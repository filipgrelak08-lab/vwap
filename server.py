#!/usr/bin/env python3
"""
Backtesting Tool: local server for the Trader.dev backtester.

    export TRADERDEV_API_KEY=pk_...
    python3 server.py            # then open http://localhost:8000

Serves the web app in ./web, stores strategies as .js files in ./strategies,
and forwards backtests to Trader.dev, which runs every backtest.

The browser never sees the API key: it calls this server, and this server
calls Trader.dev with the key from the environment.

Standard library only. Python 3.8+.
"""
import argparse
import json
import os
import re
import sys
import tempfile
import threading
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

VERSION = "2.0.0"
ROOT = Path(__file__).resolve().parent
WEB_DIR = ROOT / "web"
STRATEGY_DIR = ROOT / "strategies"

ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
MAX_STRATEGY_BYTES = 512 * 1024

# Trader.dev speaks MCP over HTTP at the address its sign-in page gives MCP
# clients. (mcp-api.trader.dev is its website and REST API: it has no /mcp
# route.) TRADERDEV_MCP_URL overrides the default if the service moves.
DEFAULT_TRADERDEV_URL = "https://mcp.trader.dev/mcp"
TRADERDEV_URL = (os.environ.get("TRADERDEV_MCP_URL") or "").strip() or DEFAULT_TRADERDEV_URL
TRADERDEV_KEY_VARS = ("TRADERDEV_API_KEY", "TRADER_DEV_API_KEY")

# Only these Trader.dev tools can be reached from the browser.
ALLOWED_TOOLS = {
    "whoami": 30,
    "get_credits": 30,
    "get_pine_codegen_rules": 30,
    "plan_backtest_window": 60,
    "quick_backtest": 180,
    "get_backtest_result": 120,
    "get_trades": 60,
    "get_equity_curve": 60,
    "list_strategies": 60,
    "get_strategy": 60,
    "optimize_strategy": 900,
}

PROTOCOL_VERSION = "2025-06-18"


class ApiError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def traderdev_key():
    for var in TRADERDEV_KEY_VARS:
        key = (os.environ.get(var) or "").strip()
        if key:
            return key
    return ""


# --------------------------------------------------------------------------- Trader.dev (MCP over HTTP)


