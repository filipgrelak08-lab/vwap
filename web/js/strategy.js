/*
 * Strategy files: compiling them and reading their parameters.
 *
 * A strategy is one JavaScript file in strategies/ that exports a name, a
 * description, its parameters, and a pine() function returning the Pine
 * Script v6 that expresses its signals. Backtests themselves run on
 * Trader.dev; this file only loads the strategy and hands BT.pine what it
 * needs to generate the script.
 */
(function (root) {
  'use strict';
  const BT = (root.BT = root.BT || {});

  // Execution settings that apply to every strategy. These are the ones
  // Trader.dev's engine can reproduce; see web/js/pine.js.
  const DEFAULT_SETTINGS = {
    capital: 10000,
    allowShorts: true,
    // stops and targets (0 = off). A strategy's own levels come first.
    stopLossPct: 0,
    atrStopMult: 0, // stop = entry -/+ mult * ATR (wins over stopLossPct)
    atrLength: 14,
    takeProfitPct: 0,
    rrTarget: 0, // target = entry +/- rrTarget * initial risk (wins over takeProfitPct)
    trailingStopPct: 0,
    breakEvenR: 0, // move the stop to entry once the trade is this many R in profit
    maxBarsInTrade: 0, // time stop
    trendFilterLength: 0, // longs only above the N-bar SMA, shorts only below
  };

  // What the market panel asks Trader.dev for.
  const DEFAULT_MARKET = {
    symbol: 'BTCUSDT',
    timeframe: '1h',
    from: '',
    to: '',
  };

  // ---------------------------------------------------------------- compile

  let lineOffset = null;
  function getLineOffset() {
    if (lineOffset !== null) return lineOffset;
    try {
      new Function('"use strict";throw new Error("probe")\n//# sourceURL=probe.js')();
    } catch (e) {
      const m = String(e.stack || '').match(/probe\.js:(\d+)/);
      lineOffset = m ? Number(m[1]) - 1 : 0;
    }
    return lineOffset;
  }

  // Map an error thrown inside strategy code to a line number in the editor.
  function errorLine(err) {
    const m = String((err && err.stack) || '').match(/strategy\.js:(\d+)(?::(\d+))?/);
    return m ? Number(m[1]) - getLineOffset() : null;
  }

  function prettyLabel(key) {
    return key
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/_/g, ' ')
      .replace(/^./, (c) => c.toUpperCase());
  }

  function normalizeParam(key, spec) {
    if (typeof spec === 'number') spec = { value: spec };
    else if (typeof spec === 'boolean') spec = { value: spec };
    else if (typeof spec === 'string') spec = { value: spec, options: [spec] };
    if (!spec || typeof spec !== 'object' || !('value' in spec)) {
      throw new Error(`Parameter "${key}" needs a value, e.g. ${key}: 20 or ${key}: { value: 20, min: 5, max: 50 }`);
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`Parameter name "${key}" must be letters, numbers and _ only, starting with a letter.`);
    }
    const p = Object.assign({ key, label: prettyLabel(key) }, spec);
    if (typeof p.value === 'boolean') p.type = 'bool';
    else if (Array.isArray(p.options)) p.type = 'select';
    else if (typeof p.value === 'number') {
      p.type = 'number';
      const v = p.value;
      const isInt = Number.isInteger(v) && (p.step === undefined || Number.isInteger(p.step));
      if (p.step === undefined) p.step = isInt ? 1 : Math.pow(10, Math.floor(Math.log10(Math.abs(v) || 1)) - 1);
      if (p.min === undefined) p.min = isInt ? Math.max(1, Math.round(v / 4)) : +(v / 4).toPrecision(2);
      if (p.max === undefined) p.max = isInt ? Math.max(v * 4, v + 10) : +(v * 4).toPrecision(2);
      if (v < 0 && spec.min === undefined) p.min = v * 4;
      if (v < 0 && spec.max === undefined) p.max = 0;
    } else throw new Error(`Parameter "${key}" has an unsupported value type`);
    return p;
  }

  /**
   * Turn strategy source into { name, description, params, pine }.
   * The file may use `export default { ... }` or a bare `return { ... }`.
   */
  function compile(code) {
    // swap `export default` for `return` without touching line breaks, so error line numbers match the editor
    const body = String(code).replace(/^([ \t]*)export[ \t]+default\b/m, '$1return');
    let factory;
    try {
      factory = new Function('"use strict";' + body + '\n//# sourceURL=strategy.js');
    } catch (e) {
      const err = new Error(`Syntax error: ${e.message}`);
      err.line = errorLine(e);
      throw err;
    }
    let def;
    try {
      def = factory();
    } catch (e) {
      const err = new Error(`Error while loading strategy: ${e.message}`);
      err.line = errorLine(e);
      throw err;
    }
    if (!def || typeof def !== 'object') {
      throw new Error('The strategy must export an object: export default { name, params, pine }');
    }
    if (typeof def.pine !== 'function') {
      throw new Error('The strategy needs a pine({ p }) function returning { body, longEntry, shortEntry }.');
    }
    const params = Object.entries(def.params || {}).map(([k, v]) => normalizeParam(k, v));
    return {
      name: String(def.name || 'Untitled strategy'),
      description: String(def.description || ''),
      params,
      pine: def.pine,
    };
  }

  function defaultParams(compiled) {
    const out = {};
    for (const p of compiled.params) out[p.key] = p.value;
    return out;
  }

  // Starter code for "New strategy".
  const TEMPLATE = `// My strategy
// Docs: see the "Strategy API" panel next to this editor.

export default {
  name: 'My strategy',
  description: 'Long when the fast EMA crosses above the slow EMA, exit on the cross back down.',

  params: {
    fast: { value: 12, min: 2, max: 100, label: 'Fast EMA' },
    slow: { value: 26, min: 5, max: 300, label: 'Slow EMA' },
  },

  // Returns the Pine Script v6 that Trader.dev runs.
  // p.<name> is the Pine input holding that parameter's value.
  pine({ p }) {
    return {
      body: \`
fastMa = ta.ema(close, \${p.fast})
slowMa = ta.ema(close, \${p.slow})\`,

      longEntry: 'ta.crossover(fastMa, slowMa)',
      shortEntry: 'ta.crossunder(fastMa, slowMa)',

      plots: [
        { title: 'Fast EMA', expr: 'fastMa' },
        { title: 'Slow EMA', expr: 'slowMa' },
      ],
    };
  },
};
`;

  BT.strategy = { compile, defaultParams, normalizeParam, errorLine, DEFAULT_SETTINGS, DEFAULT_MARKET, TEMPLATE };
})(typeof window !== 'undefined' ? window : globalThis);
