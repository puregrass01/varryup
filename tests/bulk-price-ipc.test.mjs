// 상품 일괄 수정(판매가) — 오류 분류와 플랫폼별 가격 쓰기 경로. 네트워크는 쓰지 않는다.
//
// 있었던 일 (2026-09-30 리뷰)
//   · 쿠팡: 판매가를 '상품 수정(승인필요)' 전체 PUT + requested:true 로 보냈다. 승인완료 상품은
//     이 API 로 판매가가 바뀌지 않고(공식 문서) 저장할 때마다 승인 요청이 다시 나갔다.
//   · IPC 가 e.message 만 넘겨 직원 토큰 만료·서버 재시작·429 가 전부 플랫폼 오류처럼 보였고,
//     '보내기 전에 멈춤'과 '보냈는데 결과 모름'을 구분할 수 없었다.
//   · 네이버: 상품 조회 GET 은 429 재시도 대상이 아니었고, 한 행 저장에 GET 4회 + PUT 1회가 나갔다.
//   · eBay: load() 가 모든 API 오류를 삼켜 토큰 만료도 '연결 필요'로 보였고, 가격만 바꿔도 수량을 다시 썼다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apiError, markPreSend, errorKind, errorStage, describeError } from '../src/utils/api_error.js';
import { registerBulkPriceIPC } from '../src/bulk_price_ipc.js';
import { Coupang, findProductIdsFromSheet } from '../src/platforms/coupang.js';
import { Amazon, JP_MARKETPLACE_ID, US_MARKETPLACE_ID } from '../src/platforms/amazon.js';
import { NaverAPI } from '../src/platforms/naver_api.js';
import { NaverProducts } from '../src/platforms/naver_products.js';
import { AmazonAPI } from '../src/platforms/amazon_api.js';
import { EbayAPIError } from '../src/platforms/ebay_api.js';
import { EbayStore } from '../src/platforms/ebay_store.js';
import { Ebay } from '../src/platforms/ebay.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

function tmpDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ── 오류 분류 ────────────────────────────────────────────────────────────

test('오류 종류: 프록시 401 은 직원 재로그인, 429 는 호출 한도, 타임아웃·네트워크는 응답 없음', () => {
  assert.equal(errorKind(apiError('x', { status: 401, proxyError: true })), 'STAFF_AUTH');
  assert.equal(errorKind(apiError('x', { status: 502, proxyError: true })), 'PROXY');
  assert.equal(errorKind(apiError('x', { status: 429 })), 'RATE_LIMIT');
  assert.equal(errorKind(apiError('x', { status: 400, authFailure: true })), 'AUTH');
  assert.equal(errorKind(apiError('x', { status: 200, rejected: true })), 'REJECTED');
  assert.equal(errorKind(Object.assign(new Error('t'), { name: 'TimeoutError' })), 'TIMEOUT');
  assert.equal(errorKind(new Error('outer', { cause: new TypeError('fetch failed') })), 'NETWORK');
  // 감싼 오류도 원인 쪽 status 로 분류한다(아마존 '상품 수정 실패: …' 처럼).
  assert.equal(errorKind(new Error('아마존 상품 수정 실패', { cause: apiError('q', { status: 429 }) })), 'RATE_LIMIT');
  assert.equal(errorKind(new Error('설정 없음')), 'ERROR');
});

test('반영 여부: 보내기 전이면 pre-send, 거부면 rejected, 응답을 못 받으면 unknown', () => {
  const timeout = apiError('t', { timeout: true });
  assert.equal(errorStage(timeout, false), 'pre-send');
  assert.equal(errorStage(timeout, true), 'unknown');
  assert.equal(errorStage(markPreSend(apiError('t', { timeout: true })), true), 'pre-send');
  assert.equal(errorStage(apiError('r', { status: 400 }), true), 'rejected');
  assert.equal(errorStage(apiError('r', { status: 429 }), true), 'rejected');
  assert.equal(errorStage(apiError('p', { status: 401, proxyError: true }), true), 'rejected');
  assert.equal(errorStage(apiError('p', { status: 404, proxyError: true }), true), 'rejected');
  assert.equal(errorStage(apiError('p', { status: 504, proxyError: true }), true), 'unknown');
  assert.equal(errorStage(apiError('s', { status: 503 }), true), 'unknown');
  const info = describeError(apiError('p', { status: 401, proxyError: true }), { sent: false });
  assert.deepEqual([info.kind, info.stage, info.blocking, info.proxyError], ['STAFF_AUTH', 'pre-send', true, true]);
});

// ── IPC 오케스트레이션 (가짜 서비스) ─────────────────────────────────────

