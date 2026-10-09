// Prop-firm day-trading combo, Nasdaq (intraday, 5-minute bars)
//
// One trade a day: the first signal from three rules that held up out of sample in
// research/video_strategies (picked on 2019-2024, checked on 2025-2026):
//   1. Opening range breakout (first 15 minutes) in the direction of the daily trend,
//      stop 2 × ATR, target 3R. Only the day's first breakout counts.
//   2. Noise-area momentum, longs only: a close above the day's usual range (14-day average
//      move from the open), checked every 30 minutes, skipped if the prior-day high is less
//      than 2 ATR away. Stop 1.5 × ATR; exit when price falls back inside the range.
//   3. Volatility breakout with the daily trend: a close more than 0.3 × the prior day's
//      range beyond the open. Stop 1.5 × ATR.
// Everything is flat at the close. Use "risk per trade" sizing so every trade risks the
// same amount; prop_study.js found about $200-300 per trade suited a 50K evaluation.
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

// Bars per minute-span on this data (e.g. 15 minutes = 3 bars on 5m data).
function barsFor(data, minutes) {
  const d = [];
  for (let i = 1; i < Math.min(data.length, 200); i++) d.push(data.time[i] - data.time[i - 1]);
  d.sort((a, b) => a - b);
  const step = d[Math.floor(d.length / 2)] || 300;
  return Math.max(1, Math.round((minutes * 60) / step));
}

export default {
  name: 'NQ Prop Combo (one trade a day)',
  description: 'First signal of the day from ORB + daily trend, noise-area long and volatility breakout. Flat at the close.',

  params: {
    useOrb: { value: true, label: 'Opening range breakout + daily trend' },
    useNoise: { value: true, label: 'Noise-area momentum (long only)' },
    useBreakout: { value: true, label: 'Volatility breakout + daily trend' },
    orMinutes: { value: 15, min: 5, max: 60, step: 5, label: 'Opening range (minutes)' },
    orbStopAtr: { value: 2, min: 0.5, max: 5, step: 0.5, label: 'ORB stop (× ATR)' },
    orbTargetR: { value: 3, min: 0, max: 10, step: 0.5, label: 'ORB target (R, 0 = none)' },
    noiseDays: { value: 14, min: 5, max: 60, label: 'Noise average (days)' },
    noiseStopAtr: { value: 1.5, min: 0.5, max: 5, step: 0.5, label: 'Noise-area stop (× ATR)' },
    noiseRoomAtr: { value: 2, min: 0, max: 10, step: 0.5, label: 'Noise-area: min room to prior-day high (× ATR)' },
    k: { value: 0.3, min: 0.05, max: 1.5, step: 0.05, label: 'Breakout distance (× prior-day range)' },
    breakoutStopAtr: { value: 1.5, min: 0.5, max: 5, step: 0.5, label: 'Breakout stop (× ATR)' },
  },

  setup({ data, params, ta, plot }) {
    const common = sessionContext(data, ta);
    const n = data.length;
    const bar = ta.sessionBar(data);
    const orLen = barsFor(data, params.orMinutes);
    const orHigh = new Array(n).fill(NaN);
    const orLow = new Array(n).fill(NaN);
    const upper = new Array(n).fill(NaN);
    const dayOpen = new Array(n).fill(NaN);
    const hist = new Map();
    let hi = -Infinity, lo = Infinity, open = NaN;
    for (let i = 0; i < n; i++) {
      if (bar[i] === 0) { hi = -Infinity; lo = Infinity; open = data.open[i]; }
      dayOpen[i] = open;
      if (bar[i] < orLen) { hi = Math.max(hi, data.high[i]); lo = Math.min(lo, data.low[i]); }
      else { orHigh[i] = hi; orLow[i] = lo; }
      const tod = data.time[i] % 86400;
      const past = hist.get(tod) || [];
      if (past.length >= params.noiseDays && Number.isFinite(common.pdc[i])) {
        const sigma = past.slice(-params.noiseDays).reduce((a, b) => a + b, 0) / params.noiseDays;
        upper[i] = Math.max(open, common.pdc[i]) * (1 + sigma);
      }
      past.push(Math.abs(data.close[i] / open - 1));
      if (past.length > 100) past.shift();
      hist.set(tod, past);
    }
    plot('Range high', orHigh, { color: 'up', style: 'dashed' });
    plot('Range low', orLow, { color: 'down', style: 'dashed' });
    plot('Noise upper', upper, { color: 'accent', style: 'dots' });
    return { common, orHigh, orLow, upper, dayOpen, state: { day: -1, orbSeen: -1, traded: -1, leg: '' } };
  },

  onBar(ctx) {
    const { i, close, ind, params: p } = ctx;
    const c = ind.common, st = ind.state, day = c.day[i], atr = c.atr[i];
    const nextT = ctx.data.time[i + 1] % 86400;
    const onCheck = (nextT - 9.5 * 3600) % 1800 === 0; // next bar opens on the half hour

    // exit rule of the noise-area leg: back inside the range at a half-hour check
    if (ctx.isLong && st.leg === 'noise' && onCheck && close < ind.upper[i]) return ctx.exit('Back inside noise area');
    if (!ctx.isFlat || ctx.lastBarOfSession || st.traded === day || !(atr > 0)) return;

    const go = (leg, side, stopAtr, targetR, label) => {
      const stop = close - side * stopAtr * atr;
      const target = targetR > 0 ? close + side * targetR * stopAtr * atr : undefined;
      if (side > 0) ctx.long({ stop, target, label });
      else ctx.short({ stop, target, label });
      st.traded = day;
      st.leg = leg;
    };

    // 1. opening range breakout with the daily trend (only the first breakout of the day counts)
    if (p.useOrb && st.orbSeen !== day && ind.orHigh[i] > ind.orLow[i]) {
      const side = close > ind.orHigh[i] ? 1 : close < ind.orLow[i] ? -1 : 0;
      if (side) {
        st.orbSeen = day;
        if (c.trend[i] === side) return go('orb', side, p.orbStopAtr, p.orbTargetR, side > 0 ? 'ORB up' : 'ORB down');
      }
    }
    // 2. noise-area breakout, long only, with room to the prior-day high
    if (p.useNoise && onCheck && close > ind.upper[i]) {
      const room = c.pdh[i] - close;
      if (!(p.noiseRoomAtr > 0 && room > 0 && room < p.noiseRoomAtr * atr)) return go('noise', 1, p.noiseStopAtr, 0, 'Above noise area');
    }
    // 3. volatility breakout with the daily trend
    const range = c.pdh[i] - c.pdl[i];
    if (p.useBreakout && range > 0) {
      const o = ind.dayOpen[i];
      const side = close > o + p.k * range ? 1 : close < o - p.k * range ? -1 : 0;
      if (side && c.trend[i] === side) return go('breakout', side, p.breakoutStopAtr, 0, side > 0 ? 'Breakout up' : 'Breakout down');
    }
  },
};
