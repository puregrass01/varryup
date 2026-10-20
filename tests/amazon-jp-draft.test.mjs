// 아마존 일본 등록 초안 CSV(src/amazon_jp_draft.js) 회귀 테스트 — `npm test` 에 자동으로 포함된다.
//
// 지키려는 것
//   · 일본어 표기는 셸과 같은 정규화 사전 경로(vu-suggest.js + vehicle_i18n.json)에서만 나온다.
//     사전에 없으면 지어내지 않고 비운 뒤 '확인 필요' 에 적는다.
//   · 브랜드는 늘 OGWM — 차량 제조사나 'Optic Glass' 가 브랜드로 나가면 안 된다.
//   · 엔화는 환율 자동 변경과 같은 등급 규칙(기준가 ÷ 환율, 앞 두 자리)이다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadVehicleNames, buildJpDraft, draftCsv, jpTitle, JP_TITLE_MAX } from '../src/amazon_jp_draft.js';

const names = { brands: { '현대': { ko: '현대', en: 'Hyundai', jp: 'ヒュンダイ' }, 'BMW': { ko: 'BMW', en: 'BMW', jp: 'BMW' },
    '캐딜락': { ko: '캐딜락', en: 'Cadillac', jp: 'キャデラック' }, '기타': { ko: '기타', en: 'Others', jp: 'その他' } },
  aliases: {}, generationTokens: { '세대': '世代', '현재': '現在', '전기형': '前期型' },
  models: { '현대': { '그랜저': { ko: '그랜저', en: 'GRANDEUR', jp: 'グレンジャー' }, '없는일어': { ko: '없는일어', en: 'NOJA', jp: null } },
    'BMW': { 'X5': { ko: 'X5', en: 'X5', jp: 'X5' } },
    '캐딜락': { 'ATS-V': { ko: 'ATS-V', en: 'ATS-V', jp: 'ATS-V' } },
    '기타': { '마쯔다 CX-9': { ko: '마쯔다 CX-9', en: 'Mazda CX-9', jp: 'マツダ CX-9' } } },
  generations: {} };
const catalog = {
  variants: [
    { brand: '현대', model: '그랜저', gen: '7세대', year: '22.11~현재', code: 'GN7', no: '135', skus: ['HY0101N135', 'HY0101N1351'] },
    { brand: '현대', model: '없는일어', gen: '1세대', year: '20~', code: 'X1', no: '200', skus: ['HY0201N200'] },
    { brand: '기타', model: '마쯔다 CX-9', gen: '2세대', year: '16.10~19.07', code: 'TC', no: '5002', skus: ['MA0101N5002'] },
    { brand: '현대', model: '그랜저 -B', gen: '6세대', year: '16.11~19.11', code: 'IG (하단 둥근 타입)', no: '140', skus: ['HY0102N140'] },
    { brand: '캐딜락', model: 'ATS-V', gen: '1세대', year: '16~', code: 'CU/CP / 브라켓이 2종류', no: '501', skus: ['CD0101N501'] },
    // 같은 차에 미러가 둘(품번 705·778) — 카탈로그만으로는 제목이 같아진다
    { brand: '현대', model: '그랜저', gen: '5세대', year: '11~16', code: 'HG', no: '705', skus: ['HY0103N705', 'HY0105N705'] },
    { brand: '현대', model: '그랜저', gen: '5세대', year: '11~16', code: 'HG', no: '778', skus: ['HY0104N778'] },
  ],
  listings: [
    { brandEn: 'Hyundai', modelEn: 'Grandeur', yearText: '7th gen', sku: 'HY0101N135', priceUsd: 109.32, bsa: false, no: '135' },
    { brandEn: 'Hyundai', modelEn: 'Grandeur', yearText: '7th gen BSA', sku: 'HY0101N1351', priceUsd: 160, bsa: true, no: '135' },
    { brandEn: 'BMW', modelEn: 'X5', yearText: '4th gen 18- BSA', sku: 'OBM0901N300', priceUsd: 160, bsa: true, no: '300' },
  ],
};
const snapshot = { base: 'USD', rates: { KRW: 1400, JPY: 150, USD: 1 }, marketDate: '2026-10-05',
  fetchedAt: new Date().toISOString(), stale: false };
