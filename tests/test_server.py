"""Tests for server.py. Run: python3 -m unittest discover -s tests

The Trader.dev tests run against a stub that speaks MCP over HTTP, so they
need no API key and no network.
"""
import http.client
import json
import socket
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import server  # noqa: E402


# --------------------------------------------------------------------------- Trader.dev stub


class StubHandler(BaseHTTPRequestHandler):
    """Enough of MCP streamable HTTP to exercise server.TraderDev.

    Like Trader.dev, it keeps the API key per session: tools refuse to run
    until the session has called authenticate. Other paths stand in for the
    ways a connection fails: /cf is Cloudflare's firewall, /blocked a network
    filter, /busy a rate limit, /html a web page, /slow a gateway timeout and
    /cut a reply that stops half way. Anything else 404s like Trader.dev's
    website does.
    """

    calls = []
    auths = []
    headers_seen = []
    sse = False
    fail_sessions_once = False
    stale_as_400 = False  # answer an expired session the TypeScript SDK way
    always_expire = False
    sse_noise = False  # send notifications around the response, as servers may
    _expired = False
    _sessions = 0
    _authed = set()

    def log_message(self, *args):
        pass

    def do_POST(self):
        cls = type(self)
        cls.headers_seen.append(dict(self.headers))
        if self.path == "/cf":
            return self._raw(
                403, b'{"title":"Error 1010: Access denied","detail":"blocked by cloudflare","error_code":1010,"ray_id":"8f2a1b3c4d5e6f70"}'
            )
        if self.path == "/blocked":
            return self._raw(403, b"<html><body>This site is blocked by your network administrator.</body></html>", "text/html")
        if self.path == "/busy":
            return self._raw(429, b"<html><head><title>Rate limited | Cloudflare</title></head></html>", "text/html")
        if self.path == "/html":
            return self._raw(200, b"<!DOCTYPE html><html><body>Welcome to Trader.dev</body></html>", "text/html")
        if self.path == "/slow":
            return self._raw(524, b"<html><body>A timeout occurred | Cloudflare</body></html>", "text/html")
        if self.path == "/cut":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", "500")
            self.end_headers()
            self.wfile.write(b'{"jsonrpc":')
            self.wfile.flush()
            self.connection.shutdown(socket.SHUT_RDWR)
            return
        if self.path != "/mcp":
            return self._raw(404, b'{"message":"Route POST:' + self.path.encode() + b' not found","error":"Not Found","statusCode":404}')
        length = int(self.headers.get("Content-Length") or 0)
        req = json.loads(self.rfile.read(length) or b"{}")
        method = req.get("method")
        session = self.headers.get("Mcp-Session-Id")
        if method == "initialize":
            cls._sessions += 1
            return self._reply(req, {"protocolVersion": "2025-06-18", "capabilities": {}}, session=f"stub-{cls._sessions}")
        if method == "notifications/initialized":
            self.send_response(202)
            self.end_headers()
            return
        if method == "tools/call":
            params = req.get("params") or {}
            if params.get("name") == "authenticate":
                key = (params.get("arguments") or {}).get("key")
                cls.auths.append(key)
                if key == "pk_bad":
                    return self._reply(req, {"content": [{"type": "text", "text": "Invalid API key"}], "isError": True})
                if key.startswith("pk_echo"):
                    return self._reply(req, {"content": [{"type": "text", "text": f"Authentication failed for key {key}"}], "isError": True})
                if key == "pk_rpcerr":
                    body = {"jsonrpc": "2.0", "id": req.get("id"), "error": {"code": -32602, "message": "Invalid arguments for tool authenticate"}}
                    return self._raw(200, json.dumps(body).encode())
                cls._authed.add(session)
                return self._reply(req, {"content": [{"type": "text", "text": "Authenticated."}]})
            if session not in cls._authed:
                return self._reply(req, {"content": [{"type": "text", "text": "Not authenticated."}], "isError": True})
            cls.calls.append((params.get("name"), params.get("arguments")))
            if cls.always_expire:
                return self._raw(404, b"")
            if cls.stale_as_400 and not cls._expired:
                cls._expired = True
                return self._raw(400, b'{"jsonrpc":"2.0","error":{"code":-32000,"message":"Bad Request: No valid session ID provided"},"id":null}')
            if cls.fail_sessions_once and not cls._expired:
                type(self)._expired = True
                self.send_response(404)
                self.end_headers()
                return
            if params.get("name") == "boom":
                return self._reply(req, {"content": [{"type": "text", "text": "no credits left"}], "isError": True})
            payload = {"ok": True, "tool": params.get("name"), "args": params.get("arguments")}
            return self._reply(
                req,
                {"content": [{"type": "text", "text": "A note for the reader."}, {"type": "text", "text": json.dumps(payload)}]},
            )
        self.send_response(400)
        self.end_headers()

    def _raw(self, status, body, ctype="application/json"):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _reply(self, req, result, session=None):
        body = json.dumps({"jsonrpc": "2.0", "id": req.get("id"), "result": result}).encode()
        if type(self).sse:
            body = b"event: message\ndata: " + body + b"\n\n"
            if type(self).sse_noise:
                note = json.dumps({"jsonrpc": "2.0", "method": "notifications/progress", "params": {"progress": 50}}).encode()
                body = b"event: message\ndata: " + note + b"\n\n" + body + b": keep-alive\n\ndata: " + note + b"\n\n"
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream" if type(self).sse else "application/json")
        self.send_header("Content-Length", str(len(body)))
        if session:
            self.send_header("Mcp-Session-Id", session)
        self.end_headers()
        self.wfile.write(body)


