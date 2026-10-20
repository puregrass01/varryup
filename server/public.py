# 로그인 없이 접근하는 경로 모음.
#
# 이 파일은 라우터를 **두 개**로 나눠 내보낸다. 프로세스 분리(공개/내부) 결정에 따른 것이다.
#
#   public_router   — 인터넷에 열리는 공개 프로세스가 include 한다.
#                     GET /privacy, GET /privacy/en, GET /ebay/auth/accepted|declined
#                     admin.db·KEY_MASTER·ADMIN_SECRET·세션을 전혀 쓰지 않는다.
#   internal_router — WireGuard 인터페이스에만 바인드되는 내부 프로세스가 include 한다.
#                     GET /updates, GET /updates/{파일}
#                     직원은 사무실 안에서만 앱을 쓰므로 자동 업데이트도 내부에 둔다.
#
# eBay 는 심사 중 /privacy 를 익명으로 열어보므로 공개 라우터에는 인증을 걸 수 없다.
# 대신 /updates 는 (a) 내부 프로세스로 옮기고 (b) UPDATE_TOKEN 미설정이면 라우트를
# 아예 등록하지 않는다. 이전 동작(토큰 없으면 무인증 공개)은 사내 빌드 전체가
# 인터넷에 열려 있다는 뜻이었다.
#
# ── 하위 호환 주의 ───────────────────────────────────────────
#  * 기존 진입점이 쓰던 `router` 는 두 라우터를 합친 형태로 계속 제공한다(파일 하단).
#    단일 프로세스로 돌리는 구버전 app.py 는 수정 없이 그대로 동작한다.
#  * COMPANY_NAME / CONTACT_EMAIL / DATA_RETENTION 중 하나라도 플레이스홀더면
#    **임포트 시점에 RuntimeError 로 기동을 실패시킨다.** 환경변수를 주지 않고 돌리던
#    개발 환경은 이제 서버가 뜨지 않는다 — README/운영 체크리스트 참고.
import logging
import os
import re
import secrets
from pathlib import Path

from fastapi import APIRouter, Header
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse

log = logging.getLogger("veryup.public")

public_router = APIRouter()
internal_router = APIRouter()


# ══════════════════════════════════════════════════════════════
#  자동 업데이트 (내부 전용)
# ══════════════════════════════════════════════════════════════
UPDATES_DIR = Path(os.environ.get("UPDATE_DIR") or (Path(__file__).parent / "updates")).resolve()

# 자동 업데이트에 실제로 필요한 파일만 내보낸다.
#   latest.yml / *.exe / *.exe.blockmap
# 문자 클래스에 / 와 \ 가 없으므로 정규식 단계에서 이미 경로 구분자를 막지만,
# 방어는 아래 _safe_update_path() 의 resolve() 검사까지 두 겹으로 둔다.
_ALLOWED = re.compile(r"^(latest(-[a-z0-9]+)?\.yml|[A-Za-z0-9 ._-]+\.exe(\.blockmap)?)$")

# UPDATE_TOKEN 이 없으면 /updates 라우트를 등록하지 않는다(= 404).
# 왜 '옵셔널'이 아니라 '필수'인가: 설치본(.exe)에는 asar 미적용 사내 소스가 그대로
# 들어 있어, 무인증 공개는 내부 시스템 구조를 통째로 내주는 것과 같다.
#
# 켤 때는 반드시 양쪽을 같이 맞춰야 한다 — 서버의 UPDATE_TOKEN 과
# Electron 클라이언트가 requestHeaders 로 보내는 같은 값의 환경변수
# (src/main_process.js:520 process.env.UPDATE_TOKEN).
# 한쪽만 설정하면 자동 업데이트가 조용히 401 로 막혀 전원이 업데이트를
# 받지 못한다(앱에는 오류가 잘 드러나지 않는다).
UPDATE_TOKEN = os.environ.get("UPDATE_TOKEN") or ""


