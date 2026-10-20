"""
VERY UP **내부 프로세스** 진입점 — WireGuard 인터페이스에만 바인드한다.

실행 — **두 구성 중 하나**다. 섞어 쓰면 로그인 IP 잠금과 login_logs.ip 가 조용히 망가진다.

  (A) WireGuard 직결 (권장, 앞에 리버스 프록시가 없다)
      VERYUP_ENV=production uvicorn serve_internal:app --host 10.8.0.1 --port 8001
      → --proxy-headers 를 **쓰지 않는다.** 앞에 프록시가 없으니 X-Forwarded-For 는
        전부 클라이언트가 지어낸 값이다. 그대로 믿으면 IP 잠금 우회 + 감사 로그 위조가 된다.
        이 구성에서 request.client.host 는 피어 주소(10.8.0.11 …)라 IP 잠금이 실제로 동작한다.

  (B) 같은 호스트의 nginx 가 루프백으로 프록시 (내부 TLS 종단·임시 Basic auth 구성)
      VERYUP_ENV=production uvicorn serve_internal:app --host 127.0.0.1 --port 8001 \
          --proxy-headers --forwarded-allow-ips 127.0.0.1
      → 신뢰 대상은 **nginx 가 붙어 오는 주소(127.0.0.1)** 이지 이 서버의 WireGuard 주소가 아니다.
        (예전 예시의 `--forwarded-allow-ips 10.8.0.1` 은 어느 구성에도 맞지 않았다.)
        이때 nginx 가 X-Forwarded-For 를 반드시 넣어야 한다. 넣지 않으면 모든 요청이
        127.0.0.1 로 찍히고, app.py:103-115 의 _NON_ROUTABLE_IPS 가 그 값을 잠금 판정에서
        빼기 때문에 **IP 별 로그인 잠금이 사실상 꺼진다**(계정별 잠금만 남는다).

  어느 구성이든 FORWARDED_ALLOW_IPS 를 `*` / `0.0.0.0/0` 으로 두면 기동을 거부한다(아래 5절).

이 프로세스가 서빙하는 것 (보안감사_2026-09-16.md 3절 (b) 확정 아키텍처)
  app.py      : /login, /, /staff, /keys, /logs, /licenses, /usage, /password, /api/*
  proxy.py    : POST /coupang /naver /amazon /ebay, GET /proxy/health
                ※ 쿠팡·네이버 허용목록에 등록된 **아웃바운드 IP** 때문에 이 릴레이는 EC2 에 남는다.
                   사무실 LAN 으로 옮기면 마켓플레이스 허용목록을 전부 재등록해야 한다.
  public.py   : /updates, /updates/{파일}  (internal_router — UPDATE_TOKEN 필수)
  이 파일     : /deletions*  — 공개 프로세스가 쌓은 eBay 삭제 알림 큐의 승인 화면

이 프로세스가 서빙하지 **않는** 것
  /privacy, /privacy/en, /ebay/deletion, /ebay/auth/* → 전부 공개 프로세스(serve_public.py)
  ebay_notify 모듈은 여기서 import 하지 않는다. 그 모듈은 EBAY_DELETION_ENDPOINT 를 요구하고
  무인증 웹훅 수신기라서, 내부 프로세스에 들어올 이유가 없다.

큐 연결 방향 — **내부 → 공개 읽기만** (뒤집히면 분리가 무의미해진다)
  이 프로세스는 공개 프로세스의 ebay_queue.db **파일을 직접 읽는다.** 네트워크 호출이 아니다.
  따라서 공개 → 내부 방향의 소켓·포트·라우트는 하나도 생기지 않는다.
  (같은 EC2 안이므로 파일 공유로 충분하다. 두 프로세스를 다른 호스트에 두게 되면
   내부가 공개로 **나가는** HTTPS 폴링으로 바꾸고, 반대 방향은 그때도 만들지 마라.)

WireGuard 바인드가 이 파일의 전제다
  아래 코드는 인터넷에서 도달 불가를 **가정**할 뿐 스스로 보장하지 못한다.
  보장은 (1) uvicorn --host 를 WireGuard IP 로, (2) AWS 보안그룹에서 해당 포트를 막고,
  (3) nginx 공개 서버 블록이 이 포트로 프록시하지 않게 하는 세 가지가 함께 해야 성립한다.
  배포_분리_가이드.md 의 체크리스트를 따르라.
"""
import html
import logging
import logging.handlers
import os
import sys
import time

# ══════════════════════════════════════════════════════════════
#  0. 로깅 (감사 §23·§29 — 루트 핸들러가 없으면 veryup.* 로그가 아무 데도 안 남는다)
# ══════════════════════════════════════════════════════════════
LOG_LEVEL = (os.environ.get("LOG_LEVEL") or "INFO").upper()
LOG_FILE = (os.environ.get("LOG_FILE") or "").strip()


def _setup_logging() -> None:
    root = logging.getLogger()
    root.setLevel(LOG_LEVEL)
    fmt = logging.Formatter("%(asctime)s %(levelname)s [%(name)s] %(message)s")
    if not any(isinstance(h, logging.StreamHandler) for h in root.handlers):
        stream = logging.StreamHandler(sys.stderr)
        stream.setFormatter(fmt)
        root.addHandler(stream)
    if LOG_FILE:
        handler = logging.handlers.RotatingFileHandler(
            LOG_FILE, maxBytes=10 * 1024 * 1024, backupCount=5, encoding="utf-8")
        handler.setFormatter(fmt)
        root.addHandler(handler)


_setup_logging()
log = logging.getLogger("veryup.serve_internal")


# ══════════════════════════════════════════════════════════════
#  1. 비밀값 확인 — app.py 를 import 하기 **전에**
# ══════════════════════════════════════════════════════════════
# app.py 가 import 되는 순간 config.verify_startup() 이 돌지만, 개발 모드(VERYUP_ENV 미설정)에서는
# 조용히 파일 폴백/자동 생성으로 넘어간다. 운영자가 VERYUP_ENV 를 깜빡 빠뜨리면
# "떴으니 됐다"고 넘어가고, 실제로는 자동 생성된 키로 돌게 된다 — 재시작하면 기존 암호문을 못 읽는다.
# 그래서 여기서 **모드와 무관하게** 두 값의 존재를 먼저 확인한다.
class InternalStartupError(RuntimeError):
    """내부 프로세스 기동 요건이 충족되지 않았을 때."""


_ALLOW_DEV_SECRETS = (os.environ.get("VERYUP_ALLOW_DEV_SECRETS") or "").strip().lower() in (
    "1", "true", "yes", "on")

_missing = [name for name in ("ADMIN_SECRET", "KEY_MASTER")
            if not (os.environ.get(name) or "").strip()]
if _missing:
    if not _ALLOW_DEV_SECRETS:
        raise InternalStartupError(
            "내부 프로세스 기동 거부 — 환경변수 " + ", ".join(_missing) + " 가 없습니다.\n"
            "  ADMIN_SECRET : 세션·API 토큰 **서명** 전용 키. 교체해도 저장된 암호문은 멀쩡하다.\n"
            '                 생성: python -c "import secrets; print(secrets.token_urlsafe(32))"\n'
            "  KEY_MASTER   : 인증키 Fernet **암호화** 전용 키. 기존 데이터를 계속 읽으려면\n"
            "                 현재 server/secret.key 의 내용을 **그대로** 넣어라.\n"
            "                 새로 만들면 기존 암호문은 영구 복호화 불가다.\n"
            "  두 값은 서로 달라야 한다(같으면 분리한 의미가 없어 config.py 가 기동을 거부한다).\n"
            "  로컬 개발에서 일부러 폴백을 쓰려면 VERYUP_ALLOW_DEV_SECRETS=1 을 명시하라."
        )
    log.warning(
        "⚠ %s 가 없어 개발 모드 폴백(파일 읽기/자동 생성)으로 진행합니다. "
        "운영 배포라면 지금 즉시 멈추고 환경변수를 주입하세요.", ", ".join(_missing))

