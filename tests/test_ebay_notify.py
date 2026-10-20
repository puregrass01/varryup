"""무인증 eBay 계정 삭제 알림 엔드포인트 오프라인 테스트. 네트워크도 admin.db 도 건드리지 않는다.

표면 분리(2026-09-16) 이후 이 파일이 통째로 달라진 점 — 되돌리지 말 것
  · 이 경로는 **공개 프로세스 전용**이다. app.app(내부)에는 ebay_notify.router 가 없어
    거기다 대고 POST 하면 404 다. 그래서 라우터만 임시 앱에 올려 검사한다
    (serve_public 자체는 import 할 수 없다 — 같은 프로세스에서 다른 테스트가 db 를 import 하면
     그쪽 모듈 격리 점검이 STRICT 와 무관하게 기동을 거부한다).
  · POST 는 더 이상 인증키를 삭제하지 않는다. 검증을 통과한 건을 ebay_queue 의 pending 큐에
    적재만 하고, 실제 삭제는 내부 프로세스에서 관리자가 승인할 때 한다.
    따라서 예전의 'sweep' 테스트(db.delete_credential 호출 여부)는 검사할 대상 자체가 없어졌다.
  · 영수증 로그 상수는 ebay_notify.DELETION_LOG → **ebay_queue.RECEIPT_LOG** 로 옮겼다.
  · 서명을 실제로 ECDSA 검증한다. 오프라인에서 진짜 eBay 공개키를 받을 수는 없으므로,
    '통과한 뒤의 동작'을 보는 테스트만 _verify_notification 을 대역으로 바꾼다.
    거절 경로는 대역 없이 **실제 코드 그대로** 돌린다 — 위조가 통과하지 않는다는 것이 요점이라서.
"""
import base64
import hashlib
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent))
import server_env  # noqa: E402,F401  (환경변수·sys.path 준비가 먼저)

import ebay_notify  # noqa: E402
import ebay_queue  # noqa: E402

# 검증 토큰·엔드포인트는 배포 환경변수에서 오므로, 테스트는 항상 자기 값으로 덮어써서
# 이 머신의 환경변수와 무관하게 같은 결과가 나오게 한다.
TOKEN = "offline-verification-token-0123456789"
ENDPOINT = "https://admin.example.test/ebay/deletion"


def _app() -> FastAPI:
    """공개 프로세스가 올리는 것과 같은 라우터만 담은 임시 앱."""
    app = FastAPI()
    app.include_router(ebay_notify.router)
    return app


