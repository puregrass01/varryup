"""
서버 비밀값 공급 모듈 — 서명키(ADMIN_SECRET)와 암호화키(KEY_MASTER)를 **완전히 분리**한다.

왜 분리하는가 (보안감사_2026-09-16.md 3·5·8·15·17번 항목):
  기존 구조는 crypto.app_secret() 이 Fernet 마스터 키를 그대로 문자열로 반환하고,
  app.py 가 그 값을 세션 쿠키 서명키와 API 베어러 토큰 서명키로 재사용했다.
  즉 secret.key 파일 하나를 얻은 사람이
    (a) admin.db 의 인증키 전량을 오프라인 복호화하고,
    (b) 같은 값으로 {"uid":1} 관리자 토큰·세션 쿠키를 위조할 수 있었다.
  반대로 "세션키만 돌리자"고 키를 교체하면 저장된 암호문이 전부 복호화 불능이 되어,
  사고 대응(키 회전) 자체가 막혀 있었다. 두 값은 용도도 수명도 다르므로 분리한다.
    - ADMIN_SECRET : 서명 전용. 언제든 교체 가능(교체하면 기존 세션·토큰만 끊긴다).
    - KEY_MASTER   : Fernet 암호화 전용. 교체하면 기존 암호문을 못 읽는다 → 재입력 필요.

운영/개발 구분:
  환경변수 VERYUP_ENV 가 "production"(대소문자 무시) 이면 운영 모드.
  운영 모드에서는 **조용한 폴백이 전부 꺼진다** — 두 값이 환경변수로 오지 않으면 기동을 거부한다.
  개발 모드에서만 파일 폴백/자동 생성이 남는다(로컬에서 매번 키를 넣는 불편 제거).

운영자 주의(마이그레이션):
  * 기존 server/secret.key 로 암호화된 데이터를 계속 읽으려면
    **그 파일의 내용을 그대로 KEY_MASTER 환경변수에 넣어라.** 새 키를 만들면 기존 암호문은 영구 복호화 불가다.
  * 이미 노출된 키를 회전할 때는 반드시
    ① 마켓플레이스 쪽 자격증명 재발급 → ② **VERYUP_KEY_ROTATION=1 과 함께** 새 KEY_MASTER 로 기동
    → ③ /keys 에서 옛 행 삭제 + 새 값 재입력 → ④ VERYUP_KEY_ROTATION 제거 후 재기동 순서로.
    순서를 뒤집으면 기존 암호문을 읽지 못한 채 원본도 잃는다.
    ②에 VERYUP_KEY_ROTATION 이 필요한 이유는 아래 key_rotation_mode() 주석에 적었다 —
    그 변수가 없으면 카나리아가 기동을 막아 ③ 화면에 도달할 방법이 없다(회전 자체가 불가능해진다).
  * ADMIN_SECRET 은 KEY_MASTER 와 **다른 난수**여야 한다(같으면 분리한 의미가 없어 기동 거부).
    이 검사와 최소 길이 검사는 **모드와 무관하게** 적용된다(개발 모드에서도 거부한다).
    생성: python -c "import secrets; print(secrets.token_urlsafe(32))"
  * KEY_MASTER 는 형식만 맞으면 기동에 성공하지만, **다른 키**를 넣으면 저장된 인증키를 못 읽는다.
    내부 프로세스는 기동 시 verify_master_key_canary() 로 실제 복호화를 1건 시도해 조기에 잡는다.
"""
import logging
import os

log = logging.getLogger("veryup.config")

BASE_DIR = os.path.dirname(__file__)

# 개발 모드 전용 파일들. 운영 모드에서는 읽지도 쓰지도 않는다.
KEY_FILE = os.path.join(BASE_DIR, "secret.key")              # Fernet 마스터 키(기존 파일, 하위 호환)
DEV_SIGNING_KEY_FILE = os.path.join(BASE_DIR, "dev_admin_secret.key")  # 개발용 서명키(신규, secret.key 와 별개)

# ADMIN_SECRET 에 요구하는 최소 길이(운영·개발 공통).
# secrets.token_urlsafe(32) == 43자 이므로 32자면 실수로 짧은 값을 넣는 것만 걸러낸다.
MIN_ADMIN_SECRET_LEN = 32


