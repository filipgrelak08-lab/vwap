# EMA crossover sweep

Every combination of fast and slow EMA from these lengths (420 pairs, both "trend" pairs where
fast < slow and swapped "dip" pairs where fast > slow):

`2 3 4 5 7 9 12 15 20 25 30 40 50 60 75 100 125 150 200 250 300`

Run on 6 symbols (SPY, QQQ, IWM, DIA, AAPL, MSFT) and 2 timeframes:

- **Daily**, full Yahoo history (back to 1980–2000 depending on the symbol)
- **Hourly**, the last 2 years (Yahoo's limit)

Rules: long only, 100% of equity, 0.02% commission + 0.01% slippage per side, fills at the next bar's
open. Buy when fast crosses above slow, sell when it crosses back below.

Each dataset is split: the first 70% is **in-sample** (where you'd pick settings) and the last 30% is
**out-of-sample** (later data the settings never saw). Data downloaded 2026-10-01.

## Files

| File | Contents |
|---|---|
| `all_runs.csv` | One row per symbol × timeframe × pair (5,040 rows): return, CAGR, Sharpe, max drawdown, trades, win rate and time in market for both periods, plus buy and hold for comparison |
| `summary_by_pair.csv` | One row per timeframe × pair, averaged over the 6 symbols, sorted by out-of-sample Sharpe |
| `datasets.csv` | Date ranges per dataset, buy-and-hold results, and how well in-sample ranking predicted out-of-sample ranking |
| `run.js`, `fetch_data.py` | Re-run it: `python3 research/ema_sweep/fetch_data.py data.json` then `node research/ema_sweep/run.js data.json` |

## Findings

**No pair clearly beats buy and hold.** Every one of the 420 daily pairs made less money than simply
holding over the out-of-sample years (2012–2018 → 2026, a strong bull market). The best pairs match
buy-and-hold's risk-adjusted return (Sharpe ≈ 0.79 vs 0.79) with smaller drawdowns.

**Daily, the best region is a very short fast EMA (2–5) against a slow EMA of 25–30 or 125–150.**
Neighbouring pairs score almost the same, which is a good sign: it's a zone, not a lucky single cell.
The standout is **4/30**, which beat buy-and-hold's Sharpe on 5 of 6 symbols out-of-sample:

| 4/30, out-of-sample | Return | Buy and hold | Max drawdown | Buy and hold DD | Trades |
|---|---|---|---|---|---|
| SPY | +172% | +312% | −16% | −34% | 53 |
| QQQ | +221% | +343% | −16% | −35% | 41 |
| IWM | +68% | +100% | −37% | −41% | 50 |
| DIA | +85% | +139% | −16% | −37% | 43 |
| AAPL | +939% | +2,008% | −25% | −39% | 78 |
| MSFT | +189% | +1,283% | −32% | −37% | 86 |

So 4/30 roughly halves the worst drawdown but gives up a large part of the return. Whether that trade-off
is worth it depends on you; on its own it is not an edge over holding.

**Trend beats dip on daily data.** Average out-of-sample Sharpe: trend pairs 0.68, swapped dip pairs 0.42.
The classic 50/200 averaged 0.62 and 100/9 (a dip pair) 0.40.

**Hourly results are not reliable.** The 30% out-of-sample window is only about 7 months, with 5–15 trades
per run. For SPY and QQQ the pairs that ranked best in-sample ranked *worst* out-of-sample (rank correlation
−0.54 and −0.59), and the top out-of-sample pairs had near-zero in-sample Sharpe. Picking hourly settings
from the past would not have worked here.

**On daily data, past rankings did carry over somewhat** (rank correlation 0.2–0.8 between in-sample and
out-of-sample Sharpe), so daily sweeps are more trustworthy than hourly ones.

Caveats: 6 large US symbols that all went up a lot (survivorship bias), one split point, no taxes, and
fractional shares. Treat this as a screen, not proof.
