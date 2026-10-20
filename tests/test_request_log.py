"""실시간 요청 로그 — 버퍼·마스킹·권한.

이 기능의 위험은 '동작하지 않는 것'이 아니라 **담지 말아야 할 것을 담는 것**이다.
그래서 마스킹과 권한 테스트를 기능 테스트보다 먼저 둔다.
"""
import asyncio
import importlib
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

# 환경변수·sys.path 준비가 **서버 모듈 import 보다 먼저** 와야 한다.
sys.path.insert(0, str(Path(__file__).resolve().parent))
import server_env  # noqa: E402,F401

import db  # noqa: E402
import request_log  # noqa: E402

with patch.object(db, "init_db"):
    admin = importlib.import_module("app")


def fresh():
    """두 채널을 모두 비운다. 테스트끼리 기록이 새지 않게."""
    request_log.inbound.reset()
    request_log.upstream.reset()


def rec_up(**kw):
    base = dict(platform="coupang", method="GET", url="https://api-gateway.coupang.com/v2/x",
                status=200, duration_ms=12.0, body=b'{"ok":true}', user="admin",
                ts="2026-09-17T00:00:00+00:00")
    base.update(kw)
    request_log.record_upstream(**base)


def rec(**kw):
    base = dict(method="GET", path="/x", query="", status=200,
                duration_ms=1.0, ip="1.2.3.4", user="", ts="2026-09-17T00:00:00+00:00")
    base.update(kw)
    request_log.record(**base)


class QueryMaskingTests(unittest.TestCase):
    """쿼리스트링에 비밀값이 실려 와도 버퍼에 남지 않아야 한다."""

    def setUp(self):
        fresh()

    def test_allowlist_keeps_value(self):
        rec(query="platform=coupang")
        self.assertEqual(request_log.history()[0]["query"], "platform=coupang")

    def test_unknown_key_keeps_name_drops_value(self):
        rec(query="token=super-secret-value&platform=naver")
        q = request_log.history()[0]["query"]
        self.assertNotIn("super-secret-value", q, "비밀값이 버퍼에 남으면 안 된다")
        self.assertIn("token=", q, "어떤 파라미터였는지는 남아야 디버깅이 된다")
        self.assertIn("platform=naver", q)

    def test_no_query_is_empty(self):
        rec(query="")
        self.assertEqual(request_log.history()[0]["query"], "")

    def test_bare_key_without_equals(self):
        rec(query="debug")
        self.assertEqual(request_log.history()[0]["query"], "debug")

    def test_long_query_is_truncated(self):
        rec(query="platform=" + "a" * 500)
        self.assertLessEqual(len(request_log.history()[0]["query"]), 200)

    def test_long_path_is_truncated(self):
        rec(path="/" + "b" * 1000)
        self.assertLessEqual(len(request_log.history()[0]["path"]), 300)


class BufferTests(unittest.TestCase):
    def setUp(self):
        fresh()

    def test_history_is_capped(self):
        for i in range(request_log.MAX_HISTORY + 50):
            rec(path=f"/p{i}")
        self.assertEqual(len(request_log.history()), request_log.MAX_HISTORY)
        # 가장 오래된 것이 밀려나고 최신이 남는다
        self.assertEqual(request_log.history()[-1]["path"],
                         f"/p{request_log.MAX_HISTORY + 49}")

    def test_stream_path_is_not_recorded(self):
        rec(path="/logs/live/stream")
        self.assertEqual(request_log.history(), [],
                         "스트림 자신을 기록하면 화면이 자기를 비춘다")

    def test_record_never_raises(self):
        # 로깅이 요청을 죽이면 안 된다 — 이상한 값이 와도 조용히 넘어가야 한다.
        request_log.record(method=None, path=None, query=None, status="bad",
                           duration_ms=None, ip=None, user=None, ts=None)

    def test_history_returns_a_copy(self):
        rec()
        h = request_log.history()
        h.clear()
        self.assertEqual(len(request_log.history()), 1, "내부 버퍼가 밖에서 비워지면 안 된다")

    def test_ids_increase(self):
        rec(path="/a")
        rec(path="/b")
        ids = [e["id"] for e in request_log.history()]
        self.assertEqual(ids, sorted(ids))
        self.assertNotEqual(ids[0], ids[1])


