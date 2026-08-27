"""
VERY UP 관리자 서버 (Phase 2)
- 로그인 / 직원 계정 / 로그인 로그 / 대시보드
- 개발 중 포트 8001 (AI 서버 8000과 분리). 나중에 서버 PC에서 통합.
실행:  python -m uvicorn app:app --host 0.0.0.0 --port 8001 --reload

※ Starlette 의 Jinja2Templates 래퍼 대신 Jinja2 Environment 로 직접 렌더링한다.
  (최신 starlette/jinja2/python 조합에서 TemplateResponse 캐시 키 호환 이슈 회피)
"""
import os
import json
import secrets
from fastapi import FastAPI, Request, Form
from fastapi.responses import HTMLResponse, RedirectResponse
from starlette.middleware.sessions import SessionMiddleware
from jinja2 import Environment, FileSystemLoader, select_autoescape

import db
import crypto


def _ip(request: "Request") -> str:
    return request.client.host if request.client else "-"

BASE_DIR = os.path.dirname(__file__)
env = Environment(
    loader=FileSystemLoader(os.path.join(BASE_DIR, "templates")),
    autoescape=select_autoescape(),
)


def render(name: str, status_code: int = 200, **ctx) -> HTMLResponse:
    return HTMLResponse(env.get_template(name).render(**ctx), status_code=status_code)


app = FastAPI(title="VERY UP 관리자")
# 세션 서명 키: 실제 서버 배포 시 환경변수 ADMIN_SECRET 로 고정값을 넣는다.
app.add_middleware(SessionMiddleware, secret_key=os.environ.get("ADMIN_SECRET", secrets.token_hex(32)))

db.init_db()


# ── 로그인 상태 헬퍼 ──────────────────────────────────────────
def current_user(request: Request):
    uid = request.session.get("uid")
    if not uid:
        return None
    return db.get_staff_by_id(uid)


# ── 로그인 / 로그아웃 ─────────────────────────────────────────
@app.get("/login", response_class=HTMLResponse)
def login_page(request: Request):
    if current_user(request):
        return RedirectResponse("/", status_code=303)
    return render("login.html", error=None)


@app.post("/login", response_class=HTMLResponse)
def login_submit(request: Request, username: str = Form(...), password: str = Form(...)):
    ip = request.client.host if request.client else "-"
    user = db.get_staff_by_username(username)
    ok = user is not None and user["is_active"] == 1 and db.verify_password(password, user["password_hash"])
    if ok:
        db.record_login(user["id"], username, ip, "success")
        request.session["uid"] = user["id"]
        return RedirectResponse("/", status_code=303)
    db.record_login(user["id"] if user else None, username, ip, "fail")
    return render("login.html", status_code=401,
                  error="아이디 또는 비밀번호가 올바르지 않거나 비활성 계정입니다.")


@app.get("/logout")
def logout(request: Request):
    request.session.clear()
    return RedirectResponse("/login", status_code=303)


# ── 대시보드 ─────────────────────────────────────────────────
@app.get("/", response_class=HTMLResponse)
def dashboard(request: Request):
    user = current_user(request)
    if not user:
        return RedirectResponse("/login", status_code=303)
    staff = db.list_staff()
    active_count = sum(1 for s in staff if s["is_active"] == 1)
    return render("dashboard.html", user=user,
                  staff_total=len(staff), active_count=active_count,
                  today_logins=db.count_today_logins(), recent=db.recent_logins(8))


# ── 직원 계정 관리 ────────────────────────────────────────────
@app.get("/staff", response_class=HTMLResponse)
def staff_page(request: Request, msg: str = None):
    user = current_user(request)
    if not user:
        return RedirectResponse("/login", status_code=303)
    return render("staff.html", user=user, staff=db.list_staff(), msg=msg)


@app.post("/staff/add")
def staff_add(request: Request, username: str = Form(...), name: str = Form(...),
              password: str = Form(...), role: str = Form("staff")):
    user = current_user(request)
    if not user or user["role"] != "admin":
        return RedirectResponse("/login", status_code=303)
    try:
        db.add_staff(username.strip(), password, name.strip(), role)
        return RedirectResponse("/staff?msg=직원 계정이 추가되었습니다.", status_code=303)
    except Exception as e:
        return RedirectResponse(f"/staff?msg=추가 실패: {e}", status_code=303)


