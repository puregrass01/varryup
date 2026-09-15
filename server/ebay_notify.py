"""
eBay 마켓플레이스 계정 삭제 알림(Marketplace Account Deletion) 엔드포인트.

왜 별도 모듈인가
  proxy.py 의 POST /ebay 는 '직원 토큰으로 인증된 앱이 eBay API 를 대신 부르게 하는' 통로다.
  이쪽은 정반대 방향 — eBay 가 우리 서버를 직접 부르고, 인증 헤더가 없다.
  같은 경로에 얹으면 인증 분기가 생겨 감사 로그가 흐려지므로 경로를 분리한다.

eBay 가 요구하는 동작 (developer.ebay.com > Alerts & Notifications)
  1) 검증:  GET  {ENDPOINT_URL}?challenge_code=XXXX
            -> 200 / application/json / {"challengeResponse": sha256hex}
               해시 입력 순서는 challengeCode + verificationToken + endpointURL (UTF-8 연결).
               endpointURL 은 포털에 등록한 문자열과 '완전히' 같아야 한다(쿼리스트링 제외).
  2) 운영:  POST {ENDPOINT_URL}  (계정 삭제 알림 본문)
            -> 2xx 를 빨리 돌려준다. 2xx 가 아니면 eBay 가 재시도하고,
               계속 실패하면 엔드포인트를 'down' 으로 표시하고 알림 이메일을 보낸다.

배포 시 환경변수로 덮어쓸 수 있다
  EBAY_VERIFICATION_TOKEN  포털에 입력한 검증 토큰 (32~80자, 영숫자/_/-)
  EBAY_DELETION_ENDPOINT   포털에 등록한 엔드포인트 URL (라우트 경로도 여기서 파생된다)
"""
import hashlib
import json
import logging
import os
import re
from datetime import datetime, timezone
from urllib.parse import urlsplit

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

log = logging.getLogger("veryup.ebay_notify")

router = APIRouter()

VERIFICATION_TOKEN = os.environ.get(
    "EBAY_VERIFICATION_TOKEN", "opticgla-r-PRD-382a9c2a1-1d064d46"
)
ENDPOINT_URL = os.environ.get(
    "EBAY_DELETION_ENDPOINT", "https://admin.veryup-domain.duckdns.org/ebay/deletion"
)

# 라우트 경로를 URL 에서 뽑아 쓴다. 등록 URL 과 해시 입력이 어긋날 수 없게 하기 위함.
_PATH = urlsplit(ENDPOINT_URL).path or "/ebay/deletion"

# 받은 알림을 남길 곳. eBay 는 "받았다"는 증빙과 30일 내 삭제 이행을 요구한다.
DELETION_LOG = os.path.join(os.path.dirname(__file__), "ebay_deletions.jsonl")

if not (32 <= len(VERIFICATION_TOKEN) <= 80 and re.fullmatch(r"[A-Za-z0-9_-]+", VERIFICATION_TOKEN)):
    log.warning(
        "eBay 검증 토큰 형식이 규격을 벗어납니다(32~80자, 영숫자/밑줄/하이픈): len=%d",
        len(VERIFICATION_TOKEN),
    )


def _challenge_response(challenge_code: str) -> str:
    """challengeCode + verificationToken + endpointURL 을 이 순서로 이어 SHA-256."""
    h = hashlib.sha256()
    h.update(challenge_code.encode("utf-8"))
    h.update(VERIFICATION_TOKEN.encode("utf-8"))
    h.update(ENDPOINT_URL.encode("utf-8"))
    return h.hexdigest()


@router.get(_PATH)
async def ebay_deletion_challenge(request: Request):
    """eBay 가 엔드포인트 검증 때 부르는 곳. 브라우저로 열어보면 400 이 정상이다."""
    challenge_code = request.query_params.get("challenge_code")
    if not challenge_code:
        return JSONResponse({"error": "challenge_code 쿼리 파라미터가 필요합니다."}, status_code=400)
    log.info("ebay challenge ok (endpoint=%s)", ENDPOINT_URL)
    return JSONResponse({"challengeResponse": _challenge_response(challenge_code)})


@router.post(_PATH)
async def ebay_deletion_notification(request: Request):
    """계정 삭제 알림 수신. 무슨 일이 있어도 200 을 돌려준다(아니면 eBay 가 재시도·중단 판정)."""
    try:
        payload = json.loads(await request.body() or b"{}")
    except (json.JSONDecodeError, UnicodeDecodeError):
        payload = {}

    data = (payload.get("notification") or {}).get("data") or {}
    log.info(
        "ebay account deletion: userId=%s username=%s notificationId=%s",
        data.get("userId"), data.get("username"),
        (payload.get("notification") or {}).get("notificationId"),
    )

    # 기록이 실패해도 200 은 유지한다 — eBay 에게는 '수신 성공'이 맞기 때문.
    try:
        with open(DELETION_LOG, "a", encoding="utf-8") as f:
            f.write(json.dumps({
                "receivedAt": datetime.now(timezone.utc).isoformat(),
                "payload": payload,
            }, ensure_ascii=False) + "\n")
    except OSError as e:
        log.error("ebay 삭제 알림 기록 실패: %s", e)

    return JSONResponse({"ok": True})
