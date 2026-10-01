const test = require('node:test');
const assert = require('node:assert/strict');
const { loadBT } = require('./load.js');

const BT = loadBT();
const iso = (t) => new Date(t * 1000).toISOString().slice(0, 16);

test('parses a Yahoo-style CSV with Adj Close', () => {
  const csv = 'Date,Open,High,Low,Close,Adj Close,Volume\n2024-01-03,10,11,9,10,5,100\n2024-01-02,20,22,18,20,10,200\n';
  const d = BT.data.parseCSV(csv, 'spy.csv');
  assert.equal(d.length, 2);
  assert.equal(iso(d.time[0]), '2024-01-02T00:00'); // sorted ascending
  assert.equal(d.close[0], 10); // adjusted
  assert.equal(d.high[0], 11);
  assert.equal(d.symbol, 'SPY');
  assert.equal(d.interval, '1d');
});

test('parses intraday timestamps, separate date/time columns and unix times', () => {
  const a = BT.data.parseCSV('datetime,open,high,low,close,volume\n2024-03-01 09:30:00,1,2,0.5,1.5,10\n2024-03-01 09:35:00,1.5,2,1,1.8,12\n');
  assert.equal(iso(a.time[1]), '2024-03-01T09:35');
  assert.equal(a.interval, '5m');
  const b = BT.data.parseCSV('Date;Time;Open;High;Low;Close;Volume\n01.03.2024;09:30;1,5;2;1;1,8;10\n01.03.2024;09:31;1,8;2;1;1,9;10\n');
  assert.equal(iso(b.time[0]), '2024-03-01T09:30');
  assert.equal(b.open[0], 1.5); // decimal comma
  const c = BT.data.parseCSV('open_time,open,high,low,close,volume\n1709285400000,1,2,0.5,1.5,10\n1709285460000,1.5,2,1,1.8,12\n');
  assert.equal(c.interval, '1m');
});

test('US dates, AM/PM and dollar signs (Nasdaq export)', () => {
  const d = BT.data.parseCSV('Date,Close/Last,Volume,Open,High,Low\n03/01/2024,$180.75,100,$179.55,$180.53,$177.38\n02/29/2024,$180.00,90,$181.27,$182.57,$179.53\n');
  assert.equal(iso(d.time[1]), '2024-03-01T00:00');
  assert.equal(d.close[1], 180.75);
  assert.equal(BT.data.parseTime('3/1/2024 1:05 PM'), Date.UTC(2024, 2, 1, 13, 5) / 1000);
});

test('rejects files without a date column', () => {
  assert.throws(() => BT.data.parseCSV('foo,bar\n1,2\n3,4\n'), /date column/i);
});

test('date range filter keeps whole days', () => {
  const d = BT.data.sample('intraday');
  const f = BT.data.filterRange(d, '2026-05-05', '2026-05-05');
  assert.equal(f.length, 78);
  assert.equal(iso(f.time[0]), '2026-05-05T09:30');
});

test('samples are deterministic', () => {
  const a = BT.data.sample('daily');
  assert.equal(a.length, 2282);
  assert.ok(a.close.every((x) => x > 0));
});
