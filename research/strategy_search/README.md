# Strategy search: which published crypto strategies survive out of sample?

Eleven families of published or well-known daily rules, 46 settings, nine coins, with the settings chosen
on one period and judged on another. The finalists were then re-run on trader.dev (Bybit perpetuals).
The results feed the app's **Library** tab (`research/library.json`).

## Method

- **Coins:** BTC, ETH, LTC, BCH, LINK (data from 2015–2019) plus SOL, ADA, DOGE, AVAX (from 2021). Coinbase daily
  candles. These are coins that still trade today, so there is some survivorship bias.
- **Pick on 2015 → 2021, judge on 2022 → Oct 2026.** For each family, the setting with the best median Sharpe
  across the five older coins before 2022 is the one used for the verdict. It is then measured on all nine coins
  after 2022, data it never saw, and separately from April 2025 (after the newest paper's data ended).
- **Execution:** signal on the daily close, position held the next day; 0.07% cost per side (0.05% fee + 0.02%
  slippage) whenever the position changes. Long or cash unless the rule says long/short. Each coin's first year is
  warm-up and not counted.
- **Summary numbers** are the median coin (Sharpe, max drawdown) or the mean (CAGR), so one lucky coin can't
  carry a rule. The equal-weight portfolio is the rule run on all nine coins at once, rebalanced daily.

## Families tested

| Family | Settings | Source |
|---|---|---|
| Donchian trend, single lookback | 10–150 days | Zarattini, Pagani & Barbon (2025), [Catching Crypto Trends](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=5209907) |
| Donchian ensemble (9 lookbacks, 5–360 days) | average, 25% vol target (the paper's version), 34/50/67% vote | same |
| Time-series momentum | 10–180 days, long/cash and long/short | Moskowitz, Ooi & Pedersen (2012); Liu & Tsyvinski (2021) |
| Close above SMA | 10–200 days | Faber (2007); Grayscale (50-day MA on BTC) |
| SMA crossover | 10/50, 20/50, 20/100, 50/200 | classic |
| N-day high hold | 10–50 days | Padyšák & Vojtko (2022), [SSRN 4081000](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=4081000) |
| Volatility breakout | k = 0.3, 0.5, 0.7, with and without a 50-day SMA filter | Larry Williams |
| RSI(2) pullback | RSI(2) below 5, 10, 20 above the 200-day SMA | Connors & Alvarez (2009) |

## Findings

**Everything looked good before 2022, and almost everything got worse after.** Median in-sample Sharpe was
1.0–1.6 for most families; after 2022 it was 0.1–0.6. Buy and hold went from 1.30 to 0.33 (altcoins mostly fell),
so trend rules still beat holding, but by far less than the backtests suggested.

Best in-sample setting per family, judged after 2022 (nine coins):

| Rule (setting picked before 2022) | Sharpe before 2022 | Sharpe 2022 → | Mean CAGR 2022 → | Median max DD | Beat buy and hold | Sharpe Apr 2025 → |
|---|---|---|---|---|---|---|
| Donchian ensemble, 25% vol target (paper) | 1.44 | **0.59** | +6.4% | −15.5% | 7 of 9 | 0.17 |
| 50-day high hold | 0.51 | **0.55** | +13.6% | −27.9% | 6 of 9 | **0.52** |
| Time-series momentum 30 days | 1.56 | 0.53 | +7.7% | −74.1% | 5 of 9 | −0.03 |
| Donchian 10 days | 1.42 | 0.44 | +14.2% | −53.9% | 6 of 9 | 0.07 |
| Donchian ensemble, 67% vote | 1.42 | 0.41 | +5.4% | −42.8% | 3 of 9 | −0.64 |
| Close above SMA 20 | 1.50 | 0.40 | +8.1% | −69.8% | 5 of 9 | 0.17 |
| SMA 20/100 crossover | 1.40 | 0.36 | +8.1% | −60.6% | 5 of 9 | 0.26 |
| Buy and hold | 1.30 | 0.33 | −1.7% | −80.1% | – | 0.25 |
| Momentum 30 days long/short | 1.02 | 0.30 | −13.3% | −80.6% | 2 of 9 | −0.03 |
| RSI(2) below 10 | 0.34 | 0.27 | +0.7% | −31.4% | 3 of 9 | 0.52 |
| Volatility breakout k = 0.5 | 1.51 | 0.11 | −9.8% | −66.4% | 1 of 9 | −0.14 |
| Volatility breakout k = 0.3 + SMA filter | 1.49 | −0.01 | −10.6% | −60.0% | 2 of 9 | 0.13 |

(`summary.csv` has all 46 settings plus buy and hold; `runs.csv` every coin and period.)

1. **N-day high hold is the most consistent rule.** Hold the coin for the next day only when today's close is the
   highest of the last N days. With N of 30 or 50 it beat buy and hold on 6 of 9 coins after 2022, and every N from
   10 to 50 did so on 6–7 of 9 after April 2025. Median drawdowns were −28% to −42% after 2022 and about −20% since
   April 2025. It sits in cash 84–94% of the time, so it gives up return in strong bull markets. As a nine-coin portfolio after 2022: Sharpe 0.96, max drawdown −13% (buy and hold: 0.32, −72%).
2. **The Donchian ensemble catches the big trends.** On trend-heavy coins it beat buy and hold by a wide margin (BTC,
   SOL, AVAX), but it struggled on choppy ones (DOGE, ETH, LTC, BCH). The paper's own volatility-targeted version had
   the best risk-adjusted result from 2022 to early 2025 but has been weak since the paper came out, and it needs
   daily position sizing that the app and trader.dev can't do. The all-in 50% vote version is what the app runs.
3. **Shorting didn't pay.** Every long/short variant was worse than its long/cash twin after 2022.
4. **Volatility breakout is a curve-fit.** Its in-sample Sharpe of 1.5 fell to 0.1, and its results swing wildly with k.
5. **RSI(2) mean reversion** has a small edge but trades so rarely that returns are near zero.
6. **Fast settings decayed most.** TSMOM 30d and Donchian 10d led before 2022 and were flat after April 2025. Slower
   settings such as close above the 150-day SMA held up better (Sharpe 0.57 after 2022, 0.51 after April 2025), but
   picking them now would be hindsight.

## trader.dev check (Bybit perpetuals, 0.05% per side, 100% of equity)

The two finalists, run through the app's trader.dev connection on six coins from each coin's first Bybit day
(BTC Mar 2020; ETH Mar 2021; SOL Oct 2021). Return · Sharpe · max drawdown since 2022:

| Coin | Donchian Trend Ensemble | 50d High Hold | Buy and hold |
|---|---|---|---|
| BTC | +188% · 0.94 · −20% | +78% · 0.76 · −21% | +77% · 0.49 · −67% |
| ETH | +15% · 0.25 · −39% | +18% · 0.31 · −21% | −29% · 0.24 · −74% |
| SOL | +414% · 0.95 · −41% | +222% · 0.92 · −25% | −34% · 0.41 · −94% |
| LINK | +66% · 0.45 · −40% | −16% · −0.04 · −40% | −33% · 0.33 · −82% |
| DOGE | −4% · 0.23 · −64% | +536% · 1.11 · −24% | −46% · 0.29 · −85% |
| AVAX | +462% · 1.02 · −33% | +79% · 0.53 · −28% | −90% · −0.07 · −95% |

The ensemble beat buy and hold's Sharpe on 4 of 6 coins and tied on ETH; the high hold on 5 of 6. Both had much
smaller drawdowns than buy and hold on every coin. Result IDs are in `traderdev_runs.json`; every run opens in the app's Library tab.

**Verdict:** for a single coin, the 50-day high hold is the safest choice and the Donchian ensemble the one with the
most upside. Neither is a guaranteed edge: after 2022 both earned less than their pre-2022 backtests promised, the
coins tested are survivors, and trader.dev ignores funding costs, which longs on perpetuals usually pay.

## Files

| File | Contents |
|---|---|
| `fetch_daily.py` | Downloads the Coinbase daily candles |
| `search.py` | The rules, the in/out-of-sample split, and the statistics; writes `runs.csv`, `summary.csv`, `picks.csv` |
| `traderdev_runs.json`, `traderdev_check.py` | trader.dev result IDs, and the script that splits those runs into periods (`traderdev_summary.csv`) |
| `build_library.py` | Builds `research/library.json` for the app's Library tab from the CSVs above |

Re-run: `python3 research/strategy_search/fetch_daily.py daily.json`, `python3 research/strategy_search/search.py daily.json`,
`python3 research/strategy_search/traderdev_check.py`, `python3 research/strategy_search/build_library.py`.
Data downloaded 2026-10-03.