def _safe_update_path(filename: str):
    """UPDATES_DIR 안의 실제 파일이면 Path, 아니면 None.

    resolve() 이후에 UPDATES_DIR 하위인지 확인한다 — 심볼릭 링크나
    ..\\ 조합으로 디렉터리를 벗어나는 경우를 여기서 잘라낸다.
    (Path.parents 검사만으로는 UPDATES_DIR 자신이 심링크일 때 어긋날 수 있다)
    """
    if not filename or "/" in filename or "\\" in filename or "\x00" in filename:
        return None
    if not _ALLOWED.match(filename):
        return None
    try:
        path = (UPDATES_DIR / filename).resolve()
        path.relative_to(UPDATES_DIR)   # 하위가 아니면 ValueError
    except (ValueError, OSError):
        return None
    if not path.is_file():
        return None
    return path


def _token_ok(given: str) -> bool:
    """업데이트 토큰 비교 — 길이·내용에 따라 걸리는 시간이 달라지지 않게 한다.

    왜 `!=` 가 아닌가: 파이썬 문자열 비교는 첫 불일치 바이트에서 멈추므로
    응답 시간으로 토큰을 한 바이트씩 맞춰 나갈 여지가 남는다. db.verify_password 가
    이미 secrets.compare_digest 를 쓰고 있어 일관성 문제이기도 하다.
    compare_digest 는 str 에 비ASCII 가 섞이면 TypeError 를 내므로 bytes 로 맞춰 넘긴다.
    """
    return secrets.compare_digest(
        (given or "").encode("utf-8"), UPDATE_TOKEN.encode("utf-8")
    )


if UPDATE_TOKEN:
    @internal_router.get("/updates/{filename}")
    def update_file(filename: str, x_update_token: str = Header(default="")):
        if not _token_ok(x_update_token):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        path = _safe_update_path(filename)
        if path is None:
            # 존재 여부를 구분해 주지 않는다(파일명 탐색 방지).
            return JSONResponse({"error": "not found"}, status_code=404)
        return FileResponse(path, filename=filename)

    @internal_router.get("/updates/")
    @internal_router.get("/updates")
    def update_index(x_update_token: str = Header(default="")):
        """디렉터리 목록은 내보내지 않는다. 배포 상태 확인용 요약만 돌려준다."""
        # 요약이라도 배포 여부·파일 수가 드러나므로 파일 내려받기와 같은 토큰을 요구한다.
        if not _token_ok(x_update_token):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        if not UPDATES_DIR.is_dir():
            return JSONResponse({"ready": False, "reason": "updates 폴더가 없습니다", "dir": str(UPDATES_DIR)})
        names = sorted(p.name for p in UPDATES_DIR.iterdir() if p.is_file() and _ALLOWED.match(p.name))
        return JSONResponse({
            "ready": "latest.yml" in names,
            "files": len(names),
            "tokenRequired": True,
        })
else:
    # 라우트를 등록하지 않았다는 사실을 기동 로그에 남긴다 —
    # "업데이트가 404 난다"는 문의가 왔을 때 여기부터 보면 된다.
    log.warning(
        "UPDATE_TOKEN 미설정 → /updates 라우트를 등록하지 않았습니다. "
        "자동 업데이트를 쓰려면 서버 UPDATE_TOKEN 과 Electron 클라이언트의 "
        "UPDATE_TOKEN(requestHeaders)을 같은 값으로 함께 설정하세요."
    )


# ══════════════════════════════════════════════════════════════
#  개인정보처리방침 (공개)
# ══════════════════════════════════════════════════════════════
# eBay·아마존 개발자 등록에 제출하는 페이지.
# 플레이스홀더가 남은 채로 심사에 들어가면 즉시 반려되므로, 값이 채워지지
# 않았으면 서버를 아예 띄우지 않는다(아래 _require 참조).
_PLACEHOLDER = "[["

COMPANY_NAME = os.environ.get("COMPANY_NAME") or "[[회사명]]"
CONTACT_EMAIL = os.environ.get("CONTACT_EMAIL") or "[[담당자 이메일]]"
RETENTION = os.environ.get("DATA_RETENTION") or "[[보관 기간]]"

# PIPA 필수 기재사항용 보조 값. 미설정이어도 기동은 되지만(문서 품질 문제이지
# 법적 공백은 위 3개에서 생긴다) 운영 전 채우는 것을 권장한다.
COMPANY_NAME_EN = os.environ.get("COMPANY_NAME_EN") or COMPANY_NAME
RETENTION_EN = os.environ.get("DATA_RETENTION_EN") or RETENTION
PRIVACY_OFFICER = os.environ.get("PRIVACY_OFFICER") or "개인정보 보호책임자"
PRIVACY_OFFICER_EN = os.environ.get("PRIVACY_OFFICER_EN") or "Data Protection Officer"
EFFECTIVE_DATE = os.environ.get("PRIVACY_EFFECTIVE_DATE") or "2026-09-16"
REVISED_DATE = os.environ.get("PRIVACY_REVISED_DATE") or EFFECTIVE_DATE


