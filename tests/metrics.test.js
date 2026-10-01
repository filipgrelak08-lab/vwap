const test = require('node:test');
const assert = require('node:assert/strict');
const { loadBT } = require('./load.js');

const BT = loadBT();

test('max drawdown and drawdown series', () => {
  const eq = [100, 120, 90, 130, 117];
  const dd = BT.metrics.maxDrawdown(eq);
  assert.ok(Math.abs(dd.maxDD - -25) < 1e-9);
  const series = BT.metrics.drawdownSeries(eq);
  assert.ok(Math.abs(series[4] - -10) < 1e-9);
});

test('monthly returns chain month-end equity', () => {
  const t = (y, m, d) => Date.UTC(y, m, d) / 1000;
  const result = {
    settings: { capital: 100 },
    data: { time: [t(2024, 0, 2), t(2024, 0, 31), t(2024, 1, 15), t(2024, 1, 28), t(2025, 0, 2)] },
    equity: [100, 110, 105, 121, 133.1],
  };
  const rows = BT.metrics.monthly(result);
  assert.equal(rows.length, 2);
  assert.ok(Math.abs(rows[0].months[0] - 10) < 1e-9);
  assert.ok(Math.abs(rows[0].months[1] - 10) < 1e-9);
  assert.ok(Math.abs(rows[0].total - 21) < 1e-9);
  assert.ok(Math.abs(rows[1].months[0] - 10) < 1e-9);
  assert.equal(rows[1].months[1], null);
});

test('win rate, profit factor and exposure', () => {
  const day = 86400;
  const n = 5;
  const result = {
    settings: { capital: 1000 },
    data: { time: Array.from({ length: n }, (_, i) => i * day) },
    equity: [1000, 1010, 1010, 1005, 1005],
    buyHold: [1000, 1000, 1000, 1000, 1000],
    exposure: [0, 1, 0, -1, 0],
    trades: [{ pnl: 10, returnPct: 1, bars: 1, side: 'long' }, { pnl: -5, returnPct: -0.5, bars: 1, side: 'short' }],
    commissionPaid: 0,
  };
  const m = BT.metrics.compute(result);
  assert.equal(m.trades, 2);
  assert.equal(m.winRate, 50);
  assert.equal(m.profitFactor, 2);
  assert.equal(m.exposurePct, 40);
  assert.ok(Math.abs(m.totalReturn - 0.5) < 1e-9);
});
