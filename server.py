#!/usr/bin/env python3
"""
VWAP Lab: local backtesting server.

    python3 server.py            # then open http://localhost:8000

Serves the web app in ./web, stores strategies as .js files in ./strategies,
lists CSV files you drop into ./data, and proxies market data from Yahoo
Finance and Binance (browsers can't call those APIs directly). With a
trader.dev API key it also runs Pine scripts from ./pine on trader.dev.

Standard library only. Python 3.8+.
"""
import argparse
import gzip
import json
import os
import re
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from datetime import datetime
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

VERSION = "1.0.0"
ROOT = Path(__file__).resolve().parent
WEB_DIR = ROOT / "web"
STRATEGY_DIR = ROOT / "strategies"
DATA_DIR = ROOT / "data"
PINE_DIR = ROOT / "pine"
TRADERDEV_KEY_FILE = ROOT / ".traderdev-key"

ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
FILE_RE = re.compile(r"^[A-Za-z0-9_. -]{1,128}\.(csv|txt)$", re.IGNORECASE)
SYMBOL_RE = re.compile(r"^[A-Za-z0-9.^=_-]{1,32}$")
MAX_STRATEGY_BYTES = 512 * 1024
# Yahoo answers a bare "Mozilla/5.0" but rate-limits (429) full browser strings and python-urllib.
USER_AGENT = "Mozilla/5.0"