def _require_privacy_config():
    """플레이스홀더가 남아 있으면 기동을 실패시킨다.

    왜 임포트 시점인가: privacy() 안에서 503 을 돌려주면 서버는 '정상'으로 뜨고,
    담당자가 그 사실을 모른 채 eBay 에 URL 을 제출할 수 있다. 기동을 막으면
    배포 즉시 드러난다.
    """
    missing = [
        name for name, value in (
            ("COMPANY_NAME", COMPANY_NAME),
            ("CONTACT_EMAIL", CONTACT_EMAIL),
            ("DATA_RETENTION", RETENTION),
        )
        if not value or value.startswith(_PLACEHOLDER)
    ]
    if missing:
        raise RuntimeError(
            "개인정보처리방침 환경변수가 비어 있습니다: " + ", ".join(missing) +
            " — 플레이스홀더가 박힌 /privacy 는 eBay 심사에서 즉시 반려되므로 "
            "서버를 기동하지 않습니다. 예) COMPANY_NAME='주식회사 OO' "
            "CONTACT_EMAIL='privacy@example.com' DATA_RETENTION='1년'"
        )


_require_privacy_config()


_STYLE = """
 body{max-width:820px;margin:0 auto;padding:40px 20px 80px;background:#fff;color:#1a1d21;
      font:15px/1.7 "Malgun Gothic",system-ui,sans-serif}
 h1{font-size:26px;margin:0 0 6px} h2{font-size:17px;margin:32px 0 8px}
 .sub{color:#6b7578;margin:0 0 10px} .meta{color:#6b7578;font-size:13px;margin:0 0 28px}
 ul{padding-left:20px} li{margin:5px 0}
 table{border-collapse:collapse;width:100%;margin-top:8px}
 th,td{border:1px solid #d8dcdb;padding:8px 10px;text-align:left;font-size:14px;vertical-align:top}
 th{background:#f2f4f3;font-weight:600}
 .lang{float:right;font-size:13px}
 footer{margin-top:40px;padding-top:14px;border-top:1px solid #d8dcdb;color:#6b7578;font-size:13px}
"""

