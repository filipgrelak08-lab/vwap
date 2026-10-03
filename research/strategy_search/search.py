"""Search for daily crypto strategies that hold up out of sample.

    python3 research/strategy_search/fetch_daily.py daily.json
    python3 research/strategy_search/search.py daily.json

Every rule is a published or well-known one (see README.md). Each family has a few
settings. The setting used for the verdict is the one with the best median Sharpe
in-sample (before 2022, on the five coins that existed then); it is then judged on
2022 onward on all nine coins, which it never saw.

Signals use the daily close; the position is held the next day (close to close).
Costs: 0.07% per side (0.05% fee + 0.02% slippage) whenever the position changes.
Long/flat unless the name says long/short.
"""
import csv
import json
import math
import statistics
import sys
from collections import deque
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
DAY_MS = 86_400_000
SPLIT = int(datetime(2022, 1, 1, tzinfo=timezone.utc).timestamp() * 1000)
# Zarattini, Pagani & Barbon used data to March 2025; everything after is new to them too
POST_PAPER = int(datetime(2025, 4, 1, tzinfo=timezone.utc).timestamp() * 1000)
WARMUP_DAYS = 365  # every rule has its longest lookback filled before it is measured
COST = 0.0007
IS_COINS = ["BTC-USD", "ETH-USD", "LTC-USD", "BCH-USD", "LINK-USD"]
ENSEMBLE = (5, 10, 20, 30, 60, 90, 150, 250, 360)


# ---------------------------------------------------------------- indicators

def rolling(x, n, fn):
    """max or min of the last n values including today (None until n values)."""
    out, dq = [None] * len(x), deque()
    better = (lambda a, b: a >= b) if fn is max else (lambda a, b: a <= b)
    for i, v in enumerate(x):
        while dq and better(v, x[dq[-1]]):
            dq.pop()
        dq.append(i)
        if dq[0] <= i - n:
            dq.popleft()
        if i >= n - 1:
            out[i] = x[dq[0]]
    return out


def sma(x, n):
    out, s = [None] * len(x), 0.0
    for i, v in enumerate(x):
        s += v
        if i >= n:
            s -= x[i - n]
        if i >= n - 1:
            out[i] = s / n
    return out


def rsi(x, n):
    out = [None] * len(x)
    gain = loss = 0.0
    for i in range(1, len(x)):
        d = x[i] - x[i - 1]
        g, l_ = max(d, 0), max(-d, 0)
        if i <= n:
            gain += g / n
            loss += l_ / n
        else:
            gain = (gain * (n - 1) + g) / n
            loss = (loss * (n - 1) + l_) / n
        if i >= n:
            out[i] = 100 if loss == 0 else 100 - 100 / (1 + gain / loss)
    return out


def realized_vol(c, n):
    r = [0.0] + [c[i] / c[i - 1] - 1 for i in range(1, len(c))]
    out = [None] * len(c)
    for i in range(n, len(c)):
        out[i] = statistics.pstdev(r[i - n + 1:i + 1]) * math.sqrt(365)
    return out


# ---------------------------------------------------------------- rules -> positions held the next day

def tsmom(d, n, short=False):
    c = d["c"]
    return [0 if i < n else (1 if c[i] > c[i - n] else (-1 if short else 0)) for i in range(len(c))]


def above_sma(d, n, short=False):
    c, m = d["c"], sma(d["c"], n)
    return [0 if m[i] is None else (1 if c[i] > m[i] else (-1 if short else 0)) for i in range(len(c))]


def sma_cross(d, fast, slow):
    f, s = sma(d["c"], fast), sma(d["c"], slow)
    return [0 if s[i] is None else (1 if f[i] > s[i] else 0) for i in range(len(f))]


def donchian(d, n):
    """Zarattini, Pagani & Barbon (2025): enter when the close beats the highest close of the
    previous n days; trail a stop at the higher of the old stop and the channel midpoint."""
    c = d["c"]
    hi, lo = rolling(c, n, max), rolling(c, n, min)
    pos, stop, out = 0, 0.0, [0] * len(c)
    for i in range(n, len(c)):
        mid = (hi[i] + lo[i]) / 2
        if pos == 0 and c[i] > hi[i - 1]:
            pos, stop = 1, mid
        elif pos == 1:
            stop = max(stop, mid)
            if c[i] < stop:
                pos = 0
        out[i] = pos
    return out


def donchian_ensemble(d, vote=None, vol_target=None):
    """Average of the nine Donchian systems (fractional exposure). vote: go all-in when at least
    that share of systems is long. vol_target: the paper's 25% vol sizing, capped at 1x."""
    systems = [donchian(d, n) for n in ENSEMBLE]
    avg = [sum(s[i] for s in systems) / len(systems) for i in range(len(d["c"]))]
    if vote is not None:
        return [1 if a >= vote else 0 for a in avg]
    if vol_target:
        vol = realized_vol(d["c"], 90)
        return [0 if vol[i] in (None, 0) else a * min(1.0, vol_target / vol[i]) for i, a in enumerate(avg)]
    return avg


