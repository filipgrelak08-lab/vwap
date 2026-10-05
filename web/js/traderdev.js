/*
 * Trader.dev client.
 *
 * Every backtest in this app runs on Trader.dev. The browser cannot call
 * Trader.dev directly (the API key must not leave the machine, and the
 * browser would be blocked by CORS anyway), so requests go through the
 * local server, which holds the key and forwards them.
 *
 * See server.py for the proxy and the environment variables it reads.
 */
(function (root) {
  'use strict';
  const BT = (root.BT = root.BT || {});

  async function post(path, body) {
    let res;
    try {
      res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
    } catch (e) {
      throw new Error('Could not reach the local server. Is python3 server.py still running?');
    }
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload.error || `Trader.dev request failed (HTTP ${res.status}).`);
    return payload;
  }

  async function getJSON(path) {
    const res = await fetch(path);
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload.error || `Request failed (HTTP ${res.status}).`);
    return payload;
  }

  /** Is a key configured, and does the endpoint answer? */
  const status = () => getJSON('api/traderdev/status');

  const call = (tool, args) => post('api/traderdev/call', { tool, args: args || {} });

  /**
   * Run one backtest. Pass strategyId to add a version to an existing
   * Trader.dev strategy; pass name instead to create it the first time.
   */
  async function backtest(opts) {
    const args = {
      pineSource: opts.pineSource,
      symbol: opts.symbol,
      timeframe: opts.timeframe,
    };
    if (opts.from) args.from = opts.from;
    if (opts.to) args.to = opts.to;
    if (opts.initialCapital) args.initialCapital = opts.initialCapital;
    if (opts.notes) args.notes = opts.notes;
    if (opts.strategyId) args.strategyId = opts.strategyId;
    else if (opts.name) args.name = opts.name;
    const body = await call('quick_backtest', args);
    if (!body.result || !body.result.result) {
      throw new Error('Trader.dev did not return a backtest result.');
    }
    return body.result;
  }

  async function trades(resultId) {
    const body = await call('get_trades', { jobId: resultId });
    return Array.isArray(body.result) ? body.result : [];
  }

  async function equityCurve(resultId, maxPoints) {
    const body = await call('get_equity_curve', { jobId: resultId, maxPoints: maxPoints || 1500 });
    const r = body.result;
    const rows = Array.isArray(r) ? r : (r && (r.points || r.curve || r.equity)) || [];
    return rows;
  }

  /** Window and symbol Trader.dev will actually use. */
  async function plan(opts) {
    const body = await call('plan_backtest_window', opts);
    return body.result;
  }

  async function credits() {
    const body = await call('get_credits', {});
    return body.result;
  }

  /**
   * Parameter sweep on Trader.dev's side.
   * paramRanges entries are { name, min, max, step } using Pine input names.
   */
  async function optimize(opts) {
    const body = await call('optimize_strategy', opts);
    return body.result;
  }

  BT.traderdev = { status, call, backtest, trades, equityCurve, plan, credits, optimize };
})(typeof window !== 'undefined' ? window : globalThis);
