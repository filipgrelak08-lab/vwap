# VWAP Lab

A local backtester for trading strategies. Run one Python file, open your browser, pick or write a strategy, and see how it would have traded: equity curve, drawdown, every trade on the chart, monthly returns, and a parameter sweep with out-of-sample testing.

- **No installs.** The server uses only the Python standard library; the app is plain HTML/JS.
- **Strategies are small JavaScript files** in `strategies/`. Edit them in the built-in editor or in your own editor.
- **Data:** Yahoo Finance (stocks, ETFs, indices, FX, crypto), Binance (crypto), your own CSV files, or the built-in synthetic samples.
- **Twelve example strategies** to start from: VWAP band reversion, VWAP trend pullback, opening range breakout, moving average crossover, RSI(2) pullback, Bollinger breakout, Donchian breakout, MACD trend, time-series momentum, Donchian trend ensemble, N-day high/low and hour-of-day window.
- **A library of tested strategies**: published crypto strategies checked on data they were not tuned on, with verdicts, trader.dev runs and one-click runs (see [Library](#library)).
- **trader.dev**: connect your trader.dev account to run TradingView Pine scripts on its servers and see the results here (see [trader.dev](#traderdev)).

## Quick start

```bash
python3 server.py
```

Your browser opens at <http://localhost:8000>. On Windows use `py server.py`. Options: `--port 9000`, `--no-browser`, `--verbose`.

Requirements: Python 3.8+ and a current browser. Live data needs an internet connection.

> No Python? Build a single HTML file that runs on its own with `python3 tools/build_standalone.py` (on any machine that has Python) and open `dist/vwap-lab.html`. It includes the example strategies and works with sample and CSV data. Live downloads and saving to `strategies/` need the server.

## Using it

1. **Market data** (left panel). Pick a source:
   - **Sample**: generated price series for trying things out. Not real market data.
   - **Yahoo**: any Yahoo Finance ticker (`AAPL`, `SPY`, `^GSPC`, `BTC-USD`, `EURUSD=X`). Yahoo limits intraday history: 1m covers 7 days, 5m–30m cover 60 days, 1h covers 2 years.
   - **Binance**: spot pairs such as `BTCUSDT`, up to 20,000 candles.
   - **CSV**: open a file, or drop CSVs into `data/` and pick them from the list. Columns: `Date` (or `Datetime`/`Timestamp`), `Open`, `High`, `Low`, `Close`, `Volume`. Exports from Yahoo, TradingView, Binance, Nasdaq and MetaTrader work as-is.
   - **From / To** narrows the test to a date range.
2. **Strategy**: choose one and adjust its parameters. With auto-run on, results update as you drag.
3. **Execution**, **Position size**, **Stops and targets**, **Entry filters** (see [Risk settings](#risk-settings)): capital, costs, fill timing, shorting, how big each trade is, where it exits, and when new trades are allowed. They apply to every strategy.
4. **Results**: summary tiles, then tabs:
   - **Chart**: candles with indicators and entry/exit markers, plus equity vs buy and hold and drawdown. All charts zoom and pan together.
   - **Trades**: statistics, the full trade list with R-multiple, MAE and MFE per trade, and two scatter charts showing where stops and targets would have worked. Click a trade to jump to it on the chart. Download as CSV.
   - **Monthly returns**: a calendar heatmap.
   - **Optimize**: sweep one or two strategy parameters or risk settings (e.g. ATR stop × reward:risk). Choose "Optimize on first 70%" to rank settings on the first part of the data and see how the best ones did on the rest.
   - **Code**: the strategy source. `Ctrl/⌘ + Enter` runs, `Ctrl/⌘ + S` saves to `strategies/<name>.js`.
   - **Library**: strategies tested in `research/`, best first, with how they did out of sample (see below).
   - **trader.dev**: run Pine scripts on trader.dev and browse past runs (see below).

## Library

The **Library** tab lists strategies from published papers that were tested in [`research/strategy_search`](research/strategy_search) and [`research/btc_paper_edges`](research/btc_paper_edges): settings picked on 2015–2021, then judged on 2022 → 2026 on nine coins they had never seen, and confirmed on trader.dev. Each card shows the rules, a verdict (recommended, mixed, didn't hold up), the before/after numbers against buy and hold, and the trader.dev runs per coin.

- **Run here** loads the strategy with its tested settings and BTC-USD data from Yahoo.
- **Open** shows a trader.dev run (equity curve and trades) in the trader.dev tab; **Buy and hold** shows the same coin held.
- **Open pine/… on trader.dev** puts the Pine script in the trader.dev editor to re-run it on another coin or period.

Current picks: **Donchian Trend Ensemble** (most upside when a coin trends) and **50-day High Hold** (most consistent, smallest drawdowns). The library is built from the research results by `python3 research/strategy_search/build_library.py` into `research/library.json`.

## trader.dev

[trader.dev](https://trader.dev) backtests TradingView Pine Script (v6) strategies on Bybit USDT perpetuals and forex pairs. The **trader.dev** tab connects to it through the local server:

1. Get an API key at <https://mcp-api.trader.dev/login> (it starts with `pk_`), paste it into the tab and press **Connect**. The server checks it and saves it to `.traderdev-key` next to `server.py` (owner-only file permissions on macOS and Linux; ignored by git). Or start the server with `TRADERDEV_API_KEY=pk_... python3 server.py`. The key only ever goes to trader.dev.
2. Pick a script from `pine/` or paste your own, choose symbol, timeframe and dates, and press **Run on trader.dev**. You get the summary, equity curve and every trade, plus a link to trader.dev's full report.
3. **Past runs** lists the runs you made from this browser; the research runs are in the Library tab. Click one, or paste any result ID or report link, to open it again. Opening a past run is free.

Things to know: each run costs 1 credit (free accounts get 1,000 a week); trader.dev always trades 100% of equity with 0.05% commission per side and no funding costs; and every run is saved **publicly** on trader.dev under the script's `strategy()` title or the name you give it.

Pine scripts you want to reuse go in `pine/` as `.pine` files. They are separate from the JavaScript strategies in `strategies/`, which run locally in the browser.

## Risk settings

**R** is the distance from entry to the initial stop. A trade that makes twice what it risked is +2R.

| Setting | What it does |
|---|---|
| Size each trade by **% of equity** | Every trade uses the position size % of your current equity. |
| Size each trade by **risk per trade** | Size so that hitting the stop loses that % of equity. Needs a stop; the position size becomes a cap. |
| **Stop loss %** | Fixed % stop from the entry price. |
| **ATR stop (× ATR)** | Stop k × ATR from entry, using the ATR of the signal bar. Adapts to volatility. |
| **Take profit %** | Fixed % target. |
| **Reward:risk (R)** | Target = entry ± R × the stop distance. |
| **Trailing %** | Stop that follows the best price by this %. |
| **Break-even after (R)** | Once the trade is this many R in profit, the stop moves to the entry price. |
| **Time stop (bars)** | Close after this many bars, at the bar's close. |
| **Close positions at the end of each day** | Intraday data only. |
| **Enter from / until** | New trades only in this window (exchange time, intraday data). |
| **Trend SMA** | Longs only above this SMA, shorts only below it. |
| **Max trades / day** | Stop opening trades after this many in a day. |
| **Daily loss limit %** | When equity falls this % below the day's start, close the position and stop for the day. |

Priority when several apply: the strategy's own `stop`/`target` first, then the ATR stop before stop loss %, and reward:risk before take profit %. Filters never block exits. The Trades tab lists how many signals each filter skipped.

**MAE** (maximum adverse excursion) is the worst point against you while a trade was open; **MFE** (maximum favourable excursion) is the best point in your favour. If 90% of winners never went more than 0.4% against you, a 2% stop is wider than it needs to be. If losers were often in profit first, a target or break-even stop could have saved them.

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

  // runs once: compute indicators
  setup({ data, params, ta, plot }) {
    const fast = ta.ema(data.close, params.fast);
    const slow = ta.ema(data.close, params.slow);
    plot('Fast EMA', fast);
    plot('Slow EMA', slow);
    return { fast, slow };
  },

  // runs after every bar closes
  onBar(ctx) {
    if (ctx.crossOver(ctx.ind.fast, ctx.ind.slow)) ctx.long();
    if (ctx.crossUnder(ctx.ind.fast, ctx.ind.slow)) ctx.exit('cross down');
  },
};
```

Click **New strategy** in the app to start from this template, or copy the example closest to your idea. Files you add or edit in `strategies/` appear after a page reload.

### Reference

| | |
|---|---|
| **params** | `len: 20`, or `{ value, min, max, step, label }`. `true`/`false` gives a checkbox, `{ value: 'EMA', options: ['SMA', 'EMA'] }` a dropdown. |
| **setup({ data, params, ta, plot })** | `data.open/high/low/close/volume/time` are arrays. Return what `onBar` needs; it arrives as `ctx.ind`. |
| **plot(name, series, opts)** | `opts.color`: `vwap`, `band`, `accent`, `up`, `down` or any CSS colour. `opts.style`: `line`, `dashed`, `dots`, `histogram`. `opts.pane: 'lower'` draws below the price. `opts.levels: [30, 70]` adds guide lines. |
| **bar data** | `ctx.i`, `ctx.open`, `ctx.high`, `ctx.low`, `ctx.close`, `ctx.volume`, `ctx.time` |
| **position** | `ctx.isFlat`, `ctx.isLong`, `ctx.isShort`, `ctx.position.entryPrice`, `.barsHeld`, `.pnlPct`, `.stop`, `.target`, `.risk` (1R in price), `ctx.equity` |
| **session / time** | `ctx.newSession`, `ctx.lastBarOfSession`, `ctx.sessionBar` (0 = first bar of the day), `ctx.hour`, `ctx.minute`, `ctx.dayOfWeek` (0 = Sunday) |
| **orders** | `ctx.long(opts)`, `ctx.short(opts)`, `ctx.exit(reason)`, `ctx.cancel()`, `ctx.setStop(price)`, `ctx.setTarget(price)` |
| **order opts** | `stop`, `target` (prices), `trail` (%), `size` (0–1 of equity; skips risk sizing), `label`, `atClose: true` (fill at this bar's close) |
| **helpers** | `ctx.crossOver(a, b)`, `ctx.crossUnder(a, b)`, `ctx.prev(series, n)`, `ctx.log(...)` |
| **ta** | `sma ema wma rma stdev highest lowest rsi macd stoch roc change zscore bollinger donchian keltner atr trueRange adx obv hlc3 hl2 ohlc4 vwap vwapBands rollingVwap anchorIds sessionStart sessionEnd sessionBar crossover crossunder` |

`ta.vwap(data, anchor)` and `ta.vwapBands(data, mult, anchor)` reset each `session` (day), `week` or `month`, or never with `none`. `ta.rollingVwap(data, n)` is the VWAP of the last n bars, which is more useful on daily data.

Keep per-run state (for example "already traded today") in the object `setup()` returns, not in variables outside the strategy, because the optimizer runs the same strategy many times.

### Coming from TradingView Pine Script

| Pine | VWAP Lab |
|---|---|
| `ta.sma(close, 20)` | `ta.sma(data.close, 20)` in `setup()` |
| `ta.vwap(hlc3)` | `ta.vwap(data, 'session')` |
| `ta.crossover(a, b)` | `ctx.crossOver(ind.a, ind.b)` |
| `strategy.entry("L", strategy.long)` | `ctx.long()` |
| `strategy.entry("S", strategy.short)` | `ctx.short()` |
| `strategy.close("L")` | `ctx.exit()` |
| `strategy.exit("x", stop=s, limit=t)` | `ctx.long({ stop: s, target: t })` or `ctx.setStop(s)` |
| `input.int(14, "Length")` | `params: { length: { value: 14, label: 'Length' } }` |
| `close[1]` | `data.close[i - 1]`, or `ctx.prev(data.close)` |

## How trades are simulated

- `onBar` runs after a bar closes. Orders fill at the **next bar's open** (or at the same bar's close if you choose that, or pass `atClose: true`). The strategy never sees future bars.
- Stops, targets and trailing stops trigger inside a bar using its high and low. If the bar opens beyond the level (a gap), the fill is the open. If a stop and a target are both inside one bar, the stop is assumed to hit first.
- One position at a time. `long()` while short closes the short and opens a long. With shorting off, a short signal only closes the long.
- Position size is a percentage of current equity (or set by risk per trade), with fractional quantities. Commission is a percentage of traded value per side; slippage moves every fill against you.
- Statistics are annualised using the calendar span of the data, so they work for any bar size and for 24/7 markets. Sharpe and Sortino use a 0% risk-free rate.
- Intraday times are shown in the exchange's local time (UTC for Binance), so "the session" means the exchange's trading day.

A backtest is a model. It does not include partial fills, borrow costs, funding rates, dividends on short positions or market impact, and a good backtest says little about the future. Test on data you did not tune on, and treat results with suspicion before risking money.

## Project layout

```
server.py                 local server: static files, strategy files, Yahoo/Binance proxy, trader.dev client
strategies/*.js           strategies (one file each)
pine/*.pine               Pine scripts for the trader.dev tab
research/                 strategy studies (sweeps, paper replications, strategy search) and library.json
data/                     drop CSV files here
web/index.html            the app
web/js/engine.js          strategy compiler and bar-by-bar simulator
web/js/indicators.js      technical indicators (ta.*)
web/js/metrics.js         performance statistics
web/js/data.js            sample data, CSV parser, data loaders
web/js/optimizer.js       parameter sweeps
web/js/charts.js          charts (TradingView Lightweight Charts)
web/js/app.js             UI
web/js/traderdev.js       trader.dev tab
web/js/library.js         Library tab
tools/build_standalone.py bundles everything into one HTML file
tests/                    unit tests
```

## Tests

```bash
node --test tests/*.test.js                 # engine, indicators, metrics, CSV, optimizer
python3 -m unittest discover -s tests       # server
VWAPLAB_NETWORK_TESTS=1 python3 -m unittest discover -s tests   # also hit Yahoo and Binance
```

## Credits

Charts by [TradingView Lightweight Charts™](https://www.tradingview.com/) (Apache 2.0, see `web/vendor/`). Market data from Yahoo Finance and Binance public APIs; check their terms before using the data for anything beyond personal research.

This tool is for research and education. It is not financial advice.