class _EbayEndpointBase(unittest.TestCase):
    def setUp(self):
        self.addCleanup(patch.stopall)
        workspace = tempfile.TemporaryDirectory()
        self.addCleanup(workspace.cleanup)
        self.queue_dir = Path(workspace.name)
        # 큐·영수증·격리 파일을 매 테스트마다 빈 임시 디렉터리로 돌린다.
        # _initialized 를 내려야 _ensure() 가 새 경로에 표를 다시 만든다.
        self.log_path = self.queue_dir / "ebay_deletions.jsonl"
        patch.object(ebay_queue, "DB_PATH", str(self.queue_dir / "ebay_queue.db")).start()
        patch.object(ebay_queue, "RECEIPT_LOG", str(self.log_path)).start()
        patch.object(ebay_queue, "QUARANTINE_LOG", str(self.queue_dir / "q.jsonl")).start()
        patch.object(ebay_queue, "QUARANTINE_UNVERIFIED_LOG", str(self.queue_dir / "q-unverified.jsonl")).start()
        patch.object(ebay_queue, "_initialized", False).start()
        ebay_queue.init()

        patch.object(ebay_notify, "VERIFICATION_TOKEN", TOKEN).start()
        patch.object(ebay_notify, "ENDPOINT_URL", ENDPOINT).start()
        # 레이트리밋 창은 프로세스 전역이라 테스트끼리 예산을 나눠 쓰게 된다
        # (테스트 하나가 이웃 테스트를 429 로 떨어뜨린다). 매번 넉넉한 새 카운터로 갈아 끼운다.
        # 상한 자체는 아래 전용 테스트가 작은 카운터로 따로 검사한다.
        patch.object(ebay_notify, "_limiter", self._limiter(10_000, 10_000)).start()
        patch.object(ebay_notify, "_keyfetch_limiter", self._limiter(10_000, 10_000)).start()
        # 오프라인 보장 — 잘 만들어진 서명 헤더는 eBay 공개키 API 로 **실제 아웃바운드 호출**을
        # 유발한다. 테스트가 네트워크에 나가면 느려지고, 회선 상태에 따라 결과가 바뀐다.
        # 기본값은 '모르는 kid'(= 위조 취급, 200) 로 세우고, 통과 경로는 verified_signature() 가 덮는다.
        async def _unknown_kid(kid, ip):
            return None, "", "unknown-kid"

        patch.object(ebay_notify, "_fetch_public_key", _unknown_kid).start()

        self.path = ebay_notify._PATH
        self.client = TestClient(_app())
        self.addCleanup(self.client.close)

    @staticmethod
    def _limiter(per_key: int, glob: int):
        return ebay_notify._FixedWindowLimiter(
            per_key_limit=per_key, global_limit=glob, name="test")

    # ── 헬퍼 ────────────────────────────────────────────────
    def signature(self, **overrides):
        """eBay 가 보내는 x-ebay-signature 모양(base64 로 감싼 JSON)을 흉내낸다."""
        fields = {"alg": "ecdsa", "kid": "key-1", "signature": "c2lnbmF0dXJl", "digest": "SHA1"}
        fields.update(overrides)
        return base64.b64encode(json.dumps(fields).encode()).decode()

    _KEEP = object()   # "값을 주지 않았다"와 "빈 값을 일부러 줬다"를 구분하는 표식

    def notice(self, user_id="ebay-user-5f3", notification_id="notif-1", event_date=_KEEP, **data):
        return {
            "metadata": {"topic": "MARKETPLACE_ACCOUNT_DELETION"},
            "notification": {
                "notificationId": notification_id,
                # 기본값은 '지금'. 하드코딩한 날짜를 쓰면 EBAY_EVENT_MAX_AGE_HOURS(기본 168시간)가
                # 지나는 순간 테스트가 저절로 빨개진다.
                "eventDate": (datetime.now(timezone.utc).isoformat()
                              if event_date is self._KEEP else event_date),
                "data": {"userId": user_id, "username": "buyer-one", **data},
            },
        }

    def post(self, body, header=None, **kwargs):
        headers = {"Content-Type": "application/json"}
        if header is None:
            header = self.signature()
        if header is not False:
            headers["x-ebay-signature"] = header
        content = body if isinstance(body, (bytes, str)) else json.dumps(body)
        return self.client.post(self.path, headers=headers, content=content, **kwargs)

    def receipts(self):
        if not self.log_path.exists():
            return []
        return [json.loads(line) for line in self.log_path.read_text(encoding="utf-8").splitlines() if line.strip()]

    def pending(self):
        return [dict(row) for row in ebay_queue.list_pending()]

    def rejections(self):
        return [dict(row) for row in ebay_queue.recent_rejections()]

    def assertNothingQueued(self):
        """큐에 들어간 것도, 사람이 읽는 영수증도 없어야 한다."""
        self.assertEqual(self.pending(), [])
        self.assertEqual(self.receipts(), [])

    def verified_signature(self, kid="key-1"):
        """서명 검증을 통과한 것으로 세운다.

        진짜 eBay 공개키를 오프라인에서 받아올 수는 없으므로, '검증 통과 이후' 동작을 보는
        테스트만 이 대역을 쓴다. 거절 경로 테스트에는 절대 쓰지 않는다.
        """
        async def _ok(raw_header, payload, ip):
            return True, "verified", kid

        return patch.object(ebay_notify, "_verify_notification", _ok)


