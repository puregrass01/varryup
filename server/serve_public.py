"""
VERY UP **공개 프로세스** 진입점 — 인터넷에 직접 열리는 유일한 표면.

실행:
    uvicorn serve_public:app --host 127.0.0.1 --port 8080 --proxy-headers --forwarded-allow-ips <nginx IP>

이 프로세스가 가지는 것 / 가지지 않는 것 (보안감사_2026-09-16.md 3절 (b) 확정 아키텍처)
  가진다     : /privacy, /privacy/en, /ebay/deletion(GET 검증 + POST 수신), /ebay/auth/accepted|declined
               자체 소형 저장소(ebay_queue.db — 수신 큐 + 거절 기록)
  가지지 않는다: admin.db 접근, KEY_MASTER, ADMIN_SECRET, 세션, 로그인, 프록시 릴레이, /updates

왜 이렇게 나누는가
  기존 단일 프로세스는 "인터넷에서 그 포트에 닿을 수 있다"는 한 가지 전제 위에
  /login 무차별 대입, staff 토큰 전량 덤프, 세션 탈취, 프록시 릴레이 남용이 모두 얹혀 있었다.
  분리의 요점은 그 결함들을 하나씩 고치는 것이 아니라 **인터넷에서 도달할 수 없게 만드는 것**이다.
  그래서 이 파일의 가장 중요한 코드는 라우터 등록이 아니라 아래의 '자가 점검'이다 —
  실수로 내부 모듈이나 마스터 키가 이 프로세스에 딸려 들어오면 분리는 그 순간 무의미해진다.

큐 연결 방향 (뒤집히면 분리가 무의미해진다)
  내부 → 공개 **읽기**. 내부 프로세스가 ebay_queue.db 를 직접 읽어 관리자가 승인한다.
  **공개 → 내부 인바운드 구멍은 하나도 만들지 않는다.** 이 파일은 내부 주소를 알지도 못한다.

기동 순서(배포_분리_가이드.md 참고)
  공개 프로세스를 **먼저** 올려 eBay 엔드포인트 검증을 통과시킨 뒤 내부 프로세스를 올린다.
  eBay 심사는 공개 표면만 필요로 하므로 내부 수정이 끝나기를 기다릴 이유가 없다.

환경변수는 배포_분리_가이드.md 의 표를 보라. 이 프로세스에 **있으면 안 되는** 값:
  KEY_MASTER, ADMIN_SECRET, BOOTSTRAP_ADMIN_USER/PW, UPDATE_TOKEN, STAFF_PLATFORMS
이 프로세스에 **있어야 하는** 비밀값은 EBAY_CLIENT_ID/EBAY_CLIENT_SECRET 둘뿐이다(서명 검증용).

자가 점검은 기본이 **기동 거부**(PUBLIC_STRICT 미설정 = STRICT on)다.
개발 중 경고로 낮추려면 PUBLIC_STRICT=0 을 명시하라. 쓰기가 필요한 큐·영수증 디렉터리는
EBAY_QUEUE_DIR 로 admin.db 바깥에 둔다.
"""
import logging
import logging.handlers
import os
import sys
from contextlib import asynccontextmanager

# ══════════════════════════════════════════════════════════════
#  0. 로깅 — 다른 무엇보다 먼저 (감사 §23·§29)
# ══════════════════════════════════════════════════════════════
# 이 프로젝트의 모듈들은 logging.getLogger("veryup.*") 로만 기록하고 핸들러를 달지 않는다.
# 루트에 핸들러가 없으면 uvicorn 기본 설정에서 그 로그는 **아무 데도 출력되지 않는다**.
# 무인증 경로의 거절·레이트리밋 기록이 안 보이면 공격을 받고 있다는 사실 자체를 모르게 된다.
LOG_LEVEL = (os.environ.get("LOG_LEVEL") or "INFO").upper()
LOG_FILE = (os.environ.get("LOG_FILE") or "").strip()


