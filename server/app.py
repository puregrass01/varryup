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
from fastapi import FastAPI, Request, Form, Header
from fastapi.responses import HTMLResponse, RedirectResponse, JSONResponse
from starlette.middleware.sessions import SessionMiddleware
from jinja2 import Environment, FileSystemLoader, select_autoescape
from itsdangerous import URLSafeTimedSerializer, BadSignature, SignatureExpired

import db
import crypto
import proxy
import ebay_notify

# 세션·API 토큰 서명에 쓰는 안정적인 비밀키 (재시작해도 동일)
APP_SECRET = os.environ.get("ADMIN_SECRET") or crypto.app_secret()
api_signer = URLSafeTimedSerializer(APP_SECRET, salt="app-api-token")
API_TOKEN_MAX_AGE = 60 * 60 * 24 * 7  # 7일


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
# 세션 서명 키(안정적 → 재시작에도 로그인 유지). 배포 시 환경변수 ADMIN_SECRET 로 덮어쓸 수 있다.
app.add_middleware(SessionMiddleware, secret_key=APP_SECRET)

db.init_db()

# 고정 IP 프록시 라우트 (POST /coupang, /naver, /amazon, /ebay + GET /proxy/health).
# 앱이 서명한 요청을 서버가 대신 전달해, 마켓플레이스에는 서버 IP 하나만 보이게 한다.
app.include_router(proxy.router)

# eBay 마켓플레이스 계정 삭제 알림 엔드포인트 (GET 검증 + POST 수신).
# eBay 가 인증 없이 직접 부르므로 프록시와 경로를 분리해 둔다.
app.include_router(ebay_notify.router)


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


@app.post("/staff/{staff_id}/reset-password")
def staff_reset_password(request: Request, staff_id: int, new_password: str = Form(...)):
    # 관리자가 직원 비밀번호를 재설정(초기화)한다. 현재 비번 몰라도 됨.
    user = current_user(request)
    if not user or user["role"] != "admin":
        return RedirectResponse("/login", status_code=303)
    if len(new_password) < 6:
        return RedirectResponse("/staff?msg=❌ 비밀번호는 6자 이상이어야 합니다.", status_code=303)
    target = db.get_staff_by_id(staff_id)
    if not target:
        return RedirectResponse("/staff", status_code=303)
    db.update_password(staff_id, new_password)
    return RedirectResponse(f"/staff?msg=✅ {target['name']} 님의 비밀번호가 변경되었습니다.", status_code=303)