class EbayChallengeTests(_EbayEndpointBase):
    """GET — eBay 엔드포인트 검증. 이 응답 규격이 곧 심사 통과 조건이다."""

    def test_challenge_requires_code_and_matches_independent_hash(self):
        missing = self.client.get(self.path)
        self.assertEqual(missing.status_code, 400)
        self.assertNotIn("challengeResponse", missing.json())

        for code in ["a1b2c3", "코드-한글", "0" * 64]:
            with self.subTest(code=code):
                response = self.client.get(self.path, params={"challenge_code": code})
                self.assertEqual(response.status_code, 200)
                self.assertTrue(response.headers["content-type"].startswith("application/json"))
                # 모듈의 헬퍼를 부르지 않고 규격(challengeCode + verificationToken + endpointURL)대로 직접 계산한다.
                expected = hashlib.sha256((code + TOKEN + ENDPOINT).encode("utf-8")).hexdigest()
                self.assertEqual(response.json()["challengeResponse"], expected)

    def test_production_challenge_regression_vector(self):
        """운영 값으로 고정한 회귀 기준. 이 해시가 틀리면 eBay 엔드포인트 등록이 깨진다.

        토큰·엔드포인트는 공개 포털에 등록된 값이라 비밀이 아니다(토큰은 회전 대상일 뿐).
        절대 바꾸지 말 것 — 바꾸려면 eBay 포털 등록값을 먼저 바꿔야 한다.
        """
        prod_token = "opticgla-r-PRD-382a9c2a1-1d064d46"
        prod_endpoint = "https://admin.veryup-domain.duckdns.org/ebay/deletion"
        with patch.object(ebay_notify, "VERIFICATION_TOKEN", prod_token), \
                patch.object(ebay_notify, "ENDPOINT_URL", prod_endpoint):
            response = self.client.get(self.path, params={"challenge_code": "test123"})
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.headers["content-type"].startswith("application/json"))
        self.assertEqual(
            response.json(),
            {"challengeResponse": "99d7bb5e59f55ac258839ccb1f5c90cd90e3f89020572c0f4e46d2ae14a2d6bf"},
        )

    def test_challenge_hash_depends_on_token_and_endpoint(self):
        base = self.client.get(self.path, params={"challenge_code": "a1b2c3"}).json()["challengeResponse"]
        with patch.object(ebay_notify, "ENDPOINT_URL", ENDPOINT + "/other"):
            moved = self.client.get(self.path, params={"challenge_code": "a1b2c3"}).json()["challengeResponse"]
        with patch.object(ebay_notify, "VERIFICATION_TOKEN", TOKEN[::-1]):
            rotated = self.client.get(self.path, params={"challenge_code": "a1b2c3"}).json()["challengeResponse"]
        self.assertEqual(len({base, moved, rotated}), 3)

    def test_challenge_without_token_fails_loudly_instead_of_hashing(self):
        with patch.object(ebay_notify, "VERIFICATION_TOKEN", ""):
            response = self.client.get(self.path, params={"challenge_code": "a1b2c3"})
        self.assertEqual(response.status_code, 503)
        self.assertNotIn("challengeResponse", response.json())

    def test_route_path_never_shadows_the_dashboard(self):
        # EBAY_DELETION_ENDPOINT 가 이상해도 "/" 같은 경로를 잡아채면 관리자 대시보드가 사라진다.
        for endpoint in ["https://admin.example.test/", "https://admin.example.test", "", "not a url", "https://admin.example.test//", "https://admin.example.test/a/b/c/d/e/f/g"]:
            with self.subTest(endpoint=endpoint):
                with self.assertRaises(RuntimeError):
                    ebay_notify._route_path(endpoint)
        self.assertEqual(ebay_notify._route_path("https://admin.example.test/ebay/deletion"), "/ebay/deletion")