function ipcFixture(services) {
  const handlers = {};
  const logs = [];
  registerBulkPriceIPC({
    ipcMain: { handle: (channel, fn) => { handlers[channel] = fn; } },
    naverAPI: () => services.naverAPI, naverProducts: () => services.naverProducts,
    coupang: () => services.coupang, amazon: () => services.amazon, ebay: () => services.ebay,
    imweb: async () => services.imweb, board: async () => services.board, rates: async () => ({ data: {} }),
    log: { error: m => logs.push(m) }, sleep: async () => {},
  });
  const invoke = (channel, input) => handlers[channel](null, input);
  return { invoke, logs };
}

function fakeCoupang({ inventory = { 555: 10000 }, change } = {}) {
  const calls = [];
  const service = {
    loadConfig() {},
    api: { getItemInventory: async id => { calls.push(['inventory', id]); return { salePrice: inventory[id] }; } },
    async loadProductForEdit(id) {
      calls.push(['product', id]);
      return { productId: id, title: '옵틱글래스 미러', statusName: '승인완료', options: [
        { index: 0, sellerProductItemId: 1, vendorItemId: 555, itemName: '아반떼', salePrice: 9000, imageUrl: '' },
        { index: 1, sellerProductItemId: 2, vendorItemId: null, itemName: '소나타', salePrice: 9000, imageUrl: '' },
      ] };
    },
    async changeItemPrice(args) {
      calls.push(['change', args]);
      if (change) return change(args);
      inventory[args.vendorItemId] = Number(args.salePrice);
      return { unchanged: false, salePrice: Number(args.salePrice) };
    },
  };
  return { service, calls, inventory };
}

test('쿠팡 현재가: 옵션ID 별 가격 API 값을 쓰고, 옵션ID 가 없는 옵션은 읽기 전용으로 표시한다', async () => {
  const { service } = fakeCoupang();
  const { invoke } = ipcFixture({ coupang: service });
  const res = await invoke('bulk-price-load', { scope: 'coupang', id: '777' });
  assert.equal(res.success, true);
  const [a, b] = res.data;
  assert.deepEqual([a.optionId, a.price, a.ready, !!a.readonly], ['555', '10000', true, false], '판매가는 seller-products(9000)가 아니라 inventories(10000)');
  assert.deepEqual([b.ready, b.readonly], [false, true]);
  assert.match(b.result, /승인완료 전/);
});

test('아마존 목록: API 페이징이 1000건에서 잘리면 안내와 truncated 를 함께 돌려준다', async () => {
  const amazon = { loadConfig() {}, async searchProducts(query, stats) {
    Object.assign(stats, { source: 'api', scanned: 1000, total: 1386, truncated: true });
    return [{ id: 'S1', name: 'Mirror', price: '10' }];
  } };
  const { invoke } = ipcFixture({ amazon });
  const res = await invoke('bulk-price-list', { scope: 'amazon-us' });
  assert.equal(res.success, true);
  assert.equal(res.data.truncated, true);
  assert.match(res.data.note, /1000\/1386건에서 잘렸습니다/);
});

test('쿠팡 저장: 아이템별 가격 변경 경로로 보내고 가격 API 로 다시 읽어 확인한다', async () => {
  const { service, calls } = fakeCoupang();
  const { invoke } = ipcFixture({ coupang: service });
  const res = await invoke('bulk-price-save', { scope: 'coupang', id: '777', optionId: '555', newPrice: '12000', expectedPrice: '10000' });
  assert.deepEqual(res, { success: true, data: { status: 'VERIFIED', price: '12000' } });
  assert.deepEqual(calls.map(c => c[0]), ['change', 'inventory'], '저장 전 전체 상품 조회(load)를 다시 하지 않는다');
  assert.deepEqual(calls[0][1], { vendorItemId: '555', salePrice: '12000', expectedPrice: '10000' });
});

test('쿠팡 저장: 10원 단위가 아니면 보내지 않는다', async () => {
  const { service, calls } = fakeCoupang();
  const { invoke } = ipcFixture({ coupang: service });
  const res = await invoke('bulk-price-save', { scope: 'coupang', id: '777', optionId: '555', newPrice: '12345', expectedPrice: '10000' });
  assert.equal(res.success, false);
  assert.equal(res.stage, 'pre-send');
  assert.match(res.error, /10원 단위/);
  assert.equal(calls.length, 0);
});

