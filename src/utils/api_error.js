// 플랫폼 오류를 화면이 판단할 수 있는 모양으로 바꾼다.
//
// 사연
//   IPC 는 예전에 e.message 한 줄만 넘겼다. 그래서 직원 토큰 만료·서버 재시작·429 가
//   전부 '쿠팡 API 오류' 같은 문구로만 보였고, 일괄 저장 루프는 같은 오류를 모든 행에
//   반복했다. 각 클라이언트가 error 에 status / proxyError / timeout / network / rejected 를
//   붙이고, 여기서 한 번에 종류(kind)와 반영 여부(stage)를 정한다.

/** message + 판단용 속성을 가진 Error 를 만든다. cause 를 주면 원인 체인으로 남긴다. */
export function apiError(message, props = {}) {
  const { cause, ...rest } = props;
  const error = cause ? new Error(message, { cause }) : new Error(message);
  return Object.assign(error, rest);
}

/** 쓰기 요청을 보내기 전에 멈춘 오류라고 표시한다. 재조회 후 다시 보내도 안전하다. */
export function markPreSend(error) {
  if (error && typeof error === 'object') error.stage = 'pre-send';
  return error;
}

// 감싼 오류(new Error(msg, { cause }))도 원인 쪽 속성을 읽는다.
function pick(error, key) {
  for (let e = error, depth = 0; e && depth < 6; e = e.cause, depth++) {
    const value = e[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

// fetch/undici 가 연결 단계에서 던지는 오류인지. TypeError('fetch failed') 가 대표적이다.
function isNetworkError(error) {
  if (pick(error, 'network')) return true;
  for (let e = error, depth = 0; e && depth < 6; e = e.cause, depth++) {
    if (e instanceof TypeError && /fetch failed|network/i.test(String(e.message))) return true;
    if (/^(ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPIPE|UND_ERR_)/.test(String(e.code || ''))) return true;
  }
  return false;
}

function isTimeoutError(error) {
  if (pick(error, 'timeout')) return true;
  for (let e = error, depth = 0; e && depth < 6; e = e.cause, depth++) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') return true;
    if (/UND_ERR_(HEADERS|BODY|CONNECT)_TIMEOUT/.test(String(e.code || ''))) return true;
  }
  return false;
}

/**
 * 오류 종류.
 *   STAFF_AUTH 관리자 서버가 직원 토큰을 거부(재로그인 필요)   PROXY 관리자 서버 자체 오류
 *   TIMEOUT / NETWORK 응답을 받지 못함                          RATE_LIMIT 429
 *   AUTH 플랫폼 인증 실패(401/403)   SERVER 플랫폼 5xx   REJECTED 플랫폼이 요청을 거부(4xx, code=ERROR)
 *   ERROR 그 밖(설정 누락, 응답 해석 실패 등)
 */
export function errorKind(error) {
  const status = Number(pick(error, 'status')) || 0;
  if (pick(error, 'proxyError')) {
    if (status === 401 || status === 403) return 'STAFF_AUTH';
    // 서버 프록시가 공용 호출 한도 때문에 보내지 않고 돌려보낸 경우(server/proxy.py 호출 간격 조절).
    return status === 429 ? 'RATE_LIMIT' : 'PROXY';
  }
  // 플랫폼 토큰 발급 실패(키 만료·동의 철회 등). 토큰 엔드포인트는 400 으로 답하기도 해서 따로 표시한다.
  if (pick(error, 'authFailure')) return 'AUTH';
  if (isTimeoutError(error)) return 'TIMEOUT';
  if (isNetworkError(error)) return 'NETWORK';
  if (status === 429) return 'RATE_LIMIT';
  if (status === 401 || status === 403) return 'AUTH';
  if (status >= 500) return 'SERVER';
  if (pick(error, 'rejected') || (status >= 400 && status < 500)) return 'REJECTED';
  return 'ERROR';
}

// 같은 원인으로 다음 행도 실패할 것이 분명한 종류. 일괄 작업은 여기서 멈춘다.
const BLOCKING = new Set(['STAFF_AUTH', 'PROXY', 'AUTH', 'RATE_LIMIT', 'NETWORK']);

/**
 * 쓰기 요청 이후의 반영 여부.
 *   pre-send  보내기 전에 멈춤 — 반영 안 됨
 *   rejected  플랫폼이 거부 — 반영 안 됨
 *   unknown   응답을 못 받음(타임아웃·네트워크·5xx·게이트웨이) — 반영됐을 수 있음
 * sent=false 면 쓰기 전 단계에서 난 오류다.
 */
export function errorStage(error, sent) {
  if (!sent || pick(error, 'stage') === 'pre-send') return 'pre-send';
  const kind = errorKind(error);
  const status = Number(pick(error, 'status')) || 0;
  if (['REJECTED', 'RATE_LIMIT', 'AUTH', 'STAFF_AUTH'].includes(kind)) return 'rejected';
  // 프록시 404(경로 없음)·400(봉투 오류)은 플랫폼까지 가지 않았다. 502/504 는 알 수 없다.
  if (kind === 'PROXY' && status > 0 && status < 500) return 'rejected';
  return 'unknown';
}

/** IPC 로 넘길 평범한 객체. */
export function describeError(error, { sent = null } = {}) {
  const kind = errorKind(error);
  const out = {
    error: String(error?.message || error || '요청을 처리하지 못했습니다.'),
    kind,
    status: Number(pick(error, 'status')) || 0,
    proxyError: !!pick(error, 'proxyError'),
    blocking: BLOCKING.has(kind),
    retryable: ['RATE_LIMIT', 'TIMEOUT', 'NETWORK', 'SERVER', 'PROXY'].includes(kind),
  };
  if (sent !== null) out.stage = errorStage(error, sent);
  return out;
}
