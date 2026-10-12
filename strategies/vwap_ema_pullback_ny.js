// VWAP + EMA Pullback (New York session)
//
// Trend pullback for intraday charts (built for BTC on 5m). Go long when the
// fast EMA is above the slow EMA, VWAP is higher than it was a few candles
// ago, and price has dipped to VWAP within the last few candles and closes
// back above it on a green candle (mirror image for shorts).
//
// Stop: just beyond the pullback's extreme (lowest low of the touch window,
// minus a few ticks). Target: a multiple of that risk. Two filters skip
// trades: price was stretched too far from VWAP before the pullback, or the
// stop would be too wide, both measured in ATR (0 turns a filter off).
//
// Entries only between two New York clock times, open trades are closed at
// a set New York time, and an optional cap on trades per New York day.
// New York time follows US daylight saving (EDT from the second Sunday of
// March to the first Sunday of November, EST otherwise). Crypto trades every
// day, so weekends count too.
//
// VWAP resets at 00:00 UTC, the usual crypto session. Size is the tester's
// 100% of the account; there is no contracts setting.

export default {
  name: 'VWAP + EMA Pullback (NY session)',
  description: 'Buy pullbacks to a rising VWAP when the fast EMA is above the slow one (shorts mirrored), New York session hours only. Stop under the pullback, target a multiple of the risk. Use a 5m chart.',

  params: {
    takeLongs: { value: true, label: 'Take longs' },
    takeShorts: { value: true, label: 'Take shorts' },
    slopeBars: { value: 5, min: 1, max: 60, label: 'VWAP slope: compare with (bars ago)' },
    fastLen: { value: 20, min: 2, max: 200, label: 'Fast EMA' },
    slowLen: { value: 50, min: 3, max: 400, label: 'Slow EMA' },
    touchBars: { value: 3, min: 1, max: 20, label: 'VWAP touch within the previous (candles)' },
    maxExtAtr: { value: 2, min: 0, max: 10, step: 0.1, label: 'Skip if price was this far from VWAP before the pullback (× ATR, 0 = off)' },
    stopTicks: { value: 1, min: 0, max: 1000, label: 'Stop buffer (ticks)' },
    tickSize: { value: 0.1, min: 0.0001, max: 100, step: 0.0001, label: 'Tick size (BTCUSDT = 0.1)' },
    atrLen: { value: 1, min: 1, max: 50, label: 'ATR length' },
    maxStopAtr: { value: 2, min: 0, max: 10, step: 0.1, label: 'Skip if the stop is wider than (× ATR, 0 = off)' },
    rewardRisk: { value: 1, min: 0.1, max: 10, step: 0.1, label: 'Take profit (× initial risk)' },
    startHHMM: { value: 945, min: 0, max: 2359, label: 'Take entries from (NY time, HHMM)' },
    endHHMM: { value: 1130, min: 0, max: 2359, label: 'Take entries until (NY time, HHMM)' },
    useCloseTime: { value: true, label: 'Close open trades at a set time' },
    closeHHMM: { value: 1555, min: 0, max: 2359, label: 'Close open trades at (NY time, HHMM)' },
    maxTrades: { value: 0, min: 0, max: 50, label: 'Max trades per day (0 = no limit)' },
  },

  pine({ p }) {
    return {
      body: `
// --- New York clock (US daylight saving rules), from the candle's open time
utcDays = math.floor(time / 86400000)
utcHour = math.floor(time / 3600000) % 24
z = utcDays + 719468
era = math.floor(z / 146097)
doe = z - era * 146097
yoe = math.floor((doe - math.floor(doe / 1460) + math.floor(doe / 36524) - math.floor(doe / 146096)) / 365)
doy = doe - (365 * yoe + math.floor(yoe / 4) - math.floor(yoe / 100))
mp = math.floor((5 * doy + 2) / 153)
utcDom = doy - math.floor((153 * mp + 2) / 5) + 1
utcMonth = mp < 10 ? mp + 3 : mp - 9
utcDow = (utcDays + 4) % 7
firstDow = (utcDow - (utcDom - 1) % 7 + 7) % 7
secondSunMar = 8 + (7 - firstDow) % 7
firstSunNov = 1 + (7 - firstDow) % 7
isDst = (utcMonth > 3 and utcMonth < 11) or (utcMonth == 3 and (utcDom > secondSunMar or (utcDom == secondSunMar and utcHour >= 7))) or (utcMonth == 11 and (utcDom < firstSunNov or (utcDom == firstSunNov and utcHour < 6)))
nyMs = time - (isDst ? 4 : 5) * 3600000
nyMin = math.floor(nyMs / 60000) % 1440
nyDay = math.floor(nyMs / 86400000)
startMin = math.floor(${p.startHHMM} / 100) * 60 + ${p.startHHMM} % 100
endMin = math.floor(${p.endHHMM} / 100) * 60 + ${p.endHHMM} % 100
closeMin = math.floor(${p.closeHHMM} / 100) * 60 + ${p.closeHHMM} % 100
inWindow = nyMin >= startMin and nyMin < endMin
flatTime = ${p.useCloseTime} and nyMin >= closeMin

// --- daily VWAP, reset at 00:00 UTC
newAnchor = bar_index == 0 or utcDays != utcDays[1]
var float cumPV = 0.0
var float cumV = 0.0
if newAnchor
    cumPV := 0.0
    cumV := 0.0
cumPV := cumPV + hlc3 * volume
cumV := cumV + volume
vwapVal = cumV > 0 ? cumPV / cumV : hlc3

fastMa = ta.ema(close, ${p.fastLen})
slowMa = ta.ema(close, ${p.slowLen})
atrVal = ta.atr(${p.atrLen})
priorVwap = vwapVal[${p.slopeBars}]
buffer = ${p.stopTicks} * ${p.tickSize}

// --- pullback: price touched VWAP within the last touchBars candles
sinceDip = ta.barssince(low <= vwapVal)
sincePop = ta.barssince(high >= vwapVal)
dipped = not na(sinceDip) and sinceDip < ${p.touchBars}
popped = not na(sincePop) and sincePop < ${p.touchBars}
pullLow = ta.lowest(low, ${p.touchBars})
pullHigh = ta.highest(high, ${p.touchBars})

// how far price was from VWAP in the candles just before the touch window
upExt = ta.highest(high - vwapVal, ${p.slopeBars})
dnExt = ta.highest(vwapVal - low, ${p.slopeBars})
wasFarUp = ${p.maxExtAtr} > 0 and upExt[${p.touchBars}] > ${p.maxExtAtr} * atrVal
wasFarDn = ${p.maxExtAtr} > 0 and dnExt[${p.touchBars}] > ${p.maxExtAtr} * atrVal

longStopLvl = pullLow - buffer
shortStopLvl = pullHigh + buffer
longRisk = close - longStopLvl
shortRisk = shortStopLvl - close
longStopOk = longRisk > 0 and (${p.maxStopAtr} == 0 or longRisk <= ${p.maxStopAtr} * atrVal)
shortStopOk = shortRisk > 0 and (${p.maxStopAtr} == 0 or shortRisk <= ${p.maxStopAtr} * atrVal)

// --- trades per New York day
var int tradesToday = 0
if nyDay != nyDay[1]
    tradesToday := 0
canTrade = inWindow and strategy.position_size == 0 and (${p.maxTrades} == 0 or tradesToday < ${p.maxTrades}) and not na(priorVwap) and not na(slowMa) and atrVal > 0

rawLong = ${p.takeLongs} and canTrade and fastMa > slowMa and vwapVal > priorVwap and dipped and close > vwapVal and close > open and not wasFarUp and longStopOk
rawShort = ${p.takeShorts} and canTrade and not rawLong and fastMa < slowMa and vwapVal < priorVwap and popped and close < vwapVal and close < open and not wasFarDn and shortStopOk
if rawLong or rawShort
    tradesToday := tradesToday + 1`,

      longEntry: 'rawLong',
      shortEntry: 'rawShort',
      longExit: 'flatTime',
      shortExit: 'flatTime',
      longStop: 'longStopLvl',
      shortStop: 'shortStopLvl',
      longTarget: `close + ${p.rewardRisk} * longRisk`,
      shortTarget: `close - ${p.rewardRisk} * shortRisk`,

      plots: [
        { title: 'VWAP', expr: 'vwapVal' },
        { title: 'Fast EMA', expr: 'fastMa' },
        { title: 'Slow EMA', expr: 'slowMa' },
      ],
    };
  },
};
