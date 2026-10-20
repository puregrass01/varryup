"""
VERY UP 관리자 서버 — **내부 프로세스** (Phase 2)
- 로그인 / 직원 계정 / 로그인 로그 / 인증키 / 라이선스 / 사용량 / 앱용 API / 프록시 릴레이 / 업데이트 배포
- 실행:  python -m uvicorn app:app --host <WireGuard IP> --port 8001

※ 표면 분리(보안감사_2026-09-16.md 3절 (b))
  이 모듈은 admin.db 와 KEY_MASTER·ADMIN_SECRET 를 모두 쥐는 **내부 프로세스 전용**이다.
  인터넷에서 도달 가능한 곳(privacy / eBay 알림 수신)에 이 모듈을 올리면 분리의 의미가 사라진다.
  - 여기서 include 하는 라우터는 proxy.router 와 public.internal_router 뿐이다.
  - ebay_notify 는 **공개 프로세스 전용**이라 여기서 import 하지 않는다(하위 호환 깨짐, 아래 주석 참고).
  - 공개 프로세스 진입점은 public.public_router + ebay_notify.router 만 include 하고 이 파일을 import 하지 않는다.

※ Starlette 의 Jinja2Templates 래퍼 대신 Jinja2 Environment 로 직접 렌더링한다.
  (최신 starlette/jinja2/python 조합에서 TemplateResponse 캐시 키 호환 이슈 회피)

※ 다른 모듈(serve_internal.py 등)이 쓰는 공개 헬퍼
  세션 쿠키로 인증하는 상태 변경 POST 라우트를 새로 만든다면 **반드시** CSRF 게이트를 통과시켜라.
    CSRF_FIELD_NAME                                  # "csrf_token" — 폼 hidden input 의 name
    issue_csrf_token(request) -> str                 # 세션 토큰 발급/조회
    csrf_input_html(request) -> str                  # '<input type="hidden" ...>' 마크업
    csrf_check(request, submitted) -> bool           # 일치 여부만 필요할 때
    require_csrf(request, submitted, back="/") -> None | HTMLResponse   # 통과하면 None
  자세한 사용법은 아래 'CSRF 방어' 절 주석 참고.
"""
import html
import json
import logging
import sys
import math
import os
import re
import secrets
import asyncio
import time
from datetime import datetime, timedelta, timezone

from fastapi import FastAPI, Request, Form, Header
from fastapi.responses import (HTMLResponse, RedirectResponse, JSONResponse,
                               StreamingResponse)
from starlette.concurrency import run_in_threadpool
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.middleware.sessions import SessionMiddleware
from jinja2 import Environment, FileSystemLoader, select_autoescape
from itsdangerous import URLSafeTimedSerializer, BadSignature, SignatureExpired

import config
from currency_rates import currency_rates
import db
import crypto
import proxy
import public
import request_log

log = logging.getLogger("veryup.app")

# ── 로깅 핸들러 ───────────────────────────────────────────────
# 이 프로세스의 진입점은 `uvicorn app:app` 이다. uvicorn 은 자기 로거(uvicorn.access 등)만
# 설정하고 루트 로거는 건드리지 않는다. 그래서 여기서 핸들러를 붙이지 않으면
# logging.getLogger("veryup.*") 의 **INFO 가 전부 버려진다** — 파이썬의 lastResort 핸들러는
# WARNING 이상만 내보내기 때문이다.
#
# 실제로 이것 때문에 프록시 감사 로그가 journald 에 **한 줄도** 남지 않았다.
# 릴레이가 최근 7일에만 수백 건 돌았는데(쿠팡 77 · 네이버 216 · 아마존 143),
# 남은 것은 uvicorn 의 액세스 로그뿐이라 "무엇이 왜 실패했는지"를 사후에 볼 수 없었다.
#
# serve_internal.py 로 띄우는 경우에는 그쪽이 루트에 핸들러를 달아 두므로 여기서는 건너뛴다
# (두 번 붙이면 같은 줄이 두 번 찍힌다).
_veryup_log = logging.getLogger("veryup")
if not _veryup_log.handlers and not logging.getLogger().handlers:
    _handler = logging.StreamHandler(sys.stderr)   # systemd 가 stderr 를 journald 로 받는다
    _handler.setFormatter(logging.Formatter("%(levelname)s [%(name)s] %(message)s"))
    _veryup_log.addHandler(_handler)
_veryup_log.setLevel((os.environ.get("LOG_LEVEL") or "INFO").upper())

# ── 비밀값 ────────────────────────────────────────────────────
# 기동 자가 점검. 운영 모드(VERYUP_ENV=production)에서 ADMIN_SECRET / KEY_MASTER 가
# 없거나 서로 같으면 여기서 SecretConfigError 를 던져 **요청을 받기 전에** 프로세스가 죽는다.
# (하위 호환 깨짐: 예전 `os.environ.get("ADMIN_SECRET") or crypto.app_secret()` 폴백은 제거됐다.
#  그 폴백은 Fernet 마스터 키를 그대로 서명키로 재사용해, 키 파일 하나로 인증키 전량 복호화와
#  {"uid":1} 관리자 토큰 위조가 동시에 가능했다 — 보안감사 3·5·8·15·17번.)
config.verify_startup()

# 세션·API 토큰 **서명 전용** 키. crypto 의 암호화 키(KEY_MASTER)와 물리적으로 다른 값이다.
# 직접 os.environ.get("ADMIN_SECRET") 를 읽지 말 것 — 길이·중복 검사를 우회하게 된다.
APP_SECRET = config.admin_secret()
api_signer = URLSafeTimedSerializer(APP_SECRET, salt="app-api-token")

# 앱용 베어러 토큰 수명. 기본은 기존과 같은 7일이며, 운영자가 환경변수로 더 짧게 줄일 수 있다.
# (감사 권고는 '더 짧게'지만, 기본값을 바꾸면 현장 앱이 갑자기 재로그인을 요구하므로 레버만 만들어 둔다.
#  ADMIN_SECRET 를 교체하면 그 즉시 기존 토큰·세션이 전부 무효가 된다 — 사고 시엔 그쪽이 확실하다.)
try:
    API_TOKEN_MAX_AGE = max(60, int(os.environ.get("API_TOKEN_MAX_AGE_HOURS", "168"))) * 3600
except ValueError:
    API_TOKEN_MAX_AGE = 60 * 60 * 24 * 7


# ── 공통 상수 ─────────────────────────────────────────────────
# 비밀번호 최소 길이. 6자 → 12자 (보안감사 1·7번: 인터넷 노출 호스트 기준으로 6자는 너무 짧다.
# 내부망으로 옮겨도 pbkdf2 증폭 DoS·내부자 추측은 남으므로 그대로 12자를 유지한다.)
MIN_PASSWORD_LEN = 12

# 로그인 시도 제한: 최근 LOGIN_LOCKOUT_MINUTES 분 안에 임계치를 넘기면 429.
# 계정 단위와 IP 단위 임계치를 나눈 이유:
#   사무실은 공인 IP 하나(또는 WireGuard 게이트웨이 하나) 뒤에 전 직원이 모여 있다.
#   하나의 임계치로 계정·IP 를 함께 세면 한 사람이 5번 틀린 순간 사무실 전체가 15분간 잠긴다.
#   그래서 표적 공격을 막는 계정 임계치는 낮게, 스캔을 막는 IP 임계치는 넉넉하게 둔다.
LOGIN_MAX_FAILURES = 5        # 같은 계정에 대한 실패 (어느 IP 에서든)
LOGIN_MAX_FAILURES_IP = 20    # 같은 IP 에서의 실패 (어느 계정이든)
LOGIN_LOCKOUT_MINUTES = 15

# 세션 쿠키 수명(초). 기존 Starlette 기본값 14일 → 8시간 (근무 1일 기준).
SESSION_MAX_AGE = 8 * 60 * 60


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


# Secure 플래그. 운영 모드에서는 기본 True.
# ※ 내부 프로세스를 WireGuard 위에서 **평문 http** 로 서비스한다면 Secure 쿠키는 브라우저가 보내지 않아
#   로그인이 아예 안 된다. 그 구성일 때만 SESSION_HTTPS_ONLY=0 으로 내려라(그 경우 VPN 이 암호화를 담당한다).
SESSION_HTTPS_ONLY = _env_bool("SESSION_HTTPS_ONLY", config.is_production())

