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

  BT.charts = { init, render, fitAll, focusTrade, setShowMarkers, retheme };
})(typeof window !== 'undefined' ? window : globalThis);
