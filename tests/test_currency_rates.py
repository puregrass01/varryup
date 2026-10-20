import importlib
import json
import sys
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))
from currency_rates import CurrencyRates, DAY, RETRY, download_rates


def quote():
    return {"base": "USD", "source": "test", "marketDate": "2026-09-28",
            "rates": {"USD": 1, "JPY": 150, "KRW": 1350}}


class RatesTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "rates.json"
        self.now = 1790640000.0  # 2026-09-29 UTC
        self.fetch = Mock(side_effect=lambda: quote())
        self.service = CurrencyRates(self.path, self.fetch, lambda: self.now)

    def test_daily_boundary_and_restart(self):
        first = self.service.get()
        self.assertTrue(first["ok"])
        self.assertFalse(first["stale"])
        self.now += DAY - 1
        restarted = CurrencyRates(self.path, self.fetch, lambda: self.now)
        self.assertEqual(first["fetchedAt"], restarted.get()["fetchedAt"])
        self.assertEqual(self.fetch.call_count, 1)
        self.now += 1
        self.assertNotEqual(first["fetchedAt"], restarted.get()["fetchedAt"])
        self.assertEqual(self.fetch.call_count, 2)

    def test_failure_retains_cache_then_retries(self):
        first = self.service.get()
        disk = self.path.read_bytes()
        self.now += DAY
        self.fetch.side_effect = OSError("offline")
        with self.assertLogs("veryup.currency", level="ERROR"):
            result = self.service.get()
        self.assertTrue(result["stale"])
        self.assertEqual(result["rates"], first["rates"])
        self.assertEqual(self.path.read_bytes(), disk)
        self.now += RETRY - 1
        self.service.get()
        self.assertEqual(self.fetch.call_count, 2)
        self.now += 1
        self.fetch.side_effect = lambda: quote()
        self.assertFalse(self.service.get()["stale"])
        self.assertEqual(self.fetch.call_count, 3)

    def test_empty_cache_and_invalid_rates(self):
        for value in (0, -2, float("nan"), float("inf"), True):
            self.fetch.side_effect = None
            bad = quote()
            bad["rates"]["JPY"] = value
            self.fetch.return_value = bad
            service = CurrencyRates(self.path, self.fetch, lambda: self.now)
            with self.assertLogs("veryup.currency", level="ERROR"):
                self.assertFalse(service.get()["ok"])
            self.assertFalse(self.path.exists())

    def test_corrupt_cache_and_concurrent_requests(self):
        self.path.write_text("{broken", encoding="utf-8")
        service = CurrencyRates(self.path, self.fetch, lambda: self.now)
        with ThreadPoolExecutor(max_workers=8) as executor:
            results = list(executor.map(lambda _: service.get(), range(20)))
        self.assertTrue(all(r["ok"] for r in results))
        self.assertEqual(self.fetch.call_count, 1)

    def test_background_start_and_stop(self):
        ready = threading.Event()
        self.fetch.side_effect = lambda: (ready.set(), quote())[1]
        self.service.start()
        self.assertTrue(ready.wait(2))
        self.service.stop()
        self.assertFalse(self.service.thread.is_alive())

    def test_failed_atomic_write_preserves_snapshot(self):
        first = self.service.get()
        disk = self.path.read_bytes()
        self.now += DAY
        with patch("currency_rates.os.replace", side_effect=OSError("read only")), self.assertLogs("veryup.currency", level="ERROR"):
            result = self.service.get()
        self.assertTrue(result["stale"])
        self.assertEqual(first["fetchedAt"], result["fetchedAt"])
        self.assertEqual(disk, self.path.read_bytes())

    def test_yfinance_uses_latest_common_date(self):
        import pandas as pd
        columns = pd.MultiIndex.from_tuples([("Close", "KRW=X"), ("Close", "JPY=X")])
        frame = pd.DataFrame([[1350, 150], [1400, float("nan")]],
                             index=pd.to_datetime(["2026-09-25", "2026-09-28"]), columns=columns)
        with patch("yfinance.download", return_value=frame) as download:
            result = download_rates()
        self.assertEqual(result["marketDate"], "2026-09-25")
        self.assertEqual(result["rates"], {"USD": 1, "JPY": 150, "KRW": 1350})
        self.assertEqual(download.call_args.kwargs["interval"], "1d")
        with patch("yfinance.download", return_value=pd.DataFrame()):
            with self.assertRaises(ValueError):
                download_rates()


class CurrencyRouteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        import server_env
        import db
        with patch.object(db, "init_db"):
            cls.admin = importlib.import_module("app")

    def test_authentication_precedes_fetch(self):
        from fastapi.testclient import TestClient
        with patch.object(self.admin, "_auth_by_token", return_value=None), patch.object(self.admin.currency_rates, "get") as get:
            client = TestClient(self.admin.app)
            self.addCleanup(client.close)
            self.assertEqual(client.get("/api/currency-rates").status_code, 401)
            get.assert_not_called()

    def test_success_and_unavailable(self):
        from fastapi.testclient import TestClient
        with patch.object(self.admin, "_auth_by_token", return_value={"id": 1}), patch.object(self.admin.currency_rates, "get") as get:
            client = TestClient(self.admin.app)
            self.addCleanup(client.close)
            get.return_value = {"ok": True, **quote()}
            self.assertEqual(client.get("/api/currency-rates").status_code, 200)
            get.return_value = {"ok": False, "error": "offline"}
            self.assertEqual(client.get("/api/currency-rates").status_code, 503)


if __name__ == "__main__":
    unittest.main()
