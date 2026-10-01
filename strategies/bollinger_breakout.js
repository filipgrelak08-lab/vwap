// Bollinger Band Breakout
//
// Volatility expansion: go with a close outside the bands, exit when price
// falls back through the middle band.

export default {
  name: 'Bollinger Breakout',
  description: 'Go long on a close above the upper band (short below the lower band); exit when price crosses the middle band.',

  params: {
    length: { value: 20, min: 5, max: 100, label: 'Length' },
    mult: { value: 2, min: 0.5, max: 4, step: 0.1, label: 'Width (σ)' },
    trendFilter: { value: true, label: 'Only trade with the 100 EMA' },
  },

  setup({ data, params, ta, plot }) {
    const bb = ta.bollinger(data.close, params.length, params.mult);
    const trend = ta.ema(data.close, 100);
    plot('Upper', bb.upper, { color: 'band' });
    plot('Middle', bb.middle, { color: 'accent' });
    plot('Lower', bb.lower, { color: 'band' });
    return { ...bb, trend };
  },

  onBar(ctx) {
    const { i, close, ind, params: p } = ctx;
    if (ctx.isLong && close < ind.middle[i]) return ctx.exit('Back below middle');
    if (ctx.isShort && close > ind.middle[i]) return ctx.exit('Back above middle');
    if (!ctx.isFlat) return;
    const upOk = !p.trendFilter || close > ind.trend[i];
    const downOk = !p.trendFilter || close < ind.trend[i];
    if (close > ind.upper[i] && upOk) ctx.long({ label: 'Close above upper band' });
    else if (close < ind.lower[i] && downOk) ctx.short({ label: 'Close below lower band' });
  },
};
