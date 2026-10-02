"""Download the price data used by run.js.

    python3 research/ema_sweep/fetch_data.py data.json SPY QQQ IWM DIA AAPL MSFT
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
import server  # noqa: E402

out_file, *symbols = sys.argv[1:] or ["data.json"]
symbols = symbols or ["SPY", "QQQ", "IWM", "DIA", "AAPL", "MSFT"]
data = {}
for sym in symbols:
    for interval, rng in (("1d", "max"), ("1h", "2y")):
        bars = server.fetch_yahoo(sym, interval, rng, True)["bars"]
        data[f"{sym}|{interval}"] = bars
        print(f"{sym} {interval}: {len(bars)} bars")
Path(out_file).write_text(json.dumps(data))
print(f"wrote {out_file}")
