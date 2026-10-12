"""Backtest the VWAP pullback rules (pine/vwap_trend_pullback.pine) on Yahoo or TradingView data.

    python3 check.py                       # 60 days of 5-minute NQ=F from Yahoo, default settings
    python3 check.py --atr 1 --r 1 --max-stop 2   # any TradingView input can be set; see --help
    python3 check.py --sweep               # every ATR length x R target, month by month
    python3 check.py --csv mnq_5m.csv      # a TradingView export instead of Yahoo (any length)

Results are in dollars per 1 MNQ contract ($2 a point) after commission and slippage, split by
calendar month. A setting worth trading should make money in most months, not only in one.

Needs only Python 3.8+, no packages. Yahoo keeps 60 days of 5-minute data; for more, export the
chart from TradingView (chart menu > Export chart data) and pass the file with --csv.

The replay follows the Pine rules: session VWAP from 9:30 New York time, VWAP above/below its value
5 bars ago, 20/50 EMA, a VWAP touch in the previous 3 candles that came after the last entry, a
bullish/bearish signal candle, price no more than 2 ATR from VWAP on the candle before the pullback,
stop 1 tick beyond the pullback's extreme, skip stops wider than 1.5 ATR, target in R, entries
9:45-11:30, fill at the signal candle's close, one trade at a time. If a candle touches both the
stop and the target, the stop counts. Small differences from TradingView are normal (data feed,
bar timestamps); the totals should be close.
"""
import argparse
import csv
import datetime as dt
import json
import urllib.request
from collections import defaultdict

TICK, POINT_VALUE = 0.25, 2.0


def ny_offset(utc):
    """New York's UTC offset in hours (US daylight saving: 2nd Sunday of March to 1st Sunday of November)."""
    y = utc.year
    mar = dt.datetime(y, 3, 8 + (6 - dt.date(y, 3, 8).weekday()) % 7, 7)  # 2:00 EST = 7:00 UTC
    nov = dt.datetime(y, 11, 1 + (6 - dt.date(y, 11, 1).weekday()) % 7, 6)  # 2:00 EDT = 6:00 UTC
    return -4 if mar <= utc.replace(tzinfo=None) < nov else -5


def to_ny(ts):
    utc = dt.datetime.fromtimestamp(ts, dt.timezone.utc)
    return (utc + dt.timedelta(hours=ny_offset(utc))).replace(tzinfo=None)


def load_yahoo(symbol):
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?interval=5m&range=60d&includePrePost=false"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        res = json.load(r)["chart"]["result"][0]
    q = res["indicators"]["quote"][0]
    rows = []
    for i, ts in enumerate(res["timestamp"]):
        o, h, l, c, v = (q[k][i] for k in ("open", "high", "low", "close", "volume"))
        if None not in (o, h, l, c):
            rows.append((to_ny(ts), o, h, l, c, v or 0))
    return rows


def load_csv(path):
    """TradingView export: time (unix seconds or ISO with offset), open, high, low, close, Volume."""
    rows = []
    with open(path, newline="") as f:
        for r in csv.DictReader(f):
            r = {k.strip().lower(): v for k, v in r.items()}
            t = r.get("time") or r.get("date") or r.get("datetime")
            if t.replace(".", "").isdigit():
                when = to_ny(float(t))
            else:
                d = dt.datetime.fromisoformat(t.replace("Z", "+00:00"))
                when = to_ny(d.timestamp()) if d.tzinfo else d
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


DEFAULTS = dict(longs=True, shorts=True, slope=5, fast=20, slow=50, touch=3, ext=2.0, buffer=1, atr=14, max_stop=1.5,
                r=2.0, contracts=1, start=945, until=1130, flat=1555, max_trades=0, commission=0.62, slip_ticks=1)


