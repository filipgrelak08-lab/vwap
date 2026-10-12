// VWAP Pullback, MNQ (same rules and settings as pine/vwap_trend_pullback.pine)
//
// Long: close above session VWAP (anchored at 9:30 New York), VWAP above its value `slopeBars`
// ago, fast EMA above slow EMA, one of the previous `touchBars` candles touched VWAP (and came
// after the last entry), and the candle is bullish. Skipped when price was more than `maxExtAtr`
// x ATR from VWAP on the candle before the pullback, or when the stop is wider than `maxStopAtr`
// x ATR. Stop `stopTicks` beyond the pullback's lowest low; target `rewardRisk` x the risk.
// Short: mirrored. Entries fill at the signal candle's close, like the Pine version.
//
// Use 5-minute Yahoo data for NQ=F or MNQ=F: times are New York time, which the session settings
// assume. Each trade is `contracts` MNQ contracts ($2 a point), whatever the Position size panel
// says. MNQ costs in the Execution panel: commission 0.001% and slippage 0.001% per side are about
// $0.62 and 1 tick per contract at 31,000.

const toMin = (hhmm) => Math.floor(hhmm / 100) * 60 + (hhmm % 100);
const minuteOfDay = (t) => Math.floor((((t % 86400) + 86400) % 86400) / 60);

