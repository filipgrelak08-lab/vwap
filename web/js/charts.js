/*
 * Chart rendering on top of TradingView Lightweight Charts (v4).
 * Four stacked charts share one bar index, so zooming, panning and the
 * crosshair stay in sync: price + overlays, optional lower pane, equity,
 * drawdown.
 */
(function (root) {
  'use strict';
  const BT = (root.BT = root.BT || {});
  const LW = () => root.LightweightCharts;
  const PAD = 11; // fixed-width price labels keep the four charts' plot areas aligned

  const el = {};
  const charts = {};
  const main = {}; // the series each chart's crosshair snaps to
  let overlays = []; // { chart, series, plot }
  let focusLines = [];
  let result = null;
  let dataKey = null;
  let timeIndex = new Map();
  let syncing = false;
  let showMarkers = true;
  let markerCache = [];

  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  function theme() {
    return {
      surface: css('--surface'), text: css('--muted'), ink: css('--ink'), ink2: css('--ink-2'),
      grid: css('--grid'), line: css('--line'), up: css('--up'), down: css('--down'),
      accent: css('--accent'), vwap: css('--vwap'), band: css('--band'), bh: css('--bh'), bad: css('--bad'),
      series: [1, 2, 3, 4, 5, 6, 7, 8].map((k) => css(`--s${k}`)),
    };
  }

  function rgba(hex, a) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex);
    if (!m) return hex;
    const v = parseInt(m[1], 16);
    return `rgba(${(v >> 16) & 255}, ${(v >> 8) & 255}, ${v & 255}, ${a})`;
  }

  function resolveColor(name, t, k) {
    if (!name) return t.series[k % t.series.length];
    const named = { vwap: t.vwap, band: t.band, accent: t.accent, up: t.up, down: t.down, muted: t.text, ink: t.ink };
    return named[name] || name;
  }

  const pad = (s) => String(s).padStart(PAD);
  const fmtPrice = (v) => pad(BT.fmt.price(v));
  const fmtMoney = (v) => pad(BT.fmt.money(v));
  const fmtPct = (v) => pad(`${v.toFixed(1)}%`);
  const fmtNum = (v) => pad(BT.fmt.num(v, Math.abs(v) >= 100 ? 0 : 2));

  function options(t, o) {
    return {
      autoSize: true,
      layout: {
        background: { type: 'solid', color: t.surface },
        textColor: t.text,
        fontFamily: "'IBM Plex Mono', ui-monospace, Menlo, Consolas, monospace",
        fontSize: 11,
        attributionLogo: !!o.logo,
      },
      grid: { vertLines: { color: t.grid }, horzLines: { color: t.grid } },
      rightPriceScale: { borderColor: t.line, scaleMargins: o.margins || { top: 0.1, bottom: 0.08 } },
      timeScale: { borderColor: t.line, timeVisible: true, secondsVisible: false, visible: !!o.timeAxis, rightOffset: 3, minBarSpacing: 0.01 },
      crosshair: {
        mode: LW().CrosshairMode.Normal,
        vertLine: { color: t.band, labelBackgroundColor: t.ink2 },
        horzLine: { color: t.band, labelBackgroundColor: t.ink2 },
      },
      localization: { priceFormatter: o.formatter, locale: 'en-US' },
    };
  }

  function create() {
    const t = theme();
    const make = (key, box, o) => {
      charts[key] = LW().createChart(box, options(t, o));
    };
    make('price', el.price, { logo: true, formatter: fmtPrice, margins: { top: 0.12, bottom: 0.06 } });
    make('osc', el.osc, { timeAxis: true, formatter: fmtNum, margins: { top: 0.12, bottom: 0.08 } });
    make('equity', el.equity, { formatter: fmtMoney, margins: { top: 0.14, bottom: 0.06 } });
    make('dd', el.dd, { timeAxis: true, formatter: fmtPct, margins: { top: 0.18, bottom: 0.02 } });

    main.candle = charts.price.addCandlestickSeries({
      upColor: t.up, downColor: t.down, borderVisible: false, wickUpColor: t.up, wickDownColor: t.down,
      priceLineVisible: false,
    });
    main.bh = charts.equity.addLineSeries({ color: t.bh, lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    main.equity = charts.equity.addAreaSeries({
      lineColor: t.accent, lineWidth: 2, topColor: rgba(t.accent, 0.16), bottomColor: rgba(t.accent, 0.01),
      priceLineVisible: false,
    });
    main.dd = charts.dd.addAreaSeries({
      lineColor: t.down, lineWidth: 1.5, topColor: rgba(t.down, 0.04), bottomColor: rgba(t.down, 0.22),
      invertFilledArea: false, priceLineVisible: false, lastValueVisible: false,
    });
    main.osc = null;

    // keep every chart on the same bar range
    for (const key of Object.keys(charts)) {
      charts[key].timeScale().subscribeVisibleLogicalRangeChange((range) => {
        if (syncing || !range) return;
        syncing = true;
        for (const other of Object.keys(charts)) {
          if (other !== key && !(other === 'osc' && el.osc.hidden)) charts[other].timeScale().setVisibleLogicalRange(range);
        }
        syncing = false;
      });
      charts[key].subscribeCrosshairMove((param) => onCrosshair(key, param));
    }
  }

  function destroy() {
    for (const key of Object.keys(charts)) {
      charts[key].remove();
      delete charts[key];
    }
    overlays = [];
    focusLines = [];
    dataKey = null;
  }

  function init(ids) {
    el.price = document.getElementById(ids.price);
    el.osc = document.getElementById(ids.osc);
    el.equity = document.getElementById(ids.equity);
    el.dd = document.getElementById(ids.dd);
    el.priceLegend = document.getElementById(ids.priceLegend);
    el.oscLegend = document.getElementById(ids.oscLegend);
    el.equityLegend = document.getElementById(ids.equityLegend);
    el.ddLegend = document.getElementById(ids.ddLegend);
    if (!LW()) throw new Error('The chart library failed to load.');
    create();
  }

  // ---------------------------------------------------------------- render

  function lineData(times, series) {
    const out = new Array(times.length);
    for (let i = 0; i < times.length; i++) {
      const v = series[i];
      out[i] = Number.isFinite(v) ? { time: times[i], value: v } : { time: times[i] };
    }
    return out;
  }

  function buildMarkers(res, t) {
    const times = res.data.time;
    const out = [];
    for (const tr of res.trades) {
      const long = tr.side === 'long';
      out.push({
        time: times[tr.entryIndex], position: long ? 'belowBar' : 'aboveBar', shape: long ? 'arrowUp' : 'arrowDown',
        color: long ? t.up : t.down, size: 1,
      });
      out.push({
        time: times[tr.exitIndex], position: long ? 'aboveBar' : 'belowBar', shape: 'circle',
        color: t.text, size: 0.5,
      });
    }
    out.sort((a, b) => a.time - b.time);
    return out;
  }

  function render(res) {
    if (!charts.price) create();
    const t = theme();
    const d = res.data;
    const times = d.time;
    const key = `${d.symbol}|${d.interval}|${d.length}|${times[0]}|${times[d.length - 1]}`;
    const newData = key !== dataKey;
    result = res;
    clearFocus();

    const intraday = BT.fmt.isIntraday(d);
    for (const c of Object.values(charts)) c.applyOptions({ timeScale: { timeVisible: intraday } });

    if (newData) {
      main.candle.setData(times.map((tm, i) => ({ time: tm, open: d.open[i], high: d.high[i], low: d.low[i], close: d.close[i] })));
      timeIndex = new Map(times.map((tm, i) => [tm, i]));
      dataKey = key;
    }

    for (const o of overlays) o.chart.removeSeries(o.series);
    overlays = [];
    main.osc = null;

    let k = 0;
    let lowerCount = 0;
    for (const p of res.plots) {
      const lower = p.pane === 'lower';
      const chart = lower ? charts.osc : charts.price;
      // un-coloured lower-pane lines start from the accent so they don't echo the VWAP amber
      const color = !p.color && lower && lowerCount === 0 ? t.accent : resolveColor(p.color, t, k);
      k++;
      if (lower) lowerCount++;
      let series;
      if (p.style === 'histogram') {
        series = chart.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false });
        series.setData(times.map((tm, i) => {
          const v = p.series[i];
          return Number.isFinite(v) ? { time: tm, value: v, color: rgba(v >= 0 ? t.up : t.down, 0.55) } : { time: tm };
        }));
      } else {
        const style = { dashed: LW().LineStyle.Dashed, dots: LW().LineStyle.Dotted }[p.style] || LW().LineStyle.Solid;
        series = chart.addLineSeries({
          color, lineWidth: p.width || (lower ? 1.5 : 1.5), lineStyle: style,
          priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
        });
        series.setData(lineData(times, p.series));
      }
      if (lower && Array.isArray(p.levels)) {
        for (const lv of p.levels) series.createPriceLine({ price: lv, color: t.band, lineWidth: 1, lineStyle: LW().LineStyle.Dashed, axisLabelVisible: false, title: '' });
      }
      if (lower && !main.osc) main.osc = series;
      overlays.push({ chart, series, plot: p, color });
    }
    el.osc.hidden = !overlays.some((o) => o.plot.pane === 'lower');
    charts.price.applyOptions({ timeScale: { visible: el.osc.hidden } });

    markerCache = buildMarkers(res, t);
    main.candle.setMarkers(showMarkers ? markerCache : []);

    main.equity.setData(times.map((tm, i) => ({ time: tm, value: res.equity[i] })));
    main.bh.setData(times.map((tm, i) => ({ time: tm, value: res.buyHold[i] })));
    const dd = BT.metrics.drawdownSeries(res.equity);
    res.drawdown = dd;
    main.dd.setData(times.map((tm, i) => ({ time: tm, value: dd[i] })));

    if (newData) fitAll();
    else {
      // re-align a freshly shown lower pane with the others
      const range = charts.price.timeScale().getVisibleLogicalRange();
      if (range && !el.osc.hidden) charts.osc.timeScale().setVisibleLogicalRange(range);
    }
    updateLegends(times.length - 1);
  }

  function fitAll() {
    const n = result ? result.data.length : 0;
    if (!n) return;
    const range = { from: -2, to: n + 2 };
    syncing = true;
    for (const key of Object.keys(charts)) {
      if (key === 'osc' && el.osc.hidden) continue;
      charts[key].timeScale().setVisibleLogicalRange(range);
      // dragging the price axis switches autoscale off; get it back
      charts[key].priceScale('right').applyOptions({ autoScale: true });
    }
    syncing = false;
  }

  function setShowMarkers(on) {
    showMarkers = on;
    if (main.candle) main.candle.setMarkers(on ? markerCache : []);
  }

  function clearFocus() {
    for (const l of focusLines) {
      try { main.candle.removePriceLine(l); } catch (e) { /* series replaced */ }
    }
    focusLines = [];
  }

  // Zoom to one trade and mark its entry and exit prices.
  function focusTrade(tr) {
    if (!result || !tr) return;
    clearFocus();
    const t = theme();
    const span = Math.max(tr.exitIndex - tr.entryIndex, 1);
    const padBars = Math.max(30, span * 1.5);
    const range = { from: tr.entryIndex - padBars, to: tr.exitIndex + padBars };
    syncing = true;
    for (const key of Object.keys(charts)) {
      if (key === 'osc' && el.osc.hidden) continue;
      charts[key].timeScale().setVisibleLogicalRange(range);
    }
    syncing = false;
    const color = tr.side === 'long' ? t.up : t.down;
    focusLines.push(main.candle.createPriceLine({ price: tr.entryPrice, color, lineWidth: 1, lineStyle: LW().LineStyle.Dashed, axisLabelVisible: true, title: 'entry' }));
    focusLines.push(main.candle.createPriceLine({ price: tr.exitPrice, color: t.ink2, lineWidth: 1, lineStyle: LW().LineStyle.Dashed, axisLabelVisible: true, title: 'exit' }));
    updateLegends(tr.entryIndex);
  }

  // ---------------------------------------------------------------- legends & crosshair

  function onCrosshair(source, param) {
    if (!result || syncing) return;
    const idx = param && param.time !== undefined ? timeIndex.get(param.time) : undefined;
    const i = idx === undefined ? result.data.length - 1 : idx;
    updateLegends(i);
    syncing = true;
    for (const key of Object.keys(charts)) {
      if (key === source) continue;
      if (key === 'osc' && el.osc.hidden) continue;
      if (idx === undefined) {
        charts[key].clearCrosshairPosition();
        continue;
      }
      const s = { price: main.candle, osc: main.osc, equity: main.equity, dd: main.dd }[key];
      if (!s) continue;
      const v = key === 'price' ? result.data.close[i] : key === 'equity' ? result.equity[i] : key === 'dd' ? result.drawdown[i] : overlays.find((o) => o.series === s).plot.series[i];
      if (Number.isFinite(v)) charts[key].setCrosshairPosition(v, param.time, s);
    }
    syncing = false;
  }

  function item(parent, color, label, value) {
    const span = document.createElement('span');
    span.className = 'item';
    if (color) {
      const key = document.createElement('i');
      key.className = 'line-key';
      key.style.background = color;
      span.appendChild(key);
    }
    span.appendChild(document.createTextNode(label ? `${label} ` : ''));
    const b = document.createElement('b');
    b.textContent = value;
    span.appendChild(b);
    parent.appendChild(span);
  }

  function updateLegends(i) {
    if (!result) return;
    const d = result.data;
    const f = BT.fmt;
    const pl = el.priceLegend;
    pl.textContent = '';
    item(pl, null, '', f.time(d.time[i], d));
    item(pl, null, 'O', f.price(d.open[i]));
    item(pl, null, 'H', f.price(d.high[i]));
    item(pl, null, 'L', f.price(d.low[i]));
    item(pl, null, 'C', f.price(d.close[i]));
    if (d.volume[i] > 0) item(pl, null, 'Vol', f.compact(d.volume[i]));
    const ol = el.oscLegend;
    ol.textContent = '';
    for (const o of overlays) {
      const v = o.plot.series[i];
      const txt = Number.isFinite(v) ? (o.plot.pane === 'lower' ? f.num(v, 2) : f.price(v)) : '–';
      item(o.plot.pane === 'lower' ? ol : pl, o.color, o.plot.name, txt);
    }
    const el2 = el.equityLegend;
    el2.textContent = '';
    const cap = result.settings.capital;
    item(el2, theme().accent, 'Strategy', `${f.money(result.equity[i])} (${f.pct((result.equity[i] / cap - 1) * 100, 1)})`);
    item(el2, theme().bh, 'Buy and hold', `${f.money(result.buyHold[i])} (${f.pct((result.buyHold[i] / cap - 1) * 100, 1)})`);
    el.ddLegend.textContent = '';
    item(el.ddLegend, null, 'Drawdown', f.pct(result.drawdown ? result.drawdown[i] : 0, 1));
  }

  function retheme() {
    if (!charts.price) return;
    destroy();
    create();
    if (result) render(result);
  }

  // ---------------------------------------------------------------- scatter (trade excursions)

  const SVG = 'http://www.w3.org/2000/svg';
  function svgEl(tag, attrs, parent) {
    const e = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
    if (parent) parent.appendChild(e);
    return e;
  }

  function niceTicks(a, b, count) {
    const span = b - a || 1;
    const raw = span / count;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((x) => x >= raw);
    const out = [];
    for (let v = Math.ceil(a / step) * step; v <= b + 1e-9; v += step) out.push(+v.toFixed(10));
    return out;
  }

  /**
   * points: [{ x, y, win, label }]; opts: { xLabel, yLabel, onClick(point) }.
   * Both axes always include 0 so "against you" / "in your favour" read at a glance.
   */
  function scatter(container, points, opts) {
    container.textContent = '';
    const W = 460;
    const H = 270;
    const m = { l: 46, r: 12, t: 10, b: 36 };
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `${opts.xLabel} against ${opts.yLabel}` }, container);
    if (!points.length) {
      svgEl('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', class: 'empty-note' }, svg).textContent = 'No trades to show';
      return;
    }
    const ext = (vals) => {
      let lo = Math.min(0, ...vals);
      let hi = Math.max(0, ...vals);
      const pad = (hi - lo || 1) * 0.06;
      return [lo - pad, hi + pad];
    };
    const [x0, x1] = ext(points.map((p) => p.x));
    const [y0, y1] = ext(points.map((p) => p.y));
    const X = (v) => m.l + ((v - x0) / (x1 - x0)) * (W - m.l - m.r);
    const Y = (v) => H - m.b - ((v - y0) / (y1 - y0)) * (H - m.t - m.b);
    for (const t of niceTicks(y0, y1, 5)) {
      svgEl('line', { x1: m.l, x2: W - m.r, y1: Y(t), y2: Y(t), class: t === 0 ? 'zero' : 'grid' }, svg);
      svgEl('text', { x: m.l - 6, y: Y(t) + 3, 'text-anchor': 'end', class: 'tick' }, svg).textContent = `${+t.toFixed(2)}%`;
    }
    for (const t of niceTicks(x0, x1, 5)) {
      svgEl('line', { x1: X(t), x2: X(t), y1: m.t, y2: H - m.b, class: t === 0 ? 'zero' : 'grid' }, svg);
      svgEl('text', { x: X(t), y: H - m.b + 13, 'text-anchor': 'middle', class: 'tick' }, svg).textContent = `${+t.toFixed(2)}%`;
    }
    svgEl('text', { x: (m.l + W - m.r) / 2, y: H - 4, 'text-anchor': 'middle', class: 'axis-label' }, svg).textContent = opts.xLabel;
    const yl = svgEl('text', { x: 11, y: (m.t + H - m.b) / 2, 'text-anchor': 'middle', class: 'axis-label', transform: `rotate(-90 11 ${(m.t + H - m.b) / 2})` }, svg);
    yl.textContent = opts.yLabel;
    // losers first so winners sit on top where they overlap
    const sorted = points.slice(0, 3000).sort((a, b) => a.win - b.win);
    for (const p of sorted) {
      const c = svgEl('circle', { cx: X(p.x), cy: Y(p.y), r: 4, class: p.win ? 'win' : 'loss' }, svg);
      svgEl('title', {}, c).textContent = p.label;
      if (opts.onClick) {
        c.style.cursor = 'pointer';
        c.addEventListener('click', () => opts.onClick(p));
      }
    }
  }

  /**
   * Small static line chart (used for trader.dev equity curves).
   * points: [{ t (unix seconds), y }]; opts: { label, base (dashed reference level), format(y) }.
   */
  function line(container, points, opts) {
    container.textContent = '';
    const W = 920;
    const H = 260;
    const m = { l: 64, r: 12, t: 10, b: 26 };
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': opts.label || 'Line chart' }, container);
    if (points.length < 2) {
      svgEl('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', class: 'empty-note' }, svg).textContent = 'Not enough data to draw';
      return;
    }
    const ys = points.map((p) => p.y).concat(Number.isFinite(opts.base) ? [opts.base] : []);
    let y0 = Math.min(...ys);
    let y1 = Math.max(...ys);
    const padY = (y1 - y0 || 1) * 0.06;
    y0 -= padY;
    y1 += padY;
    const t0 = points[0].t;
    const t1 = points[points.length - 1].t;
    const X = (t) => m.l + ((t - t0) / (t1 - t0 || 1)) * (W - m.l - m.r);
    const Y = (v) => H - m.b - ((v - y0) / (y1 - y0)) * (H - m.t - m.b);
    const fmt = opts.format || ((v) => BT.fmt.num(v, 0));
    for (const t of niceTicks(y0, y1, 5)) {
      svgEl('line', { x1: m.l, x2: W - m.r, y1: Y(t), y2: Y(t), class: 'grid' }, svg);
      svgEl('text', { x: m.l - 6, y: Y(t) + 3, 'text-anchor': 'end', class: 'tick' }, svg).textContent = fmt(t);
    }
    for (let k = 0; k <= 5; k++) {
      const t = t0 + ((t1 - t0) * k) / 5;
      const anchor = k === 0 ? 'start' : k === 5 ? 'end' : 'middle';
      svgEl('text', { x: X(t), y: H - 8, 'text-anchor': anchor, class: 'tick' }, svg).textContent = BT.fmt.date(t);
    }
    if (Number.isFinite(opts.base)) svgEl('line', { x1: m.l, x2: W - m.r, y1: Y(opts.base), y2: Y(opts.base), class: 'zero' }, svg);
    const d = points.map((p, i) => `${i ? 'L' : 'M'}${X(p.t).toFixed(1)},${Y(p.y).toFixed(1)}`).join(' ');
    svgEl('path', { d: `${d} L${X(t1).toFixed(1)},${H - m.b} L${X(t0).toFixed(1)},${H - m.b} Z`, class: 'area' }, svg);
    svgEl('path', { d, class: 'line' }, svg);
  }

  BT.charts = { init, render, fitAll, focusTrade, setShowMarkers, retheme, scatter, line };
})(typeof window !== 'undefined' ? window : globalThis);
