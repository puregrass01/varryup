// 아임웹 OAuth 2.0 (Authorization Code Flow). 본사몰 · B2B몰의 상품 작업이 이 인증으로 돈다(2026-10-05).
// 예전 v2 키/시크릿 인증(imweb_api.js)은 지웠다.
//
// 구 v2 API 와 다른 점 두 가지. 옮겨 적을 때 여기서 가장 많이 틀린다.
//   1) 호스트가 다르다.  구: api.imweb.me/v2   신: openapi.imweb.me
//   2) 파라미터가 camelCase 다. 일반적인 OAuth 의 snake_case(client_id, redirect_uri,
//      grant_type)가 아니라 clientId · redirectUri · grantType · responseType · siteCode 다.
//      snake_case 로 보내면 필수값 누락으로 거부된다.
//
// 근거 문서(웹 문서 화면은 내용이 안 읽히지만 아래 두 파일은 받아진다):
//   https://developers-docs.imweb.me/llms-full.txt            가이드 전문(앱 연동 · OAuth · 토큰 유효기간)
//   https://developers-docs.imweb.me/reference/openapi.json   엔드포인트 · scope · 오류코드표
//
// 알아둘 규칙(문서):
//   - 특정 사이트 전용 앱은 앱스토어 승인 대상이 아니고, 개발자센터 계정이 소유한 '테스트 사이트'에서만
//     API 를 쓸 수 있다. 그래서 승인을 기다릴 일이 아니라 앱의 'API 설정'에 필요한 API 를 넣는 일이다.
//   - 액세스 토큰 2시간 · 리프레시 토큰 90일. 연동중 상태에서는 연동완료 처리(completeIntegration) 외의
//     API 를 쓸 수 없다.

export const IMWEB_BASE = 'https://openapi.imweb.me';
export const AUTHORIZE_PATH = '/oauth2/authorize';

// 2026-09-23 실측으로 확인. 후보 경로 중 /oauth2/token 만 존재하고(나머지는 404),
// 본문은 x-www-form-urlencoded 만 받는다 — JSON 으로 보내면 30122 로 거부된다.
export const TOKEN_PATH = '/oauth2/token';

// 아임웹이 인가 코드 발급 때 무조건 요구하는 범위. 빠지면 동의창 대신
//   "인가 코드 발급 시 scope에 site-info:write 권한이 필수로 제공되어야 합니다"
// 를 돌려준다. 이 앱이 사이트 정보를 고칠 일은 없지만 아임웹의 요구라 선택지가 없다.
export const REQUIRED_SCOPES = ['site-info:write'];

// 지금 이 앱이 요청하는 범위(개발자센터에서 신청한 것과 같다): 회원 읽기 · 상품 읽기∙쓰기 · 주문 읽기∙쓰기.
// 아임웹 표기상 :write 는 '읽기∙쓰기' 라 :read 를 따로 적지 않는다.
//
// 2026-10-05 실측: 아임웹이 받아주는 것은 site-info 와 member-info:read 뿐이고 product · order 는
// 30099 로 거부한다. scope 는 앱의 'API 설정'에 들어 있는 것만 요청할 수 있어서(문서: "Redirect Uri와
// Scope가 설정되어 있어야 합니다") 코드가 아니라 개발자센터 설정의 문제다. 거부되는 것이 섞여 있어도
// 흐름이 멈추지 않도록 requestApprovedCode() 가 받아주는 것만 추려서 요청한다.
export const DEFAULT_SCOPES = ['site-info:write', 'member-info:read', 'product:write', 'order:write'];

