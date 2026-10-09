// "One lever at a time" study on Nasdaq-100 intraday data.
//
//   node research/video_strategies/run.js <nq.json> [outDir]
//
// nq.json comes from build_data.py: { "NQ|5m": bars, "NQ|15m": bars }.
//
// For each strategy: run the plain version, then add one lever (filter, stop, target,
// timeframe...) at a time, always picking the lever that most improves the result on the
// LEARN period (2019-2024). The TEST period (2025 onwards) is never used to choose
// anything; it only shows how each step held up on data it did not see.
const fs = require('fs');
const path = require('path');
const { loadBT, readStrategy } = require('../../tests/load.js');

const BT = loadBT();
const [dataFile, outDir = __dirname] = process.argv.slice(2);
if (!dataFile) {
  console.error('usage: node research/video_strategies/run.js <nq.json> [outDir]');
  process.exit(1);
}

const TEST_FROM = Date.UTC(2025, 0, 1) / 1000;
const MAX_STEPS = 5;
const MIN_LEARN_TRADES = 150; // about one trade every two weeks over six years
const MIN_IMPROVEMENT = 0.1; // a lever must add at least this much to the score

// Nasdaq futures-like costs: ~0.3 index points of slippage and $2 commission per side on ~$400k notional.
const BASE_SETTINGS = {
  capital: 100000, sizing: 'risk', riskPct: 1, sizePct: 5000,
  commissionPct: 0.0005, slippagePct: 0.0015, fillOn: 'open', allowShorts: true,
  flatAtSessionEnd: true, atrLength: 14,
};

const STRATEGIES = [
  ['orb', 'nq_opening_range_breakout.js'],
  ['vwap_sigma', 'nq_vwap_sigma_reversion.js'],
  ['supertrend', 'nq_supertrend_flip.js'],
  ['volume_spike', 'nq_volume_spike_breakout.js'],
  ['sweep_reclaim', 'nq_liquidity_sweep_reclaim.js'],
  ['candle2', 'nq_candle2_reversal.js'],
];

// Levers. `group` makes them exclusive: one entry window, one stop, one target, and so on.
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

const raw = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
const sets = {};
for (const tf of ['5m', '15m']) {
  const data = BT.data.fromBars(raw[`NQ|${tf}`], { symbol: 'NQ', interval: tf });
  let cut = 0;
  while (cut < data.length && data.time[cut] < TEST_FROM) cut++;
  sets[tf] = { learn: BT.engine.sliceData(data, 0, cut), test: BT.engine.sliceData(data, cut, data.length) };
}
const years = (d) => (d.time[d.length - 1] - d.time[0]) / (365.25 * 86400);

function stats(trades, d) {
  const R = trades.map((t) => t.rMultiple).filter(Number.isFinite);
  const n = R.length;
  const sum = R.reduce((a, b) => a + b, 0);
  const avg = n ? sum / n : 0;
  const sd = n > 1 ? Math.sqrt(R.reduce((a, b) => a + (b - avg) ** 2, 0) / (n - 1)) : 0;
  let peak = 0, cum = 0, dd = 0;
  for (const r of R) { cum += r; peak = Math.max(peak, cum); dd = Math.min(dd, cum - peak); }
  const wins = R.filter((r) => r > 0);
  const losses = R.filter((r) => r <= 0);
  const gl = -losses.reduce((a, b) => a + b, 0);
  return {
    trades: n,
    perWeek: n / (years(d) * 52.18),
    winRate: n ? (wins.length / n) * 100 : 0,
    avgR: avg,
    totalR: sum,
    pf: gl > 0 ? wins.reduce((a, b) => a + b, 0) / gl : wins.length ? 99 : 0,
    maxDDR: dd,
    t: sd > 0 ? (avg / sd) * Math.sqrt(n) : 0, // how many standard errors the average R is above zero
  };
}

// Score used to pick levers on the learn period: the t-statistic of the average R.
// It rewards a higher edge but also enough trades to trust it, unlike raw expectancy,
// which you can always push up by keeping only a handful of lucky trades.
const score = (s) => (s.trades >= MIN_LEARN_TRADES ? s.t : -Infinity);

function runConfig(compiled, cfg, period) {
  const d = sets[cfg.tf][period];
  const res = BT.engine.run(d, compiled, cfg.params, Object.assign({}, BASE_SETTINGS, cfg.settings));
  return stats(res.trades, d);
}

const clone = (c) => ({ tf: c.tf, params: { ...c.params }, settings: { ...c.settings }, levers: [...c.levers], groups: new Set(c.groups) });
const r2 = (x) => (Number.isFinite(x) ? +x.toFixed(2) : '');
const r3 = (x) => (Number.isFinite(x) ? +x.toFixed(3) : '');

const stepRows = [];
const candidateRows = [];
for (const [key, file] of STRATEGIES) {
  const compiled = BT.engine.compile(readStrategy(file));
  let cfg = { tf: '5m', params: {}, settings: {}, levers: [], groups: new Set() };
  let learn = runConfig(compiled, cfg, 'learn');
  const t0 = Date.now();
  for (let step = 0; ; step++) {
    const test = runConfig(compiled, cfg, 'test');
    stepRows.push({ strategy: key, step, levers: cfg.levers.join(' + ') || '(baseline)', learn, test });
    console.log(`${key} step ${step}: ${cfg.levers.join(' + ') || 'baseline'} | learn n=${learn.trades} avgR=${r3(learn.avgR)} t=${r2(learn.t)} | test n=${test.trades} avgR=${r3(test.avgR)} t=${r2(test.t)}`);
    if (step === MAX_STEPS) break;
    let best = null;
    for (const lever of LEVERS) {
      if (cfg.groups.has(lever.group)) continue;
      const c = clone(cfg);
      lever.apply(c);
      c.levers.push(lever.id);
      c.groups.add(lever.group);
      const s = runConfig(compiled, c, 'learn');
      candidateRows.push({ strategy: key, step: step + 1, lever: lever.id, learn: s });
      if (!best || score(s) > score(best.s)) best = { c, s };
    }
    if (!best || !(score(best.s) > score(learn) + MIN_IMPROVEMENT)) break;
    cfg = best.c;
    learn = best.s;
  }
  console.log(`${key}: done in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}

const COLS = ['trades', 'perWeek', 'winRate', 'avgR', 'totalR', 'pf', 'maxDDR', 't'];
const fmt = (s, prefix) => Object.fromEntries(COLS.map((k) => [`${prefix}_${k}`, k === 'trades' ? s[k] : k === 'avgR' ? r3(s[k]) : r2(s[k])]));
function writeCsv(file, rows) {
  const head = Object.keys(rows[0]);
  const esc = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v);
  fs.writeFileSync(path.join(outDir, file), [head.join(','), ...rows.map((r) => head.map((h) => esc(r[h])).join(','))].join('\n') + '\n');
}
writeCsv('steps.csv', stepRows.map((r) => ({ strategy: r.strategy, step: r.step, levers: r.levers, ...fmt(r.learn, 'learn'), ...fmt(r.test, 'test') })));
writeCsv('candidates.csv', candidateRows.map((r) => ({ strategy: r.strategy, step: r.step, lever: r.lever, ...fmt(r.learn, 'learn') })));
const span = (d) => `${BT.fmt.date(d.time[0])} to ${BT.fmt.date(d.time[d.length - 1])}`;
console.log(`learn ${span(sets['5m'].learn)}, test ${span(sets['5m'].test)}; wrote steps.csv and candidates.csv to ${outDir}`);
