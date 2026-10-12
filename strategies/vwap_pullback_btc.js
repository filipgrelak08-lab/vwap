// VWAP Pullback, BTC (same rules and settings as pine/vwap_trend_pullback.pine)
//
// Long: close above the daily VWAP (restarting at 00:00 UTC), VWAP above its value `slopeBars`
// ago, fast EMA above slow EMA, one of the previous `touchBars` candles touched VWAP (and came
// after the last entry), and the candle is bullish. Skipped when price was more than `maxExtAtr`
// x ATR from VWAP on the candle before the pullback, or when the stop is wider than `maxStopAtr`
// x ATR. Stop `stopTicks` beyond the pullback's lowest low; target `rewardRisk` x the risk.
// Short: mirrored. Entries fill at the signal candle's close, like the Pine version.
//
// Made for Binance BTCUSDT 5-minute data (times in UTC). Size each trade in the Position size panel:
// "risk per trade" matches the Pine script's fixed-risk sizing. Bybit's taker fee for USDT
// perpetuals is 0.055% per side; Binance spot is 0.1%.

const toMin = (hhmm) => Math.floor(hhmm / 100) * 60 + (hhmm % 100);
const minuteOfDay = (t) => Math.floor((((t % 86400) + 86400) % 86400) / 60);

export default {
  name: 'VWAP Pullback (BTC)',
  description: 'The TradingView VWAP pullback strategy for BTC: pullback to a sloping daily VWAP with the 20/50 EMA trend, stop beyond the pullback, R target, optional UTC time filters.',

  params: {
    takeLongs: { value: true, label: 'Take longs' },
    takeShorts: { value: true, label: 'Take shorts' },
    slopeBars: { value: 5, min: 1, max: 30, label: 'VWAP slope: compare with (bars ago)' },
    fastLen: { value: 20, min: 2, max: 200, label: 'Fast EMA' },
    slowLen: { value: 50, min: 2, max: 400, label: 'Slow EMA' },
    touchBars: { value: 3, min: 1, max: 20, label: 'VWAP touch within the previous (candles)' },
    maxExtAtr: { value: 2, min: 0, max: 10, step: 0.25, label: 'Skip if price was this far from VWAP before the pullback (× ATR, 0 = off)' },
    stopTicks: { value: 1, min: 0, max: 100, label: 'Stop buffer (ticks)' },
    tickSize: { value: 0.1, min: 0.01, max: 10, step: 0.01, label: 'Tick size (Bybit BTCUSDT 0.1, Binance 0.01)' },
    atrLen: { value: 14, min: 1, max: 100, label: 'ATR length' },
    maxStopAtr: { value: 1.5, min: 0, max: 10, step: 0.25, label: 'Skip if the stop is wider than (× ATR, 0 = off)' },
    rewardRisk: { value: 2, min: 0.25, max: 10, step: 0.25, label: 'Take profit (× initial risk)' },
    useWindow: { value: false, label: 'Only enter between the times below (UTC)' },
    entryFrom: { value: 1345, min: 0, max: 2359, label: 'Enter from (HHMM, UTC)' },
    entryUntil: { value: 1530, min: 0, max: 2359, label: 'Enter until (HHMM, UTC)' },
    closeTrades: { value: false, label: 'Close open trades at the time below' },
    flatAt: { value: 2355, min: 0, max: 2359, label: 'Close open trades at (HHMM, UTC)' },
    maxTrades: { value: 0, min: 0, max: 50, label: 'Max trades per day (0 = no limit)' },
  },

  setup({ data, params: p, ta, plot }) {
    const n = data.close.length;
    const day = data.time.map((t) => Math.floor(t / 86400));

    // daily VWAP, restarting at the first candle of each UTC day
    const vwap = new Array(n).fill(NaN);
    let pv = 0;
    let vv = 0;
    for (let i = 0; i < n; i++) {
      if (i === 0 || day[i] !== day[i - 1]) pv = vv = 0;
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
    plot('Daily VWAP', vwap, { color: 'vwap', width: 2 });
    plot('Fast EMA', fast, { color: 'up' });
    plot('Slow EMA', slow, { color: 'accent' });

    return {
      vwap, fast, slow, atr: ta.atr(data, p.atrLen), mins: data.time.map(minuteOfDay), day, barMin,
      H: data.high, L: data.low, C: data.close, O: data.open,
      state: { lastEntry: -1, day: -1, tradesToday: 0 },
    };
  },

  onBar(ctx) {
    const { i, ind, params: p } = ctx;
    const { vwap: vw, H, L, C, O, state } = ind;
    // the time exit fires on the first candle that closes at or after the set time
    const closeMin = (ind.mins[i] + ind.barMin) % 1440;
    const late = p.closeTrades && closeMin >= toMin(p.flatAt) && closeMin < toMin(p.flatAt) + ind.barMin;

    if (!ctx.isFlat) {
      if (late) ctx.exit({ reason: 'Time exit', atClose: true });
      return;
    }
    if (ind.day[i] !== state.day) {
      state.day = ind.day[i];
      state.tradesToday = 0;
    }
    if (late) return;
    if (p.useWindow && (ind.mins[i] < toMin(p.entryFrom) || ind.mins[i] >= toMin(p.entryUntil))) return;
    if (p.maxTrades > 0 && state.tradesToday >= p.maxTrades) return;

    const k = p.touchBars;
    if (i < Math.max(60, k + 2, p.slopeBars + 1)) return;
    const atr = ind.atr[i];
    const atrBefore = ind.atr[i - k - 1];
    if (!(atr > 0) || !(atrBefore > 0)) return;

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

    if (p.takeLongs && C[i] > vw[i] && vw[i] > vw[i - p.slopeBars] && ind.fast[i] > ind.slow[i] && touchL && C[i] > O[i] && extOk) {
      const stop = roundTick(Math.min(...L.slice(i - k, i + 1)) - p.stopTicks * tick);
      if (p.maxStopAtr > 0 && C[i] - stop > p.maxStopAtr * atr) return;
      const target = roundTick(C[i] + p.rewardRisk * (C[i] - stop));
      ctx.long({ stop, target, atClose: true, label: 'VWAP pullback long' });
      state.lastEntry = i;
      state.tradesToday++;
    } else if (p.takeShorts && C[i] < vw[i] && vw[i] < vw[i - p.slopeBars] && ind.fast[i] < ind.slow[i] && touchS && C[i] < O[i] && extOk) {
      const stop = roundTick(Math.max(...H.slice(i - k, i + 1)) + p.stopTicks * tick);
      if (p.maxStopAtr > 0 && stop - C[i] > p.maxStopAtr * atr) return;
      const target = roundTick(C[i] - p.rewardRisk * (stop - C[i]));
      ctx.short({ stop, target, atClose: true, label: 'VWAP pullback short' });
      state.lastEntry = i;
      state.tradesToday++;
    }
  },
};
