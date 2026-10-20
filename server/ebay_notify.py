"""
eBay 마켓플레이스 계정 삭제 알림(Marketplace Account Deletion) 엔드포인트.

이 파일은 '공개 프로세스' 코드다 — 인터넷에서 직접 도달 가능하다.
  그래서 admin.db 도 KEY_MASTER 도 ADMIN_SECRET 도 건드리지 않는다.
  상태는 ebay_queue.py 의 소형 저장소 하나뿐이고, 인증키를 지울 수 있는
  코드 경로가 웹훅 쪽에 **존재하지 않는다**(2026-09-16 보안감사 §4-2 확정 아키텍처).

왜 별도 모듈인가
  proxy.py 의 POST /ebay 는 '직원 토큰으로 인증된 앱이 eBay API 를 대신 부르게 하는' 통로다.
  이쪽은 정반대 방향 — eBay 가 우리 서버를 직접 부르고, 직원 인증 헤더가 없다.

eBay 가 요구하는 동작 (developer.ebay.com > Alerts & Notifications)
  1) 검증:  GET  {ENDPOINT_URL}?challenge_code=XXXX
            -> 200 / application/json / {"challengeResponse": sha256hex}
               해시 입력 순서는 challengeCode + verificationToken + endpointURL (UTF-8 연결).
               endpointURL 은 포털에 등록한 문자열과 '완전히' 같아야 한다(쿼리스트링 제외).
  2) 운영:  POST {ENDPOINT_URL}  (계정 삭제 알림 본문)
            -> 2xx 를 빨리 돌려준다. 2xx 가 아니면 eBay 가 재시도하고,
               계속 실패하면 엔드포인트를 'down' 으로 표시하고 알림 이메일을 보낸다.

               **2xx 는 "이 알림은 우리가 책임졌다"는 뜻으로만 쓴다.**
               eBay 는 2xx 를 받은 알림을 다시 보내주지 않기 때문에, 우리 쪽 사정으로
               처리하지 못한 건에 200 을 돌려주면 그 알림은 그 순간 영구히 사라진다.
               그래서 아래 POST 핸들러는 거절 사유를 두 부류로 나눈다(_is_our_fault 참고):
                 · 상대가 가짜다(서명 불일치·모르는 kid·헤더 위조) → 200. 재시도해도 똑같다.
                 · 우리가 고장났다(토큰 발급 실패·공개키 조회 실패·큐 장애) 또는 레이트리밋
                   → 5xx/429. eBay 가 재시도한다. 계속 실패하면 엔드포인트가 down 으로
                     표시되고 이메일이 오는데, 그편이 훨씬 낫다 —
                     **down 은 사람이 알게 되지만 소실은 아무도 모른다.**
               어느 쪽이든 조용히 버리지는 않는다 — 거절 사유와 원본 본문을 ebay_queue 에 남긴다.

무엇이 바뀌었나 (2026-09-16, 보안감사 §4-2 반영) — 하위 호환 깨짐
  - POST 는 더 이상 인증키를 삭제하지 않는다. pending 큐에 적재만 하고,
    실제 삭제는 내부 프로세스에서 관리자가 승인할 때 수행한다(eBay 기한 30일).
  - 서명을 실제로 검증한다(ECDSA P-256, eBay public_key/{kid}).
    **자격증명이 없거나 검증에 실패하면 거절 사유만 남기고 큐에 넣지 않는다.**
    검증 불가 상태를 '통과'로 취급하지 않는다.
  - EBAY_DELETION_ENDPOINT 기본값(공인 DuckDNS 주소)을 제거했다. 미설정이면 기동하지 않는다.

배포 시 환경변수
  EBAY_DELETION_ENDPOINT   포털에 등록한 엔드포인트 URL. **필수** — 없으면 프로세스가 뜨지 않는다.
                           경로는 /ebay/<이름> 형태여야 한다(관리 경로를 가리지 못하게).
  EBAY_VERIFICATION_TOKEN  포털에 입력한 검증 토큰 (32~80자, 영숫자/_/-). **필수** — 없으면 GET 이 503.
  EBAY_CLIENT_ID           eBay 앱 Client ID     ┐ 서명 검증용 application access token 발급에 쓴다.
  EBAY_CLIENT_SECRET       eBay 앱 Client Secret ┘ 둘 중 하나라도 없으면 모든 알림이 거절 기록된다.
  EBAY_API_BASE            (선택) 기본 https://api.ebay.com — 샌드박스는 https://api.sandbox.ebay.com
                           **https 가 아니면 기동하지 않는다**(Basic 헤더에 Client Secret 이 실린다).
  EBAY_RATE_PER_IP         (선택) IP 당 분당 요청 수, 기본 120
  EBAY_RATE_GLOBAL         (선택) 전역 분당 요청 수, 기본 600
                           상한 초과가 429 라서 eBay 의 엔드포인트 건강도에 집계된다 —
                           목적은 자원 고갈 방지이지 정상 알림 억제가 아니다(아래 상수 주석 참고).
  EBAY_RATE_KEYFETCH_PER_IP (선택) IP 당 분당 '공개키 캐시 미스' 허용 수, 기본 3
  EBAY_RATE_KEYFETCH_GLOBAL (선택) 전역 분당 '공개키 캐시 미스' 허용 수, 기본 12
                           무인증 POST 1건이 eBay API 아웃바운드 1건을 유발하는 증폭을 여기서 끊는다.
  EBAY_TRUST_FORWARDED     (선택) 1 이면 X-Forwarded-For 첫 값을 클라이언트 IP 로 쓴다.
                           **신뢰할 수 있는 리버스 프록시 뒤에 있을 때만** 켠다(레이트리밋 우회 방지).
"""
import asyncio
import base64
import binascii
import hashlib
import json
import logging
import os
import re
import threading
import time
from datetime import datetime, timedelta, timezone
from urllib.parse import urlsplit

import httpx
from cryptography.exceptions import InvalidSignature, UnsupportedAlgorithm
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

import ebay_queue

log = logging.getLogger("veryup.ebay_notify")

router = APIRouter()

# ── 설정 ─────────────────────────────────────────────────────
# 검증 토큰은 비밀값이므로 코드에 기본값을 두지 않는다 — 환경변수로만 주입한다.
# 예전에 이 자리에 하드코딩돼 있던 토큰은 이미 저장소에 남아 유출된 것으로 보고,
# eBay 개발자 포털 > Alerts & Notifications 에서 새 토큰으로 반드시 교체(rotate)해야 한다.
VERIFICATION_TOKEN = (os.environ.get("EBAY_VERIFICATION_TOKEN") or "").strip()

# 공인 주소를 기본값으로 박아 두면 개발자가 로컬에서 켠 서버가 운영 주소 행세를 하게 된다
# (감사 §design-drift). 그래서 기본값을 없애고, 미설정이면 아예 기동하지 않는다.
ENDPOINT_URL = (os.environ.get("EBAY_DELETION_ENDPOINT") or "").strip()
if not ENDPOINT_URL:
    raise RuntimeError(
        "EBAY_DELETION_ENDPOINT 환경변수가 필요합니다. "
        "eBay 개발자 포털에 등록한 삭제 알림 엔드포인트 URL 을 '완전히 같은 문자열'로 넣어주세요. "
        "예: EBAY_DELETION_ENDPOINT=https://public.example.com/ebay/deletion "
        "(이 값은 라우트 경로와 challengeResponse 해시 입력에 함께 쓰이므로 기본값을 둘 수 없습니다.)"
    )

