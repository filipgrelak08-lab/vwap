"""Nasdaq gamma levels on a local web page: GEX from free CBOE option data, drawn on the NQ chart.

    python3 gex/server.py              # then open http://localhost:8010
    python3 gex/server.py --port 9010

Data: CBOE's free delayed option quotes for QQQ and NDX (open interest updates once a day before the
open; quotes are about 15 minutes late) and Yahoo's 5-minute NQ=F futures for the price chart.

How GEX is calculated (the usual public method):
- each option's gamma comes from Black-Scholes with its own implied volatility and time to expiry;
- dollar gamma per 1% move = gamma x open interest x 100 x price^2 x 1%;
- calls count as positive and puts as negative, i.e. dealers are assumed to be long the calls and short
  the puts customers trade. Nobody sees the real positions, so treat every GEX number as an estimate;
- the gamma flip is the price where the total, recalculated at that price, crosses zero;
- QQQ and NDX strikes are converted to NQ prices with today's QQQ/NDX/NQ ratios.

Needs only Python 3.9+, no packages.
"""
import argparse
import datetime as dt
import json
import math
import re
import threading
import time
import urllib.request
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from zoneinfo import ZoneInfo

HERE = Path(__file__).resolve().parent
VENDOR = HERE.parent / "web" / "vendor" / "lightweight-charts.standalone.production.js"
UTC = dt.timezone.utc
NY = ZoneInfo("America/New_York")
SYMBOL_RE = re.compile(r"^([A-Z]+)(\d{6})([CP])(\d{8})$")
RATE = 0.04  # risk-free rate for Black-Scholes; small changes barely move the levels
BUCKET = 25  # NQ points per strike bucket
RANGE = 0.08  # show and search levels within 8% of the price
CACHE_SECONDS = 600


def get_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def load_chain(symbol):
    j = get_json(f"https://cdn.cboe.com/api/global/delayed_quotes/options/{symbol}.json")
    return j["timestamp"], j["data"]


def options(data, now, max_days):
    """(strike, is_call, open_interest, iv, years_to_expiry) for every usable option."""
    out = []
    for o in data["options"]:
        m = SYMBOL_RE.match(o["option"])
        if not m or not o.get("open_interest") or not o.get("iv") or o["iv"] <= 0:
            continue
        expiry = dt.datetime.strptime(m.group(2), "%y%m%d").replace(hour=16, tzinfo=NY)
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
    """Total dollar gamma per 1% move at `spot` (calls +, puts -), and {strike: [calls, puts]}."""
    total, by_strike = 0.0, {}
    for k, is_call, oi, iv, t in opts:
        g = gamma(spot, k, iv, t) * oi * 100 * spot * spot * 0.01 * (1 if is_call else -1)
        total += g
        by_strike.setdefault(k, [0.0, 0.0])[0 if is_call else 1] += g
    return total, by_strike


def nq_quote():
    j = get_json("https://query1.finance.yahoo.com/v8/finance/chart/NQ%3DF?interval=1d&range=5d")
    return j["chart"]["result"][0]["meta"]["regularMarketPrice"]