def _setup_logging() -> None:
    root = logging.getLogger()
    root.setLevel(LOG_LEVEL)
    fmt = logging.Formatter("%(asctime)s %(levelname)s [%(name)s] %(message)s")
    if not any(isinstance(h, logging.StreamHandler) for h in root.handlers):
        stream = logging.StreamHandler(sys.stderr)   # systemd journal 로 흘러간다
        stream.setFormatter(fmt)
        root.addHandler(stream)
    if LOG_FILE:
        # 회전 파일. 상한을 두지 않으면 무인증 경로가 디스크를 채울 수 있다.
        handler = logging.handlers.RotatingFileHandler(
            LOG_FILE, maxBytes=10 * 1024 * 1024, backupCount=3, encoding="utf-8")
        handler.setFormatter(fmt)
        root.addHandler(handler)


_setup_logging()
log = logging.getLogger("veryup.serve_public")

# STRICT 는 **기본 on** 이다(PUBLIC_STRICT 미설정 = 켜짐).
# 왜 기본값을 뒤집었나: 이전에는 기본 off 라서 '키가 실제로 이 프로세스에 주입돼 있다',
# '공개 프로세스가 admin.db 에 손댈 수 있다' 같은 **가장 직접적인 사고**가 경고 한 줄로 끝나고
# 서버는 멀쩡히 떴다. 경고는 journal 에 묻히고, 분리는 서류상으로만 남는다.
# 기동 실패는 배포하는 사람이 반드시 본다 — 그래서 안전한 쪽을 기본값으로 둔다.
# 개발 편의로 끄려면 PUBLIC_STRICT=0 을 **명시**하라(명시적 선택으로 만드는 것이 요점이다).
_STRICT_RAW = (os.environ.get("PUBLIC_STRICT") or "").strip().lower()
STRICT = _STRICT_RAW not in ("0", "false", "no", "off")
if not STRICT:
    log.warning(
        "⚠ PUBLIC_STRICT=%s — 공개 표면 자가 점검이 '경고만' 모드입니다. "
        "개발 환경에서만 쓰세요. 운영에서는 이 변수를 지우면 기본값(거부)으로 돌아옵니다.",
        _STRICT_RAW or "(빈 값)",
    )


class PublicSurfaceError(RuntimeError):
    """공개 프로세스에 있어서는 안 될 것이 발견됐을 때 기동을 거부한다."""


def _problem(message: str) -> None:
    """STRICT(기본 on)면 기동 거부, 명시적으로 껐으면 경고. 어느 쪽이든 반드시 기록은 남는다."""
    if STRICT:
        raise PublicSurfaceError(message)
    log.warning("⚠ %s  (PUBLIC_STRICT=0 이라 경고로 낮췄습니다 — 기본값이면 기동 거부입니다)", message)


# ══════════════════════════════════════════════════════════════
#  1. 비밀값 누출 점검 — import 보다 먼저
# ══════════════════════════════════════════════════════════════
# 공개 프로세스에 이 값들이 주입돼 있다는 것은 systemd EnvironmentFile 을 두 유닛이
# 공유하고 있다는 뜻이고, 그러면 '공개 쪽에는 키가 없다'는 분리의 전제가 통째로 무너진다.
# 값 자체는 절대 로그에 찍지 않는다(찍는 순간 journal 이 키 저장소가 된다).
_FORBIDDEN_ENV = (
    ("KEY_MASTER", "인증키 복호화 마스터 키"),
    ("ADMIN_SECRET", "세션·API 토큰 서명키"),
    ("BOOTSTRAP_ADMIN_USER", "관리자 부트스트랩 계정명"),
    ("BOOTSTRAP_ADMIN_PW", "관리자 부트스트랩 비밀번호"),
    ("UPDATE_TOKEN", "내부 업데이트 배포 토큰"),
    ("STAFF_PLATFORMS", "내부 RBAC 설정"),
)

for _name, _what in _FORBIDDEN_ENV:
    if (os.environ.get(_name) or "").strip():
        _problem(
            f"공개 프로세스에 {_name}({_what}) 환경변수가 주입돼 있습니다. "
            f"이 프로세스는 그 값을 쓰지 않으며, 있다는 것 자체가 배포 실수입니다 — "
            f"공개/내부 유닛의 EnvironmentFile 을 분리하세요."
        )

