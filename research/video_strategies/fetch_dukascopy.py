# Download Dukascopy USATECHIDXUSD (Nasdaq-100 CFD) 1-minute BID candles, one file per UTC day.
import sys, os, time, datetime as dt, urllib.request
from concurrent.futures import ThreadPoolExecutor
out = sys.argv[1]; start = dt.date.fromisoformat(sys.argv[2]); end = dt.date.fromisoformat(sys.argv[3])
days = [start + dt.timedelta(d) for d in range((end - start).days + 1)]
days = [d for d in days if d.weekday() < 5]
def get(d):
    f = f"{out}/{d.isoformat()}.bi5"
    if os.path.exists(f): return 0
    url = f"https://datafeed.dukascopy.com/datafeed/USATECHIDXUSD/{d.year}/{d.month-1:02d}/{d.day:02d}/BID_candles_min_1.bi5"
    for k in range(6):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            b = urllib.request.urlopen(req, timeout=60).read()
            open(f + ".tmp", "wb").write(b); os.replace(f + ".tmp", f); return 1
        except Exception as e:
            if getattr(e, "code", None) == 404: open(f, "wb").close(); return 0
            time.sleep(2 ** k)
    print("FAILED", d, flush=True); return 0
with ThreadPoolExecutor(6) as ex:
    n = 0
    for i, r in enumerate(ex.map(get, days)):
        n += r
        if i % 200 == 0: print(i, len(days), flush=True)
print("done", n, flush=True)