def max_hold(d, n):
    c, hi = d["c"], rolling(d["c"], n, max)
    return [1 if hi[i] is not None and c[i] >= hi[i] else 0 for i in range(len(c))]


def rsi2(d, entry=10, trend=200, exit_n=5):
    """Connors: buy RSI(2) dips while above the 200-day SMA, sell on a close above the 5-day SMA."""
    c, r, t, e = d["c"], rsi(d["c"], 2), sma(d["c"], trend), sma(d["c"], exit_n)
    pos, out = 0, [0] * len(c)
    for i in range(len(c)):
        if None in (r[i], t[i], e[i]):
            continue
        if pos == 0 and r[i] < entry and c[i] > t[i]:
            pos = 1
        elif pos == 1 and c[i] > e[i]:
            pos = 0
        out[i] = pos
    return out


def returns_from_positions(d, pos):
    c = d["c"]
    out = [0.0] * len(c)
    for i in range(1, len(c)):
        prev = pos[i - 2] if i >= 2 else 0
        out[i] = pos[i - 1] * (c[i] / c[i - 1] - 1) - COST * abs(pos[i - 1] - prev)
    return out, [0] + pos[:-1]


def vol_breakout(d, k, trend=None):
    """Larry Williams: buy when price rises k x yesterday's range above today's open, sell at the
    close. Simulated from daily bars: filled at the trigger level if the day's high reaches it."""
    o, h, l_, c = d["o"], d["h"], d["l"], d["c"]
    m = sma(c, trend) if trend else None
    rets, held = [0.0] * len(c), [0] * len(c)
    for i in range(1, len(c)):
        if m is not None and (m[i - 1] is None or c[i - 1] <= m[i - 1]):
            continue
        level = o[i] + k * (h[i - 1] - l_[i - 1])
        if h[i] >= level > 0:
            rets[i] = c[i] / level - 1 - 2 * COST
            held[i] = 1
    return rets, held


def strategies():
    out = []
    add = lambda family, name, fn: out.append((family, name, fn))
    add("Buy and hold", "Buy and hold", lambda d: returns_from_positions(d, [1] * len(d["c"])))
    for n in (10, 20, 30, 60, 90, 120, 180):
        add("Time-series momentum", f"TSMOM {n}d", lambda d, n=n: returns_from_positions(d, tsmom(d, n)))
    for n in (20, 30, 60, 90):
        add("Time-series momentum long/short", f"TSMOM {n}d L/S", lambda d, n=n: returns_from_positions(d, tsmom(d, n, True)))
    for n in (10, 20, 30, 50, 100, 150, 200):
        add("Price above SMA", f"Close > SMA {n}", lambda d, n=n: returns_from_positions(d, above_sma(d, n)))
    for f, s in ((10, 50), (20, 50), (20, 100), (50, 200)):
        add("SMA crossover", f"SMA {f}/{s} cross", lambda d, f=f, s=s: returns_from_positions(d, sma_cross(d, f, s)))
    for n in (10, 20, 30, 60, 90, 150):
        add("Donchian trend (single)", f"Donchian {n}d", lambda d, n=n: returns_from_positions(d, donchian(d, n)))
    add("Donchian ensemble", "Donchian ensemble (average)", lambda d: returns_from_positions(d, donchian_ensemble(d)))
    add("Donchian ensemble", "Donchian ensemble, 25% vol target (paper)", lambda d: returns_from_positions(d, donchian_ensemble(d, vol_target=0.25)))
    for v in (0.34, 0.5, 0.67):
        add("Donchian ensemble vote", f"Donchian ensemble vote >= {v:.0%}", lambda d, v=v: returns_from_positions(d, donchian_ensemble(d, vote=v)))
    for n in (10, 20, 30, 50):
        add("N-day high hold", f"{n}d high hold", lambda d, n=n: returns_from_positions(d, max_hold(d, n)))
    for k in (0.3, 0.5, 0.7):
        add("Volatility breakout", f"Vol breakout k={k}", lambda d, k=k: vol_breakout(d, k))
        add("Volatility breakout + trend", f"Vol breakout k={k}, close > SMA 50", lambda d, k=k: vol_breakout(d, k, 50))
    for e in (5, 10, 20):
        add("RSI(2) pullback", f"RSI(2) < {e} above SMA 200", lambda d, e=e: returns_from_positions(d, rsi2(d, e)))
    return out


# ---------------------------------------------------------------- statistics

def stats(times, rets, held):
    if len(rets) < 30:
        return None
    eq = peak = 1.0
    mdd = 0.0
    for r in rets:
        eq *= 1 + r
        peak = max(peak, eq)
        mdd = min(mdd, eq / peak - 1)
    years = (times[-1] - times[0] + DAY_MS) / (365.25 * DAY_MS)
    sd = statistics.pstdev(rets)
    trades = sum(1 for a, b in zip([0] + held[:-1], held) if b and not a)
    return {
        "cagr": (eq ** (1 / years) - 1) * 100 if eq > 0 else -100.0,
        "vol": sd * math.sqrt(365) * 100,
        "sharpe": statistics.fmean(rets) / sd * math.sqrt(365) if sd else 0.0,
        "max_dd": mdd * 100,
        "exposure": statistics.fmean(abs(h) for h in held) * 100,
        "trades": trades,
        "years": years,
    }


