// 네이버 커머스API 클라이언트. 상품 검색과 naver_products.js의 신규 복사등록·기존 상품 조회·수정을 담당한다.
//
// eBay 와 다른 점 하나 — 토큰 발급도 프록시를 거친다.
//   네이버는 '호출한 기기의 외부 IP'를 허용목록(앱당 최대 3개)으로 검사하고, 토큰 발급
//   엔드포인트도 같은 호스트라 함께 검사 대상이다. 직원 PC 에서 직접 부르면 IP 가 달라
//   실패한다. ebay_api.js 가 OAuth 만 직접 호출하는 것과 정반대이므로 옮겨 쓰지 말 것.
//   (server/proxy.py TARGETS["naver"] 주석 참고)

import { apiError } from '../utils/api_error.js';
import { CALL_GAP_MS, apiTemplate, paceCall } from '../utils/rate_limiter.js';

export const NAVER_BASE = 'https://api.commerce.naver.com';

// 공식 문서의 curl 예시가 https://api.commerce.naver.com/external/v1/oauth2/token 이다.
// 문서 색인은 /external 을 뺀 /v1/oauth2/token 으로 표기하므로 아래 API_PREFIX 로 보정한다.
export const TOKEN_PATH = '/external/v1/oauth2/token';
export const API_PREFIX = '/external';

export function naverConnectionInfo(proxy = {}) {
  const server = !!proxy?.proxyUrl;
  return {
    mode: server ? 'proxy' : 'direct',
    label: server ? '서버 프록시 경유' : '이 PC에서 직접 호출',
    ipGuidance: (server ? '프록시 서버' : '이 PC') +
      '의 외부 IPv4를 커머스API센터 > 내 스토어 애플리케이션 > 해당 앱 > 수정 > API 호출 IP에 등록해주세요.'
  };
}

export class NaverAPIError extends Error {
  constructor(status, data) {
    // 커머스API 오류 본문은 { code, message, invalidInputs:[...] } 형태로 관측된다.
    const detail = [data?.code, data?.message].filter(Boolean).join(': ');
    const invalid = (data?.invalidInputs || [])
      .map(i => `${i.name || i.field || '?'}: ${i.message || i.reason || ''}`.trim())
      .filter(Boolean).join('; ');
    super([detail, invalid].filter(Boolean).join(' | ') || `네이버 HTTP ${status}`);
    this.status = status;
    this.code = data?.code || '';
    this.invalidInputs = data?.invalidInputs || [];
  }
}

export class NaverAPI {
  constructor(config, { fetchImpl = fetch, sleep = ms => new Promise(r => setTimeout(r, ms)), proxy = {}, bcrypt = null } = {}) {
    this.config = config || {};
    this.fetch = fetchImpl;
    this.sleep = sleep;
    this.proxyUrl = proxy?.proxyUrl || '';
    this.proxyToken = proxy?.proxyToken || '';
    this.bcrypt = bcrypt;              // 테스트에서 주입. 런타임에는 아래 lazy import.
    this.accessToken = null;
    this.expiresAt = 0;
    this.refreshing = null;
  }

  connectionInfo() {
    return naverConnectionInfo({ proxyUrl: this.proxyUrl });
  }

