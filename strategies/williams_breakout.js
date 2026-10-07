// Larry Williams Volatility Breakout
//
// Each UTC day, set a trigger at today's open plus k times the recent daily
// range (high minus low; by default just yesterday's). Buy the first candle
// that closes above it, and sell at the close of the day's last candle, so
// no trade is held overnight unless you ask for a longer hold. At most one
// trade a day. Meant for intraday charts (1h, 2h, 4h).
//
// Optional short side: sell short the first close below today's open minus
// k times the range. Off by default; the tested version is long only.
//
// The day's last candle is found from the gap between candles, so the same
// code works on any intraday timeframe without setting an hour by hand.

export default {
  name: 'Williams Breakout',
  description: 'Buy when price closes above today\'s open + k × yesterday\'s range, sell at the end of the UTC day. Use a 1h to 4h chart.',

  params: {
    k: { value: 0.5, min: 0.1, max: 1.5, step: 0.05, label: 'k (× daily range)' },
    rangeDays: { value: 1, min: 1, max: 10, label: 'Range: average of last N days' },
    holdDays: { value: 1, min: 1, max: 5, label: 'Hold for (days, 1 = sell at today\'s close)' },
    useTrend: { value: false, label: 'Trend filter: trade with yesterday\'s close vs its daily average' },
    trendDays: { value: 20, min: 5, max: 100, label: 'Daily average length (days)' },
    shorts: { value: false, label: 'Also short breakdowns below the open' },
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
var float cumR = 0.0

if newDay
    // yesterday's range counts only if it was a full day from its 00:00 candle
    pRange := bar_index > 0 and curFromMidnight and dayId == curDay + 1 ? dHi - dLo : 0.0
    cumR := cumR + pRange
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

// average range of the last rangeDays days (1 = yesterday's range)
cumRBack = ta.valuewhen(newDay, cumR, ${p.rangeDays})
avgRange = na(cumRBack) ? 0.0 : (cumR - cumRBack) / ${p.rangeDays}

// average of the last trendDays daily closes, fixed for the whole day
cumBack = ta.valuewhen(newDay, cumC, ${p.trendDays})
dailyMa = na(cumBack) ? na : (cumC - cumBack) / ${p.trendDays}
trendUp = not ${p.useTrend} or (not na(dailyMa) and pdc > dailyMa)
trendDown = not ${p.useTrend} or (not na(dailyMa) and pdc < dailyMa)

ready = not traded and not lastBar and strategy.position_size == 0 and pRange > 0 and avgRange > 0
upTrigger = dOpen + ${p.k} * avgRange
downTrigger = dOpen - ${p.k} * avgRange
rawLong = ready and close > upTrigger and trendUp
rawShort = ready and ${p.shorts} and not rawLong and close < downTrigger and trendDown
if rawLong or rawShort
    traded := true
    entryDay := dayId

// sell at the close of the last candle of day holdDays (1 = the entry day)
exitDay = dayId - entryDay >= ${p.holdDays} or (lastBar and dayId - entryDay >= ${p.holdDays} - 1)`,

      longEntry: 'rawLong',
      shortEntry: 'rawShort',
      longExit: 'exitDay',
      shortExit: 'exitDay',

      plots: [
        { title: 'Buy trigger', expr: 'avgRange > 0 ? upTrigger : na' },
        { title: 'Short trigger', expr: `${p.shorts} and avgRange > 0 ? downTrigger : na` },
      ],
    };
  },
};