# 표 항목은 실제 스키마와 1:1 로 맞춘다.
#   db.py          platform_credentials / login_logs / key_access_logs / ai_usage / licenses
#                  (staff 는 직원 계정 자체라 2항의 '로그인 기록' 줄에 함께 설명된다)
#   ebay_queue.py  pending_deletions — eBay userId·username 을 보관하므로 방침에도 적는다.
#                  rejections 는 개인정보가 아니라 거절 사유·IP 지문뿐이라 표에 넣지 않는다.
# 스키마를 바꾸면 이 표도 같이 고쳐야 한다. 특히 7항(30일 이내 삭제)은 실제 승인 흐름과
# 맞물려 있으니, 큐 승인 절차를 바꾸면 방침 문구도 같이 확인할 것.
_PRIVACY_KO = """<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>개인정보처리방침 · VERY UP</title>
<style>{style}</style></head><body>
<p class="lang"><a href="/privacy/en">English</a></p>
<h1>개인정보처리방침</h1>
<p class="sub">VERY UP — 상품 등록 자동화 도구 · {company}</p>
<p class="meta">시행일자: {effective} · 최종 개정일: {revised}</p>

<h2>1. 이 도구가 하는 일과 처리 목적</h2>
<p>VERY UP 은 {company} 직원이 자사 상품을 여러 오픈마켓에 등록·수정하기 위해
쓰는 사내 도구입니다. 일반 소비자에게 배포되지 않으며, 구매자(오픈마켓 이용자)의
개인정보를 수집하거나 저장하지 않습니다. 개인정보는 사내 접근 통제, 인증키 오·남용
추적, 사용량 관리 목적으로만 처리합니다.</p>

<h2>2. 처리하는 개인정보 항목</h2>
<table>
<tr><th>항목</th><th>목적</th><th>보관 위치</th><th>보유 기간</th></tr>
<tr><td>오픈마켓 판매자 계정 인증키<br>(API 키·시크릿·토큰·세션)</td>
    <td>판매자 본인 계정의 상품 등록·수정 API 호출</td>
    <td>서버 데이터베이스(암호화 저장)</td>
    <td>연동 해제·삭제 요청 시 즉시 파기</td></tr>
<tr><td>직원 계정 정보<br>(아이디·이름·권한·비밀번호 해시·생성 시각)</td>
    <td>사내 도구 로그인 및 권한 관리</td><td>서버 데이터베이스</td>
    <td>퇴사·계정 삭제 시 즉시 파기</td></tr>
<tr><td>직원 로그인 기록<br>(아이디·접속 IP·성공/실패·시각)</td>
    <td>사내 접근 통제 및 감사</td><td>서버 데이터베이스</td><td>{retention}</td></tr>
<tr><td>인증키 열람·생성·변경·삭제 기록<br>(아이디·대상 마켓·접속 IP·시각)</td>
    <td>인증키 오·남용 추적</td><td>서버 데이터베이스</td><td>{retention}</td></tr>
<tr><td>AI 기능 사용 기록<br>(아이디·호출 기능·처리 시간·시각)</td>
    <td>사용량 집계 및 장애 대응</td><td>서버 데이터베이스</td><td>{retention}</td></tr>
<tr><td>라이선스 배정 메모<br>(배정 대상 표기·좌석 수·만료일)</td>
    <td>사내 라이선스 관리</td><td>서버 데이터베이스</td>
    <td>라이선스 삭제 시 즉시 파기</td></tr>
<tr><td>eBay 계정 삭제 알림 접수 기록<br>(eBay 사용자 식별자(userId)·사용자명(username)·알림 ID·수신 시각·발신 IP)</td>
    <td>eBay 계정 삭제·폐쇄 요청의 접수 확인과 이행 증빙</td>
    <td>서버 파일(인증키 금고와 분리된 별도 저장소)</td>
    <td>이행 또는 기각 처리 후 증빙 목적으로 {retention} 보관 후 파기</td></tr>
</table>
<p>주민등록번호 등 고유식별정보와 민감정보는 수집하지 않습니다.</p>

<h2>3. 제3자 제공 및 처리위탁</h2>
<p>수집한 정보를 제3자에게 판매하거나 제공하지 않습니다. 오픈마켓
(eBay·Amazon·쿠팡·네이버·아임웹)에 대한 요청은 판매자 본인 계정의 상품을
등록·수정하기 위한 것이며, 해당 마켓의 API 규약을 따릅니다. 별도의
개인정보 처리위탁은 없습니다.</p>

<h2>4. 보유 및 파기</h2>
<p>인증키는 판매자가 삭제를 요청하거나 계정 연동을 해제하면 즉시 파기합니다.
eBay 계정 삭제·폐쇄 알림으로 접수된 건은 아래 7항의 절차에 따라 <b>접수일로부터 30일
이내</b>에 파기합니다. 로그인·인증키 접근·AI 사용 기록과 삭제 알림 접수 기록은
{retention} 보관 후 파기합니다. 전자적 파일은 복구할 수 없는 방법으로 삭제합니다.</p>

<h2>5. 안전성 확보 조치</h2>
<ul>
 <li>오픈마켓 인증키는 암호화하여 저장합니다.</li>
 <li>관리 화면은 사내망(VPN) 에서만 접근할 수 있으며, 인터넷에서 도달할 수 없습니다.</li>
 <li>직원 비밀번호는 복호화가 불가능한 방식으로 저장합니다.</li>
 <li>인증키 열람·변경은 전 건 기록으로 남깁니다.</li>
</ul>

<h2>6. 정보주체의 권리와 행사 방법</h2>
<p>정보주체는 언제든지 개인정보의 <b>열람·정정·삭제·처리정지</b>를 요구할 수 있습니다.
요구는 <a href="mailto:{email}">{email}</a> 로 서면·전자우편으로 접수하며,
접수일로부터 10일 이내에 처리 결과를 알려드립니다. 대리인을 통해 요구할 때에는
위임장을 함께 제출해 주셔야 합니다.</p>

<h2>7. eBay 계정 삭제·폐쇄 알림</h2>
<p>eBay 로부터 계정 삭제·폐쇄 알림(Marketplace Account Deletion)을 받으면 알림의 서명을
검증한 뒤 <b>즉시 접수</b>하고, 담당자가 대상 계정을 확인하는 절차를 거쳐 해당 계정과
연결된 인증키 및 관련 기록을 <b>eBay 정책이 정한 기한인 접수일로부터 30일 이내</b>에
삭제합니다. 알림 수신 주소는 <code>/ebay/deletion</code> 입니다.</p>
<p>확인 절차를 두는 이유는 인터넷에 열린 수신 경로가 사람의 확인 없이 인증키를 곧바로
파기하지 못하게 하기 위함입니다 — 위조된 알림 한 건으로 되돌릴 수 없는 삭제가
일어나지 않도록, 수신 서버에는 인증키를 삭제할 권한 자체가 없습니다.
접수된 알림은 위 2항에 적은 항목만 별도 저장소에 기록하며, 이행 결과는 이행 증빙으로
보관합니다.</p>

<h2>8. 개인정보 보호책임자</h2>
<p>{officer} · 연락처 <a href="mailto:{email}">{email}</a><br>
개인정보 처리에 관한 문의·불만·피해구제는 위 연락처로 접수해 주십시오.</p>

<h2>9. 권익침해 구제 방법</h2>
<ul>
 <li>개인정보분쟁조정위원회 — 1833-6972 · www.kopico.go.kr</li>
 <li>개인정보침해신고센터 — 118 · privacy.kisa.or.kr</li>
 <li>대검찰청 사이버수사과 — 1301 · 경찰청 사이버수사국 — 182</li>
</ul>

<h2>10. 방침의 변경</h2>
<p>이 방침의 내용이 추가·삭제·수정될 때에는 변경 사항의 시행 7일 전부터
이 페이지를 통해 공지합니다.</p>

<footer>{company} · 본 방침은 사내 도구 VERY UP 에 적용됩니다. ·
시행일자 {effective} / 최종 개정일 {revised}</footer>
</body></html>"""


