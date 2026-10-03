// Donchian Trend Ensemble  (Zarattini, Pagani & Barbon 2025, "Catching Crypto Trends")
//
// Nine Donchian trend systems with lookbacks from 5 to 360 bars. Each goes long when
// the close beats the highest close of the previous n bars and exits on a close below
// its trailing stop: the higher of the old stop and the channel midpoint. The paper
// sizes by the share of systems that are long; here the strategy holds while at least
// `vote` of them are long. Daily bars, long only. Tested in research/strategy_search.

const LOOKBACKS = [5, 10, 20, 30, 60, 90, 150, 250, 360];

export default {
  name: 'Donchian Trend Ensemble',
  description: 'Daily long-only trend following: nine Donchian breakout systems (5–360 bars) with midpoint trailing stops; hold while enough of them are long.',

  params: {
    vote: { value: 0.5, min: 0.1, max: 1, step: 0.05, label: 'Hold when this share of systems is long' },
  },

  setup({ data, ta, plot }) {
    const n = data.length;
    const share = new Array(n).fill(0);
    for (const len of LOOKBACKS) {
      const hi = ta.highest(data.close, len);
      const lo = ta.lowest(data.close, len);
      let on = false;
      let stop = 0;
      for (let i = 1; i < n; i++) {
        if (!(hi[i - 1] > 0) || !(lo[i] > 0)) continue;
        const mid = (hi[i] + lo[i]) / 2;
        if (!on && data.close[i] > hi[i - 1]) {
          on = true;
          stop = mid;
        } else if (on) {
          stop = Math.max(stop, mid);
          if (data.close[i] < stop) on = false;
        }
        if (on) share[i] += 1 / LOOKBACKS.length;
      }
    }
    plot('Share of systems long', share, { pane: 'lower', style: 'histogram' });
    return { share };
  },

  onBar(ctx) {
    const { i, ind, params: p } = ctx;
    const hold = ind.share[i] >= p.vote - 1e-9;
    if (hold && ctx.isFlat) ctx.long({ label: `${Math.round(ind.share[i] * 9)} of 9 systems long` });
    else if (!hold && ctx.isLong) ctx.exit('Too few systems long');
  },
};
