// RSI(2) Pullback  (after Larry Connors)
//
// In a long-term uptrend (close above the 200 SMA), buy when a very short RSI
// is deeply oversold and sell into the first bounce above a short SMA.
// Designed for daily bars on stocks and indices. Long only.

export default {
  name: 'RSI(2) Pullback',
  description: 'Daily long-only: buy deep RSI(2) dips while above the 200 SMA, sell when price closes above the 5 SMA.',

  params: {
    rsiLen: { value: 2, min: 2, max: 14, label: 'RSI length' },
    entryRsi: { value: 10, min: 1, max: 40, label: 'Buy when RSI below' },
    trendLen: { value: 200, min: 20, max: 400, label: 'Trend SMA length' },
    exitLen: { value: 5, min: 2, max: 30, label: 'Exit SMA length' },
    maxBars: { value: 10, min: 1, max: 60, label: 'Time stop (bars)' },
  },

  setup({ data, params, ta, plot }) {
    const rsi = ta.rsi(data.close, params.rsiLen);
    const trend = ta.sma(data.close, params.trendLen);
    const exitMa = ta.sma(data.close, params.exitLen);
    plot(`SMA ${params.trendLen}`, trend, { color: 'vwap', width: 2 });
    plot(`SMA ${params.exitLen}`, exitMa, { color: 'band' });
    plot(`RSI(${params.rsiLen})`, rsi, { pane: 'lower', levels: [params.entryRsi] });
    return { rsi, trend, exitMa };
  },

  onBar(ctx) {
    const { i, close, ind, params: p } = ctx;
    if (ctx.isLong) {
      if (close > ind.exitMa[i]) ctx.exit('Close above exit SMA');
      else if (ctx.position.barsHeld >= p.maxBars) ctx.exit('Time stop');
      return;
    }
    if (close > ind.trend[i] && ind.rsi[i] < p.entryRsi) ctx.long({ label: 'RSI oversold in uptrend' });
  },
};
