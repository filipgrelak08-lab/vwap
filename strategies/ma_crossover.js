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

  setup({ data, params, ta, plot }) {
    const ma = { SMA: ta.sma, EMA: ta.ema, WMA: ta.wma }[params.type];
    const fast = ma(data.close, params.fast);
    const slow = ma(data.close, params.slow);
    plot(`Fast ${params.type} ${params.fast}`, fast, { color: 'accent' });
    plot(`Slow ${params.type} ${params.slow}`, slow, { color: 'vwap' });
    return { fast, slow };
  },

  onBar(ctx) {
    const { ind } = ctx;
    if (ctx.crossOver(ind.fast, ind.slow)) ctx.long({ label: 'Golden cross' });
    if (ctx.crossUnder(ind.fast, ind.slow)) ctx.short({ label: 'Death cross' });
  },
};
