// Rally Fade Short  (RSI(2) bounce in a downtrend)
//
// Short only, for falling markets. While price is below its long average
// (200 candles, about 33 days on 4h), sell short when RSI(2) spikes above 90,
// meaning a sharp bounce, and buy back at the first close below the 10-candle
// average. No stop, as tested.
//
// Tested on 4h, BTC/ETH/SOL perps, 2020-2026, half the account per trade:
// BTC +40% (worst drop 18%), ETH +27%, SOL +79%, about two in three trades win.
// Most of the profit came in real downtrends such as 2022.
//
// Size defaults to 50% of equity: at 100% the tester partly closes a short on
// any candle that moves against it, which a 1x Bybit position would not do.
// Needs "Allow short selling" on.

export default {
  name: 'Rally Fade Short',
  description: 'Short-only: below the 200-candle average, short when RSI(2) goes above 90; buy back on a close below the 10-candle average. Use a 4h chart.',

  params: {
    rsiLevel: { value: 90, min: 50, max: 99, label: 'Short when RSI(2) above' },
    trendLen: { value: 200, min: 20, max: 400, label: 'Downtrend average (candles)' },
    exitLen: { value: 10, min: 2, max: 50, label: 'Exit average (candles)' },
    sizePct: { value: 50, min: 10, max: 100, step: 5, label: 'Size (% of account)' },
  },

  pine({ p }) {
    return {
      body: `
rsi2 = ta.rsi(close, 2)
trendMa = ta.sma(close, ${p.trendLen})
exitMa = ta.sma(close, ${p.exitLen})`,

      shortEntry: `not na(trendMa) and close < trendMa and rsi2 > ${p.rsiLevel}`,
      shortExit: 'close < exitMa',
      shortSizePct: p.sizePct,

      plots: [
        { title: 'Downtrend average', expr: 'trendMa' },
        { title: 'Exit average', expr: 'exitMa' },
      ],
    };
  },
};
