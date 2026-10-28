import { previewImageUrls } from '../src/utils/bulk_images.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseImageUrls, imagePolicy } from '../src/utils/bulk_images.js';
import { createBulkImageService } from '../src/bulk_image_service.js';
import { NaverProducts } from '../src/platforms/naver_products.js';
import { Coupang } from '../src/platforms/coupang.js';
import { CoupangAPI } from '../src/platforms/coupang_api.js';
import { Amazon } from '../src/platforms/amazon.js';
import { Ebay } from '../src/platforms/ebay.js';
import { replaceDetailImages } from '../src/platforms/openapi/imweb_b2b.js';

const old = 'https://images.example/old.jpg', fresh = 'https://images.example/new.jpg', second = 'https://images.example/2.jpg';
const quiet = { sleep: async () => {}, inspect: async () => true };

test('pipe lists preserve order, reject malformed values and enforce gallery limits', () => {
  assert.deepEqual(parseImageUrls(`${fresh}|${second}`, 'ebay'), [fresh, second]);
  for (const v of ['', `${fresh}||${second}`, '<img src="x">', 'file:///x', 'javascript:alert(1)', 'https://a:b@example/x', 'https://example/x"oops'])
    assert.throws(() => parseImageUrls(v, 'naver'));
  assert.throws(() => parseImageUrls(Array(10).fill(fresh), 'amazon-us'));
  assert.equal(imagePolicy('naver').display, 'images');
  assert.equal(imagePolicy('amazon-jp').display, 'urls');
  assert.equal(imagePolicy('ebay').display, 'urls');
});