# 라우트 경로를 URL 에서 뽑아 쓴다. 등록 URL 과 해시 입력이 어긋날 수 없게 하기 위함.
DEFAULT_PATH = "/ebay/deletion"
# 화이트리스트: /ebay/<이름> 한 단계만. 예전 정규식은 '/' 나 '/login' 같은 값까지 받아들여
# 오설정 한 번으로 관리자 로그인 경로를 통째로 가릴 수 있었다(감사 §4-2).
_ALLOWED_PATH = re.compile(r"^/ebay/[A-Za-z0-9._~-]{1,40}$")


def _route_path(endpoint_url: str) -> str:
    """등록 URL 에서 라우트 경로를 뽑는다. 화이트리스트에 맞지 않으면 기동을 거부한다.

    조용히 기본 경로로 되돌리면 포털 등록 URL 과 실제 라우트가 달라져
    eBay 엔드포인트 검증이 404 로 실패하는데, 그 사실이 로그 한 줄에 묻힌다.
    차라리 뜨지 않는 편이 낫다.
    """
    path = urlsplit(endpoint_url).path or ""
    if not _ALLOWED_PATH.fullmatch(path):
        raise RuntimeError(
            f"EBAY_DELETION_ENDPOINT 의 경로가 허용 형식이 아닙니다: path={path!r} "
            f"(url={endpoint_url!r}). '/ebay/<이름>' 형태만 허용합니다(예: {DEFAULT_PATH}). "
            "'/' 나 '/login' 같은 값은 관리 경로를 가로챕니다."
        )
    return path


_PATH = _route_path(ENDPOINT_URL)

_scheme = (urlsplit(ENDPOINT_URL).scheme or "").lower()
if _scheme != "https":
    # eBay 는 https 만 등록받는다. 로컬 개발(http://127.0.0.1)은 허용하되 경고는 남긴다.
    log.warning("EBAY_DELETION_ENDPOINT 가 https 가 아닙니다(scheme=%s). eBay 포털은 https 만 등록받습니다.", _scheme)

# 계정 삭제 알림은 1KB 안팎이다. 넉넉히 64KB 로 자른다 —
# 상한이 없으면 아무나 큰 본문을 반복 전송해 디스크를 채우고 서버를 멈출 수 있다.
MAX_NOTIFICATION_BYTES = 64 * 1024
# 로그에 남기는 개별 값 길이 상한 (공격자가 값 하나로 로그를 부풀리지 못하게).
MAX_FIELD_CHARS = 200

if not VERIFICATION_TOKEN:
    log.warning(
        "EBAY_VERIFICATION_TOKEN 이 설정되지 않았습니다. "
        "GET %s 검증 요청은 503 으로 거절됩니다 — 배포 환경변수에 포털의 검증 토큰을 넣어주세요.",
        _PATH,
    )
elif not (32 <= len(VERIFICATION_TOKEN) <= 80 and re.fullmatch(r"[A-Za-z0-9_-]+", VERIFICATION_TOKEN)):
    log.warning(
        "eBay 검증 토큰 형식이 규격을 벗어납니다(32~80자, 영숫자/밑줄/하이픈): len=%d",
        len(VERIFICATION_TOKEN),
    )

EBAY_API_BASE = (os.environ.get("EBAY_API_BASE") or "https://api.ebay.com").rstrip("/")

# 이 주소로 보내는 토큰 요청에는 EBAY_CLIENT_SECRET 이 담긴 Basic 인증 헤더가 실린다.
# http:// 로 오설정되면 그 자격증명이 평문으로 나가고, 중간자가 우리 앱을 통째로 흉내낼 수 있다.
# EBAY_DELETION_ENDPOINT 쪽은 이미 검사하고 있었는데 이쪽만 비어 있었다(감사 후속).
# 샌드박스도 https 이므로 예외를 둘 이유가 없다 — 경고가 아니라 기동 거부다.
_api = urlsplit(EBAY_API_BASE)
if _api.scheme.lower() != "https" or not _api.netloc:
    raise RuntimeError(
        f"EBAY_API_BASE 는 https:// 주소여야 합니다 (현재: {EBAY_API_BASE!r}). "
        "이 주소로 EBAY_CLIENT_SECRET 이 담긴 Basic 인증 헤더를 보내므로 http 면 평문으로 유출됩니다. "
        "운영: https://api.ebay.com / 샌드박스: https://api.sandbox.ebay.com"
    )

EBAY_CLIENT_ID = (os.environ.get("EBAY_CLIENT_ID") or "").strip()
EBAY_CLIENT_SECRET = (os.environ.get("EBAY_CLIENT_SECRET") or "").strip()
_HAS_EBAY_CREDS = bool(EBAY_CLIENT_ID and EBAY_CLIENT_SECRET)
if not _HAS_EBAY_CREDS:
    log.warning(
        "EBAY_CLIENT_ID/EBAY_CLIENT_SECRET 이 없어 서명을 검증할 수 없습니다. "
        "POST %s 로 오는 모든 알림은 거절 기록만 남고 큐에 들어가지 않습니다 "
        "(검증 불가 상태에서 통과시키지 않는 것이 이 경로의 안전 기본값입니다).",
        _PATH,
    )

TRUST_FORWARDED = (os.environ.get("EBAY_TRUST_FORWARDED") or "").strip() in ("1", "true", "yes")

# 큐 파일을 기동 시점에 만들어 둔다. 알림이 들어온 뒤에야 '쓸 수 없는 경로였다'는 것을
# 알게 되면 그 알림은 이미 잃어버린 뒤다(eBay 는 200 을 받고 재시도하지 않는다).
try:
    ebay_queue.init()
except Exception as e:                            # noqa: BLE001 - 원인을 사람이 읽을 수 있게 다시 던진다
    raise RuntimeError(
        f"eBay 삭제 알림 큐를 열 수 없습니다 (db={ebay_queue.DB_PATH}): {type(e).__name__}: {e}. "
        "EBAY_QUEUE_DIR(전용 디렉터리) 또는 EBAY_QUEUE_DB 경로에 쓰기 권한이 있는지 확인하세요. "
        "이 큐가 없으면 받은 삭제 알림을 잃어버리게 되므로 기동하지 않습니다."
    ) from e

# ── 레이트리밋 ───────────────────────────────────────────────
# 무인증 경로라 요청 수 자체를 막지 않으면 CPU·디스크·eBay 아웃바운드 호출이 모두 고갈된다.
# 본문을 읽기 전에 판정한다.
RATE_WINDOW_SEC = 60.0
# 기본값을 30/120 에서 120/600 으로 올렸다(2026-09-16 3차 회귀검토).
#   예전 30/120 은 "상한을 넘으면 200 으로 조용히 버린다"는 전제에서 정해진 숫자였다.
#   지금은 상한 초과가 429 이고, 429 는 **eBay 의 엔드포인트 건강도에 그대로 집계된다** —
#   즉 상한이 낮으면 우리가 스스로 엔드포인트를 down 으로 몰아간다.
#   레이트리밋의 목적은 디스크·CPU·아웃바운드 고갈을 막는 것이지 정상 알림을 억제하는 것이 아니다.
#   · per-IP 120: eBay 의 egress IP 는 한 줌이라 모든 계정의 알림이 같은 몇 개 IP 로 몰린다.
#     재기동·장애 복구 뒤 밀린 알림이 한꺼번에 재전송되는 순간이 가장 위험한데,
#     초당 2건(=분당 120)까지는 정상 트래픽으로 보고 통과시킨다.
#   · 전역 600: 초당 10건. 본문 상한 64KB 를 곱해도 분당 최대 ~37MB 라 디스크·CPU 방어선으로 충분하다.
#   이보다 더 내리려면 "eBay 가 이 상한에 걸릴 수 있는가"를 먼저 따져야 한다.
RATE_PER_IP = int(os.environ.get("EBAY_RATE_PER_IP") or 120)
RATE_GLOBAL = int(os.environ.get("EBAY_RATE_GLOBAL") or 600)
_MAX_TRACKED_IPS = 4096

