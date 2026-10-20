"""Offline administrator credential routes; use mock records and a temporary key only."""
import importlib
import json
from pathlib import Path
import re
import sys
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

# 환경변수·sys.path 준비가 **서버 모듈 import 보다 먼저** 와야 한다.
# (config/public/ebay_notify 는 import 시점에 환경변수를 검사하고 없으면 기동을 거부한다)
sys.path.insert(0, str(Path(__file__).resolve().parent))
import server_env  # noqa: E402,F401

import db  # noqa: E402

# init_db 만 막으면 실제 server/admin.db 는 열리지 않는다(아래 테스트는 전부 mock 을 쓴다).
with patch.object(db, "init_db"):
    admin = importlib.import_module("app")


class CredentialTests(unittest.TestCase):
    def setUp(self):
        self.user = {"id": 1, "username": "tester", "name": "Test Admin", "role": "admin", "is_active": 1}
        self.addCleanup(patch.stopall)
        patch.object(db, "get_staff_by_id", return_value=self.user).start()
        self.access_log = patch.object(db, "record_key_access").start()
        self.client = TestClient(admin.app)
        self.addCleanup(self.client.close)
        self.headers = {"Authorization": "Bearer " + admin.api_signer.dumps({"uid": 1})}

    def csrf(self):
        """세션에 CSRF 토큰을 심고 그 값을 돌려준다.

        상태 변경 POST 는 이제 폼의 csrf_token 이 세션 값과 같아야 통과한다(app.require_csrf).
        토큰은 서명된 세션 쿠키 안에 있으므로 테스트도 실제 화면처럼 **GET 으로 폼을 한 번 받아**
        거기 박힌 값을 써야 한다 — 임의로 만들어 낸 값으로는(설계대로) 통과할 수 없다.
        """
        with patch.object(admin, "current_user", return_value=self.user), \
                patch.object(db, "list_credentials", return_value=[]), \
                patch.object(db, "recent_key_logs", return_value=[]):
            page = self.client.get("/keys")
        self.assertEqual(page.status_code, 200)
        token = re.search(r'name="csrf_token" value="([^"]+)"', page.text)
        self.assertIsNotNone(token, "/keys 폼에 csrf_token hidden input 이 있어야 한다")
        return token.group(1)

    def test_form_includes_marketplaces_and_uses_server_api_fields(self):
        with patch.object(admin, "current_user", return_value=self.user), patch.object(db, "list_credentials", return_value=[]), patch.object(db, "recent_key_logs", return_value=[]):
            response = self.client.get("/keys")
        self.assertEqual(response.status_code, 200)
        for platform in ("ebay", "amazon"):
            self.assertIn(f'<option value="{platform}">', response.text)
        rendered = re.search(r"const API = (.*);", response.text).group(1)
        self.assertEqual(json.loads(rendered), admin.PLATFORM_HINTS)
        amazon = json.loads(admin.PLATFORM_HINTS["amazon"])
        ebay = json.loads(admin.PLATFORM_HINTS["ebay"])
        self.assertTrue({"sellerId", "clientId", "clientSecret", "refreshToken", "endpoint", "marketplaceId"} <= amazon.keys())
        self.assertEqual(ebay["environment"], "production")
        self.assertTrue({"clientId", "clientSecret", "refreshToken", "ruName", "merchantLocationKey", "fulfillmentPolicyId", "paymentPolicyId", "returnPolicyId"} <= ebay.keys())

    def test_add_encrypts_marketplace_credentials_and_api_returns_same_values(self):
        records = []
        csrf = self.csrf()
        for platform in ("amazon", "ebay"):
            payload = json.loads(admin.PLATFORM_HINTS[platform])
            payload.update(clientId="test-app", clientSecret="test-secret", refreshToken="test-refresh")
            with patch.object(admin, "current_user", return_value=self.user), patch.object(db, "add_credential") as save:
                response = self.client.post("/keys/add", data={"platform": platform, "label": "Test", "payload": json.dumps(payload), "csrf_token": csrf}, follow_redirects=False)
            self.assertEqual(response.status_code, 303)
            saved_platform, label, encrypted, updated_by = save.call_args.args
            self.assertEqual(saved_platform, platform)
            self.assertNotIn(b"test-secret", encrypted)
            self.assertEqual(json.loads(admin.crypto.decrypt(encrypted)), payload)
            records.append({"id": len(records) + 1, "platform": platform, "label": label, "enc_payload": encrypted})
        with patch.object(db, "list_credentials", return_value=records), patch.object(db, "get_credential", side_effect=lambda identifier: records[identifier - 1]):
            # platform 은 이제 **필수**다. 예전에는 생략하면 저장된 전 플랫폼 인증키가
            # 한 응답에 평문으로 나왔다(토큰 하나 = 금고 전체, 보안감사 12·26·27번).
            bulk = self.client.get("/api/credentials", headers=self.headers)
            self.assertEqual(bulk.status_code, 400)
            self.assertNotIn("test-refresh", bulk.text)
            for platform in ("amazon", "ebay"):
                result = self.client.get("/api/credentials", params={"platform": platform}, headers=self.headers).json()["credentials"]
                self.assertEqual(len(result), 1)
                self.assertEqual(result[0]["platform"], platform)
                self.assertEqual(result[0]["data"]["refreshToken"], "test-refresh")
        # create 2건 + platform 별 view 2건 = 4건. (platform 없는 요청은 400 이라 아무것도 읽지 않는다.)
        self.assertEqual(self.access_log.call_count, 4)

    def test_unauthenticated_api_never_reads_keys_and_staff_cannot_create(self):
        with patch.object(db, "list_credentials") as read:
            self.assertEqual(self.client.get("/api/credentials?platform=amazon").status_code, 401)
            self.assertEqual(self.client.get("/api/credentials?platform=ebay", headers={"Authorization": "Bearer invalid"}).status_code, 401)
            read.assert_not_called()
        # CSRF 토큰을 **제대로 넣고도** staff 는 막혀야 한다 — 그래야 이 테스트가
        # RBAC 을 보는 것이지 CSRF 게이트에 걸려 우연히 통과하는 것이 아님이 분명해진다.
        csrf = self.csrf()
        with patch.object(admin, "current_user", return_value={**self.user, "role": "staff"}), patch.object(db, "add_credential") as save:
            response = self.client.post("/keys/add", data={"platform": "ebay", "label": "Test", "payload": "{}", "csrf_token": csrf}, follow_redirects=False)
            self.assertEqual(response.status_code, 303)
            save.assert_not_called()
        # 반대로 관리자라도 CSRF 토큰이 없으면 403 이고 저장은 일어나지 않는다.
        with patch.object(admin, "current_user", return_value=self.user), patch.object(db, "add_credential") as save:
            response = self.client.post("/keys/add", data={"platform": "ebay", "label": "Test", "payload": "{}"}, follow_redirects=False)
            self.assertEqual(response.status_code, 403)
            save.assert_not_called()


if __name__ == "__main__":
    unittest.main()
