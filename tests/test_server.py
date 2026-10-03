"""Tests for server.py. Run: python3 -m unittest discover -s tests
Set VWAPLAB_NETWORK_TESTS=1 to also hit Yahoo Finance and Binance."""
import http.client
import json
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import server  # noqa: E402

NETWORK = os.environ.get("VWAPLAB_NETWORK_TESTS") == "1"


class ServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        root = Path(cls.tmp.name)
        server.STRATEGY_DIR = root / "strategies"
        server.DATA_DIR = root / "data"
        server.STRATEGY_DIR.mkdir()
        server.DATA_DIR.mkdir()
        (server.STRATEGY_DIR / "alpha.js").write_text("export default { name: 'Alpha', onBar() {} };\n", encoding="utf-8")
        (server.DATA_DIR / "prices.csv").write_text("Date,Close\n2024-01-02,1\n", encoding="utf-8")
        (server.DATA_DIR / "notes.md").write_text("not data", encoding="utf-8")
        server.PINE_DIR = root / "pine"
        server.PINE_DIR.mkdir()
        (server.PINE_DIR / "demo.pine").write_text("//@version=6\nstrategy(\"Demo\")\n", encoding="utf-8")
        server.TRADERDEV_KEY_FILE = root / ".traderdev-key"
        cls.env_key = os.environ.pop("TRADERDEV_API_KEY", None)
        cls.httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        cls.httpd.verbose = False
        cls.httpd.allow_any_host = False
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.tmp.cleanup()
        if cls.env_key is not None:
            os.environ["TRADERDEV_API_KEY"] = cls.env_key

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
        code = "export default { name: 'Beta', onBar() {} };\n"
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

    def test_datasets(self):
        status, body = self.json("GET", "/api/datasets")
        self.assertEqual(body["files"], ["prices.csv"])
        status, data = self.request("GET", "/api/datasets/prices.csv")
        self.assertEqual(status, 200)
        self.assertTrue(data.startswith(b"Date,Close"))
        status, _ = self.request("GET", "/api/datasets/notes.md")
        self.assertEqual(status, 404)

    def test_bad_market_data_requests_fail_cleanly(self):
        status, body = self.json("GET", "/api/yahoo?symbol=%3Cscript%3E&interval=1d&range=1y")
        self.assertEqual(status, 400)
        self.assertIn("error", body)
        status, body = self.json("GET", "/api/binance?symbol=BTCUSDT&interval=7m&bars=100")
        self.assertEqual(status, 400)

    def test_pine_scripts(self):
        status, body = self.json("GET", "/api/pine")
        self.assertEqual(status, 200)
        self.assertEqual([s["id"] for s in body["scripts"]], ["demo"])

    def fake_traderdev(self):
        """Replace the trader.dev client with a stub; returns the list of calls it receives."""
        calls = []

        def fake(tool, args=None, key=None):
            calls.append((tool, args, key))
            answers = {
                "whoami": {"email": "me@example.com", "displayTier": "free"},
                "get_credits": {"balance": 7},
                "quick_backtest": {"resultId": "01ABCDEFGHJKMNPQRSTVWXYZ00", "result": {"netProfitPct": 1.5}},
            }
            return answers[tool]

        original = server.traderdev_call
        server.traderdev_call = fake
        self.addCleanup(setattr, server, "traderdev_call", original)
        return calls

    def test_traderdev_not_connected(self):
        server.TRADERDEV_KEY_FILE.unlink(missing_ok=True)
        status, body = self.json("GET", "/api/traderdev/status")
        self.assertEqual((status, body), (200, {"connected": False}))
        status, body = self.json("POST", "/api/traderdev/backtest", {"pineSource": "x", "symbol": "BTCUSDT", "timeframe": "1D"})
        self.assertEqual(status, 401)
        self.assertIn("API key", body["error"])

    def test_traderdev_key_roundtrip(self):
        calls = self.fake_traderdev()
        status, _ = self.json("PUT", "/api/traderdev/key", {"key": "not-a-key"})
        self.assertEqual(status, 400)
        self.assertFalse(server.TRADERDEV_KEY_FILE.exists())
        status, body = self.json("PUT", "/api/traderdev/key", {"key": "pk_abcdefgh12345"})
        self.assertEqual(status, 200, body)
        self.assertEqual((body["connected"], body["email"], body["credits"], body["source"]), (True, "me@example.com", 7, "file"))
        self.assertEqual(server.TRADERDEV_KEY_FILE.read_text(encoding="utf-8").strip(), "pk_abcdefgh12345")
        if os.name == "posix":
            self.assertEqual(server.TRADERDEV_KEY_FILE.stat().st_mode & 0o777, 0o600)
        self.assertIn(("whoami", None, "pk_abcdefgh12345"), calls)
        status, body = self.json("DELETE", "/api/traderdev/key")
        self.assertEqual((status, body["connected"]), (200, False))
        self.assertFalse(server.TRADERDEV_KEY_FILE.exists())

    def test_traderdev_backtest_validation(self):
        calls = self.fake_traderdev()
        good = {"pineSource": "//@version=6", "symbol": "BTCUSDT", "timeframe": "1h", "from": "2024-01-01", "to": "", "name": "Test"}
        for bad in ({"pineSource": ""}, {"symbol": "BTC USDT"}, {"timeframe": "hourly"}, {"from": "01/02/2024"}):
            status, body = self.json("POST", "/api/traderdev/backtest", dict(good, **bad))
            self.assertEqual(status, 400, (bad, body))
        self.assertEqual(calls, [])
        status, body = self.json("POST", "/api/traderdev/backtest", good)
        self.assertEqual((status, body["resultId"]), (200, "01ABCDEFGHJKMNPQRSTVWXYZ00"))
        self.assertEqual(calls[-1][:2], ("quick_backtest", {"pineSource": "//@version=6", "symbol": "BTCUSDT", "timeframe": "1h", "from": "2024-01-01", "name": "Test"}))

    def test_traderdev_result_rejects_bad_ids(self):
        for rid in ("short", "has%20space", "x" * 41):
            status, _ = self.json("GET", f"/api/traderdev/results/{rid}")
            self.assertEqual(status, 400, rid)

    def test_traderdev_reads_event_stream_answers(self):
        class Resp:
            def __init__(self, body, sid="s1"):
                self.body, self.headers = body.encode(), {"Mcp-Session-Id": sid}

            def read(self):
                return self.body

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

        def fake_urlopen(req, timeout=None):
            msg = json.loads(req.data)
            if msg.get("method") == "initialize":
                return Resp('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n')
            if "id" not in msg:
                return Resp("")
            content = [{"type": "text", "text": "tip for the user"}, {"type": "text", "text": '{"balance": 42}'}]
            return Resp("event: message\ndata: " + json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"content": content}}) + "\n\n")

        original = server.urllib.request.urlopen
        server.urllib.request.urlopen = fake_urlopen
        self.addCleanup(setattr, server.urllib.request, "urlopen", original)
        server._td_sessions.clear()
        self.assertEqual(server.traderdev_call("get_credits", key="pk_test12345678"), {"balance": 42})

    @unittest.skipUnless(NETWORK, "set VWAPLAB_NETWORK_TESTS=1 to run")
    def test_traderdev_result_live(self):
        status, body = self.json("GET", "/api/traderdev/results/01M41Y8ZVSHME7R13GRTCG47B1")
        self.assertEqual(status, 200, body)
        self.assertEqual(len(body["trades"]), 242)
        self.assertGreater(len(body["equity"]), 100)

    @unittest.skipUnless(NETWORK, "set VWAPLAB_NETWORK_TESTS=1 to run")
    def test_yahoo_live(self):
        status, body = self.json("GET", "/api/yahoo?symbol=SPY&interval=1d&range=1mo&adjusted=1")
        self.assertEqual(status, 200, body)
        self.assertGreater(len(body["bars"]), 10)
        self.assertEqual(body["bars"][0][0] % 86400, 0)  # daily bars sit on midnight of the trading date

    @unittest.skipUnless(NETWORK, "set VWAPLAB_NETWORK_TESTS=1 to run")
    def test_yahoo_rejects_coarser_data_than_requested(self):
        # Yahoo answers 15m + max with monthly bars; the server must not pass those off as 15m
        status, body = self.json("GET", "/api/yahoo?symbol=SPY&interval=15m&range=max")
        self.assertEqual(status, 400, body)
        self.assertIn("15m", body["error"])

    @unittest.skipUnless(NETWORK, "set VWAPLAB_NETWORK_TESTS=1 to run")
    def test_binance_live(self):
        status, body = self.json("GET", "/api/binance?symbol=BTCUSDT&interval=1h&bars=1500")
        self.assertEqual(status, 200, body)
        bars = body["bars"]
        self.assertEqual(len(bars), 1500)
        self.assertTrue(all(b[0] - a[0] == 3600 for a, b in zip(bars, bars[1:])))


if __name__ == "__main__":
    unittest.main()