# 세션 쿠키 이름. Starlette 기본값과 같은 값이지만 **명시**한다 —
# 아래 _session_cookie_missing() 이 "브라우저가 세션 쿠키를 되돌려 보냈는가"를 판정하려면
# 이름을 알아야 하고, 기본값에 의존하면 라이브러리가 이름을 바꾸는 순간 진단이 조용히 거짓말을 한다.
SESSION_COOKIE_NAME = "session"


def _session_cookie_missing(request: "Request") -> bool:
    """요청에 세션 쿠키가 **아예 오지 않았는지**.

    왜 이걸 따로 보나(중간 6번):
      SESSION_HTTPS_ONLY=1 인 채로 평문 http 로 서비스하면 브라우저는 Secure 쿠키를 저장은 해도
      http 요청에 실어 보내지 않는다. 그러면 세션이 매 요청 비어 있어 CSRF 토큰이 영원히 불일치하고,
      GET 으로 새 토큰을 받아도 결과는 같다 — **영구 400**. 그런데 화면 문구가 '토큰 만료'라서
      운영자는 원인에 도달할 단서가 전혀 없다. 쿠키 자체가 없다는 사실을 문구로 구분해 준다.
    """
    return not request.cookies.get(SESSION_COOKIE_NAME)


# 쿠키가 아예 오지 않았을 때 쓰는 안내 문구(로그인 화면·CSRF 오류 화면 공용).
COOKIE_MISSING_HINT = (
    "쿠키가 저장되지 않았습니다 — 브라우저가 세션 쿠키를 되돌려 보내지 않았습니다. "
    "평문 http 로 접속 중이라면 서버의 SESSION_HTTPS_ONLY 설정(0 으로 내렸는지)을 확인하세요. "
    "그 외에는 브라우저의 쿠키 차단·시크릿 모드 설정을 확인하세요."
)


def _ip(request: "Request") -> str:
    return request.client.host if request.client else "-"


# 리버스 프록시 뒤에서 uvicorn 을 --proxy-headers 없이 띄우면 모든 요청이 루프백으로 찍힌다.
# 그 값으로 IP 잠금을 세면 사실상 전역 카운터가 되어 정상 사용자까지 잠근다(db.count_recent_failures 주석 참고).
# 그래서 루프백/미상 IP 는 잠금 판정에서 제외하고 계정 단위로만 센다.
_NON_ROUTABLE_IPS = {"127.0.0.1", "::1", "localhost", "-", ""}


def _lockout_ip(request: Request):
    ip = _ip(request)
    return None if ip in _NON_ROUTABLE_IPS else ip


def _row_get(row, key, default=0):
    """sqlite3.Row 와 dict 를 모두 받아 안전하게 읽는다.
    (컬럼이 없는 구버전 DB row·테스트의 mock dict 에서 죽지 않게 하기 위함)"""
    try:
        value = row[key]
    except (KeyError, IndexError, TypeError):
        return default
    return default if value is None else value


BASE_DIR = os.path.dirname(__file__)
env = Environment(
    loader=FileSystemLoader(os.path.join(BASE_DIR, "templates")),
    autoescape=select_autoescape(),
)


def render(name: str, request: "Request | None" = None, status_code: int = 200, **ctx) -> HTMLResponse:
    """템플릿 렌더.

    request 를 주면 CSRF 토큰을 컨텍스트(`csrf`)에 **자동으로** 넣는다.
    왜 호출부마다 넣지 않고 여기서 주입하나: 화면이 하나 늘 때마다 토큰 전달을 빠뜨리면
    그 화면의 폼만 조용히 CSRF 검사에 걸려 '저장이 안 된다'는 버그로 보이기 때문이다.

    같은 이유로 `is_admin`(현재 사용자가 관리자인지)도 여기서 주입한다.
    템플릿이 `user["role"] == "admin"` 를 직접 비교하면 role 정규화(_is_admin)가 적용되지 않아
    라우트는 통과시키는 계정에게 메뉴가 안 보이는 식으로 화면과 권한이 어긋난다(낮음 7번).
    """
    if request is not None and "csrf" not in ctx:
        ctx["csrf"] = issue_csrf_token(request)
    if "is_admin" not in ctx and ctx.get("user") is not None:
        ctx["is_admin"] = _is_admin(ctx["user"])
    return HTMLResponse(env.get_template(name).render(**ctx), status_code=status_code)


# ── CSRF 방어 (동기화 토큰 패턴) ──────────────────────────────
# 세션 쿠키의 same_site="strict" 가 1차 방어지만, 그것 **하나에만** 기대지 않는다:
#   - 구형 브라우저·일부 인앱(카카오톡/라인 등) 웹뷰는 SameSite 를 무시하거나 Lax 로 낮춘다.
#   - 같은 출처 안에 XSS·열린 리다이렉트가 하나라도 생기면 strict 는 우회된다.
#   - 관리자 브라우저에서 한 번의 위조 POST 로 /keys/{id}/delete(되돌릴 수 없는 삭제)가 돈다.
# 그래서 쿠키로 인증하는 **상태 변경 POST 는 전부** 세션에 심은 난수 토큰을 함께 요구한다.
#
# 대상이 아닌 것(의도적 제외):
#   - GET 라우트: 부작용이 없어야 하는 경로다. 여기에 토큰을 요구하면 북마크·새로고침이 깨진다.
#   - /api/* : Authorization 베어러 토큰으로 인증한다. 브라우저가 자동으로 붙여 주는 자격증명이
#     아니므로 제3자 사이트가 유발한 요청은 애초에 인증되지 않는다 = CSRF 가 성립하지 않는다.
#   - /proxy/*, /updates : 세션 쿠키를 쓰지 않는 경로(위와 같은 이유).
CSRF_FIELD_NAME = "csrf_token"   # 폼 hidden input 의 name. 템플릿·serve_internal.py 와 공유한다.
_CSRF_SESSION_KEY = "_csrf"      # 세션 안에 토큰을 두는 키(쿠키는 서명돼 있어 위조할 수 없다)


def issue_csrf_token(request: Request) -> str:
    """현재 세션의 CSRF 토큰을 돌려준다(없으면 만들어 세션에 심는다).

    로그인 전(/login)에도 쓸 수 있다 — SessionMiddleware 가 응답에 쿠키를 새로 내려 준다.
    로그인 성공 시 세션을 비우므로(세션 고정 방지) 토큰도 함께 갱신된다.
    """
    try:
        token = request.session.get(_CSRF_SESSION_KEY)
    except AssertionError:   # SessionMiddleware 가 붙지 않은 경로(방어적)
        return ""
    if not token:
        token = secrets.token_urlsafe(32)
        request.session[_CSRF_SESSION_KEY] = token
    return token


def csrf_check(request: Request, submitted: str | None) -> bool:
    """폼이 보낸 토큰이 세션 토큰과 같은지. 비교는 상수시간으로 한다."""
    try:
        expected = request.session.get(_CSRF_SESSION_KEY)
    except AssertionError:
        return False
    if not expected or not submitted:
        return False
    return secrets.compare_digest(str(submitted), str(expected))


def csrf_input_html(request: Request) -> str:
    """hidden input 마크업 문자열.

    Jinja 템플릿이 아니라 파이썬에서 HTML 을 문자열로 조립하는 화면(serve_internal.py 의
    /deletions 승인 폼)이 쓴다. 템플릿에서는 `{{ csrf }}` 를 그대로 쓰면 된다.
    """
    return ('<input type="hidden" name="' + CSRF_FIELD_NAME
            + '" value="' + html.escape(issue_csrf_token(request), quote=True) + '">')


