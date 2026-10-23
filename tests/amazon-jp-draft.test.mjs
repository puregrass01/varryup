// 아마존 일본 등록 초안 CSV(src/amazon_jp_draft.js) 회귀 테스트 — `npm test` 에 자동으로 포함된다.
//
// 지키려는 것
//   · 일본어 표기는 셸과 같은 정규화 사전 경로(vu-suggest.js + vehicle_i18n.json)에서만 나온다.
//     사전에 없으면 지어내지 않고 비운 뒤 '확인 필요' 에 적는다.
//   · 브랜드는 늘 OGWM — 차량 제조사나 'Optic Glass' 가 브랜드로 나가면 안 된다.
//   · 엔화는 환율 자동 변경과 같은 등급 규칙(기준가 ÷ 환율, 앞 두 자리)이다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadVehicleNames, buildJpDraft, makeJpDraft, draftCsv, draftTsv, jpTitle, pickMainImages, JP_TITLE_MAX, UPLOAD_KEYS, UPLOAD_ROWS_MAX } from '../src/amazon_jp_draft.js';

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
// 실시간 조회에서 고른 메인 이미지가 있는 상품(이미지 칸을 따로 보는 테스트는 images 를 직접 준다)
const withImage = i => ({ images: { main: 'https://m.media-amazon.com/images/I/' + (i.sku ?? i.id) + '.jpg', others: [], checked: [] }, ...i });
const draft = items => buildJpDraft({ items: items.map(withImage), names: loadVehicleNames({ names, catalog }), fx, snapshot });
const row = (rows, sku) => rows.find(r => r.sku === sku);

test('카탈로그 행에 이어진 SKU 는 사전의 일본어로 제목을 만들고 브랜드는 OGWM 이다', () => {
  const { rows } = draft([{ id: 'HY0101N135', asin: 'B0TEST', price: '109.32', stock: '10' }]);
  const r = row(rows, 'HY0101N135');
  assert.equal(r.brand, 'OGWM');
  assert.equal(r.makerJa, 'ヒュンダイ');
  assert.equal(r.modelJa, 'グレンジャー');
  assert.equal(r.genJa, '7世代');
  assert.equal(r.year, '22.11~現在', '연식의 한글 낱말도 사전 토큰으로 옮긴다');
  assert.match(r.title, /^OGWM ヒュンダイ グレンジャー 7世代 22\.11-現在 GN7用 ヒーター付き広角ミラーガラス 左右セット$/, '연식의 ~ 는 - 로 쓴다');
  assert.match(r.bullets[0], /^適合車種：ヒュンダイ グレンジャー 7世代 22\.11-現在 GN7専用/, '첫 불릿에 차를 적는다');
  assert.match(r.description, /^ヒュンダイ グレンジャー 7世代/);
  assert.doesNotMatch(r.description, /\n/, '설명은 한 문단');
  assert.doesNotMatch([...r.bullets, r.description].join(''), /クローム|同じ機能/, '미국 리스팅에 근거 없는 주장은 쓰지 않는다');
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
  assert.match(bsa.bullets[3], /^BSA対応/);
  assert.doesNotMatch(plain.bullets.join(''), /BSA/);
  // 하이라이트는 문장이 아니라 제목에 없는 짧은 말이다
  assert.ok([...bsa.highlight].length <= 10 && !bsa.title.includes(bsa.highlight), bsa.highlight);
  assert.match(bsa.description, /BSA/);
  assert.doesNotMatch(plain.description, /BSA/, '일반 SKU 설명에 BSA 문장이 있으면 BSA 가 들어 있는 줄로 읽힌다');
});

