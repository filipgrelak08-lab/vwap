// VWAP Trend Pullback
//
// Trade with the trend since the VWAP anchor reset: when VWAP is rising and
// price pulls back to touch it, buy the bounce (mirror image for shorts).
// The stop sits a multiple of ATR beyond VWAP; the target is a multiple of
// that risk.

export default {
  name: 'VWAP Trend Pullback',
  description: 'Buy pullbacks to a rising anchored VWAP (sell rallies to a falling one). ATR stop, fixed reward:risk target.',

  params: {
    slopeBars: { value: 12, min: 2, max: 60, label: 'VWAP slope lookback (bars)' },
    touchPct: { value: 0.05, min: 0, max: 0.5, step: 0.01, label: 'Touch tolerance (%)' },
    atrLen: { value: 14, min: 2, max: 50, label: 'ATR length' },
    stopAtr: { value: 1.5, min: 0.5, max: 5, step: 0.1, label: 'Stop (× ATR)' },
    rewardRisk: { value: 2, min: 0.5, max: 6, step: 0.1, label: 'Target (× risk)' },
    anchorDays: { value: 1, min: 1, max: 30, label: 'Reset VWAP every (days)' },
    skipBars: { value: 6, min: 0, max: 30, label: 'Skip first bars after the reset' },
  },

  pine({ p }) {
    return {
      body: `
// anchored VWAP
bucket = math.floor(time / 86400000 / ${p.anchorDays})
newAnchor = na(bucket[1]) or bucket != bucket[1]
var float cumPV = 0.0
var float cumV = 0.0
var int anchorBar = 0
if newAnchor
    cumPV := 0.0
    cumV := 0.0
    anchorBar := 0
else
    anchorBar := anchorBar + 1
src = hlc3
cumPV := cumPV + src * volume
cumV := cumV + volume
vwapVal = cumV > 0 ? cumPV / cumV : src

atrVal = ta.atr(${p.atrLen})
prior = vwapVal[${p.slopeBars}]
tol = vwapVal * ${p.touchPct} / 100
ready = atrVal > 0 and not na(prior) and anchorBar >= math.max(${p.skipBars}, ${p.slopeBars})`,

      longEntry: 'ready and vwapVal > prior and low <= vwapVal + tol and close > vwapVal',
      shortEntry: 'ready and vwapVal < prior and high >= vwapVal - tol and close < vwapVal',
      longExit: 'newAnchor',
      shortExit: 'newAnchor',
      longStop: `vwapVal - ${p.stopAtr} * atrVal`,
      shortStop: `vwapVal + ${p.stopAtr} * atrVal`,
      longTarget: `close + ${p.rewardRisk} * (close - (vwapVal - ${p.stopAtr} * atrVal))`,
      shortTarget: `close - ${p.rewardRisk} * ((vwapVal + ${p.stopAtr} * atrVal) - close)`,

      plots: [{ title: 'VWAP', expr: 'vwapVal' }],
    };
  },
};