def require_csrf(request: Request, submitted: str | None, back: str = "/"):
    """상태 변경 라우트용 게이트. **통과하면 None**, 실패하면 403 응답을 돌려준다.

        denied = require_csrf(request, csrf_token, back="/staff")
        if denied:
            return denied

    back 은 실패 화면의 '돌아가기' 링크 주소다(우리가 만든 내부 경로만 넘길 것).
    """
    if csrf_check(request, submitted):
        return None
    # 위조 시도일 수도, 단순히 8시간짜리 세션이 만료된 탭일 수도 있다. 둘 다 흔적을 남긴다.
    # 세션 쿠키가 **아예 오지 않은** 경우는 원인이 전혀 다르므로(SESSION_HTTPS_ONLY + 평문 http 등)
    # 로그와 화면 모두에서 구분해 준다. 구분하지 않으면 영구 실패가 '토큰 만료'로 보인다.
    cookie_missing = _session_cookie_missing(request)
    log.warning("CSRF 토큰 불일치: path=%s ip=%s 세션쿠키=%s",
                request.url.path, _ip(request), "없음" if cookie_missing else "있음")
    if cookie_missing:
        log.warning("세션 쿠키가 요청에 없다. SESSION_HTTPS_ONLY=%s 인데 평문 http 로 접속 중이라면 "
                    "브라우저가 Secure 쿠키를 보내지 않아 영구 실패한다.", SESSION_HTTPS_ONLY)
    return render("csrf_error.html", request, status_code=403, back=back,
                  cookie_missing=cookie_missing, cookie_hint=COOKIE_MISSING_HINT)


app = FastAPI(title="VERY UP 관리자(내부)")


# ── 강제 비밀번호 변경 ────────────────────────────────────────
# must_change_password=1 인 계정은 비밀번호를 바꾸기 전까지 다른 화면에 들어갈 수 없다.
# 라우트마다 검사를 넣으면 새 라우트가 추가될 때 빠지므로 미들웨어 한 곳에서 처리한다.
_PW_EXEMPT_PATHS = {"/password", "/login", "/logout"}
# 세션을 쓰지 않는 경로(앱용 API·프록시 릴레이·공개 라우터). 이들은 토큰 검증에서 따로 막는다.
# ※ "/docs", "/openapi.json" 은 목록에서 뺐다(죽은 잔재 정리).
#    내부 진입점(serve_internal.py:127-133)이 기동 때 /docs·/redoc·/openapi.json 라우트를
#    아예 걷어내므로 면제할 대상 자체가 없다. 그리고 INTERNAL_ENABLE_DOCS=1 로 문서를 다시 켜더라도
#    **면제하지 않는 편이 맞다** — 비밀번호를 아직 바꾸지 않은 계정이 관리 API 전체 스키마를
#    먼저 구경할 이유는 없다. 다른 진입점을 새로 만들어 문서를 노출하게 되더라도 이 줄에 되살리지 말 것.
_PW_EXEMPT_PREFIXES = ("/api/", "/proxy/", "/updates", "/privacy", "/ebay",
                       "/coupang", "/naver", "/amazon", "/static")


async def _force_password_change(request: Request, call_next):
    path = request.url.path
    if path in _PW_EXEMPT_PATHS or path.startswith(_PW_EXEMPT_PREFIXES):
        return await call_next(request)
    try:
        uid = request.session.get("uid")
    except AssertionError:  # SessionMiddleware 가 아직 안 붙은 경로
        uid = None
    if uid:
        user = await run_in_threadpool(db.get_staff_by_id, uid)
        if user and _row_get(user, "must_change_password") == 1:
            return RedirectResponse("/password?err=비밀번호를 먼저 변경해야 합니다.", status_code=303)
    return await call_next(request)


async def _record_request(request: Request, call_next):
    """요청 한 건을 실시간 로그 버퍼에 남긴다 (/logs/live 화면이 읽는다).

    등록 위치가 **맨 안쪽**인 이유: request.session["uname"] 을 읽어 '누가' 보냈는지
    같이 남기기 때문이다. 바깥쪽에 두면 SessionMiddleware 보다 먼저 돌아 세션이 없다.
    대신 그 바깥에서 끝나 버리는 요청(비밀번호 강제 변경 리디렉트)은 기록되지 않는다 —
    그건 드물고 화면에 이유가 그대로 나오므로 감수한다.

    ⚠ 이 미들웨어는 어떤 경우에도 요청을 실패시키면 안 된다. 기록은 부수 효과일 뿐이다.
    """
    start = time.perf_counter()
    status = 500                      # call_next 가 예외를 던지면 이 값으로 남는다
    try:
        response = await call_next(request)
        status = response.status_code
        return response
    finally:
        try:
            uname = request.session.get("uname") or ""
        except (AssertionError, AttributeError):
            uname = ""                # SessionMiddleware 가 안 붙은 경로
        request_log.record(
            method=request.method,
            path=request.url.path,
            query=request.url.query,
            status=status,
            duration_ms=(time.perf_counter() - start) * 1000,
            ip=_ip(request),
            user=uname,
            # 서버는 UTC 로 도는데 보는 사람은 한국에 있다. 여기서 포맷하지 않고
            # ISO(UTC)로 보내 브라우저가 현지시간으로 그리게 한다.
            ts=datetime.now(timezone.utc).isoformat(),
        )


# ⚠ 미들웨어 등록 순서 주의 — Starlette 는 **나중에 add_middleware 한 것이 바깥쪽(먼저 실행)** 이다.
#   위 미들웨어는 request.session 을 읽으므로 SessionMiddleware 가 먼저 돌아야 한다.
#   따라서 강제 변경 미들웨어를 **먼저**, SessionMiddleware 를 **나중에** 등록한다. 순서를 바꾸지 마라.
#   요청 기록은 세션이 필요하고 응답 시간도 재야 하므로 **가장 먼저**(=가장 안쪽) 등록한다.
app.add_middleware(BaseHTTPMiddleware, dispatch=_record_request)
app.add_middleware(BaseHTTPMiddleware, dispatch=_force_password_change)
app.add_middleware(
    SessionMiddleware,
    secret_key=APP_SECRET,
    session_cookie=SESSION_COOKIE_NAME,  # 진단(_session_cookie_missing)이 이름에 의존하므로 명시한다
    https_only=SESSION_HTTPS_ONLY,   # 평문 http 로 쿠키가 새는 경로 차단
    same_site="strict",              # 외부 사이트에서 유발된 요청에 쿠키를 싣지 않는다(CSRF 완화)
    max_age=SESSION_MAX_AGE,         # 14일 → 8시간
)

db.init_db()

# ── 라우터 등록 (진입점이 제어할 수 있게 함수로 묶는다) ────────
# 공개/내부 프로세스를 나눌 때 진입점 모듈이 이 함수를 그대로 호출하면 된다.
# 하위 호환 깨짐: 예전에는 여기서 ebay_notify.router 와 public.router(공개+내부 합본)를 include 했다.
#   - ebay_notify 는 이제 공개 프로세스 전용이다(import 만 해도 EBAY_DELETION_ENDPOINT 를 요구한다).
#   - public.router 합본을 쓰면 /privacy 가 내부에, /updates 가 공개 쪽에 딸려 들어간다.
def include_internal_routers(target_app: FastAPI) -> None:
    """내부 프로세스가 서빙해야 하는 라우터만 붙인다."""
    # 고정 IP 프록시 릴레이 (POST /coupang, /naver, /amazon, /ebay + GET /proxy/health).
    # 쿠팡·네이버 허용목록에 등록된 아웃바운드 IP 때문에 이 릴레이는 반드시 EC2 에 남는다.
    target_app.include_router(proxy.router)
    # electron-updater 배포 파일 (/updates). UPDATE_TOKEN 이 없으면 public.py 가 라우트를 등록하지 않는다.
    target_app.include_router(public.internal_router)


include_internal_routers(app)


# ── 로그인 상태 헬퍼 ──────────────────────────────────────────
def current_user(request: Request):
    """세션 사용자. 비활성 계정은 세션이 남아 있어도 즉시 끊는다(보안감사 18번).
    _auth_by_token 은 예전부터 is_active 를 봤는데 웹 경로만 빠져 있어 정책이 어긋나 있었다 —
    직원을 비활성화해도 이미 로그인된 브라우저는 최대 14일간 그대로 살아 있었다."""
    uid = request.session.get("uid")
    if not uid:
        return None
    user = db.get_staff_by_id(uid)
    if not user or user["is_active"] != 1:
        request.session.clear()  # 죽은 세션을 계속 들고 다니지 않게 쿠키도 비운다
        return None
    return user