@app.post("/staff/{staff_id}/toggle")
def staff_toggle(request: Request, staff_id: int):
    user = current_user(request)
    if not user or user["role"] != "admin":
        return RedirectResponse("/login", status_code=303)
    target = db.get_staff_by_id(staff_id)
    if target:
        db.set_staff_active(staff_id, target["is_active"] == 0)
    return RedirectResponse("/staff", status_code=303)


# ── 인증키 중앙보관 (암호화 + 감사로그) ───────────────────────
PLATFORM_HINTS = {
    "coupang": '{\n  "vendorId": "",\n  "accessKey": "",\n  "secretKey": ""\n}',
    "naver": '{\n  "session": ""\n}',
    "esm": '{\n  "session": ""\n}',
    "imweb": '{\n  "clientId": "",\n  "clientSecret": ""\n}',
}


@app.get("/keys", response_class=HTMLResponse)
def keys_page(request: Request, msg: str = None):
    user = current_user(request)
    if not user:
        return RedirectResponse("/login", status_code=303)
    if user["role"] != "admin":
        return RedirectResponse("/", status_code=303)
    return render("keys.html", user=user, creds=db.list_credentials(),
                  logs=db.recent_key_logs(20), hints=PLATFORM_HINTS, msg=msg)


@app.post("/keys/add")
def keys_add(request: Request, platform: str = Form(...), label: str = Form(...), payload: str = Form(...)):
    user = current_user(request)
    if not user or user["role"] != "admin":
        return RedirectResponse("/login", status_code=303)
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
    if user["role"] != "admin":
        return RedirectResponse("/", status_code=303)
    row = db.get_credential(cred_id)
    if not row:
        return RedirectResponse("/keys", status_code=303)
    plaintext = crypto.decrypt(row["enc_payload"])
    try:  # 보기 좋게 정렬
        plaintext = json.dumps(json.loads(plaintext), ensure_ascii=False, indent=2)
    except Exception:
        pass
    # 복호화해서 열람한 것 자체를 감사 기록에 남긴다
    db.record_key_access(user["id"], user["username"], row["platform"], cred_id, "view", _ip(request))
    return render("key_detail.html", user=user, cred=row, plaintext=plaintext)


@app.post("/keys/{cred_id}/update")
def keys_update(request: Request, cred_id: int, payload: str = Form(...)):
    user = current_user(request)
    if not user or user["role"] != "admin":
        return RedirectResponse("/login", status_code=303)
    row = db.get_credential(cred_id)
    if not row:
        return RedirectResponse("/keys", status_code=303)
    try:
        json.loads(payload)
    except Exception:
        return RedirectResponse(f"/keys/{cred_id}", status_code=303)
    db.update_credential(cred_id, crypto.encrypt(payload), user["name"])
    db.record_key_access(user["id"], user["username"], row["platform"], cred_id, "update", _ip(request))
    return RedirectResponse("/keys?msg=✅ 인증키가 수정되었습니다.", status_code=303)


@app.post("/keys/{cred_id}/delete")
def keys_delete(request: Request, cred_id: int):
    user = current_user(request)
    if not user or user["role"] != "admin":
        return RedirectResponse("/login", status_code=303)
    row = db.get_credential(cred_id)
    if row:
        db.delete_credential(cred_id)
        db.record_key_access(user["id"], user["username"], row["platform"], cred_id, "delete", _ip(request))
    return RedirectResponse("/keys?msg=🗑 인증키가 삭제되었습니다.", status_code=303)


# ── 로그인 로그 ──────────────────────────────────────────────
@app.get("/logs", response_class=HTMLResponse)
def logs_page(request: Request):
    user = current_user(request)
    if not user:
        return RedirectResponse("/login", status_code=303)
    return render("logs.html", user=user, logs=db.recent_logins(100))
