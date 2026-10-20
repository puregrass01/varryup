import test from 'node:test';
import assert from 'node:assert/strict';
import { createIdentityIndex, productIdentity, identityText } from '../src/utils/product_identity.js';
import { imwebCatalogRows, readVehicleCatalog } from '../src/utils/imweb_catalog.js';

const catalog = {
  variants: [{ brand: 'BMW', model: '1시리즈', no: '101', bsa: 'Bsa가능', skus: ['OBM0103N101'] },
    { brand: '현대', model: '쏘나타', no: 'H103-1', bsa: '', skus: ['HY1103NH1032'] }],
  listings: [{ sku: 'OBM0101N105', no: '105', bsa: true }],
  coupang: [{ id: '16286810435', options: [
    { id: '95709886702', text: 'No.5023 - 1세대 (16~) BSA', no: '5023', bsa: true },
    { id: '95709886703', text: 'No.5024 - 2세대 (20~)', no: '5024', bsa: false }] }],
};
const index = createIdentityIndex(catalog);
const text = row => identityText(productIdentity(row, index));

test('모든 몰이 같은 표기(No.번호 BSA)로 보인다', () => {
  // 쿠팡 옵션 행: 옵션 문구에서 읽는다 — 중복 검사 안내와 같은 'No.5023 BSA'.
  assert.equal(text({ scope: 'coupang', id: '1', optionId: '9', variant: 'No.h131번 (7세대) BSA' }).main, 'No.H131 BSA');
  // 아마존·eBay: ID 가 곧 SKU 다. SKU 는 번호 하나에 대응하지만 판(BSA)은 모른다.
  assert.deepEqual(text({ scope: 'amazon-us', id: 'obm0103n101' }), { main: 'No.101', all: 'No.101', count: 1,
    skus: 'OBM0103N101', search: 'No.101 101 OBM0103N101' });
  // SKU 끝자리로 번호를 짐작하지 않는다(HY1103NH1032 는 H1032 가 아니라 H103-1).
  assert.equal(text({ scope: 'ebay', id: 'HY1103NH1032' }).main, 'No.H103-1');
  // 네이버 원상품은 옵션이 여럿이다.
  const naver = text({ scope: 'naver', id: '77', variant: '기본 판매가 · 옵션 추가금 유지',
    optionTexts: ['No.101번 (2세대)', 'No.105번 (1세대) BSA', '색상 선택'] });
  assert.deepEqual([naver.main, naver.all, naver.count], ['No.101 외 1개', 'No.101, No.105 BSA', 2]);
});

test('쿠팡 목록 행은 스냅샷의 옵션 번호를, 옵션 행은 그 옵션만 쓴다', () => {
  assert.equal(text({ scope: 'coupang', id: '16286810435' }).all, 'No.5023 BSA, No.5024');
  assert.equal(text({ scope: 'coupang', id: '16286810435', optionId: '95709886703', variant: '색상 없음' }).main, 'No.5024');
  assert.equal(text({ scope: 'coupang', id: '16286810435', optionId: 'item-3', variant: '색상 없음' }).main, '', '모르는 옵션에 다른 옵션 번호를 붙이지 않는다');
});

test('상품명은 No. 가 붙은 번호만 읽는다', () => {
  assert.equal(text({ scope: 'naver', id: '1', name: '옵틱글래스 인피니티 Q50 광각미러' }).main, '');
  assert.equal(text({ scope: 'naver', id: '1', name: '광각미러 No.612' }).main, 'No.612');
});

test('아임웹 카탈로그: 코드표의 BSA 메모는 판이 아니다', () => {
  const rows = imwebCatalogRows({ variants: catalog.variants, listings: catalog.listings }, 'imweb-ko');
  const bmw = rows.find(r => r.sku === 'OBM0103N101'), listing = rows.find(r => r.sku === 'OBM0101N105');
  assert.equal(identityText(productIdentity(bmw, index)).main, 'No.101');
  assert.match(bmw.variant, /BSA 여부: Bsa가능/);
  assert.doesNotMatch(bmw.variant, /· BSA$/);
  assert.equal(identityText(productIdentity(listing, index)).main, 'No.105 BSA');
});

test('번들 카탈로그: 번호가 적힌 SKU 는 그 번호 하나로, 번호 칸이 빈 SKU 는 번호 미확인으로 읽힌다', () => {
  const data = readVehicleCatalog(), full = createIdentityIndex(data);
  const numbered = new Map();
  for (const v of data.variants) for (const sku of v.skus || []) if (v.no) numbered.set(sku.toUpperCase(), String(v.no).toUpperCase());
  for (const l of data.listings) if (l.sku && l.no && !numbered.has(l.sku.toUpperCase())) numbered.set(l.sku.toUpperCase(), String(l.no).toUpperCase());
  const skus = [...new Set([...data.variants.flatMap(v => v.skus || []), ...data.listings.map(l => l.sku).filter(Boolean)])];
  assert.ok(numbered.size > 800);
  for (const sku of skus) {
    const { nos } = productIdentity({ scope: 'ebay', id: sku }, full);
    // 이베이 목록에만 있고 번호 칸이 빈 SKU 는 끝자리로 짐작하지 않는다('MB0502N3391' 은 No.339).
    assert.deepEqual(nos, numbered.has(sku.toUpperCase()) ? [numbered.get(sku.toUpperCase())] : [], sku);
  }
});
