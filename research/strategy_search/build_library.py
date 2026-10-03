"""Build research/library.json: the tested strategies shown in the app's Library tab.

    python3 research/strategy_search/build_library.py

Numbers come from the CSVs written by search.py, traderdev_check.py and
research/btc_paper_edges/analyze.py; the descriptions and verdicts are below.
"""
import csv
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
RESEARCH = HERE.parent
PAPER = RESEARCH / "btc_paper_edges"
BTC_DATA = {"source": "yahoo", "symbol": "BTC-USD", "interval": "1d", "range": "max"}


def rows(path):
    return list(csv.DictReader(open(path)))


def num(v):
    try:
        return round(float(v), 2)
    except (TypeError, ValueError):
        return None


SUMMARY = {r["strategy"]: r for r in rows(HERE / "summary.csv")}
TD_SUMMARY = rows(HERE / "traderdev_summary.csv")
TD_RUNS = json.load(open(HERE / "traderdev_runs.json"))


def search_evidence(name):
    """Rows for a rule from the 9-coin search; the median coin, so one lucky coin can't carry it."""
    s, bh = SUMMARY[name], SUMMARY["Buy and hold"]

    def row(label, p, s=s):
        return {"label": label, "sharpe": num(s[f"{p}_median_sharpe"]), "cagr": num(s[f"{p}_mean_cagr"]),
                "maxDd": num(s[f"{p}_median_max_dd"]), "beatsBh": f"{s[f'{p}_beats_bh_sharpe']} of {s[f'{p}_coins']}"}

    return [
        row("Before 2022 · 5 coins · settings picked here", "in"),
        row("2022 → Oct 2026 · 9 coins · never seen before", "out"),
        row("Apr 2025 → Oct 2026 · 9 coins", "post_paper"),
        {"label": "Buy and hold, 2022 → Oct 2026 · 9 coins", "sharpe": num(bh["out_median_sharpe"]), "cagr": num(bh["out_mean_cagr"]), "maxDd": num(bh["out_median_max_dd"]), "beatsBh": "–"},
        {"label": "Equal-weight portfolio of the 9 coins, 2022 →", "sharpe": num(s["portfolio_out_sharpe"]), "cagr": num(s["portfolio_out_cagr"]), "maxDd": num(s["portfolio_out_max_dd"]), "beatsBh": f"buy and hold: {num(bh['portfolio_out_sharpe'])}"},
    ]


def paper_row(csv_name, strategy, period, label, costs="taker 0.05%/side"):
    """One row from the BTC replication of Padysak & Vojtko (Coinbase)."""
    r = next(r for r in rows(PAPER / csv_name) if r["strategy"] == strategy and r["period"] == period and r["costs"] == costs)
    return {"label": label, "sharpe": num(r["sharpe"]), "cagr": num(r["cagr_pct"]), "maxDd": num(r["max_dd_pct"]), "beatsBh": "–"}


def paper_evidence(csv_name, strategy, extra=None):
    return [
        paper_row(csv_name, strategy, "paper", "Paper's sample · BTC · Nov 2015 → Feb 2022"),
        paper_row(csv_name, strategy, "after", "After the paper · BTC · Feb 2022 → Oct 2026"),
        *(extra or []),
        paper_row("coinbase_max_min.csv", "Buy and hold", "after", "Buy and hold BTC, Feb 2022 → Oct 2026", costs="none"),
    ]


def td_period(strategy, symbol, period="2022 on"):
    r = next((x for x in TD_SUMMARY if x["strategy"] == strategy and x["symbol"] == symbol and x["period"] == period), None)
    return {"returnPct": num(r["return_pct"]), "sharpe": num(r["sharpe"]), "maxDdPct": num(r["max_dd_pct"])} if r else None


def search_runs(kind, label):
    out = []
    for key, run in TD_RUNS.items():
        k, symbol = key.split("|")
        if k != kind:
            continue
        out.append({
            "id": run["resultId"], "name": run["name"], "symbol": run["symbol"], "label": symbol[:-4], "timeframe": "1D",
            "fromTs": run["fromTs"], "toTs": run["toTs"], "returnPct": num(run["netProfitPct"]), "maxDdPct": num(run["maxDrawdownPct"]),
            "sharpe": num(run["sharpeRatio"]), "trades": run["totalTrades"], "profitFactor": num(run["profitFactor"]),
            "winRatePct": num(run["winRatePct"]), "commission": num(run["commissionPaid"]), "initialCapital": 10000,
            "finalEquity": num(run["finalEquity"]), "ranAt": int(run["createdAt"]),
            "after": td_period(label, symbol), "bhAfter": td_period("Buy and hold", symbol),
            "bhId": TD_RUNS[f"bh|{symbol}"]["resultId"],
        })
    return out