# ── VERYUP_ENV — 미설정이면 **기동 거부** ────────────────────
# 예전에는 경고 한 줄로 넘겼다. 그게 실제로 무엇을 무효화했는지:
#   위 검사(:78-)는 두 변수의 **존재**만 본다. 값이 같은지, 길이가 충분한지는 보지 않는다.
#   그런데 아래 메시지는 "두 값은 서로 달라야 한다(config.py 가 거부한다)"고 약속한다.
#   그 약속은 **VERYUP_ENV=production 일 때만** 참이었다(config.py 가 동일값·길이 검사를
#   is_production() 안에서만 돌렸기 때문). 즉 VERYUP_ENV 를 빠뜨리면
#   ADMIN_SECRET == KEY_MASTER 로도 조용히 떴다 — 서명키/암호화키 분리가 그 자리에서 무효가 된다.
# config.py 담당이 그 검사를 모드 밖으로 올려 이제는 개발 모드에서도 걸리지만,
# 내부 프로세스는 **금고를 여는 유일한 프로세스**다. "실수로 개발 모드"는 여기서 가장 위험하므로
# (파일 폴백·키 자동 생성 경로가 살아 있다) 모드를 명시하지 않으면 아예 뜨지 않게 한다.
_ENV_NAME = (os.environ.get("VERYUP_ENV") or "").strip()
_DEV_ENV_NAMES = ("development", "dev", "local", "test")

if _ENV_NAME.lower() != "production":
    if _ENV_NAME.lower() in _DEV_ENV_NAMES:
        # 개발이라고 **명시**했다 — 그러면 그대로 진행한다. 실수와 의도를 구분하는 것이 요점이다.
        log.warning(
            "⚠ VERYUP_ENV=%s — 개발 모드입니다. 비밀값 파일 폴백/자동 생성이 살아 있습니다. "
            "운영 배포라면 지금 멈추고 VERYUP_ENV=production 으로 바꾸세요.", _ENV_NAME)
    else:
        raise InternalStartupError(
            "내부 프로세스 기동 거부 — VERYUP_ENV 가 "
            + (f"{_ENV_NAME!r} 입니다." if _ENV_NAME else "설정되지 않았습니다.") + "\n"
            "  이 프로세스는 인증키 금고(KEY_MASTER)를 여는 유일한 프로세스라 모드를 추측하지 않는다.\n"
            "  운영: VERYUP_ENV=production  ← 비밀값 파일 폴백·자동 생성이 전부 꺼진다.\n"
            "  개발: VERYUP_ENV=development ← 폴백을 쓰겠다고 **명시**하는 것이다.\n"
            "  (production 은 철자 그대로여야 한다. 'prod' 같은 값은 config.py 가 개발 모드로 읽는다.)"
        )

# ── FORWARDED_ALLOW_IPS — 와일드카드 거부 ────────────────────
# 이 값이 "*" 면 uvicorn 이 **모든** 클라이언트의 X-Forwarded-For 를 그대로 믿는다. 결과:
#   (1) app.py 의 로그인 IP 잠금을 헤더 한 줄로 우회한다(요청마다 다른 IP 를 대면 카운터가 안 쌓인다),
#   (2) login_logs.ip / key_access_logs.ip 에 공격자가 고른 문자열이 남는다 — 감사 추적 오염.
# WireGuard 뒤라도 마찬가지다. VPN 은 '누가 붙었는지'를 보장할 뿐 그 피어가 보낸 헤더를
# 진실로 만들어 주지 않는다(감염된 사무실 PC 한 대면 성립한다).
_FORWARDED_WILDCARDS = {"*", "0.0.0.0/0", "::/0", "0.0.0.0", "::"}


def _check_forwarded_allow_ips(raw: str, *, source: str) -> str:
    """신뢰 프록시 목록에 와일드카드가 있으면 기동을 거부한다."""
    entries = [e.strip() for e in (raw or "").split(",") if e.strip()]
    bad = [e for e in entries if e in _FORWARDED_WILDCARDS]
    if bad:
        raise InternalStartupError(
            f"내부 프로세스 기동 거부 — {source} 에 와일드카드 {', '.join(bad)} 가 있습니다.\n"
            "  이 설정은 아무나 X-Forwarded-For 를 지어내 로그인 IP 잠금을 우회하고\n"
            "  login_logs 의 IP 를 위조할 수 있게 만듭니다.\n"
            "  (A) WireGuard 직결이면 --proxy-headers 자체를 쓰지 마세요(이 값도 비웁니다).\n"
            "  (B) 같은 호스트의 nginx 가 앞에 있으면 그 프록시 주소만 적으세요(예: 127.0.0.1)."
        )
    return ",".join(entries)


# 환경변수 경로(EnvironmentFile 에 적힌 경우) — uvicorn 은 이 이름을 기본값으로 읽는다.
_check_forwarded_allow_ips(os.environ.get("FORWARDED_ALLOW_IPS") or "",
                           source="환경변수 FORWARDED_ALLOW_IPS")

# CLI 경로(`uvicorn ... --forwarded-allow-ips '*'`) — uvicorn 이 만든 값이라 코드에서 읽을 방법이
# 없으므로 argv 를 직접 본다. ExecStart 에 적힌 오타를 잡는 것이 목적이다.
# (gunicorn 등 다른 런처로 띄우면 이 점검은 건너뛴다 — 그래서 위 환경변수 점검을 함께 둔다.)
_argv = sys.argv[1:]
for _i, _arg in enumerate(_argv):
    if _arg == "--forwarded-allow-ips" and _i + 1 < len(_argv):
        _check_forwarded_allow_ips(_argv[_i + 1], source="uvicorn --forwarded-allow-ips")
    elif _arg.startswith("--forwarded-allow-ips="):
        _check_forwarded_allow_ips(_arg.split("=", 1)[1], source="uvicorn --forwarded-allow-ips")

# ══════════════════════════════════════════════════════════════
#  2. 내부 앱 import
# ══════════════════════════════════════════════════════════════
# app.py 가 import 시점에 config.verify_startup() → db.init_db() → 라우터 등록(proxy, public.internal)
# 까지 모두 수행한다. 이 파일은 그 위에 큐 승인 화면만 얹는다.
from fastapi import FastAPI, Form, Request  # noqa: E402
from fastapi.responses import HTMLResponse, RedirectResponse, Response  # noqa: E402
from starlette.concurrency import run_in_threadpool  # noqa: E402
from starlette.middleware.base import BaseHTTPMiddleware  # noqa: E402
from starlette.middleware.trustedhost import TrustedHostMiddleware  # noqa: E402

import app as admin_app  # noqa: E402  (app.py — 내부 관리자 앱)
import config            # noqa: E402
import crypto            # noqa: E402
import db                # noqa: E402
import ebay_queue        # noqa: E402  (공개 프로세스의 큐 파일을 **읽기 위해서만** 쓴다)

# ⚠ ebay_notify 는 import 하지 않는다. 그 모듈은 EBAY_DELETION_ENDPOINT 를 요구하는
#   무인증 웹훅 수신기이고, 내부 프로세스가 그것을 들고 있을 이유가 없다.
if "ebay_notify" in sys.modules:
    raise InternalStartupError(
        "내부 프로세스에 ebay_notify(공개 웹훅 수신기)가 로드됐습니다. "
        "공개 표면은 serve_public.py 가 담당합니다 — import 를 제거하세요."
    )

app: FastAPI = admin_app.app

