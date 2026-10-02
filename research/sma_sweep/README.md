# SMA crossover sweep

Same setup as `../ema_sweep` (420 fast/slow pairs from 2 to 300, 6 symbols, daily full history and
2 years hourly, long only, 0.02% commission + 0.01% slippage, next-open fills, 70/30 split), but with
simple moving averages. Produced by `node research/ema_sweep/run.js data.json research/sma_sweep sma`.
`all_runs.csv` and `summary_by_pair.csv` also include full-history results (`full_*` columns).

## Most profitable pairs (daily, averaged over SPY, QQQ, IWM, DIA, AAPL, MSFT)

| Pair | Avg CAGR, full history | Avg worst drawdown | Out-of-sample Sharpe |
|---|---|---|---|
| Buy and hold | **13.95%** | −67% | 0.79 |
| 200/250 | 11.14% | −45% | 0.59 |
| 125/300 | 10.85% | −48% | 0.60 |
| 150/300 | 10.80% | −45% | 0.68 |
| 7/300 | 10.70% | −44% | 0.77 |
| 9/300 | 10.65% | −45% | 0.75 |
| 50/200 (golden cross) | 9.12% | −53% | 0.61 |
| 20/50 | 8.46% | −52% | 0.60 |

- No SMA pair beat buy and hold on average. The best earned about 3 percentage points a year less.
- The most profitable pairs use a long slow average (250–300 days). They are mainly a "stay out of
  bear markets" filter, cutting the worst drawdown from about −67% to about −44%.
- The best pair differs for every symbol (SPY 200/300, QQQ 60/300, IWM 7/5, DIA 200/250, AAPL 2/30,
  MSFT 100/125), and each barely beats or trails buy and hold. Picking "the best pair" per symbol is
  curve fitting.
- Hourly: no pair beat buy and hold's return out-of-sample (best 16.4% vs 17.0%, on about 4 trades).
