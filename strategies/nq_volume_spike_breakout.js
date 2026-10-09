// Volume Spike Breakout, Nasdaq research version (intraday)
//
// A bar with volume well above average that closes beyond the recent high or low:
// trade the breakout, stop at the other end of that bar, flat at the close.
// Strategy 4 of 6 from research/video_strategies.

// ---- Shared filters (the same block is in every nq_* strategy) ----
// Each one is a "lever" from the research in research/video_strategies: off by default.
const FILTER_PARAMS = {
  direction: { value: 'both', options: ['both', 'long', 'short'], label: 'Direction' },
  dailyTrend: { value: false, label: 'Only with the daily trend (prior close vs 20-day SMA)' },
  vwapSide: { value: false, label: 'Longs only above VWAP, shorts only below' },
  gapAlign: { value: false, label: 'Only in the direction of the opening gap' },
  roomAtr: { value: 0, min: 0, max: 10, step: 0.5, label: 'Skip if prior-day high/low is less than N ATR ahead (0 = off)' },
  nativeStop: { value: true, label: "Use the strategy's own stop (off: use the Stops panel)" },
  nativeTarget: { value: true, label: "Use the strategy's own target or exit (off: use the Stops panel)" },
};

// Per-bar context: ATR, session VWAP, prior-day high/low/close, daily trend and opening gap.
function sessionContext(data, ta) {
  const n = data.length;
  const day = ta.anchorIds(data, 'session');
  const atr = ta.atr(data, 14);
  const vwap = ta.vwap(data, 'session');
  const pdh = new Array(n).fill(NaN);
  const pdl = new Array(n).fill(NaN);
  const pdc = new Array(n).fill(NaN);
  const trend = new Array(n).fill(0);
  const gap = new Array(n).fill(0);
  const closes = [];
  let hi = -Infinity, lo = Infinity, prev = null, open = NaN, tr = 0, g = 0;
  for (let i = 0; i < n; i++) {
    if (i === 0 || day[i] !== day[i - 1]) {
      if (i > 0) {
        prev = { h: hi, l: lo, c: data.close[i - 1] };
        closes.push(data.close[i - 1]);
      }
      hi = -Infinity; lo = Infinity; open = data.open[i];
      tr = 0;
      if (closes.length >= 20) {
        const sma = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
        tr = closes[closes.length - 1] > sma ? 1 : -1;
      }
      g = prev ? Math.sign(open - prev.c) : 0;
    }
    hi = Math.max(hi, data.high[i]);
    lo = Math.min(lo, data.low[i]);
    if (prev) { pdh[i] = prev.h; pdl[i] = prev.l; pdc[i] = prev.c; }
    trend[i] = tr;
    gap[i] = g;
  }
  return { day, atr, vwap, pdh, pdl, pdc, trend, gap };
}

// Place an entry if the switched-on filters allow it. Returns true if an order was sent.
function enter(ctx, side, stop, target, label) {
  const { i, close, params: p } = ctx;
  const c = ctx.ind.common;
  if (!(c.atr[i] > 0)) return false; // ATR still warming up: an ATR stop could not be placed
  if ((p.direction === 'long' && side < 0) || (p.direction === 'short' && side > 0)) return false;
  if (p.dailyTrend && c.trend[i] !== side) return false;
  if (p.vwapSide && side * (close - c.vwap[i]) <= 0) return false;
  if (p.gapAlign && c.gap[i] !== side) return false;
  if (p.roomAtr > 0) {
    const level = side > 0 ? c.pdh[i] : c.pdl[i];
    const room = side * (level - close);
    if (room > 0 && room < p.roomAtr * c.atr[i]) return false;
  }
  const opts = { label };
  if (p.nativeStop && Number.isFinite(stop)) {
    if (side * (close - stop) <= 0) return false; // price is already past the stop
    opts.stop = stop;
  }
  if (p.nativeTarget && Number.isFinite(target) && side * (target - close) > 0) opts.target = target;
  if (side > 0) ctx.long(opts);
  else ctx.short(opts);
  return true;
}

// Bars per minute-span on this data (e.g. 15 minutes = 3 bars on 5m data).
function barsFor(data, minutes) {
  const d = [];
  for (let i = 1; i < Math.min(data.length, 200); i++) d.push(data.time[i] - data.time[i - 1]);
  d.sort((a, b) => a - b);
  const step = d[Math.floor(d.length / 2)] || 300;
  return Math.max(1, Math.round((minutes * 60) / step));
}

export default {
  name: 'NQ Volume Spike Breakout',
  description: 'High-volume bar closing beyond the last N bars’ high or low: trade the breakout, stop at the bar’s other end.',

  params: {
    lookback: { value: 20, min: 5, max: 100, label: 'Breakout lookback (bars)' },
    volMult: { value: 2, min: 1, max: 5, step: 0.25, label: 'Volume ≥ N × 20-bar average' },
    ...FILTER_PARAMS,
  },

  setup({ data, params, ta, plot }) {
    const common = sessionContext(data, ta);
    const hh = ta.highest(data.high, params.lookback);
    const ll = ta.lowest(data.low, params.lookback);
    const avgVol = ta.sma(data.volume, 20);
    plot('Breakout high', hh, { color: 'up', style: 'dashed' });
    plot('Breakout low', ll, { color: 'down', style: 'dashed' });
    return { common, hh, ll, avgVol };
  },

  onBar(ctx) {
    const { i, close, ind, params: p } = ctx;
    if (!ctx.isFlat || ctx.lastBarOfSession || ctx.sessionBar < 1) return;
    if (!(ctx.volume >= p.volMult * ind.avgVol[i - 1])) return;
    if (close > ind.hh[i - 1]) enter(ctx, 1, ctx.low, NaN, 'Volume breakout up');
    else if (close < ind.ll[i - 1]) enter(ctx, -1, ctx.high, NaN, 'Volume breakout down');
  },
};
