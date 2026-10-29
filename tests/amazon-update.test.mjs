import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Amazon } from '../src/platforms/amazon.js';
import { registerBulkPriceIPC } from '../src/bulk_price_ipc.js';

const MP = 'ATVPDKIKX0DER';
const config = {
  sellerId: 'A1B2C3D4E5F6G', clientId: 'app', clientSecret: 'secret', refreshToken: 'refresh',
  marketplaceId: MP, endpoint: 'https://sellingpartnerapi-na.amazon.com', brand: '설정기본브랜드'
};

// 실제 운영 리스팅처럼 이미지·불릿·브랜드·오퍼 부가설정을 모두 갖춘 기존 상품
const existingListing = () => ({
  sku: 'SKU-1',
  summaries: [{ marketplaceId: MP, asin: 'B00TEST', productType: 'AUTO_PART', status: ['BUYABLE'], itemName: 'Old Title' }],
  attributes: {
    item_name: [{ value: 'Old Title', marketplace_id: MP }],
    brand: [{ value: 'RealBrand', marketplace_id: MP }],
    bullet_point: [{ value: '기존 불릿 1', marketplace_id: MP }, { value: '기존 불릿 2', marketplace_id: MP }],
    main_product_image_locator: [{ media_location: 'https://img.example.com/main.jpg', marketplace_id: MP }],
    other_product_image_locator_1: [{ media_location: 'https://img.example.com/sub1.jpg', marketplace_id: MP }],
    purchasable_offer: [{
      currency: 'JPY', marketplace_id: MP,
      our_price: [{ schedule: [{ value_with_tax: 100 }] }],
      minimum_seller_allowed_price: [{ schedule: [{ value_with_tax: 50 }] }]
    }],
    fulfillment_availability: [
      { fulfillment_channel_code: 'DEFAULT', quantity: 5, lead_time_to_ship_max_days: 3 },
      { fulfillment_channel_code: 'AMAZON_NA', quantity: 7 }
    ]
  }
});

function setup(t, listingHandler) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amazon-update-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'amazon.json');
  fs.writeFileSync(file, JSON.stringify(config));

  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (String(url).includes('api.amazon.com/auth')) {
      return new Response(JSON.stringify({ access_token: 'access', expires_in: 3600 }), { status: 200 });
    }
    const call = { url: String(url), method: options.method, body: options.body ? JSON.parse(options.body) : null };
    calls.push(call);
    return listingHandler(call);
  });

  const amazon = new Amazon(file);
  amazon.loadConfig();
  return { amazon, calls };
}

const ok = body => new Response(JSON.stringify(body), { status: 200 });
const fail = message => new Response(JSON.stringify({ issues: [{ message }] }), { status: 400 });

test('제목만 수정하면 제목 속성만 PATCH로 보내고 이미지·불릿·브랜드는 건드리지 않는다', async t => {
  const { amazon, calls } = setup(t, call =>
    call.method === 'GET' ? ok(existingListing()) : ok({ sku: 'SKU-1', status: 'ACCEPTED', submissionId: 'sub-1' }));

  // 값이 없는 필드는 빈 문자열로 들어올 수 있다(예전 veryup-update-product 경로의 형태 — 그 경로는 2026-10-23 지웠다).
  const result = await amazon.updateExistingProduct({
    sku: 'SKU-1', title: '새 제목', titleEn: '새 제목', price: '', stock: '', description: '', marketplaceId: MP
  });

  assert.deepEqual(calls.map(c => c.method), ['GET', 'PATCH']);
  const patch = calls[1].body;
  assert.equal(patch.productType, 'AUTO_PART');
  assert.deepEqual(patch.patches.map(p => p.path), ['/attributes/item_name']);
  assert.deepEqual(patch.patches[0], { op: 'replace', path: '/attributes/item_name', value: [{ value: '새 제목', language_tag: 'en_US', marketplace_id: MP }] });
  assert.deepEqual(result.updatedAttributes, ['item_name']);
  assert.equal(result.submissionId, 'sub-1');
});

