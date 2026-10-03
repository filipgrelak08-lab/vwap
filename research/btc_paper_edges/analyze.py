"""Test the edges reported by Padysak & Vojtko (2022), "Seasonality, Trend-following,
and Mean reversion in Bitcoin" (SSRN 4081000), before and after the paper.

    python3 research/btc_paper_edges/fetch_coinbase.py btc_usd_1h.csv
    python3 research/btc_paper_edges/analyze.py btc_usd_1h.csv

Two data sources:

1. Coinbase BTC-USD spot, hourly, 2015 onward (from fetch_coinbase.py). Long enough to
   cover the paper's own sample (26 Nov 2015 - 3 Feb 2022) and everything since.
2. trader.dev backtests on the Bybit BTCUSDT perpetual (Mar 2020 onward), run through
   its Pine engine. The result files are public; their ids are listed in TRADER_DEV.

Writes CSVs next to this script.
"""
import csv
import gzip
import json
import math
import statistics
import sys
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
HOUR = 3600_000
DAY = 24 * HOUR

# Paper sample (Quantpedia write-up: 26.11.2015 - 3.2.2022) and the period after it.
PERIODS = {
    "paper": (datetime(2015, 11, 26, tzinfo=timezone.utc), datetime(2022, 2, 4, tzinfo=timezone.utc)),
    "after": (datetime(2022, 2, 4, tzinfo=timezone.utc), datetime(2100, 1, 1, tzinfo=timezone.utc)),
}
PERIODS = {k: (int(a.timestamp() * 1000), int(b.timestamp() * 1000)) for k, (a, b) in PERIODS.items()}

FEE_TAKER = 0.0005  # per side, same as trader.dev's fixed 0.05%
FEE_MAKER = 0.0002  # per side, Bybit perp maker

R2 = "https://pub-5880a55c41fd4cd1a11146f4fd522fbe.r2.dev/backtests/{}.json.gz"
TRADER_DEV = {
    "Seasonality 21-23 UTC (1h)": "01M41Y4GPYQ05Q5BFMFPBP96MH",
    "Seasonality 22-24 UTC (1h)": "01M41Y808VYDKDX225QVEBBMJZ",
    "10d MAX+MIN (1D)": "01M41Y8EAPAMD32PCS12Y1N3Q8",
    "10d MAX only (1D)": "01M41Y8ZVSHME7R13GRTCG47B1",
    "10d MIN only (1D)": "01M41Y91YQG9V0MK9Y8XV2YPK7",
    "Buy and hold (1D)": "01M41Y93V9F39HHRD28CHEPK54",
}


def day(ms):
    return datetime.fromtimestamp(ms / 1000, timezone.utc).strftime("%Y-%m-%d")


def period_of(ms):
    for name, (a, b) in PERIODS.items():
        if a <= ms < b:
            return name
    return None


def stats(times, rets, per_year):
    """Compounded stats for a series of per-step returns."""
    if not rets:
        return {}
    eq, peak, mdd = 1.0, 1.0, 0.0
    for r in rets:
        eq *= 1 + r
        peak = max(peak, eq)
        mdd = min(mdd, eq / peak - 1)
    years = (times[-1] - times[0] + (times[1] - times[0] if len(times) > 1 else 0)) / (365.25 * DAY)
    mean, sd = statistics.fmean(rets), statistics.pstdev(rets)
    return {
        "from": day(times[0]),
        "to": day(times[-1]),
        "total_return_pct": round((eq - 1) * 100, 1),
        "cagr_pct": round((eq ** (1 / years) - 1) * 100, 1) if years > 0 and eq > 0 else None,
        "vol_pct": round(sd * math.sqrt(per_year) * 100, 1),
        "sharpe": round(mean / sd * math.sqrt(per_year), 2) if sd else None,
        "max_dd_pct": round(mdd * 100, 1),
    }


def load_coinbase(path):
    rows = list(csv.DictReader(open(path)))
    return [(int(r["time"]), float(r["open"]), float(r["close"])) for r in rows]


def hourly_returns(bars):
    """Close-to-close return of each hourly bar, keyed by the bar's open time."""
    out = []
    for (t0, _, c0), (t1, _, c1) in zip(bars, bars[1:]):
        if t1 - t0 == HOUR:
            out.append((t1, c1 / c0 - 1))
    return out


