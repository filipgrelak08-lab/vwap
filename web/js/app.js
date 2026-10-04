/*
 * UI controller: wires the sidebar, results tabs, optimizer and code editor
 * to the engine. Works in two modes:
 *   - local server (python3 server.py): strategies are files in strategies/,
 *     live data comes from Yahoo Finance / Binance through the server.
 *   - standalone preview (no server): bundled strategies, browser storage,
 *     sample and CSV data only.
 */
(function () {
  'use strict';
  const BT = window.BT;
  const f = BT.fmt;
  const $ = (id) => document.getElementById(id);
  const PREVIEW = window.BT_PREVIEW === true;
  const STORE_KEY = 'vwaplab:v1';
  const DRAFT_KEY = 'vwaplab:drafts';
  const LOCAL_STRATS_KEY = 'vwaplab:strategies';
  const DEFAULT_STRATEGY = 'vwap_band_reversion';

  // ---------------------------------------------------------------- storage (best effort)

  const store = {
    get(key, fallback) {
      try {
        const raw = window.localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
      } catch (e) {
        return fallback;
      }
    },
    set(key, value) {
      try {
        window.localStorage.setItem(key, JSON.stringify(value));
      } catch (e) {
        /* storage unavailable: settings just won't persist */
      }
    },
  };

  const debounce = (fn, ms) => {
    let t = null;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  };

  // ---------------------------------------------------------------- state

  const saved = store.get(STORE_KEY, {});
  const state = {
    server: false,
    strategies: [], // { id, code, origin: 'file' | 'bundled' | 'local' | 'new' }
    drafts: store.get(DRAFT_KEY, {}),
    strategyId: saved.strategyId || DEFAULT_STRATEGY,
    params: saved.params || {},
    settings: Object.assign({}, BT.engine.DEFAULT_SETTINGS, saved.settings || {}),
    source: saved.source || 'sample',
    sampleKey: saved.sampleKey || 'intraday',
    dataset: null, // as loaded
    data: null, // after the date filter
    result: null,
    compiled: null,
    compileCache: { code: null, compiled: null },
    autoRun: saved.autoRun !== false,
    lastError: null,
    opt: null,
  };

  function persist() {
    store.set(STORE_KEY, {
      strategyId: state.strategyId,
      params: state.params,
      settings: state.settings,
      source: state.source,
      sampleKey: state.sampleKey,
      autoRun: state.autoRun,
      yahoo: { symbol: $('yahooSymbol').value, interval: $('yahooInterval').value, range: $('yahooRange').value, adjusted: $('yahooAdjusted').checked },
      binance: { symbol: $('binanceSymbol').value, interval: $('binanceInterval').value, bars: $('binanceBars').value },
      theme: saved.theme,
    });
  }
  const persistSoon = debounce(persist, 300);
  const persistDrafts = debounce(() => store.set(DRAFT_KEY, state.drafts), 400);

  // ---------------------------------------------------------------- environment

  async function detectServer() {
    if (PREVIEW || location.protocol === 'file:') return false;
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 1500);
      const res = await fetch('api/health', { signal: ctl.signal });
      clearTimeout(timer);
      if (!res.ok) return false;
      const body = await res.json();
      return !!(body && body.ok);
    } catch (e) {
      return false;
    }
  }

  function renderEnv() {
    const b = $('envBadge');
    if (state.server) {
      b.dataset.state = 'server';
      b.textContent = 'Local server';
      b.title = 'Strategies are saved to the strategies/ folder. Live data available.';
    } else {
      b.dataset.state = 'preview';
      b.textContent = PREVIEW ? 'Preview · sample and CSV data' : 'Offline · sample and CSV data';
      b.title = 'Run python3 server.py for live data and saving strategies to files.';
    }
    for (const id of ['yahooSymbol', 'yahooInterval', 'yahooRange', 'yahooAdjusted', 'yahooLoad', 'binanceSymbol', 'binanceInterval', 'binanceBars', 'binanceLoad']) {
      $(id).disabled = !state.server;
    }
    document.querySelectorAll('.server-only').forEach((n) => (n.hidden = state.server));
    $('exportTradesBtn').hidden = PREVIEW;
    $('themeToggle').hidden = PREVIEW;
  }

  // ---------------------------------------------------------------- strategies

  async function loadStrategies() {
    let list = [];
    if (state.server) {
      const body = await BT.data.getJSON('api/strategies');
      list = body.strategies.map((s) => ({ id: s.id, code: s.code, origin: 'file' }));
    } else {
      list = (window.BT_BUNDLED_STRATEGIES || []).map((s) => ({ id: s.id, code: s.code, origin: 'bundled' }));
      const local = store.get(LOCAL_STRATS_KEY, {});
      for (const [id, code] of Object.entries(local)) {
        const existing = list.find((s) => s.id === id);
        if (existing) {
          existing.code = code;
          existing.origin = 'local';
          existing.bundledCode = (window.BT_BUNDLED_STRATEGIES || []).find((s) => s.id === id).code;
        } else list.push({ id, code, origin: 'local' });
      }
    }
    state.strategies = list;
  }

  const currentRec = () => state.strategies.find((s) => s.id === state.strategyId) || state.strategies[0];
  const codeOf = (rec) => (rec && state.drafts[rec.id] !== undefined ? state.drafts[rec.id] : rec ? rec.code : '');
  const isDirty = (rec) => !!rec && (rec.origin === 'new' || (state.drafts[rec.id] !== undefined && state.drafts[rec.id] !== rec.code));

  function nameOf(rec) {
    try {
      return compileCached(codeOf(rec)).name;
    } catch (e) {
      return `${rec.id} (has errors)`;
    }
  }

  function compileCached(code) {
    if (state.compileCache.code === code) return state.compileCache.compiled;
    const compiled = BT.engine.compile(code);
    state.compileCache = { code, compiled };
    return compiled;
  }

  function renderStrategySelect() {
    const sel = $('strategySelect');
    sel.textContent = '';
    const names = state.strategies.map((r) => ({ rec: r, name: nameOf(r) }));
    const counts = {};
    names.forEach((n) => (counts[n.name] = (counts[n.name] || 0) + 1));
    names.sort((a, b) => a.name.localeCompare(b.name));
    for (const { rec, name } of names) {
      const opt = document.createElement('option');
      opt.value = rec.id;
      opt.textContent = (isDirty(rec) ? '● ' : '') + (counts[name] > 1 ? `${name} (${rec.id})` : name);
      sel.appendChild(opt);
    }
    sel.value = currentRec() ? currentRec().id : '';
  }

  function paramsFor(id, compiled) {
    const stored = state.params[id] || {};
    const out = {};
    for (const p of compiled.params) {
      let v = stored[p.key];
      if (p.type === 'number') v = Number.isFinite(Number(v)) && v !== '' && v !== null && v !== undefined ? Number(v) : p.value;
      else if (p.type === 'bool') v = typeof v === 'boolean' ? v : p.value;
      else if (p.type === 'select') v = p.options.includes(v) ? v : p.value;
      out[p.key] = v;
    }
    return out;
  }

  function setParam(key, value) {
    const id = state.strategyId;
    state.params[id] = Object.assign({}, state.params[id], { [key]: value });
    persistSoon();
    scheduleRun();
  }

  function renderParams() {
    const box = $('paramsForm');
    box.textContent = '';
    const rec = currentRec();
    let compiled;
    try {
      compiled = compileCached(codeOf(rec));
    } catch (e) {
      $('strategyDesc').textContent = 'This strategy has an error. Open the Code tab to fix it.';
      return;
    }
    $('strategyDesc').textContent = compiled.description;
    const values = paramsFor(rec.id, compiled);
    for (const p of compiled.params) {
      const row = document.createElement('div');
      const id = `param-${p.key}`;
      if (p.type === 'bool') {
        row.className = 'param bool';
        const label = document.createElement('label');
        label.className = 'check';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.id = id;
        cb.checked = values[p.key];
        cb.addEventListener('change', () => setParam(p.key, cb.checked));
        label.append(cb, document.createTextNode(p.label));
        row.appendChild(label);
      } else if (p.type === 'select') {
        row.className = 'param select';
        const label = document.createElement('label');
        label.htmlFor = id;
        label.textContent = p.label;
        const sel = document.createElement('select');
        sel.id = id;
        for (const o of p.options) {
          const opt = document.createElement('option');
          opt.value = o;
          opt.textContent = o;
          sel.appendChild(opt);
        }
        sel.value = values[p.key];
        sel.addEventListener('change', () => setParam(p.key, sel.value));
        row.append(label, sel);
      } else {
        row.className = 'param';
        const label = document.createElement('label');
        label.htmlFor = id;
        label.textContent = p.label;
        const num = document.createElement('input');
        num.type = 'number';
        num.id = id;
        num.step = p.step;
        num.value = values[p.key];
        const range = document.createElement('input');
        range.type = 'range';
        range.id = `${id}-range`;
        range.min = p.min;
        range.max = p.max;
        range.step = p.step;
        range.value = values[p.key];
        range.setAttribute('aria-label', p.label);
        num.addEventListener('input', () => {
          const v = Number(num.value);
          if (num.value === '' || !Number.isFinite(v)) return;
          range.value = v;
          setParam(p.key, v);
        });
        range.addEventListener('input', () => {
          num.value = range.value;
          setParam(p.key, Number(range.value));
        });
        row.append(label, num, range);
      }
      box.appendChild(row);
    }
    if (!compiled.params.length) {
      const p = document.createElement('p');
      p.className = 'hint';
      p.textContent = 'This strategy has no parameters.';
      box.appendChild(p);
    }
  }

  function selectStrategy(id) {
    state.strategyId = id;
    persistSoon();
    renderStrategySelect();
    renderParams();
    openInEditor();
    setupOptimizer();
    runBacktest();
  }

  // ---------------------------------------------------------------- data

  function setLoadStatus(text, isError) {
    const el = $('loadStatus');
    el.textContent = text || '';
    el.classList.toggle('error', !!isError);
  }

  function setDataset(data) {
    state.dataset = data;
    const first = f.date(data.time[0]);
    const last = f.date(data.time[data.length - 1]);
    for (const id of ['rangeFrom', 'rangeTo']) {
      $(id).min = first;
      $(id).max = last;
      $(id).value = '';
    }
    applyRange();
    const skipped = data.skippedRows ? ` Skipped ${data.skippedRows} unreadable rows.` : '';
    setLoadStatus(`Loaded ${f.int(data.length)} bars, ${first} to ${last}.${skipped}`);
  }

  function applyRange() {
    if (!state.dataset) return;
    const data = BT.data.filterRange(state.dataset, $('rangeFrom').value, $('rangeTo').value);
    if (data.length < 2) {
      setLoadStatus('That date range contains fewer than 2 bars.', true);
      return;
    }
    state.data = data;
    renderDatasetChip();
    runBacktest();
  }

  function renderDatasetChip() {
    const d = state.data;
    $('chipSymbol').textContent = d.symbol;
    const label = d.synthetic ? 'synthetic' : d.source;
    $('chipMeta').textContent = `${d.interval} · ${f.int(d.length)} bars · ${f.date(d.time[0])} → ${f.date(d.time[d.length - 1])} · ${label}`;
  }

  async function loadWith(fn, label) {
    setLoadStatus(`Loading ${label}…`);
    try {
      const data = await fn();
      setDataset(data);
    } catch (e) {
      setLoadStatus(e.message, true);
    }
  }

  function loadSample(key) {
    state.sampleKey = key;
    persistSoon();
    setDataset(BT.data.sample(key));
  }

  function loadCsvFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        setDataset(BT.data.parseCSV(reader.result, file.name));
      } catch (e) {
        setLoadStatus(e.message, true);
      }
    };
    reader.onerror = () => setLoadStatus(`Could not read ${file.name}.`, true);
    reader.readAsText(file);
  }

  async function refreshServerCsvs() {
    if (!state.server) return;
    try {
      const files = await BT.data.listServerCSVs();
      const sel = $('serverCsvSelect');
      sel.textContent = '';
      for (const name of files) {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        sel.appendChild(opt);
      }
      $('serverCsvBox').hidden = !files.length;
    } catch (e) {
      $('serverCsvBox').hidden = true;
    }
  }

  function selectSource(src) {
    state.source = src;
    persistSoon();
    document.querySelectorAll('#sourceTabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.source === src)));
    document.querySelectorAll('.source-pane').forEach((p) => (p.hidden = p.dataset.pane !== src));
    if (src === 'csv') refreshServerCsvs();
  }

  // Open a strategy from the Library tab: select it with its tested parameters and load its data.
  async function runLocal(spec) {
    if (!state.strategies.some((s) => s.id === spec.strategy)) {
      setLoadStatus(`There is no strategies/${spec.strategy}.js to run.`, true);
      return;
    }
    state.params[spec.strategy] = Object.assign({}, spec.params || {});
    selectTab('chart');
    selectStrategy(spec.strategy);
    const d = spec.data;
    const embedded = d && window.BT_DATASETS && window.BT_DATASETS[`${d.symbol}|${d.interval}`];
    if (embedded && !state.server) {
      // a hosted or standalone build can carry the data the Library uses
      setDataset(BT.data.fromBars(embedded, { symbol: d.symbol, name: `${d.symbol} (built in)`, interval: d.interval, source: 'built in', timezone: 'UTC' }));
    } else if (d && d.source === 'yahoo' && state.server) {
      $('yahooSymbol').value = d.symbol;
      $('yahooInterval').value = d.interval;
      $('yahooRange').value = d.range;
      selectSource('yahoo');
      persist();
      await loadWith(() => BT.data.loadYahoo({ symbol: d.symbol, interval: d.interval, range: d.range, adjusted: $('yahooAdjusted').checked }), `${d.symbol} from Yahoo`);
    } else if (d) {
      setLoadStatus(`Tested on ${d.symbol} (${d.interval}). Load that data to compare; live data needs the local server.`);
    }
  }

  BT.app = { runLocal };

  // ---------------------------------------------------------------- settings

  const SETTING_IDS = [
    'capital', 'fillOn', 'commissionPct', 'slippagePct', 'allowShorts',
    'sizing', 'sizePct', 'riskPct',
    'stopLossPct', 'atrStopMult', 'atrLength', 'takeProfitPct', 'rrTarget', 'trailingStopPct', 'breakEvenR', 'maxBarsInTrade', 'flatAtSessionEnd',
    'entryStart', 'entryEnd', 'trendFilterLength', 'maxTradesPerDay', 'dailyLossPct',
  ];
  // number settings where 0 means "off" (shown as an empty box)
  const OFF_WHEN_ZERO = new Set(['stopLossPct', 'atrStopMult', 'takeProfitPct', 'rrTarget', 'trailingStopPct', 'breakEvenR', 'maxBarsInTrade', 'trendFilterLength', 'maxTradesPerDay', 'dailyLossPct']);
  // must be > 0
  const POSITIVE = new Set(['capital', 'sizePct', 'riskPct', 'atrLength']);

  function renderSettings() {
    for (const key of SETTING_IDS) {
      const input = $(`set-${key}`);
      const v = state.settings[key];
      if (input.type === 'checkbox') input.checked = !!v;
      else if (input.type === 'number') input.value = OFF_WHEN_ZERO.has(key) && !v ? '' : v;
      else input.value = v === undefined || v === null ? '' : v;
    }
    updateSettingBadges();
  }

  function updateSettingBadges() {
    const st = state.settings;
    const risk = st.sizing === 'risk';
    $('set-riskPct').disabled = !risk;
    $('sizePctLabel').textContent = risk ? 'Max position (% equity)' : 'Position size (% equity)';
    const badge = (id, text, on) => {
      $(id).textContent = text;
      $(id).classList.toggle('on', on);
    };
    badge('badge-size', risk ? `${st.riskPct}% risk` : `${st.sizePct}% equity`, risk);
    const exits = ['stopLossPct', 'atrStopMult', 'takeProfitPct', 'rrTarget', 'trailingStopPct', 'breakEvenR', 'maxBarsInTrade'].filter((k) => st[k] > 0).length + (st.flatAtSessionEnd ? 1 : 0);
    badge('badge-exits', exits ? `${exits} on` : 'off', exits > 0);
    const filters = (st.entryStart || st.entryEnd ? 1 : 0) + ['trendFilterLength', 'maxTradesPerDay', 'dailyLossPct'].filter((k) => st[k] > 0).length;
    badge('badge-filters', filters ? `${filters} on` : 'off', filters > 0);
    return { exits, filters, risk };
  }

  function bindSettings() {
    for (const key of SETTING_IDS) {
      const input = $(`set-${key}`);
      const handler = () => {
        let v;
        if (input.type === 'checkbox') v = input.checked;
        else if (input.type === 'number') {
          v = input.value === '' ? (POSITIVE.has(key) ? NaN : 0) : Number(input.value);
          if (!Number.isFinite(v) || v < 0) return;
          if (POSITIVE.has(key) && v <= 0) return;
        } else v = input.value;
        state.settings[key] = v;
        updateSettingBadges();
        persistSoon();
        scheduleRun();
      };
      input.addEventListener(input.type === 'checkbox' || input.tagName === 'SELECT' ? 'change' : 'input', handler);
    }
    // open the groups that have something switched on
    const on = updateSettingBadges();
    $('fold-size').open = on.risk;
    $('fold-exits').open = on.exits > 0;
    $('fold-filters').open = on.filters > 0;
  }

  // ---------------------------------------------------------------- run

  const scheduleRun = debounce(() => {
    if (state.autoRun) runBacktest();
    else markStale(true);
  }, 120);

  function markStale(on) {
    $('kpis').classList.toggle('stale', on);
    document.querySelectorAll('.chart-card').forEach((c) => c.classList.toggle('stale', on));
  }

  function runBacktest() {
    if (!state.data) return;
    const rec = currentRec();
    if (!rec) return;
    let compiled;
    try {
      compiled = compileCached(codeOf(rec));
    } catch (e) {
      showError(e);
      return;
    }
    state.compiled = compiled;
    try {
      const t0 = performance.now();
      const res = BT.engine.run(state.data, compiled, paramsFor(rec.id, compiled), state.settings);
      const ms = performance.now() - t0;
      state.result = res;
      hideError();
      renderResult(res, compiled, ms);
      markStale(false);
      return res;
    } catch (e) {
      showError(e);
      markStale(true);
    }
  }

  function showError(e) {
    state.lastError = e;
    $('errorBox').hidden = false;
    $('errorTitle').textContent = e.line ? `Strategy error on line ${e.line}` : 'Strategy error';
    $('errorText').textContent = e.message;
    $('errorGoto').hidden = !e.line;
    $('runStatus').textContent = 'Last run failed';
    setCodeMsg(e.line ? `Line ${e.line}: ${e.message}` : e.message, 'error');
    markGutterError(e.line);
  }

  function hideError() {
    state.lastError = null;
    $('errorBox').hidden = true;
    markGutterError(null);
  }

  function renderResult(res, compiled, ms) {
    const d = res.data;
    $('runTitle').textContent = compiled.name;
    const paramText = Object.entries(res.params).map(([k, v]) => `${k}=${v}`).join(' ');
    $('runSubtitle').textContent = `${d.symbol} · ${d.interval} · ${f.date(d.time[0])} → ${f.date(d.time[d.length - 1])}${paramText ? ' · ' + paramText : ''}`;
    $('runStatus').textContent = `${f.int(d.length)} bars in ${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms`;
    renderKpis(res.metrics);
    renderTrades(res);
    renderMonthly(res);
    BT.charts.render(res);
  }

  function kpi(label, value, cls, sub) {
    const tile = document.createElement('div');
    tile.className = 'kpi';
    const l = document.createElement('div');
    l.className = 'kpi-label';
    l.textContent = label;
    const v = document.createElement('div');
    v.className = `kpi-value ${cls || ''}`;
    v.textContent = value;
    const s = document.createElement('div');
    s.className = 'kpi-sub';
    s.textContent = sub;
    s.title = sub;
    tile.append(l, v, s);
    return tile;
  }

  const sign = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');

  function renderKpis(m) {
    const box = $('kpis');
    box.textContent = '';
    const yrs = m.years < 1 ? `${Math.round(m.years * 365)} days` : `${m.years.toFixed(1)} years`;
    box.append(
      kpi('Net return', f.pct(m.totalReturn, 1), sign(m.totalReturn), `${f.money(m.endEquity)} · buy and hold ${f.pct(m.buyHoldReturn, 1)}`),
      kpi('CAGR', f.pct(m.cagr, 1), sign(m.cagr), `annualised over ${yrs}`),
      kpi('Max drawdown', f.pct(m.maxDrawdown, 1), m.maxDrawdown < 0 ? 'neg' : '', `buy and hold ${f.pct(m.buyHoldMaxDrawdown, 1)}`),
      kpi('Sharpe', f.num(m.sharpe, 2), '', `Sortino ${f.num(m.sortino, 2)} · Calmar ${f.num(m.calmar, 2)}`),
      kpi('Profit factor', f.num(m.profitFactor, 2), '', `expectancy ${f.signedMoney(m.expectancy)}${m.rTrades ? ` · ${f.num(m.avgR, 2)}R` : ''} per trade`),
      kpi('Win rate', f.pct(m.winRate, 1, false), '', `avg win ${f.pct(m.avgWinPct)} · loss ${f.pct(m.avgLossPct)}`),
      kpi('Trades', f.int(m.trades), '', `avg ${f.num(m.avgBarsHeld, 1)} bars held`),
      kpi('Time in market', f.pct(m.exposurePct, 1, false), '', `volatility ${f.pct(m.volatility, 1, false)} a year`)
    );
  }

  function renderTrades(res) {
    const m = res.metrics;
    $('tradeCount').textContent = f.int(m.trades);
    const stats = [
      ['Net profit', f.signedMoney(m.netProfit)],
      ['Average trade', f.pct(m.avgTradePct)],
      ['Average win', f.pct(m.avgWinPct)],
      ['Average loss', f.pct(m.avgLossPct)],
      ['Best trade', f.pct(m.bestTradePct)],
      ['Worst trade', f.pct(m.worstTradePct)],
      ['Expectancy', f.signedMoney(m.expectancy)],
      ['Average bars held', f.num(m.avgBarsHeld, 1)],
      ['Longest losing streak', f.int(m.maxLossStreak)],
      ['Long trades (win rate)', `${f.int(m.longTrades)} (${f.pct(m.longWinRate, 0, false)})`],
      ['Short trades (win rate)', `${f.int(m.shortTrades)} (${f.pct(m.shortWinRate, 0, false)})`],
      ['Average R per trade', m.rTrades ? `${f.num(m.avgR, 2)}R` : 'needs a stop'],
      ['Best / worst R', m.rTrades ? `${f.num(m.bestR, 2)}R / ${f.num(m.worstR, 2)}R` : '–'],
      ['Average MAE / MFE', `${f.pct(m.avgMaePct)} / ${f.pct(m.avgMfePct)}`],
      ['Commission paid', f.money(m.commissionPaid, 2)],
      ['Longest drawdown', `${f.int(m.longestDrawdownBars)} bars`],
      ['Annual volatility', f.pct(m.volatility, 1, false)],
      ['Final equity', f.money(m.endEquity, 2)],
    ];
    const dl = $('tradeStats');
    dl.textContent = '';
    for (const [k, v] of stats) {
      const row = document.createElement('div');
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = v;
      row.append(dt, dd);
      dl.appendChild(row);
    }

    const tbody = $('tradesTable').querySelector('tbody');
    tbody.textContent = '';
    const frag = document.createDocumentFragment();
    const d = res.data;
    const limit = 3000;
    res.trades.slice(0, limit).forEach((t, k) => {
      const tr = document.createElement('tr');
      tr.tabIndex = 0;
      const cells = [
        [String(k + 1), 'num mono'],
        [null, ''],
        [f.time(t.entryTime, d), 'mono'],
        [f.price(t.entryPrice), 'num mono'],
        [f.time(t.exitTime, d), 'mono'],
        [f.price(t.exitPrice), 'num mono'],
        [f.int(t.bars), 'num mono'],
        [f.signedMoney(t.pnl), `num mono ${sign(t.pnl)}`],
        [f.pct(t.returnPct), `num mono ${sign(t.returnPct)}`],
        [Number.isFinite(t.rMultiple) ? `${f.num(t.rMultiple, 2)}R` : '–', `num mono ${sign(t.rMultiple)}`],
        [f.pct(t.maePct), 'num mono'],
        [f.pct(t.mfePct), 'num mono'],
        [t.exitReason, ''],
      ];
      for (const [text, cls] of cells) {
        const td = document.createElement('td');
        td.className = cls;
        if (text === null) {
          const pill = document.createElement('span');
          pill.className = `side-pill ${t.side}`;
          pill.textContent = t.side;
          td.appendChild(pill);
        } else td.textContent = text;
        tr.appendChild(td);
      }
      tr.addEventListener('click', () => showTrade(t));
      tr.addEventListener('keydown', (e) => e.key === 'Enter' && showTrade(t));
      frag.appendChild(tr);
    });
    tbody.appendChild(frag);
    $('tradesEmpty').hidden = res.trades.length > 0;

    renderExcursions(res);
    $('logCard').hidden = !res.logs.length;
    $('logBox').textContent = res.logs.map((l) => `${f.time(d.time[l.index], d)}  ${l.text}`).join('\n');
  }

  function renderExcursions(res) {
    const m = res.metrics;
    const list = $('excursionInsights');
    list.textContent = '';
    const say = (parts) => {
      const li = document.createElement('li');
      for (const p of parts) {
        if (Array.isArray(p)) {
          const b = document.createElement('b');
          b.textContent = p[0];
          li.appendChild(b);
        } else li.appendChild(document.createTextNode(p));
      }
      list.appendChild(li);
    };
    const wins = res.trades.filter((t) => t.pnl > 0).length;
    const losses = res.trades.length - wins;
    if (wins >= 5) {
      say(['90% of winning trades never went more than ', [f.pct(-m.winnersMae90)], ' against you. A stop just beyond that would have kept almost all of them.']);
    }
    if (losses >= 5 && Number.isFinite(m.losersMfeAvg)) {
      say(['Losing trades were up ', [f.pct(m.losersMfeAvg)], ' on average at their best; ', [f.pct(m.losersUpAtSomePoint, 0, false)], ' of them were in profit at some point.']);
    }
    if (m.rTrades) say(['Average result: ', [`${f.num(m.avgR, 2)}R`], ` per trade, over ${f.int(m.rTrades)} trades with a stop.`]);
    else if (res.trades.length) say(['Set a stop (strategy, ATR or stop loss %) to see results in R.']);
    const sk = m.skipped;
    const skippedTotal = sk.hours + sk.trend + sk.maxTrades + sk.dailyLoss;
    if (skippedTotal) {
      const why = [['trading hours', sk.hours], ['trend filter', sk.trend], ['max trades per day', sk.maxTrades], ['daily loss limit', sk.dailyLoss]]
        .filter(([, v]) => v)
        .map(([k, v]) => `${k} ${f.int(v)}`)
        .join(', ');
      say(['Entry filters skipped ', [f.int(skippedTotal)], ` signals (${why}).`]);
    }
    if (!list.children.length) say(['Not enough trades yet to say where stops and targets belong.']);

    const d = res.data;
    const pts = (key) =>
      res.trades.map((t, k) => ({
        x: t[key],
        y: t.returnPct,
        win: t.pnl > 0,
        trade: t,
        label: `#${k + 1} ${t.side} ${f.time(t.entryTime, d)}: result ${f.pct(t.returnPct)}, ${key === 'maePct' ? 'worst' : 'best'} ${f.pct(t[key])}`,
      }));
    const onClick = (p) => showTrade(p.trade);
    BT.charts.scatter($('maeChart'), pts('maePct'), { xLabel: 'Worst point against you (MAE)', yLabel: 'Trade result', onClick });
    BT.charts.scatter($('mfeChart'), pts('mfePct'), { xLabel: 'Best point in your favour (MFE)', yLabel: 'Trade result', onClick });
  }

  function showTrade(t) {
    selectTab('chart');
    requestAnimationFrame(() => BT.charts.focusTrade(t));
  }

  function heatColor(v, scale) {
    const style = getComputedStyle(document.documentElement);
    const rgb = style.getPropertyValue(v >= 0 ? '--heat-pos' : '--heat-neg').trim();
    const k = Math.min(Math.abs(v) / scale, 1);
    return { bg: `rgba(${rgb}, ${(0.12 + 0.78 * k).toFixed(3)})`, strong: k > 0.6 };
  }

  function renderMonthly(res) {
    const rows = BT.metrics.monthly(res);
    const table = $('monthlyTable');
    table.textContent = '';
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    for (const h of ['Year', ...months, 'Year total']) {
      const th = document.createElement('th');
      th.textContent = h;
      if (h === 'Year') th.className = 'year';
      hr.appendChild(th);
    }
    thead.appendChild(hr);
    table.appendChild(thead);
    const all = rows.flatMap((r) => r.months.filter((v) => v !== null).map(Math.abs)).sort((a, b) => a - b);
    const scale = Math.max(all.length ? all[Math.floor(all.length * 0.9)] : 1, 0.5);
    const tbody = document.createElement('tbody');
    for (const r of rows) {
      const tr = document.createElement('tr');
      const th = document.createElement('th');
      th.className = 'year';
      th.textContent = r.year;
      tr.appendChild(th);
      const cell = (v, title, extra) => {
        const td = document.createElement('td');
        if (v === null) {
          td.className = 'none';
          td.textContent = '·';
        } else {
          const c = heatColor(v, scale * (extra ? 2.5 : 1));
          td.style.background = c.bg;
          if (c.strong) td.style.color = '#ffffff';
          td.textContent = f.pct(v, 1);
          td.title = `${title}: ${f.pct(v, 2)}`;
          if (extra) td.className = extra;
        }
        tr.appendChild(td);
      };
      r.months.forEach((v, k) => cell(v, `${months[k]} ${r.year}`));
      cell(r.total, `${r.year}`, 'total');
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
  }

  function exportTrades() {
    const res = state.result;
    if (!res) return;
    const d = res.data;
    const lines = ['side,entry_time,entry_price,exit_time,exit_price,qty,bars,pnl,return_pct,r_multiple,mae_pct,mfe_pct,entry_reason,exit_reason'];
    for (const t of res.trades) {
      const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
      const r = Number.isFinite(t.rMultiple) ? t.rMultiple.toFixed(3) : '';
      lines.push([t.side, f.time(t.entryTime, d), t.entryPrice, f.time(t.exitTime, d), t.exitPrice, t.qty, t.bars, t.pnl.toFixed(2), t.returnPct.toFixed(4), r, t.maePct.toFixed(4), t.mfePct.toFixed(4), q(t.entryReason), q(t.exitReason)].join(','));
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `trades_${state.strategyId}_${d.symbol}.csv`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 1000);
  }

  // ---------------------------------------------------------------- tabs

  const TABS = ['chart', 'trades', 'monthly', 'optimize', 'code', 'library', 'traderdev'];

  function selectTab(tab) {
    if (!TABS.includes(tab)) tab = 'chart';
    document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
    document.querySelectorAll('.tab-panel').forEach((p) => (p.hidden = p.dataset.panel !== tab));
    try {
      history.replaceState(null, '', `#${tab}`);
    } catch (e) {
      /* sandboxed: ignore */
    }
    if (tab === 'code') refreshGutter();
    if (tab === 'traderdev') BT.traderdev.show();
    if (tab === 'library') BT.library.show();
  }

  // ---------------------------------------------------------------- code editor

  const editor = () => $('codeEditor');

  function setCodeMsg(text, kind) {
    const el = $('codeMsg');
    el.textContent = text || '';
    el.className = `code-msg ${kind || ''}`;
  }

  function fileLabel(rec) {
    if (!rec) return '';
    if (rec.origin === 'new') return 'unsaved strategy';
    if (state.server) return `strategies/${rec.id}.js`;
    return rec.origin === 'bundled' ? `${rec.id}.js (built-in)` : `${rec.id}.js (saved in this browser)`;
  }

  function openInEditor() {
    const rec = currentRec();
    if (!rec) return;
    editor().value = codeOf(rec);
    $('codeFile').textContent = fileLabel(rec);
    updateDirty();
    refreshGutter();
    setCodeMsg(state.server ? 'Edits are kept as a draft until you save.' : 'Edits are kept in this browser until you save.');
    hideForms();
  }

  function updateDirty() {
    const rec = currentRec();
    $('dirtyDot').hidden = !isDirty(rec);
    $('codeRevertBtn').disabled = !rec || rec.origin === 'new' || state.drafts[rec.id] === undefined;
    const canDelete = rec && (rec.origin === 'file' || rec.origin === 'local');
    $('codeDeleteBtn').hidden = !canDelete;
    if (rec && rec.origin === 'local' && rec.bundledCode) $('codeDeleteBtn').textContent = 'Restore built-in';
    else $('codeDeleteBtn').textContent = 'Delete';
  }

  let errorLine = null;
  function refreshGutter() {
    const lines = editor().value.split('\n').length;
    const g = $('codeGutter');
    g.textContent = '';
    const frag = document.createDocumentFragment();
    for (let k = 1; k <= lines; k++) {
      if (k === errorLine) {
        const s = document.createElement('span');
        s.className = 'err';
        s.textContent = String(k);
        frag.appendChild(s);
      } else frag.appendChild(document.createTextNode(String(k)));
      if (k < lines) frag.appendChild(document.createTextNode('\n'));
    }
    g.appendChild(frag);
    g.scrollTop = editor().scrollTop;
  }

  function markGutterError(line) {
    errorLine = line || null;
    refreshGutter();
  }

  function gotoLine(line) {
    const ta = editor();
    const lines = ta.value.split('\n');
    let pos = 0;
    for (let k = 0; k < Math.min(line - 1, lines.length); k++) pos += lines[k].length + 1;
    ta.focus();
    ta.setSelectionRange(pos, pos + (lines[line - 1] || '').length);
    const lh = parseFloat(getComputedStyle(ta).lineHeight) || 20;
    ta.scrollTop = Math.max(0, (line - 5) * lh);
  }

  function onEditorInput() {
    const rec = currentRec();
    if (!rec) return;
    state.drafts[rec.id] = editor().value;
    if (rec.origin !== 'new' && state.drafts[rec.id] === rec.code) delete state.drafts[rec.id];
    persistDrafts();
    updateDirty();
    refreshGutter();
  }

  function onEditorKey(e) {
    const ta = editor();
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key === 'Enter') {
      e.preventDefault();
      runFromEditor();
    } else if (mod && (e.key === 's' || e.key === 'S')) {
      e.preventDefault();
      saveCurrent();
    } else if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault();
      ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end');
      onEditorInput();
    } else if (e.key === 'Enter' && !mod && !e.shiftKey && !e.altKey) {
      const before = ta.value.slice(0, ta.selectionStart);
      const lineStart = before.lastIndexOf('\n') + 1;
      const indent = (before.slice(lineStart).match(/^\s*/) || [''])[0];
      const extra = /[{([]\s*$/.test(before) ? '  ' : '';
      if (indent || extra) {
        e.preventDefault();
        ta.setRangeText('\n' + indent + extra, ta.selectionStart, ta.selectionEnd, 'end');
        onEditorInput();
      }
    }
  }

  function runFromEditor() {
    const rec = currentRec();
    onEditorInput();
    let compiled;
    try {
      compiled = compileCached(codeOf(rec));
    } catch (e) {
      showError(e);
      return;
    }
    renderStrategySelect();
    renderParams();
    setupOptimizer();
    const res = runBacktest();
    if (res) setCodeMsg(`Ran "${compiled.name}": ${f.int(res.metrics.trades)} trades, ${f.pct(res.metrics.totalReturn, 1)} net return.`, 'ok');
  }

  async function saveCurrent() {
    const rec = currentRec();
    if (!rec) return;
    if (rec.origin === 'new' || rec.origin === 'bundled') {
      showSaveAs(rec.origin === 'bundled' ? `my_${rec.id}` : 'my_strategy');
      return;
    }
    await saveAs(rec.id, editor().value, true);
  }

  async function saveAs(id, code, overwrite) {
    try {
      BT.engine.compile(code);
    } catch (e) {
      showError(e);
      setCodeMsg(`Not saved: ${e.line ? `line ${e.line}: ` : ''}${e.message}`, 'error');
      return false;
    }
    const exists = state.strategies.find((s) => s.id === id && s.origin !== 'new');
    if (exists && !overwrite) {
      setCodeMsg(`A strategy called ${id} already exists. Pick another name.`, 'error');
      return false;
    }
    try {
      if (state.server) {
        const res = await fetch(`api/strategies/${encodeURIComponent(id)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || `Save failed (HTTP ${res.status})`);
      } else {
        const local = store.get(LOCAL_STRATS_KEY, {});
        local[id] = code;
        store.set(LOCAL_STRATS_KEY, local);
      }
    } catch (e) {
      setCodeMsg(e.message, 'error');
      return false;
    }
    const prev = currentRec();
    if (prev && prev.origin === 'new') state.strategies = state.strategies.filter((s) => s !== prev);
    let rec = state.strategies.find((s) => s.id === id);
    if (!rec) {
      rec = { id, code, origin: state.server ? 'file' : 'local' };
      state.strategies.push(rec);
    } else {
      rec.code = code;
      if (!state.server && rec.origin === 'bundled') {
        rec.origin = 'local';
        rec.bundledCode = (window.BT_BUNDLED_STRATEGIES || []).find((s) => s.id === id).code;
      }
    }
    delete state.drafts[id];
    if (prev && prev.id !== id) {
      // keep the original untouched; carry its parameter values over to the copy
      if (prev.origin !== 'new') delete state.drafts[prev.id];
      state.params[id] = Object.assign({}, state.params[prev.id]);
    }
    persistDrafts();
    state.strategyId = id;
    persist();
    renderStrategySelect();
    renderParams();
    openInEditor();
    setupOptimizer();
    runBacktest();
    setCodeMsg(`Saved ${fileLabel(rec)}.`, 'ok');
    return true;
  }

  function showSaveAs(suggest) {
    hideForms();
    $('saveAsForm').hidden = false;
    $('saveAsName').value = suggest || '';
    $('saveAsName').focus();
    $('saveAsName').select();
  }

  function hideForms() {
    $('saveAsForm').hidden = true;
    $('deleteConfirm').hidden = true;
  }

  async function deleteCurrent() {
    const rec = currentRec();
    if (!rec) return;
    try {
      if (state.server) {
        const res = await fetch(`api/strategies/${encodeURIComponent(rec.id)}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' } });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `Delete failed (HTTP ${res.status})`);
        }
        state.strategies = state.strategies.filter((s) => s !== rec);
      } else {
        const local = store.get(LOCAL_STRATS_KEY, {});
        delete local[rec.id];
        store.set(LOCAL_STRATS_KEY, local);
        if (rec.bundledCode) {
          rec.code = rec.bundledCode;
          rec.origin = 'bundled';
          delete rec.bundledCode;
        } else state.strategies = state.strategies.filter((s) => s !== rec);
      }
    } catch (e) {
      setCodeMsg(e.message, 'error');
      return;
    }
    delete state.drafts[rec.id];
    persistDrafts();
    hideForms();
    const next = state.strategies.find((s) => s.id === rec.id) || state.strategies.find((s) => s.id === DEFAULT_STRATEGY) || state.strategies[0];
    selectStrategy(next.id);
    setCodeMsg(`Removed ${rec.id}.`, 'ok');
  }

  function newStrategy() {
    let id = 'untitled';
    let k = 2;
    while (state.strategies.some((s) => s.id === id)) id = `untitled_${k++}`;
    const rec = { id, code: BT.engine.TEMPLATE, origin: 'new' };
    state.strategies.push(rec);
    delete state.drafts[id];
    selectStrategy(id);
    selectTab('code');
    setCodeMsg('New strategy from the template. Edit it, press Run, then Save.');
  }

  // ---------------------------------------------------------------- optimizer

  function setupOptimizer() {
    let compiled;
    try {
      compiled = compileCached(codeOf(currentRec()));
    } catch (e) {
      return;
    }
    state.compiled = compiled;
    const params = compiled.params;
    const fill = (sel, withNone) => {
      sel.textContent = '';
      if (withNone) {
        const o = document.createElement('option');
        o.value = '';
        o.textContent = 'None';
        sel.appendChild(o);
      }
      const group = (label, list) => {
        const g = document.createElement('optgroup');
        g.label = label;
        for (const p of list) {
          const o = document.createElement('option');
          o.value = p.key;
          o.textContent = p.label;
          g.appendChild(o);
        }
        sel.appendChild(g);
      };
      if (params.length) group('Strategy parameters', params);
      group('Stops, targets and filters', SWEEP_SETTINGS);
    };
    fill($('optX'), false);
    fill($('optY'), true);
    const numeric = params.filter((p) => p.type === 'number');
    $('optX').value = numeric[0] ? numeric[0].key : params[0] ? params[0].key : SWEEP_SETTINGS[0].key;
    $('optY').value = numeric[1] ? numeric[1].key : '';
    axisDefaults('X');
    axisDefaults('Y');
    $('optResults').hidden = true;
    updateOptCount();
  }

  // execution settings that can be swept like strategy parameters
  const SWEEP_SETTINGS = [
    ['atrStopMult', 'ATR stop (× ATR)', 0.5, 5, 0.5],
    ['stopLossPct', 'Stop loss %', 0.5, 10, 0.5],
    ['rrTarget', 'Reward:risk (R)', 0.5, 5, 0.5],
    ['takeProfitPct', 'Take profit %', 0.5, 10, 0.5],
    ['trailingStopPct', 'Trailing stop %', 0.5, 10, 0.5],
    ['breakEvenR', 'Break-even after (R)', 0.5, 3, 0.5],
    ['maxBarsInTrade', 'Time stop (bars)', 5, 100, 5],
    ['riskPct', 'Risk per trade %', 0.25, 5, 0.25],
    ['trendFilterLength', 'Trend SMA', 20, 300, 20],
  ].map(([setting, label, min, max, step]) => ({ key: `set:${setting}`, setting, label, type: 'number', min, max, step }));

  function optParam(axis) {
    const key = $(`opt${axis}`).value;
    if (!key) return null;
    if (key.startsWith('set:')) return SWEEP_SETTINGS.find((p) => p.key === key) || null;
    return state.compiled ? state.compiled.params.find((p) => p.key === key) : null;
  }

  // the value an axis has in the current, un-swept configuration
  function currentAxisValue(p, stratId) {
    if (!p) return undefined;
    if (p.setting) return state.settings[p.setting];
    return paramsFor(stratId, state.compiled)[p.key];
  }

  function axisDefaults(axis) {
    const p = optParam(axis);
    const ids = ['From', 'To', 'Step'].map((s) => $(`opt${axis}${s}`));
    const numeric = p && p.type === 'number';
    ids.forEach((i) => (i.disabled = !numeric));
    if (!numeric) {
      ids.forEach((i) => (i.value = ''));
      return;
    }
    let step = p.step;
    const span = p.max - p.min;
    if (span / step > 12) {
      const raw = span / 10;
      const mag = Math.pow(10, Math.floor(Math.log10(raw)));
      step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || raw;
      if (Number.isInteger(p.step)) step = Math.max(1, Math.round(step));
    }
    ids[0].value = p.min;
    ids[1].value = p.max;
    ids[2].value = +step.toPrecision(6);
  }

  function axisSpec(axis) {
    return { from: $(`opt${axis}From`).value, to: $(`opt${axis}To`).value, step: $(`opt${axis}Step`).value };
  }

  function updateOptCount() {
    const x = optParam('X');
    const y = optParam('Y');
    try {
      if (!x) throw new Error('Pick a parameter to sweep.');
      if (y && y.key === x.key) throw new Error('Pick two different parameters.');
      const n = BT.optimizer.countRuns(x, axisSpec('X'), y, axisSpec('Y'));
      const tooMany = n > BT.optimizer.MAX_RUNS;
      $('optCount').textContent = tooMany ? `${f.int(n)} runs. Use larger steps (max ${f.int(BT.optimizer.MAX_RUNS)}).` : `${f.int(n)} backtests`;
      $('optRunBtn').disabled = tooMany || !n;
    } catch (e) {
      $('optCount').textContent = e.message;
      $('optRunBtn').disabled = true;
    }
  }

  async function runOptimizer() {
    if (state.opt) {
      state.opt.cancel();
      return;
    }
    const rec = currentRec();
    let compiled;
    try {
      compiled = compileCached(codeOf(rec));
    } catch (e) {
      showError(e);
      return;
    }
    const x = optParam('X');
    const y = optParam('Y');
    const btn = $('optRunBtn');
    const bar = $('optProgress');
    let handle;
    try {
      handle = BT.optimizer.run(
        {
          data: state.data, compiled, baseParams: paramsFor(rec.id, compiled), settings: state.settings,
          x, xSpec: axisSpec('X'), y, ySpec: axisSpec('Y'),
          objective: $('optObjective').value, split: $('optSplit').value, minTrades: Number($('optMinTrades').value) || 0,
        },
        (done, total) => {
          bar.firstElementChild.style.width = `${(100 * done) / total}%`;
          $('optCount').textContent = `${f.int(done)} of ${f.int(total)} backtests`;
        }
      );
    } catch (e) {
      $('optCount').textContent = e.message;
      return;
    }
    state.opt = handle;
    btn.textContent = 'Cancel';
    bar.hidden = false;
    bar.firstElementChild.style.width = '0%';
    try {
      const out = await handle.promise;
      renderOptimizer(out, x, y, rec.id);
      $('optCount').textContent = `${f.int(out.cells.length)} backtests done`;
    } catch (e) {
      $('optCount').textContent = e.message;
      if (e.line) showError(e);
    } finally {
      state.opt = null;
      btn.textContent = 'Run sweep';
      bar.hidden = true;
    }
  }

  const MIDPOINTS = { sharpe: 0, totalReturn: 0, calmar: 0, sortino: 0, profitFactor: 1, winRate: 50 };

  function renderOptimizer(out, x, y, stratId) {
    $('optResults').hidden = false;
    const objKey = $('optObjective').value;
    const mid = MIDPOINTS[objKey] || 0;
    const scores = out.cells.filter((c) => c.valid && Number.isFinite(c.score)).map((c) => c.score);
    const maxDev = Math.max(1e-9, ...scores.map((s) => Math.abs(s - mid)));
    const curX = currentAxisValue(x, stratId);
    const curY = currentAxisValue(y, stratId);
    const short = (p) => (p.setting ? p.setting : p.key);
    const splitNote = out.splitTime ? ` · in-sample before ${f.date(out.splitTime)}` : '';
    $('optHeatTitle').textContent = `${out.objective.label} by ${x.label}${y ? ` and ${y.label}` : ''}${splitNote}`;

    const heat = $('optHeat');
    heat.textContent = '';
    heat.style.gridTemplateColumns = `auto repeat(${out.xs.length}, minmax(46px, 1fr))`;
    const corner = document.createElement('div');
    corner.className = 'corner';
    corner.textContent = y ? `${short(y)} ↓ ${short(x)} →` : `${short(x)} →`;
    heat.appendChild(corner);
    for (const xv of out.xs) {
      const d = document.createElement('div');
      d.className = 'ax';
      d.textContent = String(xv);
      heat.appendChild(d);
    }
    const style = getComputedStyle(document.documentElement);
    for (let yi = 0; yi < out.ys.length; yi++) {
      const lab = document.createElement('div');
      lab.className = 'ax y';
      lab.textContent = y ? String(out.ys[yi]) : out.objective.label;
      heat.appendChild(lab);
      for (let xi = 0; xi < out.xs.length; xi++) {
        const c = out.cells[yi * out.xs.length + xi];
        const b = document.createElement('button');
        b.type = 'button';
        const desc = `${short(x)}=${c.axis.x}${y ? `, ${short(y)}=${c.axis.y}` : ''}`;
        if (!c.valid || !Number.isFinite(c.score)) {
          b.className = 'invalid';
          b.textContent = '–';
          b.title = `${desc}: only ${c.metrics.trades} trades`;
        } else {
          const k = Math.min(Math.abs(c.score - mid) / maxDev, 1);
          const rgb = style.getPropertyValue(c.score >= mid ? '--heat-pos' : '--heat-neg').trim();
          b.style.background = `rgba(${rgb}, ${(0.1 + 0.8 * k).toFixed(3)})`;
          b.style.color = k > 0.6 ? '#ffffff' : 'var(--ink)';
          b.textContent = out.objective.fmt(c.score);
          b.title = `${desc}: ${out.objective.label} ${out.objective.fmt(c.score)}, return ${f.pct(c.metrics.totalReturn, 1)}, ${c.metrics.trades} trades`;
        }
        const isCurrent = c.axis.x === curX && (!y || c.axis.y === curY);
        if (isCurrent) b.classList.add('current');
        b.addEventListener('click', () => applyCell(stratId, c));
        heat.appendChild(b);
      }
    }

    const table = $('optTable');
    const thead = table.querySelector('thead');
    const tbody = table.querySelector('tbody');
    thead.textContent = '';
    tbody.textContent = '';
    const heads = ['#', x.label, ...(y ? [y.label] : []), out.objective.label, 'Return', 'Max DD', 'Trades'];
    if (out.splitTime) heads.push(`Test ${out.objective.label}`, 'Test return', 'Test trades');
    const hr = document.createElement('tr');
    heads.forEach((h, k) => {
      const th = document.createElement('th');
      th.textContent = h;
      if (k > 0) th.className = 'num';
      hr.appendChild(th);
    });
    thead.appendChild(hr);
    out.top.forEach((c, k) => {
      const tr = document.createElement('tr');
      if (k === 0) tr.className = 'best';
      const vals = [String(k + 1), String(c.axis.x), ...(y ? [String(c.axis.y)] : []), out.objective.fmt(c.score), f.pct(c.metrics.totalReturn, 1), f.pct(c.metrics.maxDrawdown, 1), f.int(c.metrics.trades)];
      if (out.splitTime) {
        vals.push(c.oos ? out.objective.fmt(c.oosScore) : '–', c.oos ? f.pct(c.oos.totalReturn, 1) : '–', c.oos ? f.int(c.oos.trades) : '–');
      }
      vals.forEach((v, j) => {
        const td = document.createElement('td');
        td.className = j > 0 ? 'num mono' : 'mono';
        td.textContent = v;
        tr.appendChild(td);
      });
      tr.tabIndex = 0;
      tr.addEventListener('click', () => applyCell(stratId, c));
      tr.addEventListener('keydown', (e) => e.key === 'Enter' && applyCell(stratId, c));
      tbody.appendChild(tr);
    });
    if (!out.top.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = heads.length;
      td.textContent = 'No combination reached the minimum number of trades.';
      tr.appendChild(td);
      tbody.appendChild(tr);
    }
  }

  // Apply one sweep result: strategy parameters plus any swept execution settings.
  function applyCell(stratId, c) {
    if (stratId !== state.strategyId) return;
    state.params[stratId] = Object.assign({}, c.params);
    Object.assign(state.settings, c.overrides);
    persistSoon();
    renderParams();
    renderSettings();
    const res = runBacktest();
    document.querySelectorAll('#optHeat button.current').forEach((b) => b.classList.remove('current'));
    const changed = Object.assign({}, c.params, c.overrides);
    if (res) $('runStatus').textContent = `Applied ${Object.entries(changed).map(([k, v]) => `${k}=${v}`).join(', ')}`;
  }

  // ---------------------------------------------------------------- theme

  function applyTheme(theme) {
    if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
  }

  function toggleTheme() {
    const dark = document.documentElement.dataset.theme
      ? document.documentElement.dataset.theme === 'dark'
      : window.matchMedia('(prefers-color-scheme: dark)').matches;
    saved.theme = dark ? 'light' : 'dark';
    applyTheme(saved.theme); // the data-theme observer re-renders charts and the heatmap
    persist();
  }

  // ---------------------------------------------------------------- wiring

  function bind() {
    document.querySelectorAll('#sourceTabs button').forEach((b) => b.addEventListener('click', () => selectSource(b.dataset.source)));
    const sampleSel = $('sampleSelect');
    for (const [key, s] of Object.entries(BT.data.SAMPLES)) {
      const o = document.createElement('option');
      o.value = key;
      o.textContent = s.label;
      sampleSel.appendChild(o);
    }
    sampleSel.value = state.sampleKey;
    sampleSel.addEventListener('change', () => loadSample(sampleSel.value));

    const y = saved.yahoo || {};
    if (y.symbol) $('yahooSymbol').value = y.symbol;
    if (y.interval) $('yahooInterval').value = y.interval;
    if (y.range) $('yahooRange').value = y.range;
    if (typeof y.adjusted === 'boolean') $('yahooAdjusted').checked = y.adjusted;
    const bn = saved.binance || {};
    if (bn.symbol) $('binanceSymbol').value = bn.symbol;
    if (bn.interval) $('binanceInterval').value = bn.interval;
    if (bn.bars) $('binanceBars').value = bn.bars;

    $('yahooLoad').addEventListener('click', () => {
      persist();
      const opts = { symbol: $('yahooSymbol').value.trim().toUpperCase(), interval: $('yahooInterval').value, range: $('yahooRange').value, adjusted: $('yahooAdjusted').checked };
      if (!opts.symbol) return setLoadStatus('Enter a ticker symbol first.', true);
      loadWith(() => BT.data.loadYahoo(opts), `${opts.symbol} from Yahoo`);
    });
    $('yahooSymbol').addEventListener('keydown', (e) => e.key === 'Enter' && $('yahooLoad').click());
    $('binanceLoad').addEventListener('click', () => {
      persist();
      const opts = { symbol: $('binanceSymbol').value.trim().toUpperCase(), interval: $('binanceInterval').value, bars: Number($('binanceBars').value) };
      if (!opts.symbol) return setLoadStatus('Enter a trading pair first, e.g. BTCUSDT.', true);
      loadWith(() => BT.data.loadBinance(opts), `${opts.symbol} from Binance`);
    });
    $('binanceSymbol').addEventListener('keydown', (e) => e.key === 'Enter' && $('binanceLoad').click());

    $('csvFile').addEventListener('change', (e) => loadCsvFile(e.target.files[0]));
    const dz = $('dropzone');
    dz.addEventListener('dragover', (e) => {
      e.preventDefault();
      dz.classList.add('drag');
    });
    dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
    dz.addEventListener('drop', (e) => {
      e.preventDefault();
      dz.classList.remove('drag');
      loadCsvFile(e.dataTransfer.files[0]);
    });
    $('serverCsvLoad').addEventListener('click', () => {
      const name = $('serverCsvSelect').value;
      if (name) loadWith(() => BT.data.loadServerCSV(name), `data/${name}`);
    });
    $('rangeFrom').addEventListener('change', applyRange);
    $('rangeTo').addEventListener('change', applyRange);

    $('strategySelect').addEventListener('change', (e) => selectStrategy(e.target.value));
    $('resetParamsBtn').addEventListener('click', () => {
      delete state.params[state.strategyId];
      persistSoon();
      renderParams();
      runBacktest();
    });
    $('editCodeBtn').addEventListener('click', () => {
      selectTab('code');
      editor().focus();
    });
    $('newStrategyBtn').addEventListener('click', newStrategy);

    bindSettings();
    $('runBtn').addEventListener('click', runBacktest);
    $('autoRun').checked = state.autoRun;
    $('autoRun').addEventListener('change', (e) => {
      state.autoRun = e.target.checked;
      persistSoon();
      if (state.autoRun) runBacktest();
    });

    document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => selectTab(b.dataset.tab)));
    $('showMarkers').addEventListener('change', (e) => BT.charts.setShowMarkers(e.target.checked));
    $('fitBtn').addEventListener('click', () => BT.charts.fitAll());
    $('exportTradesBtn').addEventListener('click', exportTrades);
    $('errorGoto').addEventListener('click', () => {
      selectTab('code');
      if (state.lastError && state.lastError.line) gotoLine(state.lastError.line);
    });

    const ta = editor();
    ta.addEventListener('input', onEditorInput);
    ta.addEventListener('keydown', onEditorKey);
    ta.addEventListener('scroll', () => ($('codeGutter').scrollTop = ta.scrollTop));
    $('codeRunBtn').addEventListener('click', runFromEditor);
    $('codeSaveBtn').addEventListener('click', saveCurrent);
    $('codeSaveAsBtn').addEventListener('click', () => {
      const rec = currentRec();
      showSaveAs(rec && rec.origin !== 'new' ? `${rec.id}_copy` : 'my_strategy');
    });
    $('saveAsCancel').addEventListener('click', hideForms);
    $('saveAsForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const id = $('saveAsName').value.trim().replace(/\.js$/i, '');
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
        setCodeMsg('Use letters, numbers, _ and - only (max 64 characters).', 'error');
        return;
      }
      if (await saveAs(id, editor().value, false)) hideForms();
    });
    $('codeRevertBtn').addEventListener('click', () => {
      const rec = currentRec();
      delete state.drafts[rec.id];
      persistDrafts();
      openInEditor();
      renderStrategySelect();
      renderParams();
      setupOptimizer();
      runBacktest();
      setCodeMsg('Changes discarded.');
    });
    $('codeDeleteBtn').addEventListener('click', () => {
      const rec = currentRec();
      hideForms();
      $('deleteText').textContent = rec.bundledCode
        ? `Replace your edited copy of ${rec.id} with the built-in version?`
        : state.server
          ? `Delete strategies/${rec.id}.js? This removes the file.`
          : `Delete ${rec.id} from this browser?`;
      $('deleteYes').textContent = rec.bundledCode ? 'Restore' : 'Delete';
      $('deleteConfirm').hidden = false;
    });
    $('deleteNo').addEventListener('click', hideForms);
    $('deleteYes').addEventListener('click', deleteCurrent);

    for (const id of ['optX', 'optY']) {
      $(id).addEventListener('change', () => {
        axisDefaults(id === 'optX' ? 'X' : 'Y');
        updateOptCount();
      });
    }
    for (const id of ['optXFrom', 'optXTo', 'optXStep', 'optYFrom', 'optYTo', 'optYStep']) $(id).addEventListener('input', updateOptCount);
    $('optRunBtn').addEventListener('click', runOptimizer);

    $('themeToggle').addEventListener('click', toggleTheme);
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onScheme = () => {
      BT.charts.retheme();
      if (state.result) renderMonthly(state.result);
    };
    if (mq.addEventListener) mq.addEventListener('change', onScheme);
    // the viewer of a hosted preview can flip data-theme on <html>
    new MutationObserver(onScheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && document.activeElement !== editor()) {
        e.preventDefault();
        runBacktest();
      }
    });
  }

  async function boot() {
    if (!PREVIEW) applyTheme(saved.theme);
    BT.charts.init({ price: 'priceChart', osc: 'oscChart', equity: 'equityChart', dd: 'ddChart', priceLegend: 'priceLegend', oscLegend: 'oscLegend', equityLegend: 'equityLegend', ddLegend: 'ddLegend' });
    bind();
    renderSettings();
    state.server = await detectServer();
    renderEnv();
    BT.traderdev.init({ server: state.server, kpi, selectTab });
    BT.library.init({ server: state.server, selectTab });
    try {
      await loadStrategies();
    } catch (e) {
      setLoadStatus(`Could not load strategies: ${e.message}`, true);
    }
    if (!state.strategies.length) {
      state.strategies.push({ id: 'untitled', code: BT.engine.TEMPLATE, origin: 'new' });
    }
    if (!state.strategies.some((s) => s.id === state.strategyId)) state.strategyId = (state.strategies.find((s) => s.id === DEFAULT_STRATEGY) || state.strategies[0]).id;
    renderStrategySelect();
    renderParams();
    openInEditor();
    setupOptimizer();
    const startSource = state.server ? state.source : ['sample', 'csv'].includes(state.source) ? state.source : 'sample';
    selectSource(startSource);
    loadSample(BT.data.SAMPLES[state.sampleKey] ? state.sampleKey : 'intraday');
    const tab = (location.hash || '').replace('#', '');
    selectTab(TABS.includes(tab) ? tab : 'chart');
  }

  boot();
})();
