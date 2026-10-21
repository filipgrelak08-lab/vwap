// Donchian Channel Breakout  (Turtle-style)
//
// Buy a breakout above the highest high of the last N bars, exit on a break
// of the M-bar low, with an initial stop k × ATR from entry. The channels
// are read as of the previous bar, so the current bar can break them.

export default {
  name: 'Donchian Breakout',
  description: 'Turtle-style: enter on an N-bar high/low breakout, exit on the shorter opposite channel, ATR initial stop.',

  params: {
    entryLen: { value: 20, min: 5, max: 120, label: 'Entry channel (bars)' },
    exitLen: { value: 10, min: 2, max: 60, label: 'Exit channel (bars)' },
    atrLen: { value: 20, min: 5, max: 60, label: 'ATR length' },
    stopAtr: { value: 2, min: 0.5, max: 6, step: 0.1, label: 'Initial stop (× ATR)' },
  },

  pine({ p }) {
    return {
      body: `
entryHigh = ta.highest(high, ${p.entryLen})
entryLow = ta.lowest(low, ${p.entryLen})
exitHigh = ta.highest(high, ${p.exitLen})
exitLow = ta.lowest(low, ${p.exitLen})
atrVal = ta.atr(${p.atrLen})`,

      longEntry: 'not na(entryHigh[1]) and close > entryHigh[1]',
      shortEntry: 'not na(entryLow[1]) and close < entryLow[1]',
      longExit: 'not na(exitLow[1]) and close < exitLow[1]',
      shortExit: 'not na(exitHigh[1]) and close > exitHigh[1]',
      longStop: `close - ${p.stopAtr} * atrVal`,
      shortStop: `close + ${p.stopAtr} * atrVal`,

      plots: [
        { title: 'Entry channel high', expr: 'entryHigh' },
        { title: 'Entry channel low', expr: 'entryLow' },
      ],
    };
  },
};
