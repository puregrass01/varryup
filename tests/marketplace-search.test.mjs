import test from 'node:test';
import assert from 'node:assert/strict';
import { AmazonAPI } from '../src/platforms/amazon_api.js';
import { Amazon } from '../src/platforms/amazon.js';
import { EbayAPI } from '../src/platforms/ebay_api.js';
import { Ebay } from '../src/platforms/ebay.js';
import { matchesProduct } from '../src/platforms/product_search.js';

const US = 'ATVPDKIKX0DER', JP = 'A1VC38T7YXB528';
test('Amazon list request encodes seller and pagination, with seller listing fields', async t => {
  let request;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    request = { url: new URL(url), options };
    return new Response(JSON.stringify({ items: [] }));
  });
  const api = new AmazonAPI({ sellerId: 'A1B2C3D4E5F6G' });
  api.accessToken = 'test'; api.tokenExpiresAt = Date.now() + 3600000;
  await api.searchListingsItems({ marketplaceId: US, pageToken: 'a+/=&' });
  assert.equal(request.url.pathname, '/listings/2021-08-01/items/A1B2C3D4E5F6G');
  assert.equal(request.url.searchParams.get('marketplaceIds'), US);
  assert.equal(request.url.searchParams.get('pageToken'), 'a+/=&');
  assert.equal(request.url.searchParams.get('pageSize'), '20');
  assert.match(request.url.searchParams.get('includedData'), /attributes/);
  assert.equal(request.options.method, 'GET');
});

// Amazon 은 잘못된 sellerId 를 400 InvalidInput 으로만 알려주고 details 도 비워 보낸다.
// 연결 테스트는 sellerId 를 쓰지 않아 통과하므로, 요청 전에 걸러야 원인을 알 수 있다.
test('Amazon rejects a sellerId that is not a Merchant Token before calling SP-API', async t => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response('{}'));
  for (const bad of ['OPTICGLASS', 'seller /1', '', 'A1B2C3D4E5F6G1234', 'a1b2c3d4e5f6g']) {
    const api = new AmazonAPI({ sellerId: bad });
    api.accessToken = 'test'; api.tokenExpiresAt = Date.now() + 3600000;
    await assert.rejects(() => api.searchListingsItems({ marketplaceId: US }), /Merchant Token/);
    await assert.rejects(() => api.getListingItem('SKU-1'), /Merchant Token/);
  }
  assert.equal(fetchMock.mock.callCount(), 0);
});

function amazonWith(api) {
  const amazon = new Amazon('unused');
  amazon.config = { marketplaceId: US };
  amazon.api = { endpoint: 'https://sellingpartnerapi-na.amazon.com', ...api };
  return amazon;
}
const listing = (sku, title) => ({ sku, summaries: [{ marketplaceId: US, itemName: title, asin: 'ASIN-1' }],
  attributes: { purchasable_offer: [{ marketplace_id: US, our_price: [{ schedule: [{ value_with_tax: 0 }] }] }],
    fulfillment_availability: [{ fulfillment_channel_code: 'DEFAULT', quantity: 0 }] } });

test('Amazon lists every page, preserves arbitrary SKUs and zeroes, filters later pages', async () => {
  const calls = [];
  const amazon = amazonWith({ searchListingsItems: async query => {
    calls.push(query);
    return query.pageToken ? { items: [listing('custom/sku', 'Hyundai Mirror')] }
      : { items: [listing('OTHER', 'Ford Glass')], pagination: { nextToken: 'next' } };
  } });
  const items = await amazon.searchProducts({ searchText: 'hyundai mirror' });
  assert.equal(calls.length, 2); assert.equal(calls[1].pageToken, 'next');
  assert.deepEqual(items[0], { id: 'custom/sku', name: 'Hyundai Mirror', price: '0', stock: '0', description: '', brand: '', asin: 'ASIN-1' });
  assert.equal((await amazon.searchProducts()).length, 2);
  assert.equal((await amazon.searchProducts({ code: 'custom/sku', brand: 'irrelevant' })).length, 1);
});

