import crypto from 'crypto';
import { apiError } from '../utils/api_error.js';
import { CALL_GAP_MS, coolDown, paceCall } from '../utils/rate_limiter.js';

const API_BASE = 'https://api-gateway.coupang.com';
const API_PATH_PREFIX = '/v2/providers/seller_api/apis/api/v1/marketplace';
// 본문 code 가 이 값들일 때만 성공이다 (대문자로 비교). 수정 경로(coupang.js)가 쓰던 목록과 같다.
const COUPANG_OK_CODES = new Set(['SUCCESS', 'OK', '200']);

// 쿠팡은 vendorId 당 초당 5회를 넘으면 429 를 주고 수 분~수십 분 막는다(공식 공지).
// 막힌 동안 계속 부르면 차단이 길어지므로, 429 를 받으면 이 PC 에서는 1분간 바로 거절한다.
const RATE_LIMIT_COOLDOWN_MS = 60000;

// 서버 프록시 httpx 읽기 제한(60초)보다 길게 잡아, 느린 응답은 서버가 먼저 504 로 알려 주게 한다.
const PROXY_TIMEOUT_MS = 90000;
const DIRECT_TIMEOUT_MS = 60000;

// JSON 이 아닌 오류 본문(HTML 게이트웨이 페이지 등)에서 원인을 짐작할 앞부분만 남긴다.
function textSnippet(text) {
  return String(text || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
}

/**
 * 쿠팡 Open API 클라이언트
 * - HMAC-SHA256 기반 인증
 * - 상품 등록/조회/수정 API
 * - 카테고리 및 메타 정보 조회
 */
export class CoupangAPI {
  /**
   * @param {string} vendorId - 업체코드
   * @param {string} accessKey - Access Key
   * @param {string} secretKey - Secret Key
   * @param {string} [vendorUserId] - 로그인 ID
   */
  constructor(vendorId, accessKey, secretKey, vendorUserId = '', proxy = {}) {
    this.vendorId = vendorId;
    this.accessKey = accessKey;
    this.secretKey = secretKey;
    this.vendorUserId = vendorUserId || vendorId;
    // 서버 프록시(고정 IP) 경유용 — proxyUrl 이 있으면 쿠팡을 직접 안 부르고 서버를 거친다.
    this.proxyUrl = proxy.proxyUrl || '';
    this.proxyToken = proxy.proxyToken || '';
    // (vendorItemId, salePrice) => void — 판매가를 알게 될 때마다 부른다(_sawPrice). Coupang 이 단다.
    this.onPrice = null;
  }

  // ──────────────────────────────────────────
  // HMAC 인증
  // ──────────────────────────────────────────

  /**
   * HMAC-SHA256 서명을 생성하여 Authorization 헤더 값을 반환합니다.
   * 쿠팡 API 인증 규격:
   *   Message = datetime + method + path
   *   datetime = yyMMddTHHmmssZ (UTC)
   *   Authorization = CEA algorithm=HmacSHA256, access-key={ak}, signed-date={dt}, signature={sig}
   */
  _buildAuthHeader(method, fullPath) {
    const now = new Date();
    const pad = (n, len = 2) => String(n).padStart(len, '0');

    // yyMMddTHHmmssZ  (UTC)
    const datetime = [
      pad(now.getUTCFullYear() % 100),
      pad(now.getUTCMonth() + 1),
      pad(now.getUTCDate()),
      'T',
      pad(now.getUTCHours()),
      pad(now.getUTCMinutes()),
      pad(now.getUTCSeconds()),
      'Z'
    ].join('');

    // ? 기준 분리하여 ? 제거 후 path + query 결합 (쿠팡 HMAC 규격)
    let path = fullPath;
    let query = '';
    const qIndex = fullPath.indexOf('?');
    if (qIndex !== -1) {
      path = fullPath.substring(0, qIndex);
      query = fullPath.substring(qIndex + 1);
    }

    const message = datetime + method.toUpperCase() + path + query;
    const signature = crypto
      .createHmac('sha256', this.secretKey)
      .update(message)
      .digest('hex');

    return {
      authorization: `CEA algorithm=HmacSHA256, access-key=${this.accessKey}, signed-date=${datetime}, signature=${signature}`,
      datetime
    };
  }

  /**
   * 공통 API 요청 래퍼
   */
  async _request(method, path, body = null, { retry = false } = {}) {
    const { authorization } = this._buildAuthHeader(method, path);

    const headers = {
      'Authorization': authorization,
      'Content-Type': 'application/json;charset=UTF-8',
      'X-Requested-By': this.vendorUserId,
      'X-MARKET': 'KR',
      'X-EXTENDED-TIMEOUT': '45000'
    };

    const bodyStr = (body && (method.toUpperCase() === 'POST' || method.toUpperCase() === 'PUT'))
      ? JSON.stringify(body) : null;

    console.log(`[CoupangAPI] ${method.toUpperCase()} ${path}${this.proxyUrl ? ' (프록시 경유)' : ''}`);
    if (this.proxyUrl && !this.proxyToken) {
      throw apiError('서버 프록시 인증이 필요합니다. 직원 계정으로 다시 로그인해주세요.', { status: 401, proxyError: true });
    }
    const paceKey = 'coupang:' + this.vendorId;
    await paceCall(paceKey, CALL_GAP_MS.coupang, { label: '쿠팡' });

    const route = this.proxyUrl ? '서버 프록시 경유' : '이 PC에서 직접 호출';
    let response;
    let text;
    try {
      if (this.proxyUrl) {
        // 서버 프록시 경유: 앱이 서명한 요청을 서버가 고정 IP로 대신 전달 → 쿠팡은 서버 IP만 봄
        response = await fetch(`${this.proxyUrl.replace(/\/+$/, '')}/coupang`, {
          method: 'POST', signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
          headers: { 'Authorization': `Bearer ${this.proxyToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ method: method.toUpperCase(), path, headers, body: bodyStr }),
        });
      } else {
        // 직접 호출 (기존)
        const options = { method: method.toUpperCase(), headers, signal: AbortSignal.timeout(DIRECT_TIMEOUT_MS) };
        if (bodyStr) options.body = bodyStr;
        response = await fetch(`${API_BASE}${path}`, options);
      }
      text = await response.text();
    } catch (error) {
      console.error(`[CoupangAPI] Fetch Error:`, error);
      if (error.name === 'TimeoutError' || error.name === 'AbortError') {
        throw apiError(`쿠팡 응답 시간 초과 (${route}). 변경 요청이었다면 반영됐을 수 있으니 다시 보내기 전에 현재 상태를 조회해주세요.`,
          { timeout: true, cause: error });
      }
      if (error.cause) {
        console.error(`[CoupangAPI] Fetch Error Cause:`, error.cause);
        throw apiError(`fetch failed: ${error.cause.message || error.cause.code || error.cause} (${route})`,
          { network: true, cause: error });
      }
      throw error;
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { rawResponse: text };
    }

    // 프록시 자신이 낸 오류는 항상 proxyError 로 표시된다(server/proxy.py _err).
    // '(404)' 모양을 넣지 않는다 — duplicate_guard 가 그 모양으로 '상품 없음'을 판정한다.
    if (data?.proxyError) {
      console.error(`[CoupangAPI] 서버 프록시 오류 (${response.status}): ${data.message}`);
      throw apiError(`서버 프록시 오류 (HTTP ${response.status}): ${data.message || '요청 실패'}`,
        { status: response.status, proxyError: true });
    }
    if (this.proxyUrl && response.status === 404 && data?.detail === 'Not Found') {
      throw apiError('관리자 서버에 /coupang 프록시 경로가 없습니다. 서버 배포 상태를 확인해주세요.',
        { status: 404, proxyError: true });
    }
    // 프록시를 쓰는데 JSON 이 아닌 502·503·504 가 오면 프록시 앞단(Caddy·uvicorn)이 낸 응답이다.
    if (this.proxyUrl && response.status >= 502 && response.status <= 504 && data?.rawResponse !== undefined) {
      const snippet = textSnippet(data.rawResponse);
      throw apiError(`관리자 서버가 응답하지 않습니다 (HTTP ${response.status})${snippet ? ` — ${snippet}` : ''}. 서버 재시작 중일 수 있습니다.`,
        { status: response.status, proxyError: true });
    }

    if (!response.ok) {
      // 504 Gateway Timeout 등 일시적 게이트웨이 지연 시 GET 요청은 1.5초 후 1회 자동 재시도
      if (method.toUpperCase() === 'GET' && response.status === 504 && !retry) {
        console.warn(`[CoupangAPI] 쿠팡 504 Gateway Timeout 감지, 1.5초 후 자동 재시도: ${path}`);
        await new Promise(r => setTimeout(r, 1500));
        return this._request(method, path, body, { retry: true });
      }

      const snippet = data?.rawResponse !== undefined ? textSnippet(data.rawResponse) : '';
      const errMsg = data?.message || data?.error || `HTTP ${response.status}${snippet ? ` — ${snippet}` : ''}`;
      console.error(`[CoupangAPI] Error: ${errMsg}`, data);
      if (response.status === 429) coolDown(paceKey, RATE_LIMIT_COOLDOWN_MS);
      const hint = response.status === 429 ? ' 쿠팡 호출 한도(초당 5회)를 넘어 잠시 차단됐습니다. 몇 분 뒤 다시 시도해주세요.'
        : response.status === 401 ? ' 쿠팡 API 키(180일마다 만료)와 PC 시계를 확인해주세요.'
          : response.status === 403 ? ` 현재 경로: ${route}. 쿠팡 Open API 허용 IP를 확인해주세요.` : '';
      throw apiError(`쿠팡 API 오류 (${response.status}): ${errMsg}${hint}`, { status: response.status });
    }

    // 쿠팡은 거부도 HTTP 200 + {code:'ERROR', message:'...'} 로 돌려준다. 여기서 막지 않으면
    //   · 등록이 실패했는데 "등록되었습니다 (ID: undefined)" 로 보고되고,
    //   · 목록 조회 오류 본문이 빈 목록으로 읽혀 5분 캐시에 '상품 없음'으로 남는다.
    // 호출하는 엔드포인트가 성공 때 돌려주는 code 는 'SUCCESS'(상품·목록·카테고리)와
    // '200'/200(반품지)뿐이다. code 가 아예 없는 응답(출고지 목록 등)은 예전처럼 통과시킨다.
    // 메시지에 '(400)'·'(404)' 모양을 넣지 않는다 — duplicate_guard 가 그 모양으로 '상품 없음'을 판정한다.
    if (data && typeof data === 'object' && !Array.isArray(data) && data.code != null
        && !COUPANG_OK_CODES.has(String(data.code).toUpperCase())) {
      const errMsg = data.message || data.error || JSON.stringify(data).slice(0, 200);
      console.error(`[CoupangAPI] 거부 응답 (code=${data.code}): ${errMsg}`, data);
      throw apiError(`쿠팡이 요청을 거부했습니다 (code=${data.code}): ${errMsg}`, { status: response.status, rejected: true });
    }

    return data;
  }

  // ──────────────────────────────────────────
  // 연결 테스트
  // ──────────────────────────────────────────

  /**
   * API 연결 테스트 — 카테고리 목록 일부를 조회하여 인증이 유효한지 확인합니다.
   */
  async testConnection() {
    const path = `${API_PATH_PREFIX}/meta/display-categories`;
    const result = await this._request('GET', path);
    return { success: true, message: '쿠팡 API 연결 성공!', categoryCount: result?.data?.length || 0 };
  }

  // ──────────────────────────────────────────
  // 출고지 / 반품지
  // ──────────────────────────────────────────

  /**
   * 출고지 목록을 조회합니다.
   */
  async getOutboundShippingPlaces() {
    const path = `/v2/providers/marketplace_openapi/apis/api/v2/vendor/shipping-place/outbound?pageNum=1&pageSize=50`;
    return this._request('GET', path);
  }

  /**
   * 반품지 목록을 조회합니다.
   */
  async getReturnCenters() {
    const path = `/v2/providers/openapi/apis/api/v5/vendors/${this.vendorId}/returnShippingCenters`;
    return this._request('GET', path);
  }

  // ──────────────────────────────────────────
  // 상품 등록 / 조회 / 수정
  // ──────────────────────────────────────────

  /**
   * 상품을 등록합니다.
   * @param {object} productBody - 쿠팡 상품 등록 API 포맷의 JSON
   * @returns {object} - 등록 결과 (sellerProductId 등)
   */
  async registerProduct(productBody) {
    const path = `${API_PATH_PREFIX}/seller-products`;
    return this._request('POST', path, productBody);
  }

  /**
   * 등록된 상품 정보를 조회합니다. (30초 단기 캐시 — 일괄 수정 시 가격/이미지 중복 호출 방지)
   * @param {string|number} sellerProductId - 판매자 상품 ID
   * @param {{ force?: boolean }} [options]
   */
  async getProduct(sellerProductId, { force = false } = {}) {
    const key = String(sellerProductId);
    const now = Date.now();
    const cached = this._productCache?.get(key);
    if (!force && cached && (now - cached.at) < 30000) {
      console.log(`[CoupangAPI] getProduct 캐시 사용 (ID: ${key})`);
      return cached.data;
    }
    const path = `${API_PATH_PREFIX}/seller-products/${sellerProductId}`;
    const res = await this._request('GET', path);
    if (res && (res.code === 'SUCCESS' || res.data) && res.data) {
      if (!this._productCache) this._productCache = new Map();
      this._productCache.set(key, { data: res, at: now });
    }
    return res;
  }

  clearProductCache(sellerProductId = null) {
    if (sellerProductId) this._productCache?.delete(String(sellerProductId));
    else this._productCache?.clear();
  }

  /**
   * 등록 상품 목록을 한 페이지 조회합니다. (nextToken 페이징)
   */
  async listProducts(nextToken = '', maxPerPage = 100) {
    const path = `${API_PATH_PREFIX}/seller-products?vendorId=${this.vendorId}&maxPerPage=${maxPerPage}`
      + (nextToken ? `&nextToken=${nextToken}` : '');
    return this._request('GET', path);
  }

  /**
   * 등록된 상품을 수정합니다.
   * 수정 API는 경로에 ID를 포함하지 않고, body에 sellerProductId를 포함해야 합니다.
   */
  async updateProduct(sellerProductId, productBody) {
    this.clearProductCache(sellerProductId);
    const path = `${API_PATH_PREFIX}/seller-products`;
    // sellerProductId를 body에 주입
    const body = { ...productBody, sellerProductId: Number(sellerProductId) };
    return this._request('PUT', path, body);
  }

  /**
   * 옵션(vendorItemId) 하나의 현재 판매가·재고·판매 상태를 조회합니다.
   * @returns {{sellerItemId, amountInStock, salePrice, onSale}}
   */
  async getItemInventory(vendorItemId) {
    if (!/^\d+$/.test(String(vendorItemId ?? ''))) throw new Error('옵션ID(vendorItemId)가 올바르지 않습니다.');
    const res = await this._request('GET', `${API_PATH_PREFIX}/vendor-items/${vendorItemId}/inventories`);
    if (!res?.data || res.data.salePrice == null) throw new Error(`쿠팡 옵션(${vendorItemId}) 가격 응답을 확인할 수 없습니다.`);
    this._sawPrice(vendorItemId, res.data.salePrice);
    return res.data;
  }

  /**
   * 판매가를 알게 될 때마다(가격 조회·가격 변경) 알린다 — Coupang 이 로컬 판매가 캐시를 채운다(coupang_store.js).
   * 쿠팡 판매가는 이 두 API 로만 읽고 바꾸므로 여기 한 곳이면 일괄 수정·상품 수정 탭·셸 일괄 수정이 다 지나간다.
   * 캐시가 실패해도 쿠팡 호출 결과는 그대로 돌려준다.
   */
  _sawPrice(vendorItemId, salePrice) {
    if (typeof this.onPrice !== 'function') return;
    try { this.onPrice(String(vendorItemId), salePrice); }
    catch (e) { console.warn('[CoupangAPI] 판매가 캐시 반영 실패(무시):', e.message); }
  }

  /**
   * 승인완료 상품의 옵션 판매가를 바꿉니다. 상품 수정(PUT seller-products)은 승인 전에만 판매가를
   * 바꿀 수 있고 승인 요청까지 다시 보내므로, 판매가는 반드시 이 API 로 바꿉니다.
   * 쿠팡 제약: 10원 단위, 기본 변경폭은 기존가 대비 50% 인하·100% 인상까지(force 로 해제).
   */
  async updateItemPrice(vendorItemId, price, { force = false } = {}) {
    this.clearProductCache();
    if (!/^\d+$/.test(String(vendorItemId ?? ''))) throw new Error('옵션ID(vendorItemId)가 올바르지 않습니다.');
    const value = Number(price);
    if (!Number.isSafeInteger(value) || value <= 0 || value % 10 !== 0) throw new Error('쿠팡 판매가는 10원 단위 양의 정수여야 합니다.');
    const path = `${API_PATH_PREFIX}/vendor-items/${vendorItemId}/prices/${value}` + (force ? '?forceSalePriceUpdate=true' : '');
    const res = await this._request('PUT', path);
    this._sawPrice(vendorItemId, value);   // 거부(code:ERROR)는 _request 가 던지므로 여기 오면 쿠팡이 받은 값이다
    return res;
  }

  /**
   * 승인완료 상품의 옵션 재고를 바꿉니다. 승인완료 상품의 가격·재고는 상품 수정(PUT seller-products)으로
   * 바뀌지 않는다 — 쿠팡 공식 문서 '가격과 재고가 변경되지 않습니다' · '상품 아이템별 수량 변경'.
   */
  async updateItemQuantity(vendorItemId, quantity) {
    this.clearProductCache();
    if (!/^\d+$/.test(String(vendorItemId ?? ''))) throw new Error('옵션ID(vendorItemId)가 올바르지 않습니다.');
    const value = Number(quantity);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('쿠팡 재고는 0 이상의 정수여야 합니다.');
    return this._request('PUT', `${API_PATH_PREFIX}/vendor-items/${vendorItemId}/quantities/${value}`);
  }
}
