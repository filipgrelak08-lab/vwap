// Moving Average Crossover
//
// The classic trend follower: long when the fast average crosses above the
// slow one, out (or short, if shorts are allowed) when it crosses back below.

export default {
  name: 'Moving Average Crossover',
  description: 'Long when the fast MA crosses above the slow MA; exit or reverse on the cross back down.',

  params: {
    fast: { value: 20, min: 2, max: 200, label: 'Fast MA length' },
    slow: { value: 50, min: 5, max: 400, label: 'Slow MA length' },
    type: { value: 'EMA', options: ['SMA', 'EMA', 'WMA'], label: 'MA type' },
  },

  pine({ p }) {
    return {
      body: `
maType = ${p.type}
fastMa = maType == "SMA" ? ta.sma(close, ${p.fast}) : maType == "WMA" ? ta.wma(close, ${p.fast}) : ta.ema(close, ${p.fast})
slowMa = maType == "SMA" ? ta.sma(close, ${p.slow}) : maType == "WMA" ? ta.wma(close, ${p.slow}) : ta.ema(close, ${p.slow})`,

      longEntry: 'ta.crossover(fastMa, slowMa)',
      shortEntry: 'ta.crossunder(fastMa, slowMa)',

      plots: [
        { title: 'Fast MA', expr: 'fastMa' },
        { title: 'Slow MA', expr: 'slowMa' },
      ],
    };
  },
};
