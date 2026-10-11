# VWAP pullback check

`check.py` replays the rules of `pine/vwap_trend_pullback.pine` in Python on Yahoo's last 60 days of
5-minute NQ=F (same prices as MNQ), or on a 5-minute TradingView export of any length, and reports
dollars per 1 MNQ contract after commission ($0.62 a side) and 1 tick of slippage a side, by month.

```bash
python3 check.py                                  # default settings (ATR 14, 2R, close at 15:55)
python3 check.py --atr 1 --r 1 --flat 1200        # other settings
python3 check.py --atr 1 --r 1 --flat 1200 --trades   # list every trade
python3 check.py --sweep --flat 1200              # ATR 1-20 x R 0.75-2.5, month by month
python3 check.py --csv my_mnq_5m.csv --sweep      # a TradingView export instead of Yahoo
```

No packages needed, Python 3.8+. On the TradingView window of 14 Sep - 9 Oct 2026, ATR 1 / 1R /
close at 12:00 gives +$1,330 per contract here; TradingView showed $3,951 on 3 contracts ($1,317 each).
