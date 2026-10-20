import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { apiError } from '../utils/api_error.js';
import { CALL_GAP_MS, apiTemplate, paceCall } from '../utils/rate_limiter.js';

/**
 * Amazon Selling Partner API (SP-API) 클라이언트
 * - LWA (Login with Amazon) OAuth2 토큰 자동 발급 및 캐싱
 * - LWA access token으로 SP-API 인증
 * - Listings Items API (v2021-08-01) 기반 상품 등록/조회/수정
 */
/**
 * Amazon 판매자 ID(Merchant Token) 형식 검사.
 * A + 영대문자·숫자 12~13자.
 */
/** searchListingsItems 의 identifiers 파라미터 상한 (SP-API 모델 maxItems). */
export const SEARCH_IDENTIFIERS_MAX = 20;

export function isMerchantToken(value) {
  return /^A[A-Z0-9]{12,13}$/.test(String(value ?? '').trim());
}

export class AmazonAPI {
  /**
   * @param {object} options
   * @param {string} options.sellerId - 판매자 ID (Merchant Token)
   * @param {string} options.clientId - LWA Client ID
   * @param {string} options.clientSecret - LWA Client Secret
   * @param {string} options.refreshToken - LWA Refresh Token
   * @param {string} [options.endpoint] - SP-API 엔드포인트 URL
   * @param {string} [options.marketplaceId] - 기본 마켓플레이스 ID (기본: US ATVPDKIKX0DER)
   * @param {object} [options.proxy] - 프록시 옵션 { proxyUrl, proxyToken }
   * @param {Map} [options.tokenCache] - 여러 인스턴스가 나눠 쓰는 LWA 토큰 캐시
   */
  constructor({
    sellerId = '',
    clientId = '',
    clientSecret = '',
    refreshToken = '',
    endpoint = 'https://sellingpartnerapi-na.amazon.com',
    marketplaceId = 'ATVPDKIKX0DER',
    proxy = {},
    tokenCache = null,
    authHint = ''
  } = {}) {
    // 401·403 오류 뒤에 붙일 안내(예: 일본 마켓을 북미 인증정보로 부를 때). amazon.js apiForMarketplace 가 넣는다.
    this.authHint = authHint;
    // Amazon 서비스는 설정을 읽을 때마다(IPC 호출마다) 이 객체를 새로 만든다. 토큰을 인스턴스에만
    // 두면 일괄 저장 1행에 LWA 발급이 3번씩 나갔다. 서비스가 넘겨준 캐시를 refresh token 단위로 쓴다.
    this.tokenCache = tokenCache;
    this.sellerId = sellerId;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.refreshToken = refreshToken;
    this.endpoint = (endpoint || 'https://sellingpartnerapi-na.amazon.com').replace(/\/+$/, '');
    this.marketplaceId = marketplaceId || 'ATVPDKIKX0DER';
    this.proxyUrl = proxy.proxyUrl || '';
    this.proxyToken = proxy.proxyToken || '';

    // LWA 토큰 캐시
    this.accessToken = null;
    this.tokenExpiresAt = 0;
  }

  // ──────────────────────────────────────────
  // 1. LWA OAuth 2.0 Access Token
  // ──────────────────────────────────────────

