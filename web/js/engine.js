/*
 * Backtest engine: compiles strategy code and simulates it bar by bar.
 *
 * Execution model (no look-ahead):
 *   - onBar(ctx) runs after bar i closes.
 *   - Orders fill at the NEXT bar's open by default ("next open"),
 *     or at this bar's close when settings.fillOn === 'close' or the
 *     order passes { atClose: true }.
 *   - Stops / targets are checked against each bar's high/low. If a bar
 *     gaps through a level the fill is the open. If stop and target are
 *     both inside one bar, the stop is assumed to hit first.
 *   - One position at a time. long() while short reverses; no pyramiding.
 */
(function (root) {
  'use strict';
  const BT = (root.BT = root.BT || {});
  const ta = () => BT.ta;

  const DEFAULT_SETTINGS = {
    capital: 10000,
    sizePct: 100, // % of equity per trade (with risk sizing: the most a single position may use)
    sizing: 'equity', // 'equity' (sizePct of equity) | 'risk' (lose riskPct of equity if the stop hits)
    riskPct: 1,
    commissionPct: 0.02, // per side, % of traded value
    slippagePct: 0.01, // per side, % of price, always against you
    fillOn: 'open', // 'open' (next bar open) | 'close' (signal bar close)
    allowShorts: true,
    // stops & targets (0 = off). Priority: the strategy's own stop/target, then these.
    stopLossPct: 0,
    atrStopMult: 0, // stop = entry -/+ mult * ATR (wins over stopLossPct)
    atrLength: 14,
    takeProfitPct: 0,
    rrTarget: 0, // target = entry +/- rrTarget * initial risk (wins over takeProfitPct)
    trailingStopPct: 0,
    breakEvenR: 0, // move the stop to entry once the trade is this many R in profit
    maxBarsInTrade: 0, // time stop
    flatAtSessionEnd: false,
    // entry filters (exits are never blocked)
    entryStart: '', // 'HH:MM' exchange time, intraday data only
    entryEnd: '',
    trendFilterLength: 0, // longs only above the N-bar SMA, shorts only below
    maxTradesPerDay: 0,
    dailyLossPct: 0, // flatten and stop for the day after losing this % of the day's starting equity
  };

  // 'HH:MM' -> minutes after midnight, or null
  function parseClock(v) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || '').trim());
    return m && +m[1] < 24 && +m[2] < 60 ? +m[1] * 60 + +m[2] : null;
  }

  // ---------------------------------------------------------------- compile

  let lineOffset = null;
  function getLineOffset() {
    if (lineOffset !== null) return lineOffset;
    try {
      new Function('ta', 'BT', '"use strict";throw new Error("probe")\n//# sourceURL=probe.js')();
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
   * Turn strategy source into { name, description, params, setup, onBar }.
   * The file may use `export default { ... }` or a bare `return { ... }`.
   */
  function compile(code) {
    // swap `export default` for `return` without touching line breaks, so error line numbers match the editor
    const body = String(code).replace(/^([ \t]*)export[ \t]+default\b/m, '$1return');
    let factory;
    try {
      factory = new Function('ta', 'BT', '"use strict";' + body + '\n//# sourceURL=strategy.js');
    } catch (e) {
      const err = new Error(`Syntax error: ${e.message}`);
      err.line = errorLine(e);
      throw err;
    }
    let def;
    try {
      def = factory(BT.ta, BT);
    } catch (e) {
      const err = new Error(`Error while loading strategy: ${e.message}`);
      err.line = errorLine(e);
      throw err;
    }
    if (!def || typeof def !== 'object') {
      throw new Error('The strategy must export an object: export default { name, params, setup, onBar }');
    }
    if (typeof def.onBar !== 'function') throw new Error('The strategy needs an onBar(ctx) function.');
    if (def.setup !== undefined && typeof def.setup !== 'function') throw new Error('setup must be a function.');
    const params = Object.entries(def.params || {}).map(([k, v]) => normalizeParam(k, v));
    return {
      name: String(def.name || 'Untitled strategy'),
      description: String(def.description || ''),
      params,
      setup: def.setup || (() => ({})),
      onBar: def.onBar,
    };
  }

  function defaultParams(compiled) {
    const out = {};
    for (const p of compiled.params) out[p.key] = p.value;
    return out;
  }

  // ---------------------------------------------------------------- run

  function sliceData(data, from, to) {
    const keys = ['time', 'open', 'high', 'low', 'close', 'volume'];
    const out = Object.assign({}, data);
    for (const k of keys) out[k] = data[k].slice(from, to);
    out.length = out.time.length;
    return out;
  }

  function run(data, compiled, paramValues, userSettings) {
    const s = Object.assign({}, DEFAULT_SETTINGS, userSettings || {});
    const n = data.length;
    if (!n || n < 2) throw new Error('Need at least 2 bars of data to run a backtest.');
    const params = Object.assign(defaultParams(compiled), paramValues || {});
    const { time, open, high, low, close } = data;

    const plots = [];
    const plot = (name, series, opts) => {
      if (!series || typeof series.length !== 'number') throw new Error(`plot("${name}") needs an array of values`);
      plots.push(Object.assign({ name: String(name), series, pane: 'price', style: 'line' }, opts || {}));
    };

    let ind;
    try {
      ind = compiled.setup({ data, params, ta: BT.ta, plot, settings: s }) || {};
    } catch (e) {
      const err = new Error(`setup() failed: ${e.message}`);
      err.line = errorLine(e);
      throw err;
    }

    const sessStart = ta().sessionStart(data);
    const sessEnd = ta().sessionEnd(data);
    const sessBar = ta().sessionBar(data);
    const dayId = ta().anchorIds(data, 'session');
    const intraday = sessStart.some((x, i) => i > 0 && !x);
    const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
    const atr = num(s.atrStopMult) > 0 ? ta().atr(data, Math.max(1, Math.round(num(s.atrLength)) || 14)) : null;
    const trendSma = num(s.trendFilterLength) > 0 ? ta().sma(close, Math.round(num(s.trendFilterLength))) : null;
    const winStart = parseClock(s.entryStart);
    const winEnd = parseClock(s.entryEnd);
    const useWindow = intraday && (winStart !== null || winEnd !== null);

    const equity = new Array(n);
    const exposure = new Array(n).fill(0);
    const trades = [];
    const markers = [];
    const logs = [];
    const skipped = { hours: 0, trend: 0, maxTrades: 0, dailyLoss: 0 };
    let cash = s.capital; // realized equity
    let pos = null;
    let pending = null;
    let commissionPaid = 0;
    let entriesDay = null;
    let entriesToday = 0;
    let dayStartEquity = s.capital;
    let haltedDay = null;
    const commRate = s.commissionPct / 100;
    const slipRate = s.slippagePct / 100;
    const pct = (v) => (v > 0 ? v / 100 : 0);

    function inWindow(i) {
      const m = Math.floor((((time[i] % 86400) + 86400) % 86400) / 60);
      const a = winStart === null ? 0 : winStart;
      const b = winEnd === null ? 24 * 60 : winEnd;
      return a <= b ? m >= a && m <= b : m >= a || m <= b; // a > b: window runs past midnight
    }

    // Why a new entry is not allowed (or null). fillIdx: bar it would fill on, sigIdx: signal bar.
    function entryBlock(side, fillIdx, sigIdx) {
      if (useWindow && !inWindow(fillIdx)) return 'hours';
      if (trendSma) {
        const v = trendSma[sigIdx];
        if (!Number.isFinite(v) || (side > 0 ? close[sigIdx] <= v : close[sigIdx] >= v)) return 'trend';
      }
      if (haltedDay !== null && dayId[fillIdx] === haltedDay) return 'dailyLoss';
      if (s.maxTradesPerDay > 0 && entriesDay === dayId[fillIdx] && entriesToday >= s.maxTradesPerDay) return 'maxTrades';
      return null;
    }

    function enter(side, rawPrice, i, opts, viaReverse, sigIdx) {
      const fill = rawPrice * (1 + side * slipRate);
      const eq = cash;
      // stop: strategy's own > ATR > %
      let stop = opts.stop !== undefined && Number.isFinite(opts.stop) ? opts.stop : null;
      if (stop === null && atr && atr[sigIdx] > 0) stop = fill - side * s.atrStopMult * atr[sigIdx];
      if (stop === null && s.stopLossPct > 0) stop = fill * (1 - side * pct(s.stopLossPct));
      const riskPerUnit = stop !== null && side * (fill - stop) > 0 ? side * (fill - stop) : null;
      // target: strategy's own > reward:risk > %
      let target = opts.target !== undefined && Number.isFinite(opts.target) ? opts.target : null;
      if (target === null && s.rrTarget > 0 && riskPerUnit) target = fill + side * s.rrTarget * riskPerUnit;
      if (target === null && s.takeProfitPct > 0) target = fill * (1 + side * pct(s.takeProfitPct));
      // size
      const maxQty = (eq * (opts.size !== undefined ? opts.size * 100 : s.sizePct)) / 100 / fill;
      let qty = maxQty;
      if (opts.size === undefined && s.sizing === 'risk' && riskPerUnit) qty = Math.min((eq * pct(s.riskPct)) / riskPerUnit, maxQty);
      if (!(qty > 0)) return;
      const comm = qty * fill * commRate;
      cash -= comm;
      commissionPaid += comm;
      if (entriesDay !== dayId[i]) {
        entriesDay = dayId[i];
        entriesToday = 0;
      }
      entriesToday++;
      pos = {
        side,
        qty,
        entryPrice: fill,
        entryIndex: i,
        entryTime: time[i],
        entryComm: comm,
        stop,
        stopKind: 'initial',
        target,
        riskPerUnit,
        trail: opts.trail !== undefined ? pct(opts.trail) : pct(s.trailingStopPct),
        extreme: fill, // best price so far (trailing stop, MFE)
        worst: fill, // worst price so far (MAE)
        label: opts.label || (viaReverse ? 'Reverse' : side > 0 ? 'Long' : 'Short'),
        checkFrom: i,
      };
      markers.push({ index: i, kind: side > 0 ? 'long' : 'short', price: fill, label: pos.label });
    }

    function exitPosition(rawPrice, i, reason) {
      if (!pos) return;
      const side = pos.side;
      const fill = rawPrice * (1 - side * slipRate);
      const gross = side * pos.qty * (fill - pos.entryPrice);
      const comm = pos.qty * fill * commRate;
      commissionPaid += comm;
      cash += gross - comm;
      const pnl = gross - comm - pos.entryComm;
      // excursions include the exit price itself, never the part of a bar after the exit
      const best = side > 0 ? Math.max(pos.extreme, rawPrice) : Math.min(pos.extreme, rawPrice);
      const worst = side > 0 ? Math.min(pos.worst, rawPrice) : Math.max(pos.worst, rawPrice);
      const r = pos.riskPerUnit;
      trades.push({
        side: side > 0 ? 'long' : 'short',
        entryIndex: pos.entryIndex,
        exitIndex: i,
        entryTime: pos.entryTime,
        exitTime: time[i],
        entryPrice: pos.entryPrice,
        exitPrice: fill,
        qty: pos.qty,
        pnl,
        returnPct: (pnl / (pos.qty * pos.entryPrice)) * 100,
        bars: i - pos.entryIndex,
        entryReason: pos.label,
        exitReason: reason,
        mfePct: side * (best / pos.entryPrice - 1) * 100,
        maePct: side * (worst / pos.entryPrice - 1) * 100,
        risk: r ? r * pos.qty : null, // $ lost if the initial stop had been hit
        rMultiple: r ? pnl / (r * pos.qty) : null,
        mfeR: r ? (side * (best - pos.entryPrice)) / r : null,
        maeR: r ? (side * (worst - pos.entryPrice)) / r : null,
      });
      markers.push({ index: i, kind: 'exit', price: fill, label: reason, pnl });
      pos = null;
    }

    function execute(order, price, i) {
      if (order.type === 'exit') {
        if (pos) exitPosition(price, i, order.reason || 'Exit');
        return;
      }
      const side = order.type === 'long' ? 1 : -1;
      if (pos && pos.side === side) return; // already in that direction
      let willEnter = side > 0 || s.allowShorts; // long-only: a short signal just closes the long
      if (willEnter) {
        const why = entryBlock(side, i, order.i);
        if (why) {
          skipped[why]++;
          willEnter = false;
        }
      }
      const reversing = !!pos;
      if (pos) exitPosition(price, i, willEnter ? 'Reverse' : order.opts.label || (side < 0 ? 'Sell signal' : 'Buy signal'));
      if (willEnter) enter(side, price, i, order.opts, reversing, order.i);
    }

    // Stop / target / trailing checks inside bar i.
    function checkExits(i) {
      if (!pos || i < pos.checkFrom) return;
      const L = pos.side > 0;
      let stop = pos.stop;
      let stopReason = { initial: 'Stop loss', breakeven: 'Break-even stop', manual: 'Stop loss' }[pos.stopKind];
      if (pos.trail > 0) {
        const t = L ? pos.extreme * (1 - pos.trail) : pos.extreme * (1 + pos.trail);
        if (stop === null || (L ? t > stop : t < stop)) {
          stop = t;
          stopReason = 'Trailing stop';
        }
      }
      const tgt = pos.target;
      const o = open[i];
      const stopHit = stop !== null && (L ? low[i] <= stop : high[i] >= stop);
      const tgtHit = tgt !== null && (L ? high[i] >= tgt : low[i] <= tgt);
      if (tgtHit && (L ? o >= tgt : o <= tgt)) return exitPosition(o, i, 'Take profit');
      if (stopHit) return exitPosition(L ? Math.min(o, stop) : Math.max(o, stop), i, stopReason);
      if (tgtHit) return exitPosition(tgt, i, 'Take profit');
    }

    // After bar i has been held to its close: update excursions, then break-even.
    function trackBar(i) {
      if (!pos || i < pos.checkFrom) return;
      if (pos.side > 0) {
        pos.extreme = Math.max(pos.extreme, high[i]);
        pos.worst = Math.min(pos.worst, low[i]);
      } else {
        pos.extreme = Math.min(pos.extreme, low[i]);
        pos.worst = Math.max(pos.worst, high[i]);
      }
      if (s.breakEvenR > 0 && pos.riskPerUnit && pos.stopKind !== 'breakeven') {
        if (pos.side * (pos.extreme - pos.entryPrice) >= s.breakEvenR * pos.riskPerUnit) {
          const be = pos.entryPrice;
          if (pos.stop === null || (pos.side > 0 ? be > pos.stop : be < pos.stop)) {
            pos.stop = be;
            pos.stopKind = 'breakeven';
          }
        }
      }
    }

    // ---- the per-bar context handed to onBar ----
    const position = { side: 'flat', qty: 0, entryPrice: NaN, entryIndex: -1, entryTime: null, barsHeld: 0, pnlPct: 0, stop: null, target: null, risk: null };
    const ctx = {
      data, ind, params, ta: BT.ta, settings: s,
      i: 0, time: 0, open: 0, high: 0, low: 0, close: 0, volume: 0,
      bar: null, position,
      isFlat: true, isLong: false, isShort: false,
      equity: s.capital, cash: s.capital,
      newSession: false, lastBarOfSession: false, sessionBar: 0,
      hour: 0, minute: 0, dayOfWeek: 0,
      long(opts) { pending = { type: 'long', opts: opts || {}, i: ctx.i }; },
      short(opts) { pending = { type: 'short', opts: opts || {}, i: ctx.i }; },
      exit(opts) {
        const o = typeof opts === 'string' ? { reason: opts } : opts || {};
        pending = { type: 'exit', reason: o.reason || o.label || 'Exit signal', opts: o, i: ctx.i };
      },
      cancel() { pending = null; },
      setStop(price) {
        if (!pos) return;
        pos.stop = Number.isFinite(price) ? price : null;
        pos.stopKind = 'manual';
      },
      setTarget(price) { if (pos) pos.target = Number.isFinite(price) ? price : null; },
      crossOver: (a, b) => BT.ta.crossover(a, b, ctx.i),
      crossUnder: (a, b) => BT.ta.crossunder(a, b, ctx.i),
      prev: (series, k = 1) => series[ctx.i - k],
      log: (...args) => { if (logs.length < 500) logs.push({ index: ctx.i, text: args.map(String).join(' ') }); },
    };

    function syncCtx(i) {
      ctx.i = i;
      ctx.time = time[i];
      ctx.open = open[i];
      ctx.high = high[i];
      ctx.low = low[i];
      ctx.close = close[i];
      ctx.volume = data.volume[i];
      ctx.bar = { time: time[i], open: open[i], high: high[i], low: low[i], close: close[i], volume: data.volume[i] };
      ctx.newSession = sessStart[i];
      ctx.lastBarOfSession = sessEnd[i];
      ctx.sessionBar = sessBar[i];
      const secOfDay = ((time[i] % 86400) + 86400) % 86400;
      ctx.hour = Math.floor(secOfDay / 3600);
      ctx.minute = Math.floor((secOfDay % 3600) / 60);
      ctx.dayOfWeek = (Math.floor(time[i] / 86400) + 4) % 7; // 0 = Sunday
      const unreal = pos ? pos.side * pos.qty * (close[i] - pos.entryPrice) : 0;
      ctx.cash = cash;
      ctx.equity = cash + unreal;
      ctx.isFlat = !pos;
      ctx.isLong = !!pos && pos.side > 0;
      ctx.isShort = !!pos && pos.side < 0;
      position.side = pos ? (pos.side > 0 ? 'long' : 'short') : 'flat';
      position.qty = pos ? pos.qty : 0;
      position.entryPrice = pos ? pos.entryPrice : NaN;
      position.entryIndex = pos ? pos.entryIndex : -1;
      position.entryTime = pos ? pos.entryTime : null;
      position.barsHeld = pos ? i - pos.entryIndex : 0;
      position.pnlPct = pos ? (pos.side * (close[i] / pos.entryPrice - 1)) * 100 : 0;
      position.stop = pos ? pos.stop : null;
      position.target = pos ? pos.target : null;
      position.risk = pos && pos.riskPerUnit ? pos.riskPerUnit : null;
    }

    for (let i = 0; i < n; i++) {
      if (sessStart[i] && i > 0) dayStartEquity = equity[i - 1];
      // 1. orders from the previous bar fill at this bar's open
      if (pending && pending.i < i) {
        const order = pending;
        pending = null;
        execute(order, open[i], i);
      }
      // 2. protective exits inside this bar
      checkExits(i);
      trackBar(i);

      // 3. strategy logic on the closed bar
      syncCtx(i);
      if (i < n - 1) {
        try {
          compiled.onBar(ctx);
        } catch (e) {
          const err = new Error(`onBar() failed on bar ${i} (${BT.fmt ? BT.fmt.time(time[i], data) : time[i]}): ${e.message}`);
          err.line = errorLine(e);
          throw err;
        }
      }

      // 4. same-bar fills and end-of-bar rules
      if (pending && (s.fillOn === 'close' || pending.opts.atClose)) {
        const order = pending;
        pending = null;
        execute(order, close[i], i);
        if (pos && pos.entryIndex === i) pos.checkFrom = i + 1;
      }
      if (i < n - 1) {
        if (pos && s.maxBarsInTrade > 0 && i - pos.entryIndex >= s.maxBarsInTrade) exitPosition(close[i], i, 'Time stop');
        if (s.flatAtSessionEnd && intraday && sessEnd[i]) {
          if (pos) exitPosition(close[i], i, 'Session end');
          if (pending && pending.type !== 'exit') pending = null;
        }
        if (s.dailyLossPct > 0 && haltedDay !== dayId[i]) {
          const eqNow = cash + (pos ? pos.side * pos.qty * (close[i] - pos.entryPrice) : 0);
          if (eqNow <= dayStartEquity * (1 - pct(s.dailyLossPct))) {
            if (pos) exitPosition(close[i], i, 'Daily loss limit');
            haltedDay = dayId[i];
          }
        }
      }

      // 5. mark to market
      exposure[i] = pos ? pos.side : 0;
      equity[i] = cash + (pos ? pos.side * pos.qty * (close[i] - pos.entryPrice) : 0);
    }
    if (pos) {
      exitPosition(close[n - 1], n - 1, 'End of data');
      equity[n - 1] = cash;
    }

    const buyHold = close.map((c) => (s.capital * c) / close[0]);
    const result = {
      data, params, settings: s, ind, plots, trades, markers, logs,
      equity, buyHold, exposure, commissionPaid, skipped,
    };
    result.metrics = BT.metrics.compute(result);
    return result;
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

  // Runs once. Compute indicators here and return them.
  setup({ data, params, ta, plot }) {
    const fast = ta.ema(data.close, params.fast);
    const slow = ta.ema(data.close, params.slow);
    plot('Fast EMA', fast);
    plot('Slow EMA', slow);
    return { fast, slow };
  },

  // Runs after every bar closes. Orders fill at the next bar's open.
  onBar(ctx) {
    const { ind } = ctx;
    if (ctx.crossOver(ind.fast, ind.slow)) ctx.long();
    if (ctx.crossUnder(ind.fast, ind.slow)) ctx.exit('EMA cross down');
  },
};
`;

  BT.engine = { compile, run, defaultParams, sliceData, errorLine, parseClock, DEFAULT_SETTINGS, TEMPLATE };
})(typeof window !== 'undefined' ? window : globalThis);