test('저장 오류는 종류와 반영 여부를 함께 넘기고 메인 로그에 남긴다', async () => {
  const cases = [
    [() => { throw markPreSend(new Error('쿠팡 현재 판매가가 조회 이후 변경됐습니다.')); }, { stage: 'pre-send', kind: 'ERROR', blocking: false }],
    [() => { throw apiError('쿠팡 응답 시간 초과', { timeout: true }); }, { stage: 'unknown', kind: 'TIMEOUT', blocking: false }],
    [() => { throw apiError('서버 프록시 오류 (HTTP 401): 인증 필요', { status: 401, proxyError: true }); }, { stage: 'rejected', kind: 'STAFF_AUTH', blocking: true }],
    [() => { throw apiError('쿠팡이 요청을 거부했습니다 (code=ERROR)', { status: 200, rejected: true }); }, { stage: 'rejected', kind: 'REJECTED', blocking: false }],
    [() => { throw apiError('쿠팡 API 오류 (429)', { status: 429 }); }, { stage: 'rejected', kind: 'RATE_LIMIT', blocking: true }],
  ];
  for (const [change, expected] of cases) {
    const { service } = fakeCoupang({ change });
    const { invoke, logs } = ipcFixture({ coupang: service });
    const res = await invoke('bulk-price-save', { scope: 'coupang', id: '777', optionId: '555', newPrice: '12000', expectedPrice: '10000' });
    assert.equal(res.success, false);
    assert.deepEqual({ stage: res.stage, kind: res.kind, blocking: res.blocking }, expected, res.error);
    assert.match(logs[0], /\[bulk-price\] bulk-price-save coupang\/777\/555 →/);
  }
});

test('조회 오류에는 반영 여부(stage)를 붙이지 않는다', async () => {
  const service = { loadConfig() {}, loadProductForEdit: async () => { throw apiError('서버 프록시 오류 (HTTP 401)', { status: 401, proxyError: true }); } };
  const { invoke } = ipcFixture({ coupang: service });
  const res = await invoke('bulk-price-load', { scope: 'coupang', id: '777' });
  assert.deepEqual([res.success, res.kind, res.blocking, res.stage], [false, 'STAFF_AUTH', true, undefined]);
});

test('쓰기 뒤 조회 가격이 다르면 한 번 더 읽고, 그래도 다르면 CHECK 로 알린다', async () => {
  const { service, calls } = fakeCoupang({ change: () => ({ unchanged: false, salePrice: 12000 }) });
  const { invoke } = ipcFixture({ coupang: service });
  const res = await invoke('bulk-price-save', { scope: 'coupang', id: '777', optionId: '555', newPrice: '12000', expectedPrice: '10000' });
  assert.equal(res.data.status, 'CHECK');
  assert.match(res.data.message, /10000/);
  assert.equal(calls.filter(c => c[0] === 'inventory').length, 2);
});

test('이미 같은 가격이면 UNCHANGED 이고 확인 조회를 하지 않는다', async () => {
  const { service, calls } = fakeCoupang({ change: () => ({ unchanged: true, salePrice: 12000 }) });
  const { invoke } = ipcFixture({ coupang: service });
  const res = await invoke('bulk-price-save', { scope: 'coupang', id: '777', optionId: '555', newPrice: '12000', expectedPrice: '10000' });
  assert.deepEqual(res.data, { status: 'UNCHANGED', price: '12000' });
  assert.equal(calls.filter(c => c[0] === 'inventory').length, 0);
});

// ── 쿠팡 실제 클래스 (fetch 모의) ────────────────────────────────────────

function coupangSetup(t, handler, extra = {}) {
  const file = path.join(tmpDir(t, 'bulk-coupang-'), 'coupang_config.json');
  fs.writeFileSync(file, JSON.stringify({ vendorId: 'A00099999', accessKey: 'ak', secretKey: 'sk', ...extra }));
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const call = { url: String(url), method: options.method || 'GET', body: options.body ?? null };
    calls.push(call);
    return handler(call);
  });
  const coupang = new Coupang(file);
  coupang.loadConfig();
  return { coupang, calls };
}

test('쿠팡 가격 변경: PUT vendor-items/{id}/prices/{price} 만 보내고 상품 수정(PUT seller-products)은 쓰지 않는다', async t => {
  const { coupang, calls } = coupangSetup(t, call => (call.method === 'GET'
    ? json({ code: 'SUCCESS', data: { sellerItemId: 1, salePrice: 10000, amountInStock: 3, onSale: true } })
    : json({ code: 'SUCCESS', message: '가격 변경을 완료했습니다.', data: null })));
  const result = await coupang.changeItemPrice({ vendorItemId: '555', salePrice: '12000', expectedPrice: '10000' });
  assert.deepEqual(result, { unchanged: false, salePrice: 12000 });
  assert.equal(calls.length, 2);
  assert.ok(calls[0].url.endsWith('/vendor-items/555/inventories'), calls[0].url);
  assert.equal(calls[1].method, 'PUT');
  assert.ok(calls[1].url.endsWith('/vendor-items/555/prices/12000'), calls[1].url);
  assert.equal(calls[1].body, null, '가격 변경은 본문 없이 경로로만 보낸다');
  assert.ok(!calls.some(c => c.url.includes('/seller-products')), '판매가 변경에 상품 수정 API 를 쓰면 승인 요청이 다시 나간다');
});