# admin.db 를 **읽을 수 있는지**도 본다. 코드가 읽지 않더라도, 읽을 수 있는 권한으로
# 인터넷에 열린 프로세스를 돌리면 이 프로세스의 임의 코드 실행 취약점 하나가
# 곧 인증키 DB 유출이 된다. 운영에서는 별도 OS 계정으로 띄워 권한 자체를 없애라.
_ADMIN_DB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "admin.db")
_ADMIN_DB_DIR = os.path.dirname(_ADMIN_DB)
if os.path.exists(_ADMIN_DB) and os.access(_ADMIN_DB, os.R_OK):
    _problem(
        f"공개 프로세스가 admin.db 를 읽을 수 있습니다 ({_ADMIN_DB}). "
        "별도 OS 계정(예: veryup-public)으로 띄우고 admin.db 의 권한을 내부 계정 전용(0600)으로 두세요."
    )

# 파일 권한만 보면 admin.db 를 못 지킨다. **디렉터리 쓰기 권한**이 있으면 파일을 읽지 못해도
# unlink/rename 으로 지우거나 가짜 DB 로 갈아치울 수 있다(POSIX 에서 삭제 권한은 파일이 아니라
# 그 파일이 든 디렉터리의 권한이다). 읽기 차단보다 이쪽이 더 조용한 사고다 —
# 관리자는 "인증키가 사라졌다"를 디스크 오류로 오해하게 된다.
# (admin.db 가 애초에 이 디렉터리에 없으면 지울 대상도 없으므로 점검하지 않는다.)
_ADMIN_DB_PRESENT = os.path.exists(_ADMIN_DB)
if _ADMIN_DB_PRESENT and os.access(_ADMIN_DB_DIR, os.W_OK):
    _problem(
        f"공개 프로세스가 admin.db 가 든 디렉터리에 쓸 수 있습니다 ({_ADMIN_DB_DIR}). "
        "읽지 못해도 admin.db 를 지우거나 갈아치울 수 있습니다. "
        "코드 디렉터리는 공개 계정에 대해 읽기 전용(예: root:veryup 0750)으로 두고, "
        "쓰기가 필요한 큐·영수증은 EBAY_QUEUE_DIR 로 다른 디렉터리에 두세요."
    )

# ══════════════════════════════════════════════════════════════
#  2. 라우터 import
# ══════════════════════════════════════════════════════════════
# ⚠ 여기서 import 해도 되는 것은 아래 둘뿐이다. app / db / crypto / proxy 는 절대 금지.
#   - public        : /privacy, /privacy/en, /ebay/auth/*  (COMPANY_NAME 등 미설정 시 import 에서 기동 거부)
#   - ebay_notify   : /ebay/deletion GET+POST              (EBAY_DELETION_ENDPOINT 미설정 시 import 에서 기동 거부)
#     ebay_notify 는 db/crypto 를 모듈 최상단에서 import 하지 않는다(함수 안 지연 import).
#     그래서 이 프로세스에는 Fernet 키도, admin.db 커넥션도 존재하지 않는다 — 아래 3번에서 실제로 확인한다.
import ebay_notify  # noqa: E402  (위의 비밀값 점검이 import 보다 먼저 돌아야 한다)
import public       # noqa: E402

from fastapi import FastAPI  # noqa: E402

# ══════════════════════════════════════════════════════════════
#  3. 모듈 격리 점검 — "코드상 admin.db 에 도달할 수 없다"를 실제로 확인
# ══════════════════════════════════════════════════════════════
# 주석으로 "import 하지 않는다"고 적어두는 것만으로는 다음 사람이 한 줄 추가하는 것을 막지 못한다.
# 기동 시점에 sys.modules 를 직접 보고, 들어와 있으면 **무조건** 기동을 거부한다(STRICT 무관).
# 이것은 경고로 낮출 수 있는 종류의 문제가 아니다.
_FORBIDDEN_MODULES = {
    "app": "내부 관리자 앱(세션·로그인·인증키 화면)",
    "db": "admin.db 접근 계층",
    "crypto": "Fernet 복호화",
    "config": "ADMIN_SECRET/KEY_MASTER 공급",
    "proxy": "마켓플레이스 프록시 릴레이",
}
_leaked = [f"{m}({why})" for m, why in _FORBIDDEN_MODULES.items() if m in sys.modules]
if _leaked:
    raise PublicSurfaceError(
        "공개 프로세스에 내부 전용 모듈이 로드됐습니다: " + ", ".join(_leaked) + ". "
        "이 프로세스는 admin.db 와 마스터 키에 도달할 수 없어야 합니다 — import 를 제거하세요."
    )