# ── 로그인 시도 제한 ──────────────────────────────────────────
# 존재하지 않는 계정에도 같은 비용의 해시 계산을 돌려, 응답 시간으로 계정 존재 여부가 새지 않게 한다.
# (import 시점에 한 번만 만든다. 값 자체는 쓰이지 않으며 절대 어떤 비밀번호와도 일치하지 않는다.)
_DUMMY_PASSWORD_HASH = db.hash_password(secrets.token_urlsafe(32))


def _remaining_seconds(last_iso) -> int:
    """마지막 실패 시각 기준으로 잠금 해제까지 남은 초."""
    if not last_iso:
        return 0
    try:
        unlock_at = datetime.fromisoformat(last_iso) + timedelta(minutes=LOGIN_LOCKOUT_MINUTES)
    except (TypeError, ValueError):
        return LOGIN_LOCKOUT_MINUTES * 60
    remain = int((unlock_at - datetime.now()).total_seconds())
    return remain if remain > 0 else 0


def _lockout_remaining(username: str, request: Request) -> int:
    """잠금 상태면 해제까지 남은 초, 아니면 0.
    계정 단위와 IP 단위를 **따로** 센다(db.count_recent_failures 는 둘을 함께 주면 OR 로 세므로
    한 번에 부르면 임계치를 구분할 수 없다)."""
    uname = (username or "").strip() or None
    ip = _lockout_ip(request)

    if uname:
        if db.count_recent_failures(username=uname, minutes=LOGIN_LOCKOUT_MINUTES) >= LOGIN_MAX_FAILURES:
            remain = _remaining_seconds(db.last_failure_at(username=uname))
            if remain:
                return remain
    if ip:
        if db.count_recent_failures(ip=ip, minutes=LOGIN_LOCKOUT_MINUTES) >= LOGIN_MAX_FAILURES_IP:
            remain = _remaining_seconds(db.last_failure_at(ip=ip))
            if remain:
                return remain
    return 0


def _check_password(username: str, password: str):
    """(staff row 또는 None, 성공여부) 를 돌려준다.
    계정이 없어도 더미 해시를 계산해 pbkdf2 시간(200k 반복)을 동일하게 소비한다."""
    user = db.get_staff_by_username(username)
    if user is None:
        db.verify_password(password, _DUMMY_PASSWORD_HASH)  # 타이밍 차 제거용(결과는 버린다)
        return None, False
    ok = db.verify_password(password, user["password_hash"]) and user["is_active"] == 1
    return user, ok


# ── 로그인 / 로그아웃 ─────────────────────────────────────────
@app.get("/login", response_class=HTMLResponse)
def login_page(request: Request):
    if current_user(request):
        return RedirectResponse("/", status_code=303)
    return render("login.html", request, error=None)


@app.post("/login", response_class=HTMLResponse)
def login_submit(request: Request, username: str = Form(...), password: str = Form(...),
                 csrf_token: str = Form("")):
    ip = _ip(request)
    username = (username or "").strip()

    # 로그인 CSRF 도 막는다 — 공격자가 자기 계정으로 피해자를 로그인시켜 놓고
    # 피해자가 그 세션에서 한 일(검색·업로드)을 자기 계정에서 열람하는 수법이 있다.
    #
    # ※ 의도된 예외(문서화): 다른 11개 폼은 require_csrf() 로 403 + csrf_error.html 을 낸다.
    #   /login 만 400 + 로그인 화면 인라인 메시지다. 일관성이 깨진 게 아니라 **일부러 다르다** —
    #   로그인 화면에서 흔한 원인은 위조가 아니라 '8시간 만에 만료된 탭'이고, 그때 필요한 것은
    #   '돌아가기' 링크 하나짜리 오류 페이지가 아니라 새 토큰이 박힌 로그인 폼 그 자체이기 때문이다.
    #   (render() 가 새 CSRF 토큰을 다시 심어 주므로 이 응답을 그대로 제출하면 성공한다.)
    #   이 동작을 require_csrf() 로 통일하지 말 것.
    if not csrf_check(request, csrf_token):
        # 세션 쿠키가 아예 오지 않았다면 새 토큰을 내려도 결과는 같다 — **영구 400** 이다.
        # 이 경우만 원인을 짚어 주지 않으면 운영자는 '토큰 만료'만 반복해서 보게 된다(중간 6번).
        cookie_missing = _session_cookie_missing(request)
        log.warning("로그인 CSRF 토큰 불일치: ip=%s 세션쿠키=%s", ip, "없음" if cookie_missing else "있음")
        if cookie_missing:
            log.warning("세션 쿠키가 요청에 없다. SESSION_HTTPS_ONLY=%s — 평문 http 로 서비스 중이라면 "
                        "브라우저가 Secure 쿠키를 보내지 않아 로그인이 영영 되지 않는다.", SESSION_HTTPS_ONLY)
        return render("login.html", request, status_code=400,
                      error=(COOKIE_MISSING_HINT if cookie_missing
                             else "보안 토큰이 만료되었습니다. 다시 로그인해 주세요."))

    remain = _lockout_remaining(username, request)
    if remain > 0:
        # 잠금 중에는 login_logs 에 fail 을 **추가하지 않는다** — 기록하면 공격자가 요청만 계속 보내
        # 잠금이 영원히 갱신되어 정상 사용자가 영영 들어오지 못한다(자기증식 잠금 방지).
        log.warning("로그인 잠금: username=%s ip=%s 남은=%d초", username, ip, remain)
        resp = render("login.html", request, status_code=429,
                      error=f"로그인 시도가 너무 많습니다. 약 {math.ceil(remain / 60)}분 후 다시 시도하세요.")
        resp.headers["Retry-After"] = str(remain)
        return resp

    user, ok = _check_password(username, password)
    if ok:
        db.record_login(user["id"], username, ip, "success")
        request.session.clear()          # 세션 고정 공격 방지: 기존 세션 값을 버리고 새로 채운다
        request.session["uid"] = user["id"]
        # 요청 로그 화면이 '누가' 보냈는지 보여 줄 때 쓴다. 여기 넣어 두지 않으면
        # 요청마다 uid 로 DB 를 한 번씩 더 치게 된다(로그 때문에 모든 요청이 느려진다).
        # 권한 판정에는 절대 쓰지 마라 — 세션 쿠키의 값이고, 권한은 current_user() 가
        # 매번 DB 에서 is_active 까지 확인해서 정한다.
        request.session["uname"] = username
        if _row_get(user, "must_change_password") == 1:
            return RedirectResponse("/password?err=비밀번호를 먼저 변경해야 합니다.", status_code=303)
        return RedirectResponse("/", status_code=303)

    db.record_login(user["id"] if user else None, username, ip, "fail")
    return render("login.html", request, status_code=401,
                  error="아이디 또는 비밀번호가 올바르지 않거나 비활성 계정입니다.")


@app.get("/logout")
def logout(request: Request):
    request.session.clear()
    return RedirectResponse("/login", status_code=303)


# ── 권한(RBAC) 헬퍼 ──────────────────────────────────────────
def _is_admin(user) -> bool:
    """role='admin' 인지. 저장된 값에 공백·대문자가 섞여 있어도 같게 본다.

    ※ role 비교는 **여기 한 곳에서만** 한다. 라우트마다 user["role"] != "admin" 을 직접 쓰면
      정규화가 절반만 적용되어, role=" Admin " 같은 행이 /api/credentials(전 플랫폼 평문 인증키)와
      /deletions 승인(되돌릴 수 없는 삭제)은 통과하는데 읽기 전용 화면은 못 여는,
      **느슨한 쪽이 하필 최고 위험 경로인** 상태가 된다(낮음 7번).
      serve_internal._require_admin 과 _platform_allowed() 도 같은 정규화를 쓴다.
    """
    return (_row_get(user, "role", "") or "").strip().lower() == "admin"


# 템플릿에서 임의의 행(예: 직원 목록의 각 s)에 같은 판정을 쓰기 위한 전역 함수.
# 현재 로그인 사용자에 대한 판정은 render() 가 넣어 주는 `is_admin` 불리언을 쓰면 된다.
env.globals["is_admin_role"] = _is_admin


