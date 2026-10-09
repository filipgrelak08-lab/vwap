// Levers shared by run.js and recent_study.js: each changes one thing about a strategy run.
// `group` makes them exclusive: one entry window, one stop, one target, and so on.
const LEVERS = [
  { id: '15m bars', group: 'tf', apply: (c) => { c.tf = '15m'; } },
  { id: 'longs only', group: 'dir', apply: (c) => { c.params.direction = 'long'; } },
  { id: 'shorts only', group: 'dir', apply: (c) => { c.params.direction = 'short'; } },
  { id: 'entries until 10:30', group: 'end', apply: (c) => { c.settings.entryEnd = '10:30'; } },
  { id: 'entries until 11:00', group: 'end', apply: (c) => { c.settings.entryEnd = '11:00'; } },
  { id: 'entries until 12:00', group: 'end', apply: (c) => { c.settings.entryEnd = '12:00'; } },
  { id: 'entries until 14:00', group: 'end', apply: (c) => { c.settings.entryEnd = '14:00'; } },
  { id: 'entries from 10:00', group: 'start', apply: (c) => { c.settings.entryStart = '10:00'; } },
  { id: 'with daily trend', group: 'trend', apply: (c) => { c.params.dailyTrend = true; } },
  { id: 'VWAP side', group: 'vwap', apply: (c) => { c.params.vwapSide = true; } },
  { id: 'with opening gap', group: 'gap', apply: (c) => { c.params.gapAlign = true; } },
  { id: 'room ≥ 2 ATR to prior-day level', group: 'room', apply: (c) => { c.params.roomAtr = 2; } },
  { id: 'room ≥ 5 ATR to prior-day level', group: 'room', apply: (c) => { c.params.roomAtr = 5; } },
  ...[1, 1.5, 2, 3].map((k) => ({
    id: `stop ${k}×ATR`, group: 'stop',
    apply: (c) => { c.params.nativeStop = false; c.settings.atrStopMult = k; },
  })),
  ...[1, 1.5, 2, 3].map((r) => ({
    id: `target ${r}R`, group: 'target',
    apply: (c) => { c.params.nativeTarget = false; c.settings.rrTarget = r; },
  })),
  { id: 'break-even at 1R', group: 'be', apply: (c) => { c.settings.breakEvenR = 1; } },
  { id: 'max 1 trade a day', group: 'maxday', apply: (c) => { c.settings.maxTradesPerDay = 1; } },
];

module.exports = { LEVERS };
