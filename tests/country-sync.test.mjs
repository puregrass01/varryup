import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { referencePrices, pickPrice, countryPrice, countryTargets, productPageUrl, editionOf } from '../src/utils/country_sync.js';
import { productIdentity } from '../src/utils/product_identity.js';
import { registerBulkPriceIPC } from '../src/bulk_price_ipc.js';

const imwebRows = variants => [{ id: '2097', optionId: '', variant: '기본 판매가 (조합 가격은 아래 줄)', price: 150000, name: '옵틱글래스 BMW X5 광각미러 [No.101]' },
  ...variants.map(([variant, price], i) => ({ id: '2097', optionId: 'od' + i, variant: '조합 · ' + variant, price }))];

test('판: 조합 문구(값만 이은 optionTextOf)의 번역된 BSA 값을 읽고, hasBsa 가 BSA 로 읽는 No BSA · なし 는 일반판이다', () => {
  assert.equal(editionOf('조합 · BSA 있음 / 1set'), true);
  assert.equal(editionOf('조합 · BSA 없음 / 1set'), false);
  assert.equal(editionOf('조합 · No BSA / 1set'), false);
  assert.equal(editionOf('조합 · With BSA / 1set (Left + Right)'), true);
  assert.equal(editionOf('조합 · なし / 1セット(左右)'), false);
  assert.equal(editionOf('조합 · あり / 1セット(左右) · 품절'), true);
  assert.equal(editionOf('BSA(後側方警戒システム)の有無=あり / セット内容=1セット(左右)'), true);
  assert.equal(editionOf('조합 · 1set'), null);
});

test('기준가: 1set · 운전석 조합가를 판별로 읽고, 조수석과 기본가는 쓰지 않는다', () => {
  const { set, left } = referencePrices(imwebRows([['BSA 없음 / 1set', 110000], ['BSA 없음 / 운전석', 60000], ['BSA 없음 / 조수석', 50000],
    ['BSA 있음 / 1set', 160000]]));
  assert.deepEqual([...set], [[false, '110000'], [true, '160000']]);
  assert.deepEqual([...left], [[false, '60000']]);
  assert.deepEqual([...referencePrices(imwebRows([['なし / 1セット(左右)', 15000], ['あり / 1セット(左右)', 22000]])).set], [[false, '15000'], [true, '22000']]);
  assert.deepEqual([...referencePrices([{ id: '1', optionId: '', price: 99000 }]).set], [[null, '99000']]);
  assert.equal(referencePrices(imwebRows([['조수석', 70000]])).error, '1set · 운전석 조합가 없음');
  assert.match(referencePrices(imwebRows([['1set', 1], ['1세트(운전석+조수석)', 2]])).error, /둘 이상/);
});

test('판에 맞는 값: 판을 모르면 기준가가 하나일 때만, BSA판은 BSA 기준가가 있어야 한다', () => {
  const both = new Map([[false, '110000'], [true, '160000']]), plain = new Map([[null, '150000']]);
  assert.deepEqual(pickPrice(both, true), { price: '160000' });
  assert.deepEqual(pickPrice(both, false), { price: '110000' });
  assert.match(pickPrice(both, null).skip, /BSA판인지 몰라/);
  assert.deepEqual(pickPrice(plain, false), { price: '150000' });
  assert.deepEqual(pickPrice(plain, null), { price: '150000' });
  assert.match(pickPrice(plain, true).skip, /BSA판 1set 가격이 없음/);
  assert.match(pickPrice(new Map(), false, '운전석').skip, /운전석 조합가가 없음/);
});

test('대상 행: 네이버는 운전석가를 번호 · 판이 하나일 때만, 쿠팡은 10원 단위, 번호가 다르면 넣지 않는다', () => {
  const ref = { no: '101', set: new Map([[false, '110000'], [true, '160000']]), left: new Map([[false, '60000']]) };
  const row = (scope, extra) => { const r = { scope, id: '1', name: '', ...extra }; return { ...r, identity: productIdentity(r) }; };
  // 네이버는 한쪽씩 판다(운전석 +0 · 조수석 −10000) — 기본 판매가는 1set 이 아니라 운전석가다.
  assert.deepEqual(countryPrice('naver', row('naver', { optionTexts: ['BMW X5 [No.101] 운전석', 'BMW X5 [No.101] 조수석'] }), ref), { price: '60000', basis: '운전석' });
  assert.match(countryPrice('naver', row('naver', { optionTexts: ['[No.101] BSA 운전석'] }), ref).skip, /BSA판 운전석 가격이 없음/);
  assert.match(countryPrice('naver', row('naver', { optionTexts: ['[No.101] 운전석', '[No.101] BSA 운전석'] }), ref).skip, /여럿/);
  assert.match(countryPrice('naver', row('naver', { optionTexts: ['[No.105] 운전석'] }), ref).skip, /번호가 다름/);
  assert.deepEqual(countryPrice('coupang', row('coupang', { optionId: '9', variant: '1개 No.101-1세대 BSA' }), ref), { price: '160000', basis: '1set' });
  assert.match(countryPrice('coupang', row('coupang', { optionId: '9', variant: 'No.101' }), { no: '101', set: new Map([[null, '110005']]) }).skip, /10원/);
  // SKU 행(아마존 · eBay)은 판을 모른다 → 인덱스(카탈로그)가 준 판, 없으면 상품명.
  assert.equal(countryPrice('amazon-us', row('amazon-us', { id: 'OBM0103N101', sku: 'OBM0103N101', name: 'Mirror' }), ref, { bsa: true }).price, '160000');
  assert.equal(countryPrice('ebay', row('ebay', { id: 'X', name: 'Mirror (BSA)' }), ref).price, '160000');
  assert.match(countryPrice('ebay', row('ebay', { id: 'X', name: 'Mirror' }), ref).skip, /BSA판인지 몰라/);
});

