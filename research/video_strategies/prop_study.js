// Which strategy passes a prop-firm evaluation most often?
//
//   node research/video_strategies/prop_study.js <nq.json> [outDir]
//
// Simulates a 50K futures evaluation (Topstep / Apex end-of-day style) starting on every
// session of the period: +$3,000 profit target, $2,000 maximum loss that trails the best
// end-of-day balance until it reaches the starting balance, $1,000 daily loss limit, best
// day under 50% of total profit, at least 2 trading days. Intraday, a trade's worst point
// (its MAE) counts against the limit. Each strategy takes at most one trade a day and risks
// a fixed dollar amount per trade; that amount is chosen on 2019-2024 and then checked on
// 2025-2026.
const fs = require('fs');
const path = require('path');
const { loadBT, readStrategy } = require('../../tests/load.js');

const BT = loadBT();
const [dataFile, outDir = __dirname] = process.argv.slice(2);
const TEST_FROM = Date.UTC(2025, 0, 1) / 1000;
const DAY = 86400;
const RULES = { start: 50000, target: 3000, maxLoss: 2000, dailyLoss: 1000, bestDayShare: 0.5, minDays: 2, maxDays: 120 };
const RISKS = [150, 200, 250, 300, 400, 500, 600, 750, 1000];
const BASE = {
  capital: 100000, sizing: 'risk', riskPct: 1, sizePct: 1000, maxTradesPerDay: 1,
  commissionPct: 0.0005, slippagePct: 0.0015, fillOn: 'open', allowShorts: true, flatAtSessionEnd: true, atrLength: 14,
};

const raw = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
const data = BT.data.fromBars(raw['NQ|5m'], { symbol: 'NQ', interval: '5m' });
let cut = 0;
while (data.time[cut] < TEST_FROM) cut++;
const parts = { learn: BT.engine.sliceData(data, 0, cut), test: BT.engine.sliceData(data, cut, data.length) };
const sessions = (d) => [...new Set(d.time.map((t) => Math.floor(t / DAY)))];

const compiled = {};
const strat = (file) => (compiled[file] = compiled[file] || BT.engine.compile(readStrategy(file)));
function legTrades(leg, period) {
  const res = BT.engine.run(parts[period], strat(leg.file), leg.params || {}, Object.assign({}, BASE, leg.settings || {}));
  return res.trades.filter((t) => Number.isFinite(t.rMultiple));
}
// one trade a day: the earliest entry among the legs
function dailyTrades(legs, period) {
  const byDay = new Map();
  for (const leg of legs) {
    for (const t of legTrades(leg, period)) {
      const d = Math.floor(t.entryTime / DAY);
      const cur = byDay.get(d);
      if (!cur || t.entryTime < cur.entryTime) byDay.set(d, t);
    }
  }
  return byDay;
}

function rStats(byDay, nDays) {
  const R = [...byDay.values()].map((t) => t.rMultiple);
  const n = R.length;
  const avg = n ? R.reduce((a, b) => a + b, 0) / n : 0;
  const sd = n > 1 ? Math.sqrt(R.reduce((a, b) => a + (b - avg) ** 2, 0) / (n - 1)) : 0;
  let run = 0, worst = 0;
  for (const r of R) { run = r <= 0 ? run + 1 : 0; worst = Math.max(worst, run); }
  return { trades: n, tradeDays: n / nDays, winRate: (R.filter((r) => r > 0).length / (n || 1)) * 100, avgR: avg, t: sd ? (avg / sd) * Math.sqrt(n) : 0, worstLosingStreak: worst };
}