# --------------------------------------------------------------------------- HTTP surface


class ServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        root = Path(cls.tmp.name)
        server.STRATEGY_DIR = root / "strategies"
        server.STRATEGY_DIR.mkdir()
        (server.STRATEGY_DIR / "alpha.js").write_text("export default { name: 'Alpha', pine() {} };\n", encoding="utf-8")

        cls.stub = ThreadingHTTPServer(("127.0.0.1", 0), StubHandler)
        threading.Thread(target=cls.stub.serve_forever, daemon=True).start()
        cls.stub_url = f"http://127.0.0.1:{cls.stub.server_address[1]}/mcp"

        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        cls.httpd.verbose = False
        cls.httpd.allow_any_host = False
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        for s in (cls.httpd, cls.stub):
            s.shutdown()
            s.server_close()
        cls.tmp.cleanup()

    def setUp(self):
        StubHandler.calls = []
        StubHandler.auths = []
        StubHandler.headers_seen = []
        StubHandler.sse = False
        StubHandler.fail_sessions_once = False
        StubHandler.stale_as_400 = False
        StubHandler.always_expire = False
        StubHandler.sse_noise = False
        StubHandler._expired = False
        StubHandler._authed = set()
        server._client = None
        server.TRADERDEV_URL = self.stub_url

    def tearDown(self):
        server._client = None
        for var in server.TRADERDEV_KEY_VARS:
            server.os.environ.pop(var, None)

    def use_key(self, key="pk_test"):
        server.os.environ["TRADERDEV_API_KEY"] = key

    def request(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=30)
        hdrs = {"Host": f"localhost:{self.port}"}
        hdrs.update(headers or {})
        conn.request(method, path, body=body, headers=hdrs)
        resp = conn.getresponse()
        data = resp.read()
        conn.close()
        return resp.status, data

    def json(self, method, path, payload=None, headers=None):
        body = json.dumps(payload).encode() if payload is not None else None
        h = {"Content-Type": "application/json"} if payload is not None else {}
        h.update(headers or {})
        status, data = self.request(method, path, body, h)
        return status, json.loads(data or b"{}")

    def test_serves_the_app(self):
        status, data = self.request("GET", "/")
        self.assertEqual(status, 200)
        self.assertIn(b"Backtesting Tool", data)

    def test_health(self):
        status, body = self.json("GET", "/api/health")
        self.assertEqual((status, body["ok"]), (200, True))

    def test_strategy_roundtrip(self):
        status, body = self.json("GET", "/api/strategies")
        self.assertEqual(status, 200)
        self.assertIn("alpha", [s["id"] for s in body["strategies"]])
        code = "export default { name: 'Beta', pine() {} };\n"
        status, body = self.json("PUT", "/api/strategies/beta", {"code": code})
        self.assertEqual(status, 200, body)
        self.assertEqual((server.STRATEGY_DIR / "beta.js").read_text(encoding="utf-8"), code)
        status, _ = self.json("DELETE", "/api/strategies/beta")
        self.assertEqual(status, 200)
        self.assertFalse((server.STRATEGY_DIR / "beta.js").exists())
        status, _ = self.json("DELETE", "/api/strategies/beta")
        self.assertEqual(status, 404)

    def test_rejects_bad_strategy_names(self):
        for name in ("..%2Fserver", "a.b", "x" * 65):
            status, _ = self.json("PUT", f"/api/strategies/{name}", {"code": "x"})
            self.assertIn(status, (400, 404), name)
        self.assertFalse((server.STRATEGY_DIR.parent / "server.js").exists())

    def test_writes_require_json(self):
        status, _ = self.request("PUT", "/api/strategies/gamma", b"code=1", {"Content-Type": "application/x-www-form-urlencoded"})
        self.assertEqual(status, 415)
        self.assertFalse((server.STRATEGY_DIR / "gamma.js").exists())

    def test_rejects_foreign_host_header(self):
        status, _ = self.request("GET", "/api/health", headers={"Host": "attacker.example"})
        self.assertEqual(status, 403)

    def test_static_files_cannot_escape_web_dir(self):
        status, _ = self.request("GET", "/../server.py")
        self.assertEqual(status, 404)
        status, _ = self.request("GET", "/%2e%2e/server.py")
        self.assertEqual(status, 404)

    # ---- Trader.dev proxy

    def test_status_without_a_key_says_so(self):
        status, body = self.json("GET", "/api/traderdev/status")
        self.assertEqual(status, 200)
        self.assertFalse(body["ok"])
        self.assertFalse(body["configured"])
        self.assertIn("TRADERDEV_API_KEY", body["error"])

    def test_backtest_without_a_key_is_refused(self):
        status, body = self.json("POST", "/api/traderdev/call", {"tool": "quick_backtest", "args": {}})
        self.assertEqual(status, 503)
        self.assertIn("TRADERDEV_API_KEY", body["error"])

    def test_only_allowlisted_tools_can_be_called(self):
        self.use_key()
        status, body = self.json("POST", "/api/traderdev/call", {"tool": "delete_strategy", "args": {}})
        self.assertEqual(status, 400)
        self.assertEqual(StubHandler.calls, [])
        status, body = self.json("POST", "/api/traderdev/call", {"tool": "create_alert", "args": {}})
        self.assertEqual(status, 400)

    def test_forwards_a_tool_call_and_unwraps_the_json(self):
        self.use_key()
        status, body = self.json("POST", "/api/traderdev/call", {"tool": "get_credits", "args": {"a": 1}})
        self.assertEqual(status, 200, body)
        self.assertEqual(body["result"], {"ok": True, "tool": "get_credits", "args": {"a": 1}})
        self.assertEqual(body["notes"], ["A note for the reader."])
        self.assertEqual(StubHandler.calls, [("get_credits", {"a": 1})])

    def test_handles_an_event_stream_reply(self):
        self.use_key()
        StubHandler.sse = True
        status, body = self.json("POST", "/api/traderdev/call", {"tool": "get_credits", "args": {}})
        self.assertEqual(status, 200, body)
        self.assertTrue(body["result"]["ok"])

    def test_reopens_an_expired_session(self):
        self.use_key()
        StubHandler.fail_sessions_once = True
        status, body = self.json("POST", "/api/traderdev/call", {"tool": "get_credits", "args": {}})
        self.assertEqual(status, 200, body)
        self.assertEqual(len(StubHandler.calls), 2)  # first call expired, second succeeded
        self.assertEqual(StubHandler.auths, ["pk_test", "pk_test"], "the new session needs the key again")

    def test_hands_the_key_to_each_session_once(self):
        self.use_key("pk_mine")
        for _ in range(3):
            status, body = self.json("POST", "/api/traderdev/call", {"tool": "get_credits", "args": {}})
            self.assertEqual(status, 200, body)
        self.assertEqual(StubHandler.auths, ["pk_mine"], "one session, authenticated once, reused")
        self.assertEqual(len(StubHandler.calls), 3)

    def test_a_rejected_key_says_so(self):
        self.use_key("pk_bad")
        status, body = self.json("POST", "/api/traderdev/call", {"tool": "get_credits", "args": {}})
        self.assertEqual(status, 401)
        self.assertIn("could not log in with your API key", body["error"])
        self.assertIn("Invalid API key", body["error"])
        self.assertEqual(StubHandler.calls, [], "nothing runs on a session the key did not open")
        status, body = self.json("GET", "/api/traderdev/status")
        self.assertFalse(body["ok"])
        self.assertIn("API key", body["error"])

    def test_the_key_is_not_sent_as_a_header(self):
        # Trader.dev's own setup sends no Authorization header; the key goes
        # through the authenticate tool instead.
        self.use_key()
        self.json("POST", "/api/traderdev/call", {"tool": "get_credits", "args": {}})
        self.assertTrue(StubHandler.headers_seen)
        for h in StubHandler.headers_seen:
            self.assertNotIn("Authorization", h)
            self.assertNotIn("pk_test", json.dumps(h))

    def test_sends_its_own_user_agent(self):
        # Trader.dev's firewall turns away Python's default "Python-urllib".
        self.use_key()
        self.json("POST", "/api/traderdev/call", {"tool": "get_credits", "args": {}})
        for h in StubHandler.headers_seen:
            self.assertTrue(h.get("User-Agent", "").startswith("BacktestingTool/"), h.get("User-Agent"))

    def test_a_wrong_address_is_explained(self):
        self.use_key()
        server.TRADERDEV_URL = self.stub_url.replace("/mcp", "/wrong")
        status, body = self.json("POST", "/api/traderdev/call", {"tool": "get_credits", "args": {}})
        self.assertEqual(status, 502)
        self.assertIn("There is no Trader.dev MCP server at", body["error"])
        self.assertIn("/wrong", body["error"])
        self.assertIn(server.DEFAULT_TRADERDEV_URL, body["error"], "says what the right address is")
        self.assertNotIn("Route POST", body["error"])

    def test_a_firewall_block_is_not_blamed_on_the_key(self):
        self.use_key()
        server.TRADERDEV_URL = self.stub_url.replace("/mcp", "/cf")
        status, body = self.json("POST", "/api/traderdev/call", {"tool": "get_credits", "args": {}})
        self.assertEqual(status, 502)
        self.assertIn("firewall", body["error"])
        self.assertIn("not your key", body["error"])

    def test_the_default_address_is_the_mcp_host(self):
        self.assertEqual(server.DEFAULT_TRADERDEV_URL, "https://mcp.trader.dev/mcp")

    def call_at(self, path, key="pk_test"):
        self.use_key(key)
        server.TRADERDEV_URL = self.stub_url.replace("/mcp", path)
        return self.json("POST", "/api/traderdev/call", {"tool": "get_credits", "args": {}})

    def test_reads_an_event_stream_with_notifications_around_the_answer(self):
        self.use_key()
        StubHandler.sse = True
        StubHandler.sse_noise = True
        status, body = self.json("POST", "/api/traderdev/call", {"tool": "get_credits", "args": {"n": 1}})
        self.assertEqual(status, 200, body)
        self.assertEqual(body["result"]["args"], {"n": 1})

    def test_reopens_a_session_expired_with_a_400(self):
        self.use_key()
        StubHandler.stale_as_400 = True
        status, body = self.json("POST", "/api/traderdev/call", {"tool": "get_credits", "args": {}})
        self.assertEqual(status, 200, body)
        self.assertEqual(len(StubHandler.auths), 2, "a new session, with the key handed over again")

    def test_logs_in_again_when_trader_dev_forgets_the_session_login(self):
        self.use_key()
        self.assertEqual(self.json("POST", "/api/traderdev/call", {"tool": "get_credits", "args": {}})[0], 200)
        StubHandler._authed.clear()  # e.g. Trader.dev restarted but kept the session
        status, body = self.json("POST", "/api/traderdev/call", {"tool": "get_credits", "args": {}})
        self.assertEqual(status, 200, body)
        self.assertEqual(len(StubHandler.auths), 2)

    def test_a_session_that_keeps_expiring_is_explained(self):
        self.use_key()
        StubHandler.always_expire = True
        status, body = self.json("POST", "/api/traderdev/call", {"tool": "get_credits", "args": {}})
        self.assertEqual(status, 502)
        self.assertIn("keeps dropping", body["error"])
        self.assertNotIn("session expired", body["error"].lower())

    def test_a_refusal_before_the_key_is_sent_does_not_blame_the_key(self):
        status, body = self.call_at("/blocked")
        self.assertEqual(status, 502)
        self.assertIn("key is not the problem", body["error"])
        self.assertNotIn("<html", body["error"])

    def test_a_firewall_block_carries_the_details_to_report(self):
        status, body = self.call_at("/cf")
        self.assertIn("Cloudflare error 1010", body["error"])
        self.assertIn("Ray ID 8f2a1b3c4d5e6f70", body["error"])

    def test_a_rate_limit_says_to_wait(self):
        status, body = self.call_at("/busy")
        self.assertEqual(status, 503)
        self.assertIn("too many requests", body["error"])
        self.assertNotIn("<html", body["error"])

    def test_a_web_page_instead_of_mcp_points_at_the_address(self):
        status, body = self.call_at("/html")
        self.assertEqual(status, 502)
        self.assertIn("answered with a web page", body["error"])
        self.assertIn("TRADERDEV_MCP_URL", body["error"])
        self.assertNotIn("<html", body["error"].lower())

    def test_a_gateway_timeout_warns_about_credits(self):
        status, body = self.call_at("/slow")
        self.assertEqual(status, 504)
        self.assertIn("may still have finished and used a credit", body["error"])

    def test_a_reply_cut_off_part_way_is_explained(self):
        status, body = self.call_at("/cut")
        self.assertEqual(status, 502)
        self.assertIn("dropped before it finished answering", body["error"])
        status, body = self.json("GET", "/api/traderdev/status")
        self.assertEqual(status, 200, "the status check must not crash on it")
        self.assertFalse(body["ok"])

    def test_the_key_is_never_echoed_back(self):
        self.use_key("pk_echoSECRET123")
        status, body = self.json("POST", "/api/traderdev/call", {"tool": "get_credits", "args": {}})
        self.assertEqual(status, 401)
        self.assertNotIn("pk_echoSECRET123", body["error"])
        status, body = self.json("GET", "/api/traderdev/status")
        self.assertNotIn("pk_echoSECRET123", json.dumps(body))

    def test_a_key_inside_the_address_is_never_shown(self):
        self.use_key()
        server.TRADERDEV_URL = self.stub_url + "?key=pk_inurlSECRET"
        status, body = self.json("GET", "/api/traderdev/status")
        self.assertNotIn("pk_inurlSECRET", json.dumps(body))
        server.TRADERDEV_URL = self.stub_url.replace("/mcp", "/nowhere") + "?key=pk_inurlSECRET"
        server._client = None
        status, body = self.json("POST", "/api/traderdev/call", {"tool": "get_credits", "args": {}})
        self.assertIn("/nowhere", body["error"])
        self.assertNotIn("pk_inurlSECRET", body["error"])

    def test_a_key_of_the_wrong_shape_is_caught_before_sending(self):
        self.use_key("sk_live_wrongkind")
        status, body = self.json("POST", "/api/traderdev/call", {"tool": "get_credits", "args": {}})
        self.assertEqual(status, 401)
        self.assertIn("should start with pk_", body["error"])
        self.assertEqual(StubHandler.headers_seen, [], "nothing was sent to Trader.dev")

    def test_a_key_pasted_with_its_quotes_still_works(self):
        self.use_key('"pk_quoted"')
        status, body = self.json("POST", "/api/traderdev/call", {"tool": "get_credits", "args": {}})
        self.assertEqual(status, 200, body)
        self.assertEqual(StubHandler.auths, ["pk_quoted"])

    def test_an_authenticate_protocol_error_reads_as_a_key_problem(self):
        self.use_key("pk_rpcerr")
        status, body = self.json("POST", "/api/traderdev/call", {"tool": "get_credits", "args": {}})
        self.assertEqual(status, 401)
        self.assertIn("could not log in with your API key", body["error"])

    def test_a_tool_error_comes_back_as_an_error(self):
        self.use_key()
        server.ALLOWED_TOOLS["boom"] = 10
        try:
            status, body = self.json("POST", "/api/traderdev/call", {"tool": "boom", "args": {}})
        finally:
            del server.ALLOWED_TOOLS["boom"]
        self.assertEqual(status, 502)
        self.assertIn("no credits left", body["error"])

    def test_status_reports_the_signed_in_user(self):
        self.use_key()
        status, body = self.json("GET", "/api/traderdev/status")
        self.assertEqual(status, 200, body)
        # the stub echoes the tool name rather than a user, so ok is true and email is absent
        self.assertTrue(body["ok"])
        self.assertEqual(body["url"], self.stub_url)

    def test_unreachable_endpoint_fails_cleanly(self):
        self.use_key()
        server.TRADERDEV_URL = "http://127.0.0.1:1/mcp"
        server._client = None
        status, body = self.json("POST", "/api/traderdev/call", {"tool": "get_credits", "args": {}})
        self.assertEqual(status, 502)
        self.assertIn("Could not reach Trader.dev", body["error"])