# 공개키 캐시 미스(= eBay 로 나가는 아웃바운드 호출)에 대한 별도의 훨씬 빡빡한 상한.
# 일반 상한과 같은 예산을 쓰면 무인증 POST 120건이 그대로 eBay API 호출 120건으로 증폭된다.
# 정상 운영에서 kid 는 한 줌이고 24시간 캐시되므로 미스는 하루에 몇 번뿐이다.
# 이 값을 낮게 유지할 수 있는 근거는 아래 single-flight 다 — 콜드 캐시에서 같은 kid 로
# 동시에 몰려도 예산은 1칸만 쓴다(_KeyFetch 주석). 그게 없으면 이 숫자가 정품 알림을 막는다.
RATE_KEYFETCH_PER_IP = int(os.environ.get("EBAY_RATE_KEYFETCH_PER_IP") or 3)
RATE_KEYFETCH_GLOBAL = int(os.environ.get("EBAY_RATE_KEYFETCH_GLOBAL") or 12)


class _FixedWindowLimiter:
    """분 단위 고정 창 카운터. 정밀할 필요는 없고 '폭주를 끊는' 것이 목적이라 단순하게 간다.

    ⚠ 판정 순서가 중요하다: **per-key 를 먼저 보고, 거기서 버릴 요청은 전역 예산을 건드리지 않는다.**
      예전에는 전역 카운터를 무조건 먼저 올렸다. 그러면 한 IP 가 200회를 두드릴 때
      per-ip 상한에서 끊기는데도 전역 예산은 이미 소진돼, 그 창 동안 **진짜 eBay 알림까지**
      전역 상한에 걸려 차단됐다(실측 확인). 한 IP 가 전역 예산을 먹어치울 수 있으면
      레이트리밋 자체가 서비스 거부 도구가 된다.

    ⚠ 그런데 순서를 뒤집으면서 **전역에서 버릴 요청까지 per-key 슬롯을 만들던** 버그가 생겼었다.
      예전(전역 먼저)에는 전역 예산이 바닥나면 _per_key 를 건드리기 전에 리턴해서
      새 키 유입이 자동으로 분당 global_limit 개로 제한됐다. per-key 를 먼저 보게 되자
      전역에서 어차피 거절될 요청도 매번 슬롯을 만들었고, 서로 다른 키가 쏟아지면
      테이블이 넘쳐 _evict 가 clear() 를 하는데 **그 순간 정상 IP 들의 카운터까지 0 으로 돌아갔다.**
      즉 per-IP 상한이 꼭 필요한 상황(분산 요청)에서 정확히 꺼졌다.
      그래서 지금은 **슬롯이 없던 키는 전역 판정까지 통과한 뒤에야 삽입한다.**
      (이미 슬롯이 있는 키는 전역에서 거절되더라도 카운트를 소비하지 않는 성질을 그대로 유지한다.)
    """

    def __init__(self, *, per_key_limit: int, global_limit: int, name: str,
                 max_keys: int = _MAX_TRACKED_IPS):
        self._lock = threading.Lock()
        self._per_key: dict[str, list] = {}       # key -> [창 시작시각, 카운트]
        self._global = [0.0, 0]
        self._per_key_limit = per_key_limit
        self._global_limit = global_limit
        self._name = name
        self._max_keys = max_keys

    def allow(self, key: str) -> tuple[bool, str]:
        now = time.monotonic()
        with self._lock:
            # 1) per-key 먼저. 여기서 거절되면 전역 카운터는 손대지 않는다.
            #    단, **아직 아무것도 쓰지 않는다** — 슬롯 생성은 전역 판정 뒤로 미룬다.
            slot = self._per_key.get(key)
            expired = slot is None or now - slot[0] >= RATE_WINDOW_SEC
            used = 0 if expired else slot[1]
            if used >= self._per_key_limit:
                return False, "per-ip"

            # 2) 전역은 per-key 를 통과한 요청만 소비한다.
            if now - self._global[0] >= RATE_WINDOW_SEC:
                self._global = [now, 0]
            if self._global[1] >= self._global_limit:
                # 전역 예산이 바닥났으면 per-key 쪽은 아무것도 하지 않는다 —
                # 카운터를 올리지도, **슬롯을 새로 만들지도** 않는다.
                # 슬롯을 만들면 어차피 버릴 요청이 추적 테이블을 밀어내 _evict 의 clear() 를
                # 유발하고, 그 clear() 가 정상 IP 들의 카운터까지 지워 per-IP 상한을 무력화한다.
                # 만들지 않으면 새 키 유입이 전역 예산(분당 global_limit)으로 자연히 유계가 된다.
                return False, "global"

            # 3) 통과 확정. 이제서야 슬롯을 만들거나 창을 새로 연다.
            if expired:
                # 새 키를 넣기 '전에' 자리를 만든다. 삽입 후에 비우면(_evict 의 clear())
                # 방금 넣은 slot 이 dict 에서 사라진 고아 리스트가 되어 아래 slot[1] += 1 이
                # 어디에도 반영되지 않는다 — 그 키는 사실상 무제한이 된다.
                if key not in self._per_key and len(self._per_key) >= self._max_keys:
                    self._evict(now)
                slot = [now, 0]
                self._per_key[key] = slot

            slot[1] += 1
            self._global[1] += 1
            return True, ""

    def _evict(self, now: float) -> None:
        """창이 지난 항목부터 버린다. 그래도 넘치면 통째로 비운다 — 메모리가 무한히 늘지 않게.

        호출부가 '새 키를 삽입하기 직전'에만 부른다. 삽입 뒤에 부르면 clear() 가
        방금 만든 슬롯을 고아로 만들어 그 요청의 카운트가 유실된다(위 allow 주석 참고).
        """
        stale = [k for k, v in self._per_key.items() if now - v[0] >= RATE_WINDOW_SEC]
        for k in stale:
            self._per_key.pop(k, None)
        if len(self._per_key) < self._max_keys:
            return

        # 아직도 넘친다. 통째로 비우기 전에 **상한에 걸려 있는 키는 남긴다** —
        # clear() 는 그 순간 차단 중이던 IP 들의 카운터까지 0 으로 되돌려,
        # per-IP 상한이 가장 필요한 상황(서로 다른 키가 쏟아지는 분산 요청)에서 정확히 꺼진다.
        # (전역 예산이 max_keys 보다 작게 잡혀 있으면 — 기본값 600 < 4096 — 한 창에 들어올 수
        #  있는 새 키가 전역 예산으로 유계라 여기까지 오지 않는다. 오설정 대비 안전망이다.)
        blocked = {k: v for k, v in self._per_key.items() if v[1] >= self._per_key_limit}
        if len(blocked) < len(self._per_key):
            log.warning("eBay 알림 레이트리밋(%s) 추적 테이블이 가득 차 %d개를 버렸습니다"
                        "(차단 중인 %d개는 유지).",
                        self._name, len(self._per_key) - len(blocked), len(blocked))
            self._per_key = blocked
        if len(self._per_key) >= self._max_keys:
            # 차단 중인 키만으로 테이블이 찼다 = 진짜 대규모 분산 요청. 메모리를 지키는 쪽을 택한다.
            self._per_key.clear()
            log.warning("eBay 알림 레이트리밋(%s) 추적 테이블이 가득 차 초기화했습니다(분산 요청 의심).",
                        self._name)


