"""Download Dukascopy 1-minute BID candles, one file per UTC weekday.

    python3 research/video_strategies/fetch_dukascopy.py raw/ 2019-01-01 2026-10-08 [INSTRUMENT] [THREADS]

INSTRUMENT defaults to USATECHIDXUSD (Nasdaq-100 CFD); USA500IDXUSD is the S&P 500.
Already downloaded days are skipped, so the script can be re-run to resume.
Dukascopy throttles single connections, so many parallel requests are much faster.
"""
import datetime as dt
import os
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

out = sys.argv[1]
start = dt.date.fromisoformat(sys.argv[2])
end = dt.date.fromisoformat(sys.argv[3])
instrument = sys.argv[4] if len(sys.argv) > 4 else "USATECHIDXUSD"
threads = int(sys.argv[5]) if len(sys.argv) > 5 else 24
os.makedirs(out, exist_ok=True)
days = [start + dt.timedelta(d) for d in range((end - start).days + 1)]
days = [d for d in days if d.weekday() < 5]


def get(d):
    f = f"{out}/{d.isoformat()}.bi5"
    if os.path.exists(f):
        return 0
    url = (f"https://datafeed.dukascopy.com/datafeed/{instrument}/"
           f"{d.year}/{d.month - 1:02d}/{d.day:02d}/BID_candles_min_1.bi5")  # months are 0-based
    for k in range(12):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            body = urllib.request.urlopen(req, timeout=60).read()
            with open(f + ".tmp", "wb") as fh:
                fh.write(body)
            os.replace(f + ".tmp", f)
            return 1
        except Exception as e:  # noqa: BLE001 - retry anything, the feed resets connections often
            if getattr(e, "code", None) == 404:
                open(f, "wb").close()  # no data that day
                return 0
            time.sleep(1 + k)
    print("FAILED", d, flush=True)
    return 0


with ThreadPoolExecutor(threads) as ex:
    got = 0
    for i, r in enumerate(ex.map(get, days)):
        got += r
        if i % 200 == 0:
            print(f"{i}/{len(days)}", flush=True)
print(f"done: {got} new files, {len(days)} weekdays", flush=True)
