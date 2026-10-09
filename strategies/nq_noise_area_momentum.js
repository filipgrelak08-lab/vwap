// Noise-Area Momentum (Zarattini, Aziz & Barbon 2024), Nasdaq research version
//
// From "Beat the Market: An Effective Intraday Momentum Strategy" (SSRN 4824172).
// Each minute-of-day has a typical distance from the open (the average over the last
// 14 days). Price beyond that "noise area" signals real demand: checked every 30 minutes,
// go long above the upper boundary or short below the lower one. The stop trails at the
// boundary or VWAP, whichever is closer to price. Flat at the close.
// Published-strategy 3 of 3 in research/video_strategies.

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
  name: 'NQ Noise-Area Momentum (Zarattini et al.)',
  description: 'Break out of the usual intraday range (14-day average move from the open), trail at VWAP/boundary.',

  params: {
    lookbackDays: { value: 14, min: 5, max: 60, label: 'Days in the noise average' },
    checkMinutes: { value: 30, min: 5, max: 60, step: 5, label: 'Check every N minutes' },
    ...FILTER_PARAMS,
  },

  setup({ data, params, ta, plot }) {
    const common = sessionContext(data, ta);
    const n = data.length;
    const upper = new Array(n).fill(NaN);
    const lower = new Array(n).fill(NaN);
    const hist = new Map(); // time of day -> recent |close / open - 1|
    let dayOpen = NaN;
    for (let i = 0; i < n; i++) {
      if (i === 0 || common.day[i] !== common.day[i - 1]) dayOpen = data.open[i];
      const tod = data.time[i] % 86400;
      const past = hist.get(tod) || [];
      if (past.length >= params.lookbackDays && Number.isFinite(common.pdc[i])) {
        const sigma = past.slice(-params.lookbackDays).reduce((a, b) => a + b, 0) / params.lookbackDays;
        upper[i] = Math.max(dayOpen, common.pdc[i]) * (1 + sigma);
        lower[i] = Math.min(dayOpen, common.pdc[i]) * (1 - sigma);
      }
      past.push(Math.abs(data.close[i] / dayOpen - 1));
      if (past.length > 100) past.shift();
      hist.set(tod, past);
    }
    plot('Noise upper', upper, { color: 'up', style: 'dashed' });
    plot('Noise lower', lower, { color: 'down', style: 'dashed' });
    plot('VWAP', common.vwap, { color: 'vwap' });
    return { common, upper, lower };
  },

  onBar(ctx) {
    const { i, close, ind, params: p } = ctx;
    const up = ind.upper[i], lo = ind.lower[i], vw = ind.common.vwap[i];
    if (!Number.isFinite(up)) return;
    // trailing stop: the boundary or VWAP, whichever is closer to price
    if (p.nativeStop && ctx.isLong) ctx.setStop(Math.max(up, vw));
    if (p.nativeStop && ctx.isShort) ctx.setStop(Math.min(lo, vw));
    const nextT = ctx.data.time[i + 1] % 86400;
    const onCheck = (nextT - 9.5 * 3600) % (p.checkMinutes * 60) === 0;
    if (!onCheck || ctx.lastBarOfSession) return;
    if (ctx.isShort && close > lo) ctx.exit('Back inside noise area');
    if (ctx.isLong && close < up) ctx.exit('Back inside noise area');
    if (!ctx.isLong && close > up) enter(ctx, 1, Math.max(up, vw), NaN, 'Above noise area');
    else if (!ctx.isShort && close < lo) enter(ctx, -1, Math.min(lo, vw), NaN, 'Below noise area');
  },
};
