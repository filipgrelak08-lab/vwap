const test = require('node:test');
const assert = require('node:assert/strict');
const { loadBT } = require('./load.js');

const BT = loadBT();
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

// bars: [open, high, low, close]; one bar per day unless times are given
function daily(bars) {
  return BT.data.fromBars(bars.map((b, i) => [86400 * (i + 1), b[0], b[1], b[2], b[3], 1000]), { symbol: 'T', interval: '1d' });
}
// intraday: bars = [[ 'YYYY-MM-DD HH:MM', o, h, l, c ], ...]
function intraday(bars) {
  return BT.data.fromBars(bars.map((b) => [BT.data.parseTime(b[0]), b[1], b[2], b[3], b[4], 1000]), { symbol: 'T', interval: '5m' });
}
const strat = (onBar) => BT.engine.compile(`export default { name: 't', onBar: ${onBar} };`);
const base = { capital: 1000, commissionPct: 0, slippagePct: 0 };
const flat = (n, px = 100) => Array.from({ length: n }, () => [px, px, px, px]);

test('reward:risk target is a multiple of the stop distance', () => {
  const bars = [[100, 100, 100, 100], [100, 100, 100, 100], [100, 111, 99, 110], [110, 110, 110, 110]];
  const s = strat('(ctx) => { if (ctx.i === 0) ctx.long(); }');
  const r = BT.engine.run(daily(bars), s, {}, Object.assign({ stopLossPct: 5, rrTarget: 2 }, base));
  const t = r.trades[0];
  assert.equal(t.exitReason, 'Take profit');
  near(t.exitPrice, 110); // 100 + 2 * 5
  near(t.rMultiple, 2);
  near(t.risk, 50); // 10 shares * $5
});

test('a strategy target wins over the reward:risk target', () => {
  const bars = [[100, 100, 100, 100], [100, 100, 100, 100], [100, 104, 99, 103], [103, 103, 103, 103]];
  const s = strat('(ctx) => { if (ctx.i === 0) ctx.long({ target: 103 }); }');
  const r = BT.engine.run(daily(bars), s, {}, Object.assign({ stopLossPct: 5, rrTarget: 2 }, base));
  near(r.trades[0].exitPrice, 103);
});

test('risk sizing loses riskPct of equity when the stop is hit', () => {
  const bars = [[100, 100, 100, 100], [100, 100, 100, 100], [100, 100, 90, 92], [92, 92, 92, 92]];
  const s = strat('(ctx) => { if (ctx.i === 0) ctx.long(); }');
  const r = BT.engine.run(daily(bars), s, {}, Object.assign({ stopLossPct: 4, sizing: 'risk', riskPct: 1 }, base));
  const t = r.trades[0];
  near(t.qty, 2.5); // $10 risk / $4 per share
  near(t.pnl, -10);
  near(t.rMultiple, -1);
});

test('risk sizing is capped by the position size setting', () => {
  const bars = [[100, 100, 100, 100], [100, 100, 100, 100], [100, 100, 100, 100]];
  const s = strat('(ctx) => { if (ctx.i === 0) ctx.long(); }');
  const r = BT.engine.run(daily(bars), s, {}, Object.assign({ stopLossPct: 0.1, sizing: 'risk', riskPct: 5, sizePct: 100 }, base));
  near(r.trades[0].qty, 10); // risk sizing wants 500 shares; 100% of equity buys 10
});

test('ATR stop uses the ATR known at the signal bar', () => {
  // constant 2-point range -> ATR(3) = 2 -> stop = 100 - 1.5 * 2 = 97
  const bars = [[100, 101, 99, 100], [100, 101, 99, 100], [100, 101, 99, 100], [100, 101, 99, 100], [100, 100, 96, 96.5], [96, 96, 96, 96]];
  const s = strat('(ctx) => { if (ctx.i === 3) ctx.long(); }');
  const r = BT.engine.run(daily(bars), s, {}, Object.assign({ atrStopMult: 1.5, atrLength: 3, stopLossPct: 10 }, base));
  const t = r.trades[0];
  assert.equal(t.exitReason, 'Stop loss');
  near(t.exitPrice, 97); // ATR stop wins over the 10% stop
});

test('break-even moves the stop to entry after +1R', () => {
  // entry 100, stop 95 (R=5). Bar 2 reaches 105 (+1R), bar 3 falls back through 100.
  const bars = [[100, 100, 100, 100], [100, 100, 100, 100], [100, 105, 99, 104], [103, 103, 98, 99], [99, 99, 99, 99]];
  const s = strat('(ctx) => { if (ctx.i === 0) ctx.long(); }');
  const r = BT.engine.run(daily(bars), s, {}, Object.assign({ stopLossPct: 5, breakEvenR: 1 }, base));
  const t = r.trades[0];
  assert.equal(t.exitReason, 'Break-even stop');
  near(t.exitPrice, 100);
  near(t.mfeR, 1);
});

