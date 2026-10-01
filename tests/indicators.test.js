const test = require('node:test');
const assert = require('node:assert/strict');
const { loadBT } = require('./load.js');

const BT = loadBT();
const ta = BT.ta;
const close = (n, ...xs) => assert.ok(Math.abs(n - xs[0]) < (xs[1] || 1e-9), `${n} != ${xs[0]}`);

test('sma averages a rolling window and pads warm-up with NaN', () => {
  const out = ta.sma([1, 2, 3, 4, 5], 3);
  assert.ok(Number.isNaN(out[0]) && Number.isNaN(out[1]));
  assert.deepEqual(out.slice(2), [2, 3, 4]);
});

test('ema is seeded with the SMA and then smooths', () => {
  const out = ta.ema([1, 2, 3, 4, 5], 3);
  close(out[2], 2);
  close(out[3], 0.5 * 4 + 0.5 * 2);
  close(out[4], 0.5 * 5 + 0.5 * 3);
});

test('ema skips leading NaN values (indicator of an indicator)', () => {
  const out = ta.ema([NaN, NaN, 2, 4, 6], 2);
  assert.ok(Number.isNaN(out[2]));
  close(out[3], 3);
});

test('rsi is 100 on a rising series and 0 on a falling one', () => {
  const up = ta.rsi([1, 2, 3, 4, 5, 6, 7], 3);
  const down = ta.rsi([7, 6, 5, 4, 3, 2, 1], 3);
  assert.equal(up[6], 100);
  assert.equal(down[6], 0);
  assert.ok(Number.isNaN(up[2]));
});

test('rsi matches the Wilder reference values', () => {
  // classic 14-period example (StockCharts). Their table rounds the average gain to 0.24 and
  // prints 70.53 / 66.32; computed without rounding the same inputs give 70.46 / 66.25.
  const px = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.00, 46.03, 46.41, 46.22, 45.64];
  const out = ta.rsi(px, 14);
  close(out[14], 70.464, 0.01);
  close(out[15], 66.249, 0.01);
});

test('highest / lowest use a rolling window', () => {
  const src = [3, 1, 4, 1, 5, 9, 2, 6];
  assert.deepEqual(ta.highest(src, 3).slice(2), [4, 4, 5, 9, 9, 9]);
  assert.deepEqual(ta.lowest(src, 3).slice(2), [1, 1, 1, 1, 2, 2]);
});

test('stdev is the population standard deviation', () => {
  const out = ta.stdev([2, 4, 4, 4, 5, 5, 7, 9], 8);
  close(out[7], 2);
});

test('session VWAP resets each day and weights by volume', () => {
  const day = 86400;
  const data = {
    time: [day + 34200, day + 34500, 2 * day + 34200],
    high: [10, 20, 30], low: [10, 20, 30], close: [10, 20, 30], open: [10, 20, 30],
    volume: [1, 3, 5],
  };
  const v = ta.vwap(data, 'session');
  close(v[0], 10);
  close(v[1], (10 * 1 + 20 * 3) / 4);
  close(v[2], 30); // new session
  const all = ta.vwap(data, 'none');
  close(all[2], (10 + 60 + 150) / 9);
});

test('vwap falls back to equal weights when a dataset has no volume', () => {
  const data = { time: [0, 60], high: [10, 20], low: [10, 20], close: [10, 20], open: [10, 20], volume: [0, 0] };
  close(ta.vwap(data, 'none')[1], 15);
});

test('crossover and crossunder detect the bar of the cross', () => {
  const a = [1, 2, 3, 2, 1];
  assert.equal(ta.crossover(a, 2, 2), true);
  assert.equal(ta.crossover(a, 2, 1), false);
  assert.equal(ta.crossunder(a, 2, 4), true);
  assert.equal(ta.crossunder(a, 2, 3), false);
});

test('atr of constant-range bars equals the range', () => {
  const n = 30;
  const data = { high: new Array(n).fill(11), low: new Array(n).fill(9), close: new Array(n).fill(10) };
  close(ta.atr(data, 14)[n - 1], 2);
});

test('session helpers mark first and last bars of each day', () => {
  const d = 86400;
  const data = { time: [d + 1, d + 2, d + 3, 2 * d + 1, 2 * d + 2] };
  assert.deepEqual(Array.from(ta.sessionStart(data)), [true, false, false, true, false]);
  assert.deepEqual(Array.from(ta.sessionEnd(data)), [false, false, true, false, true]);
  assert.deepEqual(Array.from(ta.sessionBar(data)), [0, 1, 2, 0, 1]);
});