YAHOO_INTERVALS = {"1m", "2m", "5m", "15m", "30m", "60m", "90m", "1h", "1d", "5d", "1wk", "1mo", "3mo"}
YAHOO_DAILY = {"1d", "5d", "1wk", "1mo", "3mo"}
YAHOO_RANGES = {"1d", "5d", "1mo", "3mo", "6mo", "1y", "2y", "5y", "10y", "ytd", "max"}
BINANCE_INTERVALS = {"1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "8h", "12h", "1d", "3d", "1w"}
BINANCE_HOSTS = ("https://data-api.binance.vision", "https://api.binance.com")

TRADERDEV_MCP = "https://mcp.trader.dev/mcp"
TRADERDEV_RESULTS = "https://pub-5880a55c41fd4cd1a11146f4fd522fbe.r2.dev/backtests/{}.json.gz"
TRADERDEV_REPORT = "https://mcp-api.trader.dev/backtest/{}"
TRADERDEV_KEY_RE = re.compile(r"^pk_[A-Za-z0-9_-]{8,200}$")
TRADERDEV_ID_RE = re.compile(r"^[0-9A-Za-z]{10,40}$")
TRADERDEV_SYMBOL_RE = re.compile(r"^[A-Za-z0-9:._-]{1,40}$")
TRADERDEV_TF_RE = re.compile(r"^[0-9]{0,4}[mhdwDWM]?$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
MAX_PINE_BYTES = 200 * 1024
TRADE_FIELDS = ("seq", "direction", "entryTime", "entryPrice", "exitTime", "exitPrice", "qty", "profit", "profitPct", "commission", "barsInTrade", "isOpen")


class ApiError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


# --------------------------------------------------------------------------- HTTP client


def http_json(url, timeout=20):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        try:
            return json.loads(body)  # APIs put the useful message in the JSON body
        except ValueError:
            if e.code == 429:
                raise ApiError("The data provider is rate-limiting requests. Wait a minute and try again.", 429)
            raise ApiError(f"Data provider returned HTTP {e.code}.", 502)
    except urllib.error.URLError as e:
        reason = str(getattr(e, "reason", e))
        if "CERTIFICATE_VERIFY_FAILED" in reason:
            raise ApiError(
                "Python could not verify the data provider's SSL certificate. On macOS, run "
                "'Install Certificates.command' from your Python folder in Applications, then restart the server.",
                502,
            )
        raise ApiError(f"Could not reach the data provider: {reason}", 502)
    except (TimeoutError, OSError) as e:
        raise ApiError(f"Network error while fetching data: {e}", 502)


# --------------------------------------------------------------------------- market data


def _local_offset_fn(tz_name, fallback_offset):
    """Return f(unix_ts) -> UTC offset in seconds for the exchange timezone (DST aware)."""
    try:
        from zoneinfo import ZoneInfo  # Python 3.9+; needs the tzdata package on Windows

        tz = ZoneInfo(tz_name)
        return lambda ts: int(datetime.fromtimestamp(ts, tz).utcoffset().total_seconds())
    except Exception:
        return lambda ts: fallback_offset


def fetch_yahoo(symbol, interval, rng, adjusted):
    if not SYMBOL_RE.match(symbol):
        raise ApiError("That doesn't look like a ticker symbol.")
    if interval not in YAHOO_INTERVALS:
        raise ApiError(f"Unsupported interval {interval}.")
    if rng not in YAHOO_RANGES:
        raise ApiError(f"Unsupported range {rng}.")
    yi = "60m" if interval == "1h" else interval
    params = {"interval": yi, "range": rng, "includePrePost": "false", "events": "div,splits"}
    if rng == "max" and interval in YAHOO_DAILY:
        # range=max comes back as monthly bars; an explicit window keeps the requested interval
        del params["range"]
        params.update(period1=0, period2=int(time.time()))
    query = urllib.parse.urlencode(params)
    data = None
    for host in ("query1", "query2"):
        url = f"https://{host}.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(symbol)}?{query}"
        try:
            data = http_json(url)
            break
        except ApiError as e:
            if e.status != 429 or host == "query2":
                raise
    chart = (data or {}).get("chart") or {}
    if chart.get("error"):
        err = chart["error"]
        msg = err.get("description") or err.get("code") or "Yahoo returned an error."
        raise ApiError(f"Yahoo: {msg}", 404 if err.get("code") == "Not Found" else 400)
    results = chart.get("result") or []
    if not results:
        raise ApiError(f"Yahoo returned no data for {symbol}.", 404)
    res = results[0]
    meta = res.get("meta") or {}
    # For ranges longer than its intraday limits, Yahoo can silently answer with coarser
    # bars (e.g. monthly for 15m + max). Refuse that instead of mislabelling the data.
    got = meta.get("dataGranularity")
    if got and got != yi and not (yi == "60m" and got == "1h"):
        hint = (
            "Pick a shorter range, such as 10 years."
            if interval in YAHOO_DAILY
            else "Intraday history is limited: 1m covers 7 days, 2m-30m cover 60 days, 1h covers 2 years. "
            "Pick a shorter range or a daily interval."
        )
        raise ApiError(f"Yahoo has no {interval} data for range '{rng}' (it sent {got} bars instead). {hint}", 400)
    stamps = res.get("timestamp") or []
    quote = ((res.get("indicators") or {}).get("quote") or [{}])[0]
    adj = (((res.get("indicators") or {}).get("adjclose") or [{}])[0] or {}).get("adjclose")
    offset_of = _local_offset_fn(meta.get("exchangeTimezoneName") or "UTC", int(meta.get("gmtoffset") or 0))
    daily = interval in YAHOO_DAILY
    cols = [quote.get(k) or [] for k in ("open", "high", "low", "close", "volume")]
    bars = []
    for i, ts in enumerate(stamps):
        try:
            o, h, l, c, v = (col[i] for col in cols)
        except IndexError:
            continue
        if None in (o, h, l, c) or c <= 0:
            continue
        if adjusted and adj and i < len(adj) and adj[i]:
            r = adj[i] / c
            o, h, l, c = o * r, h * r, l * r, adj[i]
        local = ts + offset_of(ts)  # exchange wall-clock time, stored as UTC
        if daily:
            local -= local % 86400
        bars.append([local, o, h, l, c, v or 0])
    if not bars:
        raise ApiError(f"Yahoo returned no bars for {symbol} with interval {interval} and range {rng}.", 404)
    return {
        "symbol": meta.get("symbol") or symbol,
        "name": meta.get("longName") or meta.get("shortName") or symbol,
        "currency": meta.get("currency"),
        "timezone": meta.get("exchangeTimezoneName"),
        "bars": bars,
    }


def fetch_binance(symbol, interval, count):
    if not re.match(r"^[A-Z0-9]{3,20}$", symbol):
        raise ApiError("Use a Binance pair like BTCUSDT.")
    if interval not in BINANCE_INTERVALS:
        raise ApiError(f"Unsupported interval {interval}.")
    count = max(50, min(int(count), 20000))
    last_error = None
    for host in BINANCE_HOSTS:
        rows = []
        end = None
        try:
            while len(rows) < count:
                limit = min(1000, count - len(rows))
                params = {"symbol": symbol, "interval": interval, "limit": limit}
                if end is not None:
                    params["endTime"] = end
                page = http_json(f"{host}/api/v3/klines?{urllib.parse.urlencode(params)}")
                if isinstance(page, dict):
                    raise ApiError(f"Binance: {page.get('msg') or 'request failed'}", 400)
                if not page:
                    break
                rows = page + rows
                end = page[0][0] - 1
                if len(page) < limit:
                    break
        except ApiError as e:
            last_error = e
            if e.status == 400:
                raise
            continue
        bars = [[r[0] // 1000, float(r[1]), float(r[2]), float(r[3]), float(r[4]), float(r[5])] for r in rows[-count:]]
        return {"symbol": symbol, "bars": bars}
    raise last_error or ApiError("Could not reach Binance.", 502)


# --------------------------------------------------------------------------- trader.dev
# trader.dev is an MCP server (JSON-RPC over HTTP). An API key works as a bearer token.

_td_lock = threading.Lock()
_td_sessions = {}  # api key -> MCP session id


class _SessionExpired(Exception):
    pass


def traderdev_key():
    """(key, where it came from). The TRADERDEV_API_KEY environment variable wins over the key file."""
    env = os.environ.get("TRADERDEV_API_KEY", "").strip()
    if env:
        return env, "env"
    try:
        key = TRADERDEV_KEY_FILE.read_text(encoding="utf-8").strip()
    except OSError:
        key = ""
    return (key, "file") if key else (None, None)


def _mcp_post(key, payload, session=None, timeout=120):
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "Authorization": f"Bearer {key}",
        "MCP-Protocol-Version": "2025-06-18",
        "User-Agent": f"VWAPLab/{VERSION}",  # trader.dev's firewall blocks python-urllib
    }
    if session:
        headers["Mcp-Session-Id"] = session
    req = urllib.request.Request(TRADERDEV_MCP, data=json.dumps(payload).encode("utf-8"), headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            sid = resp.headers.get("Mcp-Session-Id")
            body = resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        if session and e.code in (400, 404):
            raise _SessionExpired()
        if e.code in (401, 403):
            raise ApiError("trader.dev refused the request. Check your API key.", 401)
        raise ApiError(f"trader.dev returned HTTP {e.code}.", 502)
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise ApiError(f"Could not reach trader.dev: {getattr(e, 'reason', e)}", 502)
    if "id" not in payload:  # a notification: nothing comes back
        return sid, None
    # answers arrive as JSON or as server-sent events ("data: {...}" lines)
    chunks = [line[5:].strip() for line in body.splitlines() if line.startswith("data:")] or [body]
    for chunk in chunks:
        try:
            msg = json.loads(chunk)
        except ValueError:
            continue
        if isinstance(msg, dict) and msg.get("id") == payload["id"]:
            return sid, msg
    raise ApiError("trader.dev sent an answer the server could not read.", 502)


def _mcp_session(key):
    with _td_lock:
        sid = _td_sessions.get(key)
    if sid:
        return sid
    init = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "vwap-lab", "version": VERSION}},
    }
    sid, _ = _mcp_post(key, init)
    if not sid:
        raise ApiError("trader.dev did not start a session.", 502)
    _mcp_post(key, {"jsonrpc": "2.0", "method": "notifications/initialized"}, sid)
    with _td_lock:
        _td_sessions[key] = sid
    return sid


def traderdev_call(tool, args=None, key=None):
    """Call a trader.dev tool and return the JSON it answers with."""
    key = key or traderdev_key()[0]
    if not key:
        raise ApiError("Connect trader.dev first: paste your API key in the trader.dev tab.", 401)
    call = {"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": tool, "arguments": args or {}}}
    for _ in range(2):
        try:
            _, msg = _mcp_post(key, call, _mcp_session(key))
            break
        except _SessionExpired:
            with _td_lock:
                _td_sessions.pop(key, None)
    else:
        raise ApiError("Could not start a trader.dev session.", 502)
    if msg.get("error"):
        raise ApiError(f"trader.dev: {msg['error'].get('message') or 'request failed'}", 502)
    result = msg.get("result") or {}
    texts = [c.get("text", "") for c in result.get("content") or [] if c.get("type") == "text"]
    if result.get("isError"):
        text = (texts[0] if texts else "request failed").strip()
        raise ApiError(f"trader.dev: {text[:600]}", 401 if "API key" in text else 400)
    for text in texts:  # tips and notes come as plain text; the payload is the JSON item
        try:
            return json.loads(text)
        except ValueError:
            continue
    return {"text": "\n".join(texts)}


