"""
eBay 계정 삭제 알림 전용 소형 저장소 — '공개 프로세스'가 가지는 유일한 상태.

왜 admin.db 가 아니라 별도 파일인가
  공개 프로세스는 인터넷에 직접 열린다. 그래서 admin.db 파일도, KEY_MASTER 도,
  ADMIN_SECRET 도 가지지 않는다(2026-09-16 보안감사 §4-2 에서 확정된 아키텍처).
  하지만 eBay 는 "알림을 받았다"는 증빙과 30일 내 이행을 요구하므로 어딘가에는 적어야 한다.
  그 '어딘가'를 인증키 금고와 **물리적으로 다른 파일**로 둔 것이 이 모듈이다.
  이 파일이 통째로 유출돼도 나오는 것은 eBay userId 와 거절 사유뿐이고,
  이 프로세스가 침해돼도 인증키를 지울 수 있는 코드 경로가 아예 존재하지 않는다.

무엇을 담나
  pending_deletions  서명 검증을 통과한 삭제 알림. **여기서는 아무것도 삭제하지 않는다.**
                     실제 인증키 삭제는 내부 프로세스의 관리자가 확인·승인할 때만 수행한다.
                     eBay 이행 기한이 30일이라 사람이 개입할 시간은 충분하다.
  rejections         버린 요청의 사유·시각·IP·헤더 지문. 200 만 돌려주고 조용히 버리면
                     진짜 eBay 알림을 잃어도 사후에 알 수 없기 때문(감사 §28).
  quarantine.jsonl   거절한 요청의 **원본 바이트**. 사유만 남기면 "어떤 userId 였는지"를
                     복구할 수 없어 사후 이행이 불가능하다. 서명 검증을 통과한 본문과
                     그렇지 않은 본문을 **서로 다른 파일**에 담는다 — 위조 본문 폭주가
                     진짜 알림 본문을 회전으로 밀어내지 못하게 하기 위함.
  receipts.jsonl     사람이 바로 열어볼 수 있는 영수증 사본. 크기 상한 + 회전으로 디스크를 묶는다.

배포 시 환경변수
  EBAY_QUEUE_DIR      큐·영수증·격리 파일을 담을 **전용 디렉터리**. 운영에서는 반드시 설정한다
                      (예: /var/lib/veryup-public). 미설정이면 이 파일 옆에 만들고 경고를 남긴다.
                      왜 전용 디렉터리인가는 아래 _BASE_DIR 주석 참고.
  EBAY_QUEUE_DB       (선택) 큐 SQLite 파일 경로   (기본: <EBAY_QUEUE_DIR>/ebay_queue.db)
  EBAY_RECEIPT_LOG    (선택) 영수증 jsonl 경로     (기본: <EBAY_QUEUE_DIR>/ebay_deletions.jsonl)
  EBAY_QUARANTINE_MAX_BYTES            (선택) 검증 통과 본문 격리 파일 상한, 기본 4MB
  EBAY_QUARANTINE_UNVERIFIED_MAX_BYTES (선택) 미검증 본문 격리 파일 상한, 기본 1MB
"""
import base64
import binascii
import json
import logging
import os
import sqlite3
import uuid
from datetime import datetime, timezone

log = logging.getLogger("veryup.ebay_queue")

_HERE = os.path.dirname(os.path.abspath(__file__))

# ── 저장 위치 ────────────────────────────────────────────────
# admin.db 와 '이름이 다른 것'만으로는 부족하다 — 이 모듈은 db.py 를 import 하지 않고
# DB_PATH 도 참조하지 않는다. 즉 코드 상으로 admin.db 에 도달할 방법이 없다.
#
# 그런데 '다른 파일'만으로도 부족하다. POSIX 에서 **디렉터리 쓰기 권한은 그 안 파일의
# unlink/rename 권한**이다. 큐 파일이 admin.db 와 같은 디렉터리에 있으면, 공개 프로세스에게
# 큐를 쓰라고 준 그 권한이 곧 admin.db 를 **지우거나 갈아치울** 권한이 된다.
# 코드가 admin.db 를 열지 않아도 그렇다 — 파일을 여는 것이 아니라 디렉터리 항목을 바꾸는 일이라서.
# 그래서 공개 프로세스가 쓰는 파일은 admin.db 와 **다른 디렉터리**에 둔다.
QUEUE_DIR = (os.environ.get("EBAY_QUEUE_DIR") or "").strip()
if QUEUE_DIR:
    _BASE_DIR = os.path.abspath(os.path.expanduser(QUEUE_DIR))
