// 0건이 "왜" 0건인지 호출자가 구분할 수 있어야 한다. 반환 타입(배열)은 바뀌면 안 된다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Ebay } from '../src/platforms/ebay.js';
import { effectiveQuery, matchesProduct } from '../src/platforms/product_search.js';

const ebayWith = api => new Ebay({ config: () => ({ environment: 'sandbox' }) }, () => api);
const row = (sku, title) => ({ sku, product: { title } });
const offer = () => [{ status: 'PUBLISHED', pricingSummary: { price: { value: '12.34' } }, availableQuantity: 3 }];

test('계정에 Inventory 상품이 없으면 이관이 필요하다고 알린다', async () => {
  const ebay = ebayWith({ async inventoryItems() { return { inventoryItems: [], total: 0 }; }, async offers() { return []; } });
  const stats = {};
  const items = await ebay.searchProducts({}, stats);

  assert.deepEqual(items, []);
  assert.equal(stats.scanned, 0);
  assert.equal(stats.total, 0);
  assert.match(stats.reason, /bulkMigrateListing/);
});

test('검색어가 한글이면 영문으로 저장된다는 점을 짚어 준다', async () => {
  const ebay = ebayWith({
    async inventoryItems() { return { inventoryItems: [row('OPT-1', 'Hyundai Mirror'), row('OPT-2', 'Ford Glass')], total: 2 }; },
    async offers() { return offer(); }
  });
  const stats = {};
  const items = await ebay.searchProducts({ brand: '현대', model: '아반떼' }, stats);

  assert.deepEqual(items, []);
  assert.equal(stats.scanned, 2);
  assert.equal(stats.matched, 0);
  assert.match(stats.reason, /현대 아반떼/);
  assert.match(stats.reason, /한글로는 찾을 수 없습니다/);
});

test('미국 고정가 Offer 조건에서 걸러졌으면 그 건수를 밝힌다', async () => {
  const ebay = ebayWith({
    async inventoryItems() { return { inventoryItems: [row('none', 'Mirror A'), row('many', 'Mirror B')], total: 2 }; },
    async offers(sku) { return sku === 'none' ? [] : [...offer(), ...offer()]; }
  });
  const stats = {};
  const items = await ebay.searchProducts({ searchText: 'mirror' }, stats);

  assert.deepEqual(items, []);
  assert.equal(stats.matched, 2);
  assert.equal(stats.noOffer, 1);
  assert.equal(stats.multiOffer, 1);
  assert.match(stats.reason, /Offer 없음 1건, Offer 2개 이상 1건/);
});

test('결과가 있으면 사유를 남기지 않고, stats 없이 호출해도 배열을 그대로 반환한다', async () => {
  const api = {
    async inventoryItems() { return { inventoryItems: [row('OPT-1', 'Hyundai Mirror')], total: 1 }; },
    async offers() { return offer(); }
  };
  const stats = {};
  const items = await ebayWith(api).searchProducts({ searchText: 'hyundai' }, stats);

  assert.deepEqual(items, [{ id: 'OPT-1', name: 'Hyundai Mirror', price: '12.34', stock: '3', description: '', status: 'PUBLISHED' }]);
  assert.equal(stats.reason, '');
  assert.equal(stats.matched, 1);

  // 기존 호출부(main_process 통합 검색, 테스트)는 stats 없이 부른다.
  assert.deepEqual(await ebayWith(api).searchProducts({ searchText: 'hyundai' }), items);
});

test('effectiveQuery 는 matchesProduct 와 같은 우선순위를 쓴다', () => {
  assert.equal(effectiveQuery({ code: 'B104', brand: '현대', model: '아반떼' }), 'B104');
  assert.equal(effectiveQuery({ brand: '현대', model: '아반떼', searchText: '무시됨' }), '현대 아반떼');
  assert.equal(effectiveQuery({ searchText: ' mirror ' }), 'mirror');
  assert.equal(effectiveQuery(), '');
  assert.ok(matchesProduct({ id: 'B104', name: 'Mirror' }, { code: 'b104', brand: '현대' }));
  assert.equal(matchesProduct({ id: 'B104', name: 'Mirror' }, { brand: '현대' }), false);
});
