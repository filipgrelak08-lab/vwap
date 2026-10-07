// Larry Williams Volatility Breakout
//
// Each UTC day, set a trigger at today's open plus k times yesterday's range
// (high minus low). Buy the first candle that closes above it, then sell at
// the close of the day's last candle, so no trade is held overnight. Long
// only, at most one trade a day. Meant for intraday charts (1h, 2h, 4h).
//
// The day's last candle is found from the gap between candles, so the same
// code works on any intraday timeframe without setting an hour by hand.

export default {
  name: 'Williams Breakout',
  description: 'Long-only: buy when price closes above today\'s open + k × yesterday\'s range, sell at the end of the UTC day. Use a 1h to 4h chart.',

  params: {
    k: { value: 0.5, min: 0.1, max: 1.5, step: 0.05, label: 'k (× yesterday\'s range)' },
    useTrend: { value: false, label: 'Only when yesterday\'s close is above its daily average' },
    trendDays: { value: 20, min: 5, max: 100, label: 'Daily average length (days)' },
  },

  pine({ p }) {
    return {
      body: `
dayId = math.floor(time / 86400000)
hr = math.floor(time / 3600000) % 24
newDay = bar_index == 0 or dayId != dayId[1]

// candle length in ms: the smallest gap seen between candles
var int barMs = 0
gap = bar_index > 0 ? time - time[1] : 0
if gap > 0 and (barMs == 0 or gap < barMs)
    barMs := gap
lastBar = barMs > 0 and math.floor((time + barMs) / 86400000) != dayId

var float dOpen = na
var float dHi = na
var float dLo = na
var float pRange = 0.0
var int curDay = -1
var bool curFromMidnight = false
var bool traded = false
var int entryDay = -1
var float pdc = na
var float cumC = 0.0

if newDay
    // yesterday's range counts only if it was a full day from its 00:00 candle
    pRange := bar_index > 0 and curFromMidnight and dayId == curDay + 1 ? dHi - dLo : 0.0
    if bar_index > 0
        pdc := close[1]
        cumC := cumC + close[1]
    dOpen := open
    dHi := high
    dLo := low
    curDay := dayId
    curFromMidnight := hr == 0
    traded := false
else
    dHi := math.max(dHi, high)
    dLo := math.min(dLo, low)

// average of the last trendDays daily closes, fixed for the whole day
cumBack = ta.valuewhen(newDay, cumC, ${p.trendDays})
dailyMa = na(cumBack) ? na : (cumC - cumBack) / ${p.trendDays}
trendOk = not ${p.useTrend} or (not na(dailyMa) and pdc > dailyMa)

trigger = dOpen + ${p.k} * pRange
rawLong = not traded and not lastBar and pRange > 0 and close > trigger and trendOk
if rawLong
    traded := true
    entryDay := dayId`,

      longEntry: 'rawLong',
      longExit: 'lastBar or dayId != entryDay',

      plots: [{ title: 'Trigger', expr: 'pRange > 0 ? trigger : na' }],
    };
  },
};