else:
    # 기본값은 하위 호환을 위해 유지하되, 기동 시 반드시 눈에 띄게 경고한다.
    # (serve_public.py 가 EBAY_QUEUE_DIR 미설정을 별도로 점검한다 — PUBLIC_STRICT=1 이면 기동 거부)
    _BASE_DIR = _HERE
    log.warning(
        "EBAY_QUEUE_DIR 이 설정되지 않아 큐·영수증을 소스 디렉터리(%s)에 만듭니다. "
        "이 디렉터리에는 admin.db 가 함께 있고, 디렉터리 쓰기 권한은 그 안 파일의 삭제·교체 권한이므로 "
        "인터넷에 열린 공개 프로세스가 admin.db 를 지우거나 갈아치울 수 있습니다. "
        "운영에서는 EBAY_QUEUE_DIR=/var/lib/veryup-public 처럼 전용 디렉터리를 지정하세요.",
        _BASE_DIR,
    )

DB_PATH = os.environ.get("EBAY_QUEUE_DB") or os.path.join(_BASE_DIR, "ebay_queue.db")
RECEIPT_LOG = os.environ.get("EBAY_RECEIPT_LOG") or os.path.join(_BASE_DIR, "ebay_deletions.jsonl")

# 격리(quarantine) 파일 — 거절한 요청의 원본 바이트.
# 검증 통과분과 미검증분을 **다른 파일**에 담는 이유: 두 파일은 각자의 상한으로 회전하므로,
# 공격자가 위조 본문을 아무리 부어도 진짜 알림 본문이 회전으로 밀려나지 않는다.
QUARANTINE_LOG = os.environ.get("EBAY_QUARANTINE_LOG") or os.path.join(_BASE_DIR, "ebay_quarantine.jsonl")
QUARANTINE_UNVERIFIED_LOG = (
    os.environ.get("EBAY_QUARANTINE_UNVERIFIED_LOG")
    or os.path.join(_BASE_DIR, "ebay_quarantine_unverified.jsonl")
)

# 영수증 파일 상한과 회전 — 무인증 경로가 만드는 파일이라 상한이 없으면
# curl 루프 하나로 디스크를 채울 수 있다(감사 §26·§24). 상한을 넘으면 .1 로 한 번만
# 밀어내고 새로 쓴다. 최악의 경우에도 디스크 사용량은 상한의 2배로 묶인다.
MAX_RECEIPT_BYTES = int(os.environ.get("EBAY_RECEIPT_MAX_BYTES") or 5 * 1024 * 1024)

# 격리 파일 상한도 같은 방식(2세대 회전)으로 묶는다.
MAX_QUARANTINE_BYTES = int(os.environ.get("EBAY_QUARANTINE_MAX_BYTES") or 4 * 1024 * 1024)
MAX_QUARANTINE_UNVERIFIED_BYTES = int(
    os.environ.get("EBAY_QUARANTINE_UNVERIFIED_MAX_BYTES") or 1 * 1024 * 1024)
# 한 건당 남기는 본문 길이 상한. 계정 삭제 알림은 1KB 안팎이라 이 정도면 userId 는 반드시 들어온다.
# (base64 라 실제 기록량은 4/3 배)
MAX_QUARANTINE_BODY_BYTES = int(os.environ.get("EBAY_QUARANTINE_BODY_BYTES") or 16 * 1024)

# 거절 기록은 공격자가 마음대로 늘릴 수 있으므로 행 수에 상한을 둔다.
# pending_deletions 는 서명 검증을 통과한 것만 들어오므로 상한을 두지 않는다
# (그쪽을 잘라내면 이행 의무 자체를 잃어버린다).
MAX_REJECTION_ROWS = int(os.environ.get("EBAY_MAX_REJECTION_ROWS") or 5000)

