import { AmazonAPI, SEARCH_IDENTIFIERS_MAX } from './amazon_api.js';
import { markPreSend } from '../utils/api_error.js';
import { amazonImageUrls, parseImageUrls, sameImages } from '../utils/bulk_images.js';
import { matchesProduct } from './product_search.js';
import { amazonSkuOf, amazonMarketplaceOf } from '../utils/duplicate_guard.js';
import { writeJsonAtomic } from '../utils/json_file.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

// SP-API uses LWA authentication; discard retired IAM settings from older configs.
export function cleanAmazonConfig(config) {
  const cleaned = { ...config };
  for (const field of ['awsAccessKeyId', 'awsSecretAccessKey', 'region']) delete cleaned[field];
  // UI 입력은 저장 전에 trim 되지만, 관리 서버가 밀어넣는 값은 그대로 들어온다
  // (main_process.js mergeIntoConfig). 공백·개행이 섞이면 LWA 는 invalid_client,
  // SP-API 는 400 으로 떨어지는데 어느 쪽도 원인을 알려주지 않는다.
  for (const field of ['sellerId', 'clientId', 'clientSecret', 'refreshToken',
    'jpSellerId', 'jpClientId', 'jpClientSecret', 'jpRefreshToken']) {
    if (typeof cleaned[field] === 'string') cleaned[field] = cleaned[field].trim();
  }
  return cleaned;
}

/** 전체 카탈로그 스냅샷용 리포트. Product Listing 역할로 커버된다. */
export const LISTINGS_REPORT_TYPE = 'GET_MERCHANT_LISTINGS_ALL_DATA';

/**
 * 마켓플레이스 프로파일. src/ui/index.html 의 AMZ_MARKETPLACES 와 같은 값을 유지할 것
 * — 엔드포인트가 어긋나면 서명이 깨지고, 통화가 어긋나면 엉뚱한 가격이 등록된다.
 */
export const JP_MARKETPLACE_ID = 'A1VC38T7YXB528';
export const US_MARKETPLACE_ID = 'ATVPDKIKX0DER';
export const MARKETPLACE_CURRENCY = {
  [US_MARKETPLACE_ID]: 'USD',
  [JP_MARKETPLACE_ID]: 'JPY'
};

// A 403 alone does not prove which seller region owns a refresh token.
const JP_AUTH_HINT = '북미(미국) 계정용 인증만 등록했다면 일본 판매자 계정의 앱 승인을 확인해주세요. '
  + 'API KEY > 아마존 > 일본 설정에 일본 Refresh Token(jpRefreshToken)을 입력할 수 있습니다. '
  + '일본용 토큰도 거부되면 해당 앱 권한과 승인 상태를 확인해주세요.';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// 일본 마켓 리포트는 열 이름이 일본어로 온다(2026-09-30 실제 리포트: 商品名·出品者SKU·価格·数量·商品ID…).
// 헤더를 소문자로 비교하므로 키도 소문자(SKU→sku, ID→id)로 적는다.
const JP_REPORT_HEADERS = {
  '商品名': 'item-name', '出品者sku': 'seller-sku', '価格': 'price', '数量': 'quantity',
  '商品説明': 'item-description', '商品id': 'product-id', '商品idタイプ': 'product-id-type'
};

/**
 * GET_MERCHANT_LISTINGS_ALL_DATA(탭 구분 플랫파일)를 UI 행 형태로 바꾼다.
 * 열 순서는 마켓플레이스마다 다를 수 있어 헤더 이름으로 찾는다.
 */
export function parseListingsReport(text) {
  const lines = String(text || '').split(/\r?\n/);
  const headerLine = lines.shift();
  if (!headerLine) return [];
  // trim 은 첫 열의 BOM(U+FEFF)도 지운다.
  const header = headerLine.split('\t').map(h => h.trim().toLowerCase()).map(h => JP_REPORT_HEADERS[h] || h);
  const at = (...names) => {
    for (const name of names) {
      const i = header.indexOf(name);
      if (i !== -1) return i;
    }
    return -1;
  };
  const iSku = at('seller-sku', 'sku');
  if (iSku === -1) throw new Error('리포트에 seller-sku 열이 없습니다. 리포트 형식을 확인해주세요.');
  const iName = at('item-name', 'title');
  const iPrice = at('price');
  const iQty = at('quantity');
  const iDesc = at('item-description');
  const iAsin = at('asin1', 'asin');
  // 일본 리포트에는 asin1 열이 없고 商品ID 에 ASIN 이 온다(商品IDタイプ 1 = ASIN).
  const iPid = at('product-id');
  const iPidType = at('product-id-type');
  const iBrand = at('brand', 'brand-name'); // 이 리포트에는 보통 없다 — 없으면 빈 값

  const cell = (cols, i) => (i === -1 ? '' : String(cols[i] ?? '').trim());
  const rows = [];
  for (const line of lines) {
    if (!line) continue;
    const cols = line.split('\t');
    const sku = cell(cols, iSku);
    if (!sku) continue;
    rows.push({
      id: sku,
      name: cell(cols, iName) || sku,
      price: cell(cols, iPrice),
      stock: cell(cols, iQty),
      description: cell(cols, iDesc),
      brand: cell(cols, iBrand),
      asin: cell(cols, iAsin) || (cell(cols, iPidType) === '1' ? cell(cols, iPid) : '')
    });
  }
  return rows;
}

// 디버그 로그용 임시 폴더
function _debugDir() {
  try {
    const d = path.join(os.tmpdir(), 'antigravity-debug');
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    return d;
  } catch {
    return null;
  }
}

/** URL 안전 인코딩 헬퍼 */
function getSafeUrl(urlStr) {
  if (!urlStr) return '';
  try {
    let url = urlStr.trim();
    const match = url.match(/src=["']([^"']+)["']/i);
    if (match) url = match[1];
    return encodeURI(decodeURIComponent(url));
  } catch {
    return urlStr;
  }
}

