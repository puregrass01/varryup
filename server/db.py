"""
SQLite 데이터베이스 초기화 및 헬퍼.
- 이 규모(직원 2~3명)에는 SQLite 파일 하나로 충분하다.
- 비밀번호는 평문 저장 금지: hashlib.pbkdf2_hmac 로 해시 + 솔트 보관.
"""
import sqlite3
import os
import hashlib
import secrets
from datetime import datetime

DB_PATH = os.path.join(os.path.dirname(__file__), "admin.db")


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
            created_at    TEXT NOT NULL
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

    conn.commit()

    # 최초 실행 시 기본 관리자 계정 1개 생성 (username: admin / pw: admin1234)
    cur.execute("SELECT COUNT(*) AS c FROM staff")
    if cur.fetchone()["c"] == 0:
        cur.execute(
            "INSERT INTO staff (username, password_hash, name, role, is_active, created_at) "
            "VALUES (?, ?, ?, 'admin', 1, ?)",
            ("admin", hash_password("admin1234"), "관리자", datetime.now().isoformat(timespec="seconds")),
        )
        conn.commit()
        print("[DB] 기본 관리자 계정 생성됨 → 아이디: admin / 비밀번호: admin1234 (첫 로그인 후 변경 권장)")

    conn.close()


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


def add_staff(username: str, password: str, name: str, role: str = "staff"):
    conn = get_conn()
    conn.execute(
        "INSERT INTO staff (username, password_hash, name, role, is_active, created_at) "
        "VALUES (?, ?, ?, ?, 1, ?)",
        (username, hash_password(password), name, role, datetime.now().isoformat(timespec="seconds")),
    )
    conn.commit()
    conn.close()


def set_staff_active(staff_id: int, active: bool):
    conn = get_conn()
    conn.execute("UPDATE staff SET is_active = ? WHERE id = ?", (1 if active else 0, staff_id))
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
