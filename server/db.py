"""
SQLite 데이터베이스 초기화 및 헬퍼.
- 이 규모(직원 2~3명)에는 SQLite 파일 하나로 충분하다.
- 비밀번호는 평문 저장 금지: hashlib.pbkdf2_hmac 로 해시 + 솔트 보관.
"""
import sqlite3
import os
import hashlib
import logging
import secrets
from datetime import datetime, timedelta

DB_PATH = os.path.join(os.path.dirname(__file__), "admin.db")

log = logging.getLogger("veryup.db")


def get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


# ── 비밀번호 해시 (stdlib만 사용) ──────────────────────────────
def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), 200_000)
    return f"pbkdf2_sha256$200000${salt}${dk.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, iters, salt, digest = stored.split("$")
        dk = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), int(iters))
        return secrets.compare_digest(dk.hex(), digest)
    except Exception:
        return False


# ── 스키마 생성 ──────────────────────────────────────────────
def init_db():
    conn = get_conn()
    cur = conn.cursor()

    cur.execute("""
        CREATE TABLE IF NOT EXISTS staff (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            username      TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            name          TEXT NOT NULL,
            role          TEXT NOT NULL DEFAULT 'staff',   -- admin / staff
            is_active     INTEGER NOT NULL DEFAULT 1,
            created_at    TEXT NOT NULL,
            -- 1 이면 로그인 직후 /password 로 강제 리다이렉트해야 한다.
            -- 부트스트랩으로 만든 최초 관리자 계정은 1 로 시작한다.
            must_change_password INTEGER NOT NULL DEFAULT 0
        )
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS login_logs (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            staff_id   INTEGER,
            username   TEXT,
            ip         TEXT,
            result     TEXT NOT NULL,                       -- success / fail
            created_at TEXT NOT NULL,
            FOREIGN KEY (staff_id) REFERENCES staff(id)
        )
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS platform_credentials (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            platform    TEXT NOT NULL,                       -- coupang / naver / esm / imweb
            label       TEXT NOT NULL,                       -- 계정 별칭 (예: 쿠팡-본사)
            enc_payload BLOB NOT NULL,                       -- 암호화된 JSON (accessKey/secretKey/세션 등)
            updated_by  TEXT,
            updated_at  TEXT NOT NULL
        )
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS key_access_logs (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            staff_id   INTEGER,
            username   TEXT,
            platform   TEXT,
            cred_id    INTEGER,
            action     TEXT NOT NULL,                        -- view / create / update / delete
            ip         TEXT,
            created_at TEXT NOT NULL
        )
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS licenses (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            key            TEXT UNIQUE NOT NULL,
            status         TEXT NOT NULL DEFAULT 'active',   -- active / blocked / expired
            seats          INTEGER NOT NULL DEFAULT 1,
            assigned_to    TEXT,                             -- 배정 대상(메모)
            expires_at     TEXT,                             -- 만료일 (YYYY-MM-DD, 없으면 무제한)
            created_at     TEXT NOT NULL
        )
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS ai_usage (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            staff_id   INTEGER,
            username   TEXT,
            endpoint   TEXT,                                 -- predict / predict_clean
            ms_elapsed INTEGER,
            created_at TEXT NOT NULL
        )
    """)

    conn.commit()

    # ── 기존 DB 마이그레이션 ──────────────────────────────────
    # 이 서버는 파일 하나짜리 SQLite 라 마이그레이션 도구가 없다.
    # 그래서 "컬럼이 없으면 ALTER TABLE" 방식으로 기동 때마다 멱등하게 맞춘다.
    # 기존 행은 DEFAULT 0 → 이미 쓰고 있던 계정들의 로그인 흐름은 그대로 유지된다.
    _ensure_column(cur, "staff", "must_change_password", "INTEGER NOT NULL DEFAULT 0")
    conn.commit()

    _bootstrap_admin(conn, cur)

    conn.close()


def _ensure_column(cur, table: str, column: str, ddl: str):
    """테이블에 컬럼이 없으면 추가한다(있으면 아무것도 하지 않는다)."""
    cols = {r["name"] for r in cur.execute(f"PRAGMA table_info({table})").fetchall()}
    if column not in cols:
        cur.execute(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}")
        log.warning("[DB] 마이그레이션: %s.%s 컬럼 추가", table, column)


