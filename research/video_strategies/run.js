// "One lever at a time" study on Nasdaq-100 intraday data.
//
//   node research/video_strategies/run.js <nq.json> [outDir] [other.json]
//
// nq.json comes from build_data.py: { "NQ|5m": bars, "NQ|15m": bars }. If other.json
// (e.g. the S&P 500 built the same way) is given, the final Nasdaq versions are also run
// on it unchanged, to see whether what was learned on one market carries over to another.
//
// For each strategy: run the plain version, then add one lever (filter, stop, target,
// timeframe...) at a time, always picking the lever that most improves the result on the
// LEARN period (2019-2024). The TEST period (2025 onwards) is never used to choose
// anything; it only shows how each step held up on data it did not see.
const fs = require('fs');
const path = require('path');
const { loadBT, readStrategy } = require('../../tests/load.js');

const BT = loadBT();
const [dataFile, outDir = __dirname, otherFile] = process.argv.slice(2);
if (!dataFile) {
  console.error('usage: node research/video_strategies/run.js <nq.json> [outDir]');
  process.exit(1);
}

const TEST_FROM = Date.UTC(2025, 0, 1) / 1000;
const MAX_STEPS = 5;
const MIN_LEARN_TRADES = 150; // about one trade every two weeks over six years
const MIN_IMPROVEMENT = 0.1; // a lever must add at least this much to the score
const FINAL_LEVERS = 3; // the video's conclusion: past about three rules, test results get worse

// Nasdaq futures-like costs: ~0.3 index points of slippage and $2 commission per side on ~$400k notional.
const BASE_SETTINGS = {
  capital: 100000, sizing: 'risk', riskPct: 1, sizePct: 1000, // at most 10x leverage
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
  // published day-trading strategies (rules fixed in papers from 2018-2024)
  ['orb5_zarattini', 'nq_orb5_zarattini.js'],
  ['intraday_momentum', 'nq_intraday_momentum.js'],
  ['noise_area', 'nq_noise_area_momentum.js'],
];

// Levers. `group` makes them exclusive: one entry window, one stop, one target, and so on.
const { LEVERS } = require('./levers.js');

function loadSets(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const symbol = Object.keys(raw)[0].split('|')[0];
  const out = { symbol };
  for (const tf of ['5m', '15m']) {
    const data = BT.data.fromBars(raw[`${symbol}|${tf}`], { symbol, interval: tf });
    let cut = 0;
    while (cut < data.length && data.time[cut] < TEST_FROM) cut++;
    out[tf] = { learn: BT.engine.sliceData(data, 0, cut), test: BT.engine.sliceData(data, cut, data.length), full: data };
  }
  return out;
}
let sets = loadSets(dataFile);
const years = (d) => (d.time[d.length - 1] - d.time[0]) / (365.25 * 86400);

function stats(trades, d, metrics) {
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
    noStop: trades.length - n, // trades without an initial stop (no R); should be 0
    perWeek: n / (years(d) * 52.18),
    winRate: n ? (wins.length / n) * 100 : 0,
    avgR: avg,
    totalR: sum,
    pf: gl > 0 ? wins.reduce((a, b) => a + b, 0) / gl : wins.length ? 99 : 0,
    maxDDR: dd,
    t: sd > 0 ? (avg / sd) * Math.sqrt(n) : 0, // how many standard errors the average R is above zero
    returnPct: metrics ? metrics.totalReturn : NaN, // with 1% of equity risked per trade
    maxDDPct: metrics ? metrics.maxDrawdown : NaN,
  };
}

// Score used to pick levers on the learn period: the t-statistic of the average R.
// It rewards a higher edge but also enough trades to trust it, unlike raw expectancy,
// which you can always push up by keeping only a handful of lucky trades.
const score = (s) => (s.trades >= MIN_LEARN_TRADES ? s.t : -Infinity);

function runRaw(compiled, cfg, period) {
  const d = sets[cfg.tf][period];
  return { d, res: BT.engine.run(d, compiled, cfg.params, Object.assign({}, BASE_SETTINGS, cfg.settings)) };
}
function runConfig(compiled, cfg, period) {
  const { d, res } = runRaw(compiled, cfg, period);
  return stats(res.trades, d, res.metrics);
}

