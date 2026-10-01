// VWAP Band Reversion (intraday)
//
// On range-bound days price tends to snap back to the session VWAP.
// Fade closes outside VWAP ± k·σ (volume-weighted standard deviation),
// take profit back at VWAP, stop further out, and be flat by the close.
// Works on intraday data (1m–1h). On daily bars switch the anchor to week or month.

export default {
  name: 'VWAP Band Reversion',
  description: 'Intraday mean reversion: fade closes outside the VWAP ± k·σ bands, exit back at VWAP, flat by the close.',

  params: {
    band: { value: 2, min: 0.5, max: 4, step: 0.1, label: 'Entry band (σ)' },
    stopBand: { value: 3.5, min: 1, max: 6, step: 0.1, label: 'Stop band (σ)' },
    skipBars: { value: 6, min: 0, max: 30, label: 'Skip first bars of session' },
    lastEntryBar: { value: 66, min: 10, max: 400, label: 'No entries after bar #' },
    rsiFilter: { value: true, label: 'Require RSI extreme' },
    rsiLen: { value: 7, min: 2, max: 30, label: 'RSI length' },
    anchor: { value: 'session', options: ['session', 'week', 'month'], label: 'VWAP anchor' },
  },

  setup({ data, params, ta, plot }) {
    const bands = ta.vwapBands(data, params.band, params.anchor);
    const rsi = ta.rsi(data.close, params.rsiLen);
    const intraday = ta.sessionStart(data).some((s, i) => i > 0 && !s);
    plot('VWAP', bands.vwap, { color: 'vwap', width: 2 });
    plot('Upper band', bands.upper, { color: 'band', style: 'dashed' });
    plot('Lower band', bands.lower, { color: 'band', style: 'dashed' });
    plot('RSI', rsi, { pane: 'lower', levels: [30, 70] });
    return { ...bands, rsi, intraday };
  },

  onBar(ctx) {
    const { i, close, ind, params: p } = ctx;
    const vwap = ind.vwap[i];
    const sd = ind.stdev[i];

    // exits
    if (ctx.isLong && close >= vwap) return ctx.exit('Back at VWAP');
    if (ctx.isShort && close <= vwap) return ctx.exit('Back at VWAP');
    if (ind.intraday && !ctx.isFlat && ctx.lastBarOfSession) return ctx.exit({ reason: 'Session close', atClose: true });

    // entries
    if (!ctx.isFlat || !(sd > 0)) return;
    if (ind.intraday && (ctx.sessionBar < p.skipBars || ctx.sessionBar > p.lastEntryBar || ctx.lastBarOfSession)) return;
    const rsi = ind.rsi[i];
    if (close < ind.lower[i] && (!p.rsiFilter || rsi < 30)) {
      ctx.long({ stop: vwap - p.stopBand * sd, label: 'Below lower band' });
    } else if (close > ind.upper[i] && (!p.rsiFilter || rsi > 70)) {
      ctx.short({ stop: vwap + p.stopBand * sd, label: 'Above upper band' });
    }
  },
};
