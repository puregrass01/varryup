"""
인증키 암호화 모듈 (Fernet 대칭키 암호화).

마스터 키 우선순위:
  1) 환경변수 KEY_MASTER  (권장: 서버 배포 시 여기에 넣고 git·DB엔 절대 안 둠)
  2) server/secret.key 파일 (없으면 최초 실행 시 자동 생성) — .gitignore 대상

주의: 이 마스터 키가 있어야 저장된 인증키를 복호화할 수 있다.
      키를 잃어버리면 저장된 인증키도 복구 불가하므로, secret.key 는 별도 백업 권장.
"""
import os
from cryptography.fernet import Fernet

BASE_DIR = os.path.dirname(__file__)
KEY_FILE = os.path.join(BASE_DIR, "secret.key")


def _load_master_key() -> bytes:
    env = os.environ.get("KEY_MASTER")
    if env:
        return env.encode()
    if os.path.exists(KEY_FILE):
        with open(KEY_FILE, "rb") as f:
            return f.read().strip()
    # 최초 실행: 새 마스터 키 생성 후 파일 저장 (git 제외)
    key = Fernet.generate_key()
    with open(KEY_FILE, "wb") as f:
        f.write(key)
    print("[crypto] 마스터 키 생성됨 → server/secret.key (백업 권장, git 제외됨)")
    return key


_fernet = Fernet(_load_master_key())


def encrypt(plaintext: str) -> bytes:
    """평문 문자열 → 암호문(bytes). DB에 이 bytes 를 그대로 저장."""
    return _fernet.encrypt(plaintext.encode("utf-8"))


def decrypt(token: bytes) -> str:
    """암호문(bytes) → 평문 문자열."""
    if isinstance(token, str):
        token = token.encode("utf-8")
    return _fernet.decrypt(token).decode("utf-8")


def app_secret() -> str:
    """세션·API 토큰 서명용 안정적인 비밀키(문자열). 서버 재시작에도 동일하게 유지된다."""
    return _load_master_key().decode("utf-8")
