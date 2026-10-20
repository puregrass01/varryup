"""Offline route tests; never open the real staff database or master key."""
import importlib
import json
from pathlib import Path
import sys
import time
import unittest
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient

# 환경변수·sys.path 준비가 **서버 모듈 import 보다 먼저** 와야 한다.
# (config/public/ebay_notify 는 import 시점에 환경변수를 검사하고 없으면 기동을 거부한다)
sys.path.insert(0, str(Path(__file__).resolve().parent))
import server_env  # noqa: E402,F401

import db  # noqa: E402

# init_db 만 막으면 실제 server/admin.db 는 열리지 않는다(아래 테스트는 전부 mock 을 쓴다).
with patch.object(db, "init_db"):
    admin = importlib.import_module("app")
import proxy
import request_log


class ProxyTests(unittest.TestCase):
    def setUp(self):
        self.user = {"id": 1, "username": "tester", "is_active": 1}
        self.addCleanup(patch.stopall)
        patch.object(db, "get_staff_by_id", return_value=self.user).start()
        self.public_host = patch.object(proxy, "_is_public_host", return_value=True).start()
        self.client = TestClient(admin.app)
        self.addCleanup(self.client.close)
        self.headers = {"Authorization": "Bearer " + admin.api_signer.dumps({"uid": 1})}
        self.requests = []
        self.upstream = lambda request: httpx.Response(200, json={"ok": True})
        original_client = httpx.AsyncClient

        def respond(request):
            self.requests.append(request)
            return self.upstream(request)

        def client_factory(**kwargs):
            return original_client(transport=httpx.MockTransport(respond), **kwargs)

        patch.object(proxy.httpx, "AsyncClient", side_effect=client_factory).start()
        # 호출 간격 기록은 프로세스 전역이다. 테스트마다 새로 시작해 서로 기다리지 않게 한다.
        patch.object(proxy, "_pacer", proxy._Pacer()).start()

    def post(self, payload, route="/ebay"):
        return self.client.post(route, headers={**self.headers, "Content-Type": "application/json"}, content=json.dumps(payload))

    def envelope(self, **overrides):
        return {"method": "GET", "url": "https://api.sandbox.ebay.com/sell/inventory/v1/inventory_item", "headers": {"Authorization": "Bearer ebay-access"}, **overrides}

    # ── /logs/api 실시간 화면에 들어갈 기록 ──────────────────
    def test_upstream_reply_reaches_the_live_buffer(self):
        """쇼핑몰이 돌려준 값이 실시간 버퍼에 담겨야 화면에 보인다."""
        request_log.upstream.reset()
        self.upstream = lambda r: httpx.Response(201, json={"sellerProductId": 987654})
        self.post(self.envelope(method="POST", body={"x": 1}))

        entries = request_log.upstream.history()
        self.assertEqual(len(entries), 1)
        e = entries[0]
        self.assertEqual(e["platform"], "ebay")
        self.assertEqual(e["status"], 201)
        self.assertEqual(e["method"], "POST")
        self.assertIn("987654", e["body"], "받아온 값이 담겨야 한다 — 그게 이 화면의 목적")
        self.assertEqual(e["user"], "tester")
        self.assertGreaterEqual(e["ms"], 0)

    def test_live_buffer_never_stores_upstream_credentials(self):
        """상단 인증 헤더(서명·토큰)는 어떤 경우에도 버퍼에 남으면 안 된다."""
        request_log.upstream.reset()
        self.post(self.envelope(headers={"Authorization": "Bearer SECRET-EBAY-TOKEN",
                                         "X-EBAY-C-MARKETPLACE-ID": "EBAY_US"}))
        blob = json.dumps(request_log.upstream.history(), ensure_ascii=False)
        self.assertNotIn("SECRET-EBAY-TOKEN", blob)
        self.assertNotIn("Authorization", blob)

    def test_transport_failure_is_recorded_with_reason(self):
        """연결이 안 되면 그 사실이 화면에 보여야 한다(조용히 사라지면 안 된다)."""
        request_log.upstream.reset()

        def boom(r):
            raise httpx.ConnectError("no route", request=r)
        self.upstream = boom
        r = self.post(self.envelope())
        self.assertEqual(r.status_code, 502)

        entries = request_log.upstream.history()
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["status"], 502)
        self.assertIn("연결 실패", entries[0]["error"])

    def test_client_still_receives_the_full_body_when_log_truncates(self):
        """로그는 잘라도 **앱으로 가는 응답은 원문 그대로**여야 한다.

        여기서 자르면 coupang_api.js / amazon_api.js 의 JSON 파싱이 깨진다.
        """
        request_log.upstream.reset()
        big = {"items": ["x" * 100] * 200}
        self.upstream = lambda r: httpx.Response(200, json=big)
        r = self.post(self.envelope())

        self.assertEqual(r.json(), big, "릴레이 응답이 잘리면 안 된다")
        e = request_log.upstream.history()[0]
        self.assertTrue(e["truncated"])
        self.assertLessEqual(len(e["body"]), request_log.UPSTREAM_BODY_CHARS)
        self.assertEqual(e["size"], len(r.content))

    # ── 실패 응답 본문을 journald 에 남기기 ──────────────────
    def test_failed_upstream_logs_its_body(self):
        """403 의 원인 코드는 본문에 있다. 메모리 버퍼는 재시작하면 사라지므로 로그에도 남긴다."""
        self.upstream = lambda r: httpx.Response(
            403, json={"code": "GROUP_NOT_AUTHORIZED", "message": "권한이 없습니다"})
        with self.assertLogs("veryup.proxy", level="WARNING") as captured:
            r = self.post(self.envelope())
        self.assertEqual(r.status_code, 403)
        blob = "\n".join(captured.output)
        self.assertIn("GROUP_NOT_AUTHORIZED", blob, "거절 사유 코드가 로그에 있어야 한다")
        self.assertIn("403", blob)
        self.assertIn("ebay", blob)

    def test_successful_upstream_body_is_not_logged(self):
        """성공 본문에는 토큰이 들어오는 경로가 있다(/oauth2/token). 절대 남기지 않는다."""
        self.upstream = lambda r: httpx.Response(
            200, json={"access_token": "SHOULD-NEVER-BE-LOGGED", "expires_in": 10800})
        with self.assertLogs("veryup.proxy", level="DEBUG") as captured:
            # 감사 로그(INFO) 는 남으므로 assertLogs 는 성립한다. 본문만 없어야 한다.
            self.post(self.envelope())
        blob = "\n".join(captured.output)
        self.assertNotIn("SHOULD-NEVER-BE-LOGGED", blob)
        self.assertNotIn("실패본문", blob)

    def test_error_body_is_truncated(self):
        big = {"message": "x" * 5000}
        self.upstream = lambda r: httpx.Response(500, json=big)
        with self.assertLogs("veryup.proxy", level="WARNING") as captured:
            self.post(self.envelope())
        line = [l for l in captured.output if "실패본문" in l][0]
        self.assertLess(len(line), proxy.ERROR_BODY_LOG_BYTES + 400,
                        "본문을 통째로 남기면 journald 가 밀려난다")

    def test_error_log_has_no_request_credentials(self):
        self.upstream = lambda r: httpx.Response(401, json={"error": "invalid_token"})
        with self.assertLogs("veryup.proxy", level="WARNING") as captured:
            self.post(self.envelope(headers={"Authorization": "Bearer UPSTREAM-SECRET"}))
        blob = "\n".join(captured.output)
        self.assertNotIn("UPSTREAM-SECRET", blob, "상단 인증 서명은 로그에 남으면 안 된다")

    def test_auth_required_invalid_expired_and_disabled(self):
        for headers in [{}, {"Authorization": "Bearer invalid"}]:
            self.assertEqual(self.client.post("/ebay", headers=headers, json=self.envelope()).status_code, 401)
        with patch("time.time", return_value=time.time() - admin.API_TOKEN_MAX_AGE - 10):
            expired = admin.api_signer.dumps({"uid": 1})
        self.assertEqual(self.client.post("/ebay", headers={"Authorization": "Bearer " + expired}, json=self.envelope()).status_code, 401)
        self.user["is_active"] = 0
        self.assertEqual(self.post(self.envelope()).status_code, 401)
        self.assertEqual(self.requests, [])

    def test_environments_preserve_bytes_query_status_and_headers(self):
        for host in ["api.ebay.com", "api.sandbox.ebay.com"]:
            self.upstream = lambda r: httpx.Response(429, content=b'{"errors":[{"errorId":1}]}', headers={"Retry-After": "4", "Content-Type": "application/json"})
            url = f"https://{host}/sell/inventory/v1/offer?sku=A%2FB%20C&x=%2B"
            body = '{"title":"유리"}'
            result = self.post(self.envelope(url=url, method="PUT", body=body, headers={"Authorization": "Bearer ebay-access", "Content-Type": "application/json", "Host": "evil.example", "Connection": "x-drop", "x-drop": "secret", "Proxy-Authorization": "secret"}))
            sent = self.requests[-1]
            self.assertEqual(str(sent.url), url)
            self.assertEqual(sent.method, "PUT")
            self.assertEqual(sent.content, body.encode())
            self.assertEqual(sent.headers["authorization"], "Bearer ebay-access")
            self.assertEqual(sent.headers["host"], host)
            self.assertNotIn("proxy-authorization", sent.headers)
            self.assertNotIn("x-drop", sent.headers)
            self.assertNotIn(self.headers["Authorization"], str(sent.headers))
            self.assertEqual(result.status_code, 429)
            self.assertEqual(result.content, b'{"errors":[{"errorId":1}]}')
            self.assertEqual(result.headers["retry-after"], "4")

    def test_existing_platform_contracts(self):
        cases = [("coupang", {"path": "/v2/test?a=%2F&b=two"}, "api-gateway.coupang.com"), ("naver", {"path": "/external/v1/test"}, "api.commerce.naver.com"), ("amazon", {"url": "https://sellingpartnerapi-fe.amazon.com/listings/test"}, "sellingpartnerapi-fe.amazon.com")]
        for platform, target, host in cases:
            with self.subTest(platform=platform):
                result = self.post({"method": "GET", **target}, "/" + platform)
                self.assertEqual(result.status_code, 200)
                self.assertEqual(self.requests[-1].url.host, host)

    def test_invalid_targets_never_reach_network(self):
        for url in ["http://api.ebay.com/sell/test", "https://evil.example/test", "https://api.ebay.com.evil.example/test", "https://api.ebay.com:8443/test", "https://api.ebay.com:bad/test", "https://user:pass@api.ebay.com/test", "https://api.ebay.com/test#fragment", "https://[broken", "https://api.ebay.com/te\nst", "https://api.ebay.com\\@evil.example/test"]:
            with self.subTest(url=url):
                self.assertEqual(self.post(self.envelope(url=url)).status_code, 400)
        self.assertEqual(self.post(self.envelope(path="/test")).status_code, 400)
        self.assertEqual(self.post({"path": "/test"}).status_code, 400)
        self.assertEqual(self.requests, [])

    def test_malformed_envelopes_are_client_errors(self):
        for payload in [[], None, {}, self.envelope(headers=[]), self.envelope(headers={"x-bad": "a\r\nb"}), self.envelope(headers={"x-bad": {}}), self.envelope(body=123), self.envelope(body="\ud800")]:
            with self.subTest(payload=repr(payload)):
                self.assertEqual(self.post(payload).status_code, 400)
        for content in [b"{", b"\xff"]:
            self.assertEqual(self.client.post("/ebay", headers=self.headers, content=content).status_code, 400)
        self.assertEqual(self.post(self.envelope(method="CONNECT")).status_code, 405)
        self.assertEqual(self.requests, [])

    def test_private_dns_and_size_limits(self):
        self.public_host.return_value = False
        self.assertEqual(self.post(self.envelope()).status_code, 502)
        self.public_host.return_value = True
        with patch.object(proxy, "MAX_REQUEST_BYTES", 10):
            self.assertEqual(self.post(self.envelope()).status_code, 413)
        self.assertEqual(self.requests, [])
        self.upstream = lambda r: httpx.Response(200, content=b"12345678901")
        with patch.object(proxy, "MAX_RESPONSE_BYTES", 10):
            self.assertEqual(self.post(self.envelope()).status_code, 502)

    def test_redirects_cannot_replay_credentials(self):
        for status in [301, 302, 303, 307, 308]:
            self.upstream = lambda r: httpx.Response(status, headers={"Location": "https://evil.example/"})
            result = self.post(self.envelope(method="POST", body="{}"))
            self.assertEqual(result.status_code, 502)
            self.assertTrue(result.json()["proxyError"])
            self.assertNotIn("location", result.headers)
        self.assertEqual(len(self.requests), 5)

    def test_transport_errors_do_not_retry_writes(self):
        for error, status in [(httpx.ReadTimeout("timeout"), 504), (httpx.ConnectError("failure"), 502)]:
            def fail(r):
                raise error
            self.upstream = fail
            result = self.post(self.envelope(method="POST", body="{}"))
            self.assertEqual(result.status_code, status)
            self.assertTrue(result.json()["proxyError"])
        self.assertEqual(len(self.requests), 2)

    def test_empty_response_and_hop_headers(self):
        self.upstream = lambda r: httpx.Response(204, headers={"Connection": "x-private", "x-private": "drop", "Set-Cookie": "foreign=yes", "x-ebay-request-id": "123"})
        result = self.post(self.envelope(method="DELETE"))
        self.assertEqual(result.status_code, 204)
        self.assertEqual(result.content, b"")
        self.assertNotIn("x-private", result.headers)
        self.assertNotIn("set-cookie", result.headers)
        self.assertEqual(result.headers["x-ebay-request-id"], "123")

    def test_health_requires_auth_and_includes_ebay(self):
        self.assertEqual(self.client.get("/proxy/health").status_code, 401)
        self.upstream = lambda r: httpx.Response(200, text="8.8.8.8")
        result = self.client.get("/proxy/health", headers=self.headers).json()
        self.assertIn("ebay", result["platforms"])
        self.assertEqual(result["outboundIp"], "8.8.8.8")

    # ── 공용 호출 간격 (여러 직원이 같은 앱 키를 나눠 씀) ────────
    def stamp(self, status=200, body=None):
        times = []

        def upstream(request):
            times.append(time.monotonic())
            return httpx.Response(status, json=body if body is not None else {"ok": True})
        self.upstream = upstream
        return times

    def naver(self, path):
        return self.post({"method": "GET", "path": path, "headers": {"Authorization": "Bearer n"}}, route="/naver")

    def coupang(self, vendor="A0001"):
        return self.post({"method": "GET", "path": "/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/1",
                          "headers": {"Authorization": "CEA x", "X-Requested-By": vendor}}, route="/coupang")

    def test_same_api_is_spaced(self):
        """번호만 다른 같은 API 는 간격을 두고 상단에 나간다."""
        times = self.stamp()
        with patch.dict(proxy.PACE_SECONDS, {"naver": 0.3}):
            self.assertEqual(self.naver("/external/v2/products/origin-products/1").status_code, 200)
            self.assertEqual(self.naver("/external/v2/products/origin-products/2").status_code, 200)
        self.assertGreaterEqual(times[1] - times[0], 0.28)

    def test_different_apis_are_not_spaced(self):
        times = self.stamp()
        with patch.dict(proxy.PACE_SECONDS, {"naver": 1.0}):
            self.naver("/external/v2/products/origin-products/1")
            self.naver("/external/v1/products/search")
        self.assertLess(times[1] - times[0], 0.9)

    def test_full_queue_returns_proxy_429_without_calling_upstream(self):
        self.stamp()
        with patch.dict(proxy.PACE_SECONDS, {"naver": 5.0}), patch.object(proxy, "PACE_MAX_WAIT", 1.0):
            self.naver("/external/v2/products/origin-products/1")
            result = self.naver("/external/v2/products/origin-products/2")
        self.assertEqual(result.status_code, 429)
        self.assertTrue(result.json()["proxyError"], "앱이 서버 대기 거절을 마켓플레이스 오류와 구분해야 한다")
        self.assertEqual(len(self.requests), 1)

    def test_coupang_429_pauses_that_vendor_only(self):
        """쿠팡이 막으면 같은 판매자로는 잠시 보내지 않는다(막힌 동안 부르면 차단이 길어진다)."""
        self.stamp(429, {"code": "ERROR", "message": "too many requests"})
        first = self.coupang()
        self.assertEqual(first.status_code, 429)
        self.assertNotIn("proxyError", first.json(), "상단 429 는 그대로 전달한다")
        self.stamp()
        second = self.coupang()
        self.assertEqual(second.status_code, 429)
        self.assertTrue(second.json()["proxyError"])
        self.assertIn("초 동안", second.json()["message"])
        self.assertEqual(len(self.requests), 1, "쉬는 동안에는 상단에 보내지 않는다")
        self.assertEqual(self.coupang("B0002").status_code, 200, "다른 판매자는 영향이 없다")

    def test_ebay_is_not_paced(self):
        times = self.stamp()
        self.post(self.envelope())
        self.post(self.envelope())
        self.assertLess(times[1] - times[0], 0.2)

    def test_api_template_hides_ids(self):
        self.assertEqual(proxy._api_template("/external/v2/products/origin-products/123?x=1"), "/external/v2/products/origin-products/{id}")
        self.assertEqual(proxy._pace_key("amazon", "https://sellingpartnerapi-na.amazon.com/listings/2021-08-01/items/A1B2C3D4E5F6G7/SKU-1", {}),
                         "amazon:/listings/2021-08-01/items")


if __name__ == "__main__":
    unittest.main()
