import crypto from 'crypto';

const API_BASE = 'https://api-gateway.coupang.com';
const API_PATH_PREFIX = '/v2/providers/seller_api/apis/api/v1/marketplace';

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
  constructor(vendorId, accessKey, secretKey, vendorUserId = '') {
    this.vendorId = vendorId;
    this.accessKey = accessKey;
    this.secretKey = secretKey;
    this.vendorUserId = vendorUserId || vendorId;
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
  async _request(method, path, body = null) {
    const { authorization } = this._buildAuthHeader(method, path);

    const headers = {
      'Authorization': authorization,
      'Content-Type': 'application/json;charset=UTF-8',
      'X-Requested-By': this.vendorUserId,
      'X-MARKET': 'KR'
    };

    const url = `${API_BASE}${path}`;
    const options = { method: method.toUpperCase(), headers };
    if (body && (method.toUpperCase() === 'POST' || method.toUpperCase() === 'PUT')) {
      options.body = JSON.stringify(body);
    }

    console.log(`[CoupangAPI] ${method.toUpperCase()} ${path}`);

    let response;
    let text;
    try {
      response = await fetch(url, options);
      text = await response.text();
    } catch (error) {
      console.error(`[CoupangAPI] Fetch Error:`, error);
      if (error.cause) {
        console.error(`[CoupangAPI] Fetch Error Cause:`, error.cause);
        throw new Error(`fetch failed: ${error.cause.message || error.cause.code || error.cause}`);
      }
      throw error;
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { rawResponse: text };
    }

    if (!response.ok) {
      const errMsg = data?.message || data?.error || `HTTP ${response.status}`;
      console.error(`[CoupangAPI] Error: ${errMsg}`, data);
      throw new Error(`쿠팡 API 오류 (${response.status}): ${errMsg}`);
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
  // 카테고리 관련
  // ──────────────────────────────────────────

  /**
   * 전체 카테고리 목록을 조회합니다.
   */
  async getCategories() {
    const path = `${API_PATH_PREFIX}/meta/display-categories`;
    return this._request('GET', path);
  }

  /**
   * 특정 카테고리의 메타 정보(필수 속성, 고시정보 등)를 조회합니다.
   */
  async getCategoryMeta(displayCategoryCode) {
    const path = `${API_PATH_PREFIX}/meta/category-related-metas/display-category-codes/${displayCategoryCode}`;
    return this._request('GET', path);
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
   * 등록된 상품 정보를 조회합니다.
   * @param {string} sellerProductId - 판매자 상품 ID
   */
  async getProduct(sellerProductId) {
    const path = `${API_PATH_PREFIX}/seller-products/${sellerProductId}`;
    return this._request('GET', path);
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
    const path = `${API_PATH_PREFIX}/seller-products`;
    // sellerProductId를 body에 주입
    const body = { ...productBody, sellerProductId: Number(sellerProductId) };
    return this._request('PUT', path, body);
  }

  /**
   * 상품 판매를 중지합니다.
   */
  async stopSelling(sellerProductId) {
    const path = `${API_PATH_PREFIX}/seller-products/${sellerProductId}/sales/stop`;
    return this._request('PUT', path);
  }
}