class TraderDev:
    """Minimal MCP streamable-HTTP client: initialize once, then call tools.

    Not a general MCP implementation — just enough to call the handful of
    Trader.dev tools the app needs, with one session reused across requests.
    """

    def __init__(self, url, key):
        self.url = url
        self.key = key
        self.session_id = None
        self._next_id = 0
        self._lock = threading.Lock()

    # ---- transport

    def _headers(self):
        h = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "MCP-Protocol-Version": PROTOCOL_VERSION,
            # Trader.dev's firewall turns away Python's default user agent.
            "User-Agent": f"BacktestingTool/{VERSION}",
        }
        if self.session_id:
            h["Mcp-Session-Id"] = self.session_id
        return h

    def _send(self, payload, timeout):
        body = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(self.url, data=body, headers=self._headers(), method="POST")
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                sid = resp.headers.get("Mcp-Session-Id")
                if sid:
                    self.session_id = sid
                raw = resp.read().decode("utf-8", "replace")
                ctype = (resp.headers.get("Content-Type") or "").lower()
                return resp.status, ctype, raw
        except urllib.error.HTTPError as e:
            raw = e.read().decode("utf-8", "replace")
            return e.code, (e.headers.get("Content-Type") or "").lower(), raw
        except urllib.error.URLError as e:
            reason = str(getattr(e, "reason", e))
            if "CERTIFICATE_VERIFY_FAILED" in reason:
                raise ApiError(
                    "Python could not verify Trader.dev's SSL certificate. On macOS, run "
                    "'Install Certificates.command' from your Python folder in Applications, then restart the server.",
                    502,
                )
            raise ApiError(f"Could not reach Trader.dev at {self.url}: {reason}", 502)
        except (TimeoutError, OSError) as e:
            raise ApiError(f"Trader.dev did not answer in time: {e}", 504)

    @staticmethod
    def _parse(status, ctype, raw):
        """A JSON-RPC response, whether it arrived as JSON or as one SSE event."""
        if "text/event-stream" in ctype:
            chunks = []
            for line in raw.splitlines():
                if line.startswith("data:"):
                    chunks.append(line[5:].strip())
            raw = "\n".join(chunks)
        if not raw.strip():
            return None
        try:
            return json.loads(raw)
        except ValueError:
            snippet = raw.strip()[:200]
            raise ApiError(f"Trader.dev sent a reply this app could not read (HTTP {status}): {snippet}", 502)

    def _rpc(self, method, params, timeout):
        self._next_id += 1
        payload = {"jsonrpc": "2.0", "id": self._next_id, "method": method, "params": params or {}}
        status, ctype, raw = self._send(payload, timeout)
        if status in (401, 403, 404) or status >= 500:
            self._raise_for_http(status, raw)
        body = self._parse(status, ctype, raw)
        if status >= 400:
            msg = ""
            if isinstance(body, dict):
                msg = (body.get("error") or {}).get("message") if isinstance(body.get("error"), dict) else body.get("message")
            raise ApiError(msg or f"Trader.dev returned HTTP {status}.", 502)
        if not isinstance(body, dict):
            raise ApiError("Trader.dev sent an empty reply.", 502)
        if body.get("error"):
            err = body["error"]
            msg = err.get("message") if isinstance(err, dict) else str(err)
            raise ApiError(f"Trader.dev: {msg}", 502)
        return body.get("result") or {}

    def _raise_for_http(self, status, raw):
        """Explain an HTTP failure in terms of what to do about it."""
        if status == 404 and self.session_id:
            raise ApiError("The Trader.dev session expired.", 409)
        cloudflare = "cloudflare" in raw.lower()
        if status == 404:
            if self.url != DEFAULT_TRADERDEV_URL:
                fix = f"Remove TRADERDEV_MCP_URL to use the default, {DEFAULT_TRADERDEV_URL}, or correct it."
            else:
                fix = "Trader.dev may have moved it; set TRADERDEV_MCP_URL to the new address."
            raise ApiError(f"There is no Trader.dev MCP server at {self.url} (HTTP 404). {fix}", 502)
        if status == 403 and cloudflare:
            raise ApiError(
                "Trader.dev's firewall turned this request away (HTTP 403). That is on Trader.dev's side, "
                "not your key: try again later, and tell Trader.dev if it keeps happening.",
                502,
            )
        if status in (401, 403):
            raise ApiError(
                "Trader.dev rejected the API key. Check TRADERDEV_API_KEY, then restart the server.", 401
            )
        raise ApiError(
            f"Trader.dev's server is not answering properly right now (HTTP {status}). Try again in a minute.",
            502,
        )

    def _notify(self, method, params=None):
        payload = {"jsonrpc": "2.0", "method": method, "params": params or {}}
        self._send(payload, 30)

    def _handshake(self):
        self.session_id = None
        try:
            self._rpc(
                "initialize",
                {
                    "protocolVersion": PROTOCOL_VERSION,
                    "capabilities": {},
                    "clientInfo": {"name": "backtesting-tool", "version": VERSION},
                },
                30,
            )
            self._notify("notifications/initialized")
            self._authenticate()
        except Exception:
            self.session_id = None  # a half-open session must not be reused
            raise

    def _authenticate(self):
        """Hand the API key to this session.

        Trader.dev keeps the key per MCP session: it is given once through its
        authenticate tool rather than sent as a header on every request.
        """
        result = self._rpc("tools/call", {"name": "authenticate", "arguments": {"key": self.key}}, 30)
        if result.get("isError"):
            detail = " ".join(
                (b.get("text") or "") for b in result.get("content") or [] if isinstance(b, dict)
            ).strip()
            raise ApiError(
                "Trader.dev did not accept the API key" + (f" ({detail[:300]})" if detail else "")
                + ". Check TRADERDEV_API_KEY, then restart the server.",
                401,
            )

    # ---- tools

    def call_tool(self, name, args, timeout):
        with self._lock:
            if not self.session_id:
                self._handshake()
            try:
                result = self._rpc("tools/call", {"name": name, "arguments": args}, timeout)
            except ApiError as e:
                if e.status != 409:
                    raise
                self._handshake()  # session expired mid-run: open a new one and retry once
                result = self._rpc("tools/call", {"name": name, "arguments": args}, timeout)
        return self._unwrap(name, result)

    @staticmethod
    def _unwrap(name, result):
        """Turn an MCP tool result into the JSON payload the app wants.

        Trader.dev answers with text blocks; the useful part is the one that
        parses as JSON. Anything else is passed through as text so the UI can
        show it rather than swallowing it.
        """
        texts = []
        for block in result.get("content") or []:
            if isinstance(block, dict) and block.get("type") == "text":
                texts.append(block.get("text") or "")
        if result.get("isError"):
            raise ApiError(f"Trader.dev could not run {name}: {' '.join(texts).strip()[:500]}", 502)
        parsed = None
        for text in texts:
            stripped = text.strip()
            if not stripped or stripped[0] not in "{[":
                continue
            try:
                parsed = json.loads(stripped)
            except ValueError:
                continue
        if parsed is None and isinstance(result.get("structuredContent"), (dict, list)):
            parsed = result["structuredContent"]
        notes = [t.strip() for t in texts if t.strip() and (not t.strip() or t.strip()[0] not in "{[")]
        if parsed is None:
            raise ApiError(f"Trader.dev's answer to {name} held no data: {' '.join(notes)[:300]}", 502)
        return {"result": parsed, "notes": notes}


