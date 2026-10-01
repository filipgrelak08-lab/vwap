/*
 * Market data: synthetic samples, CSV parsing and loaders for the local
 * server's Yahoo Finance / Binance proxies.
 *
 * A dataset is column-oriented:
 *   { symbol, interval, source, time[], open[], high[], low[], close[], volume[], length }
 * `time` is UNIX seconds expressed as exchange wall-clock time ("09:30" is
 * stored as 09:30 UTC), so session/day logic never needs a timezone.
 */
(function (root) {
  'use strict';
  const BT = (root.BT = root.BT || {});
  const DAY = 86400;

  // ---------------------------------------------------------------- helpers

  function fromBars(rows, meta) {
    const clean = [];
    for (const r of rows) {
      let [t, o, h, l, c, v] = r.map(Number);
      if (![t, o, h, l, c].every(Number.isFinite) || c <= 0) continue;
      h = Math.max(h, o, c);
      l = Math.min(l, o, c);
      clean.push([t, o, h, l, c, Number.isFinite(v) && v > 0 ? v : 0]);
    }
    clean.sort((a, b) => a[0] - b[0]);
    const dedup = [];
    for (const r of clean) {
      if (dedup.length && dedup[dedup.length - 1][0] === r[0]) dedup[dedup.length - 1] = r;
      else dedup.push(r);
    }
    const col = (k) => dedup.map((r) => r[k]);
    const data = Object.assign({ symbol: 'DATA', source: 'csv' }, meta || {}, {
      time: col(0), open: col(1), high: col(2), low: col(3), close: col(4), volume: col(5),
      length: dedup.length,
    });
    if (!data.interval) data.interval = detectInterval(data.time);
    return data;
  }

  function detectInterval(time) {
    if (time.length < 2) return '?';
    const diffs = [];
    for (let i = 1; i < Math.min(time.length, 500); i++) diffs.push(time[i] - time[i - 1]);
    diffs.sort((a, b) => a - b);
    const d = diffs[Math.floor(diffs.length / 2)];
    if (d >= 28 * DAY) return '1mo';
    if (d >= 6 * DAY) return '1wk';
    if (d >= DAY) return '1d';
    if (d % 3600 === 0) return `${d / 3600}h`;
    if (d % 60 === 0) return `${d / 60}m`;
    return `${d}s`;
  }

  function filterRange(data, fromStr, toStr) {
    const from = fromStr ? Date.parse(fromStr + 'T00:00:00Z') / 1000 : -Infinity;
    const to = toStr ? Date.parse(toStr + 'T00:00:00Z') / 1000 + DAY : Infinity;
    let a = 0;
    while (a < data.length && data.time[a] < from) a++;
    let b = data.length;
    while (b > a && data.time[b - 1] >= to) b--;
    if (a === 0 && b === data.length) return data;
    return BT.engine.sliceData(data, a, b);
  }

  // ---------------------------------------------------------------- synthetic samples

  function rng(seed) {
    let a = seed >>> 0;
    const next = () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    let spare = null;
    next.normal = () => {
      if (spare !== null) {
        const s = spare;
        spare = null;
        return s;
      }
      let u = 0;
      while (u === 0) u = next();
      const v = next();
      const r = Math.sqrt(-2 * Math.log(u));
      spare = r * Math.sin(2 * Math.PI * v);
      return r * Math.cos(2 * Math.PI * v);
    };
    return next;
  }

  // Build one OHLC bar that opens at `open` and closes at `close`, with a
  // Brownian-bridge path in between to place a realistic high and low.
  function bridgeBar(rand, open, close, sigma, steps) {
    const walk = [0];
    for (let k = 1; k <= steps; k++) walk.push(walk[k - 1] + (sigma / Math.sqrt(steps)) * rand.normal());
    const total = Math.log(close / open);
    let hi = Math.max(open, close);
    let lo = Math.min(open, close);
    for (let k = 1; k < steps; k++) {
      const f = k / steps;
      const p = open * Math.exp(walk[k] - f * walk[steps] + f * total);
      if (p > hi) hi = p;
      if (p < lo) lo = p;
    }
    return [open, hi, lo, close];
  }

  // US-equity-like 5 minute bars (09:30-16:00): mostly range days that rotate
  // around a drifting fair value, plus some trend days.
  function sampleIntraday() {
    const rand = rng(20260504);
    const rows = [];
    let day = Date.UTC(2026, 4, 4) / 1000; // Monday 2026-05-04
    let price = 182.4;
    let sessions = 0;
    while (sessions < 60) {
      const dow = (Math.floor(day / DAY) + 4) % 7;
      if (dow !== 0 && dow !== 6) {
        price *= Math.exp(0.006 * rand.normal()); // overnight gap
        const trendDay = rand() < 0.3;
        const dayDrift = trendDay ? (rand() < 0.5 ? -1 : 1) * (0.006 + 0.01 * rand()) : 0.002 * rand.normal();
        const volMult = Math.exp(0.3 * rand.normal());
        let fair = price;
        let dev = 0;
        for (let b = 0; b < 78; b++) {
          const t = day + 9.5 * 3600 + b * 300;
          const u = 1 + 1.6 * Math.exp(-b / 6) + 0.9 * Math.exp(-(77 - b) / 5); // U-shaped activity
          const sigma = 0.0012 * volMult * Math.sqrt(u);
          fair *= Math.exp(dayDrift / 78 + (trendDay ? 0.5 : 0.3) * sigma * rand.normal());
          dev = dev * (trendDay ? 0.95 : 0.92) + 0.8 * sigma * rand.normal(); // rotation around fair value
          const close = fair * Math.exp(dev);
          const bar = bridgeBar(rand, price, close, sigma * 0.9, 8);
          const vol = Math.round(42000 * u * Math.exp(0.4 * rand.normal()) * (1 + 80 * Math.abs(Math.log(close / price))));
          rows.push([t, bar[0], bar[1], bar[2], bar[3], vol]);
          price = close;
        }
        sessions++;
      }
      day += DAY;
    }
    return fromBars(rows, { symbol: 'SYNTH', name: 'Synthetic stock · 5-minute', interval: '5m', source: 'sample', synthetic: true });
  }

  // Daily bars with bull / bear / sideways regimes and volatility clustering.
  function sampleDaily() {
    const rand = rng(1801);
    const rows = [];
    const regimes = [
      { mu: 0.0008, sigma: 0.009 },
      { mu: -0.001, sigma: 0.016 },
      { mu: 0.0001, sigma: 0.008 },
    ];
    let regime = 0;
    let volState = 1;
    let price = 48.2;
    let day = Date.UTC(2018, 0, 2) / 1000;
    const end = Date.UTC(2026, 8, 30) / 1000;
    while (day <= end) {
      const dow = (Math.floor(day / DAY) + 4) % 7;
      if (dow !== 0 && dow !== 6) {
        if (rand() < 1 / 180) regime = rand() < 0.5 ? 0 : rand() < 0.5 ? 1 : 2;
        const g = regimes[regime];
        const z = rand.normal();
        volState = 0.93 * volState + 0.07 * (0.6 + 0.5 * z * z);
        const sigma = g.sigma * volState;
        const open = price * Math.exp(0.25 * sigma * rand.normal());
        const close = open * Math.exp(g.mu + sigma * rand.normal());
        const bar = bridgeBar(rand, open, close, sigma, 10);
        const vol = Math.round(3.1e6 * volState * Math.exp(0.3 * rand.normal()));
        rows.push([day, bar[0], bar[1], bar[2], bar[3], vol]);
        price = close;
      }
      day += DAY;
    }
    return fromBars(rows, { symbol: 'SYNTH', name: 'Synthetic stock · daily', interval: '1d', source: 'sample', synthetic: true });
  }

  // 24/7 hourly bars, crypto-like volatility.
  function sampleHourly() {
    const rand = rng(424242);
    const rows = [];
    let price = 61250;
    let t = Date.UTC(2025, 9, 1) / 1000;
    let mu = 0;
    let volState = 1;
    for (let k = 0; k < 24 * 365; k++) {
      if (rand() < 1 / 300) mu = 0.00012 * rand.normal();
      const z = rand.normal();
      volState = 0.97 * volState + 0.03 * (0.5 + 0.6 * z * z);
      const hour = (t / 3600) % 24;
      const season = 1 + 0.35 * Math.sin(((hour - 8) / 24) * 2 * Math.PI);
      const sigma = 0.005 * volState * season;
      const close = price * Math.exp(mu + sigma * rand.normal());
      const bar = bridgeBar(rand, price, close, sigma, 8);
      rows.push([t, bar[0], bar[1], bar[2], bar[3], +(820 * season * volState * Math.exp(0.4 * rand.normal())).toFixed(3)]);
      price = close;
      t += 3600;
    }
    return fromBars(rows, { symbol: 'SYNTH-USD', name: 'Synthetic crypto · 1-hour (24/7)', interval: '1h', source: 'sample', synthetic: true });
  }

  const SAMPLES = {
    intraday: { label: 'Synthetic stock · 5-minute · 60 sessions', make: sampleIntraday },
    daily: { label: 'Synthetic stock · daily · 2018–2026', make: sampleDaily },
    hourly: { label: 'Synthetic crypto · 1-hour · 24/7 · 1 year', make: sampleHourly },
  };
  const sampleCache = {};
  function sample(key) {
    if (!SAMPLES[key]) throw new Error(`Unknown sample "${key}"`);
    return sampleCache[key] || (sampleCache[key] = SAMPLES[key].make());
  }

  // ---------------------------------------------------------------- CSV

  function splitLine(line, delim) {
    const out = [];
    let cur = '';
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) {
        if (ch === '"') {
          if (line[i + 1] === '"') {
            cur += '"';
            i++;
          } else q = false;
        } else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === delim) {
        out.push(cur);
        cur = '';
      } else cur += ch;
    }
    out.push(cur);
    return out.map((s) => s.trim());
  }

  function parseNumber(s, delim) {
    if (s === undefined) return NaN;
    let v = String(s).trim().replace(/^\$/, '');
    if (!v || /^(null|nan|n\/a|-)$/i.test(v)) return NaN;
    if (delim !== ',' && /^-?\d+,\d+$/.test(v)) v = v.replace(',', '.'); // decimal comma
    else if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(v)) v = v.replace(/,/g, ''); // thousands separators
    return Number(v);
  }

  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

  // Parse a timestamp into "wall clock as UTC" seconds. Timezone suffixes are ignored on purpose.
  function parseTime(raw) {
    const s = String(raw).trim();
    if (/^\d+(\.\d+)?$/.test(s)) {
      const x = Number(s);
      if (/^\d{8}$/.test(s)) return Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)) / 1000;
      if (x > 1e14) return Math.floor(x / 1e6); // microseconds
      if (x > 1e11) return Math.floor(x / 1000); // milliseconds
      if (x > 1e8) return Math.floor(x);
      return NaN;
    }
    let m;
    let y, mo, d;
    let rest = '';
    if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(.*)$/))) {
      [y, mo, d, rest] = [+m[1], +m[2], +m[3], m[4]];
    } else if ((m = s.match(/^(\d{1,2})([/.-])(\d{1,2})\2(\d{2,4})(.*)$/))) {
      let a = +m[1];
      let b = +m[3];
      y = +m[4];
      if (y < 100) y += 2000;
      // dots are day-first (European); slashes are month-first unless the first number can't be a month
      if (m[2] === '.' || a > 12) [d, mo] = [a, b];
      else [mo, d] = [a, b];
      rest = m[5];
    } else if ((m = s.match(/^(\d{1,2})[ -]([A-Za-z]{3})[a-z]*[ -](\d{2,4})(.*)$/))) {
      d = +m[1];
      mo = MONTHS[m[2].toLowerCase()];
      y = +m[3] < 100 ? +m[3] + 2000 : +m[3];
      rest = m[4];
    } else if ((m = s.match(/^([A-Za-z]{3})[a-z]* (\d{1,2}),? (\d{4})(.*)$/))) {
      mo = MONTHS[m[1].toLowerCase()];
      d = +m[2];
      y = +m[3];
      rest = m[4];
    } else return NaN;
    let hh = 0;
    let mm = 0;
    let ss = 0;
    const tm = rest.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*([AaPp][Mm])?/);
    if (tm) {
      hh = +tm[1];
      mm = +tm[2];
      ss = tm[3] ? +tm[3] : 0;
      if (tm[4]) {
        const pm = /p/i.test(tm[4]);
        if (pm && hh < 12) hh += 12;
        if (!pm && hh === 12) hh = 0;
      }
    }
    if (!mo || mo > 12 || !d || d > 31) return NaN;
    return Date.UTC(y, mo - 1, d, hh, mm, ss) / 1000;
  }

  function parseCSV(text, name) {
    const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 2) throw new Error('The CSV file is empty or has only one line.');
    const first = lines[0];
    const delim = [',', ';', '\t', '|'].sort((a, b) => first.split(b).length - first.split(a).length)[0];
    const head = splitLine(first, delim).map((h) => h.toLowerCase().replace(/[^a-z0-9/ ]/g, '').trim());
    const hasHeader = head.some((h) => /[a-z]/.test(h)) && !Number.isFinite(parseTime(splitLine(first, delim)[0]));
    const find = (...names) => head.findIndex((h) => names.includes(h));
    let col;
    if (hasHeader) {
      col = {
        date: find('date', 'datetime', 'date time', 'date/time', 'timestamp', 'time', 'open time', 'opentime', 'gmt time', 'local time', 'day', 'unix', 'unix timestamp'),
        time: -1,
        open: find('open', 'o', 'open price'),
        high: find('high', 'h', 'high price'),
        low: find('low', 'l', 'low price'),
        close: find('close', 'c', 'close price', 'last', 'price', 'close/last'),
        adj: find('adj close', 'adjclose', 'adj_close', 'adjusted close'),
        volume: head.findIndex((h) => h === 'v' || h === 'vol' || /^volume/.test(h)),
      };
      // separate Date + Time columns
      const dIdx = find('date', 'day');
      const tIdx = find('time');
      if (dIdx >= 0 && tIdx >= 0 && dIdx !== tIdx) {
        col.date = dIdx;
        col.time = tIdx;
      }
    } else {
      col = { date: 0, time: -1, open: 1, high: 2, low: 3, close: 4, adj: -1, volume: 5 };
    }
    if (col.date < 0) throw new Error('No date column found. Name it Date, Datetime, Time or Timestamp.');
    if (col.close < 0) throw new Error('No close column found. The CSV needs at least Date and Close columns.');
    const rows = [];
    let bad = 0;
    for (let k = hasHeader ? 1 : 0; k < lines.length; k++) {
      const f = splitLine(lines[k], delim);
      const t = parseTime(col.time >= 0 ? `${f[col.date]} ${f[col.time]}` : f[col.date]);
      const c = parseNumber(f[col.close], delim);
      const o = col.open >= 0 ? parseNumber(f[col.open], delim) : c;
      const h = col.high >= 0 ? parseNumber(f[col.high], delim) : Math.max(o, c);
      const l = col.low >= 0 ? parseNumber(f[col.low], delim) : Math.min(o, c);
      const v = col.volume >= 0 ? parseNumber(f[col.volume], delim) : 0;
      if (!Number.isFinite(t) || !Number.isFinite(c)) {
        bad++;
        continue;
      }
      const adj = col.adj >= 0 ? parseNumber(f[col.adj], delim) : NaN;
      const r = Number.isFinite(adj) && c > 0 ? adj / c : 1; // dividend/split adjust OHLC
      rows.push([t, o * r, h * r, l * r, c * r, v]);
    }
    if (!rows.length) throw new Error(`Could not read any rows. Check the date format in the first column (e.g. "${lines[1].slice(0, 40)}").`);
    const symbol = String(name || 'CSV').replace(/\.[a-z]+$/i, '').toUpperCase().slice(0, 24);
    const data = fromBars(rows, { symbol, name: name || 'CSV file', source: 'csv' });
    data.skippedRows = bad;
    return data;
  }

  // ---------------------------------------------------------------- local server

  async function getJSON(url) {
    let res;
    try {
      res = await fetch(url);
    } catch (e) {
      throw new Error('Could not reach the local server. Is server.py still running?');
    }
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error((body && body.error) || `Request failed (HTTP ${res.status})`);
    return body;
  }

  async function loadYahoo(opts) {
    const q = new URLSearchParams({ symbol: opts.symbol, interval: opts.interval, range: opts.range, adjusted: opts.adjusted ? '1' : '0' });
    const body = await getJSON(`api/yahoo?${q}`);
    if (!body.bars || !body.bars.length) throw new Error(`Yahoo returned no bars for ${opts.symbol}.`);
    return fromBars(body.bars, { symbol: body.symbol, name: body.name || body.symbol, interval: opts.interval, source: 'yahoo', currency: body.currency, timezone: body.timezone });
  }

  async function loadBinance(opts) {
    const q = new URLSearchParams({ symbol: opts.symbol, interval: opts.interval, bars: String(opts.bars) });
    const body = await getJSON(`api/binance?${q}`);
    if (!body.bars || !body.bars.length) throw new Error(`Binance returned no bars for ${opts.symbol}.`);
    return fromBars(body.bars, { symbol: body.symbol, name: `${body.symbol} · Binance`, interval: opts.interval, source: 'binance', timezone: 'UTC' });
  }

  async function listServerCSVs() {
    const body = await getJSON('api/datasets');
    return body.files || [];
  }

  async function loadServerCSV(name) {
    const res = await fetch(`api/datasets/${encodeURIComponent(name)}`);
    if (!res.ok) throw new Error(`Could not read data/${name}`);
    return parseCSV(await res.text(), name);
  }

  BT.data = {
    fromBars, detectInterval, filterRange, parseCSV, parseTime, sample, SAMPLES,
    loadYahoo, loadBinance, listServerCSVs, loadServerCSV, getJSON,
  };
})(typeof window !== 'undefined' ? window : globalThis);