class SubscriberTests(unittest.TestCase):
    def setUp(self):
        fresh()

    def test_subscriber_receives_entry(self):
        async def go():
            q = request_log.subscribe()
            rec(path="/hello")
            return await asyncio.wait_for(q.get(), timeout=1)
        entry = asyncio.run(go())
        self.assertEqual(entry["path"], "/hello")

    def test_slow_subscriber_is_skipped_not_blocking(self):
        """구독자 큐가 가득 차도 record() 가 막히거나 예외를 내면 안 된다."""
        async def go():
            q = request_log.subscribe()
            for i in range(request_log.SUBSCRIBER_QUEUE_MAX + 20):
                rec(path=f"/p{i}")
            return q.qsize()
        size = asyncio.run(go())
        self.assertEqual(size, request_log.SUBSCRIBER_QUEUE_MAX)
        # 버퍼 쪽에는 전부 들어가 있다(구독자만 건너뛴 것이다)
        self.assertEqual(len(request_log.history()),
                         min(request_log.MAX_HISTORY, request_log.SUBSCRIBER_QUEUE_MAX + 20))

    def test_unsubscribe_removes(self):
        async def go():
            q = request_log.subscribe()
            self.assertEqual(request_log.subscriber_count(), 1)
            request_log.unsubscribe(q)
            self.assertEqual(request_log.subscriber_count(), 0)
            request_log.unsubscribe(q)   # 두 번 빼도 터지지 않아야 한다
        asyncio.run(go())

    def test_sse_format_and_hangul(self):
        line = request_log.sse({"path": "/상품/등록"})
        self.assertTrue(line.startswith("data: "))
        self.assertTrue(line.endswith("\n\n"))
        self.assertIn("/상품/등록", line, "ensure_ascii=False 라야 한글이 안 깨진다")


class RouteAuthTests(unittest.TestCase):
    """요청 로그는 활동 내역이므로 관리자만 볼 수 있어야 한다."""

    def setUp(self):
        fresh()
        self.client = TestClient(admin.app)
        self.addCleanup(self.client.close)
        self.addCleanup(patch.stopall)

    def test_page_requires_login(self):
        with patch.object(admin, "current_user", return_value=None):
            r = self.client.get("/logs/live", follow_redirects=False)
        self.assertEqual(r.status_code, 303)
        self.assertEqual(r.headers["location"], "/login")

    def test_page_rejects_non_admin(self):
        staff = {"id": 2, "username": "s", "name": "직원", "role": "staff", "is_active": 1}
        with patch.object(admin, "current_user", return_value=staff):
            r = self.client.get("/logs/live", follow_redirects=False)
        self.assertEqual(r.status_code, 303)
        self.assertEqual(r.headers["location"], "/")

    def test_stream_requires_admin(self):
        with patch.object(admin, "current_user", return_value=None):
            r = self.client.get("/logs/live/stream")
        self.assertEqual(r.status_code, 401)

        staff = {"id": 2, "username": "s", "name": "직원", "role": "staff", "is_active": 1}
        with patch.object(admin, "current_user", return_value=staff):
            r = self.client.get("/logs/live/stream")
        self.assertEqual(r.status_code, 401)

    def test_admin_sees_page(self):
        boss = {"id": 1, "username": "admin", "name": "관리자", "role": "admin", "is_active": 1}
        rec(path="/coupang", status=200, user="admin")
        with patch.object(admin, "current_user", return_value=boss), \
                patch.object(db, "get_staff_by_id", return_value=boss):
            r = self.client.get("/logs/live")
        self.assertEqual(r.status_code, 200)
        self.assertIn("실시간 요청 로그", r.text)
        self.assertIn("/logs/live/stream", r.text, "EventSource 주소가 페이지에 있어야 한다")