// 실측하거나 문서(openapi.json 의 오류표)로 확인한 코드와 조치. 아임웹 메시지만으로는 무엇을
// 고쳐야 할지 알기 어려운 것들이다.
export const ERROR_HINTS = {
  '10007': '요청이 한꺼번에 몰렸습니다(버킷 25 · 초당 2 회복). 잠시 뒤 다시 시도하세요.',
  '30098': 'clientId · clientSecret · redirectUri 중 하나가 앱 설정과 다릅니다.',
  '30099': '이 앱의 API 설정에 없는 scope 를 요청했습니다. 개발자센터 > 앱 > API 설정에서 해당 API(읽기∙쓰기)를 선택해 저장했는지, 앱이 "심사 중"이라 설정이 잠겨 있지는 않은지 확인하세요.',
  '30100': '인가 코드가 유효하지 않습니다. authorize 부터 다시 시작하세요.',
  '30101': '토큰이 유효하지 않습니다. 다시 발급하세요.',
  '30102': '액세스 토큰이 만료됐습니다(유효 2시간). refreshToken 으로 갱신하세요.',
  '30103': '이 토큰에는 그 API 에 필요한 scope 가 없습니다. 토큰 응답의 scope 를 확인하세요.',
  '30105': '인증 정보가 유효하지 않습니다. 토큰을 다시 발급하세요.',
  '30122': '토큰 요청 본문은 x-www-form-urlencoded 여야 합니다.',
  '30123': 'redirectUri 가 앱 설정과 다릅니다.',
  '30124': '잘못된 인가 코드입니다. authorize 부터 다시 시작하세요.',
  '30125': '인가 코드가 만료됐습니다. 코드는 한 번만, 받은 직후에 써야 합니다. authorize 부터 다시 시작하세요.',
  '30128': '연동중 상태인 앱만 연동완료 처리가 됩니다. 이미 연동완료이거나 연동이 해제된 상태입니다.',
  '30132': 'siteCode 가 이 앱과 연동된 사이트가 아닙니다. 없는 코드와 똑같은 응답이라 "거의 맞다"는 뜻이 아닙니다.',
  '30156': `scope 에 ${REQUIRED_SCOPES.join(' ')} 가 빠졌습니다.`
};

export class ImwebOAuthError extends Error {
  constructor(status, data, text) {
    // 아임웹 오류 본문은 {"statusCode":400,"error":{"errorCode":"30098","message":"…","innerMessage":"…"}}
    // 처럼 error 가 객체다. 문자열로 이어 붙이면 "[object Object]" 가 되므로 풀어서 읽는다.
    // 표준 OAuth 형태(error / error_description 문자열)도 함께 받는다.
    const nested = data && typeof data.error === 'object' ? data.error : null;
    const errorCode = nested?.errorCode ? String(nested.errorCode) : null;
    // 입력 검증 오류(10003 등)는 진짜 사유가 error.data[] 안에 있다 —
    // 예: [{ arrayMaxSize: { field: 'prodNos', message: 'prodNos must contain no more than 10 elements' } }]
    const reasons = (Array.isArray(nested?.data) ? nested.data : [])
      .flatMap(item => Object.values(item || {}))
      .map(v => (v && typeof v === 'object' ? v.message : v))
      .filter(Boolean).slice(0, 3);
    const detail = nested
      ? [errorCode, nested.message, nested.innerMessage && `(${nested.innerMessage})`, reasons.length && `[${reasons.join('; ')}]`].filter(Boolean).join(' ')
      : [data?.error, data?.error_description, data?.message, data?.code].filter(Boolean).join(': ');
    const hint = errorCode && ERROR_HINTS[errorCode] ? ` → ${ERROR_HINTS[errorCode]}` : '';
    super((detail || `아임웹 OAuth HTTP ${status}${text ? ` — ${String(text).slice(0, 200)}` : ''}`) + hint);
    this.status = status;
    this.data = data;
    this.errorCode = errorCode;
  }
}

// 아임웹 OAuth 의 clientId 는 UUID 다(두 번 발급받은 값 모두). 구 v2 키는 42자·22자라 겹치지 않는다.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 구 v2 apiKey 칸에 OAuth Client ID 를 넣는 실수를 가려낼 때 쓴다. */
export const looksLikeOAuthClientId = (value) => UUID.test(String(value ?? '').trim());

/**
 * VERY UP 의 아임웹 키 설정(imweb_openapi_config.json)에서 OAuth clientId · clientSecret 을 꺼낸다.
 *
 * 전용 칸(clientId · clientSecret)이 있으면 그것을 쓴다. 없으면 아임웹 탭의 'Open API 키'
 * 입력칸(apiKey · apiSecret)에 OAuth 값이 들어간 경우를 받아준다 — 그 칸은 원래 구 v2 키 자리라,
 * apiKey 가 UUID 일 때만 OAuth 값으로 본다. 그 경우 from 이 'apiKey' 이고, 구 v2 키로 동작하는
 * 기능(imweb_edit.js 의 B2B 상품 생성 등)은 그 키를 잃은 상태라는 뜻이다.
 * OAuth 값이 없으면 null.
 */
export function oauthCredentialsFromConfig(cfg) {
  const s = (v) => String(v ?? '').trim();
  if (s(cfg?.clientId)) return { clientId: s(cfg.clientId), clientSecret: s(cfg.clientSecret), from: 'clientId' };
  if (UUID.test(s(cfg?.apiKey))) return { clientId: s(cfg.apiKey), clientSecret: s(cfg.apiSecret), from: 'apiKey' };
  return null;
}

