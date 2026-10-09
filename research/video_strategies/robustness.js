// Stress tests for the versions that held up out of sample.
//
//   node research/video_strategies/robustness.js <nq.json> [outDir]
//
// For each candidate: neighbouring settings (is it a plateau or a lucky spike?),
// three times the trading costs, and a "just be long" control that enters at the
// same time of day with the same stop, to separate a real edge from market drift.
const fs = require('fs');
const path = require('path');
const { loadBT, readStrategy } = require('../../tests/load.js');

const BT = loadBT();
const [dataFile, outDir = __dirname] = process.argv.slice(2);
const TEST_FROM = Date.UTC(2025, 0, 1) / 1000;
const BASE = {
  capital: 100000, sizing: 'risk', riskPct: 1, sizePct: 1000,
  commissionPct: 0.0005, slippagePct: 0.0015, fillOn: 'open', allowShorts: true, flatAtSessionEnd: true, atrLength: 14,
};

const raw = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
const symbol = Object.keys(raw)[0].split('|')[0];
const data = BT.data.fromBars(raw[`${symbol}|5m`], { symbol, interval: '5m' });
let cut = 0;
while (data.time[cut] < TEST_FROM) cut++;
const parts = { learn: BT.engine.sliceData(data, 0, cut), test: BT.engine.sliceData(data, cut, data.length) };

function stats(trades) {
  const R = trades.map((t) => t.rMultiple).filter(Number.isFinite);
  const n = R.length;
  const avg = n ? R.reduce((a, b) => a + b, 0) / n : 0;
  const sd = n > 1 ? Math.sqrt(R.reduce((a, b) => a + (b - avg) ** 2, 0) / (n - 1)) : 0;
  return { n, avgR: +avg.toFixed(3), t: +(sd ? (avg / sd) * Math.sqrt(n) : 0).toFixed(2), win: +((R.filter((r) => r > 0).length / (n || 1)) * 100).toFixed(1) };
}

// "Long every day" control: buy at a fixed time with an ATR stop, flat at the close.
const control = BT.engine.compile(`export default {
  params: { at: '10:00' },
  setup({ data, ta }) { return { atr: ta.atr(data, 14) }; },
  onBar(ctx) {
    const [h, m] = ctx.params.at.split(':').map(Number);
    if (ctx.isFlat && ctx.data.time[ctx.i + 1] % 86400 === h * 3600 + m * 60 && ctx.ind.atr[ctx.i] > 0) ctx.long();
  },
};`);

const CASES = [
  {
    name: 'noise_area', file: 'nq_noise_area_momentum.js',
    final: { params: { nativeStop: false, direction: 'long', roomAtr: 2 }, settings: { atrStopMult: 1.5 } },
    variants: [
      ['stop 1×ATR', { settings: { atrStopMult: 1 } }],
      ['stop 2×ATR', { settings: { atrStopMult: 2 } }],
      ['room 1 ATR', { params: { roomAtr: 1 } }],
      ['room 3 ATR', { params: { roomAtr: 3 } }],
      ['no room filter', { params: { roomAtr: 0 } }],
      ['check every 15 min', { params: { checkMinutes: 15 } }],
      ['10-day noise average', { params: { lookbackDays: 10 } }],
      ['20-day noise average', { params: { lookbackDays: 20 } }],
      ['shorts too', { params: { direction: 'both' } }],
    ],
    control: [['long at 10:00, 1.5×ATR stop', { at: '10:00' }, { atrStopMult: 1.5 }]],
  },
  {
    name: 'orb', file: 'nq_opening_range_breakout.js',
    final: { params: { dailyTrend: true, nativeStop: false, nativeTarget: false }, settings: { atrStopMult: 2, rrTarget: 3 } },
    variants: [
      ['stop 1.5×ATR', { settings: { atrStopMult: 1.5 } }],
      ['stop 3×ATR', { settings: { atrStopMult: 3 } }],
      ['target 2R', { settings: { rrTarget: 2 } }],
      ['target 4R', { settings: { rrTarget: 4 } }],
      ['10-minute range', { params: { orMinutes: 10 } }],
      ['30-minute range', { params: { orMinutes: 30 } }],
      ['longs only', { params: { direction: 'long' } }],
      ['without daily trend', { params: { dailyTrend: false } }],
    ],
    control: [['long at 09:45, 2×ATR stop, 3R target', { at: '09:45' }, { atrStopMult: 2, rrTarget: 3 }]],
  },
  {
    name: 'orb5_zarattini (published rules)', file: 'nq_orb5_zarattini.js',
    final: { params: {}, settings: {} },
    variants: [
      ['target 5R', { params: { targetR: 5 } }],
      ['hold to close (no target)', { params: { targetR: 0 } }],
      ['longs only', { params: { direction: 'long' } }],
    ],
    control: [['long at 09:35, 1×ATR stop, 10R target', { at: '09:35' }, { atrStopMult: 1, rrTarget: 10 }]],
  },
];

const rows = [];
function record(caseName, label, compiled, params, settings) {
  const row = { strategy: caseName, version: label };
  for (const [p, d] of Object.entries(parts)) {
    const s = stats(BT.engine.run(d, compiled, params, Object.assign({}, BASE, settings)).trades);
    for (const [k, v] of Object.entries(s)) row[`${p}_${k}`] = v;
  }
  rows.push(row);
  console.log(`${caseName.padEnd(32)} ${label.padEnd(40)} learn n=${row.learn_n} avgR=${row.learn_avgR} t=${row.learn_t} | test n=${row.test_n} avgR=${row.test_avgR} t=${row.test_t}`);
}

for (const c of CASES) {
  const compiled = BT.engine.compile(readStrategy(c.file));
  record(c.name, 'final', compiled, c.final.params, c.final.settings);
  for (const [label, v] of c.variants) {
    record(c.name, label, compiled, { ...c.final.params, ...(v.params || {}) }, { ...c.final.settings, ...(v.settings || {}) });
  }
  record(c.name, '3× costs', compiled, c.final.params, { ...c.final.settings, commissionPct: 0.0015, slippagePct: 0.0045 });
  for (const [label, params, settings] of c.control) record(c.name, `control: ${label}`, control, params, settings);
}

const head = Object.keys(rows[0]);
fs.writeFileSync(path.join(outDir, `robustness_${symbol}.csv`), [head.join(','), ...rows.map((r) => head.map((h) => r[h]).join(','))].join('\n') + '\n');
