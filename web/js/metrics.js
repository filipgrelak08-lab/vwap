/*
 * The few statistics the app works out itself.
 *
 * Trader.dev returns the headline numbers with every backtest (net profit,
 * profit factor, Sharpe, drawdown and so on). What it does not return is
 * the calendar-month breakdown or an annualised return, so those are
 * derived here from the equity curve it sends back.
 */
(function (root) {
  'use strict';
  const BT = (root.BT = root.BT || {});
  const YEAR_MS = 365.25 * 86400 * 1000;

  /**
   * Calendar-month returns of an equity curve.
   * @param {Array<{time:number, equity:number}>} points  time in Unix ms, oldest first
   * @param {number} startEquity  equity before the first point
   * @returns {Array<{year:number, months:Array<number|null>, total:number|null}>}
   */
  function monthly(points, startEquity) {
    const rows = new Map();
    if (!points || !points.length) return [];
    let prevEnd = startEquity;
    let yearStart = startEquity;
    let curKey = null;
    let curYear = null;
    let lastEq = startEquity;
    const closeMonth = (key) => {
      const [y, mo] = key.split('-').map(Number);
      if (!rows.has(y)) rows.set(y, { year: y, months: new Array(12).fill(null), total: null });
      rows.get(y).months[mo] = prevEnd > 0 ? (lastEq / prevEnd - 1) * 100 : 0;
      prevEnd = lastEq;
    };
    for (const pt of points) {
      const d = new Date(pt.time);
      const y = d.getUTCFullYear();
      const key = `${y}-${d.getUTCMonth()}`;
      if (curKey !== null && key !== curKey) {
        closeMonth(curKey);
        if (y !== curYear) {
          rows.get(curYear).total = yearStart > 0 ? (lastEq / yearStart - 1) * 100 : 0;
          yearStart = lastEq;
        }
      }
      curKey = key;
      curYear = y;
      lastEq = pt.equity;
    }
    if (curKey !== null) {
      closeMonth(curKey);
      rows.get(curYear).total = yearStart > 0 ? (lastEq / yearStart - 1) * 100 : 0;
    }
    return Array.from(rows.values());
  }

  /** Annualised return from a total return over a window, in %. */
  function cagr(startEquity, endEquity, fromMs, toMs) {
    const years = Math.max((toMs - fromMs) / YEAR_MS, 1 / 365.25);
    if (!(startEquity > 0) || !(endEquity > 0)) return -100;
    return (Math.pow(endEquity / startEquity, 1 / years) - 1) * 100;
  }

  /** Span of a window in years, for labelling. */
  function years(fromMs, toMs) {
    return Math.max((toMs - fromMs) / YEAR_MS, 1 / 365.25);
  }

  BT.metrics = { monthly, cagr, years };
})(typeof window !== 'undefined' ? window : globalThis);
