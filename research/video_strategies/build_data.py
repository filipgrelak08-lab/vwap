"""Turn Dukascopy USATECHIDXUSD 1-minute day files into New York regular-hours bars.

    python3 research/video_strategies/fetch_dukascopy.py raw/ 2019-01-01 2026-10-08
    python3 research/video_strategies/build_data.py raw/ nq.json

Writes {"NQ|5m": bars, "NQ|15m": bars} where each bar is [time, open, high, low, close, volume]
and time is New York wall-clock time stored as UTC (the format server.py uses).
Only 09:30-16:00 New York time is kept. Dukascopy's volume is tick volume, not exchange volume.
"""
import json
import lzma
import struct
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

NY = ZoneInfo("America/New_York")
raw_dir, out_file = Path(sys.argv[1]), Path(sys.argv[2])


def minutes(path):
    blob = path.read_bytes()
    if not blob:
        return []
    raw = lzma.decompress(blob)
    day = datetime.fromisoformat(path.stem).replace(tzinfo=timezone.utc)
    rows = []
    for k in range(len(raw) // 24):
        sec, o, c, lo, hi, vol = struct.unpack(">5if", raw[k * 24:(k + 1) * 24])
        utc = day + timedelta(seconds=sec)
        local = utc.astimezone(NY)
        m = local.hour * 60 + local.minute
        if 570 <= m < 960:  # 09:30 <= t < 16:00
            wall = int(local.replace(tzinfo=timezone.utc).timestamp())
            rows.append([wall, o / 1000, hi / 1000, lo / 1000, c / 1000, float(vol)])
    return rows


def aggregate(rows, mins):
    out = []
    for r in rows:
        t = r[0] - ((r[0] % 86400) - 570 * 60) % (mins * 60)  # buckets anchored at 09:30
        if out and out[-1][0] == t:
            b = out[-1]
            b[2] = max(b[2], r[2]); b[3] = min(b[3], r[3]); b[4] = r[4]; b[5] += r[5]
        else:
            out.append([t, r[1], r[2], r[3], r[4], r[5]])
    return out


days = sorted(raw_dir.glob("*.bi5"))
one = []
kept = 0
for p in days:
    rows = minutes(p)
    # skip holidays and half days: Dukascopy fills closed hours with flat, zero-volume candles
    if sum(1 for r in rows if r[5] > 0) >= 300:
        one.extend(rows)
        kept += 1
data = {"NQ|5m": aggregate(one, 5), "NQ|15m": aggregate(one, 15)}
for k, v in data.items():
    for b in v:
        b[1:5] = [round(x, 2) for x in b[1:5]]
        b[5] = round(b[5], 4)
out_file.write_text(json.dumps(data))
print(f"{len(days)} day files, {kept} sessions kept, {len(data['NQ|5m'])} 5m bars, {len(data['NQ|15m'])} 15m bars"
      f" ({date.fromtimestamp(one[0][0]) if one else '-'} to {date.fromtimestamp(one[-1][0]) if one else '-'})")