class Market:
    def __init__(self, rows):
        self.T = [r[0] for r in rows]
        self.O, self.H, self.L, self.C, self.V = ([r[k] for r in rows] for k in range(1, 6))
        self.mins = [t.hour * 60 + t.minute for t in self.T]
        gaps = sorted((b - a).total_seconds() / 60 for a, b in zip(self.T[:500], self.T[1:501]))
        self.bar_min = gaps[len(gaps) // 2] if gaps else 5
        self.vwap, pv, vv = [], 0.0, 0.0
        for i, m in enumerate(self.mins):
            in_rth = 570 <= m < 960
            if in_rth and (i == 0 or not 570 <= self.mins[i - 1] < 960 or self.T[i].date() != self.T[i - 1].date()):
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


def tick_round(x):
    return round(x / TICK) * TICK


def backtest(mk, **settings):
    s = {**DEFAULTS, **settings}
    T, O, H, L, C, vw = mk.T, mk.O, mk.H, mk.L, mk.C, mk.vwap
    A, mins, n, bar = mk.atr(s["atr"]), mk.mins, len(mk.C), mk.bar_min
    fast, slow = mk.ema(s["fast"]), mk.ema(s["slow"])
    touch, slope, rr, buf = s["touch"], s["slope"], s["r"], s["buffer"] * TICK
    lo, hi = hhmm(s["start"]), hhmm(s["until"])
    flat_m = hhmm(s["flat"]) if s["flat"] is not None else None
    cost = 2 * s["commission"] + 2 * s["slip_ticks"] * TICK * POINT_VALUE  # $ per contract, round trip
    trades, last_entry, per_day = [], -1, defaultdict(int)
    i = max(60, touch + 2, slope + 1)
    while i < n:
        a, a_before = A[i], A[i - touch - 1]
        late = flat_m is not None and mins[i] + bar >= flat_m
        day_full = s["max_trades"] > 0 and per_day[T[i].date()] >= s["max_trades"]
        if lo <= mins[i] < hi and a and a_before and not late and not day_full:
            fresh = range(1, touch + 1)
            touch_l = any(L[i - k] <= vw[i - k] and i - k > last_entry for k in fresh)
            touch_s = any(H[i - k] >= vw[i - k] and i - k > last_entry for k in fresh)
            ext_ok = s["ext"] == 0 or abs(C[i - touch - 1] - vw[i - touch - 1]) <= s["ext"] * a_before
            side, stop = 0, None
            if s["longs"] and C[i] > vw[i] > vw[i - slope] and fast[i] > slow[i] and touch_l and C[i] > O[i] and ext_ok:
                stop = tick_round(min(L[i - touch:i + 1]) - buf)
                side = 1 if s["max_stop"] == 0 or C[i] - stop <= s["max_stop"] * a else 0
            elif s["shorts"] and C[i] < vw[i] < vw[i - slope] and fast[i] < slow[i] and touch_s and C[i] < O[i] and ext_ok:
                stop = tick_round(max(H[i - touch:i + 1]) + buf)
                side = -1 if s["max_stop"] == 0 or stop - C[i] <= s["max_stop"] * a else 0
            if side:
                risk = abs(C[i] - stop)
                target = tick_round(C[i] + side * rr * risk)
                pts, why, j = None, None, i + 1
                while j < n and pts is None:
                    if (L[j] <= stop) if side > 0 else (H[j] >= stop):
                        pts, why = -risk, "stop"
                    elif (H[j] >= target) if side > 0 else (L[j] <= target):
                        pts, why = side * (target - C[i]), "target"
                    elif flat_m is not None and (mins[j] + bar >= flat_m or T[j].date() != T[i].date()):
                        pts, why = side * (C[j] - C[i]), "time"
                    j += 1
                if pts is None:
                    break  # still open at the end of the data
                per_day[T[i].date()] += 1
                trades.append(dict(time=T[i], side="long" if side > 0 else "short", entry=C[i], stop=stop,
                                   risk_pts=risk, exit=why, r=pts / risk, usd=s["contracts"] * (pts * POINT_VALUE - cost)))
                # a stop or target fills inside candle j-1, so like TradingView a new trade may start on
                # that candle's close; a time exit closes the day, so the search resumes after it
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
    ap.add_argument("--csv", help="TradingView 5-minute export instead of Yahoo")
    ap.add_argument("--symbol", default="NQ%3DF", help="Yahoo symbol (default NQ=F, same prices as MNQ)")
    g = ap.add_argument_group("strategy settings (same names and defaults as the TradingView inputs)")
    g.add_argument("--no-longs", dest="longs", action="store_false", help="don't take longs")
    g.add_argument("--no-shorts", dest="shorts", action="store_false", help="don't take shorts")
    g.add_argument("--slope", type=int, default=d["slope"], help=f"VWAP slope: compare with (bars ago), default {d['slope']}")
    g.add_argument("--fast", type=int, default=d["fast"], help=f"fast EMA, default {d['fast']}")
    g.add_argument("--slow", type=int, default=d["slow"], help=f"slow EMA, default {d['slow']}")
    g.add_argument("--touch", type=int, default=d["touch"], help=f"VWAP touch within the previous (candles), default {d['touch']}")
    g.add_argument("--ext", type=float, default=d["ext"], help=f"skip if price was this far from VWAP before the pullback (x ATR, 0 = off), default {d['ext']}")
    g.add_argument("--buffer", type=int, default=d["buffer"], help=f"stop buffer (ticks), default {d['buffer']}")
    g.add_argument("--atr", type=int, default=d["atr"], help=f"ATR length, default {d['atr']}")
    g.add_argument("--max-stop", type=float, default=d["max_stop"], help=f"skip if the stop is wider than (x ATR, 0 = off), default {d['max_stop']}")
    g.add_argument("--r", type=float, default=d["r"], help=f"take profit (x initial risk), default {d['r']}")
    g.add_argument("--contracts", type=int, default=d["contracts"], help=f"contracts, default {d['contracts']}")
    g.add_argument("--start", type=int, default=d["start"], help=f"take entries from HHMM New York, default {d['start']}")
    g.add_argument("--until", type=int, default=d["until"], help=f"take entries until HHMM New York, default {d['until']}")
    g.add_argument("--flat", type=int, default=d["flat"], help=f"close open trades at HHMM New York, default {d['flat']}")
    g.add_argument("--no-flat", dest="flat", action="store_const", const=None, help="never close by time, only at the stop or target")
    g.add_argument("--max-trades", type=int, default=d["max_trades"], help="max trades per day (0 = no limit)")
    ap.add_argument("--sweep", action="store_true", help="test every ATR length x R target with the other settings")
    ap.add_argument("--trades", action="store_true", help="list every trade")
    args = ap.parse_args()
    settings = {k: getattr(args, k) for k in DEFAULTS if hasattr(args, k)}

    rows = load_csv(args.csv) if args.csv else load_yahoo(args.symbol)
    mk = Market(rows)
    print(f"{len(rows)} bars, {rows[0][0]:%Y-%m-%d} to {rows[-1][0]:%Y-%m-%d} (New York time)")
    shown = {k: v for k, v in settings.items() if not (args.sweep and k in ("atr", "r"))}
    print("settings: " + ", ".join(f"{k}={v}" for k, v in shown.items()) + "\n")

    if not args.sweep:
        trades = backtest(mk, **settings)
        c = settings["contracts"]
        print(f"$ for {c} MNQ contract{'s' if c != 1 else ''} after costs")
        print("(R = result in units of the trade's own risk, before costs; it doesn't depend on position size)")
        print(f"{'month':8} {'trades':>6} {'wins':>5} {'total R':>8} {'net $':>8}")
        for m, ts in sorted(by_month(trades).items()) + ([("total", trades)] if trades else []):
            print(f"{m:8} {len(ts):6} {sum(t['r'] > 0 for t in ts) / len(ts):5.0%} {sum(t['r'] for t in ts):+8.2f} {sum(t['usd'] for t in ts):8.0f}")
        if args.trades:
            print()
            for t in trades:
                print(f"{t['time']:%Y-%m-%d %H:%M} {t['side']:5} entry {t['entry']:.2f} stop {t['stop']:.2f} "
                      f"risk {t['risk_pts']:.2f} pts  {t['exit']:6} {t['r']:+5.2f}R {t['usd']:+8.2f} $")
        return

    months = sorted({t.strftime("%Y-%m") for t in mk.T})
    print("Total R by month for each ATR length x R target (net $ in the last columns)")
    print(f"{'ATR':>4} {'R':>5} " + " ".join(f"{m:>8}" for m in months) + f" {'total R':>8} {'net $':>8} {'months +':>9}")
    for a in (1, 2, 3, 5, 10, 14, 20):
        for r in (0.75, 1.0, 1.25, 1.5, 2.0, 2.5):
            trades = backtest(mk, **{**settings, "atr": a, "r": r})
            per = by_month(trades)
            vals = [sum(t["r"] for t in per.get(m, [])) for m in months]
            print(f"{a:4} {r:5} " + " ".join(f"{v:+8.2f}" for v in vals) + f" {sum(vals):+8.2f} "
                  f"{sum(t['usd'] for t in trades):8.0f} {sum(v > 0 for v in vals):5}/{len(months)}")


if __name__ == "__main__":
    main()