class MiddlewareTests(unittest.TestCase):
    """미들웨어가 실제 요청을 잡아 버퍼에 넣는가."""

    def setUp(self):
        fresh()
        self.client = TestClient(admin.app)
        self.addCleanup(self.client.close)
        self.addCleanup(patch.stopall)

    def test_real_request_is_recorded(self):
        self.client.get("/login")
        paths = [e["path"] for e in request_log.history()]
        self.assertIn("/login", paths)
        entry = [e for e in request_log.history() if e["path"] == "/login"][0]
        self.assertEqual(entry["method"], "GET")
        self.assertEqual(entry["status"], 200)
        self.assertGreaterEqual(entry["ms"], 0)

    def test_status_is_recorded_for_404(self):
        self.client.get("/definitely-not-a-route")
        entry = [e for e in request_log.history()
                 if e["path"] == "/definitely-not-a-route"][0]
        self.assertEqual(entry["status"], 404)

    def test_query_secret_does_not_reach_buffer(self):
        self.client.get("/login?token=leak-me-please&platform=coupang")
        entry = [e for e in request_log.history() if e["path"] == "/login"][0]
        self.assertNotIn("leak-me-please", entry["query"])
        self.assertIn("platform=coupang", entry["query"])

    def test_no_headers_or_body_in_entry(self):
        self.client.get("/login", headers={"Authorization": "Bearer do-not-log-me"})
        entry = [e for e in request_log.history() if e["path"] == "/login"][0]
        blob = repr(entry)
        self.assertNotIn("do-not-log-me", blob)
        self.assertNotIn("Authorization", blob)


class UpstreamChannelTests(unittest.TestCase):
    """쇼핑몰 API 응답 채널 — 받아온 값을 담되, 보낸 인증은 담지 않는다."""

    def setUp(self):
        fresh()

    def test_body_is_kept(self):
        rec_up(body=b'{"data":{"sellerProductId":123}}')
        e = request_log.upstream.history()[0]
        self.assertIn("sellerProductId", e["body"], "받아온 값이 이 화면의 목적이다")
        self.assertEqual(e["platform"], "coupang")
        self.assertEqual(e["status"], 200)

    def test_large_body_is_truncated_but_size_kept(self):
        big = b'{"x":"' + b"a" * 200000 + b'"}'
        rec_up(body=big)
        e = request_log.upstream.history()[0]
        self.assertLessEqual(len(e["body"]), request_log.UPSTREAM_BODY_CHARS)
        self.assertEqual(e["size"], len(big), "원래 크기는 그대로 알려 줘야 한다")
        self.assertTrue(e["truncated"])

    def test_small_body_not_marked_truncated(self):
        rec_up(body=b'{"ok":1}')
        self.assertFalse(request_log.upstream.history()[0]["truncated"])

    def test_hangul_body_survives(self):
        rec_up(body='{"message":"상품이 등록되었습니다"}'.encode("utf-8"))
        self.assertIn("상품이 등록되었습니다", request_log.upstream.history()[0]["body"])

    def test_invalid_utf8_does_not_raise(self):
        rec_up(body=b"\xff\xfe\x00bad bytes")
        self.assertEqual(len(request_log.upstream.history()), 1)

    def test_error_entry_has_no_body(self):
        rec_up(status=504, body=b"", error="응답 시간 초과")
        e = request_log.upstream.history()[0]
        self.assertEqual(e["error"], "응답 시간 초과")
        self.assertEqual(e["size"], 0)

    def test_record_upstream_never_raises(self):
        request_log.record_upstream(platform=None, method=None, url=None, status=None,
                                    duration_ms=None, body=object(), user=None, ts=None)

    def test_two_channels_are_independent(self):
        rec(path="/login")
        rec_up(platform="naver")
        self.assertEqual(len(request_log.inbound.history()), 1)
        self.assertEqual(len(request_log.upstream.history()), 1)
        self.assertEqual(request_log.inbound.history()[0]["path"], "/login")
        self.assertEqual(request_log.upstream.history()[0]["platform"], "naver")

    def test_url_is_truncated(self):
        rec_up(url="https://api.example.com/" + "z" * 900)
        self.assertLessEqual(len(request_log.upstream.history()[0]["url"]), 400)


