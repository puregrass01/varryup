// 마켓플레이스가 거부했는데 '성공'으로 보고되던 경로들 (코드 리뷰 6~8번).
//
// 있었던 일
//   · 아마존: SP-API 는 검증 실패를 HTTP 200 + status:"INVALID" 로 준다. 그대로 성공 처리하고
//     로컬 캐시까지 새 값으로 고쳤다. 수정 경로는 429·5xx 에도 전체 문서 PUT 으로 넘어갔다.
//   · 쿠팡: 등록 거부(HTTP 200 + code:'ERROR')를 확인하지 않아 "등록되었습니다 (ID: undefined)".
//     목록 조회 오류 본문은 '상품 0개'로 5분 캐시됐다. 수정 화면은 옛 index 로 옵션을 찾아,
//     옵션을 지우고 한 번 더 저장하면 한 옵션이 사라지고 한 옵션이 두 번 들어갔다.
//   · 아임웹: 판매중 전환·그룹가격 상속 실패를 로그로만 남기고, main 이 요약 문자열을 무조건
//     success:true 로 감쌌다("일부 실패"도 성공).
//   (네이버 복사등록은 2026-10-28 커머스API 로 옮겼다 — tests/naver-products.test.mjs)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Amazon, assertListingAccepted } from '../src/platforms/amazon.js';
import { AmazonStore } from '../src/platforms/amazon_store.js';
import { Coupang } from '../src/platforms/coupang.js';
import { ImwebEdit } from '../src/platforms/imweb_edit.js';
import { imwebRunResponse } from '../src/platforms/imweb.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

function tmpDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// 코드 안의 sleep(수 초)을 가짜 시계로 건너뛴다. setImmediate 는 진짜라 await 사슬이 계속 돈다.
async function withFakeTimers(t, fn) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let settled = false;
    const p = Promise.resolve().then(fn).finally(() => { settled = true; });
    p.catch(() => {});   // 도는 동안 '처리 안 된 거부'로 잡히지 않게 — 거부는 아래 await 가 그대로 던진다
    while (!settled) {
      await new Promise(r => setImmediate(r));
      t.mock.timers.tick(60_000);
    }
    return await p;
  } finally {
    t.mock.timers.reset();
  }
}

// ── 아마존 ──────────────────────────────────────────────────────────────

const MP = 'ATVPDKIKX0DER';
const SELLER = 'A1B2C3D4E5F6G';

function amazonSetup(t, handler) {
  const dir = tmpDir(t, 'amazon-results-');
  const file = path.join(dir, 'amazon.json');
  fs.writeFileSync(file, JSON.stringify({
    sellerId: SELLER, clientId: 'app', clientSecret: 'secret', refreshToken: 'refresh',
    marketplaceId: MP, endpoint: 'https://sellingpartnerapi-na.amazon.com'
  }));
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    if (String(url).includes('api.amazon.com/auth')) return json({ access_token: 'access', expires_in: 3600 });
    const call = { url: String(url), method: options.method || 'GET' };
    calls.push(call);
    return handler(call);
  });
  const store = new AmazonStore(dir);
  store.saveListingsCache({
    updatedAt: 'now', sellerId: SELLER, marketplaceId: MP, total: 1,
    items: [{ id: 'SKU-A', name: '옛 이름', price: '10', stock: '1', description: '', brand: '', asin: 'A1' }]
  });
  const amazon = new Amazon(file, store);
  amazon.loadConfig();
  return { amazon, store, calls };
}

const INVALID = {
  sku: 'SKU-A', status: 'INVALID', submissionId: 'sub-x',
  issues: [{ code: '90220', message: "'item_name' is required but not supplied.", severity: 'ERROR', attributeNames: ['item_name'] }]
};
const existing = () => ({
  sku: 'SKU-A',
  summaries: [{ marketplaceId: MP, itemName: '옛 이름', productType: 'AUTO_PART' }],
  attributes: { item_name: [{ value: '옛 이름', marketplace_id: MP }] }
});

test('아마존 등록: HTTP 200 + INVALID 는 이슈를 담아 실패하고 캐시를 고치지 않는다', async t => {
  const { amazon, store } = amazonSetup(t, () => json(INVALID));
  await assert.rejects(
    amazon.registerProduct({ sku: 'SKU-A', titleEn: '새 이름', price: '99', stock: '3', marketplaceId: MP }),
    err => /거부/.test(err.message) && /INVALID/.test(err.message) && /90220/.test(err.message) && /item_name/.test(err.message)
  );
  const row = store.listingsCache(MP).items.find(i => i.id === 'SKU-A');
  assert.equal(row.name, '옛 이름', '거부된 값으로 캐시를 고치면 목록에 아마존에 없는 값이 보인다');
  assert.equal(row.price, '10');
});

