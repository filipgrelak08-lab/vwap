// What did best in 2024-2026, and was it more than luck?
//
//   node research/video_strategies/recent_study.js <nq.json> [outDir]
//
// Every strategy is run with no lever, each single lever and each pair of levers, always
// with at most one trade a day (the prop-firm setting). Versions are ranked on RECENT
// (2024-01-01 to the end of the data). Searching hundreds of versions always finds some
// that look great by chance, so the top versions are then run on EARLIER (2019-2023),
// which played no part in the ranking. A version only counts if it also held up there.
// Finally the survivors go through the 50K evaluation simulation on the recent period,
// with the risk per trade chosen on the earlier period.
const fs = require('fs');
const path = require('path');
const { loadBT, readStrategy } = require('../../tests/load.js');
const { LEVERS } = require('./levers.js');

const BT = loadBT();
const [dataFile, outDir = __dirname] = process.argv.slice(2);
const SPLIT = Date.UTC(2024, 0, 1) / 1000;
const DAY = 86400;
const MIN_TRADE_DAYS = 0.4; // trades on at least 40% of sessions
const TOP = 40; // versions checked on the earlier period
const MIN_EARLIER_T = 1.5; // and kept only if they held up there
const BASE = {
  capital: 100000, sizing: 'risk', riskPct: 1, sizePct: 1000, maxTradesPerDay: 1,
  commissionPct: 0.0005, slippagePct: 0.0015, fillOn: 'open', allowShorts: true, flatAtSessionEnd: true, atrLength: 14,
};
const RULES = { start: 50000, target: 3000, maxLoss: 2000, dailyLoss: 1000, bestDayShare: 0.5, minDays: 2, maxDays: 120 };
const RISKS = [150, 200, 250, 300, 400, 500];

const STRATEGIES = [
  'nq_opening_range_breakout.js', 'nq_vwap_sigma_reversion.js', 'nq_supertrend_flip.js', 'nq_volume_spike_breakout.js',
  'nq_liquidity_sweep_reclaim.js', 'nq_candle2_reversal.js', 'nq_orb5_zarattini.js', 'nq_intraday_momentum.js',
  'nq_noise_area_momentum.js', 'nq_volatility_breakout.js',
];

const raw = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
const sets = {};
for (const tf of ['5m', '15m']) {
  const d = BT.data.fromBars(raw[`NQ|${tf}`], { symbol: 'NQ', interval: tf });
  let cut = 0;
  while (d.time[cut] < SPLIT) cut++;
  sets[tf] = { earlier: BT.engine.sliceData(d, 0, cut), recent: BT.engine.sliceData(d, cut, d.length) };
}
const sessions = (d) => [...new Set(d.time.map((t) => Math.floor(t / DAY)))];
const nSessions = { earlier: sessions(sets['5m'].earlier).length, recent: sessions(sets['5m'].recent).length };

function stats(trades, period) {
  const T = trades.filter((t) => Number.isFinite(t.rMultiple));
  const R = T.map((t) => t.rMultiple);
  const n = R.length;
  const sum = R.reduce((a, b) => a + b, 0);
  const avg = n ? sum / n : 0;
  const sd = n > 1 ? Math.sqrt(R.reduce((a, b) => a + (b - avg) ** 2, 0) / (n - 1)) : 0;
  let peak = 0, cum = 0, dd = 0, run = 0, streak = 0;
  for (const r of R) {
    cum += r; peak = Math.max(peak, cum); dd = Math.min(dd, cum - peak);
    run = r <= 0 ? run + 1 : 0; streak = Math.max(streak, run);
  }
  const byYear = {};
  for (const t of T) {
    const y = new Date(t.entryTime * 1000).getUTCFullYear();
    byYear[y] = (byYear[y] || 0) + t.rMultiple;
  }
  return {
    trades: n, tradeDays: n / nSessions[period], winRate: n ? (R.filter((r) => r > 0).length / n) * 100 : 0,
    avgR: avg, totalR: sum, t: sd ? (avg / sd) * Math.sqrt(n) : 0, maxDDR: dd, losingStreak: streak, byYear, T,
  };
}

const compiled = {};
const strat = (f) => (compiled[f] = compiled[f] || BT.engine.compile(readStrategy(f)));
function run(v, period) {
  const res = BT.engine.run(sets[v.tf][period], strat(v.file), v.params, Object.assign({}, BASE, v.settings));
  return stats(res.trades, period);
}

// all versions: no lever, one lever, two levers from different groups
const levers = LEVERS.filter((l) => l.group !== 'maxday'); // one trade a day is always on
const combos = [[]];
for (let a = 0; a < levers.length; a++) {
  combos.push([levers[a]]);
  for (let b = a + 1; b < levers.length; b++) if (levers[a].group !== levers[b].group) combos.push([levers[a], levers[b]]);
}
const versions = [];
for (const file of STRATEGIES) {
  for (const combo of combos) {
    const v = { file, tf: '5m', params: {}, settings: {}, levers: combo.map((l) => l.id).join(' + ') || '(no lever)' };
    for (const l of combo) l.apply(v);
    versions.push(v);
  }
}