test('가격·재고 수정 시 통화와 다른 배송채널 등 기존 오퍼 설정이 유지된다', async t => {
  const { amazon, calls } = setup(t, call =>
    call.method === 'GET' ? ok(existingListing()) : ok({ status: 'ACCEPTED' }));

  await amazon.updateExistingProduct({ sku: 'SKU-1', price: '129.5', stock: '42', marketplaceId: MP });

  const patches = Object.fromEntries(calls[1].body.patches.map(p => [p.path, p.value]));
  assert.deepEqual(Object.keys(patches), ['/attributes/purchasable_offer', '/attributes/fulfillment_availability']);
  assert.equal(patches['/attributes/purchasable_offer'][0].our_price[0].schedule[0].value_with_tax, 129.5);
  assert.equal(patches['/attributes/purchasable_offer'][0].currency, 'JPY');
  assert.deepEqual(patches['/attributes/purchasable_offer'][0].minimum_seller_allowed_price, [{ schedule: [{ value_with_tax: 50 }] }]);
  assert.deepEqual(patches['/attributes/fulfillment_availability'], [
    { fulfillment_channel_code: 'DEFAULT', quantity: 42, lead_time_to_ship_max_days: 3 },
    { fulfillment_channel_code: 'AMAZON_NA', quantity: 7 }
  ]);
});

test('비즈니스(B2B) 가격이 먼저 와도 판매가는 일반 고객가(audience ALL)를 읽고 그 오퍼를 고친다', async t => {
  const listing = existingListing();
  listing.attributes.purchasable_offer = [
    { audience: 'B2B', currency: 'USD', marketplace_id: MP, our_price: [{ schedule: [{ value_with_tax: 90 }] }] },
    { audience: 'ALL', currency: 'USD', marketplace_id: MP, our_price: [{ schedule: [{ value_with_tax: 110 }] }] },
  ];
  const { amazon, calls } = setup(t, call => call.method === 'GET' ? ok(listing) : ok({ status: 'ACCEPTED' }));
  assert.equal((await amazon.loadProductForEdit('SKU-1', MP)).price, 110);
  await amazon.updateExistingProduct({ sku: 'SKU-1', price: '120', stock: '', marketplaceId: MP });
  const offers = calls.find(c => c.method === 'PATCH').body.patches.find(p => p.path === '/attributes/purchasable_offer').value;
  assert.deepEqual(offers.map(o => [o.audience, o.our_price[0].schedule[0].value_with_tax]), [['B2B', 90], ['ALL', 120]]);
});

test('추가 이미지를 한 장만 보내도 나머지 슬롯과 기존 대표 이미지는 그대로 둔다', async t => {
  const { amazon, calls } = setup(t, call =>
    call.method === 'GET' ? ok(existingListing()) : ok({ status: 'ACCEPTED' }));

  await amazon.updateExistingProduct({ sku: 'SKU-1', subImages: ['https://img.example.com/new-sub.jpg'], marketplaceId: MP });

  assert.deepEqual(calls[1].body.patches.map(p => p.path), ['/attributes/other_product_image_locator_1']);
});

test('기존 상품 조회에 실패하면 덮어쓰기 없이 즉시 중단한다', async t => {
  const { amazon, calls } = setup(t, () => fail('Listing not found'));

  await assert.rejects(
    amazon.updateExistingProduct({ sku: 'SKU-1', title: '새 제목', marketplaceId: MP }),
    /조회에 실패하여 수정을 중단/
  );
  assert.deepEqual(calls.map(c => c.method), ['GET']);
});

test('PATCH 미지원 상품유형이면 기존 속성을 병합한 전체 문서로 PUT 한다', async t => {
  const { amazon, calls } = setup(t, call => {
    if (call.method === 'GET') return ok(existingListing());
    if (call.method === 'PATCH') return fail('Patch operation is not supported for this product type');
    return ok({ status: 'ACCEPTED' });
  });

  await amazon.updateExistingProduct({ sku: 'SKU-1', title: '새 제목', marketplaceId: MP });

  assert.deepEqual(calls.map(c => c.method), ['GET', 'PATCH', 'PUT']);
  const put = calls[2].body;
  assert.equal(put.requirements, 'LISTING');
  assert.equal(put.attributes.item_name[0].value, '새 제목');
  assert.equal(put.attributes.main_product_image_locator[0].media_location, 'https://img.example.com/main.jpg');
  assert.equal(put.attributes.other_product_image_locator_1[0].media_location, 'https://img.example.com/sub1.jpg');
  assert.equal(put.attributes.brand[0].value, 'RealBrand');
  assert.deepEqual(put.attributes.bullet_point.map(b => b.value), ['기존 불릿 1', '기존 불릿 2']);
});

test('바뀐 값이 없으면 아마존에 수정 요청을 보내지 않는다', async t => {
  const { amazon, calls } = setup(t, call => (call.method === 'GET' ? ok(existingListing()) : ok({ status: 'ACCEPTED' })));

  const result = await amazon.updateExistingProduct({ sku: 'SKU-1', title: '', price: '', stock: '', marketplaceId: MP });

  assert.deepEqual(calls.map(c => c.method), ['GET']);
  assert.equal(result.status, 'SKIPPED');
});