# ── 마스터 키 자가검증 (KEY_MASTER 가 '이 DB 를 암호화한 그 키'인지) ──
# app.py import 시점에 config.verify_startup() → db.init_db() 가 이미 끝났다. 그 둘은 **형식**만 본다.
# 형식만 맞는 다른 Fernet 키를 주입하면 기동은 멀쩡히 성공하고, 고장은 한참 뒤에
# /api/credentials 가 조용히 data:null 을 돌려주는 모습으로 드러난다(게다가 "view" 감사 로그까지 남는다).
# 그래서 저장된 암호문을 실제로 복호화해 보고 **한 건도** 안 되면 여기서 멈춘다.
#
# 회전 전용 탈출구 — VERYUP_KEY_ROTATION=1
#   KEY_MASTER 회전 절차는 ① 자격증명 재발급 → ② 새 키로 기동 → ③ /keys 재입력 인데,
#   ②의 시점에는 admin.db 에 옛 키로 암호화된 행만 남아 있으므로 카나리아가 반드시 실패한다.
#   그대로 기동을 막으면 ③의 재입력 화면 자체가 뜨지 않아 **회전이 구조적으로 불가능**했다
#   (게다가 그때 뜨던 오류가 "새 KEY_MASTER 로 기동 → /keys 재입력"을 안내하는 순환이었다).
#   그래서 회전 중임을 **명시**하면 실패를 ERROR 로그 + 기동 요약 경고로 낮추고 기동시킨다.
#   ⚠ VERYUP_ALLOW_DEV_SECRETS 와 겸용하지 않는다 — 그 변수는 비밀값 파일 폴백·자동 생성까지
#     통째로 여는 로컬 개발 스위치라, 사고 대응 중에 켜게 만들면 안 된다.
#     VERYUP_KEY_ROTATION 은 위의 두 비밀값 존재·길이·동일값 검사를 하나도 풀지 않는다.
_KEY_ROTATION = config.key_rotation_mode()
_CANARY_STATUS = "통과 (인증키가 0건이면 비교할 암호문이 없어 건너뛴다 — config 로그 참조)"
_CANARY_FAILED = False          # 배너·요약이 "지금 금고를 못 연다"를 표시할지 판단하는 값
try:
    config.verify_master_key_canary()
    _report = config.canary_report()
    if _report["status"] == "부분 실패":
        _CANARY_FAILED = True
        _CANARY_STATUS = ("⚠ 부분 실패 — %d건 중 %d건만 복호화됨. 나머지는 옛 KEY_MASTER 로 암호화된 행일 수 있습니다"
                          " (/keys 에서 삭제 후 재입력)" % (_report["checked"], _report["ok"]))
    elif _report["status"] == "건너뜀":
        _CANARY_STATUS = "건너뜀 — " + str(_report.get("note") or "비교할 암호문 없음")
    elif _report["status"] == "통과":
        _CANARY_STATUS = "통과 — 저장된 인증키 %d건 전부 복호화됨" % _report["ok"]
except config.SecretConfigError as e:
    _CANARY_FAILED = True
    if _KEY_ROTATION:
        _CANARY_STATUS = ("❌ 실패 — VERYUP_KEY_ROTATION=1 이라 기동만 허용했습니다. "
                          "회전이 끝나면 이 환경변수를 **제거**하세요")
        log.error("═" * 62)
        log.error("⚠ 마스터 키 카나리아 실패 — VERYUP_KEY_ROTATION=1 이라 기동은 계속합니다.")
        log.error("   %s", e)
        log.error("   지금 상태: 저장된 인증키를 **하나도 읽지 못합니다**. /api/credentials 는 data:null 을,")
        log.error("   /keys 상세는 '복호화 실패' 안내를 돌려줍니다 — 직원 앱도 그동안 인증키를 못 받습니다.")
        log.error("   할 일: /keys 에서 옛 행을 삭제하고 새 자격증명을 재입력한 뒤,")
        log.error("         **VERYUP_KEY_ROTATION 을 제거하고 다시 띄워** 카나리아가 통과하는지 확인하세요.")
        log.error("         남겨 두면 다음 사고(KEY_MASTER 오타)가 조용히 통과합니다.")
        log.error("═" * 62)
    elif _ALLOW_DEV_SECRETS:
        # 로컬 개발 탈출구를 이미 명시한 사람에게는 기동을 막지 않는다
        # (자동 생성 키로 남의 admin.db 사본을 열어 보는 상황이 정상적으로 존재한다).
        # 운영 회전용 탈출구는 위의 VERYUP_KEY_ROTATION 이다 — 이 변수를 그 용도로 쓰지 마라.
        _CANARY_STATUS = "❌ 실패 — KEY_MASTER 가 이 admin.db 를 암호화한 키가 아닙니다 (개발 폴백으로 계속 진행)"
        log.error("⚠ 마스터 키 카나리아 실패(VERYUP_ALLOW_DEV_SECRETS=1 이라 계속 진행): %s", e)
    else:
        raise InternalStartupError(str(e)) from e

# ── 기존 관리자 계정 점검 (감사 §1·2·4·7 의 'admin/admin1234') ──
# 기본계정 자동 생성을 막은 것은 **생성 경로**뿐이다. 이미 admin.db 에 들어 있는 계정은
# 그대로 유효하고, must_change_password 열은 _ensure_column 이 DEFAULT 0 으로 붙였기 때문에
# 기존 계정은 전부 '강제 변경 대상 아님'으로 시작한다. 감사가 문제 삼은 그 계정이 바로 이것이다.
# 코드가 비밀번호를 볼 수는 없으므로(해시만 있다) 여기서 하는 일은 두 가지다:
#   1) 강제 변경 플래그가 없는 활성 관리자 계정을 세어 기동 로그와 관리 화면에 드러낸다,
#   2) VERYUP_FORCE_ADMIN_PW_CHANGE=1 이면 그 계정들에 플래그를 **일괄로** 세운다.
# 확인이 끝난 계정은 VERYUP_ADMIN_PW_ACK 에 아이디를 적어 경고에서 뺀다 —
# 경고를 끄는 유일한 방법을 '전부 무시'로 두면 새 계정이 생겨도 아무도 못 알아채기 때문이다.
_ADMIN_PW_ACK = {u.strip().lower()
                 for u in (os.environ.get("VERYUP_ADMIN_PW_ACK") or "").split(",") if u.strip()}
_FORCE_ADMIN_PW_CHANGE = (os.environ.get("VERYUP_FORCE_ADMIN_PW_CHANGE") or "").strip().lower() in (
    "1", "true", "yes", "on")
_ADMIN_PW_RECHECK_SEC = 60.0        # 배너용 캐시 수명(관리자가 비밀번호를 바꾸면 곧 사라져야 한다)
_stale_admin_cache: dict = {"names": [], "at": 0.0}


def _is_admin_row(row) -> bool:
    """role 값의 공백·대소문자를 흡수하는 관리자 판정(app.py 와 같은 규칙)."""
    checker = getattr(admin_app, "_is_admin", None)
    if checker:
        return bool(checker(row))
    try:
        return str(row["role"]).strip().lower() == "admin"     # 폴백(app.py 가 헬퍼를 없앤 경우)
    except Exception:                                          # noqa: BLE001
        return False


def _stale_admin_usernames() -> list[str]:
    """강제 변경 플래그가 없는 **활성 관리자** 아이디 목록.

    ⚠ admin.db 를 직접 열지 않는다 — db 모듈 함수만 쓴다(파일을 두 곳에서 열면 잠금이 꼬인다).
    """
    try:
        rows = db.list_staff()
    except Exception as e:                       # noqa: BLE001 - 점검 실패가 기동을 막지는 않는다
        log.error("관리자 계정 점검 실패: %s", type(e).__name__)
        return []
    out = []
    for row in rows:
        if not _is_admin_row(row) or admin_app._row_get(row, "is_active", 0) != 1:
            continue
        if admin_app._row_get(row, "must_change_password", 0) == 1:
            continue                              # 이미 다음 로그인에서 바꾸게 돼 있다
        name = str(row["username"])
        if name.lower() in _ADMIN_PW_ACK:
            continue                              # 운영자가 "이 계정은 확인했다"고 명시한 것
        out.append(name)
    return out


def _audit_existing_admins() -> None:
    """기동 시 1회. 필요하면 일괄 플래그까지 세운다."""
    names = _stale_admin_usernames()
    _stale_admin_cache["names"] = names
    _stale_admin_cache["at"] = time.monotonic()
    if not names:
        log.info("관리자 계정 점검: 비밀번호 확인이 필요한 활성 관리자 없음 ✅")
        return

    if _FORCE_ADMIN_PW_CHANGE:
        changed = []
        for row in db.list_staff():
            if str(row["username"]) in names:
                try:
                    db.set_must_change_password(row["id"], True)
                    changed.append(str(row["username"]))
                except Exception as e:            # noqa: BLE001
                    log.error("강제 변경 플래그 설정 실패 (%s): %s", row["username"], type(e).__name__)
        log.warning("VERYUP_FORCE_ADMIN_PW_CHANGE=1 — 관리자 계정 %d개에 비밀번호 강제 변경을 걸었습니다: %s. "
                    "다음 로그인에서 /password 로 리다이렉트되고, 바꾸기 전에는 앱 /api/login 이 403 입니다. "
                    "조치가 끝나면 이 환경변수를 **제거**하세요(재기동마다 다시 걸립니다).",
                    len(changed), ", ".join(changed))
        _stale_admin_cache["names"] = _stale_admin_usernames()
        return

    log.warning("═" * 62)
    log.warning("⚠ 비밀번호를 **확인했다고 표시되지 않은** 활성 관리자 계정 %d개: %s",
                len(names), ", ".join(names))
    log.warning("   기본계정 자동 생성은 막았지만, **이미 admin.db 에 있던 계정은 그대로 유효**합니다 —")
    log.warning("   감사가 지적한 admin/admin1234 도 지우지 않는 한 그대로 로그인됩니다.")
    log.warning("   ※ 코드는 비밀번호 자체를 볼 수 없다(해시만 있다). 여기서 보는 것은")
    log.warning("     'must_change_password 플래그가 걸려 있지 않다'는 사실뿐이며,")
    log.warning("     비밀번호를 방금 바꾼 계정도 플래그가 0 이라 이 목록에 다시 나타난다.")
    log.warning("   조치: (1) 비밀번호를 바꾸거나 확인한다 — 잘 모르겠으면")
    log.warning("             VERYUP_FORCE_ADMIN_PW_CHANGE=1 로 한 번 띄워 전원에게 변경을 강제하고")
    log.warning("             그 환경변수를 다시 지운다,")
    log.warning("        (2) 그런 다음 VERYUP_ADMIN_PW_ACK=아이디1,아이디2 에 적어 이 경고를 끈다.")
    log.warning("             적지 않으면 계속 뜬다. 목록에 없는 계정이 새로 생기면 다시 뜬다.")
    log.warning("═" * 62)