const fx = { tiers: [{ id: 'tier-1', label: '일반 미러', krw: 150000 }, { id: 'tier-2', label: 'BSA 미러', krw: 220000 }], assignments: {} };
const draft = items => buildJpDraft({ items, names: loadVehicleNames({ names, catalog }), fx, snapshot });
const row = (rows, sku) => rows.find(r => r.sku === sku);

test('카탈로그 행에 이어진 SKU 는 사전의 일본어로 제목을 만들고 브랜드는 OGWM 이다', () => {
  const { rows } = draft([{ id: 'HY0101N135', asin: 'B0TEST', price: '109.32', stock: '10' }]);
  const r = row(rows, 'HY0101N135');
  assert.equal(r.brand, 'OGWM');
  assert.equal(r.makerJa, 'ヒュンダイ');
  assert.equal(r.modelJa, 'グレンジャー');
  assert.equal(r.genJa, '7世代');
  assert.equal(r.year, '22.11~現在', '연식의 한글 낱말도 사전 토큰으로 옮긴다');
  assert.match(r.title, /^OGWM ヒュンダイ グレンジャー 7世代 22\.11~現在 GN7 用 広角ドアミラーガラス 交換用/);
  assert.doesNotMatch(r.title, /BSA|No\./, '제목이 겹치지 않으면 품번을 넣지 않는다');
  assert.equal(r.notes, '');
  assert.equal(r.bullets.length, 5);
  assert.ok(r.bullets.every(Boolean));
});

test('BSA SKU 는 제목·불릿·하이라이트로 일반 SKU 와 갈린다', () => {
  const { rows } = draft([{ id: 'HY0101N135', price: '109.32' }, { id: 'HY0101N1351', price: '160' }]);
  const plain = row(rows, 'HY0101N135'), bsa = row(rows, 'HY0101N1351');
  assert.match(bsa.title, /BSA対応/);
  assert.notEqual(plain.title, bsa.title);
  assert.match(bsa.bullets[4], /^BSA対応/);
  assert.doesNotMatch(plain.bullets[4], /BSA/);
  assert.match(bsa.highlight, /BSA/);
  assert.match(bsa.description, /BSA/);
  assert.doesNotMatch(plain.description, /BSA/, '일반 SKU 설명에 BSA 문장이 있으면 BSA 가 들어 있는 줄로 읽힌다');
});

test('기타 브랜드는 その他 없이 차종 칸의 제조사로 제목을 시작한다', () => {
  const { rows } = draft([{ id: 'MA0101N5002', price: '110' }]);
  assert.match(rows[0].title, /^OGWM マツダ CX-9 2世代 16\.10~19\.07 TC 用/);
  assert.doesNotMatch(rows[0].title, /その他/);
  assert.equal(rows[0].notes, '');
});

test('코드표 꼬리표(-B)는 떼고 사전을 찾되 ATS-V 같은 차종명은 그대로 둔다', () => {
  const { rows } = draft([{ id: 'HY0102N140', price: '110' }, { id: 'CD0101N501', price: '110' }]);
  assert.equal(row(rows, 'HY0102N140').modelJa, 'グレンジャー');
  assert.equal(row(rows, 'CD0101N501').modelJa, 'ATS-V');
});

test('차량코드의 한글 메모는 지어내지 않고 빼고, 원문을 확인 필요에 남긴다', () => {
  const { rows } = draft([{ id: 'HY0102N140', price: '110' }, { id: 'CD0101N501', price: '110' }]);
  const round = row(rows, 'HY0102N140'), bracket = row(rows, 'CD0101N501');
  assert.equal(round.code, 'IG');
  assert.equal(bracket.code, 'CU/CP');
  for (const r of [round, bracket]) assert.doesNotMatch(r.title, /[가-힣]/);
  assert.match(round.notes, /차량코드 한글 메모 뺌: IG \(하단 둥근 타입\)/);
  assert.match(bracket.notes, /차량코드 한글 메모 뺌: CU\/CP \/ 브라켓이 2종류/);
});

