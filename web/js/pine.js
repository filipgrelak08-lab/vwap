/*
 * Pine Script v6 code generation.
 *
 * Every backtest runs on Trader.dev, which executes Pine. This file turns
 * the strategy currently selected in the app, with its parameter values and
 * the execution settings from the sidebar, into one self-contained
 * //@version=6 strategy.
 *
 * A strategy supplies its signals through pine({ p, params }):
 *
 *   pine({ p }) {
 *     return {
 *       body: `fastMa = ta.ema(close, ${p.fast})\nslowMa = ta.ema(close, ${p.slow})`,
 *       longEntry: 'ta.crossover(fastMa, slowMa)',
 *       shortEntry: 'ta.crossunder(fastMa, slowMa)',
 *       longExit: 'ta.crossunder(fastMa, slowMa)',   // optional
 *       longStop: 'fastMa',                          // optional, overrides the sidebar stop
 *     };
 *   }
 *
 * `p.<key>` is the Pine variable name of that parameter's input, p_<key>, so
 * the script exposes every parameter as a Pine input. Each stop, target and
 * filter that is switched on becomes an input too, named r_<setting>. That
 * is what lets Trader.dev's optimizer sweep them: it addresses Pine inputs
 * by variable name.
 *
 * Trader.dev fixes commission at 0.05% per side, position size at 100% of
 * equity and fills on the signal bar's close, so the app has no controls
 * for those.
 */