export default {
  name: 'VWAP Pullback (MNQ)',
  description: 'The TradingView VWAP pullback strategy: pullback to a sloping 9:30 VWAP with the 20/50 EMA trend, stop beyond the pullback, R target, New York session times, sized in MNQ contracts.',

  params: {
    takeLongs: { value: true, label: 'Take longs' },
    takeShorts: { value: true, label: 'Take shorts' },
    slopeBars: { value: 5, min: 1, max: 30, label: 'VWAP slope: compare with (bars ago)' },
    fastLen: { value: 20, min: 2, max: 200, label: 'Fast EMA' },
    slowLen: { value: 50, min: 2, max: 400, label: 'Slow EMA' },
    touchBars: { value: 3, min: 1, max: 20, label: 'VWAP touch within the previous (candles)' },
    maxExtAtr: { value: 2, min: 0, max: 10, step: 0.25, label: 'Skip if price was this far from VWAP before the pullback (× ATR, 0 = off)' },
    stopTicks: { value: 1, min: 0, max: 40, label: 'Stop buffer (ticks)' },
    atrLen: { value: 14, min: 1, max: 100, label: 'ATR length' },
    maxStopAtr: { value: 1.5, min: 0, max: 10, step: 0.25, label: 'Skip if the stop is wider than (× ATR, 0 = off)' },
    rewardRisk: { value: 2, min: 0.25, max: 10, step: 0.25, label: 'Take profit (× initial risk)' },
    contracts: { value: 1, min: 1, max: 100, label: 'Contracts' },
    entryFrom: { value: 945, min: 0, max: 2359, label: 'Take entries from (HHMM, New York)' },
    entryUntil: { value: 1130, min: 0, max: 2359, label: 'Take entries until (HHMM, New York)' },
    closeTrades: { value: true, label: 'Close open trades at the time below' },
    flatAt: { value: 1555, min: 0, max: 2359, label: 'Close open trades at (HHMM, New York)' },
    maxTrades: { value: 0, min: 0, max: 20, label: 'Max trades per day (0 = no limit)' },
    tickSize: { value: 0.25, min: 0.01, max: 10, step: 0.01, label: 'Tick size (MNQ 0.25)' },
    pointValue: { value: 2, min: 0.01, max: 1000, step: 0.01, label: '$ per point per contract (MNQ 2, NQ 20)' },
  },

  setup({ data, params: p, ta, plot }) {
    const n = data.close.length;
    const mins = data.time.map(minuteOfDay);
    const day = data.time.map((t) => Math.floor(t / 86400));
    const inRth = mins.map((m) => m >= 570 && m < 960);

    // session VWAP, restarting at the first candle at or after 9:30 each day
    const vwap = new Array(n).fill(NaN);
    let pv = 0;
    let vv = 0;
    let started = false;
    for (let i = 0; i < n; i++) {
      if (inRth[i] && (i === 0 || !inRth[i - 1] || day[i] !== day[i - 1])) {
        pv = vv = 0;
        started = true;
      }
      if (!started) continue;
      const w = data.volume[i] || 1;
      pv += ((data.high[i] + data.low[i] + data.close[i]) / 3) * w;
      vv += w;
      vwap[i] = pv / vv;
    }

    const gaps = [];
    for (let i = 1; i < Math.min(n, 500); i++) gaps.push(data.time[i] - data.time[i - 1]);
    gaps.sort((a, b) => a - b);
    const barMin = gaps.length ? gaps[gaps.length >> 1] / 60 : 5;

    const fast = ta.ema(data.close, p.fastLen);
    const slow = ta.ema(data.close, p.slowLen);
    plot('Session VWAP', vwap.map((v, i) => (inRth[i] ? v : NaN)), { color: 'vwap', width: 2 });
    plot('Fast EMA', fast, { color: 'up' });
    plot('Slow EMA', slow, { color: 'accent' });

    return {
      vwap, fast, slow, atr: ta.atr(data, p.atrLen), mins, day, barMin,
      H: data.high, L: data.low, C: data.close, O: data.open,
      state: { lastEntry: -1, day: -1, tradesToday: 0 },
    };
  },

  onBar(ctx) {
    const { i, ind, params: p } = ctx;
    const { vwap: vw, H, L, C, O, state } = ind;
    const closeMin = ind.mins[i] + ind.barMin;
    const late = p.closeTrades && closeMin >= toMin(p.flatAt);

    if (!ctx.isFlat) {
      if (late) ctx.exit({ reason: 'Time exit', atClose: true });
      return;
    }
    if (ind.day[i] !== state.day) {
      state.day = ind.day[i];
      state.tradesToday = 0;
    }
    if (ind.mins[i] < toMin(p.entryFrom) || ind.mins[i] >= toMin(p.entryUntil) || late) return;
    if (p.maxTrades > 0 && state.tradesToday >= p.maxTrades) return;

    const k = p.touchBars;
    if (i < Math.max(60, k + 2, p.slopeBars + 1)) return;
    const atr = ind.atr[i];
    const atrBefore = ind.atr[i - k - 1];
    if (!(atr > 0) || !(atrBefore > 0) || ![vw[i], vw[i - p.slopeBars], vw[i - k - 1]].every(Number.isFinite)) return;

    let touchL = false;
    let touchS = false;
    for (let j = 1; j <= k; j++) {
      if (i - j <= state.lastEntry) continue;
      if (L[i - j] <= vw[i - j]) touchL = true;
      if (H[i - j] >= vw[i - j]) touchS = true;
    }
    const extOk = p.maxExtAtr === 0 || Math.abs(C[i - k - 1] - vw[i - k - 1]) <= p.maxExtAtr * atrBefore;
    const tick = p.tickSize;
    const roundTick = (x) => Math.round(x / tick) * tick;
    // size as a share of equity so that each trade is exactly `contracts` contracts
    const size = (p.contracts * p.pointValue * C[i]) / ctx.equity;

    if (p.takeLongs && C[i] > vw[i] && vw[i] > vw[i - p.slopeBars] && ind.fast[i] > ind.slow[i] && touchL && C[i] > O[i] && extOk) {
      const stop = roundTick(Math.min(...L.slice(i - k, i + 1)) - p.stopTicks * tick);
      if (p.maxStopAtr > 0 && C[i] - stop > p.maxStopAtr * atr) return;
      const target = roundTick(C[i] + p.rewardRisk * (C[i] - stop));
      ctx.long({ stop, target, size, atClose: true, label: 'VWAP pullback long' });
      state.lastEntry = i;
      state.tradesToday++;
    } else if (p.takeShorts && C[i] < vw[i] && vw[i] < vw[i - p.slopeBars] && ind.fast[i] < ind.slow[i] && touchS && C[i] < O[i] && extOk) {
      const stop = roundTick(Math.max(...H.slice(i - k, i + 1)) + p.stopTicks * tick);
      if (p.maxStopAtr > 0 && stop - C[i] > p.maxStopAtr * atr) return;
      const target = roundTick(C[i] - p.rewardRisk * (stop - C[i]));
      ctx.short({ stop, target, size, atClose: true, label: 'VWAP pullback short' });
      state.lastEntry = i;
      state.tradesToday++;
    }
  },
};