test('쿠팡 가격 변경: 조회 이후 바뀌었거나 변경폭(50% 인하·100% 인상)을 넘으면 보내기 전에 멈춘다', async t => {
  const { coupang, calls } = coupangSetup(t, () => json({ code: 'SUCCESS', data: { salePrice: 10000 } }));
  await assert.rejects(coupang.changeItemPrice({ vendorItemId: '555', salePrice: '12000', expectedPrice: '9000' }), e => {
    assert.equal(e.stage, 'pre-send'); assert.match(e.message, /조회 이후 변경/); return true;
  });
  await assert.rejects(coupang.changeItemPrice({ vendorItemId: '555', salePrice: '20010', expectedPrice: '10000' }), e => {
    assert.equal(e.stage, 'pre-send'); assert.match(e.message, /50% 인하·100% 인상/); return true;
  });
  await assert.rejects(coupang.changeItemPrice({ vendorItemId: '555', salePrice: '4990', expectedPrice: '10000' }), /50% 인하/);
  assert.ok(!calls.some(c => c.method === 'PUT'));
});

test('쿠팡 API: 프록시 자체 오류와 HTTP 200 + code:ERROR 를 구분해 표시한다', async t => {
  let body, status;
  const { coupang } = coupangSetup(t, () => json(body, status), { proxyUrl: 'https://admin.example.test', proxyToken: 'STAFF' });
  body = { proxyError: true, message: '인증 필요(토큰 없음/만료)' }; status = 401;
  await assert.rejects(coupang.api.getItemInventory('555'), e => {
    assert.equal(e.proxyError, true); assert.match(e.message, /서버 프록시 오류/); assert.equal(errorKind(e), 'STAFF_AUTH');
    assert.doesNotMatch(e.message, /\((?:400|404)\)/, "duplicate_guard 가 '(404)' 모양을 '상품 없음'으로 읽는다");
    return true;
  });
  body = { detail: 'Not Found' }; status = 404;
  await assert.rejects(coupang.api.getItemInventory('555'), /\/coupang 프록시 경로가 없습니다/);
  body = { code: 'ERROR', message: '가격변경에 실패했습니다.' }; status = 200;
  await assert.rejects(coupang.api.updateItemPrice('555', 12000), e => { assert.equal(errorKind(e), 'REJECTED'); return true; });
});

test('쿠팡 API: 프록시 앞단의 JSON 아닌 502 는 관리자 서버 문제로 알린다', async t => {
  const { coupang } = coupangSetup(t, () => new Response('<html>502 Bad Gateway</html>', { status: 502 }),
    { proxyUrl: 'https://admin.example.test', proxyToken: 'STAFF' });
  await assert.rejects(coupang.api.getItemInventory('555'), e => {
    assert.match(e.message, /관리자 서버가 응답하지 않습니다/); assert.equal(e.proxyError, true); return true;
  });
});

// ── 쿠팡 단건 상품 수정(updateExistingProduct)의 판매가 ─────────────────────

async function withFakeTimers(t, fn) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let settled = false;
    const p = Promise.resolve().then(fn).finally(() => { settled = true; });
    p.catch(() => {});
    while (!settled) { await new Promise(r => setImmediate(r)); t.mock.timers.tick(60_000); }
    return await p;
  } finally { t.mock.timers.reset(); }
}

const cpItem = (id, name, vendorItemId, salePrice = 10000) => ({
  sellerProductItemId: id, vendorItemId, itemName: name, salePrice, originalPrice: salePrice, maximumBuyCount: 5,
  attributes: [{ attributeTypeName: '차종', attributeValueName: name, exposed: 'EXPOSED' }], images: [], contents: [],
});
const cpOpt = (id, name, salePrice) => ({ sellerProductItemId: id, isNew: false, attrs: [{ index: 0, typeName: '차종', value: name }], salePrice });

