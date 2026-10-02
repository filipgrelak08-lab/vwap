// EMA crossover parameter sweep across several symbols and timeframes.
//
//   node research/ema_sweep/run.js <data.json> [outDir] [ema|sma]
//
// data.json: { "SPY|1d": [[time, open, high, low, close, volume], ...], ... }
// (the format server.py's /api/yahoo returns in "bars").
//
// For every (fast, slow) pair the strategy is run long-only on the first 70% of
// each dataset ("in-sample") and separately on the last 30% ("out-of-sample"),
// so you can see whether settings that looked good earlier kept working later.
const fs = require('fs');
const path = require('path');
const { loadBT } = require('../../tests/load.js');

const BT = loadBT();
const [dataFile, outDir = path.join(__dirname), maType = 'ema'] = process.argv.slice(2);
if (!['ema', 'sma'].includes(maType)) throw new Error('moving average type must be ema or sma');
if (!dataFile) {
  console.error('usage: node research/ema_sweep/run.js <data.json> [outDir]');
  process.exit(1);
}

const LENGTHS = [2, 3, 4, 5, 7, 9, 12, 15, 20, 25, 30, 40, 50, 60, 75, 100, 125, 150, 200, 250, 300];
const SPLIT = 0.7;
const SETTINGS = { capital: 10000, sizePct: 100, commissionPct: 0.02, slippagePct: 0.01, fillOn: 'open', allowShorts: false };

const emaCross = BT.engine.compile(`export default {
  params: { fast: 12, slow: 26 },
  setup({ data, params, ta }) {
    return { fast: ta.${maType}(data.close, params.fast), slow: ta.${maType}(data.close, params.slow) };
  },
  onBar(ctx) {
    if (ctx.crossOver(ctx.ind.fast, ctx.ind.slow)) ctx.long();
    if (ctx.crossUnder(ctx.ind.fast, ctx.ind.slow)) ctx.exit('cross down');
  },
};`);
const buyHold = BT.engine.compile(`export default { onBar(ctx) { if (ctx.i === 0) ctx.long(); } };`);

const raw = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
const rows = [];
const benchmarks = [];
const r2 = (x) => (Number.isFinite(x) ? +x.toFixed(2) : x === Infinity ? 999 : '');
const r3 = (x) => (Number.isFinite(x) ? +x.toFixed(3) : x === Infinity ? 999 : '');

for (const [key, bars] of Object.entries(raw)) {
  const [symbol, interval] = key.split('|');
  const data = BT.data.fromBars(bars, { symbol, interval });
  const cut = Math.floor(data.length * SPLIT);
  const parts = { is: BT.engine.sliceData(data, 0, cut), oos: BT.engine.sliceData(data, cut, data.length), full: data };
  const bh = {};
  for (const [p, d] of Object.entries(parts)) bh[p] = BT.engine.run(d, buyHold, {}, SETTINGS).metrics;
  benchmarks.push({
    symbol, interval, bars: data.length,
    is_from: BT.fmt.date(parts.is.time[0]), is_to: BT.fmt.date(parts.is.time[parts.is.length - 1]),
    oos_from: BT.fmt.date(parts.oos.time[0]), oos_to: BT.fmt.date(parts.oos.time[parts.oos.length - 1]),
    bh_is_return: r2(bh.is.totalReturn), bh_is_sharpe: r3(bh.is.sharpe), bh_is_maxdd: r2(bh.is.maxDrawdown),
    bh_oos_return: r2(bh.oos.totalReturn), bh_oos_sharpe: r3(bh.oos.sharpe), bh_oos_maxdd: r2(bh.oos.maxDrawdown),
    bh_full_return: r2(bh.full.totalReturn), bh_full_cagr: r2(bh.full.cagr), bh_full_maxdd: r2(bh.full.maxDrawdown),
  });
  const t0 = Date.now();
  for (const fast of LENGTHS) {
    for (const slow of LENGTHS) {
      if (fast === slow) continue;
      const m = {};
      for (const [p, d] of Object.entries(parts)) m[p] = BT.engine.run(d, emaCross, { fast, slow }, SETTINGS).metrics;
      rows.push({
        symbol, interval, fast, slow, style: fast < slow ? 'trend' : 'dip',
        is_return: r2(m.is.totalReturn), is_cagr: r2(m.is.cagr), is_sharpe: r3(m.is.sharpe), is_maxdd: r2(m.is.maxDrawdown),
        is_trades: m.is.trades, is_winrate: r2(m.is.winRate), is_exposure: r2(m.is.exposurePct),
        oos_return: r2(m.oos.totalReturn), oos_cagr: r2(m.oos.cagr), oos_sharpe: r3(m.oos.sharpe), oos_maxdd: r2(m.oos.maxDrawdown),
        oos_trades: m.oos.trades, oos_winrate: r2(m.oos.winRate), oos_exposure: r2(m.oos.exposurePct),
        full_return: r2(m.full.totalReturn), full_cagr: r2(m.full.cagr), full_sharpe: r3(m.full.sharpe), full_maxdd: r2(m.full.maxDrawdown),
        full_trades: m.full.trades, bh_full_return: r2(bh.full.totalReturn), bh_full_cagr: r2(bh.full.cagr),
        bh_is_sharpe: r3(bh.is.sharpe), bh_oos_sharpe: r3(bh.oos.sharpe), bh_oos_return: r2(bh.oos.totalReturn),
        oos_beats_bh_sharpe: m.oos.sharpe > bh.oos.sharpe ? 1 : 0,
      });
    }
  }
  console.log(`${key}: ${data.length} bars, ${LENGTHS.length * (LENGTHS.length - 1)} pairs in ${Date.now() - t0} ms`);
}