test('아마존 등록: ACCEPTED 만 성공이다', () => {
  assert.doesNotThrow(() => assertListingAccepted({ status: 'ACCEPTED' }));
  assert.throws(() => assertListingAccepted({}), /상태: 없음/);
  assert.throws(() => assertListingAccepted({ status: 'INVALID', issues: [] }), /INVALID/);
});

test('아마존 수정: PATCH 가 HTTP 200 + INVALID 면 PUT 으로 덮어쓰지 않고 실패한다', async t => {
  const { amazon, store, calls } = amazonSetup(t, call => (call.method === 'GET' ? json(existing()) : json(INVALID)));
  await assert.rejects(amazon.updateExistingProduct({ sku: 'SKU-A', title: '새 이름', marketplaceId: MP }), /90220/);
  assert.deepEqual(calls.map(c => c.method), ['GET', 'PATCH']);
  assert.equal(store.listingsCache(MP).items[0].name, '옛 이름');
});

test('아마존 수정: 429·5xx 는 PUT 대체 없이 그대로 실패한다 (PATCH 미지원일 때만 PUT)', async t => {
  for (const status of [429, 503]) {
    const { amazon, calls } = amazonSetup(t, call =>
      (call.method === 'GET' ? json(existing()) : json({ errors: [{ code: 'QuotaExceeded', message: 'You exceeded your quota' }] }, status)));
    await assert.rejects(amazon.updateExistingProduct({ sku: 'SKU-A', title: '새 이름', marketplaceId: MP }), /QuotaExceeded/);
    assert.deepEqual(calls.map(c => c.method), ['GET', 'PATCH'], `HTTP ${status} 에 PUT 을 보내면 안 된다`);
  }
});

test('아마존 수정: PATCH 미지원 → PUT 대체가 INVALID 면 실패한다', async t => {
  const { amazon, store, calls } = amazonSetup(t, call => {
    if (call.method === 'GET') return json(existing());
    if (call.method === 'PATCH') return json({ issues: [{ message: 'Patch operation is not supported for this product type' }] }, 400);
    return json(INVALID);
  });
  await assert.rejects(amazon.updateExistingProduct({ sku: 'SKU-A', title: '새 이름', marketplaceId: MP }), /PUT 재시도.*INVALID/);
  assert.deepEqual(calls.map(c => c.method), ['GET', 'PATCH', 'PUT']);
  assert.equal(store.listingsCache(MP).items[0].name, '옛 이름');
});

// ── 쿠팡 ────────────────────────────────────────────────────────────────

function coupangSetup(t, handler) {
  const dir = tmpDir(t, 'coupang-results-');
  const file = path.join(dir, 'coupang_config.json');
  fs.writeFileSync(file, JSON.stringify({ vendorId: 'A00012345', accessKey: 'ak', secretKey: 'sk' }));
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const call = { url: String(url), method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null };
    calls.push(call);
    return handler(call);
  });
  const coupang = new Coupang(file);
  coupang.loadConfig();
  return { coupang, calls };
}

const TEMPLATE = {
  sellerProductId: 13670011949, displayCategoryCode: 1, vendorId: 'A00012345', returnCenterCode: 1,
  outboundShippingPlaceCode: 1,
  items: [{ itemName: 'T', attributes: [{ attributeTypeName: '차종', attributeValueName: 'X', exposed: 'EXPOSED' }], contents: [], images: [] }]
};
const copyData = { title: '옵틱글래스 현대 아반떼 미러', category: '자동차', optionModel: '아반떼', optionProduct: '1개', price: '50000' };

test('쿠팡 등록: HTTP 200 + code:ERROR 는 쿠팡 메시지로 실패한다', async t => {
  const { coupang } = coupangSetup(t, call =>
    (call.method === 'GET' ? json({ code: 'SUCCESS', data: TEMPLATE }) : json({ code: 'ERROR', message: '필수 구매옵션이 누락되었습니다.' })));
  await assert.rejects(coupang.copyRegisterProduct(copyData), /거부.*code=ERROR.*필수 구매옵션이 누락/);
});

