// 상품 일괄 수정 — 아임웹 네 범위(B2B · 본사 한국/미국/일본)를 Open API 로 읽고 쓴다(imweb_bulk.js).
// 예전에는 '차량 카탈로그 참조 · API 연동 전'으로 읽기만 했다. 네트워크 대신 가짜 본사몰 · B2B몰을 쓴다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerBulkPriceIPC } from '../src/bulk_price_ipc.js';
import { createImwebBulk } from '../src/imweb_bulk.js';
import { imwebCatalogRows, readVehicleCatalog } from '../src/utils/imweb_catalog.js';

const catalog = { _built: '2026-09-23', variants: [
  { brand: '혼다', model: '시빅', modelEn: 'Civic', gen: '1세대', no: '1252', year: '2020~', code: 'FK', skus: ['HONDA-1'] },
  { brand: '현대', model: '쏘나타', no: 'H101', skus: [] }
], listings: [
  { sku: 'HONDA-1', brandEn: 'Honda', modelEn: 'Civic', priceUsd: 109.32 },
  { sku: 'BMW-1', brandEn: 'BMW', modelEn: 'X5', priceUsd: 120, no: '101' }
], coupang: [{ id: 'not-an-imweb-id', name: 'not an Imweb row' }] };

// 가짜 사이트: units = [{unitCode, currency}], products = { 번호: { [unitCode]: { name, price, content, options:[{code, price, status, names}] } } }
function fakeSite(units, products) {
  const calls = [];
  const get = (no, unit) => {
    const p = products[no]?.[unit];
    if (!p) throw Object.assign(new Error('없는 상품'), { status: 404, errorCode: '30006' });
    return p;
  };
  return {
    calls, store: products,
    siteInfo: async () => ({ unitList: units }),
    products: async unit => Object.entries(products).filter(([, p]) => p[unit]).map(([no, p]) =>
      ({ prodNo: Number(no), name: p[unit].name, price: p[unit].price, productImages: ['https://cdn/' + no + '.jpg'], prodStatus: 'sale' })),
    product: async (no, unit) => { const p = get(no, unit); return { prodNo: Number(no), name: p.name, price: p.price, content: p.content, productImages: ['https://cdn/' + no + '.jpg'] }; },
    optionDetails: async (no, unit) => (get(no, unit).options || []).map(o => ({ optionDetailCode: o.code, price: o.price, status: o.status || 'SALE', stock: 0,
      optionDetailInfoList: o.names.map(n => ({ optionCode: 'o', name: 'n', optionValue: { optionValueCode: 'v', optionValueName: n } })) })),
    setPrice: async (no, unit, price) => { calls.push(['setPrice', String(no), unit, price]); get(no, unit).price = price; },
    setOptionPrice: async (no, code, unit, price) => { calls.push(['setOption', String(no), code, unit, price]); get(no, unit).options.find(o => o.code === code).price = price; },
    request: async (method, path, { form } = {}) => {
      const m = path.match(/^\/products\/(\d+)$/);
      if (method !== 'PATCH' || !m) throw new Error('예상하지 못한 요청 ' + method + ' ' + path);
      const unit = form.get('unitCode'), description = form.get('description');
      calls.push(['description', m[1], unit]);
      get(m[1], unit).content = description;
      return { data: true };
    },
  };
}
const HEAD_UNITS = [{ unitCode: 'uKR', currency: 'KRW' }, { unitCode: 'uUS', currency: 'USD' }, { unitCode: 'uJP', currency: 'JPY' }];
const mirror = () => ({
  uKR: { name: '와이드/광각미러', price: 80000, content: '<p><img src="https://img/k1.jpg"><img src="https://img/k2.jpg"></p>',
    options: [{ code: 'od1', price: 80000, names: ['BSA 없음', '운전석'] }, { code: 'od2', price: 115000, names: ['BSA 있음', '운전석'] }] },
  uUS: { name: 'Wide View Side Mirror', price: 58, content: '<p><img src="https://img/e1.jpg"></p>',
    options: [{ code: 'od1', price: 58, names: ['No BSA', 'Left'] }, { code: 'od2', price: 84, names: ['With BSA', 'Left'], status: 'HIDDEN' }] },
  uJP: { name: '広角ドアミラー', price: 9300, content: '', options: [] },
});
function fixture() {
  const head = fakeSite(HEAD_UNITS, { 3: mirror() });
  const b2b = fakeSite([{ unitCode: 'uB', currency: 'KRW' }], { 712: { uB: { name: '옵틱글래스 쌍용 렉스턴W 미러 1셋 [Y111]', price: 150000,
    content: '<p><img src="https://img/b1.jpg"></p>', options: [{ code: 'odX', price: 150000, names: ['렉스턴W', 'BSA X'] }, { code: 'odO', price: 170000, names: ['렉스턴W', 'BSA O'] }] } } });
  const handlers = {};
  registerBulkPriceIPC({ ipcMain: { handle: (name, fn) => handlers[name] = fn }, readCatalog: () => structuredClone(catalog),
    imwebBulk: createImwebBulk({ clientFor: site => site === 'b2b' ? b2b : head }),
    inspectImages: async () => true, sleep: async () => {}, log: { error() {} } });
  return { head, b2b, call: (channel, input) => handlers[channel](null, input) };
}