// 아마존 탭 수정 폼은 불러온 값을 모두 다시 보낸다(registerAmazon). 대표 이미지·브랜드·불릿이 그대로면 다시 PATCH 하지 않는다.
const formResend = (extra = {}) => ({ sku: 'SKU-1', marketplaceId: MP, titleEn: 'Old Title', brand: 'RealBrand', price: '100', stock: '5',
  mainImageUrl: 'https://img.example.com/main.jpg', bulletPoints: '기존 불릿 1\n기존 불릿 2', description: '', currency: 'USD', ...extra });

test('폼이 불러온 값을 그대로 다시 보내면 PATCH 하지 않는다(SKIPPED · 변경 없음)', async t => {
  const { amazon, calls } = setup(t, call => (call.method === 'GET' ? ok(existingListing()) : ok({ status: 'ACCEPTED' })));
  const result = await amazon.updateExistingProduct(formResend({
    replaceImageUrls: ['https://img.example.com/main.jpg', 'https://img.example.com/sub1.jpg'],
    expectedImageUrls: ['https://img.example.com/main.jpg', 'https://img.example.com/sub1.jpg'] }));
  assert.deepEqual(calls.map(c => c.method), ['GET']);
  assert.equal(result.status, 'SKIPPED');
});

test('폼에서 가격만 바꾸면 가격만 PATCH — 바뀌지 않은 대표 이미지·제목·브랜드·재고는 보내지 않는다', async t => {
  const { amazon, calls } = setup(t, call => (call.method === 'GET' ? ok(existingListing()) : ok({ status: 'ACCEPTED' })));
  const result = await amazon.updateExistingProduct(formResend({ price: '120' }));
  assert.deepEqual(calls[1].body.patches.map(p => p.path), ['/attributes/purchasable_offer']);
  assert.deepEqual(result.updatedAttributes, ['purchasable_offer']);
});

test('이미지를 뒤에서 한 장 지우기만 하면 그 슬롯 delete 만 보낸다(대표 이미지는 그대로라 빠진다)', async t => {
  const { amazon, calls } = setup(t, call => (call.method === 'GET' ? ok(existingListing()) : ok({ status: 'ACCEPTED' })));
  await amazon.updateExistingProduct(formResend({ replaceImageUrls: ['https://img.example.com/main.jpg'],
    expectedImageUrls: ['https://img.example.com/main.jpg', 'https://img.example.com/sub1.jpg'] }));
  assert.deepEqual(calls[1].body.patches.map(p => [p.op, p.path]), [['delete', '/attributes/other_product_image_locator_1']]);
});

// 일괄 저장(bulk-save-batch) 의 상품명 — 아마존 미국·일본. 리스팅 GET 은 PATCH 가 바꾼 이름을 돌려준다.
function nameFixture(t, marketplaceId, itemName, { lag = false } = {}) {
  const listing = existingListing();
  listing.summaries[0].marketplaceId = marketplaceId;
  listing.attributes.item_name = [itemName];
  const { amazon, calls } = setup(t, call => {
    if (call.method === 'PATCH') { if (!lag) listing.attributes.item_name = call.body.patches[0].value; return ok({ status: 'ACCEPTED' }); }
    return ok(listing);
  });
  const handlers = {};
  registerBulkPriceIPC({ ipcMain: { handle: (name, fn) => handlers[name] = fn }, amazon: () => amazon,
    readCatalog: () => ({ variants: [], listings: [] }), sleep: async () => {}, log: { error() {} } });
  let n = 0;
  const save = async (scope, job) => {
    const res = await handlers['bulk-save-batch'](null, { jobId: 'amazon-name-' + (++n), scope, jobs: [{ type: 'name', id: 'SKU-1', ...job }] });
    return res.success ? res.data.results[0] : res;
  };
  return { calls, save, handlers };
}

test('상품명(아마존 미국): item_name 만 PATCH(언어 태그 en_US) 하고 다시 읽어 확인한다', async t => {
  const { calls, save, handlers } = nameFixture(t, MP, { value: 'Old Title', marketplace_id: MP });
  const loaded = await handlers['bulk-price-load-many'](null, { scope: 'amazon-us', ids: ['SKU-1'], includeImages: true });
  assert.equal(loaded.data.items[0].rows[0].name, 'Old Title', '불러온 줄의 name 이 expectedName 이다');
  const r = await save('amazon-us', { expectedName: 'Old Title', newName: 'New Title' });
  assert.deepEqual([r.success, r.data?.status], [true, 'VERIFIED'], r.error);
  const patch = calls.find(c => c.method === 'PATCH');
  assert.deepEqual(patch.body.patches, [{ op: 'replace', path: '/attributes/item_name', value: [{ value: 'New Title', language_tag: 'en_US', marketplace_id: MP }] }]);
});

