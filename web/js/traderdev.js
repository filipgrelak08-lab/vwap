/*
 * trader.dev tab: connect an API key, run Pine scripts on trader.dev through the
 * local server, and look at the results (equity curve, trades) and past runs.
 * Everything goes through server.py; the browser never sees the API key.
 */
(function (root) {
  'use strict';
  const BT = (root.BT = root.BT || {});
  const $ = (id) => document.getElementById(id);
  const RUNS_KEY = 'vwaplab:traderdev:runs';
  const DRAFT_KEY = 'vwaplab:traderdev:draft';
  const MAX_RUNS = 50;
  const ULID_RE = /[0-9A-HJKMNP-TV-Z]{26}/i;

  const store = {
    get(key, fallback) {
      try {
        const raw = root.localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
      } catch (e) {
        return fallback;
      }
    },
    set(key, value) {
      try {
        root.localStorage.setItem(key, JSON.stringify(value));
      } catch (e) {
        /* storage unavailable */
      }
    },
  };

  const td = {
    server: false,
    kpi: null,
    started: false,
    connected: false,
    runs: store.get(RUNS_KEY, []),
    known: {}, // summaries of runs opened from the Library tab
    selectTab: null,
    templatesReady: null,
    shownId: null,
    busy: false,
  };

  // ---------------------------------------------------------------- helpers

  async function api(method, path, body) {
    let res;
    try {
      res = await fetch(path, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new Error('Could not reach the local server. Is server.py still running?');
    }
    const out = await res.json().catch(() => null);
    if (!res.ok) throw new Error((out && out.error) || `Request failed (HTTP ${res.status})`);
    return out;
  }

  // trader.dev reports minutes for intraday timeframes ("60"), letters otherwise ("1D")
  function tfLabel(tf) {
    const s = String(tf || '');
    if (!/^\d+$/.test(s)) return s;
    const n = Number(s);
    return n >= 60 && n % 60 === 0 ? `${n / 60}h` : `${n}m`;
  }

  const isIntraday = (tf) => /^\d+[mh]$/.test(tfLabel(tf));
  const when = (ms, tf) => BT.fmt.time(ms / 1000, { interval: isIntraday(tf) ? '1h' : '1d' });
  const sign = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');

  function setRunStatus(text, isError) {
    const el = $('tdRunStatus');
    el.textContent = text || '';
    el.classList.toggle('error', !!isError);
  }

  // ---------------------------------------------------------------- account

  function renderStatus(st) {
    td.connected = !!(st && st.connected);
    const chip = $('tdStatus');
    if (td.connected) {
      chip.dataset.state = 'on';
      const credits = Number.isFinite(st.credits) ? ` · ${BT.fmt.int(st.credits)} credits` : '';
      chip.textContent = `Connected as ${st.email || 'unknown'}${credits}`;
    } else {
      chip.dataset.state = st && st.error ? 'error' : 'off';
      chip.textContent = st && st.error ? st.error : 'Not connected';
    }
    const fromEnv = st && st.source === 'env';
    $('tdKeyForm').hidden = td.connected;
    $('tdConnectedRow').hidden = !td.connected;
    $('tdDisconnectBtn').hidden = fromEnv; // can't forget a key that comes from the environment
    updateRunButton();
  }

  async function refreshStatus() {
    $('tdStatus').textContent = 'Checking…';
    try {
      renderStatus(await api('GET', 'api/traderdev/status'));
    } catch (e) {
      renderStatus({ connected: false, error: e.message });
    }
  }

  async function connect(e) {
    e.preventDefault();
    const key = $('tdKey').value.trim();
    if (!key) return;
    $('tdConnectBtn').disabled = true;
    $('tdStatus').textContent = 'Checking key…';
    try {
      renderStatus(await api('PUT', 'api/traderdev/key', { key }));
      $('tdKey').value = '';
    } catch (err) {
      renderStatus({ connected: false, error: err.message });
    } finally {
      $('tdConnectBtn').disabled = false;
    }
  }

  async function disconnect() {
    try {
      renderStatus(await api('DELETE', 'api/traderdev/key'));
    } catch (err) {
      renderStatus({ connected: false, error: err.message });
    }
  }

  // ---------------------------------------------------------------- Pine editor

  function saveDraft() {
    store.set(DRAFT_KEY, {
      pine: $('tdPine').value,
      symbol: $('tdSymbol').value,
      timeframe: $('tdTimeframe').value,
      from: $('tdFrom').value,
      to: $('tdTo').value,
      name: $('tdName').value,
    });
  }

  function refreshGutter() {
    const lines = $('tdPine').value.split('\n').length;
    let s = '';
    for (let i = 1; i <= lines; i++) s += i + '\n';
    $('tdGutter').textContent = s;
    $('tdGutter').scrollTop = $('tdPine').scrollTop;
  }

  async function loadTemplates() {
    const sel = $('tdTemplate');
    sel.textContent = '';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Choose a script in pine/…';
    sel.appendChild(placeholder);
    let scripts = [];
    try {
      scripts = (await api('GET', 'api/pine')).scripts || [];
    } catch (e) {
      /* no pine/ folder: the editor still works */
    }
    td.templates = {};
    for (const s of scripts) {
      td.templates[s.id] = s.code;
      const o = document.createElement('option');
      o.value = s.id;
      o.textContent = `pine/${s.id}.pine`;
      sel.appendChild(o);
    }
    if (!$('tdPine').value.trim() && scripts.length) useTemplate(scripts[0].id);
  }

  function useTemplate(id) {
    const code = td.templates && td.templates[id];
    if (code === undefined) return;
    const current = $('tdPine').value;
    if (current.trim() && current !== code && !root.confirm(`Replace the script in the editor with pine/${id}.pine?`)) {
      $('tdTemplate').value = '';
      return;
    }
    $('tdPine').value = code;
    // daily templates are named for it; pick a sensible default timeframe
    if (/1D chart/.test(code)) $('tdTimeframe').value = '1D';
    else if (/1h chart/.test(code)) $('tdTimeframe').value = '1h';
    refreshGutter();
    saveDraft();
  }

  // ---------------------------------------------------------------- running

  function updateRunButton() {
    $('tdRunBtn').disabled = !td.server || !td.connected || td.busy;
    $('tdRunBtn').title = !td.connected ? 'Connect your trader.dev account first' : '';
  }

  function recordFrom(out, name) {
    const r = out.result || {};
    return {
      id: out.resultId,
      strategyId: out.strategyId,
      name: name || r.notes || 'Pine strategy',
      symbol: r.displaySymbol || r.symbol,
      timeframe: tfLabel(r.timeframe),
      fromTs: r.fromTs,
      toTs: r.toTs,
      returnPct: r.netProfitPct,
      maxDdPct: r.maxDrawdownPct,
      sharpe: r.sharpeRatio,
      trades: r.totalTrades,
      profitFactor: r.profitFactor,
      winRatePct: r.winRatePct,
      commission: r.commissionPaid,
      initialCapital: r.initialCapital,
      finalEquity: r.finalEquity,
      ranAt: r.createdAt || Date.now(),
    };
  }

  function strategyTitle(pine) {
    const m = /strategy\(\s*(?:title\s*=\s*)?["']([^"']+)["']/.exec(pine);
    return m ? m[1] : null;
  }

  async function run() {
    const pine = $('tdPine').value;
    if (!pine.trim()) return setRunStatus('Paste a Pine script or pick one from pine/ first.', true);
    td.busy = true;
    updateRunButton();
    setRunStatus('Running on trader.dev… usually a few seconds.');
    const name = $('tdName').value.trim();
    try {
      const out = await api('POST', 'api/traderdev/backtest', {
        pineSource: pine,
        symbol: $('tdSymbol').value.trim(),
        timeframe: $('tdTimeframe').value,
        from: $('tdFrom').value,
        to: $('tdTo').value,
        name,
      });
      const rec = recordFrom(out, name || strategyTitle(pine));
      td.runs = [rec].concat(td.runs.filter((x) => x.id !== rec.id)).slice(0, MAX_RUNS);
      store.set(RUNS_KEY, td.runs);
      const adjusted = (out.parityAdjustments || []).filter((a) => a.field === 'from' || a.field === 'symbol');
      const note = adjusted.length ? ` trader.dev changed: ${adjusted.map((a) => `${a.field} → ${a.applied}`).join(', ')}.` : '';
      await openRun(rec.id, `Done in ${((out.durationMs || 0) / 1000).toFixed(1)} s. 1 credit used.${note}`);
      refreshStatus();
    } catch (e) {
      setRunStatus(e.message, true);
    } finally {
      td.busy = false;
      updateRunButton();
    }
  }

  // ---------------------------------------------------------------- results

  function summaryFromBlob(id, blob) {
    const eq = blob.equity || [];
    const first = eq[0] || [0, 0, 0];
    const initial = first[1] - (first[2] || 0);
    const final = eq.length ? eq[eq.length - 1][1] : initial;
    let peak = -Infinity;
    let dd = 0;
    for (const p of eq) {
      peak = Math.max(peak, p[1]);
      dd = Math.max(dd, (1 - p[1] / peak) * 100);
    }
    const closed = (blob.trades || []).filter((t) => !t.isOpen);
    const won = closed.filter((t) => t.profit > 0);
    const gross = won.reduce((a, t) => a + t.profit, 0);
    const lost = -closed.filter((t) => t.profit < 0).reduce((a, t) => a + t.profit, 0);
    return {
      id,
      name: `trader.dev result ${id.slice(-6)}`,
      symbol: '',
      timeframe: '',
      fromTs: eq.length ? eq[0][0] : null,
      toTs: eq.length ? eq[eq.length - 1][0] : null,
      returnPct: initial ? (final / initial - 1) * 100 : NaN,
      maxDdPct: dd,
      sharpe: NaN,
      trades: closed.length,
      profitFactor: lost ? gross / lost : NaN,
      winRatePct: closed.length ? (won.length / closed.length) * 100 : NaN,
      commission: (blob.trades || []).reduce((a, t) => a + (t.commission || 0), 0),
      initialCapital: initial,
      finalEquity: final,
    };
  }

  function renderResult(rec, blob) {
    const f = BT.fmt;
    $('tdResultCard').hidden = false;
    $('tdResultTitle').textContent = rec.name;
    const market = [rec.symbol, tfLabel(rec.timeframe)].filter(Boolean).join(' · ');
    const period = rec.fromTs ? `${f.date(rec.fromTs / 1000)} → ${f.date(rec.toTs / 1000)}` : '';
    $('tdResultSub').textContent = [market, period, `result ${rec.id}`].filter(Boolean).join(' · ');
    $('tdReportLink').href = blob.reportUrl;

    const years = rec.fromTs && rec.toTs ? (rec.toTs - rec.fromTs) / (365.25 * 864e5) : NaN;
    const cagr = years > 0 && rec.returnPct > -100 ? (Math.pow(1 + rec.returnPct / 100, 1 / years) - 1) * 100 : NaN;
    const box = $('tdKpis');
    box.textContent = '';
    box.append(
      td.kpi('Net return', f.pct(rec.returnPct, 1), sign(rec.returnPct), `${f.money(rec.initialCapital)} → ${f.money(rec.finalEquity)}`),
      td.kpi('CAGR', f.pct(cagr, 1), sign(cagr), Number.isFinite(years) ? `over ${years.toFixed(1)} years` : ''),
      td.kpi('Max drawdown', f.pct(-rec.maxDdPct, 1), rec.maxDdPct > 0 ? 'neg' : '', 'peak to trough'),
      td.kpi('Sharpe', f.num(rec.sharpe, 2), '', Number.isFinite(rec.sharpe) ? 'as reported by trader.dev' : 'not in the result file'),
      td.kpi('Profit factor', f.num(rec.profitFactor, 2), '', 'gross profit ÷ gross loss'),
      td.kpi('Win rate', f.pct(rec.winRatePct, 1, false), '', 'of closed trades'),
      td.kpi('Trades', f.int(rec.trades), '', blob.trades.some((t) => t.isOpen) ? 'plus one still open' : 'closed trades'),
      td.kpi('Fees paid', f.money(rec.commission), '', '0.05% per side')
    );

    BT.charts.line(
      $('tdEquity'),
      blob.equity.filter((p) => Number.isFinite(p[1])).map((p) => ({ t: p[0] / 1000, y: p[1] })),
      { label: `Equity of ${rec.name}`, base: rec.initialCapital, format: (v) => f.money(v) }
    );

    const tbody = $('tdTrades').querySelector('tbody');
    tbody.textContent = '';
    $('tdTradeCount').textContent = f.int(blob.trades.length);
    const frag = document.createDocumentFragment();
    for (const t of blob.trades) {
      const tr = document.createElement('tr');
      const cells = [
        [t.seq, ''],
        [t.direction === 'short' ? 'Short' : 'Long', ''],
        [when(t.entryTime, rec.timeframe), 'mono'],
        [f.price(t.entryPrice), 'num'],
        [t.isOpen ? 'open' : when(t.exitTime, rec.timeframe), 'mono'],
        [t.isOpen ? '–' : f.price(t.exitPrice), 'num'],
        [f.signedMoney(t.profit), `num ${sign(t.profit)}`],
        [f.pct(t.profitPct), `num ${sign(t.profitPct)}`],
        [f.money(t.commission, 2), 'num'],
      ];
      for (const [text, cls] of cells) {
        const td_ = document.createElement('td');
        td_.className = cls;
        td_.textContent = text;
        tr.appendChild(td_);
      }
      frag.appendChild(tr);
    }
    tbody.appendChild(frag);
    td.shownId = rec.id;
    renderRuns();
  }

  async function openRun(id, doneMessage) {
    const known = td.known[id];
    const rec = td.runs.find((r) => r.id === id) || (known && Number.isFinite(known.returnPct) ? known : null);
    setRunStatus(`Loading result ${id}…`);
    // a brand-new result file can take a moment to appear
    for (let attempt = 0; ; attempt++) {
      try {
        const blob = await api('GET', `api/traderdev/results/${encodeURIComponent(id)}`);
        // no stored summary: work it out from the result file, keeping any name we were given
        const labels = {};
        for (const k of ['name', 'symbol', 'timeframe']) if (known && known[k]) labels[k] = known[k];
        renderResult(rec || Object.assign(summaryFromBlob(id, blob), labels), blob);
        setRunStatus(doneMessage || '');
        $('tdResultCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      } catch (e) {
        if (attempt < 3 && /No trader\.dev result/.test(e.message)) {
          await new Promise((r) => setTimeout(r, 1500));
          continue;
        }
        setRunStatus(e.message, true);
        return;
      }
    }
  }

  function renderRuns() {
    const f = BT.fmt;
    const tbody = $('tdRuns').querySelector('tbody');
    tbody.textContent = '';
    if (!td.runs.length) {
      const tr = document.createElement('tr');
      const c = document.createElement('td');
      c.colSpan = 8;
      c.className = 'empty';
      c.textContent = 'No runs from this browser yet. The tested strategies and their trader.dev runs are in the Library tab.';
      tr.appendChild(c);
      tbody.appendChild(tr);
    }
    for (const r of td.runs) {
      const tr = document.createElement('tr');
      if (r.id === td.shownId) tr.className = 'best';
      const cells = [
        [r.name, ''],
        [[r.symbol, tfLabel(r.timeframe)].filter(Boolean).join(' · '), 'mono'],
        [r.fromTs ? `${f.date(r.fromTs / 1000)} → ${f.date(r.toTs / 1000)}` : '–', 'mono'],
        [f.pct(r.returnPct, 1), `num ${sign(r.returnPct)}`],
        [Number.isFinite(r.maxDdPct) ? f.pct(-r.maxDdPct, 1) : '–', 'num'],
        [f.num(r.sharpe, 2), 'num'],
        [f.int(r.trades), 'num'],
        [r.ranAt ? f.date(r.ranAt / 1000) : '–', 'mono'],
      ];
      for (const [text, cls] of cells) {
        const c = document.createElement('td');
        c.className = cls;
        c.textContent = text;
        tr.appendChild(c);
      }
      tr.title = 'Show this run';
      tr.addEventListener('click', () => td.server && openRun(r.id));
      tbody.appendChild(tr);
    }
  }

  function openFromInput(e) {
    e.preventDefault();
    const m = ULID_RE.exec($('tdOpenId').value.trim());
    if (!m) return setRunStatus('Paste a result ID (26 characters) or a trader.dev report link.', true);
    openRun(m[0].toUpperCase());
  }

  // ---------------------------------------------------------------- wiring

  function bind() {
    const draft = store.get(DRAFT_KEY, {});
    const today = new Date().toISOString().slice(0, 10);
    $('tdPine').value = draft.pine || '';
    $('tdSymbol').value = draft.symbol || 'BTCUSDT';
    $('tdTimeframe').value = draft.timeframe || '1D';
    $('tdFrom').value = draft.from || '2022-01-01';
    $('tdTo').value = draft.to || today;
    $('tdName').value = draft.name || '';
    refreshGutter();

    $('tdKeyForm').addEventListener('submit', connect);
    $('tdDisconnectBtn').addEventListener('click', disconnect);
    $('tdRefreshBtn').addEventListener('click', refreshStatus);
    $('tdTemplate').addEventListener('change', (e) => e.target.value && useTemplate(e.target.value));
    $('tdPine').addEventListener('input', () => {
      refreshGutter();
      saveDraft();
    });
    $('tdPine').addEventListener('scroll', () => ($('tdGutter').scrollTop = $('tdPine').scrollTop));
    for (const id of ['tdSymbol', 'tdTimeframe', 'tdFrom', 'tdTo', 'tdName']) $(id).addEventListener('change', saveDraft);
    $('tdRunBtn').addEventListener('click', run);
    $('tdOpenForm').addEventListener('submit', openFromInput);
  }

  // ---------------------------------------------------------------- used by the Library tab

  function openResult(rec) {
    td.known[rec.id] = rec;
    td.selectTab('traderdev');
    if (td.server) openRun(rec.id);
  }

  async function loadPine(id) {
    td.selectTab('traderdev');
    if (!td.server) return;
    await td.templatesReady;
    $('tdTemplate').value = id;
    useTemplate(id);
    $('tdPine').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function init(opts) {
    td.server = !!opts.server;
    td.kpi = opts.kpi;
    td.selectTab = opts.selectTab;
    bind();
    renderRuns();
    $('tdServerNotice').hidden = td.server;
    for (const id of ['tdKey', 'tdConnectBtn', 'tdTemplate', 'tdOpenId']) $(id).disabled = !td.server;
    updateRunButton();
  }

  // first time the tab is opened: check the account and load pine/ scripts
  function show() {
    if (td.started || !td.server) return;
    td.started = true;
    refreshStatus();
    td.templatesReady = loadTemplates();
  }

  BT.traderdev = { init, show, tfLabel, openResult, loadPine };
})(typeof window !== 'undefined' ? window : globalThis);
