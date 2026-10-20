import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Amazon } from '../src/platforms/amazon.js';

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

  // veryup-update-product 경로가 넘기는 형태: 값이 없는 필드는 빈 문자열로 들어온다.
  const result = await amazon.updateExistingProduct({
    sku: 'SKU-1', title: '새 제목', titleEn: '새 제목', price: '', stock: '', description: '', marketplaceId: MP
  });

  assert.deepEqual(calls.map(c => c.method), ['GET', 'PATCH']);
  const patch = calls[1].body;
  assert.equal(patch.productType, 'AUTO_PART');
  assert.deepEqual(patch.patches.map(p => p.path), ['/attributes/item_name']);
  assert.deepEqual(patch.patches[0], { op: 'replace', path: '/attributes/item_name', value: [{ value: '새 제목', marketplace_id: MP }] });
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
