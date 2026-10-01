const test = require('node:test');
const assert = require('node:assert/strict');
const { loadBT, readStrategy, listStrategies } = require('./load.js');

const BT = loadBT();

// bars: [open, high, low, close], one per day
function dataset(bars) {
  return BT.data.fromBars(bars.map((b, i) => [86400 * (i + 1), b[0], b[1], b[2], b[3], 1000]), { symbol: 'T', interval: '1d' });
}

const NO_COSTS = { commissionPct: 0, slippagePct: 0, capital: 1000 };

function strat(onBar, extra = '') {
  return BT.engine.compile(`export default { name: 'test', ${extra} onBar: ${onBar} };`);
}

test('orders fill at the next bar open by default', () => {
  const data = dataset([[10, 10, 10, 10], [11, 12, 10, 11], [12, 13, 11, 12], [13, 14, 12, 13]]);
  const s = strat('(ctx) => { if (ctx.i === 0) ctx.long(); if (ctx.i === 1) ctx.exit("done"); }');
  const r = BT.engine.run(data, s, {}, NO_COSTS);
  assert.equal(r.trades.length, 1);
  const t = r.trades[0];
  assert.equal(t.entryIndex, 1);
  assert.equal(t.entryPrice, 11);
  assert.equal(t.exitIndex, 2);
  assert.equal(t.exitPrice, 12);
  assert.ok(Math.abs(r.equity[3] - 1000 * (12 / 11)) < 1e-9);
});

test('fillOn close executes on the signal bar', () => {
  const data = dataset([[10, 10, 10, 10], [11, 12, 10, 11], [12, 13, 11, 12]]);
  const s = strat('(ctx) => { if (ctx.i === 0) ctx.long(); if (ctx.i === 1) ctx.exit(); }');
  const r = BT.engine.run(data, s, {}, Object.assign({ fillOn: 'close' }, NO_COSTS));
  assert.equal(r.trades[0].entryPrice, 10);
  assert.equal(r.trades[0].exitPrice, 11);
});

test('commission and slippage are charged on both sides', () => {
  const data = dataset([[100, 100, 100, 100], [100, 100, 100, 100], [100, 100, 100, 100], [100, 100, 100, 100]]);
  const s = strat('(ctx) => { if (ctx.i === 0) ctx.long(); if (ctx.i === 1) ctx.exit(); }');
  const r = BT.engine.run(data, s, {}, { capital: 1000, commissionPct: 0.1, slippagePct: 0 });
  // 10 shares at $100: $1 commission in, $1 out
  assert.ok(Math.abs(r.metrics.endEquity - 998) < 1e-9, String(r.metrics.endEquity));
  assert.ok(Math.abs(r.trades[0].pnl - -2) < 1e-9);
  const r2 = BT.engine.run(data, s, {}, { capital: 1000, commissionPct: 0, slippagePct: 1 });
  assert.equal(r2.trades[0].entryPrice, 101);
  assert.equal(r2.trades[0].exitPrice, 99);
});

test('a stop inside the bar exits at the stop; a gap through it exits at the open', () => {
  const s = strat('(ctx) => { if (ctx.i === 0) ctx.long({ stop: 95 }); }');
  const inside = BT.engine.run(dataset([[100, 100, 100, 100], [100, 101, 94, 96], [96, 97, 95, 96]]), s, {}, NO_COSTS);
  assert.equal(inside.trades[0].exitPrice, 95);
  assert.equal(inside.trades[0].exitReason, 'Stop loss');
  const gap = BT.engine.run(dataset([[100, 100, 100, 100], [90, 92, 89, 91], [91, 92, 90, 91]]), s, {}, NO_COSTS);
  assert.equal(gap.trades[0].exitPrice, 90);
});

test('stop is assumed to hit before target when both are inside one bar', () => {
  const s = strat('(ctx) => { if (ctx.i === 0) ctx.long({ stop: 95, target: 105 }); }');
  const r = BT.engine.run(dataset([[100, 100, 100, 100], [100, 106, 94, 100], [100, 100, 100, 100]]), s, {}, NO_COSTS);
  assert.equal(r.trades[0].exitReason, 'Stop loss');
});

