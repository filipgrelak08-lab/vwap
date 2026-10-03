"""Split the trader.dev confirmation runs (Bybit perpetuals, 0.05% per side) into periods.

    python3 research/strategy_search/traderdev_check.py

Reads traderdev_runs.json (the result IDs), downloads each run's public result file and
writes traderdev_summary.csv: return, CAGR, Sharpe and max drawdown per period, measured on
trader.dev's equity curve (open positions included).
"""
import csv
import gzip
import json
import math
import statistics
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
R2 = "https://pub-5880a55c41fd4cd1a11146f4fd522fbe.r2.dev/backtests/{}.json.gz"
DAY_MS = 86_400_000
PERIODS = {
    "all": (0, 10 ** 15),
    "before 2022": (0, int(datetime(2022, 1, 1, tzinfo=timezone.utc).timestamp() * 1000)),
    "2022 on": (int(datetime(2022, 1, 1, tzinfo=timezone.utc).timestamp() * 1000), 10 ** 15),
    "since Apr 2025": (int(datetime(2025, 4, 1, tzinfo=timezone.utc).timestamp() * 1000), 10 ** 15),
}
LABELS = {"ens": "Donchian Trend Ensemble", "high": "50d High Hold", "bh": "Buy and hold"}


def blob(rid):
    req = urllib.request.Request(R2.format(rid), headers={"User-Agent": "vwap-lab-research"})
    raw = urllib.request.urlopen(req, timeout=60).read()
    return json.loads(gzip.decompress(raw) if raw[:2] == b"\x1f\x8b" else raw)


def stats(points):
    if len(points) < 20:
        return None
    t = [p[0] for p in points]
    eq = [p[1] for p in points]
    rets = [b / a - 1 for a, b in zip(eq, eq[1:])]
    step = statistics.fmean(b - a for a, b in zip(t, t[1:]))
    years = (t[-1] - t[0]) / (365.25 * DAY_MS)
    peak, mdd = eq[0], 0.0
    for v in eq:
        peak = max(peak, v)
        mdd = min(mdd, v / peak - 1)
    sd = statistics.pstdev(rets)
    total = eq[-1] / eq[0] - 1
    return {
        "return_pct": round(total * 100, 1),
        "cagr_pct": round(((1 + total) ** (1 / years) - 1) * 100, 1) if years > 0 and total > -1 else None,
        "sharpe": round(statistics.fmean(rets) / sd * math.sqrt(365.25 * DAY_MS / step), 2) if sd else None,
        "max_dd_pct": round(mdd * 100, 1),
    }


def main():
    runs = json.load(open(HERE / "traderdev_runs.json"))
    rows = []
    for key, run in runs.items():
        kind, symbol = key.split("|")
        b = blob(run["resultId"])
        eq = [(p["barTime"], p["equity"]) for p in b["equity"]]
        for period, (a, z) in PERIODS.items():
            pts = [p for p in eq if a <= p[0] < z]
            st = stats(pts)
            if st:
                rows.append({"strategy": LABELS[kind], "symbol": symbol, "period": period,
                             "from": datetime.fromtimestamp(pts[0][0] / 1000, timezone.utc).date(),
                             "to": datetime.fromtimestamp(pts[-1][0] / 1000, timezone.utc).date(),
                             **st, "result_id": run["resultId"]})
    rows.sort(key=lambda r: (list(PERIODS).index(r["period"]), r["symbol"], r["strategy"]))
    with open(HERE / "traderdev_summary.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    print(f"wrote research/strategy_search/traderdev_summary.csv ({len(rows)} rows)")
    for period in PERIODS:
        print(f"\n== {period}: return% / Sharpe / max DD%")
        syms = sorted({r["symbol"] for r in rows})
        print("strategy".ljust(26) + "".join(s[:-4].ljust(18) for s in syms))
        for name in LABELS.values():
            line = name.ljust(26)
            for s in syms:
                r = next((x for x in rows if x["strategy"] == name and x["symbol"] == s and x["period"] == period), None)
                line += (f"{r['return_pct']:.0f} / {r['sharpe']} / {r['max_dd_pct']:.0f}" if r else "-").ljust(18)
            print(line)


if __name__ == "__main__":
    main()
