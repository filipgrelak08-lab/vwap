// VWAP Trend Pullback (intraday)
//
// Trade with the day's trend: when VWAP is rising and price pulls back to
// touch it, buy the bounce (mirror image for shorts). The stop sits a
// multiple of ATR beyond VWAP; the target is a multiple of that risk.

export default {
  name: 'VWAP Trend Pullback',
  description: 'Buy pullbacks to a rising session VWAP (sell rallies to a falling one). ATR stop, fixed reward:risk target.',

  params: {
    slopeBars: { value: 12, min: 2, max: 60, label: 'VWAP slope lookback (bars)' },
    touchPct: { value: 0.05, min: 0, max: 0.5, step: 0.01, label: 'Touch tolerance (%)' },
    atrLen: { value: 14, min: 2, max: 50, label: 'ATR length' },
    stopAtr: { value: 1.5, min: 0.5, max: 5, step: 0.1, label: 'Stop (× ATR)' },
    rewardRisk: { value: 2, min: 0.5, max: 6, step: 0.1, label: 'Target (× risk)' },
    skipBars: { value: 6, min: 0, max: 30, label: 'Skip first bars of session' },
  },

  setup({ data, params, ta, plot }) {
    const vwap = ta.vwap(data, 'session');
    const atr = ta.atr(data, params.atrLen);
    const intraday = ta.sessionStart(data).some((s, i) => i > 0 && !s);
    plot('VWAP', vwap, { color: 'vwap', width: 2 });
    return { vwap, atr, intraday };
  },

  onBar(ctx) {
    const { i, close, low, high, ind, params: p } = ctx;
    if (ind.intraday && !ctx.isFlat && ctx.lastBarOfSession) return ctx.exit({ reason: 'Session close', atClose: true });
    if (!ctx.isFlat || ctx.sessionBar < Math.max(p.skipBars, p.slopeBars) || ctx.lastBarOfSession) return;

    const v = ind.vwap[i];
    const prior = ind.vwap[i - p.slopeBars];
    const atr = ind.atr[i];
    if (!(atr > 0)) return;
    const tol = v * (p.touchPct / 100);

    if (v > prior && low <= v + tol && close > v) {
      const stop = v - p.stopAtr * atr;
      ctx.long({ stop, target: close + p.rewardRisk * (close - stop), label: 'Pullback to rising VWAP' });
    } else if (v < prior && high >= v - tol && close < v) {
      const stop = v + p.stopAtr * atr;
      ctx.short({ stop, target: close - p.rewardRisk * (stop - close), label: 'Rally to falling VWAP' });
    }
  },
};