  async connectionDiagnostics() {
    const info = this.connectionInfo();
    // Only run on an explicit connection check. Never send marketplace keys to the IP service.
    try {
      if (this.proxyUrl && !this.proxyToken) return info;
      const response = await this.fetch(this.proxyUrl
        ? this.proxyUrl.replace(/\/+$/, '') + '/proxy/health'
        : 'https://api.ipify.org', {
        signal: AbortSignal.timeout(6000), redirect: 'error',
        ...(this.proxyUrl ? { headers: { Authorization: 'Bearer ' + this.proxyToken } } : {})
      });
      if (response.status !== 200) return info;
      const text = await response.text();
      const ip = String(this.proxyUrl ? JSON.parse(text).outboundIp || '' : text).trim();
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip) && ip.split('.').every(n => Number(n) <= 255)) {
        info.outboundIp = ip;
      }
    } catch { /* A failed IP lookup must not hide the actual Naver authentication result. */ }
    return info;
  }

  // bcryptjs 는 순수 JS 구현이라 electron-builder 의 npmRebuild:false · asar:false 조합에서도
  // 깨지지 않는다. 네이티브 bcrypt 는 패키징된 앱에서 로드에 실패하므로 쓰지 않는다.
  async _bcrypt() {
    if (this.bcrypt) return this.bcrypt;
    try {
      const mod = await import('bcryptjs');
      this.bcrypt = mod.default || mod;
      return this.bcrypt;
    } catch {
      throw new Error('bcryptjs 모듈이 없습니다. `npm i bcryptjs` 후 다시 실행해주세요.');
    }
  }

  /**
   * 전자서명 생성 — 서명 = base64( bcrypt 해시 출력 ).
   *
   * 공식 문서의 client_secret_sign 예시를 base64 디코딩하면 '$2a$04$QKLnou1D2cSH19Pia3...'
   * 즉 bcrypt 해시 출력 그대로가 나온다. client_secret 자체가 cost 04 의 bcrypt salt 이므로
   * 해시 결과가 그 접두사를 물려받는다. 이 구조는 문서로 확인했다.
   *
   * 해싱 대상 문자열은 clientId + '_' + timestamp 다. 2026-09-18 실계정 토큰 발급 성공으로
   * 확정했다(type=SELF, 유효기간 10737초 수신). 추측이 아니므로 임의로 바꾸지 말 것.
   */
  async sign(timestamp) {
    const { clientId, clientSecret } = this.config;
    if (!clientId || !clientSecret) throw new Error('Client ID와 Client Secret을 먼저 저장해주세요.');
    // 네이버가 발급하는 client_secret 은 그 자체가 bcrypt salt 다 ($2a$04$... 형태).
    // 형식이 깨진 채로 들어오면 bcrypt 가 'Invalid salt version' 을 던지는데, 그 메시지만
    // 보면 서명 방식이 틀린 것처럼 보인다. 흔한 원인은 값 전달 과정의 $ 소실이다.
    if (!/^\$2[aby]\$\d{2}\$/.test(clientSecret)) {
      throw new Error(
        'Client Secret 이 bcrypt salt 형식이 아닙니다 (정상 예: $2a$04$xxxxxxxx…). '
        + `현재 길이 ${clientSecret.length}자, 시작 "${clientSecret.slice(0, 4)}". `
        + 'PowerShell 큰따옴표는 $2a 를 변수로 해석해 값을 지웁니다 — 작은따옴표로 넣어주세요.'
      );
    }
    const bcrypt = await this._bcrypt();
    const hashed = bcrypt.hashSync(`${clientId}_${timestamp}`, clientSecret);
    return Buffer.from(hashed, 'utf-8').toString('base64');
  }

  // 인증 토큰 유효기간은 3시간(10,800초). 네이버는 남은 시간이 30분 이상이면 기존 토큰을
  // 그대로 돌려주고 30분 미만일 때만 새로 발급한다. 즉 재발급 호출 자체는 저렴하지만,
  // 아래 token() 의 캐시가 불필요한 왕복을 없애 준다.
  async tokenRequest() {
    const { clientId, accountId, type } = this.config;
    // VERY UP 은 자사 스토어만 다루는 사내 도구라 SELF 가 맞다(실계정 검증 완료).
    // SELLER 는 솔루션 업체가 남의 판매자 리소스를 대신 다룰 때 쓰며, 이 앱에서는
    // 같은 키로 시도하면 400 BadRequest 가 돌아온다.
    const authType = type || 'SELF';
    // type=SELLER 는 account_id 가 필수다. 없이 보내면 원인이 모호한 오류가 돌아오므로
    // 전송 전에 막고 무엇이 빠졌는지 알려준다.
    if (authType === 'SELLER' && !accountId) {
      throw new Error('type=SELLER 에는 판매자 ID(account_id)가 필요합니다. 예: ncp_2sRZTWJVbDtHPoz9O…');
    }
    // timestamp 는 5분만 유효하므로 발급 직전에 매번 새로 만든다. 캐시하면 안 된다.
    const timestamp = Date.now();
    const body = new URLSearchParams({
      client_id: clientId,
      timestamp: String(timestamp),
      client_secret_sign: await this.sign(timestamp),
      grant_type: 'client_credentials',
      type: authType
    });
    if (authType === 'SELLER') body.set('account_id', accountId);

    const { status, data } = await this._send('POST', TOKEN_PATH, body.toString(), {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json'
    });
    // 토큰 응답에는 자격증명이 들어 있다. 오류 필드만 노출하고 본문을 그대로 넘기지 않는다.
    if (status < 200 || status >= 300 || !data?.access_token) {
      const detail = [data?.code || data?.error, data?.message || data?.error_description].filter(Boolean).join(': ');
      // 429·5xx·빈 본문은 키 문제가 아니다(서버 재시작 중 게이트웨이 502 등). '키를 확인하라'고 안내하지 않는다.
      if (status === 429 || status >= 500 || (!data && status !== 200)) {
        throw apiError(`네이버 토큰 발급 서버 응답 오류 (HTTP ${status})${detail ? ` — ${detail}` : ''}. 잠시 후 다시 시도해주세요.`, { status });
      }
      throw apiError(`네이버 인증 실패 (HTTP ${status})${detail ? ` — ${detail}` : ''}. 키와 전자서명 방식을 확인해주세요.`,
        { status, authFailure: true });
    }
    this.accessToken = data.access_token;
    this.expiresAt = Date.now() + Math.max(0, Number(data.expires_in || 0) - 60) * 1000;
    return { expiresIn: Number(data.expires_in || 0) };
  }

  async token() {
    if (this.accessToken && Date.now() < this.expiresAt) return this.accessToken;
    // 동시 호출이 토큰을 여러 번 받아가지 않도록 발급 요청 하나를 공유한다.
    if (!this.refreshing) this.refreshing = this.tokenRequest().finally(() => { this.refreshing = null; });
    await this.refreshing;
    return this.accessToken;
  }

  // 프록시가 있으면 {method, path, headers, body} 봉투로 감싸 보낸다(쿠팡과 같은 형식).
  // proxy.py 의 naver 항목은 base 가 있으므로 path 형식을 그대로 받는다.
  async _send(method, path, bodyStr, headers) {
    if (this.proxyUrl && !this.proxyToken) throw apiError('서버 프록시 인증이 필요합니다. 직원 계정으로 다시 로그인해주세요.', { status: 401, proxyError: true });
    // 내 스토어 앱은 API별 2RPS 다. 같은 API(경로에서 번호를 뺀 모양)끼리 간격을 둔다.
    await paceCall('naver:' + apiTemplate(path), CALL_GAP_MS.naver, { sleep: this.sleep, label: '네이버' });
    let response;
    try {
      response = this.proxyUrl
        ? await this.fetch(`${this.proxyUrl.replace(/\/+$/, '')}/naver`, {
          method: 'POST', signal: AbortSignal.timeout(90000), redirect: 'error',
          headers: { Authorization: `Bearer ${this.proxyToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ method, path, headers, body: bodyStr })
        })
        : await this.fetch(`${NAVER_BASE}${path}`, {
          method, signal: AbortSignal.timeout(30000), redirect: 'error', headers,
          ...(bodyStr === undefined ? {} : { body: bodyStr })
        });
    } catch (error) {
      const timeout = error.name === 'TimeoutError' || error.name === 'AbortError';
      if (timeout || error instanceof TypeError) {
        const cause = timeout ? '시간 초과' : `네트워크 오류: ${error.cause?.code || error.cause?.message || error.message}`;
        const advice = method === 'GET' || /\/(search|query)|oauth2\/token/.test(path) ? ''
          : ' 변경 요청은 자동 재전송하지 않습니다. 상품번호로 상태를 다시 조회해주세요.';
        throw apiError(`네이버 응답을 확인하지 못했습니다 (${cause}, ${this.connectionInfo().label}).${advice}`,
          timeout ? { timeout, cause: error } : { network: true, cause: error });
      }
      throw error;
    }
    const text = await response.text();
    let data = null;
    let invalidJson = false;
    if (text) { try { data = JSON.parse(text); } catch { invalidJson = true; } }

    // 프록시 자신이 낸 오류는 항상 proxyError 로 표시된다(server/proxy.py:91).
    if (data?.proxyError) {
      const error = new Error(`서버 프록시 오류 (${response.status}): ${data.message || '요청 실패'}`);
      error.status = response.status; error.proxyError = true;
      throw error;
    }
    // 프록시를 쓰는데 /naver 경로가 없으면 FastAPI 기본 404 가 온다. eBay 와 같은 진단.
    if (this.proxyUrl && response.status === 404 && data?.detail === 'Not Found') {
      const error = new Error('관리자 서버에 /naver 프록시 경로가 없습니다. server/proxy.py 배포 상태를 확인해주세요.');
      error.status = 404; error.proxyError = true;
      throw error;
    }
    // 프록시를 쓰는데 봉투도 JSON 도 아닌 502·503·504 는 프록시 앞단(Caddy·uvicorn)이 낸 응답이다.
    if (this.proxyUrl && response.status >= 502 && response.status <= 504 && (invalidJson || !data)) {
      throw apiError(`관리자 서버가 응답하지 않습니다 (HTTP ${response.status}). 서버 재시작 중일 수 있습니다. 잠시 후 다시 시도해주세요.`,
        { status: response.status, proxyError: true });
    }
    if (invalidJson) throw apiError(`네이버 응답 형식 오류 (HTTP ${response.status})`, { status: response.status });
    if (data?.code === 'GW.IP_NOT_ALLOWED') {
      const connection = this.connectionInfo();
      const error = new NaverAPIError(response.status, { code: data.code });
      error.traceId = response.headers?.get?.('GNCP-GW-Trace-ID') || data.traceId || '';
      error.connection = connection;
      error.message = '네이버 IP 인증 실패 (HTTP ' + response.status +
        ', GW.IP_NOT_ALLOWED). 현재 경로: ' + connection.label + '. ' + connection.ipGuidance +
        (error.traceId ? ' 문의용 Trace ID: ' + error.traceId : '');
      throw error;
    }
    return { status: response.status, data };
  }

  /**
   * 인증된 API 호출. path 는 /external 을 뺀 문서 표기 그대로 넘긴다.
   *   예) request('POST', '/v1/products/search', { ... })
   * body 가 FormData 면 multipart 로 보낸다(이미지 업로드). 경계값은 fetch 가 정하므로 Content-Type 을 비운다.
   */
  async request(method, path, body, attempt = 0, authRetried = false) {
    if (!path.startsWith('/') || path.startsWith('//')) throw new Error('잘못된 API 경로입니다.');
    const form = body instanceof FormData;
    // 프록시 봉투는 JSON 문자열만 실어 나른다(server/proxy.py). 앱은 네이버를 직접 부르므로 verimap 스크립트에서만 걸린다.
    if (form && this.proxyUrl) throw apiError('서버 프록시 경유로는 네이버에 파일을 올릴 수 없습니다. --direct 로 실행해주세요.', { proxyError: true });
    const headers = {
      Authorization: `Bearer ${await this.token()}`,
      ...(form ? {} : { 'Content-Type': 'application/json' }),
      Accept: 'application/json'
    };
    const bodyStr = body === undefined || form ? body : JSON.stringify(body);
    const { status, data } = await this._send(method, `${API_PREFIX}${path}`, bodyStr, headers);

    if (status === 401 && !authRetried) {
      this.accessToken = null;
      return this.request(method, path, body, attempt, true);
    }
    // 429 는 게이트웨이가 처리하지 않고 돌려보낸 것이라(내 스토어 앱은 API별 2RPS 고정, 공식 답변)
    // 변경 요청도 다시 보내도 된다. 5xx 는 조회(GET·검색)만 재시도한다 — 타임아웃된 수정은 이미
    // 반영됐을 수 있다. 공식 권장은 1~2초 뒤 재호출이라 조금 더 넉넉히 쉰다.
    const isRead = method === 'GET' || (method === 'POST' && /\/(search|query)/.test(path));
    if ((status === 429 || (isRead && status >= 500)) && attempt < 2) {
      await this.sleep(Math.min(10000, 1500 * 2 ** attempt + Math.floor(Math.random() * 500)));
      return this.request(method, path, body, attempt + 1, authRetried);
    }
    if (status < 200 || status >= 300) throw new NaverAPIError(status, data);
    return data;
  }

  // ── 조회 래퍼 (Phase 2에서 쓰는 읽기 전용 경로) ──────────────────
  async searchProducts(payload = {}) {
    return this.request('POST', '/v1/products/search', { page: 1, size: 50, ...payload });
  }
  async originProduct(originProductNo) {
    return this.request('GET', `/v2/products/origin-products/${encodeURIComponent(originProductNo)}`);
  }

  /**
   * 등록 상품 전체를 페이징으로 수집한다.
   *
   * 응답 구조(실계정 확인): { contents: [{ originProductNo, channelProducts: [...] }],
   *   page, size, totalElements, totalPages, first, last }
   * 한 원상품에 채널상품이 여러 개 달릴 수 있어 원상품번호로 중복을 없앤다.
   */
  async allProducts({ pageSize = 100, maxPages = 60, force = false, onProgress = null } = {}) {
    // 실계정은 1,800건이 넘어 페이지당 100건이면 19회 왕복이다. 기존 브라우저 구현도
    // 같은 이유로 5분 캐시를 뒀다(옛 naver_smartstore_edit.js — 2026-10-16 삭제). 같은 수명을 유지해서
    // 조회를 반복해도 왕복이 늘지 않게 한다.
    const now = Date.now();
    if (!force && this._allProducts && (now - this._allProductsAt) < 5 * 60 * 1000) {
      return this._allProducts;
    }
    const rows = [];
    const seen = new Set();
    let truncated = false;
    let page = 1;
    for (; page <= maxPages; page++) {
      const res = await this.searchProducts({ page, size: pageSize });
      for (const entry of res?.contents || []) {
        // 채널상품이 이름·가격·재고를 들고 있다. 원상품 레벨에는 번호만 있다.
        const channel = (entry.channelProducts || [])[0] || {};
        const originNo = entry.originProductNo ?? channel.originProductNo;
        if (originNo == null || seen.has(originNo)) continue;
        seen.add(originNo);
        rows.push({
          // 기존 브라우저 경로와 같은 계약: id 는 문자열, name 은 상품명.
          // 원상품번호를 주면 loadProductForEdit 의 resolveOriginNo 가 첫 시도에 성공해
          // 목록 전수 검색(두 번째 sleep(9000) 블록)을 아예 타지 않는다.
          id: String(originNo),
          name: channel.name || '',
          originProductNo: originNo,
          channelProductNo: channel.channelProductNo ?? null,
          statusType: channel.statusType || '',
          salePrice: channel.salePrice ?? 0,
          stockQuantity: channel.stockQuantity ?? 0,
          brandName: channel.brandName || '',
          modelName: channel.modelName || '',
          categoryId: channel.categoryId || '',
          representativeImage: channel.representativeImage?.url || ''
        });
      }
      onProgress?.(rows.length, res?.totalElements ?? null);
      if (res?.last === true || !(res?.contents || []).length) break;
      if (res?.totalPages && page >= res.totalPages) { break; }
      if (page === maxPages) truncated = true;
    }
    // 잘렸으면 반드시 드러낸다. 조용히 일부만 돌려주면 '검색 결과 없음'이 오진이 된다.
    if (truncated) {
      throw new Error(`상품이 ${maxPages * pageSize}건을 넘어 전부 읽지 못했습니다. 조회 범위를 좁혀주세요.`);
    }
    this._allProducts = rows;
    this._allProductsAt = Date.now();
    return rows;
  }

  /** 캐시를 버린다. 상품을 등록·수정한 직후처럼 목록이 바뀐 것이 확실할 때 부른다. */
  invalidateProducts() {
    this._allProducts = null;
    this._allProductsAt = 0;
  }

  /**
   * 제조사·차종으로 상품을 찾는다. 옛 브라우저 구현(naver_smartstore_edit.js — 2026-10-16 삭제)의
   * 동명 메서드와 시그니처·필터 규칙·반환 계약을 일부러 똑같이 맞췄다(호출부를 그대로 두려고).
   */
  async searchProductsByName(brand, model, { force = false, onProgress = null } = {}) {
    const b = String(brand || '').trim();
    const m = String(model || '').trim();
    if (!b && !m) throw new Error('제조사 또는 차종을 입력해 주세요.');
    const all = await this.allProducts({ force, onProgress });
    const norm = s => String(s || '').replace(/\s+/g, '');
    const nb = norm(b), nm = norm(m);
    return all.filter(p => {
      const n = norm(p.name);
      return (!nb || n.includes(nb)) && (!nm || n.includes(nm));
    });
  }
}
