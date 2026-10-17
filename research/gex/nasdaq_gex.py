"""Nasdaq gamma exposure (GEX) levels from free CBOE data, in QQQ, NDX and NQ/MNQ prices.

    python3 nasdaq_gex.py                 # today's levels from QQQ + NDX options
    python3 nasdaq_gex.py --max-days 30   # only options expiring within 30 days
    python3 nasdaq_gex.py --no-log        # don't add today's levels to gex_log.csv

Data: CBOE's free delayed option quotes (about 15 minutes late during the session; outside market
hours they show the last close). Open interest updates once a day, before the open, so the levels are
for the whole day. NQ comes from Yahoo (NQ=F), used to convert index levels to futures prices.

How it is calculated (the usual public method, the same idea SpotGamma and others describe):
- each option's gamma comes from Black-Scholes with its own implied volatility and time to expiry;
- dollar gamma per 1% move = gamma x open interest x 100 x price^2 x 1%;
- calls count as positive and puts as negative, i.e. dealers are assumed to be long the calls and
  short the puts that customers trade. That assumption is the weak point of every GEX estimate:
  nobody sees the real positions;
- the gamma flip is the price where the total, recalculated at that price, crosses zero.

Positive total GEX: dealers' hedging sells rallies and buys dips, which tends to dampen moves (chop,
mean reversion). Negative: their hedging adds to moves (trend days, bigger swings). These are
tendencies, not predictions.

Each run adds a row to gex_log.csv, so after a few weeks you can compare the regime with how your
strategy did on those days. Needs only Python 3.8+, no packages.
"""
import argparse
import csv
import datetime as dt
import json
import math
import re
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
UTC = dt.timezone.utc
SYMBOL_RE = re.compile(r"^([A-Z]+)(\d{6})([CP])(\d{8})$")
RATE = 0.04  # risk-free rate for Black-Scholes; small changes barely move the levels


def get_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def load_chain(symbol):
    j = get_json(f"https://cdn.cboe.com/api/global/delayed_quotes/options/{symbol}.json")
    return j["timestamp"], j["data"]


def nq_price():
    j = get_json("https://query1.finance.yahoo.com/v8/finance/chart/NQ%3DF?interval=1d&range=5d")
    return j["chart"]["result"][0]["meta"]["regularMarketPrice"]


def options(data, now, max_days):
    """(strike, is_call, open_interest, iv, years_to_expiry) for every usable option."""
    out = []
    for o in data["options"]:
        m = SYMBOL_RE.match(o["option"])
        if not m or not o.get("open_interest") or not o.get("iv") or o["iv"] <= 0:
            continue
        expiry = dt.datetime.strptime(m.group(2), "%y%m%d").replace(hour=20, tzinfo=UTC)  # ~16:00 New York
        days = (expiry - now).total_seconds() / 86400
        if days <= 0 or (max_days and days > max_days):
            continue
        out.append((int(m.group(4)) / 1000, m.group(3) == "C", o["open_interest"], o["iv"], max(days, 1 / 24) / 365))
    return out


def gamma(spot, strike, iv, t):
    sd = iv * math.sqrt(t)
    d1 = (math.log(spot / strike) + (RATE + iv * iv / 2) * t) / sd
    return math.exp(-d1 * d1 / 2) / math.sqrt(2 * math.pi) / (spot * sd)