def hour_of_day_table(hret):
    rows = []
    by = defaultdict(list)
    for t, r in hret:
        p = period_of(t)
        if p:
            by[(p, (t // HOUR) % 24)].append(r)
    for h in range(24):
        row = {"hour_utc": f"{h:02d}:00-{(h + 1) % 24:02d}:00"}
        for p in PERIODS:
            xs = by[(p, h)]
            m, sd = statistics.fmean(xs), statistics.stdev(xs)
            row[f"{p}_mean_bps"] = round(m * 1e4, 2)
            row[f"{p}_t_stat"] = round(m / (sd / math.sqrt(len(xs))), 2)
            row[f"{p}_n"] = len(xs)
        rows.append(row)
    for p in PERIODS:
        ranked = sorted(rows, key=lambda r: -r[f"{p}_mean_bps"])
        for i, r in enumerate(ranked):
            r[f"{p}_rank"] = i + 1
    return rows


def seasonality(hret, start_hour, hold):
    """One trade per day: long from start_hour for `hold` hours. Returns per-day gross returns."""
    hours = dict(hret)
    times, rets = [], []
    first = hret[0][0] // DAY * DAY
    for d in range(first, hret[-1][0], DAY):
        t0 = d + start_hour * HOUR
        legs = [hours.get(t0 + k * HOUR) for k in range(hold)]
        if None in legs:
            continue
        g = math.prod(1 + x for x in legs) - 1
        times.append(t0)
        rets.append(g)
    return times, rets


def daily_closes(bars):
    """Close of the 23:00 UTC bar = the daily close at 00:00 UTC (same as Bybit's 1D candle)."""
    out = {}
    for t, _, c in bars:
        if (t // HOUR) % 24 == 23:
            out[t // DAY * DAY] = c
    return [(d, out[d]) for d in sorted(out)]


def max_min_strategy(closes, lookback, use_max, use_min, fee):
    """Hold BTC for day t+1 when close_t is the highest (MAX) or lowest (MIN) of the last
    `lookback` closes, including today. Pays `fee` per side when the position changes."""
    times, rets, bh, in_mkt = [], [], [], []
    pos = 0
    for i in range(lookback, len(closes)):
        t, c = closes[i]
        if t - closes[i - 1][0] != DAY:
            pos = 0
            continue
        r = c / closes[i - 1][1] - 1
        window = [x[1] for x in closes[i - lookback:i]]
        prev_close = closes[i - 1][1]
        sig = (use_max and prev_close >= max(window)) or (use_min and prev_close <= min(window))
        new = 1 if sig else 0
        cost = fee if new != pos else 0
        pos = new
        times.append(t)
        rets.append(pos * r - cost)
        bh.append(r)
        in_mkt.append(pos)
    return times, rets, bh, in_mkt


def split(times, *series):
    out = defaultdict(lambda: ([], *[[] for _ in series]))
    for i, t in enumerate(times):
        p = period_of(t)
        if p:
            out[p][0].append(t)
            for j, s in enumerate(series):
                out[p][j + 1].append(s[i])
    return out


def write(name, rows):
    path = HERE / name
    with open(path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    print(f"wrote {path.relative_to(HERE.parents[1])} ({len(rows)} rows)")


def coinbase(path):
    bars = load_coinbase(path)
    hret = hourly_returns(bars)
    print(f"coinbase: {len(bars)} hourly bars, {day(bars[0][0])} to {day(bars[-1][0])}")

    write("coinbase_hour_of_day.csv", hour_of_day_table(hret))

    rows = []
    for start, label in ((21, "21-23 UTC"), (22, "22-24 UTC")):
        times, gross = seasonality(hret, start, 2)
        for p, (ts, g) in split(times, gross).items():
            for cost_label, fee in (("none", 0), ("maker 0.02%/side", FEE_MAKER), ("taker 0.05%/side", FEE_TAKER)):
                net = [(1 + x) * (1 - fee) ** 2 - 1 for x in g]
                rows.append({"strategy": f"Seasonality {label}", "period": p, "costs": cost_label,
                             "trades": len(net), "avg_gross_bps": round(statistics.fmean(g) * 1e4, 2),
                             "win_rate_pct": round(sum(x > 0 for x in net) / len(net) * 100, 1),
                             **stats(ts, net, 365.25)})
    write("coinbase_seasonality.csv", rows)

    closes = daily_closes(bars)
    rows = []
    for lookback in (10, 20, 30, 40, 50):
        for label, mx, mn in (("MAX+MIN", True, True), ("MAX only", True, False), ("MIN only", False, True)):
            for cost_label, fee in (("none", 0), ("taker 0.05%/side", FEE_TAKER)):
                times, rets, bh, in_mkt = max_min_strategy(closes, lookback, mx, mn, fee)
                for p, (ts, r, b, m) in split(times, rets, bh, in_mkt).items():
                    rows.append({"strategy": f"{lookback}d {label}", "lookback": lookback, "period": p,
                                 "costs": cost_label, "time_in_market_pct": round(statistics.fmean(m) * 100, 1),
                                 **stats(ts, r, 365.25)})
                    if lookback == 10 and label == "MAX+MIN" and fee == 0:
                        rows.append({"strategy": "Buy and hold", "lookback": "", "period": p, "costs": "none",
                                     "time_in_market_pct": 100.0, **stats(ts, b, 365.25)})
    write("coinbase_max_min.csv", rows)


def trader_dev():
    rows = []
    for name, rid in TRADER_DEV.items():
        req = urllib.request.Request(R2.format(rid), headers={"User-Agent": "vwap-lab-research"})
        raw = urllib.request.urlopen(req, timeout=60).read()
        blob = json.loads(gzip.decompress(raw) if raw[:2] == b"\x1f\x8b" else raw)
        eq = [(p["barTime"], p["equity"]) for p in blob["equity"]]
        trades = blob["trades"]
        for p, (a, b) in PERIODS.items():
            pts = [x for x in eq if a <= x[0] < b]
            if len(pts) < 2:
                continue
            # step returns between stored equity points (daily for 1D runs, ~28h for 1h runs)
            times = [x[0] for x in pts]
            rets = [y[1] / x[1] - 1 for x, y in zip(pts, pts[1:])]
            st = stats(times[1:], rets, 365.25 * DAY / statistics.fmean(
                [y - x for x, y in zip(times, times[1:])]))
            tr = [t for t in trades if a <= t["entryTime"] < b]
            gross = math.prod(t["exitPrice"] / t["entryPrice"] for t in tr) - 1 if tr else 0
            rows.append({"strategy": name, "period": p, "trades": len(tr),
                         "gross_return_pct_before_fees": round(gross * 100, 1) if "hold" not in name else "",
                         "win_rate_pct": round(sum(t["profit"] > 0 for t in tr) / len(tr) * 100, 1) if tr else "",
                         **st, "result_url": f"https://mcp-api.trader.dev/backtest/{rid}"})
    write("traderdev_runs.csv", rows)


if __name__ == "__main__":
    coinbase(sys.argv[1] if len(sys.argv) > 1 else "btc_usd_1h.csv")
    trader_dev()
