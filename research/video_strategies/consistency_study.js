// Which versions kept their edge in EVERY half-year of 2024-2026, rather than one great stretch?
//
//   node research/video_strategies/consistency_study.js <nq.json> [outDir]
//
// Same 2,340 versions as recent_study.js (every strategy with no lever, one lever or two levers,
// one trade a day). Instead of ranking on the whole 2024-2026 block, which one strong half-year
// can carry, each version is ranked by its WORST half-year average R from 2024 H1 to 2026 H2,
// and must be positive in all of them. The last 12 months are compared with what came before
// to flag edges that are fading. The top versions are then checked on 2019-2023, which played
// no part in the ranking, and run through the 50K evaluation on 2024-2026 with the risk per
// trade chosen on 2019-2023.
const fs = require('fs');
const path = require('path');
const { loadBT, readStrategy } = require('../../tests/load.js');
const { LEVERS } = require('./levers.js');

const BT = loadBT();
const [dataFile, outDir = __dirname] = process.argv.slice(2);
const SPLIT = Date.UTC(2024, 0, 1) / 1000;
const DAY = 86400;
const MIN_TRADE_DAYS = 0.4;
const TOP = 30;
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
const end = sets['5m'].recent.time.at(-1);
const LAST12 = end - 365 * DAY;
const half = (t) => { const d = new Date(t * 1000); return `${d.getUTCFullYear()}${d.getUTCMonth() < 6 ? 'H1' : 'H2'}`; };

function summarize(trades, period) {
  const T = trades.filter((t) => Number.isFinite(t.rMultiple));
  const R = T.map((t) => t.rMultiple);
  const n = R.length;
  const avg = n ? R.reduce((a, b) => a + b, 0) / n : 0;
  const sd = n > 1 ? Math.sqrt(R.reduce((a, b) => a + (b - avg) ** 2, 0) / (n - 1)) : 0;
  const halves = {};
  for (const t of T) (halves[half(t.entryTime)] = halves[half(t.entryTime)] || []).push(t.rMultiple);
  const halfAvg = Object.fromEntries(Object.entries(halves).map(([k, v]) => [k, v.reduce((a, b) => a + b, 0) / v.length]));
  const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : NaN);
  return {
    T, trades: n, tradeDays: n / nSessions[period], winRate: n ? (R.filter((r) => r > 0).length / n) * 100 : 0,
    avgR: avg, t: sd ? (avg / sd) * Math.sqrt(n) : 0, halfAvg,
    worstHalf: Math.min(...Object.values(halfAvg)),
    last12: mean(T.filter((t) => t.entryTime >= LAST12).map((t) => t.rMultiple)),
    before12: mean(T.filter((t) => t.entryTime < LAST12).map((t) => t.rMultiple)),
  };
}

const compiled = {};
const strat = (f) => (compiled[f] = compiled[f] || BT.engine.compile(readStrategy(f)));
const run = (v, period) => summarize(BT.engine.run(sets[v.tf][period], strat(v.file), v.params, Object.assign({}, BASE, v.settings)).trades, period);

const levers = LEVERS.filter((l) => l.group !== 'maxday');
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

const t0 = Date.now();
const ok = [];
let tested = 0;
for (const v of versions) {
  const s = run(v, 'recent');
  if (s.tradeDays < MIN_TRADE_DAYS) continue;
  tested++;
  if (s.worstHalf > 0) ok.push({ v, recent: s });
}
ok.sort((a, b) => b.recent.worstHalf - a.recent.worstHalf);
console.log(`${versions.length} versions in ${((Date.now() - t0) / 1000).toFixed(0)} s; ${tested} trade on ≥ ${MIN_TRADE_DAYS * 100}% of days; ${ok.length} positive in every half-year of 2024-2026`);

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

const f2 = (x) => (Number.isFinite(x) ? +x.toFixed(2) : '');
const f3 = (x) => (Number.isFinite(x) ? +x.toFixed(3) : '');
const HALVES = ['2024H1', '2024H2', '2025H1', '2025H2', '2026H1', '2026H2'];
const rows = ok.slice(0, TOP).map((r, i) => {
  const e = run(r.v, 'earlier');
  const earlierHalves = Object.values(e.halfAvg);
  const keep = e.avgR > 0 && e.t >= 1.5;
  const row = {
    rank: i + 1, strategy: r.v.file.replace(/^nq_|\.js$/g, ''), levers: r.v.levers, held_up_earlier: keep ? 'yes' : 'no',
    fading: r.recent.last12 < 0.5 * r.recent.before12 ? 'yes' : 'no',
    recent_trades: r.recent.trades, recent_tradeDays: Math.round(r.recent.tradeDays * 100), recent_winRate: f2(r.recent.winRate),
    recent_avgR: f3(r.recent.avgR), recent_t: f2(r.recent.t), worst_half: f3(r.recent.worstHalf),
    ...Object.fromEntries(HALVES.map((h) => [`avgR_${h}`, f3(r.recent.halfAvg[h])])),
    last12_avgR: f3(r.recent.last12), before_last12_avgR: f3(r.recent.before12),
    earlier_avgR: f3(e.avgR), earlier_t: f2(e.t), earlier_negative_halves: `${earlierHalves.filter((x) => x < 0).length}/${earlierHalves.length}`,
  };
  if (keep) {
    let best = null;
    for (const risk of RISKS) {
      const p = passRate(e.T, 'earlier', risk);
      if (!best || p.pass > best.p.pass) best = { risk, p };
    }
    const p = passRate(r.recent.T, 'recent', best.risk);
    const luck = passRate(r.recent.T, 'recent', best.risk, true);
    Object.assign(row, { risk$: best.risk, recent_pass: f2(p.pass), recent_fail: f2(p.fail), recent_pass_noEdge: f2(luck.pass) });
  }
  console.log(`${String(row.rank).padStart(2)} ${keep ? 'KEEP' : '    '}${row.fading === 'yes' ? ' FADING' : ''} ${row.strategy} | ${row.levers} | ${row.recent_tradeDays}% days win ${row.recent_winRate}% avgR ${row.recent_avgR} worst half ${row.worst_half} | halves ${HALVES.map((h) => row[`avgR_${h}`]).join(' ')} | last 12m ${row.last12_avgR} vs before ${row.before_last12_avgR} | 2019-23 avgR ${row.earlier_avgR} t ${row.earlier_t} neg halves ${row.earlier_negative_halves}${row.risk$ ? ` | $${row.risk$}: pass ${row.recent_pass}% fail ${row.recent_fail}% (luck ${row.recent_pass_noEdge}%)` : ''}`);
  return row;
});
const head = [...new Set(rows.flatMap((r) => Object.keys(r)))];
const esc = (v) => (v === undefined ? '' : /[",]/.test(String(v)) ? `"${v}"` : v);
fs.writeFileSync(path.join(outDir, 'consistency_study.csv'), [head.join(','), ...rows.map((r) => head.map((h) => esc(r[h])).join(','))].join('\n') + '\n');