# ══════════════════════════════════════════════════════════════
#  3-b. 큐 저장소 위치 점검 — 쓰기 권한이 admin.db 옆에 있으면 안 된다
# ══════════════════════════════════════════════════════════════
# 이 프로세스가 유일하게 **쓰는** 곳은 eBay 수신 큐와 영수증이다. 그 디렉터리가 admin.db 와
# 같으면, 큐를 쓰기 위해 준 권한이 그대로 admin.db 를 지울 권한이 된다(위 디렉터리 점검과 같은 이유).
# 큐 저장소는 EBAY_QUEUE_DIR 로 admin.db 바깥의 전용 디렉터리를 지정하라.
def _same_dir(a: str, b: str) -> bool:
    """심링크·대소문자·상대경로 차이를 흡수해 같은 디렉터리인지 본다."""
    try:
        return os.path.normcase(os.path.realpath(a)) == os.path.normcase(os.path.realpath(b))
    except OSError:
        return False


_QUEUE_DIR_ENV = (os.environ.get("EBAY_QUEUE_DIR") or "").strip()
_queue_dirs = {os.path.dirname(os.path.abspath(p))
               for p in (getattr(ebay_notify.ebay_queue, "DB_PATH", ""),
                         getattr(ebay_notify.ebay_queue, "RECEIPT_LOG", ""))
               if p}
if _QUEUE_DIR_ENV:
    _queue_dirs.add(os.path.abspath(_QUEUE_DIR_ENV))

for _qdir in sorted(_queue_dirs):
    if _ADMIN_DB_PRESENT and _same_dir(_qdir, _ADMIN_DB_DIR):
        _problem(
            f"eBay 큐/영수증 저장소가 admin.db 와 같은 디렉터리입니다 ({_qdir}). "
            "이 디렉터리에는 공개 프로세스의 쓰기 권한이 필요하고, 그 권한은 곧 admin.db 를 "
            "지우거나 갈아치울 권한입니다. EBAY_QUEUE_DIR 로 전용 디렉터리를 지정하세요 "
            "(예: /var/lib/veryup-public, 소유자 veryup-public 0700)."
        )

# ══════════════════════════════════════════════════════════════
#  3-c. 자격증명 점검 — "정상 가동 중인 귀머거리"를 만들지 않는다
# ══════════════════════════════════════════════════════════════
# EBAY_CLIENT_ID/SECRET 이 없으면 서명 검증이 불가능해 **모든** 삭제 알림이 거절된다.
# 그런데 밖에서 보이는 응답 코드는 정상이라, eBay 포털은 엔드포인트가 건강하다고 표시하고
# 관리자는 빈 큐를 "요청이 없었다"로 읽는다. 30일 뒤 미처리로 규정 위반이 드러난다.
# 조용히 도는 것보다 크게 실패하는 편이 낫다 — GET 이 토큰 없을 때 503 으로 실패하는 것과 같은 논리다.
if not ebay_notify._HAS_EBAY_CREDS:
    _problem(
        "EBAY_CLIENT_ID / EBAY_CLIENT_SECRET 이 없어 eBay 알림 서명을 검증할 수 없습니다. "
        "이 상태로 뜨면 모든 삭제 알림이 거절되는데 eBay 포털에는 정상으로 보입니다 "
        "(빈 큐 = '요청 없음'으로 오해 → 30일 뒤 미처리 위반). 두 값을 설정한 뒤 기동하세요."
    )

