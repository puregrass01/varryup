# 로그인 없이 접근하는 공개 경로.
#
#   GET /privacy          eBay 개발자 등록에 넣는 개인정보처리방침 (OAuth 신청 필수값)
#   GET /updates/{파일}    electron-updater 가 받아가는 자동 업데이트 파일
#
# 둘 다 인증을 걸 수 없다. eBay 는 심사 중 /privacy 를 익명으로 열어보고,
# electron-updater 는 설치된 앱이 로그인 전에 호출한다.
# 대신 /updates 는 파일명 화이트리스트로 잠그고, 선택적으로 토큰을 요구한다.
import os
import re
from pathlib import Path

from fastapi import APIRouter, Header, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse

router = APIRouter()

UPDATES_DIR = Path(os.environ.get("UPDATE_DIR") or (Path(__file__).parent / "updates")).resolve()

# 자동 업데이트에 실제로 필요한 파일만 내보낸다.
#   latest.yml / *.exe / *.exe.blockmap
_ALLOWED = re.compile(r"^(latest(-[a-z0-9]+)?\.yml|[A-Za-z0-9 ._-]+\.exe(\.blockmap)?)$")

# UPDATE_TOKEN 이 설정돼 있으면 X-Update-Token 헤더가 일치해야 내려준다.
# 설정하지 않으면 누구나 받을 수 있다(기본값) — 설치본에 회사 공용 로그인이
# 들어가므로, 운영에서는 토큰을 켜는 편이 낫다.
UPDATE_TOKEN = os.environ.get("UPDATE_TOKEN") or ""


@router.get("/updates/{filename}")
def update_file(filename: str, x_update_token: str = Header(default="")):
    if UPDATE_TOKEN and x_update_token != UPDATE_TOKEN:
        return JSONResponse({"error": "unauthorized"}, status_code=401)
    if not _ALLOWED.match(filename):
        return JSONResponse({"error": "not found"}, status_code=404)
    path = (UPDATES_DIR / filename).resolve()
    # resolve() 후 경로가 UPDATES_DIR 밖이면 거부 (경로 탈출 방지)
    if UPDATES_DIR not in path.parents or not path.is_file():
        return JSONResponse({"error": "not found"}, status_code=404)
    return FileResponse(path, filename=filename)


@router.get("/updates/")
@router.get("/updates")
def update_index():
    """디렉터리 목록은 내보내지 않는다. 배포 상태 확인용 요약만 돌려준다."""
    if not UPDATES_DIR.is_dir():
        return JSONResponse({"ready": False, "reason": "updates 폴더가 없습니다", "dir": str(UPDATES_DIR)})
    names = sorted(p.name for p in UPDATES_DIR.iterdir() if p.is_file() and _ALLOWED.match(p.name))
    return JSONResponse({
        "ready": "latest.yml" in names,
        "files": len(names),
        "tokenRequired": bool(UPDATE_TOKEN),
    })


# ── 개인정보처리방침 ──────────────────────────────────────────
# eBay·아마존 개발자 등록에 제출하는 페이지. 아래 [[ ]] 부분은 회사 정보로
# 채워야 한다 — 비워 둔 채 심사에 넣으면 반려된다.
COMPANY_NAME = os.environ.get("COMPANY_NAME") or "[[회사명]]"
CONTACT_EMAIL = os.environ.get("CONTACT_EMAIL") or "[[담당자 이메일]]"
RETENTION = os.environ.get("DATA_RETENTION") or "[[보관 기간]]"

_PRIVACY = """<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>개인정보처리방침 · VERY UP</title>
<style>
 body{{max-width:760px;margin:0 auto;padding:40px 20px 80px;background:#fff;color:#1a1d21;
      font:15px/1.7 "Malgun Gothic",system-ui,sans-serif}}
 h1{{font-size:26px;margin:0 0 6px}} h2{{font-size:17px;margin:32px 0 8px}}
 .sub{{color:#6b7578;margin:0 0 28px}} ul{{padding-left:20px}} li{{margin:5px 0}}
 table{{border-collapse:collapse;width:100%;margin-top:8px}}
 th,td{{border:1px solid #d8dcdb;padding:8px 10px;text-align:left;font-size:14px;vertical-align:top}}
 th{{background:#f2f4f3;font-weight:600}}
 footer{{margin-top:40px;padding-top:14px;border-top:1px solid #d8dcdb;color:#6b7578;font-size:13px}}
</style></head><body>
<h1>개인정보처리방침</h1>
<p class="sub">VERY UP — 상품 등록 자동화 도구 · {company}</p>

<h2>1. 이 도구가 하는 일</h2>
<p>VERY UP 은 {company} 직원이 자사 상품을 여러 오픈마켓에 등록·수정하기 위해
쓰는 사내 도구입니다. 일반 소비자에게 배포되지 않으며, 구매자의 개인정보를
수집하거나 저장하지 않습니다.</p>

<h2>2. 처리하는 정보</h2>
<table>
<tr><th>항목</th><th>목적</th><th>보관 위치</th></tr>
<tr><td>오픈마켓 판매자 계정 인증키<br>(API 키·토큰·세션)</td><td>판매자 본인의 상품 등록·수정 API 호출</td><td>서버에 암호화 저장</td></tr>
<tr><td>직원 로그인 기록<br>(아이디·접속 IP·시각)</td><td>사내 접근 통제 및 감사</td><td>서버 데이터베이스</td></tr>
<tr><td>인증키 열람·변경 기록</td><td>인증키 오·남용 추적</td><td>서버 데이터베이스</td></tr>
</table>

<h2>3. 제3자 제공</h2>
<p>수집한 정보를 제3자에게 판매하거나 제공하지 않습니다. 오픈마켓
(eBay·Amazon·쿠팡·네이버·아임웹)에 대한 요청은 판매자 본인 계정의 상품을
등록·수정하기 위한 것이며, 해당 마켓의 API 규약을 따릅니다.</p>

<h2>4. 보관 및 파기</h2>
<p>인증키는 판매자가 삭제를 요청하거나 계정 연동을 해제하면 즉시 파기합니다.
접근 기록은 {retention} 보관 후 파기합니다.</p>

<h2>5. eBay 계정 삭제·폐쇄 알림</h2>
<p>eBay 로부터 계정 삭제·폐쇄 알림(Marketplace Account Deletion)을 받으면,
해당 계정과 연결된 인증키와 관련 기록을 지체 없이 삭제합니다.
알림 수신 주소는 <code>/ebay/deletion</code> 입니다.</p>

<h2>6. 문의</h2>
<p>개인정보 열람·정정·삭제 요청은 <a href="mailto:{email}">{email}</a> 로 보내주세요.</p>

<footer>{company} · 본 방침은 사내 도구 VERY UP 에 적용됩니다.</footer>
</body></html>"""


@router.get("/privacy", response_class=HTMLResponse)
def privacy(request: Request):
    return HTMLResponse(_PRIVACY.format(
        company=COMPANY_NAME, email=CONTACT_EMAIL, retention=RETENTION))