class EbayRejectionTests(_EbayEndpointBase):
    """POST 거절 경로 — 대역 없이 실제 검증 코드를 돌린다."""

    def test_unsigned_or_forged_post_never_queues_and_leaves_a_rejection(self):
        forged = [
            ("헤더 없음", False),
            ("빈 헤더", ""),
            ("base64 아님", "this-is-not-base64!!"),
            ("JSON 객체 아님", base64.b64encode(b"[]").decode()),
            ("JSON 아님", base64.b64encode(b"not json").decode()),
            ("digest 누락", self.signature(digest=None)),
            ("kid 가 빈 문자열", self.signature(kid="   ")),
            ("signature 가 숫자", self.signature(signature=1234)),
            ("헤더 과대", base64.b64encode(b"x" * ebay_notify.MAX_SIGNATURE_HEADER).decode()),
        ]
        for name, header in forged:
            with self.subTest(case=name):
                response = self.post(self.notice(), header=header)
                # 상대가 가짜인 건은 재시도해도 결과가 같으므로 200 이다(eBay 재시도 유발 금지).
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json(), {"ok": True})
                self.assertNothingQueued()
        # 다만 '조용히 버리지는 않는다' — 거절 사유가 전부 남아야 한다(감사 §28).
        self.assertEqual(len(self.rejections()), len(forged))

    def test_missing_ebay_credentials_asks_ebay_to_retry(self):
        # 자격증명이 없으면 '검증을 못 한 것'이지 '가짜'가 아니다.
        # 200 을 주면 그 알림은 영구 소실되므로 반드시 5xx 여야 한다.
        with patch.object(ebay_notify, "_HAS_EBAY_CREDS", False):
            response = self.post(self.notice())
        self.assertEqual(response.status_code, 503)
        self.assertIn("retry-after", {k.lower() for k in response.headers})
        self.assertNothingQueued()
        self.assertEqual(self.rejections()[0]["reason"], "no-ebay-credentials")

    def test_oversized_body_is_discarded_without_queueing(self):
        body = self.notice()
        body["notification"]["data"]["padding"] = "A" * (ebay_notify.MAX_NOTIFICATION_BYTES + 1)
        response = self.post(body)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"ok": True})
        self.assertNothingQueued()
        self.assertEqual(self.rejections()[0]["reason"], "oversized-body")

    def test_body_size_cap_is_enforced_at_the_limit(self):
        with patch.object(ebay_notify, "MAX_NOTIFICATION_BYTES", 32):
            response = self.post(self.notice())
        self.assertEqual(response.status_code, 200)
        self.assertNothingQueued()

    def test_rate_limit_asks_for_a_retry_instead_of_dropping(self):
        # 레이트리밋은 '가짜라서'가 아니라 '지금 우리가 못 받아서' 버리는 것이다.
        # 200 을 주면 그 한 건이 영구 소실되므로 429 + Retry-After 여야 한다.
        with patch.object(ebay_notify, "_limiter", self._limiter(1, 100)):
            first = self.post(self.notice(), header=False)
            second = self.post(self.notice(notification_id="notif-2"), header=False)
        self.assertEqual(first.status_code, 200)     # 서명이 없어 거절되지만 상한에는 안 걸린다
        self.assertEqual(second.status_code, 429)
        self.assertEqual(second.headers["retry-after"], str(ebay_notify.RETRY_AFTER_SEC))
        self.assertNothingQueued()