console.log(`${versions.length} versions, ranking on ${BT.fmt.date(sets['5m'].recent.time[0])} to ${BT.fmt.date(sets['5m'].recent.time.at(-1))}`);
const t0 = Date.now();
const ranked = [];
for (const v of versions) {
  const s = run(v, 'recent');
  if (s.tradeDays >= MIN_TRADE_DAYS) ranked.push({ v, recent: s });
}
ranked.sort((a, b) => b.recent.t - a.recent.t);
console.log(`ran in ${((Date.now() - t0) / 1000).toFixed(0)} s; ${ranked.length} trade on at least ${MIN_TRADE_DAYS * 100}% of days`);
const top = ranked.slice(0, TOP);
for (const r of top) r.earlier = run(r.v, 'earlier');

// ---- prop evaluation (same model as prop_study.js)
function evaluate(days, byDay, s, risk) {
  let bal = RULES.start, peak = RULES.start, best = 0, traded = 0;
  for (let k = s; k < days.length && k - s < RULES.maxDays; k++) {
    const t = byDay.get(days[k]);
    if (!t) continue;
    const floor = Math.min(peak - RULES.maxLoss, RULES.start);
    if (bal + Math.min(0, t.maeR) * risk <= floor) return 'fail';
    const pnl = Math.max(t.rMultiple * risk, -RULES.dailyLoss);
    bal += pnl; traded++; best = Math.max(best, pnl);
    if (bal <= floor) return 'fail';
    peak = Math.max(peak, bal);
    const profit = bal - RULES.start;
    if (traded >= RULES.minDays && profit >= RULES.target && best <= RULES.bestDayShare * profit) return 'pass';
  }
  return 'open';
}
function passRate(T, period, risk, removeEdge) {
  const mean = removeEdge ? T.reduce((a, t) => a + t.rMultiple, 0) / (T.length || 1) : 0;
  const byDay = new Map(T.map((t) => [Math.floor(t.entryTime / DAY), { rMultiple: t.rMultiple - mean, maeR: t.maeR }]));
  const days = sessions(sets['5m'][period]);
  const out = { pass: 0, fail: 0, open: 0 };
  const last = Math.max(1, days.length - 40);
  for (let s = 0; s < last; s++) out[evaluate(days, byDay, s, risk)]++;
  return { pass: (out.pass / last) * 100, fail: (out.fail / last) * 100 };
}

const r2 = (x) => +x.toFixed(2);
const rows = top.map((r, rank) => {
  const keep = r.earlier.avgR > 0 && r.earlier.t >= MIN_EARLIER_T;
  const row = {
    rank: rank + 1, strategy: r.v.file.replace(/^nq_|\.js$/g, ''), levers: r.v.levers, held_up_earlier: keep ? 'yes' : 'no',
    recent_trades: r.recent.trades, recent_tradeDays: Math.round(r.recent.tradeDays * 100), recent_winRate: r2(r.recent.winRate),
    recent_avgR: +r.recent.avgR.toFixed(3), recent_t: r2(r.recent.t), recent_totalR: r2(r.recent.totalR), recent_maxDDR: r2(r.recent.maxDDR),
    recent_losingStreak: r.recent.losingStreak,
    R_2024: r2(r.recent.byYear[2024] || 0), R_2025: r2(r.recent.byYear[2025] || 0), R_2026: r2(r.recent.byYear[2026] || 0),
    earlier_trades: r.earlier.trades, earlier_avgR: +r.earlier.avgR.toFixed(3), earlier_t: r2(r.earlier.t),
    earlier_losing_years: Object.values(r.earlier.byYear).filter((x) => x < 0).length,
  };
  if (keep) {
    // risk per trade: best pass rate on the earlier period, then used on the recent one
    let best = null;
    for (const risk of RISKS) {
      const p = passRate(r.earlier.T, 'earlier', risk);
      if (!best || p.pass > best.p.pass) best = { risk, p };
    }
    const p = passRate(r.recent.T, 'recent', best.risk);
    const luck = passRate(r.recent.T, 'recent', best.risk, true);
    Object.assign(row, { risk$: best.risk, recent_pass: r2(p.pass), recent_fail: r2(p.fail), recent_pass_noEdge: r2(luck.pass) });
  }
  return row;
});
for (const r of rows) {
  console.log(`${String(r.rank).padStart(2)} ${r.held_up_earlier === 'yes' ? 'KEEP' : '    '} ${r.strategy} | ${r.levers} | recent n=${r.recent_trades} (${r.recent_tradeDays}% of days) win ${r.recent_winRate}% avgR ${r.recent_avgR} t ${r.recent_t} [${r.R_2024}/${r.R_2025}/${r.R_2026}] | earlier avgR ${r.earlier_avgR} t ${r.earlier_t}${r.risk$ ? ` | $${r.risk$}: pass ${r.recent_pass}% fail ${r.recent_fail}% (luck ${r.recent_pass_noEdge}%)` : ''}`);
}
const head = [...new Set(rows.flatMap((r) => Object.keys(r)))];
const esc = (v) => (v === undefined ? '' : /[",]/.test(String(v)) ? `"${v}"` : v);
fs.writeFileSync(path.join(outDir, 'recent_study.csv'), [head.join(','), ...rows.map((r) => head.map((h) => esc(r[h])).join(','))].join('\n') + '\n');
