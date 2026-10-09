# Nasdaq day-trading strategies, one lever at a time

Tests the strategies from the YouTube video *"I Backtested 10,000 Strategies PART 2 – AI made them
profitable without overfit"* (Lil Fish), plus three published day-trading strategies, using the video's
own method: start from the plain strategy, add one rule ("lever") at a time, and check every step on
later data the rules were never tuned on.

The video does not publish its exact rules, so the six video strategies are standard versions of the
names it shows: opening range breakout, VWAP sigma reversion, SuperTrend flip, volume spike breakout,
liquidity sweep reclaim and the candle-2 (fractal) model. The three published ones follow their papers:

- **5-minute ORB**: Zarattini & Aziz (2023), *Can Day Trading Really Be Profitable?*
- **Intraday momentum** (last half hour follows the first): Gao, Han, Li & Zhou (2018), *Market Intraday Momentum*
- **Noise-area momentum** (break out of the usual intraday range, trail at VWAP): Zarattini, Aziz & Barbon (2024), *Beat the Market*

## Setup

- **Data**: Dukascopy Nasdaq-100 CFD (USATECHIDXUSD), 1-minute bars aggregated to 5 and 15 minutes,
  regular hours 09:30–16:00 New York time, 2019-01-02 to 2026-10-08 (1,938 sessions). Volume is tick volume.
- **Learn period** 2019–2024 picks the levers. **Test period** 2025-01-02 to 2026-10-08 is only looked at afterwards.
- **Levers** (one per group): 15-minute bars, long or short only, entry window, daily trend
  (prior close vs 20-day SMA), VWAP side, opening-gap direction, room to the prior-day high/low,
  ATR stop, R target, break-even at 1R, one trade a day.
- **Choosing a lever**: the one that most raises the t-statistic of the average R on the learn period,
  needing at least 150 learn trades. (Raw expectancy would reward keeping a few lucky trades.)
- **Final version**: at most 3 levers, fixed before looking at the test period. This is the video's own
  conclusion: beyond about three rules, test results got worse.
- **Costs and sizing**: 0.0015% slippage and 0.0005% commission per side (about 0.3 index points plus $2 on
  an NQ contract), 1% of equity risked per trade, flat at the close.

## Results

Final versions (≤ 3 levers), measured in R (multiples of the initial risk). `t` is the average R
divided by its standard error: around 2 or more means unlikely to be luck.

| Strategy | Levers | Learn trades | Learn avg R | Learn t | Test trades | Test avg R | Test t | Test return (1% risk) | Test max DD |
|---|---|---|---|---|---|---|---|---|---|
| **Noise-area momentum** | stop 1.5×ATR, longs only, room ≥ 2 ATR | 668 | +0.31 | 5.0 | 178 | **+0.21** | 1.65 | +42% | −14% |
| **Opening range breakout** | daily trend, stop 2×ATR, target 3R | 752 | +0.19 | 3.4 | 189 | **+0.16** | 1.49 | +32% | −16% |
| 5-min ORB (Zarattini) | stop 1×ATR, room ≥ 5 ATR, break-even 1R | 935 | +0.29 | 3.5 | 302 | +0.03 | 0.23 | 0% | −28% |
| 5-min ORB, published rules (no levers) | – | 1,495 | +0.13 | 2.1 | 439 | +0.14 | 1.26 | | |
| Candle-2 reversal | daily trend, target 2R, longs only | 883 | +0.09 | 2.3 | 216 | −0.01 | −0.18 | −4% | −23% |
| SuperTrend flip | VWAP side, 15m bars, target 2R | 976 | +0.07 | 3.2 | 270 | −0.02 | −0.59 | −6% | −13% |
| Liquidity sweep reclaim | entries until 14:00, daily trend | 345 | +0.22 | 1.9 | 96 | −0.05 | −0.35 | −5% | −17% |
| Intraday momentum | daily trend, shorts only | 207 | +0.07 | 1.1 | 72 | −0.02 | −0.18 | −2% | −12% |
| VWAP sigma reversion | gap direction, break-even 1R, room ≥ 5 ATR | 2,017 | +0.08 | 1.3 | 516 | −0.07 | −0.68 | −32% | −46% |
| Volume spike breakout | target 2R | 163 | +0.22 | 2.1 | 9 | −0.35 | – | | |

Every step for every strategy is in `steps.csv`; every lever tried at every step is in `candidates.csv`.

### What this shows

**Most of the "fixed" strategies were overfit, exactly as the video warns.** Adding levers kept improving the
learn results while test results stayed flat or got worse. VWAP sigma reversion is the clearest case: with
five levers the learn period showed +0.35R per trade (t = 2.2) and the test period −0.36R (t = −2.3).

**Two held up: noise-area momentum (long only) and the opening range breakout with the daily trend.**
Both were positive on the test period and in every calendar year from 2019 to 2026, including 2022 when
the Nasdaq fell about a third (R per year in `final.csv`). `robustness.js` checks them further
(`robustness_NQ.csv`):

- **Neighbouring settings also work.** Different stops, room filters, targets and range lengths all stayed
  positive on the test period (except a 30-minute opening range), so this is a plateau, not one lucky cell.
- **Costs are not the issue.** At three times the costs, test average R falls only to +0.17 and +0.14.
- **It is not just market drift.** Buying at the same time of day with the same stop and target lost money
  in 2025–26 (−0.07R and −0.04R per trade).