test('쿠팡 등록: 성공 코드라도 등록상품ID 가 없으면 성공으로 보지 않는다', async t => {
  const { coupang } = coupangSetup(t, call =>
    (call.method === 'GET' ? json({ code: 'SUCCESS', data: TEMPLATE }) : json({ code: 'SUCCESS', message: '' })));
  await assert.rejects(coupang.copyRegisterProduct(copyData), /등록상품ID가 없습니다/);
});

test('쿠팡 등록: 정상 응답은 등록상품ID 를 그대로 돌려준다', async t => {
  const { coupang } = coupangSetup(t, call =>
    (call.method === 'GET' ? json({ code: 'SUCCESS', data: TEMPLATE }) : json({ code: 'SUCCESS', message: '', data: 1320567185 })));
  const r = await coupang.copyRegisterProduct(copyData);
  assert.equal(r.data, 1320567185);
});

test('쿠팡 목록: 오류 본문을 빈 목록으로 캐시하지 않는다', async t => {
  let fail = true;
  const { coupang } = coupangSetup(t, () => (fail
    ? json({ code: 'ERROR', message: '요청 한도를 초과했습니다' })
    : json({ code: 'SUCCESS', data: [{ sellerProductId: 1, sellerProductName: '옵틱글래스 현대 아반떼' }] })));
  await assert.rejects(coupang.fetchAllProducts(), /요청 한도를 초과/);
  assert.equal(coupang._allProducts ?? null, null, "'상품 0개'가 5분 동안 캐시되면 안 된다");
  fail = false;
  assert.equal((await coupang.fetchAllProducts()).length, 1);
});

test('쿠팡 API: 성공 코드(SUCCESS / 200 / "200")와 code 없는 응답은 그대로 통과한다', async t => {
  let body;
  const { coupang } = coupangSetup(t, () => json(body));
  for (body of [{ code: 'SUCCESS', data: [] }, { code: 200, data: {} }, { code: '200', message: 'OK', data: {} }, { content: [] }]) {
    assert.deepEqual(await coupang.api.getReturnCenters(), body);
  }
});

// 첫 저장에서 옵션 A 를 지웠다. 화면은 옛 목록(A,B,C 의 index 0,1,2)에서 A 만 뺀 B(index 1)·C(index 2)를
// 들고 있고, 쿠팡에는 이제 B·C 두 개뿐이다(index 0,1). 옛 index 로 찾으면 B→C, C→없음→ID로 C 가 되어
// B 는 사라지고 C 가 두 번 들어간다.
const item = (id, name) => ({
  sellerProductItemId: id, vendorItemId: id * 10, itemName: name, salePrice: 1000, originalPrice: 1000, maximumBuyCount: 5,
  attributes: [{ attributeTypeName: '차종', attributeValueName: name, exposed: 'EXPOSED' }],
  images: [], contents: [],
});
const afterFirstSave = () => ({ sellerProductId: 777, sellerProductName: 'P', statusName: '승인완료', items: [item(22, 'B'), item(33, 'C')] });

test('쿠팡 수정: 두 번째 저장은 옛 index 가 아니라 sellerProductItemId 로 옵션을 찾는다', async t => {
  const puts = [];
  const { coupang } = coupangSetup(t, call => {
    if (call.method === 'PUT') { puts.push(call.body); return json({ code: 'SUCCESS', data: 777 }); }
    // 저장 뒤 반영 확인 조회는 방금 보낸 옵션 그대로 돌려준다
    if (puts.length) return json({ code: 'SUCCESS', data: { ...afterFirstSave(), items: puts[0].items } });
    return json({ code: 'SUCCESS', data: afterFirstSave() });
  });
  await withFakeTimers(t, () => coupang.updateExistingProduct({
    productId: 777,
    options: [
      { index: 1, sellerProductItemId: 22, isNew: false, attrs: [{ index: 0, typeName: '차종', value: 'B' }] },
      { index: 2, sellerProductItemId: 33, isNew: false, attrs: [{ index: 0, typeName: '차종', value: 'C' }] },
    ],
  }));
  assert.equal(puts.length, 1);
  assert.deepEqual(puts[0].items.map(i => [i.sellerProductItemId, i.itemName]), [[22, 'B'], [33, 'C']]);
});

test('쿠팡 수정: ID 가 있는데 쿠팡에 없으면 index 로 대신하지 않고 저장 전에 멈춘다', async t => {
  const { coupang, calls } = coupangSetup(t, () => json({ code: 'SUCCESS', data: afterFirstSave() }));
  await assert.rejects(coupang.updateExistingProduct({
    productId: 777,
    options: [{ index: 0, sellerProductItemId: 11, isNew: false }, { index: 1, sellerProductItemId: 22, isNew: false }],
  }), /옵션ID: 11.*다시 불러온/);
  assert.ok(!calls.some(c => c.method === 'PUT'), '엉뚱한 옵션으로 저장 요청을 보내면 안 된다');
});

