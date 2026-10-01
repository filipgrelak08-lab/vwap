// Donchian Channel Breakout  (Turtle-style)
//
// Buy a breakout above the highest high of the last N bars, exit on a break
// of the M-bar low, with an initial stop k × ATR from entry.

export default {
  name: 'Donchian Breakout',
  description: 'Turtle-style: enter on an N-bar high/low breakout, exit on the shorter opposite channel, ATR initial stop.',

  params: {
    entryLen: { value: 20, min: 5, max: 120, label: 'Entry channel (bars)' },
    exitLen: { value: 10, min: 2, max: 60, label: 'Exit channel (bars)' },
    atrLen: { value: 20, min: 5, max: 60, label: 'ATR length' },
    stopAtr: { value: 2, min: 0.5, max: 6, step: 0.1, label: 'Initial stop (× ATR)' },
  },

  setup({ data, params, ta, plot }) {
    const entry = ta.donchian(data, params.entryLen);
    const exit = ta.donchian(data, params.exitLen);
    const atr = ta.atr(data, params.atrLen);
    plot(`High ${params.entryLen}`, entry.upper, { color: 'up' });
    plot(`Low ${params.entryLen}`, entry.lower, { color: 'down' });
    return { entry, exit, atr };
  },

  onBar(ctx) {
    const { i, close, ind, params: p } = ctx;
    if (i < 1) return;
    // compare with the channel as of the previous bar, so today's bar can break it
    const upper = ind.entry.upper[i - 1];
    const lower = ind.entry.lower[i - 1];
    if (ctx.isLong && close < ind.exit.lower[i - 1]) return ctx.exit(`${p.exitLen}-bar low`);
    if (ctx.isShort && close > ind.exit.upper[i - 1]) return ctx.exit(`${p.exitLen}-bar high`);
    if (!ctx.isFlat) return;
    const atr = ind.atr[i];
    if (close > upper) ctx.long({ stop: close - p.stopAtr * atr, label: `${p.entryLen}-bar breakout` });
    else if (close < lower) ctx.short({ stop: close + p.stopAtr * atr, label: `${p.entryLen}-bar breakdown` });
  },
};