def _bootstrap_admin(conn, cur):
    """
    최초 1회 관리자 계정 생성.

    ※ 하위 호환 깨짐(의도된 변경): 예전에는 빈 DB 에 admin/admin1234 를 자동으로 심고
      비밀번호를 콘솔에 출력했다. 그 계정이 인터넷에 열린 /login 으로 그대로 노출됐고
      운영 DB 에서 실제로 유효한 상태였다(보안감사_2026-09-16.md 1·2·4·7번).
      이제는 환경변수가 있을 때만 만들고, 없으면 계정을 만들지 않는다.

    운영자 할 일: 신규 배포(빈 admin.db)라면 최초 기동 한 번만
        BOOTSTRAP_ADMIN_USER=<아이디> BOOTSTRAP_ADMIN_PW=<12자 이상 강한 비밀번호>
      를 넣어 띄운 뒤, 로그인해서 비밀번호를 바꾸고(강제 변경 플래그가 걸려 있다)
      환경변수를 제거하고 재기동한다. 이미 계정이 있는 DB 에서는 무시된다.
    """
    cur.execute("SELECT COUNT(*) AS c FROM staff")
    if cur.fetchone()["c"] > 0:
        return  # 이미 계정이 있으면 부트스트랩하지 않는다.

    username = (os.environ.get("BOOTSTRAP_ADMIN_USER") or "").strip()
    password = os.environ.get("BOOTSTRAP_ADMIN_PW") or ""

    if not username or not password:
        # 기동은 계속한다(공개 프로세스/헬스체크까지 죽이지 않기 위해).
        # 다만 로그인 가능한 계정이 하나도 없으므로 운영자가 반드시 조치해야 한다.
        log.warning(
            "[DB] staff 테이블이 비어 있는데 BOOTSTRAP_ADMIN_USER / BOOTSTRAP_ADMIN_PW 가 없어 "
            "관리자 계정을 만들지 않았다. 기본계정 자동 생성은 보안상 제거됨. "
            "두 환경변수를 설정하고 한 번만 재기동하라."
        )
        return

    if len(password) < 12:
        # 인터넷에 노출될 수 있는 호스트 기준으로 12자 미만은 거부한다.
        log.error("[DB] BOOTSTRAP_ADMIN_PW 가 12자 미만이라 계정을 만들지 않았다.")
        return

    cur.execute(
        "INSERT INTO staff (username, password_hash, name, role, is_active, created_at, must_change_password) "
        "VALUES (?, ?, ?, 'admin', 1, ?, 1)",
        (username, hash_password(password), "관리자",
         datetime.now().isoformat(timespec="seconds")),
    )
    conn.commit()
    # 비밀번호는 절대 로그에 남기지 않는다(예전 print 가 그 반대였다).
    log.warning("[DB] 부트스트랩 관리자 계정 생성됨 (아이디: %s). 최초 로그인 시 비밀번호 변경이 강제된다.", username)


# ── 조회/기록 헬퍼 ────────────────────────────────────────────
def get_staff_by_username(username: str):
    conn = get_conn()
    row = conn.execute("SELECT * FROM staff WHERE username = ?", (username,)).fetchone()
    conn.close()
    return row


def get_staff_by_id(staff_id: int):
    conn = get_conn()
    row = conn.execute("SELECT * FROM staff WHERE id = ?", (staff_id,)).fetchone()
    conn.close()
    return row


def list_staff():
    conn = get_conn()
    rows = conn.execute("SELECT * FROM staff ORDER BY id").fetchall()
    conn.close()
    return rows


def add_staff(username: str, password: str, name: str, role: str = "staff",
              must_change_password: bool = False):
    # must_change_password: 관리자가 대신 정해 준 비밀번호로 계정을 만들 때 True 를 주면
    # 해당 직원이 첫 로그인에서 반드시 비밀번호를 바꾸게 된다(기본값은 기존 동작 유지).
    conn = get_conn()
    conn.execute(
        "INSERT INTO staff (username, password_hash, name, role, is_active, created_at, must_change_password) "
        "VALUES (?, ?, ?, ?, 1, ?, ?)",
        (username, hash_password(password), name, role,
         datetime.now().isoformat(timespec="seconds"), 1 if must_change_password else 0),
    )
    conn.commit()
    conn.close()


def set_staff_active(staff_id: int, active: bool):
    conn = get_conn()
    conn.execute("UPDATE staff SET is_active = ? WHERE id = ?", (1 if active else 0, staff_id))
    conn.commit()
    conn.close()


