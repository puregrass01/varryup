// eBay US Sell APIs. Credentials and access tokens stay in the main process.
import { apiError } from '../utils/api_error.js';
export const EBAY_SCOPES = [
  'https://api.ebay.com/oauth/api_scope',
  'https://api.ebay.com/oauth/api_scope/sell.inventory',
  'https://api.ebay.com/oauth/api_scope/sell.account.readonly'
].join(' ');

export class EbayAPIError extends Error {
  constructor(status, data) {
    const errors = data.errors || [];
    super(errors.map(e => `[${e.errorId}] ${e.longMessage || e.message}`).join('; ') || `eBay HTTP ${status}`);
    this.status = status;
    this.errors = errors;
  }
}

export class EbayAPI {
  constructor(config, { fetchImpl = fetch, sleep = ms => new Promise(r => setTimeout(r, ms)), proxy = {} } = {}) {
    this.config = config;
    this.fetch = fetchImpl;
    this.sleep = sleep;
    this.proxyUrl = proxy?.proxyUrl || '';
    this.proxyToken = proxy?.proxyToken || '';
    if (!['sandbox', 'production'].includes(config.environment)) throw new Error('잘못된 eBay 환경입니다.');
    this.base = config.environment === 'production' ? 'https://api.ebay.com' : 'https://api.sandbox.ebay.com';
    this.accessToken = null;
    this.expiresAt = 0;
  }

