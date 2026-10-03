// Time-series Momentum
//
// Hold while the close is above the close N bars ago (Moskowitz, Ooi & Pedersen 2012;
// Liu & Tsyvinski 2021 for crypto). With shorts on, go short when it is below; turn on
// "Allow short selling" under Execution too. In research/strategy_search the 30-day
// version looked best before 2022 and has been mixed since; shorts lost money.

export default {
  name: 'Time-series Momentum',
  description: 'Daily: long while the close is above the close N bars ago (optionally short below). A classic trend filter.',

  params: {
    lookback: { value: 30, min: 2, max: 365, label: 'Lookback (bars)' },
    shorts: { value: false, label: 'Go short when momentum is negative' },
  },

  setup({ data, params, plot }) {
    const n = params.lookback;
    const mom = data.close.map((c, i) => (i >= n ? (c / data.close[i - n] - 1) * 100 : NaN));
    plot(`${n}-bar return %`, mom, { pane: 'lower', style: 'histogram', levels: [0] });
    return { mom };
  },

  onBar(ctx) {
    const { i, ind, params: p } = ctx;
    const m = ind.mom[i];
    if (!Number.isFinite(m)) return;
    if (m > 0 && !ctx.isLong) ctx.long({ label: 'Momentum positive' });
    else if (m <= 0 && p.shorts && !ctx.isShort) ctx.short({ label: 'Momentum negative' });
    else if (m <= 0 && !p.shorts && ctx.isLong) ctx.exit('Momentum negative');
  },
};
