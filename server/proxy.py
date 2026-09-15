"""
고정 IP 프록시 — 직원 PC 대신 서버가 마켓플레이스 API 를 호출한다.

왜 필요한가
  쿠팡과 네이버 커머스API 는 '실제로 호출한 기기의 외부 IP' 를 허용목록으로 검사한다.
  직원 PC 에서 직접 부르면 사람마다 IP 를 등록해야 하고(네이버는 앱 하나당 최대 3개),
  유동 IP 면 매일 바뀌어 아침마다 깨진다. 서버가 대신 부르면 등록할 IP 는 서버 하나뿐이다.
  (배포_가이드.md 가 안내하는 "각 직원 PC 외부 IP 를 쿠팡에 등록" 수작업도 같이 없어진다.)

이 프록시가 하지 않는 것 — 중요
  서명하지 않는다. 앱이 이미 서명을 끝낸 요청(Authorization 헤더 포함)을 그대로 전달만 한다.
  따라서 이 서버는 마켓플레이스 비밀키를 알 필요가 없고, 알아서도 안 된다.
  키가 새어도 프록시에서는 아무것도 얻을 수 없게 하는 것이 이 설계의 요점이다.

보안 경계
  - 대상 호스트는 아래 표에 하드코딩한다. 요청 본문이 목적지를 정하지 못한다(SSRF 차단).
  - 인증은 기존 직원 API 토큰(POST /api/login 발급)을 그대로 쓴다. 별도 공유 비밀을 두지 않는다.
    직원 비활성화 시 즉시 막히고, 7일 후 만료되며, 누가 호출했는지 로그에 남는다.
  - 직원 토큰은 절대 상단(마켓플레이스)으로 전달하지 않는다. 상단 인증은 body.headers 안에 따로 들어온다.
"""
import ipaddress
import json
import logging
import re
import socket
from urllib.parse import urlparse, urlsplit

import httpx
from fastapi import APIRouter, Header, Request, Response
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

log = logging.getLogger("veryup.proxy")

router = APIRouter()

# ── 대상 허용목록 ────────────────────────────────────────────
# path 형태로 오면 base 에 붙이고, url 형태로 오면 host 가 hosts 안에 있어야 한다.
# 여기에 없는 플랫폼·호스트로는 어떤 요청도 나가지 않는다.
TARGETS = {
    "coupang": {
        "base": "https://api-gateway.coupang.com",
        "hosts": {"api-gateway.coupang.com"},
    },
    "naver": {
        # 커머스API 는 토큰 발급(/external/v1/oauth2/token)도 같은 호스트라 함께 덮인다.
        "base": "https://api.commerce.naver.com",
        "hosts": {"api.commerce.naver.com"},
    },
    "amazon": {
        # SP-API 는 리전별로 호스트가 갈린다. 앱이 url 로 보내오므로 host 만 검사한다.
        # LWA 토큰(api.amazon.com)은 앱이 직접 부른다 — IP 허용목록이 없어 경유가 불필요.
        "base": None,
        "hosts": {
            "sellingpartnerapi-na.amazon.com",
            "sellingpartnerapi-eu.amazon.com",
            "sellingpartnerapi-fe.amazon.com",
        },
    },
    "ebay": {
        # The client supplies the URL so Sandbox and Production stay isolated.
        # OAuth exchange/refresh remains a direct client request, like Amazon LWA.
        "base": None,
        "hosts": {"api.ebay.com", "api.sandbox.ebay.com"},
    },
}

ALLOWED_METHODS = {"GET", "POST", "PUT", "PATCH", "DELETE"}

# 앱이 보낸 헤더 중 상단으로 넘기지 않을 것들.
# Host/Content-Length 는 httpx 가 다시 계산하고, 홉 단위 헤더는 전달하면 안 된다.
DROP_REQUEST_HEADERS = {
    "host", "content-length", "connection", "keep-alive", "proxy-authenticate",
    "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade",
    "accept-encoding",
}
# 상단 응답에서 클라이언트로 넘기지 않을 것들 (httpx 가 이미 압축을 풀었으므로 인코딩 헤더 제거)
DROP_RESPONSE_HEADERS = {
    "content-encoding", "content-length", "connection", "keep-alive",
    "transfer-encoding", "upgrade", "proxy-authenticate", "proxy-authorization",
    "te", "trailer", "set-cookie",
}

TIMEOUT = httpx.Timeout(connect=10.0, read=60.0, write=60.0, pool=10.0)
MAX_RESPONSE_BYTES = 16 * 1024 * 1024   # 쿠팡 카테고리 전체 트리가 수 MB 라 넉넉히 잡는다
MAX_REQUEST_BYTES = 16 * 1024 * 1024


