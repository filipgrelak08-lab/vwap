# VWAP pullback check

The VWAP pullback strategy for BTC exists in three places with the same rules and settings:

| Where | Use it for |
|---|---|
| TradingView, `pine/vwap_trend_pullback.pine` | Charts, alerts, TradingView's Strategy Tester |
| VWAP Lab, `strategies/vwap_pullback_btc.js` | Charts, trade list, parameter sweeps with an out-of-sample split |
| `check.py` in this folder | One command, month-by-month results from Binance or a TradingView export |

VWAP restarts at 00:00 UTC. All times are UTC. Fees default to 0.055% per side (Bybit perpetual taker).

```bash
python3 check.py                                   # 90 days of 5-minute BTCUSDT from Binance
python3 check.py --days 365                        # more history
python3 check.py --atr 1 --r 1 --max-stop 2        # change any input; python3 check.py --help lists them
python3 check.py --sweep                           # ATR 1-20 x R 0.75-2.5, month by month
python3 check.py --csv btc_5m.csv                  # a TradingView export instead of Binance
```

Optional filters: `--window 1345-1530` (enter only between UTC times), `--flat 2355` (close open trades at
a UTC time), `--max-trades 2`. Results are in R after fees, and in dollars for `--risk` dollars risked per trade.