test('상품명(아마존 일본): 기존 언어 태그(ja_JP)를 지키고, 불러온 뒤 바뀐 이름 · 같은 이름은 보내지 않는다', async t => {
  const JP = 'A1VC38T7YXB528';
  const { calls, save } = nameFixture(t, JP, { value: '旧タイトル', language_tag: 'ja_JP', marketplace_id: JP });
  const stale = await save('amazon-jp', { expectedName: '他の名前', newName: '新タイトル' });
  assert.deepEqual([stale.success, stale.stage], [false, 'pre-send']);
  assert.match(stale.error, /불러온 뒤 상품명이 바뀌었습니다\(지금 旧タイトル\)/);
  const same = await save('amazon-jp', { expectedName: '旧タイトル', newName: ' 旧タイトル ' });
  assert.deepEqual([same.success, same.data?.status], [true, 'UNCHANGED']);
  assert.equal(calls.filter(c => c.method === 'PATCH').length, 0);
  const r = await save('amazon-jp', { expectedName: '旧タイトル', newName: '新タイトル' });
  assert.deepEqual([r.success, r.data?.status], [true, 'VERIFIED'], r.error);
  assert.deepEqual(calls.find(c => c.method === 'PATCH').body.patches[0].value, [{ value: '新タイトル', language_tag: 'ja_JP', marketplace_id: JP }]);
});

test('상품명(아마존): 접수됐지만 아직 반영 전이면 판매가처럼 ACCEPTED 로 끝낸다(실패로 보이지 않게)', async t => {
  const { save } = nameFixture(t, MP, { value: 'Old Title', marketplace_id: MP }, { lag: true });
  const r = await save('amazon-us', { expectedName: 'Old Title', newName: 'New Title' });
  assert.deepEqual([r.success, r.data?.status], [true, 'ACCEPTED'], r.error);
});

test('신규 등록은 기존처럼 전체 문서 PUT을 그대로 사용한다', async t => {
  const { amazon, calls } = setup(t, () => ok({ status: 'ACCEPTED' }));

  await amazon.registerProduct({ sku: 'SKU-NEW', titleEn: 'New Item', price: '10', stock: '3', marketplaceId: MP });

  assert.deepEqual(calls.map(c => c.method), ['PUT']);
  assert.equal(calls[0].body.requirements, 'LISTING');
});

test('신규 등록: 빈 판매가를 89.99 로 채우지 않고 막으며, 재고 0 은 999 가 아니라 0 이다', async t => {
  const { amazon, calls } = setup(t, () => ok({ status: 'ACCEPTED' }));

  await assert.rejects(amazon.registerProduct({ sku: 'SKU-NEW', titleEn: 'New Item', price: '', stock: '3', marketplaceId: MP }), /판매가를 입력하세요/);
  assert.equal(calls.length, 0, '보내기 전에 막는다');

  await amazon.registerProduct({ sku: 'SKU-NEW', titleEn: 'New Item', price: '10', stock: '0', marketplaceId: MP });
  assert.equal(calls[0].body.attributes.fulfillment_availability[0].quantity, 0);
});

test('skusOnMarketplace: SKU 마다 묻고 404 는 없음, 200 은 있음 — 검색 API 가 안 돌려주는 오퍼만 있는 SKU 도 잡는다', async t => {
  const { amazon, calls } = setup(t, call => call.url.includes('/SKU-1?')
    ? ok({ sku: 'SKU-1', summaries: [], issues: [{ code: '5461' }] })
    : new Response(JSON.stringify({ errors: [{ code: 'NOT_FOUND', message: 'not found' }] }), { status: 404 }));
  const found = await amazon.skusOnMarketplace(['SKU-1', 'SKU-2', 'SKU-1'], MP);
  assert.deepEqual([...found], ['SKU-1']);
  assert.equal(calls.length, 2, '같은 SKU 는 한 번만 묻는다');
  const { amazon: denied } = setup(t, () => new Response(JSON.stringify({ errors: [{ code: 'InvalidInput', message: 'Invalid accountId' }] }), { status: 400 }));
  await assert.rejects(denied.skusOnMarketplace(['A', 'B'], MP), /Invalid accountId|400/);
});