# ── 대시보드 ─────────────────────────────────────────────────
@app.get("/", response_class=HTMLResponse)
def dashboard(request: Request):
    user = current_user(request)
    if not user:
        return RedirectResponse("/login", status_code=303)
    # 직원(role='staff')에게는 전 직원 수·최근 로그인 IP 를 보여주지 않는다.
    # 이 화면은 로그인 후 반드시 지나가는 착지점이라 라우트 자체를 막을 수는 없고, 내용만 줄인다.
    # (아래 /staff·/logs·/usage 를 관리자 전용으로 좁힌 것과 같은 이유 — 감사 4번 RBAC)
    if not _is_admin(user):
        return render("dashboard.html", request, user=user, is_admin=False)
    staff = db.list_staff()
    active_count = sum(1 for s in staff if s["is_active"] == 1)
    return render("dashboard.html", request, user=user, is_admin=True,
                  staff_total=len(staff), active_count=active_count,
                  today_logins=db.count_today_logins(), recent=db.recent_logins(8))


# ── 직원 계정 관리 ────────────────────────────────────────────
# 하위 호환 깨짐(의도): 예전에는 role='staff' 도 이 화면을 열 수 있었다.
# 전 직원의 이름·아이디·권한·활성 여부가 그대로 보였고, 그것은 내부자나 탈취된 직원 계정에게
# **공격 대상 명부**를 주는 것과 같다(관리자 계정이 어느 것인지도 함께 노출된다).
# 설계안의 RBAC(최소권한)에 맞춰 관리자 전용으로 좁힌다. 직원은 /password 로 본인 비밀번호만 바꾼다.
@app.get("/staff", response_class=HTMLResponse)
def staff_page(request: Request, msg: str = None):
    user = current_user(request)
    if not user:
        return RedirectResponse("/login", status_code=303)
    if not _is_admin(user):
        return RedirectResponse("/", status_code=303)
    return render("staff.html", request, user=user, staff=db.list_staff(),
                  msg=msg, min_len=MIN_PASSWORD_LEN)


@app.post("/staff/add")
def staff_add(request: Request, username: str = Form(...), name: str = Form(...),
              password: str = Form(...), role: str = Form("staff"),
              csrf_token: str = Form("")):
    user = current_user(request)
    if not user or not _is_admin(user):
        return RedirectResponse("/login", status_code=303)
    denied = require_csrf(request, csrf_token, back="/staff")
    if denied:
        return denied
    # 예전에는 길이 검사가 아예 없어 1자짜리 비밀번호도 만들어졌다.
    if len(password) < MIN_PASSWORD_LEN:
        return RedirectResponse(f"/staff?msg=❌ 비밀번호는 {MIN_PASSWORD_LEN}자 이상이어야 합니다.", status_code=303)
    try:
        # 관리자가 정해 준 비밀번호는 본인만 아는 값이 아니므로 첫 로그인에서 반드시 바꾸게 한다.
        db.add_staff(username.strip(), password, name.strip(), role, must_change_password=True)
        return RedirectResponse("/staff?msg=직원 계정이 추가되었습니다. (첫 로그인 시 비밀번호 변경이 강제됩니다)",
                                status_code=303)
    except Exception as e:
        return RedirectResponse(f"/staff?msg=추가 실패: {e}", status_code=303)


@app.post("/staff/{staff_id}/toggle")
def staff_toggle(request: Request, staff_id: int, csrf_token: str = Form("")):
    user = current_user(request)
    if not user or not _is_admin(user):
        return RedirectResponse("/login", status_code=303)
    denied = require_csrf(request, csrf_token, back="/staff")
    if denied:
        return denied
    target = db.get_staff_by_id(staff_id)
    if target:
        db.set_staff_active(staff_id, target["is_active"] == 0)
    return RedirectResponse("/staff", status_code=303)


@app.post("/staff/{staff_id}/reset-password")
def staff_reset_password(request: Request, staff_id: int, new_password: str = Form(...),
                         csrf_token: str = Form("")):
    # 관리자가 직원 비밀번호를 재설정(초기화)한다. 현재 비번 몰라도 됨.
    user = current_user(request)
    if not user or not _is_admin(user):
        return RedirectResponse("/login", status_code=303)
    denied = require_csrf(request, csrf_token, back="/staff")
    if denied:
        return denied
    if len(new_password) < MIN_PASSWORD_LEN:
        return RedirectResponse(f"/staff?msg=❌ 비밀번호는 {MIN_PASSWORD_LEN}자 이상이어야 합니다.", status_code=303)
    target = db.get_staff_by_id(staff_id)
    if not target:
        return RedirectResponse("/staff", status_code=303)
    db.update_password(staff_id, new_password)
    # update_password 는 강제 변경 플래그를 내린다. 관리자가 정해 준 값은 본인만 아는 값이 아니므로 다시 세운다.
    db.set_must_change_password(staff_id, True)
    return RedirectResponse(
        f"/staff?msg=✅ {target['name']} 님의 비밀번호가 변경되었습니다. (본인 첫 로그인 시 재변경이 강제됩니다)",
        status_code=303)


# ── 인증키 중앙보관 (암호화 + 감사로그) ───────────────────────
PLATFORM_HINTS = {
    "coupang": '{\n  "vendorId": "",\n  "accessKey": "",\n  "secretKey": ""\n}',
    # 네이버 커머스API. clientSecret 은 그 자체가 bcrypt salt($2a$04$...) 라 형식이 중요하다.
    # type 은 자사 스토어면 SELF, 타사 판매자를 대신 다루면 SELLER(이때 accountId 필수).
    "naver": '{\n  "clientId": "",\n  "clientSecret": "",\n  "type": "SELF",\n  "accountId": ""\n}',
    "esm": '{\n  "session": ""\n}',
    "imweb": '{\n  "clientId": "",\n  "clientSecret": ""\n}',
    # 이베이(Sell API): 앱은 clientSecret·refreshToken 을 OS 암호화 저장소에 다시 넣어 보관한다.
    "ebay": '{\n  "environment": "production",\n  "clientId": "",\n  "clientSecret": "",\n  "ruName": "",\n  "refreshToken": "",\n  "merchantLocationKey": "",\n  "fulfillmentPolicyId": "",\n  "paymentPolicyId": "",\n  "returnPolicyId": ""\n}',
    # 아마존(SP-API): sellerId·clientId·clientSecret·refreshToken 이 필수값.
    "amazon": '{\n  "sellerId": "",\n  "clientId": "",\n  "clientSecret": "",\n  "refreshToken": "",\n  "endpoint": "https://sellingpartnerapi-na.amazon.com",\n  "marketplaceId": "ATVPDKIKX0DER"\n}',
}

# platform 값은 로그·DB 에 그대로 들어가므로 형식을 먼저 좁힌다.
_PLATFORM_RE = re.compile(r"^[a-z0-9_-]{1,32}$")


def _normalize_platform(raw) -> str | None:
    """폼/DB 의 platform 값을 저장 형식(소문자·공백 없음)으로 좁힌다. 형식이 아니면 None.

    왜 쓰기 경로에 반드시 있어야 하나:
      읽기 경로(/api/credentials)는 platform 을 .strip().lower() 로 정규화한 뒤
      `c["platform"] != platform` 으로 **정확히** 비교한다. 그런데 쓰기 경로가 "Coupang" 이나
      "coupang " 을 그대로 저장하면 그 행은 어떤 질의와도 영원히 일치하지 않는다 —
      화면에는 멀쩡히 보이는데 앱만 인증키를 못 받는, 원인을 찾기 어려운 고장이 된다.
    """
    value = (raw or "").strip().lower()
    return value if _PLATFORM_RE.fullmatch(value) else None


def _staff_platform_scope() -> frozenset:
    """role='staff' 계정이 /api/credentials 로 꺼낼 수 있는 플랫폼 목록.

    하위 호환 깨짐(의도): 기본값은 **빈 집합**이다. 예전에는 role 검사 자체가 없어
    staff 계정 하나만 새면 전 플랫폼 평문 인증키가 한 응답에 나왔다(보안감사 12·26·27번).
    운영자 할 일: 직원용 앱이 실제로 필요로 하는 플랫폼만
        STAFF_PLATFORMS=coupang,naver
    처럼 환경변수로 명시하라. 관리자(role='admin')는 이 목록과 무관하게 전 플랫폼을 볼 수 있다.
    """
    raw = os.environ.get("STAFF_PLATFORMS", "")
    items = {p.strip().lower() for p in raw.split(",") if p.strip()}
    return frozenset(p for p in items if _PLATFORM_RE.fullmatch(p))


