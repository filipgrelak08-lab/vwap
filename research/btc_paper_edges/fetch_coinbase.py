"""Download Coinbase BTC-USD hourly candles (spot, back to 2015) into a CSV.

    python3 research/btc_paper_edges/fetch_coinbase.py btc_usd_1h.csv

Coinbase returns at most 300 candles per request, so this pages through the
range. Columns: time (UTC ms of the bar open), open, high, low, close, volume.
"""
import csv
import json
import sys
import time
import urllib.request
from datetime import datetime, timezone

URL = "https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=3600&start={}&end={}"
START = datetime(2015, 7, 20, tzinfo=timezone.utc)
STEP = 300 * 3600


def iso(ts):
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def get(url):
    for attempt in range(5):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "vwap-lab-research"})
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.load(r)
        except Exception as e:  # rate limit or network blip
            print(f"retry {attempt + 1}: {e}", file=sys.stderr)
            time.sleep(2 ** attempt)
    raise RuntimeError(f"failed: {url}")


def main(out_file):
    bars = {}
    t = int(START.timestamp())
    end = int(time.time()) // 3600 * 3600
    while t < end:
        chunk = get(URL.format(iso(t), iso(min(t + STEP - 3600, end))))
        for ts, low, high, open_, close, vol in chunk:
            bars[ts] = (open_, high, low, close, vol)
        t += STEP
        time.sleep(0.15)
    with open(out_file, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["time", "open", "high", "low", "close", "volume"])
        for ts in sorted(bars):
            w.writerow([ts * 1000, *bars[ts]])
    print(f"wrote {len(bars)} bars to {out_file} ({iso(min(bars))} to {iso(max(bars))})")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "btc_usd_1h.csv")