# eBay 심사관은 영어권이다. 개발자 포털에는 이 영문 URL(/privacy/en) 을 제출한다.
_PRIVACY_EN = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Privacy Policy · VERY UP</title>
<style>{style}</style></head><body>
<p class="lang"><a href="/privacy">&#54620;&#44397;&#50612;</a></p>
<h1>Privacy Policy</h1>
<p class="sub">VERY UP — internal product-listing automation tool · {company_en}</p>
<p class="meta">Effective date: {effective} · Last updated: {revised}</p>

<h2>1. What this tool does</h2>
<p>VERY UP is an internal tool used by employees of {company_en} to create and update
the company's own product listings across several online marketplaces. It is not
distributed to consumers, and it does not collect or store personal information of
marketplace buyers. Personal data is processed solely for internal access control,
detection of credential misuse, and usage accounting.</p>

<h2>2. Personal data we process</h2>
<table>
<tr><th>Data</th><th>Purpose</th><th>Where stored</th><th>Retention</th></tr>
<tr><td>Marketplace seller credentials<br>(API keys, secrets, tokens, sessions)</td>
    <td>Calling listing APIs on the seller's own account</td>
    <td>Server database (encrypted at rest)</td>
    <td>Destroyed immediately on disconnect or deletion request</td></tr>
<tr><td>Employee account records<br>(user ID, name, role, password hash, creation time)</td>
    <td>Sign-in to the internal tool and role management</td><td>Server database</td>
    <td>Destroyed when the employee leaves or the account is deleted</td></tr>
<tr><td>Employee sign-in records<br>(user ID, IP address, success/failure, timestamp)</td>
    <td>Internal access control and audit</td><td>Server database</td><td>{retention_en}</td></tr>
<tr><td>Credential access records<br>(user ID, marketplace, action, IP address, timestamp)</td>
    <td>Tracing misuse of credentials</td><td>Server database</td><td>{retention_en}</td></tr>
<tr><td>AI feature usage records<br>(user ID, endpoint, elapsed time, timestamp)</td>
    <td>Usage accounting and incident response</td><td>Server database</td><td>{retention_en}</td></tr>
<tr><td>License assignment notes<br>(assignee label, seats, expiry)</td>
    <td>Internal license management</td><td>Server database</td>
    <td>Destroyed when the license record is deleted</td></tr>
