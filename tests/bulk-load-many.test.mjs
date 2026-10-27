// 현재가 묶음 조회 · 네이버 묶음 확인 (2026-10-01). 네트워크는 쓰지 않는다.
//
// 있었던 일
//   · '현재가 불러오기'가 상품마다 한 번씩 몰을 불렀다. 네이버는 상품 300개면 원상품 GET 300회(호출 간격 550ms),
//     아마존은 getListingItem 300회였다. 네이버 목록 조회는 원상품번호 100건, 아마존 searchListingsItems 는 SKU 20건을
//     한 요청에 받는다.
//   · 네이버 일괄 저장은 상품마다 GET + PUT + 확인 GET 이었다. 판매가를 정해서 바꾸는 다건 API 는 없어(bulk-update 는
//     n원·n% 증감만 — 공식 답변) 쓰기는 그대로 두고, 확인만 목록 조회 한 번으로 묶는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerBulkPriceIPC } from '../src/bulk_price_ipc.js';
import { createBulkBatch } from '../src/bulk_batch.js';
import { Amazon, US_MARKETPLACE_ID as US } from '../src/platforms/amazon.js';
import { NaverProducts } from '../src/platforms/naver_products.js';
import { apiError } from '../src/utils/api_error.js';

function ipcFixture(services) {
  const handlers = {}, logs = [];
  registerBulkPriceIPC({
    ipcMain: { handle: (channel, fn) => { handlers[channel] = fn; } },
    naverAPI: () => services.naverAPI, naverProducts: () => services.naverProducts,
    coupang: () => services.coupang, amazon: () => services.amazon, ebay: () => services.ebay,
    readCatalog: async () => ({}), log: { error: m => logs.push(m) }, sleep: async () => {},
  });
  return { invoke: (channel, input) => handlers[channel](null, input), logs };
}

// 검색 응답: 요청한 원상품번호 가운데 prices 에 있는 것만 돌려준다. listed 로 검색 쪽 가격을 따로 줄 수 있다.
function naverSearch(prices, { listed = no => prices[no], extra = [] } = {}) {
  const searches = [];
  const searchProducts = async payload => {
    searches.push(payload);
    return { contents: [...extra, ...payload.originProductNos.filter(no => prices[no] != null).map(no => ({
      originProductNo: no, channelProducts: [{ name: '상품 ' + no, salePrice: listed(no), representativeImage: { url: 'https://img.test/' + no + '.jpg' } }],
    }))] };
  };
  return { searches, searchProducts };
}

test('네이버 현재가: 목록 조회 한 번에 100건, 응답에 없는 번호만 1건 조회한다', async () => {
  const prices = Object.fromEntries(Array.from({ length: 150 }, (_, i) => [1000 + i, 10000 + i]));
  const ids = Object.keys(prices);
  delete prices[1005];   // 검색에 안 잡히는 번호(채널 상품번호를 넣은 경우 등)
  const { searches, searchProducts } = naverSearch(prices, {
    // 필터가 안 먹어 요청하지 않은 상품이 섞여 와도 그 가격을 쓰지 않는다.
    extra: [{ originProductNo: 9999, channelProducts: [{ salePrice: 1 }] }],
  });
  const singles = [];
  const naverProducts = { loadProductForEdit: async no => { singles.push(no); return { originNo: no, title: '1건', salePrice: 5000, detailImages: [] }; } };
  const { invoke } = ipcFixture({ naverAPI: { searchProducts }, naverProducts });
  const res = await invoke('bulk-price-load-many', { scope: 'naver', ids, includeImages: true });
  assert.equal(res.success, true);
  assert.deepEqual(searches.map(s => [s.searchKeywordType, s.originProductNos.length, s.size]), [['PRODUCT_NO', 100, 100], ['PRODUCT_NO', 50, 100]]);
  assert.deepEqual(singles, ['1005']);
  assert.equal(res.data.items.length, 150);
  const byId = new Map(res.data.items.map(item => [item.id, item.rows]));
  assert.deepEqual([byId.get('1000')[0].price, byId.get('1000')[0].ready, byId.get('1000')[0].name], ['10000', true, '상품 1000']);
  assert.equal(byId.get('1005')[0].price, '5000');
  assert.equal(byId.get('1000')[0].imagesReady, undefined, '검색 결과에는 상세 이미지가 없다 — 이미지 적용 때 조회');
  assert.ok(!byId.has('9999'));
});