// 상품 조회·옵션별 가격 조회·가격 변경·상품 수정을 흉내 낸다. 가격 변경은 옵션 가격 조회에 바로 반영된다.
function coupangProduct(t, items) {
  const prices = Object.fromEntries(items.filter(i => i.vendorItemId).map(i => [String(i.vendorItemId), i.salePrice]));
  const stocks = {};
  let saved = null;
  const setup = coupangSetup(t, call => {
    const m = call.url.match(/vendor-items\/(\d+)\/(?:inventories|prices\/(\d+)|quantities\/(\d+))/);
    if (m && call.method === 'GET') return json({ code: 'SUCCESS', data: { salePrice: prices[m[1]], amountInStock: stocks[m[1]] ?? 5, onSale: true } });
    if (m && call.method === 'PUT' && m[3] != null) { stocks[m[1]] = Number(m[3]); return json({ code: 'SUCCESS', message: '수량 변경을 완료했습니다.', data: null }); }
    if (m && call.method === 'PUT') { prices[m[1]] = Number(m[2]); return json({ code: 'SUCCESS', message: '가격 변경을 완료했습니다.', data: null }); }
    if (call.method === 'PUT') { saved = JSON.parse(call.body); return json({ code: 'SUCCESS', data: 777 }); }
    return json({ code: 'SUCCESS', data: saved || { sellerProductId: 777, sellerProductName: 'P', statusName: '승인완료', items } });
  });
  const label = c => `${c.method} ${c.url.replace(/^.*\/marketplace/, '')}`;
  return { ...setup, prices, stocks, label };
}

test('쿠팡 상품 수정: 승인완료 옵션의 재고만 바꾸면 수량 변경 API 만 쓰고, 안 바꾼 옵션과 상품 수정 PUT(재승인)은 보내지 않는다', async t => {
  const { coupang, calls, stocks, label } = coupangProduct(t, [cpItem(11, 'A', 5011), cpItem(22, 'B', 5022)]);
  const result = await coupang.updateExistingProduct({ productId: 777,
    options: [{ ...cpOpt(11, 'A', 10000), stock: '7' }, { ...cpOpt(22, 'B', 10000), stock: '5' }] });
  assert.equal(result.priceOnly, true);
  assert.match(result.verified, /재고 1개 옵션 변경 확인/);
  assert.deepEqual(calls.filter(c => c.method === 'PUT').map(label), ['PUT /vendor-items/5011/quantities/7']);
  assert.equal(stocks['5022'], undefined, '화면 값(5) 그대로인 옵션은 보내지 않는다 — 그 사이 팔린 수량이 되살아나지 않게');
});

test('쿠팡 상품 수정: 승인완료 옵션의 판매가만 바꾸면 가격 변경 API 만 쓰고 상품 수정 PUT(재승인)은 보내지 않는다', async t => {
  const { coupang, calls, prices, label } = coupangProduct(t, [cpItem(11, 'A', 5011), cpItem(22, 'B', 5022)]);
  const result = await coupang.updateExistingProduct({ productId: 777, options: [cpOpt(11, 'A', 12000), cpOpt(22, 'B', 10000)] });
  assert.equal(result.priceOnly, true);
  assert.match(result.verified, /1개 옵션 변경 확인/);
  assert.deepEqual(calls.map(label), [
    'GET /seller-products/777', 'GET /vendor-items/5011/inventories', 'PUT /vendor-items/5011/prices/12000', 'GET /vendor-items/5011/inventories']);
  assert.equal(prices['5011'], 12000);
  assert.equal(prices['5022'], 10000, '가격을 안 바꾼 옵션에는 보내지 않는다');
});

test('쿠팡 상품 수정: 상품명도 바꾸면 가격 변경 API 를 먼저 보내고, 상품 수정 본문에도 새 가격을 넣는다', async t => {
  const { coupang, calls, label } = coupangProduct(t, [cpItem(11, 'A', 5011), cpItem(22, 'B', 5022)]);
  await withFakeTimers(t, () => coupang.updateExistingProduct({ productId: 777, title: '새 이름', options: [cpOpt(11, 'A', 12000), cpOpt(22, 'B', 10000)] }));
  const order = calls.filter(c => c.method === 'PUT').map(label);
  assert.deepEqual(order, ['PUT /vendor-items/5011/prices/12000', 'PUT /seller-products']);
  const body = JSON.parse(calls.find(c => c.url.endsWith('/seller-products') && c.method === 'PUT').body);
  assert.equal(body.sellerProductName, '새 이름');
  assert.deepEqual(body.items.map(i => [i.salePrice, i.originalPrice]), [[12000, 10000], [10000, 10000]],
    '본문 가격이 옛 값이면 쿠팡이 방금 바꾼 가격을 되돌릴 수 있다. 정가(originalPrice)는 건드리지 않는다');
});