try:
    _audit_existing_admins()
except Exception as e:                            # noqa: BLE001 - 점검이 기동을 죽이지 않게
    log.error("관리자 계정 점검 중 예외: %s: %s", type(e).__name__, e)


# ── 관리 화면 배너 ───────────────────────────────────────────
# 기동 로그는 journal 에 묻힌다. 위 경고는 '사람이 조치해야만' 사라지는 종류라 화면에도 띄운다.
# app.py 의 템플릿은 내 담당 파일이 아니므로 응답 HTML 에 한 줄을 끼워 넣는 방식으로 붙인다.
_BANNER_STYLE = ("position:sticky;top:0;z-index:9999;background:#c62828;color:#fff;"
                 "padding:10px 14px;font:13px/1.5 system-ui,'Malgun Gothic',sans-serif")
_ROTATION_BANNER_STYLE = ("position:sticky;top:0;z-index:9999;background:#6a1b9a;color:#fff;"
                          "padding:10px 14px;font:13px/1.5 system-ui,'Malgun Gothic',sans-serif")


def _rotation_banner_html() -> str:
    """KEY_MASTER 회전 중(또는 복호화 불가 행이 남아 있을 때) 띄우는 배너.

    왜 화면에도 띄우는가: VERYUP_KEY_ROTATION 은 **기동 거부를 경고로 낮추는** 스위치라,
    지우는 것을 잊으면 다음 사고(KEY_MASTER 오타)가 조용히 통과한다. 기동 로그는 journal 에
    묻히므로 '사람이 조치해야 사라지는' 종류의 경고는 관리 화면에도 함께 둔다.
    """
    if not (_KEY_ROTATION or _CANARY_FAILED):
        return ""
    report = config.canary_report()
    failed = report.get("failed") or []
    detail = ""
    if failed:
        detail = ("기동 시점 기준 복호화 불가 인증키 " + str(len(failed)) + "건: "
                  + html.escape(", ".join(f"#{f['id']} {f['platform']}/{f['label']}" for f in failed[:10]))
                  + ("…" if len(failed) > 10 else "") + ". ")
    if _KEY_ROTATION:
        head = "🔑 KEY_MASTER <b>회전 모드</b>로 떠 있습니다 (VERYUP_KEY_ROTATION=1). "
        tail = ("<a href=\"/keys\" style=\"color:#fff\">/keys</a> 에서 옛 행을 삭제하고 새 값을 재입력한 뒤, "
                "<b>이 환경변수를 제거하고 재기동</b>하세요 — 남겨 두면 KEY_MASTER 오타가 조용히 통과합니다.")
    else:
        head = "🔓 저장된 인증키 일부를 <b>복호화하지 못했습니다</b>. "
        tail = ("옛 KEY_MASTER 로 암호화된 행일 수 있습니다 — "
                "<a href=\"/keys\" style=\"color:#fff\">/keys</a> 에서 확인해 삭제·재입력하세요.")
    return '<div style="' + _ROTATION_BANNER_STYLE + '">' + head + detail + tail + "</div>"


def _viewer_is_admin(request: Request) -> bool:
    """이 응답을 받는 사람이 **로그인한 관리자**인가.

    ⚠ 반드시 call_next() 가 끝난 뒤에 불러야 한다. 이 미들웨어는 SessionMiddleware 보다
      바깥쪽이라(나중에 add_middleware 한 것이 바깥), 요청 시점에는 scope["session"] 이 아직 없다.
      안쪽 SessionMiddleware 가 같은 scope dict 에 session 을 채워 넣으므로 응답 뒤에는 읽을 수 있다.
    """
    session = request.scope.get("session")
    if not isinstance(session, dict):
        return False                          # 세션이 아예 없는 경로(정적 파일 등)
    uid = session.get("uid")
    if not uid:
        return False
    try:
        user = db.get_staff_by_id(uid)
    except Exception as e:                    # noqa: BLE001 - 배너 때문에 화면이 죽으면 본말전도다
        log.error("배너 권한 판단 실패: %s: %s", type(e).__name__, e)
        return False
    if not user or admin_app._row_get(user, "is_active", 0) != 1:
        return False
    return _is_admin_row(user)


async def _banner_blocks(request: Request, response) -> list[str]:
    """이 응답에 끼울 배너 HTML 조각들. 없으면 빈 목록.

    ⚠ 여기서는 **본문을 건드리지 않는다.** body_iterator 를 한 번이라도 소비하면
      되돌릴 수 없으므로, 판단이 끝난 뒤에만 읽는다.
    """
    if response.status_code != 200:
        return []
    if "text/html" not in (response.headers.get("content-type") or ""):
        return []                # /updates 파일 다운로드·JSON API 는 건드리지 않는다

    # ⚠ 관리자 세션이 아니면 아무것도 끼우지 않는다.
    #   이 검사가 없으면 **로그인하지 않은 /login 화면**에 유효한 관리자 아이디 목록과
    #   "기본 비밀번호(admin/admin1234)일 수 있다"는 힌트, 그리고 회전 배너의 인증키 인벤토리
    #   (#1 coupang/메인 …)가 함께 나간다. 이 감사의 출발점이 바로 인터넷에 열린 /login 이었고,
    #   배너가 그 화면에 공격에 필요한 정보를 직접 얹어 주는 상태가 된다.
    #   경고를 보여 줘야 할 상대는 조치할 수 있는 관리자뿐이다.
    if not _viewer_is_admin(request):
        return []

    blocks: list[str] = []
    rotation = _rotation_banner_html()       # 기동 시점 값이라 DB 조회가 없다(캐시 불필요)
    if rotation:
        blocks.append(rotation)

    names = _stale_admin_cache["names"]
    if time.monotonic() - _stale_admin_cache["at"] > _ADMIN_PW_RECHECK_SEC:
        # 관리자가 비밀번호를 바꾸면 배너가 저절로 사라져야 한다(사람이 재기동할 리 없다).
        names = await run_in_threadpool(_stale_admin_usernames)
        _stale_admin_cache["names"] = names
        _stale_admin_cache["at"] = time.monotonic()
    if names:
        blocks.append(
            '<div style="' + _BANNER_STYLE + '">⚠ 비밀번호를 확인했다고 표시되지 않은 관리자 계정 '
            + str(len(names)) + "개: " + html.escape(", ".join(names)) + ". "
            "예전 admin.db 에서 넘어온 계정이라면 기본 비밀번호(admin/admin1234)일 수 있습니다 — "
            '<a href="/password" style="color:#fff">지금 변경</a>하고, '
            "확인이 끝나면 내부 유닛에 VERYUP_ADMIN_PW_ACK=아이디 를 넣어 이 배너를 끄세요"
            "(비밀번호를 바꿔도 이 배너는 자동으로 사라지지 않습니다 — 코드는 비밀번호를 볼 수 없습니다).</div>")
    return blocks


