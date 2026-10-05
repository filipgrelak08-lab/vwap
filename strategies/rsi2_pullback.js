// RSI(2) Pullback  (after Larry Connors)
//
// In a long-term uptrend (close above the 200 SMA), buy when a very short RSI
// is deeply oversold and sell into the first bounce above a short SMA.
// Long only.

export default {
  name: 'RSI(2) Pullback',
  description: 'Long-only: buy deep RSI(2) dips while above the 200 SMA, sell when price closes above the 5 SMA.',

  params: {
    rsiLen: { value: 2, min: 2, max: 14, label: 'RSI length' },
    entryRsi: { value: 10, min: 1, max: 40, label: 'Buy when RSI below' },
    trendLen: { value: 200, min: 20, max: 400, label: 'Trend SMA length' },
    exitLen: { value: 5, min: 2, max: 30, label: 'Exit SMA length' },
    maxBars: { value: 10, min: 1, max: 60, label: 'Time stop (bars)' },
  },

  pine({ p }) {
    return {
      body: `
rsiVal = ta.rsi(close, ${p.rsiLen})
trendMa = ta.sma(close, ${p.trendLen})
exitMa = ta.sma(close, ${p.exitLen})

// bars the current position has been open, for the strategy's own time stop
var int barsHeld = 0
barsHeld := strategy.position_size != 0 ? barsHeld + 1 : 0`,

      longEntry: `close > trendMa and rsiVal < ${p.entryRsi}`,
      longExit: `close > exitMa or barsHeld >= ${p.maxBars}`,

      // Plots share the price chart, so RSI is left off: on the price axis it
      // would flatten the candles into a line.
      plots: [
        { title: 'Trend SMA', expr: 'trendMa' },
        { title: 'Exit SMA', expr: 'exitMa' },
      ],
    };
  },
};
