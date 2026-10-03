// Hour-of-day Window  (after Padysak & Vojtko 2022)
//
// Long only during a fixed clock window each day, flat the rest of the time.
// The paper found Bitcoin's two best hours were 21:00-23:00 UTC (2015-2022).
// Since then the edge per trade has shrunk below typical crypto fees; see
// research/btc_paper_edges. Times are exchange time (UTC for Binance).
// Needs intraday data; 1h bars match the paper.

export default {
  name: 'Hour-of-day Window',
  description: 'Intraday: long from the start hour for a set number of hours each day, flat otherwise. Paper default: BTC 21:00–23:00 UTC.',

  params: {
    startHour: { value: 21, min: 0, max: 23, label: 'Start hour (exchange time)' },
    hours: { value: 2, min: 1, max: 23, label: 'Hold for (hours)' },
  },

  setup({ data }) {
    // bar length, so the window lines up on any intraday interval
    let step = Infinity;
    for (let i = 1; i < Math.min(data.length, 200); i++) {
      const d = data.time[i] - data.time[i - 1];
      if (d > 0) step = Math.min(step, d);
    }
    return { step: Number.isFinite(step) ? step : 3600 };
  },

  onBar(ctx) {
    const { ind, params: p } = ctx;
    // clock time at which an order placed now fills (the end of this bar)
    const fill = (((ctx.time + ind.step) % 86400) + 86400) % 86400;
    const start = p.startHour * 3600;
    const end = (start + p.hours * 3600) % 86400;
    const inside = start < end ? fill >= start && fill < end : fill >= start || fill < end;
    if (inside && ctx.isFlat) ctx.long({ label: 'Window opens' });
    else if (!inside && ctx.isLong) ctx.exit('Window closes');
  },
};