STAFF_PLATFORMS = _staff_platform_scope()
if not STAFF_PLATFORMS:
    log.warning(
        "STAFF_PLATFORMS 가 비어 있어 role='staff' 계정은 /api/credentials 로 아무 인증키도 받지 못한다. "
        "직원 앱이 인증키를 못 받는다면 이 환경변수(예: STAFF_PLATFORMS=coupang,naver)를 설정하라."
    )


def _platform_allowed(user, platform: str) -> bool:
    """요청자 role 이 해당 플랫폼 인증키를 꺼낼 수 있는지."""
    role = (_row_get(user, "role", "") or "").strip().lower()
    if role == "admin":
        return True
    if role == "staff":
        return platform in STAFF_PLATFORMS
    return False  # 모르는 role 은 거부(기본 거부)


@app.get("/keys", response_class=HTMLResponse)
def keys_page(request: Request, msg: str = None):
    user = current_user(request)
    if not user:
        return RedirectResponse("/login", status_code=303)
    if not _is_admin(user):
        return RedirectResponse("/", status_code=303)
    return render("keys.html", request, user=user, creds=db.list_credentials(),
                  logs=db.recent_key_logs(20), hints=PLATFORM_HINTS, msg=msg)


@app.post("/keys/add")
def keys_add(request: Request, platform: str = Form(...), label: str = Form(...),
             payload: str = Form(...), csrf_token: str = Form("")):
    user = current_user(request)
    if not user or not _is_admin(user):
        return RedirectResponse("/login", status_code=303)
    denied = require_csrf(request, csrf_token, back="/keys")
    if denied:
        return denied
    # 읽기 경로(:api_credentials)와 같은 형식으로 먼저 정규화한다.
    # 정규화 없이 저장하면 그 인증키는 앱의 /api/credentials?platform=... 조회에 영원히 안 걸린다.
    platform = _normalize_platform(platform)
    if not platform:
        return RedirectResponse(
            "/keys?msg=❌ 플랫폼 값이 올바르지 않습니다. (영문 소문자·숫자·_·- 로 1~32자)",
            status_code=303)
    try:
        json.loads(payload)  # JSON 형식 검증
    except Exception:
        return RedirectResponse("/keys?msg=❌ JSON 형식이 올바르지 않습니다.", status_code=303)
    db.add_credential(platform, label.strip(), crypto.encrypt(payload), user["name"])
    db.record_key_access(user["id"], user["username"], platform, None, "create", _ip(request))
    return RedirectResponse("/keys?msg=✅ 인증키가 암호화되어 저장되었습니다.", status_code=303)


@app.get("/keys/{cred_id}", response_class=HTMLResponse)
def keys_detail(request: Request, cred_id: int):
    user = current_user(request)
    if not user:
        return RedirectResponse("/login", status_code=303)
    if not _is_admin(user):
        return RedirectResponse("/", status_code=303)
    row = db.get_credential(cred_id)
    if not row:
        return RedirectResponse("/keys", status_code=303)

    # 복호화는 실패할 수 있다 — KEY_MASTER 를 교체했거나(옛 secret.key 로 암호화된 값),
    # 암호문이 손상된 경우. 예전에는 try 없이 불러 화면이 통째로 500 이 됐고,
    # 운영자는 '관리 서버가 고장났다'고만 볼 뿐 원인을 알 수 없었다. 이유를 화면에 적어 준다.
    decrypt_error = None
    plaintext = ""
    try:
        plaintext = crypto.decrypt(row["enc_payload"])
    except Exception as e:      # noqa: BLE001 - InvalidToken 외에 형식 오류도 같은 화면으로 설명한다
        decrypt_error = (
            f"복호화에 실패했습니다 ({type(e).__name__}). "
            "이 값을 암호화할 때 쓴 KEY_MASTER 와 지금 기동된 KEY_MASTER 가 다를 가능성이 큽니다. "
            "키를 되돌리거나, 되돌릴 수 없다면 이 인증키를 삭제하고 다시 등록해야 합니다."
        )
        log.error("인증키 복호화 실패: cred_id=%s platform=%s (%s)",
                  cred_id, row["platform"], type(e).__name__)
    else:
        try:  # 보기 좋게 정렬
            plaintext = json.dumps(json.loads(plaintext), ensure_ascii=False, indent=2)
        except Exception:
            pass
    # 복호화해서 열람한 것 자체를 감사 기록에 남긴다(실패한 시도도 남긴다 — 키 사고의 최초 흔적이 된다)
    db.record_key_access(user["id"], user["username"], row["platform"], cred_id,
                         "view-failed" if decrypt_error else "view", _ip(request))
    return render("key_detail.html", request, user=user, cred=row,
                  plaintext=plaintext, decrypt_error=decrypt_error)


@app.post("/keys/{cred_id}/update")
def keys_update(request: Request, cred_id: int, payload: str = Form(...),
                csrf_token: str = Form("")):
    user = current_user(request)
    if not user or not _is_admin(user):
        return RedirectResponse("/login", status_code=303)
    denied = require_csrf(request, csrf_token, back="/keys")
    if denied:
        return denied
    row = db.get_credential(cred_id)
    if not row:
        return RedirectResponse("/keys", status_code=303)
    try:
        json.loads(payload)
    except Exception:
        return RedirectResponse(f"/keys/{cred_id}", status_code=303)
    # 이 화면에는 platform 입력란이 없다(값은 DB 행을 따른다). 다만 정규화가 들어오기 전에 저장된
    # 행은 "Coupang" 처럼 남아 있을 수 있으므로, 감사 로그에는 정규화한 값을 남기고
    # 어긋난 행은 경고로 알린다 — 그 행은 앱의 platform 조회와 영원히 불일치하므로 재등록이 필요하다.
    platform = _normalize_platform(row["platform"])
    if platform != row["platform"]:
        log.warning("정규화되지 않은 platform 이 DB 에 있다: cred_id=%s platform=%r "
                    "→ /api/credentials?platform= 조회와 불일치한다. 삭제 후 재등록이 필요하다.",
                    cred_id, row["platform"])
    db.update_credential(cred_id, crypto.encrypt(payload), user["name"])
    db.record_key_access(user["id"], user["username"], platform or row["platform"],
                         cred_id, "update", _ip(request))
    return RedirectResponse("/keys?msg=✅ 인증키가 수정되었습니다.", status_code=303)


@app.post("/keys/{cred_id}/delete")
def keys_delete(request: Request, cred_id: int, csrf_token: str = Form("")):
    user = current_user(request)
    if not user or not _is_admin(user):
        return RedirectResponse("/login", status_code=303)
    denied = require_csrf(request, csrf_token, back="/keys")
    if denied:
        return denied
    row = db.get_credential(cred_id)
    if row:
        db.delete_credential(cred_id)
        db.record_key_access(user["id"], user["username"], row["platform"], cred_id, "delete", _ip(request))
    return RedirectResponse("/keys?msg=🗑 인증키가 삭제되었습니다.", status_code=303)


# ── 비밀번호 변경 (본인 계정) ─────────────────────────────────
@app.get("/password", response_class=HTMLResponse)
def password_page(request: Request, msg: str = None, err: str = None):
    user = current_user(request)
    if not user:
        return RedirectResponse("/login", status_code=303)
    return render("password.html", request, user=user, msg=msg, err=err, min_len=MIN_PASSWORD_LEN)


@app.post("/password", response_class=HTMLResponse)
def password_change(request: Request, current: str = Form(...),
                    new1: str = Form(...), new2: str = Form(...),
                    csrf_token: str = Form("")):
    user = current_user(request)
    if not user:
        return RedirectResponse("/login", status_code=303)
    denied = require_csrf(request, csrf_token, back="/password")
    if denied:
        return denied
    if not db.verify_password(current, user["password_hash"]):
        return render("password.html", request, user=user, status_code=400,
                      min_len=MIN_PASSWORD_LEN, err="현재 비밀번호가 올바르지 않습니다.")
    if new1 != new2:
        return render("password.html", request, user=user, status_code=400,
                      min_len=MIN_PASSWORD_LEN, err="새 비밀번호 두 개가 서로 다릅니다.")
    if len(new1) < MIN_PASSWORD_LEN:
        return render("password.html", request, user=user, status_code=400,
                      min_len=MIN_PASSWORD_LEN,
                      err=f"새 비밀번호는 {MIN_PASSWORD_LEN}자 이상이어야 합니다.")
    if new1 == current:
        return render("password.html", request, user=user, status_code=400,
                      min_len=MIN_PASSWORD_LEN, err="새 비밀번호가 기존 비밀번호와 같습니다.")
    # update_password 가 must_change_password 플래그도 함께 내린다.
    db.update_password(user["id"], new1)
    return render("password.html", request, user=user, min_len=MIN_PASSWORD_LEN,
                  msg="✅ 비밀번호가 변경되었습니다.")