# ── 인증키 중앙보관 (암호화 + 감사로그) ───────────────────────
PLATFORM_HINTS = {
    "coupang": '{\n  "vendorId": "",\n  "accessKey": "",\n  "secretKey": ""\n}',
    "naver": '{\n  "session": ""\n}',
    "esm": '{\n  "session": ""\n}',
    "imweb": '{\n  "clientId": "",\n  "clientSecret": ""\n}',
    # 이베이(Sell API): 앱은 clientSecret·refreshToken 을 OS 암호화 저장소에 다시 넣어 보관한다.
    "ebay": '{\n  "environment": "production",\n  "clientId": "",\n  "clientSecret": "",\n  "ruName": "",\n  "refreshToken": "",\n  "merchantLocationKey": "",\n  "fulfillmentPolicyId": "",\n  "paymentPolicyId": "",\n  "returnPolicyId": ""\n}',
    # 아마존(SP-API): sellerId·clientId·clientSecret·refreshToken 이 필수값.
    "amazon": '{\n  "sellerId": "",\n  "clientId": "",\n  "clientSecret": "",\n  "refreshToken": "",\n  "endpoint": "https://sellingpartnerapi-na.amazon.com",\n  "marketplaceId": "ATVPDKIKX0DER"\n}',
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


# ── 비밀번호 변경 (본인 계정) ─────────────────────────────────
@app.get("/password", response_class=HTMLResponse)
def password_page(request: Request, msg: str = None, err: str = None):
    user = current_user(request)
    if not user:
        return RedirectResponse("/login", status_code=303)
    return render("password.html", user=user, msg=msg, err=err)


@app.post("/password", response_class=HTMLResponse)
def password_change(request: Request, current: str = Form(...),
                    new1: str = Form(...), new2: str = Form(...)):
    user = current_user(request)
    if not user:
        return RedirectResponse("/login", status_code=303)
    if not db.verify_password(current, user["password_hash"]):
        return render("password.html", user=user, status_code=400,
                      err="현재 비밀번호가 올바르지 않습니다.")
    if new1 != new2:
        return render("password.html", user=user, status_code=400,
                      err="새 비밀번호 두 개가 서로 다릅니다.")
    if len(new1) < 6:
        return render("password.html", user=user, status_code=400,
                      err="새 비밀번호는 6자 이상이어야 합니다.")
    db.update_password(user["id"], new1)
    return render("password.html", user=user, msg="✅ 비밀번호가 변경되었습니다.")


# ── 로그인 로그 ──────────────────────────────────────────────
@app.get("/logs", response_class=HTMLResponse)
def logs_page(request: Request):
    user = current_user(request)
    if not user:
        return RedirectResponse("/login", status_code=303)
    return render("logs.html", user=user, logs=db.recent_logins(100))


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
    if user["role"] != "admin":
        return RedirectResponse("/", status_code=303)
    return render("licenses.html", user=user, licenses=db.list_licenses(), msg=msg)


@app.post("/licenses/add")
def licenses_add(request: Request, key: str = Form(""), seats: int = Form(1),
                 assigned_to: str = Form(""), expires_at: str = Form("")):
    user = current_user(request)
    if not user or user["role"] != "admin":
        return RedirectResponse("/login", status_code=303)
    key = (key or "").strip() or _gen_license_key()
    try:
        db.add_license(key, seats, assigned_to.strip(), expires_at.strip())
        return RedirectResponse(f"/licenses?msg=✅ 라이선스 발급: {key}", status_code=303)
    except Exception as e:
        return RedirectResponse(f"/licenses?msg=발급 실패: {e}", status_code=303)


@app.post("/licenses/{license_id}/toggle")
def licenses_toggle(request: Request, license_id: int):
    user = current_user(request)
    if not user or user["role"] != "admin":
        return RedirectResponse("/login", status_code=303)
    rows = [l for l in db.list_licenses() if l["id"] == license_id]
    if rows:
        new_status = "blocked" if rows[0]["status"] == "active" else "active"
        db.set_license_status(license_id, new_status)
    return RedirectResponse("/licenses", status_code=303)


@app.post("/licenses/{license_id}/delete")
def licenses_delete(request: Request, license_id: int):
    user = current_user(request)
    if not user or user["role"] != "admin":
        return RedirectResponse("/login", status_code=303)
    db.delete_license(license_id)
    return RedirectResponse("/licenses?msg=🗑 라이선스가 삭제되었습니다.", status_code=303)


# ── AI 사용량 통계 ────────────────────────────────────────────
@app.get("/usage", response_class=HTMLResponse)
def usage_page(request: Request):
    user = current_user(request)
    if not user:
        return RedirectResponse("/login", status_code=303)
    return render("usage.html", user=user,
                  summary=db.ai_usage_summary(), recent=db.recent_ai_usage(50))


# ══════════════════════════════════════════════════════════════
#  앱(프로그램)용 API — 앱이 서버에서 인증키를 받아쓰기 위한 통로
#  1) POST /api/login          : 직원 로그인 → 토큰 발급
#  2) GET  /api/credentials    : 토큰으로 인증키(복호화) 조회
# ══════════════════════════════════════════════════════════════
def _auth_by_token(authorization: str | None):
    """Authorization: Bearer <token> 헤더를 검증해 staff row 반환 (실패 시 None)."""
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
    return user


@app.post("/api/login")
def api_login(request: Request, username: str = Form(...), password: str = Form(...)):
    ip = _ip(request)
    user = db.get_staff_by_username(username)
    ok = user is not None and user["is_active"] == 1 and db.verify_password(password, user["password_hash"])
    if not ok:
        db.record_login(user["id"] if user else None, username, ip, "fail")
        return JSONResponse({"ok": False, "error": "로그인 실패"}, status_code=401)
    db.record_login(user["id"], username, ip, "success")
    token = api_signer.dumps({"uid": user["id"]})
    return {"ok": True, "token": token, "name": user["name"], "role": user["role"]}


@app.get("/api/credentials")
def api_credentials(request: Request, platform: str = None, authorization: str = Header(None)):
    """앱이 인증키를 받아가는 엔드포인트. platform 지정 시 해당 플랫폼만.
       반환: [{id, platform, label, data}]  (data = 복호화된 값)"""
    user = _auth_by_token(authorization)
    if not user:
        return JSONResponse({"ok": False, "error": "인증 필요(토큰 없음/만료)"}, status_code=401)
    result = []
    for c in db.list_credentials():
        if platform and c["platform"] != platform:
            continue
        row = db.get_credential(c["id"])
        try:
            data = json.loads(crypto.decrypt(row["enc_payload"]))
        except Exception:
            data = None
        result.append({"id": c["id"], "platform": c["platform"], "label": c["label"], "data": data})
        # 앱이 키를 가져간 것도 감사로그에 남긴다 (api 경유 열람)
        db.record_key_access(user["id"], user["username"], c["platform"], c["id"], "view", _ip(request) + " (앱)")
    return {"ok": True, "credentials": result}


@app.post("/api/usage")
def api_usage(request: Request, endpoint: str = Form("predict"),
              ms_elapsed: int = Form(0), authorization: str = Header(None)):
    """앱이 AI 이미지 1건 처리할 때마다 사용량을 기록한다."""
    user = _auth_by_token(authorization)
    if not user:
        return JSONResponse({"ok": False, "error": "인증 필요"}, status_code=401)
    db.record_ai_usage(user["id"], user["username"], endpoint, ms_elapsed)
    return {"ok": True}