test('기타 브랜드는 その他 없이 차종 칸의 제조사로 제목을 시작한다', () => {
  const { rows } = draft([{ id: 'MA0101N5002', price: '110' }]);
  assert.match(rows[0].title, /^OGWM マツダ CX-9 2世代 16\.10-19\.07 TC用 /);
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
  assert.match(row(rows, 'HY0103N705').title, /ガラス No\.705 /);
  assert.match(row(rows, 'HY0104N778').title, /ガラス No\.778 /);
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
  assert.match(unknown.notes, /차량을 찾지 못한 SKU/);
  assert.equal(unknown.productType, '');
});

test('카탈로그 행이 없으면 영문 표기로 같은 사전을 거꾸로 찾고 세대는 사전 토큰을 쓴다', () => {
  const { rows } = draft([{ id: 'OBM0901N300', price: '160' }]);
  const r = row(rows, 'OBM0901N300');
  assert.equal(r.source, '영문 역조회');
  assert.equal(r.makerJa, 'BMW');
  assert.equal(r.genJa, '4世代');
  assert.equal(r.year, '18-');
  assert.match(r.title, /^OGWM BMW X5 4世代 18-用 .*BSA対応/);
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
  const { rows } = buildJpDraft({ items: [withImage({ id: 'HY0101N135', price: '109.32' })], names: loadVehicleNames({ names, catalog }), fx, snapshot: null });
  assert.equal(rows[0].jpy, '');
  assert.match(rows[0].notes, /엔화 가격/);
});