def compute_gex(max_days=0):
    now = dt.datetime.now(UTC)
    ts_q, qqq = load_chain("QQQ")
    ts_n, ndx = load_chain("_NDX")
    q0, n0 = qqq["current_price"], ndx["current_price"]
    try:
        nq0 = nq_quote()
    except Exception:
        nq0 = None
    to_nq = nq0 / n0 if nq0 else 1.0  # NQ trades at a small premium to NDX
    nq_spot = nq0 or n0
    q_opts, n_opts = options(qqq, now, max_days), options(ndx, now, max_days)

    tq, sq = gex_at(q_opts, q0)
    tn, sn = gex_at(n_opts, n0)
    total = tq + tn

    # total GEX if both underlyings moved by the same %, and where it crosses zero
    grid = [i / 1000 for i in range(-80, 81, 2)]
    curve = [(m, gex_at(q_opts, q0 * (1 + m))[0] + gex_at(n_opts, n0 * (1 + m))[0]) for m in grid]
    flips = [a[0] - a[1] * (b[0] - a[0]) / (b[1] - a[1]) for a, b in zip(curve, curve[1:]) if (a[1] < 0) != (b[1] < 0)]
    flip_m = min(flips, key=abs) if flips else None

    buckets = {}
    for src, to_price in ((sq, lambda k: k * n0 / q0 * to_nq), (sn, lambda k: k * to_nq)):
        for k, (c, p) in src.items():
            b = buckets.setdefault(round(to_price(k) / BUCKET) * BUCKET, [0.0, 0.0])
            b[0] += c
            b[1] += p
    near = {k: v for k, v in buckets.items() if abs(k / nq_spot - 1) <= RANGE}
    call_wall = max(near, key=lambda k: near[k][0])
    put_wall = min(near, key=lambda k: near[k][1])
    return {
        "computed": now.isoformat(),
        "dataTime": ts_q,
        "qqq": q0, "ndx": n0, "nq": nq_spot, "nqLive": nq0 is not None,
        "optionsUsed": {"QQQ": len(q_opts), "NDX": len(n_opts)},
        "maxDays": max_days,
        "total": total,
        "regime": "positive" if total > 0 else "negative",
        "flip": nq_spot * (1 + flip_m) if flip_m is not None else None,
        "callWall": call_wall,
        "putWall": put_wall,
        "profile": [{"price": k, "calls": v[0], "puts": v[1]} for k, v in sorted(near.items())],
        "curve": [{"price": nq_spot * (1 + m), "gex": g} for m, g in curve],
    }


def nq_bars():
    """5-minute NQ=F candles for the last 5 days, timestamps as New York wall-clock time."""
    j = get_json("https://query1.finance.yahoo.com/v8/finance/chart/NQ%3DF?interval=5m&range=5d")
    r = j["chart"]["result"][0]
    q = r["indicators"]["quote"][0]
    bars = []
    for i, ts in enumerate(r["timestamp"]):
        o, h, l, c = q["open"][i], q["high"][i], q["low"][i], q["close"][i]
        if None in (o, h, l, c):
            continue
        local = ts + int(dt.datetime.fromtimestamp(ts, NY).utcoffset().total_seconds())
        bars.append({"time": local, "open": o, "high": h, "low": l, "close": c})
    return bars


class Cache:
    def __init__(self):
        self.lock = threading.Lock()
        self.data = {}

    def get(self, key, fn, max_age):
        with self.lock:
            hit = self.data.get(key)
            if hit and time.time() - hit[0] < max_age:
                return hit[1]
        value = fn()
        with self.lock:
            self.data[key] = (time.time(), value)
        return value


CACHE = Cache()


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def send_json(self, payload, status=200):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_file(self, path, ctype):
        body = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        url = urlparse(self.path)
        try:
            if url.path in ("/", "/index.html"):
                return self.send_file(HERE / "index.html", "text/html; charset=utf-8")
            if url.path == "/vendor/lightweight-charts.js":
                return self.send_file(VENDOR, "text/javascript")
            if url.path == "/api/gex":
                q = parse_qs(url.query)
                max_days = int(q.get("maxDays", ["0"])[0] or 0)
                fresh = q.get("refresh", ["0"])[0] == "1"
                return self.send_json(CACHE.get(("gex", max_days), lambda: compute_gex(max_days), 0 if fresh else CACHE_SECONDS))
            if url.path == "/api/price":
                return self.send_json(CACHE.get("price", nq_bars, 60))
            self.send_error(404)
        except Exception as e:  # report data problems to the page instead of a blank screen
            self.send_json({"error": f"{type(e).__name__}: {e}"}, 502)


def main():
    ap = argparse.ArgumentParser(description="Nasdaq gamma levels on localhost.")
    ap.add_argument("--port", type=int, default=8010)
    ap.add_argument("--no-browser", action="store_true", help="don't open a browser tab")
    args = ap.parse_args()
    httpd = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    httpd.daemon_threads = True
    url = f"http://localhost:{args.port}/"
    print(f"\n  Nasdaq gamma levels: {url}\n  Press Ctrl+C to stop.\n")
    if not args.no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n  Stopped.")


if __name__ == "__main__":
    main()
