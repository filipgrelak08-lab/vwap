# VWAP pullback check

The VWAP pullback strategy from `pine/vwap_trend_pullback.pine` exists in three places with the same
rules and settings, so results can be cross-checked:

| Where | Use it for |
|---|---|
| TradingView, `pine/vwap_trend_pullback.pine` | Charts, alerts, TradingView's Strategy Tester |
| VWAP Lab, `strategies/vwap_pullback_mnq.js` | Charts, trade list, parameter sweeps with an out-of-sample split |
| `check.py` in this folder | One command, month-by-month results, any TradingView export |

On 3 Aug – 12 Oct 2026 of Yahoo's 5-minute NQ=F, VWAP Lab and `check.py` take the same trades (36 of
36 with the defaults, 54 of 54 with ATR 1 / 1R / max stop 2). VWAP Lab also lists a trade still open
when the data ends; `check.py` leaves it out.

## check.py

Plain Python 3.8+, no packages. Every TradingView input is an option with the same default:

```bash
python3 check.py                                   # defaults: ATR 14, 2R, stop cap 1.5 ATR, close 15:55
python3 check.py --atr 1 --r 1 --max-stop 2        # change any input; python3 check.py --help lists them
python3 check.py --atr 1 --r 1 --max-stop 2 --trades   # list every trade
python3 check.py --sweep --max-stop 2              # ATR 1-20 x R 0.75-2.5 with the other settings fixed
python3 check.py --csv my_mnq_5m.csv --sweep       # a TradingView export instead of Yahoo (any length)
```

Options: `--no-longs`, `--no-shorts`, `--slope`, `--fast`, `--slow`, `--touch`, `--ext`, `--buffer`,
`--atr`, `--max-stop`, `--r`, `--contracts`, `--start`, `--until`, `--flat` (or `--no-flat`) and
`--max-trades`. Results are dollars after $0.62 commission and 1 tick of slippage per contract per side,
plus total R (the result in units of each trade's own risk, which doesn't depend on size).

## VWAP Lab

Run `python3 server.py` from the repo root, then in the browser:

1. Market data: Yahoo, symbol `NQ=F` (or `MNQ=F`), interval 5 minutes, range 1 month (Yahoo keeps 60 days).
2. Strategy: **VWAP Pullback (MNQ)**. Its settings match the TradingView inputs.
3. Execution: commission 0.001% and slippage 0.001% per side (about $0.62 and 1 tick per MNQ contract).
   Position size is ignored: each trade is the "Contracts" setting.
4. Optimize: sweep ATR length × take profit, with "Optimize on first 70%" to see how the best settings
   did on the part they weren't picked on.
