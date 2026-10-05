# Backtesting Tool

A backtester for trading strategies that runs every backtest on [Trader.dev](https://trader.dev). Run one Python file, open your browser, pick or write a strategy, and see how it would have traded: equity curve, drawdown, every trade, monthly returns, and a parameter sweep.

Strategies are small JavaScript files that describe their parameters and return the Pine Script for their signals. The app generates the finished script from the strategy plus whatever you have set in the sidebar, and sends it to Trader.dev on every run — so the code Trader.dev tests always matches what you changed in the app. The Pine sent tab shows exactly what went out.

- **Backtests run on Trader.dev.** Nothing is simulated locally, so the numbers are the ones Trader.dev's TradingView-parity engine produces.
- **Your edits go with every run.** Change a parameter or a stop, press Run, and the regenerated Pine carries it.
- **Runs are versioned.** The first run of a strategy creates it on Trader.dev; later runs add versions to the same strategy, so its report shows the history.
- **Eight example strategies**: VWAP band reversion, VWAP trend pullback, opening range breakout, moving average crossover, RSI(2) pullback, Bollinger breakout, Donchian breakout and MACD trend.

## Quick start

You need a Trader.dev API key (it starts with `pk_`), Python 3.8+ and a current browser.

```bash
export TRADERDEV_API_KEY=pk_your_key_here
python3 server.py
```

Your browser opens at <http://localhost:8000>. On Windows use `py server.py`, and `set TRADERDEV_API_KEY=pk_...` instead of `export`.

Options: `--port 9000`, `--no-browser`, `--verbose`.

The key stays on your machine: the browser talks to this server, and only this server talks to Trader.dev, handing it the key once per connection. Nothing writes the key to disk, so set it in your shell (or your shell profile) each session. The badge at the top right says whether Trader.dev answered; if it did not, the message says why.

The server connects to Trader.dev's MCP server at `https://mcp.trader.dev/mcp`. If Trader.dev moves it, point the server at the new address with `TRADERDEV_MCP_URL=https://.../mcp`.

Each backtest costs one Trader.dev credit, and a parameter sweep costs one per combination. The Run button shows your balance.

## Using it

1. **Market** (left panel). Symbol, timeframe and an optional date range. Trader.dev tests Bybit USDT perpetuals — `BTCUSDT`, `ETHUSDT`, `SOLUSDT` and the rest of its coverage. Leave the dates empty for the longest window it has. If a symbol is not covered or the dates fall outside its archive, Trader.dev substitutes what it can and the app says so above the results.
2. **Strategy**: choose one and adjust its parameters.
3. **Execution**, **Stops and targets**, **Entry filter** (see [Settings](#settings)): starting capital, shorting, where trades exit and when new ones are allowed. They apply to every strategy and become part of the generated Pine.
4. **Run on Trader.dev**. There is no auto-run, because each run costs a credit.
5. **Results**: summary tiles, then tabs:
   - **Equity**: the equity curve and drawdown from Trader.dev, zooming and panning together.
   - **Trades**: statistics, the full trade list with each trade's worst and best point, and two scatter charts showing where stops and targets would have worked. Click a trade to jump to it. Download as CSV.
   - **Monthly returns**: a calendar heatmap.
   - **Optimize**: sweep one or two parameters on Trader.dev's optimizer.
   - **Code**: the strategy source. `Ctrl/⌘ + Enter` runs, `Ctrl/⌘ + S` saves to `strategies/<name>.js`.
   - **Pine sent**: the exact script of the last run, ready to paste into TradingView.
   - The candle chart with every fill marked is on the Trader.dev report; each run links to it.

## Settings

**R** is the distance from entry to the initial stop. A trade that makes twice what it risked is +2R.

| Setting | What it does |
|---|---|
| **Starting capital** | The account the backtest starts with. |
| **Allow short selling** | Off: a short signal only closes a long. |
| **Stop loss %** | Fixed % stop from the entry price. |
| **ATR stop (× ATR)** | Stop k × ATR from entry. Adapts to volatility. |
| **Take profit %** | Fixed % target. |
| **Reward:risk (R)** | Target = entry ± R × the stop distance. |
| **Trailing %** | Stop that follows the best price by this %, tightening only. |
| **Break-even after (R)** | Once the trade is this many R in profit, the stop moves to the entry price. |
| **Time stop (bars)** | Close after this many bars. |
| **Trend SMA** | Longs only above this SMA, shorts only below it. |

Priority when several apply: the strategy's own `longStop`/`longTarget` first, then the ATR stop before stop loss %, and reward:risk before take profit %. The filter only blocks entries; exits always go through.

Each setting that is switched on becomes a Pine input in the generated script, which is what lets the Optimize tab sweep it and what makes the script editable on TradingView.

### Set by Trader.dev, not by you

Trader.dev runs every backtest on one broker profile so the numbers line up with TradingView's Strategy Tester. The app has no controls for these:

| | |
|---|---|
| Order size | 100% of equity |
| Margin | long 100, short 100 |
| Pyramiding | 1 (one position at a time) |
| Commission | 0.05% per side |
| Slippage | 0 |
| Fills | on the signal bar's close |

To reproduce a run on TradingView, paste the script from the Pine sent tab and match those, plus the same symbol, timeframe and dates. Set TradingView's commission to 0% — Trader.dev's parity profile already accounts for it.

This also means a few things the old local engine could do have no equivalent here: risk-per-trade position sizing, a daily loss limit, a cap on trades per day, trading-hour windows and closing out at the end of each session. Trader.dev's markets trade around the clock, so the session-based ones would not mean much anyway; a strategy that wants a daily anchor can work it out from `time` (both VWAP strategies do).

## Writing a strategy

A strategy is one file in `strategies/` that exports an object:

```js
export default {
  name: 'EMA Cross',
  description: 'Long when the fast EMA crosses above the slow EMA.',

  params: {
    fast: { value: 12, min: 2, max: 100, label: 'Fast EMA' },
    slow: { value: 26, min: 5, max: 300, label: 'Slow EMA' },
  },

  // Returns the Pine Script v6 that Trader.dev runs.
  // p.fast is the *name* of that parameter's Pine input, so it goes
  // straight into the code.
  pine({ p }) {
    return {
      body: `
fastMa = ta.ema(close, ${p.fast})
slowMa = ta.ema(close, ${p.slow})`,

      longEntry: 'ta.crossover(fastMa, slowMa)',
      shortEntry: 'ta.crossunder(fastMa, slowMa)',

      plots: [
        { title: 'Fast EMA', expr: 'fastMa' },
        { title: 'Slow EMA', expr: 'slowMa' },
      ],
    };
  },
};
```

Click **New strategy** in the app to start from this template, or copy the example closest to your idea. Files you add or edit in `strategies/` appear after a page reload.

### Reference

| | |
|---|---|
| **params** | `len: 20`, or `{ value, min, max, step, label }`. `true`/`false` gives a checkbox, `{ value: 'EMA', options: ['SMA', 'EMA'] }` a dropdown in the sidebar (in the Pine it is a plain string input, because the engine's parser rejects an options list). Every parameter becomes a Pine input named `p_<key>`. |
| **pine({ p, params, settings })** | `p.len` is the Pine input's name (`p_len`); `params.len` is its current value, for when you need the number at generation time. |
| **body** | Pine that computes your indicators and helper variables. |
| **longEntry**, **shortEntry** | Pine expressions, true when a trade opens. At least one is required. |
| **longExit**, **shortExit** | True when the position closes on a signal. |
| **longStop**, **shortStop**, **longTarget**, **shortTarget** | Price levels read at entry. They win over the sidebar's stop and target; return `na` to fall back to it. |
| **plots** | `[{ title, expr }]`, drawn on the Trader.dev report. They share the price chart, so plot price levels; an oscillator like RSI flattens the candles into a line. |

The app adds the `strategy()` header, the inputs, the entry and exit orders, and whichever stops, targets and filters are switched on.

### What the engine allows

Trader.dev's engine implements a fixed set of Pine:

`ta.`sma ema rma wma vwma hma swma alma linreg median mode percentile_nearest_rank percentile_linear_interpolation percentrank rsi stoch cci cmo mfi roc mom change tsi wpr cog macd bb bbw kc kcw dmi supertrend sar crossover crossunder cross barssince valuewhen rising falling pivothigh pivotlow highest lowest highestbars lowestbars range stdev dev variance correlation cum max min atr tr vwap obv pvt accdist iii wad wvad nvi pvi

Also `open high low close volume time bar_index hl2 hlc3 ohlc4`, `na() nz() fixnan()`, `math.*`, `input.*`, `var`, `:=`, `if`/`for`, and history access with `[]`.

Not available: `request.security` and other timeframes, arrays and maps, user-defined functions and types, `strategy.cancel`, `strategy.order`, `calc_on_every_tick`, drawings as logic, and pyramiding above 1. `npm test` checks the generated scripts against this list, so a strategy that strays is caught before it costs a credit.

### Coming from TradingView Pine Script

Because strategies are written in Pine already, most of a TradingView strategy ports across unchanged. What moves:

| In your Pine | In a strategy file here |
|---|---|
| `strategy(...)` header | Dropped — the app writes it |
| `input.int(14, "Length")` | `params: { length: { value: 14, label: 'Length' } }`, then `${p.length}` in the body |
| `ta.sma(close, 20)` | the same, in `body` |
| indicator maths, `var`, `:=`, `[]` | the same, in `body` |
| `if cond \n strategy.entry("L", strategy.long)` | `longEntry: 'cond'` |
| `strategy.close("L")` on a signal | `longExit: 'cond'` |
| `strategy.exit("x", stop=s, limit=t)` | `longStop: 's'`, `longTarget: 't'` |
| `plot(series, title="X")` | `plots: [{ title: 'X', expr: 'series' }]` |
| `time(timeframe.period, session)` | arithmetic on `time` (see the VWAP strategies) |

## How trades are simulated

That is Trader.dev's job, and its report is the reference. In outline: the script runs once per closed bar, orders fill at that bar's close (`process_orders_on_close`), one position at a time, position size is 100% of equity, and commission is 0.05% per side. Stops and targets are placed as `strategy.exit` orders and trigger inside a bar. Trailing stops ratchet and are re-issued each bar.

A backtest is a model. A good backtest says little about the future. Test on data you did not tune on, and treat results with suspicion before risking money.

## Project layout

```
server.py                 local server: static files, strategy files, Trader.dev proxy
strategies/*.js           strategies (one file each)
web/index.html            the app
web/js/strategy.js        loads strategy files and reads their parameters
web/js/pine.js            generates the Pine Script that gets sent
web/js/traderdev.js       talks to the server's Trader.dev proxy
web/js/metrics.js         monthly returns and annualised return
web/js/charts.js          equity, drawdown and scatter charts
web/js/app.js             UI
tests/                    unit tests
```

## Tests

```bash
npm test                                    # both suites
node --test tests/*.test.js                 # strategy loading, Pine generation, metrics
python3 -m unittest discover -s tests       # server and the Trader.dev proxy
```

No test spends a credit: the Pine tests check the generated scripts, and the server tests run the Trader.dev proxy against a local stub.

## Credits

Charts by [TradingView Lightweight Charts™](https://www.tradingview.com/) (Apache 2.0, see `web/vendor/`). Backtests by [Trader.dev](https://trader.dev). Market data from Bybit via Trader.dev; check their terms before using it for anything beyond personal research.

This tool is for research and education. It is not financial advice.