test('같은 제목이 되는 SKU 는 미국 상품명의 품번으로 가르고, 품번도 같으면 확인 필요에 적는다', () => {
  const { rows } = draft([
    { id: 'HY0103N705', price: '110', name: 'Mirror for Hyundai Grandeur (5th gen 11~16 [No.705])' },
    { id: 'HY0104N778', price: '110', name: 'Mirror for Hyundai Grandeur (5th gen 11~16 [No.778])' },
  ]);
  assert.match(row(rows, 'HY0103N705').title, / 交換用 No\.705 /);
  assert.match(row(rows, 'HY0104N778').title, / 交換用 No\.778 /);
  assert.equal(row(rows, 'HY0103N705').notes, '');
  // 미국 상품명에 품번이 없으면 카탈로그 no 를 쓴다 — 한 행에 묶인 두 SKU 는 품번도 같아 못 가른다
  const same = draft([{ id: 'HY0103N705', price: '110' }, { id: 'HY0105N705', price: '110' }]).rows;
  assert.equal(same[0].title, same[1].title);
  assert.doesNotMatch(same[0].title, /No\./, '가르지 못하는 품번은 넣지 않는다(꾸밈말 자리만 먹는다)');
  assert.match(same[0].notes, /같은 상품명 2건/);
});

test('사전에 일본어가 없으면 지어내지 않고 비운 뒤 확인 필요에 적는다', () => {
  const { rows } = draft([{ id: 'HY0201N200', price: '109.32' }, { id: 'ZZ-UNKNOWN', price: '50' }]);
  const missing = row(rows, 'HY0201N200');
  assert.equal(missing.title, '');
  assert.equal(missing.modelJa, '');
  assert.match(missing.notes, /차종 일본어 없음/);
  const unknown = row(rows, 'ZZ-UNKNOWN');
  assert.equal(unknown.title, '');
  assert.match(unknown.notes, /카탈로그에 없는 SKU/);
  assert.equal(unknown.productType, '');
});

test('카탈로그 행이 없으면 영문 표기로 같은 사전을 거꾸로 찾고 세대는 사전 토큰을 쓴다', () => {
  const { rows } = draft([{ id: 'OBM0901N300', price: '160' }]);
  const r = row(rows, 'OBM0901N300');
  assert.equal(r.source, '영문 역조회');
  assert.equal(r.makerJa, 'BMW');
  assert.equal(r.genJa, '4世代');
  assert.equal(r.year, '18-');
  assert.match(r.title, /^OGWM BMW X5 4世代 18- 用 .*BSA対応/);
  assert.match(r.notes, /차량코드 없음/);
});

test('엔화는 등급 기준가 ÷ 환율의 앞 두 자리다', () => {
  const { rows } = draft([{ id: 'HY0101N135', price: '109.32' }, { id: 'HY0101N1351', price: '160' }]);
  // 150,000원 ÷ 1,400 × 150 = 16,071엔 → 16,000 · 109.32 USD × 1,400 = 153,048원 → 일반 미러 등급
  assert.equal(row(rows, 'HY0101N135').jpy, '16000');
  // 160 USD × 1,400 = 224,000원 → BSA 미러 등급 220,000원 → 23,571엔 → 23,000
  assert.equal(row(rows, 'HY0101N1351').jpy, '23000');
});

test('환율이 없으면 엔화를 비우고 이유를 남긴다', () => {
  const { rows } = buildJpDraft({ items: [{ id: 'HY0101N135', price: '109.32' }], names: loadVehicleNames({ names, catalog }), fx, snapshot: null });
  assert.equal(rows[0].jpy, '');
  assert.match(rows[0].notes, /엔화 가격/);
});

test('긴 차량명이어도 75자 안에서만 꾸밈말을 붙이고 차 부분은 줄이지 않는다', () => {
  const t = jpTitle({ brand: 'メルセデス・ベンツ', model: 'GLEクラス クーペ', gen: '2世代', year: '19.01~現在', code: 'C167', bsa: true });
  assert.ok([...t].length <= JP_TITLE_MAX, t);
  assert.match(t, /メルセデス・ベンツ GLEクラス クーペ 2世代 19\.01~現在 C167/);
});

test('CSV 는 BOM·헤더·따옴표 처리를 한다', () => {
  const { rows } = draft([{ id: 'HY0101N135', price: '109.32', name: 'He said "hi"' }]);
  const csv = draftCsv(rows);
  assert.ok(csv.startsWith('﻿"SKU"'));
  assert.match(csv, /"He said ""hi"""/);
  assert.equal(csv.split('\r\n').length, 2);
});

test('실제 사전·카탈로그로도 불러진다', () => {
  const real = loadVehicleNames();
  assert.equal(real.vu.brandJa('현대'), 'ヒョンデ');   // 2026-10-20 사용자 지정(사전 BRAND_JP_OVERRIDES)
  assert.ok((real.catalog.variants || []).length > 100);
});