test('목록: 범위마다 그 사이트 · 구역의 실제 상품 — 이름 · 기본 판매가 · 통화', async () => {
  const { call } = fixture();
  const cases = { 'imweb-ko': ['와이드/광각미러', '80000', 'KRW'], 'imweb-en': ['Wide View Side Mirror', '58', 'USD'],
    'imweb-jp': ['広角ドアミラー', '9300', 'JPY'], 'imweb-b2b': ['옵틱글래스 쌍용 렉스턴W 미러 1셋 [Y111]', '150000', 'KRW'] };
  for (const [scope, [name, price, currency]] of Object.entries(cases)) {
    const res = await call('bulk-price-list', { scope });
    assert.equal(res.success, true, res.error);
    const [row] = res.data.items;
    assert.deepEqual([row.name, row.price, row.currency, row.ready, row.catalogOnly], [name, price, currency, false, undefined], scope);
    assert.match(res.data.note, /Open API/);
  }
  assert.equal((await call('bulk-price-list', { scope: 'imweb-ko', query: '광각' })).data.items.length, 1);
  assert.equal((await call('bulk-price-list', { scope: 'imweb-ko', query: '없는상품' })).data.items.length, 0);
});

test('현재가: 기본 판매가 한 줄 + 조합마다 한 줄(조합가는 최종가), 숨김 조합은 표시, 이미지 상태 포함', async () => {
  const { call } = fixture();
  const res = await call('bulk-price-load', { scope: 'imweb-en', id: '3', includeImages: true });
  assert.equal(res.success, true, res.error);
  assert.deepEqual(res.data.map(r => [r.optionId, r.price, r.variant]), [
    ['', '58', '기본 판매가 (조합 가격은 아래 줄)'],
    ['od1', '58', '조합 · No BSA / Left'],
    ['od2', '84', '조합 · With BSA / Left · 숨김'],
  ]);
  assert.deepEqual(res.data[0].images, ['https://img/e1.jpg']);
  assert.ok(res.data[0].imageRevision);
  const jp = await call('bulk-price-load', { scope: 'imweb-jp', id: '3' });
  assert.deepEqual(jp.data.map(r => [r.optionId, r.variant]), [['', '기본 판매가']], '조합이 없으면 기본 판매가 한 줄');
});

test('저장: 기본 판매가 · 조합 가격을 그 구역에만 보내고 다시 읽어 확인한다', async () => {
  const { call, head } = fixture();
  const base = await call('bulk-price-save', { scope: 'imweb-en', id: '3', optionId: '', expectedPrice: '58', newPrice: '59' });
  assert.deepEqual([base.success, base.data?.status], [true, 'VERIFIED'], base.error);
  const combo = await call('bulk-price-save', { scope: 'imweb-en', id: '3', optionId: 'od2', expectedPrice: '84', newPrice: '85.5' });
  assert.deepEqual([combo.success, combo.data?.status], [true, 'VERIFIED'], combo.error);
  assert.deepEqual(head.calls, [['setPrice', '3', 'uUS', 59], ['setOption', '3', 'od2', 'uUS', 85.5]]);
  assert.deepEqual([head.store[3].uKR.price, head.store[3].uKR.options[1].price], [80000, 115000], '다른 구역(한국)은 그대로');
  const b2b = await call('bulk-price-save', { scope: 'imweb-b2b', id: '712', optionId: 'odO', expectedPrice: '170000', newPrice: '175000' });
  assert.deepEqual([b2b.success, b2b.data?.status], [true, 'VERIFIED'], b2b.error);
});

