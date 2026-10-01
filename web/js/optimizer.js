/*
 * Grid search over one or two strategy parameters, with an optional
 * in-sample / out-of-sample split to expose curve fitting.
 */
(function (root) {
  'use strict';
  const BT = (root.BT = root.BT || {});
  const MAX_RUNS = 2500;

  const OBJECTIVES = {
    sharpe: { label: 'Sharpe', get: (m) => m.sharpe, fmt: (v) => BT.fmt.num(v, 2) },
    totalReturn: { label: 'Return', get: (m) => m.totalReturn, fmt: (v) => BT.fmt.pct(v, 1) },
    calmar: { label: 'CAGR/DD', get: (m) => m.calmar, fmt: (v) => BT.fmt.num(v, 2) },
    profitFactor: { label: 'Profit factor', get: (m) => (m.profitFactor === Infinity ? 99 : m.profitFactor), fmt: (v) => BT.fmt.num(v, 2) },
    sortino: { label: 'Sortino', get: (m) => m.sortino, fmt: (v) => BT.fmt.num(v, 2) },
    winRate: { label: 'Win rate', get: (m) => m.winRate, fmt: (v) => BT.fmt.pct(v, 1, false) },
  };

  function range(from, to, step) {
    from = Number(from);
    to = Number(to);
    step = Math.abs(Number(step));
    if (![from, to, step].every(Number.isFinite) || step === 0) throw new Error('Each range needs numeric from, to and step values.');
    if (to < from) [from, to] = [to, from];
    const decimals = Math.max(0, ...[from, step].map((x) => (String(x).split('.')[1] || '').length));
    const out = [];
    for (let k = 0; ; k++) {
      const v = +(from + k * step).toFixed(decimals);
      if (v > to + 1e-9) break;
      out.push(v);
      if (out.length > MAX_RUNS) break;
    }
    return out;
  }

  function axisValues(param, spec) {
    if (!param) return [undefined];
    if (param.type === 'bool') return [false, true];
    if (param.type === 'select') return param.options.slice();
    return range(spec.from, spec.to, spec.step);
  }

  function countRuns(x, xs, y, ys) {
    return axisValues(x, xs).length * (y ? axisValues(y, ys).length : 1);
  }

  /**
   * opts: { data, compiled, baseParams, settings, x, xSpec, y, ySpec, objective, split, minTrades }
   * onProgress(done, total). Returns { cells, xs, ys, top, splitTime } and resolves asynchronously
   * so the page stays responsive. Call handle.cancel() to stop early.
   */
  function run(opts, onProgress) {
    const { data, compiled, baseParams, settings, x, y, objective, minTrades } = opts;
    const obj = OBJECTIVES[objective] || OBJECTIVES.sharpe;
    const xs = axisValues(x, opts.xSpec);
    const ys = y ? axisValues(y, opts.ySpec) : [undefined];
    const total = xs.length * ys.length;
    if (total > MAX_RUNS) throw new Error(`That is ${total.toLocaleString()} runs. Keep the sweep under ${MAX_RUNS.toLocaleString()} by using larger steps.`);
    const split = Math.min(100, Math.max(10, Number(opts.split) || 100));
    const cut = Math.floor((data.length * split) / 100);
    const inSample = split < 100 ? BT.engine.sliceData(data, 0, cut) : data;
    const outSample = split < 100 ? BT.engine.sliceData(data, cut, data.length) : null;

    let cancelled = false;
    const cells = [];
    const handle = {
      cancel() { cancelled = true; },
      promise: new Promise((resolve, reject) => {
        let k = 0;
        const step = () => {
          if (cancelled) return reject(new Error('Sweep cancelled.'));
          const t0 = Date.now();
          try {
            while (k < total && Date.now() - t0 < 40) {
              const xi = k % xs.length;
              const yi = Math.floor(k / xs.length);
              const params = Object.assign({}, baseParams);
              if (x) params[x.key] = xs[xi];
              if (y) params[y.key] = ys[yi];
              const r = BT.engine.run(inSample, compiled, params, settings);
              const m = r.metrics;
              const valid = m.trades >= (minTrades || 0);
              cells.push({ xi, yi, params, metrics: m, score: valid ? obj.get(m) : NaN, valid });
              k++;
            }
          } catch (e) {
            return reject(e);
          }
          if (onProgress) onProgress(k, total);
          if (k < total) setTimeout(step, 0);
          else resolve(finish());
        };
        setTimeout(step, 0);
      }),
    };

    function finish() {
      const ranked = cells.filter((c) => c.valid && Number.isFinite(c.score)).sort((a, b) => b.score - a.score);
      const top = ranked.slice(0, 15);
      if (outSample && outSample.length > 2) {
        for (const c of top) {
          try {
            const r = BT.engine.run(outSample, compiled, c.params, settings);
            c.oos = r.metrics;
            c.oosScore = obj.get(r.metrics);
          } catch (e) {
            c.oos = null;
          }
        }
      }
      return { cells, xs, ys, top, objective: obj, split, splitTime: outSample ? data.time[cut] : null };
    }

    return handle;
  }

  BT.optimizer = { run, range, axisValues, countRuns, OBJECTIVES, MAX_RUNS };
})(typeof window !== 'undefined' ? window : globalThis);
