"""USD-base FX snapshot, refreshed once per 24 hours by the internal server."""
import json
import logging
import math
import os
import threading
import time
from datetime import datetime, timezone, date
from pathlib import Path

DAY = 86400
RETRY = 900
log = logging.getLogger("veryup.currency")


def download_rates():
    import yfinance as yf
    frame = yf.download(
        ["KRW=X", "JPY=X"], period="5d", interval="1d",
        group_by="column", auto_adjust=False, progress=False,
        threads=False, timeout=10,
    )
    if frame is None or frame.empty:
        raise ValueError("환율 데이터가 없습니다")
    # Both quotes must be from the same date; never combine different sessions.
    close = frame["Close"][["KRW=X", "JPY=X"]].dropna().sort_index()
    if close.empty:
        raise ValueError("달러/원·달러/엔 공통 기준일이 없습니다")
    row = close.iloc[-1]
    return {
        "base": "USD", "source": "Yahoo Finance / yfinance",
        "marketDate": close.index[-1].date().isoformat(),
        "rates": {"USD": 1.0, "JPY": float(row["JPY=X"]), "KRW": float(row["KRW=X"])},
    }


def valid_snapshot(data):
    try:
        rates = data["rates"]
        if data["base"] != "USD" or rates["USD"] != 1:
            return False
        if not all(type(rates[c]) in (int, float) and math.isfinite(rates[c]) and rates[c] > 0
                   for c in ("USD", "JPY", "KRW")):
            return False
        fetched = datetime.fromisoformat(data["fetchedAt"])
        market = date.fromisoformat(data["marketDate"])
        return fetched.tzinfo is not None and market <= fetched.date()
    except (KeyError, TypeError, ValueError, OverflowError):
        return False


class CurrencyRates:
    def __init__(self, cache_path, fetch=download_rates, clock=time.time):
        self.path = Path(cache_path)
        self.fetch = fetch
        self.clock = clock
        self.lock = threading.Lock()
        self.stop_event = threading.Event()
        self.thread = None
        self.snapshot = None
        self.retry_at = 0
        self.error = None
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            if valid_snapshot(data):
                self.snapshot = data
        except (OSError, ValueError, TypeError):
            pass

    def _age(self, now):
        if not self.snapshot:
            return DAY
        return now - datetime.fromisoformat(self.snapshot["fetchedAt"]).timestamp()

    def get(self):
        with self.lock:
            now = self.clock()
            age = self._age(now)
            if (age < 0 or age >= DAY) and now >= self.retry_at:
                try:
                    snapshot = dict(self.fetch())
                    snapshot["fetchedAt"] = datetime.fromtimestamp(self.clock(), timezone.utc).isoformat()
                    if not valid_snapshot(snapshot):
                        raise ValueError("유효하지 않은 환율 응답")
                    # Atomic commit: failed download/write must preserve the last good snapshot.
                    self.path.parent.mkdir(parents=True, exist_ok=True)
                    temp = self.path.with_suffix(".tmp")
                    temp.write_text(json.dumps(snapshot, ensure_ascii=False, allow_nan=False), encoding="utf-8")
                    os.replace(temp, self.path)
                    self.snapshot = snapshot
                    self.error = None
                    self.retry_at = 0
                except Exception:
                    log.exception("환율 갱신 실패")
                    self.error = "환율 갱신 실패 — 15분 후 재시도합니다."
                    self.retry_at = self.clock() + RETRY
            if not self.snapshot:
                return {"ok": False, "error": self.error or "환율을 준비하고 있습니다.", "stale": True}
            age = self._age(self.clock())
            return {**self.snapshot, "ok": True, "stale": age < 0 or age >= DAY,
                    "warning": self.error, "refreshSeconds": DAY}

    def start(self):
        if self.thread and self.thread.is_alive():
            return
        self.stop_event.clear()
        def run():
            while not self.stop_event.is_set():
                self.get()
                self.stop_event.wait(60)
        self.thread = threading.Thread(target=run, name="currency-rates", daemon=True)
        self.thread.start()

    def stop(self):
        self.stop_event.set()
        if self.thread:
            self.thread.join(timeout=1)


currency_rates = CurrencyRates(
    os.environ.get("CURRENCY_RATES_CACHE") or Path(__file__).with_name("currency_rates.json")
)