test('저장: 불러온 뒤 바뀐 값은 보내지 않고(pre-send), 같은 값은 보내지 않는다', async () => {
  const { call, head } = fixture();
  head.store[3].uKR.price = 81000;   // 다른 곳에서 바뀜
  const stale = await call('bulk-price-save', { scope: 'imweb-ko', id: '3', optionId: '', expectedPrice: '80000', newPrice: '82000' });
  assert.deepEqual([stale.success, stale.stage], [false, 'pre-send']);
  assert.match(stale.error, /불러온 뒤 판매가가 바뀌었습니다\(지금 81000\)/);
  const same = await call('bulk-price-save', { scope: 'imweb-ko', id: '3', optionId: 'od1', expectedPrice: '80000', newPrice: '80000' });
  assert.deepEqual([same.success, same.data?.status], [true, 'UNCHANGED']);
  assert.equal(head.calls.length, 0, '아무것도 보내지 않았다');
  const gone = await call('bulk-price-save', { scope: 'imweb-ko', id: '3', optionId: 'od9', expectedPrice: '1', newPrice: '2' });
  assert.deepEqual([gone.success, gone.stage], [false, 'pre-send']);
  assert.match(gone.error, /조합 od9 을 찾지 못했습니다/);
});

test('상세 이미지: 그 구역 상세설명의 이미지를 불러와 바꾸고(자리 유지) 다시 읽어 확인한다', async () => {
  const { call, head } = fixture();
  const loaded = await call('bulk-images-load', { scope: 'imweb-ko', id: '3' });
  assert.deepEqual(loaded.data.images, ['https://img/k1.jpg', 'https://img/k2.jpg']);
  const saved = await call('bulk-images-save', { scope: 'imweb-ko', id: '3', urls: ['https://ai.esmplus.com/n1.jpg'], expectedRevision: loaded.data.revision });
  assert.deepEqual([saved.success, saved.data?.status], [true, 'VERIFIED'], saved.error);
  assert.equal(head.store[3].uKR.content, '<p><img src="https://ai.esmplus.com/n1.jpg"></p>');
  assert.equal(head.store[3].uUS.content, '<p><img src="https://img/e1.jpg"></p>', '다른 구역은 그대로');
  assert.deepEqual(head.calls, [['description', '3', 'uKR']]);
});

test('카탈로그 행(상품 표준 표기용): SKU · 차종 검색, 값이 갈리는 USD 는 모름으로 둔다', () => {
  const rows = imwebCatalogRows(catalog, 'imweb-en');
  assert.equal(rows.filter(r => [r.name, r.sku, r.variant].join(' ').includes('HONDA-1')).length, 1);
  const changed = structuredClone(catalog);
  changed.listings.push({ ...changed.listings[0], priceUsd: 999 });
  assert.equal(imwebCatalogRows(changed, 'imweb-en')[0].catalogPriceUsd, '');
  const reversed = { ...catalog, variants: [...catalog.variants].reverse() };
  assert.equal(imwebCatalogRows(reversed, 'imweb-en')[1].id, imwebCatalogRows(catalog, 'imweb-en')[0].id);
});

test('번들 카탈로그: 쿠팡 ID 없이 겹치지 않는 행을 만든다', () => {
  const data = readVehicleCatalog(), rows = imwebCatalogRows(data, 'imweb-en');
  assert.ok(rows.length >= 900);
  assert.equal(new Set(rows.map(r => r.id)).size, rows.length);
  assert.ok(rows.every(r => r.price === '' && r.images.length === 0 && r.id.startsWith('catalog:')));
});