/** 배열이든 공백·쉼표로 이은 문자열이든 중복 없는 scope 배열로 맞춘다. */
export function normalizeScopes(scopes) {
  const list = Array.isArray(scopes) ? scopes : String(scopes ?? '').split(/[\s,]+/);
  return [...new Set(list.map(s => String(s).trim()).filter(Boolean))];
}

/** CSRF 방지용 state. 노드 내장 crypto 를 쓰고 예측 가능한 값(시간·순번)은 쓰지 않는다. */
export async function randomState() {
  const { randomBytes } = await import('node:crypto');
  return randomBytes(24).toString('hex');
}

/**
 * 브라우저에서 열 authorize URL 을 만든다.
 * 사람이 아임웹에 로그인하고 동의해야 하는 흐름이라, 이 URL 은 반드시 브라우저로 연다.
 * (Invoke-WebRequest·curl 로 부르면 로그인 페이지 HTML 만 돌아온다)
 */
export function authorizeUrl({ clientId, redirectUri, siteCode, state, scopes = DEFAULT_SCOPES }) {
  for (const [k, v] of [['clientId', clientId], ['redirectUri', redirectUri], ['siteCode', siteCode], ['state', state]]) {
    if (!String(v || '').trim()) throw new Error(`아임웹 authorize 에 ${k} 가 필요합니다.`);
  }
  // 호출자가 무엇을 넘기든 필수 범위는 앞에 붙인다. 넘긴 순서는 지키고 중복만 없앤다.
  // 여기서 강제하지 않으면 IMWEB_SCOPES 로 좁게 지정했을 때 같은 오류가 다시 난다.
  const scope = [...new Set([...REQUIRED_SCOPES, ...normalizeScopes(scopes)])].join(' ');
  // responseType 은 Authorization Code Flow 만 지원하므로 code 로 고정이다.
  const query = new URLSearchParams({
    responseType: 'code', clientId, redirectUri, scope, state, siteCode
  });
  // URLSearchParams 는 공백을 + 로 적는다. 쿼리에서 + 를 공백으로 안 읽는 서버가 있어
  // scope 가 'a+b' 한 덩어리로 해석될 수 있으므로 %20 으로 바꾼다. 값 속의 진짜 + 는
  // 이미 %2B 로 인코딩돼 있어서 여기 남은 + 는 전부 공백이다.
  return `${IMWEB_BASE}${AUTHORIZE_PATH}?${query.toString().replaceAll('+', '%20')}`;
}

/**
 * 동의 후 리디렉션된 주소에서 code 를 꺼낸다.
 * state 를 반드시 대조한다 — 이것이 authorize 를 시작한 그 요청의 응답인지 확인하는 유일한 수단이다.
 */
export function readCallback(callbackUrl, expectedState) {
  let url;
  try { url = new URL(callbackUrl); }
  catch { throw new Error('동의 후 이동한 페이지의 전체 주소를 붙여넣어주세요.'); }

  // 아임웹은 거부할 때 표준 OAuth 의 error= 가 아니라 서비스 URL 에 ?errorCode=&message= 를 붙인다.
  const errorCode = url.searchParams.get('errorCode');
  if (errorCode) {
    throw new ImwebOAuthError(302, { error: { errorCode, message: url.searchParams.get('message') || '' } });
  }
  const error = url.searchParams.get('error');
  if (error) {
    const desc = url.searchParams.get('error_description') || '';
    throw new Error(`아임웹이 동의를 거부했습니다: ${error}${desc ? ` — ${desc}` : ''}`);
  }
  const code = url.searchParams.get('code');
  if (!code) {
    throw new Error('주소에 code 가 없습니다. 리디렉션 주소가 /login 이나 / 처럼 '
      + '다시 이동하는 경로면 쿼리가 사라집니다. 리디렉션하지 않는 경로를 쓰세요.');
  }
  const got = url.searchParams.get('state');
  if (expectedState && got !== expectedState) {
    throw new Error('state 가 일치하지 않습니다. authorize 를 다시 시작해주세요.');
  }
  return { code, state: got };
}

