// Price-only adapters reuse the existing authenticated transports and preserve unrelated fields.
import { describeError, markPreSend } from './utils/api_error.js';
import { createBulkImageService, productImageState } from './bulk_image_service.js';
import { createBulkBatch } from './bulk_batch.js';
import { readVehicleCatalog } from './utils/imweb_catalog.js';
import { isImwebBulkScope } from './imweb_bulk.js';
import { createIdentityIndex, productIdentity } from './utils/product_identity.js';

const NAVER_SEARCH_SIZE = 100;   // 네이버 목록 조회 한 번에 읽는 상품 수
const NAVER_VERIFY_GROUP = 10;   // 네이버 저장 뒤 확인을 묶는 상품 수(결과가 화면에 너무 늦게 뜨지 않을 만큼)
const IMWEB_SAVE_GROUP = 20;     // 아임웹 한 번에 넘기는 줄 수(상품 4~5개). 결과는 묶음마다 화면에 뜬다
const LOAD_MANY_MAX = 200;

// imwebBulk: 아임웹 네 범위(B2B · 본사 한국/미국/일본)의 Open API 어댑터(imweb_bulk.js).
export function registerBulkPriceIPC({ ipcMain, naverAPI, naverProducts, coupang, amazon, ebay, imwebBulk, rates,
  log = console, sleep = ms => new Promise(r => setTimeout(r, ms)), inspectImages, readCatalog, directory }) {
  // 표의 '상품번호 / SKU' 칸은 몰과 상관없이 같은 표기(No.101 BSA · SKU)로 보인다. 카탈로그는 앱에 묶여 있어
  // 한 번 읽어 둔다. 못 읽어도 목록은 그대로 돌려준다 — 표기는 보여 주기용이라 몰 ID·저장에는 쓰지 않는다.
  let identityIndex = null;
  async function withIdentity(rows) {
    if (!identityIndex) {
      try { identityIndex = createIdentityIndex(await (readCatalog || readVehicleCatalog)()); }
      catch (e) { log.error?.('[bulk-price] 상품 표준 표기용 카탈로그를 읽지 못했습니다: ' + e.message); }
    }
    return rows.map(r => ({ ...r, identity: productIdentity(r, identityIndex || undefined) }));
  }
  const images = createBulkImageService({ naverProducts, coupang, amazon, ebay, imwebBulk, sleep, inspect: inspectImages });
  const markets = { 'amazon-us': 'ATVPDKIKX0DER', 'amazon-jp': 'A1VC38T7YXB528' };
  const currencies = { naver: 'KRW', coupang: 'KRW', 'imweb-b2b': 'KRW', 'imweb-en': 'USD',
    'imweb-ko': 'KRW', 'imweb-jp': 'JPY', 'amazon-us': 'USD', 'amazon-jp': 'JPY', ebay: 'USD' };
  // 쓰기는 한 번에 하나. 화면 저장끼리 겹치면 예전처럼 BUSY 로 돌려보낸다. 환율 자동 변경(fx_auto_price.js)이
  // 저장 중이면 화면 요청은 그 한 건(몇 초)이 끝나기를 기다리고, 자동 변경도 화면 저장이 끝나기를 기다린다.
  let writing = null, idle = null, release = () => {};
  const hold = owner => { writing = owner; idle = new Promise(resolve => { release = resolve; }); };
  const free = () => { writing = null; release(); };
  async function exclusive(work) {
    while (writing) await idle;
    hold('fx');
    try { return await work(); } finally { free(); }
  }
  const currency = scope => {
    if (!Object.hasOwn(currencies, scope)) throw new Error('지원하지 않는 플랫폼입니다.');
    return currencies[scope];
  };
  const identity = input => {
    currency(input.scope);
    const id = String(input.id ?? '').trim();
    if (!id) throw new Error('상품번호 또는 SKU가 없습니다.');
    return id;
  };
  const priceOf = value => value === '' || value == null ? '' : String(value);
  const samePrice = (a, b) => (a === '' || b === '') ? a === b : Number(a) === Number(b);
  const config = get => { const service = get(); service.loadConfig(); return service; };
  function row(input, price, extra = {}) {
    return { ...input, price: priceOf(price), currency: currency(input.scope), ready: true, ...extra };
  }
  async function list({ scope, query = '' }) {
    currency(scope);
    let items = [], note = '', truncated = false;
    if (scope === 'naver') items = (await naverAPI().allProducts()).map(p => ({
      ...p, price: p.salePrice, image: p.representativeImage }));
    else if (scope === 'coupang') {
      // 쿠팡 목록 API 에는 옵션ID·판매가가 없다(공식 문서). 이 PC 에서 불러온 적 있는 상품만 그때 읽은 판매가를
      // 옵션 행의 '(목록)' 가격으로 펼친다(coupang.js listForPriceEdit). 고치려면 지금처럼 현재가를 다시 불러온다.
      const listed = await config(coupang).listForPriceEdit();
      items = listed.items;
      note = listed.cached
        ? `쿠팡 목록에는 옵션·판매가가 없어, 이 PC 에서 불러온 적 있는 상품 ${listed.cached}개는 그때 읽은 판매가를 '(목록)' 으로 보여 줍니다. 가격을 바꾸려면 현재가를 다시 불러오세요.`
        : '쿠팡 목록에는 옵션·판매가가 없습니다. 현재가를 불러오면 옵션별 판매가가 나오고, 다음 목록부터는 그 값이 \'(목록)\' 으로 보입니다.';
    } else if (markets[scope]) {
      const stats = {};
      items = await config(amazon).searchProducts({ marketplaceId: markets[scope], searchText: query }, stats);
      // 캐시가 없으면 API 페이징이 1000건에서 조용히 끊긴다. 일부만 보이는 목록을 전체처럼 쓰지 않게 알린다.
      truncated = !!stats.truncated;
      note = truncated
        ? `주의: 아마존 목록이 ${stats.scanned}/${stats.total}건에서 잘렸습니다(API 1000건 한도). 위의 [전체 목록 동기화]를 먼저 실행하세요.`
        : stats.reason || '이후 올린 상품이 안 보이면 위의 [전체 목록 동기화]로 아마존 전체 목록을 갱신하세요.';
    } else if (scope === 'ebay') {
      const stats = {};
      items = await ebay().searchProducts({ searchText: query }, stats);
      note = stats.reason || '이후 올린 상품이 안 보이면 위의 [전체 목록 동기화]로 eBay 전체 목록을 갱신하세요.';
    } else if (isImwebBulkScope(scope)) {
      items = await imwebBulk.list(scope);
      note = '아임웹 Open API · 목록의 가격은 기본 판매가입니다. 현재가를 불러오면 조합(옵션)별 가격이 줄마다 나옵니다.';
    }
    const words = String(query).toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return { items: items.filter(p => words.every(q => [p.id, p.sku, p.name, p.title, p.subject].join(' ').toLocaleLowerCase().includes(q)))
      .map(p => ({ ...p, id: String(p.id ?? p.sku), name: p.name || p.title || p.subject || '', scope,
        price: priceOf(p.price), currency: currency(scope), ready: false })), note, truncated };
  }
  const amazonRow = (input, p) => row(input, p.price, { ...(input.includeImages ? productImageState(input.scope, p) : {}),
    name: p.title, image: p.mainImageUrl });
  async function load(input) {
    const id = identity(input), { scope } = input;
    const imageState = p => input.includeImages ? productImageState(scope, p) : {};
    if (scope === 'naver') {
      const p = await naverProducts().loadProductForEdit(id);
      return [row(input, p.salePrice, { ...imageState(p), id: p.originNo, name: p.title, revision: p.revision,
        variant: '기본 판매가 · 옵션 추가금 유지', image: input.image || p.detailImages?.[0]?.url,
        optionTexts: (p.options || []).map(o => (o.names || []).join(' ')) })];
    }
    if (scope === 'coupang') {
      // 판매가는 옵션(vendorItemId)별 가격 API 로 바꾸고 확인하므로, 현재가도 같은 곳에서 읽는다.
      // 옵션ID 가 없는 옵션은 승인완료 전이라 판매가를 바꿀 수 없다.
      const service = config(coupang);
      const p = await service.loadProductForEdit(id);
      const state = p.statusName && p.statusName !== '승인완료' ? ' · ' + p.statusName : '';
      const rows = [];
      for (const o of p.options) {
        const base = { ...imageState(p), name: p.title, variant: (o.itemName || '') + state, image: o.imageUrl };
        if (!o.vendorItemId) {
          rows.push(row(input, o.salePrice, { ...base, optionId: 'item-' + (o.sellerProductItemId ?? o.index),
            ready: false, readonly: true, result: '승인완료 전 옵션이라 판매가를 바꿀 수 없습니다(쿠팡 승인 후 가능).' }));
          continue;
        }
        const inventory = await service.api.getItemInventory(o.vendorItemId);
        rows.push(row(input, inventory.salePrice, { ...base, optionId: String(o.vendorItemId) }));
      }
      return rows;
    }
    if (markets[scope]) return [amazonRow(input, await config(amazon).loadProductForEdit(id, markets[scope]))];
    if (scope === 'ebay') {
      const p = await ebay().load(id, { allowMigration: false });
      if (p.offer?.pricingSummary?.price?.currency !== 'USD') throw new Error('USD 상품만 가격 수정이 가능합니다.');
      if (p.offer.status !== 'PUBLISHED') throw new Error('게시된 상품만 수정 가능합니다.');
      return [row(input, p.offer.pricingSummary.price.value, { ...imageState(p), name: p.inventory.product?.title,
        image: p.inventory.product?.imageUrls?.[0] })];
    }
    if (isImwebBulkScope(scope)) {
      // 기본 판매가 한 줄 + 조합마다 한 줄. 조합 가격은 그 조합의 최종가다(추가금이 아니다).
      return (await imwebBulk.load(scope, id)).map(r => row(input, r.price, { ...imageState(r), id: r.id, name: r.name,
        variant: r.variant, optionId: r.optionId, image: input.image || r.image }));
    }
    throw new Error('이 게시판에는 수정할 판매가가 없습니다.');
  }

  // 네이버 상품 목록 조회(검색)를 원상품번호 목록으로 부른다. 한 번에 100건 — 전체 목록 동기화가 실계정에서 쓰는 페이지
  // 크기다(공식 최대값은 문서로 확인하지 못했다). 짝은 응답의 원상품번호로만 맞춘다: 걸러지지 않은 상품이 섞여 와도
  // 다른 상품의 가격을 쓰지 않고, 응답에 없는 번호는 부르는 쪽이 1건 조회로 다시 확인한다.
  // 네이버가 이 검색 조건을 400 으로 거부하면 앱을 다시 켤 때까지 묶음 조회를 쓰지 않는다(100건마다 헛요청하지 않게).
  let naverSearchRejected = false;
  async function naverListed(ids) {
    const found = new Map(), numbers = [...new Set(ids)].filter(id => /^\d{1,15}$/.test(id));
    if (naverSearchRejected) return found;
    for (let i = 0; i < numbers.length; i += NAVER_SEARCH_SIZE) {
      const chunk = numbers.slice(i, i + NAVER_SEARCH_SIZE), wanted = new Set(chunk);
      let res;
      try { res = await naverAPI().searchProducts({ searchKeywordType: 'PRODUCT_NO', originProductNos: chunk.map(Number), page: 1, size: NAVER_SEARCH_SIZE }); }
      catch (e) { if (Number(e?.status) === 400 && !e?.proxyError) naverSearchRejected = true; throw e; }
      for (const entry of res?.contents || []) {
        // allProducts 와 같이 첫 채널상품이 이름·가격을 들고 있다.
        const channel = (entry.channelProducts || [])[0] || {};
        const originNo = String(entry.originProductNo ?? channel.originProductNo ?? '');
        if (wanted.has(originNo) && channel.salePrice != null && !found.has(originNo)) found.set(originNo, channel);
      }
    }
    return found;
  }

  /**
   * 여러 상품의 현재가를 몰이 한 요청에 허용하는 만큼 묶어 읽는다. 네이버 목록 조회 100건, 아마존 20건.
   * 묶음 조회가 없는 쿠팡(옵션별 가격 API)·eBay(SKU별 Offer)는 지금처럼 1건씩 읽고, 묶음에서 빠진 상품도 1건 조회로 확인한다.
   * includeImages(화면의 현재가·이미지 불러오기)면 묶음 결과에 상세 이미지가 없는 상품(네이버 목록 조회)은 그 상품만 이미지 목록을 읽어 채운다.
   * @returns {{ items: Array<{id, rows}|{id, error, kind, blocking}>, blocked: string }} blocked 면 그 뒤 상품은 items 에 없다.
   */
  async function loadMany({ scope, ids, includeImages = false, images: thumbs = {} } = {}) {
    currency(scope);
    const list = [...new Set((Array.isArray(ids) ? ids : []).map(v => String(v ?? '').trim()).filter(Boolean))];
    if (!list.length || list.length > LOAD_MANY_MAX) throw new Error('한 번에 1~' + LOAD_MANY_MAX + '개 상품의 현재가를 불러올 수 있습니다.');
    const inputOf = id => ({ scope, id, includeImages, image: thumbs?.[id] });
    const ready = new Map();
    try {
      if (scope === 'naver') {
        for (const [id, p] of await naverListed(list)) ready.set(id, [row(inputOf(id), p.salePrice,
          { name: p.name || '', variant: '기본 판매가 · 옵션 추가금 유지', image: thumbs?.[id] || p.representativeImage?.url })]);
      } else if (markets[scope]) {
        for (const [id, p] of await config(amazon).loadProductsForEdit(list, markets[scope])) ready.set(id, [amazonRow(inputOf(id), p)]);
      }
    } catch (e) {
      const info = describeError(e);
      // 인증·한도·프록시 오류는 1건 조회도 똑같이 실패한다. 나머지는 1건 조회로 이어 간다.
      if (info.blocking) return { items: [{ id: list[0], ...info }], blocked: info.error };
      log.error?.(`[bulk-price] ${scope} 묶음 현재가 조회 실패 → 1건 조회로 진행: ${info.error}`);
    }
    const one = async id => {
      if (ready.has(id)) return { id, rows: ready.get(id) };
      try { return { id, rows: await load(inputOf(id)) }; }
      catch (e) { return { id, ...describeError(e) }; }
    };
    // eBay 는 이 PC 의 호출 간격 조절 대상이 아니라(일일 한도) 몇 건씩 동시에 읽는다. 나머지 몰은 간격 조절기가 한 줄로 세운다.
    const width = scope === 'ebay' ? 4 : 1, items = [];
    let blocked = '';
    for (let i = 0; i < list.length && !blocked; i += width) {
      for (const item of await Promise.all(list.slice(i, i + width).map(one))) {
        items.push(item);
        if (item.blocking && !blocked) blocked = item.error;
      }
    }
    // 이미지가 빠진 상품은 이미지 목록을 따로 읽는다('이미지 목록 조회'와 같은 길이라 저장 때 revision 검사가 맞다).
    // 못 읽어도 가격 행은 그대로 쓰고 이유를 처리 결과 칸에 남긴다. 인증·한도 오류가 나면 남은 상품은 읽지 않는다.
    let imageStop = '';
    for (const item of includeImages ? items : []) {
      if (!item.rows || item.rows.every(r => r.imagesReady)) continue;
      let error = imageStop;
      if (!error) {
        try {
          const got = await images.load({ scope, id: item.id });
          item.rows = item.rows.map(r => ({ ...r, images: got.images, imageRevision: got.revision, imagesReady: true, newImages: null }));
          continue;
        } catch (e) { const info = describeError(e); error = info.error; if (info.blocking) imageStop = error; }
      }
      item.rows = item.rows.map(r => ({ ...r, imageResult: '이미지 목록을 불러오지 못했습니다: ' + error }));
    }
    return { items, blocked };
  }

  const amazonWriter = {
    async write(ctx) {
      const service = config(amazon), marketplaceId = markets[ctx.input.scope];
      const result = await service.updateExistingProduct({ sku: ctx.id, marketplaceId, currency: ctx.unit,
        price: ctx.price, expectedPrice: ctx.expected });
      return { accepted: result.status === 'ACCEPTED', unchanged: result.status === 'UNCHANGED', salePrice: ctx.price };
    },
    current: async ({ id, input }) => (await config(amazon).loadProductForEdit(id, markets[input.scope])).price,
  };
  // 플랫폼별 쓰기(write)와 쓰기 뒤 확인용 판매가 조회(current).
  // write 는 보내기 전에 현재가를 다시 읽어 비교하고, 그 단계의 오류는 pre-send 로 표시한다.
  const writers = {
    naver: {
      // 조회·비교·PUT 을 한 번에 한다(행당 GET 2회 + PUT 1회).
      write: ({ id, price, expected }) => naverProducts().updateSalePrice({ originNo: id, salePrice: price, expectedPrice: expected }),
      current: async ({ id }) => (await naverProducts().loadProductForEdit(id)).salePrice,
    },
    coupang: {
      // 상품 수정(PUT seller-products) 대신 아이템별 가격 변경 API. 조회·비교·변경폭 확인을 coupang.js 가 한다.
      write: ({ input, price, expected }) => config(coupang).changeItemPrice({ vendorItemId: input.optionId, salePrice: price, expectedPrice: expected }),
      current: async ({ input }) => (await config(coupang).api.getItemInventory(input.optionId)).salePrice,
    },
    'amazon-us': amazonWriter,
    'amazon-jp': amazonWriter,
    // 아임웹: 기본 판매가(optionId 없음) 또는 조합 가격. 보내기 전에 다시 읽어 불러온 값과 비교한다.
    ...Object.fromEntries(['imweb-b2b', 'imweb-ko', 'imweb-en', 'imweb-jp'].map(scope => [scope, {
      write: ({ input, id, price, expected }) => imwebBulk.writePrice({ scope, id, optionId: input.optionId, price, expected }),
      current: ({ input, id }) => imwebBulk.currentPrice(scope, id, input.optionId),
    }])),
    ebay: {
      // updatePriceQuantity 가 조회·기대가 비교·게시 상태 확인을 pre-send 로 표시해 던진다. 가격만 보낸다.
      write: ({ id, price, expected }) => ebay().updatePriceQuantity({ sku: id, price, priceOnly: true, expectedPrice: expected }),
      current: async ({ id }) => (await ebay().load(id, { allowMigration: false })).offer?.pricingSummary?.price?.value,
    },
  };
  // 쓰기 뒤 판매가만 다시 읽어 확인한다. 반영이 늦는 경우가 있어 한 번 더 기다렸다 읽는다.
  async function verify(writer, ctx) {
    let seen = '', failure = null;
    for (const wait of [0, 1500]) {
      if (wait) await sleep(wait);
      try { seen = priceOf(await writer.current(ctx)); failure = null; }
      catch (e) { failure = e; continue; }
      if (samePrice(seen, ctx.price)) return { status: 'VERIFIED', price: seen };
    }
    if (failure) return { status: 'CHECK', message: `요청은 보냈지만 재조회에 실패했습니다(${failure.message}). 다시 보내기 전에 현재가를 확인하세요.` };
    return { status: 'CHECK', price: seen, message: `요청은 보냈지만 조회된 판매가(${seen || '없음'})가 입력값과 다릅니다. 반영이 늦을 수 있으니 잠시 뒤 현재가를 다시 불러오세요.` };
  }
  function priceContext(input) {
    const id = identity(input), unit = currency(input.scope), price = String(input.newPrice ?? '').trim();
    if (!(unit === 'USD' ? /^\d+(\.\d{1,2})?$/ : /^\d+$/).test(price) ||
        !Number.isFinite(Number(price)) || Number(price) <= 0 || Number(price) > Number.MAX_SAFE_INTEGER)
      throw new Error(unit + ' 판매가를 양수로 입력하세요.' + (unit === 'USD' ? ' 소수 둘째 자리까지 가능합니다.' : ' 정수만 가능합니다.'));
    if (input.scope === 'coupang' && Number(price) % 10 !== 0) throw new Error('쿠팡 판매가는 10원 단위로 입력하세요.');
    if (input.expectedPrice === undefined) throw new Error('현재가를 먼저 불러오세요.');
    const writer = writers[input.scope];
    if (!writer) throw new Error('이 게시판에는 수정할 판매가가 없습니다.');
    return { id, input, unit, price, expected: priceOf(input.expectedPrice) };
  }
  async function save(input) {
    const ctx = priceContext(input), writer = writers[input.scope], { price } = ctx;
    let outcome;
    // 여기서 난 오류는 쓰기 요청이 나갔을 수 있다(sent). pre-send 로 표시된 것만 '전송 안 됨'이다.
    try { outcome = (await writer.write(ctx)) || {}; }
    catch (e) { if (e && typeof e === 'object') e.sent = true; throw e; }
    if (outcome.unchanged) return { status: 'UNCHANGED', price: priceOf(outcome.salePrice ?? price) };
    if (outcome.accepted) return { status: 'ACCEPTED', price, message: '아마존 접수 완료 · 반영까지 시간이 걸릴 수 있습니다.' };
    return verify(writer, ctx);
  }
  // 네이버 일괄 저장. 판매가를 정해서 바꾸는 다건 API 가 없어(bulk-update 는 n원·n% 증감만 — 공식 답변) 쓰기는
  // 상품마다 GET + PUT 이다. 쓰기 뒤 확인만 묶는다: 보낸 상품을 목록 조회 한 번으로 다시 읽고, 다르게 보이는
  // 상품(검색 반영이 늦은 경우 포함)만 지금처럼 1건 조회로 확인한다. 중단·결과 불명이면 남은 상품은 보내지 않는다.
  async function saveNaverPrices(jobs, { cancelled = () => false } = {}) {
    const outcomes = new Array(jobs.length), sent = [];
    let stop = '';
    for (const [i, job] of jobs.entries()) {
      if (stop || cancelled()) {
        outcomes[i] = { success: false, ...describeError(markPreSend(new Error(stop || '중단해서 보내지 않았습니다.')), { sent: false }) };
        continue;
      }
      let ctx;
      try { ctx = priceContext(job); } catch (e) { outcomes[i] = { success: false, ...describeError(e, { sent: false }) }; continue; }
      try {
        const out = (await writers.naver.write(ctx)) || {};
        if (out.unchanged) outcomes[i] = { success: true, data: { status: 'UNCHANGED', price: priceOf(out.salePrice ?? ctx.price) } };
        else sent.push({ i, ctx });
      } catch (e) {
        const info = describeError(e, { sent: true });
        outcomes[i] = { success: false, ...info };
        if (info.blocking || info.stage === 'unknown') stop = '앞 상품의 저장이 실패해 보내지 않았습니다: ' + info.error;
      }
    }
    if (!sent.length) return outcomes;
    let listed = new Map();
    try { listed = await naverListed(sent.map(s => s.ctx.id)); } catch { /* 아래 1건 조회로 확인한다 */ }
    for (const { i, ctx } of sent) {
      const seen = listed.get(ctx.id);
      outcomes[i] = { success: true, data: seen && samePrice(priceOf(seen.salePrice), ctx.price)
        ? { status: 'VERIFIED', price: ctx.price } : await verify(writers.naver, ctx) };
    }
    return outcomes;
  }
  // 아임웹 일괄 저장. 같은 상품의 줄(기본가 + 조합)은 한 번 읽어 모두 판단하고, 바뀌는 줄만 보낸 뒤 한 번 다시 읽어 확인한다.
  // 예전엔 줄마다 읽기 → 보내기 → 다시 읽기라 조합 목록을 줄마다 두 번 읽었다(기본가 + 조합 3개 = 12회 → 8회).
  // 판단은 한 줄 저장과 같다(imweb_bulk checkBefore · verify): 불러온 뒤 바뀐 줄은 보내지 않고, 이미 같으면 '변경 없음'.
  // 중단은 상품 사이에서 본다 — 한 상품의 줄은 끝까지 보내 기본가 · 조합가가 반쯤 바뀐 채로 남지 않게 한다.
  async function saveImwebPrices(jobs, { cancelled = () => false } = {}) {
    const scope = jobs[0].scope, outcomes = new Array(jobs.length), byProduct = new Map();
    const fail = (i, e, sent) => { outcomes[i] = { success: false, ...describeError(sent ? e : markPreSend(e), { sent }) }; return outcomes[i]; };
    for (const [i, job] of jobs.entries()) {
      try { const ctx = priceContext(job); if (!byProduct.has(ctx.id)) byProduct.set(ctx.id, []); byProduct.get(ctx.id).push({ i, ctx }); }
      catch (e) { fail(i, e, false); }
    }
    const need = rows => ({ base: rows.some(r => !r.ctx.input.optionId), options: rows.some(r => r.ctx.input.optionId) });
    let stop = '';
    for (const [id, rows] of byProduct) {
      if (stop || cancelled()) { rows.forEach(r => fail(r.i, new Error(stop || '중단해서 보내지 않았습니다.'), false)); continue; }
      let now;
      try { now = await imwebBulk.readPrices(scope, id, need(rows)); }
      catch (e) { rows.forEach(r => { if (fail(r.i, e, false).blocking) stop = e.message; }); continue; }
      const sent = [];
      for (const { i, ctx } of rows) {
        if (stop) { fail(i, new Error('앞 줄의 저장이 실패해 보내지 않았습니다: ' + stop), false); continue; }
        let current;
        try {
          current = imwebBulk.priceIn(now, ctx.input.optionId);
          if (imwebBulk.checkBefore(current, ctx)) { outcomes[i] = { success: true, data: { status: 'UNCHANGED', price: priceOf(current) } }; continue; }
        } catch (e) { fail(i, e, false); continue; }
        try { await imwebBulk.sendPrice(scope, id, ctx.input.optionId, ctx.price); sent.push({ i, ctx }); }
        catch (e) { const info = fail(i, e, true); if (info.blocking || info.stage === 'unknown') stop = info.error; }
      }
      // 보낸 줄만 다시 읽어 확인한다(반영이 늦으면 1.5초 뒤 한 번 더). 판단 문구는 verify() 와 같다.
      let pending = sent, failure = null, seen = null;
      for (const wait of [0, 1500]) {
        if (!pending.length) break;
        if (wait) await sleep(wait);
        try { seen = await imwebBulk.readPrices(scope, id, need(pending)); failure = null; }
        catch (e) { failure = e; continue; }
        pending = pending.filter(({ i, ctx }) => {
          let got = '';
          try { got = priceOf(imwebBulk.priceIn(seen, ctx.input.optionId)); } catch { /* 조합이 없어졌으면 다르다 */ }
          if (!samePrice(got, ctx.price)) return true;
          outcomes[i] = { success: true, data: { status: 'VERIFIED', price: got } };
          return false;
        });
      }
      for (const { i, ctx } of pending) {
        let got = '';
        try { if (seen) got = priceOf(imwebBulk.priceIn(seen, ctx.input.optionId)); } catch { /* 위와 같음 */ }
        outcomes[i] = { success: true, data: failure && !seen
          ? { status: 'CHECK', message: `요청은 보냈지만 재조회에 실패했습니다(${failure.message}). 다시 보내기 전에 현재가를 확인하세요.` }
          : { status: 'CHECK', price: got, message: `요청은 보냈지만 조회된 판매가(${got || '없음'})가 입력값과 다릅니다. 반영이 늦을 수 있으니 잠시 뒤 현재가를 다시 불러오세요.` } };
      }
    }
    return outcomes;
  }
  // 조회 전용 채널. 저장은 bulk-save-batch 하나로만 한다(1건 저장 채널은 화면이 쓰지 않아 10-23 제거).
  for (const [channel, work] of [['bulk-price-list', list], ['bulk-price-load-many', loadMany],
    ['bulk-images-load', images.load], ['bulk-images-import', images.importImages]]) {
    ipcMain.handle(channel, async (_, input) => {
      while (writing === 'fx') await idle;
      if (writing) return { success: false, error: '가격 저장 중입니다. 완료 후 다시 시도하세요.', kind: 'BUSY', stage: 'pre-send' };
      try {
        let data = await work(input);
        if (channel === 'bulk-price-list') data = { ...data, items: await withIdentity(data.items) };
        else if (channel === 'bulk-price-load-many') for (const item of data.items) if (item.rows) item.rows = await withIdentity(item.rows);
        return { success: true, data };
      }
      catch (e) {
        // 화면에는 종류까지 넘기고, 원인 추적용으로 메인 로그에도 남긴다.
        const info = describeError(e);
        const target = [input?.scope, input?.id, input?.optionId].filter(Boolean).join('/');
        log.error?.(`[bulk-price] ${channel} ${target} → ${info.kind}${info.status ? ' ' + info.status : ''}: ${info.error}`);
        return { success: false, ...info };
      }
    });
  }
  const batch = createBulkBatch({ directory,
    validate: async (job, options) => {
      identity(job);
      if (job.type === 'price') priceContext(job);
      else { if (!job.expectedRevision) throw new Error('이미지를 먼저 불러오세요.'); await images.validate(job, options); }
    },
    save: (job, options) => job.type === 'images' ? images.save(job, options) : save(job),
    // eBay 는 한 요청에 25건을 보낸다. 네이버는 쓰기는 상품마다, 쓰기 뒤 확인을 10건씩 묶는다.
    // 아임웹은 같은 상품의 줄을 한 번 읽고 한 번 확인한다(saveImwebPrices) — 연속한 줄 IMWEB_SAVE_GROUP 개씩.
    groupSize: scope => scope === 'ebay' ? 25 : scope === 'naver' ? NAVER_VERIFY_GROUP : isImwebBulkScope(scope) ? IMWEB_SAVE_GROUP : 1,
    savePrices: (jobs, options) => jobs[0].scope === 'naver' ? saveNaverPrices(jobs, options)
      : isImwebBulkScope(jobs[0].scope) ? saveImwebPrices(jobs, options) : ebay().updatePricesBatch(jobs),
  });
  ipcMain.handle('bulk-save-batch', async (event, input) => {
    while (writing === 'fx') await idle;
    if (writing) return { success: false, error: '다른 저장 작업이 진행 중입니다.', stage: 'pre-send', kind: 'BUSY' };
    hold('ui');
    try {
      const data = await batch.run(input, payload => event?.sender?.send('bulk-save-progress', payload));
      return { success: true, data };
    } catch (e) { return { success: false, ...describeError(e, { sent: !!e?.sent }) }; }
    finally { free(); }
  });
  ipcMain.handle('bulk-save-cancel', (_, { jobId } = {}) => ({ success: true, data: batch.cancel(jobId) }));
  // 환율 자동 변경이 화면과 같은 조회·저장 경로를 쓰도록 넘긴다. 아임웹 미국·일본은 별도(imweb_unit_prices.js)로 한다.
  return { list, load, loadMany, save, exclusive };
}
