// 아임웹 Open API(OAuth) 클라이언트 — 토큰 관리와 호출 제한을 한곳에서 맡는다.
//
// 토큰은 디스크에 저장하지 않는다. 앱이 사이트에 설치돼 있으면 authorize 가 로그인 없이 곧바로
// 인가 코드를 주므로(imweb_oauth.js requestCode), 필요할 때 메모리에서 발급하고 만료되면 갱신·재발급한다.
// 저장된 비밀값이 client secret 하나로 끝난다.
//
// 호출 제한(문서): 버킷 25 · 초당 2 회복, 몰리면 남은 양과 상관없이 429. 응답의 X-RateLimit-Remaining 을
// 보고 바닥나기 전에 쉬고, 429 · 10007 은 잠시 뒤 다시 보낸다.
import {
  IMWEB_BASE, ImwebOAuthError, requestApprovedCode, exchangeCode, refreshAccessToken
} from './imweb_oauth.js';

// 문서상 액세스 토큰은 2시간이다. JWT 의 exp 를 읽지 못하면 이 값으로 보고, 끝나기 5분 전에 새로 받는다.
const ACCESS_TTL_MS = 2 * 60 * 60 * 1000;
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;

/** JWT 의 exp(초)를 ms 로. 서명은 검증하지 않는다 — 만료 시각을 미리 알기 위한 용도뿐이다. */
export function jwtExpiryMs(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
    return Number.isFinite(payload?.exp) ? payload.exp * 1000 : null;
  } catch { return null; }
}

/**
 * 토큰 세션. credentials() 는 { clientId, clientSecret } 를 돌려준다(부를 때마다 읽어 설정 변경을 바로 반영).
 * need 로 꼭 있어야 하는 scope 를 주면, 아임웹이 그 scope 를 주지 않았을 때 토큰을 받자마자 멈춘다.
 */
export function createImwebSession({
  credentials, siteCode, redirectUri, scopes, need = [],
  fetchImpl = fetch, now = Date.now, log = () => {}
}) {
  let current = null;      // { accessToken, refreshToken, expiresAt, scope, clientId }
  let pending = null;      // 동시에 여러 호출이 만료를 만나도 발급은 한 번만

  function accept(token, clientId) {
    const missing = need.filter(s => !token.scope.includes(s));
    if (missing.length) {
      throw new Error(`아임웹이 ${missing.join(' ')} 권한을 주지 않았습니다(받은 권한: ${token.scope.join(' ') || '없음'}). `
        + '개발자센터 > 앱 > API 설정을 확인하세요.');
    }
    current = {
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiresAt: (jwtExpiryMs(token.accessToken) ?? now() + ACCESS_TTL_MS) - EXPIRY_MARGIN_MS,
      scope: token.scope,
      clientId
    };
    return current.accessToken;
  }

  async function issue() {
    const { clientId, clientSecret } = await credentials() || {};
    if (!clientId || !clientSecret) {
      throw new Error('아임웹 OAuth Client ID / Secret 이 없습니다. 아임웹 탭 > Open API 키의 OAuth 칸에 저장하세요.');
    }
    // 설정에서 앱이 바뀌었으면 옛 리프레시 토큰은 다른 앱의 것이라 쓰지 않는다.
    if (current?.refreshToken && current.clientId === clientId) {
      try {
        const token = await refreshAccessToken({ clientId, clientSecret, refreshToken: current.refreshToken }, { fetchImpl });
        log('[아임웹 API] 토큰 갱신');
        return accept(token, clientId);
      } catch (error) {
        log(`[아임웹 API] 토큰 갱신 실패(${error.errorCode || error.status || error.message}) — 새로 발급합니다`);
      }
    }
    // authorize 는 브라우저 주소로 나가는 요청이라 secret 을 넘기지 않는다(교환 단계에서만 쓴다).
    const { code, rejected } = await requestApprovedCode({ clientId, redirectUri, siteCode, scopes }, { fetchImpl });
    if (rejected.length) log(`[아임웹 API] 승인되지 않아 뺀 권한: ${rejected.join(' ')}`);
    const token = await exchangeCode({ clientId, clientSecret, code, redirectUri }, { fetchImpl });
    log('[아임웹 API] 토큰 발급');
    return accept(token, clientId);
  }

  return {
    async token() {
      if (current && now() < current.expiresAt) return current.accessToken;
      if (!pending) pending = issue().finally(() => { pending = null; });
      return pending;
    },
    /** 서버가 토큰을 거부했을 때(30101 · 30102) 부른다. 다음 token() 이 갱신·재발급한다. */
    invalidate() { if (current) current.expiresAt = 0; },
    scope: () => current?.scope || []
  };
}

/**
 * 중첩 객체를 multipart 필드로 편다. 아임웹 문서: "multipart/form-data의 중첩 객체/배열 필드는 JSON 문자열이 아니라
 * bracket notation으로 전송합니다" — { a: { b: [{ c: 1 }] } } → a[b][0][c]=1.
 * 빈 배열 · 빈 객체는 multipart 로 나타낼 방법이 없어 빠진다(그런 값은 JSON 엔드포인트로 따로 보낸다).
 */