# ── 로그인 로그 ──────────────────────────────────────────────
# 하위 호환 깨짐(의도): role='staff' 에게 닫는다.
# 여기에는 전 직원의 아이디와 접속 IP 이력 100건이 그대로 나온다. 직원 한 명의 계정이 새면
# '누가 어디서 언제 일하는지'가 통째로 새는 셈이고, 이는 본인 업무에 필요한 정보가 아니다.
@app.get("/logs", response_class=HTMLResponse)
def logs_page(request: Request):
    user = current_user(request)
    if not user:
        return RedirectResponse("/login", status_code=303)
    if not _is_admin(user):
        return RedirectResponse("/", status_code=303)
    return render("logs.html", request, user=user, logs=db.recent_logins(100))


# ── 요청 로그 실시간 화면 ─────────────────────────────────────
# /logs 는 admin.db 에 영구 저장된 '로그인 기록'이고, 이쪽은 메모리에만 있는
# '지금 들어오는 요청'이다. 둘은 목적이 달라 화면을 따로 둔다.
@app.get("/logs/live", response_class=HTMLResponse)
def logs_live_page(request: Request):
    user = current_user(request)
    if not user:
        return RedirectResponse("/login", status_code=303)
    if not _is_admin(user):
        return RedirectResponse("/", status_code=303)
    return render("logs_live.html", request, user=user,
                  history=request_log.history(),
                  max_history=request_log.MAX_HISTORY)


def _sse_for(buffer, request: Request):
    """관리자 확인 후 buffer 를 SSE 로 흘려보낸다. 두 로그 화면이 같이 쓴다.

    왜 WebSocket 이 아닌가: 방향이 서버→브라우저 한쪽뿐이고, EventSource 는
    끊기면 브라우저가 알아서 재연결한다. 프록시(Caddy)도 text/event-stream 을
    알아보고 버퍼링을 끄므로 추가 설정이 필요 없다.
    """
    user = current_user(request)
    if not user or not _is_admin(user):
        # EventSource 는 본문을 못 읽으므로 상태코드로만 말한다(브라우저는 onerror 로 받는다).
        return JSONResponse({"error": "unauthorized"}, status_code=401)

    async def gen():
        q = buffer.subscribe()
        try:
            yield ": connected\n\n"
            while True:
                try:
                    entry = await asyncio.wait_for(q.get(), timeout=20.0)
                except asyncio.TimeoutError:
                    # 하트비트. 조용한 새벽에 유휴 연결이 중간에서 끊기는 것을 막는다.
                    # 주석 줄(': ')은 SSE 규격상 무시되므로 화면에는 아무 영향이 없다.
                    yield ": ping\n\n"
                    continue
                yield request_log.sse(entry)
        finally:
            # 브라우저가 창을 닫으면 제너레이터가 닫히며 여기로 온다.
            # 구독을 안 빼면 죽은 큐가 계속 쌓여 record() 가 헛일을 한다.
            buffer.unsubscribe(q)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            # nginx 를 앞에 두는 구성으로 바뀌어도 버퍼링되지 않게(Caddy 는 불필요하지만 무해).
            "X-Accel-Buffering": "no",
        },
    )


@app.get("/logs/live/stream")
async def logs_live_stream(request: Request):
    return _sse_for(request_log.inbound, request)


# ── 쇼핑몰 API 응답 실시간 화면 ───────────────────────────────
# /logs/live 가 '이 서버로 들어온 요청'이라면, 이쪽은 '쇼핑몰에서 받아온 값'이다.
# proxy.py 의 릴레이를 지나간 응답만 보인다 — 아래 화면 안내문에 그 조건을 적어 둔다.
@app.get("/logs/api", response_class=HTMLResponse)
def logs_api_page(request: Request):
    user = current_user(request)
    if not user:
        return RedirectResponse("/login", status_code=303)
    if not _is_admin(user):
        return RedirectResponse("/", status_code=303)
    return render("logs_api.html", request, user=user,
                  history=request_log.upstream.history(),
                  max_history=request_log.MAX_HISTORY,
                  body_chars=request_log.UPSTREAM_BODY_CHARS)


@app.get("/logs/api/stream")
async def logs_api_stream(request: Request):
    return _sse_for(request_log.upstream, request)


# ── 라이선스 관리 ────────────────────────────────────────────
def _gen_license_key():
    import secrets as _s
    part = lambda: _s.token_hex(2).upper()
    return f"VERYUP-{part()}-{part()}-{part()}"


@app.get("/licenses", response_class=HTMLResponse)
def licenses_page(request: Request, msg: str = None):
    user = current_user(request)
    if not user:
        return RedirectResponse("/login", status_code=303)
    if not _is_admin(user):
        return RedirectResponse("/", status_code=303)
    return render("licenses.html", request, user=user, licenses=db.list_licenses(), msg=msg)


@app.post("/licenses/add")
def licenses_add(request: Request, key: str = Form(""), seats: int = Form(1),
                 assigned_to: str = Form(""), expires_at: str = Form(""),
                 csrf_token: str = Form("")):
    user = current_user(request)
    if not user or not _is_admin(user):
        return RedirectResponse("/login", status_code=303)
    denied = require_csrf(request, csrf_token, back="/licenses")
    if denied:
        return denied
    key = (key or "").strip() or _gen_license_key()
    try:
        db.add_license(key, seats, assigned_to.strip(), expires_at.strip())
        return RedirectResponse(f"/licenses?msg=✅ 라이선스 발급: {key}", status_code=303)
    except Exception as e:
        return RedirectResponse(f"/licenses?msg=발급 실패: {e}", status_code=303)


@app.post("/licenses/{license_id}/toggle")
def licenses_toggle(request: Request, license_id: int, csrf_token: str = Form("")):
    user = current_user(request)
    if not user or not _is_admin(user):
        return RedirectResponse("/login", status_code=303)
    denied = require_csrf(request, csrf_token, back="/licenses")
    if denied:
        return denied
    rows = [l for l in db.list_licenses() if l["id"] == license_id]
    if rows:
        new_status = "blocked" if rows[0]["status"] == "active" else "active"
        db.set_license_status(license_id, new_status)
    return RedirectResponse("/licenses", status_code=303)


@app.post("/licenses/{license_id}/delete")
def licenses_delete(request: Request, license_id: int, csrf_token: str = Form("")):
    user = current_user(request)
    if not user or not _is_admin(user):
        return RedirectResponse("/login", status_code=303)
    denied = require_csrf(request, csrf_token, back="/licenses")
    if denied:
        return denied
    db.delete_license(license_id)
    return RedirectResponse("/licenses?msg=🗑 라이선스가 삭제되었습니다.", status_code=303)


# ── AI 사용량 통계 ────────────────────────────────────────────
# 하위 호환 깨짐(의도): role='staff' 에게 닫는다.
# 직원별 집계와 최근 사용 내역은 곧 '전 직원 명부 + 근무 패턴'이다. 직원 본인에게 필요한 값이 아니고
# /staff·/logs 를 닫아 놓고 여기만 열어 두면 같은 정보가 옆문으로 새어 나간다.
# (직원 본인 사용량만 보여 주는 화면이 필요해지면 db 질의에 staff_id 필터를 걸어 따로 만들 것.)
@app.get("/usage", response_class=HTMLResponse)
def usage_page(request: Request):
    user = current_user(request)
    if not user:
        return RedirectResponse("/login", status_code=303)
    if not _is_admin(user):
        return RedirectResponse("/", status_code=303)
    return render("usage.html", request, user=user,
                  summary=db.ai_usage_summary(), recent=db.recent_ai_usage(50))