def _err(status: int, message: str, **extra):
    """마켓플레이스가 아니라 이 프록시가 낸 오류임을 항상 표시한다."""
    return JSONResponse({"proxyError": True, "message": message, **extra}, status_code=status)


def _is_public_host(host: str) -> bool:
    """Reject non-public DNS answers. This is a preflight, not DNS pinning."""
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror:
        return False
    for info in infos:
        try:
            ip = ipaddress.ip_address(info[4][0])
        except ValueError:
            return False
        if not ip.is_global:
            return False
    return bool(infos)


def _resolve_target(platform: str, payload: dict):
    """(url, error) 를 돌려준다. 목적지는 오직 서버 표에서만 나온다."""
    spec = TARGETS[platform]
    raw_path = payload.get("path")
    raw_url = payload.get("url")
    if raw_path is not None and raw_url is not None:
        return None, "path 또는 url 중 하나만 보내주세요."

    if raw_path:
        if not isinstance(raw_path, str) or not raw_path.startswith("/"):
            return None, "path 는 '/' 로 시작하는 문자열이어야 합니다."
        if "://" in raw_path or raw_path.startswith("//"):
            return None, "path 에 절대 URL 을 넣을 수 없습니다."
        if not spec["base"]:
            return None, f"{platform} 은 path 형식을 지원하지 않습니다. url 을 보내주세요."
        raw_url = spec["base"] + raw_path

    if raw_url:
        if not isinstance(raw_url, str):
            return None, "url 은 문자열이어야 합니다."
        if any(ord(c) <= 32 or ord(c) == 127 for c in raw_url) or "\\" in raw_url:
            return None, "url 에 공백, 제어 문자 또는 역슬래시를 넣을 수 없습니다."
        try:
            parts = urlsplit(raw_url)
            port = parts.port
        except ValueError:
            return None, "올바르지 않은 URL 입니다."
        if parts.scheme != "https":
            return None, "https 만 허용합니다."
        if parts.username is not None or parts.password is not None or port not in (None, 443) or "#" in raw_url:
            return None, "URL 인증정보, 사용자 지정 포트, fragment 는 허용하지 않습니다."
        if parts.hostname not in spec["hosts"]:
            return None, f"허용되지 않은 대상 호스트입니다: {parts.hostname}"
        return raw_url, None

    return None, "path 또는 url 중 하나는 필요합니다."