_SCHEMA = """
CREATE TABLE IF NOT EXISTS pending_deletions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    notification_id TEXT    UNIQUE,        -- 리플레이/재시도 중복 제거 키
    topic           TEXT,
    event_date      TEXT,
    user_id         TEXT    NOT NULL,
    username        TEXT,
    signature_kid   TEXT,
    source_ip       TEXT,
    received_at     TEXT    NOT NULL,
    status          TEXT    NOT NULL DEFAULT 'pending',  -- pending | fulfilled | dismissed
    resolved_at     TEXT,
    resolved_by     TEXT,
    resolution_note TEXT
);
CREATE INDEX IF NOT EXISTS idx_pending_status ON pending_deletions (status, id);

CREATE TABLE IF NOT EXISTS rejections (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    reason        TEXT NOT NULL,
    detail        TEXT,
    source_ip     TEXT,
    sig_kid       TEXT,
    sig_digest    TEXT,          -- 헤더 원문이 아니라 SHA-256 지문만 남긴다
    body_bytes    INTEGER,
    created_at    TEXT NOT NULL,
    quarantine_ref TEXT          -- 격리 파일에 저장된 원본 본문의 id (없으면 NULL)
);
CREATE INDEX IF NOT EXISTS idx_rejections_created ON rejections (id);
"""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _ensure_dir() -> None:
    """전용 디렉터리를 만든다. 없는 경로를 주면 알림을 받는 순간에야 실패를 알게 된다."""
    if not QUEUE_DIR:
        return                                   # 기본 경로(소스 디렉터리)는 이미 존재한다
    os.makedirs(_BASE_DIR, exist_ok=True)


def _conn() -> sqlite3.Connection:
    # timeout: 같은 파일에 동시 쓰기가 몰려도 즉시 실패하지 않게 잠깐 기다린다.
    conn = sqlite3.connect(DB_PATH, timeout=5.0)
    conn.row_factory = sqlite3.Row
    return conn


_initialized = False


def _migrate(conn: sqlite3.Connection) -> None:
    """이미 만들어진 큐 파일에 뒤늦게 추가된 열을 붙인다.

    CREATE TABLE IF NOT EXISTS 는 기존 표의 모양을 바꿔주지 않으므로,
    이 단계가 없으면 기존 배포에서 quarantine_ref INSERT 가 통째로 실패한다
    (= 거절 기록이 사라진다).
    """
    cols = {row["name"] for row in conn.execute("PRAGMA table_info(rejections)")}
    if cols and "quarantine_ref" not in cols:
        conn.execute("ALTER TABLE rejections ADD COLUMN quarantine_ref TEXT")
        log.info("eBay 거절 표에 quarantine_ref 열을 추가했습니다.")


def init() -> None:
    """테이블을 만든다. 여러 번 불러도 안전하다."""
    global _initialized
    _ensure_dir()
    conn = _conn()
    try:
        conn.executescript(_SCHEMA)
        _migrate(conn)
        conn.commit()
    finally:
        conn.close()
    _initialized = True
    log.info("eBay 삭제 알림 큐 준비 완료 (db=%s)", DB_PATH)


def _ensure() -> None:
    if not _initialized:
        init()


# ── 수신 큐 ──────────────────────────────────────────────────
def enqueue_deletion(*, notification_id, topic, event_date, user_id,
                     username=None, signature_kid=None, source_ip=None) -> str:
    """검증을 통과한 삭제 알림을 pending 으로 적재한다. 'queued' 또는 'duplicate' 를 돌려준다.

    **여기서는 어떤 인증키도 지우지 않는다.** 그것이 이 큐의 존재 이유다 —
    인증 없는 공개 경로가 되돌릴 수 없는 삭제를 직접 수행하던 구조를 끊어낸 자리.
    """
    _ensure()
    conn = _conn()
    try:
        cur = conn.execute(
            "INSERT OR IGNORE INTO pending_deletions "
            "(notification_id, topic, event_date, user_id, username, signature_kid, source_ip, received_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (notification_id, topic, event_date, user_id, username, signature_kid, source_ip, _now()),
        )
        conn.commit()
        # notification_id 가 UNIQUE 이므로 재전송·리플레이는 rowcount 0 으로 걸러진다.
        return "queued" if cur.rowcount else "duplicate"
    finally:
        conn.close()