test('쿠팡 상품 수정: 판매가가 10원 단위가 아니거나 변경폭(50% 인하·100% 인상)을 넘으면 아무것도 보내지 않는다', async t => {
  const { coupang, calls } = coupangProduct(t, [cpItem(11, 'A', 5011), cpItem(22, 'B', 5022)]);
  await assert.rejects(coupang.updateExistingProduct({ productId: 777, title: '새 이름', options: [cpOpt(11, 'A', 12345), cpOpt(22, 'B', 10000)] }),
    /10원 단위.*아무것도 저장하지 않았습니다/);
  await assert.rejects(coupang.updateExistingProduct({ productId: 777, options: [cpOpt(11, 'A', 12000), cpOpt(22, 'B', 20010)] }),
    /"B" 판매가는 한 번에 기존가\(10,000원\)의 50% 인하·100% 인상까지만.*아무것도 저장하지 않았습니다/);
  assert.ok(!calls.some(c => c.method === 'PUT'), '검사에 걸리면 앞 옵션의 가격도 바꾸지 않는다');
});

test('쿠팡 상품 수정: 승인 전 옵션(vendorItemId 없음)은 예전처럼 상품 수정 본문의 판매가로 바꾼다', async t => {
  const { coupang, calls } = coupangProduct(t, [cpItem(11, 'A', null)]);
  await withFakeTimers(t, () => coupang.updateExistingProduct({ productId: 777, options: [cpOpt(11, 'A', 12000)] }));
  assert.ok(!calls.some(c => c.url.includes('/vendor-items/')), '옵션ID 가 없으면 가격 API 를 부를 수 없다');
  const body = JSON.parse(calls.find(c => c.method === 'PUT').body);
  assert.deepEqual([body.items[0].salePrice, body.items[0].originalPrice, body.requested], [12000, 12000, true]);
});

// ── 네이버 ──────────────────────────────────────────────────────────────

const naverJson = (status, body) => ({ status, text: async () => (body === undefined ? '' : JSON.stringify(body)) });
function naverFetch(handlers) {
  const calls = [];
  const impl = async (url, options) => { calls.push({ url, options }); const next = handlers.shift(); if (!next) throw new Error('추가 요청: ' + url); return next; };
  impl.calls = calls;
  return impl;
}
const naverConfig = { clientId: 'CID', clientSecret: '$2a$04$uSbYAXyKyJjPVDzRl.Ie', type: 'SELF' };
const bcryptStub = { hashSync: (v, s) => `hashed(${v}|${s})` };

test('네이버: 상품 조회 GET 도 429 를 기다렸다 다시 보낸다', async () => {
  const fetchImpl = naverFetch([naverJson(200, { access_token: 'AT', expires_in: 10800 }),
    naverJson(429, { code: 'GW.RATE_LIMIT', message: '요청이 많아' }), naverJson(200, { originProduct: { salePrice: 1000 } })]);
  const waits = [];
  const api = new NaverAPI(naverConfig, { fetchImpl, bcrypt: bcryptStub, sleep: async ms => { waits.push(ms); } });
  assert.deepEqual(await api.originProduct(5), { originProduct: { salePrice: 1000 } });
  assert.equal(fetchImpl.calls.length, 3);
  assert.ok(waits[0] >= 1500, '공식 권장(1~2초)보다 짧게 쉬지 않는다');
});

test('네이버: 토큰 발급이 502(빈 본문)면 키 문제로 안내하지 않는다', async () => {
  const api = new NaverAPI(naverConfig, { fetchImpl: naverFetch([naverJson(502)]), bcrypt: bcryptStub });
  await assert.rejects(api.token(), e => {
    assert.doesNotMatch(e.message, /키와 전자서명/); assert.equal(errorKind(e), 'SERVER'); return true;
  });
  const bad = new NaverAPI(naverConfig, { fetchImpl: naverFetch([naverJson(400, { code: 'BadRequest', message: 'invalid' })]), bcrypt: bcryptStub });
  await assert.rejects(bad.token(), e => { assert.match(e.message, /키와 전자서명/); assert.equal(errorKind(e), 'AUTH'); return true; });
});

test('네이버 판매가 변경: GET 1회 + PUT 1회, 재고·상세이미지 엄격 검증 없이 판매가만 바꾼다', async () => {
  const origin = { originProduct: { name: 'P', salePrice: 10000, stockQuantity: 5, detailContent: '<p>x</p>' } };
  const calls = [];
  const api = {
    originProduct: async no => { calls.push(['GET', no]); return structuredClone(origin); },
    request: async (method, p, body) => { calls.push([method, p, body]); return {}; },
    invalidateProducts() {},
  };
  const products = new NaverProducts(api);
  assert.deepEqual(await products.updateSalePrice({ originNo: '123', salePrice: '12000', expectedPrice: '10000' }),
    { originNo: '123', unchanged: false, salePrice: 12000 });
  assert.deepEqual(calls.map(c => c[0]), ['GET', 'PUT']);
  assert.equal(calls[1][2].originProduct.salePrice, 12000);
  assert.equal(calls[1][2].originProduct.stockQuantity, 5);

  calls.length = 0;
  await assert.rejects(products.updateSalePrice({ originNo: '123', salePrice: '12000', expectedPrice: '9000' }), e => {
    assert.equal(e.stage, 'pre-send'); return true;
  });
  assert.deepEqual(calls.map(c => c[0]), ['GET'], '기대가가 다르면 PUT 을 보내지 않는다');
  assert.equal((await products.updateSalePrice({ originNo: '123', salePrice: '10000', expectedPrice: '10000' })).unchanged, true);
});