test('take-profit and trailing-stop settings apply to every entry', () => {
  const s = strat('(ctx) => { if (ctx.i === 0) ctx.long(); }');
  const tp = BT.engine.run(dataset([[100, 100, 100, 100], [100, 111, 99, 110], [110, 110, 110, 110]]), s, {}, Object.assign({ takeProfitPct: 10 }, NO_COSTS));
  assert.equal(tp.trades[0].exitReason, 'Take profit');
  assert.ok(Math.abs(tp.trades[0].exitPrice - 110) < 1e-9);
  const trail = BT.engine.run(
    dataset([[100, 100, 100, 100], [100, 120, 100, 119], [119, 119, 105, 106], [106, 106, 106, 106]]),
    s, {}, Object.assign({ trailingStopPct: 10 }, NO_COSTS)
  );
  assert.equal(trail.trades[0].exitReason, 'Trailing stop');
  assert.ok(Math.abs(trail.trades[0].exitPrice - 108) < 1e-9); // 120 * 0.9
});

test('long-only mode turns a short signal into an exit', () => {
  const data = dataset([[10, 10, 10, 10], [10, 10, 10, 10], [12, 12, 12, 12], [12, 12, 12, 12]]);
  const s = strat('(ctx) => { if (ctx.i === 0) ctx.long(); if (ctx.i === 1) ctx.short(); }');
  const longOnly = BT.engine.run(data, s, {}, Object.assign({ allowShorts: false }, NO_COSTS));
  assert.equal(longOnly.trades.length, 1);
  assert.equal(longOnly.trades[0].side, 'long');
  const both = BT.engine.run(data, s, {}, NO_COSTS);
  assert.equal(both.trades.length, 2);
  assert.equal(both.trades[1].side, 'short');
  assert.equal(both.trades[1].exitReason, 'End of data');
});

test('short positions profit when price falls', () => {
  const data = dataset([[10, 10, 10, 10], [10, 10, 10, 10], [8, 8, 8, 8], [8, 8, 8, 8]]);
  const s = strat('(ctx) => { if (ctx.i === 0) ctx.short(); if (ctx.i === 2) ctx.exit(); }');
  const r = BT.engine.run(data, s, {}, NO_COSTS);
  assert.ok(Math.abs(r.metrics.endEquity - 1200) < 1e-9);
});

test('params are normalised from shorthand and merged with overrides', () => {
  const s = BT.engine.compile(`export default {
    params: { len: 20, fast: { value: 5, min: 2, max: 9 }, on: true, kind: { value: 'EMA', options: ['SMA', 'EMA'] } },
    onBar() {},
  };`);
  const byKey = Object.fromEntries(s.params.map((p) => [p.key, p]));
  assert.equal(byKey.len.type, 'number');
  assert.equal(byKey.len.step, 1);
  assert.equal(byKey.fast.max, 9);
  assert.equal(byKey.on.type, 'bool');
  assert.equal(byKey.kind.type, 'select');
  const r = BT.engine.run(dataset([[1, 1, 1, 1], [1, 1, 1, 1]]), s, { len: 7 }, NO_COSTS);
  assert.equal(r.params.len, 7);
  assert.equal(r.params.fast, 5);
});

test('runtime errors report the editor line number', () => {
  const code = ['export default {', '  name: "x",', '', '  onBar(ctx) {', '    ctx.nope.boom;', '  },', '};'].join('\n');
  const s = BT.engine.compile(code);
  assert.throws(() => BT.engine.run(dataset([[1, 1, 1, 1], [1, 1, 1, 1]]), s, {}, NO_COSTS), (e) => e.line === 5);
});

test('compile rejects strategies without onBar', () => {
  assert.throws(() => BT.engine.compile('export default { name: "x" };'), /onBar/);
  assert.throws(() => BT.engine.compile('export default {'), /Syntax error/);
});

test('every bundled strategy runs on every sample dataset', () => {
  for (const key of Object.keys(BT.data.SAMPLES)) {
    const data = BT.data.sample(key);
    for (const file of listStrategies()) {
      const s = BT.engine.compile(readStrategy(file));
      const r = BT.engine.run(data, s, {}, {});
      assert.equal(r.equity.length, data.length, `${file} on ${key}`);
      assert.ok(r.equity.every(Number.isFinite), `${file} on ${key} produced a non-finite equity value`);
      for (const t of r.trades) assert.ok(t.exitIndex >= t.entryIndex, `${file}: exit before entry`);
    }
  }
});

test('the new-strategy template compiles and runs', () => {
  const s = BT.engine.compile(BT.engine.TEMPLATE);
  const r = BT.engine.run(BT.data.sample('daily'), s, {}, {});
  assert.ok(r.trades.length > 0);
});