/** HTML 태그 제거 및 텍스트 정리 헬퍼 (아마존 설명용) */
function stripHtmlToPlainText(html) {
  if (!html) return '';
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*[\/]?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 빈 값(미입력) 판별 — 수정 요청에서 건드리면 안 되는 필드를 가려낸다 */
function isBlank(value) {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/** 일본 판매가는 이미 환산된 price(JPY)만 받는다. USD를 엔으로 해석하거나 임의 환율로 바꾸지 않는다. */
function listingPrice(data, marketplaceId, required = false) {
  if (marketplaceId !== JP_MARKETPLACE_ID) {
    const input = isBlank(data.priceUsd) ? data.price : data.priceUsd;
    return isBlank(input) ? NaN : parseFloat(input);
  }
  if (isBlank(data.price)) {
    if (required || !isBlank(data.priceUsd))
      throw markPreSend(new Error('일본 판매가(엔)를 입력하세요. USD 가격은 환율로 계산한 JPY 값을 price에 전달해야 합니다.'));
    return NaN;  // 이미지·설명만 바꾸는 요청은 판매가를 유지한다.
  }
  if (!isBlank(data.currency) && data.currency !== 'JPY')
    throw markPreSend(new Error('일본 마켓플레이스 판매가 통화는 JPY여야 합니다.'));
  const text = String(data.price).trim(), price = Number(text);
  if (!/^\d+(?:\.0+)?$/.test(text) || !Number.isSafeInteger(price) || price <= 0)
    throw markPreSend(new Error('일본 판매가(엔)는 1 이상의 정수로 입력하세요.'));
  return price;
}

/** 불릿 포인트 입력(배열 또는 줄바꿈 문자열) 정리 */
function normalizeBullets(input) {
  let list = [];
  if (Array.isArray(input)) list = input.map(b => String(b).trim()).filter(Boolean);
  else if (typeof input === 'string') list = input.split('\n').map(b => b.trim()).filter(Boolean);
  // 'About this item' 섹션 헤더가 포함되어 있다면 불릿 항목에서 제외
  return list.filter(b => !/^about\s+this\s+item:?$/i.test(b));
}

/** 기존 리스팅 속성을 훼손하지 않도록 깊은 복사 */
function cloneAttr(value) {
  return value === undefined || value === null ? value : JSON.parse(JSON.stringify(value));
}

/** 수정 비교용: 그 마켓에서 보이는 값만 뽑는다(언어 태그·다른 마켓 값·오퍼 부가 항목은 비교하지 않는다). 읽기(productForEdit)와 같은 값이다. */
function marketView(key, rows, marketplaceId) {
  const list = Array.isArray(rows) ? rows : [];
  if (key === 'fulfillment_availability') return list.filter(a => a?.fulfillment_channel_code === 'DEFAULT').map(a => Number(a.quantity));
  const mine = list.filter(v => !v?.marketplace_id || v.marketplace_id === marketplaceId);
  if (key === 'purchasable_offer') return mine.filter(o => !o?.audience || o.audience === 'ALL').map(o => Number(o?.our_price?.[0]?.schedule?.[0]?.value_with_tax));
  return mine.map(v => v?.value ?? v?.media_location);
}

/**
 * Listings Items PUT/PATCH 응답이 실제로 접수됐는지 확인한다.
 * SP-API 는 검증 실패를 HTTP 200 + status:"INVALID" + issues[] 로 돌려준다. 예전엔 이걸 그대로
 * 성공으로 보고하고 로컬 캐시까지 새 값으로 고쳐서, 아마존에는 없는 변경이 목록에 보였다.
 * status 가 ACCEPTED 가 아니면(없어도) 던진다 — 메시지에 이슈 코드·내용을 담는다.
 */
export function assertListingAccepted(result, action = '등록') {
  const status = String(result?.status || '');
  if (status === 'ACCEPTED') return result;
  const issues = (Array.isArray(result?.issues) ? result.issues : [])
    .map(i => [i?.severity === 'WARNING' ? '[경고]' : '', [i?.code, i?.message].filter(Boolean).join(': ')].filter(Boolean).join(' ')
      + (Array.isArray(i?.attributeNames) && i.attributeNames.length ? ` (${i.attributeNames.join(', ')})` : ''))
    .filter(Boolean);
  throw new Error(`아마존이 상품 ${action}을 거부했습니다 (상태: ${status || '없음'})`
    + (issues.length ? ` — ${issues.join(' | ')}` : ''));
}

// PATCH 를 지원하지 않는 상품 유형일 때 아마존이 주는 오류인지. 이 경우에만 전체 문서 PUT 으로 넘어간다.
// 429·5xx·네트워크 오류까지 PUT 으로 넘기면, PATCH 를 받아 줄 수 있었던 리스팅을 전체 교체로
// 다시 보내게 되고(재시도 폭주·다른 속성 덮어쓰기 위험) 원래 오류도 가려진다.
function isPatchUnsupportedError(err) {
  const msg = String(err?.message || '');
  return /patch/i.test(msg) && /(not\s+supported|unsupported|does\s+not\s+support|is\s+not\s+allowed)/i.test(msg);
}

/**
 * 아마존 상품 등록 / 관리 모듈 (SP-API 방식)
 */
export class Amazon {
  constructor(configPath, store = null) {
    this.configPath = configPath;
    this.store = store;   // AmazonStore. 없으면 캐시 기능만 꺼지고 나머지는 그대로 동작한다.
    this.config = null;
    this.api = null;
    // loadConfig 가 AmazonAPI 를 새로 만들어도 LWA 액세스 토큰은 이어서 쓴다(amazon_api.js tokenCache).
    this._lwaTokens = new Map();
  }

  readConfig() {
    if (!fs.existsSync(this.configPath)) {
      throw new Error('아마존 설정 파일이 없습니다. 먼저 API 설정을 완료해주세요.');
    }
    const raw = fs.readFileSync(this.configPath, 'utf-8');
    return cleanAmazonConfig(JSON.parse(raw));
  }

  loadConfig() {
    this.config = this.readConfig();
    const complete = c => c && ['sellerId', 'clientId', 'clientSecret', 'refreshToken'].every(k => c[k]);
    if (!complete(this.config) && !complete(this._jpCredentials())) {
      throw new Error('아마존 API 필수 인증값(Seller ID, Client ID, Secret, Refresh Token)이 설정되지 않았습니다. 아마존 탭에서 API 설정을 완료해주세요.');
    }

    this.api = new AmazonAPI({
      sellerId: this.config.sellerId,
      clientId: this.config.clientId,
      clientSecret: this.config.clientSecret,
      refreshToken: this.config.refreshToken,
      endpoint: this.config.endpoint || 'https://sellingpartnerapi-na.amazon.com',
      marketplaceId: this.config.marketplaceId || 'ATVPDKIKX0DER',
      proxy: this._proxyOpts(),
      tokenCache: this._lwaTokens
    });

    return this.config;
  }

  /**
   * 고정 IP 프록시 옵션. runtimeProxy(로그인 시 메모리에 주입되는 직원 토큰)가 우선이고,
   * 설정 파일 값은 폴백이다. 토큰은 일부러 디스크에 쓰지 않으므로 config.proxyToken 은
   * 보통 비어 있다 — 그래서 AmazonAPI 를 새로 만드는 모든 자리에서 반드시 이 함수를 써야 한다.
   * (apiForMarketplace 가 this.config 만 읽는 바람에 일본 마켓플레이스가 프록시를 우회했었다.)
   */
  _proxyOpts() {
    // 명시적인 직접 호출 정책은 저장된 프록시 설정보다 우선한다.
    if (this.runtimeProxy === null) return {};
    return {
      proxyUrl: this.runtimeProxy?.proxyUrl || this.config?.proxyUrl || '',
      proxyToken: this.runtimeProxy?.proxyToken || this.config?.proxyToken || ''
    };
  }

  saveConfig(newConfig) {
    // 통째로 덮어쓰지 않고 병합한다. 설정 폼은 12개 필드만 들고 있어서, 전체 쓰기를 하면
    // 폼에 없는 값(manufacturer, 서버가 내려준 proxyUrl/proxyToken 등)이 조용히 사라진다.
    // 연결 테스트 버튼도 저장을 먼저 하므로 같은 일이 벌어졌다.
    // 메모리의 this.config 는 오래됐거나 비어 있을 수 있어 파일을 새로 읽어 기준으로 삼는다.
    // (빈 문자열을 보내면 그대로 덮어써진다 — 값을 지우는 동작은 그대로 살아 있다.)
    let current = {};
    try {
      if (fs.existsSync(this.configPath)) {
        current = JSON.parse(fs.readFileSync(this.configPath, 'utf-8')) || {};
      }
    } catch (e) {
      // 파일이 깨졌으면 병합을 포기하고 새 값으로 간다. 저장 자체를 막지는 않는다.
      console.warn('아마존 설정 파일을 읽지 못해 병합 없이 저장합니다:', e.message);
      current = {};
    }

    const merged = cleanAmazonConfig({ ...current, ...newConfig });

    // tmp → rename 으로 원자적으로 쓴다. 쓰다가 죽어도 기존 설정이 잘린 채 남지 않는다.
    writeJsonAtomic(this.configPath, merged);

    this.config = merged;
    this.api = null; // 인스턴스 재생성 대기
    return this.config;
  }

  async testConnection(marketplaceId) {
    if (!this.api) this.loadConfig();
    const mp = marketplaceId || this.config.marketplaceId || US_MARKETPLACE_ID;
    const api = this.apiForMarketplace(mp);
    const result = await api.testConnection();
    if (!result.participations.some(p => p.id === mp)) {
      throw new Error(`요청한 마켓플레이스(${mp})에 판매 참여가 확인되지 않았습니다. 해당 국가의 판매자 계정과 앱 승인을 확인해주세요.`);
    }
    // 참여 확인은 Seller ID 를 쓰지 않아 틀려도 통과한다. 지역마다 판매자 토큰이 달라
    // 미국 ID 로 일본 리스팅을 부르면 "Invalid 'accountId'" 가 나므로, 리스팅 1건 조회로 확인한다.
    const label = mp === JP_MARKETPLACE_ID ? '일본' : '미국';
    try {
      await api.verifySeller(mp);
    } catch (e) {
      if (!api.sellerId || /Merchant Token|accountId/i.test(e.message)) {
        const where = mp === JP_MARKETPLACE_ID
          ? '셀러센트럴 일본 > 설정 > 계정 정보의 판매자 토큰을 API KEY > 아마존 > 일본 설정의 Seller ID 에'
          : '셀러센트럴 > 설정 > 계정 정보의 판매자 토큰(Merchant Token)을 Seller ID 에';
        throw new Error(`${label} 연결과 마켓 참여는 확인됐지만 Seller ID(${api.sellerId || '비어 있음'})가 ${label} 판매자 계정과 맞지 않습니다. `
          + `${where} 넣어주세요.`, { cause: e });
      }
      throw new Error(`${label} 연결은 됐지만 리스팅 조회가 거부됐습니다: ${e.message}`, { cause: e });
    }
    return { ...result, marketplaceId: mp, sellerId: api.sellerId,
      message: `아마존 ${mp === JP_MARKETPLACE_ID ? '일본' : '미국'} SP-API 연결 및 마켓 참여 확인 완료` };
  }

  sellerForMarketplace(marketplaceId) {
    return (marketplaceId === JP_MARKETPLACE_ID ? this._jpCredentials()?.sellerId : null) || this.config?.sellerId || '';
  }

  apiForMarketplace(marketplaceId) {
    if (!this.api) this.loadConfig();
    const endpoint = {
      [US_MARKETPLACE_ID]: 'https://sellingpartnerapi-na.amazon.com',
      [JP_MARKETPLACE_ID]: 'https://sellingpartnerapi-fe.amazon.com'
    }[marketplaceId];
    const jp = marketplaceId === JP_MARKETPLACE_ID ? this._jpCredentials() : null;
    if (!endpoint || (this.api.endpoint === endpoint && !jp)) return this.api;
    // 일본 전용 인증정보가 있으면 그것을, 없으면 기본 인증정보를 쓰되 403 에 원인 안내를 붙인다.
    return new AmazonAPI({ ...this.config, ...jp, endpoint, marketplaceId,
      authHint: marketplaceId === JP_MARKETPLACE_ID && !jp ? JP_AUTH_HINT : '',
      proxy: this._proxyOpts(), tokenCache: this._lwaTokens });
  }

  /** 일본 셀러센트럴에서 따로 승인받은 값. jpRefreshToken 이 없으면 null(기본 인증정보를 쓴다). */
  _jpCredentials() {
    const c = this.config;
    if (!c?.jpRefreshToken) return null;
    if (!!c.jpClientId !== !!c.jpClientSecret) throw new Error('일본 LWA Client ID와 Client Secret은 함께 설정해주세요.');
    return {
      refreshToken: c.jpRefreshToken,
      sellerId: c.jpSellerId || c.sellerId,
      clientId: c.jpClientId || c.clientId,
      clientSecret: c.jpClientSecret || c.clientSecret
    };
  }

  async searchProducts(query = {}, stats = null) {
    if (!this.api) this.loadConfig();
    const marketplaceId = query.marketplaceId || this.config.marketplaceId || 'ATVPDKIKX0DER';

    // 캐시가 있으면 네트워크를 전혀 쓰지 않는다. (eBay searchProducts 와 같은 구조)
    const cached = this.getCachedListings(marketplaceId);
    if (cached && cached.items.length > 0) {
      const matches = cached.items.filter(row => matchesProduct(row, query));
      if (stats) Object.assign(stats, {
        source: 'cache', scanned: cached.items.length, matched: matches.length,
        total: cached.total ?? cached.items.length, updatedAt: cached.updatedAt || null
      });
      return matches.map(row => ({ ...row }));
    }

    const api = this.apiForMarketplace(marketplaceId);
    const items = new Map(), tokens = new Set();
    let pageToken, scanned = 0, reported = null;
    do {
      const page = await api.searchListingsItems({ marketplaceId, pageToken });
      if (reported === null && Number.isFinite(Number(page.numberOfResults))) {
        reported = Number(page.numberOfResults);
      }
      for (const listing of page.items || []) {
        if (!listing.sku) continue;
        scanned++;
        const item = this.listingRow(listing, marketplaceId);
        if (matchesProduct(item, query)) items.set(item.id, item);
      }
      pageToken = page.pagination?.nextToken;
      if (pageToken && (tokens.has(pageToken) || tokens.size >= 999)) {
        throw new Error('아마존 목록 페이지를 모두 조회하지 못했습니다. 검색 조건 또는 API 응답을 확인해주세요.');
      }
      if (pageToken) tokens.add(pageToken);
    } while (pageToken);

    // searchListingsItems 는 numberOfResults 로 전체 건수를 보고하면서도 1000건에서
    // nextToken 을 조용히 끊는다. 잘렸는데 다 받은 것처럼 보이는 상황을 드러낸다.
    const truncated = reported !== null && scanned < reported;
    if (stats) Object.assign(stats, {
      source: 'api', scanned, matched: items.size, total: reported, truncated
    });
    if (truncated) {
      console.warn(`[Amazon] 목록이 잘렸습니다: ${scanned}/${reported}건. ` +
        '페이징 상한(1000건) 때문입니다. 전체를 받으려면 목록 동기화를 실행하세요.');
    }
    return [...items.values()];
  }

  /** SP-API 리스팅 한 건을 UI 행(=캐시 행)으로 바꾼다. 두 표현이 어긋나지 않도록 한 곳에서만 만든다. */
  listingRow(listing, marketplaceId) {
    const product = this.productForEdit(listing, listing.sku, marketplaceId);
    return {
      id: product.sku,
      name: product.title || product.sku,
      price: String(product.price ?? ''),
      stock: String(product.stock ?? ''),
      description: product.description,
      brand: product.brand,
      asin: product.asin
    };
  }

  /**
   * 등록·수정 성공 후 캐시 행을 제자리에서 고친다.
   * searchProducts 가 캐시를 먼저 보기 때문에, 이걸 빼먹으면 수정한 상품이
   * 목록에서 계속 옛 값으로 보인다. 전체 동기화는 리포트 생성까지 수 분이 걸려
   * 수정할 때마다 돌릴 수 없다. (eBay 는 ebay.js 의 updatePriceQuantity 끝에서 같은 일을 한다)
   */
  _syncCachedListing(sku, data, marketplaceId) {
    if (typeof this.store?.updateCachedListing !== 'function') return;
    if (!this.getCachedListings(marketplaceId)) return;   // 다른 계정/마켓 캐시는 건드리지 않는다
    const fields = {};
    const title = data.title || data.titleEn;
    if (title !== undefined && title !== null && String(title).trim() !== '') fields.name = String(title).trim();
    for (const [key, value] of [['price', data.price], ['stock', data.stock], ['brand', data.brand]]) {
      if (value !== undefined && value !== null && String(value).trim() !== '') fields[key] = String(value).trim();
    }
    if (Object.keys(fields).length === 0) return;
    try { this.store.updateCachedListing(sku, fields, marketplaceId); }
    catch (e) { console.warn('[Amazon] 캐시 반영 실패(무시):', e.message); }
  }

  // ──────────────────────────────────────────
  // 리스팅 캐시
  // ──────────────────────────────────────────

  /**
   * 캐시는 (판매자, 마켓플레이스) 조합에 묶인다.
   * 관리 서버가 로그인마다 amazon_config.json 을 덮어쓰므로(main_process.mergeIntoConfig)
   * 계정이 바뀌면 이전 계정의 목록이 그대로 남아 보일 수 있다. 키가 다르면 없는 것으로 친다.
   */
  getCachedListings(marketplaceId) {
    if (typeof this.store?.listingsCache !== 'function') return null;
    const cache = this.store.listingsCache(marketplaceId);
    if (!cache || !Array.isArray(cache.items)) return null;
    if (cache.sellerId !== this.sellerForMarketplace(marketplaceId)) return null;
    if (cache.marketplaceId !== marketplaceId) return null;
    return cache;
  }

  clearListingsCache() {
    if (typeof this.store?.clearListingsCache === 'function') this.store.clearListingsCache();
  }

  /**
   * 전체 카탈로그를 받아 캐시에 저장한다.
   *
   * searchListingsItems 는 1000건까지만 페이징되고 그 뒤로는 nextToken 이 에러 없이
   * 사라지기 때문에, 리스팅이 그보다 많으면 페이징으로는 전체를 받을 수 없다.
   * 그래서 스냅샷은 Reports API 로 받는다 — 이미 보유한 Product Listing 역할로 커버된다.
   */
  async refreshListingsCache({ marketplaceId, onProgress = null, enrichBrand = true,
                               pollIntervalMs = 5000, timeoutMs = 15 * 60 * 1000 } = {}) {
    if (!this.api) this.loadConfig();
    if (typeof this.store?.saveListingsCache !== 'function') {
      throw new Error('리스팅 캐시 저장소가 없습니다.');
    }
    const mp = marketplaceId || this.config.marketplaceId || 'ATVPDKIKX0DER';
    const api = this.apiForMarketplace(mp);
    const progress = p => { if (onProgress) onProgress(p); };

    progress({ stage: 'create', loaded: 0, total: null });
    const created = await api.createReport(LISTINGS_REPORT_TYPE, mp);
    const reportId = created?.reportId;
    if (!reportId) throw new Error('아마존 리포트 생성에 실패했습니다 (reportId 없음).');

    // 리포트 생성은 비동기다. 수십 초에서 수 분까지 걸린다.
    const deadline = Date.now() + timeoutMs;
    let documentId = null;
    for (;;) {
      const report = await api.getReport(reportId);
      const status = report?.processingStatus;
      if (status === 'DONE') { documentId = report.reportDocumentId; break; }
      if (status === 'CANCELLED') throw new Error('아마존이 리포트를 취소했습니다. 해당 마켓플레이스에 리스팅이 없을 때도 이 상태가 됩니다.');
      if (status === 'FATAL') throw new Error('아마존 리포트 생성이 실패했습니다 (FATAL).');
      if (Date.now() > deadline) {
        throw new Error(`아마존 리포트가 ${Math.round(timeoutMs / 60000)}분 안에 완료되지 않았습니다.`);
      }
      progress({ stage: 'wait', status: status || 'IN_QUEUE', loaded: 0, total: null });
      await sleep(pollIntervalMs);
    }

    progress({ stage: 'download', loaded: 0, total: null });
    const doc = await api.getReportDocument(documentId);
    const text = await api.downloadReportDocument(doc);
    const items = parseListingsReport(text);

    // GET_MERCHANT_LISTINGS_ALL_DATA 에는 brand 열이 없다. 브랜드로 검색하면 캐시 적중 때만
    // 결과가 달라지므로 identifiers 로 20건씩 받아 채운다(1386건이면 70회, 15~30초).
    // 여기서 실패해도 리포트 스냅샷은 그대로 저장한다 — 수십 초짜리 결과를 통째로 버리지 않는다.
    let enriched = 0;
    let enrichError = null;
    if (enrichBrand && items.length > 0) {
      try {
        const rows = await this._fetchListingsBySku(items.map(item => item.id), {
          marketplaceId: mp, onProgress: progress, stage: 'enrich'
        });
        const byId = new Map(rows.map(row => [row.id, row]));
        for (const item of items) {
          const row = byId.get(item.id);
          if (!row) continue;
          if (row.brand) { item.brand = row.brand; enriched++; }
          if (!item.description && row.description) item.description = row.description;
          if (!item.asin && row.asin) item.asin = row.asin;
        }
      } catch (error) {
        enrichError = error.message;
        console.warn(`[Amazon] 브랜드 보강 실패 (리포트 결과는 유지): ${error.message}`);
        progress({ stage: 'enrich-failed', loaded: enriched, total: items.length, error: error.message });
      }
    }

    const cacheData = {
      updatedAt: new Date().toISOString(),
      sellerId: api.sellerId || '',
      marketplaceId: mp,
      total: items.length,
      items
    };
    this.store.saveListingsCache(cacheData);
    progress({ stage: 'done', loaded: items.length, total: items.length });
    return {
      total: items.length, count: items.length, updatedAt: cacheData.updatedAt, marketplaceId: mp,
      enriched, enrichError
    };
  }

  /**
   * SKU 를 지정해 최신값만 받아 캐시를 갱신한다.
   * searchListingsItems 의 identifiers 는 한 호출에 최대 20건이라 20개씩 묶어 보낸다.
   * 전체 새로고침과 달리 리포트를 기다리지 않는다.
   */
  async refreshListings(skus, options = {}) {
    if (!this.api) this.loadConfig();
    const mp = options.marketplaceId || this.config.marketplaceId || 'ATVPDKIKX0DER';
    const rows = await this._fetchListingsBySku(skus, { ...options, marketplaceId: mp });
    if (typeof this.store?.updateCachedListing === 'function') {
      for (const row of rows) this.store.updateCachedListing(row.id, row, mp);
    }
    return rows;
  }

  /**
   * SKU 목록을 identifiers 로 20개씩 묶어 받아온다(배열 요청). 캐시는 건드리지 않는다.
   * searchListingsItems 는 5 rps 라 동시 실행은 낮게 잡는다.
   */
  async _fetchListingsBySku(skus, { marketplaceId, concurrency = 2, onProgress = null,
                                    stage = 'fetch' } = {}) {
    const api = this.apiForMarketplace(marketplaceId);
    const unique = [...new Set((skus || []).map(v => String(v).trim()).filter(Boolean))];

    const chunks = [];
    for (let i = 0; i < unique.length; i += SEARCH_IDENTIFIERS_MAX) {
      chunks.push(unique.slice(i, i + SEARCH_IDENTIFIERS_MAX));
    }

    const rows = [];
    let loaded = 0;
    for (let i = 0; i < chunks.length; i += concurrency) {
      const batch = chunks.slice(i, i + concurrency);
      const pages = await Promise.all(batch.map(chunk =>
        api.searchListingsItems({ marketplaceId, identifiers: chunk, identifiersType: 'SKU' })));
      for (const page of pages) {
        for (const listing of page.items || []) {
          if (listing.sku) rows.push(this.listingRow(listing, marketplaceId));
        }
      }
      loaded += batch.reduce((n, chunk) => n + chunk.length, 0);
      if (onProgress) onProgress({ stage, loaded, total: unique.length });
    }
    return rows;
  }

  /**
   * 입력 데이터를 아마존 Listings Items API v2021-08-01 포맷으로 변환
   */
  _buildProductPayload(data) {
    const marketplaceId = data.marketplaceId || this.config?.marketplaceId || 'ATVPDKIKX0DER';
    const brand = data.brand || this.config?.brand || 'Optic Glass';
    const manufacturer = data.manufacturer || this.config?.manufacturer || brand;
    // config.currency 는 단일 마켓 값(보통 USD)이라 마켓 기본값보다 뒤에 둬야 한다.
    // UI 에서 통화 전달이 누락돼도 JP 에 USD 가 나가지 않게 하는 마지막 방어선.
    const currency = data.currency || MARKETPLACE_CURRENCY[marketplaceId] || this.config?.currency || 'USD';
    // 일본은 환산 완료된 엔화만 허용하며 USD 기본값으로 대체하지 않는다.
    const price = listingPrice(data, marketplaceId, true);
    // 예전에는 빈 판매가를 89.99 로, 재고 '0' 을 999 로 바꿔 등록했다 — 앞 상품 값·기본값이 경고 없이 나갔다.
    if (!(price > 0)) throw markPreSend(new Error('판매가를 입력하세요 (0보다 큰 금액).'));
    const stock = isBlank(data.stock) ? 999 : Number(String(data.stock).trim());
    if (!Number.isSafeInteger(stock) || stock < 0) throw markPreSend(new Error('재고 수량은 0 이상의 정수로 입력하세요.'));
    const productType = (data.productType || this.config?.productType || 'AUTO_PART').toUpperCase();

    // 상품명 (영문 기본, 없으면 한글 타이틀)
    const title = String(data.titleEn || data.title || '').trim();

    // 대표 이미지 URL
    const mainImageUrl = getSafeUrl(data.mainImageUrl || '');

    // 상세 설명 (HTML 제거 후 Plain Text 변환)
    let descriptionText = String(data.description || '').trim();
    if (!descriptionText && (data.esmHtml || data.detailHtml)) {
      descriptionText = stripHtmlToPlainText(data.esmHtml || data.detailHtml);
    }
    if (!descriptionText) {
      // 일본 마켓에 영문 기본 문구를 채워 넣지 않는다 — 조용히 영문이 등록되던 것이 원래 문제다.
      if (marketplaceId === JP_MARKETPLACE_ID) {
        throw new Error('일본 마켓플레이스 등록에는 일본어 상세설명이 필요합니다 (아마존 탭의 상품 설명란).');
      }
      descriptionText = `Product Description\n\nBoost your driving confidence with this innovative blind spot mirror!\n\nIts wide-angle design and optimal curvature dramatically reduce blind spots, giving you a clear panoramic view of your surroundings.\n\n\n\nThe mirror is designed to match the original design of your side mirror, making it easy to install while preserving the original look of your vehicle.\n\nPlus, a special water-repellent coating ensures crystal-clear vision, even in rainy or wet conditions.\n\n\n\nAn optional engraving feature allows the BSA sensor light to be visible on the mirror, improving your awareness of potential threats on the road.\n\nThe mirror's design prioritizes safety, convenience, and clarity, offering an enhanced driving experience for all users.\n\n\n\nConstructed with high-quality materials, this blind spot mirror is built to last, offering reliable performance for long journeys.\n\nUpgrade your driving experience today and enjoy peace of mind with every ride!`;
    }

    // Bullet Points (특징 목록)
    let bullets = normalizeBullets(data.bulletPoints);

    if (bullets.length === 0) {
      // 설명과 같은 이유로 일본 마켓은 영문 기본 불릿으로 때우지 않는다.
      if (marketplaceId === JP_MARKETPLACE_ID) {
        throw new Error('일본 마켓플레이스 등록에는 일본어 불릿 포인트가 필요합니다 (아마존 탭의 주요 특징란).');
      }
      bullets = [
        'Eliminate Blind Spots: Our convex mirror with optimal curvature significantly reduces blind spots, providing a wide-angle view for superior safety. This wide-angle mirror design significantly reduces blind spots, keeping you aware of your surroundings and improving driving safety.',
        'Crystal Clear Vision: Our chrome surface coating minimizes diffuse reflection, providing a clear view even in bright light. Additionally, a special water-repellent coating ensures optimal visibility during rainy or wet weather conditions.',
        'Heated for All Season: Defeat foggy mirrors in winter and condensation buildup in summer with our integrated heating function. This feature matches the functionality of your car\'s original heated mirrors, providing a consistent and comfortable driving experience year-round.',
        'Easy Installation: The replaceable jack-to-jack connector allows for a quick and easy swap, perfectly fitting your existing mirror\'s connection. Simply unplug your existing mirror and plug ours in for a perfect fit.',
        'Personalization Available (Optional): Add a unique touch with our BSA engraving option (availability may vary). Add a custom touch to your mirrors and showcase your unique style.'
      ];
    }

    // Attributes 구성 (아마존 JSON Schema 규격)
    const attributes = {
      item_name: [{ value: title, marketplace_id: marketplaceId }],
      brand: [{ value: brand, marketplace_id: marketplaceId }],
      manufacturer: [{ value: manufacturer, marketplace_id: marketplaceId }],
      product_description: [{ value: descriptionText, marketplace_id: marketplaceId }],
      bullet_point: bullets.map(b => ({ value: b, marketplace_id: marketplaceId })),
      condition_type: [{ value: 'new_new', marketplace_id: marketplaceId }],
      purchasable_offer: [
        {
          currency,
          our_price: [{ schedule: [{ value_with_tax: price }] }],
          marketplace_id: marketplaceId
        }
      ],
      fulfillment_availability: [
        {
          fulfillment_channel_code: 'DEFAULT',
          quantity: stock
        }
      ]
    };

    // 대표 이미지 첨부
    if (mainImageUrl) {
      attributes.main_product_image_locator = [
        {
          media_location: mainImageUrl,
          marketplace_id: marketplaceId
        }
      ];
    }

    // 추가 이미지 첨부 (other_product_image_locator_1 ~ 8)
    const subImages = Array.isArray(data.subImages) ? [...data.subImages] : [];
    if (data.specImageUrl) subImages.unshift(data.specImageUrl);
    subImages.slice(0, 8).forEach((imgUrl, idx) => {
      const safeSub = getSafeUrl(imgUrl);
      if (safeSub) {
        const key = `other_product_image_locator_${idx + 1}`;
        attributes[key] = [{ media_location: safeSub, marketplace_id: marketplaceId }];
      }
    });

    return {
      productType,
      requirements: 'LISTING',
      attributes
    };
  }

  /**
   * 상품 등록 (PUT /listings/2021-08-01/items/{sellerId}/{sku})
   */
  async registerProduct(data) {
    if (!this.api) this.loadConfig();

    // 중복 검사(duplicate_guard)가 판정한 SKU 와 여기서 PUT 하는 SKU 가 같아야 하므로 같은 함수를 쓴다.
    const sku = amazonSkuOf(data);
    if (!sku) {
      throw new Error('상품 등록을 위한 SKU(관리코드)가 필수입니다.');
    }

    console.log(`[Amazon] 상품 등록 시작: SKU=${sku}, Title=${data.title || data.titleEn}`);
    const payload = this._buildProductPayload(data);

    this._writeDebug('register', sku, payload, data);

    const marketplaceId = amazonMarketplaceOf(data, this.config);
    const result = await this.apiForMarketplace(marketplaceId).putListingItem(sku, payload, marketplaceId);
    // INVALID 면 여기서 던진다 — 캐시를 고치기 전에. (원장 기록도 register 가 던지면 건너뛴다)
    assertListingAccepted(result, '등록');

    console.log('✓ [Amazon] 상품 등록 완료!');
    this._syncCachedListing(sku, data, marketplaceId);
    return {
      sku,
      status: result.status,
      submissionId: result.submissionId || 'ACCEPTED',
      raw: result
    };
  }

  /**
   * 기존 상품 정보 불러오기 (수정용)
   */
  async loadProductForEdit(sku, marketplaceId = null) {
    if (!this.api) this.loadConfig();
    const mid = marketplaceId || this.config.marketplaceId || 'ATVPDKIKX0DER';

    console.log(`[Amazon] 기존 상품 불러오기: SKU=${sku}`);
    const res = await this.apiForMarketplace(mid).getListingItem(sku, mid);
    return this.productForEdit(res, sku, mid);
  }

  /**
   * 여러 SKU 를 수정용 모양으로 한 번에 불러온다. getListingItem 은 한 호출에 1건, searchListingsItems 는
   * identifiers 로 20건이다. 응답에 없는 SKU 는 결과에 넣지 않는다 — 부르는 쪽이 1건 조회로 다시 확인한다.
   * @returns {Promise<Map<string, object>>} SKU → loadProductForEdit 와 같은 모양
   */
  async loadProductsForEdit(skus, marketplaceId = null) {
    if (!this.api) this.loadConfig();
    const mid = marketplaceId || this.config.marketplaceId || 'ATVPDKIKX0DER';
    const api = this.apiForMarketplace(mid);
    const wanted = new Set((skus || []).map(v => String(v).trim()).filter(Boolean)), unique = [...wanted];
    const chunks = [];
    for (let i = 0; i < unique.length; i += SEARCH_IDENTIFIERS_MAX) chunks.push(unique.slice(i, i + SEARCH_IDENTIFIERS_MAX));
    const found = new Map();
    // _fetchListingsBySku 와 같이 두 묶음씩 보낸다(5 rps 는 호출 간격 조절이 지킨다).
    for (let i = 0; i < chunks.length; i += 2) {
      const pages = await Promise.all(chunks.slice(i, i + 2).map(chunk =>
        api.searchListingsItems({ marketplaceId: mid, identifiers: chunk, identifiersType: 'SKU' })));
      for (const listing of pages.flatMap(page => page?.items || [])) {
        const sku = String(listing?.sku ?? '');
        if (wanted.has(sku) && !found.has(sku)) found.set(sku, this.productForEdit(listing, sku, mid));
      }
    }
    return found;
  }

  /**
   * SKU 마다 그 마켓에 리스팅이 있는지(getListingsItem 200 / 404). searchListingsItems 는 BIL 이 만든
   * '오퍼만 있는' 일본 SKU 를 돌려주지 않는다(2026-10-02 전수 조회: 4건만 나옴) — 그래서 한 건씩 묻는다.
   * 1,000건이면 호출 간격 조절(220ms) 때문에 4분쯤. 404 가 아닌 오류는 남은 SKU 를 묻지 않고 던진다.
   */
  async skusOnMarketplace(skus, marketplaceId, { width = 4, onProgress = () => {} } = {}) {
    if (!this.api) this.loadConfig();
    const api = this.apiForMarketplace(marketplaceId), list = [...new Set((skus || []).map(String))], found = new Set();
    let next = 0, done = 0, failure = null;
    const worker = async () => {
      while (!failure && next < list.length) {
        const sku = list[next++];
        try { if (await api.getListingItem(sku, marketplaceId)) found.add(sku); }
        catch (e) { if (e?.status !== 404) { failure = e; return; } }
        onProgress(++done, list.length);
      }
    };
    await Promise.all(Array.from({ length: Math.min(width, list.length) }, worker));
    if (failure) throw failure;
    return found;
  }

  productForEdit(res, sku, marketplaceId) {
    const attrs = res?.attributes || {};
    const marketValue = values => values?.find(v => v.marketplace_id === marketplaceId) || values?.find(v => !v.marketplace_id);
    const summaries = res?.summaries?.find(s => s.marketplaceId === marketplaceId) || res?.summaries?.[0] || {};

    const title = marketValue(attrs.item_name)?.value || summaries.itemName || '';
    // 판매가는 일반 고객가(audience ALL · offerType B2C)다 — 비즈니스(B2B) 가격이 먼저 오면 그 값을 판매가로 읽었다.
    const offer = res?.offers?.find(o => o.marketplaceId === marketplaceId && o.offerType !== 'B2B');
    const consumer = attrs.purchasable_offer?.filter(v => !v.audience || v.audience === 'ALL');
    const price = marketValue(consumer)?.our_price?.[0]?.schedule?.[0]?.value_with_tax ?? offer?.price?.amount ?? '';
    const stock = attrs.fulfillment_availability?.find(a => a.fulfillment_channel_code === 'DEFAULT')?.quantity
      ?? res?.fulfillmentAvailability?.find(a => a.fulfillmentChannelCode === 'DEFAULT')?.quantity ?? '';
    const brand = marketValue(attrs.brand)?.value || '';
    const mainImageUrl = marketValue(attrs.main_product_image_locator)?.media_location || summaries.mainImage?.link || '';
    const description = marketValue(attrs.product_description)?.value || '';
    const bulletPoints = (attrs.bullet_point || []).map(b => b.value);

    return {
      sku,
      title,
      price,
      stock,
      brand,
      mainImageUrl,
      description,
      bulletPoints,
      asin: summaries.asin || '',
      status: summaries.status || res.status,
      raw: res
    };
  }

  /** 전송 직전 페이로드를 임시 폴더에 기록 (문제 발생 시 원인 추적용) */
  _writeDebug(label, sku, payload, data) {
    try {
      const dir = _debugDir();
      if (!dir) return;
      fs.appendFileSync(
        path.join(dir, 'amazon_debug.log'),
        JSON.stringify({ timestamp: new Date().toISOString(), label, sku, payload, data }, null, 2) + '\n\n',
        'utf-8'
      );
      fs.writeFileSync(
        path.join(dir, 'amazon_payload_app.json'),
        JSON.stringify(payload, null, 2),
        'utf-8'
      );
    } catch (e) {
      console.error('[Amazon] 디버그 로그 저장 실패:', e);
    }
  }

  /**
   * 수정 요청에 실제로 담겨 온 값만 아마존 속성으로 변환한다.
   * 비어 있는 필드는 속성 자체를 만들지 않으므로(기본값 생성 금지) 기존 리스팅 값이 그대로 남는다.
   */
  _buildPartialAttributes(data, marketplaceId, existingAttrs = {}) {
    const attributes = {};

    const title = String((isBlank(data.titleEn) ? data.title : data.titleEn) ?? '').trim();
    if (title) {
      // 언어 태그는 지금 리스팅 값을 따르고, 없으면 마켓 기본(미국 en_US · 일본 ja_JP — amazon_jp_draft.js 와 같다).
      const old = existingAttrs.item_name?.find(v => v.marketplace_id === marketplaceId) || existingAttrs.item_name?.find(v => !v.marketplace_id);
      attributes.item_name = [{ value: title, language_tag: old?.language_tag || (marketplaceId === JP_MARKETPLACE_ID ? 'ja_JP' : 'en_US'), marketplace_id: marketplaceId }];
    }

    if (!isBlank(data.brand)) {
      attributes.brand = [{ value: String(data.brand).trim(), marketplace_id: marketplaceId }];
    }
    if (!isBlank(data.manufacturer)) {
      attributes.manufacturer = [{ value: String(data.manufacturer).trim(), marketplace_id: marketplaceId }];
    }

    let descriptionText = isBlank(data.description) ? '' : String(data.description).trim();
    if (!descriptionText && (data.esmHtml || data.detailHtml)) {
      descriptionText = stripHtmlToPlainText(data.esmHtml || data.detailHtml);
    }
    if (descriptionText) {
      attributes.product_description = [{ value: descriptionText, marketplace_id: marketplaceId }];
    }

    const bullets = normalizeBullets(data.bulletPoints);
    if (bullets.length > 0) {
      attributes.bullet_point = bullets.map(b => ({ value: b, marketplace_id: marketplaceId }));
    }

    // 가격·재고는 기존 오퍼 구조를 복사한 뒤 해당 값만 교체해 통화·배송 설정 등 부가 항목을 지킨다.
    const price = listingPrice(data, marketplaceId);
    if (Number.isFinite(price)) {
      const offers = cloneAttr(existingAttrs.purchasable_offer) || [];
      // 읽기(productForEdit)와 같은 오퍼를 고친다 — 일반 고객가(audience ALL). B2B 가격이 먼저 오면 그것을 고쳤다.
      const consumer = o => !o?.audience || o.audience === 'ALL';
      let idx = offers.findIndex(o => o?.marketplace_id === marketplaceId && consumer(o));
      if (idx < 0) idx = offers.findIndex(o => !o?.marketplace_id && consumer(o));
      const offer = idx >= 0 ? offers[idx] : {};
      if (offer.our_price?.[0]?.schedule?.[0]) offer.our_price[0].schedule[0].value_with_tax = price;
      else offer.our_price = [{ schedule: [{ value_with_tax: price }] }];
      offer.marketplace_id = offer.marketplace_id || marketplaceId;
      // _buildProductPayload 과 같은 우선순위 — config.currency(단일 마켓 값)는 마켓 기본값 뒤.
      offer.currency = offer.currency || data.currency || MARKETPLACE_CURRENCY[marketplaceId] || this.config?.currency || 'USD';
      if (idx < 0) offers.push(offer);
      attributes.purchasable_offer = offers;
    }

    const stock = isBlank(data.stock) ? NaN : parseInt(data.stock, 10);
    if (Number.isFinite(stock)) {
      const availability = cloneAttr(existingAttrs.fulfillment_availability) || [];
      const idx = availability.findIndex(a => a?.fulfillment_channel_code === 'DEFAULT');
      if (idx >= 0) availability[idx].quantity = stock;
      else availability.push({ fulfillment_channel_code: 'DEFAULT', quantity: stock });
      attributes.fulfillment_availability = availability;
    }

    const mainImageUrl = getSafeUrl(data.mainImageUrl || '');
    if (mainImageUrl) {
      attributes.main_product_image_locator = [{ media_location: mainImageUrl, marketplace_id: marketplaceId }];
    }

    // 전달된 추가 이미지 슬롯만 교체한다. 넘어오지 않은 슬롯의 기존 이미지는 유지된다.
    const subImages = Array.isArray(data.subImages) ? [...data.subImages] : [];
    if (data.specImageUrl) subImages.unshift(data.specImageUrl);
    subImages.slice(0, 8).forEach((imgUrl, idx) => {
      const safeSub = getSafeUrl(imgUrl);
      if (safeSub) {
        attributes[`other_product_image_locator_${idx + 1}`] = [{ media_location: safeSub, marketplace_id: marketplaceId }];
      }
    });

    return attributes;
  }

  /**
   * 기존 상품 수정 — 넘어온 필드만 바꾸고 나머지 리스팅 값은 건드리지 않는다.
   * 전체 문서 PUT은 본문에 없는 속성을 모두 삭제하므로 수정 경로에서는 사용하지 않는다.
   */
  async updateExistingProduct(data) {
    if (!this.api) this.loadConfig();

    const sku = String(data.sku || data.itemCode || data.code || '').trim();
    if (!sku) {
      throw new Error('상품 수정을 위한 SKU(관리코드)가 필수입니다.');
    }

    const marketplaceId = data.marketplaceId || this.config.marketplaceId || 'ATVPDKIKX0DER';
    const api = this.apiForMarketplace(marketplaceId);

    // 기존 리스팅을 먼저 읽는다. 조회에 실패하면 무엇을 보존해야 할지 알 수 없으므로 중단한다.
    let existing;
    try {
      existing = await api.getListingItem(sku, marketplaceId);
    } catch (err) {
      throw markPreSend(new Error(`아마존 기존 상품(SKU: ${sku}) 조회에 실패하여 수정을 중단했습니다. 기존 이미지·상세정보가 지워지는 것을 막기 위함입니다. (원인: ${err.message})`, { cause: err }));
    }

    if (data.expectedPrice !== undefined) {
      const currentPrice = this.productForEdit(existing, sku, marketplaceId).price;
      if (currentPrice == null || currentPrice === '' || Number(currentPrice) !== Number(data.expectedPrice))
        throw markPreSend(new Error('현재 판매가가 조회 이후 변경됐습니다. 다시 불러온 뒤 수정하세요.'));
      const priceOnly = Object.keys(data).every(key => ['sku', 'marketplaceId', 'currency', 'price', 'expectedPrice'].includes(key));
      if (priceOnly && Number(currentPrice) === Number(data.price)) return { sku, status: 'UNCHANGED' };
    }
    const existingAttrs = existing?.attributes || {};
    const summary = existing?.summaries?.find(s => s.marketplaceId === marketplaceId) || existing?.summaries?.[0] || {};
    const productType = String(summary.productType || data.productType || this.config?.productType || 'AUTO_PART').toUpperCase();
    if (data.productType && String(data.productType).toUpperCase() !== productType) {
      console.warn(`[Amazon] 요청한 상품유형(${data.productType})과 기존 리스팅 유형(${productType})이 달라 기존 유형을 유지합니다.`);
    }

    const attributes = this._buildPartialAttributes(data, marketplaceId, existingAttrs);
    const imageDeletes = [];
    if (data.replaceImageUrls !== undefined) {
      let urls;
      try {
        urls = parseImageUrls(data.replaceImageUrls, marketplaceId === 'A1VC38T7YXB528' ? 'amazon-jp' : 'amazon-us');
        if (!sameImages(amazonImageUrls(this.productForEdit(existing, sku, marketplaceId), marketplaceId), data.expectedImageUrls))
          throw new Error('이미지가 변경됐습니다. 다시 불러오세요.');
      } catch (e) { throw markPreSend(e); }
      for (let i = 0; i < 9; i++) {
        const key = i ? `other_product_image_locator_${i}` : 'main_product_image_locator';
        const old = existingAttrs[key] || [];
        const others = old.filter(v => v.marketplace_id && v.marketplace_id !== marketplaceId);
        if (urls[i]) attributes[key] = [...others, { media_location: urls[i], marketplace_id: marketplaceId }];
        else if (old.some(v => !v.marketplace_id || v.marketplace_id === marketplaceId)) {
          if (others.length) attributes[key] = others;
          else imageDeletes.push({ op: 'delete', path: `/attributes/${key}`, value: old });
        }
      }
    }
    // 폼은 불러온 값을 모두 다시 보낸다(대표 이미지·브랜드·가격 포함). 지금 리스팅과 같은 속성은 빼고 바뀐 것만 PATCH 한다.
    for (const key of Object.keys(attributes)) {
      if (JSON.stringify(marketView(key, attributes[key], marketplaceId)) === JSON.stringify(marketView(key, existingAttrs[key], marketplaceId)))
        delete attributes[key];
    }
    const changedKeys = Object.keys(attributes);
    if (changedKeys.length === 0 && imageDeletes.length === 0) {
      console.log(`[Amazon] 변경할 값이 없어 수정 요청을 보내지 않았습니다: SKU=${sku}`);
      return { sku, status: 'SKIPPED', submissionId: 'NO_CHANGES', updatedAttributes: [], raw: null };
    }

    console.log(`[Amazon] 상품 수정 시작: SKU=${sku}, 변경 속성=${changedKeys.join(', ')}`);

    const patchPayload = {
      productType,
      patches: [...changedKeys.map(key => ({ op: 'replace', path: `/attributes/${key}`, value: attributes[key] })), ...imageDeletes]
    };
    this._writeDebug('update-patch', sku, patchPayload, data);

    let result;
    try {
      result = await api.patchListingItem(sku, patchPayload, marketplaceId);
      // HTTP 200 + INVALID 도 거부다. 이슈 문구가 'PATCH 미지원'이면 아래 catch 가 PUT 으로 넘긴다.
      assertListingAccepted(result, '수정');
    } catch (patchError) {
      // 일부 상품 유형은 PATCH를 지원하지 않는다. 이때만 "기존 속성 + 변경분"을 합친 전체 문서로 PUT 한다.
      // 그 밖의 오류(429·5xx·네트워크·검증 실패)는 PUT 으로 덮어쓰지 않고 그대로 알린다.
      if (!isPatchUnsupportedError(patchError)) {
        throw new Error(`아마존 상품 수정 실패: ${patchError.message}`, { cause: patchError });
      }
      console.warn(`[Amazon] 이 상품 유형은 PATCH 를 지원하지 않아 기존 속성을 병합해 PUT으로 재시도합니다. (${patchError.message})`);
      const mergedPayload = {
        productType,
        requirements: data.requirements || 'LISTING',
        attributes: { ...cloneAttr(existingAttrs), ...attributes }
      };
      for (const patch of imageDeletes) delete mergedPayload.attributes[patch.path.split('/').pop()];
      this._writeDebug('update-put-fallback', sku, mergedPayload, data);
      try {
        result = await api.putListingItem(sku, mergedPayload, marketplaceId);
        assertListingAccepted(result, '수정');
      } catch (putError) {
        throw new Error(`아마존 상품 수정 실패 (PATCH: ${patchError.message} / PUT 재시도: ${putError.message})`, { cause: putError });
      }
    }

    console.log('✓ [Amazon] 상품 수정 완료!');
    this._syncCachedListing(sku, data, marketplaceId);
    return {
      sku,
      status: result.status,
      submissionId: result.submissionId || 'ACCEPTED',
      updatedAttributes: changedKeys,
      raw: result
    };
  }
}