// ---- aggregate per (interval, fast, slow) across symbols
const groups = new Map();
for (const r of rows) {
  const k = `${r.interval}|${r.fast}|${r.slow}`;
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(r);
}
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const summary = [];
for (const [k, g] of groups) {
  const [interval, fast, slow] = k.split('|');
  summary.push({
    interval, fast: +fast, slow: +slow, style: g[0].style, symbols: g.length,
    avg_is_sharpe: r3(mean(g.map((r) => r.is_sharpe))),
    avg_oos_sharpe: r3(mean(g.map((r) => r.oos_sharpe))),
    avg_bh_oos_sharpe: r3(mean(g.map((r) => r.bh_oos_sharpe))),
    avg_oos_return: r2(mean(g.map((r) => r.oos_return))),
    avg_bh_oos_return: r2(mean(g.map((r) => r.bh_oos_return))),
    avg_oos_maxdd: r2(mean(g.map((r) => r.oos_maxdd))),
    avg_oos_trades: r2(mean(g.map((r) => r.oos_trades))),
    avg_full_cagr: r2(mean(g.map((r) => r.full_cagr))),
    avg_bh_full_cagr: r2(mean(g.map((r) => r.bh_full_cagr))),
    avg_full_maxdd: r2(mean(g.map((r) => r.full_maxdd))),
    median_full_return: r2(g.map((r) => r.full_return).sort((a, b) => a - b)[Math.floor(g.length / 2)]),
    symbols_oos_profitable: g.filter((r) => r.oos_return > 0).length,
    symbols_oos_beat_bh_sharpe: g.reduce((s, r) => s + r.oos_beats_bh_sharpe, 0),
  });
}
summary.sort((a, b) => a.interval.localeCompare(b.interval) || b.avg_oos_sharpe - a.avg_oos_sharpe);

// ---- does a good in-sample Sharpe predict a good out-of-sample Sharpe? (Spearman rank correlation)
function spearman(xs, ys) {
  const rank = (v) => {
    const idx = v.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]);
    const r = new Array(v.length);
    idx.forEach(([, i], k) => (r[i] = k));
    return r;
  };
  const a = rank(xs);
  const b = rank(ys);
  const ma = mean(a);
  const mb = mean(b);
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < a.length; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return num / Math.sqrt(da * db);
}
for (const b of benchmarks) {
  const g = rows.filter((r) => r.symbol === b.symbol && r.interval === b.interval);
  b.is_vs_oos_sharpe_rank_corr = r3(spearman(g.map((r) => r.is_sharpe), g.map((r) => r.oos_sharpe)));
  const best = g.slice().sort((x, y) => y.is_sharpe - x.is_sharpe)[0];
  b.best_is_pair = `${best.fast}/${best.slow}`;
  b.best_is_pair_is_sharpe = best.is_sharpe;
  b.best_is_pair_oos_sharpe = best.oos_sharpe;
}

function writeCsv(file, list) {
  const cols = Object.keys(list[0]);
  const esc = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  fs.writeFileSync(file, [cols.join(','), ...list.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n') + '\n');
  console.log(`wrote ${file} (${list.length} rows)`);
}
fs.mkdirSync(outDir, { recursive: true });
writeCsv(path.join(outDir, 'all_runs.csv'), rows);
writeCsv(path.join(outDir, 'summary_by_pair.csv'), summary);
writeCsv(path.join(outDir, 'datasets.csv'), benchmarks);