test('쿠팡 수정: 같은 기존 옵션이 두 번 들어오면 멈춘다', async t => {
  const { coupang, calls } = coupangSetup(t, () => json({ code: 'SUCCESS', data: afterFirstSave() }));
  await assert.rejects(coupang.updateExistingProduct({
    productId: 777,
    options: [{ index: 0, isNew: false }, { index: 0, isNew: false }],
  }), /두 번/);
  assert.ok(!calls.some(c => c.method === 'PUT'));
});

// ── 아임웹 ──────────────────────────────────────────────────────────────

test('아임웹 응답: 일부 실패는 success:false · partial:true · 대상별 results', () => {
  const r = imwebRunResponse({
    summary: 'B2B몰 등록 일부 실패 (성공: 개별)',
    results: [{ target: 'B2B 개별', ok: true }, { target: 'B2B 세트', ok: false, error: '판매중 전환 실패' }],
  }, ' ⚠ 안내');
  assert.equal(r.success, false);
  assert.equal(r.partial, true);
  assert.deepEqual(r.results, [{ target: 'B2B 개별', ok: true }, { target: 'B2B 세트', ok: false, error: '판매중 전환 실패' }]);
  assert.match(r.error, /B2B 세트: 판매중 전환 실패/);
  assert.match(r.error, /안내$/);
  assert.match(r.message, /일부 실패/);

  const all = imwebRunResponse({ summary: 's', results: [{ target: 'B2B 개별', ok: false, error: 'x' }] });
  assert.equal(all.success, false);
  assert.equal(all.partial, false);

  const ok = imwebRunResponse({ summary: 'B2B몰 등록 성공 (개별)', results: [{ target: 'B2B 개별', ok: true }] });
  assert.deepEqual(ok, { success: true, message: 'B2B몰 등록 성공 (개별)', results: [{ target: 'B2B 개별', ok: true }] });

  assert.equal(imwebRunResponse({ summary: '', results: [] }).success, false, '아무것도 안 했으면 성공이 아니다');
});

function imwebStub(t) {
  const imweb = new ImwebEdit();
  imweb.logCallback = null;
  t.mock.method(console, 'log', () => {});
  return imweb;
}

test('아임웹 실행: B2B 한쪽 실패 → 대상별 결과, 만들어진 것은 모두 원장 대상', async t => {
  const imweb = imwebStub(t);
  imweb.registerB2bViaApi = async () => ([
    { type: 'indiv', ok: true, no: 101, title: '개별' },
    { type: 'set', ok: false, no: 102, title: '세트', error: '판매중 전환 실패 — 숨김 상태로 남았습니다' },
  ]);
  const run = await imweb.executeAutomation({
    targetB2b: true, registerIndiv: true, registerSet: true, code: 'H1', bsaX: true,
  });
  assert.deepEqual(run.results, [
    { target: 'B2B 개별', ok: true },
    { target: 'B2B 세트', ok: false, error: '판매중 전환 실패 — 숨김 상태로 남았습니다' },
  ]);
  // 숨김으로 남은 세트도 '만들어진 상품'이다 — 원장에 적어야 재시도가 또 만들지 않는다.
  assert.deepEqual(imweb.lastRegistered.map(r => r.no), [101, 102]);
  const res = imwebRunResponse(run);
  assert.equal(res.success, false);
  assert.equal(res.partial, true);
});

test('아임웹 실행: B2B 준비 단계가 던지면 요청한 개별·세트 모두 그 오류로 실패한다', async t => {
  const imweb = imwebStub(t);
  imweb.registerB2bViaApi = async () => { throw new Error('아임웹 Open API 키가 없습니다.'); };
  const run = await imweb.executeAutomation({ targetB2b: true, registerIndiv: true, registerSet: true, code: 'H1' });
  assert.deepEqual(run.results, [
    { target: 'B2B 개별', ok: false, error: '아임웹 Open API 키가 없습니다.' },
    { target: 'B2B 세트', ok: false, error: '아임웹 Open API 키가 없습니다.' },
  ]);
  const res = imwebRunResponse(run);
  assert.equal(res.success, false);
  assert.equal(res.partial, false);
});

// B2B 등록 · 수정의 단계별 판정(판매중 전환 거부 · 확인 불일치 등)은 tests/imweb-b2b.test.mjs 에 있다(Open API).

