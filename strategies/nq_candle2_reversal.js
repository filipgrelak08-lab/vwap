// Candle-2 Reversal (fractal model), Nasdaq research version (intraday)
//
// On higher-timeframe candles built from the session (default 60 minutes from 09:30):
// candle 2 trades below candle 1's low and closes back above it -> long into candle 3,
// stop at candle 2's low, target candle 1's high. Mirror for shorts. Flat at the close.
// Strategy 6 of 6 from research/video_strategies.

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
  if (p.nativeStop && Number.isFinite(stop) && side * (close - stop) > 0) opts.stop = stop;
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
  name: 'NQ Candle-2 Reversal',
  description: 'Higher-timeframe candle sweeps the previous candle’s high/low and closes back inside: trade candle 3.',

  params: {
    htfMinutes: { value: 60, min: 15, max: 120, step: 15, label: 'Candle size (minutes)' },
    ...FILTER_PARAMS,
  },

  setup({ data, params, ta }) {
    const common = sessionContext(data, ta);
    const n = data.length;
    const bar = ta.sessionBar(data);
    const per = barsFor(data, params.htfMinutes);
    // signal[i] is set on the bar that completes a higher-timeframe candle
    const signal = new Array(n).fill(null);
    let cur = null, prev = null;
    for (let i = 0; i < n; i++) {
      if (bar[i] === 0) { cur = null; prev = null; }
      if (!cur || bar[i] % per === 0) cur = { h: data.high[i], l: data.low[i] };
      else { cur.h = Math.max(cur.h, data.high[i]); cur.l = Math.min(cur.l, data.low[i]); }
      const done = bar[i] % per === per - 1;
      if (!done) continue;
      const c = data.close[i];
      if (prev) {
        if (cur.l < prev.l && c > prev.l && c < prev.h) signal[i] = { side: 1, stop: cur.l, target: prev.h };
        else if (cur.h > prev.h && c < prev.h && c > prev.l) signal[i] = { side: -1, stop: cur.h, target: prev.l };
      }
      prev = { h: cur.h, l: cur.l };
    }
    return { common, signal };
  },

  onBar(ctx) {
    const s = ctx.ind.signal[ctx.i];
    if (!s || !ctx.isFlat || ctx.lastBarOfSession) return;
    enter(ctx, s.side, s.stop, s.target, s.side > 0 ? 'Candle 2 swept low' : 'Candle 2 swept high');
  },
};