def window(d, start, end):
    first = d["t"][0] + WARMUP_DAYS * DAY_MS
    return [i for i, t in enumerate(d["t"]) if max(start, first) <= t < end]


def main(path):
    raw = json.load(open(path))
    coins = {k: {"t": [b[0] for b in v], "o": [b[1] for b in v], "h": [b[2] for b in v], "l": [b[3] for b in v], "c": [b[4] for b in v]} for k, v in raw.items()}
    rows, series = [], {}
    for family, name, fn in strategies():
        for coin, d in coins.items():
            rets, held = fn(d)
            series[(name, coin)] = (d["t"], rets)
            for period, (a, b) in (("in", (0, SPLIT)), ("out", (SPLIT, 10 ** 15)), ("post_paper", (POST_PAPER, 10 ** 15))):
                idx = window(d, a, b)
                st = stats([d["t"][i] for i in idx], [rets[i] for i in idx], [held[i] for i in idx])
                if st:
                    rows.append({"family": family, "strategy": name, "coin": coin, "period": period,
                                 "from": datetime.fromtimestamp(d["t"][idx[0]] / 1000, timezone.utc).date(),
                                 "to": datetime.fromtimestamp(d["t"][idx[-1]] / 1000, timezone.utc).date(),
                                 **{k: round(v, 3) for k, v in st.items()}})
    write("runs.csv", rows)

    bh = {(r["coin"], r["period"]): r for r in rows if r["strategy"] == "Buy and hold"}
    summary = []
    for family, name, _ in strategies():
        s = {"family": family, "strategy": name}
        for period in ("in", "out", "post_paper"):
            rs = [r for r in rows if r["strategy"] == name and r["period"] == period and (period != "in" or r["coin"] in IS_COINS)]
            s[f"{period}_coins"] = len(rs)
            s[f"{period}_median_sharpe"] = round(statistics.median(r["sharpe"] for r in rs), 2)
            s[f"{period}_mean_cagr"] = round(statistics.fmean(r["cagr"] for r in rs), 1)
            s[f"{period}_median_max_dd"] = round(statistics.median(r["max_dd"] for r in rs), 1)
            s[f"{period}_beats_bh_sharpe"] = sum(r["sharpe"] > bh[(r["coin"], period)]["sharpe"] for r in rs)
            s[f"{period}_positive"] = sum(r["cagr"] > 0 for r in rs)
            s[f"{period}_exposure"] = round(statistics.fmean(r["exposure"] for r in rs), 1)
            s[f"{period}_trades_per_year"] = round(statistics.fmean(r["trades"] / r["years"] for r in rs), 1)
        p = portfolio(series, name, coins)
        s.update({f"portfolio_out_{k}": round(v, 2) for k, v in p.items() if k in ("cagr", "sharpe", "max_dd")})
        summary.append(s)
    write("summary.csv", summary)

    # the honest pick: best in-sample setting per family, then look at what it did out of sample
    picks = []
    for family in dict.fromkeys(s["family"] for s in summary):
        group = [s for s in summary if s["family"] == family]
        is_best = max(group, key=lambda s: s["in_median_sharpe"])
        oos_best = max(group, key=lambda s: s["out_median_sharpe"])
        picks.append({**is_best, "hindsight_best_out": oos_best["strategy"], "hindsight_best_out_sharpe": oos_best["out_median_sharpe"]})
    picks.sort(key=lambda s: -s["out_median_sharpe"])
    write("picks.csv", picks)
    print_table(picks)


def portfolio(series, name, coins):
    """Equal weight across the coins that are past their warm-up, rebalanced daily, from 2022."""
    by_day = {}
    for coin, d in coins.items():
        t, rets = series[(name, coin)]
        first = t[0] + WARMUP_DAYS * DAY_MS
        for ti, r in zip(t, rets):
            if ti >= max(SPLIT, first):
                by_day.setdefault(ti, []).append(r)
    days = sorted(by_day)
    rets = [statistics.fmean(by_day[k]) for k in days]
    return stats(days, rets, [1] * len(days))


def write(name, rows):
    with open(HERE / name, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    print(f"wrote research/strategy_search/{name} ({len(rows)} rows)")


def print_table(picks):
    cols = ["strategy", "in_median_sharpe", "out_median_sharpe", "out_mean_cagr", "out_median_max_dd", "out_beats_bh_sharpe", "out_positive", "out_exposure", "portfolio_out_sharpe", "hindsight_best_out"]
    print(" | ".join(cols))
    for p in picks:
        print(" | ".join(str(p[c]) for c in cols))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "daily.json")