// Run one evaluation from session index s. Returns { result: 'pass'|'fail'|'open', days }.
function evaluate(days, byDay, s, risk) {
  let bal = RULES.start, peak = RULES.start, best = 0, traded = 0;
  for (let k = s; k < days.length && k - s < RULES.maxDays; k++) {
    const t = byDay.get(days[k]);
    if (!t) continue;
    const floor = Math.min(peak - RULES.maxLoss, RULES.start);
    const worstIntraday = bal + Math.min(0, t.maeR) * risk;
    if (worstIntraday <= floor) return { result: 'fail', days: k - s + 1 };
    const pnl = Math.max(t.rMultiple * risk, -RULES.dailyLoss);
    bal += pnl;
    traded++;
    best = Math.max(best, pnl);
    if (bal <= floor) return { result: 'fail', days: k - s + 1 };
    peak = Math.max(peak, bal);
    const profit = bal - RULES.start;
    if (traded >= RULES.minDays && profit >= RULES.target && best <= RULES.bestDayShare * profit) return { result: 'pass', days: k - s + 1 };
  }
  return { result: 'open', days: RULES.maxDays };
}

function propStats(byDay, period, risk) {
  const days = sessions(parts[period]);
  let pass = 0, fail = 0, open = 0;
  const passDays = [];
  // start no later than 40 sessions before the end so every run has time to finish
  const last = Math.max(1, days.length - 40);
  for (let s = 0; s < last; s++) {
    const e = evaluate(days, byDay, s, risk);
    if (e.result === 'pass') { pass++; passDays.push(e.days); } else if (e.result === 'fail') fail++; else open++;
  }
  passDays.sort((a, b) => a - b);
  const n = pass + fail + open;
  return { passRate: (pass / n) * 100, failRate: (fail / n) * 100, medianDaysToPass: passDays.length ? passDays[Math.floor(passDays.length / 2)] : NaN };
}

// ---- candidates. Settings from the lever study (chosen on 2019-2024) or the published rules.
const NOISE_LONG = { file: 'nq_noise_area_momentum.js', params: { nativeStop: false, direction: 'long', roomAtr: 2 }, settings: { atrStopMult: 1.5 } };
const ORB_TREND = { file: 'nq_opening_range_breakout.js', params: { dailyTrend: true, nativeStop: false, nativeTarget: false }, settings: { atrStopMult: 2, rrTarget: 3 } };
const CANDIDATES = [
  { name: 'Noise-area momentum (long only)', legs: [NOISE_LONG] },
  { name: 'Opening range breakout + daily trend', legs: [ORB_TREND] },
  { name: 'Combined: first signal of the day from the two above', legs: [ORB_TREND, NOISE_LONG] },
  { name: '5-min ORB, published rules (Zarattini & Aziz)', legs: [{ file: 'nq_orb5_zarattini.js' }] },
  { name: '5-min ORB, 5R target', legs: [{ file: 'nq_orb5_zarattini.js', params: { targetR: 5 } }] },
];

// Volatility breakout: pick k, trend filter and stop on the learn period only.
let bestVb = null;
for (const k of [0.1, 0.2, 0.3, 0.5, 0.75]) {
  for (const dailyTrend of [false, true]) {
    for (const stop of [0, 1.5, 3]) {
      const leg = { file: 'nq_volatility_breakout.js', params: { k, dailyTrend, nativeStop: stop === 0 }, settings: stop ? { atrStopMult: stop } : {} };
      const learnDays = sessions(parts.learn).length;
      const s = rStats(dailyTrades([leg], 'learn'), learnDays);
      if (s.tradeDays >= 0.4 && (!bestVb || s.t > bestVb.s.t)) bestVb = { leg, s };
    }
  }
}
const vb = bestVb.leg;
CANDIDATES.push({
  name: `Volatility breakout (k=${vb.params.k}${vb.params.dailyTrend ? ', daily trend' : ''}, ${vb.params.nativeStop ? 'stop at open' : `stop ${vb.settings.atrStopMult}×ATR`})`,
  legs: [vb],
});
CANDIDATES.push({ name: 'Combined: ORB + daily trend, noise-area long, volatility breakout', legs: [ORB_TREND, NOISE_LONG, vb] });
CANDIDATES.push({ name: 'nq_prop_combo.js (the same combination as one strategy file)', legs: [{ file: 'nq_prop_combo.js' }] });