# ══════════════════════════════════════════════════════════════
#  4. 앱 구성
# ══════════════════════════════════════════════════════════════
@asynccontextmanager
async def _lifespan(_app: FastAPI):
    """무엇이 인터넷에 열렸는지 기동 로그에 **명시적으로** 남긴다.

    배포 사고의 상당수는 '내가 뭘 열었는지 몰랐다'에서 온다.
    여기서 출력된 목록 밖의 경로가 인터넷에서 응답한다면 그것은 nginx 설정 문제다.
    """
    log.info("─" * 62)
    log.info("VERY UP 공개 프로세스 기동 — 인터넷에 노출되는 경로는 다음이 전부입니다:")
    for row in _route_table(_app):
        log.info("    %s", row)
    log.info("─" * 62)
    log.info("eBay 삭제 알림 경로   : %s", ebay_notify._PATH)
    log.info("eBay 수신 큐 파일     : %s", ebay_notify.ebay_queue.DB_PATH)
    log.info("eBay 영수증 파일      : %s", ebay_notify.ebay_queue.RECEIPT_LOG)
    log.info("서명 검증 자격증명    : %s",
             "설정됨" if ebay_notify._HAS_EBAY_CREDS else "❌ 없음 — 모든 알림이 거절 기록만 남습니다")
    log.info("GET 검증 토큰         : %s",
             "설정됨" if ebay_notify.VERIFICATION_TOKEN else "❌ 없음 — eBay 엔드포인트 검증이 503 으로 실패합니다")
    # "이 서버엔 비밀값이 없다"고 단언하면 다음 사람이 오해한다 — 이 프로세스는
    # EBAY_CLIENT_ID/SECRET 을 실제로 보유한다(서명 검증에 필요). 없는 것과 있는 것을 나눠 적는다.
    log.info("admin.db / KEY_MASTER / ADMIN_SECRET / 세션 : 없음 (설계대로)")
    log.info("이 프로세스에 있어도 되는 유일한 비밀값 : EBAY_CLIENT_ID / EBAY_CLIENT_SECRET "
             "(eBay 서명 검증 전용, 유출 시 eBay 앱 자격증명 재발급 대상)")
    log.info("자가 점검 모드          : %s", "STRICT(기동 거부)" if STRICT else "⚠ 경고만 (PUBLIC_STRICT=0)")
    log.info("─" * 62)
    yield


# docs/redoc/openapi 를 끈다. 인터넷에 열린 표면에 내부 구조를 설명하는 페이지를 둘 이유가 없다.
app = FastAPI(
    title="VERY UP 공개 서비스",
    description="개인정보처리방침 · eBay 계정 삭제 알림 수신 전용",
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
    lifespan=_lifespan,
)

# ⚠ SessionMiddleware 를 달지 않는다. 이 프로세스에는 세션도 로그인도 없고 서명키도 없다.
#   (달려면 ADMIN_SECRET 이 필요한데, 그 값이 여기 있으면 안 된다는 것이 1번 점검의 내용이다.)
# ⚠ db.init_db() 를 호출하지 않는다. 이 프로세스는 admin.db 를 열지 않는다.
#   유일한 상태는 ebay_notify 가 import 시점에 준비하는 ebay_queue.db 다.

app.include_router(public.public_router)   # /privacy, /privacy/en, /ebay/auth/accepted|declined
app.include_router(ebay_notify.router)     # GET+POST {EBAY_DELETION_ENDPOINT 의 경로}

# ⚠ public.router(공개+내부 합본)를 쓰지 마라 — /updates 가 인터넷에 딸려 나간다.
# ⚠ public.internal_router / proxy.router 는 내부 프로세스 전용이다.


def _route_table(target: FastAPI) -> list[str]:
    """등록된 경로를 '메서드 경로' 문자열 목록으로.

    최신 FastAPI(0.14x)는 include_router 한 라우터를 _IncludedRouter 래퍼로 감싸 넣는다.
    그 래퍼에는 path 가 없고 안쪽에 원본 라우터가 들어 있으므로 재귀로 펼쳐야 한다.
    (버전에 따라 속성 이름이 다를 수 있어 getattr 로만 접근하고, 못 펼치면 조용히 건너뛴다 —
     경로 목록을 못 뽑는다고 서버가 뜨지 않으면 안 된다.)
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


if __name__ == "__main__":
    # 개발 편의용 직접 실행. 운영은 systemd + uvicorn 을 쓴다(배포_분리_가이드.md).
    # 기본 바인드가 127.0.0.1 인 이유: 앞단 nginx 가 TLS 를 끝내고 이 포트로 넘긴다.
    # 0.0.0.0 으로 직접 열면 평문 http 가 인터넷에 그대로 노출된다.
    import uvicorn

    uvicorn.run(
        app,
        host=os.environ.get("PUBLIC_HOST") or "127.0.0.1",
        port=int(os.environ.get("PUBLIC_PORT") or 8080),
        proxy_headers=True,
        forwarded_allow_ips=os.environ.get("FORWARDED_ALLOW_IPS") or "127.0.0.1",
    )