test('긴 차량명이어도 75자 안에서만 꾸밈말을 붙이고 차 부분은 줄이지 않는다', () => {
  const t = jpTitle({ brand: 'メルセデス・ベンツ', model: 'GLEクラス クーペ', gen: '2世代', year: '19.01~現在', code: 'C167', bsa: true });
  assert.ok([...t].length <= JP_TITLE_MAX, t);
  assert.match(t, /メルセデス・ベンツ GLEクラス クーペ 2世代 19\.01-現在 C167用/);
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

// ── 2026-10-21: 정규화 표 + 실시간 조회 · 메인 이미지 · 업로드 TSV ──

// 정규화 표(data/amazon_listings.json) 한 줄
const norm = (sku, more = {}) => ({ sku, asin: 'B0NORM' + sku.slice(-3), parentSku: 'OGHY01', parentAsin: 'B0PARENT', maker: '현대',
  modelEn: 'Grandeur', subModel: '', gens: [7], years: '22~', chassis: 'GN7', no: '135', bsa: false,
  vehicles: [{ model: '그랜저', gen: '7세대 22.11~현재', option: 'GN7' }], issues: [], ...more });

test('정규화 표가 상품의 정본이다 — V2 차량으로 이름을 짓고, BSA·품번·부모 SKU 는 표에서 읽는다', () => {
  // 이베이 표(catalog.listings)는 HY0101N135 를 일반(bsa:false)으로 적었지만 정규화 표가 BSA 라고 하면 BSA 다
  const { rows } = draft([{ sku: 'HY0101N135', asin: 'B0NORM135', price: '160', stock: '4', live: true, listing: norm('HY0101N135', { bsa: true, no: 'K135' }) }]);
  const r = rows[0];
  assert.equal(r.source, 'V2 차량');
  assert.equal(r.bsa, true);
  assert.match(r.title, /^OGWM ヒュンダイ グレンジャー 7世代 22\.11-現在 GN7用 .*BSA対応/);
  assert.equal(r.partNo, 'K135');
  assert.equal(r.parentSku, 'OGHY01');
  assert.equal(r.stock, '4', '재고는 미국 실시간 재고 그대로');
  assert.equal(r.notes, '');
  assert.equal(r.ready, true);
});

test('실시간 조회에 없는 SKU 와 ASIN 이 다른 SKU 는 확인 필요로 남고 업로드하지 않는다', () => {
  const { rows } = draft([
    { sku: 'HY0101N135', live: false, listing: norm('HY0101N135') },
    { sku: 'HY0101N1351', asin: 'B0OTHER', price: '160', live: true, listing: norm('HY0101N1351', { bsa: true }) },
  ]);
  const gone = row(rows, 'HY0101N135'), other = row(rows, 'HY0101N1351');
  assert.match(gone.notes, /미국 리스팅 없음/);
  assert.equal(gone.ready, false);
  assert.match(other.notes, /ASIN 다름: 정규화 B0NORM351 · 미국 B0OTHER/);
  assert.equal(other.ready, false, 'ASIN 이 다르면 어느 상품인지 모른다 — 업로드하지 않는다');
});

test('정규화 표의 BSA 와 가격 등급이 어긋나면 적는다', () => {
  // 109.32 USD → 일반 미러 등급인데 표는 BSA
  const { rows } = draft([{ sku: 'HY0101N135', price: '109.32', live: true, listing: norm('HY0101N135', { bsa: true }) }]);
  assert.match(rows[0].notes, /BSA 여부\(O\)와 가격 등급\(일반 미러\) 다름/);
});

test('V2 세대 칸의 한글 메모는 제목에 넣지 않는다', () => {
  const { rows } = draft([{ sku: 'HY0101N135', price: '110', live: true,
    listing: norm('HY0101N135', { vehicles: [{ model: '그랜저', gen: '7세대 22.11~현재 (쿠페 가능)', option: 'GN7' }] }) }]);
  assert.doesNotMatch(rows[0].title, /[가-힣]/);
  assert.match(rows[0].notes, /연식 한글 메모 뺌/);
});

test('메인 이미지는 미국 이미지 순서대로 글자 없는 첫 사진 — 글자 든·판별 못 한 이미지는 추가 이미지로만', async () => {
  const verdict = { 'u/text1': true, 'u/photo': false, 'u/text2': true, 'u/null': null, 'u/shared': true };
  const rounds = [];
  const detect = async urls => { rounds.push(urls); return urls.map(url => ({ url, hasText: verdict[url], text: verdict[url] ? 'BSA' : '' })); };
  const picked = await pickMainImages([
    { sku: 'A', urls: ['u/text1', 'u/photo', 'u/text2'] },
    { sku: 'B', urls: ['u/null', 'u/shared'] },
    { sku: 'C', urls: ['u/shared', 'u/photo'] },
    { sku: 'D', urls: [] },
  ], detect);
  assert.deepEqual(picked.get('A'), { main: 'u/photo', others: ['u/text1', 'u/text2'],
    checked: [{ url: 'u/text1', hasText: true, text: 'BSA' }, { url: 'u/photo', hasText: false, text: '' }] });
  assert.equal(picked.get('B').main, '', '판별 못 한(null) 이미지는 메인이 되지 않는다');
  assert.deepEqual(picked.get('B').others, ['u/null', 'u/shared']);
  assert.equal(picked.get('C').main, 'u/photo');
  assert.equal(picked.get('D').main, '');
  // 아직 메인이 없는 SKU 의 다음 후보만, 같은 URL 은 한 번만 묻는다
  assert.deepEqual(rounds, [['u/text1', 'u/null', 'u/shared'], ['u/photo', 'u/shared']]);
  assert.ok(!rounds.flat().includes('u/text2'), '메인을 고른 뒤의 이미지는 OCR 하지 않는다');

  const { rows } = draft([{ sku: 'HY0101N135', price: '110', live: true, listing: norm('HY0101N135'), images: picked.get('B') }]);
  assert.equal(rows[0].mainImage, '');
  assert.deepEqual(rows[0].otherImages, ['u/null', 'u/shared']);
  assert.match(rows[0].notes, /글자 없는 메인 이미지 없음/);
  assert.match(rows[0].imageText, /판별 못 함 \/ 글자: BSA/);
  assert.equal(rows[0].ready, false, '메인 이미지가 없으면 업로드하지 않는다');
});

test('업로드 TSV 는 템플릿 속성 키 머리글 · 검토 끝난 줄만 · 칸 안 탭·줄바꿈 없음 · 999줄씩', () => {
  const { rows } = draft([
    { sku: 'HY0101N135', price: '110', stock: '7', live: true, listing: norm('HY0101N135'),
      images: { main: 'https://m.media-amazon.com/images/I/main.jpg', others: ['https://m.media-amazon.com/images/I/chart.jpg'], checked: [] } },
    { sku: 'ZZ-UNKNOWN', price: '50', live: true },
  ]);
  const [tsv, ...more] = draftTsv(rows);
  assert.equal(more.length, 0);
  const [head, line, end] = tsv.split('\r\n');
  assert.equal(end, '');
  assert.deepEqual(head.split('\t'), UPLOAD_KEYS);
  assert.ok(!tsv.startsWith('\uFEFF'), 'BOM 없음');
  const cell = Object.fromEntries(UPLOAD_KEYS.map((k, i) => [k, line.split('\t')[i]]));
  const mp = '[marketplace_id=A1VC38T7YXB528]', ja = '[language_tag=ja_JP]';
  assert.equal(cell['contribution_sku#1.value'], 'HY0101N135', '확인 필요(차량 없음) 줄은 업로드하지 않는다');
  assert.equal(cell['main_product_image_locator' + mp + '#1.media_location'], 'https://m.media-amazon.com/images/I/main.jpg');
  assert.equal(cell['other_product_image_locator_1' + mp + '#1.media_location'], 'https://m.media-amazon.com/images/I/chart.jpg');
  assert.equal(cell['country_of_origin' + mp + '#1.value'], '大韓民国');
  assert.equal(cell['fulfillment_availability#1.quantity'], '7');
  assert.equal(cell['purchasable_offer' + mp + '[audience=ALL]#1.our_price#1.schedule#1.value_with_tax'], '16000');
  assert.equal(cell['list_price' + mp + '#1.value'], '16000');
  assert.equal(cell['fit_type' + mp + ja + '#1.value'], '車種限定フィット', 'fit_type 목록 안의 값');
  for (const key of ['distribution_designation' + mp + '#1.value', 'is_exclusive_product' + mp + '#1.value', 'automotive_fit_type' + mp + '#1.value',
    'included_components' + mp + ja + '#1.value', 'supplier_declared_dg_hz_regulation' + mp + '#1.value', 'model_name' + mp + ja + '#1.value'])
    assert.ok(cell[key], key + ' 가 비었다');
  assert.equal(line.split('\t').length, UPLOAD_KEYS.length, '칸 안에 탭이 없다');

  const many = Array.from({ length: UPLOAD_ROWS_MAX + 1 }, (_, i) => ({ ...rows[0], sku: 'S' + i }));
  const parts = draftTsv(many);
  assert.deepEqual(parts.map(p => p.split('\r\n').length - 2), [UPLOAD_ROWS_MAX, 1]);
  assert.deepEqual(draftTsv([{ ...rows[0], ready: false }]), []);
});

test('Windows OCR 모듈은 읽지 못한 파일을 null 로 돌려준다', { skip: process.platform !== 'win32' }, async () => {
  const { detectImageText } = await import('../src/utils/image_text.js');
  const [missing] = await detectImageText(['C:/no/such/veryup-image.jpg']);
  assert.equal(missing.hasText, null);
});

// ── 2026-10-21 검토 반영 ──

test('V2 세대 칸의 4자리 연도·일 단위 날짜·시간 꼬리·여러 줄도 숫자 한가운데서 자르지 않는다', () => {
  const titleFor = gen => draft([{ sku: 'HY0101N135', price: '110', live: true,
    listing: norm('HY0101N135', { vehicles: [{ model: '그랜저', gen, option: 'GN7' }] }) }]).rows[0];
  assert.match(titleFor('7세대 2001~2004').title, / 7世代 2001-2004 GN7用 /);
  assert.match(titleFor('7세대 22.11.14~현재').title, / 7世代 22\.11\.14-現在 GN7用 /);
  assert.match(titleFor('7세대 2018 .04 ~ 현재').title, / 7世代 2018\.04-現在 GN7用 /);
  assert.match(titleFor('7세대 10-13 00:00:00').title, / 7世代 10-13 GN7用 /);
  const multi = titleFor('7세대\n7세대 후기형 15.07~18');
  assert.doesNotMatch(multi.title, /\n/);
  assert.match(multi.notes, /여러 줄/);
  assert.equal(multi.ready, false);
});

test('열린 연식의 - 는 차량코드에 붙지 않는다 — 칸 사이 공백이 남는다', () => {
  const r = draft([{ sku: 'HY0101N135', price: '110', live: true,
    listing: norm('HY0101N135', { vehicles: [{ model: '그랜저', gen: '7세대 22.11~', option: 'GN7' }] }) }]).rows[0];
  assert.match(r.title, / 22\.11- GN7用 /);
  assert.match(r.bullets[0], /22\.11- GN7専用/);
});

test('숫자만 남은 차대 칸은 버리고 V2 의 차량코드를 쓴다', () => {
  const r = draft([{ sku: 'HY0101N135', price: '110', live: true, listing: norm('HY0101N135', { chassis: '15' }) }]).rows[0];
  assert.match(r.title, / GN7用 /);
  assert.doesNotMatch(r.title, / 15用/);
});

test('카탈로그 행이 정규화 표와 다른 차(차대·연식)면 그 이름을 쓰지 않는다', () => {
  // HY0103N705 카탈로그 행: 그랜저 5세대 11~16 HG. 정규화 표는 같은 SKU 를 다른 차(차대 E46, 00~06)로 적었다.
  const listing = norm('HY0103N705', { vehicles: [], chassis: 'E46', years: '00-06', modelEn: 'NoSuchModel', no: '705' });
  const r = draft([{ sku: 'HY0103N705', price: '110', live: true, listing }]).rows[0];
  assert.equal(r.title, '', '다른 차 이름으로 상품명을 만들지 않는다');
  assert.match(r.notes, /카탈로그 차량\(그랜저 5세대 11~16 HG\)이 정규화 표\(00-06 E46\)와 다름/);
  assert.equal(r.ready, false);
  // 같은 차(차대가 겹친다)면 카탈로그 이름을 쓴다
  const same = draft([{ sku: 'HY0103N705', price: '110', live: true, listing: { ...listing, chassis: 'HG', years: '11-16' } }]).rows[0];
  assert.equal(same.source, '카탈로그');
  assert.match(same.title, /グレンジャー 5世代 11-16 HG用/);
});

test('일본에 이미 있는 SKU 와 정규화 표 Issues 가 있는 SKU 는 업로드하지 않는다', () => {
  const { rows } = draft([
    { sku: 'HY0101N135', price: '110', live: true, onJp: true, listing: norm('HY0101N135') },
    { sku: 'HY0101N1351', price: '160', live: true, listing: norm('HY0101N1351', { bsa: true, issues: ['BSA 표기와 판매가가 안 맞음'] }) },
  ]);
  assert.match(row(rows, 'HY0101N135').notes, /일본에 이미 있는 SKU/);
  assert.equal(row(rows, 'HY0101N135').ready, false);
  assert.match(row(rows, 'HY0101N1351').notes, /정규화 표: BSA 표기와 판매가가 안 맞음/);
  assert.equal(row(rows, 'HY0101N1351').ready, false);
  assert.deepEqual(draftTsv(rows), []);
});

test('사전 차종이 브랜드로 시작해도 브랜드를 두 번 쓰지 않는다 · 영문 차종 앞의 브랜드를 떼고도 찾는다', () => {
  const dict = { ...names, brands: { ...names.brands, '제네시스': { ko: '제네시스', en: 'Genesis', jp: 'ジェネシス' } },
    models: { ...names.models, '제네시스': { G80: { ko: 'G80', en: 'G80', jp: 'G80' } },
      '현대': { ...names.models['현대'], '현대 포터': { ko: '현대 포터', en: 'PORTER', jp: 'ヒュンダイ ポーター' } } } };
  const build = items => buildJpDraft({ items: items.map(withImage), names: loadVehicleNames({ names: dict, catalog }), fx, snapshot }).rows;
  const [porter] = build([{ sku: 'HY9901N900', price: '110', live: true,
    listing: norm('HY9901N900', { vehicles: [{ model: '현대 포터', gen: '2세대 04~', option: 'HR' }] }) }]);
  assert.match(porter.title, /^OGWM ヒュンダイ ポーター 2世代/);
  const [g80] = build([{ sku: 'GN0101NH100', price: '110', live: true,
    listing: norm('GN0101NH100', { maker: '제네시스', modelEn: 'Genesis G80', vehicles: [], chassis: 'RG3', years: '20~' }) }]);
  assert.equal(g80.source, '정규화 영문');
  assert.match(g80.title, /^OGWM ジェネシス G80 /);
});

test('업로드 TSV 에 商品の状態(新品)·保証内容(6ヶ月保証)이 들어간다', () => {
  const { rows, summary } = draft([{ sku: 'HY0101N135', price: '110', live: true, listing: norm('HY0101N135') }]);
  const [head, line] = draftTsv(rows)[0].split('\r\n');
  const i = head.split('\t').indexOf('condition_type[marketplace_id=A1VC38T7YXB528]#1.value');
  assert.equal(line.split('\t')[i], '新品');
  assert.equal(line.split('\t')[head.split('\t').indexOf('warranty_description[marketplace_id=A1VC38T7YXB528][language_tag=ja_JP]#1.value')], '6ヶ月保証');
  assert.equal(summary.warrantyMissing, false);
});

test('makeJpDraft: 부모 SKU 는 빼고, 미국 실시간 값·일본에 이미 있는 SKU·메인 이미지를 한 SKU 로 잇는다', async () => {
  const US = 'ATVPDKIKX0DER';
  const loc = url => [{ media_location: url, marketplace_id: US }];
  const listings = [norm('HY0101N135'), norm('HY0101N1351', { bsa: true }), norm('OGHY01', { parentSku: '' })];
  const calls = [];
  const amazon = {
    async loadProductsForEdit(skus, mp) {
      calls.push(['live', mp, [...skus]]);
      return new Map([['HY0101N135', { asin: 'B0NORM135', price: '110', stock: '3', title: 'US title',
        raw: { attributes: { main_product_image_locator: loc('https://i/text.jpg'), other_product_image_locator_1: loc('https://i/photo.jpg') },
          summaries: [{ marketplaceId: US, productType: 'VEHICLE_MIRROR' }] } }]]);
    },
    async skusOnMarketplace(skus, mp) { calls.push(['jp', mp, [...skus]]); return new Set(['HY0101N1351']); },
  };
  const detect = async urls => urls.map(url => ({ url, hasText: url.includes('text'), text: url.includes('text') ? 'FIT' : '' }));
  const { rows, summary } = await makeJpDraft({ amazon, listings, detect, names: loadVehicleNames({ names, catalog }), fx, snapshot });
  assert.deepEqual(calls.map(c => [c[0], c[1], c[2]]), [['live', US, ['HY0101N135', 'HY0101N1351']], ['jp', 'A1VC38T7YXB528', ['HY0101N135', 'HY0101N1351']]],
    '부모 SKU(OGHY01)는 묻지도 않는다');
  const a = row(rows, 'HY0101N135'), b = row(rows, 'HY0101N1351');
  assert.equal(a.mainImage, 'https://i/photo.jpg', '글자 든 미국 메인은 추가 이미지로 내린다');
  assert.deepEqual(a.otherImages, ['https://i/text.jpg']);
  assert.equal(a.stock, '3');
  assert.equal(a.ready, true);
  assert.match(b.notes, /미국 리스팅 없음/);
  assert.match(b.notes, /일본에 이미 있는 SKU/);
  assert.deepEqual([summary.parents, summary.live, summary.jpError, summary.ocrError], [1, 1, '', '']);

  // 일본 조회·OCR 이 통째로 실패해도 초안은 나온다 — 이유만 남는다
  amazon.skusOnMarketplace = async () => { throw new Error('400 Invalid accountId'); };
  const broken = await makeJpDraft({ amazon, listings, names: loadVehicleNames({ names, catalog }), fx, snapshot,
    detect: async () => { throw new Error('OCR 없음'); } });
  assert.equal(broken.summary.jpError, '400 Invalid accountId');
  assert.equal(broken.summary.ocrError, 'OCR 없음');
  assert.equal(row(broken.rows, 'HY0101N135').mainImage, '');
  assert.doesNotMatch(row(broken.rows, 'HY0101N1351').notes, /일본에 이미 있는 SKU/);
});

// ── 2026-10-22: 사람이 확인한 지정(overrides) — 아임웹 일본몰 이름 · 메인 이미지 · 검토 결과 ──

const draftWith = (items, overrides) => buildJpDraft({ items: items.map(withImage), names: loadVehicleNames({ names, catalog }), fx, snapshot, overrides });
const iwName = more => ({ makerJa: 'ヒュンダイ', modelJa: 'ノージャ', confidence: 'high', no: '200', prodNo: 1, ...more });

test('지정이 없거나 다른 SKU 것만 있으면 결과가 그대로다', () => {
  const items = [{ id: 'HY0101N135', price: '109.32' }, { id: 'HY0201N200', price: '109.32' }, { id: 'ZZ-UNKNOWN', price: '50' }];
  const base = draft(items).rows;
  const other = { imwebNames: { X: iwName() }, mainImages: { X: { url: 'u' } }, review: { X: { accept: ['차종'], bsa: true, car: { gen: 'g' } } } };
  for (const o of [undefined, {}, other]) assert.deepEqual(draftWith(items, o).rows, base);
});

test('아임웹 일본몰 이름은 사전에 없는 빈칸만 채우고, 확실하지 않거나 한글이면 쓰지 않는다', () => {
  const r = draftWith([{ id: 'HY0201N200', price: '109.32' }], { imwebNames: { HY0201N200: iwName() } }).rows[0];
  assert.match(r.title, /^OGWM ヒュンダイ ノージャ 1世代 20- X1用 /);
  assert.equal(r.source, '카탈로그+아임웹 일본몰');
  assert.doesNotMatch(r.notes, /차종 일본어 없음/);
  assert.match(r.notes, /일본어 차종: 아임웹 일본몰 상품 1 No\.200/);
  assert.equal(r.ready, true);
  // 사전 값이 있으면 사전이 이긴다 · 브랜드로 시작해도 두 번 쓰지 않는다
  assert.equal(draftWith([{ id: 'HY0101N135', price: '109.32' }], { imwebNames: { HY0101N135: iwName({ modelJa: 'ダミー' }) } }).rows[0].modelJa, 'グレンジャー');
  assert.match(draftWith([{ id: 'HY0201N200', price: '1' }], { imwebNames: { HY0201N200: iwName({ modelJa: 'ヒュンダイ ノージャ' }) } }).rows[0].title, /^OGWM ヒュンダイ ノージャ 1世代/);
  for (const bad of [iwName({ modelJa: '노자' }), iwName({ confidence: 'ambiguous' }), iwName({ confidence: undefined })]) {
    const x = draftWith([{ id: 'HY0201N200', price: '109.32' }], { imwebNames: { HY0201N200: bad } }).rows[0];
    assert.equal(x.title, '');
    assert.match(x.notes, /차종 일본어 없음/);
  }
});

test('메인 이미지 지정은 OCR 결과보다 앞서고 출처를 메모에 남긴다', () => {
  const images = { main: '', others: ['u/a', 'u/b'], checked: [{ url: 'u/a', hasText: true, text: 'FIT' }] };
  const item = { sku: 'HY0101N135', price: '110', live: true, listing: norm('HY0101N135'), images };
  assert.equal(draftWith([item]).rows[0].ready, false);
  const r = draftWith([item], { mainImages: { HY0101N135: { url: 'u/b', source: '미국 메인 렌더' } } }).rows[0];
  assert.equal(r.mainImage, 'u/b');
  assert.deepEqual(r.otherImages, ['u/a']);
  assert.match(r.notes, /메인 이미지: 직접 지정 \(미국 메인 렌더\)/);
  assert.doesNotMatch(r.notes, /글자 없는 메인/);
  assert.equal(r.ready, true);
});

test('검토 accept 는 그 메모만 풀고, 상품명·일본 존재 같은 HARD 메모는 못 푼다', () => {
  const two = norm('HY0101N135', { vehicles: [{ model: '그랜저', gen: '7세대 22.11~현재', option: 'GN7' }, { model: '그랜저', gen: '6세대', option: 'IG' }] });
  const item = { sku: 'HY0101N135', price: '110', live: true, listing: two };
  assert.equal(draftWith([item]).rows[0].ready, false);
  const r = draftWith([item], { review: { HY0101N135: { accept: ['V2 차량 2개'], note: '검토 ok' } } }).rows[0];
  assert.match(r.notes, /확인함: V2 차량 2개/);
  assert.match(r.notes, /확인함: 검토 ok/);
  assert.equal(r.ready, true);
  assert.equal(draftWith([item], { review: { OTHER: { accept: ['V2 차량 2개'] } } }).rows[0].ready, false);
  const onJp = draftWith([{ ...item, listing: norm('HY0101N135'), onJp: true }], { review: { HY0101N135: { accept: ['일본에 이미 있는 SKU', ''] } } }).rows[0];
  assert.doesNotMatch(onJp.notes, /확인함/);
  assert.equal(onJp.ready, false);
});

test('검토 bsa·car 는 제목·BSA 등급 검사에 쓰인다', () => {
  const item = { sku: 'HY0101N135', price: '109.32', live: true, listing: norm('HY0101N135', { bsa: true }) };
  assert.match(draftWith([item]).rows[0].notes, /가격 등급\(일반 미러\) 다름/);
  const plain = draftWith([item], { review: { HY0101N135: { bsa: false } } }).rows[0];
  assert.doesNotMatch(plain.notes, /다름/);
  assert.doesNotMatch(plain.title + plain.description, /BSA/);
  const gen = draftWith([item], { review: { HY0101N135: { bsa: false, car: { gen: '7世代 後期型' } } } }).rows[0];
  assert.match(gen.title, /グレンジャー 7世代 後期型 22\.11-現在 GN7用/);
  assert.match(gen.source, /검토 수정/);
});

test('makeJpDraft 도 지정을 buildJpDraft 까지 넘긴다', async () => {
  const amazon = { async loadProductsForEdit() { return new Map([['HY0101N135', { asin: 'B0NORM135', price: '110', stock: '1', raw: { attributes: {} } }]]); },
    async skusOnMarketplace() { return new Set(); } };
  const { rows } = await makeJpDraft({ amazon, listings: [norm('HY0101N135')], detect: async () => [], names: loadVehicleNames({ names, catalog }), fx, snapshot,
    overrides: { mainImages: { HY0101N135: { url: 'https://i/pick.jpg' } } } });
  assert.equal(rows[0].mainImage, 'https://i/pick.jpg');
});