async def _admin_password_banner(request: Request, call_next):
    """조치가 남아 있는 경고(회전 모드·미확인 관리자 계정)를 모든 내부 HTML 화면 위에 띄운다."""
    response = await call_next(request)
    try:
        blocks = await _banner_blocks(request, response)
    except Exception as e:                        # noqa: BLE001 - 판단 실패는 조용히 넘긴다
        log.error("관리자 경고 배너 판단 실패: %s: %s", type(e).__name__, e)
        return response
    if not blocks:
        return response

    # 여기서부터는 본문을 소비했으므로 **반드시** 새 Response 를 만들어 돌려줘야 한다.
    body = b"".join([chunk async for chunk in response.body_iterator])
    try:
        idx = body.find(b"<body")
        end = body.find(b">", idx) if idx >= 0 else -1
        if end >= 0:
            banner = "".join(blocks).encode("utf-8")
            body = body[:end + 1] + banner + body[end + 1:]
    except Exception as e:                        # noqa: BLE001 - 배너 때문에 화면이 죽으면 본말전도다
        log.error("관리자 경고 배너 주입 실패: %s: %s", type(e).__name__, e)
    # content-length 는 Response 가 새 본문 길이로 다시 계산한다(옛 값을 넘기면 응답이 잘린다).
    headers = {k: v for k, v in response.headers.items() if k.lower() != "content-length"}
    return Response(content=body, status_code=response.status_code,
                    headers=headers, media_type=response.media_type)


app.add_middleware(BaseHTTPMiddleware, dispatch=_admin_password_banner)

# ── 내부 문서 페이지 제거 ────────────────────────────────────
# app.py 는 FastAPI() 기본값으로 만들어져 /docs, /redoc, /openapi.json 이 딸려 있다.
# 내부망이라도 관리 API 의 전체 스키마를 열어 둘 이유는 없다(내부자·감염 PC 경로가 남는다).
# app.py 는 내 담당 파일이 아니라 수정하지 않고, 진입점에서 라우트만 걷어낸다.
if (os.environ.get("INTERNAL_ENABLE_DOCS") or "").strip().lower() not in ("1", "true", "yes", "on"):
    _doc_paths = {"/docs", "/redoc", "/openapi.json", "/docs/oauth2-redirect"}
    app.router.routes = [r for r in app.router.routes
                         if getattr(r, "path", None) not in _doc_paths]

# ── Host 헤더 제한 (선택, 심층 방어) ─────────────────────────
# 바인드 주소를 잘못 열었을 때 공개 도메인 이름으로 들어오는 요청을 한 겹 더 막는다.
# 예: INTERNAL_ALLOWED_HOSTS=10.8.0.1,admin.internal,localhost
_allowed_hosts = [h.strip() for h in (os.environ.get("INTERNAL_ALLOWED_HOSTS") or "").split(",") if h.strip()]
if _allowed_hosts:
    # ⚠ Starlette 는 **나중에 add_middleware 한 것이 바깥쪽**이다. 여기서 추가하면
    #   app.py 의 세션·강제비밀번호변경 미들웨어보다 바깥에서 먼저 걸러진다 — 의도한 순서다.
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=_allowed_hosts)
    log.info("Host 헤더 허용목록 적용: %s", ", ".join(_allowed_hosts))


# ══════════════════════════════════════════════════════════════
#  3. eBay 삭제 알림 큐 — 관리자 승인 화면
# ══════════════════════════════════════════════════════════════
# 왜 필요한가
#   공개 프로세스의 POST /ebay/deletion 은 더 이상 인증키를 지우지 않는다(감사 §19·§26).
#   서명 검증을 통과한 알림을 pending 으로 쌓아둘 뿐이다. 그 큐를 사람이 확인하고
#   승인할 자리가 없으면 eBay 이행 기한 30일을 그냥 넘기게 된다. 이 화면이 그 자리다.
#
# 경로 접두사를 /ebay 로 두지 않은 이유
#   app.py 의 강제 비밀번호 변경 미들웨어가 "/ebay" 로 시작하는 경로를 면제 목록에 두고 있다
#   (공개 라우터용 면제). /ebay/... 로 만들면 must_change_password 강제가 이 화면에만 빠진다.
_PENDING_PREFIX = "/deletions"

# ── 삭제 이행 ────────────────────────────────────────────────
# 예전에는 ebay_notify.py 에도 같은 로직이 한 벌 더 있었다. 지금은 **여기에만 있다** —
# 공개 프로세스에서 _purge_records_for_user / _USER_ID_FIELDS 가 제거됐다(그 함수가 db·crypto 를
# 지연 import 해 admin.db 로 가는 가젯이 되고 있었다). 즉 인증키를 지우는 코드는 이 파일 하나뿐이고,
# 그 실행은 아래 관리자 승인 경로에서만 일어난다.
#
# 알림의 eBay userId 와 '명시적으로' 같은 값을 들고 있는 필드만 본다.
# 플랫폼 중립적인 "userId" 는 제외 — 네이버·쿠팡 세션 블롭에도 있는 이름이라
# 알림 한 통으로 엉뚱한 플랫폼 인증키가 지워질 수 있다(감사 §ebay-webhook).
_USER_ID_FIELDS = ("ebayUserId", "ebayUserID")


def _purge_records_for_user(user_id: str, *, actor_id=None, actor_name: str = "-",
                            request_ip: str | None = None) -> dict:
    """해당 eBay userId 에 연결된 저장 기록을 찾아 지우고 처리 결과를 돌려준다.

    이 앱의 인증키는 '플랫폼+별칭' 기준으로 저장되지 어떤 구매자 계정에 매여 있지 않다.
    따라서 보통은 matched=0 이 정상이고, 그것이 곧 '지울 것이 없었다'는 증빙이 된다.
    """
    import json

    result = {"scanned": 0, "matched": 0, "removed": 0, "errors": 0}
    if not user_id:
        return result
    try:
        rows = db.list_credentials()
    except Exception as e:                       # noqa: BLE001 - DB 장애에도 화면은 살아 있어야 한다
        log.error("ebay 삭제 이행: 인증키 목록 조회 실패: %s", type(e).__name__)
        result["errors"] += 1
        return result

    for row in rows:
        # eBay 계정 삭제 알림이 지울 수 있는 것은 eBay 인증키뿐이다.
        if row["platform"] != "ebay":
            continue
        result["scanned"] += 1
        try:
            full = db.get_credential(row["id"])
            if not full:
                continue
            data = json.loads(crypto.decrypt(full["enc_payload"]))
        except Exception as e:                   # noqa: BLE001 - 한 건 실패로 전체를 멈추지 않는다
            log.warning("ebay 삭제 이행: 인증키 %s 확인 실패: %s", row["id"], type(e).__name__)
            result["errors"] += 1
            continue
        if not isinstance(data, dict):
            continue
        if not any(data.get(f) == user_id for f in _USER_ID_FIELDS if isinstance(data.get(f), str)):
            continue
        result["matched"] += 1
        try:
            db.delete_credential(full["id"])
            result["removed"] += 1
            # 관리자 경로(/keys)와 똑같이 감사 로그를 남긴다 — /logs 화면에 보이지 않는
            # 삭제가 생기면 그것이 곧 추적 불가능한 삭제다(감사 §20).
            db.record_key_access(actor_id, f"{actor_name}(ebay-deletion-approved)",
                                 full["platform"], full["id"], "delete", request_ip)
            log.info("ebay 삭제 이행: 인증키 %s 삭제 (platform=%s, 승인자=%s)",
                     full["id"], full["platform"], actor_name)
        except Exception as e:                   # noqa: BLE001
            log.error("ebay 삭제 이행: 인증키 %s 삭제 실패: %s", full["id"], type(e).__name__)
            result["errors"] += 1
    return result


# ── 큐 파일 접근 ─────────────────────────────────────────────
def _queue_ready() -> bool:
    """큐 파일이 이미 있는지.

    ⚠ 없을 때 만들지 않는다(ebay_queue.init() 을 호출하지 않는다).
      내부 프로세스가 먼저 만들면 파일 소유자가 내부 계정이 되어, 공개 프로세스가
      알림을 받는 순간 쓰기 실패로 그 알림을 잃는다. 큐 파일의 주인은 공개 프로세스다.
    """
    return os.path.exists(ebay_queue.DB_PATH)


