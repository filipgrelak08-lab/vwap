"""Backtest the VWAP pullback rules (pine/vwap_trend_pullback.pine) on BTCUSDT from Binance or a TradingView export.

    python3 check.py                          # last 90 days of 5-minute BTCUSDT, default settings
    python3 check.py --days 365               # a longer test (Binance keeps years of 5-minute data)
    python3 check.py --atr 1 --r 1 --max-stop 2   # any TradingView input can be set; see --help
    python3 check.py --sweep                  # every ATR length x R target, month by month
    python3 check.py --csv btc_5m.csv         # a TradingView export instead of Binance

Results are in R (each trade's result divided by its own risk, after fees) and in dollars for a fixed
dollar risk per trade (--risk, default $100), by month. A setting worth trading should make money in
most months, not only in one.

Needs only Python 3.8+, no packages. All times are UTC.

The replay follows the Pine rules: daily VWAP restarting at 00:00 UTC, VWAP above/below its value 5
bars ago, 20/50 EMA, a VWAP touch in the previous 3 candles that came after the last entry, a
bullish/bearish signal candle, price no more than 2 ATR from VWAP on the candle before the pullback,
stop 1 tick beyond the pullback's extreme, skip stops wider than 1.5 ATR, target in R, fill at the
signal candle's close, one trade at a time. If a candle touches both the stop and the target, the stop
counts. Small differences from TradingView are normal (Binance vs Bybit prices, data feed).
"""
import argparse
import csv
import datetime as dt
import json
import time
import urllib.request
from collections import defaultdict

UTC = dt.timezone.utc


def get_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def load_binance(symbol, days):
    """5-minute candles from Binance's public market-data API, oldest first."""
    rows, end = [], int(time.time() * 1000)
    start = end - days * 86400 * 1000
    while start < end:
        url = f"https://data-api.binance.vision/api/v3/klines?symbol={symbol}&interval=5m&startTime={start}&limit=1000"
        batch = get_json(url)
        if not batch:
            break
        for k in batch:
            t = dt.datetime.fromtimestamp(k[0] / 1000, UTC).replace(tzinfo=None)
            rows.append((t, float(k[1]), float(k[2]), float(k[3]), float(k[4]), float(k[5])))
        start = batch[-1][0] + 300_000
        if len(batch) < 1000:
            break
    if rows and rows[-1][0] > dt.datetime.now(UTC).replace(tzinfo=None) - dt.timedelta(minutes=5):
        rows.pop()  # the current candle hasn't closed yet
    return rows


def load_csv(path):
    """TradingView export: time (unix seconds or ISO), open, high, low, close, Volume. Times become UTC."""
    rows = []
    with open(path, newline="") as f:
        for r in csv.DictReader(f):
            r = {k.strip().lower(): v for k, v in r.items()}
            t = r.get("time") or r.get("date") or r.get("datetime")
            if t.replace(".", "").isdigit():
                when = dt.datetime.fromtimestamp(float(t), UTC).replace(tzinfo=None)
            else:
                d = dt.datetime.fromisoformat(t.replace("Z", "+00:00"))
                when = d.astimezone(UTC).replace(tzinfo=None) if d.tzinfo else d
            rows.append((when, float(r["open"]), float(r["high"]), float(r["low"]), float(r["close"]), float(r.get("volume") or 0)))
    return sorted(rows)


def ema(xs, n):
    a, out = 2 / (n + 1), []
    for x in xs:
        out.append(x if not out else out[-1] + a * (x - out[-1]))
    return out


def atr(H, L, C, n):
    """Wilder's ATR, like TradingView's ta.atr."""
    tr = [H[0] - L[0]] + [max(H[i] - L[i], abs(H[i] - C[i - 1]), abs(L[i] - C[i - 1])) for i in range(1, len(C))]
    out, prev = [], None
    for i, t in enumerate(tr):
        if i < n - 1:
            out.append(None)
            continue
        prev = sum(tr[i - n + 1:i + 1]) / n if prev is None else (prev * (n - 1) + t) / n
        out.append(prev)
    return out


def hhmm(m):
    return m // 100 * 60 + m % 100


DEFAULTS = dict(longs=True, shorts=True, slope=5, fast=20, slow=50, touch=3, ext=2.0, buffer=1, tick=0.1, atr=14,
                max_stop=1.5, r=2.0, window=None, flat=None, max_trades=0, fee=0.055, slip_ticks=1, risk=100.0)


