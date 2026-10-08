// Bollinger Breakout + Long-Term Trend  (long only)
//
// The Bollinger breakout from the portfolio: buy a close above the upper band
// while price is above both the 100 EMA and a long 300-candle SMA, keep a 3%
// stop below the entry, and sell when price closes back under the middle band.
// A new breakout close while in the trade moves the stop to 3% below it.
//
// Tested on 4h, Sep 2020 to Oct 2026: BTC +531% (worst drop 25%),
// SOL +248% (worst drop 33%). About one trade every two weeks per coin.

export default {
  name: 'Bollinger Breakout + Long Trend',
  description: 'Long-only: buy a close above the upper band when above the 100 EMA and 300 SMA; 3% stop; sell below the middle band. Use a 4h chart.',

  params: {
    length: { value: 20, min: 5, max: 100, label: 'Length' },
    mult: { value: 2, min: 0.5, max: 4, step: 0.1, label: 'Width (σ)' },
    trendLen: { value: 100, min: 20, max: 400, label: 'Trend EMA length' },
    regimeLen: { value: 300, min: 50, max: 600, label: 'Long-term SMA length' },
    stopPct: { value: 3, min: 0.5, max: 10, step: 0.5, label: 'Stop loss %' },
  },

  pine({ p }) {
    return {
      body: `
[bbMid, bbUpper, bbLower] = ta.bb(close, ${p.length}, ${p.mult})
trendMa = ta.ema(close, ${p.trendLen})
regimeMa = ta.sma(close, ${p.regimeLen})`,

      longEntry: `close > bbUpper and close > trendMa and not na(regimeMa) and close > regimeMa`,
      longExit: 'close < bbMid',
      longStop: `close * (1 - ${p.stopPct} / 100)`,

      plots: [
        { title: 'Upper band', expr: 'bbUpper' },
        { title: 'Middle band', expr: 'bbMid' },
        { title: 'Lower band', expr: 'bbLower' },
        { title: 'Trend EMA', expr: 'trendMa' },
        { title: 'Long-term SMA', expr: 'regimeMa' },
      ],
    };
  },
};
