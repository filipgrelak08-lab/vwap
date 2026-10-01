const test = require('node:test');
const assert = require('node:assert/strict');
const { loadBT, readStrategy } = require('./load.js');

const BT = loadBT();

test('range builds inclusive numeric steps without float drift', () => {
  // spread copies the sandbox array into this realm so deepEqual compares values only
  assert.deepEqual([...BT.optimizer.range(0.1, 0.5, 0.1)], [0.1, 0.2, 0.3, 0.4, 0.5]);
  assert.deepEqual([...BT.optimizer.range(10, 2, 4)], [2, 6, 10]);
});

test('grid search ranks results and tests the best on held-out data', async () => {
  const compiled = BT.engine.compile(readStrategy('ma_crossover.js'));
  const byKey = Object.fromEntries(compiled.params.map((p) => [p.key, p]));
  const handle = BT.optimizer.run({
    data: BT.data.sample('daily'), compiled, baseParams: {}, settings: {},
    x: byKey.fast, xSpec: { from: 5, to: 25, step: 10 },
    y: byKey.slow, ySpec: { from: 40, to: 100, step: 30 },
    objective: 'sharpe', split: 70, minTrades: 1,
  });
  const out = await handle.promise;
  assert.equal(out.cells.length, 9);
  assert.ok(out.top.length > 0);
  for (let i = 1; i < out.top.length; i++) assert.ok(out.top[i - 1].score >= out.top[i].score);
  assert.ok(out.top[0].oos, 'top result has an out-of-sample run');
});
