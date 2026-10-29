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

test('신규 등록 한 줄(DB 에 없는 차): 탭 · 두 칸 띄움 · 한 칸 띄움 모두 상품번호 · 차종 · 세대 · 연식 · 차량코드로 나눈다', () => {
  const f150 = { no: '1108', model: 'F150', gen: '12세대 중기형', year: '11~14', code: 'P415' };
  assert.deepEqual(vu.parseDbLine('No.1108번\tF150\t12세대 중기형\t11~14\tP415'), f150);
  assert.deepEqual(vu.parseDbLine('No.1108번   F150   12세대 중기형   11~14   P415'), f150);
  assert.deepEqual(vu.parseDbLine('No.1108번 F150 12세대 중기형 11~14 P415'), f150);
  assert.deepEqual(vu.parseDbLine('No.315번 S클래스 10세대 후기형 26년 9월~ W223 F/L'),
    { no: '315', model: 'S클래스', gen: '10세대 후기형', year: '26년 9월~', code: 'W223 F/L' });
  assert.equal(vu.parseDbLine('기아 P415'), null, 'No. 로 시작하지 않으면 검색어');
  assert.equal(vu.parseDbLine('No.K107번-2   더뉴 스포티지   3세대 전기형 (SL)   10.03-12.06   SL').no, 'K107-2', "'번' 뒤 -2 도 번호");
});

test('새 차 SKU: 제조사 2자 + 차종 2자리 + 순번 2자리 + N + 상품번호, 앞 O · 끝 1 없음, 기존 SKU 와 겹치지 않음', () => {
  assert.equal(vu.suggestSku('포드', 'F150', '1108'), 'FD0905N1108', 'F150 = FD09, 기존 01~04 다음');
  assert.equal(vu.suggestSku('BMW', '6GT', '182'), 'BM2106N182', '카탈로그에 안 이어진 6GT 도 표의 영문 차종(6GT)으로 BM21');
  assert.equal(vu.suggestSku('포드', '새차종', '999'), 'FD1601N999', '처음 나오는 차종은 그 제조사에서 안 쓴 다음 번호');
  assert.equal(vu.suggestSku('없는제조사', 'x', '1'), '', '그 제조사 SKU 가 하나도 없으면 만들지 않는다');
  assert.equal(vu.suggestSku('포드', 'F150', ''), '', '상품번호 없으면 만들지 않는다');
});

test('같은 차종 · 같은 상품번호 · 같은 BSA 의 리스팅이 이미 있으면 새 SKU 를 만들지 않는다(목록에서 고른다)', () => {
  assert.equal(vu.suggestSku('기아', 'EV3', 'K138', true), '', 'KI1501NK138(BSA) 가 있다');
  assert.equal(vu.suggestSku('혼다', '시빅', '1213', false), '', 'NH0701N1213 이 있다');
  assert.match(vu.suggestSku('기아', 'EV3', 'K138', false), /^KI15\d{2}NK138$/, 'BSA 없는 판은 아직 없다 → 새 순번');
});

test("한 칸씩 띄운 줄도 카탈로그식 연식(10.03-12.06 · 20.12-현재)으로 나눈다", () => {
  assert.deepEqual(vu.parseDbLine('No.K107번-2 더뉴 스포티지 3세대 전기형 (SL) 10.03-12.06 SL'),
    { no: 'K107-2', model: '더뉴 스포티지', gen: '3세대 전기형 (SL)', year: '10.03-12.06', code: 'SL' }, '여러 낱말 차종은 카탈로그 차종으로 맞춘다');
  assert.equal(vu.parseDbLine('No.H144번 제네시스GV70 1세대 20.12-현재 JK1').year, '20.12-현재');
});