def env_name() -> str:
    """현재 실행 모드 문자열. 기본값은 development (명시해야 운영)."""
    return (os.environ.get("VERYUP_ENV") or "development").strip().lower()


def is_production() -> bool:
    """운영 모드 여부. VERYUP_ENV=production 일 때만 True."""
    return env_name() == "production"


# KEY_MASTER 회전 전용 탈출구. 다른 어떤 폴백도 열지 않는다.
KEY_ROTATION_ENV = "VERYUP_KEY_ROTATION"


def key_rotation_mode() -> bool:
    """KEY_MASTER 회전 작업 중인가 (VERYUP_KEY_ROTATION=1).

    왜 이 변수가 따로 필요한가 (없으면 회전이 **구조적으로 불가능**했다):
      회전 절차는 ① 마켓플레이스 자격증명 재발급 → ② 새 KEY_MASTER 로 기동 →
      ③ /keys 에서 재입력 이다. 그런데 ②의 시점에 admin.db 에는 아직 **옛 키로 암호화된 행**이
      남아 있다. 그래서 verify_master_key_canary() 가 실패하고 내부 프로세스가 기동을 거부했다 —
      즉 ③의 재입력 화면 자체가 뜨지 않아 ②에서 영원히 막혔다.
      게다가 그때 뜨던 오류 메시지는 "새 KEY_MASTER 로 기동 → /keys 에서 재입력하라"고,
      방금 자기가 막은 단계를 안내하는 순환이었다. 유일한 탈출구였던 VERYUP_ALLOW_DEV_SECRETS 는
      "운영에 절대 넣지 마라"로 못박은 변수다 — 사고 대응 중에 그것을 켜게 만드는 설계가 잘못이다.

    VERYUP_ALLOW_DEV_SECRETS 와 **겸용하지 않는다.**
      그 변수는 ADMIN_SECRET/KEY_MASTER 부재 시 파일 폴백·자동 생성까지 통째로 여는 열쇠라
      회전 작업의 대가로 치르기에는 너무 크다. 이 변수가 여는 것은 **딱 하나** —
      "저장된 암호문을 하나도 복호화하지 못했다"는 카나리아 실패를 기동 거부에서
      ERROR 로그 + 기동 요약 경고로 낮추는 것뿐이다.
      두 비밀값의 존재·길이·동일값 검사는 회전 중에도 그대로 살아 있다.

    ⚠ 회전이 끝나면 **반드시 제거**한다. 남겨 두면 "KEY_MASTER 를 잘못 넣었다"는 사고가
      조용히 통과해, /api/credentials 가 data:null 을 돌려주는 상태로 운영에 남는다.
    """
    return (os.environ.get(KEY_ROTATION_ENV) or "").strip().lower() in ("1", "true", "yes", "on")


class SecretConfigError(RuntimeError):
    """비밀값이 운영 요건을 만족하지 못해 기동을 거부할 때 던진다."""


# ---------------------------------------------------------------- 서명키(ADMIN_SECRET)

_admin_secret_cache: str = ""


def _master_key_candidates() -> list:
    """
    "서명키가 암호화키와 같은 값인가" 를 판정할 때 비교 대상이 되는 문자열들.

    왜 환경변수 하나만 보지 않는가:
      개발 모드에서는 KEY_MASTER 가 비어 있어도 server/secret.key 파일이 암호화 키로 쓰인다.
      운영자가 그 파일 내용을 ADMIN_SECRET 에만 붙여넣으면 환경변수 비교만으로는 잡히지 않는데,
      결과는 동일하다 — 파일 하나로 인증키 전량 복호화 + 관리자 토큰 위조.
    부작용 금지: 여기서는 **읽기만** 한다. master_key() 를 호출하면 개발 모드에서
    키 파일을 새로 만들어 버리므로(자동 생성 폴백) 절대 부르지 않는다.
    """
    candidates = []
    env_km = (os.environ.get("KEY_MASTER") or "").strip()
    if env_km:
        candidates.append(env_km)
    try:
        if os.path.exists(KEY_FILE):
            with open(KEY_FILE, "rb") as f:
                saved = f.read().strip()
            if saved:
                candidates.append(saved.decode("utf-8", "ignore"))
    except OSError:
        # 파일을 못 읽는 것 자체는 여기서 다룰 문제가 아니다(master_key() 가 제 자리에서 실패시킨다).
        pass
    return candidates


