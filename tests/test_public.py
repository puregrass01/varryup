"""무인증 공개 라우트 + 내부 전용 /updates 오프라인 테스트. 실제 admin.db·secret.key 는 건드리지 않는다.

표면 분리(2026-09-16) 이후 이 파일이 달라진 점
  · /privacy, /privacy/en, /ebay/auth/* 는 **공개 프로세스**의 public.public_router 에 있다.
    app.app(내부 프로세스)에는 더 이상 없으므로 거기다 대고 GET 하면 404 다.
  · /updates 는 반대로 **내부 전용**(public.internal_router)이고, UPDATE_TOKEN 이 없으면
    라우트가 **등록조차 되지 않는다**(=404). 그래서 토큰은 server_env 가 import 전에 넣어 준다.
  · serve_public 을 그대로 import 하지 않는 이유: 그 모듈은 기동 시 sys.modules 를 검사해
    db/crypto/config 가 로드돼 있으면 **무조건** 기동을 거부한다(STRICT 와 무관). 한 프로세스에서
    다른 테스트 파일이 db 를 import 하므로 여기서는 라우터만 임시 앱에 올려 검사한다.
    진짜 serve_public 의 자가 점검은 배포 점검의 몫이다.
"""
from pathlib import Path
import os
import sys
import tempfile
import unittest
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent))
import server_env  # noqa: E402,F401  (환경변수·sys.path 준비가 먼저)

import public  # noqa: E402


def _client(router) -> TestClient:
    """라우터 하나만 올린 임시 앱. 진입점(serve_public/serve_internal)을 import 하지 않는다."""
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


class UpdateFeedTests(unittest.TestCase):
    """/updates — 내부 프로세스 전용. 배포 파일만 내보내고 그 밖의 것은 절대 내보내지 않는다."""

    def setUp(self):
        self.addCleanup(patch.stopall)
        # 실제 server/updates 폴더(그리고 그 옆의 admin.db·secret.key)를 절대 건드리지 않게
        # 매 테스트마다 임시 배포 폴더를 새로 만들어 UPDATES_DIR 을 그쪽으로 돌린다.
        workspace = tempfile.TemporaryDirectory()
        self.addCleanup(workspace.cleanup)
        self.outside = Path(workspace.name).resolve()
        self.updates = self.outside / "updates"
        self.updates.mkdir()
        (self.updates / "latest.yml").write_bytes(b"version: 1.0.0\n")
        (self.updates / "VERY UP Setup 1.0.0.exe").write_bytes(b"MZ-installer")
        (self.updates / "VERY UP Setup 1.0.0.exe.blockmap").write_bytes(b"blockmap")
        # 배포 폴더에 섞여 들어갈 수 있는 비밀 파일 — 화이트리스트가 막아야 한다.
        (self.updates / "admin.db").write_bytes(b"SQLite format 3")
        (self.updates / "secret.key").write_bytes(b"master-key-never-served")
        patch.object(public, "UPDATES_DIR", self.updates).start()
        self.token = server_env.UPDATE_TOKEN
        self.auth = {"X-Update-Token": self.token}
        self.client = _client(public.internal_router)
        self.addCleanup(self.client.close)

    def test_allowlist_serves_update_files_only(self):
        for filename, body in [("latest.yml", b"version: 1.0.0\n"), ("VERY UP Setup 1.0.0.exe", b"MZ-installer"), ("VERY UP Setup 1.0.0.exe.blockmap", b"blockmap")]:
            with self.subTest(filename=filename):
                response = self.client.get("/updates/" + filename, headers=self.auth)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.content, body)
        for filename in ["admin.db", "secret.key", "app.log", "latest.yml.bak", "..%2F..%2Fadmin.db", "%2e%2e%2fsecret.key", "..%5Csecret.key", "sub/latest.yml", "설치본.exe", "latest.yml%00.exe"]:
            with self.subTest(filename=filename):
                response = self.client.get("/updates/" + filename, headers=self.auth)
                self.assertEqual(response.status_code, 404)
                self.assertNotIn(b"master-key-never-served", response.content)
                self.assertNotIn(b"SQLite format 3", response.content)

    def test_containment_rejects_allowed_name_pointing_outside(self):
        # 이름이 정규식을 통과해도 resolve() 결과가 UPDATES_DIR 밖이면 내보내면 안 된다.
        # (배포 폴더에 바깥 파일을 가리키는 링크가 섞여 들어온 상황)
        secret = self.outside / "secret.key"
        secret.write_bytes(b"master-key-outside")
        link = self.updates / "leak.exe"
        try:
            os.symlink(secret, link)
        except (OSError, NotImplementedError):
            self.skipTest("이 환경에서는 심볼릭 링크를 만들 수 없어 경로 탈출을 재현할 수 없습니다")
        self.assertTrue(public._ALLOWED.match("leak.exe"), "정규식을 통과하는 이름이어야 의미 있는 테스트다")
        self.assertTrue(link.is_file())
        response = self.client.get("/updates/leak.exe", headers=self.auth)
        self.assertEqual(response.status_code, 404)
        self.assertNotIn(b"master-key-outside", response.content)

    def test_directory_and_missing_names_are_not_served(self):
        # 이름은 통과하지만 파일이 아닌 경우(디렉터리·없는 파일)도 404 여야 한다.
        (self.updates / "nested.exe").mkdir()
        for filename in ["nested.exe", "absent.exe", "latest-beta.yml"]:
            with self.subTest(filename=filename):
                self.assertEqual(self.client.get("/updates/" + filename, headers=self.auth).status_code, 404)

    def test_token_gate_covers_file_and_index(self):
        # 토큰은 파일 내려받기와 인덱스를 '둘 다' 막아야 한다.
        # 인덱스만 열려 있으면 배포 여부·파일 수가 그대로 새어 나간다.
        for route in ["/updates/latest.yml", "/updates", "/updates/"]:
            with self.subTest(route=route):
                self.assertEqual(self.client.get(route).status_code, 401)
                self.assertEqual(self.client.get(route, headers={"X-Update-Token": "wrong"}).status_code, 401)
                self.assertEqual(self.client.get(route, headers=self.auth).status_code, 200)
        # 토큰을 통과해도 화이트리스트는 그대로 살아 있어야 한다.
        self.assertEqual(self.client.get("/updates/secret.key", headers=self.auth).status_code, 404)

    def test_index_summarises_without_listing_names(self):
        index = self.client.get("/updates", headers=self.auth).json()
        self.assertTrue(index["ready"])
        # 화이트리스트에 걸리는 3개만 세고 admin.db·secret.key 는 빠져야 한다.
        self.assertEqual(index["files"], 3)
        # UPDATE_TOKEN 이 없으면 라우트가 등록되지 않으므로, 응답이 온다는 것 자체가 토큰이 켜져 있다는 뜻이다.
        self.assertTrue(index["tokenRequired"])
        self.assertNotIn("secret.key", self.client.get("/updates", headers=self.auth).text)
        with patch.object(public, "UPDATES_DIR", self.outside / "없는폴더"):
            missing = self.client.get("/updates/", headers=self.auth).json()
        self.assertFalse(missing["ready"])


