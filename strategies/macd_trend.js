// MACD Trend
//
// MACD line crossing its signal line, traded only in the direction of a
// long EMA trend filter.

export default {
  name: 'MACD Trend',
  description: 'MACD / signal-line crosses in the direction of the 200 EMA. Exit on the opposite cross.',

  params: {
    fast: { value: 12, min: 2, max: 50, label: 'Fast EMA' },
    slow: { value: 26, min: 5, max: 100, label: 'Slow EMA' },
    signal: { value: 9, min: 2, max: 30, label: 'Signal EMA' },
    trendLen: { value: 200, min: 20, max: 400, label: 'Trend EMA' },
  },

  setup({ data, params, ta, plot }) {
    const m = ta.macd(data.close, params.fast, params.slow, params.signal);
    const trend = ta.ema(data.close, params.trendLen);
    plot(`EMA ${params.trendLen}`, trend, { color: 'vwap', width: 2 });
    plot('MACD', m.macd, { pane: 'lower', color: 'accent' });
    plot('Signal', m.signal, { pane: 'lower', color: 'vwap' });
    plot('Histogram', m.hist, { pane: 'lower', style: 'histogram' });
    return { ...m, trend };
  },

  onBar(ctx) {
    const { i, close, ind } = ctx;
    const up = ctx.crossOver(ind.macd, ind.signal);
    const down = ctx.crossUnder(ind.macd, ind.signal);
    if (ctx.isLong && down) return ctx.exit('MACD cross down');
    if (ctx.isShort && up) return ctx.exit('MACD cross up');
    if (!ctx.isFlat) return;
    if (up && close > ind.trend[i]) ctx.long({ label: 'MACD cross up' });
    else if (down && close < ind.trend[i]) ctx.short({ label: 'MACD cross down' });
  },
};