def _validate_admin_secret(value: str, source: str) -> None:
    """
    ADMIN_SECRET 후보값 검사 — 너무 짧거나 암호화 키와 같은 값이면 SecretConfigError.

    왜 모드와 무관하게 적용하는가:
      예전에는 이 두 검사가 is_production() 블록 **안에만** 있었다. 그런데 serve_internal.py 는
      VERYUP_ENV 미설정을 경고 한 줄로 넘기고 기동을 계속시킨다. 그래서 운영자가 두 변수에
      secret.key 내용을 똑같이 붙여넣고 VERYUP_ENV 를 빠뜨리면,
      키 분리 이전 상태(키 파일 하나 = 인증키 전량 복호화 + 관리자 토큰 위조)가
      경고 한 줄과 함께 그대로 복원됐다 — 실제로 dev 에서 admin_secret() == master_key() 가 됐다.
      개발 편의는 아래 자동 생성 폴백이 이미 담당하므로 이 검사를 항상 켜도 잃는 것이 없다.
    """
    if len(value) < MIN_ADMIN_SECRET_LEN:
        raise SecretConfigError(
            f"ADMIN_SECRET 이 너무 짧다({len(value)}자, 출처: {source}). "
            f"최소 {MIN_ADMIN_SECRET_LEN}자 이상의 난수를 쓰라. "
            'python -c "import secrets; print(secrets.token_urlsafe(32))"'
        )
    if value in _master_key_candidates():
        raise SecretConfigError(
            f"ADMIN_SECRET(출처: {source}) 이 암호화 키(KEY_MASTER 또는 server/secret.key)와 같은 값이다. "
            "서명키와 암호화키를 분리하는 것이 이 변경의 목적이다 — 같은 값을 쓰면 키 하나로 "
            "인증키 전량 복호화와 관리자 토큰 위조가 동시에 가능해진다. 서로 다른 난수를 쓰라. "
            'python -c "import secrets; print(secrets.token_urlsafe(32))"'
        )


def admin_secret() -> str:
    """
    세션 쿠키·API 토큰 **서명 전용** 비밀키(문자열).

    운영 모드: 환경변수 ADMIN_SECRET 필수. 없으면 기동 거부.
    개발 모드: ADMIN_SECRET → server/dev_admin_secret.key → 자동 생성(파일 저장) 순.
              자동 생성 파일을 쓰는 이유는 재시작해도 로컬 로그인이 유지되게 하기 위함이다.
    공통(모드 무관): 값이 있으면 최소 길이·암호화키 동일값 검사를 통과해야 한다(_validate_admin_secret).

    ※ 절대 KEY_MASTER(Fernet 키)를 반환하지 않는다. 그것이 이 모듈의 존재 이유다.
    """
    global _admin_secret_cache
    if _admin_secret_cache:
        return _admin_secret_cache

    value = (os.environ.get("ADMIN_SECRET") or "").strip()

    if is_production() and not value:
        raise SecretConfigError(
            "운영 모드(VERYUP_ENV=production)인데 ADMIN_SECRET 환경변수가 없다. "
            "세션·API 토큰 서명키를 암호화 키로 대신하는 폴백은 제거됐다. "
            'python -c "import secrets; print(secrets.token_urlsafe(32))" 로 새 값을 만들어 '
            "systemd EnvironmentFile(권한 0600) 또는 시크릿 매니저로 주입하라."
        )

    if value:
        # 운영이든 개발이든 동일한 기준으로 검사한다.
        _validate_admin_secret(value, "ADMIN_SECRET 환경변수")
        _admin_secret_cache = value
        log.info("서명키(ADMIN_SECRET) 환경변수에서 로드됨 (mode=%s)", env_name())
        return _admin_secret_cache

    # --- 개발 모드 폴백 ---
    if os.path.exists(DEV_SIGNING_KEY_FILE):
        with open(DEV_SIGNING_KEY_FILE, "r", encoding="utf-8") as f:
            saved = f.read().strip()
        if saved:
            # 파일에도 마스터 키를 붙여넣을 수 있으므로 환경변수와 같은 기준으로 검사한다.
            _validate_admin_secret(saved, DEV_SIGNING_KEY_FILE)
            _admin_secret_cache = saved
            return _admin_secret_cache

    import secrets

    generated = secrets.token_urlsafe(32)
    with open(DEV_SIGNING_KEY_FILE, "w", encoding="utf-8") as f:
        f.write(generated)
    log.warning(
        "개발 모드: 서명키를 자동 생성해 %s 에 저장했다. 운영에서는 ADMIN_SECRET 환경변수를 반드시 설정하라.",
        DEV_SIGNING_KEY_FILE,
    )
    _admin_secret_cache = generated
    return _admin_secret_cache