test('time stop exits after N bars at the close', () => {
  const s = strat('(ctx) => { if (ctx.i === 0) ctx.long(); }');
  const r = BT.engine.run(daily(flat(10)), s, {}, Object.assign({ maxBarsInTrade: 3 }, base));
  assert.equal(r.trades[0].exitReason, 'Time stop');
  assert.equal(r.trades[0].bars, 3);
});

test('MAE and MFE measure the worst and best price during the trade', () => {
  const bars = [[100, 100, 100, 100], [100, 103, 98, 101], [101, 108, 97, 105], [105, 106, 104, 105], [105, 105, 105, 105]];
  const s = strat('(ctx) => { if (ctx.i === 0) ctx.long(); if (ctx.i === 2) ctx.exit(); }');
  const t = BT.engine.run(daily(bars), s, {}, base).trades[0];
  near(t.mfePct, 8); // high of 108 while held
  near(t.maePct, -3); // low of 97 while held
  assert.equal(t.rMultiple, null); // no stop, no R
});

test('trading hours block entries outside the window but not exits', () => {
  const day = (hm, px) => [`2026-03-02 ${hm}`, px, px, px, px];
  const bars = [day('09:30', 10), day('09:35', 10), day('09:40', 11), day('09:45', 12), day('09:50', 12), day('09:55', 12)];
  const s = strat('(ctx) => { if (ctx.i === 0 || ctx.i === 2) ctx.long(); if (ctx.i === 4) ctx.exit(); }');
  const r = BT.engine.run(intraday(bars), s, {}, Object.assign({ entryStart: '09:45', entryEnd: '15:00' }, base));
  assert.equal(r.trades.length, 1);
  assert.equal(BT.fmt.time(r.trades[0].entryTime, r.data), '2026-03-02 09:45');
  assert.equal(r.metrics.skipped.hours, 1);
});

test('trend filter only allows longs above the SMA', () => {
  const bars = [[10, 10, 10, 10], [9, 9, 9, 9], [8, 8, 8, 8], [8, 8, 8, 8], [12, 12, 12, 12], [12, 12, 12, 12], [12, 12, 12, 12]];
  const s = strat('(ctx) => { if (ctx.i === 2 || ctx.i === 4) ctx.long(); }');
  const r = BT.engine.run(daily(bars), s, {}, Object.assign({ trendFilterLength: 2 }, base));
  assert.equal(r.trades.length, 1);
  assert.equal(r.trades[0].entryIndex, 5);
  assert.equal(r.metrics.skipped.trend, 1);
});

test('max trades per day and daily loss limit', () => {
  const t = (hm, o, h, l, c) => [`2026-03-02 ${hm}`, o, h, l, c];
  const bars = [
    t('09:30', 100, 100, 100, 100), t('09:35', 100, 100, 100, 100), t('09:40', 100, 100, 100, 100),
    t('09:45', 100, 100, 100, 100), t('09:50', 100, 100, 100, 100), t('09:55', 100, 100, 100, 100),
  ];
  // enter/exit every other bar: would make 3 trades
  const s = strat('(ctx) => { if (ctx.i % 2 === 0) ctx.long(); else ctx.exit(); }');
  const capped = BT.engine.run(intraday(bars), s, {}, Object.assign({ maxTradesPerDay: 1 }, base));
  assert.equal(capped.trades.length, 1);
  assert.ok(capped.metrics.skipped.maxTrades >= 1);

  const drop = [
    t('09:30', 100, 100, 100, 100), t('09:35', 100, 100, 100, 100), t('09:40', 100, 100, 96, 96),
    t('09:45', 96, 96, 96, 96), t('09:50', 96, 96, 96, 96), t('09:55', 96, 96, 96, 96),
  ];
  const holder = strat('(ctx) => { if (ctx.isFlat) ctx.long(); }');
  const r = BT.engine.run(intraday(drop), holder, {}, Object.assign({ dailyLossPct: 3 }, base));
  assert.equal(r.trades[0].exitReason, 'Daily loss limit');
  assert.equal(r.trades.length, 1); // no re-entry for the rest of the day
  assert.ok(r.metrics.skipped.dailyLoss >= 1);
});

test('R statistics in the metrics', () => {
  const bars = [[100, 100, 100, 100], [100, 100, 100, 100], [100, 111, 99, 110], [110, 110, 110, 110], [110, 110, 110, 110], [110, 110, 104, 104], [104, 104, 104, 104]];
  const s = strat('(ctx) => { if (ctx.i === 0 || ctx.i === 3) ctx.long(); }');
  const m = BT.engine.run(daily(bars), s, {}, Object.assign({ stopLossPct: 5, rrTarget: 2 }, base)).metrics;
  assert.equal(m.rTrades, 2);
  near(m.avgR, (2 + -1) / 2, 0.02);
});