def traderdev_status():
    key, source = traderdev_key()
    if not key:
        return {"connected": False}
    try:
        user = traderdev_call("whoami", key=key)
        credits = traderdev_call("get_credits", key=key)
    except ApiError as e:
        if e.status != 401:
            raise
        return {"connected": False, "source": source, "error": str(e)}
    return {
        "connected": True,
        "source": source,
        "email": user.get("email"),
        "tier": user.get("displayTier") or user.get("tier"),
        "credits": credits.get("balance"),
    }


def save_traderdev_key(key):
    key = (key or "").strip() if isinstance(key, str) else ""
    if not TRADERDEV_KEY_RE.match(key):
        raise ApiError("That doesn't look like a trader.dev API key (they start with pk_).")
    if os.environ.get("TRADERDEV_API_KEY", "").strip():
        raise ApiError("TRADERDEV_API_KEY is set where the server was started, and it takes precedence. Unset it to use a saved key.")
    traderdev_call("whoami", key=key)  # raises if trader.dev rejects it
    fd = os.open(TRADERDEV_KEY_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(key + "\n")


def forget_traderdev_key():
    if TRADERDEV_KEY_FILE.exists():
        TRADERDEV_KEY_FILE.unlink()
    with _td_lock:
        _td_sessions.clear()


def traderdev_backtest(body):
    pine = body.get("pineSource")
    if not isinstance(pine, str) or not pine.strip():
        raise ApiError("Paste a Pine script first.")
    if len(pine.encode("utf-8")) > MAX_PINE_BYTES:
        raise ApiError("Pine script is too large.")
    symbol = str(body.get("symbol") or "").strip()
    timeframe = str(body.get("timeframe") or "").strip()
    if not TRADERDEV_SYMBOL_RE.match(symbol):
        raise ApiError("Enter a symbol such as BTCUSDT or EURUSD.")
    if not timeframe or not TRADERDEV_TF_RE.match(timeframe):
        raise ApiError("Enter a timeframe such as 15m, 1h or 1D.")
    args = {"pineSource": pine, "symbol": symbol, "timeframe": timeframe}
    for field in ("from", "to"):
        value = str(body.get(field) or "").strip()
        if value:
            if not DATE_RE.match(value):
                raise ApiError(f"'{field}' must be a date like 2024-01-31.")
            args[field] = value
    name = str(body.get("name") or "").strip()
    if name:
        args["name"] = name[:255]
    if body.get("strategyId"):
        args["strategyId"] = str(body["strategyId"])[:64]
    out = traderdev_call("quick_backtest", args)
    if not isinstance(out, dict) or "resultId" not in out:
        raise ApiError(f"trader.dev: {(out or {}).get('text') or 'no result came back'}"[:600], 502)
    return out


def traderdev_result(result_id):
    """Trades and equity curve of a finished trader.dev backtest (public files, no key needed)."""
    if not TRADERDEV_ID_RE.match(result_id):
        raise ApiError("That doesn't look like a trader.dev result ID.")
    req = urllib.request.Request(TRADERDEV_RESULTS.format(result_id), headers={"User-Agent": f"VWAPLab/{VERSION}"})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read()
    except urllib.error.HTTPError as e:
        raise ApiError("No trader.dev result with that ID." if e.code in (403, 404) else f"trader.dev returned HTTP {e.code}.", 404 if e.code in (403, 404) else 502)
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise ApiError(f"Could not reach trader.dev: {getattr(e, 'reason', e)}", 502)
    try:
        blob = json.loads(gzip.decompress(raw) if raw[:2] == b"\x1f\x8b" else raw)
    except (OSError, ValueError):
        raise ApiError("trader.dev sent a result file the server could not read.", 502)
    trades = [{k: t.get(k) for k in TRADE_FIELDS} for t in blob.get("trades") or []]
    equity = [[p.get("barTime"), p.get("equity"), p.get("netProfit")] for p in blob.get("equity") or []]
    return {"id": result_id, "reportUrl": TRADERDEV_REPORT.format(result_id), "trades": trades, "equity": equity}


def list_pine():
    if not PINE_DIR.exists():
        return []
    return [{"id": p.stem, "code": p.read_text(encoding="utf-8")} for p in sorted(PINE_DIR.glob("*.pine")) if ID_RE.match(p.stem)]


# --------------------------------------------------------------------------- strategies & datasets


def list_strategies():
    out = []
    for p in sorted(STRATEGY_DIR.glob("*.js")):
        if ID_RE.match(p.stem):
            out.append({"id": p.stem, "code": p.read_text(encoding="utf-8")})
    return out


def save_strategy(sid, code):
    if not ID_RE.match(sid):
        raise ApiError("Strategy names may only use letters, numbers, _ and -.")
    if not isinstance(code, str) or not code.strip():
        raise ApiError("Strategy code is empty.")
    if len(code.encode("utf-8")) > MAX_STRATEGY_BYTES:
        raise ApiError("Strategy file is too large.")
    STRATEGY_DIR.mkdir(exist_ok=True)
    target = STRATEGY_DIR / f"{sid}.js"
    fd, tmp = tempfile.mkstemp(dir=STRATEGY_DIR, prefix=".tmp-", suffix=".js")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(code)
        os.replace(tmp, target)
    except Exception:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def delete_strategy(sid):
    if not ID_RE.match(sid):
        raise ApiError("Invalid strategy name.")
    target = STRATEGY_DIR / f"{sid}.js"
    if not target.exists():
        raise ApiError("Strategy not found.", 404)
    target.unlink()


def list_datasets():
    if not DATA_DIR.exists():
        return []
    return sorted(p.name for p in DATA_DIR.iterdir() if p.is_file() and FILE_RE.match(p.name))


# --------------------------------------------------------------------------- request handler


class Handler(SimpleHTTPRequestHandler):
    server_version = f"VWAPLab/{VERSION}"
    extensions_map = dict(SimpleHTTPRequestHandler.extensions_map, **{".js": "text/javascript", ".mjs": "text/javascript"})

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB_DIR), **kwargs)

    def log_message(self, fmt, *args):
        if getattr(self.server, "verbose", False):
            super().log_message(fmt, *args)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    # Only answer requests addressed to this machine (blocks DNS-rebinding tricks).
    def _host_ok(self):
        if getattr(self.server, "allow_any_host", False):
            return True
        host = (self.headers.get("Host") or "").strip().lower()
        host = host[1:].split("]")[0] if host.startswith("[") else host.split(":")[0]
        return host in ("localhost", "127.0.0.1", "::1")

    def _send_json(self, payload, status=200):
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _guard(self):
        if not self._host_ok():
            self._send_json({"error": "Requests must be addressed to localhost."}, 403)
            return False
        return True

    def _route(self, method):
        if not self._guard():
            return
        url = urllib.parse.urlsplit(self.path)
        parts = [urllib.parse.unquote(p) for p in url.path.split("/") if p]
        if not parts or parts[0] != "api":
            if method == "GET":
                return super().do_GET()
            if method == "HEAD":
                return super().do_HEAD()
            return self._send_json({"error": "Not found"}, 404)
        query = dict(urllib.parse.parse_qsl(url.query))
        try:
            self._api(method, parts[1:], query)
        except ApiError as e:
            self._send_json({"error": str(e)}, e.status)
        except Exception as e:  # keep the server alive and tell the UI what happened
            self._send_json({"error": f"Server error: {e}"}, 500)

    def _read_json(self):
        ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        if ctype != "application/json":
            raise ApiError("Expected a JSON request body.", 415)
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_STRATEGY_BYTES * 2:
            raise ApiError("Request body is missing or too large.", 413)
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except ValueError:
            raise ApiError("Request body is not valid JSON.")

    def _api(self, method, parts, query):
        route = parts[0] if parts else ""
        if method == "GET" and route == "health":
            return self._send_json({"ok": True, "version": VERSION})

        if route == "strategies":
            if method == "GET" and len(parts) == 1:
                return self._send_json({"strategies": list_strategies()})
            if len(parts) == 2 and method == "PUT":
                body = self._read_json()
                save_strategy(parts[1], body.get("code"))
                return self._send_json({"ok": True, "id": parts[1]})
            if len(parts) == 2 and method == "DELETE":
                delete_strategy(parts[1])
                return self._send_json({"ok": True})

        if route == "datasets" and method == "GET":
            if len(parts) == 1:
                return self._send_json({"files": list_datasets()})
            if len(parts) == 2 and FILE_RE.match(parts[1]) and parts[1] in list_datasets():
                body = (DATA_DIR / parts[1]).read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", "text/csv; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            raise ApiError("File not found in data/.", 404)

        if route == "yahoo" and method == "GET":
            symbol = (query.get("symbol") or "").strip().upper()
            return self._send_json(
                fetch_yahoo(symbol, query.get("interval", "1d"), query.get("range", "5y"), query.get("adjusted", "1") == "1")
            )

        if route == "binance" and method == "GET":
            symbol = (query.get("symbol") or "").strip().upper()
            try:
                count = int(query.get("bars", "5000"))
            except ValueError:
                raise ApiError("bars must be a number.")
            return self._send_json(fetch_binance(symbol, query.get("interval", "1h"), count))

        if route == "pine" and method == "GET" and len(parts) == 1:
            return self._send_json({"scripts": list_pine()})

        if route == "traderdev":
            sub = parts[1] if len(parts) > 1 else ""
            if method == "GET" and sub == "status":
                return self._send_json(traderdev_status())
            if sub == "key" and method == "PUT":
                save_traderdev_key(self._read_json().get("key"))
                return self._send_json(traderdev_status())
            if sub == "key" and method == "DELETE":
                forget_traderdev_key()
                return self._send_json(traderdev_status())
            if sub == "backtest" and method == "POST":
                return self._send_json(traderdev_backtest(self._read_json()))
            if sub == "results" and method == "GET" and len(parts) == 3:
                return self._send_json(traderdev_result(parts[2]))

        raise ApiError("Not found", 404)

    def do_GET(self):
        self._route("GET")

    def do_HEAD(self):
        self._route("HEAD")

    def do_PUT(self):
        self._route("PUT")

    def do_DELETE(self):
        self._route("DELETE")

    def do_POST(self):
        self._route("POST")


