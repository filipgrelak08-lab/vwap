/*
 * Library tab: the strategies tested in research/ (research/library.json). Each card shows
 * the rules, how the rule did on the data it was picked on and on later data it never saw,
 * its trader.dev runs, and buttons to run it here or open its Pine script.
 */
(function (root) {
  'use strict';
  const BT = (root.BT = root.BT || {});
  const $ = (id) => document.getElementById(id);
  const VERDICTS = { recommended: 'Recommended', mixed: 'Mixed', failed: 'Didn’t hold up' };
  const lib = { server: false, selectTab: null, started: false, data: null, filter: 'all' };

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  const sign = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');

  async function load() {
    if (root.BT_LIBRARY) return root.BT_LIBRARY; // embedded by tools/build_standalone.py
    const res = await fetch('api/library');
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error((body && body.error) || `Could not load the library (HTTP ${res.status}).`);
    return body;
  }

  function table(head, rows) {
    const t = el('table', 'data-table lib-table');
    const tr = el('tr');
    for (const [text, cls] of head) tr.appendChild(el('th', cls, text));
    t.appendChild(el('thead')).appendChild(tr);
    const tb = t.appendChild(el('tbody'));
    for (const cells of rows) {
      const r = tb.appendChild(el('tr'));
      for (const c of cells) r.appendChild(c);
    }
    const wrap = el('div', 'table-wrap');
    wrap.appendChild(t);
    return wrap;
  }

  function cell(text, cls) {
    return el('td', cls || '', text);
  }

  function evidence(rows) {
    const f = BT.fmt;
    return table(
      [['Test', ''], ['Sharpe', 'num'], ['CAGR', 'num'], ['Max drawdown', 'num'], ['Beat buy and hold', 'num']],
      rows.map((r) => [
        cell(r.label),
        cell(f.num(r.sharpe, 2), 'num'),
        cell(f.pct(r.cagr, 1), `num ${sign(r.cagr)}`),
        cell(f.pct(r.maxDd, 1), 'num'),
        cell(r.beatsBh, 'num'),
      ])
    );
  }

  const triple = (p) => (p ? `${BT.fmt.pct(p.returnPct, 0)} · ${BT.fmt.num(p.sharpe, 2)} · ${BT.fmt.pct(p.maxDdPct, 0)}` : '–');

  function runs(s) {
    const f = BT.fmt;
    return table(
      [['Run', ''], ['Since 2022: return · Sharpe · max DD', 'num'], ['Buy and hold since 2022', 'num'], ['Whole run', 'num'], ['', '']],
      s.runs.map((r) => {
        const open = el('button', 'btn ghost small', 'Open');
        open.type = 'button';
        open.disabled = !lib.server;
        open.addEventListener('click', () => BT.traderdev.openResult(r));
        const bh = el('button', 'btn ghost small', 'Buy and hold');
        bh.type = 'button';
        bh.disabled = !lib.server || !r.bhId;
        bh.addEventListener('click', () => BT.traderdev.openResult({ id: r.bhId, name: `Buy and hold · ${r.label}`, symbol: r.symbol, timeframe: r.timeframe }));
        const btns = el('td', 'lib-run-btns');
        btns.append(open, bh);
        const after = r.after && r.bhAfter && r.after.sharpe > r.bhAfter.sharpe ? 'pos' : '';
        return [
          cell(r.label, 'mono'),
          cell(triple(r.after), `num ${after}`),
          cell(triple(r.bhAfter), 'num'),
          cell(`${f.pct(r.returnPct, 0)} · ${f.num(r.sharpe, 2)}`, 'num'),
          btns,
        ];
      })
    );
  }

  function card(s) {
    const c = el('article', 'card lib-card');
    c.dataset.verdict = s.verdict;
    const head = c.appendChild(el('div', 'card-head'));
    head.appendChild(el('h3', '', s.name));
    head.appendChild(el('span', `verdict ${s.verdict}`, VERDICTS[s.verdict] || s.verdict));
    c.appendChild(el('p', 'desc', s.summary));

    const body = c.appendChild(el('div', 'lib-body'));
    const left = body.appendChild(el('div', 'lib-rules'));
    left.appendChild(el('h4', '', 'Rules'));
    const ol = left.appendChild(el('ol'));
    for (const r of s.rules) ol.appendChild(el('li', '', r));
    if (s.notes) left.appendChild(el('p', 'hint', s.notes));
    if (s.source) {
      const p = left.appendChild(el('p', 'hint', 'Source: '));
      const a = p.appendChild(el('a', '', s.source.label));
      a.href = s.source.url;
      a.target = '_blank';
      a.rel = 'noopener';
    }
    const right = body.appendChild(el('div', 'lib-evidence'));
    right.appendChild(el('h4', '', 'How it tested'));
    right.appendChild(evidence(s.evidence));

    if (s.runs && s.runs.length) {
      const box = c.appendChild(el('div', 'lib-runs'));
      box.appendChild(el('h4', '', 'trader.dev runs · Bybit perpetuals · 0.05% per side · green = beat buy and hold on Sharpe'));
      box.appendChild(runs(s));
    }

    const actions = c.appendChild(el('div', 'btn-row lib-actions'));
    if (s.local) {
      const b = el('button', 'btn primary small', `Run here on ${s.local.data ? s.local.data.symbol : 'the loaded data'}`);
      b.type = 'button';
      b.addEventListener('click', () => BT.app.runLocal(s.local));
      actions.appendChild(b);
    }
    if (s.pine) {
      const b = el('button', 'btn small', `Open pine/${s.pine}.pine on trader.dev`);
      b.type = 'button';
      b.disabled = !lib.server;
      b.addEventListener('click', () => BT.traderdev.loadPine(s.pine));
      actions.appendChild(b);
    }
    if (!s.local && !s.pine) actions.appendChild(el('span', 'hint inline', 'Research only: this rule needs features the app doesn’t have.'));
    else if (s.local) actions.appendChild(el('span', 'hint inline', 'Runs with your Execution settings; the tests used 0.05% commission + 0.02% slippage per side.'));
    return c;
  }

  function render() {
    const d = lib.data || { strategies: [] };
    const list = $('libList');
    list.textContent = '';
    $('libEmpty').hidden = d.strategies.length > 0;
    $('libUpdated').textContent = d.updated ? `Updated ${d.updated}` : '';
    const method = $('libMethod');
    method.textContent = '';
    for (const m of d.method || []) method.appendChild(el('li', '', m));
    const counts = { all: d.strategies.length };
    for (const s of d.strategies) counts[s.verdict] = (counts[s.verdict] || 0) + 1;
    document.querySelectorAll('#libFilter button').forEach((b) => {
      const k = b.dataset.filter;
      b.setAttribute('aria-selected', String(k === lib.filter));
      b.querySelector('.count').textContent = counts[k] || 0;
    });
    for (const s of d.strategies) {
      if (lib.filter === 'all' || s.verdict === lib.filter) list.appendChild(card(s));
    }
  }

  function show() {
    if (lib.started) return;
    lib.started = true;
    load()
      .then((d) => {
        lib.data = d;
        render();
      })
      .catch((e) => {
        $('libEmpty').hidden = false;
        $('libEmpty').textContent = e.message;
      });
  }

  function init(opts) {
    lib.server = !!opts.server;
    lib.selectTab = opts.selectTab;
    document.querySelectorAll('#libFilter button').forEach((b) =>
      b.addEventListener('click', () => {
        lib.filter = b.dataset.filter;
        render();
      })
    );
  }

  BT.library = { init, show };
})(typeof window !== 'undefined' ? window : globalThis);