test('네이버 현재가: 묶음 조회가 인증·한도 오류면 1건 조회로 계속 두드리지 않고 멈춘다', async () => {
  const singles = [];
  const { invoke } = ipcFixture({
    naverAPI: { searchProducts: async () => { throw apiError('네이버 API 오류 (429)', { status: 429 }); } },
    naverProducts: { loadProductForEdit: async no => { singles.push(no); return {}; } },
  });
  const res = await invoke('bulk-price-load-many', { scope: 'naver', ids: ['1', '2', '3'] });
  assert.equal(res.success, true);
  assert.match(res.data.blocked, /429/);
  assert.deepEqual(singles, []);
});

test('네이버 현재가: 검색 조건을 400 으로 거부하면 1건 조회로 이어 가고, 다음부터는 묶음 조회를 보내지 않는다', async () => {
  const singles = [];
  let searches = 0;
  const { invoke, logs } = ipcFixture({
    naverAPI: { searchProducts: async () => { searches++; throw apiError('잘못된 요청', { status: 400 }); } },
    naverProducts: { loadProductForEdit: async no => { singles.push(no); return { originNo: no, title: 't', salePrice: 7000, detailImages: [] }; } },
  });
  const res = await invoke('bulk-price-load-many', { scope: 'naver', ids: ['1', '2'] });
  assert.deepEqual(singles, ['1', '2']);
  assert.deepEqual(res.data.items.map(item => item.rows[0].price), ['7000', '7000']);
  assert.match(logs.join('\n'), /1건 조회로 진행/);
  await invoke('bulk-price-load-many', { scope: 'naver', ids: ['3'] });
  assert.equal(searches, 1);
  assert.deepEqual(singles, ['1', '2', '3']);
});

function fakeAmazon({ missing = [] } = {}) {
  const amazon = new Amazon('unused');
  amazon.config = { marketplaceId: US }; amazon.api = {}; amazon.loadConfig = () => {};
  const searches = [], gets = [];
  const listing = (sku, price) => ({ sku, summaries: [{ marketplaceId: US, itemName: 'item ' + sku }],
    attributes: { purchasable_offer: [{ marketplace_id: US, our_price: [{ schedule: [{ value_with_tax: price }] }] }] } });
  amazon.apiForMarketplace = () => ({
    searchListingsItems: async ({ identifiers, identifiersType }) => {
      searches.push([identifiers.length, identifiersType]);
      return { items: identifiers.filter(sku => !missing.includes(sku)).map(sku => listing(sku, 50)) };
    },
    getListingItem: async sku => { gets.push(sku); return listing(sku, 40); },
  });
  return { amazon, searches, gets };
}

test('아마존 현재가: SKU 20건씩 searchListingsItems 로 받고, 빠진 SKU 만 getListingItem 으로 읽는다', async () => {
  const { amazon, searches, gets } = fakeAmazon({ missing: ['SKU-7'] });
  const { invoke } = ipcFixture({ amazon });
  const ids = Array.from({ length: 45 }, (_, i) => 'SKU-' + i);
  const res = await invoke('bulk-price-load-many', { scope: 'amazon-us', ids, includeImages: true });
  assert.equal(res.success, true);
  assert.deepEqual(searches, [[20, 'SKU'], [20, 'SKU'], [5, 'SKU']]);
  assert.deepEqual(gets, ['SKU-7']);
  const byId = new Map(res.data.items.map(item => [item.id, item.rows[0]]));
  assert.deepEqual([byId.get('SKU-0').price, byId.get('SKU-7').price], ['50', '40']);
  assert.equal(byId.get('SKU-0').imagesReady, true, '아마존 묶음 응답에는 이미지 속성이 있어 같이 채운다');
});

test('묶음 조회가 없는 몰(쿠팡)은 상품마다 기존 조회 경로를 쓴다', async () => {
  const loads = [];
  const coupang = { loadConfig() {}, api: { getItemInventory: async () => ({ salePrice: 10000 }) },
    loadProductForEdit: async id => { loads.push(id); return { title: 't', statusName: '승인완료', options: [{ vendorItemId: 1, itemName: 'A' }] }; } };
  const { invoke } = ipcFixture({ coupang });
  const res = await invoke('bulk-price-load-many', { scope: 'coupang', ids: ['10', '11'] });
  assert.deepEqual(loads, ['10', '11']);
  assert.deepEqual(res.data.items.map(item => item.rows[0].price), ['10000', '10000']);
});

test('묶음 조회 입력: 1~200개만 받는다', async () => {
  const { invoke } = ipcFixture({});
  assert.equal((await invoke('bulk-price-load-many', { scope: 'naver', ids: [] })).success, false);
  assert.equal((await invoke('bulk-price-load-many', { scope: 'naver', ids: Array.from({ length: 201 }, (_, i) => String(i)) })).success, false);
});

