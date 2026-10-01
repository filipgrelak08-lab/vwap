# data/

Drop CSV files here and pick them under **Market data → CSV** while `server.py` is running.

Expected columns (header names are case-insensitive, order doesn't matter):

| Column | Also accepted as |
|---|---|
| Date | Datetime, Timestamp, Time, Open time (or separate Date + Time columns) |
| Open, High, Low | O, H, L (optional: Close is used if missing) |
| Close | Price, Last, Close/Last, C |
| Adj Close | Adjusted close: if present, prices are adjusted for dividends and splits |
| Volume | Vol, V (optional) |

Dates can be ISO (`2024-03-01 09:30`), US (`03/01/2024`), European (`01.03.2024`) or UNIX seconds/milliseconds. Timestamps are read as exchange local time; timezone suffixes are ignored.
