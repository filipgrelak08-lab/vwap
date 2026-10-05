/*
 * Chart rendering on top of TradingView Lightweight Charts (v4).
 *
 * The data comes from Trader.dev: a per-bar equity curve with the drawdown
 * at each bar. Two charts are stacked and share one bar range, so zooming,
 * panning and the crosshair stay in sync.
 *
 * Candles and indicator overlays are not drawn here. Trader.dev runs the
 * backtest and its own report page has the price chart with every fill on
 * it; the app links to that report after each run.
 */
(function (root) {
  'use strict';
  const BT = (root.BT = root.BT || {});
  const LW = () => root.LightweightCharts;
  const PAD = 11; // fixed-width price labels keep both plot areas aligned

  const el = {};
  const charts = {};
  const main = {};
  let points = []; // { time (s), equity, drawdown }
  let timeIndex = new Map();
  let syncing = false;
  let capital = 0;

  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  function theme() {
    return {
      surface: css('--surface'), text: css('--muted'), ink: css('--ink'), ink2: css('--ink-2'),
      grid: css('--grid'), line: css('--line'), up: css('--up'), down: css('--down'),
      accent: css('--accent'), band: css('--band'),
    };
  }

  function rgba(hex, a) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex);
    if (!m) return hex;
    const v = parseInt(m[1], 16);
    return `rgba(${(v >> 16) & 255}, ${(v >> 8) & 255}, ${v & 255}, ${a})`;
  }

  const pad = (s) => String(s).padStart(PAD);
  const fmtMoney = (v) => pad(BT.fmt.money(v));
  const fmtPct = (v) => pad(`${v.toFixed(1)}%`);

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
    charts.equity = LW().createChart(el.equity, options(t, { logo: true, formatter: fmtMoney, margins: { top: 0.14, bottom: 0.06 } }));
    charts.dd = LW().createChart(el.dd, options(t, { timeAxis: true, formatter: fmtPct, margins: { top: 0.18, bottom: 0.02 } }));

    main.equity = charts.equity.addAreaSeries({
      lineColor: t.accent, lineWidth: 2, topColor: rgba(t.accent, 0.16), bottomColor: rgba(t.accent, 0.01),
      priceLineVisible: false,
    });
    main.dd = charts.dd.addAreaSeries({
      lineColor: t.down, lineWidth: 1.5, topColor: rgba(t.down, 0.04), bottomColor: rgba(t.down, 0.22),
      priceLineVisible: false, lastValueVisible: false,
    });

    for (const key of Object.keys(charts)) {
      charts[key].timeScale().subscribeVisibleLogicalRangeChange((range) => {
        if (syncing || !range) return;
        syncing = true;
        for (const other of Object.keys(charts)) if (other !== key) charts[other].timeScale().setVisibleLogicalRange(range);
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
  }

  function init(ids) {
    el.equity = document.getElementById(ids.equity);
    el.dd = document.getElementById(ids.dd);
    el.equityLegend = document.getElementById(ids.equityLegend);
    el.ddLegend = document.getElementById(ids.ddLegend);
    if (!LW()) throw new Error('The chart library failed to load.');
    create();
  }

  // ---------------------------------------------------------------- render

  /**
   * @param {Array<{time:number, equity:number, drawdown:number}>} curve  time in Unix seconds
   * @param {number} startCapital
   */
  function render(curve, startCapital) {
    if (!charts.equity) create();
    points = curve || [];
    capital = startCapital;
    timeIndex = new Map(points.map((p, i) => [p.time, i]));
    main.equity.setData(points.map((p) => ({ time: p.time, value: p.equity })));
    main.dd.setData(points.map((p) => ({ time: p.time, value: p.drawdown })));
    fitAll();
    updateLegends(points.length - 1);
  }

  function fitAll() {
    if (!points.length) return;
    const range = { from: -2, to: points.length + 2 };
    syncing = true;
    for (const key of Object.keys(charts)) {
      charts[key].timeScale().setVisibleLogicalRange(range);
      charts[key].priceScale('right').applyOptions({ autoScale: true });
    }
    syncing = false;
  }

  // Zoom to the window around one trade.
  function focusWindow(fromSec, toSec) {
    if (!points.length) return;
    const near = (t) => {
      let best = 0;
      let dist = Infinity;
      for (let i = 0; i < points.length; i++) {
        const d = Math.abs(points[i].time - t);
        if (d < dist) {
          dist = d;
          best = i;
        }
      }
      return best;
    };
    const a = near(fromSec);
    const b = near(toSec);
    const padBars = Math.max(30, (b - a) * 1.5);
    syncing = true;
    for (const key of Object.keys(charts)) charts[key].timeScale().setVisibleLogicalRange({ from: a - padBars, to: b + padBars });
    syncing = false;
    updateLegends(b);
  }

  // ---------------------------------------------------------------- legends & crosshair

  function onCrosshair(source, param) {
    if (!points.length || syncing) return;
    const idx = param && param.time !== undefined ? timeIndex.get(param.time) : undefined;
    updateLegends(idx === undefined ? points.length - 1 : idx);
    syncing = true;
    for (const key of Object.keys(charts)) {
      if (key === source) continue;
      if (idx === undefined) {
        charts[key].clearCrosshairPosition();
        continue;
      }
      const v = key === 'equity' ? points[idx].equity : points[idx].drawdown;
      if (Number.isFinite(v)) charts[key].setCrosshairPosition(v, param.time, main[key]);
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
    const f = BT.fmt;
    el.equityLegend.textContent = '';
    el.ddLegend.textContent = '';
    if (!points.length || !points[i]) return;
    const p = points[i];
    item(el.equityLegend, null, '', f.date(Math.round(p.time)));
    item(el.equityLegend, theme().accent, 'Equity', `${f.money(p.equity)} (${f.pct((p.equity / capital - 1) * 100, 1)})`);
    item(el.ddLegend, null, 'Drawdown', f.pct(p.drawdown, 1));
  }

  function retheme() {
    if (!charts.equity) return;
    destroy();
    create();
    if (points.length) render(points, capital);
  }

  // ---------------------------------------------------------------- scatter

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
  function scatter(container, pts, opts) {
    container.textContent = '';
    const W = 460;
    const H = 270;
    const m = { l: 46, r: 12, t: 10, b: 36 };
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `${opts.xLabel} against ${opts.yLabel}` }, container);
    if (!pts.length) {
      svgEl('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', class: 'empty-note' }, svg).textContent = 'No trades to show';
      return;
    }
    const ext = (vals) => {
      const lo = Math.min(0, ...vals);
      const hi = Math.max(0, ...vals);
      const p = (hi - lo || 1) * 0.06;
      return [lo - p, hi + p];
    };
    const [x0, x1] = ext(pts.map((p) => p.x));
    const [y0, y1] = ext(pts.map((p) => p.y));
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
    const mid = (m.t + H - m.b) / 2;
    svgEl('text', { x: 11, y: mid, 'text-anchor': 'middle', class: 'axis-label', transform: `rotate(-90 11 ${mid})` }, svg).textContent = opts.yLabel;
    // losers first so winners sit on top where they overlap
    const sorted = pts.slice(0, 3000).sort((a, b) => a.win - b.win);
    for (const p of sorted) {
      const c = svgEl('circle', { cx: X(p.x), cy: Y(p.y), r: 4, class: p.win ? 'win' : 'loss' }, svg);
      svgEl('title', {}, c).textContent = p.label;
      if (opts.onClick) {
        c.style.cursor = 'pointer';
        c.addEventListener('click', () => opts.onClick(p));
      }
    }
  }

  BT.charts = { init, render, fitAll, focusWindow, retheme, scatter };
})(typeof window !== 'undefined' ? window : globalThis);