def update_password(staff_id: int, new_password: str):
    # 비밀번호를 실제로 바꿨으므로 강제 변경 플래그를 함께 해제한다.
    conn = get_conn()
    conn.execute("UPDATE staff SET password_hash = ?, must_change_password = 0 WHERE id = ?",
                 (hash_password(new_password), staff_id))
    conn.commit()
    conn.close()


def set_must_change_password(staff_id: int, must: bool):
    """관리자가 비밀번호를 초기화해 준 직후 등, 강제 변경 플래그를 직접 세울 때 쓴다."""
    conn = get_conn()
    conn.execute("UPDATE staff SET must_change_password = ? WHERE id = ?",
                 (1 if must else 0, staff_id))
    conn.commit()
    conn.close()


def record_login(staff_id, username, ip, result):
    conn = get_conn()
    conn.execute(
        "INSERT INTO login_logs (staff_id, username, ip, result, created_at) VALUES (?, ?, ?, ?, ?)",
        (staff_id, username, ip, result, datetime.now().isoformat(timespec="seconds")),
    )
    conn.commit()
    conn.close()


def recent_logins(limit: int = 20):
    conn = get_conn()
    rows = conn.execute(
        "SELECT * FROM login_logs ORDER BY id DESC LIMIT ?", (limit,)
    ).fetchall()
    conn.close()
    return rows


def count_today_logins():
    conn = get_conn()
    today = datetime.now().strftime("%Y-%m-%d")
    row = conn.execute(
        "SELECT COUNT(*) AS c FROM login_logs WHERE result='success' AND created_at LIKE ?",
        (today + "%",),
    ).fetchone()
    conn.close()
    return row["c"]


# ── 로그인 실패 카운터 (잠금 판정용) ──────────────────────────
# login_logs 는 created_at 을 datetime.isoformat(timespec="seconds") 형식으로 넣으므로
# 문자열 사전순 비교 = 시간순 비교가 성립한다. 그래서 별도 인덱스/파싱 없이 '>=' 로 센다.
def count_recent_failures(username: str = None, ip: str = None, minutes: int = 15) -> int:
    """
    직전 `minutes` 분 동안의 로그인 실패 건수를 센다.
    - username 만 주면 그 계정에 대한 실패 수(어느 IP 에서든)
    - ip 만 주면 그 IP 에서 발생한 실패 수(어느 계정이든)
    - 둘 다 주면 (계정 OR IP) 중 하나라도 걸리는 실패 수 —
      계정 표적 공격과 IP 분산 스캔을 한 번의 호출로 함께 막기 위해 AND 가 아니라 OR 다.
    - 둘 다 없으면 0 (전체 실패 수를 실수로 세어 서버 전체를 잠그는 사고 방지).
    app.py 가 이 값으로 임계치(예: 5회) 초과 시 429/잠금을 건다.
    """
    if not username and not ip:
        return 0

    since = (datetime.now() - timedelta(minutes=minutes)).isoformat(timespec="seconds")
    conds, params = [], [since]
    if username:
        conds.append("username = ?")
        params.append(username)
    if ip:
        conds.append("ip = ?")
        params.append(ip)

    sql = ("SELECT COUNT(*) AS c FROM login_logs "
           "WHERE result = 'fail' AND created_at >= ? AND (" + " OR ".join(conds) + ")")
    conn = get_conn()
    row = conn.execute(sql, params).fetchone()
    conn.close()
    return row["c"]


def last_failure_at(username: str = None, ip: str = None):
    """마지막 실패 시각(ISO 문자열) — 잠금 해제까지 남은 시간을 계산할 때 쓴다. 없으면 None."""
    if not username and not ip:
        return None

    conds, params = [], []
    if username:
        conds.append("username = ?")
        params.append(username)
    if ip:
        conds.append("ip = ?")
        params.append(ip)

    sql = ("SELECT created_at FROM login_logs WHERE result = 'fail' AND ("
           + " OR ".join(conds) + ") ORDER BY id DESC LIMIT 1")
    conn = get_conn()
    row = conn.execute(sql, params).fetchone()
    conn.close()
    return row["created_at"] if row else None


# ── 인증키 (암호화 저장) ──────────────────────────────────────
def list_credentials():
    """복호화하지 않고 메타데이터만 (목록 표시용)."""
    conn = get_conn()
    rows = conn.execute(
        "SELECT id, platform, label, updated_by, updated_at FROM platform_credentials ORDER BY platform, id"
    ).fetchall()
    conn.close()
    return rows