test('인덱스: 기준 상품번호의 코드표 행들을 모아 중복을 빼고, 다른 본사 상품과 함께 쓰는 대상 상품을 알린다', () => {
  const index = { products: { 2097: { via: 'index', no: '101', rows: ['2', '3'] }, 2154: { via: 'sheet', no: '1505', rows: ['562'] } },
    rows: { 2: { naver: [['10', '20']], coupang: [['30', '40', false]], skus: [['S1', null]] },
      3: { naver: [['10', '20']], coupang: [['30', '41', true]], skus: [['S2', true]] }, 562: { naver: [], coupang: [['30', '42', false]], skus: [] } } };
  const out = countryTargets(index, ['2097', 2154, '9']);
  assert.deepEqual(out['2097'], { via: 'index', no: '101', naver: [['10', '20']], coupang: [['30', '40', false], ['30', '41', true]], skus: [['S1', null], ['S2', true]],
    shared: { naver: [], coupang: ['30'] } });   // 쿠팡 30 은 2154(다른 차)도 가리킨다, 네이버 10 은 2097 의 두 행뿐
  assert.equal(out['2154'].via, 'sheet');
  assert.match(out['9'].missing, /없음/);
});

test('판매 페이지: 번호 모양이 맞을 때만 고정된 주소로 만들고, 아임웹 영문 · 일본은 링크가 없다', () => {
  assert.equal(productPageUrl({ scope: 'naver', id: '13733473928', channelProductNo: '13794583522' }), 'https://smartstore.naver.com/b-store/products/13794583522');
  assert.equal(productPageUrl({ scope: 'naver', id: '13733473928' }), '');
  // 검색 맥락 없이 바로 들어가면 막히는 상품이 있다(볼보 EX90) — verimap_match.mjs 처럼 q · sourceType · rank 를 붙인다.
  assert.equal(productPageUrl({ scope: 'coupang', id: '1', optionId: '96156700263', displayProductId: '9768389140', name: '옵틱글래스 볼보 EX90' }),
    'https://www.coupang.com/vp/products/9768389140?vendorItemId=96156700263&q=%EC%98%B5%ED%8B%B1%EA%B8%80%EB%9E%98%EC%8A%A4+%EB%B3%BC%EB%B3%B4+EX90&sourceType=search&rank=0&itemsCount=1&searchRank=0');
  assert.match(productPageUrl({ scope: 'coupang', id: '1', optionId: 'item-3', displayProductId: '9768389140' }), /^https:\/\/www\.coupang\.com\/vp\/products\/9768389140\?q=&sourceType=search/);
  assert.equal(productPageUrl({ scope: 'coupang', id: '1', displayProductId: '9768389140&x=1' }), '');
  assert.equal(productPageUrl({ scope: 'amazon-jp', id: 'SKU', asin: 'B0DFFS59CQ' }), 'https://www.amazon.co.jp/dp/B0DFFS59CQ');
  assert.equal(productPageUrl({ scope: 'amazon-us', id: 'SKU', asin: 'javascript:x' }), '');
  assert.equal(productPageUrl({ scope: 'ebay', id: 'SKU', listingId: '123456789012' }), 'https://www.ebay.com/itm/123456789012');
  assert.equal(productPageUrl({ scope: 'imweb-ko', id: '1096' }), 'https://optic-glass.co.kr/shop_view/?idx=1096');
  assert.equal(productPageUrl({ scope: 'imweb-b2b', id: '927' }), 'https://bb-store.co.kr/shop_view?idx=927');
  assert.equal(productPageUrl({ scope: 'imweb-en', id: '1096' }), '');
  assert.equal(productPageUrl({ scope: 'imweb-ko', id: '../x' }), '');
});

test('country-sync-targets: 인덱스 파일만 읽고, 파일이 없으면 만드는 방법을 알린다', () => {
  const handlers = {}, index = { products: { 1: { via: 'index', no: '101', rows: ['2'] } }, rows: { 2: { naver: [['10', '20']], coupang: [], skus: [] } } };
  registerBulkPriceIPC({ ipcMain: { handle: (name, fn) => { handlers[name] = fn; } }, readCountryIndex: () => index, log: { error() {} } });
  assert.deepEqual(handlers['country-sync-targets'](null, { ids: ['1'] }).data['1'].naver, [['10', '20']]);
  const broken = {};
  registerBulkPriceIPC({ ipcMain: { handle: (name, fn) => { broken[name] = fn; } }, readCountryIndex: () => { throw new Error('ENOENT'); }, log: { error() {} } });
  const res = broken['country-sync-targets'](null, { ids: ['1'] });
  assert.equal(res.success, false);
  assert.match(res.error, /build_country_index/);
});

test('배포본 인덱스: 본사몰 상품이 코드표 행을 가리키고, 행마다 네이버 · 쿠팡 · SKU 칸이 있다', () => {
  const index = JSON.parse(fs.readFileSync(new URL('../data/country_index.json', import.meta.url), 'utf8'));
  const products = Object.entries(index.products);
  assert.ok(products.length > 1000);
  for (const [id, p] of products) {
    assert.match(id, /^\d+$/);
    assert.ok(['index', 'sheet'].includes(p.via));
    for (const row of p.rows) assert.ok(index.rows[row], `${id} → 코드표 행 ${row}`);
  }
  for (const r of Object.values(index.rows)) {
    for (const [origin, channel] of r.naver) assert.match(origin + channel, /^\d+$/);
    for (const [id, option, bsa] of r.coupang) { assert.match(id + option, /^\d+$/); assert.equal(typeof bsa, 'boolean'); }
  }
});