test('네이버 일괄 저장: 행당 GET 2회 + PUT 1회', async () => {
  let salePrice = 10000;
  const calls = [];
  const api = {
    originProduct: async no => { calls.push('GET'); return { originProduct: { name: 'P', salePrice, detailContent: '' } }; },
    request: async (method, p, body) => { calls.push(method); salePrice = body.originProduct.salePrice; return {}; },
    searchProducts: async () => ({ contents: [] }),
    invalidateProducts() {},
  };
  const { invoke } = ipcFixture({ naverProducts: new NaverProducts(api) });
  const res = await invoke('bulk-price-save', { scope: 'naver', id: '123', newPrice: '12000', expectedPrice: '10000' });
  assert.deepEqual(res.data, { status: 'VERIFIED', price: '12000' });
  assert.deepEqual(calls, ['GET', 'PUT', 'GET']);
});

// ── 아마존 ──────────────────────────────────────────────────────────────

test('아마존: 인스턴스를 새로 만들어도 공유 캐시의 LWA 토큰을 다시 쓴다', async t => {
  let tokenCalls = 0;
  t.mock.method(globalThis, 'fetch', async url => {
    if (String(url).includes('api.amazon.com/auth')) { tokenCalls++; return json({ access_token: 'access', expires_in: 3600 }); }
    return json({ payload: [] });
  });
  const tokenCache = new Map();
  const opts = { sellerId: 'A1B2C3D4E5F6G7', clientId: 'app', clientSecret: 'secret', refreshToken: 'refresh', tokenCache };
  await new AmazonAPI(opts)._request('GET', '/sellers/v1/marketplaceParticipations');
  await new AmazonAPI(opts)._request('GET', '/sellers/v1/marketplaceParticipations');
  assert.equal(tokenCalls, 1);
});

test('아마존: 프록시 자체 오류는 아마존 오류가 아니라 서버 프록시 오류로 표시한다', async t => {
  t.mock.method(globalThis, 'fetch', async url => (String(url).includes('api.amazon.com/auth')
    ? json({ access_token: 'access', expires_in: 3600 })
    : json({ proxyError: true, message: 'amazon 응답 시간 초과' }, 504)));
  const api = new AmazonAPI({ sellerId: 'A1B2C3D4E5F6G7', clientId: 'app', clientSecret: 's', refreshToken: 'r',
    proxy: { proxyUrl: 'https://admin.example.test', proxyToken: 'STAFF' } });
  await assert.rejects(api._request('GET', '/sellers/v1/marketplaceParticipations'), e => {
    assert.match(e.message, /서버 프록시 오류 \(HTTP 504\)/); assert.equal(errorKind(e), 'PROXY'); return true;
  });
});

function amazonSetup(t, extra = {}, reply = () => json({ payload: [] })) {
  const file = path.join(tmpDir(t, 'bulk-amazon-'), 'amazon_config.json');
  fs.writeFileSync(file, JSON.stringify({ sellerId: 'A1B2C3D4E5F6G7', clientId: 'app', clientSecret: 'secret', refreshToken: 'us-refresh',
    endpoint: 'https://sellingpartnerapi-na.amazon.com', marketplaceId: US_MARKETPLACE_ID, ...extra }));
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const call = { url: String(url), body: String(options.body ?? '') };
    calls.push(call);
    return call.url.includes('api.amazon.com/auth') ? json({ access_token: 'access-' + calls.length, expires_in: 3600 }) : reply(call);
  });
  const amazon = new Amazon(file);
  amazon.loadConfig();
  return { amazon, calls };
}

test('아마존 일본: 일본 전용 인증정보(jpRefreshToken)가 있으면 그것으로 FE 엔드포인트를 부른다', async t => {
  const { amazon, calls } = amazonSetup(t, { jpRefreshToken: ' jp-refresh \n', jpSellerId: 'AJPSELLER12345' });
  const api = amazon.apiForMarketplace(JP_MARKETPLACE_ID);
  assert.equal(api.sellerId, 'AJPSELLER12345');
  await api._request('GET', '/sellers/v1/marketplaceParticipations');
  assert.match(calls[0].body, /refresh_token=jp-refresh(&|$)/, '서버가 내려준 값의 공백·개행은 지운다');
  assert.ok(calls[1].url.startsWith('https://sellingpartnerapi-fe.amazon.com/'), calls[1].url);
  assert.equal(amazon.apiForMarketplace(US_MARKETPLACE_ID), amazon.api, '미국은 기본 인증정보 그대로');
});

