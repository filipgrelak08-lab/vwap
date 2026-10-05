"""Tests for server.py. Run: python3 -m unittest discover -s tests

The Trader.dev tests run against a stub that speaks MCP over HTTP, so they
need no API key and no network.
"""
import http.client
import json
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
    """Enough of MCP streamable HTTP to exercise server.TraderDev."""

    calls = []
    sse = False
    fail_sessions_once = False
    _expired = False

    def log_message(self, *args):
        pass

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        req = json.loads(self.rfile.read(length) or b"{}")
        method = req.get("method")
        if method == "initialize":
            return self._reply(req, {"protocolVersion": "2025-06-18", "capabilities": {}}, session="stub-session")
        if method == "notifications/initialized":
            self.send_response(202)
            self.end_headers()
            return
        if method == "tools/call":
            params = req.get("params") or {}
            type(self).calls.append((params.get("name"), params.get("arguments")))
            if type(self).fail_sessions_once and not type(self)._expired:
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

    def _reply(self, req, result, session=None):
        body = json.dumps({"jsonrpc": "2.0", "id": req.get("id"), "result": result}).encode()
        if type(self).sse:
            body = b"event: message\ndata: " + body + b"\n\n"
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
        StubHandler.sse = False
        StubHandler.fail_sessions_once = False
        StubHandler._expired = False
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
        self.assertIn(b"VWAP Lab", data)

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
