/*
 * Performance statistics computed from a backtest result.
 * Annualisation uses the calendar span of the data, so it works for any
 * bar size and for both exchange-hours and 24/7 markets.
 */
(function (root) {
  'use strict';
  const BT = (root.BT = root.BT || {});
  const YEAR = 365.25 * 86400;

  function drawdownSeries(equity) {
    let peak = -Infinity;
    return equity.map((v) => {
      if (v > peak) peak = v;
      return peak > 0 ? (v / peak - 1) * 100 : 0;
    });
  }

  function maxDrawdown(equity) {
    let peak = -Infinity;
    let peakIdx = 0;
    let maxDD = 0;
    let longest = 0;
    for (let i = 0; i < equity.length; i++) {
      const v = equity[i];
      if (v >= peak) {
        peak = v;
        peakIdx = i;
      } else {
        const dd = v / peak - 1;
        if (dd < maxDD) maxDD = dd;
        if (i - peakIdx > longest) longest = i - peakIdx;
      }
    }
    return { maxDD: maxDD * 100, longestBars: longest };
  }

  function compute(result) {
    const { equity, buyHold, trades, exposure, data, settings } = result;
    const n = equity.length;
    const start = settings.capital;
    const end = equity[n - 1];
    const years = Math.max((data.time[n - 1] - data.time[0]) / YEAR, 1 / 365.25);
    const periodsPerYear = (n - 1) / years;

    let sum = 0;
    let sumSq = 0;
    let downSq = 0;
    const rets = [];
    for (let i = 1; i < n; i++) {
      const r = equity[i - 1] > 0 ? equity[i] / equity[i - 1] - 1 : 0;
      rets.push(r);
      sum += r;
      sumSq += r * r;
      if (r < 0) downSq += r * r;
    }
    const m = rets.length ? sum / rets.length : 0;
    const variance = rets.length > 1 ? (sumSq - rets.length * m * m) / (rets.length - 1) : 0;
    const sd = Math.sqrt(Math.max(variance, 0));
    const downDev = rets.length ? Math.sqrt(downSq / rets.length) : 0;
    const ann = Math.sqrt(periodsPerYear);

    const totalReturn = (end / start - 1) * 100;
    const cagr = end > 0 ? (Math.pow(end / start, 1 / years) - 1) * 100 : -100;
    const dd = maxDrawdown(equity);
    const bh = maxDrawdown(buyHold);

    const wins = trades.filter((t) => t.pnl > 0);
    const losses = trades.filter((t) => t.pnl <= 0);
    const grossWin = wins.reduce((a, t) => a + t.pnl, 0);
    const grossLoss = -losses.reduce((a, t) => a + t.pnl, 0);
    const avg = (arr, f) => (arr.length ? arr.reduce((a, t) => a + f(t), 0) / arr.length : 0);
    let streak = 0;
    let maxLossStreak = 0;
    for (const t of trades) {
      streak = t.pnl <= 0 ? streak + 1 : 0;
      if (streak > maxLossStreak) maxLossStreak = streak;
    }
    const inMarket = exposure.reduce((a, x) => a + (x !== 0 ? 1 : 0), 0);
    const longs = trades.filter((t) => t.side === 'long');
    const withR = trades.filter((t) => Number.isFinite(t.rMultiple));
    // |value| below which the given share of the list falls (e.g. 0.9 -> 90th percentile)
    const quantile = (vals, q) => {
      if (!vals.length) return NaN;
      const v = vals.slice().sort((a, b) => a - b);
      return v[Math.min(v.length - 1, Math.floor(q * (v.length - 1) + 1e-9))];
    };
    const winMae = wins.map((t) => -t.maePct).filter(Number.isFinite);
    const lossMfe = losses.map((t) => t.mfePct).filter(Number.isFinite);
    const shorts = trades.filter((t) => t.side === 'short');

    return {
      startEquity: start,
      endEquity: end,
      netProfit: end - start,
      totalReturn,
      cagr,
      years,
      volatility: sd * ann * 100,
      sharpe: sd > 0 ? (m / sd) * ann : 0,
      sortino: downDev > 0 ? (m / downDev) * ann : 0,
      maxDrawdown: dd.maxDD,
      longestDrawdownBars: dd.longestBars,
      calmar: dd.maxDD < 0 ? cagr / -dd.maxDD : 0,
      buyHoldReturn: (buyHold[n - 1] / start - 1) * 100,
      buyHoldMaxDrawdown: bh.maxDD,
      trades: trades.length,
      winRate: trades.length ? (wins.length / trades.length) * 100 : 0,
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
      avgTradePct: avg(trades, (t) => t.returnPct),
      avgWinPct: avg(wins, (t) => t.returnPct),
      avgLossPct: avg(losses, (t) => t.returnPct),
      bestTradePct: trades.length ? Math.max(...trades.map((t) => t.returnPct)) : 0,
      worstTradePct: trades.length ? Math.min(...trades.map((t) => t.returnPct)) : 0,
      expectancy: avg(trades, (t) => t.pnl),
      avgBarsHeld: avg(trades, (t) => t.bars),
      maxLossStreak,
      exposurePct: (inMarket / n) * 100,
      commissionPaid: result.commissionPaid,
      longTrades: longs.length,
      longWinRate: longs.length ? (longs.filter((t) => t.pnl > 0).length / longs.length) * 100 : 0,
      shortTrades: shorts.length,
      shortWinRate: shorts.length ? (shorts.filter((t) => t.pnl > 0).length / shorts.length) * 100 : 0,
      // R-multiples: only trades that had a stop at entry
      rTrades: withR.length,
      avgR: withR.length ? avg(withR, (t) => t.rMultiple) : NaN,
      bestR: withR.length ? Math.max(...withR.map((t) => t.rMultiple)) : NaN,
      worstR: withR.length ? Math.min(...withR.map((t) => t.rMultiple)) : NaN,
      // excursions (MAE = worst point against you, MFE = best point in your favour)
      avgMaePct: avg(trades, (t) => t.maePct || 0),
      avgMfePct: avg(trades, (t) => t.mfePct || 0),
      winnersMae90: -quantile(winMae, 0.9), // 90% of winners never went further against you than this
      losersMfeAvg: lossMfe.length ? lossMfe.reduce((a, x) => a + x, 0) / lossMfe.length : NaN,
      losersUpAtSomePoint: lossMfe.length ? (lossMfe.filter((x) => x > 0.1).length / lossMfe.length) * 100 : NaN,
      skipped: result.skipped || { hours: 0, trend: 0, maxTrades: 0, dailyLoss: 0 },
    };
  }

  // Calendar-month returns of the equity curve: [{ year, months: [12], total }]
  function monthly(result) {
    const { equity, data, settings } = result;
    const rows = new Map();
    let prevEnd = settings.capital;
    let curKey = null;
    let curYear = null;
    let lastEq = settings.capital;
    let yearStart = settings.capital;
    const close = (key) => {
      const [y, mo] = key.split('-').map(Number);
      if (!rows.has(y)) rows.set(y, { year: y, months: new Array(12).fill(null), total: null });
      rows.get(y).months[mo] = (lastEq / prevEnd - 1) * 100;
      prevEnd = lastEq;
    };
    for (let i = 0; i < equity.length; i++) {
      const d = new Date(data.time[i] * 1000);
      const y = d.getUTCFullYear();
      const key = `${y}-${d.getUTCMonth()}`;
      if (curKey !== null && key !== curKey) {
        close(curKey);
        if (y !== curYear) {
          rows.get(curYear).total = (lastEq / yearStart - 1) * 100;
          yearStart = lastEq;
        }
      }
      curKey = key;
      curYear = y;
      lastEq = equity[i];
    }
    if (curKey !== null) {
      close(curKey);
      rows.get(curYear).total = (lastEq / yearStart - 1) * 100;
    }
    return Array.from(rows.values());
  }

  BT.metrics = { compute, monthly, drawdownSeries, maxDrawdown };
})(typeof window !== 'undefined' ? window : globalThis);