_limiter = _FixedWindowLimiter(
    per_key_limit=RATE_PER_IP, global_limit=RATE_GLOBAL, name="request")
# 아웃바운드 유발 요청 전용 예산. 추적 키가 적어도 되므로 테이블도 작게 잡는다.
_keyfetch_limiter = _FixedWindowLimiter(
    per_key_limit=RATE_KEYFETCH_PER_IP, global_limit=RATE_KEYFETCH_GLOBAL,
    name="key-fetch", max_keys=1024)

# 레이트리밋에 걸린 요청까지 한 건씩 DB 에 적으면 그 기록 자체가 공격 수단이 된다.
# 사유별로 창당 한 줄만 남긴다.
_rl_note_lock = threading.Lock()
_rl_last_note: dict[str, float] = {}


def _note_ratelimit(scope: str, ip: str, dropped_path: str) -> None:
    now = time.monotonic()
    with _rl_note_lock:
        last = _rl_last_note.get(scope, 0.0)
        if now - last < RATE_WINDOW_SEC:
            return
        _rl_last_note[scope] = now
    log.warning("eBay 알림 레이트리밋 초과(%s, ip=%s, path=%s) — 요청을 버립니다.", scope, ip, dropped_path)
    try:
        ebay_queue.record_rejection(
            reason="rate-limited", detail=scope, source_ip=ip,
        )
    except Exception as e:                        # noqa: BLE001 - 기록 실패가 200 을 깨뜨리면 안 된다
        log.error("eBay 레이트리밋 기록 실패: %s", type(e).__name__)


def _client_ip(request: Request) -> str:
    """레이트리밋 키. XFF 는 위조 가능하므로 기본적으로 믿지 않는다."""
    if TRUST_FORWARDED:
        fwd = request.headers.get("x-forwarded-for")
        if fwd:
            return fwd.split(",")[0].strip()[:64] or "unknown"
    client = request.client
    return (client.host if client else "unknown")[:64]


def _clip(value) -> str | None:
    """로그에 남길 값은 문자열로만, 그것도 길이를 잘라서 남긴다."""
    if not isinstance(value, str):
        return None
    return value[:MAX_FIELD_CHARS]


def _challenge_response(challenge_code: str) -> str:
    """challengeCode + verificationToken + endpointURL 을 이 순서로 이어 SHA-256."""
    h = hashlib.sha256()
    h.update(challenge_code.encode("utf-8"))
    h.update(VERIFICATION_TOKEN.encode("utf-8"))
    h.update(ENDPOINT_URL.encode("utf-8"))
    return h.hexdigest()


# ── 서명 검증 ────────────────────────────────────────────────
# eBay 의 x-ebay-signature 는 base64(JSON) 이고 {"alg","kid","signature","digest"} 를 담는다.
# 이 헤더의 '모양'만 보던 예전 코드는 누구나 위조 통과가 가능했다(감사 §ebay-webhook).
# 이제는 eBay Notification API 로 공개키를 받아 **수신한 원본 바이트**에 대해 실제로 검증한다.
_SIGNATURE_FIELDS = ("alg", "kid", "signature", "digest")
MAX_SIGNATURE_HEADER = 4096
# kid 는 그대로 URL 에 붙는다. 경로 조작·과도한 길이를 원천 차단한다.
_KID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

# eBay 서명은 SHA1 다이제스트 위의 ECDSA(P-256) 다. SHA1 은 우리 선택이 아니라
# eBay 규격이며, 공개키 응답의 digest 필드가 알려주는 값을 그대로 따른다.
_DIGESTS = {
    "SHA1": hashes.SHA1, "SHA-1": hashes.SHA1,
    "SHA256": hashes.SHA256, "SHA-256": hashes.SHA256,
}

# 공개키 캐시 (kid -> (public_key, digest_name, 만료시각)) — **양성 키만** 담는다.
# 부정 캐시('이 kid 는 eBay 가 모른다')는 _neg_cache 라는 **분리된 공간**에 담는다.
#   왜 분리하나: 예전에는 한 dict 에 섞여 있고 축출이 FIFO 였다. 공격자가 매번 다른 kid 를
#   보내면 가짜 항목 33개만으로 **진짜 eBay kid 가 캐시에서 밀려나** 매 알림마다 다시
#   아웃바운드 호출이 나갔다(증폭 + eBay 레이트리밋 소진). 공간을 나누면 가짜는 가짜끼리만
#   밀어낸다. 양성 키 공간에는 공격자가 아무것도 넣을 수 없다.
_KEY_TTL_SEC = 24 * 3600
_NEG_TTL_SEC = 600
_MAX_KEY_CACHE = 32                               # 양성 키 — 정상 운영에서 kid 는 한 줌이다
_MAX_NEG_CACHE = 256                              # 부정 캐시 — 가짜 kid 는 여기서만 논다
_key_cache: dict[str, tuple] = {}
_neg_cache: dict[str, float] = {}                 # kid -> 만료시각
_key_lock = asyncio.Lock()


class _KeyFetch:
    """같은 kid 에 대한 동시 조회를 한 건으로 합치기 위한 in-flight 표식(single-flight).

    왜 필요한가: 캐시 확인은 _key_lock 안에서 하는데 예산 소비와 아웃바운드는 락 밖이라,
      같은 kid 에 대한 동시 요청 N건이 **각각** 예산을 쓰고 **각각** 아웃바운드를 냈다.
      재기동 직후(캐시가 비어 있고 eBay 가 밀린 알림을 한꺼번에 재전송)나 24시간 TTL 만료
      시점에 같은 eBay egress IP 에서 몇 건만 겹쳐도 key-fetch 예산이 즉시 바닥나
      정품 알림이 503 으로 되튕겼다 — 정상 운영 중 우리가 스스로 만드는 5xx 다.
    이제 첫 요청만 예산을 쓰고 나가며, 나머지는 그 결과를 기다려 그대로 공유한다.
    """

    __slots__ = ("event", "result")

    def __init__(self) -> None:
        self.event = asyncio.Event()
        self.result: tuple | None = None          # (key|None, digest_name, 사유)


_key_inflight: dict[str, _KeyFetch] = {}          # kid -> 진행 중인 조회 (반드시 _key_lock 아래에서만 만진다)
# 대기 상한. 아웃바운드는 토큰 발급(연결5+읽기10)과 공개키 조회(연결5+읽기10)를 합쳐
# 최악 30초다. 그보다 조금 길게 잡아 '기다리다 같이 멈추는' 일이 없게 한다.
_KEYFETCH_WAIT_SEC = 35.0

# application access token 캐시 (값, 만료시각)
_token_cache = {"value": None, "expires_at": 0.0}
_token_lock = asyncio.Lock()