  async tokenRequest(values) {
    const { clientId, clientSecret } = this.config;
    if (!clientId || !clientSecret) throw new Error('Client ID와 Client Secret을 저장해주세요.');
    const response = await this.fetch(`${this.base}/identity/v1/oauth2/token`, {
      method: 'POST', signal: AbortSignal.timeout(30000),
      headers: { Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(values).toString()
    });
    const text = await response.text();
    let data = {};
    if (text) { try { data = JSON.parse(text); } catch { data = {}; } }
    // Token endpoint responses can contain credentials. Only the OAuth error fields are
    // safe to surface; access_token and refresh_token must never reach a log or the UI.
    if (!response.ok || !data.access_token) {
      const detail = [data.error_id || data.error, data.error_description].filter(Boolean).join(': ');
      const message = `eBay 인증 실패 (HTTP ${response.status})${detail ? ` — ${detail}` : ''}. 환경, 키, 동의 범위를 확인하고 다시 연결해주세요.`;
      // 5xx·429 는 키 문제가 아니다. 그대로 status 로 분류되게 하고, 그 밖의 실패만 인증 실패로 표시한다.
      throw apiError(message, response.status === 429 || response.status >= 500
        ? { status: response.status } : { status: response.status, authFailure: true });
    }
    this.accessToken = data.access_token;
    this.expiresAt = Date.now() + Math.max(0, Number(data.expires_in || 0) - 60) * 1000;
    return data;
  }

  async token() {
    if (this.accessToken && Date.now() < this.expiresAt) return this.accessToken;
    if (!this.config.refreshToken) throw new Error('판매자 계정을 연결하거나 Refresh Token을 저장해주세요.');
    if (!this.refreshing) this.refreshing = this.tokenRequest({ grant_type: 'refresh_token', refresh_token: this.config.refreshToken, scope: EBAY_SCOPES }).finally(() => { this.refreshing = null; });
    await this.refreshing;
    return this.accessToken;
  }

  async request(method, path, body, attempt = 0) {
    if (!path.startsWith('/') || path.startsWith('//')) throw new Error('잘못된 API 경로입니다.');
    let response;
    try {
      if (this.proxyUrl && !this.proxyToken) throw apiError('서버 프록시 인증이 필요합니다. 직원 계정으로 다시 로그인해주세요.', { status: 401, proxyError: true });
      const headers = { Authorization: `Bearer ${await this.token()}`, 'Content-Type': 'application/json', 'Content-Language': 'en-US', 'Accept-Language': 'en-US' };
      const bodyStr = body === undefined ? undefined : JSON.stringify(body);
      response = this.proxyUrl
        ? await this.fetch(`${this.proxyUrl.replace(/\/+$/, '')}/ebay`, {
          method: 'POST', signal: AbortSignal.timeout(90000), redirect: 'error',
          headers: { Authorization: `Bearer ${this.proxyToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ method, url: `${this.base}${path}`, headers, body: bodyStr })
        })
        : await this.fetch(`${this.base}${path}`, {
          method, signal: AbortSignal.timeout(30000), redirect: 'error', headers,
          ...(bodyStr === undefined ? {} : { body: bodyStr })
        });
    } catch (error) {
      const timeout = error.name === 'TimeoutError' || error.name === 'AbortError';
      if (timeout || error instanceof TypeError) {
        const cause = timeout ? '시간 초과' : `네트워크 오류: ${error.cause?.code || error.cause?.message || error.message}`;
        const advice = method === 'GET' ? '' : ' 변경 요청은 자동 재전송하지 않습니다. SKU로 상태를 다시 조회해주세요.';
        throw apiError(`eBay 응답을 확인하지 못했습니다 (${cause}).${advice}`, timeout ? { timeout, cause: error } : { network: true, cause: error });
      }
      throw error;
    }
    const text = await response.text();
    let data = {};
    let invalidJson = false;
    if (text) { try { data = JSON.parse(text); } catch { invalidJson = true; } }
    // Staff-token failures must not refresh eBay OAuth or retry a write.
    const missingProxyRoute = this.proxyUrl && response.status === 404 && data?.detail === 'Not Found';
    if (data?.proxyError || missingProxyRoute) {
      const message = missingProxyRoute
        ? '관리자 서버에 /ebay 프록시 경로가 없습니다. USE_EBAY_PROXY=1 설정을 해제하고 앱을 다시 실행해주세요.'
        : data.message || '요청 실패';
      const error = new Error(`서버 프록시 오류 (${response.status}): ${message}`);
      error.status = response.status;
      error.proxyError = true;
      throw error;
    }
    if (response.status === 401 && attempt === 0) {
      this.accessToken = null;
      return this.request(method, path, body, 1);
    }
    // Read operations alone are retried. A timed-out create may already have succeeded.
    if (method === 'GET' && (response.status === 429 || response.status >= 500) && attempt < 2) {
      const retrySeconds = Number(response.headers.get('retry-after'));
      await this.sleep(Math.min(10000, Math.max(1000 * 2 ** attempt, (retrySeconds || 0) * 1000)));
      return this.request(method, path, body, attempt + 1);
    }
    if (invalidJson) throw new Error(`eBay 응답 형식 오류 (HTTP ${response.status})`);
    if (!response.ok) throw new EbayAPIError(response.status, data);
    return data;
  }

  async inventory(sku) {
    try { return await this.request('GET', `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`); }
    // 25710: 이 SKU 의 인벤토리 없음, 25702: SKU 를 찾을 수 없음(getInventoryItem 문서). 둘 다 '없음'이다.
    catch (e) { if ([400, 404].includes(e.status) && e.errors?.some(x => [25710, 25702].includes(Number(x.errorId)))) return null; throw e; }
  }

  async inventoryItems(offset = 0, limit = 100) {
    return this.request('GET', `/sell/inventory/v1/inventory_item?limit=${limit}&offset=${offset}`);
  }

  async offers(sku) {
    try {
      const res = await this.request('GET', `/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}&format=FIXED_PRICE&limit=200`);
      const allOffers = res.offers || [];
      const usOffers = allOffers.filter(o => ['EBAY_US', 'EBAY_MOTORS', 'EBAY_MOTORS_US'].includes(o.marketplaceId));
      return usOffers.length ? usOffers : allOffers;
    } catch (e) {
      if ([400, 404].includes(e.status) && e.errors?.some(x => Number(x.errorId) === 25713)) return [];
      throw e;
    }
  }

  async aspects(categoryId) {
    if (!/^\d+$/.test(categoryId)) throw new Error('숫자 카테고리 ID를 입력해주세요.');
    const tree = await this.request('GET', '/commerce/taxonomy/v1/get_default_category_tree_id?marketplace_id=EBAY_US');
    if (!tree.categoryTreeId) throw new Error('미국 카테고리 트리를 찾을 수 없습니다.');
    return this.request('GET', `/commerce/taxonomy/v1/category_tree/${encodeURIComponent(tree.categoryTreeId)}/get_item_aspects_for_category?category_id=${categoryId}`);
  }

  async getActiveListings(pageNumber = 1, entriesPerPage = 100) {
    const token = await this.token();
    const tradingUrl = this.config.environment === 'production'
      ? 'https://api.ebay.com/ws/api.dll'
      : 'https://api.sandbox.ebay.com/ws/api.dll';

    const xml = `<?xml version="1.0" encoding="utf-8"?>
<GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ActiveList>
    <Include>true</Include>
    <Pagination>
      <EntriesPerPage>${entriesPerPage}</EntriesPerPage>
      <PageNumber>${pageNumber}</PageNumber>
    </Pagination>
  </ActiveList>
</GetMyeBaySellingRequest>`;

    const response = await this.fetch(tradingUrl, {
      method: 'POST',
      signal: AbortSignal.timeout(30000),
      headers: {
        'X-EBAY-API-SITEID': '0',
        'X-EBAY-API-COMPATIBILITY-LEVEL': '1225',
        'X-EBAY-API-CALL-NAME': 'GetMyeBaySelling',
        'X-EBAY-API-IAF-TOKEN': token,
        'Content-Type': 'text/xml'
      },
      body: xml
    });

    const text = await response.text();
    if (!response.ok) throw new Error(`eBay GetMyeBaySelling 실패 (HTTP ${response.status})`);

    const ackMatch = text.match(/<Ack>(.*?)<\/Ack>/);
    const ack = ackMatch ? ackMatch[1] : '';
    if (ack !== 'Success' && ack !== 'Warning') {
      const errMatch = text.match(/<LongMessage>(.*?)<\/LongMessage>/) || text.match(/<ShortMessage>(.*?)<\/ShortMessage>/);
      throw new Error(`eBay GetMyeBaySelling 오류: ${errMatch ? errMatch[1] : ack || '요청 실패'}`);
    }

    const totalMatch = text.match(/<TotalNumberOfEntries>(\d+)<\/TotalNumberOfEntries>/);
    const totalPagesMatch = text.match(/<TotalNumberOfPages>(\d+)<\/TotalNumberOfPages>/);
    const total = totalMatch ? Number(totalMatch[1]) : 0;
    const totalPages = totalPagesMatch ? Number(totalPagesMatch[1]) : 0;

    const items = [];
    const itemMatches = text.match(/<Item>[\s\S]*?<\/Item>/g) || [];
    for (const m of itemMatches) {
      const itemID = (m.match(/<ItemID>(\d+)<\/ItemID>/) || [])[1] || '';
      const title = (m.match(/<Title>(.*?)<\/Title>/) || [])[1] || '';
      const sku = (m.match(/<SKU>(.*?)<\/SKU>/) || [])[1] || '';
      const price = (m.match(/<CurrentPrice[^>]*>(.*?)<\/CurrentPrice>/) || [])[1] || (m.match(/<BuyItNowPrice[^>]*>(.*?)<\/BuyItNowPrice>/) || [])[1] || '';
      const quantity = (m.match(/<Quantity>(\d+)<\/Quantity>/) || [])[1] || '';
      const url = (m.match(/<ViewItemURL>(.*?)<\/ViewItemURL>/) || [])[1] || '';
      if (itemID) {
        items.push({ itemID, title, sku, price, quantity, url });
      }
    }

    return { total, totalPages, pageNumber, entriesPerPage, items };
  }

  async bulkMigrateListing(listingIds) {
    if (!Array.isArray(listingIds) || !listingIds.length) return { responses: [] };
    if (listingIds.length > 5) throw new Error('bulkMigrateListing 은 한 번에 최대 5개까지 요청할 수 있습니다.');
    const requests = listingIds.map(id => ({ listingId: String(id).trim() }));
    return this.request('POST', '/sell/inventory/v1/bulk_migrate_listing', { requests });
  }

  async getItem(itemId) {
    const token = await this.token();
    const tradingUrl = this.config.environment === 'production'
      ? 'https://api.ebay.com/ws/api.dll'
      : 'https://api.sandbox.ebay.com/ws/api.dll';

    const xml = `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ItemID>${encodeURIComponent(itemId)}</ItemID>
</GetItemRequest>`;

    try {
      const response = await this.fetch(tradingUrl, {
        method: 'POST',
        signal: AbortSignal.timeout(15000),
        headers: {
          'X-EBAY-API-SITEID': '0',
          'X-EBAY-API-COMPATIBILITY-LEVEL': '1225',
          'X-EBAY-API-CALL-NAME': 'GetItem',
          'X-EBAY-API-IAF-TOKEN': token,
          'Content-Type': 'text/xml'
        },
        body: xml
      });

      const text = await response.text();
      if (!response.ok) return null;
      const skuMatch = text.match(/<SKU>(.*?)<\/SKU>/);
      const titleMatch = text.match(/<Title>(.*?)<\/Title>/);
      return {
        itemID: itemId,
        sku: skuMatch ? skuMatch[1] : '',
        title: titleMatch ? titleMatch[1] : ''
      };
    } catch (_) {
      return null;
    }
  }
}