def record_rejection(*, reason: str, detail=None, source_ip=None,
                     sig_kid=None, sig_digest=None, body_bytes=None,
                     quarantine_ref=None) -> None:
    """버린 요청을 남긴다. '왜 버렸는지'는 반드시 남아야 한다.

    200 으로 거절한 건은 eBay 가 재시도하지 않으므로, 우리가 잘못 거절했을 때 그 사실을
    사후에 확인할 수 있는 유일한 단서가 이 표다(감사 §28).
    quarantine_ref 가 있으면 격리 파일에서 원본 본문까지 되찾을 수 있다.
    """
    _ensure()
    conn = _conn()
    try:
        conn.execute(
            "INSERT INTO rejections "
            "(reason, detail, source_ip, sig_kid, sig_digest, body_bytes, created_at, quarantine_ref) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (reason, detail, source_ip, sig_kid, sig_digest, body_bytes, _now(), quarantine_ref),
        )
        # 상한 초과분은 오래된 것부터 버린다 — 공격자가 이 표로 디스크를 채우지 못하게.
        conn.execute(
            "DELETE FROM rejections WHERE id <= "
            "(SELECT MAX(id) FROM rejections) - ?",
            (MAX_REJECTION_ROWS,),
        )
        conn.commit()
    except sqlite3.Error as e:                    # noqa: BLE001 - 기록 실패로 200 을 깨뜨리지 않는다
        log.error("eBay 거절 기록 실패: %s", type(e).__name__)
    finally:
        conn.close()


# ── 내부 프로세스(관리자 승인)용 조회/갱신 ────────────────────
# 아래 함수들은 공개 프로세스에서 호출되지 않는다. 내부 관리 화면이 쓴다.
def list_pending(limit: int = 100, status: str = "pending"):
    _ensure()
    conn = _conn()
    try:
        return conn.execute(
            "SELECT * FROM pending_deletions WHERE status = ? ORDER BY id DESC LIMIT ?",
            (status, limit),
        ).fetchall()
    finally:
        conn.close()


def get_pending(row_id: int):
    _ensure()
    conn = _conn()
    try:
        return conn.execute("SELECT * FROM pending_deletions WHERE id = ?", (row_id,)).fetchone()
    finally:
        conn.close()


def resolve_pending(row_id: int, *, status: str, by: str, note: str = "") -> bool:
    """관리자가 승인(fulfilled) 하거나 기각(dismissed) 했음을 기록한다."""
    if status not in ("fulfilled", "dismissed"):
        raise ValueError("status 는 fulfilled 또는 dismissed 여야 합니다.")
    _ensure()
    conn = _conn()
    try:
        cur = conn.execute(
            "UPDATE pending_deletions SET status = ?, resolved_at = ?, resolved_by = ?, resolution_note = ? "
            "WHERE id = ? AND status = 'pending'",
            (status, _now(), by, note, row_id),
        )
        conn.commit()
        return bool(cur.rowcount)
    finally:
        conn.close()


def recent_rejections(limit: int = 50):
    _ensure()
    conn = _conn()
    try:
        return conn.execute(
            "SELECT * FROM rejections ORDER BY id DESC LIMIT ?", (limit,)
        ).fetchall()
    finally:
        conn.close()


def stats() -> dict:
    """관리 화면 배지용 — pending 이 쌓이면 30일 기한을 놓치기 전에 눈에 띄어야 한다."""
    _ensure()
    conn = _conn()
    try:
        pending = conn.execute(
            "SELECT COUNT(*) FROM pending_deletions WHERE status = 'pending'").fetchone()[0]
        rejected = conn.execute("SELECT COUNT(*) FROM rejections").fetchone()[0]
        return {"pending": pending, "rejections": rejected}
    finally:
        conn.close()