# ---------------------------------------------------------------- 암호화키(KEY_MASTER)

_master_key_cache: bytes = b""


def master_key() -> bytes:
    """
    인증키 Fernet 암호화 **전용** 마스터 키(bytes).

    운영 모드: 환경변수 KEY_MASTER 필수. 파일 폴백도, 자동 생성도 없다.
      - 파일 폴백을 끄는 이유: secret.key 가 admin.db 와 같은 디렉터리에 있어
        디렉터리가 통째로 새는 모든 경로(백업·동기화·폴더 복사)에서 암호화가 무효가 된다.
      - 자동 생성을 끄는 이유: 키 파일이 없는 상태로 기동하면 조용히 **새 키**가 만들어져
        기존 암호문이 영구 복호화 불가가 된다. 운영에서는 이 사고를 반드시 막아야 한다.
    개발 모드: KEY_MASTER → 기존 server/secret.key 읽기 → 없으면 자동 생성.
      (기존 secret.key 로 암호화된 로컬 데이터를 계속 읽을 수 있는 경로는 여기에만 남긴다.)
    """
    global _master_key_cache
    if _master_key_cache:
        return _master_key_cache

    value = (os.environ.get("KEY_MASTER") or "").strip()
    if value:
        _master_key_cache = value.encode()
        return _master_key_cache

    if is_production():
        raise SecretConfigError(
            "운영 모드(VERYUP_ENV=production)인데 KEY_MASTER 환경변수가 없다. "
            "server/secret.key 파일 폴백과 자동 생성은 운영에서 제거됐다(조용히 새 키가 생기면 "
            "기존 암호문을 영원히 못 읽는다). "
            "기존 데이터를 계속 읽으려면 현재 server/secret.key 의 내용을 그대로 KEY_MASTER 로 주입하라. "
            "키를 회전하려면 마켓플레이스 자격증명 재발급 → 새 KEY_MASTER 로 기동 → 인증키 재입력 순서로 진행하라."
        )

    # --- 개발 모드: 기존 파일 우선 (하위 호환: 기존 암호문을 계속 읽을 수 있어야 한다) ---
    if os.path.exists(KEY_FILE):
        with open(KEY_FILE, "rb") as f:
            saved = f.read().strip()
        if saved:
            _master_key_cache = saved
            return _master_key_cache

    from cryptography.fernet import Fernet

    generated = Fernet.generate_key()
    with open(KEY_FILE, "wb") as f:
        f.write(generated)
    log.warning(
        "개발 모드: 마스터 키를 새로 생성해 %s 에 저장했다. "
        "이전 암호문이 있었다면 이제 복호화되지 않는다. 운영에서는 KEY_MASTER 환경변수를 반드시 설정하라.",
        KEY_FILE,
    )
    _master_key_cache = generated
    return _master_key_cache


# ---------------------------------------------------------------- 기동 시 자가 점검


def verify_startup() -> None:
    """
    프로세스 기동 시 1회 호출. 두 비밀값이 요건을 만족하는지 즉시 확인하고,
    아니면 SecretConfigError 로 기동을 중단시킨다(조용한 폴백 금지).

    app.py 처럼 두 값을 모두 쓰는 내부 프로세스에서 호출한다.
    공개 프로세스는 두 값이 모두 없어야 정상이므로 이 함수를 호출하지 않는다.

    ※ KEY_MASTER 가 "맞는 키인지"까지는 여기서 알 수 없다(형식만 본다).
      그 확인은 DB 준비 후 verify_master_key_canary() 가 맡는다.
    """
    admin_secret()
    master_key()
    log.info("비밀값 점검 통과 (mode=%s, 서명키/암호화키 분리됨)", env_name())


_canary_ok: bool = False