def get_credential(cred_id: int):
    conn = get_conn()
    row = conn.execute("SELECT * FROM platform_credentials WHERE id = ?", (cred_id,)).fetchone()
    conn.close()
    return row


def add_credential(platform: str, label: str, enc_payload: bytes, by: str):
    conn = get_conn()
    conn.execute(
        "INSERT INTO platform_credentials (platform, label, enc_payload, updated_by, updated_at) "
        "VALUES (?, ?, ?, ?, ?)",
        (platform, label, enc_payload, by, datetime.now().isoformat(timespec="seconds")),
    )
    conn.commit()
    conn.close()


def update_credential(cred_id: int, enc_payload: bytes, by: str):
    conn = get_conn()
    conn.execute(
        "UPDATE platform_credentials SET enc_payload = ?, updated_by = ?, updated_at = ? WHERE id = ?",
        (enc_payload, by, datetime.now().isoformat(timespec="seconds"), cred_id),
    )
    conn.commit()
    conn.close()


def delete_credential(cred_id: int):
    conn = get_conn()
    conn.execute("DELETE FROM platform_credentials WHERE id = ?", (cred_id,))
    conn.commit()
    conn.close()


# ── 인증키 접근 감사 로그 ─────────────────────────────────────
def record_key_access(staff_id, username, platform, cred_id, action, ip):
    conn = get_conn()
    conn.execute(
        "INSERT INTO key_access_logs (staff_id, username, platform, cred_id, action, ip, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (staff_id, username, platform, cred_id, action, ip, datetime.now().isoformat(timespec="seconds")),
    )
    conn.commit()
    conn.close()


def recent_key_logs(limit: int = 30):
    conn = get_conn()
    rows = conn.execute(
        "SELECT * FROM key_access_logs ORDER BY id DESC LIMIT ?", (limit,)
    ).fetchall()
    conn.close()
    return rows


# ── 라이선스 ─────────────────────────────────────────────────
def list_licenses():
    conn = get_conn()
    rows = conn.execute("SELECT * FROM licenses ORDER BY id DESC").fetchall()
    conn.close()
    return rows


def add_license(key: str, seats: int, assigned_to: str, expires_at: str):
    conn = get_conn()
    conn.execute(
        "INSERT INTO licenses (key, status, seats, assigned_to, expires_at, created_at) "
        "VALUES (?, 'active', ?, ?, ?, ?)",
        (key, seats, assigned_to or None, expires_at or None,
         datetime.now().isoformat(timespec="seconds")),
    )
    conn.commit()
    conn.close()


def set_license_status(license_id: int, status: str):
    conn = get_conn()
    conn.execute("UPDATE licenses SET status = ? WHERE id = ?", (status, license_id))
    conn.commit()
    conn.close()


def delete_license(license_id: int):
    conn = get_conn()
    conn.execute("DELETE FROM licenses WHERE id = ?", (license_id,))
    conn.commit()
    conn.close()


# ── AI 사용량 ─────────────────────────────────────────────────
def record_ai_usage(staff_id, username, endpoint, ms_elapsed):
    conn = get_conn()
    conn.execute(
        "INSERT INTO ai_usage (staff_id, username, endpoint, ms_elapsed, created_at) "
        "VALUES (?, ?, ?, ?, ?)",
        (staff_id, username, endpoint, ms_elapsed, datetime.now().isoformat(timespec="seconds")),
    )
    conn.commit()
    conn.close()


def ai_usage_summary():
    """오늘/전체 건수 + 직원별 집계."""
    conn = get_conn()
    today = datetime.now().strftime("%Y-%m-%d")
    total = conn.execute("SELECT COUNT(*) AS c FROM ai_usage").fetchone()["c"]
    today_cnt = conn.execute(
        "SELECT COUNT(*) AS c FROM ai_usage WHERE created_at LIKE ?", (today + "%",)
    ).fetchone()["c"]
    by_staff = conn.execute(
        "SELECT username, COUNT(*) AS cnt, AVG(ms_elapsed) AS avg_ms "
        "FROM ai_usage GROUP BY username ORDER BY cnt DESC"
    ).fetchall()
    conn.close()
    return {"total": total, "today": today_cnt, "by_staff": by_staff}


def recent_ai_usage(limit: int = 50):
    conn = get_conn()
    rows = conn.execute("SELECT * FROM ai_usage ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
    conn.close()
    return rows