def _html_page(body: str) -> HTMLResponse:
    """전용 템플릿 없이 한 파일로 끝낸다.

    templates/ 는 이 작업의 담당 파일이 아니라 새 템플릿을 넣지 못했다.
    후속으로 templates/deletions.html 을 만들어 app.render() 로 옮기면 나머지 화면과 톤이 맞는다.
    """
    return HTMLResponse(
        "<!doctype html><html lang='ko'><head><meta charset='utf-8'>"
        "<meta name='viewport' content='width=device-width,initial-scale=1'>"
        "<title>eBay 삭제 요청</title><style>"
        "body{font-family:system-ui,'Malgun Gothic',sans-serif;margin:0;padding:24px 16px;"
        "background:#f6f7f9;color:#1b1f24}"
        ".wrap{max-width:1000px;margin:0 auto}"
        "h1{font-size:20px;margin:0 0 4px}p.sub{color:#5b6470;margin:0 0 20px;font-size:13px}"
        "table{width:100%;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden;"
        "box-shadow:0 1px 3px rgba(0,0,0,.08);font-size:13px}"
        "th,td{padding:10px 12px;text-align:left;border-bottom:1px solid #eceef1;vertical-align:top}"
        "th{background:#f0f2f5;font-weight:600}"
        "button{padding:6px 12px;border:0;border-radius:6px;cursor:pointer;font-size:12px}"
        ".ok{background:#c62828;color:#fff}.no{background:#e3e6ea;color:#333}"
        ".note{background:#fff8e1;border:1px solid #ffe08a;padding:12px 14px;border-radius:8px;"
        "font-size:13px;margin-bottom:16px}"
        "a{color:#1558d6}code{background:#eceef1;padding:1px 5px;border-radius:4px}"
        "</style></head><body><div class='wrap'>" + body + "</div></body></html>"
    )


def _e(value) -> str:
    """HTML 이스케이프. 큐의 값은 인터넷에서 들어온 문자열이므로 반드시 통과시킨다."""
    return html.escape("" if value is None else str(value))


def _row_value(row, key, default=None):
    """sqlite3.Row 에서 **없을 수도 있는** 열을 안전하게 읽는다.

    quarantine_ref 는 나중에 추가된 열이다. ebay_queue.init() 의 마이그레이션이 붙여 주지만,
    내부 프로세스는 큐 파일을 만들지 않으므로(소유자는 공개 프로세스다) 아직 옛 스키마인
    파일을 읽게 되는 순간이 실제로 존재한다. 그때 IndexError 로 화면 전체가 죽지 않게 한다.
    """
    try:
        value = row[key]
    except (KeyError, IndexError, TypeError):
        return default
    return default if value is None else value


def _require_admin(request: Request):
    """(user, 리다이렉트응답) — 관리자면 (user, None)."""
    user = admin_app.current_user(request)
    if not user:
        return None, RedirectResponse("/login", status_code=303)
    if not _is_admin_row(user):
        return None, RedirectResponse("/", status_code=303)
    return user, None


@app.get(_PENDING_PREFIX, response_class=HTMLResponse)
def deletions_page(request: Request, msg: str = None):
    """공개 프로세스가 쌓은 eBay 계정 삭제 알림 목록 (관리자 전용)."""
    user, redirect = _require_admin(request)
    if redirect:
        return redirect

    if not _queue_ready():
        return _html_page(
            "<h1>eBay 계정 삭제 요청</h1>"
            "<div class='note'>큐 파일이 아직 없습니다 — <code>" + _e(ebay_queue.DB_PATH) + "</code><br>"
            "공개 프로세스(serve_public.py)가 한 번도 기동하지 않았거나, "
            "두 프로세스의 <code>EBAY_QUEUE_DIR</code>(또는 개별 <code>EBAY_QUEUE_DB</code>) 이 "
            "서로 다릅니다 — 현재 이 프로세스의 값: <code>"
            + _e(ebay_queue.QUEUE_DIR or "(미설정 — 소스 디렉터리)") + "</code>. "
            "이 화면은 큐 파일을 <b>만들지 않습니다</b> — 파일의 주인은 공개 프로세스여야 하기 때문입니다.</div>"
            "<p><a href='/'>← 대시보드</a></p>")

    try:
        pending = ebay_queue.list_pending(limit=200)
        done = ebay_queue.list_pending(limit=30, status="fulfilled")
        dismissed = ebay_queue.list_pending(limit=30, status="dismissed")
        rejections = ebay_queue.recent_rejections(limit=30)
        counts = ebay_queue.stats()
    except Exception as e:                       # noqa: BLE001 - 큐 장애가 관리 화면 전체를 죽이지 않게
        log.error("eBay 큐 조회 실패: %s: %s", type(e).__name__, e)
        return _html_page(
            "<h1>eBay 계정 삭제 요청</h1>"
            "<div class='note'>큐를 읽지 못했습니다: <code>" + _e(type(e).__name__) + "</code><br>"
            "큐 파일(<code>" + _e(ebay_queue.DB_PATH) + "</code>)에 읽기 권한이 있는지 확인하세요 "
            "— 공개/내부 계정을 같은 그룹에 넣고 파일을 0660 으로 두는 구성이 표준입니다.</div>"
            "<p><a href='/'>← 대시보드</a></p>")

    # CSRF 토큰은 **세션당 하나**라 행마다 새로 발급하지 않고 한 번 만들어 재사용한다.
    csrf = admin_app.csrf_input_html(request)

    rows = []
    for r in pending:
        rows.append(
            "<tr><td>" + _e(r["id"]) + "</td>"
            "<td><b>" + _e(r["user_id"]) + "</b><br><span style='color:#5b6470'>"
            + _e(r["username"]) + "</span></td>"
            "<td>" + _e(r["topic"]) + "</td>"
            "<td>" + _e(r["event_date"]) + "<br><span style='color:#5b6470'>수신 "
            + _e(r["received_at"]) + "</span></td>"
            "<td>" + _e(r["source_ip"]) + "</td>"
            "<td>"
            "<form method='post' action='" + _PENDING_PREFIX + "/" + _e(r["id"]) + "/approve' "
            "style='display:inline' onsubmit=\"return confirm('이 eBay 사용자의 인증키를 실제로 삭제합니다. 되돌릴 수 없습니다. 계속할까요?')\">"
            + csrf + "<button class='ok'>승인·삭제</button></form> "
            "<form method='post' action='" + _PENDING_PREFIX + "/" + _e(r["id"]) + "/dismiss' "
            "style='display:inline'>" + csrf + "<button class='no'>기각</button></form>"
            "</td></tr>")
    if not rows:
        rows.append("<tr><td colspan='6' style='color:#5b6470'>대기 중인 요청이 없습니다.</td></tr>")

    history = []
    for r in list(done) + list(dismissed):
        history.append(
            "<tr><td>" + _e(r["id"]) + "</td><td>" + _e(r["user_id"]) + "</td>"
            "<td>" + _e(r["status"]) + "</td><td>" + _e(r["resolved_at"]) + "</td>"
            "<td>" + _e(r["resolved_by"]) + "</td><td>" + _e(r["resolution_note"]) + "</td></tr>")
    if not history:
        history.append("<tr><td colspan='6' style='color:#5b6470'>처리 이력이 없습니다.</td></tr>")

    rej = []
    for r in rejections:
        # quarantine_ref 가 있으면 공개 프로세스가 **원본 본문**을 격리 파일에 남겨 둔 것이다.
        # 우리가 정당한 알림을 잘못 거절했을 때 userId 를 되찾는 유일한 경로다(아래 열람 화면).
        ref = _row_value(r, "quarantine_ref")
        ref_cell = ("<a href='" + _PENDING_PREFIX + "/quarantine/" + _e(ref) + "'>"
                    + _e(ref) + "</a>") if ref else "<span style='color:#9aa3ad'>-</span>"
        rej.append(
            "<tr><td>" + _e(r["created_at"]) + "</td><td>" + _e(r["reason"]) + "</td>"
            "<td>" + _e(r["detail"]) + "</td><td>" + _e(r["source_ip"]) + "</td>"
            "<td>" + ref_cell + "</td></tr>")
    if not rej:
        rej.append("<tr><td colspan='5' style='color:#5b6470'>거절 기록이 없습니다.</td></tr>")

    banner = ""
    if msg:
        banner = "<div class='note'>" + _e(msg) + "</div>"

    return _html_page(
        "<h1>eBay 계정 삭제 요청</h1>"
        "<p class='sub'>공개 프로세스가 서명 검증을 통과한 알림만 여기에 쌓입니다. "
        "실제 인증키 삭제는 <b>이 화면에서 승인할 때만</b> 일어납니다. "
        "eBay 이행 기한은 수신일로부터 30일입니다. "
        "대기 " + _e(counts.get("pending")) + "건 · 누적 거절 " + _e(counts.get("rejections")) + "건 · "
        "큐 <code>" + _e(ebay_queue.DB_PATH) + "</code></p>"
        + banner +
        "<table><tr><th>#</th><th>eBay 사용자</th><th>topic</th><th>이벤트/수신 시각</th>"
        "<th>출처 IP</th><th>처리</th></tr>" + "".join(rows) + "</table>"
        "<h1 style='margin-top:28px'>처리 이력</h1>"
        "<table><tr><th>#</th><th>eBay 사용자</th><th>결과</th><th>처리 시각</th>"
        "<th>처리자</th><th>메모</th></tr>" + "".join(history) + "</table>"
        "<h1 style='margin-top:28px'>최근 거절 기록</h1>"
        "<p class='sub'>공개 프로세스가 버린 요청입니다. "
        "<code>public-key:</code> 나 <code>signature-mismatch</code> 가 쌓인다면 "
        "eBay 응답 형식이 구현 가정과 다른 것이므로 즉시 확인해야 합니다 — "
        "진짜 알림을 버리고 있다는 뜻일 수 있습니다. "
        "<b>격리</b> 열의 id 를 누르면 공개 프로세스가 보관한 <b>원본 본문</b>을 열어 "
        "userId 를 확인하고 수동으로 이행할 수 있습니다(보관 상한을 넘겨 회전된 건은 비어 있습니다).</p>"
        "<table><tr><th>시각</th><th>사유</th><th>상세</th><th>출처 IP</th><th>격리</th></tr>"
        + "".join(rej) + "</table>"
        "<p style='margin-top:24px'><a href='/'>← 대시보드</a></p>")


