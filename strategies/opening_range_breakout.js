// Opening Range Breakout (intraday)
//
// Mark the high and low of the first N bars of the session. Trade the first
// close outside that range, stop on the other side of the range, target a
// multiple of the range, one trade per day, flat at the close.

export default {
  name: 'Opening Range Breakout',
  description: 'Trade the first breakout of the opening range. Stop at the opposite side, target a multiple of the range, one trade a day.',

  params: {
    rangeBars: { value: 6, min: 1, max: 30, label: 'Opening range (bars)' },
    targetMult: { value: 1.5, min: 0.5, max: 5, step: 0.1, label: 'Target (× range)' },
    stopAtMid: { value: false, label: 'Stop at range midpoint' },
    lastEntryBar: { value: 48, min: 5, max: 400, label: 'No entries after bar #' },
  },

  setup({ data, params, ta, plot }) {
    const n = data.length;
    const bar = ta.sessionBar(data);
    const day = ta.anchorIds(data, 'session');
    const orHigh = new Array(n).fill(NaN);
    const orLow = new Array(n).fill(NaN);
    let hi = -Infinity;
    let lo = Infinity;
    for (let i = 0; i < n; i++) {
      if (bar[i] === 0) { hi = -Infinity; lo = Infinity; }
      if (bar[i] < params.rangeBars) {
        hi = Math.max(hi, data.high[i]);
        lo = Math.min(lo, data.low[i]);
      } else {
        orHigh[i] = hi;
        orLow[i] = lo;
      }
    }
    plot('Range high', orHigh, { color: 'up', style: 'dashed' });
    plot('Range low', orLow, { color: 'down', style: 'dashed' });
    return { orHigh, orLow, day, state: { lastTradeDay: -1 } };
  },

  onBar(ctx) {
    const { i, close, ind, params: p } = ctx;
    if (!ctx.isFlat && ctx.lastBarOfSession) return ctx.exit({ reason: 'Session close', atClose: true });
    if (!ctx.isFlat || ctx.lastBarOfSession || ctx.sessionBar > p.lastEntryBar) return;
    if (ind.state.lastTradeDay === ind.day[i]) return; // one trade per day

    const hi = ind.orHigh[i];
    const lo = ind.orLow[i];
    if (!(hi > lo)) return;
    const range = hi - lo;
    const mid = (hi + lo) / 2;

    if (close > hi) {
      ctx.long({ stop: p.stopAtMid ? mid : lo, target: hi + p.targetMult * range, label: 'Break above range' });
      ind.state.lastTradeDay = ind.day[i];
    } else if (close < lo) {
      ctx.short({ stop: p.stopAtMid ? mid : hi, target: lo - p.targetMult * range, label: 'Break below range' });
      ind.state.lastTradeDay = ind.day[i];
    }
  },
};