function naverFixture() {
  let body = { originProduct: { name: 'P', salePrice: 10000, stockQuantity: 7, detailContent: `<p>Keep text</p><img src="${old}"><p>Warranty</p>`,
    detailAttribute: { optionInfo: { optionCombinationGroupNames: { optionGroupName1: 'Color' }, optionCombinations: [{ id: 10, optionName1: 'Black', price: 100, stockQuantity: 7 }] } } } };
  const writes = [];
  const api = { originProduct: async () => structuredClone(body), invalidateProducts() {},
    request: async (method, url, data) => { writes.push({method, data}); body = structuredClone(data); return {}; } };
  const adapter = new NaverProducts(api);
  return { adapter, writes, body: () => body, change: () => { body.originProduct.detailContent += `<img src="${second}">`; } };
}
test('Naver image save keeps price/options/text and verifies exact image order', async () => {
  const f = naverFixture(), service = createBulkImageService({ ...quiet, naverProducts: () => f.adapter });
  const loaded = await service.load({ scope: 'naver', id: '123' });
  const result = await service.save({ scope: 'naver', id: '123', expectedRevision: loaded.revision, urls: [fresh, second] });
  assert.equal(result.status, 'VERIFIED'); assert.deepEqual(result.images, [fresh, second]);
  assert.equal(f.writes.length, 1); assert.equal(f.body().originProduct.salePrice, 10000);
  assert.equal(f.body().originProduct.detailAttribute.optionInfo.optionCombinations[0].id, 10);
  assert.match(f.body().originProduct.detailContent, /Keep text/); assert.match(f.body().originProduct.detailContent, /Warranty/);
});
test('stale images and failed ESM inspection do not write products', async () => {
  const f = naverFixture(), service = createBulkImageService({ ...quiet, naverProducts: () => f.adapter, inspect: async () => false });
  const loaded = await service.load({ scope: 'naver', id: '123' }); f.change();
  await assert.rejects(service.save({ scope: 'naver', id: '123', expectedRevision: loaded.revision, urls: [fresh] }), e => e.stage === 'pre-send' || /변경/.test(e.message));
  await assert.rejects(service.save({ scope: 'naver', id: '123', expectedRevision: loaded.revision, urls: ['https://ai.esmplus.com/test.jpg'] }), /ESM/);
  assert.equal(f.writes.length, 0);
});
test('accepted-but-unverified image writes return CHECK', async () => {
  // 저장 요청은 받아들여졌는데 다시 읽어도 옛 이미지면 확인 필요(CHECK)다.
  const imwebBulk = { readImages: async () => ({ content: `<img src="${old}">`, images: [old] }), saveImages: async () => {} };
  const service = createBulkImageService({ ...quiet, imwebBulk });
  const loaded = await service.load({ scope: 'imweb-ko', id: '3' });
  assert.equal((await service.save({ scope: 'imweb-ko', id: '3', expectedRevision: loaded.revision, urls: [fresh] })).status, 'CHECK');
});
test('all Imweb scopes save detail images through the Open API adapter — only the description, with the content it read', async () => {
  for (const scope of ['imweb-b2b', 'imweb-ko', 'imweb-en', 'imweb-jp']) {
    let content = `<p>intro</p><img src="${old}">`, write;
    const imwebBulk = {
      readImages: async () => ({ content, images: content.includes(fresh) ? [fresh] : [old] }),
      saveImages: async (s, id, images, base) => { write = [s, id, images, base]; content = base.replace(old, fresh); },
    };
    const service = createBulkImageService({ ...quiet, imwebBulk });
    const input = { scope, id: '3' };
    const loaded = await service.load(input);
    assert.equal((await service.save({ ...input, expectedRevision: loaded.revision, urls: [fresh] })).status, 'VERIFIED', scope);
    assert.deepEqual(write, [scope, '3', [fresh], `<p>intro</p><img src="${old}">`], scope);
  }
});
test('Coupang replaces details once per product and preserves text/options/prices', async () => {
  let product = { sellerProductId: 1, sellerProductName: 'P', deliveryCharge: 2500, items: [1, 2].map(id => ({
    sellerProductItemId: id, vendorItemId: id + 20, salePrice: 10000 + id, maximumBuyCount: 5,
    contents: [{ contentsType: 'HTML', contentDetails: [{ detailType: 'TEXT', content: `<p>intro</p><img src="${old}"><p>warranty</p>` }] }] })) };
  const adapter = Object.create(Coupang.prototype); let writes = 0;
  adapter.loadConfig = () => {};
  adapter.api = { getProduct: async () => ({ data: structuredClone(product) }), updateProduct: async (_, data) => { product = data; writes++; return { code: 'SUCCESS' }; } };
  const service = createBulkImageService({ ...quiet, coupang: () => adapter });
  const input = { scope: 'coupang', id: '1' }, loaded = await service.load(input);
  const result = await service.save({ ...input, expectedRevision: loaded.revision, urls: [fresh, second] });
  assert.equal(result.status, 'VERIFIED'); assert.equal(writes, 1); assert.equal(product.deliveryCharge, 2500);
  for (const item of product.items) {
    assert.deepEqual(adapter._extractDetailImages(item.contents).map(x => x.url), [fresh, second]);
    assert.match(item.contents[0].contentDetails[0].content, /warranty/);
    assert.equal(item.salePrice, 10000 + item.sellerProductItemId); assert.equal(item.maximumBuyCount, 5);
  }
});
test('Coupang writes re-read the product past the 30s cache, so a Wing edit after loading is not overwritten', async () => {
  let remote = { sellerProductId: 1, sellerProductName: 'P', items: [{ sellerProductItemId: 1, vendorItemId: 21, salePrice: 10000,
    contents: [{ contentsType: 'HTML', contentDetails: [{ detailType: 'TEXT', content: `<img src="${old}">` }] }] }] };
  const api = Object.create(CoupangAPI.prototype); let puts = 0;
  api._request = async method => { if (method === 'PUT') { puts++; return { code: 'SUCCESS' }; } return { code: 'SUCCESS', data: structuredClone(remote) }; };
  const adapter = Object.create(Coupang.prototype);
  adapter.loadConfig = () => {}; adapter.api = api;
  const loaded = (await api.getProduct(1)).data;   // 탭·일괄 수정이 불러온 시점 — 30초 캐시에 들어간다
  remote = structuredClone(remote); remote.items[0].contents[0].contentDetails[0].content = `<img src="${second}">`;   // 그 뒤 Wing 에서 수정
  await assert.rejects(adapter.updateBulkDetailImages({ productId: 1, images: [fresh],
    expectedContents: loaded.items.map(x => [x.sellerProductItemId, x.contents]) }), /변경됐습니다/);
  assert.equal(puts, 0, '옛 본문으로 PUT 하지 않는다');
  const seen = [];
  adapter.api = { getProduct: async (id, options) => { seen.push(options); throw new Error('stop'); } };
  await assert.rejects(adapter.updateExistingProduct({ productId: 1 }), /stop/);
  assert.deepEqual(seen, [{ force: true }], '탭 저장도 캐시를 건너뛰고 읽는다');
});
test('Amazon exact replacement deletes obsolete slots and preserves other marketplace images', async () => {
  const mid = 'ATVPDKIKX0DER', jp = 'A1VC38T7YXB528'; let patch;
  const raw = { summaries: [{ marketplaceId: mid, productType: 'AUTO_PART' }], attributes: {
    main_product_image_locator: [{ marketplace_id: mid, media_location: old }, { marketplace_id: jp, media_location: second }],
    other_product_image_locator_1: [{ marketplace_id: mid, media_location: second }],
    purchasable_offer: [{ marketplace_id: mid, our_price: [{ schedule: [{ value_with_tax: 99 }] }] }]
  } };
  const adapter = Object.create(Amazon.prototype);
  adapter.config = {}; adapter.api = {}; adapter.loadConfig = () => {}; adapter._writeDebug = () => {}; adapter._syncCachedListing = () => {};
  adapter.apiForMarketplace = () => ({ getListingItem: async () => raw, patchListingItem: async (_, body) => { patch = body; return { status: 'ACCEPTED' }; } });
  const service = createBulkImageService({ ...quiet, amazon: () => adapter });
  const input = { scope: 'amazon-us', id: 'SKU' }, loaded = await service.load(input);
  assert.equal((await service.save({ ...input, expectedRevision: loaded.revision, urls: [fresh] })).status, 'ACCEPTED');
  assert.deepEqual(patch.patches.map(p => [p.op, p.path]), [['replace', '/attributes/main_product_image_locator'], ['delete', '/attributes/other_product_image_locator_1']]);
  assert.equal(patch.patches[0].value.find(v => v.marketplace_id === jp).media_location, second);
});
test('eBay uses resolved SKU and preserves inventory fields; no migration', async () => {
  let payload, route;
  const adapter = Object.create(Ebay.prototype); adapter.busy = false;
  adapter.store = {};
  adapter.load = async (sku, options) => { assert.equal(options.allowMigration, false); return {
    sku: 'REAL-SKU', offer: { status: 'PUBLISHED' }, inventory: { sku, locale: 'en_US', condition: 'NEW',
      availability: { shipToLocationAvailability: { quantity: 7 } }, product: { title: 'P', description: 'keep', imageUrls: [old] } } }; };
  adapter.client = () => ({ api: { request: async (method, path, body) => { assert.equal(method, 'PUT'); route = path; payload = body; } } });
  await adapter.updateImages({ sku: '12345678901', images: [fresh], expectedImages: [old] });
  assert.match(route, /REAL-SKU$/); assert.equal(payload.sku, undefined); assert.equal(payload.product.description, 'keep');
  assert.equal(payload.availability.shipToLocationAvailability.quantity, 7); assert.deepEqual(payload.product.imageUrls, [fresh]);
});
test('Imweb adding images to text-only content keeps existing text', () => {
  const html = replaceDetailImages('<p>keep me</p>', [fresh]);
  assert.match(html, /keep me/); assert.match(html, /new.jpg/);
});