/**
 * 브라우저 없이 인가 코드를 받는다.
 *
 * 앱이 그 사이트에 이미 설치(연동완료)돼 있으면 authorize 는 로그인·동의 화면 없이 곧바로
 * redirectUri?code=…&state=… 로 302 한다(2026-09-23 실측). 그래서 리디렉트를 따라가지 않고
 * Location 헤더만 읽는다. 거부할 때는 서비스 URL 로 ?errorCode=&message= 를 붙여 302 하고,
 * clientId · redirectUri 가 틀리면 리디렉트 없이 400 JSON 을 준다.
 *
 * 로그인·동의 화면으로 보내면 그 사이트에는 아직 앱이 설치되지 않은 것이다. 그때는 사람이
 * 동의해야 하므로 authorizeUrl() 주소를 브라우저에서 여는 방식(tests/imweb-oauth.mjs)을 쓴다.
 */
export async function requestCode({ clientId, redirectUri, siteCode, scopes = DEFAULT_SCOPES }, { fetchImpl = fetch } = {}) {
  const state = await randomState();
  const url = authorizeUrl({ clientId, redirectUri, siteCode, state, scopes });
  const res = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(30000) });
  const location = res.headers.get('location');

  if (!location) {
    const text = await res.text().catch(() => '');
    if (res.status >= 200 && res.status < 300) {
      throw new Error('아임웹이 로그인·동의 화면을 돌려줬습니다. 이 사이트에는 아직 앱이 설치되지 않았습니다 — '
        + 'authorizeUrl() 주소를 브라우저에서 열어 동의하세요.');
    }
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* HTML 이면 원문 앞부분으로 알린다 */ }
    throw new ImwebOAuthError(res.status, data, text);
  }

  const back = new URL(location, url);
  if (!back.searchParams.get('errorCode')) {
    // 오류가 아닌데 redirectUri 가 아닌 곳으로 보냈다면 로그인 화면이다(사람의 동의가 필요한 상태).
    const expected = new URL(redirectUri);
    if (back.origin !== expected.origin || back.pathname !== expected.pathname) {
      throw new Error(`아임웹이 ${back.origin}${back.pathname} 로 보냈습니다(로그인·동의 화면). `
        + '이 사이트에는 아직 앱이 설치되지 않았습니다 — authorizeUrl() 주소를 브라우저에서 열어 동의하세요.');
    }
  }
  // errorCode 해석과 state 대조는 브라우저 방식과 같은 규칙을 쓴다.
  return readCallback(back.toString(), state);
}

/**
 * 요청한 scope 중 아임웹이 받아주는 것만 추려서 인가 코드를 받는다.
 *
 * 30099 는 '요청한 scope 가 올바르지 않다' 고만 하고 어느 scope 가 문제인지는 알려주지 않는다.
 * 그래서 전체가 거부되면 하나씩 물어볼 수밖에 없다(필수 scope 는 항상 함께 보낸다).
 * 30099 가 아닌 오류(siteCode · clientId 문제 등)는 scope 와 무관하므로 물어보지 않고 그대로 던진다.
 *
 * 반환: { code, state, scopes(실제로 요청한 것), rejected(거부된 것) }
 */
export async function requestApprovedCode({ scopes = DEFAULT_SCOPES, ...target }, deps = {}) {
  const wanted = normalizeScopes(scopes).filter(s => !REQUIRED_SCOPES.includes(s));

  try {
    const got = await requestCode({ ...target, scopes: wanted }, deps);
    return { ...got, scopes: wanted, rejected: [] };
  } catch (error) {
    // 필수 scope 만 보냈는데도 거부됐다면 물어볼 대상이 없다 — 앱 설정에 site-info 가 없다는 뜻이다.
    if (error.errorCode !== '30099' || wanted.length === 0) throw error;
  }

  const accepted = [];
  const rejected = [];
  for (const scope of wanted) {
    try {
      await requestCode({ ...target, scopes: [scope] }, deps);
      accepted.push(scope);
    } catch (error) {
      if (error.errorCode !== '30099') throw error;
      rejected.push(scope);
    }
  }
  const got = await requestCode({ ...target, scopes: accepted }, deps);
  return { ...got, scopes: accepted, rejected };
}

function readJson(text) {
  try { return text ? JSON.parse(text) : null; } catch { return null; }   // HTML 등은 원문 앞부분으로 알린다
}

function requireFields(what, fields) {
  for (const [name, value] of Object.entries(fields)) {
    if (!String(value || '').trim()) throw new Error(`${what}에 ${name} 가 필요합니다.`);
  }
}

