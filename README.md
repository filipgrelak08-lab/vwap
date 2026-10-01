# VWAP Lab

A local backtester for trading strategies. Run one Python file, open your browser, pick or write a strategy, and see how it would have traded: equity curve, drawdown, every trade on the chart, monthly returns, and a parameter sweep with out-of-sample testing.

- **No installs.** The server uses only the Python standard library; the app is plain HTML/JS.
- **Strategies are small JavaScript files** in `strategies/`. Edit them in the built-in editor or in your own editor.
- **Data:** Yahoo Finance (stocks, ETFs, indices, FX, crypto), Binance (crypto), your own CSV files, or the built-in synthetic samples.
- **Eight example strategies** to start from: VWAP band reversion, VWAP trend pullback, opening range breakout, moving average crossover, RSI(2) pullback, Bollinger breakout, Donchian breakout and MACD trend.

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
3. **Execution and risk**: capital, position size, commission, slippage, fill timing, % stop loss / take profit / trailing stop, shorting, and an option to close positions at the end of each day.
4. **Results**: summary tiles, then tabs:
   - **Chart**: candles with indicators and entry/exit markers, plus equity vs buy and hold and drawdown. All charts zoom and pan together.
   - **Trades**: statistics and the full trade list. Click a trade to jump to it on the chart. Download as CSV.
   - **Monthly returns**: a calendar heatmap.
   - **Optimize**: sweep one or two parameters. Choose "Optimize on first 70%" to rank settings on the first part of the data and see how the best ones did on the rest.
   - **Code**: the strategy source. `Ctrl/⌘ + Enter` runs, `Ctrl/⌘ + S` saves to `strategies/<name>.js`.

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
| **position** | `ctx.isFlat`, `ctx.isLong`, `ctx.isShort`, `ctx.position.entryPrice`, `.barsHeld`, `.pnlPct`, `ctx.equity` |
| **session / time** | `ctx.newSession`, `ctx.lastBarOfSession`, `ctx.sessionBar` (0 = first bar of the day), `ctx.hour`, `ctx.minute`, `ctx.dayOfWeek` (0 = Sunday) |
| **orders** | `ctx.long(opts)`, `ctx.short(opts)`, `ctx.exit(reason)`, `ctx.cancel()`, `ctx.setStop(price)`, `ctx.setTarget(price)` |
| **order opts** | `stop`, `target` (prices), `trail` (%), `size` (0–1 of equity), `label`, `atClose: true` (fill at this bar's close) |
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
- Position size is a percentage of current equity, with fractional quantities. Commission is a percentage of traded value per side; slippage moves every fill against you.
- Statistics are annualised using the calendar span of the data, so they work for any bar size and for 24/7 markets. Sharpe and Sortino use a 0% risk-free rate.
- Intraday times are shown in the exchange's local time (UTC for Binance), so "the session" means the exchange's trading day.

A backtest is a model. It does not include partial fills, borrow costs, funding rates, dividends on short positions or market impact, and a good backtest says little about the future. Test on data you did not tune on, and treat results with suspicion before risking money.

## Project layout

```
server.py                 local server: static files, strategy files, Yahoo/Binance proxy
strategies/*.js           strategies (one file each)
data/                     drop CSV files here
web/index.html            the app
web/js/engine.js          strategy compiler and bar-by-bar simulator
web/js/indicators.js      technical indicators (ta.*)
web/js/metrics.js         performance statistics
web/js/data.js            sample data, CSV parser, data loaders
web/js/optimizer.js       parameter sweeps
web/js/charts.js          charts (TradingView Lightweight Charts)
web/js/app.js             UI
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