test('ESM import parses HTML in order, checks hosting, and produces save-ready URLs without writing', async () => {
  const f = naverFixture(), inspected = [];
  const service = createBulkImageService({ ...quiet, naverProducts: () => f.adapter,
    inspect: async url => { inspected.push(url); return true; } });
  const one = 'https://ai.esmplus.com/first.jpg?a=1&b=2', two = 'https://ai.esmplus.com/second.jpg';
  const imported = await service.importImages({ scope: 'naver', input: `<div><img src="${one.replace('&', '&amp;')}" onerror="not executed"><img src="${two}"></div>` });
  assert.deepEqual(imported.images, [one, two]);
  assert.deepEqual(inspected, [one, two]);
  assert.equal(f.writes.length, 0);
  const current = await service.load({ scope: 'naver', id: '123' });
  const result = await service.save({ scope: 'naver', id: '123', expectedRevision: current.revision, urls: imported.images });
  assert.equal(result.status, 'VERIFIED');
  assert.deepEqual(result.images, [one, two]);
  assert.equal(f.writes.length, 1);
});

test('ESM import rejects failed hosting, invalid HTML sources and image limits before saving', async () => {
  const f = naverFixture(), service = createBulkImageService({ ...quiet, naverProducts: () => f.adapter, inspect: async () => false });
  await assert.rejects(service.importImages({ scope: 'naver', input: 'https://ai.esmplus.com/missing.jpg' }), /ESM/);
  await assert.rejects(service.importImages({ scope: 'naver', input: '<img src="javascript:alert(1)">' }), /esmplus/);
  await assert.rejects(service.importImages({ scope: 'amazon-us', input: Array.from({length:10},(_,i)=>`<img src="https://ai.esmplus.com/${i}.jpg">`).join('') }), /9장/);
  assert.equal(f.writes.length, 0);
});

test('preview URLs accept parsed arrays, objects, JSON and pipe lists without changing query strings', () => {
  const urls = ['https://images.example/a.jpg?a=1&b=2', 'https://images.example/b.jpg'];
  for (const input of [urls, urls.map(url => ({url})), JSON.stringify(urls), urls.join('|')]) {
    assert.deepEqual(previewImageUrls(input), urls);
  }
  assert.deepEqual(previewImageUrls(['javascript:alert(1)', 'file:///C:/secret', 'https://user:pass@example.com/a.jpg', ...urls]), urls);
});