_EBAY_TIMEOUT = httpx.Timeout(connect=5.0, read=10.0, write=10.0, pool=5.0)


def _sig_fingerprint(raw_header: str | None) -> str | None:
    """헤더 원문 대신 남길 지문. 같은 위조 헤더가 반복되는지 식별만 하면 된다."""
    if not raw_header:
        return None
    return hashlib.sha256(raw_header.encode("utf-8", "replace")).hexdigest()[:32]


def _parse_signature_header(raw_header: str | None) -> tuple[dict | None, str]:
    """헤더를 파싱해 (필드 dict, 사유) 를 돌려준다. 구조 검사일 뿐, 이것만으로는 통과가 아니다."""
    if not raw_header:
        return None, "missing-header"
    if len(raw_header) > MAX_SIGNATURE_HEADER:
        return None, "oversized-header"
    try:
        decoded = base64.b64decode(raw_header, validate=True)
        parsed = json.loads(decoded)
    except (binascii.Error, ValueError, UnicodeDecodeError):
        return None, "malformed-header"
    if not isinstance(parsed, dict):
        return None, "malformed-header"
    for field in _SIGNATURE_FIELDS:
        value = parsed.get(field)
        if not isinstance(value, str) or not value.strip():
            return None, f"missing-field:{field}"
    if not _KID_RE.fullmatch(parsed["kid"]):
        return None, "bad-kid"
    return parsed, "structure-ok"


async def _app_access_token(client: httpx.AsyncClient) -> str | None:
    """client_credentials 로 application access token 을 받아 캐시한다."""
    now = time.monotonic()
    async with _token_lock:
        if _token_cache["value"] and now < _token_cache["expires_at"]:
            return _token_cache["value"]
        basic = base64.b64encode(
            f"{EBAY_CLIENT_ID}:{EBAY_CLIENT_SECRET}".encode("utf-8")
        ).decode("ascii")
        try:
            resp = await client.post(
                f"{EBAY_API_BASE}/identity/v1/oauth2/token",
                headers={
                    "Authorization": f"Basic {basic}",
                    "Content-Type": "application/x-www-form-urlencoded",
                },
                data={
                    "grant_type": "client_credentials",
                    "scope": "https://api.ebay.com/oauth/api_scope",
                },
            )
        except httpx.HTTPError as e:
            log.error("eBay 토큰 발급 실패(네트워크): %s", type(e).__name__)
            return None
        if resp.status_code != 200:
            # 본문에 자격증명이 섞여 나올 수 있으므로 상태코드만 남긴다.
            log.error("eBay 토큰 발급 실패: HTTP %s", resp.status_code)
            return None
        try:
            body = resp.json()
            token = body["access_token"]
            expires_in = int(body.get("expires_in") or 7200)
        except (ValueError, KeyError, TypeError):
            log.error("eBay 토큰 응답 형식이 예상과 다릅니다.")
            return None
        # 만료 60초 전에 미리 갱신되게 여유를 둔다.
        _token_cache["value"] = token
        _token_cache["expires_at"] = time.monotonic() + max(60, expires_in - 60)
        return token


def _load_public_key(key_text: str):
    """eBay 가 주는 key 문자열을 공개키 객체로. PEM 헤더가 없거나 \\n 이 이스케이프된 경우도 받는다."""
    text = (key_text or "").strip()
    if "BEGIN" not in text:
        body = re.sub(r"\s+", "", text)
        lines = [body[i:i + 64] for i in range(0, len(body), 64)]
        text = "-----BEGIN PUBLIC KEY-----\n" + "\n".join(lines) + "\n-----END PUBLIC KEY-----\n"
    else:
        text = text.replace("\\n", "\n")
    key = serialization.load_pem_public_key(text.encode("ascii"))
    if not isinstance(key, ec.EllipticCurvePublicKey) or not isinstance(key.curve, ec.SECP256R1):
        raise ValueError("eBay 공개키가 ECDSA NIST P-256 이 아닙니다.")
    return key


def _cached_key_result(kid: str):
    """캐시에 이미 답이 있으면 결과 튜플을, 없으면 None. **_key_lock 을 잡은 채로** 부른다."""
    now = time.monotonic()
    cached = _key_cache.get(kid)
    if cached and now < cached[2]:
        return cached[0], cached[1], "cached"
    neg_until = _neg_cache.get(kid)
    if neg_until and now < neg_until:
        return None, "", "unknown-kid(cached)"
    return None


async def _fetch_public_key(kid: str, ip: str):
    """kid 로 공개키를 받아 캐시한다. (key|None, digest_name, 사유) 를 돌려준다.

    같은 kid 에 대한 동시 요청은 single-flight 로 합친다(_KeyFetch 주석 참고) —
    첫 요청만 예산을 쓰고 아웃바운드를 내고, 나머지는 그 결과를 기다려 공유한다.
    """
    async with _key_lock:
        hit = _cached_key_result(kid)
        if hit is not None:
            return hit
        inflight = _key_inflight.get(kid)
        owner = inflight is None
        if owner:
            inflight = _KeyFetch()
            _key_inflight[kid] = inflight

    if not owner:
        # 두 번째 이후의 동시 요청: 예산을 쓰지 않고 첫 요청의 결과를 기다린다.
        try:
            await asyncio.wait_for(inflight.event.wait(), _KEYFETCH_WAIT_SEC)
        except (asyncio.TimeoutError, TimeoutError):
            log.warning("eBay 공개키 조회 대기 시간 초과(kid=%s, ip=%s) — 재시도로 넘깁니다.", kid, ip)
            return None, "", "key-fetch-wait-timeout"
        if inflight.result is None:
            # 첫 요청이 예외·취소로 끝났다. 검증을 '못한' 것이므로 우리 쪽 장애로 분류한다.
            log.warning("eBay 공개키 조회 선행 요청이 결과 없이 끝났습니다(kid=%s).", kid)
            return None, "", "key-fetch-wait-failed"
        return inflight.result

    result = None
    try:
        result = await _fetch_public_key_uncached(kid, ip)
        return result
    finally:
        # 어떤 경로로 빠져나가든 in-flight 표식을 치우고 대기자를 깨운다.
        # 여기서 깨우지 않으면 같은 kid 의 요청들이 _KEYFETCH_WAIT_SEC 동안 통째로 묶인다.
        #
        # ⚠ 이 블록에서는 **절대 await 하지 않는다.** 예전에는 `async with _key_lock:` 으로
        #   락을 잡았는데, 락 획득이 await 지점이라 거기서 취소(클라이언트 연결 끊김,
        #   서버 종료)가 전달되면 pop 도 event.set() 도 실행되지 않고 _key_inflight[kid] 가
        #   **영구히** 남았다. 그 뒤로는 같은 kid 의 모든 알림이 _KEYFETCH_WAIT_SEC 를 기다린 뒤
        #   503 이 되고 재기동 전까지 회복하지 않는다 — 규정 기한이 걸린 무인증 엔드포인트의
        #   무증상 영구 장애다. dict 조작과 Event.set() 은 await 이 없어 이벤트 루프 안에서
        #   원자적이므로 락이 필요 없다.
        #   pop 은 '내가 넣은 그 객체일 때만' 한다 — 내가 pop 한 뒤 다른 요청이 새로 등록한
        #   _KeyFetch 를 실수로 지우지 않기 위해서다.
        if _key_inflight.get(kid) is inflight:
            del _key_inflight[kid]
        inflight.result = result                  # 예외로 나가면 None — 대기자가 그걸 보고 판단한다
        inflight.event.set()