export function toFormFields(value, prefix = '', out = []) {
  if (value === undefined || value === null) return out;
  if (Array.isArray(value)) {
    value.forEach((item, i) => toFormFields(item, `${prefix}[${i}]`, out));
  } else if (typeof value === 'object' && !(value instanceof Blob)) {
    for (const [key, item] of Object.entries(value)) toFormFields(item, prefix ? `${prefix}[${key}]` : key, out);
  } else {
    out.push([prefix, value instanceof Blob ? value : String(value)]);
  }
  return out;
}

/** toFormFields 로 편 필드와 파일들을 FormData 로. files = [{ field, blob, name }] */
export function toFormData(value, files = []) {
  const form = new FormData();
  for (const [key, item] of toFormFields(value)) form.append(key, item);
  for (const f of files) form.append(f.field, f.blob, f.name);
  return form;
}

/**
 * 액세스 토큰으로 부르는 API. 401(토큰 거부)은 한 번 재발급 후 다시, 429 · 10007 은 물러났다가 다시 보낸다.
 * 쓰기(PATCH 등)도 같은 규칙으로 다시 보낸다 — 이 클라이언트의 쓰기는 값을 '설정'하는 것이라 두 번 가도 결과가 같다.
 */
export function createImwebClient(session, {
  fetchImpl = fetch, sleep = ms => new Promise(r => setTimeout(r, ms)), maxRetries = 4, log = () => {}
} = {}) {
  // form 은 FormData(multipart) — Content-Type 은 fetch 가 경계(boundary)까지 넣어 정하므로 직접 넣지 않는다.
  // 이미지 업로드가 섞이는 요청이라 제한 시간을 넉넉히 둔다.
  async function request(method, path, { query, body, form } = {}) {
    const qs = query ? '?' + new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null)) : '';
    const url = `${IMWEB_BASE}${path}${qs}`;
    let reauthorized = false;
    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(url, {
        method,
        signal: AbortSignal.timeout(form ? 120000 : 30000),
        headers: {
          Authorization: `Bearer ${await session.token()}`,
          Accept: 'application/json',
          ...(body !== undefined && !form ? { 'Content-Type': 'application/json' } : {})
        },
        body: form || (body !== undefined ? JSON.stringify(body) : undefined)
      });
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { /* 아래에서 원문으로 알린다 */ }
      const errorCode = data && typeof data.error === 'object' ? String(data.error?.errorCode || '') : '';

      // 바닥나기 전에 쉰다. 초당 2 회복이라 1초면 2개가 돌아온다. 헤더가 없으면 판단하지 않는다 —
      // Number(null) 은 0 이라, 그대로 두면 헤더 없는 응답마다 1초씩 쉬게 된다.
      const remainingHeader = res.headers?.get?.('x-ratelimit-remaining');
      const remaining = remainingHeader == null || remainingHeader === '' ? NaN : Number(remainingHeader);
      if (Number.isFinite(remaining) && remaining <= 2) await sleep(1000);

      if (res.status >= 200 && res.status < 300) return data;

      if (res.status === 401 && !reauthorized && (errorCode === '30101' || errorCode === '30102' || !errorCode)) {
        reauthorized = true;
        session.invalidate();
        continue;
      }
      if ((res.status === 429 || errorCode === '10007') && attempt < maxRetries) {
        const retryAfter = Number(res.headers?.get?.('retry-after'));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt;
        log(`[아임웹 API] 요청이 몰려 ${Math.round(wait / 1000)}초 쉰 뒤 다시 보냅니다 (${method} ${path})`);
        await sleep(wait);
        continue;
      }
      throw new ImwebOAuthError(res.status, data, text);
    }
  }

  // 목록형 응답({ data: { list, totalPage } })을 끝까지 읽는다.
  async function all(path, query, { limit = 100, maxPages = 100 } = {}) {
    const rows = [];
    for (let page = 1; page <= maxPages; page++) {
      const data = (await request('GET', path, { query: { ...query, page, limit } }))?.data || {};
      const list = Array.isArray(data.list) ? data.list : [];
      rows.push(...list);
      const totalPage = Number(data.totalPage);
      if (Number.isFinite(totalPage) ? page >= totalPage : list.length < limit) return rows;
    }
    throw new Error(`${path} 가 ${maxPages}쪽을 넘어 끝까지 읽지 못했습니다.`);
  }

  return {
    request,
    siteInfo: async () => (await request('GET', '/site-info'))?.data,
    products: (unitCode) => all('/products', { unitCode }),
    product: async (prodNo, unitCode) =>
      (await request('GET', `/products/${encodeURIComponent(prodNo)}`, { query: { unitCode } }))?.data,
    optionDetails: (prodNo, unitCode) =>
      all(`/products/${encodeURIComponent(prodNo)}/option-details`, { unitCode }),
    setPrice: (prodNo, unitCode, price) =>
      request('PATCH', `/products/${encodeURIComponent(prodNo)}/price`, { body: { unitCode, price } }),
    setOptionPrice: (prodNo, optionDetailCode, unitCode, price) =>
      request('PATCH', `/products/${encodeURIComponent(prodNo)}/option-details/${encodeURIComponent(optionDetailCode)}`,
        { body: { unitCode, price } })
  };
}
