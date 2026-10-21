// Opening Range Breakout
//
// Mark the high and low of the first N bars of the day. Trade the first
// close outside that range, stop on the other side of the range, target a
// multiple of the range, one trade per day, flat when the next day starts.

export default {
  name: 'Opening Range Breakout',
  description: 'Trade the first breakout of the day\'s opening range. Stop at the opposite side, target a multiple of the range, one trade a day.',

  params: {
    rangeBars: { value: 6, min: 1, max: 30, label: 'Opening range (bars)' },
    targetMult: { value: 1.5, min: 0.5, max: 5, step: 0.1, label: 'Target (× range)' },
    stopAtMid: { value: false, label: 'Stop at range midpoint' },
    lastEntryBar: { value: 48, min: 5, max: 400, label: 'No entries after bar #' },
  },

  pine({ p }) {
    return {
      body: `
newDay = na(time[1]) or math.floor(time / 86400000) != math.floor(time[1] / 86400000)
var float orHigh = na
var float orLow = na
var int dayBar = 0
var bool tradedToday = false
if newDay
    orHigh := high
    orLow := low
    dayBar := 0
    tradedToday := false
else
    dayBar := dayBar + 1
    if dayBar < ${p.rangeBars}
        orHigh := math.max(orHigh, high)
        orLow := math.min(orLow, low)

orRange = orHigh - orLow
orMid = (orHigh + orLow) / 2
ready = dayBar >= ${p.rangeBars} and dayBar <= ${p.lastEntryBar} and not na(orRange) and orRange > 0
rawLong = ready and not tradedToday and close > orHigh
rawShort = ready and not tradedToday and close < orLow
if rawLong or rawShort
    tradedToday := true`,

      longEntry: 'rawLong',
      shortEntry: 'rawShort',
      longExit: 'newDay',
      shortExit: 'newDay',
      longStop: `${p.stopAtMid} ? orMid : orLow`,
      shortStop: `${p.stopAtMid} ? orMid : orHigh`,
      longTarget: `orHigh + ${p.targetMult} * orRange`,
      shortTarget: `orLow - ${p.targetMult} * orRange`,

      plots: [
        { title: 'Range high', expr: 'orHigh' },
        { title: 'Range low', expr: 'orLow' },
      ],
    };
  },
};