def gex_at(opts, spot):
    """Total dollar gamma per 1% move at `spot` (calls +, puts -), and per strike as {strike: [calls, puts]}."""
    total, by_strike = 0.0, {}
    for k, is_call, oi, iv, t in opts:
        g = gamma(spot, k, iv, t) * oi * 100 * spot * spot * 0.01 * (1 if is_call else -1)
        total += g
        by_strike.setdefault(k, [0.0, 0.0])[0 if is_call else 1] += g
    return total, by_strike


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--max-days", type=int, default=0, help="only options expiring within this many days (0 = all)")
    ap.add_argument("--no-log", action="store_true", help="don't append to gex_log.csv")
    args = ap.parse_args()

    now = dt.datetime.now(UTC)
    ts_q, qqq = load_chain("QQQ")
    ts_n, ndx = load_chain("_NDX")
    q0, n0 = qqq["current_price"], ndx["current_price"]
    try:
        nq0 = nq_price()
    except Exception:
        nq0 = None
    to_nq = (nq0 / n0) if nq0 else 1.0  # NQ trades at a small premium to NDX
    q_opts, n_opts = options(qqq, now, args.max_days), options(ndx, now, args.max_days)

    # in NQ points, so QQQ and NDX can be added up and compared with the chart
    def nq_from_qqq(x):
        return x * n0 / q0 * to_nq

    def nq_from_ndx(x):
        return x * to_nq

    tq, sq = gex_at(q_opts, q0)
    tn, sn = gex_at(n_opts, n0)
    total = tq + tn

    # gamma flip: move both underlyings by the same % and find where the total crosses zero
    grid = [i / 1000 for i in range(-80, 81, 2)]  # -8% .. +8% in 0.2% steps
    curve = [(m, gex_at(q_opts, q0 * (1 + m))[0] + gex_at(n_opts, n0 * (1 + m))[0]) for m in grid]
    flips = [a[0] - a[1] * (b[0] - a[0]) / (b[1] - a[1]) for a, b in zip(curve, curve[1:]) if (a[1] < 0) != (b[1] < 0)]
    flip_m = min(flips, key=abs) if flips else None

    # walls in NQ points: combine QQQ and NDX strikes into 25-point NQ buckets
    buckets = {}
    for src, conv in ((sq, nq_from_qqq), (sn, nq_from_ndx)):
        for k, (c, p) in src.items():
            b = buckets.setdefault(round(conv(k) / 25) * 25, [0.0, 0.0])
            b[0] += c
            b[1] += p
    nq_spot = nq0 or nq_from_ndx(n0)
    near = {k: v for k, v in buckets.items() if abs(k / nq_spot - 1) <= 0.08}
    call_wall = max(near, key=lambda k: near[k][0])  # most call gamma
    put_wall = min(near, key=lambda k: near[k][1])  # most put gamma
    top = sorted(near.items(), key=lambda kv: -abs(kv[1][0] + kv[1][1]))[:8]

    flip_nq = nq_spot * (1 + flip_m) if flip_m is not None else None
    regime = "POSITIVE" if total > 0 else "NEGATIVE"
    print(f"Nasdaq GEX  (CBOE data {ts_q} / {ts_n}, delayed; run {now:%Y-%m-%d %H:%M} UTC)")
    print(f"QQQ {q0:,.2f}   NDX {n0:,.2f}   NQ {nq_spot:,.2f}" + ("" if nq0 else "  (NQ unavailable: shown as NDX)"))
    print(f"options used: {len(q_opts):,} QQQ + {len(n_opts):,} NDX" + (f", expiring within {args.max_days} days" if args.max_days else ""))
    print()
    print(f"Total GEX: {total / 1e9:+.2f} $bn per 1% move  ->  {regime} gamma")
    print("  positive: dealer hedging tends to dampen moves (choppier, mean-reverting)" if total > 0 else
          "  negative: dealer hedging tends to add to moves (trendier, bigger swings)")
    if flip_nq:
        side = "above" if nq_spot > flip_nq else "below"
        print(f"Gamma flip: NQ {flip_nq:,.0f}  (price is {abs(nq_spot / flip_nq - 1) * 100:.1f}% {side} it)")
    else:
        print("Gamma flip: none within 8% of the price")
    print(f"Call wall:  NQ {call_wall:,.0f}   (most call gamma, often resistance)")
    print(f"Put wall:   NQ {put_wall:,.0f}   (most put gamma, often support)")
    print("\nLargest gamma strikes (NQ, 25-point buckets, $bn per 1% move):")
    print(f"  {'NQ':>9}  {'calls':>7}  {'puts':>7}  {'net':>7}")
    for k, (c, p) in sorted(top):
        print(f"  {k:>9,.0f}  {c / 1e9:+7.2f}  {p / 1e9:+7.2f}  {(c + p) / 1e9:+7.2f}")

    if not args.no_log:
        log = HERE / "gex_log.csv"
        new = not log.exists()
        with open(log, "a", newline="") as f:
            w = csv.writer(f)
            if new:
                w.writerow(["run_utc", "data_time", "nq", "total_gex_bn", "regime", "gamma_flip_nq", "call_wall_nq", "put_wall_nq"])
            w.writerow([f"{now:%Y-%m-%d %H:%M}", ts_q, round(nq_spot, 2), round(total / 1e9, 3), regime.lower(),
                        round(flip_nq) if flip_nq else "", call_wall, put_wall])
        print(f"\nsaved to {log.name}")


if __name__ == "__main__":
    main()