# ── jsonl 공통 (크기 상한 + 2세대 회전) ───────────────────────
def _append_line(path: str, line: str, max_bytes: int, *, what: str) -> None:
    """상한을 넘으면 한 세대만 밀어내고 새로 쓴다. 실패해도 예외를 밖으로 내보내지 않는다.

    0600 으로 만든다 — 이 파일들에는 eBay userId 와(격리 파일의 경우) 알림 원본이 들어간다.
    """
    try:
        _ensure_dir()
        _rotate_if_needed(path, max_bytes, what=what)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        with os.fdopen(fd, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError as e:
        log.error("eBay %s 기록 실패: %s", what, e)


def _rotate_if_needed(path: str, max_bytes: int, *, what: str) -> None:
    try:
        size = os.path.getsize(path)
    except OSError:
        return                                   # 아직 파일이 없다 = 회전할 것도 없다
    if size < max_bytes:
        return
    backup = path + ".1"
    try:
        if os.path.exists(backup):
            os.remove(backup)                    # 세대는 2개까지만 — 디스크를 무한히 먹지 않게
        os.replace(path, backup)
        log.info("eBay %s 파일이 상한(%dB)을 넘어 회전했습니다.", what, max_bytes)
    except OSError as e:
        log.error("eBay %s 회전 실패: %s", what, e)


# ── 영수증 jsonl ─────────────────────────────────────────────
def append_receipt(record: dict) -> None:
    """사람이 읽는 영수증 한 줄.

    이 파일은 '증빙'이 아니라 '사본'이다. 진짜 근거는 위의 SQLite 표다.
    """
    _append_line(RECEIPT_LOG, json.dumps(record, ensure_ascii=False),
                 MAX_RECEIPT_BYTES, what="영수증")


# ── 격리 저장소 ──────────────────────────────────────────────
def quarantine_body(raw, *, reason: str, detail=None, source_ip=None,
                    sig_kid=None, sig_digest=None, verified: bool = False) -> str | None:
    """거절한 요청의 **원본 바이트**를 남기고 참조 id 를 돌려준다(실패하면 None).

    왜 필요한가
      사유만 적고 본문을 버리면, 우리가 정당한 알림을 잘못 거절했을 때
      "어떤 userId 였는지"를 복구할 수 없다 — 즉 사후 이행이 불가능해진다.
      eBay 는 2xx 를 받은 알림을 다시 보내주지 않으므로 이 파일이 마지막 사본이다.

    왜 파일을 둘로 나누나
      verified=True(서명 검증을 통과했지만 본문 문제로 거절)는 '진짜 eBay 가 보낸 것'이라
      복구 가치가 높고 양이 적다. verified=False 는 누구나 만들어낼 수 있다.
      한 파일에 섞으면 위조 본문 폭주가 회전을 일으켜 진짜 본문을 밀어낸다.
      그래서 저장 공간 자체를 분리한다.
    """
    ref = uuid.uuid4().hex[:16]
    body = bytes(raw or b"")
    truncated = len(body) > MAX_QUARANTINE_BODY_BYTES
    if truncated:
        body = body[:MAX_QUARANTINE_BODY_BYTES]
    record = {
        "id": ref,
        "at": _now(),
        "reason": reason,
        "detail": detail,
        "sourceIp": source_ip,
        "sigKid": sig_kid,
        "sigDigest": sig_digest,
        "verified": bool(verified),
        "bodyBytes": len(raw or b""),
        "truncated": truncated,
        # 본문은 임의 바이트라 그대로 json 에 넣을 수 없다. base64 로 담는다.
        "bodyB64": base64.b64encode(body).decode("ascii"),
    }
    path = QUARANTINE_LOG if verified else QUARANTINE_UNVERIFIED_LOG
    limit = MAX_QUARANTINE_BYTES if verified else MAX_QUARANTINE_UNVERIFIED_BYTES
    _append_line(path, json.dumps(record, ensure_ascii=False), limit,
                 what="격리본문" if verified else "격리본문(미검증)")
    return ref


def read_quarantined(ref: str, *, verified: bool = True) -> dict | None:
    """격리 파일에서 참조 id 로 한 건을 찾아 본문 바이트까지 복원한다(내부 프로세스용).

    회전으로 이미 밀려났으면 None. 파일이 커봐야 상한(수 MB)이라 선형 탐색으로 충분하다.
    """
    base = QUARANTINE_LOG if verified else QUARANTINE_UNVERIFIED_LOG
    for path in (base, base + ".1"):
        try:
            with open(path, "r", encoding="utf-8") as f:
                for line in f:
                    if ref not in line:          # 값비싼 json 파싱 전에 싸게 거른다
                        continue
                    try:
                        rec = json.loads(line)
                    except ValueError:
                        continue
                    if rec.get("id") != ref:
                        continue
                    try:
                        rec["body"] = base64.b64decode(rec.get("bodyB64") or "")
                    except (binascii.Error, ValueError):
                        rec["body"] = b""
                    return rec
        except OSError:
            continue
    return None
