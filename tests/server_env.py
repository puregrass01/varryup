"""
파이썬 테스트 공용 부트스트랩 — **server/ 모듈을 import 하기 전에 가장 먼저** 부른다.

    import server_env  # noqa: F401  (환경변수·sys.path 준비)
    import db
    ...

왜 이 파일이 필요한가
  server/config.py, server/public.py, server/ebay_notify.py 는 모두 **import 시점에**
  환경변수를 읽고, 요건을 만족하지 못하면 예외를 던져 기동을 거부한다(그게 설계 의도다).
  그래서 테스트도 "서버가 뜨는 최소 환경"을 실제로 갖춰 줘야 한다. 갖추지 않으면
  테스트가 실패하는 게 아니라 **import 단계에서 통째로 죽는다** — 무엇이 깨졌는지도 안 보인다.

  구체적으로 이 네 가지가 import 를 막는다:
    · config.admin_secret()       ADMIN_SECRET 최소 32자 + KEY_MASTER 와 다른 값 (모드 무관)
    · public._require_privacy_config()  COMPANY_NAME / CONTACT_EMAIL / DATA_RETENTION
    · ebay_notify (모듈 최상단)   EBAY_DELETION_ENDPOINT (+ https EBAY_API_BASE)
    · public.internal_router      UPDATE_TOKEN 이 없으면 /updates 라우트를 아예 등록하지 않는다

절대 지켜야 하는 것 (이 파일의 존재 이유의 절반)
  * 실제 server/admin.db 와 server/secret.key 는 **읽지도 쓰지도 않는다.**
    - KEY_MASTER 를 매 실행마다 새로 만들어 넣으므로 config 가 secret.key 로 폴백하지 않는다.
    - db.init_db() 는 각 테스트 파일이 patch 로 막고, DB 접근은 전부 mock 이다.
  * eBay 큐·영수증·격리 파일은 **임시 디렉터리**로 돌린다. 기본값은 server/ 소스 디렉터리라
    그대로 두면 admin.db 옆에 테스트 찌꺼기가 쌓인다.
  * PUBLIC_STRICT=0 — serve_public 의 자가 점검은 개발 트리(admin.db 가 읽히는 상태)에서
    기동을 거부한다. 테스트는 공개 라우터를 임시 앱에 직접 올려 쓰므로 그 점검이 필요 없다.

os.environ 을 patch.dict 가 아니라 **영구히** 바꾸는 이유
  서버 모듈들은 값을 import 시점에 모듈 전역으로 굳혀 둔다(config 는 캐시까지 한다).
  pytest 는 네 테스트 파일을 한 프로세스에서 돌리므로 import 는 첫 파일에서 한 번만 일어난다.
  값이 파일마다 다르면 "두 번째 파일에서만 깨지는" 재현 어려운 실패가 된다 — 프로세스 전체에
  같은 값을 한 번 깔아 두는 편이 정확하다.
"""
import atexit
import os
from pathlib import Path
import shutil
import sys
import tempfile

from cryptography.fernet import Fernet

TESTS_DIR = Path(__file__).resolve().parent
SERVER_DIR = TESTS_DIR.parent / "server"
if str(SERVER_DIR) not in sys.path:
    sys.path.insert(0, str(SERVER_DIR))

# 큐·영수증·격리 파일 전용 임시 디렉터리. server/ 안에 만들지 않는 것이 요점이다.
QUEUE_DIR = Path(tempfile.mkdtemp(prefix="veryup-tests-queue-"))
atexit.register(shutil.rmtree, QUEUE_DIR, True)

# 이 실행에서만 쓰는 값들. KEY_MASTER 는 매번 새로 만든다 —
# server/secret.key 를 읽지 않는다는 것을 구조적으로 보장하기 위해서다.
KEY_MASTER = Fernet.generate_key().decode()
# 32자 이상이어야 하고(config.MIN_ADMIN_SECRET_LEN), KEY_MASTER 와 달라야 한다.
# 아래 값은 40자이고 Fernet 키(44자 base64)와 절대 겹치지 않는다.
ADMIN_SECRET = "offline-test-only-signing-key-0123456789"

# eBay 엔드포인트 — 실제 운영 주소를 쓰지 않는다(로컬 테스트가 운영 주소 행세를 하면 안 된다).
EBAY_ENDPOINT = "https://admin.example.test/ebay/deletion"
EBAY_VERIFICATION_TOKEN = "offline-verification-token-0123456789"   # 36자, 규격(32~80자) 안
UPDATE_TOKEN = "update-token-offline"

ENV = {
    # 개발 모드. 운영 모드로 켜면 비밀값 주입 규칙이 더 빡빡해지는데, 그건 배포 점검의 몫이다.
    "VERYUP_ENV": "development",
    "KEY_MASTER": KEY_MASTER,
    "ADMIN_SECRET": ADMIN_SECRET,
    # 개인정보처리방침 필수 3종 — 하나라도 비면 public.py import 가 RuntimeError 로 죽는다.
    "COMPANY_NAME": "베리업테스트상사",
    "CONTACT_EMAIL": "privacy@example.test",
    "DATA_RETENTION": "1년",
    # /updates 라우트는 UPDATE_TOKEN 이 있어야 **등록 자체가** 된다.
    "UPDATE_TOKEN": UPDATE_TOKEN,
    # eBay 공개 엔드포인트
    "EBAY_DELETION_ENDPOINT": EBAY_ENDPOINT,
    "EBAY_VERIFICATION_TOKEN": EBAY_VERIFICATION_TOKEN,
    "EBAY_CLIENT_ID": "offline-test-client-id",
    "EBAY_CLIENT_SECRET": "offline-test-client-secret",
    "EBAY_API_BASE": "https://api.sandbox.ebay.com",
    "EBAY_QUEUE_DIR": str(QUEUE_DIR),
    # 공개 표면 자가 점검은 이 트리(admin.db 가 옆에 있는 개발 체크아웃)에서 기동을 거부한다.
    "PUBLIC_STRICT": "0",
    # 세션 쿠키 Secure 플래그. TestClient 는 http 로 말하므로 꺼야 쿠키가 왕복한다
    # (CSRF 토큰이 세션에 들어 있어서, 이게 켜져 있으면 모든 POST 테스트가 403 이 된다).
    "SESSION_HTTPS_ONLY": "0",
}

# 기존 값이 있어도 덮어쓴다 — 이 머신의 환경변수에 따라 결과가 달라지면 테스트가 아니다.
os.environ.update(ENV)