(function (root) {
  'use strict';
  const BT = (root.BT = root.BT || {});

  const PARAM_PREFIX = 'p_';
  const SETTING_PREFIX = 'r_';

  // Execution settings that become Pine, with the label and type of the
  // input each one generates. Anything outside this list has no equivalent
  // on Trader.dev's engine.
  const SETTING_INPUTS = {
    stopLossPct: ['Stop loss %', 'float'],
    atrStopMult: ['ATR stop (x ATR)', 'float'],
    atrLength: ['ATR length', 'int'],
    takeProfitPct: ['Take profit %', 'float'],
    rrTarget: ['Reward:risk (R)', 'float'],
    trailingStopPct: ['Trailing stop %', 'float'],
    breakEvenR: ['Break-even after (R)', 'float'],
    maxBarsInTrade: ['Time stop (bars)', 'int'],
    trendFilterLength: ['Trend SMA', 'int'],
  };
  const SUPPORTED = ['capital', 'allowShorts'].concat(Object.keys(SETTING_INPUTS));

  const inputName = (key) => PARAM_PREFIX + key;
  const settingInputName = (key) => SETTING_PREFIX + key;

  // Pine number literal: no exponent form, no trailing noise.
  function num(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`Cannot put ${v} in Pine code.`);
    if (Number.isInteger(n)) return String(n);
    return n.toFixed(10).replace(/0+$/, '').replace(/\.$/, '.0');
  }

  // Pine keeps int and float apart, so float literals keep a decimal point.
  const flt = (v) => (Number.isInteger(Number(v)) ? `${num(v)}.0` : num(v));

  function str(v) {
    return '"' + String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ') + '"';
  }

  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

  function paramInput(p, value) {
    const name = inputName(p.key);
    const title = str(p.label);
    if (p.type === 'bool') return `${name} = input.bool(${value ? 'true' : 'false'}, ${title})`;
    // Trader.dev's parser rejects the `options=[...]` list, so a dropdown
    // becomes a plain string input. The choices go in the title instead, and
    // the app's own sidebar still offers them as a dropdown.
    if (p.type === 'select') {
      return `${name} = input.string(${str(value)}, ${str(`${p.label} (${p.options.join('/')})`)})`;
    }
    const isInt = Number.isInteger(p.value) && Number.isInteger(p.step);
    const v = isInt ? Math.round(clamp(value, p.min, p.max)) : clamp(value, p.min, p.max);
    const lit = isInt ? num : flt;
    const args = [lit(v), title, `minval=${lit(p.min)}`, `maxval=${lit(p.max)}`];
    if (p.step) args.push(`step=${lit(p.step)}`);
    return `${name} = ${isInt ? 'input.int' : 'input.float'}(${args.join(', ')})`;
  }

  // Indent a block of Pine by one level (Pine blocks are indentation-based).
  const indent = (text) =>
    String(text)
      .split('\n')
      .map((l) => (l.trim() ? '    ' + l : l))
      .join('\n');

  const expr = (e) => `(${String(e).trim()})`;

  /**
   * Build the Pine source for one backtest.
   * @param {object} compiled  from BT.strategy.compile()
   * @param {object} params    parameter values, keyed as in compiled.params
   * @param {object} settings  execution settings (the sidebar)
   * @returns {string} Pine v6 source
   */
  function build(compiled, params, settings) {
    if (typeof compiled.pine !== 'function') {
      throw new Error(
        'This strategy has no pine() function, so it cannot run on Trader.dev. ' +
          'Add one that returns { body, longEntry, shortEntry } — see the Strategy API panel next to the editor.'
      );
    }
    const s = settings || {};
    const value = (key) => {
      const v = Number(s[key]);
      return Number.isFinite(v) && v > 0 ? v : 0;
    };

    // Settings become inputs on first use, so the script only exposes what
    // is switched on, and the optimizer can sweep those by name.
    const settingLines = [];
    const seen = {};
    function R(key) {
      if (seen[key]) return seen[key];
      const [label, kind] = SETTING_INPUTS[key];
      const name = settingInputName(key);
      const v = value(key);
      settingLines.push(
        kind === 'int'
          ? `${name} = input.int(${num(Math.max(1, Math.round(v)))}, ${str(label)}, minval=1)`
          : `${name} = input.float(${flt(v)}, ${str(label)}, minval=0.0)`
      );
      seen[key] = name;
      return name;
    }

    // ---- what the strategy hands us
    const p = {};
    for (const pr of compiled.params) p[pr.key] = inputName(pr.key);
    let sig;
    try {
      sig = compiled.pine({ p, params, settings: s });
    } catch (e) {
      throw new Error(`pine() failed: ${e.message}`);
    }
    if (typeof sig === 'string') sig = { body: sig };
    if (!sig || typeof sig !== 'object') throw new Error('pine() must return { body, longEntry, shortEntry }.');
    if (!sig.longEntry && !sig.shortEntry) throw new Error('pine() must return at least one of longEntry or shortEntry.');

    const shorts = s.allowShorts !== false;
    const hasLong = !!sig.longEntry;
    const hasShort = !!(sig.shortEntry && shorts);

    // ---- risk series
    const riskLines = [];
    if (value('atrStopMult')) riskLines.push(`atrVal = ta.atr(${R('atrLength')})`);
    if (value('trendFilterLength')) riskLines.push(`trendVal = ta.sma(close, ${R('trendFilterLength')})`);

    // ---- entries and exits
    const filt = (cond, sgn) => {
      const parts = [expr(cond)];
      if (value('trendFilterLength')) parts.push(sgn > 0 ? 'close > trendVal' : 'close < trendVal');
      return parts.join(' and ');
    };
    // With shorting off a short signal only closes the long, as it does in the app.
    const longExits = [sig.longExit, !shorts && sig.shortEntry ? sig.shortEntry : null].filter(Boolean);
    const hasLongExit = longExits.length > 0;
    const hasShortExit = !!(hasShort && sig.shortExit);
    const signalLines = [];
    if (hasLong) signalLines.push(`longEntry = ${filt(sig.longEntry, 1)}`);
    if (hasShort) signalLines.push(`shortEntry = ${filt(sig.shortEntry, -1)}`);
    if (hasLongExit) signalLines.push(`longExit = ${longExits.map(expr).join(' or ')}`);
    if (hasShortExit) signalLines.push(`shortExit = ${expr(sig.shortExit)}`);

    // ---- stop and target at entry.
    // Priority matches the app: the strategy's own level, then the ATR stop
    // over stop loss %, and reward:risk over take profit %.
    const chain = (parts) => parts.reduceRight((acc, cur) => (acc ? `nz(${cur}, ${acc})` : cur), null);
    const stopChain = (sgn) => {
      const parts = [];
      if (sgn > 0 ? sig.longStop : sig.shortStop) parts.push(expr(sgn > 0 ? sig.longStop : sig.shortStop));
      if (value('atrStopMult')) parts.push(`close ${sgn > 0 ? '-' : '+'} ${R('atrStopMult')} * atrVal`);
      if (value('stopLossPct')) parts.push(`close * (1 ${sgn > 0 ? '-' : '+'} ${R('stopLossPct')} / 100)`);
      return chain(parts);
    };
    const targetChain = (sgn, stopVar) => {
      const parts = [];
      if (sgn > 0 ? sig.longTarget : sig.shortTarget) parts.push(expr(sgn > 0 ? sig.longTarget : sig.shortTarget));
      if (value('rrTarget') && stopVar) {
        parts.push(`na(${stopVar}) ? na : close ${sgn > 0 ? '+' : '-'} ${R('rrTarget')} * math.abs(close - ${stopVar})`);
      }
      if (value('takeProfitPct')) parts.push(`close * (1 ${sgn > 0 ? '+' : '-'} ${R('takeProfitPct')} / 100)`);
      return chain(parts);
    };

    const trail = value('trailingStopPct');
    const beR = value('breakEvenR');
    const bars = value('maxBarsInTrade');

    const sideBlock = (long, hasExit) => {
      const tag = long ? 'l' : 's';
      const id = long ? 'L' : 'S';
      const sgn = long ? 1 : -1;
      const stop = stopChain(sgn);
      const target = targetChain(sgn, stop || trail || beR ? `${tag}Stop` : null);
      const movesStop = !!(stop || trail || beR);
      const held = long ? 'strategy.position_size > 0' : 'strategy.position_size < 0';
      const mathDir = long ? 'max' : 'min';

      const vars = [];
      if (beR) vars.push(`var float ${tag}Entry = na`);
      if (bars) vars.push(`var int ${tag}Bar = na`);
      if (movesStop) vars.push(`var float ${tag}Stop = na`);
      if (target) vars.push(`var float ${tag}Target = na`);
      if (trail) vars.push(`var float ${tag}Peak = na`);
      if (beR) vars.push(`var float ${tag}Risk = na`);

      const onEntry = [`strategy.entry(${str(id)}, strategy.${long ? 'long' : 'short'})`];
      if (beR) onEntry.push(`${tag}Entry := close`);
      if (bars) onEntry.push(`${tag}Bar := bar_index`);
      if (movesStop) onEntry.push(`${tag}Stop := ${stop || 'na'}`);
      if (target) onEntry.push(`${tag}Target := ${target}`);
      if (trail) onEntry.push(`${tag}Peak := close`);
      if (beR) onEntry.push(`${tag}Risk := na(${tag}Stop) ? na : math.abs(close - ${tag}Stop)`);

      const whileHeld = [];
      if (trail) {
        const extreme = long ? 'high' : 'low';
        whileHeld.push(`${tag}Peak := math.${mathDir}(nz(${tag}Peak, ${extreme}), ${extreme})`);
        whileHeld.push(`${tag}Trail = ${tag}Peak * (1 ${long ? '-' : '+'} ${R('trailingStopPct')} / 100)`);
        whileHeld.push(`${tag}Stop := na(${tag}Stop) ? ${tag}Trail : math.${mathDir}(${tag}Stop, ${tag}Trail)`);
      }
      if (beR) {
        const progress = long ? `high - ${tag}Entry` : `${tag}Entry - low`;
        whileHeld.push(`if not na(${tag}Risk) and ${progress} >= ${R('breakEvenR')} * ${tag}Risk`);
        whileHeld.push(indent(`${tag}Stop := na(${tag}Stop) ? ${tag}Entry : math.${mathDir}(${tag}Stop, ${tag}Entry)`));
      }
      if (movesStop || target) {
        const args = [];
        if (movesStop) args.push(`stop=${tag}Stop`);
        if (target) args.push(`limit=${tag}Target`);
        const guard = [movesStop ? `not na(${tag}Stop)` : null, target ? `not na(${tag}Target)` : null].filter(Boolean).join(' or ');
        whileHeld.push(`if ${guard}`);
        whileHeld.push(indent(`strategy.exit(${str(id + 'X')}, from_entry=${str(id)}, ${args.join(', ')})`));
      }
      if (bars) {
        whileHeld.push(`if not na(${tag}Bar) and bar_index - ${tag}Bar >= ${R('maxBarsInTrade')}`);
        whileHeld.push(indent(`strategy.close(${str(id)})`));
      }

      const out = vars.slice();
      out.push(`if ${long ? 'longEntry' : 'shortEntry'}`);
      out.push(indent(onEntry.join('\n')));
      if (whileHeld.length) {
        out.push(`if ${held}`);
        out.push(indent(whileHeld.join('\n')));
      }
      if (hasExit) {
        out.push(`if ${long ? 'longExit' : 'shortExit'} and ${held}`);
        out.push(indent(`strategy.close(${str(id)})`));
      }
      return out.join('\n');
    };

    // Built before the inputs are written out, because a block only creates
    // the setting inputs it actually uses.
    const longBlock = hasLong ? sideBlock(true, hasLongExit) : '';
    const shortBlock = hasShort ? sideBlock(false, hasShortExit) : '';

    // ---- assemble
    const out = [];
    const W = (line) => out.push(line);
    W('//@version=6');
    W(
      `strategy(${str(compiled.name)}, overlay=true, pyramiding=1, process_orders_on_close=true, ` +
        'commission_type=strategy.commission.percent, commission_value=0.05, ' +
        `initial_capital=${num(value('capital') || 10000)}, ` +
        'default_qty_type=strategy.percent_of_equity, default_qty_value=100, margin_long=100, margin_short=100)'
    );
    W('');
    W('// Generated by VWAP Lab from the strategy and the execution settings in the app.');
    W('');
    if (compiled.params.length) {
      W('// --- parameters');
      for (const pr of compiled.params) W(paramInput(pr, params[pr.key]));
      W('');
    }
    if (settingLines.length) {
      W('// --- stops, targets and filters');
      for (const line of settingLines) W(line);
      W('');
    }
    if (sig.body && String(sig.body).trim()) {
      W('// --- signals');
      W(String(sig.body).trim());
      W('');
    }
    if (riskLines.length) {
      for (const line of riskLines) W(line);
      W('');
    }
    W('// --- entries and exits');
    for (const line of signalLines) W(line);
    W('');
    if (longBlock) {
      W('// --- long side');
      W(longBlock);
      W('');
    }
    if (shortBlock) {
      W('// --- short side');
      W(shortBlock);
      W('');
    }
    const plots = Array.isArray(sig.plots) ? sig.plots : [];
    if (plots.length) {
      W('// --- plots');
      for (const pl of plots) {
        if (!pl || !pl.expr) continue;
        W(`plot(${pl.expr}, title=${str(pl.title || 'Series')})`);
      }
      W('');
    }
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  }

  /**
   * Everything the optimizer can sweep: the strategy's numeric parameters
   * and whichever stops, targets and filters are switched on. The name is
   * the Pine input name, which is how Trader.dev addresses them.
   */
  function sweepable(compiled, settings) {
    const s = settings || {};
    const out = [];
    for (const pr of compiled.params) {
      if (pr.type === 'number') out.push({ name: inputName(pr.key), label: pr.label, min: pr.min, max: pr.max, step: pr.step, group: 'Strategy parameters' });
    }
    const limits = {
      stopLossPct: [0.5, 10, 0.5],
      atrStopMult: [0.5, 5, 0.5],
      atrLength: [5, 40, 5],
      takeProfitPct: [0.5, 10, 0.5],
      rrTarget: [0.5, 5, 0.5],
      trailingStopPct: [0.5, 10, 0.5],
      breakEvenR: [0.5, 3, 0.5],
      maxBarsInTrade: [5, 100, 5],
      trendFilterLength: [20, 300, 20],
    };
    for (const key of Object.keys(SETTING_INPUTS)) {
      const v = Number(s[key]);
      if (!(Number.isFinite(v) && v > 0)) continue; // only what the script exposes
      if (key === 'atrLength' && !(Number(s.atrStopMult) > 0)) continue;
      const [min, max, step] = limits[key];
      out.push({ name: settingInputName(key), label: SETTING_INPUTS[key][0], min, max, step, group: 'Stops, targets and filters' });
    }
    return out;
  }

  BT.pine = { build, sweepable, inputName, settingInputName, SUPPORTED, SETTING_INPUTS, PARAM_PREFIX, SETTING_PREFIX };
})(typeof window !== 'undefined' ? window : globalThis);