const rows = [];
const riskRows = [];
for (const c of CANDIDATES) {
  const row = { strategy: c.name };
  const trades = { learn: dailyTrades(c.legs, 'learn'), test: dailyTrades(c.legs, 'test') };
  for (const p of ['learn', 'test']) {
    const s = rStats(trades[p], sessions(parts[p]).length);
    row[`${p}_trades`] = s.trades;
    row[`${p}_tradeDays%`] = +(s.tradeDays * 100).toFixed(0);
    row[`${p}_winRate`] = +s.winRate.toFixed(1);
    row[`${p}_avgR`] = +s.avgR.toFixed(3);
    row[`${p}_t`] = +s.t.toFixed(2);
    row[`${p}_worstLosingStreak`] = s.worstLosingStreak;
  }
  // risk per trade: best pass rate on the learn period
  let best = null;
  for (const risk of RISKS) {
    const s = propStats(trades.learn, 'learn', risk);
    const t = propStats(trades.test, 'test', risk);
    riskRows.push({ strategy: c.name, risk$: risk, learn_pass: +s.passRate.toFixed(1), learn_fail: +s.failRate.toFixed(1), test_pass: +t.passRate.toFixed(1), test_fail: +t.failRate.toFixed(1) });
    if (!best || s.passRate > best.s.passRate) best = { risk, s };
  }
  // R per calendar year, both periods
  for (const p of ['learn', 'test']) {
    for (const t of trades[p].values()) {
      const y = `R_${new Date(t.entryTime * 1000).getUTCFullYear()}`;
      row[y] = +((row[y] || 0) + t.rMultiple).toFixed(2);
    }
  }
  const test = propStats(trades.test, 'test', best.risk);
  // control: the same trades with the average R subtracted, i.e. the same swings but no edge.
  // This is how often you would pass by luck alone with this trade profile.
  const noEdge = (m) => {
    const R = [...m.values()].map((t) => t.rMultiple);
    const mean = R.reduce((a, b) => a + b, 0) / (R.length || 1);
    return new Map([...m].map(([d, t]) => [d, { ...t, rMultiple: t.rMultiple - mean, maeR: t.maeR }]));
  };
  const luckLearn = propStats(noEdge(trades.learn), 'learn', best.risk);
  const luckTest = propStats(noEdge(trades.test), 'test', best.risk);
  Object.assign(row, {
    risk$: best.risk,
    learn_pass: +best.s.passRate.toFixed(1), learn_fail: +best.s.failRate.toFixed(1), learn_medianDays: best.s.medianDaysToPass,
    test_pass: +test.passRate.toFixed(1), test_fail: +test.failRate.toFixed(1), test_medianDays: test.medianDaysToPass,
    learn_pass_noEdge: +luckLearn.passRate.toFixed(1), test_pass_noEdge: +luckTest.passRate.toFixed(1),
    test_expected$perMonth: Math.round(row.test_avgR * best.risk * (row['test_tradeDays%'] / 100) * 21),
  });
  rows.push(row);
  console.log(`${c.name}\n  learn: ${row.learn_trades} trades (${row['learn_tradeDays%']}% of days) win ${row.learn_winRate}% avgR ${row.learn_avgR} t ${row.learn_t} | test: ${row.test_trades} trades win ${row.test_winRate}% avgR ${row.test_avgR} t ${row.test_t} streak ${row.test_worstLosingStreak}`);
  console.log(`  risk $${best.risk}/trade: learn pass ${row.learn_pass}% (fail ${row.learn_fail}%, median ${row.learn_medianDays} days) | test pass ${row.test_pass}% (fail ${row.test_fail}%, median ${row.test_medianDays} days) | no-edge control: learn ${row.learn_pass_noEdge}% test ${row.test_pass_noEdge}%`);
}
const head = Object.keys(rows[0]);
const esc = (v) => (/[",]/.test(String(v)) ? `"${v}"` : v);
const rh = Object.keys(riskRows[0]);
fs.writeFileSync(path.join(outDir, 'prop_risk.csv'), [rh.join(','), ...riskRows.map((r) => rh.map((h) => esc(r[h])).join(','))].join('\n') + '\n');
fs.writeFileSync(path.join(outDir, 'prop_study.csv'), [head.join(','), ...rows.map((r) => head.map((h) => esc(r[h])).join(','))].join('\n') + '\n');
