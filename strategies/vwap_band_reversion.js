// VWAP Band Reversion
//
// Price tends to snap back to the anchored VWAP on range-bound days.
// Fade closes outside VWAP ± k·σ (volume-weighted standard deviation),
// take profit back at VWAP, stop further out, and flatten when the anchor
// resets. The anchor resets every N days; 1 is the usual daily VWAP.

export default {
  name: 'VWAP Band Reversion',
  description: 'Mean reversion: fade closes outside the VWAP ± k·σ bands and exit back at VWAP.',

  params: {
    band: { value: 2, min: 0.5, max: 4, step: 0.1, label: 'Entry band (σ)' },
    stopBand: { value: 3.5, min: 1, max: 6, step: 0.1, label: 'Stop band (σ)' },
    anchorDays: { value: 1, min: 1, max: 30, label: 'Reset VWAP every (days)' },
    skipBars: { value: 6, min: 0, max: 30, label: 'Skip first bars after the reset' },
    lastEntryBar: { value: 66, min: 10, max: 400, label: 'No entries after bar #' },
    rsiFilter: { value: true, label: 'Require RSI extreme' },
    rsiLen: { value: 7, min: 2, max: 30, label: 'RSI length' },
  },

  pine({ p }) {
    return {
      body: `
// anchored VWAP and its volume-weighted standard deviation
bucket = math.floor(time / 86400000 / ${p.anchorDays})
newAnchor = na(bucket[1]) or bucket != bucket[1]
var float cumPV = 0.0
var float cumV = 0.0
var float cumPV2 = 0.0
var int anchorBar = 0
if newAnchor
    cumPV := 0.0
    cumV := 0.0
    cumPV2 := 0.0
    anchorBar := 0
else
    anchorBar := anchorBar + 1
src = hlc3
cumPV := cumPV + src * volume
cumV := cumV + volume
cumPV2 := cumPV2 + src * src * volume
vwapVal = cumV > 0 ? cumPV / cumV : src
sd = math.sqrt(math.max(cumV > 0 ? cumPV2 / cumV - vwapVal * vwapVal : 0.0, 0.0))
upperBand = vwapVal + ${p.band} * sd
lowerBand = vwapVal - ${p.band} * sd
rsiVal = ta.rsi(close, ${p.rsiLen})
canEnter = sd > 0 and anchorBar >= ${p.skipBars} and anchorBar <= ${p.lastEntryBar}`,

      longEntry: `canEnter and close < lowerBand and (not ${p.rsiFilter} or rsiVal < 30)`,
      shortEntry: `canEnter and close > upperBand and (not ${p.rsiFilter} or rsiVal > 70)`,
      longExit: 'close >= vwapVal or newAnchor',
      shortExit: 'close <= vwapVal or newAnchor',
      longStop: `vwapVal - ${p.stopBand} * sd`,
      shortStop: `vwapVal + ${p.stopBand} * sd`,

      plots: [
        { title: 'VWAP', expr: 'vwapVal' },
        { title: 'Upper band', expr: 'upperBand' },
        { title: 'Lower band', expr: 'lowerBand' },
      ],
    };
  },
};
