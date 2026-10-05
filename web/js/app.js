/*
 * UI controller: wires the sidebar, the results tabs, the optimizer and the
 * code editor to Trader.dev.
 *
 * Pressing Run regenerates the Pine Script from the strategy and the
 * sidebar, sends it to Trader.dev through the local server, and shows what
 * comes back. Nothing is simulated in the browser, so every run needs the
 * server (python3 server.py) and a Trader.dev API key.
 */
(function () {
  'use strict';
  const BT = window.BT;
  const f = BT.fmt;
  const $ = (id) => document.getElementById(id);
  // These keep the app's old name on purpose: renaming them would make the
  // browser forget saved settings and any unsaved strategy edits.
  const STORE_KEY = 'vwaplab:v2';
  const DRAFT_KEY = 'vwaplab:drafts';
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
    traderdev: null, // { ok, configured, email, tier, error }
    strategies: [], // { id, code, origin: 'file' | 'new' }
    drafts: store.get(DRAFT_KEY, {}),
    strategyId: saved.strategyId || DEFAULT_STRATEGY,
    params: saved.params || {},
    settings: Object.assign({}, BT.strategy.DEFAULT_SETTINGS, saved.settings || {}),
    market: Object.assign({}, BT.strategy.DEFAULT_MARKET, saved.market || {}),
    // Trader.dev strategy id per local strategy, so re-runs become versions
    // of the same strategy there instead of a new one each time.
    remoteIds: saved.remoteIds || {},
    compiled: null,
    compileCache: { code: null, compiled: null },
    pine: '',
    run: null, // { result, trades, curve, viewUrl }
    busy: false,
    lastError: null,
    opt: null,
  };

  function persist() {
    store.set(STORE_KEY, {
      strategyId: state.strategyId,
      params: state.params,
      settings: state.settings,
      market: state.market,
      remoteIds: state.remoteIds,
      theme: saved.theme,
    });
  }
  const persistSoon = debounce(persist, 300);
  const persistDrafts = debounce(() => store.set(DRAFT_KEY, state.drafts), 400);

  // ---------------------------------------------------------------- environment

  async function detectServer() {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 2000);
      const res = await fetch('api/health', { signal: ctl.signal });
      clearTimeout(timer);
      if (!res.ok) return false;
      const body = await res.json();
      return !!(body && body.ok);
    } catch (e) {
      return false;
    }
  }

  const RECHECK = 'Click to check again.';

  function renderEnv() {
    const b = $('envBadge');
    const td = state.traderdev;
    b.disabled = false;
    if (!state.server) {
      b.dataset.state = 'preview';
      b.textContent = 'No local server';
      b.title = `Backtests need the local server. Run python3 server.py and open http://localhost:8000. ${RECHECK}`;
    } else if (td && td.ok) {
      b.dataset.state = 'server';
      b.textContent = `Trader.dev · ${td.email || 'connected'}`;
      b.title = `Backtests run on ${td.url}${td.tier ? ` · ${td.tier} plan` : ''}. ${RECHECK}`;
    } else {
      b.dataset.state = 'preview';
      b.textContent = 'Trader.dev not connected';
      b.title = `${(td && td.error) || 'Could not reach Trader.dev.'} ${RECHECK}`;
    }
    $('runBtn').disabled = !state.server || !(td && td.ok) || state.busy;
    $('optRunBtn').disabled = $('runBtn').disabled;
  }

  // quiet: leave the sidebar message alone, because the caller is already
  // showing an error of its own
  async function refreshStatus({ quiet = false } = {}) {
    try {
      state.traderdev = await BT.traderdev.status();
    } catch (e) {
      state.traderdev = { ok: false, configured: false, error: e.message };
    }
    renderEnv();
    const shown = $('loadStatus').textContent;
    if (!state.traderdev.ok) {
      const msg = state.traderdev.error || 'Trader.dev is not reachable.';
      if (!quiet) {
        setLoadStatus(`${msg} Then click the badge at the top right to check again.`, true);
        state.envMessage = $('loadStatus').textContent;
      }
    } else if (state.envMessage && shown === state.envMessage) {
      setLoadStatus('');
    }
    refreshCredits();
  }

  // The badge doubles as a "try again" button, so a key set or a network
  // fixed after the page loaded does not need a reload.
  async function recheckEnv() {
    const b = $('envBadge');
    if (b.disabled) return;
    b.disabled = true;
    b.dataset.state = 'checking';
    b.textContent = 'Checking Trader.dev…';
    const hadServer = state.server;
    state.server = await detectServer();
    if (!state.server) {
      renderEnv();
      setLoadStatus('Backtests need the local server. Run python3 server.py and open http://localhost:8000.', true);
      return;
    }
    if (!hadServer) {
      // the server came up after the page did: start over with its strategies
      location.reload();
      return;
    }
    await refreshStatus();
  }

  async function refreshCredits() {
    if (!state.traderdev || !state.traderdev.ok) {
      $('creditNote').textContent = '';
      return;
    }
    try {
      const c = await BT.traderdev.credits();
      const n = Number(c.balance);
      $('creditNote').textContent = Number.isFinite(n) ? `${f.int(n)} credits · 1 per backtest` : '1 credit per backtest';
    } catch (e) {
      $('creditNote').textContent = '1 credit per backtest';
    }
  }

  // ---------------------------------------------------------------- strategies

  async function loadStrategies() {
    const res = await fetch('api/strategies');
    if (!res.ok) throw new Error(`Could not read strategies (HTTP ${res.status})`);
    const body = await res.json();
    state.strategies = body.strategies.map((s) => ({ id: s.id, code: s.code, origin: 'file' }));
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
    const compiled = BT.strategy.compile(code);
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
    markStale();
    refreshPine();
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
    markStale();
    refreshPine();
  }

  // ---------------------------------------------------------------- market & settings

  function setLoadStatus(text, isError) {
    const el = $('loadStatus');
    el.textContent = text || '';
    el.classList.toggle('error', !!isError);
  }

  const MARKET_IDS = ['symbol', 'timeframe', 'from', 'to'];

  function renderMarket() {
    for (const key of MARKET_IDS) $(`mkt-${key}`).value = state.market[key] || '';
  }

  function bindMarket() {
    for (const key of MARKET_IDS) {
      const input = $(`mkt-${key}`);
      input.addEventListener(input.tagName === 'SELECT' ? 'change' : 'input', () => {
        state.market[key] = key === 'symbol' ? input.value.trim().toUpperCase() : input.value;
        persistSoon();
        markStale();
      });
    }
    $('mkt-symbol').addEventListener('blur', () => renderMarket());
    $('mkt-symbol').addEventListener('keydown', (e) => e.key === 'Enter' && runBacktest());
  }

  const SETTING_IDS = [
    'capital', 'allowShorts',
    'stopLossPct', 'atrStopMult', 'atrLength', 'takeProfitPct', 'rrTarget', 'trailingStopPct', 'breakEvenR', 'maxBarsInTrade',
    'trendFilterLength',
  ];
  // number settings where 0 means "off" (shown as an empty box)
  const OFF_WHEN_ZERO = new Set(['stopLossPct', 'atrStopMult', 'takeProfitPct', 'rrTarget', 'trailingStopPct', 'breakEvenR', 'maxBarsInTrade', 'trendFilterLength']);
  const POSITIVE = new Set(['capital', 'atrLength']);

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
    const badge = (id, text, on) => {
      $(id).textContent = text;
      $(id).classList.toggle('on', on);
    };
    const exits = ['stopLossPct', 'atrStopMult', 'takeProfitPct', 'rrTarget', 'trailingStopPct', 'breakEvenR', 'maxBarsInTrade'].filter((k) => st[k] > 0).length;
    badge('badge-exits', exits ? `${exits} on` : 'off', exits > 0);
    const filters = st.trendFilterLength > 0 ? 1 : 0;
    badge('badge-filters', filters ? 'on' : 'off', filters > 0);
    return { exits, filters };
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
        markStale();
        refreshPine();
        setupOptimizer();
      };
      input.addEventListener(input.type === 'checkbox' || input.tagName === 'SELECT' ? 'change' : 'input', handler);
    }
    const on = updateSettingBadges();
    $('fold-exits').open = on.exits > 0;
    $('fold-filters').open = on.filters > 0;
  }

  // ---------------------------------------------------------------- the Pine that gets sent

  function buildPine() {
    const rec = currentRec();
    const compiled = compileCached(codeOf(rec));
    state.compiled = compiled;
    return BT.pine.build(compiled, paramsFor(rec.id, compiled), state.settings);
  }

  const refreshPine = debounce(() => {
    try {
      state.pine = buildPine();
      $('pineView').value = state.pine;
      setPineMsg(`${state.pine.split('\n').length} lines. This is what the next run sends.`);
      hideError();
    } catch (e) {
      $('pineView').value = '';
      setPineMsg(e.message, 'error');
    }
    refreshPineGutter();
  }, 120);

  function setPineMsg(text, kind) {
    const el = $('pineMsg');
    el.textContent = text || '';
    el.className = `code-msg ${kind || ''}`;
  }

  function refreshPineGutter() {
    const lines = $('pineView').value.split('\n').length;
    const g = $('pineGutter');
    const out = [];
    for (let k = 1; k <= lines; k++) out.push(String(k));
    g.textContent = out.join('\n');
    g.scrollTop = $('pineView').scrollTop;
  }

  // The result on screen belongs to the settings it was run with. Once those
  // change it is dimmed, and the dock says why.
  function setStale(on) {
    $('kpis').classList.toggle('stale', on);
    document.querySelectorAll('.chart-card').forEach((c) => c.classList.toggle('stale', on));
  }

  function markStale() {
    if (!state.run) return;
    setStale(true);
    $('runStatus').textContent = 'Settings changed since this run';
  }

  // ---------------------------------------------------------------- run

  async function runBacktest() {
    if (state.busy) return;
    const rec = currentRec();
    if (!rec) return;
    let compiled;
    let pine;
    try {
      compiled = compileCached(codeOf(rec));
      pine = BT.pine.build(compiled, paramsFor(rec.id, compiled), state.settings);
    } catch (e) {
      showError(e);
      return;
    }
    state.compiled = compiled;
    state.pine = pine;
    $('pineView').value = pine;
    refreshPineGutter();
    if (!state.market.symbol) {
      setLoadStatus('Enter a symbol first, for example BTCUSDT.', true);
      return;
    }

    state.busy = true;
    renderEnv();
    hideError();
    $('noticeBox').hidden = true;
    $('runStatus').textContent = 'Running on Trader.dev…';
    setLoadStatus('');
    try {
      const body = await BT.traderdev.backtest({
        pineSource: pine,
        symbol: state.market.symbol,
        timeframe: state.market.timeframe,
        from: state.market.from || undefined,
        to: state.market.to || undefined,
        initialCapital: state.settings.capital,
        strategyId: state.remoteIds[rec.id],
        name: state.remoteIds[rec.id] ? undefined : compiled.name,
        notes: `Backtesting Tool · ${rec.id}`,
      });
      const result = body.result;
      const resultId = result.id || body.resultId;
      if (body.strategyId) {
        state.remoteIds[rec.id] = body.strategyId;
        persist();
      }
      $('runStatus').textContent = 'Fetching trades and equity curve…';
      const [trades, curve] = await Promise.all([
        BT.traderdev.trades(resultId).catch(() => []),
        BT.traderdev.equityCurve(resultId).catch(() => []),
      ]);
      state.run = {
        result,
        body,
        trades,
        curve: normalizeCurve(curve, result.initialCapital),
        viewUrl: body.viewUrl || body.strategyViewUrl || '',
        version: body.version,
        localId: rec.id,
      };
      renderRun(compiled);
      setStale(false);
      refreshCredits();
    } catch (e) {
      // the previous run stays on screen, dimmed, with the error above it
      showError(e);
      $('runStatus').textContent = 'Last run failed';
      // a dropped connection should show on the badge too, not only here
      refreshStatus({ quiet: true });
    } finally {
      state.busy = false;
      renderEnv();
    }
  }

  // Trader.dev sends ms timestamps; the charts want seconds.
  function normalizeCurve(rows, capital) {
    const out = [];
    let peak = capital;
    for (const r of rows || []) {
      const ms = Number(r.barTime !== undefined ? r.barTime : r.time);
      const equity = Number(r.equity);
      if (!Number.isFinite(ms) || !Number.isFinite(equity)) continue;
      peak = Math.max(peak, equity);
      const dd = Number(r.drawdown);
      out.push({
        time: Math.round(ms / 1000),
        equity,
        // Trader.dev reports drawdown in currency; show it as % off the peak.
        drawdown: Number.isFinite(dd) && peak > 0 ? -(dd / peak) * 100 : peak > 0 ? (equity / peak - 1) * 100 : 0,
      });
    }
    return out;
  }

  function showError(e) {
    state.lastError = e;
    $('errorBox').hidden = false;
    $('errorTitle').textContent = e.line ? `Strategy error on line ${e.line}` : 'Backtest failed';
    $('errorText').textContent = e.message;
    $('errorGoto').hidden = !e.line;
    setCodeMsg(e.line ? `Line ${e.line}: ${e.message}` : e.message, 'error');
    markGutterError(e.line);
  }

  function hideError() {
    state.lastError = null;
    $('errorBox').hidden = true;
    markGutterError(null);
  }

  function renderRun(compiled) {
    const run = state.run;
    const r = run.result;
    const from = Number(r.fromTs);
    const to = Number(r.toTs);
    $('runTitle').textContent = compiled.name;
    const paramText = Object.entries(paramsFor(run.localId, compiled)).map(([k, v]) => `${k}=${v}`).join(' ');
    $('runSubtitle').textContent = `${r.displaySymbol || r.symbol} · ${state.market.timeframe} · ${f.date(from / 1000)} → ${f.date(to / 1000)}${paramText ? ' · ' + paramText : ''}`;
    $('runStatus').textContent = `${f.int(r.barsEvaluated)} bars on Trader.dev${run.version ? ` · version ${run.version}` : ''}`;
    $('chipSymbol').textContent = r.displaySymbol || r.symbol;
    $('chipMeta').textContent = `${state.market.timeframe} · ${f.int(r.barsEvaluated)} bars · ${f.int(r.totalTrades)} trades`;

    for (const id of ['reportLink', 'reportLink2']) {
      const a = $(id);
      if (run.viewUrl) {
        a.href = run.viewUrl;
        a.hidden = false;
      } else a.hidden = true;
    }

    renderNotices();
    renderKpis(r, from, to);
    renderTrades();
    renderMonthly();
    BT.charts.render(run.curve, r.initialCapital);
    setPineMsg(`${state.pine.split('\n').length} lines. This is the script Trader.dev just ran.`);
  }

  // Trader.dev tells us when it changed the request (symbol remapped, dates
  // clamped, broker settings forced). Saying nothing would misreport the run.
  function renderNotices() {
    const body = state.run.body;
    const items = [];
    for (const adj of body.parityAdjustments || []) {
      if (adj.field === 'symbol' || adj.field === 'from' || adj.field === 'to') {
        items.push(`${adj.field}: ${adj.requested} → ${adj.applied}`);
      }
    }
    if (body.effectiveSymbol && state.market.symbol && body.effectiveSymbol !== state.market.symbol) {
      items.push(`Symbol ${state.market.symbol} is not covered, so it ran on ${body.effectiveSymbol}.`);
    }
    for (const w of body.result.warnings || body.warnings || []) {
      if (typeof w === 'string') items.push(w);
      else if (w && w.message) items.push(w.message);
    }
    for (const w of (body.coverage && body.coverage.warnings) || []) {
      items.push(typeof w === 'string' ? w : w.message || JSON.stringify(w));
    }
    for (const note of body.notes || []) {
      if (/cascade|unreliable/i.test(note)) items.push(note);
    }
    const list = $('noticeList');
    list.textContent = '';
    for (const text of items) {
      const li = document.createElement('li');
      li.textContent = text;
      list.appendChild(li);
    }
    $('noticeBox').hidden = !items.length;
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

  function renderKpis(r, fromMs, toMs) {
    const box = $('kpis');
    box.textContent = '';
    const yrs = BT.metrics.years(fromMs, toMs);
    const span = yrs < 1 ? `${Math.round(yrs * 365)} days` : `${yrs.toFixed(1)} years`;
    const dd = -Math.abs(r.maxDrawdownPct);
    // Compounding a few weeks out to a year says nothing, so don't pretend.
    const cagr = yrs >= 0.5 ? BT.metrics.cagr(r.initialCapital, r.finalEquity, fromMs, toMs) : null;
    box.append(
      kpi('Net return', f.pct(r.netProfitPct, 1), sign(r.netProfitPct), `${f.money(r.initialCapital)} → ${f.money(r.finalEquity)}`),
      cagr === null
        ? kpi('CAGR', '—', '', `${span} is too short to annualise`)
        : kpi('CAGR', f.pct(cagr, 1), sign(cagr), `annualised over ${span}`),
      kpi('Max drawdown', f.pct(dd, 1), dd < 0 ? 'neg' : '', `largest fall from a peak`),
      kpi('Sharpe', f.num(r.sharpeRatio, 2), '', `Sortino ${f.num(r.sortinoRatio, 2)}`),
      kpi('Profit factor', f.num(r.profitFactor, 2), '', `${f.signedMoney(r.avgTrade)} per trade`),
      kpi('Win rate', f.pct(r.winRatePct, 1, false), '', `avg win ${f.signedMoney(r.avgWinningTrade)} · loss ${f.signedMoney(r.avgLosingTrade)}`),
      kpi('Trades', f.int(r.totalTrades), '', `avg ${f.num(r.avgBarsInTrade, 1)} bars held`),
      kpi('Long / short', `${f.int(r.longTrades)} / ${f.int(r.shortTrades)}`, '', `${f.signedMoney(r.longNetProfit)} / ${f.signedMoney(r.shortNetProfit)}`)
    );
  }

  // Trader.dev reports per-trade run-up and drawdown in currency; as a share
  // of the position they are the same thing as MFE and MAE.
  const notional = (t) => Math.abs(Number(t.qty) * Number(t.entryPrice)) || 0;
  const bestPct = (t) => (notional(t) ? (Number(t.runup) / notional(t)) * 100 : NaN);
  const worstPct = (t) => (notional(t) ? -(Number(t.drawdown) / notional(t)) * 100 : NaN);

  function renderTrades() {
    const run = state.run;
    const r = run.result;
    const trades = run.trades;
    $('tradeCount').textContent = f.int(r.totalTrades);
    const wins = trades.filter((t) => t.profit > 0);
    const losses = trades.filter((t) => t.profit <= 0);
    const avg = (arr, fn) => (arr.length ? arr.reduce((a, t) => a + fn(t), 0) / arr.length : NaN);
    let streak = 0;
    let maxLossStreak = 0;
    for (const t of trades) {
      streak = t.profit <= 0 ? streak + 1 : 0;
      if (streak > maxLossStreak) maxLossStreak = streak;
    }
    const stats = [
      ['Net profit', f.signedMoney(r.netProfit)],
      ['Gross profit / loss', `${f.money(r.grossProfit)} / ${f.money(r.grossLoss)}`],
      ['Average trade', f.signedMoney(r.avgTrade)],
      ['Average win', f.signedMoney(r.avgWinningTrade)],
      ['Average loss', f.signedMoney(r.avgLosingTrade)],
      ['Win / loss size ratio', f.num(r.ratioAvgWinLoss, 2)],
      ['Best trade', f.signedMoney(r.largestWin)],
      ['Worst trade', f.signedMoney(r.largestLoss)],
      ['Average bars held', f.num(r.avgBarsInTrade, 1)],
      ['Bars held, wins / losses', `${f.num(r.avgBarsWinning, 1)} / ${f.num(r.avgBarsLosing, 1)}`],
      ['Longest losing streak', f.int(maxLossStreak)],
      ['Long trades (win rate)', `${f.int(r.longTrades)} (${f.pct(r.longTrades ? (r.longWinning / r.longTrades) * 100 : 0, 0, false)})`],
      ['Short trades (win rate)', `${f.int(r.shortTrades)} (${f.pct(r.shortTrades ? (r.shortWinning / r.shortTrades) * 100 : 0, 0, false)})`],
      ['Average worst / best point', `${f.pct(avg(trades, worstPct))} / ${f.pct(avg(trades, bestPct))}`],
      ['Commission paid', f.money(r.commissionPaid, 2)],
      ['Final equity', f.money(r.finalEquity, 2)],
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
    trades.slice(0, 3000).forEach((t, k) => {
      const tr = document.createElement('tr');
      tr.tabIndex = 0;
      const long = t.direction === 'long';
      const cells = [
        [String(t.seq || k + 1), 'num mono'],
        [null, ''],
        [f.date(t.entryTime / 1000), 'mono'],
        [f.price(t.entryPrice), 'num mono'],
        [f.date(t.exitTime / 1000), 'mono'],
        [f.price(t.exitPrice), 'num mono'],
        [f.int(t.barsInTrade), 'num mono'],
        [f.signedMoney(t.profit), `num mono ${sign(t.profit)}`],
        [f.pct(t.profitPct), `num mono ${sign(t.profitPct)}`],
        [f.pct(worstPct(t)), 'num mono'],
        [f.pct(bestPct(t)), 'num mono'],
        [f.money(t.commission, 2), 'num mono'],
      ];
      for (const [text, cls] of cells) {
        const td = document.createElement('td');
        td.className = cls;
        if (text === null) {
          const pill = document.createElement('span');
          pill.className = `side-pill ${long ? 'long' : 'short'}`;
          pill.textContent = long ? 'long' : 'short';
          td.appendChild(pill);
        } else td.textContent = text;
        tr.appendChild(td);
      }
      tr.addEventListener('click', () => showTrade(t));
      tr.addEventListener('keydown', (e) => e.key === 'Enter' && showTrade(t));
      frag.appendChild(tr);
    });
    tbody.appendChild(frag);
    $('tradesEmpty').hidden = trades.length > 0;
    renderExcursions(wins, losses);
  }

  function renderExcursions(wins, losses) {
    const trades = state.run.trades;
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
    const quantile = (vals, q) => {
      if (!vals.length) return NaN;
      const v = vals.slice().sort((a, b) => a - b);
      return v[Math.min(v.length - 1, Math.floor(q * (v.length - 1) + 1e-9))];
    };
    if (wins.length >= 5) {
      const worst90 = quantile(wins.map((t) => -worstPct(t)).filter(Number.isFinite), 0.9);
      say(['90% of winning trades never went more than ', [f.pct(-worst90)], ' against you. A stop just beyond that would have kept almost all of them.']);
    }
    if (losses.length >= 5) {
      const mfe = losses.map(bestPct).filter(Number.isFinite);
      const avgMfe = mfe.length ? mfe.reduce((a, x) => a + x, 0) / mfe.length : NaN;
      const upShare = mfe.length ? (mfe.filter((x) => x > 0.1).length / mfe.length) * 100 : NaN;
      say(['Losing trades were up ', [f.pct(avgMfe)], ' on average at their best; ', [f.pct(upShare, 0, false)], ' of them were in profit at some point.']);
    }
    if (!list.children.length) say(['Not enough trades yet to say where stops and targets belong.']);

    const pts = (fn, label) =>
      trades
        .map((t) => ({
          x: fn(t),
          y: Number(t.profitPct),
          win: t.profit > 0,
          trade: t,
          label: `#${t.seq} ${t.direction} ${f.date(t.entryTime / 1000)}: result ${f.pct(t.profitPct)}, ${label} ${f.pct(fn(t))}`,
        }))
        .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
    const onClick = (p) => showTrade(p.trade);
    BT.charts.scatter($('maeChart'), pts(worstPct, 'worst'), { xLabel: 'Worst point against you', yLabel: 'Trade result', onClick });
    BT.charts.scatter($('mfeChart'), pts(bestPct, 'best'), { xLabel: 'Best point in your favour', yLabel: 'Trade result', onClick });
  }

  function showTrade(t) {
    selectTab('equity');
    requestAnimationFrame(() => BT.charts.focusWindow(t.entryTime / 1000, t.exitTime / 1000));
  }

  function heatColor(v, scale) {
    const style = getComputedStyle(document.documentElement);
    const rgb = style.getPropertyValue(v >= 0 ? '--heat-pos' : '--heat-neg').trim();
    const k = Math.min(Math.abs(v) / scale, 1);
    return { bg: `rgba(${rgb}, ${(0.12 + 0.78 * k).toFixed(3)})`, strong: k > 0.6 };
  }

  function renderMonthly() {
    const run = state.run;
    const rows = BT.metrics.monthly(
      run.curve.map((p) => ({ time: p.time * 1000, equity: p.equity })),
      run.result.initialCapital
    );
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
    const run = state.run;
    if (!run) return;
    const lines = ['seq,side,entry_time,entry_price,exit_time,exit_price,qty,bars,pnl,return_pct,worst_pct,best_pct,commission'];
    for (const t of run.trades) {
      lines.push([
        t.seq, t.direction, new Date(t.entryTime).toISOString(), t.entryPrice, new Date(t.exitTime).toISOString(), t.exitPrice,
        t.qty, t.barsInTrade, Number(t.profit).toFixed(2), Number(t.profitPct).toFixed(4),
        Number.isFinite(worstPct(t)) ? worstPct(t).toFixed(4) : '', Number.isFinite(bestPct(t)) ? bestPct(t).toFixed(4) : '',
        Number(t.commission).toFixed(4),
      ].join(','));
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `trades_${run.localId}_${run.result.symbol}.csv`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 1000);
  }

  // ---------------------------------------------------------------- tabs

  const TABS = ['equity', 'trades', 'monthly', 'optimize', 'code', 'pine'];

  function selectTab(tab) {
    if (!TABS.includes(tab)) tab = 'equity';
    document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
    document.querySelectorAll('.tab-panel').forEach((p) => (p.hidden = p.dataset.panel !== tab));
    try {
      history.replaceState(null, '', `#${tab}`);
    } catch (e) {
      /* sandboxed: ignore */
    }
    if (tab === 'code') refreshGutter();
    if (tab === 'pine') refreshPineGutter();
    if (tab === 'equity' && state.run) BT.charts.fitAll();
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
    return rec.origin === 'new' ? 'unsaved strategy' : `strategies/${rec.id}.js`;
  }

  function openInEditor() {
    const rec = currentRec();
    if (!rec) return;
    editor().value = codeOf(rec);
    $('codeFile').textContent = fileLabel(rec);
    updateDirty();
    refreshGutter();
    setCodeMsg('Edits are kept as a draft until you save.');
    hideForms();
  }

  function updateDirty() {
    const rec = currentRec();
    $('dirtyDot').hidden = !isDirty(rec);
    $('codeRevertBtn').disabled = !rec || rec.origin === 'new' || state.drafts[rec.id] === undefined;
    $('codeDeleteBtn').hidden = !(rec && rec.origin === 'file');
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
    try {
      compileCached(codeOf(rec));
    } catch (e) {
      showError(e);
      return;
    }
    renderStrategySelect();
    renderParams();
    setupOptimizer();
    refreshPine();
    runBacktest();
  }

  async function saveCurrent() {
    const rec = currentRec();
    if (!rec) return;
    if (rec.origin === 'new') {
      showSaveAs('my_strategy');
      return;
    }
    await saveAs(rec.id, editor().value, true);
  }

  async function saveAs(id, code, overwrite) {
    try {
      BT.strategy.compile(code);
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
      const res = await fetch(`api/strategies/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Save failed (HTTP ${res.status})`);
    } catch (e) {
      setCodeMsg(e.message, 'error');
      return false;
    }
    const prev = currentRec();
    if (prev && prev.origin === 'new') state.strategies = state.strategies.filter((s) => s !== prev);
    let rec = state.strategies.find((s) => s.id === id);
    if (!rec) {
      rec = { id, code, origin: 'file' };
      state.strategies.push(rec);
    } else rec.code = code;
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
    refreshPine();
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
      const res = await fetch(`api/strategies/${encodeURIComponent(rec.id)}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' } });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Delete failed (HTTP ${res.status})`);
      }
      state.strategies = state.strategies.filter((s) => s !== rec);
    } catch (e) {
      setCodeMsg(e.message, 'error');
      return;
    }
    delete state.drafts[rec.id];
    delete state.remoteIds[rec.id];
    persistDrafts();
    persist();
    hideForms();
    const next = state.strategies.find((s) => s.id === DEFAULT_STRATEGY) || state.strategies[0];
    if (next) selectStrategy(next.id);
    setCodeMsg(`Removed ${rec.id}.`, 'ok');
  }

  function newStrategy() {
    let id = 'untitled';
    let k = 2;
    while (state.strategies.some((s) => s.id === id)) id = `untitled_${k++}`;
    state.strategies.push({ id, code: BT.strategy.TEMPLATE, origin: 'new' });
    delete state.drafts[id];
    selectStrategy(id);
    selectTab('code');
    setCodeMsg('New strategy from the template. Edit it, press Run, then Save.');
  }

  // ---------------------------------------------------------------- optimizer

  function sweepable() {
    try {
      const compiled = compileCached(codeOf(currentRec()));
      state.compiled = compiled;
      return BT.pine.sweepable(compiled, state.settings);
    } catch (e) {
      return [];
    }
  }

  function setupOptimizer() {
    const list = sweepable();
    const fill = (sel, withNone) => {
      const prev = sel.value;
      sel.textContent = '';
      if (withNone) {
        const o = document.createElement('option');
        o.value = '';
        o.textContent = 'None';
        sel.appendChild(o);
      }
      let group = null;
      let groupName = null;
      for (const p of list) {
        if (p.group !== groupName) {
          groupName = p.group;
          group = document.createElement('optgroup');
          group.label = groupName;
          sel.appendChild(group);
        }
        const o = document.createElement('option');
        o.value = p.name;
        o.textContent = p.label;
        group.appendChild(o);
      }
      if (list.some((p) => p.name === prev)) sel.value = prev;
      else if (!withNone) sel.value = list.length ? list[0].name : '';
      else sel.value = '';
    };
    fill($('optX'), false);
    fill($('optY'), true);
    axisDefaults('X');
    axisDefaults('Y');
    $('optResults').hidden = true;
    updateOptCount();
  }

  const axisParam = (axis) => sweepable().find((p) => p.name === $(`opt${axis}`).value) || null;

  function axisDefaults(axis) {
    const p = axisParam(axis);
    const ids = ['From', 'To', 'Step'].map((s) => $(`opt${axis}${s}`));
    ids.forEach((i) => (i.disabled = !p));
    if (!p) {
      ids.forEach((i) => (i.value = ''));
      return;
    }
    let step = p.step || 1;
    const span = p.max - p.min;
    if (span / step > 10) {
      const raw = span / 8;
      const mag = Math.pow(10, Math.floor(Math.log10(raw)));
      step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || raw;
      if (Number.isInteger(p.step)) step = Math.max(1, Math.round(step));
    }
    ids[0].value = p.min;
    ids[1].value = p.max;
    ids[2].value = +step.toPrecision(6);
  }

  function axisRange(axis) {
    const p = axisParam(axis);
    if (!p) return null;
    const from = Number($(`opt${axis}From`).value);
    const to = Number($(`opt${axis}To`).value);
    const step = Number($(`opt${axis}Step`).value);
    if (![from, to, step].every(Number.isFinite) || step <= 0 || to < from) throw new Error('Check the from, to and step values.');
    const count = Math.floor((to - from) / step + 1e-9) + 1;
    return { name: p.name, label: p.label, min: from, max: to, step, count };
  }

  const MAX_RUNS = 200;

  function updateOptCount() {
    try {
      const x = axisRange('X');
      const y = axisRange('Y');
      if (!x) throw new Error('Pick a parameter to sweep.');
      if (y && y.name === x.name) throw new Error('Pick two different parameters.');
      const n = x.count * (y ? y.count : 1);
      const tooMany = n > MAX_RUNS;
      $('optCount').textContent = tooMany
        ? `${f.int(n)} backtests. Use larger steps (max ${f.int(MAX_RUNS)}).`
        : `${f.int(n)} backtests · ${f.int(n)} credits`;
      $('optRunBtn').disabled = tooMany || !n || !state.server || !(state.traderdev && state.traderdev.ok);
    } catch (e) {
      $('optCount').textContent = e.message;
      $('optRunBtn').disabled = true;
    }
  }

  async function runOptimizer() {
    if (state.opt) return;
    let x;
    let y;
    let pine;
    try {
      x = axisRange('X');
      y = axisRange('Y');
      pine = buildPine();
    } catch (e) {
      $('optCount').textContent = e.message;
      return;
    }
    if (!state.market.symbol) {
      $('optCount').textContent = 'Enter a symbol first.';
      return;
    }
    const ranges = [x, y].filter(Boolean).map((a) => ({ name: a.name, min: a.min, max: a.max, step: a.step }));
    const btn = $('optRunBtn');
    const bar = $('optProgress');
    state.opt = true;
    btn.disabled = true;
    bar.hidden = false;
    $('optCount').textContent = `Sweeping ${f.int(x.count * (y ? y.count : 1))} combinations on Trader.dev…`;
    try {
      const out = await BT.traderdev.optimize({
        pineSource: pine,
        symbol: state.market.symbol,
        timeframe: state.market.timeframe,
        from: state.market.from || undefined,
        to: state.market.to || undefined,
        paramRanges: ranges,
        objective: $('optObjective').value,
        topN: Number($('optTopN').value) || 10,
        minTrades: Number($('optMinTrades').value) || 1,
        maxRuns: MAX_RUNS,
      });
      renderOptimizer(out, [x, y].filter(Boolean));
      refreshCredits();
    } catch (e) {
      $('optCount').textContent = e.message;
    } finally {
      state.opt = null;
      bar.hidden = true;
      updateOptCount();
    }
  }

  // Trader.dev returns the top combinations; the exact field names differ
  // between its own metrics blob and the summary, so read either.
  function optRows(out) {
    const rows = out.results || out.top || out.candidates || [];
    return rows.map((row) => {
      const m = row.metrics || row.result || row;
      return {
        params: row.params || row.paramValues || row.values || {},
        netProfitPct: Number(m.netProfitPct),
        sharpeRatio: Number(m.sharpeRatio),
        sortinoRatio: Number(m.sortinoRatio),
        profitFactor: Number(m.profitFactor),
        winRatePct: Number(m.winRatePct),
        maxDrawdownPct: Number(m.maxDrawdownPct),
        totalTrades: Number(m.totalTrades),
        score: Number(row.score !== undefined ? row.score : m[$('optObjective').value]),
      };
    });
  }

  const OBJ_LABELS = {
    sharpeRatio: 'Sharpe',
    netProfit: 'Net profit',
    profitFactor: 'Profit factor',
    sortinoRatio: 'Sortino',
    winRatePct: 'Win rate',
    maxDrawdownPct: 'Max drawdown',
  };

  function renderOptimizer(out, axes) {
    const rows = optRows(out);
    $('optResults').hidden = false;
    const objKey = $('optObjective').value;
    $('optHeatTitle').textContent = `Best by ${OBJ_LABELS[objKey]}${axes.length > 1 ? `, sweeping ${axes.map((a) => a.label).join(' and ')}` : `, sweeping ${axes[0].label}`}`;
    const ran = Number(out.totalRuns || out.runsCompleted);
    $('optCount').textContent = Number.isFinite(ran) ? `${f.int(ran)} backtests done` : 'Sweep done';

    const table = $('optTable');
    const thead = table.querySelector('thead');
    const tbody = table.querySelector('tbody');
    thead.textContent = '';
    tbody.textContent = '';
    const heads = ['#', ...axes.map((a) => a.label), OBJ_LABELS[objKey], 'Net return', 'Max DD', 'Trades'];
    const hr = document.createElement('tr');
    heads.forEach((h, k) => {
      const th = document.createElement('th');
      th.textContent = h;
      if (k > 0) th.className = 'num';
      hr.appendChild(th);
    });
    thead.appendChild(hr);
    rows.forEach((row, k) => {
      const tr = document.createElement('tr');
      if (k === 0) tr.className = 'best';
      const vals = [
        String(k + 1),
        ...axes.map((a) => {
          const v = row.params[a.name];
          return v === undefined ? '–' : String(v);
        }),
        f.num(row.score, 2),
        f.pct(row.netProfitPct, 1),
        f.pct(-Math.abs(row.maxDrawdownPct), 1),
        f.int(row.totalTrades),
      ];
      vals.forEach((v, j) => {
        const td = document.createElement('td');
        td.className = j > 0 ? 'num mono' : 'mono';
        td.textContent = v;
        tr.appendChild(td);
      });
      tr.tabIndex = 0;
      tr.addEventListener('click', () => applyRow(row));
      tr.addEventListener('keydown', (e) => e.key === 'Enter' && applyRow(row));
      tbody.appendChild(tr);
    });
    if (!rows.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = heads.length;
      td.textContent = 'No combination reached the minimum number of trades.';
      tr.appendChild(td);
      tbody.appendChild(tr);
    }
  }

  // Put one sweep result back into the sidebar: Pine input names map to a
  // strategy parameter (p_) or an execution setting (r_).
  function applyRow(row) {
    const id = state.strategyId;
    const changed = [];
    for (const [name, value] of Object.entries(row.params || {})) {
      const v = Number(value);
      if (!Number.isFinite(v)) continue;
      if (name.startsWith(BT.pine.PARAM_PREFIX)) {
        const key = name.slice(BT.pine.PARAM_PREFIX.length);
        state.params[id] = Object.assign({}, state.params[id], { [key]: v });
        changed.push(`${key}=${v}`);
      } else if (name.startsWith(BT.pine.SETTING_PREFIX)) {
        const key = name.slice(BT.pine.SETTING_PREFIX.length);
        state.settings[key] = v;
        changed.push(`${key}=${v}`);
      }
    }
    persist();
    renderParams();
    renderSettings();
    refreshPine();
    markStale();
    $('runStatus').textContent = changed.length ? `Applied ${changed.join(', ')} — press Run to backtest it` : 'Nothing to apply';
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
    bindMarket();
    bindSettings();

    $('strategySelect').addEventListener('change', (e) => selectStrategy(e.target.value));
    $('resetParamsBtn').addEventListener('click', () => {
      delete state.params[state.strategyId];
      persistSoon();
      renderParams();
      refreshPine();
      markStale();
    });
    $('editCodeBtn').addEventListener('click', () => {
      selectTab('code');
      editor().focus();
    });
    $('newStrategyBtn').addEventListener('click', newStrategy);
    $('runBtn').addEventListener('click', runBacktest);

    document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => selectTab(b.dataset.tab)));
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
      refreshPine();
      setCodeMsg('Changes discarded.');
    });
    $('codeDeleteBtn').addEventListener('click', () => {
      const rec = currentRec();
      hideForms();
      $('deleteText').textContent = `Delete strategies/${rec.id}.js? This removes the file.`;
      $('deleteConfirm').hidden = false;
    });
    $('deleteNo').addEventListener('click', hideForms);
    $('deleteYes').addEventListener('click', deleteCurrent);

    $('pineView').addEventListener('scroll', () => ($('pineGutter').scrollTop = $('pineView').scrollTop));
    $('pineCopyBtn').addEventListener('click', async () => {
      const text = $('pineView').value;
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
        setPineMsg('Copied.', 'ok');
      } catch (e) {
        $('pineView').select();
        setPineMsg('Press Ctrl/⌘ + C to copy the selection.', 'error');
      }
    });

    for (const id of ['optX', 'optY']) {
      $(id).addEventListener('change', () => {
        axisDefaults(id === 'optX' ? 'X' : 'Y');
        updateOptCount();
      });
    }
    for (const id of ['optXFrom', 'optXTo', 'optXStep', 'optYFrom', 'optYTo', 'optYStep']) $(id).addEventListener('input', updateOptCount);
    $('optRunBtn').addEventListener('click', runOptimizer);

    $('themeToggle').addEventListener('click', toggleTheme);
    $('envBadge').addEventListener('click', recheckEnv);
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onScheme = () => {
      BT.charts.retheme();
      if (state.run) renderMonthly();
    };
    if (mq.addEventListener) mq.addEventListener('change', onScheme);
    new MutationObserver(onScheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && document.activeElement !== editor()) {
        e.preventDefault();
        runBacktest();
      }
    });
  }

  async function boot() {
    applyTheme(saved.theme);
    BT.charts.init({ equity: 'equityChart', dd: 'ddChart', equityLegend: 'equityLegend', ddLegend: 'ddLegend' });
    bind();
    renderMarket();
    renderSettings();
    state.server = await detectServer();
    renderEnv();
    if (!state.server) {
      setLoadStatus('Backtests need the local server. Run python3 server.py and open http://localhost:8000.', true);
    }
    try {
      if (state.server) await loadStrategies();
    } catch (e) {
      setLoadStatus(`Could not load strategies: ${e.message}`, true);
    }
    if (!state.strategies.length) state.strategies.push({ id: 'untitled', code: BT.strategy.TEMPLATE, origin: 'new' });
    if (!state.strategies.some((s) => s.id === state.strategyId)) {
      state.strategyId = (state.strategies.find((s) => s.id === DEFAULT_STRATEGY) || state.strategies[0]).id;
    }
    renderStrategySelect();
    renderParams();
    openInEditor();
    setupOptimizer();
    refreshPine();
    const tab = (location.hash || '').replace('#', '');
    selectTab(TABS.includes(tab) ? tab : 'equity');
    if (state.server) await refreshStatus();
  }

  boot();
})();