_client = None
_client_lock = threading.Lock()


def traderdev_client():
    global _client
    key = traderdev_key()
    if not key:
        raise ApiError(
            "No Trader.dev API key. Set TRADERDEV_API_KEY to your pk_... key and restart the server.", 503
        )
    with _client_lock:
        if _client is None or _client.key != key or _client.url != TRADERDEV_URL:
            _client = TraderDev(TRADERDEV_URL, key)
        return _client


def traderdev_call(name, args):
    if name not in ALLOWED_TOOLS:
        raise ApiError(f"{name} is not one of the Trader.dev calls this app makes.", 400)
    if not isinstance(args, dict):
        raise ApiError("Tool arguments must be an object.")
    return traderdev_client().call_tool(name, args, ALLOWED_TOOLS[name])


def traderdev_status():
    """Whether the app can reach Trader.dev, without spending a credit."""
    if not traderdev_key():
        return {
            "ok": False,
            "configured": False,
            "url": TRADERDEV_URL,
            "error": "No Trader.dev API key. Set TRADERDEV_API_KEY to your pk_... key and restart the server.",
        }
    try:
        body = traderdev_call("whoami", {})
        who = body["result"]
        user = who.get("user") or {}
        return {
            "ok": True,
            "configured": True,
            "url": TRADERDEV_URL,
            "email": user.get("email"),
            "tier": user.get("displayTier") or user.get("tier"),
        }
    except ApiError as e:
        return {"ok": False, "configured": True, "url": TRADERDEV_URL, "error": str(e)}


# --------------------------------------------------------------------------- strategies


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


# --------------------------------------------------------------------------- request handler


class Handler(SimpleHTTPRequestHandler):
    server_version = f"BacktestingTool/{VERSION}"
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

        if route == "traderdev":
            sub = parts[1] if len(parts) > 1 else ""
            if method == "GET" and sub == "status":
                return self._send_json(traderdev_status())
            if method == "POST" and sub == "call":
                body = self._read_json()
                name = body.get("tool")
                if not isinstance(name, str):
                    raise ApiError("Which Trader.dev call? Pass a tool name.")
                return self._send_json(traderdev_call(name, body.get("args") or {}))

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
    ap = argparse.ArgumentParser(description="Backtesting Tool: run the Trader.dev backtester on localhost.")
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", 8000)), help="port to listen on (default 8000)")
    ap.add_argument("--host", default="127.0.0.1", help="interface to bind (default 127.0.0.1, this computer only)")
    ap.add_argument("--no-browser", action="store_true", help="don't open a browser tab")
    ap.add_argument("--verbose", action="store_true", help="log every request")
    args = ap.parse_args(argv)

    STRATEGY_DIR.mkdir(exist_ok=True)

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
    print(f"\n  Backtesting Tool is running at {url}")
    print(f"  Strategies: {STRATEGY_DIR}")
    print(f"  Backtests:  {TRADERDEV_URL}")
    if traderdev_key():
        print("  Trader.dev API key: found")
    else:
        print("  Trader.dev API key: MISSING. Set TRADERDEV_API_KEY=pk_... and restart; backtests will fail until you do.")
    if httpd.allow_any_host:
        print("  Warning: listening beyond this computer. Anyone who can reach this port can edit strategy")
        print("           files and spend your Trader.dev credits.")
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