<tr><td>eBay account deletion notifications received<br>(eBay userId, username, notification ID, receipt time, source IP)</td>
    <td>Acknowledging eBay account deletion/closure requests and evidencing fulfilment</td>
    <td>Server file store, separate from the credential vault</td>
    <td>Retained as fulfilment evidence for {retention_en} after the request is fulfilled or dismissed, then destroyed</td></tr>
</table>
<p>We do not collect national identification numbers or any sensitive category of data.</p>

<h2>3. Disclosure to third parties and processors</h2>
<p>We do not sell or otherwise disclose this data to third parties. Requests sent to
marketplaces (eBay, Amazon, Coupang, Naver, Imweb) exist only to create and update
listings on the seller's own account, in accordance with each marketplace's API terms.
No processing is outsourced to a third-party processor.</p>

<h2>4. Retention and destruction</h2>
<p>Credentials are destroyed immediately when the seller requests deletion or disconnects
the account. Data covered by an eBay account deletion/closure notification is destroyed
<b>within 30 days of receipt</b> through the procedure described in section 7 below.
Sign-in, credential-access, AI-usage and deletion-notification records are retained for
{retention_en} and then destroyed irrecoverably.</p>

<h2>5. Security measures</h2>
<ul>
 <li>Marketplace credentials are encrypted at rest.</li>
 <li>The administration interface is reachable only from the company network (VPN);
     it is not exposed to the internet.</li>
 <li>Employee passwords are stored in a non-reversible form.</li>
 <li>Every credential view or change is recorded.</li>
</ul>

<h2>6. Your rights and how to exercise them</h2>
<p>You may at any time request <b>access, correction, deletion, or suspension of
processing</b> of your personal data. Send the request to
<a href="mailto:{email}">{email}</a>; we respond within 10 days of receipt.
A request made through a representative must include a letter of authorization.</p>

<h2>7. eBay Marketplace Account Deletion</h2>
<p>When we receive an eBay Marketplace Account Deletion/Closure notification, we verify its
signature and <b>acknowledge it immediately</b>. A staff member then confirms the account
concerned, and the credentials and related records associated with that account are
deleted <b>within 30 days of receipt</b>, the deadline set by eBay's Marketplace Account
Deletion policy. Our notification endpoint is <code>/ebay/deletion</code>.</p>
<p>The confirmation step exists so that an internet-facing endpoint can never destroy
credentials without a human check: the server that receives notifications has no ability
to delete credentials at all. A received notification is recorded with only the fields
listed in section 2 above, in a store separate from the credential vault, and the outcome
is kept as evidence of fulfilment.</p>

<h2>8. Data protection officer</h2>
<p>{officer_en} · <a href="mailto:{email}">{email}</a><br>
Please direct any inquiry, complaint, or remedy request regarding personal data
to the address above.</p>

<h2>9. Remedies (Republic of Korea)</h2>
<ul>
 <li>Personal Information Dispute Mediation Committee — +82-1833-6972 · www.kopico.go.kr</li>
 <li>Privacy Infringement Report Center (KISA) — 118 · privacy.kisa.or.kr</li>
 <li>Supreme Prosecutors' Office Cybercrime Division — 1301 · National Police Agency — 182</li>
</ul>

<h2>10. Changes to this policy</h2>
<p>Any addition, deletion, or amendment to this policy is announced on this page at
least 7 days before it takes effect.</p>

