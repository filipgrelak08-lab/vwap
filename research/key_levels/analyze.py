"""Do intraday "key levels" stop price more often than nearby made-up levels?

    python3 research/key_levels/analyze.py [bars.json]

Downloads 2 years of hourly bars for NQ=F, ES=F, QQQ and SPY from Yahoo (cached in bars.json),
then runs two tests and writes the tables next to this file.

1. Bounce test. For each day and each level (previous day's high/low/close, overnight high/low,
   today's open, first-hour high/low, round numbers), find the first time price trades into the
   level. From there, did price move D = 0.25 x daily ATR back the way it came (a bounce) before
   moving D through the level (a cross)? For a level that means nothing, that is close to a coin
   flip. The same test runs on placebo levels: the real level shifted by +-0.15 to 0.6 daily ATR
   (for round numbers, the quarter and half points between them). A key level is one whose bounce
   rate beats its placebos. Confidence intervals come from resampling whole days.

2. Timing test (QQQ and SPY, exact 9:30 sessions). In which hour is the day's high and low set,
   compared with a random walk that has the same volatility in each hour?
"""
import csv
import datetime as dt
import json
import math
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1]))
import server  # noqa: E402

SYMBOLS = {"NQ=F": ("fut", 100.0), "ES=F": ("fut", 25.0), "QQQ": ("etf", 5.0), "SPY": ("etf", 5.0)}
OFFSETS = [-0.6, -0.45, -0.3, -0.15, 0.15, 0.3, 0.45, 0.6]  # placebo shifts, x daily ATR
D_MULTS = [0.15, 0.25, 0.4]  # bounce / cross distance, x daily ATR (0.25 is the headline)
HORIZON = 14  # bars to wait for an outcome
ATR_LEN = 14
LEVEL_NAMES = {
    "PDH": "Previous day high", "PDL": "Previous day low", "PC": "Previous day close",
    "ONH": "Overnight high", "ONL": "Overnight low", "OPEN": "Today's open",
    "IBH": "First-hour high", "IBL": "First-hour low", "ROUND": "Round number",
}
rng = np.random.default_rng(7)


def load(cache):
    if cache.exists():
        return json.loads(cache.read_text())
    data = {s: server.fetch_yahoo(s, "1h", "2y", False)["bars"] for s in SYMBOLS}
    cache.write_text(json.dumps(data))
    return data


def build(bars, kind):
    """Split hourly bars into trading days. Futures: overnight = 18:00-9:00, day = 9:00-16:00
    (the 9:00 bar includes 30 minutes before the cash open). ETFs: day = 9:30-16:00."""
    seq, days = [], {}
    for t, o, h, l, c, _ in bars:
        w = dt.datetime.fromtimestamp(t, dt.UTC)  # exchange wall-clock time
        m = w.hour * 60 + w.minute
        key, part = w.date(), "day"
        if kind == "etf":
            if not 570 <= m < 960:
                continue
        elif m >= 1080:
            key, part = key + dt.timedelta(days=1), "on"
        elif m < 540:
            part = "on"
        elif m >= 960:
            continue
        days.setdefault(key, {"on": [], "day": []})[part].append(len(seq))
        seq.append((o, h, l, c, m))
    out = [dict(key=k, **v) for k, v in sorted(days.items()) if len(v["day"]) >= 3]
    for i, d in enumerate(out):
        idx = d["day"]
        d["H"] = max(seq[j][1] for j in idx)
        d["L"] = min(seq[j][2] for j in idx)
        d["C"] = seq[idx[-1]][3]
        d["O"] = seq[idx[0]][0]
        pc = out[i - 1]["C"] if i else d["O"]
        d["TR"] = max(d["H"] - d["L"], abs(d["H"] - pc), abs(d["L"] - pc))
    for i, d in enumerate(out):
        d["ATR"] = sum(x["TR"] for x in out[i - ATR_LEN:i]) / ATR_LEN if i >= ATR_LEN else None
    return seq, out


def first_touch(seq, bar_ids, level):
    for k in bar_ids:
        o, h, l, c, _ = seq[k]
        if o < level <= h:
            return k, 1  # approached from below
        if o > level >= l:
            return k, -1  # approached from above
    return None, 0


