"""
인증키 암호화 모듈 (Fernet 대칭키 암호화).

이 모듈은 **암호화 전용**이다. 서명키(ADMIN_SECRET)는 여기서 제공하지 않는다.
  - 암호화 키(KEY_MASTER)  → config.master_key()
  - 서명 키(ADMIN_SECRET)  → config.admin_secret()
두 값을 분리한 이유와 운영/개발 모드 규칙은 server/config.py 상단 주석 참고.

하위 호환을 깨는 변경 (2026-09-16):
  * crypto.app_secret() 제거. 예전에는 Fernet 마스터 키를 그대로 반환해
    app.py 가 세션·API 토큰 서명키로 재사용했고, 키 파일 하나로 '전량 복호화 + 관리자 사칭'이
    동시에 가능했다. 호출하면 이제 RuntimeError 로 즉시 실패한다 → app.py 는 config.admin_secret() 를 쓸 것.
  * 마스터 키 파일(server/secret.key) 폴백과 자동 생성은 **개발 모드에서만** 동작한다.
    운영 모드(VERYUP_ENV=production)에서는 KEY_MASTER 환경변수가 없으면 기동을 거부한다.

운영자 주의:
  기존 secret.key 로 암호화된 데이터를 계속 읽으려면 그 파일 내용을 그대로 KEY_MASTER 에 넣어라.
  새 키로 바꾸면 기존 암호문은 영구 복호화 불가다(= 인증키 재입력 필요).
"""
import logging

from cryptography.fernet import Fernet

import config

log = logging.getLogger("veryup.crypto")

# 기동 시점에 키를 확정한다(지연 로딩하지 않는 이유: 운영에서 키가 없으면 요청을 받기 전에
# 프로세스가 죽는 편이 안전하고, 예전 동작과도 동일해 하위 호환이 유지된다).
try:
    _fernet = Fernet(config.master_key())
except config.SecretConfigError:
    raise  # 메시지가 이미 운영자용으로 충분하다. 그대로 올려 기동을 중단시킨다.
except (ValueError, TypeError) as e:
    # KEY_MASTER 형식 오류(Fernet 키는 32바이트를 urlsafe base64 로 인코딩한 44자 문자열)
    raise config.SecretConfigError(
        "KEY_MASTER 값이 유효한 Fernet 키가 아니다. "
        'python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())" '
        f"로 만든 44자 문자열이어야 한다. 원인: {e}"
    ) from e


def encrypt(plaintext: str) -> bytes:
    """평문 문자열 → 암호문(bytes). DB에 이 bytes 를 그대로 저장."""
    return _fernet.encrypt(plaintext.encode("utf-8"))


def decrypt(token: bytes) -> str:
    """암호문(bytes) → 평문 문자열."""
    if isinstance(token, str):
        token = token.encode("utf-8")
    return _fernet.decrypt(token).decode("utf-8")


def app_secret() -> str:
    """
    제거됨 — 예전에는 Fernet 마스터 키를 서명키로 돌려줬다(보안감사 3·8·15·17번).

    함수를 완전히 삭제하지 않고 남겨 둔 이유: 남아 있는 호출부가 AttributeError 로 죽으면
    원인을 알기 어렵다. 여기서 이유와 대체 경로를 알려 주고 실패시킨다.
    """
    raise RuntimeError(
        "crypto.app_secret() 은 제거됐다. 서명키는 암호화키와 분리됐으니 config.admin_secret() 를 쓰라. "
        "(Fernet 마스터 키를 서명에 재사용하면 키 파일 하나로 인증키 전량 복호화와 관리자 토큰 위조가 동시에 가능해진다)"
    )