async def _fetch_public_key_uncached(kid: str, ip: str):
    """실제 아웃바운드 경로. _fetch_public_key 가 kid 당 한 번만 부른다.

    캐시 미스는 곧 eBay 로 나가는 아웃바운드 호출이다. 무인증 POST 가 그것을 무제한으로
    유발하지 못하게, 미스 경로에만 별도의 빡빡한 창당 상한을 건다.
    """
    # 여기서부터가 아웃바운드. 전용 예산을 먼저 확인한다.
    ok, scope = _keyfetch_limiter.allow(ip)
    if not ok:
        # '우리 쪽 사정으로 검증하지 못했다'로 분류한다(→ 5xx → eBay 재시도).
        # 공격자가 예산을 태워 진짜 알림을 밀어내더라도, 재시도되므로 소실되지는 않는다.
        log.warning("eBay 공개키 조회 상한 초과(%s, ip=%s, kid=%s) — 이 알림은 재시도로 넘깁니다.",
                    scope, ip, kid)
        return None, "", "key-fetch-throttled"

    # 예산을 얻는 동안(락 밖이다) 다른 요청이 캐시를 채웠을 수 있다. 한 번 더 본다 —
    # 이미 있는 키를 다시 받아오는 아웃바운드는 순수한 낭비다.
    async with _key_lock:
        hit = _cached_key_result(kid)
        if hit is not None:
            return hit

    async with httpx.AsyncClient(timeout=_EBAY_TIMEOUT, trust_env=False,
                                 follow_redirects=False) as client:
        token = await _app_access_token(client)
        if not token:
            return None, "", "token-unavailable"      # 부정 캐시에 넣지 않는다(우리 쪽 장애)
        try:
            resp = await client.get(
                f"{EBAY_API_BASE}/commerce/notification/v1/public_key/{kid}",
                headers={"Authorization": f"Bearer {token}"},
            )
        except httpx.HTTPError as e:
            log.error("eBay 공개키 조회 실패(네트워크): %s", type(e).__name__)
            return None, "", "public-key-network-error"

    if resp.status_code == 401:
        # 토큰이 만료·폐기됐을 수 있으니 캐시를 비워 다음 요청에서 다시 받게 한다.
        async with _token_lock:
            _token_cache["value"] = None
            _token_cache["expires_at"] = 0.0
        return None, "", "public-key-unauthorized"
    if resp.status_code == 404:
        # eBay 가 모르는 kid = 위조. 부정 캐시에만 넣는다(양성 키 공간은 건드리지 않는다).
        async with _key_lock:
            if len(_neg_cache) >= _MAX_NEG_CACHE:
                _neg_cache.pop(next(iter(_neg_cache)), None)
            _neg_cache[kid] = time.monotonic() + _NEG_TTL_SEC
        return None, "", "unknown-kid"
    if resp.status_code != 200:
        return None, "", f"public-key-http-{resp.status_code}"

    try:
        body = resp.json()
        key = await run_in_threadpool(_load_public_key, body.get("key"))
        digest_name = str(body.get("digest") or "SHA1").upper()
    except (ValueError, TypeError, UnsupportedAlgorithm) as e:
        log.error("eBay 공개키 해석 실패(kid=%s): %s", kid, type(e).__name__)
        return None, "", "public-key-unparseable"

    async with _key_lock:
        if len(_key_cache) >= _MAX_KEY_CACHE:
            # 가장 먼저 들어온 것부터 버린다. 여기 들어오는 것은 eBay 가 200 으로 돌려준
            # 진짜 키뿐이라(가짜 kid 는 위의 부정 캐시로 빠진다) 사실상 걸리지 않는다.
            _key_cache.pop(next(iter(_key_cache)), None)
        _key_cache[kid] = (key, digest_name, time.monotonic() + _KEY_TTL_SEC)
    return key, digest_name, "fetched"


def _verify_signature_bytes(key, digest_name: str, signature_b64: str, payload: bytes) -> bool:
    algo = _DIGESTS.get((digest_name or "SHA1").upper())
    if algo is None:
        log.error("알 수 없는 eBay 서명 다이제스트: %r", digest_name)
        return False
    try:
        sig = base64.b64decode(signature_b64, validate=True)
    except (binascii.Error, ValueError):
        return False
    try:
        key.verify(sig, payload, ec.ECDSA(algo()))
        return True
    except (InvalidSignature, ValueError, TypeError):
        return False


# '우리 쪽 장애' 목록 — 여기 해당하면 200 이 아니라 5xx 를 돌려 eBay 가 재시도하게 한다.
# 기준은 단 하나: **이 요청을 다시 보내면 성공할 가능성이 있는가.**
#   있다 → 우리 문제 → 재시도시켜야 한다. 200 을 주면 정품 알림이 조용히 사라진다.
#   없다 → 상대가 가짜 → 200. 재시도해 봐야 똑같은 위조가 다시 올 뿐이고,
#          5xx 를 주면 공격자가 우리 엔드포인트를 down 으로 만들 수 있다.
_OUR_FAULT_REASONS = frozenset({
    "no-ebay-credentials",        # 우리 배포에 EBAY_CLIENT_ID/SECRET 이 없다
    "token-unavailable",          # application access token 발급 실패
    "public-key-network-error",   # eBay 공개키 API 에 못 닿았다
    "public-key-unauthorized",    # 401 — 우리 토큰/자격증명 문제
    "public-key-unparseable",     # 200 인데 우리가 해석 못했다 = 우리 코드 문제
    "key-fetch-throttled",        # 아웃바운드 예산 소진 — 검증을 '못한' 것이지 실패한 게 아니다
    "key-fetch-wait-timeout",     # 같은 kid 의 선행 조회를 기다리다 시간 초과
    "key-fetch-wait-failed",      # 같은 kid 의 선행 조회가 결과 없이 끝남(예외·취소)
    "queue-error",                # 검증은 통과했는데 큐에 못 넣었다
})


def _is_our_fault(reason: str) -> bool:
    """이 거절이 '우리 쪽 장애'인가(=eBay 가 재시도해야 하는가)."""
    if reason in _OUR_FAULT_REASONS:
        return True
    # eBay 공개키 API 가 200/404 가 아닌 것을 돌려준 경우.
    # 404 는 '모르는 kid' = 위조라 여기로 오지 않는다. 나머지(5xx, 429, 403…)는
    # 상대(eBay)나 우리 설정 문제이지 요청자가 가짜라는 증거가 아니므로 재시도시킨다.
    return reason.startswith("public-key-http-")


