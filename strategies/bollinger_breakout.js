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
    trendFilter: { value: true, label: 'Only trade with the trend EMA' },
    trendLen: { value: 100, min: 20, max: 400, label: 'Trend EMA length' },
  },

  pine({ p }) {
    return {
      body: `
[bbMid, bbUpper, bbLower] = ta.bb(close, ${p.length}, ${p.mult})
trendMa = ta.ema(close, ${p.trendLen})`,

      longEntry: `close > bbUpper and (not ${p.trendFilter} or close > trendMa)`,
      shortEntry: `close < bbLower and (not ${p.trendFilter} or close < trendMa)`,
      longExit: 'close < bbMid',
      shortExit: 'close > bbMid',

      plots: [
        { title: 'Upper band', expr: 'bbUpper' },
        { title: 'Middle band', expr: 'bbMid' },
        { title: 'Lower band', expr: 'bbLower' },
        { title: 'Trend EMA', expr: 'trendMa' },
      ],
    };
  },
};