  /**
   * LWA Refresh Token으로 유효한 Access Token을 조회/재발급합니다.
   */
  async getAccessToken(forceRefresh = false) {
    const now = Date.now();
    const cacheKey = this.tokenCache
      ? createHash('sha256').update(`${this.clientId}\n${this.clientSecret}\n${this.refreshToken}`).digest('hex') : '';
    const shared = this.tokenCache?.get(cacheKey);
    if (!forceRefresh && !this.accessToken && shared) {
      this.accessToken = shared.token;
      this.tokenExpiresAt = shared.expiresAt;
    }
    // 만료 5분 전까지는 캐시된 토큰 재사용
    if (!forceRefresh && this.accessToken && now < this.tokenExpiresAt - 300000) {
      return this.accessToken;
    }

    if (!this.clientId || !this.clientSecret || !this.refreshToken) {
      throw new Error('Amazon LWA 인증 정보(Client ID, Client Secret, Refresh Token)가 누락되었습니다.');
    }

    const tokenUrl = 'https://api.amazon.com/auth/o2/token';
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: this.clientId,
      client_secret: this.clientSecret,
      refresh_token: this.refreshToken
    });

    console.log('[AmazonAPI] LWA Access Token 요청 중...');
    let res;
    let text;
    try {
      res = await fetch(tokenUrl, {
        method: 'POST', signal: AbortSignal.timeout(30000),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: params.toString()
      });
      text = await res.text();
    } catch (err) {
      const timeout = err.name === 'TimeoutError' || err.name === 'AbortError';
      throw apiError(`Amazon LWA 서버 접속 실패: ${timeout ? '시간 초과' : err.cause?.code || err.cause?.message || err.message}`,
        timeout ? { timeout, cause: err } : { network: true, cause: err });
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw apiError(`LWA 토큰 응답 파싱 실패 (HTTP ${res.status}): ${text.slice(0, 200)}`, { status: res.status });
    }

    if (!res.ok || !data.access_token) {
      // error 코드를 같이 남긴다. unauthorized_client(토큰이 이 client 소속이 아님) /
      // invalid_grant(토큰 자체가 무효·취소됨) / invalid_client(id·secret 불일치) 는
      // 원인이 전혀 다른데 error_description 만으로는 구분이 안 된다.
      const errMsg = [data.error, data.error_description].filter(Boolean).join(': ')
        || `HTTP ${res.status}`;
      throw apiError(`Amazon LWA 토큰 발급 실패 (HTTP ${res.status}): ${errMsg}`,
        res.status === 429 || res.status >= 500 ? { status: res.status } : { status: res.status, authFailure: true });
    }

    this.accessToken = data.access_token;
    const expiresIn = data.expires_in || 3600;
    this.tokenExpiresAt = Date.now() + (expiresIn * 1000);
    this.tokenCache?.set(cacheKey, { token: this.accessToken, expiresAt: this.tokenExpiresAt });
    console.log(`[AmazonAPI] LWA Access Token 발급 성공 (유효시간: ${expiresIn}초)`);

    return this.accessToken;
  }

  /**
   * Amazon SP-API 공통 요청 처리
   */
  /**
   * Listings Items 경로에 들어갈 판매자 ID를 검증해서 반환한다.
   * Amazon 은 존재하지 않는 sellerId 를 403 이 아니라 400 InvalidInput 으로 거부하고
   * details 도 비워 보내기 때문에, 요청을 보내고 나면 원인을 알 수 없다.
   * 연결 테스트(marketplaceParticipations)는 sellerId 를 쓰지 않아 이 값이 틀려도 통과한다.
   */
  _sellerPath() {
    if (!isMerchantToken(this.sellerId)) {
      throw new Error(
        `Amazon 판매자 ID(Merchant Token) 형식이 올바르지 않습니다: "${this.sellerId}". ` +
        'A 로 시작하는 13~14자 영대문자·숫자여야 합니다. ' +
        'Seller Central > Settings > Account Info > Your Merchant Token ' +
        '(https://sellercentral.amazon.com/sw/AccountInfo/MerchantToken/step/MerchantToken) 에서 확인하세요.'
      );
    }
    return encodeURIComponent(this.sellerId);
  }

  async _request(method, path, body = null, queryParams = {}) {
    const accessToken = await this.getAccessToken();

    // Query parameters 결합
    let fullPath = path;
    const qKeys = Object.keys(queryParams).filter(k => queryParams[k] !== undefined && queryParams[k] !== null);
    if (qKeys.length > 0) {
      const qStr = qKeys.map(k => `${encodeURIComponent(k)}=${encodeURIComponent(queryParams[k])}`).join('&');
      fullPath += (fullPath.includes('?') ? '&' : '?') + qStr;
    }

    const bodyStr = (body && ['POST', 'PUT', 'PATCH'].includes(method.toUpperCase()))
      ? JSON.stringify(body) : '';

    const headers = {
      'Content-Type': 'application/json;charset=UTF-8',
      'x-amz-access-token': accessToken,
      'User-Agent': 'VeryUpCommerce/2.0 (Language=JavaScript)'
    };

    const targetUrl = `${this.endpoint}${fullPath}`;
    console.log(`[AmazonAPI] ${method.toUpperCase()} ${targetUrl}${this.proxyUrl ? ' (프록시 경유)' : ''}`);

    if (this.proxyUrl && !this.proxyToken) {
      throw apiError('서버 프록시 인증이 필요합니다. 직원 계정으로 다시 로그인해주세요.', { status: 401, proxyError: true });
    }
    const route = this.proxyUrl ? '서버 프록시 경유' : '이 PC에서 직접 호출';
    // Listings Items 등은 연산별 초당 5회다. 경로 앞부분(예: /listings/2021-08-01/items)으로 API 를 묶어 간격을 둔다.
    await paceCall('amazon:' + apiTemplate(fullPath).split('/').slice(0, 4).join('/'), CALL_GAP_MS.amazon, { label: '아마존' });
    let response;
    let text;
    try {
      if (this.proxyUrl) {
        // 서버 httpx 읽기 제한(60초)보다 길게 잡아 느린 응답은 서버가 먼저 504 로 알려 주게 한다.
        // redirect:'error' — 리디렉션되면 액세스 토큰이 담긴 본문이 다른 곳으로 다시 전송될 수 있다.
        response = await fetch(`${this.proxyUrl.replace(/\/+$/, '')}/amazon`, {
          method: 'POST', signal: AbortSignal.timeout(90000), redirect: 'error',
          headers: {
            'Authorization': `Bearer ${this.proxyToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ method: method.toUpperCase(), url: targetUrl, headers, body: bodyStr })
        });
      } else {
        const options = {
          method: method.toUpperCase(),
          headers,
          signal: AbortSignal.timeout(60000)
        };
        if (bodyStr) options.body = bodyStr;
        response = await fetch(targetUrl, options);
      }
      text = await response.text();
    } catch (err) {
      console.error('[AmazonAPI] Fetch Error:', err);
      const timeout = err.name === 'TimeoutError' || err.name === 'AbortError';
      const cause = timeout ? '시간 초과' : err.cause?.code || err.cause?.message || err.message;
      const advice = method.toUpperCase() === 'GET' ? '' : ' 변경 요청이었다면 반영됐을 수 있으니 다시 보내기 전에 현재 상태를 조회해주세요.';
      throw apiError(`아마존 SP-API 네트워크 오류 (${cause}, ${route}).${advice}`,
        timeout ? { timeout, cause: err } : { network: true, cause: err });
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { rawResponse: text };
    }

    // 프록시 자신이 낸 오류(server/proxy.py _err)와 미배포 경로·프록시 앞단 응답은 아마존 오류가 아니다.
    // '(404)' 모양을 넣지 않는다 — duplicate_guard 가 그 모양으로 '상품 없음'을 판정한다.
    if (data?.proxyError) {
      throw apiError(`서버 프록시 오류 (HTTP ${response.status}): ${data.message || '요청 실패'}`,
        { status: response.status, proxyError: true });
    }
    if (this.proxyUrl && response.status === 404 && data?.detail === 'Not Found') {
      throw apiError('관리자 서버에 /amazon 프록시 경로가 없습니다. 서버 배포 상태를 확인해주세요.', { status: 404, proxyError: true });
    }
    if (this.proxyUrl && response.status >= 502 && response.status <= 504 && data?.rawResponse !== undefined) {
      throw apiError(`관리자 서버가 응답하지 않습니다 (HTTP ${response.status}). 서버 재시작 중일 수 있습니다. 잠시 후 다시 시도해주세요.`,
        { status: response.status, proxyError: true });
    }

    if (!response.ok) {
      const issues = data?.issues || data?.errors || [];
      // code(InvalidInput / Unauthorized ...) 와 details 를 message 와 같이 남긴다.
      // message 만으로는 원인이 안 갈린다. RequestId 는 Amazon 지원 문의 시 필수.
      let errMsg = issues.map(i => {
        let s = [i.code, i.message || i.detail].filter(Boolean).join(': ');
        if (i.details) s += ` — ${i.details}`;
        return s || JSON.stringify(i);
      }).join(' | ');
      if (!errMsg) {
        errMsg = data?.message || `HTTP ${response.status}`;
      }
      const requestId = response.headers?.get?.('x-amzn-requestid');
      if (requestId) errMsg += ` [RequestId ${requestId}]`;
      console.error(`[AmazonAPI] Error (${response.status}): ${errMsg}`, data);
      let hint = this.authHint && (response.status === 401 || response.status === 403) ? ` ${this.authHint}` : '';
      if (/Invalid 'accountId'/i.test(errMsg)) {
        hint += ' Seller ID(판매자 토큰)가 이 지역 판매자 계정과 맞지 않습니다. 미국과 일본은 판매자 토큰이 다릅니다(일본: API KEY > 아마존 > 일본 설정).';
      }
      throw apiError(`아마존 SP-API 오류 (${response.status}): ${errMsg}${hint}`, { status: response.status });
    }

    return data;
  }

  // ──────────────────────────────────────────
  // API 인터페이스
  // ──────────────────────────────────────────

  /**
   * 연결 및 계정 활성화 테스트
   * 마켓플레이스 참여 목록을 조회하여 자격증명이 올바른지 검증합니다.
   */
  async testConnection() {
    const res = await this._request('GET', '/sellers/v1/marketplaceParticipations');
    const participations = res?.payload || [];
    const activeMarkets = participations
      .filter(p => p?.participation?.isParticipating)
      .map(p => ({
        id: p.marketplace.id,
        name: p.marketplace.name,
        countryCode: p.marketplace.countryCode,
        currencyCode: p.marketplace.defaultCurrencyCode
      }));

    return {
      success: true,
      message: `아마존 SP-API 연결 성공! (${activeMarkets.length}개 마켓 활성화)`,
      participations: activeMarkets
    };
  }

  /**
   * 상품 등록 / 전체 교체 (Listings Items API v2021-08-01)
   * 주의: PUT은 전체 문서 교체라 본문에 없는 속성(이미지·불릿 등)이 모두 삭제된다.
   *       기존 상품의 일부만 바꿀 때는 patchListingItem을 사용할 것.
   * @param {string} sku - 판매자 SKU
   * @param {object} listingPayload - SP-API 규격의 상품 속성 JSON
   * @param {string} [marketplaceId] - 대상 마켓플레이스 ID
   */
  async putListingItem(sku, listingPayload, marketplaceId = this.marketplaceId) {
    const path = `/listings/2021-08-01/items/${this._sellerPath()}/${encodeURIComponent(sku)}`;
    const query = {
      marketplaceIds: marketplaceId,
      issueLocale: 'en_US'
    };
    return this._request('PUT', path, listingPayload, query);
  }

  /**
   * 상품 부분 수정 (Listings Items API v2021-08-01)
   * 요청에 담긴 속성만 변경하며, 본문에 없는 기존 속성은 그대로 유지된다.
   * @param {string} sku - 판매자 SKU
   * @param {object} patchPayload - { productType, patches: [{ op, path, value }] }
   * @param {string} [marketplaceId] - 대상 마켓플레이스 ID
   */
  async patchListingItem(sku, patchPayload, marketplaceId = this.marketplaceId) {
    const path = `/listings/2021-08-01/items/${this._sellerPath()}/${encodeURIComponent(sku)}`;
    const query = {
      marketplaceIds: marketplaceId,
      issueLocale: 'en_US'
    };
    return this._request('PATCH', path, patchPayload, query);
  }

  /**
   * 등록된 상품 조회
   * @param {string} sku - 판매자 SKU
   * @param {string} [marketplaceId] - 대상 마켓플레이스 ID
   */
  /** Seller ID 가 이 마켓 계정의 것인지 리스팅 1건 조회로 확인한다(없어도 빈 목록이면 통과). */
  async verifySeller(marketplaceId = this.marketplaceId) {
    return this._request('GET', `/listings/2021-08-01/items/${this._sellerPath()}`, null,
      { marketplaceIds: marketplaceId, includedData: 'summaries', pageSize: 1 });
  }

  async getListingItem(sku, marketplaceId = this.marketplaceId) {
    const path = `/listings/2021-08-01/items/${this._sellerPath()}/${encodeURIComponent(sku)}`;
    const query = {
      marketplaceIds: marketplaceId,
      includedData: 'summaries,attributes,issues,offers'
    };
    return this._request('GET', path, null, query);
  }

  // Seller-owned listings, not the public Amazon catalog.
  //
  // 주의: 이 오퍼레이션은 numberOfResults 로 전체 건수를 알려주면서도 페이징은 1000건에서
  // 끊긴다(50페이지 × pageSize 20). nextToken 이 에러 없이 그냥 사라지므로 호출부가
  // 전부 받았다고 착각하기 쉽다. 전체 카탈로그 스냅샷은 Reports API 를 써야 한다.
  //
  // identifiers 를 주면 해당 SKU 만 골라 받는다 — 한 호출에 최대 20건(배열 요청).
  async searchListingsItems({ marketplaceId = this.marketplaceId, pageToken,
                              identifiers, identifiersType } = {}) {
    const byId = Array.isArray(identifiers) && identifiers.length > 0;
    if (byId && identifiers.length > SEARCH_IDENTIFIERS_MAX) {
      throw new Error(`identifiers 는 한 번에 최대 ${SEARCH_IDENTIFIERS_MAX}건입니다 (요청: ${identifiers.length}건).`);
    }
    return this._request('GET', `/listings/2021-08-01/items/${this._sellerPath()}`, null, {
      marketplaceIds: marketplaceId,
      includedData: 'summaries,attributes,offers,fulfillmentAvailability',
      pageSize: 20,
      pageToken,
      identifiers: byId ? identifiers.join(',') : undefined,
      identifiersType: byId ? (identifiersType || 'SKU') : undefined
    });
  }

  // ──────────────────────────────────────────
  // Reports API — 전체 카탈로그 스냅샷
  // searchListingsItems 가 1000건에서 끊기기 때문에, 리스팅이 그보다 많으면
  // 전체를 받을 수 있는 경로는 이것뿐이다. Product Listing 역할로 커버된다.
  // ──────────────────────────────────────────

  async createReport(reportType, marketplaceId = this.marketplaceId) {
    return this._request('POST', '/reports/2021-06-30/reports', {
      reportType,
      marketplaceIds: [marketplaceId]
    });
  }

  async getReport(reportId) {
    return this._request('GET', `/reports/2021-06-30/reports/${encodeURIComponent(reportId)}`);
  }

  async getReportDocument(reportDocumentId) {
    return this._request('GET', `/reports/2021-06-30/documents/${encodeURIComponent(reportDocumentId)}`);
  }

  /**
   * 리포트 본문을 받아 텍스트로 돌려준다.
   * url 은 사전서명된 S3 주소라 인증 헤더가 필요 없고, 프록시 허용 목록에도 없으므로
   * _request 를 거치지 않고 직접 받는다.
   */
  async downloadReportDocument({ url, compressionAlgorithm } = {}) {
    if (!url) throw new Error('리포트 문서 URL이 없습니다.');
    // 전체 리스팅 리포트는 수 MB 라 API 호출보다 넉넉히 잡는다. 신호는 본문을 다 받을 때까지 유효하다.
    let res, buf;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(120000) });
      if (!res.ok) throw new Error(`리포트 문서 다운로드 실패 (HTTP ${res.status})`);
      buf = Buffer.from(await res.arrayBuffer());
    } catch (error) {
      if (error.name === 'TimeoutError' || error.name === 'AbortError') {
        throw apiError('아마존 리포트 문서 다운로드 시간 초과 (2분). 잠시 후 다시 시도해주세요.', { timeout: true, cause: error });
      }
      throw error;
    }
    const raw = compressionAlgorithm === 'GZIP' ? gunzipSync(buf) : buf;
    // 플랫파일 리포트의 인코딩은 응답에 실려 오지 않는다. UTF-8 로 읽어 치환문자가
    // 나오면 cp1252 계열로 간주한다 — 상품명에 들어가는 ° " ' 같은 글자가 깨지는 걸 막는다.
    const utf8 = raw.toString('utf8');
    return utf8.includes('�') ? raw.toString('latin1') : utf8;
  }
}