async def _verify_notification(raw_header: str | None, payload: bytes,
                               ip: str) -> tuple[bool, str, str | None]:
    """(검증통과, 사유, kid) 를 돌려준다. 통과하지 못하면 어떤 파괴적 동작도 하지 않는다.

    사유 문자열은 그대로 _is_our_fault() 의 입력이 되므로 임의로 바꾸지 말 것
    (바꾸면 '우리 장애'가 조용히 200 으로 분류돼 알림이 사라진다).
    """
    if not _HAS_EBAY_CREDS:
        # 자격증명이 없으면 '검증을 안 한 것'이지 '통과한 것'이 아니다. 조용히 넘기지 않는다.
        return False, "no-ebay-credentials", None
    parsed, reason = _parse_signature_header(raw_header)
    if parsed is None:
        return False, reason, None
    kid = parsed["kid"]
    key, digest_name, fetch_reason = await _fetch_public_key(kid, ip)
    if key is None:
        return False, fetch_reason, kid
    # 헤더가 알려준 digest 보다 공개키 응답의 digest 를 우선한다(규격상 그쪽이 권위).
    digest_name = digest_name or parsed.get("digest") or "SHA1"
    ok = await run_in_threadpool(
        _verify_signature_bytes, key, digest_name, parsed["signature"], payload
    )
    if not ok:
        return False, "signature-mismatch", kid
    return True, "verified", kid


# ── 리플레이 방지 ────────────────────────────────────────────
# notificationId 중복은 ebay_queue 의 UNIQUE 제약이 잡는다(재전송 = duplicate).
# eventDate 는 '너무 오래된 서명 원본을 그대로 다시 쏘는' 경우를 막는다.
EVENT_MAX_AGE = timedelta(hours=int(os.environ.get("EBAY_EVENT_MAX_AGE_HOURS") or 168))
EVENT_MAX_SKEW = timedelta(minutes=5)


def _event_freshness(event_date: str | None) -> tuple[bool, str]:
    if not event_date:
        return False, "missing-eventDate"
    text = event_date.strip().replace("Z", "+00:00")
    try:
        ts = datetime.fromisoformat(text)
    except ValueError:
        return False, "bad-eventDate"
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    now = datetime.now(timezone.utc)
    if ts - now > EVENT_MAX_SKEW:
        return False, "future-eventDate"
    if now - ts > EVENT_MAX_AGE:
        return False, "stale-eventDate"
    return True, "fresh"


# ── 삭제 이행은 이 프로세스에 없다 ───────────────────────
# 예전에 여기 있던 _purge_records_for_user() 는 2026-09-16 자로 **삭제**했다.
#   · 호출부가 0건인 죽은 코드였고,
#   · 함수 안에서 db/crypto 를 지연 import 하는 바람에 serve_public.py 의 모듈 격리 점검
#     (import 시점에 sys.modules 를 1회 검사)을 원리적으로 우회했다.
#     즉 인터넷에 열린 프로세스 안에 'admin.db 로 가는 완성된 가젯'이 남아 있었다 —
#     이 프로세스의 임의 코드 실행 결함 하나가 곧 인증키 전량 삭제가 된다는 뜻이다.
# 같은 기능은 내부 프로세스(serve_internal.py 의 _purge_records_for_user)에만 있다.
# 이 파일에 되살리지 말 것. 공개 표면은 admin.db 에 도달할 코드 경로를 **하나도** 가지지 않는다.


# ── 라우트 ───────────────────────────────────────────────────
@router.get(_PATH)
async def ebay_deletion_challenge(request: Request):
    """eBay 가 엔드포인트 검증 때 부르는 곳. 브라우저로 열어보면 400 이 정상이다.

    ⚠ 이 응답 규격(200 / application/json / {"challengeResponse": hex}, 해시 입력 순서)은
      eBay 엔드포인트 검증이 통과하는 조건 그 자체다. 바꾸지 말 것.
    """
    ip = _client_ip(request)
    allowed, scope = _limiter.allow(ip)
    if not allowed:
        _note_ratelimit(scope, ip, _PATH)
        # 검증 요청까지 막지 않도록 상한은 넉넉하다. 그래도 넘치면 429 로 알려 재시도를 유도한다.
        return JSONResponse({"error": "too many requests"}, status_code=429)

    if not VERIFICATION_TOKEN:
        # 토큰 없이 해시를 만들면 eBay 쪽 검증이 '조용히' 틀리게 되므로, 차라리 설정 오류로 알린다.
        log.error("eBay 검증 요청을 처리할 수 없습니다: EBAY_VERIFICATION_TOKEN 미설정")
        return JSONResponse(
            {"error": "서버에 eBay 검증 토큰(EBAY_VERIFICATION_TOKEN)이 설정되지 않았습니다."},
            status_code=503,
        )
    challenge_code = request.query_params.get("challenge_code")
    if not challenge_code:
        return JSONResponse({"error": "challenge_code 쿼리 파라미터가 필요합니다."}, status_code=400)
    log.info("ebay challenge ok (endpoint=%s)", ENDPOINT_URL)
    return JSONResponse({"challengeResponse": _challenge_response(challenge_code)})


RETRY_AFTER_SEC = int(RATE_WINDOW_SEC)


async def _reject(reason: str, *, ip: str, detail=None, sig_kid=None,
                  sig_digest=None, body: bytes | None = None,
                  verified: bool = False, status: int | None = None):
    """거절하고, '왜 거절했는지'와 '무엇을 거절했는지'를 반드시 남긴다(감사 §28).

    응답 코드는 사유가 정한다(status 를 명시하지 않으면 _is_our_fault 로 판정):
      · 상대가 가짜 → 200. eBay 는 재시도하지 않고, 우리도 재시도받을 이유가 없다.
      · 우리가 고장 → 503. eBay 가 재시도한다. 이 판정이 틀려서 200 을 주면
        **정품 알림이 그 자리에서 영구 소실된다** — 되돌릴 방법이 없다.
        반대로 잘못 503 을 주면 최악이라도 엔드포인트 down 이메일이 오는 정도다.

    body 는 원본 바이트 그대로 격리 저장한다. 사유만 남기고 본문을 버리면
    "어떤 userId 였는지"를 복구할 수 없어 사후 이행 자체가 불가능해진다.
    """
    if status is None:
        status = 503 if _is_our_fault(reason) else 200
    log.warning("ebay 삭제 알림 거절: reason=%s detail=%s ip=%s status=%d",
                reason, detail, ip, status)

    body_bytes = len(body) if body is not None else None

    def _persist() -> None:
        ref = None
        if body is not None:
            try:
                ref = ebay_queue.quarantine_body(
                    body, reason=reason, detail=detail, source_ip=ip,
                    sig_kid=sig_kid, sig_digest=sig_digest, verified=verified,
                )
            except Exception as e:                # noqa: BLE001 - 격리 실패가 거절 기록까지 막으면 안 된다
                log.error("ebay 본문 격리 실패: %s", type(e).__name__)
        ebay_queue.record_rejection(
            reason=reason, detail=detail, source_ip=ip,
            sig_kid=sig_kid, sig_digest=sig_digest, body_bytes=body_bytes,
            quarantine_ref=ref,
        )

    try:
        await run_in_threadpool(_persist)
    except Exception as e:                        # noqa: BLE001 - 기록 실패해도 응답은 돌려준다
        log.error("ebay 거절 기록 실패: %s", type(e).__name__)

    if status == 200:
        return JSONResponse({"ok": True})
    # 본문에 내부 사정을 적지 않는다(무인증 경로다). eBay 는 상태코드만 본다.
    return JSONResponse(
        {"ok": False, "error": "notification not processed; please retry"},
        status_code=status,
        headers={"Retry-After": str(RETRY_AFTER_SEC)},
    )