class EbayQueueingTests(_EbayEndpointBase):
    """POST 통과 경로 — 서명 검증을 통과한 뒤 무엇을 하는가."""

    def test_verified_notice_is_queued_not_deleted(self):
        with self.verified_signature():
            response = self.post(self.notice("ebay-user-5f3"))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"ok": True})

        rows = self.pending()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["user_id"], "ebay-user-5f3")
        self.assertEqual(rows[0]["topic"], "MARKETPLACE_ACCOUNT_DELETION")
        self.assertEqual(rows[0]["notification_id"], "notif-1")
        # 이행은 내부 프로세스에서 관리자가 승인할 때 한다 — 이 경로는 '대기'까지만이다.
        self.assertEqual(rows[0]["status"], "pending")

        receipt = self.receipts()[-1]
        self.assertTrue(receipt["verified"])
        self.assertEqual(receipt["queue"], "queued")
        # 이 경로에는 인증키를 지우는 코드가 아예 없다. 영수증이 그 사실을 말해 준다.
        self.assertFalse(receipt["purged"])

    def test_resent_notification_is_absorbed_as_duplicate(self):
        # eBay 는 같은 알림을 재전송한다. notificationId UNIQUE 로 흡수돼야 한다.
        with self.verified_signature():
            self.post(self.notice())
            again = self.post(self.notice())
        self.assertEqual(again.status_code, 200)
        self.assertEqual(len(self.pending()), 1)
        self.assertEqual(self.receipts()[-1]["queue"], "duplicate")

    def test_replayed_or_incomplete_notices_are_not_queued(self):
        stale = (datetime.now(timezone.utc) - ebay_notify.EVENT_MAX_AGE - timedelta(hours=1)).isoformat()
        cases = [
            ("오래된 eventDate", self.notice(event_date=stale)),
            ("eventDate 없음", self.notice(event_date="")),
            ("userId 없음", {"notification": {"notificationId": "n", "eventDate": datetime.now(timezone.utc).isoformat(), "data": {"username": "buyer"}}}),
            ("userId 가 숫자", {"notification": {"notificationId": "n", "eventDate": datetime.now(timezone.utc).isoformat(), "data": {"userId": 12345}}}),
            ("notificationId 없음", self.notice(notification_id=None)),
            ("JSON 아님", b"{"),
            ("객체 아님", b"[]"),
            ("빈 본문", b""),
        ]
        for name, body in cases:
            with self.subTest(case=name):
                with self.verified_signature():
                    response = self.post(body)
                # 서명은 진짜지만 본문이 못 쓸 것이다 — 재시도해도 같으므로 200.
                self.assertEqual(response.status_code, 200)
        self.assertNothingQueued()
        self.assertEqual(len(self.rejections()), len(cases))

    def test_queue_failure_asks_ebay_to_retry_instead_of_losing_the_notice(self):
        # 큐에 못 넣었는데 200 을 주면 그 알림은 어디에도 남지 않는다 — 가장 나쁜 소실이다.
        def boom(**kwargs):
            raise RuntimeError("database is locked")

        with self.verified_signature(), patch.object(ebay_queue, "enqueue_deletion", boom):
            response = self.post(self.notice())
        self.assertEqual(response.status_code, 503)
        self.assertEqual(self.pending(), [])
        self.assertEqual(self.rejections()[0]["reason"], "queue-error")

    def test_receipt_clips_attacker_controlled_fields(self):
        long_name = "x" * (ebay_notify.MAX_FIELD_CHARS + 500)
        with self.verified_signature():
            response = self.post(self.notice(long_name, username=long_name))
        self.assertEqual(response.status_code, 200)
        receipt = self.receipts()[-1]
        self.assertEqual(len(receipt["userId"]), ebay_notify.MAX_FIELD_CHARS)
        self.assertEqual(len(receipt["username"]), ebay_notify.MAX_FIELD_CHARS)


class EbaySurfaceTests(_EbayEndpointBase):
    """이 모듈이 '공개 프로세스에 둘 수 있는 코드'인지 자체를 지킨다."""

    def test_module_never_reaches_the_credential_vault(self):
        # 여기 admin.db 로 가는 코드 경로가 하나라도 생기면, 인터넷에 열린 프로세스의
        # 임의 코드 실행 결함 하나가 곧 인증키 전량 유출·삭제가 된다(감사 §4-2).
        # 예전에 있던 _purge_records_for_user 는 삭제됐다. 되살리지 말 것.
        self.assertFalse(hasattr(ebay_notify, "_purge_records_for_user"))
        source = Path(ebay_notify.__file__).read_text(encoding="utf-8")
        for forbidden in ("import db", "import crypto", "import config"):
            self.assertNotIn(forbidden, source, f"공개 표면 모듈에 '{forbidden}' 이 들어왔다")

    def test_routes_are_exactly_the_two_ebay_requires(self):
        rows = {(m, r.path) for r in ebay_notify.router.routes
                for m in getattr(r, "methods", ()) if m not in ("HEAD", "OPTIONS")}
        self.assertEqual(rows, {("GET", self.path), ("POST", self.path)})


if __name__ == "__main__":
    unittest.main()