@app.post(_PENDING_PREFIX + "/{row_id}/approve")
def deletions_approve(request: Request, row_id: int, note: str = Form(""),
                      csrf_token: str = Form("")):
    """승인 — 실제 인증키 삭제를 수행하고 큐 항목을 fulfilled 로 닫는다."""
    user, redirect = _require_admin(request)
    if redirect:
        return redirect
    # 인증 → CSRF 순서다. 미인증자에게 토큰 유효성을 알려 주지 않기 위해서다(app.py 와 동일 규칙).
    # 이 경로는 **되돌릴 수 없는 인증키 삭제**라 CSRF 보호가 특히 중요하다: 관리자 브라우저가
    # 외부 페이지를 하나 여는 것만으로 위조 POST 가 돌면 그대로 삭제가 실행된다.
    denied = admin_app.require_csrf(request, csrf_token, back=_PENDING_PREFIX)
    if denied:
        return denied
    if not _queue_ready():
        return RedirectResponse(_PENDING_PREFIX + "?msg=큐 파일이 없습니다.", status_code=303)

    row = ebay_queue.get_pending(row_id)
    if not row or row["status"] != "pending":
        return RedirectResponse(_PENDING_PREFIX + "?msg=이미 처리되었거나 없는 항목입니다.", status_code=303)

    ip = admin_app._ip(request)
    result = _purge_records_for_user(row["user_id"], actor_id=user["id"],
                                     actor_name=user["username"], request_ip=ip)
    summary = (f"scanned={result['scanned']} matched={result['matched']} "
               f"removed={result['removed']} errors={result['errors']}")

    # 먼저 삭제하고 나중에 상태를 닫는다. 순서를 뒤집으면 삭제 도중 죽었을 때
    # '처리됨'으로 표시된 채 실제로는 안 지워진 항목이 남는다(그쪽이 훨씬 나쁘다).
    ebay_queue.resolve_pending(row_id, status="fulfilled", by=user["username"],
                               note=(note.strip() + " " + summary).strip())
    log.info("eBay 삭제 요청 #%s 승인 (user_id=%s, %s, 승인자=%s)",
             row_id, row["user_id"], summary, user["username"])
    return RedirectResponse(
        _PENDING_PREFIX + "?msg=✅ #" + str(row_id) + " 승인 완료 — " + summary
        + " (matched=0 은 '지울 것이 없었다'는 정상 결과입니다)",
        status_code=303)


@app.post(_PENDING_PREFIX + "/{row_id}/dismiss")
def deletions_dismiss(request: Request, row_id: int, note: str = Form(""),
                      csrf_token: str = Form("")):
    """기각 — 인증키를 지우지 않고 항목만 닫는다.

    지울 것이 없음이 명백하거나 위조로 판단할 때 쓴다. 기각도 감사 로그에 남긴다 —
    '아무 일도 하지 않았다'는 판단 역시 나중에 설명할 수 있어야 한다.
    """
    user, redirect = _require_admin(request)
    if redirect:
        return redirect
    # 기각도 큐 상태를 바꾸는 POST 다. 위조로 조용히 기각시키면 30일 기한을 그대로 놓친다.
    denied = admin_app.require_csrf(request, csrf_token, back=_PENDING_PREFIX)
    if denied:
        return denied
    if not _queue_ready():
        return RedirectResponse(_PENDING_PREFIX + "?msg=큐 파일이 없습니다.", status_code=303)

    row = ebay_queue.get_pending(row_id)
    if not row or row["status"] != "pending":
        return RedirectResponse(_PENDING_PREFIX + "?msg=이미 처리되었거나 없는 항목입니다.", status_code=303)

    ebay_queue.resolve_pending(row_id, status="dismissed", by=user["username"], note=note.strip())
    db.record_key_access(user["id"], f"{user['username']}(ebay-deletion-dismissed)",
                         "ebay", None, "dismiss", admin_app._ip(request))
    log.info("eBay 삭제 요청 #%s 기각 (user_id=%s, 처리자=%s)", row_id, row["user_id"], user["username"])
    return RedirectResponse(_PENDING_PREFIX + "?msg=#" + str(row_id) + " 기각했습니다.", status_code=303)


_REF_CHARS = set("0123456789abcdef")


@app.get(_PENDING_PREFIX + "/quarantine/{ref}", response_class=HTMLResponse)
def deletions_quarantine(request: Request, ref: str):
    """거절된 알림의 **원본 본문**을 연다 (관리자 전용, 읽기 전용).

    왜 필요한가
      공개 프로세스가 알림을 거절하면 사유만 표에 남고 본문은 격리 파일로 간다. eBay 는 2xx 를
      받은 알림을 다시 보내주지 않으므로, 우리가 **정당한 알림을 잘못 거절했을 때** 그 파일이
      userId 를 되찾을 마지막 사본이다. 화면에서 볼 수 없으면 사후 이행이 사실상 불가능하다.

    본문은 인터넷에서 들어온 임의 바이트다 — 절대 해석하지 않고 이스케이프해서 그대로 보여준다.
    """
    user, redirect = _require_admin(request)
    if redirect:
        return redirect

    # ref 는 uuid4().hex[:16] 이다. 경로 탐색이 될 자리는 없지만(파일명으로 쓰이지 않는다)
    # 형식을 먼저 좁혀 두면 이상한 값이 로그·화면에 실려 다니지 않는다.
    if not ref or len(ref) > 32 or not set(ref.lower()) <= _REF_CHARS:
        return _html_page("<h1>격리 본문</h1><div class='note'>잘못된 참조 id 입니다.</div>"
                          "<p><a href='" + _PENDING_PREFIX + "'>← 목록</a></p>")

    rec = None
    for verified in (True, False):    # 검증 통과분 파일을 먼저 본다(복구 가치가 높은 쪽)
        try:
            rec = ebay_queue.read_quarantined(ref, verified=verified)
        except Exception as e:        # noqa: BLE001 - 파일 장애가 화면을 죽이지 않게
            log.error("격리 본문 조회 실패(ref=%s): %s", ref, type(e).__name__)
            rec = None
        if rec:
            break

    if not rec:
        return _html_page(
            "<h1>격리 본문</h1><div class='note'>id <code>" + _e(ref) + "</code> 를 찾지 못했습니다. "
            "보관 상한(기본 검증분 4MB / 미검증분 1MB)을 넘겨 회전됐거나, "
            "내부 프로세스의 <code>EBAY_QUEUE_DIR</code> 이 공개 프로세스와 다를 수 있습니다 — "
            "현재 값: <code>" + _e(ebay_queue.QUARANTINE_LOG) + "</code></div>"
            "<p><a href='" + _PENDING_PREFIX + "'>← 목록</a></p>")

    body = rec.get("body") or b""
    text = body.decode("utf-8", "replace")
    log.info("격리 본문 열람 (ref=%s, reason=%s, 열람자=%s)", ref, rec.get("reason"), user["username"])
    return _html_page(
        "<h1>격리 본문 " + _e(ref) + "</h1>"
        "<p class='sub'>사유 <code>" + _e(rec.get("reason")) + "</code> · "
        "서명검증 " + ("통과" if rec.get("verified") else "<b>미통과(위조일 수 있음)</b>") + " · "
        "수신 " + _e(rec.get("at")) + " · 출처 IP " + _e(rec.get("sourceIp")) + " · "
        "원본 " + _e(rec.get("bodyBytes")) + "바이트"
        + (" (잘림)" if rec.get("truncated") else "") + "</p>"
        "<div class='note'>이 본문은 <b>검증되지 않은 인터넷 입력</b>일 수 있습니다. "
        "여기 적힌 userId 로 인증키를 지우기 전에, 정말 eBay 가 보낸 알림이었는지 "
        "(사유가 <code>public-key-*</code>·<code>token-unavailable</code> 처럼 '우리 쪽 장애'인지) "
        "먼저 판단하세요. 위조 본문을 그대로 이행하면 공격자가 삭제를 대신 시키는 셈이 됩니다.</div>"
        "<pre style='background:#fff;border:1px solid #eceef1;border-radius:8px;padding:12px;"
        "white-space:pre-wrap;word-break:break-all;font-size:12px'>" + _e(text) + "</pre>"
        "<p><a href='" + _PENDING_PREFIX + "'>← 목록</a></p>")