def resolve(seq, k, side, level, dist):
    far, back = level + side * dist, level - side * dist  # through the level / back where it came from
    o, h, l, c, _ = seq[k]
    thru = h >= far if side > 0 else l <= far
    ret = l <= back if side > 0 else h >= back
    if ret:
        return None  # can't tell whether that happened before or after the touch
    if thru:
        return 0
    for j in range(k + 1, min(k + 1 + HORIZON, len(seq))):
        o, h, l, c, _ = seq[j]
        thru = h >= far if side > 0 else l <= far
        ret = l <= back if side > 0 else h >= back
        if thru and ret:
            return None
        if thru:
            return 0
        if ret:
            return 1
    return None


def levels_for(days, i, kind, seq):
    """(name, price, first bar index it may be tested from) for day i."""
    d, p = days[i], days[i - 1]
    day = d["day"]
    out = [("PDH", p["H"], 0), ("PDL", p["L"], 0), ("PC", p["C"], 0)]
    if kind == "fut" and len(d["on"]) >= 6:
        out += [("ONH", max(seq[j][1] for j in d["on"]), 0), ("ONL", min(seq[j][2] for j in d["on"]), 0)]
    out.append(("OPEN", d["O"], 1))
    if kind == "etf":
        out += [("IBH", seq[day[0]][1], 1), ("IBL", seq[day[0]][2], 1)]
    return out


def bounce_test(data):
    rows = []  # (symbol, day index, level, is_real, D mult, result)
    for sym, (kind, grid) in SYMBOLS.items():
        seq, days = build(data[sym], kind)
        for i in range(ATR_LEN + 1, len(days)):
            d = days[i]
            atr = d["ATR"]
            if not atr:
                continue
            for name, price, start in levels_for(days, i, kind, seq):
                bar_ids = d["day"][start:]
                cands = [(price, True)] + [(price + k * atr, False) for k in OFFSETS]
                for lvl, real in cands:
                    k, side = first_touch(seq, bar_ids, lvl)
                    if k is None:
                        continue
                    for dm in D_MULTS:
                        rows.append((sym, i, name, real, dm, resolve(seq, k, side, lvl, dm * atr)))
            # round numbers: multiples of the grid are real, quarter/half/three-quarter points are placebos
            q = grid / 4
            lo, hi = d["L"], d["H"]
            for n in range(math.ceil(lo / q), math.floor(hi / q) + 1):
                lvl = n * q
                k, side = first_touch(seq, d["day"], lvl)
                if k is None:
                    continue
                for dm in D_MULTS:
                    rows.append((sym, i, "ROUND", n % 4 == 0, dm, resolve(seq, k, side, lvl, dm * atr)))
    return rows


def summarize(rows, level, dm, syms=None, n_boot=2000):
    groups = {}
    for sym, day, name, real, m, res in rows:
        if name != level or m != dm or res is None or (syms and sym not in syms):
            continue
        g = groups.setdefault((sym, day), [0, 0, 0, 0])  # real bounces, real n, placebo bounces, placebo n
        g[0 if real else 2] += res
        g[1 if real else 3] += 1
    if not groups:
        return None
    a = np.array(list(groups.values()), dtype=float)
    if a[:, 1].sum() == 0 or a[:, 3].sum() == 0:
        return None
    pr, pp = a[:, 0].sum() / a[:, 1].sum(), a[:, 2].sum() / a[:, 3].sum()
    idx = rng.integers(0, len(a), size=(n_boot, len(a)))
    s = a[idx].sum(axis=1)
    diffs = s[:, 0] / np.maximum(s[:, 1], 1) - s[:, 2] / np.maximum(s[:, 3], 1)
    lo, hi = np.percentile(diffs, [2.5, 97.5])
    return dict(level=level, d_atr=dm, n_real=int(a[:, 1].sum()), bounce_real=pr, n_placebo=int(a[:, 3].sum()),
                bounce_placebo=pp, edge=pr - pp, ci_low=lo, ci_high=hi, p_value_one_sided=float((diffs <= 0).mean()))