test('아마존 일본: 일본 인증정보가 없으면 403 에 북미 계정용이라는 안내를 붙인다(미국 403 에는 붙이지 않는다)', async t => {
  const denied = () => json({ errors: [{ code: 'Unauthorized', message: 'Access to requested resource is denied.' }] }, 403);
  const { amazon } = amazonSetup(t, {}, denied);
  await assert.rejects(amazon.apiForMarketplace(JP_MARKETPLACE_ID)._request('GET', '/sellers/v1/marketplaceParticipations'), e => {
    assert.match(e.message, /북미\(미국\) 계정용.*jpRefreshToken/); assert.equal(errorKind(e), 'AUTH'); return true;
  });
  await assert.rejects(amazon.apiForMarketplace(US_MARKETPLACE_ID)._request('GET', '/sellers/v1/marketplaceParticipations'), e => {
    assert.doesNotMatch(e.message, /jpRefreshToken/); return true;
  });
});

test('타임아웃: 아마존 리포트 문서 다운로드와 쿠팡 상품 시트 조회에도 제한 시간을 건다', async t => {
  const signals = [];
  let fail = false;
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    signals.push(options.signal);
    if (fail) throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    return new Response(String(url).includes('docs.google.com') ? '123456789,옵틱글래스 현대 아반떼\n' : 'seller-sku\tprice\nS1\t10\n');
  });
  const api = new AmazonAPI({ sellerId: 'A1B2C3D4E5F6G7', clientId: 'app', clientSecret: 's', refreshToken: 'r' });
  assert.match(await api.downloadReportDocument({ url: 'https://s3.example.test/doc' }), /S1/);
  assert.deepEqual(await findProductIdsFromSheet('현대', '아반떼'), [{ id: '123456789', name: '옵틱글래스 현대 아반떼' }]);
  assert.ok(signals.length === 2 && signals.every(s => s instanceof AbortSignal));
  fail = true;
  await assert.rejects(api.downloadReportDocument({ url: 'https://s3.example.test/doc' }), e => {
    assert.match(e.message, /다운로드 시간 초과/); assert.equal(errorKind(e), 'TIMEOUT'); return true;
  });
  await assert.rejects(findProductIdsFromSheet('현대', '아반떼'), /응답 시간 초과\(30초\)/);
});

// ── eBay ────────────────────────────────────────────────────────────────

const ebayConfig = { environment: 'sandbox', clientId: 'app', clientSecret: 'test-secret', refreshToken: 'test-refresh', ruName: 'r', merchantLocationKey: 'w', fulfillmentPolicyId: 's', paymentPolicyId: 'p', returnPolicyId: 'r' };
const mockEncryption = { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(`encrypted:${s}`), decryptString: b => b.toString().slice(10) };

function ebayFixture(t, api) {
  const store = new EbayStore(tmpDir(t, 'bulk-ebay-'), mockEncryption);
  store.save(ebayConfig);
  return new Ebay(store, () => api);
}

test('eBay load: 없음이 아닌 오류(토큰 만료 등)를 삼키지 않고 그대로 알린다', async t => {
  const api = {
    inventory: async () => { throw new EbayAPIError(401, { errors: [{ errorId: 1001, message: 'Invalid access token' }] }); },
    offers: async () => [],
  };
  await assert.rejects(ebayFixture(t, api).load('OG-1-L', { allowMigration: false }), e => {
    assert.match(e.message, /Invalid access token/);
    assert.doesNotMatch(e.message, /연결이 필요|찾을 수 없습니다/);
    return true;
  });
});

test('eBay 가격만 수정: availableQuantity 를 보내지 않고 수량 검증도 하지 않는다', async t => {
  const calls = [];
  const api = {
    inventory: async () => ({ availability: { shipToLocationAvailability: { quantity: 3 } }, product: { title: 'T' } }),
    offers: async () => [{ offerId: 'o1', status: 'PUBLISHED', marketplaceId: 'EBAY_US', availableQuantity: 5, pricingSummary: { price: { currency: 'USD', value: '50.00' } } }],
    request: async (method, url, body) => { calls.push({ method, url, body }); return { responses: [{ statusCode: 200 }] }; },
  };
  await ebayFixture(t, api).updatePriceQuantity({ sku: 'OG-1-L', price: '55.5', priceOnly: true, expectedPrice: '50.00' });
  assert.deepEqual(calls[0].body.requests[0].offers[0], { offerId: 'o1', price: { currency: 'USD', value: '55.50' } });
});