class PublicSurfaceTests(unittest.TestCase):
    """인터넷에 열리는 표면 — 개인정보처리방침과 eBay OAuth 착지 페이지뿐이다."""

    def setUp(self):
        self.addCleanup(patch.stopall)
        self.client = _client(public.public_router)
        self.addCleanup(self.client.close)

    def test_privacy_renders_and_css_braces_survive_format(self):
        with patch.object(public, "COMPANY_NAME", "베리업상사"), patch.object(public, "CONTACT_EMAIL", "privacy@example.test"), patch.object(public, "RETENTION", "1년"):
            response = self.client.get("/privacy")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.headers["content-type"].startswith("text/html"))
        body = response.text
        for value in ["베리업상사", "privacy@example.test", "1년"]:
            self.assertIn(value, body)
        # .format() 이 CSS 를 먹지 않았는지 — {{ }} 가 한 겹으로 풀리고 남은 자리표시자가 없어야 한다.
        self.assertIn("body{max-width:820px", body)
        self.assertIn("th{background:#f2f4f3", body)
        self.assertNotIn("{{", body)
        self.assertNotIn("}}", body)
        for placeholder in ["{company}", "{email}", "{retention}"]:
            self.assertNotIn(placeholder, body)
        # eBay 심사에 제출하는 페이지이므로 삭제 알림 주소가 반드시 적혀 있어야 한다.
        self.assertIn("/ebay/deletion", body)

    def test_english_privacy_is_served_too(self):
        # eBay 심사는 영문 페이지를 함께 본다. 한글판만 살아 있으면 반려된다.
        response = self.client.get("/privacy/en")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.headers["content-type"].startswith("text/html"))

    def test_oauth_landing_pages_are_public_and_static(self):
        for route in ["/ebay/auth/accepted", "/ebay/auth/declined"]:
            with self.subTest(route=route):
                response = self.client.get(route, params={"code": "v%1.1#abc"})
                self.assertEqual(response.status_code, 200)
                # 서버는 code 를 받아 처리하지도, 본문에 되비추지도 않는다(로그 유출 방지).
                self.assertNotIn("v%1.1#abc", response.text)
                self.assertIn("전체 주소 복사", response.text)

    def test_public_router_never_carries_the_update_feed(self):
        # 이 한 줄이 분리의 핵심이다 — public_router 에 /updates 가 섞이면
        # 사내 설치본(asar 미적용 소스 포함)이 그대로 인터넷에 열린다.
        paths = {getattr(r, "path", "") for r in self.client.app.routes}
        self.assertNotIn("/updates", paths)
        self.assertEqual(self.client.get("/updates").status_code, 404)


if __name__ == "__main__":
    unittest.main()