# trader.dev runs from research/btc_paper_edges (BTCUSDT perp, Mar 2020 - Oct 2026)
PAPER_RUNS = {
    "21-23": dict(id="01M41Y4GPYQ05Q5BFMFPBP96MH", name="BTC Seasonality 21-23 UTC", timeframe="1h", returnPct=-54.48, maxDdPct=65.86, sharpe=-0.67, trades=2377, profitFactor=0.91, winRatePct=44.76, commission=19453, finalEquity=4552, ranAt=1791066522335),
    "22-24": dict(id="01M41Y808VYDKDX225QVEBBMJZ", name="BTC Seasonality 22-24 UTC", timeframe="1h", returnPct=-88.03, maxDdPct=88.11, sharpe=-1.95, trades=2378, profitFactor=0.75, winRatePct=42.01, commission=9722, finalEquity=1197, ranAt=1791066636572),
    "maxmin": dict(id="01M41Y8EAPAMD32PCS12Y1N3Q8", name="BTC 10d MAX+MIN", timeframe="1D", returnPct=499.91, maxDdPct=51.88, sharpe=0.94, trades=432, profitFactor=1.24, winRatePct=49.77, commission=17551, finalEquity=59991, ranAt=1791066650966),
    "max": dict(id="01M41Y8ZVSHME7R13GRTCG47B1", name="BTC 10d MAX only", timeframe="1D", returnPct=257.75, maxDdPct=23.61, sharpe=0.91, trades=242, profitFactor=1.41, winRatePct=32.23, commission=5611, finalEquity=35775, ranAt=1791066668921),
    "min": dict(id="01M41Y91YQG9V0MK9Y8XV2YPK7", name="BTC 10d MIN only", timeframe="1D", returnPct=67.07, maxDdPct=46.04, sharpe=0.43, trades=193, profitFactor=1.16, winRatePct=70.98, commission=3323, finalEquity=16707, ranAt=1791066671063),
}
PAPER_AFTER = {r["strategy"]: r for r in rows(PAPER / "traderdev_runs.csv") if r["period"] == "after"}
PAPER_CSV_NAME = {"21-23": "Seasonality 21-23 UTC (1h)", "22-24": "Seasonality 22-24 UTC (1h)", "maxmin": "10d MAX+MIN (1D)", "max": "10d MAX only (1D)", "min": "10d MIN only (1D)"}


def paper_run(key, label):
    after = PAPER_AFTER[PAPER_CSV_NAME[key]]
    bh = PAPER_AFTER["Buy and hold (1D)"]
    return {**PAPER_RUNS[key], "symbol": "BYBIT:BTCUSDT.P", "label": label, "fromTs": 1585180800000, "toTs": 1790985600000, "initialCapital": 10000,
            "after": {"returnPct": num(after["total_return_pct"]), "sharpe": num(after["sharpe"]), "maxDdPct": num(after["max_dd_pct"])},
            "bhAfter": {"returnPct": num(bh["total_return_pct"]), "sharpe": num(bh["sharpe"]), "maxDdPct": num(bh["max_dd_pct"])},
            "bhId": "01M41Y93V9F39HHRD28CHEPK54"}


ZPB = {"label": "Zarattini, Pagani & Barbon (2025), Catching Crypto Trends", "url": "https://papers.ssrn.com/sol3/papers.cfm?abstract_id=5209907"}
PV = {"label": "Padyšák & Vojtko (2022), Seasonality, Trend-following, and Mean reversion in Bitcoin", "url": "https://papers.ssrn.com/sol3/papers.cfm?abstract_id=4081000"}