# ══════════════════════════════════════════════════════════════
#  앱(프로그램)용 API — 앱이 서버에서 인증키를 받아쓰기 위한 통로
#  1) POST /api/login          : 직원 로그인 → 토큰 발급
#  2) GET  /api/credentials    : 토큰으로 인증키(복호화) 조회 — platform 필수 + role 제한
# ══════════════════════════════════════════════════════════════
def _auth_by_token(authorization: str | None):
    """Authorization: Bearer <token> 헤더를 검증해 staff row 반환 (실패 시 None).
    proxy.py 도 이 함수를 그대로 쓴다(proxy.py:150)."""
    if not authorization or not authorization.lower().startswith("bearer "):
        return None
    token = authorization.split(" ", 1)[1].strip()
    try:
        data = api_signer.loads(token, max_age=API_TOKEN_MAX_AGE)
    except (BadSignature, SignatureExpired):
        return None
    user = db.get_staff_by_id(data.get("uid"))
    if not user or user["is_active"] != 1:
        return None
    # 강제 변경 대기 중인 계정은 발급된 토큰도 쓸 수 없다 —
    # '이 비밀번호는 본인 말고도 아는 사람이 있다'는 상태에서 7일짜리 토큰이 살아 있으면 플래그가 무의미하다.
    if _row_get(user, "must_change_password") == 1:
        return None
    return user


@app.post("/api/login")
def api_login(request: Request, username: str = Form(...), password: str = Form(...)):
    ip = _ip(request)
    username = (username or "").strip()

    remain = _lockout_remaining(username, request)
    if remain > 0:
        # 웹 /login 과 같은 이유로 잠금 중 시도는 login_logs 에 남기지 않는다(자기증식 잠금 방지).
        log.warning("API 로그인 잠금: username=%s ip=%s 남은=%d초", username, ip, remain)
        return JSONResponse(
            {"ok": False, "error": f"로그인 시도가 너무 많습니다. 약 {math.ceil(remain / 60)}분 후 다시 시도하세요."},
            status_code=429, headers={"Retry-After": str(remain)})

    user, ok = _check_password(username, password)
    if not ok:
        db.record_login(user["id"] if user else None, username, ip, "fail")
        return JSONResponse({"ok": False, "error": "로그인 실패"}, status_code=401)

    db.record_login(user["id"], username, ip, "success")
    if _row_get(user, "must_change_password") == 1:
        # 토큰을 발급하지 않는다. 관리 화면(/password)에서 비밀번호를 바꾼 뒤 다시 로그인해야 한다.
        return JSONResponse({"ok": False, "must_change_password": True,
                             "error": "비밀번호를 먼저 변경해야 합니다. 관리자 페이지에서 변경 후 다시 로그인하세요."},
                            status_code=403)
    token = api_signer.dumps({"uid": user["id"]})
    return {"ok": True, "token": token, "name": user["name"], "role": user["role"]}



@app.on_event("startup")
def start_currency_rates():
    currency_rates.start()


@app.on_event("shutdown")
def stop_currency_rates():
    currency_rates.stop()


@app.get("/api/currency-rates")
def api_currency_rates(authorization: str = Header(None)):
    if not _auth_by_token(authorization):
        return JSONResponse({"ok": False, "error": "로그인이 필요합니다."}, status_code=401)
    result = currency_rates.get()
    return JSONResponse(result, status_code=200 if result["ok"] else 503,
                        headers={"Cache-Control": "no-store"})


@app.get("/api/credentials")
def api_credentials(request: Request, platform: str = None, authorization: str = Header(None)):
    """앱이 인증키를 받아가는 엔드포인트.

    하위 호환 깨짐(의도된 변경, 보안감사 12·26·27번):
      1) platform 쿼리 파라미터가 **필수**가 됐다. 예전에는 생략하면 저장된 전 플랫폼 인증키가
         한 응답에 평문으로 나왔다(토큰 하나 = 금고 전체).
      2) 요청자 role 로 접근 가능한 플랫폼을 제한한다. admin 은 전 플랫폼, staff 는 STAFF_PLATFORMS 만.
      3) 성공이든 거부든 key_access_logs 에 남는다.
    반환: [{id, platform, label, data}]  (data = 복호화된 값)
    """
    user = _auth_by_token(authorization)
    if not user:
        return JSONResponse({"ok": False, "error": "인증 필요(토큰 없음/만료/비활성)"}, status_code=401)

    platform = (platform or "").strip().lower()
    if not platform:
        return JSONResponse(
            {"ok": False, "error": "platform 쿼리 파라미터는 필수입니다. 예: /api/credentials?platform=coupang"},
            status_code=400)
    if not _PLATFORM_RE.fullmatch(platform):
        return JSONResponse({"ok": False, "error": "platform 값 형식이 올바르지 않습니다."}, status_code=400)

    if not _platform_allowed(user, platform):
        # 거부도 감사 로그에 남긴다 — 토큰 탈취 후의 정찰이 흔적 없이 지나가지 않게.
        db.record_key_access(user["id"], user["username"], platform, None, "view-denied", _ip(request) + " (앱)")
        log.warning("인증키 접근 거부: user=%s role=%s platform=%s ip=%s",
                    user["username"], _row_get(user, "role", "?"), platform, _ip(request))
        return JSONResponse({"ok": False, "error": "이 플랫폼 인증키에 접근할 권한이 없습니다."}, status_code=403)

    result = []
    failed = []
    for c in db.list_credentials():
        if c["platform"] != platform:
            continue
        row = db.get_credential(c["id"])
        try:
            data = json.loads(crypto.decrypt(row["enc_payload"]))
        except Exception as e:                    # noqa: BLE001 - 한 건이 깨져도 나머지는 내려준다
            # 예전에는 여기서 data=None 을 담고 그대로 "view" 감사 로그를 남겼다. 그러면
            #   (1) 앱은 200 을 받고 조용히 빈 자격증명으로 동작해 원인을 알 수 없고,
            #   (2) **아무것도 못 읽었는데 "열람했다"는 감사 기록이 남는다.**
            # KEY_MASTER 회전 중(VERYUP_KEY_ROTATION)에는 이 상태가 정상 운영 절차이므로
            # 가짜 열람 기록이 계속 쌓인다. 실패는 실패로 기록하고 응답에도 드러낸다.
            failed.append({"id": c["id"], "label": c["label"], "error": type(e).__name__})
            log.error("인증키 복호화 실패: cred_id=%s platform=%s user=%s (%s) "
                      "— KEY_MASTER 가 이 행을 암호화한 키와 다를 수 있습니다.",
                      c["id"], c["platform"], user["username"], type(e).__name__)
            db.record_key_access(user["id"], user["username"], c["platform"], c["id"],
                                 "view-failed", _ip(request) + " (앱)")
            continue
        result.append({"id": c["id"], "platform": c["platform"], "label": c["label"], "data": data})
        # 앱이 키를 가져간 것도 감사로그에 남긴다 (api 경유 열람)
        db.record_key_access(user["id"], user["username"], c["platform"], c["id"], "view", _ip(request) + " (앱)")

    if failed and not result:
        # 요청한 플랫폼의 인증키를 하나도 못 읽었다. 200 으로 위장하지 않는다 —
        # 앱이 "키가 없다"와 "키를 못 읽는다"를 구분할 수 있어야 한다.
        return JSONResponse(
            {"ok": False, "error": "저장된 인증키를 복호화하지 못했습니다(서버 KEY_MASTER 설정을 확인하세요).",
             "failed": failed},
            status_code=503)
    payload = {"ok": True, "credentials": result}
    if failed:
        payload["failed"] = failed               # 일부만 깨진 경우 — 읽은 것은 주되 사실을 숨기지 않는다
    return payload


@app.post("/api/usage")
def api_usage(request: Request, endpoint: str = Form("predict"),
              ms_elapsed: int = Form(0), authorization: str = Header(None)):
    """앱이 AI 이미지 1건 처리할 때마다 사용량을 기록한다."""
    user = _auth_by_token(authorization)
    if not user:
        return JSONResponse({"ok": False, "error": "인증 필요"}, status_code=401)
    db.record_ai_usage(user["id"], user["username"], endpoint, ms_elapsed)
    return {"ok": True}