@router.post(_PATH)
async def ebay_deletion_notification(request: Request):
    """계정 삭제 알림 수신.

    **여기서 인증키를 지우지 않는다.** 서명 검증을 통과한 건만 pending 큐에 적재하고,
    실제 삭제는 내부 프로세스에서 관리자가 승인할 때 수행한다(eBay 이행 기한 30일).

    응답 코드 규칙은 모듈 docstring 과 _reject 를 보라. 요약하면 '우리가 처리하지 못한 건에는
    절대 2xx 를 주지 않는다' — 2xx 를 주는 순간 그 알림은 다시 오지 않는다.
    """
    ip = _client_ip(request)

    # 1) 레이트리밋 — 본문을 읽기 전에 끊는다. 읽고 나서 버리면 이미 대역폭·CPU 를 쓴 뒤다.
    allowed, scope = _limiter.allow(ip)
    if not allowed:
        _note_ratelimit(scope, ip, _PATH)
        # 예전에는 여기서 200 을 돌려줬다. 그러면 상한에 걸린 그 한 건이 **영구 소실**된다
        # (레이트리밋은 '가짜라서'가 아니라 '지금 우리가 못 받아서' 버리는 것이다).
        # 429 를 주면 eBay 가 잠시 뒤 다시 보내고, 그때는 창이 바뀌어 대개 통과한다.
        return JSONResponse(
            {"ok": False, "error": "too many requests"}, status_code=429,
            headers={"Retry-After": str(RETRY_AFTER_SEC)},
        )

    # 2) 본문 크기 상한 — proxy.py 와 같은 방식으로 스트림을 세어 가며 읽는다.
    raw = bytearray()
    oversized = False
    async for chunk in request.stream():
        if len(raw) + len(chunk) > MAX_NOTIFICATION_BYTES:
            oversized = True
            break
        raw.extend(chunk)
    if oversized:
        # 재시도해도 같은 크기로 다시 올 뿐이라 200. 대신 읽은 앞부분은 격리해 둔다
        # (계정 삭제 알림은 1KB 안팎이라 앞부분만으로도 userId 는 들어 있다).
        return await _reject("oversized-body", ip=ip, detail=f">{MAX_NOTIFICATION_BYTES}B",
                             body=bytes(raw))

    raw_header = request.headers.get("x-ebay-signature")
    fingerprint = _sig_fingerprint(raw_header)

    # 3) 서명을 실제로 검증한다. 원본 바이트 그대로 넣어야 한다(JSON 재직렬화 금지).
    verified, reason, kid = await _verify_notification(raw_header, bytes(raw), ip)
    if not verified:
        # ⚠ reason 이 '우리 쪽 장애'(토큰 발급 실패·공개키 조회 실패 등)면 503 이 나가고
        #   eBay 가 재시도한다. 위조(signature-mismatch·unknown-kid 등)면 200 이다.
        #   이 구분을 없애고 전부 200 으로 되돌리지 말 것 — 우리 장애 구간 동안의
        #   정품 알림이 통째로 사라진다.
        return await _reject(reason, ip=ip, detail="signature-verification", sig_kid=kid,
                             sig_digest=fingerprint, body=bytes(raw))

    # 여기서부터는 **서명 검증을 통과한 본문**이다 = 진짜 eBay 가 보낸 것.
    # 아래 거절들은 재시도해도 결과가 같으므로 200 이지만, 본문은 verified 격리 공간에
    # 남겨 사후 복구가 가능하게 한다(위조 본문과 저장 공간이 분리돼 있어 밀려나지 않는다).
    try:
        payload = json.loads(raw or b"{}")
    except (json.JSONDecodeError, UnicodeDecodeError):
        payload = None
    if not isinstance(payload, dict):
        return await _reject("bad-json", ip=ip, sig_kid=kid, sig_digest=fingerprint,
                             body=bytes(raw), verified=True)

    notification = payload.get("notification") if isinstance(payload.get("notification"), dict) else {}
    metadata = payload.get("metadata") if isinstance(payload.get("metadata"), dict) else {}
    data = notification.get("data") if isinstance(notification.get("data"), dict) else {}

    user_id = _clip(data.get("userId"))
    if not user_id:
        return await _reject("missing-userId", ip=ip, sig_kid=kid, sig_digest=fingerprint,
                             body=bytes(raw), verified=True)

    notification_id = _clip(notification.get("notificationId"))
    event_date = _clip(notification.get("eventDate"))

    # 4) 리플레이 방지 — 서명이 유효해도 '오래된 원본을 다시 쏘는' 것은 막는다.
    fresh, why = _event_freshness(event_date)
    if not fresh:
        return await _reject("replay", ip=ip, detail=why, sig_kid=kid,
                             sig_digest=fingerprint, body=bytes(raw), verified=True)
    if not notification_id:
        # notificationId 가 없으면 중복 제거 키가 없어 같은 알림을 무한히 쌓을 수 있다.
        return await _reject("missing-notificationId", ip=ip, sig_kid=kid,
                             sig_digest=fingerprint, body=bytes(raw), verified=True)

    topic = _clip(metadata.get("topic"))
    username = _clip(data.get("username"))

    # 5) 큐 적재. SQLite 는 동기라 이벤트 루프를 막지 않게 스레드로 넘긴다.
    #    (notificationId UNIQUE 이므로 eBay 재전송은 duplicate 로 흡수된다.)
    try:
        status = await run_in_threadpool(
            lambda: ebay_queue.enqueue_deletion(
                notification_id=notification_id, topic=topic, event_date=event_date,
                user_id=user_id, username=username, signature_kid=kid, source_ip=ip,
            )
        )
    except Exception as e:                        # noqa: BLE001
        # 큐에 못 넣었는데 200 을 주면 이 알림은 어디에도 남지 않는다 — 가장 나쁜 소실이다.
        # 503 으로 재시도를 받고, 본문은 격리해 둔다(재시도가 모두 실패해도 복구 가능하게).
        # notificationId 가 UNIQUE 라 재시도는 중복 없이 흡수된다.
        log.error("ebay 삭제 알림 큐 적재 실패: %s", type(e).__name__)
        return await _reject("queue-error", ip=ip, detail=type(e).__name__, sig_kid=kid,
                             sig_digest=fingerprint, body=bytes(raw), verified=True)

    log.info(
        "ebay account deletion queued(%s): userId=%s username=%s notificationId=%s kid=%s",
        status, user_id, username, notification_id, kid,
    )

    # 6) 영수증 사본 — 사람이 바로 열어보는 용도.
    #    여기까지 왔다면 큐 적재(= 진짜 근거)는 이미 커밋됐다. 사본 실패로 5xx 를 내면
    #    eBay 가 이미 처리된 알림을 계속 재시도하게 되므로, 이 실패는 삼키고 200 을 준다.
    try:
        await run_in_threadpool(
            lambda: ebay_queue.append_receipt({
                "receivedAt": datetime.now(timezone.utc).isoformat(),
                "topic": topic,
                "notificationId": notification_id,
                "eventDate": event_date,
                "userId": user_id,
                "username": username,
                # 이제 이 값은 '실제로 ECDSA 검증을 통과했다'는 뜻이다.
                "verified": True,
                "signatureKid": kid,
                "queue": status,
                # 이 경로는 삭제를 수행하지 않는다. 이행은 관리자 승인 후 내부 프로세스가 한다.
                "purged": False,
            })
        )
    except Exception as e:                        # noqa: BLE001 - 사본 실패가 이미 받은 알림을 되돌리면 안 된다
        log.error("ebay 영수증 기록 실패: %s", type(e).__name__)

    return JSONResponse({"ok": True})