**But none of it is proven.** About 180 test trades over 21 months give t ≈ 1.5–1.7, below the usual
bar of 2. These are the best candidates here, not a guarantee. Also, CFD data is not futures data,
fills are modelled at the next bar's open, and the noise-area strategy only goes long.

## Prop-firm version: one trade a day

`prop_study.js` asks a different question: which strategy, taking **at most one trade a day**, passes a
50K futures evaluation most often? Rules modelled (Topstep 50K Combine / Apex 50K end-of-day style):
+$3,000 target, $2,000 maximum loss trailing the best end-of-day balance (it stops at the starting
balance), $1,000 daily loss limit, best day under 50% of the total profit, at least 2 trading days. A
trade's worst point (MAE) counts against the limit intraday. An evaluation is started on every session
and given up to 120 trading days; one that neither passes nor fails counts as not passed. The risk per
trade (a fixed dollar amount) is chosen on 2019–2024 and then used unchanged on 2025–2026.

Pass rates alone mislead: with a $3,000 target and a $2,000 trailing loss, a strategy with **no edge**
still passes fairly often by luck. So every candidate also runs a control: the same trades with their
average R subtracted (same swings, zero edge). The useful number is the gap between the two.

One more classic once-a-day rule was added here: a **volatility breakout** (Larry Williams / Toby Crabel
style: close more than k × the prior day's range beyond the open). Its settings (k = 0.3, daily trend,
1.5 × ATR stop) were picked on 2019–2024.

| Strategy (max 1 trade a day) | Days traded | Win rate | Learn avg R | Test avg R | Risk/trade | Learn pass (no-edge) | Test pass (no-edge) | Test fail |
|---|---|---|---|---|---|---|---|---|
| **Combo: first signal of ORB + trend, noise-area long, volatility breakout** | 73% | 38–40% | +0.23 | +0.13 | $200 | **64% (12%)** | **37% (7%)** | 35% |
| Opening range breakout + daily trend | 50% | 41–43% | +0.19 | +0.16 | $300 | 53% (23%) | 46% (36%) | 42% |
| Combo of ORB + trend and noise-area long | 61% | 41% | +0.23 | +0.08 | $300 | 60% (27%) | 32% (25%) | 61% |
| Volatility breakout + daily trend | 56% | 34–38% | +0.28 | +0.16 | $200 | 61% (13%) | 18% (1%) | 25% |
| 5-min ORB, published rules | 100% | 24–28% | +0.13 | +0.14 | $150 | 44% (20%) | 45% (28%) | 52% |
| Noise-area momentum, long only | 30% | 38–42% | +0.33 | +0.03 | $300 | 57% (25%) | 1% (0%) | 38% |

Full numbers, including R per calendar year, are in `prop_study.csv`; pass and fail rates at every risk
level are in `prop_risk.csv`.

**The best fit is the three-rule combo**, saved as one strategy: `strategies/nq_prop_combo.js`
(it reproduces the study: 1,094 trades at +0.23R on 2019–2024, 294 at +0.13R on 2025–2026). It trades
on about three days in four, was positive in every calendar year 2019–2026, and has the widest gap over
luck. Notes:

- **Keep the risk small.** Pass rates peak at $150–250 per trade and fall fast above $300 (2025–26 at
  $300: 25% pass, 73% fail). The 5-minute ATR on NQ in 2025–26 was about 34 points (middle half 24–47),
  so a 1.5 × ATR stop is about 50 points: $200 of risk is about 2 MNQ contracts.
- **It is slow.** At $200 a trade it makes roughly $20–35 a day on average, so passes take about
  50 trading days (median), and many 2025–26 runs were still going after 120 days.
- **The noise-area rule needs its re-entries.** Alone and limited to one trade a day, its 2025–26 edge
  disappears (+0.03R), so it only works here as one leg of the combo.
- **Nasdaq, not the S&P 500.** Run unchanged on the S&P 500 CFD, the combo is positive but weaker:
  +0.10R a trade in 2019–2024 (t = 2.0) and +0.04R in 2025–2026 (t = 0.5).
- **The 5-minute ORB paper.** Its published rules were positive here (+0.14R on 2025–26), but with a
  24–28% win rate and losing streaks of 13 it fails more evaluations than it passes. An independent
  replication on CFD data found no edge after costs, so treat it with care.

None of this is a guarantee. Prop firms change rules often, and real fills on news days and at the open
can be worse than modelled. Check the current rules of your firm before relying on these numbers.

## Re-running

```bash
python3 research/video_strategies/fetch_dukascopy.py raw/ 2019-01-01 2026-10-08   # ~2,000 files; resumable
python3 research/video_strategies/build_data.py raw/ nq.json
node research/video_strategies/run.js nq.json research/video_strategies       # ~8 minutes
node research/video_strategies/robustness.js nq.json research/video_strategies
node research/video_strategies/prop_study.js nq.json research/video_strategies
```

The strategies are in `strategies/nq_*.js` and appear in the app. Each has the same filter switches as
the levers here (direction, daily trend, VWAP side, gap, room to prior-day level, own stop/target on or off).
To use a final version, set those switches and the matching Stops panel values (ATR stop, reward:risk).
