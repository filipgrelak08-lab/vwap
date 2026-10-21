const test = require('node:test');
const assert = require('node:assert');
const { load } = require('./load');

const BT = load();
const DAY = 86400 * 1000;
const utc = (y, m, d) => Date.UTC(y, m - 1, d);

test('monthly returns are measured month end to month end', () => {
  const points = [
    { time: utc(2026, 1, 10), equity: 10500 },
    { time: utc(2026, 1, 31), equity: 11000 }, // January: +10% on 10000
    { time: utc(2026, 2, 15), equity: 11000 },
    { time: utc(2026, 2, 28), equity: 9900 }, // February: -10% on 11000
  ];
  const rows = BT.metrics.monthly(points, 10000);
  assert.strictEqual(rows.length, 1);
  const r = rows[0];
  assert.strictEqual(r.year, 2026);
  assert.ok(Math.abs(r.months[0] - 10) < 1e-9, 'January');
  assert.ok(Math.abs(r.months[1] + 10) < 1e-9, 'February');
  assert.strictEqual(r.months[2], null, 'a month with no bars stays empty');
  assert.ok(Math.abs(r.total + 1) < 1e-9, 'the year is -1% overall');
});

test('a year boundary starts a new row and closes the old one', () => {
  const points = [
    { time: utc(2025, 12, 20), equity: 11000 },
    { time: utc(2025, 12, 31), equity: 12000 },
    { time: utc(2026, 1, 20), equity: 13200 },
  ];
  const rows = BT.metrics.monthly(points, 10000);
  assert.deepStrictEqual(rows.map((r) => r.year), [2025, 2026]);
  assert.ok(Math.abs(rows[0].total - 20) < 1e-9, '2025 ran 10000 to 12000');
  assert.ok(Math.abs(rows[1].months[0] - 10) < 1e-9, 'January 2026 ran 12000 to 13200');
});

test('monthly returns of nothing are nothing', () => {
  assert.deepStrictEqual(BT.metrics.monthly([], 10000), []);
  assert.deepStrictEqual(BT.metrics.monthly(null, 10000), []);
});

test('CAGR annualises the window', () => {
  const from = utc(2025, 1, 1);
  const doubled = BT.metrics.cagr(10000, 20000, from, from + 365.25 * DAY);
  assert.ok(Math.abs(doubled - 100) < 0.5, `a year of doubling is about 100%, got ${doubled}`);
  const half = BT.metrics.cagr(10000, 20000, from, from + (365.25 / 2) * DAY);
  assert.ok(half > 290 && half < 310, `doubling in six months compounds to about 300%, got ${half}`);
  assert.strictEqual(BT.metrics.cagr(10000, 0, from, from + 365.25 * DAY), -100);
});

test('the span of a window is in years', () => {
  const from = utc(2025, 1, 1);
  assert.ok(Math.abs(BT.metrics.years(from, from + 365.25 * DAY) - 1) < 1e-9);
  assert.ok(BT.metrics.years(from, from) > 0, 'never zero, so nothing divides by it');
});
