"""Download Coinbase daily candles for the coins used in the strategy search.

    python3 research/strategy_search/fetch_daily.py daily.json

Writes {"BTC-USD": [[time_ms, open, high, low, close, volume], ...], ...}. Daily
candles open at 00:00 UTC. Coinbase returns at most 300 candles per request.
"""
import json
import sys
import time
import urllib.request
from datetime import datetime, timezone

COINS = ["BTC-USD", "ETH-USD", "LTC-USD", "BCH-USD", "LINK-USD", "SOL-USD", "ADA-USD", "DOGE-USD", "AVAX-USD"]
URL = "https://api.exchange.coinbase.com/products/{}/candles?granularity=86400&start={}&end={}"
START = datetime(2015, 7, 20, tzinfo=timezone.utc)
DAY = 86400


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


def fetch(product):
    bars = {}
    t = int(START.timestamp())
    end = int(time.time()) // DAY * DAY  # drop today's unfinished candle
    while t < end:
        for ts, low, high, open_, close, vol in get(URL.format(product, iso(t), iso(min(t + 299 * DAY, end - DAY)))):
            if ts < end:
                bars[ts] = [ts * 1000, open_, high, low, close, vol]
        t += 300 * DAY
        time.sleep(0.15)
    return [bars[k] for k in sorted(bars)]


def main(out_file):
    data = {}
    for product in COINS:
        data[product] = fetch(product)
        first, last = data[product][0][0] // 1000, data[product][-1][0] // 1000
        print(f"{product}: {len(data[product])} days, {iso(first)[:10]} to {iso(last)[:10]}")
    with open(out_file, "w") as f:
        json.dump(data, f)
    print(f"wrote {out_file}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "daily.json")
