// N-day High / Low  (after Padysak & Vojtko 2022)
//
// Hold for the next bar whenever the close is the highest close of the last N
// bars (trend following, "MAX") or the lowest (mean reversion, "MIN"). The paper
// used daily Bitcoin with N = 10 and both legs. Tested after publication, only
// the high (MAX) leg kept working; see research/btc_paper_edges.

export default {
  name: 'N-day High / Low',
  description: 'Daily long-only: hold while the close is at its N-bar high (trend) and/or N-bar low (mean reversion). Paper default: BTC, N = 10, both legs.',

  params: {
    lookback: { value: 10, min: 2, max: 100, label: 'Lookback (bars)' },
    buyHigh: { value: true, label: 'Hold at the N-bar high (trend)' },
    buyLow: { value: true, label: 'Hold at the N-bar low (mean reversion)' },
  },

  setup({ data, params, ta, plot }) {
    const hh = ta.highest(data.close, params.lookback);
    const ll = ta.lowest(data.close, params.lookback);
    plot(`${params.lookback}-bar high`, hh, { color: 'up', style: 'dashed' });
    plot(`${params.lookback}-bar low`, ll, { color: 'down', style: 'dashed' });
    return { hh, ll };
  },

  onBar(ctx) {
    const { i, close, ind, params: p } = ctx;
    const atHigh = p.buyHigh && close >= ind.hh[i];
    const atLow = p.buyLow && close <= ind.ll[i];
    if ((atHigh || atLow) && ctx.isFlat) ctx.long({ label: atHigh ? 'New N-bar high' : 'New N-bar low' });
    else if (!atHigh && !atLow && ctx.isLong) ctx.exit('Off the extreme');
  },
};
