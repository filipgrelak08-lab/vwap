# Do intraday key levels work?

Tests whether the levels day traders watch stop price more often than nearby levels that mean
nothing. The data is 2 years of hourly bars (Oct 2024 to Oct 2026) for NQ=F, ES=F, QQQ and SPY from
Yahoo, downloaded 2026-10-10.

## Test 1: does price bounce off the level?

For each day and each level, find the first time price trades into it. From there, did price move
D back the way it came (a **bounce**) before moving D through the level (a **cross**)? D is 0.25 ×
the 14-day average daily range (headline), with 0.15 and 0.4 as robustness checks.

The same test runs on **placebo levels**: the real level shifted by ±0.15, 0.3, 0.45 and 0.6 daily
ATR. For round numbers (NQ 100s, ES 25s, QQQ/SPY $5s), the placebos are the quarter, half and
three-quarter points between them. A key level is one that bounces more often than its placebos.
The 95% intervals come from resampling whole days.

| Level | Touches | Bounce | Placebo bounce | Edge | 95% interval |
|---|---:|---:|---:|---:|---:|
| Previous day high | 499 | 37.9% | 36.8% | +1.1% | −3.6% to +5.7% |
| Previous day low | 246 | 33.7% | 35.4% | −1.6% | −7.7% to +4.7% |
| Previous day close | 464 | 36.6% | 34.1% | +2.5% | −2.1% to +7.3% |
| Overnight high (futures) | 324 | 41.0% | 35.8% | +5.3% | −0.4% to +11.3% |
| Overnight low (futures) | 198 | 35.9% | 35.5% | +0.4% | −6.6% to +7.8% |
| Today's open | 643 | 37.9% | 39.8% | −1.9% | −5.8% to +2.5% |
| First-hour high (ETFs) | 420 | 41.7% | 38.7% | +2.9% | −2.3% to +8.2% |
| First-hour low (ETFs) | 292 | 37.0% | 40.5% | −3.6% | −9.5% to +2.5% |
| Round number | 1,710 | 34.7% | 36.6% | −1.9% | −4.1% to +0.3% |

**No level shows a reliable edge.** Every interval includes zero. The overnight high comes closest:
it is positive at all three distances (+7.0%, +5.3%, +3.8%) and for both NQ and ES, but with nine
levels tested at three distances, a result this size is expected by chance. Round numbers, if
anything, bounce slightly *less* than the points between them. Per-symbol results (in
`bounce_test.csv`) flip sign from one symbol to the next, which is what noise looks like.

Bounce rates are below 50% for real and placebo levels alike. Part of that is the method: a touch
candle that had already moved D back is thrown out, because hourly bars can't show whether that
happened before or after the touch. It affects real and placebo levels equally, so the comparison
holds.

## Test 2: when is the day's high and low set?

QQQ and SPY, 988 full sessions (494 days × 2 symbols), compared with a random walk that has each
hour's real volatility, and one with the same volatility all day:

| Hour | Day's high here | Day's low here | Random walk, real volatility | Random walk, flat volatility |
|---|---:|---:|---:|---:|
| 9:30 | 35.9% | 44.6% | 33.6% | 25.2% |
| 10:30 | 11.5% | 11.6% | 11.1% | 12.1% |
| 11:30 | 8.9% | 8.3% | 8.4% | 10.4% |
| 12:30 | 6.8% | 7.0% | 10.9% | 9.7% |
| 13:30 | 7.3% | 7.3% | 9.2% | 10.4% |
| 14:30 | 11.7% | 8.3% | 10.0% | 14.6% |
| 15:30 (half hour) | 17.8% | 12.9% | 16.8% | 17.5% |

- **The first hour does set the extreme unusually often, but mostly because it is the most volatile
  hour.** Even a random walk sets its high or low in the first hour 25% of the time (the arcsine
  law), and 34% once it has the real first-hour volatility. Highs (35.9%) are close to that.
- **Lows are set in the first hour more than volatility explains** (44.6% vs 33.6%). Over a period
  when NQ rose from about 20,000 to 31,000, that fits "low early, rally later" and may not hold in a
  falling market.
- **Midday (12:30–14:30) sets fewer extremes than chance.** Price tends to stay inside the range
  already made.
- **Range after the first hour:** the day's range reached 1.5× the first hour's range on 62.6% of
  days and 2× on 33.3%. Both sides of the first hour were broken on 22.5% of days.

## Limits

- Hourly bars are coarse. A level touched and rejected within a few minutes, which is how these
  levels are usually traded, is invisible here. Five-minute data would be better, but Yahoo only
  keeps 60 days of it.
- For futures, the "day" is 9:00–16:00 because the hourly bars start on the hour, so the cash open at
  9:30 sits inside the 9:00 bar. QQQ and SPY have exact 9:30 sessions.
- Yahoo's NQ=F and ES=F are the front contract without roll adjustment.
- Two years of a mostly rising market.

## Files

| File | Contents |
|---|---|
| `analyze.py` | The tests. `python3 research/key_levels/analyze.py` downloads the data to `bars.json` (not committed) and rewrites the tables |
| `bounce_test.csv` | Every level × distance × scope (all symbols, then each symbol) with intervals and one-sided p-values |
| `timing_test.csv` | The hour-of-extreme table |
| `summary.json` | First-hour range statistics |