# --------------------------------------------------------------------------- parsing helpers


class ParsingTest(unittest.TestCase):
    def test_parses_json_and_sse(self):
        payload = {"jsonrpc": "2.0", "id": 1, "result": {"a": 1}}
        raw = json.dumps(payload)
        self.assertEqual(server.TraderDev._parse(200, "application/json", raw), payload)
        sse = f"event: message\ndata: {raw}\n\n"
        self.assertEqual(server.TraderDev._parse(200, "text/event-stream", sse), payload)
        self.assertIsNone(server.TraderDev._parse(202, "application/json", ""))

    def test_unreadable_reply_raises(self):
        with self.assertRaises(server.ApiError):
            server.TraderDev._parse(200, "text/html", "<html>nope</html>")

    def test_unwrap_prefers_the_json_block(self):
        result = {"content": [{"type": "text", "text": "hint"}, {"type": "text", "text": '{"x": 2}'}]}
        out = server.TraderDev._unwrap("quick_backtest", result)
        self.assertEqual(out["result"], {"x": 2})
        self.assertEqual(out["notes"], ["hint"])

    def test_unwrap_falls_back_to_structured_content(self):
        result = {"content": [{"type": "text", "text": "hint"}], "structuredContent": {"y": 3}}
        self.assertEqual(server.TraderDev._unwrap("get_trades", result)["result"], {"y": 3})

    def test_unwrap_raises_when_there_is_no_data(self):
        with self.assertRaises(server.ApiError):
            server.TraderDev._unwrap("get_trades", {"content": [{"type": "text", "text": "just prose"}]})

    def test_unwrap_raises_on_a_tool_error(self):
        result = {"content": [{"type": "text", "text": "symbol not covered"}], "isError": True}
        with self.assertRaises(server.ApiError) as cm:
            server.TraderDev._unwrap("quick_backtest", result)
        self.assertIn("symbol not covered", str(cm.exception))


if __name__ == "__main__":
    unittest.main()