test('Amazon never hides API failures or repeated pagination as empty results', async () => {
  await assert.rejects(amazonWith({ searchListingsItems: async () => { throw new Error('Access denied'); } }).searchProducts(), /Access denied/);
  await assert.rejects(amazonWith({ searchListingsItems: async () => ({ pagination: { nextToken: 'same' } }) }).searchProducts(), /페이지/);
  assert.deepEqual(await amazonWith({ searchListingsItems: async () => ({ items: [] }) }).searchProducts(), []);
});

test('Amazon US/JP endpoint selection retains proxy and leaves saved settings intact', () => {
  const amazon = amazonWith({});
  amazon.config.proxyUrl = 'https://proxy.example'; amazon.config.proxyToken = 'test';
  const api = amazon.apiForMarketplace(JP);
  assert.equal(api.endpoint, 'https://sellingpartnerapi-fe.amazon.com');
  assert.equal(api.proxyUrl, amazon.config.proxyUrl);
  assert.equal(amazon.apiForMarketplace(US), amazon.api);
  assert.equal(amazon.config.marketplaceId, US);
});

test('Amazon normalized values use the requested marketplace and preserve unknown stock', () => {
  const amazon = amazonWith({});
  const result = amazon.productForEdit({ summaries: [{ marketplaceId: JP, itemName: 'Japan' }],
    attributes: { item_name: [{ marketplace_id: US, value: 'US' }, { marketplace_id: JP, value: 'JP' }] },
    offers: [{ marketplaceId: JP, price: { amount: 1000 } }] }, 'sku', JP);
  assert.equal(result.title, 'JP'); assert.equal(result.price, 1000); assert.equal(result.stock, '');
});

test('eBay inventory pagination uses authenticated GET in the selected environment', async () => {
  const urls = [];
  const api = new EbayAPI({ environment: 'sandbox' }, { fetchImpl: async (url, options) => {
    urls.push(url); assert.equal(options.method, 'GET');
    return new Response(JSON.stringify({ inventoryItems: [], total: 0 }));
  } });
  api.accessToken = 'test'; api.expiresAt = Date.now() + 10000;
  await api.inventoryItems(100);
  assert.equal(urls[0], 'https://api.sandbox.ebay.com/sell/inventory/v1/inventory_item?limit=100&offset=100');
});

test('eBay filters before offer lookups, follows pages, maps US offers and keeps zero stock', async () => {
  const offsets = [], lookups = [];
  const api = {
    async inventoryItems(offset) {
      offsets.push(offset);
      return offset === 0 ? { inventoryItems: Array.from({ length: 100 }, (_, i) => ({ sku: `ford-${i}`, product: { title: 'Ford' } })), total: 102, next: 'next' }
        : { inventoryItems: [{ sku: 'custom/sku', product: { title: 'Hyundai Mirror' } }, { sku: 'no-US-offer', product: { title: 'Hyundai Glass' } }], total: 102 };
    },
    async offers(sku) { lookups.push(sku); return sku === 'no-US-offer' ? [] : [{ status: 'PUBLISHED', pricingSummary: { price: { value: '12.34' } }, availableQuantity: 0 }]; }
  };
  const ebay = new Ebay({ config: () => ({ environment: 'sandbox' }) }, () => api);
  const items = await ebay.searchProducts({ searchText: 'HYUNDAI' });
  assert.deepEqual(offsets, [0, 100]); assert.deepEqual(lookups, ['custom/sku', 'no-US-offer']);
  assert.deepEqual(items, [{ id: 'custom/sku', name: 'Hyundai Mirror', price: '12.34', stock: '0', description: '', status: 'PUBLISHED' }]);
  api.offers = async () => { throw new Error('Expired credentials'); };
  await assert.rejects(ebay.searchProducts({ searchText: 'hyundai' }), /Expired credentials/);
});

test('common search supports blank lists, multiword names, codes and ASINs', () => {
  const item = { id: 'OPT-B104', name: 'Hyundai Mirror', brand: 'Optic', asin: 'B000000001' };
  assert.ok(matchesProduct(item));
  assert.ok(matchesProduct(item, { brand: 'optic', model: 'hyundai' }));
  assert.ok(matchesProduct(item, { code: 'B104', brand: 'Ford' }));
  assert.ok(matchesProduct(item, { searchText: 'B000000001' }));
  assert.equal(matchesProduct(item, { searchText: 'Hyundai Ford' }), false);
});