class UpstreamRouteTests(unittest.TestCase):
    def setUp(self):
        fresh()
        self.client = TestClient(admin.app)
        self.addCleanup(self.client.close)
        self.addCleanup(patch.stopall)
        self.boss = {"id": 1, "username": "admin", "name": "관리자",
                     "role": "admin", "is_active": 1}

    def test_page_requires_admin(self):
        with patch.object(admin, "current_user", return_value=None):
            r = self.client.get("/logs/api", follow_redirects=False)
        self.assertEqual(r.status_code, 303)

        staff = {"id": 2, "username": "s", "name": "직원", "role": "staff", "is_active": 1}
        with patch.object(admin, "current_user", return_value=staff):
            r = self.client.get("/logs/api", follow_redirects=False)
        self.assertEqual(r.status_code, 303)
        self.assertEqual(r.headers["location"], "/")

    def test_stream_requires_admin(self):
        with patch.object(admin, "current_user", return_value=None):
            self.assertEqual(self.client.get("/logs/api/stream").status_code, 401)

    def test_admin_sees_response_body_on_page(self):
        rec_up(body=b'{"marker":"COUPANG-REPLY"}')
        with patch.object(admin, "current_user", return_value=self.boss), \
                patch.object(db, "get_staff_by_id", return_value=self.boss):
            r = self.client.get("/logs/api")
        self.assertEqual(r.status_code, 200)
        self.assertIn("쇼핑몰 API 응답", r.text)
        self.assertIn("COUPANG-REPLY", r.text, "받아온 본문이 화면 데이터에 있어야 한다")
        self.assertIn("/logs/api/stream", r.text)


class StreamGeneratorTests(unittest.TestCase):
    """SSE 제너레이터가 열리고·밀어 주고·닫히면서 구독을 반납하는가.

    HTTP 전송 계층은 여기서 **일부러 빼고** 제너레이터만 본다.
    (httpx.ASGITransport 로 감싸면 응답을 통째로 모으느라 테스트가 영영 안 끝난다 —
     전송 계층까지 포함한 실측은 uvicorn + `curl -N` 으로 따로 했고,
     ': connected' 가 2초 시점에 13바이트로 먼저 도착하는 것을 확인했다.
     그 실측은 자동화하지 않는다. 테스트가 포트를 열고 프로세스를 띄우기 시작하면
     CI 에서 가장 먼저 불안정해지는 종류의 테스트가 되기 때문이다.)

    모든 await 에 타임아웃이 있다 — 고장이 '실패'로 나야지 '멈춤'으로 나면 안 된다.
    """

    def setUp(self):
        fresh()
        self.addCleanup(patch.stopall)
        self.boss = {"id": 1, "username": "admin", "name": "관리자",
                     "role": "admin", "is_active": 1}

    @staticmethod
    def _request():
        from starlette.requests import Request
        return Request({"type": "http", "method": "GET", "path": "/logs/live/stream",
                        "headers": [], "query_string": b""})

    def test_generator_opens_pushes_and_releases(self):
        async def go():
            resp = await admin.logs_live_stream(self._request())
            self.assertEqual(resp.media_type, "text/event-stream")
            it = resp.body_iterator

            opening = await asyncio.wait_for(it.__anext__(), timeout=2)
            self.assertIn("connected", opening)
            self.assertEqual(request_log.subscriber_count(), 1)

            rec(path="/gen-check", status=201, user="관리자")
            chunk = await asyncio.wait_for(it.__anext__(), timeout=2)

            await it.aclose()          # 브라우저가 창을 닫은 것과 같다
            return chunk, request_log.subscriber_count()

        with patch.object(admin, "current_user", return_value=self.boss):
            chunk, after = asyncio.run(go())

        self.assertTrue(chunk.startswith("data: "), chunk[:80])
        self.assertIn("/gen-check", chunk)
        self.assertIn("201", chunk)
        self.assertIn("관리자", chunk, "한글이 깨지면 안 된다")
        self.assertEqual(after, 0, "연결이 닫혔는데 구독이 남아 있다")

    def test_unauthorized_returns_401_not_a_stream(self):
        async def go():
            return await admin.logs_live_stream(self._request())

        with patch.object(admin, "current_user", return_value=None):
            resp = asyncio.run(go())
        self.assertEqual(resp.status_code, 401)
        self.assertEqual(request_log.subscriber_count(), 0,
                         "인증 실패인데 구독을 만들면 구독자 목록이 오염된다")


if __name__ == "__main__":
    unittest.main(verbosity=2)
