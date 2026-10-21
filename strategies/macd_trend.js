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

  pine({ p }) {
    return {
      body: `
[macdLine, signalLine, histLine] = ta.macd(close, ${p.fast}, ${p.slow}, ${p.signal})
trendMa = ta.ema(close, ${p.trendLen})
crossUp = ta.crossover(macdLine, signalLine)
crossDown = ta.crossunder(macdLine, signalLine)`,

      longEntry: 'crossUp and close > trendMa',
      shortEntry: 'crossDown and close < trendMa',
      longExit: 'crossDown',
      shortExit: 'crossUp',

      // Plots share the price chart, so the MACD lines are left off: they sit
      // around zero and would flatten the candles into a line.
      plots: [{ title: 'Trend EMA', expr: 'trendMa' }],
    };
  },
};
