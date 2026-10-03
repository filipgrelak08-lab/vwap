# Bitcoin seasonality, trend and mean reversion: does the paper's edge survive?

**Paper:** Padyšák, M. and Vojtko, R. (2022), *Seasonality, Trend-following, and Mean reversion in Bitcoin*,
[SSRN 4081000](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=4081000). Gemini BTC data, 26 Nov 2015 – 3 Feb 2022.
Summaries: [Quantpedia (trend/mean reversion)](https://quantpedia.com/trend-following-and-mean-reversion-in-bitcoin/),
[Quantpedia (seasonality)](https://quantpedia.com/strategies/intraday-seasonality-in-bitcoin),
[Quantpedia's own 2024 revisit](https://quantpedia.com/revisiting-trend-following-and-mean-reversion-strategies-in-bitcoin/).

It reports three edges:

| Edge | Rule | Reported result |
|---|---|---|
| Seasonality | Long BTC 21:00–23:00 UTC every day, flat otherwise (Quantpedia lists it as 22:00 + 2h) | ~33%/yr, 20.9% vol, Sharpe 1.58, max DD −34% |
| Trend (MAX) | If today's close is the highest of the last 10 days, hold BTC tomorrow | (combined below) |
| Mean reversion (MIN) | If today's close is the lowest of the last 10 days, hold BTC tomorrow | (combined below) |
| MAX + MIN | Hold tomorrow if either is true | 98.4%/yr, 47.8% vol, max DD −37.7% (buy and hold: 74.4% vol, −83.7% DD) |

None of the reported numbers include trading costs.

## How it was tested

1. **Coinbase BTC-USD spot, hourly, 2015 → 3 Oct 2026** (98,179 bars). This covers the paper's own sample, to check
   the replication, and the 4.7 years since it was posted, which the authors could not have seen.
2. **trader.dev backtests on the Bybit BTCUSDT perpetual**, Mar 2020 → 3 Oct 2026 (the history it has), using the
   Pine scripts in the repo's top-level `pine/` folder (also runnable from the app's trader.dev tab). trader.dev always charges 0.05% per side, 100% of equity, fills at bar close.

"paper" = 26 Nov 2015 – 3 Feb 2022 (Coinbase) or 26 Mar 2020 – 3 Feb 2022 (trader.dev). "after" = 4 Feb 2022 – 3 Oct 2026.
Costs: taker 0.05%/side (≈ Bybit perp taker), maker 0.02%/side.

## Findings

**The replication works.** On Coinbase data over the paper's dates, without costs, 10d MAX+MIN gives 103.8%/yr,
49.1% vol, −44.3% max DD and a return/vol of 2.11 (paper: 98.4%, 47.8%, −37.7%, 2.06). Buy and hold matches too
(76.8% vol, −83.8% DD vs 74.4%, −83.7%). In the hour-of-day table, 21:00–22:00 and 22:00–23:00 UTC were the two best
hours of the day (+5.9 and +6.0 bps per hour, t ≈ 3.1–3.2), exactly the paper's window.

**1. Seasonality: real but too small to trade.** The average 21:00–23:00 trade earned 11.8 bps before costs during
the paper's sample and **5.2 bps** since. A taker round trip costs 10 bps. Results after the paper:

| 21:00–23:00 UTC, after | CAGR | Sharpe | Max DD |
|---|---|---|---|
| Coinbase, no costs | +19.8% | 1.38 | −21.8% |
| Coinbase, maker 0.02%/side | +3.5% | 0.32 | −28.7% |
| Coinbase, taker 0.05%/side | −16.8% | −1.27 | −57.7% |
| trader.dev Bybit perp, 0.05%/side | −16.9% | −1.30 | −57.9% |

Before fees, trader.dev and Coinbase agree closely: +130% and +132% total since Feb 2022. Fees turn that into −58%.
Even in the paper's own sample the strategy made only +4%/yr at taker fees. Quantpedia's 22:00–24:00 version is
worse: 23:00–24:00 has become the 23rd-best hour, and trader.dev shows −88% for it over 2020–2026. The 22:00–23:00
hour is still the best hour of the day after the paper (+3.5 bps, t = 2.7), but that is below even maker fees for a
round trip.

**2. Mean reversion (MIN): gone.** Since the paper, MIN loses money at every lookback from 10 to 50 days (Coinbase,
taker: −1.4% to −4.3%/yr; trader.dev 10d: −17% total). Quantpedia's 2024 revisit says the same.

**3. Trend (MAX): survives, but as lower risk, not higher return.** After the paper, with costs:

| After Feb 2022 | CAGR | Vol | Sharpe | Max DD | Days in market |
|---|---|---|---|---|---|
| 10d MAX only (Coinbase) | +8.8% | 20.8% | 0.51 | −23.0% | 19% |
| 30d MAX only (Coinbase) | +11.0% | 17.5% | 0.68 | −15.7% | 11% |
| 10d MAX only (trader.dev) | +12.0% | 22.2% | 0.62 | −21.2% | – |
| 10d MAX+MIN (Coinbase) | +7.3% | 32.0% | 0.38 | −41.4% | 34% |
| 10d MAX+MIN (trader.dev) | +7.7% | 33.0% | 0.39 | −44.7% | – |
| Buy and hold (Coinbase) | +19.2% | 50.8% | 0.60 | −66.8% | 100% |
| Buy and hold (trader.dev) | +16.4% | 51.1% | 0.55 | −66.7% | 100% |

MAX alone roughly matches buy and hold's Sharpe with about a third of the drawdown, while holding BTC only 10–20%
of the time. It earns less than buy and hold. All lookbacks from 10 to 50 days behave alike, so this is not one
lucky setting. Over 4.7 years a Sharpe estimate has a standard error of about 0.5, so "about the same as buy and
hold" is all the data can say. The paper's headline combined strategy is now **worse** than buy and hold
(Sharpe 0.38 vs 0.60), because the dead MIN leg drags it down.

**Verdict:** the published edge is real in the sample it was found in, and it replicates. After publication the
seasonality edge shrank to less than trading costs, and the mean-reversion leg disappeared. Only "hold BTC while it
is at a new N-day high" still works, and only as a way to hold BTC with smaller drawdowns, not as a source of
extra return.

Caveats: perpetual funding (longs usually pay it in rising markets) and slippage are not modelled; one asset; one
split date; the paper picked its hours and lookbacks after looking at the same data, which is why the "after" column
matters more than the "paper" one.

## trader.dev runs

Full window, Mar 2020 – Oct 2026, 0.05%/side:

| Strategy | Return | Max DD | Sharpe | Trades | Report |
|---|---|---|---|---|---|
| Seasonality 21–23 UTC (1h) | −54.5% | −65.9% | −0.67 | 2,377 | [link](https://mcp-api.trader.dev/backtest/01M41Y4GPYQ05Q5BFMFPBP96MH) |
| Seasonality 22–24 UTC (1h) | −88.0% | −88.1% | −1.95 | 2,378 | [link](https://mcp-api.trader.dev/backtest/01M41Y808VYDKDX225QVEBBMJZ) |
| 10d MAX+MIN (1D) | +499.9% | −51.9% | 0.94 | 432 | [link](https://mcp-api.trader.dev/backtest/01M41Y8EAPAMD32PCS12Y1N3Q8) |
| 10d MAX only (1D) | +257.8% | −23.6% | 0.91 | 242 | [link](https://mcp-api.trader.dev/backtest/01M41Y8ZVSHME7R13GRTCG47B1) |
| 10d MIN only (1D) | +67.1% | −46.0% | 0.43 | 193 | [link](https://mcp-api.trader.dev/backtest/01M41Y91YQG9V0MK9Y8XV2YPK7) |
| Buy and hold (1D) | +1,153% | −76.7% | 0.96 | open | [link](https://mcp-api.trader.dev/backtest/01M41Y93V9F39HHRD28CHEPK54) |

## Files

| File | Contents |
|---|---|
| `coinbase_hour_of_day.csv` | Mean hourly return, t-stat and rank for each UTC hour, paper period vs after |
| `coinbase_seasonality.csv` | 21–23 and 22–24 UTC strategies, both periods, no / maker / taker costs |
| `coinbase_max_min.csv` | MAX, MIN and MAX+MIN for lookbacks 10–50, both periods, with and without costs, plus buy and hold |
| `traderdev_runs.csv` | The trader.dev runs above split into paper / after, with gross (pre-fee) returns |
| `../../pine/*.pine` | The Pine v6 scripts run on trader.dev (also work in TradingView) |
| `../../strategies/hour_window.js`, `nday_high_low.js` | The same rules as VWAP Lab strategies, to run locally on any data |
| `fetch_coinbase.py`, `analyze.py` | Re-run it: `python3 research/btc_paper_edges/fetch_coinbase.py btc_usd_1h.csv` then `python3 research/btc_paper_edges/analyze.py btc_usd_1h.csv` |

Data downloaded 2026-10-03.
