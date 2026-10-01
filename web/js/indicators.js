/*
 * Technical indicators. Every function takes plain arrays (or the dataset
 * object for OHLCV-based indicators) and returns arrays of the same length,
 * padded with NaN until enough bars exist ("warm-up").
 *
 * Available inside strategies as `ta`, e.g. `ta.sma(data.close, 20)`.
 */
(function (root) {
  'use strict';
  const BT = (root.BT = root.BT || {});

  const DAY = 86400;
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const nanArray = (n) => new Array(n).fill(NaN);
  const valueAt = (x, i) => (typeof x === 'number' ? x : x ? x[i] : NaN);

  // ---------- moving averages ----------

  function sma(src, len) {
    const n = src.length;
    const out = nanArray(n);
    let sum = 0;
    let bad = 0;
    for (let i = 0; i < n; i++) {
      const v = src[i];
      if (isNum(v)) sum += v;
      else bad++;
      if (i >= len) {
        const old = src[i - len];
        if (isNum(old)) sum -= old;
        else bad--;
      }
      if (i >= len - 1 && bad === 0) out[i] = sum / len;
    }
    return out;
  }

  // Exponential smoothing seeded with the SMA of the first `len` valid values.
  function expSmooth(src, len, alpha) {
    const n = src.length;
    const out = nanArray(n);
    let prev = NaN;
    let seedSum = 0;
    let seedCount = 0;
    for (let i = 0; i < n; i++) {
      const v = src[i];
      if (!isNum(prev)) {
        if (isNum(v)) {
          seedSum += v;
          seedCount++;
          if (seedCount === len) {
            prev = seedSum / len;
            out[i] = prev;
          }
        } else {
          seedSum = 0;
          seedCount = 0;
        }
        continue;
      }
      if (isNum(v)) prev = alpha * v + (1 - alpha) * prev;
      out[i] = prev;
    }
    return out;
  }

  const ema = (src, len) => expSmooth(src, len, 2 / (len + 1));
  // Wilder's moving average (used by RSI, ATR, ADX).
  const rma = (src, len) => expSmooth(src, len, 1 / len);

  function wma(src, len) {
    const n = src.length;
    const out = nanArray(n);
    const denom = (len * (len + 1)) / 2;
    for (let i = len - 1; i < n; i++) {
      let s = 0;
      let ok = true;
      for (let k = 0; k < len; k++) {
        const v = src[i - k];
        if (!isNum(v)) {
          ok = false;
          break;
        }
        s += v * (len - k);
      }
      if (ok) out[i] = s / denom;
    }
    return out;
  }

  // Population standard deviation over a rolling window.
  function stdev(src, len) {
    const n = src.length;
    const out = nanArray(n);
    let sum = 0;
    let sumSq = 0;
    let bad = 0;
    for (let i = 0; i < n; i++) {
      const v = src[i];
      if (isNum(v)) {
        sum += v;
        sumSq += v * v;
      } else bad++;
      if (i >= len) {
        const old = src[i - len];
        if (isNum(old)) {
          sum -= old;
          sumSq -= old * old;
        } else bad--;
      }
      if (i >= len - 1 && bad === 0) {
        const mean = sum / len;
        out[i] = Math.sqrt(Math.max(0, sumSq / len - mean * mean));
      }
    }
    return out;
  }

  // ---------- rolling extremes (monotonic deque, O(n)) ----------

  function rollingExtreme(src, len, isMax) {
    const n = src.length;
    const out = nanArray(n);
    const dq = [];
    let head = 0;
    let lastBad = -1;
    for (let i = 0; i < n; i++) {
      const v = src[i];
      if (!isNum(v)) {
        lastBad = i;
        dq.length = 0;
        head = 0;
        continue;
      }
      while (dq.length > head && (isMax ? src[dq[dq.length - 1]] <= v : src[dq[dq.length - 1]] >= v)) dq.pop();
      dq.push(i);
      if (dq[head] <= i - len) head++;
      if (i - lastBad >= len) out[i] = src[dq[head]];
    }
    return out;
  }

  const highest = (src, len) => rollingExtreme(src, len, true);
  const lowest = (src, len) => rollingExtreme(src, len, false);

  // ---------- oscillators ----------

  function rsi(src, len = 14) {
    const n = src.length;
    const out = nanArray(n);
    let avgGain = 0;
    let avgLoss = 0;
    let count = 0;
    let seeded = false;
    const calc = () => (avgLoss === 0 ? (avgGain === 0 ? 50 : 100) : 100 - 100 / (1 + avgGain / avgLoss));
    for (let i = 1; i < n; i++) {
      const ch = src[i] - src[i - 1];
      if (!isNum(ch)) continue;
      const gain = ch > 0 ? ch : 0;
      const loss = ch < 0 ? -ch : 0;
      if (!seeded) {
        avgGain += gain;
        avgLoss += loss;
        count++;
        if (count === len) {
          avgGain /= len;
          avgLoss /= len;
          seeded = true;
          out[i] = calc();
        }
      } else {
        avgGain = (avgGain * (len - 1) + gain) / len;
        avgLoss = (avgLoss * (len - 1) + loss) / len;
        out[i] = calc();
      }
    }
    return out;
  }

  function macd(src, fast = 12, slow = 26, signalLen = 9) {
    const f = ema(src, fast);
    const s = ema(src, slow);
    const line = f.map((v, i) => v - s[i]);
    const signal = ema(line, signalLen);
    const hist = line.map((v, i) => v - signal[i]);
    return { macd: line, signal, hist };
  }

  function stoch(data, kLen = 14, kSmooth = 3, dLen = 3) {
    const hh = highest(data.high, kLen);
    const ll = lowest(data.low, kLen);
    const raw = data.close.map((c, i) => {
      const range = hh[i] - ll[i];
      return range > 0 ? (100 * (c - ll[i])) / range : isNum(range) ? 50 : NaN;
    });
    const k = sma(raw, kSmooth);
    return { k, d: sma(k, dLen) };
  }

  function roc(src, len = 1) {
    return src.map((v, i) => (i >= len ? 100 * (v / src[i - len] - 1) : NaN));
  }

  function change(src, len = 1) {
    return src.map((v, i) => (i >= len ? v - src[i - len] : NaN));
  }

  function zscore(src, len) {
    const m = sma(src, len);
    const sd = stdev(src, len);
    return src.map((v, i) => (sd[i] > 0 ? (v - m[i]) / sd[i] : NaN));
  }

  // ---------- bands & channels ----------

  function bollinger(src, len = 20, mult = 2) {
    const middle = sma(src, len);
    const sd = stdev(src, len);
    return {
      middle,
      upper: middle.map((m, i) => m + mult * sd[i]),
      lower: middle.map((m, i) => m - mult * sd[i]),
    };
  }

  function donchian(data, len = 20) {
    const upper = highest(data.high, len);
    const lower = lowest(data.low, len);
    return { upper, lower, middle: upper.map((u, i) => (u + lower[i]) / 2) };
  }

  function keltner(data, len = 20, mult = 2, atrLen = 10) {
    const middle = ema(data.close, len);
    const a = atr(data, atrLen);
    return {
      middle,
      upper: middle.map((m, i) => m + mult * a[i]),
      lower: middle.map((m, i) => m - mult * a[i]),
    };
  }

  // ---------- volatility & trend strength ----------

  function trueRange(data) {
    const { high, low, close } = data;
    return high.map((h, i) => {
      if (i === 0) return h - low[0];
      const pc = close[i - 1];
      return Math.max(h - low[i], Math.abs(h - pc), Math.abs(low[i] - pc));
    });
  }

  const atr = (data, len = 14) => rma(trueRange(data), len);

  function adx(data, len = 14) {
    const { high, low } = data;
    const n = high.length;
    const plusDM = nanArray(n);
    const minusDM = nanArray(n);
    for (let i = 1; i < n; i++) {
      const up = high[i] - high[i - 1];
      const down = low[i - 1] - low[i];
      plusDM[i] = up > down && up > 0 ? up : 0;
      minusDM[i] = down > up && down > 0 ? down : 0;
    }
    const tr = trueRange(data);
    tr[0] = NaN;
    const trS = rma(tr, len);
    const pS = rma(plusDM, len);
    const mS = rma(minusDM, len);
    const plusDI = pS.map((v, i) => (trS[i] > 0 ? (100 * v) / trS[i] : NaN));
    const minusDI = mS.map((v, i) => (trS[i] > 0 ? (100 * v) / trS[i] : NaN));
    const dx = plusDI.map((p, i) => {
      const s = p + minusDI[i];
      return s > 0 ? (100 * Math.abs(p - minusDI[i])) / s : isNum(s) ? 0 : NaN;
    });
    return { adx: rma(dx, len), plusDI, minusDI };
  }

  // ---------- volume ----------

  function obv(data) {
    const { close, volume } = data;
    let acc = 0;
    return close.map((c, i) => {
      if (i > 0) acc += c > close[i - 1] ? volume[i] : c < close[i - 1] ? -volume[i] : 0;
      return acc;
    });
  }

  const hlc3 = (data) => data.close.map((c, i) => (data.high[i] + data.low[i] + c) / 3);
  const hl2 = (data) => data.high.map((h, i) => (h + data.low[i]) / 2);
  const ohlc4 = (data) => data.close.map((c, i) => (data.open[i] + data.high[i] + data.low[i] + c) / 4);

  // Group id per bar for an anchor period. Times are "exchange wall clock"
  // expressed as UTC seconds, so a calendar day is simply floor(t / 86400).
  function anchorIds(data, anchor = 'session') {
    const t = data.time;
    switch (anchor) {
      case 'session':
      case 'day':
        return t.map((x) => Math.floor(x / DAY));
      case 'week': // weeks start on Monday (1970-01-01 was a Thursday)
        return t.map((x) => Math.floor((Math.floor(x / DAY) + 3) / 7));
      case 'month':
        return t.map((x) => {
          const d = new Date(x * 1000);
          return d.getUTCFullYear() * 12 + d.getUTCMonth();
        });
      case 'none':
        return t.map(() => 0);
      default:
        throw new Error(`Unknown VWAP anchor "${anchor}" (use session, week, month or none)`);
    }
  }

  function volumeWeights(data) {
    const v = data.volume;
    for (let i = 0; i < v.length; i++) if (v[i] > 0) return v;
    return v.map(() => 1); // no volume in this dataset (e.g. FX, indices): equal weights
  }

  /**
   * Anchored VWAP with volume-weighted standard deviation.
   * anchor: 'session' (resets each day), 'week', 'month' or 'none' (whole dataset).
   */
  function vwapBands(data, mult = 2, anchor = 'session') {
    const tp = hlc3(data);
    const vol = volumeWeights(data);
    const ids = anchorIds(data, anchor);
    const n = tp.length;
    const vw = nanArray(n);
    const sd = nanArray(n);
    let cumV = 0;
    let cumPV = 0;
    let cumP2V = 0;
    for (let i = 0; i < n; i++) {
      if (i === 0 || ids[i] !== ids[i - 1]) {
        cumV = 0;
        cumPV = 0;
        cumP2V = 0;
      }
      const v = vol[i] > 0 ? vol[i] : 0;
      cumV += v;
      cumPV += tp[i] * v;
      cumP2V += tp[i] * tp[i] * v;
      if (cumV > 0) {
        const m = cumPV / cumV;
        vw[i] = m;
        sd[i] = Math.sqrt(Math.max(0, cumP2V / cumV - m * m));
      } else {
        vw[i] = tp[i];
        sd[i] = 0;
      }
    }
    return {
      vwap: vw,
      stdev: sd,
      upper: vw.map((m, i) => m + mult * sd[i]),
      lower: vw.map((m, i) => m - mult * sd[i]),
    };
  }

  const vwap = (data, anchor = 'session') => vwapBands(data, 0, anchor).vwap;

  // VWAP of the last `len` bars - useful on daily data where a session VWAP is one bar.
  function rollingVwap(data, len = 20) {
    const tp = hlc3(data);
    const vol = volumeWeights(data);
    const pv = tp.map((p, i) => p * vol[i]);
    const sumPV = sma(pv, len);
    const sumV = sma(vol, len);
    return sumPV.map((x, i) => (sumV[i] > 0 ? x / sumV[i] : NaN));
  }

  // ---------- sessions ----------

  // true on the first bar of each trading day
  function sessionStart(data) {
    const ids = anchorIds(data, 'session');
    return ids.map((d, i) => i === 0 || d !== ids[i - 1]);
  }

  // true on the last bar of each trading day (and on the final bar)
  function sessionEnd(data) {
    const ids = anchorIds(data, 'session');
    return ids.map((d, i) => i === ids.length - 1 || d !== ids[i + 1]);
  }

  // index of the bar within its trading day (0 = first bar)
  function sessionBar(data) {
    const ids = anchorIds(data, 'session');
    let k = 0;
    return ids.map((d, i) => (k = i === 0 || d !== ids[i - 1] ? 0 : k + 1));
  }

  // ---------- crosses ----------

  // a crossed above b on bar i. a and b may be arrays or plain numbers.
  function crossover(a, b, i) {
    const a0 = valueAt(a, i);
    const b0 = valueAt(b, i);
    const a1 = valueAt(a, i - 1);
    const b1 = valueAt(b, i - 1);
    return isNum(a0) && isNum(b0) && isNum(a1) && isNum(b1) && a0 > b0 && a1 <= b1;
  }

  function crossunder(a, b, i) {
    const a0 = valueAt(a, i);
    const b0 = valueAt(b, i);
    const a1 = valueAt(a, i - 1);
    const b1 = valueAt(b, i - 1);
    return isNum(a0) && isNum(b0) && isNum(a1) && isNum(b1) && a0 < b0 && a1 >= b1;
  }

  BT.ta = {
    sma, ema, rma, wma, stdev, highest, lowest,
    rsi, macd, stoch, roc, change, zscore,
    bollinger, donchian, keltner, trueRange, atr, adx,
    obv, hlc3, hl2, ohlc4,
    vwap, vwapBands, rollingVwap, anchorIds,
    sessionStart, sessionEnd, sessionBar,
    crossover, crossunder, isNum,
  };
})(typeof window !== 'undefined' ? window : globalThis);
