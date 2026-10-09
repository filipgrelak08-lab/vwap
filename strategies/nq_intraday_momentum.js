// Intraday Momentum (Gao, Han, Li & Zhou 2018), Nasdaq research version
//
// From "Market Intraday Momentum" (Journal of Financial Economics): the return from the
// previous close to 10:00 predicts the return of the last half hour. At 15:30, trade in the
// direction of that early return and exit at the close. The paper has no stop; this version
// adds a protective stop (N × ATR) so results can be measured in R.
// Published-strategy 2 of 3 in research/video_strategies.

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
  name: 'NQ Intraday Momentum (last half hour)',
  description: 'At 15:30, go with the sign of the previous-close-to-10:00 return; exit at the close.',

  params: {
    entryTime: { value: '15:30', options: ['15:00', '15:30'], label: 'Entry at' },
    stopAtr: { value: 2, min: 0.5, max: 10, step: 0.5, label: 'Protective stop (× ATR)' },
    ...FILTER_PARAMS,
  },

  setup({ data, ta }) {
    const common = sessionContext(data, ta);
    const n = data.length;
    // signal: sign of (price at 10:00) / (prior close) - 1, known from the bar that ends at 10:00
    const early = new Array(n).fill(0);
    let s = 0;
    for (let i = 0; i < n; i++) {
      if (i === 0 || common.day[i] !== common.day[i - 1]) s = 0;
      const t = data.time[i] % 86400;
      const end = t + (i + 1 < n && common.day[i + 1] === common.day[i] ? data.time[i + 1] - data.time[i] : 0);
      if (t < 36000 && end >= 36000 && Number.isFinite(common.pdc[i])) s = Math.sign(data.close[i] - common.pdc[i]);
      early[i] = s;
    }
    return { common, early };
  },

  onBar(ctx) {
    const { i, close, ind, params: p } = ctx;
    if (!ctx.isFlat || !ind.early[i]) return;
    const [h, m] = p.entryTime.split(':').map(Number);
    // the bar that closes at the entry time: its next bar opens at entryTime
    const nextT = ctx.data.time[i + 1] % 86400;
    if (nextT !== h * 3600 + m * 60) return;
    const side = ind.early[i];
    enter(ctx, side, close - side * p.stopAtr * ind.common.atr[i], NaN, side > 0 ? 'Early strength' : 'Early weakness');
  },
};
