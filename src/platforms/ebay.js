import { updateEbayPricesBatch } from './ebay_bulk_prices.js';
import { createHash, randomBytes } from 'node:crypto';
import { EbayAPI, EbayAPIError, EBAY_SCOPES } from './ebay_api.js';
import { buildEbayPayload, priceQuantity, validateAspects, validateSku } from './ebay_payload.js';
import { effectiveQuery, matchesProduct } from './product_search.js';
import { markPreSend } from '../utils/api_error.js';
import { parseImageUrls, sameImages } from '../utils/bulk_images.js';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// 중복 등록 예외. ebay_ipc 가 duplicate·existing 을 응답에 실어 보낸다(main 의 다른 채널과 같은 모양).
function duplicateError(message, existing) {
  const error = new Error(message);
  error.duplicate = true;
  error.existing = existing;
  return error;
}

// 0건은 원인이 셋인데 화면에는 똑같이 보인다: 계정에 Inventory 상품이 없거나, 검색어가 안 맞거나,
// 미국 고정가 Offer 조건에서 전부 걸러졌거나. 어느 쪽인지 집계값으로 가려 한 줄로 남긴다.
function emptySearchReason(tally, query, activeCount = null) {
  if (!tally.scanned) {
    const hint = (activeCount !== null && activeCount !== undefined) ? ` (현재 eBay 활성 리스팅 ${activeCount}건 확인됨)` : '';
    return `eBay API 통신 성공 (정상 응답): 현재 계정에 Inventory API로 등록된 상품이 없습니다.${hint} 웹사이트(Seller Hub)나 기존 방식으로 올린 리스팅은 [기존 리스팅 일괄 이관(bulkMigrateListing)] 버튼으로 이관해야 이 목록에 표시됩니다.`;
  }
  const term = effectiveQuery(query);
  if (!tally.matched) {
    if (!term) return `재고 ${tally.scanned}건이 모두 SKU 없는 항목이라 조회 대상에서 제외되었습니다.`;
    const hint = /[가-힣]/.test(term)
      ? ' eBay 상품명·SKU는 영문으로 저장되므로 한글로는 찾을 수 없습니다. 품번이나 영문 상품명으로 검색하세요.' : '';
    return `재고 ${tally.scanned}건을 조회했지만 검색어 "${term}"와(과) 일치하는 상품이 없습니다.${hint}`;
  }
  return `검색어와 일치한 ${tally.matched}건이 모두 제외되었습니다 — 미국 고정가 Offer 없음 ${tally.noOffer}건, Offer 2개 이상 ${tally.multiOffer}건.`;
}

export class Ebay {
  constructor(store, apiFactory = (config, options) => new EbayAPI(config, options)) {
    this.store = store;
    this.apiFactory = apiFactory;
    this.busy = false;
  }