async def _relay(platform: str, request: Request, authorization: str | None):
    # 이 모듈은 app.py 의 인증 헬퍼를 빌려 쓴다 (순환 import 를 피해 지연 import).
    from app import _auth_by_token, _ip

    user = _auth_by_token(authorization)
    if not user:
        return _err(401, "인증 필요(토큰 없음/만료)")

    if platform not in TARGETS:
        return _err(404, f"알 수 없는 플랫폼: {platform}")

    raw = bytearray()
    async for chunk in request.stream():
        if len(raw) + len(chunk) > MAX_REQUEST_BYTES:
            return _err(413, "요청 본문이 너무 큽니다.")
        raw.extend(chunk)
    try:
        payload = json.loads(raw or b"{}")
    except (json.JSONDecodeError, UnicodeDecodeError):
        return _err(400, "요청 본문이 올바른 JSON 이 아닙니다.")
    if not isinstance(payload, dict):
        return _err(400, "요청 본문은 JSON 객체여야 합니다.")

    method = str(payload.get("method") or "GET").upper()
    if method not in ALLOWED_METHODS:
        return _err(405, f"허용되지 않은 메서드: {method}")

    target, why = _resolve_target(platform, payload)
    if why:
        return _err(400, why)

    # 앱이 만든 상단 인증 헤더는 그대로, 직원 토큰은 절대 넘기지 않는다.
    up_headers = {}
    headers = payload.get("headers", {})
    if not isinstance(headers, dict):
        return _err(400, "headers 는 JSON 객체여야 합니다.")
    connection_headers = {h.strip().lower() for k, v in headers.items() if k.lower() == "connection" for h in str(v).split(",")}
    for k, v in headers.items():
        if not isinstance(k, str) or v is None:
            continue
        if k.lower() in DROP_REQUEST_HEADERS or k.lower() in connection_headers:
            continue
        if not re.fullmatch(r"[!#$%&'*+.^_`|~0-9A-Za-z-]+", k) or not isinstance(v, str) or any(ord(c) < 32 or ord(c) >= 127 for c in v):
            return _err(400, "올바르지 않은 HTTP 헤더입니다.")
        up_headers[k] = str(v)

    body = payload.get("body")
    if isinstance(body, (dict, list)):
        content = json.dumps(body).encode("utf-8")
    elif isinstance(body, str):
        try:
            content = body.encode("utf-8")
        except UnicodeError:
            return _err(400, "body 는 올바른 UTF-8 문자열이어야 합니다.")
    elif body is None:
        content = None
    else:
        return _err(400, "body 는 문자열 또는 JSON 객체여야 합니다.")

    host = urlparse(target).hostname
    if not await run_in_threadpool(_is_public_host, host):
        return _err(502, f"대상 호스트를 확인할 수 없습니다: {host}")

    try:
        async with httpx.AsyncClient(timeout=TIMEOUT, follow_redirects=False, trust_env=False) as client:
            req = client.build_request(method, target, headers=up_headers, content=content)
            upstream = await client.send(req, stream=True)
            # A Location response could make desktop fetch replay the envelope
            # (including marketplace credentials) outside this allowlist.
            if upstream.status_code in (301, 302, 303, 307, 308):
                await upstream.aclose()
                return _err(502, "상단 리디렉션은 허용하지 않습니다.")
            chunks, total = [], 0
            async for chunk in upstream.aiter_bytes():
                total += len(chunk)
                if total > MAX_RESPONSE_BYTES:
                    await upstream.aclose()
                    return _err(502, "상단 응답이 너무 큽니다.")
                chunks.append(chunk)
            await upstream.aclose()
            payload_bytes = b"".join(chunks)
    except httpx.TimeoutException:
        return _err(504, f"{platform} 응답 시간 초과")
    except httpx.HTTPError as e:
        return _err(502, f"{platform} 연결 실패: {type(e).__name__}")
    except (httpx.InvalidURL, ValueError, UnicodeError):
        return _err(400, "요청 URL, 헤더 또는 본문 인코딩을 확인해주세요.")

    # 감사 로그 — 본문과 헤더는 남기지 않는다 (서명·키가 들어 있다).
    log.info(
        "proxy %s %s %s -> %s (%dB) by %s from %s",
        platform, method, urlparse(target).path, upstream.status_code,
        len(payload_bytes), user["username"], _ip(request),
    )

    connection_headers = {h.strip().lower() for h in upstream.headers.get("connection", "").split(",")}
    out_headers = {
        k: v for k, v in upstream.headers.items()
        if k.lower() not in DROP_RESPONSE_HEADERS and k.lower() not in connection_headers
    }
    # 클라이언트(coupang_api.js / amazon_api.js)는 상단 상태코드와 본문을 그대로 읽는다.
    # 여기서 감싸면 오류 판정이 깨지므로 절대 봉투를 씌우지 않는다.
    return Response(
        content=payload_bytes,
        status_code=upstream.status_code,
        headers=out_headers,
        media_type=upstream.headers.get("content-type"),
    )


# ── 라우트 ───────────────────────────────────────────────────
# 경로는 기존 클라이언트가 이미 부르는 모양 그대로 둔다.
#   coupang_api.js -> POST {proxyUrl}/coupang   {method, path, headers, body}
#   amazon_api.js  -> POST {proxyUrl}/amazon    {method, url,  headers, body}
#   ebay_api.js    -> POST {proxyUrl}/ebay      {method, url,  headers, body}
#   (네이버 클라이언트는 아직 없다. path 형식으로 붙이면 된다.)

@router.post("/coupang")
async def proxy_coupang(request: Request, authorization: str = Header(None)):
    return await _relay("coupang", request, authorization)


@router.post("/naver")
async def proxy_naver(request: Request, authorization: str = Header(None)):
    return await _relay("naver", request, authorization)


@router.post("/amazon")
async def proxy_amazon(request: Request, authorization: str = Header(None)):
    return await _relay("amazon", request, authorization)


@router.post("/ebay")
async def proxy_ebay(request: Request, authorization: str = Header(None)):
    return await _relay("ebay", request, authorization)


@router.get("/proxy/health")
async def proxy_health(authorization: str = Header(None)):
    """앱이 프록시 사용 가능 여부와 서버 외부 IP 를 확인하는 용도.
       이 IP 를 쿠팡 판매자센터 / 네이버 커머스API센터에 등록하면 된다."""
    from app import _auth_by_token
    if not _auth_by_token(authorization):
        return _err(401, "인증 필요(토큰 없음/만료)")
    outbound_ip = None
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(5.0)) as client:
            r = await client.get("https://api.ipify.org")
            if r.status_code == 200:
                outbound_ip = r.text.strip()
    except httpx.HTTPError:
        pass
    return {
        "ok": True,
        "platforms": sorted(TARGETS.keys()),
        "outboundIp": outbound_ip,
        "hint": "이 IP 를 각 마켓플레이스 API 설정의 허용 IP 로 등록하세요.",
    }