def timing_test(data):
    """Hour of the day's high and low for QQQ/SPY full sessions, vs a volatility-matched random walk."""
    slots = [570, 630, 690, 750, 810, 870, 930]  # 9:30 ... 15:30 bar starts
    counts_h, counts_l, ib = np.zeros(7), np.zeros(7), dict(days=0, ext15=0, ext20=0, both=0)
    rets = [[] for _ in slots]
    for sym in ("QQQ", "SPY"):
        seq, days = build(data[sym], "etf")
        for d in days:
            bars = [seq[j] for j in d["day"]]
            if [b[4] for b in bars] != slots:
                continue  # skip half days
            highs, lows = [b[1] for b in bars], [b[2] for b in bars]
            counts_h[int(np.argmax(highs))] += 1
            counts_l[int(np.argmin(lows))] += 1
            for s, b in enumerate(bars):
                rets[s].append(math.log(b[3] / b[0]))
            ibr = highs[0] - lows[0]
            rng_day = max(highs) - min(lows)
            ib["days"] += 1
            ib["ext15"] += rng_day >= 1.5 * ibr
            ib["ext20"] += rng_day >= 2.0 * ibr
            ib["both"] += max(highs[1:]) > highs[0] and min(lows[1:]) < lows[0]
    n = counts_h.sum()
    # random walk with each hour's real volatility, in 5-minute steps (the last slot is 30 minutes)
    steps = [12] * 6 + [6]
    sd = [np.std(r) / math.sqrt(k) for r, k in zip(rets, steps)]
    sims = 20000
    path = np.cumsum(np.concatenate([rng.normal(0, s, size=(sims, k)) for s, k in zip(sd, steps)], axis=1), axis=1)
    slot_of = np.repeat(np.arange(7), steps)
    sim_h = np.bincount(slot_of[path.argmax(axis=1)], minlength=7) / sims
    sim_l = np.bincount(slot_of[path.argmin(axis=1)], minlength=7) / sims
    flat_h = np.bincount(slot_of[np.cumsum(rng.normal(0, 1, size=(sims, 78)), axis=1).argmax(axis=1)], minlength=7) / sims
    table = []
    for s in range(7):
        table.append(dict(hour=f"{slots[s] // 60}:{slots[s] % 60:02d}", high_share=counts_h[s] / n, low_share=counts_l[s] / n,
                          random_walk_same_vol=(sim_h[s] + sim_l[s]) / 2, random_walk_flat_vol=flat_h[s],
                          hourly_vol=float(np.std(rets[s]))))
    return table, int(n), ib


def write_csv(path, rows):
    with open(path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]))
        w.writeheader()
        for r in rows:
            w.writerow({k: (round(v, 4) if isinstance(v, float) else v) for k, v in r.items()})


def main():
    data = load(Path(sys.argv[1]) if len(sys.argv) > 1 else HERE / "bars.json")
    for s in SYMBOLS:
        b = data[s]
        print(f"{s}: {len(b)} hourly bars, {dt.datetime.fromtimestamp(b[0][0], dt.UTC):%Y-%m-%d} to {dt.datetime.fromtimestamp(b[-1][0], dt.UTC):%Y-%m-%d}")

    rows = bounce_test(data)
    out = []
    for dm in D_MULTS:
        for lv in LEVEL_NAMES:
            for scope, syms in (("all", None), ("NQ=F", {"NQ=F"}), ("ES=F", {"ES=F"}), ("QQQ", {"QQQ"}), ("SPY", {"SPY"})):
                r = summarize(rows, lv, dm, syms)
                if r:
                    out.append(dict(scope=scope, **r))
    write_csv(HERE / "bounce_test.csv", out)
    print("\nBounce test, D = 0.25 x daily ATR, all symbols pooled")
    print(f"{'level':22} {'touches':>7} {'bounce':>7} {'placebo':>8} {'edge':>7} {'95% CI':>17} {'p':>6}")
    for r in out:
        if r["scope"] == "all" and r["d_atr"] == 0.25:
            print(f"{LEVEL_NAMES[r['level']]:22} {r['n_real']:7} {r['bounce_real']:7.1%} {r['bounce_placebo']:8.1%} "
                  f"{r['edge']:+7.1%} [{r['ci_low']:+6.1%}, {r['ci_high']:+6.1%}] {r['p_value_one_sided']:6.3f}")

    table, n, ib = timing_test(data)
    write_csv(HERE / "timing_test.csv", table)
    print(f"\nWhere the day's high/low is set (QQQ+SPY, {n} full sessions)")
    print(f"{'hour':6} {'high':>6} {'low':>6} {'rw same vol':>12} {'rw flat vol':>12} {'hourly vol':>11}")
    for r in table:
        print(f"{r['hour']:6} {r['high_share']:6.1%} {r['low_share']:6.1%} {r['random_walk_same_vol']:12.1%} {r['random_walk_flat_vol']:12.1%} {r['hourly_vol']:11.4f}")
    print(f"\nFirst hour: range ends >= 1.5x first-hour range on {ib['ext15'] / ib['days']:.1%} of days, >= 2x on "
          f"{ib['ext20'] / ib['days']:.1%}; both sides broken on {ib['both'] / ib['days']:.1%}")
    (HERE / "summary.json").write_text(json.dumps(dict(timing_days=n, first_hour=ib), indent=1))


if __name__ == "__main__":
    main()