# 마지막 카나리아 결과. 기동 요약·화면 배너가 "어느 행이 안 읽히는가"를 사람에게 보여줄 때 쓴다.
#   status  : "미실행" / "건너뜀" / "통과" / "부분 실패" / "전체 실패"
#   failed  : [{"id":…, "platform":…, "label":…, "error":"InvalidToken"}, …]
_canary_report: dict = {"status": "미실행", "checked": 0, "ok": 0, "failed": [], "note": ""}


def canary_report() -> dict:
    """마지막 verify_master_key_canary() 결과의 사본(호출 측이 망가뜨리지 못하게 복사해서 준다)."""
    report = dict(_canary_report)
    report["failed"] = [dict(f) for f in _canary_report["failed"]]
    return report


def verify_master_key_canary() -> None:
    """
    저장된 인증키를 **실제로 복호화**해 KEY_MASTER 가 맞는 키인지 확인한다.
    한 건도 복호화되지 않으면 SecretConfigError. db.init_db() 이후에 1회 호출한다.

    왜 필요한가:
      master_key() 와 crypto.py 는 '형식이 Fernet 키인가'만 본다. 형식은 맞지만 **다른** 키를
      주입하면 기동은 멀쩡히 성공하고, 고장은 한참 뒤에 이렇게 드러난다.
        - app.py /keys/{id} : 복호화 실패 안내가 뜨고 수정 폼이 사라진다(500 은 고쳐졌다)
        - app.py /api/credentials : except Exception 이 삼켜서 조용히 "data": null 을 돌려주고,
          게다가 "view" 감사 로그까지 남는다(실제로는 아무것도 못 읽었는데).
      운영 인증키가 걸린 값이므로 조기 경보가 필요하다.

    왜 '1건만' 보지 않고 **전 행을 훑는가** (회전 교착을 만든 실제 원인):
      db.list_credentials() 는 ORDER BY platform, id 다. 회전을 절반만 끝낸 상태
      (새 키로 몇 건 재입력했지만 옛 행이 아직 남음)에서는 정렬상 **옛 행이 먼저** 걸리기 쉽고,
      첫 행만 보는 구현은 그 옛 행 하나 때문에 계속 기동을 거부했다 — 재입력을 다 끝내기 전에는
      절대 뜨지 않는 교착이다. 지금은 **한 건이라도 복호화되면 '이 DB 의 키가 맞다'는 증명이
      끝난 것으로 보고 통과**시키고, 못 읽은 행은 목록으로 남겨 운영자가 /keys 에서
      삭제·재입력할 수 있게 한다(그 행들은 /keys 상세에서 '복호화 실패' 안내로 표시된다).

    설계 메모:
      * 인증키가 0건이면 통과 — 신규 배포에서는 비교할 암호문 자체가 없다.
      * db / crypto 는 **함수 안에서 지연 import** 한다. config 가 모듈 수준에서 db 를 끌어오면
        공개 프로세스(admin.db 접근이 없어야 한다)까지 DB 모듈을 물게 되어 격리가 깨진다.
      * admin.db 를 직접 열지 않는다 — db 모듈의 기존 함수만 쓴다.
      * DB 파일/테이블이 아직 없으면 신규 배포로 보고 통과시킨다(키가 틀렸다는 증거가 아니다).
      * 전체 실패일 때 기동을 **허용할지 말지는 여기서 정하지 않는다.** 이 함수는 사실만 말하고,
        회전 탈출구(key_rotation_mode())를 반영해 낮출지 말지는 진입점(serve_internal.py)이 정한다.
    """
    global _canary_ok
    if _canary_ok:
        return

    import sqlite3  # 아래 OperationalError 분기에서만 쓴다

    import db  # 지연 import: 공개 프로세스 격리를 위해 모듈 수준에서 끌어오지 않는다

    def _skip(note: str) -> None:
        global _canary_ok
        _canary_report.update({"status": "건너뜀", "checked": 0, "ok": 0, "failed": [], "note": note})
        _canary_ok = True

    if not os.path.exists(db.DB_PATH):
        # DB 파일이 아직 없다 = 저장된 암호문도 없다. 비교할 대상이 없으므로 통과.
        log.info("마스터 키 카나리아: DB 파일이 없어 건너뜀 (신규 배포)")
        _skip("DB 파일 없음(신규 배포)")
        return

    try:
        rows = db.list_credentials()
    except sqlite3.OperationalError as e:
        # 테이블 미생성(init_db 이전) 등. 키 문제가 아니므로 기동을 막지 않는다.
        log.warning("마스터 키 카나리아: 인증키 목록을 읽지 못해 건너뜀 (%s)", e)
        _skip(f"인증키 목록 조회 실패({type(e).__name__})")
        return

    if not rows:
        log.info("마스터 키 카나리아: 저장된 인증키가 0건이라 건너뜀 (신규 배포)")
        _skip("저장된 인증키 0건")
        return

    import crypto  # 지연 import (crypto 는 import 시점에 config.master_key() 를 쓴다 → 순환 방지)

    checked = 0
    ok = 0
    failed: list = []
    for meta in rows:
        row = db.get_credential(meta["id"])
        if row is None or not row["enc_payload"]:
            # 암호문이 비어 있는 행은 키가 맞는지에 대해 아무 증거도 못 준다(성공도 실패도 아니다).
            continue
        checked += 1
        try:
            crypto.decrypt(row["enc_payload"])
        except Exception as e:  # noqa: BLE001 - InvalidToken 외 형식 오류도 같은 취급이다
            failed.append({
                "id": meta["id"],
                "platform": meta["platform"],
                "label": (meta["label"] or ""),
                "error": type(e).__name__,
            })
            continue
        ok += 1

    _canary_report.update({"checked": checked, "ok": ok, "failed": failed, "note": ""})

    if checked == 0:
        log.warning("마스터 키 카나리아: 검사할 암호문이 하나도 없어 건너뜀 (인증키 %d건이 모두 빈 값)", len(rows))
        _canary_report.update({"status": "건너뜀", "note": "암호문이 모두 빈 값"})
        _canary_ok = True
        return

    if ok == 0:
        _canary_report["status"] = "전체 실패"
        first = failed[0]
        raise SecretConfigError(
            f"KEY_MASTER 로 저장된 인증키를 **한 건도** 복호화하지 못했다"
            f"(검사 {checked}건 전부 실패, 예: cred_id={first['id']}, platform={first['platform']}, "
            f"원인: {first['error']}). "
            "형식은 맞지만 이 DB를 암호화한 키와 **다른 키**일 가능성이 크다. "
            "그대로 기동하면 /keys 상세는 '복호화 실패'만 뜨고 /api/credentials 는 조용히 "
            "data:null 을 돌려준다(직원 앱이 이유 없이 실패한다). "
            "기존 데이터를 읽으려면 원래 키(예전 server/secret.key 의 내용)를 KEY_MASTER 에 넣어라. "
            f"키를 **의도적으로 회전**하는 중이라면 {KEY_ROTATION_ENV}=1 을 함께 넣고 기동하라 — "
            "그러면 이 실패가 경고로 낮아져 /keys 에서 옛 행을 삭제하고 새 값을 재입력할 수 있다"
            f"(재입력이 끝나면 {KEY_ROTATION_ENV} 를 **반드시 제거**하고 다시 띄워라). "
            "VERYUP_ALLOW_DEV_SECRETS 는 이 용도가 아니다 — 그 변수는 비밀값 파일 폴백·자동 생성까지 "
            "통째로 여는 로컬 개발 전용 스위치다."
        )

    _canary_ok = True
    if failed:
        _canary_report["status"] = "부분 실패"
        # 기동은 시킨다 — 한 건이라도 읽혔다면 KEY_MASTER 는 이 DB 의 키가 맞다.
        # 다만 못 읽는 행은 회전 미완료(또는 손상)의 증거이므로 사람이 볼 수 있게 크게 남긴다.
        log.error("마스터 키 카나리아 **부분 실패**: %d건 중 %d건 복호화 성공, %d건 실패",
                  checked, ok, len(failed))
        for f in failed:
            log.error("   ↳ 복호화 불가 cred_id=%s platform=%s label=%s (%s)",
                      f["id"], f["platform"], f["label"], f["error"])
        log.error("   이 행들은 **옛 KEY_MASTER 로 암호화된 값**일 가능성이 크다. /keys 목록에서 해당 행을 열면 "
                  "'복호화 실패' 안내가 뜨고 수정 폼이 없다 — 삭제한 뒤 새 값으로 다시 등록하라.")
        return

    _canary_report["status"] = "통과"
    log.info("마스터 키 카나리아 통과: 저장된 인증키 %d건 전부 복호화 성공", ok)
