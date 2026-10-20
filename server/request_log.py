"""실시간 로그 버퍼 — 관리 화면이 '지금 무슨 일이 일어나는지' 보기 위한 것.

채널이 둘이다. 방향이 반대라서 담는 내용도 다르다.

  inbound   이 서버로 **들어오는** 요청   → /logs/live
            누가 어느 화면을 열었나, 앱이 릴레이를 불렀나.
  upstream  쇼핑몰 API 에서 **받아온** 값 → /logs/api
            쿠팡·네이버·아마존·이베이가 뭐라고 답했나. 본문까지 담는다.

왜 journald 를 읽지 않는가
  uvicorn 액세스 로그는 journald 로 가지만, 거기에는 (1) 어느 직원이 보냈는지가 없고
  (2) 상단 응답 본문은 애초에 없다. 그래서 앱 안에서 직접 모은다.

무엇을 담지 않는가 (중요)
  - **요청 헤더는 어느 채널에도 담지 않는다.** 쿠팡 HMAC 서명, 아마존 LWA 토큰,
    이베이 Bearer 가 전부 헤더다. proxy.py 의 감사 로그가 헤더를 빼는 이유와 같다.
  - **앱이 보낸 봉투(payload)의 headers 를 담지 않는다.** 같은 이유다.
  - inbound 채널은 쿼리스트링도 허용 키만 값을 남긴다(_SAFE_QUERY_KEYS).
  - upstream 채널은 **응답 본문을 담는다** — 그게 이 화면의 목적이다. 대신
    UPSTREAM_BODY_CHARS 로 잘라 두고, 관리자만 볼 수 있게 라우트에서 막는다.

메모리만 쓴다. 프로세스가 재시작되면 비워진다.

⚠ uvicorn 을 --workers 2 이상으로 띄우면 워커마다 버퍼가 따로 생긴다.
  현재 배포는 단일 프로세스라 문제없다.
"""
import asyncio
import json
import logging
from collections import deque

log = logging.getLogger("veryup.request_log")

MAX_HISTORY = 500
SUBSCRIBER_QUEUE_MAX = 200

# 상단 응답 본문을 화면에 보여 줄 길이. 쿠팡 상품 목록 한 페이지가 수십 KB 라
# 통째로 들고 있으면 500건 × 수십 KB 가 된다. 자르되 원래 크기는 따로 적어 둔다.
UPSTREAM_BODY_CHARS = 4000

_SAFE_QUERY_KEYS = frozenset({"platform", "page", "q", "tab", "msg", "err", "challenge_code"})
_SKIP_PATHS = frozenset({"/logs/live/stream", "/logs/api/stream"})


class LiveBuffer:
    """최근 N건을 들고 있으면서 열려 있는 SSE 구독자에게 밀어 주는 링 버퍼."""

    def __init__(self, maxlen: int = MAX_HISTORY, queue_max: int = SUBSCRIBER_QUEUE_MAX):
        self._history: deque = deque(maxlen=maxlen)
        self._subscribers: set = set()
        self._seq = 0
        self.maxlen = maxlen
        self.queue_max = queue_max

    def push(self, entry: dict) -> dict:
        self._seq += 1
        entry["id"] = self._seq
        self._history.append(entry)
        for q in list(self._subscribers):
            try:
                q.put_nowait(entry)
            except asyncio.QueueFull:
                # 밀린 구독자는 건너뛴다. 끊지 않는다 — 브라우저가 따라잡으면 그 뒤부터 다시 보인다.
                # (중간이 빈 것은 화면의 id 가 건너뛰는 것으로 드러난다)
                pass
        return entry

    def history(self) -> list:
        return list(self._history)

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=self.queue_max)
        self._subscribers.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self._subscribers.discard(q)

    def subscriber_count(self) -> int:
        return len(self._subscribers)

    def reset(self) -> None:
        """테스트 전용 — 채널을 처음 상태로 되돌린다."""
        self._history.clear()
        self._subscribers.clear()


inbound = LiveBuffer()
upstream = LiveBuffer()


def _safe_query(raw: str) -> str:
    """쿼리스트링에서 값이 안전한 것만 남긴다. 빈 문자열이면 쿼리가 없었다는 뜻."""
    if not raw:
        return ""
    parts = []
    for chunk in raw.split("&"):
        if not chunk:
            continue
        key, sep, value = chunk.partition("=")
        if not sep:
            parts.append(key)
        elif key in _SAFE_QUERY_KEYS:
            parts.append(f"{key}={value[:60]}")
        else:
            parts.append(f"{key}=…")      # 이름만 남기고 값은 버린다
    return "&".join(parts)[:200]


# ── inbound 채널 (이 서버로 들어오는 요청) ────────────────────
def record(*, method: str, path: str, query: str, status: int,
           duration_ms: float, ip: str, user: str, ts: str) -> None:
    """요청 한 건을 기록한다. **절대 예외를 밖으로 내지 않는다** — 로깅이 요청을 죽이면 안 된다."""
    try:
        if path in _SKIP_PATHS:
            return
        inbound.push({
            "ts": ts,
            "method": method,
            "path": path[:300],
            "query": _safe_query(query),
            "status": status,
            "ms": round(duration_ms, 1),
            "ip": ip,
            "user": user or "",
        })
    except Exception as e:  # noqa: BLE001
        log.warning("요청 로그 기록 실패(무시): %s", e)


# ── upstream 채널 (쇼핑몰 API 응답) ───────────────────────────
def record_upstream(*, platform: str, method: str, url: str, status: int,
                    duration_ms: float, body: bytes, user: str, ts: str,
                    error: str = "") -> None:
    """마켓플레이스에서 받아온 응답 한 건을 기록한다.

    body 는 **상단이 돌려준 원문 바이트**다. 여기서만 잘라 담고, 앱으로 나가는
    응답은 proxy.py 가 손대지 않고 그대로 넘긴다(자르면 클라이언트 파싱이 깨진다).
    """
    try:
        text, size = "", 0
        if body:
            size = len(body)
            text = body[: UPSTREAM_BODY_CHARS * 4].decode("utf-8", "replace")[:UPSTREAM_BODY_CHARS]
        upstream.push({
            "ts": ts,
            "platform": platform,
            "method": method,
            "url": (url or "")[:400],
            "status": status,
            "ms": round(duration_ms, 1),
            "size": size,
            "truncated": size > len(text.encode("utf-8", "replace")),
            "body": text,
            "user": user or "",
            "error": error or "",
        })
    except Exception as e:  # noqa: BLE001
        log.warning("상단 응답 로그 기록 실패(무시): %s", e)


def sse(data: dict) -> str:
    """SSE 한 덩어리로 포장. ensure_ascii=False 라야 한글이 안 깨진다."""
    return "data: " + json.dumps(data, ensure_ascii=False) + "\n\n"


# ── 하위 호환 (기존 호출부·테스트가 쓰던 모듈 수준 함수) ──────
def history() -> list:
    return inbound.history()


def subscribe() -> asyncio.Queue:
    return inbound.subscribe()


def unsubscribe(q: asyncio.Queue) -> None:
    inbound.unsubscribe(q)


def subscriber_count() -> int:
    return inbound.subscriber_count()