<footer>{company_en} · This policy applies to the internal tool VERY UP. ·
Effective {effective} / last updated {revised}</footer>
</body></html>"""


def _render(template: str) -> str:
    return template.format(
        style=_STYLE,
        company=COMPANY_NAME,
        company_en=COMPANY_NAME_EN,
        email=CONTACT_EMAIL,
        retention=RETENTION,
        retention_en=RETENTION_EN,
        officer=PRIVACY_OFFICER,
        officer_en=PRIVACY_OFFICER_EN,
        effective=EFFECTIVE_DATE,
        revised=REVISED_DATE,
    )


@public_router.get("/privacy", response_class=HTMLResponse)
def privacy(lang: str = ""):
    # ?lang=en 도 받는다 — eBay 포털에 어느 형태를 제출했든 영문이 나오도록.
    if lang.lower().startswith("en"):
        return HTMLResponse(_render(_PRIVACY_EN))
    return HTMLResponse(_render(_PRIVACY_KO))


@public_router.get("/privacy/en", response_class=HTMLResponse)
def privacy_en():
    """eBay 개발자 포털에 제출하는 영문본 URL."""
    return HTMLResponse(_render(_PRIVACY_EN))


# ══════════════════════════════════════════════════════════════
#  eBay OAuth 동의 착지 페이지 (공개)
# ══════════════════════════════════════════════════════════════
# 앱은 동의 완료 페이지의 "전체 주소"를 붙여넣는 방식(src/platforms/ebay.js)이라
# 서버가 code 를 받아 처리할 필요가 없다. 필요한 것은 단 하나 —
# 리디렉션 없이 쿼리스트링을 그대로 보여주는 공개 페이지.
# /login 은 로그인 상태에서 303 으로 튕기며 ?code= 를 날려버리므로 쓰면 안 된다.
#
# 주의: code 는 1회용·단시간 유효이지만 리버스 프록시 접근 로그에는 남는다.
# 서버에서는 기록하지 않는다.
_AUTH_LANDING = """<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>eBay 판매자 연결 · VERY UP</title>
<style>
 body{max-width:720px;margin:0 auto;padding:48px 20px;background:#fff;color:#1a1d21;
      font:15px/1.7 "Malgun Gothic",system-ui,sans-serif}
 h1{font-size:22px;margin:0 0 4px} .sub{color:#6b7578;margin:0 0 28px}
 .url{word-break:break-all;background:#f2f4f3;border:1px solid #d8dcdb;border-radius:6px;
      padding:14px;font:13px/1.6 Consolas,monospace;margin:0 0 12px}
 button{background:#1668c1;color:#fff;border:0;border-radius:6px;padding:11px 20px;
        font-size:15px;cursor:pointer} button:hover{background:#12539b}
 .ok{color:#137333;font-weight:600} .bad{color:#b3261e;font-weight:600}
 ol{padding-left:20px} li{margin:6px 0}
</style></head><body>
<h1>eBay 판매자 연결</h1>
<p class="sub" id="state"></p>
<div class="url" id="url"></div>
<button id="copy">전체 주소 복사</button>
<ol style="margin-top:28px">
  <li>위 버튼으로 주소를 복사합니다.</li>
  <li>VERY UP 앱의 <b>동의 완료 페이지 URL</b> 칸에 붙여넣습니다.</li>
  <li><b>연결 완료</b>를 누릅니다.</li>
</ol>
<p class="sub">인증 코드는 몇 분 안에 만료됩니다. 바로 진행하세요.</p>
<script>
 var href = location.href;
 var q = new URLSearchParams(location.search);
 var el = document.getElementById('state');
 if (q.get('code')) { el.innerHTML = '<span class="ok">동의가 완료되었습니다.</span> 아래 주소를 앱에 붙여넣으세요.'; }
 else if (q.get('error')) { el.innerHTML = '<span class="bad">동의가 거부되었거나 실패했습니다.</span> 앱에서 다시 시도하세요.'; }
 else { el.innerHTML = '<span class="bad">인증 코드가 없습니다.</span> 앱의 판매자 연결 버튼으로 시작했는지 확인하세요.'; }
 document.getElementById('url').textContent = href;
 document.getElementById('copy').onclick = function () {
   navigator.clipboard.writeText(href).then(function () {
     var b = document.getElementById('copy');
     b.textContent = '복사됨'; setTimeout(function () { b.textContent = '전체 주소 복사'; }, 1500);
   });
 };
</script>
</body></html>"""


@public_router.get("/ebay/auth/accepted", response_class=HTMLResponse)
@public_router.get("/ebay/auth/declined", response_class=HTMLResponse)
def ebay_auth_landing():
    return HTMLResponse(_AUTH_LANDING)


# ── 하위 호환 ────────────────────────────────────────────────
# 구버전 진입점(app.py 의 `app.include_router(public.router)`)을 위한 합본 라우터.
# 프로세스를 분리한 뒤에는 각 진입점이 public_router / internal_router 를
# 직접 골라 include 해야 한다. 합본을 쓰면 /updates 가 공개 프로세스에
# 딸려 들어가므로, 분리 완료 후 이 별칭은 제거할 것.
router = APIRouter()
router.include_router(public_router)
router.include_router(internal_router)
