// 본사몰 상품명 → 좌측 칸(vu-suggest.js resolveTitle). 번호로 카탈로그 행을 찾고, 한 행으로 안 좁혀지면 고르지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const window = {}; window.parent = window;
const document = { addEventListener() {}, body: null, getElementById() { return null; } };
new Function('window', 'document', read('src/ui/vu-suggest.js'))(window, document);
const vu = window.VUSuggest;
vu.setCatalog(JSON.parse(read('data/imweb_categories.json')));
vu.setNames(JSON.parse(read('data/vehicle_i18n.json')));
vu.setVehicleCatalog(JSON.parse(read('data/vehicle_catalog.json')));

test('H131 은 아반떼CN7·아반떼N 이 같이 쓴다 — 상품명의 차종으로 아반떼N 하나를 고른다', () => {
  const r = vu.resolveTitle('옵틱글래스 현대 아반떼N 광각미러 [No.H131]');
  assert.equal(r.brand, '현대');
  assert.equal(r.model, '아반떼', '차종 칸은 좌측 목록의 이름');
  assert.equal(r.no, 'H131');
  assert.equal(r.variant?.model, '아반떼N');
  assert.equal(r.variant.code, 'CN7 N');
});

test('H119 넥쏘 → 1세대 · 18~ · FE', () => {
  const r = vu.resolveTitle('옵틱글래스 현대 넥쏘 광각미러 [No.H119]');
  assert.deepEqual([r.brand, r.model, r.no], ['현대', '넥쏘', 'H119']);
  assert.deepEqual([r.variant?.gen, r.variant?.year, r.variant?.code], ['1세대', '18~', 'FE']);
});

test('같은 차종의 두 세대(C클래스 No.340 전기형·후기형)는 고르지 않는다 — 브랜드·차종·번호만', () => {
  const r = vu.resolveTitle('옵틱글래스 벤츠 C클래스 (전기형) 광각미러 [No.340]');
  assert.deepEqual([r.brand, r.model, r.no], ['벤츠', 'C클래스', '340']);
  assert.equal(r.variant, null);
});

test('[No.] 가 없는 상품명은 번호도 행도 없다', () => {
  const r = vu.resolveTitle('현대 제네시스 GV80 전동 사이드스텝 Pro (기본형/LED)');
  assert.equal(r.no, '');
  assert.equal(r.variant, null);
  assert.equal(r.brand, '현대');
});

test("코드표 브랜드가 '기타' 면 상품명의 브랜드를 쓴다", () => {
  const r = vu.resolveTitle('옵틱글래스 GMC 유콘 광각미러 [No.5587]');
  assert.equal(r.brand, 'GMC');
  assert.equal(r.variant?.no, '5587');
});