# ══════════════════════════════════════════════════════════════
#  4. 기동 로그
# ══════════════════════════════════════════════════════════════
def _route_table(target: FastAPI) -> list[str]:
    """등록된 경로를 '메서드 경로' 목록으로.

    최신 FastAPI(0.14x)는 include_router 한 라우터를 _IncludedRouter 래퍼로 감싸므로
    (래퍼에는 path 가 없다) 재귀로 펼친다. serve_public.py 에 같은 함수가 있다 —
    두 진입점은 서로를 import 하지 않는 것이 분리의 전제라 의도적으로 중복시켰다.
    """
    rows: list[str] = []

    def walk(routes, prefix: str, depth: int) -> None:
        if depth > 6:
            return
        for route in routes or ():
            path = getattr(route, "path", None)
            methods = getattr(route, "methods", None)
            if path and methods:
                for method in sorted(m for m in methods if m not in ("HEAD", "OPTIONS")):
                    rows.append(f"{method:6s} {prefix}{path}")
                continue
            inner = (getattr(route, "original_router", None)
                     or getattr(route, "included_router", None)
                     or route)
            ctx = getattr(route, "include_context", None)
            sub_prefix = prefix + (getattr(ctx, "prefix", "") or getattr(route, "prefix", "")
                                   or path or "")
            sub_routes = getattr(inner, "routes", None)
            if sub_routes:
                walk(sub_routes, sub_prefix, depth + 1)

    walk(target.routes, "", 0)
    return sorted(set(rows))


@app.on_event("startup")
async def _announce() -> None:
    log.info("─" * 62)
    log.info("VERY UP 내부 프로세스 기동 (mode=%s)", config.env_name())
    log.info("⚠ 이 프로세스는 **인터넷에서 도달 불가**해야 합니다 —")
    log.info("   uvicorn --host 를 WireGuard IP 로 두고, AWS 보안그룹에서 이 포트를 막고,")
    log.info("   nginx 공개 서버 블록이 이 포트로 프록시하지 않는지 확인하세요.")
    log.info("서빙 경로:")
    for row in _route_table(app):
        log.info("    %s", row)
    log.info("─" * 62)
    log.info("admin.db            : %s", db.DB_PATH)
    log.info("마스터 키 카나리아  : %s", _CANARY_STATUS)
    # 회전 모드는 '기동 거부를 경고로 낮춘 상태'다. 요약에서 눈에 띄지 않으면 지우는 것을 잊는다.
    if _KEY_ROTATION:
        log.warning("═" * 62)
        log.warning("🔑 KEY_MASTER 회전 모드 (VERYUP_KEY_ROTATION=1) — 카나리아 실패가 기동을 막지 않습니다.")
        log.warning("   이 변수가 여는 것은 그것 하나뿐입니다(비밀값 파일 폴백·자동 생성은 그대로 꺼져 있습니다).")
        log.warning("   순서: /keys 에서 옛 행 삭제 → 새 자격증명 재입력 →")
        log.warning("        **VERYUP_KEY_ROTATION 제거 후 재기동** → 카나리아 '통과' 확인.")
        log.warning("   제거하지 않으면 다음 사고(KEY_MASTER 오타·롤백)가 조용히 통과합니다.")
        log.warning("═" * 62)
    _failed = (config.canary_report().get("failed") or [])
    if _failed:
        log.warning("복호화 불가 인증키    : %d건 — /keys 에서 삭제 후 재입력하세요", len(_failed))
        for _f in _failed:
            log.warning("    ↳ #%s %s / %s (%s)", _f["id"], _f["platform"], _f["label"], _f["error"])
    log.info("eBay 큐 디렉터리    : %s",
             ebay_queue.QUEUE_DIR or "❌ EBAY_QUEUE_DIR 미설정 → 소스 디렉터리 사용(공개 프로세스와 같은 값이어야 한다)")
    log.info("eBay 큐(읽기 전용 소유권: 공개 프로세스) : %s%s",
             ebay_queue.DB_PATH, "" if _queue_ready() else "  ❌ 파일 없음")
    log.info("/updates            : %s",
             "활성" if os.environ.get("UPDATE_TOKEN") else "❌ UPDATE_TOKEN 미설정 → 라우트 미등록(404)")
    log.info("세션 Secure 쿠키    : %s", admin_app.SESSION_HTTPS_ONLY)
    log.info("신뢰 프록시(FORWARDED_ALLOW_IPS) : %s",
             os.environ.get("FORWARDED_ALLOW_IPS")
             or "미설정 (uvicorn 기본 127.0.0.1 — WireGuard 직결이면 --proxy-headers 도 쓰지 마세요)")
    _stale = _stale_admin_cache.get("names") or []
    log.info("비밀번호 미확인 관리자 : %s",
             "없음" if not _stale else ("⚠ %d개 — %s" % (len(_stale), ", ".join(_stale))))
    log.info("─" * 62)


if __name__ == "__main__":
    # 개발 편의용 직접 실행. 운영은 systemd + uvicorn 을 쓴다(배포_분리_가이드.md).
    import uvicorn

    _host = (os.environ.get("INTERNAL_HOST") or "127.0.0.1").strip()
    if _host in ("0.0.0.0", "::", ""):
        # 이 프로세스에는 인증키 복호화 키와 관리자 로그인이 모두 들어 있다.
        # 전 인터페이스 바인드는 분리의 전제를 그 자리에서 무효화한다.
        raise InternalStartupError(
            f"INTERNAL_HOST={_host!r} 로는 띄우지 않습니다. "
            "내부 프로세스는 WireGuard IP(예: 10.8.0.1) 또는 127.0.0.1 에만 바인드하세요."
        )
    # 신뢰 프록시 목록. 와일드카드는 import 시점에 이미 거부됐지만, 값이 여기까지 오는 경로가
    # 하나 더 있으므로(직접 실행) 한 번 더 통과시킨다 — 검사는 싸고, 빠뜨리면 감사 추적이 썩는다.
    _forwarded = _check_forwarded_allow_ips(
        os.environ.get("FORWARDED_ALLOW_IPS") or "", source="환경변수 FORWARDED_ALLOW_IPS")
    # 앞에 프록시가 없으면(WireGuard 직결) X-Forwarded-For 를 **아예 해석하지 않는다.**
    # 예전에는 무조건 proxy_headers=True 였는데, 그 구성에서는 클라이언트가 지어낸 헤더를
    # 신뢰 목록만 통과하면 그대로 믿게 된다. 프록시를 쓰겠다고 적은 경우에만 켠다.
    _proxy_headers = bool(_forwarded)
    if not _proxy_headers:
        log.info("FORWARDED_ALLOW_IPS 미설정 → --proxy-headers 없이 띄웁니다"
                 "(클라이언트 주소 = 실제 피어 주소). nginx 를 앞에 둔다면 그 주소를 넣으세요.")
    uvicorn.run(
        app,
        host=_host,
        port=int(os.environ.get("INTERNAL_PORT") or 8001),
        proxy_headers=_proxy_headers,
        forwarded_allow_ips=_forwarded or "127.0.0.1",
    )