const clone = (c) => ({ tf: c.tf, params: { ...c.params }, settings: { ...c.settings }, levers: [...c.levers], groups: new Set(c.groups) });
const r2 = (x) => (Number.isFinite(x) ? +x.toFixed(2) : '');
const r3 = (x) => (Number.isFinite(x) ? +x.toFixed(3) : '');

const stepRows = [];
const candidateRows = [];
const finalRows = [];
for (const [key, file] of STRATEGIES) {
  const compiled = BT.engine.compile(readStrategy(file));
  let cfg = { tf: '5m', params: {}, settings: {}, levers: [], groups: new Set() };
  let learn = runConfig(compiled, cfg, 'learn');
  const history = [];
  const t0 = Date.now();
  for (let step = 0; ; step++) {
    const test = runConfig(compiled, cfg, 'test');
    stepRows.push({ strategy: key, step, levers: cfg.levers.join(' + ') || '(baseline)', learn, test });
    history.push({ cfg, learn, test });
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
  // final version: at most FINAL_LEVERS levers, fixed before looking at the test period
  const fin = history[Math.min(FINAL_LEVERS, history.length - 1)];
  const { res } = runRaw(compiled, fin.cfg, 'full');
  const byYear = {};
  for (const t of res.trades) {
    if (!Number.isFinite(t.rMultiple)) continue;
    const y = new Date(t.entryTime * 1000).getUTCFullYear();
    byYear[y] = (byYear[y] || 0) + t.rMultiple;
  }
  fin.compiled = compiled;
  finalRows.push({ fin, strategy: key, timeframe: fin.cfg.tf, levers: fin.cfg.levers.join(' + ') || '(baseline)', learn: fin.learn, test: fin.test, byYear });
  console.log(`${key}: done in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}

const COLS = ['trades', 'noStop', 'perWeek', 'winRate', 'avgR', 'totalR', 'pf', 'maxDDR', 't', 'returnPct', 'maxDDPct'];
const fmt = (s, prefix) => Object.fromEntries(COLS.map((k) => [`${prefix}_${k}`, k === 'trades' || k === 'noStop' ? s[k] : k === 'avgR' ? r3(s[k]) : r2(s[k])]));
function writeCsv(file, rows) {
  const head = Object.keys(rows[0]);
  const esc = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v);
  fs.writeFileSync(path.join(outDir, file), [head.join(','), ...rows.map((r) => head.map((h) => esc(r[h])).join(','))].join('\n') + '\n');
}
writeCsv('steps.csv', stepRows.map((r) => ({ strategy: r.strategy, step: r.step, levers: r.levers, ...fmt(r.learn, 'learn'), ...fmt(r.test, 'test') })));
const allYears = [...new Set(finalRows.flatMap((r) => Object.keys(r.byYear)))].sort();
writeCsv('final.csv', finalRows.map((r) => ({
  strategy: r.strategy, timeframe: r.timeframe, levers: r.levers, ...fmt(r.learn, 'learn'), ...fmt(r.test, 'test'),
  ...Object.fromEntries(allYears.map((y) => [`R_${y}`, r2(r.byYear[y] || 0)])),
})));
writeCsv('candidates.csv', candidateRows.map((r) => ({ strategy: r.strategy, step: r.step, lever: r.lever, ...fmt(r.learn, 'learn') })));
const span = (d) => `${BT.fmt.date(d.time[0])} to ${BT.fmt.date(d.time[d.length - 1])}`;
console.log(`learn ${span(sets['5m'].learn)}, test ${span(sets['5m'].test)}; wrote steps.csv, final.csv and candidates.csv to ${outDir}`);
if (otherFile) {
  sets = loadSets(otherFile);
  const rows = [];
  for (const r of finalRows) {
    for (const [label, cfg] of [['baseline', { tf: '5m', params: {}, settings: {} }], ['final', r.fin.cfg]]) {
      rows.push({
        market: sets.symbol, strategy: r.strategy, version: label, levers: label === 'final' ? r.levers : '(baseline)',
        ...fmt(runConfig(r.fin.compiled, cfg, 'learn'), 'learn'), ...fmt(runConfig(r.fin.compiled, cfg, 'test'), 'test'),
      });
    }
  }
  writeCsv('transfer.csv', rows);
  console.log(`ran the final versions on ${sets.symbol}: transfer.csv`);
}