// 문서는 토큰 필드를 최상위로 적었지만 다른 응답처럼 data 로 감싸 올 수도 있어 둘 다 받는다.
function pick(data, ...keys) {
  for (const source of [data, data?.data]) {
    for (const key of keys) if (source?.[key] != null && source[key] !== '') return source[key];
  }
  return undefined;
}

/** 토큰 응답을 한 모양으로 맞춘다. 문서상 필드는 accessToken · refreshToken · scope(배열)이다. */
function toToken(status, data, text) {
  const accessToken = pick(data, 'accessToken', 'access_token');
  if (!accessToken) throw new ImwebOAuthError(status, data, text || '(빈 응답)');
  return {
    accessToken,
    refreshToken: pick(data, 'refreshToken', 'refresh_token') || '',
    scope: normalizeScopes(pick(data, 'scope')),
    expiresIn: Number(pick(data, 'expiresIn', 'expires_in') ?? 0),   // 문서에 없다. 액세스 토큰은 2시간이다
    raw: data
  };
}

/** /oauth2/token 호출 하나. 본문은 x-www-form-urlencoded 이고 필드는 전부 camelCase 다. */
async function postToken(fields, { fetchImpl = fetch, tokenPath = TOKEN_PATH } = {}) {
  const res = await fetchImpl(`${IMWEB_BASE}${tokenPath}`, {
    method: 'POST',
    signal: AbortSignal.timeout(30000),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(fields).toString()
  });
  const text = await res.text();
  const data = readJson(text);
  if (res.status < 200 || res.status >= 300) throw new ImwebOAuthError(res.status, data, text);
  return toToken(res.status, data, text);   // 토큰 자체는 로그에 남기지 않는다
}

/** 인가 코드를 액세스 토큰으로 교환한다. */
export async function exchangeCode({ clientId, clientSecret, code, redirectUri }, deps = {}) {
  requireFields('토큰 교환', { clientId, clientSecret, code, redirectUri });
  return postToken({ clientId, clientSecret, code, grantType: 'authorization_code', redirectUri }, deps);
}

/**
 * refreshToken 으로 새 액세스 토큰을 받는다(액세스 토큰 유효 2시간, 리프레시 토큰 90일).
 * 문서는 갱신 응답에 refreshToken 도 새로 들어 있다고 적었다 — 받은 새 값으로 바꿔 저장해야 한다
 * (옛 값이 계속 유효한지는 확인하지 못했다). 리프레시 토큰까지 만료됐다면 authorize 부터 다시 시작한다.
 */
export async function refreshAccessToken({ clientId, clientSecret, refreshToken }, deps = {}) {
  requireFields('토큰 갱신', { clientId, clientSecret, refreshToken });
  return postToken({ clientId, clientSecret, refreshToken, grantType: 'refresh_token' }, deps);
}

// ── 액세스 토큰으로 부르는 API ──────────────────────────────────────────────
// 호출 제한은 버킷 25 · 초당 2 회복이고, 몰리면 남은 양과 상관없이 429 가 올 수 있다(문서).

async function apiRequest(method, path, accessToken, { body, fetchImpl = fetch } = {}) {
  if (!String(accessToken || '').trim()) throw new Error('아임웹 API 호출에 액세스 토큰이 필요합니다.');
  const res = await fetchImpl(`${IMWEB_BASE}${path}`, {
    method,
    signal: AbortSignal.timeout(30000),
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  const data = readJson(text);
  if (res.status < 200 || res.status >= 300) throw new ImwebOAuthError(res.status, data, text);
  return data;
}

/**
 * 연결된 사이트의 기본 정보(siteCode · 유닛별 이름과 통화). 토큰이 살아 있는지, 어느 사이트에
 * 붙었는지 확인하는 가장 가벼운 호출이다.
 */
export async function getSiteInfo(accessToken, deps = {}) {
  const data = await apiRequest('GET', '/site-info', accessToken, deps);
  return data?.data ?? data;
}

/**
 * 앱 상태를 연동중 → 연동완료 로 바꾼다. 문서가 "반드시" 하라고 한 단계로, '연동중' 에서는 이 API 외의
 * 다른 API 를 쓸 수 없다. 이 API 가 site-info:write 를 요구해서 그 scope 가 모든 인가 요청에 필수다.
 * 연동중이 아니면(이미 완료·해제) 30128 로 거절되고 아무것도 바뀌지 않는다.
 */
export async function completeIntegration(accessToken, deps = {}) {
  return apiRequest('PATCH', '/site-info/integration-complete', accessToken, deps);
}