# --------------------------------------------------------------------------- main


def main(argv=None):
    ap = argparse.ArgumentParser(description="VWAP Lab: run the backtester on localhost.")
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", 8000)), help="port to listen on (default 8000)")
    ap.add_argument("--host", default="127.0.0.1", help="interface to bind (default 127.0.0.1, this computer only)")
    ap.add_argument("--no-browser", action="store_true", help="don't open a browser tab")
    ap.add_argument("--verbose", action="store_true", help="log every request")
    args = ap.parse_args(argv)

    STRATEGY_DIR.mkdir(exist_ok=True)
    DATA_DIR.mkdir(exist_ok=True)

    httpd = None
    port = args.port
    for candidate in range(args.port, args.port + 10):
        try:
            httpd = ThreadingHTTPServer((args.host, candidate), Handler)
            port = candidate
            break
        except OSError:
            continue
    if httpd is None:
        print(f"Ports {args.port}-{args.port + 9} are all busy. Try --port 9000.", file=sys.stderr)
        return 1
    httpd.daemon_threads = True
    httpd.verbose = args.verbose
    httpd.allow_any_host = args.host not in ("127.0.0.1", "localhost", "::1")

    shown_host = "localhost" if args.host in ("127.0.0.1", "0.0.0.0", "::", "::1") else args.host
    url = f"http://{shown_host}:{port}/"
    print(f"\n  VWAP Lab is running at {url}")
    print(f"  Strategies: {STRATEGY_DIR}")
    print(f"  CSV data:   {DATA_DIR}")
    if httpd.allow_any_host:
        print("  Warning: listening beyond this computer. Anyone who can reach this port can edit strategy files.")
    print("  Press Ctrl+C to stop.\n")
    if not args.no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n  Stopped.")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