  async exclusive(work) {
    if (this.busy) throw new Error('eBay 작업이 진행 중입니다. 완료 후 다시 실행해주세요.');
    this.busy = true;
    try { return await work(); } finally { this.busy = false; }
  }
  client() {
    const config = this.store.config();
    // Runtime staff tokens never enter the credential store or OAuth state.
    const proxy = this.runtimeProxy || {};
    const key = digest([config, proxy]);
    if (key !== this.clientKey) { this.api = this.apiFactory(config, { proxy }); this.clientKey = key; }
    return { config, api: this.api };
  }
  saveConfig(input) {
    if (this.busy) throw new Error('작업 중에는 설정을 변경할 수 없습니다.');
    this.pendingAuth = null;
    return this.store.save(input);
  }
  authorizationUrl() {
    const { config } = this.client();
    if (!config.clientId || !config.clientSecret || !config.ruName) throw new Error('Client ID, Client Secret, RuName을 먼저 저장해주세요.');
    const state = randomBytes(24).toString('hex');
    this.pendingAuth = { state, expires: Date.now() + 600000, configKey: digest(config) };
    const origin = config.environment === 'production' ? 'https://auth.ebay.com' : 'https://auth.sandbox.ebay.com';
    return `${origin}/oauth2/authorize?${new URLSearchParams({ client_id: config.clientId, redirect_uri: config.ruName, response_type: 'code', scope: EBAY_SCOPES, state })}`;
  }
  async completeAuthorization(callbackUrl) {
    return this.exclusive(async () => {
      const { config, api } = this.client();
      let callback; try { callback = new URL(callbackUrl); } catch { throw new Error('동의 후 이동한 페이지의 전체 URL을 붙여넣어주세요.'); }
      const auth = this.pendingAuth;
      if (!auth || auth.expires < Date.now() || auth.configKey !== digest(config) || callback.searchParams.get('state') !== auth.state) throw new Error('인증 요청이 만료되었거나 일치하지 않습니다. 판매자 연결을 다시 시작해주세요.');
      const code = callback.searchParams.get('code');
      if (!code || callback.searchParams.has('error')) throw new Error('판매자 동의가 완료되지 않았습니다.');
      const tokens = await api.tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: config.ruName });
      if (!tokens.refresh_token) throw new Error('Refresh Token을 받지 못했습니다. 다시 동의해주세요.');
      this.store.save({ refreshToken: tokens.refresh_token });
      this.pendingAuth = null;
      return this.store.publicConfig();
    });
  }

  async settings() {
    const { api } = this.client();
    const results = await Promise.all([
      api.request('GET', '/sell/account/v1/fulfillment_policy?marketplace_id=EBAY_US'),
      api.request('GET', '/sell/account/v1/payment_policy?marketplace_id=EBAY_US'),
      api.request('GET', '/sell/account/v1/return_policy?marketplace_id=EBAY_US')
    ]);
    const locations = [];
    for (let offset = 0; ; offset += 100) {
      const page = await api.request('GET', `/sell/inventory/v1/location?limit=100&offset=${offset}`);
      locations.push(...(page.locations || []));
      if ((page.locations || []).length < 100) break;
      if (offset >= 9900) throw new Error('출고지가 너무 많습니다. 출고지 키를 직접 입력해주세요.');
    }
    return { fulfillmentPolicies: results[0].fulfillmentPolicies || [], paymentPolicies: results[1].paymentPolicies || [], returnPolicies: results[2].returnPolicies || [], locations };
  }
  // eBay 는 createInventoryLocation 에 POST 를 쓴다(createOrReplace* 계열만 PUT).
  // 성공 응답은 본문 없는 204 이며, 같은 키가 이미 있으면 409 가 온다.
  async createLocation(input) {
    return this.exclusive(async () => {
      const { api } = this.client();
      const key = String(input?.merchantLocationKey || '').trim();
      if (!/^[A-Za-z0-9_-]{1,36}$/.test(key)) throw new Error('출고지 키는 영숫자, 하이픈, 밑줄 36자 이내로 입력해주세요.');
      const address = {};
      for (const [field, label] of [['addressLine1', '주소'], ['city', '도시'], ['postalCode', '우편번호'], ['country', '국가 코드']]) {
        const entered = String(input?.[field] || '').trim();
        if (!entered) throw new Error(`출고지 ${label}을(를) 입력해주세요.`);
        address[field] = entered;
      }
      if (!/^[A-Z]{2}$/.test(address.country)) throw new Error('국가 코드는 US, KR 같은 2자리 대문자입니다.');
      const region = String(input?.stateOrProvince || '').trim();
      if (region) address.stateOrProvince = region;
      const name = String(input?.name || '').trim() || key;
      await api.request('POST', `/sell/inventory/v1/location/${encodeURIComponent(key)}`, {
        location: { address }, name, merchantLocationStatus: 'ENABLED', locationTypes: ['WAREHOUSE']
      });
      return { merchantLocationKey: key, name };
    });
  }
  async categories(query) {
    if (!String(query || '').trim()) throw new Error('영문 카테고리 검색어를 입력해주세요.');
    const { api } = this.client();
    const tree = await api.request('GET', '/commerce/taxonomy/v1/get_default_category_tree_id?marketplace_id=EBAY_US');
    return api.request('GET', `/commerce/taxonomy/v1/category_tree/${encodeURIComponent(tree.categoryTreeId)}/get_category_suggestions?q=${encodeURIComponent(query)}`);
  }
  async preview(data) {
    const { config, api } = this.client();
    const payload = buildEbayPayload(data, config);
    validateAspects(payload.inventory.product.aspects, await api.aspects(payload.offer.categoryId));
    return payload;
  }

  async saveDraft(data) {
    return this.exclusive(async () => {
      const { config, api } = this.client();
      const payload = await this.preview(data);
      const key = this.store.jobKey(config, payload.sku);
      const hash = digest(payload);
      const job = this.store.job(key);
      const [inventory, offers] = await Promise.all([api.inventory(payload.sku), api.offers(payload.sku)]);
      const published = offers.find(o => o.status === 'PUBLISHED');
      if (published) {
        const listingId = published.listing?.listingId || null;
        throw duplicateError(`이미 게시된 SKU입니다. 기존 상품 관리에서 조회해주세요. (offerId ${published.offerId || '?'}, listingId ${listingId || '?'})`,
          { channel: 'ebay', source: 'live', key: { sku: payload.sku, environment: config.environment },
            products: [{ id: listingId, name: '', optionText: '', url: listingId ? `https://www.ebay.com/itm/${listingId}` : null, status: 'PUBLISHED', registeredAt: null, offerId: published.offerId || null }] });
      }
      if (offers.length > 1) throw new Error('같은 SKU의 Offer가 여러 개입니다. eBay에서 상태를 확인해주세요.');
      if ((inventory || offers.length) && (!job || job.hash !== hash)) throw new Error('이미 사용 중인 SKU입니다. 기존 초안은 저장 당시 입력값으로 복구하거나 새 SKU를 사용해주세요.');
      if (job && job.hash !== hash) throw new Error('이 SKU의 이전 작업이 있습니다. 입력값을 복구하거나 새 SKU를 사용해주세요.');
      if (job?.status === 'PUBLISH_PENDING') throw new Error('이전 게시 결과가 아직 확정되지 않았습니다. SKU 조회로 상태를 확인해주세요.');
      // store.job 은 병합 저장이라 true 가 한 번 남으면 계속 남는다 — 매 저장마다 이번 요청 값으로 덮는다.
      const bypassLegacy = data?.allowDuplicate === true;
      if (offers.length) {
        this.store.job(key, { sku: payload.sku, offerId: offers[0].offerId, status: 'DRAFT', hash, bypassLegacy });
        return { sku: payload.sku, offerId: offers[0].offerId, status: 'DRAFT', environment: config.environment };
      }
      if (job?.status === 'CREATE_PENDING') throw new Error('이전 Offer 생성 결과가 아직 확인되지 않았습니다. 중복 생성을 막기 위해 재전송하지 않았습니다. 잠시 후 같은 입력으로 다시 조회해주세요.');
      // 앱 밖(Seller Hub/Trading)에서 올린 레거시 리스팅은 Inventory API 조회(위)에 안 잡힌다.
      // 활성 리스팅 캐시에 같은 SKU 가 있으면 새 Offer 를 만들지 않는다 — 이미 2중 게시된 SKU 가 있다.
      if (!bypassLegacy) { const legacy = this._legacyListingForSku(payload.sku, job); if (legacy) throw legacy; }
      this.store.job(key, { sku: payload.sku, hash, status: 'INVENTORY_PENDING', bypassLegacy });
      await api.request('PUT', `/sell/inventory/v1/inventory_item/${encodeURIComponent(payload.sku)}`, payload.inventory);
      this.store.job(key, { status: 'CREATE_PENDING' });
      let result;
      try { result = await api.request('POST', '/sell/inventory/v1/offer', payload.offer); }
      catch (error) {
        if (error instanceof EbayAPIError && error.status < 500 && error.status !== 408) this.store.job(key, { status: 'CREATE_REJECTED' });
        throw error;
      }
      if (!result.offerId) throw new Error('Offer ID가 응답에 없습니다. 같은 입력으로 다시 조회해주세요.');
      this.store.job(key, { offerId: result.offerId, status: 'DRAFT' });
      return { sku: payload.sku, offerId: result.offerId, status: 'DRAFT', environment: config.environment, warnings: result.warnings || [] };
    });
  }

  /**
   * 활성 리스팅 캐시(Trading API 로 동기화한 것)에 같은 SKU 의 **다른** 리스팅이 있으면 그 오류를,
   * 없으면 null. 캐시가 없거나 깨졌으면 확인하지 못한 채 진행한다 — 캐시는 사용자가 동기화할 때만
   * 생기므로, 없다고 막으면 동기화하지 않은 PC 는 eBay 등록을 아예 못 한다.
   */
  _legacyListingForSku(sku, job) {
    let cache;
    try { cache = this.getCachedListings(); } catch { return null; }
    if (!cache || !Array.isArray(cache.items)) {
      console.warn('[중복검사] eBay 활성 리스팅 캐시 없음 — 레거시 중복은 확인하지 못함');
      return null;
    }
    const SKU = String(sku || '').trim().toUpperCase();
    // sku 가 빈 행(id 에 itemID 가 들어간 것)은 비교하지 않는다 — 리스팅 번호가 우연히 SKU 와 같을 수 있다.
    const row = cache.items.find(r => r && String(r.sku || '').trim() !== ''
      && String(r.sku).trim().toUpperCase() === SKU && String(r.listingId ?? '') !== String(job?.listingId ?? ''));
    if (!row) return null;
    const url = row.url || (row.listingId ? `https://www.ebay.com/itm/${row.listingId}` : '');
    return duplicateError(
      `이미 eBay에 게시 중인 SKU입니다 — listingId ${row.listingId || '?'} ${url} (활성 리스팅 캐시 ${cache.updatedAt || '?'} 기준). `
      + '새 Offer를 만들지 않았습니다. 이미 내렸다면 [활성 리스팅 목록 동기화] 후 다시 시도하세요.',
      { channel: 'ebay', source: 'cache', key: { sku, environment: cache.environment },
        products: [{ id: row.listingId || null, name: row.name || '', url: url || null, status: 'Active' }] });
  }

  getCachedListings() {
    if (typeof this.store?.listingsCache !== 'function') return null;
    const { config } = this.client();
    const cache = this.store.listingsCache();
    if (!cache || cache.environment !== config.environment) return null;
    return cache;
  }

  getCachedListingsSummary() {
    const cache = this.getCachedListings();
    return {
      total: cache?.total || 0,
      count: cache?.items?.length || 0,
      updatedAt: cache?.updatedAt || null,
      environment: cache?.environment || null
    };
  }

  async refreshActiveListingsCache(onProgress = null) {
    const { api, config } = this.client();
    const all = [];
    const entriesPerPage = 200;
    const first = await api.getActiveListings(1, entriesPerPage);
    all.push(...first.items);
    if (onProgress) onProgress({ loaded: all.length, total: first.total, stage: 'fetch' });
    for (let page = 2; page <= first.totalPages; page++) {
      const res = await api.getActiveListings(page, entriesPerPage);
      all.push(...res.items);
      if (onProgress) onProgress({ loaded: all.length, total: first.total, stage: 'fetch' });
    }
    const formatted = all.map(it => ({
      id: it.sku || it.itemID,
      sku: it.sku || '',
      listingId: it.itemID,
      name: it.title || '',
      price: it.price || '',
      stock: it.quantity || '',
      url: it.url || '',
      status: 'Active'
    }));
    const cacheData = {
      updatedAt: new Date().toISOString(),
      environment: config.environment,
      total: first.total,
      items: formatted
    };
    if (typeof this.store?.saveListingsCache === 'function') {
      this.store.saveListingsCache(cacheData);
    }
    return {
      total: cacheData.total,
      count: formatted.length,
      updatedAt: cacheData.updatedAt
    };
  }

  // stats 를 넘기면 조회 집계와 0건 사유(stats.reason)를 채워 준다. 반환값은 항상 배열이다.
  async searchProducts(query = {}, stats = null) {
    const cached = this.getCachedListings();
    if (cached && Array.isArray(cached.items) && cached.items.length > 0) {
      const tally = { scanned: cached.items.length, matched: 0, noOffer: 0, multiOffer: 0, pages: 1, total: cached.total ?? cached.items.length };
      const matches = cached.items.filter(row => matchesProduct({
        id: row.id || row.sku || row.listingId,
        name: row.name,
        brand: row.brand
      }, query));
      tally.matched = matches.length;
      if (stats) {
        Object.assign(stats, tally, {
          reason: matches.length ? '' : emptySearchReason(tally, query)
        });
      }
      return matches.map(row => ({
        id: row.sku || row.listingId,
        sku: row.sku || '',
        listingId: row.listingId,
        name: row.name,
        price: row.price,
        stock: row.stock,
        description: row.description || '',
        status: row.status || 'Active',
        url: row.url || ''
      }));
    }

    const { api } = this.client();
    const items = new Map();
    const tally = { scanned: 0, matched: 0, noOffer: 0, multiOffer: 0, pages: 0, total: null };
    for (let offset = 0; ; offset += 100) {
      const page = await api.inventoryItems(offset, 100);
      const inventory = page.inventoryItems || [];
      tally.pages++;
      tally.scanned += inventory.length;
      if (tally.total === null && Number.isFinite(Number(page.total))) tally.total = Number(page.total);
      const matches = inventory.filter(row => row.sku && matchesProduct({
        id: row.sku, name: row.product?.title, brand: row.product?.brand
      }, query));
      tally.matched += matches.length;
      // Bound offer lookups; inventory is shared across marketplaces, offers are US-only.
      for (let start = 0; start < matches.length; start += 5) {
        const batch = await Promise.all(matches.slice(start, start + 5).map(async row => {
          const offers = await api.offers(row.sku);
          if (offers.length !== 1) { // Same identity requirement as load().
            if (offers.length) tally.multiOffer++; else tally.noOffer++;
            return null;
          }
          const offer = offers[0];
          return { id: row.sku, name: row.product?.title || row.sku,
            price: String(offer.pricingSummary?.price?.value ?? ''),
            stock: String(offer.availableQuantity ?? ''),
            description: row.product?.description || '', status: offer.status };
        }));
        for (const item of batch) if (item) items.set(item.id, item);
      }
      if (!page.next && (inventory.length < 100 || offset + inventory.length >= page.total)) break;
      if (!inventory.length || offset >= 99900) throw new Error('eBay 목록 페이지를 모두 조회하지 못했습니다. API 응답을 확인해주세요.');
    }
    if (stats) Object.assign(stats, tally, { reason: items.size ? '' : emptySearchReason(tally, query) });
    return [...items.values()];
  }

  async getActiveListingsSummary() {
    const { api } = this.client();
    const res = await api.getActiveListings(1, 1);
    return { total: res.total };
  }

  async getAllActiveListings(onProgress = null) {
    const { api } = this.client();
    const all = [];
    const first = await api.getActiveListings(1, 200);
    all.push(...first.items);
    if (onProgress) onProgress({ loaded: all.length, total: first.total });
    for (let page = 2; page <= first.totalPages; page++) {
      const res = await api.getActiveListings(page, 200);
      all.push(...res.items);
      if (onProgress) onProgress({ loaded: all.length, total: first.total });
    }
    return all;
  }

  async _migrateListingsInternal(listingIds, onProgress = null, concurrency = 4) {
    const { api } = this.client();
    const ids = [...new Set((listingIds || []).map(id => String(id).trim()).filter(Boolean))];
    const successful = [];
    const failed = [];
    const chunkSize = 5;

    const chunks = [];
    for (let i = 0; i < ids.length; i += chunkSize) {
      chunks.push(ids.slice(i, i + chunkSize));
    }

    let processed = 0;

    for (let i = 0; i < chunks.length; i += concurrency) {
      const batch = chunks.slice(i, i + concurrency);
      await Promise.all(batch.map(async chunk => {
        try {
          const res = await api.bulkMigrateListing(chunk);
          for (const item of (res.responses || [])) {
            const isAlreadyMigrated = item.errors?.some(e => /already\s+(been\s+)?migrated/i.test(e.message || e.longMessage || ''));
            if ((item.statusCode >= 200 && item.statusCode < 300) || isAlreadyMigrated) {
              successful.push(item);
            } else {
              failed.push(item);
            }
          }
        } catch (err) {
          chunk.forEach(listingId => failed.push({ listingId, errors: [{ message: err.message }] }));
        } finally {
          processed = Math.min(ids.length, processed + chunk.length);
          if (onProgress) {
            onProgress({
              processed,
              total: ids.length,
              successful: successful.length,
              failed: failed.length
            });
          }
        }
      }));
    }
    return { total: ids.length, successful, failed };
  }

  async migrateListings(listingIds, onProgress = null, concurrency = 4) {
    return this.exclusive(() => this._migrateListingsInternal(listingIds, onProgress, concurrency));
  }

  async load(sku, { allowMigration = true } = {}) {
    sku = String(sku || '').trim();
    if (!sku) throw new Error('조회할 SKU를 입력해주세요.');
    const isListingId = /^\d{10,14}$/.test(sku);
    const { api, config } = this.client();

    let resolvedSku = sku;
    let targetListingId = isListingId ? sku : null;

    // 로컬 캐시에서 해당 상품을 찾아 Listing ID 및 SKU 매핑 확인
    const cache = this.getCachedListings();
    if (cache?.items) {
      const found = cache.items.find(it =>
        it.listingId === sku || (it.sku && it.sku.toLowerCase() === sku.toLowerCase())
      );
      if (found) {
        if (found.sku) resolvedSku = found.sku;
        if (found.listingId) targetListingId = found.listingId;
      }
    }

    // 캐시에 없고 Listing ID인 경우, Trading API GetItem으로 실제 SKU 조회 시도
    if (isListingId && resolvedSku === sku && typeof api.getItem === 'function') {
      try {
        const itemInfo = await api.getItem(sku);
        if (itemInfo?.sku) resolvedSku = itemInfo.sku;
      } catch (_) {}
    }

    let inventory = null;
    let offers = [];

    // 1. 이미 Inventory API에 존재하는지 먼저 조회
    //    '없음'(25710/25713)은 api.inventory/offers 가 null/[] 로 돌려준다. 그 밖의 오류(토큰 만료·429·5xx·
    //    네트워크·프록시)는 그대로 던진다 — 예전처럼 삼키면 전부 '연결 필요'·'찾을 수 없음'으로 보였다.
    //    SKU 형식이 아닌 값(Listing ID 등)만 조회를 건너뛴다.
    let lookupSku = null;
    try { lookupSku = validateSku(resolvedSku); } catch (_) {}
    if (lookupSku) [inventory, offers] = await Promise.all([api.inventory(lookupSku), api.offers(lookupSku)]);

    // 2. Inventory API에 없고 Listing ID가 확인되면, 해당 1건만 온디맨드 즉시 이관 (JIT)
    //    이관을 허용하지 않을 때는 Inventory 에 아예 없을 때만 '연결 필요'로 멈춘다.
    //    Offer 가 0개·여러 개인 경우는 아래의 정확한 안내로 넘긴다.
    if (!allowMigration && !inventory && targetListingId) {
      throw new Error('Inventory API 연결이 필요한 상품입니다. 단일 상품 수정의 eBay 탭에서 상품을 먼저 불러와 연결해주세요.');
    }
    if (allowMigration && (!inventory || offers.length !== 1) && targetListingId) {
      try {
        const mig = await this._migrateListingsInternal([targetListingId]);
        if (mig.successful.length) {
          const succ = mig.successful[0];
          if (succ.inventoryItemId) {
            resolvedSku = succ.inventoryItemId;
          }
        }
      } catch (_) {}
      let migratedSku = null;
      try { migratedSku = validateSku(resolvedSku); } catch (_) {}
      if (migratedSku) [inventory, offers] = await Promise.all([api.inventory(migratedSku), api.offers(migratedSku)]);
    }

    // 3. 여전히 못 찾았고 SKU인 경우, 원격 활성 리스팅 검색 후 이관 시도 (폴백)
    if (allowMigration && (!inventory || offers.length !== 1) && !targetListingId && this.getAllActiveListings) {
      try {
        const activeListings = await this.getAllActiveListings();
        const found = activeListings.find(it => it.sku && it.sku.toLowerCase() === resolvedSku.toLowerCase());
        if (found && found.itemID) {
          const mig = await this._migrateListingsInternal([found.itemID]);
          if (mig.successful.length) {
            if (mig.successful[0].inventoryItemId) resolvedSku = mig.successful[0].inventoryItemId;
          }
          const validSku = validateSku(resolvedSku);
          [inventory, offers] = await Promise.all([api.inventory(validSku), api.offers(validSku)]);
        }
      } catch (_) {}
    }

    const finalSku = validateSku(resolvedSku);
    if (!inventory) {
      throw new Error(`상품(SKU: ${finalSku})을 Inventory API에서 찾을 수 없습니다. [활성 리스팅 목록 동기화]를 먼저 실행하거나, 정확한 SKU를 확인해주세요.`);
    }
    if (offers.length === 0) {
      throw new Error(`상품(SKU: ${finalSku})은 등록되어 있으나, 미국(EBAY_US / EBAY_MOTORS) 고정가 Offer가 없습니다. eBay Seller Hub에서 Offer 상태를 확인해주세요.`);
    }
    if (offers.length > 1) {
      throw new Error(`상품(SKU: ${finalSku})에 동일한 Offer가 ${offers.length}개 존재합니다. eBay에서 중복 Offer를 정리해주세요.`);
    }
    return { sku: finalSku, inventory, offer: offers[0], environment: config.environment };
  }

  async publish(sku) {
    return this.exclusive(async () => {
      const current = await this.load(sku);
      const { api, config } = this.client();
      const key = this.store.jobKey(config, current.sku);
      if (current.offer.status === 'PUBLISHED') {
        this.store.job(key, { status: 'PUBLISHED', offerId: current.offer.offerId, listingId: current.offer.listing?.listingId });
        return { ...current.offer.listing, status: 'PUBLISHED' };
      }
      const job = this.store.job(key);
      if (!job || job.offerId !== current.offer.offerId) throw new Error('이 앱에서 저장한 초안만 게시할 수 있습니다.');
      if (job.status === 'PUBLISH_PENDING') throw new Error('이전 게시 결과가 아직 확정되지 않았습니다. SKU 조회로 상태를 확인해주세요.');
      // saveDraft 의 멱등 복구로 돌아온 초안, 또는 초안 저장 뒤 캐시가 동기화된 경우를 여기서 막는다.
      if (!job.bypassLegacy) { const legacy = this._legacyListingForSku(current.sku, job); if (legacy) throw legacy; }
      this.store.job(key, { status: 'PUBLISH_PENDING' });
      let result;
      try { result = await api.request('POST', `/sell/inventory/v1/offer/${encodeURIComponent(current.offer.offerId)}/publish`); }
      catch (error) {
        if (error instanceof EbayAPIError && error.status < 500 && error.status !== 408) this.store.job(key, { status: 'DRAFT' });
        throw error;
      }
      if (!result.listingId) throw new Error('게시 결과를 확인하지 못했습니다. SKU로 다시 조회해주세요.');
      this.store.job(key, { status: 'PUBLISHED', listingId: result.listingId });
      return { ...result, status: 'PUBLISHED' };
    });
  }

  async updateImages({ sku, images, expectedImages }) {
    return this.exclusive(async () => {
      let current, urls;
      try {
        urls = parseImageUrls(images, 'ebay');
        current = await this.load(sku, { allowMigration: false });
        if (current.offer.status !== 'PUBLISHED') throw new Error('게시된 상품만 이미지를 수정할 수 있습니다.');
        if (!sameImages(current.inventory.product?.imageUrls || [], expectedImages)) throw new Error('이미지가 변경됐습니다. 다시 불러오세요.');
      } catch (e) { throw markPreSend(e); }
      const { api } = this.client();
      // Inventory replacement requires the latest complete writable representation.
      const payload = JSON.parse(JSON.stringify(current.inventory));
      for (const field of ['sku', 'locale', 'inventoryItemGroupKeys']) delete payload[field];
      payload.product = { ...payload.product, imageUrls: urls };
      await api.request('PUT', `/sell/inventory/v1/inventory_item/${encodeURIComponent(current.sku)}`, payload);
      this.store.updateCachedListing?.(current.sku, { image: urls[0] });
      return { status: 'UPDATED' };
    });
  }

  async updatePricesBatch(jobs) {
    return this.exclusive(() => updateEbayPricesBatch({ api: this.client().api, store: this.store }, jobs));
  }

  async updatePriceQuantity(data) {
    return this.exclusive(async () => {
      // 여기서 던지는 오류는 모두 수정 요청을 보내기 전이다(stage=pre-send). 일괄 수정 화면이 '전송 안 됨'으로 구분한다.
      let current;
      try { current = await this.load(data.sku, { allowMigration: !data.priceOnly }); }
      catch (e) { throw markPreSend(e); }
      if (data.priceOnly && Number(current.offer.pricingSummary?.price?.value) !== Number(data.expectedPrice))
        throw markPreSend(new Error('가격이 변경됐습니다. 현재가를 다시 불러오세요.'));
      if (current.offer.status !== 'PUBLISHED') throw markPreSend(new Error('게시된 상품만 가격·판매 수량을 수정할 수 있습니다.'));
      if (current.offer.pricingSummary?.price?.currency !== 'USD') throw markPreSend(new Error('USD 상품만 수정할 수 있습니다.'));
      let price, quantity, offer;
      if (data.priceOnly) {
        // 가격만 바꿀 때는 수량을 보내지 않는다. OfferPriceQuantity 는 price 와 availableQuantity 중
        // 하나만 있어도 되고, 조회 시점 수량을 다시 쓰면 그 사이 팔린 수량이 되살아난다.
        try { ({ price } = priceQuantity({ price: data.price, quantity: 0 })); }
        catch (e) { throw markPreSend(e); }
        offer = { offerId: current.offer.offerId, price: { currency: 'USD', value: price } };
      } else {
        try { ({ price, quantity } = priceQuantity(data)); }
        catch (e) { throw markPreSend(e); }
        const total = current.inventory.availability?.shipToLocationAvailability?.quantity;
        if (!Number.isInteger(total) || quantity > total) throw markPreSend(new Error(`판매 수량은 전체 재고(${total ?? '조회 불가'}) 이하로 입력해주세요.`));
        offer = { offerId: current.offer.offerId, availableQuantity: quantity, price: { currency: 'USD', value: price } };
      }
      const { api } = this.client();
      const result = await api.request('POST', '/sell/inventory/v1/bulk_update_price_quantity', { requests: [{ sku: current.sku, offers: [offer] }] });
      const response = result.responses?.[0];
      if (!response || response.statusCode < 200 || response.statusCode >= 300 || response.errors?.length) {
        const detail = response?.errors?.map(e => `[${e.errorId}] ${e.longMessage || e.message}`).join('; ');
        const error = new Error(detail || '가격·판매 수량 수정 결과를 확인하지 못했습니다. 다시 조회해주세요.');
        // per-SKU 오류는 eBay 가 요청을 거부한 것이다. 응답 자체가 없으면 결과를 알 수 없다.
        if (detail) Object.assign(error, { status: Number(response.statusCode) || 400, rejected: true });
        throw error;
      }
      if (typeof this.store?.updateCachedListing === 'function') {
        this.store.updateCachedListing(current.sku, quantity === undefined ? { price } : { price, stock: quantity });
      }
      return { status: 'UPDATED', warnings: response.warnings || [] };
    });
  }

  async withdraw(sku) {
    return this.exclusive(async () => {
      const current = await this.load(sku);
      if (current.offer.status !== 'PUBLISHED') throw new Error('현재 게시 중인 상품이 아닙니다.');
      const { api, config } = this.client();
      const result = await api.request('POST', `/sell/inventory/v1/offer/${encodeURIComponent(current.offer.offerId)}/withdraw`);
      this.store.job(this.store.jobKey(config, current.sku), { status: 'WITHDRAWN', offerId: current.offer.offerId });
      return { ...result, status: 'WITHDRAWN' };
    });
  }
}