class Market:
    def __init__(self, rows):
        self.T = [r[0] for r in rows]
        self.O, self.H, self.L, self.C, self.V = ([r[k] for r in rows] for k in range(1, 6))
        self.mins = [t.hour * 60 + t.minute for t in self.T]
        gaps = sorted((b - a).total_seconds() / 60 for a, b in zip(self.T[:500], self.T[1:501]))
        self.bar_min = gaps[len(gaps) // 2] if gaps else 5
        self.vwap, pv, vv = [], 0.0, 0.0
        for i in range(len(self.T)):
            if i == 0 or self.T[i].date() != self.T[i - 1].date():
                pv = vv = 0.0
            w = self.V[i] or 1.0
            pv += (self.H[i] + self.L[i] + self.C[i]) / 3 * w
            vv += w
            self.vwap.append(pv / vv)
        self._cache = {}

    def atr(self, n):
        if ("atr", n) not in self._cache:
            self._cache["atr", n] = atr(self.H, self.L, self.C, n)
        return self._cache["atr", n]

    def ema(self, n):
        if ("ema", n) not in self._cache:
            self._cache["ema", n] = ema(self.C, n)
        return self._cache["ema", n]


def backtest(mk, **settings):
    s = {**DEFAULTS, **settings}
    T, O, H, L, C, vw = mk.T, mk.O, mk.H, mk.L, mk.C, mk.vwap
    A, mins, n, bar = mk.atr(s["atr"]), mk.mins, len(mk.C), mk.bar_min
    fast, slow = mk.ema(s["fast"]), mk.ema(s["slow"])
    touch, slope, rr, tick = s["touch"], s["slope"], s["r"], s["tick"]
    buf = s["buffer"] * tick
    win = [hhmm(int(x)) for x in s["window"].split("-")] if s["window"] else None
    flat_m = hhmm(s["flat"]) if s["flat"] is not None else None

    def round_tick(x):
        return round(x / tick) * tick

    def late(j):  # the time exit fires on the first candle that closes at or after the set time
        if flat_m is None:
            return False
        close_m = (mins[j] + bar) % 1440
        return flat_m <= close_m < flat_m + bar

    trades, last_entry, per_day = [], -1, defaultdict(int)
    i = max(60, touch + 2, slope + 1)
    while i < n:
        a, a_before = A[i], A[i - touch - 1]
        in_win = win is None or win[0] <= mins[i] < win[1]
        day_full = s["max_trades"] > 0 and per_day[T[i].date()] >= s["max_trades"]
        if in_win and a and a_before and not late(i) and not day_full:
            fresh = range(1, touch + 1)
            touch_l = any(L[i - k] <= vw[i - k] and i - k > last_entry for k in fresh)
            touch_s = any(H[i - k] >= vw[i - k] and i - k > last_entry for k in fresh)
            ext_ok = s["ext"] == 0 or abs(C[i - touch - 1] - vw[i - touch - 1]) <= s["ext"] * a_before
            side, stop = 0, None
            if s["longs"] and C[i] > vw[i] > vw[i - slope] and fast[i] > slow[i] and touch_l and C[i] > O[i] and ext_ok:
                stop = round_tick(min(L[i - touch:i + 1]) - buf)
                side = 1 if s["max_stop"] == 0 or C[i] - stop <= s["max_stop"] * a else 0
            elif s["shorts"] and C[i] < vw[i] < vw[i - slope] and fast[i] < slow[i] and touch_s and C[i] < O[i] and ext_ok:
                stop = round_tick(max(H[i - touch:i + 1]) + buf)
                side = -1 if s["max_stop"] == 0 or stop - C[i] <= s["max_stop"] * a else 0
            if side:
                risk = abs(C[i] - stop)
                target = round_tick(C[i] + side * rr * risk)
                pts, why, j = None, None, i + 1
                while j < n and pts is None:
                    if (L[j] <= stop) if side > 0 else (H[j] >= stop):
                        pts, why = -risk, "stop"
                    elif (H[j] >= target) if side > 0 else (L[j] <= target):
                        pts, why = side * (target - C[i]), "target"
                    elif late(j):
                        pts, why = side * (C[j] - C[i]), "time"
                    j += 1
                if pts is None:
                    break  # still open at the end of the data
                exit_px = C[i] + side * pts
                # fees on both fills plus slippage, in price units, then as a share of the risk
                cost = s["fee"] / 100 * (C[i] + exit_px) + 2 * s["slip_ticks"] * tick
                r_net = (pts - cost) / risk
                per_day[T[i].date()] += 1
                trades.append(dict(time=T[i], side="long" if side > 0 else "short", entry=C[i], stop=stop, risk_pts=risk,
                                   risk_pct=risk / C[i] * 100, exit=why, r_gross=pts / risk, r=r_net, usd=r_net * s["risk"]))
                # a stop or target fills inside candle j-1, so like TradingView a new trade may start on
                # that candle's close; after a time exit the search resumes on the next candle
                last_entry, i = i, (j - 1 if why != "time" else j)
                continue
        i += 1
    return trades


def by_month(trades):
    out = defaultdict(list)
    for t in trades:
        out[t["time"].strftime("%Y-%m")].append(t)
    return out


def main():
    d = DEFAULTS
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--csv", help="TradingView 5-minute export instead of Binance")
    ap.add_argument("--symbol", default="BTCUSDT", help="Binance symbol (default BTCUSDT)")
    ap.add_argument("--days", type=int, default=90, help="days of Binance history (default 90)")
    g = ap.add_argument_group("strategy settings (same names and defaults as the TradingView inputs)")
    g.add_argument("--no-longs", dest="longs", action="store_false", help="don't take longs")
    g.add_argument("--no-shorts", dest="shorts", action="store_false", help="don't take shorts")
    g.add_argument("--slope", type=int, default=d["slope"], help=f"VWAP slope: compare with (bars ago), default {d['slope']}")
    g.add_argument("--fast", type=int, default=d["fast"], help=f"fast EMA, default {d['fast']}")
    g.add_argument("--slow", type=int, default=d["slow"], help=f"slow EMA, default {d['slow']}")
    g.add_argument("--touch", type=int, default=d["touch"], help=f"VWAP touch within the previous (candles), default {d['touch']}")
    g.add_argument("--ext", type=float, default=d["ext"], help=f"skip if price was this far from VWAP before the pullback (x ATR, 0 = off), default {d['ext']}")
    g.add_argument("--buffer", type=int, default=d["buffer"], help=f"stop buffer (ticks), default {d['buffer']}")
    g.add_argument("--tick", type=float, default=d["tick"], help=f"tick size, default {d['tick']} (Bybit BTCUSDT)")
    g.add_argument("--atr", type=int, default=d["atr"], help=f"ATR length, default {d['atr']}")
    g.add_argument("--max-stop", type=float, default=d["max_stop"], help=f"skip if the stop is wider than (x ATR, 0 = off), default {d['max_stop']}")
    g.add_argument("--r", type=float, default=d["r"], help=f"take profit (x initial risk), default {d['r']}")
    g.add_argument("--window", help="only enter between these UTC times, e.g. 1345-1530 (default: any time)")
    g.add_argument("--flat", type=int, help="close open trades at HHMM UTC (default: never, only at the stop or target)")
    g.add_argument("--max-trades", type=int, default=d["max_trades"], help="max trades per day (0 = no limit)")
    g.add_argument("--fee", type=float, default=d["fee"], help=f"fee in %% per side, default {d['fee']} (Bybit perpetual taker)")
    g.add_argument("--risk", type=float, default=d["risk"], help=f"$ risked per trade for the dollar column, default {d['risk']:.0f}")
    ap.add_argument("--sweep", action="store_true", help="test every ATR length x R target with the other settings")
    ap.add_argument("--trades", action="store_true", help="list every trade")
    args = ap.parse_args()
    settings = {k: getattr(args, k) for k in DEFAULTS if hasattr(args, k)}

    rows = load_csv(args.csv) if args.csv else load_binance(args.symbol, args.days)
    mk = Market(rows)
    print(f"{len(rows)} candles, {rows[0][0]:%Y-%m-%d} to {rows[-1][0]:%Y-%m-%d} (UTC)")
    shown = {k: v for k, v in settings.items() if not (args.sweep and k in ("atr", "r"))}
    print("settings: " + ", ".join(f"{k}={v}" for k, v in shown.items()) + "\n")

    if not args.sweep:
        trades = backtest(mk, **settings)
        print(f"R = each trade's result divided by its risk, after fees; $ = R x ${settings['risk']:.0f} risked per trade")
        print(f"{'month':8} {'trades':>6} {'wins':>5} {'avg stop':>9} {'R':>8} {'$':>8}")
        for m, ts in sorted(by_month(trades).items()) + ([("total", trades)] if trades else []):
            print(f"{m:8} {len(ts):6} {sum(t['r'] > 0 for t in ts) / len(ts):5.0%} {sum(t['risk_pct'] for t in ts) / len(ts):8.2f}% "
                  f"{sum(t['r'] for t in ts):+8.2f} {sum(t['usd'] for t in ts):8.0f}")
        if trades:
            fees = sum(t["r_gross"] - t["r"] for t in trades) / len(trades)
            print(f"\nfees and slippage cost {fees:.2f}R per trade on average (tighter stops pay more in R)")
        if args.trades:
            print()
            for t in trades:
                print(f"{t['time']:%Y-%m-%d %H:%M} {t['side']:5} entry {t['entry']:.1f} stop {t['stop']:.1f} "
                      f"({t['risk_pct']:.2f}%)  {t['exit']:6} {t['r']:+5.2f}R {t['usd']:+8.2f} $")
        return

    months = sorted({t.strftime("%Y-%m") for t in mk.T})
    print("R after fees by month for each ATR length x R target")
    print(f"{'ATR':>4} {'R':>5} " + " ".join(f"{m:>8}" for m in months) + f" {'total':>8} {'trades':>7} {'months +':>9}")
    for a in (1, 2, 3, 5, 10, 14, 20):
        for r in (0.75, 1.0, 1.25, 1.5, 2.0, 2.5):
            trades = backtest(mk, **{**settings, "atr": a, "r": r})
            per = by_month(trades)
            vals = [sum(t["r"] for t in per.get(m, [])) for m in months]
            print(f"{a:4} {r:5} " + " ".join(f"{v:+8.2f}" for v in vals) + f" {sum(vals):+8.2f} {len(trades):7} "
                  f"{sum(v > 0 for v in vals):5}/{len(months)}")


if __name__ == "__main__":
    main()