STRATEGIES = [
    {
        "id": "donchian_ensemble",
        "name": "Donchian Trend Ensemble",
        "verdict": "recommended",
        "summary": "The strongest trend follower after 2022 when a coin trends: BTC +188% (Sharpe 0.94, max drawdown −20%) vs buy and hold +77% (0.49, −67%) on trader.dev. Weaker on choppy coins such as DOGE and ETH.",
        "rules": [
            "Nine breakout systems with lookbacks of 5, 10, 20, 30, 60, 90, 150, 250 and 360 days.",
            "Each system goes long when the daily close beats the highest close of the previous n days.",
            "Each exits on a close below its trailing stop: the higher of the old stop and the channel midpoint (highest + lowest close) / 2.",
            "Hold the coin while at least half of the nine systems are long; otherwise stay in cash. Long only, daily bars.",
        ],
        "notes": "The paper sizes by the share of systems that are long and targets 25% volatility (see the next entry); this app and trader.dev trade all-or-nothing, so this version uses a 50% vote. Before 2022 a 67% vote looked better; after 2022, 34–50% did.",
        "source": ZPB,
        "evidence": search_evidence("Donchian ensemble vote >= 50%"),
        "local": {"strategy": "donchian_ensemble", "params": {"vote": 0.5}, "data": BTC_DATA},
        "pine": "donchian_ensemble",
        "runs": search_runs("ens", "Donchian Trend Ensemble"),
    },
    {
        "id": "nday_high_hold",
        "name": "50-day High Hold",
        "verdict": "recommended",
        "summary": "The most consistent rule: since 2022 it beat buy and hold on risk-adjusted return on most coins in every window tested, with drawdowns of about 20–40% instead of 70–95%. It is in the market only 5–15% of the time, so it earns less than holding in strong bull runs.",
        "rules": [
            "Each day, check whether the close is the highest close of the last 50 days.",
            "If it is, hold the coin for the next day; if not, stay in cash. Long only, daily bars.",
        ],
        "notes": "50 days was the best lookback before 2022; 10–30 days did even better after 2025, so the whole 10–50 range works. It is the trend half of Padyšák & Vojtko's MAX/MIN rule.",
        "source": PV,
        "evidence": search_evidence("50d high hold"),
        "local": {"strategy": "nday_high_low", "params": {"lookback": 50, "buyHigh": True, "buyLow": False}, "data": BTC_DATA},
        "pine": "nday_high_hold",
        "runs": search_runs("high", "50d High Hold"),
    },
    {
        "id": "donchian_vol_target",
        "name": "Donchian Ensemble with 25% volatility target (paper version)",
        "verdict": "mixed",
        "summary": "Best risk-adjusted rule after 2022 (median Sharpe 0.59, drawdowns around −15%) but weak since the paper came out in 2025, and it needs daily position sizing that this app and trader.dev can't do. Best run as a portfolio across many coins.",
        "rules": [
            "Same nine Donchian systems as above.",
            "Position = share of systems long × (25% ÷ the coin's 90-day realised volatility), capped at 100% of capital, rebalanced daily.",
        ],
        "notes": "Research only: tested in research/strategy_search/search.py. Mostly in cash on volatile coins (about 10% invested on average), which is why returns are low and drawdowns small.",
        "source": ZPB,
        "evidence": search_evidence("Donchian ensemble, 25% vol target (paper)"),
        "local": None,
        "pine": None,
        "runs": [],
    },
    {
        "id": "tsmom",
        "name": "Time-series Momentum (30 days)",
        "verdict": "mixed",
        "summary": "Works on BTC and ETH but leaves you with 60–75% drawdowns on altcoins, and the 30-day setting that looked best before 2022 has been flat since April 2025. The slower 60-day version and 'close above the 150-day SMA' held up better after April 2025, but choosing them now would be hindsight.",
        "rules": [
            "Hold the coin while today's close is above the close 30 days ago; otherwise cash. Long only, daily bars.",
        ],
        "notes": "The long/short version (short when momentum is negative) lost money after 2022; see below.",
        "source": {"label": "Moskowitz, Ooi & Pedersen (2012), Time series momentum", "url": "https://doi.org/10.1016/j.jfineco.2011.11.003"},
        "evidence": search_evidence("TSMOM 30d"),
        "local": {"strategy": "tsmom", "params": {"lookback": 30, "shorts": False}, "data": BTC_DATA},
        "pine": None,
        "runs": [],
    },
    {
        "id": "rsi2",
        "name": "RSI(2) Pullback",
        "verdict": "mixed",
        "summary": "Buys sharp dips in an uptrend. Small, positive edge with shallow drawdowns, but it trades so rarely (in the market 3–7% of the time) that returns are close to zero.",
        "rules": [
            "Buy when RSI(2) is below 10 and the close is above the 200-day SMA.",
            "Sell on the first close above the 5-day SMA.",
        ],
        "notes": "From Larry Connors' work on stock indices. The app's RSI(2) Pullback strategy also has a time stop; the library sets it to 60 bars to match the test.",
        "source": {"label": "Connors & Alvarez (2009), Short Term Trading Strategies That Work", "url": "https://www.google.com/search?q=Connors+Alvarez+Short+Term+Trading+Strategies+That+Work"},
        "evidence": search_evidence("RSI(2) < 10 above SMA 200"),
        "local": {"strategy": "rsi2_pullback", "params": {"rsiLen": 2, "entryRsi": 10, "trendLen": 200, "exitLen": 5, "maxBars": 60}, "data": BTC_DATA},
        "pine": None,
        "runs": [],
    },
    {
        "id": "nday_high_low_paper",
        "name": "10-day MAX + MIN (paper version)",
        "verdict": "failed",
        "summary": "The paper's headline rule replicates (Sharpe 1.57 on its own data) but has been worse than buy and hold since: the buy-the-10-day-low half stopped working after publication. Use the high-only version above instead.",
        "rules": [
            "Hold BTC tomorrow if today's close is the highest or the lowest close of the last 10 days.",
        ],
        "notes": "Full write-up in research/btc_paper_edges.",
        "source": PV,
        "evidence": paper_evidence("coinbase_max_min.csv", "10d MAX+MIN", [paper_row("coinbase_max_min.csv", "10d MIN only", "after", "MIN leg alone, after the paper")]),
        "local": {"strategy": "nday_high_low", "params": {"lookback": 10, "buyHigh": True, "buyLow": True}, "data": BTC_DATA},
        "pine": "max_min",
        "runs": [paper_run("maxmin", "BTC · MAX+MIN"), paper_run("max", "BTC · MAX only"), paper_run("min", "BTC · MIN only")],
    },
    {
        "id": "vol_breakout",
        "name": "Volatility Breakout (Larry Williams)",
        "verdict": "failed",
        "summary": "Looked excellent before 2022 (median Sharpe 1.51) and collapsed after (0.11, losing money on most coins). Results swing wildly with the k setting, a classic sign of curve-fitting.",
        "rules": [
            "Each day, buy if price rises k × yesterday's range above today's open (k = 0.5); sell at the day's close.",
        ],
        "notes": "Not in the app: it needs intraday stop entries. Tested in research/strategy_search/search.py.",
        "source": {"label": "Larry Williams, volatility breakout (popular in crypto)", "url": "https://www.quantifiedstrategies.com/larry-williams-volatility-strategy/"},
        "evidence": search_evidence("Vol breakout k=0.5"),
        "local": None,
        "pine": None,
        "runs": [],
    },
    {
        "id": "tsmom_ls",
        "name": "Long/short trend (30-day momentum)",
        "verdict": "failed",
        "summary": "Shorting crypto when the trend turns down lost money after 2022: mean return −13% a year with 80% drawdowns. Stick to long or cash.",
        "rules": [
            "Long while the close is above the close 30 days ago, short while it is below.",
        ],
        "notes": "In the app: Time-series Momentum with 'Go short' ticked and 'Allow short selling' on.",
        "source": {"label": "Moskowitz, Ooi & Pedersen (2012), Time series momentum", "url": "https://doi.org/10.1016/j.jfineco.2011.11.003"},
        "evidence": search_evidence("TSMOM 30d L/S"),
        "local": None,
        "pine": None,
        "runs": [],
    },
    {
        "id": "hour_window",
        "name": "Bitcoin 21:00–23:00 UTC seasonality",
        "verdict": "failed",
        "summary": "Real but tiny: about 5 basis points per trade since 2022, half the cost of a round trip. Loses money after fees (−58% on trader.dev since 2022).",
        "rules": [
            "Buy BTC at 21:00 UTC, sell at 23:00 UTC, every day.",
        ],
        "notes": "Full write-up in research/btc_paper_edges.",
        "source": PV,
        "evidence": paper_evidence("coinbase_seasonality.csv", "Seasonality 21-23 UTC"),
        "local": {"strategy": "hour_window", "params": {"startHour": 21, "hours": 2}, "data": {"source": "yahoo", "symbol": "BTC-USD", "interval": "1h", "range": "2y"}},
        "pine": "seasonality",
        "runs": [paper_run("21-23", "BTC · 21–23 UTC"), paper_run("22-24", "BTC · 22–24 UTC")],
    },
]


def main():
    library = {
        "updated": "2026-10-03",
        "method": [
            "Rules come from published papers or well-known systems; none were invented here.",
            "Each rule's setting was picked on data before 2022 (BTC, ETH, LTC, BCH, LINK), then judged on 2022 → Oct 2026 on nine coins it had never seen (adding SOL, ADA, DOGE, AVAX), and on April 2025 onward.",
            "Local tests: Coinbase daily prices, 0.07% cost per side. trader.dev checks: Bybit perpetuals, 0.05% per side, 100% of equity, no funding costs.",
            "Numbers are medians across coins, so one lucky coin can't carry a rule. Past results don't guarantee future ones; the coins tested are survivors.",
        ],
        "strategies": STRATEGIES,
    }
    out = RESEARCH / "library.json"
    out.write_text(json.dumps(library, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote research/library.json ({len(STRATEGIES)} strategies)")


if __name__ == "__main__":
    main()