// ── 네이버 일괄 저장: 쓰기는 상품마다, 확인은 10건마다 목록 조회 한 번 ─────────────

function naverStore(count, { lagging = [] } = {}) {
  const price = Object.fromEntries(Array.from({ length: count }, (_, i) => [String(i + 1), 10000]));
  const calls = [];
  const { searchProducts } = naverSearch(price, { listed: no => lagging.includes(no) ? 10000 : price[no] });
  const api = {
    originProduct: async no => { calls.push('GET'); return { originProduct: { name: 'P', salePrice: price[no], detailContent: '' } }; },
    request: async (method, route, body) => { calls.push(method); price[route.split('/').pop()] = body.originProduct.salePrice; return {}; },
    searchProducts: async payload => { calls.push('SEARCH'); return searchProducts(payload); },
    invalidateProducts() {},
  };
  return { api, calls, price };
}
const priceJobs = (count, scope = 'naver') => ({ jobId: 'naver-batch-' + count, scope,
  jobs: Array.from({ length: count }, (_, i) => ({ type: 'price', id: String(i + 1), newPrice: '12000', expectedPrice: '10000' })) });

test('네이버 일괄 저장 12건: GET+PUT 은 상품마다, 확인은 목록 조회 2회 — 검색 반영이 늦은 상품만 1건 조회', async () => {
  const { api, calls } = naverStore(12, { lagging: [3] });
  const { invoke } = ipcFixture({ naverAPI: api, naverProducts: new NaverProducts(api) });
  const res = await invoke('bulk-save-batch', priceJobs(12));
  assert.equal(res.success, true, res.error);
  assert.deepEqual(res.data.results.map(r => r.data?.status), Array(12).fill('VERIFIED'));
  const count = kind => calls.filter(c => c === kind).length;
  assert.deepEqual([count('GET'), count('PUT'), count('SEARCH')], [13, 12, 2], '예전에는 GET 24회 + PUT 12회');
  // 첫 묶음 10건을 다 보낸 뒤 확인한다.
  assert.deepEqual(calls.slice(0, 21), [...Array(10).fill(['GET', 'PUT']).flat(), 'SEARCH']);
});

test('네이버 일괄 저장: 결과를 모르는 쓰기가 나오면 같은 묶음의 남은 상품은 보내지 않는다', async () => {
  const { api, calls } = naverStore(5);
  const put = api.request;
  api.request = async (method, route, body) => {
    if (route.endsWith('/2')) { calls.push(method); throw apiError('네이버 응답을 확인하지 못했습니다 (시간 초과)', { timeout: true }); }
    return put(method, route, body);
  };
  const { invoke } = ipcFixture({ naverAPI: api, naverProducts: new NaverProducts(api) });
  const res = await invoke('bulk-save-batch', priceJobs(5));
  const results = res.data.results;
  assert.deepEqual(results.map(r => r.data?.status || r.stage), ['VERIFIED', 'unknown', 'pre-send', 'pre-send', 'pre-send']);
  assert.ok(res.data.stopped);
  assert.equal(calls.filter(c => c === 'PUT').length, 2, '1번 보내고 2번에서 멈춤');
});

test('일괄 저장 묶음: groupSize 만큼 savePrices 로 넘기고, 묶음 안에서도 중단 여부를 알려 준다', async () => {
  const groups = [];
  let batch;
  batch = createBulkBatch({ validate() {}, save: () => assert.fail('묶음 경로를 써야 한다'), groupSize: scope => scope === 'naver' ? 10 : 1,
    savePrices: async (jobs, { cancelled }) => {
      groups.push(jobs.length);
      return jobs.map(() => ({ success: true, data: { status: 'VERIFIED' } }));
    } });
  await batch.run(priceJobs(23));
  assert.deepEqual(groups, [10, 10, 3]);

  const seen = [];
  batch = createBulkBatch({ validate() {}, save: () => assert.fail(), groupSize: () => 10,
    savePrices: async (jobs, { cancelled }) => {
      seen.push(cancelled());
      batch.cancel('naver-batch-23');
      seen.push(cancelled());
      return jobs.map(() => ({ success: true, data: { status: 'VERIFIED' } }));
    } });
  const out = await batch.run(priceJobs(23));
  assert.deepEqual(seen, [false, true]);
  assert.equal(out.cancelled, true);
  assert.equal(out.results.length, 10, '중단하면 다음 묶음을 보내지 않는다');
});
