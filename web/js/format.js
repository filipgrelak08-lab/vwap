/* Number and date formatting shared by the UI. */
(function (root) {
  'use strict';
  const BT = (root.BT = root.BT || {});

  const pad = (n) => String(n).padStart(2, '0');
  const isIntraday = (data) => !!data && /^\d+(m|h|s)$/.test(String(data.interval || ''));

  function date(t) {
    const d = new Date(t * 1000);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  }

  function time(t, data) {
    if (!isIntraday(data)) return date(t);
    const d = new Date(t * 1000);
    return `${date(t)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  }

  function num(v, digits = 2) {
    if (v === Infinity) return '∞';
    if (!Number.isFinite(v)) return '–';
    return v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }

  function pct(v, digits = 2, signed = true) {
    if (!Number.isFinite(v)) return '–';
    const s = num(Math.abs(v), digits);
    const sign = v > 0 && signed ? '+' : v < 0 ? '−' : '';
    return `${sign}${s}%`;
  }

  function money(v, digits = 0) {
    if (!Number.isFinite(v)) return '–';
    const sign = v < 0 ? '−' : '';
    return `${sign}$${num(Math.abs(v), digits)}`;
  }

  function signedMoney(v, digits = 2) {
    if (!Number.isFinite(v)) return '–';
    return (v > 0 ? '+' : v < 0 ? '−' : '') + '$' + num(Math.abs(v), digits);
  }

  // Price with sensible precision for anything from penny stocks to BTC.
  function price(v) {
    if (!Number.isFinite(v)) return '–';
    const a = Math.abs(v);
    const d = a >= 1000 ? 2 : a >= 1 ? 2 : a >= 0.01 ? 4 : 6;
    return num(v, d);
  }

  function compact(v) {
    if (!Number.isFinite(v)) return '–';
    const a = Math.abs(v);
    if (a >= 1e9) return (v / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M';
    if (a >= 1e4) return (v / 1e3).toFixed(1) + 'K';
    return num(v, 0);
  }

  function int(v) {
    return Number.isFinite(v) ? Math.round(v).toLocaleString('en-US') : '–';
  }

  BT.fmt = { date, time, num, pct, money, signedMoney, price, compact, int, isIntraday };
})(typeof window !== 'undefined' ? window : globalThis);
