// 아임웹 B2B몰 — Open API 로 조회 · 등록 · 수정. 네트워크 대신 메모리 안의 가짜 B2B몰을 쓴다.
// 템플릿 값은 2026-10-05 실제 응답(712 · 803)을 따른다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createB2bApi, comboKey, baseKeyOf, suffixOf, typeOf, planOptionValues, templateGroups, discountInfoFrom,
  buildCreateBody, replaceSpecBlock, replaceDetailImages, b2bTitle, planOf
} from '../src/platforms/openapi/imweb_b2b.js';
import { toFormFields } from '../src/platforms/openapi/imweb_client.js';

const U = 'uB';
const GROUPS_SET = { t1: { groupType: 'group', groupCode: 'gFam', groupTitle: '패밀리', dcAmount: 90000, dcType: 'price' },
  t2: { groupType: 'group', groupCode: 'gA', groupTitle: 'A클', dcAmount: 100000, dcType: 'price' } };
const GROUPS_INDIV = { t3: { groupType: 'group', groupCode: 'gFam', groupTitle: '사업자', dcAmount: 40000, dcType: 'price' } };
const CONTENT = '<!--1. 공지 영역--><p>공지</p><!--2. 조견표 영역--><p><img src="https://old/spec.jpg"></p><!--3. 상세페이지 영역--><p><img src="https://x/d1.jpg"><img src="https://x/d2.jpg"></p>';

// 바깥에서 받은 FormData 를 bracket 표기 그대로 중첩 객체로 되돌린다(서버가 하는 일).
function fromForm(form) {
  const out = {}, files = [];
  for (const [key, value] of form.entries()) {
    if (typeof value !== 'string') { files.push({ key, name: value.name, type: value.type, size: value.size }); continue; }
    const parts = key.replace(/\]/g, '').split('[');
    let node = out;
    parts.forEach((p, i) => {
      if (i === parts.length - 1) { node[p] = value; return; }
      if (!(p in node)) node[p] = /^\d+$/.test(parts[i + 1]) ? [] : {};
      node = node[p];
    });
  }
  return { body: out, files };
}

function fakeB2b() {
  const calls = [];
  let nextNo = 5000, nextCode = 1;
  const code = p => `${p}${nextCode++}`;
  const products = new Map();
  const put = (no, p) => { products.set(String(no), { prodNo: Number(no), prodStatus: 'sale', stockUse: 'Y', categories: [], productImages: ['https://cdn/1.jpg'], ...p }); };
  const group = (name, values) => ({ optionCode: code('O'), name, values: values.map(v => ({ code: code('V'), name: v })) });
  const cartesian = (prod) => {
    let rows = [[]];
    for (const g of prod.groups) rows = rows.flatMap(r => g.values.map(v => [...r, { optionCode: g.optionCode, v }]));
    return rows.map(r => ({ optionDetailCode: code('od'), price: prod.price, stock: 0, status: 'SALE', pairs: r }));
  };
  const detailView = (d) => ({ optionDetailCode: d.optionDetailCode, price: d.price, stock: d.stock, status: d.status,
    optionDetailInfoList: d.pairs.map(p => ({ optionCode: p.optionCode, name: 'n', optionValue: { optionValueCode: p.v.code, optionValueName: p.v.name } })) });
  // 템플릿 803(일반 개별) · 712(일반 세트)
  const t803 = { name: '옵틱글래스 쌍용 렉스턴W 미러 운전석/조수석', price: 80000, content: CONTENT, discountOptions: { coupon: 'Y', point: 'Y', shopping_group_dc: 'Y', period: 'Y' },
    givePointType: 'common', periodDiscount: { target: GROUPS_INDIV, usePeriod: false }, groups: [group('차량', ['렉스턴W']), group('연식', ['12~17 [No.Y111] BSA X', '12~17 [No.Y111] BSA O']), group('구성', ['운전석만', '조수석만'])] };
  t803.details = cartesian(t803);
  t803.details.forEach(d => { if (d.pairs.some(p => /BSA O/.test(p.v.name))) d.price = 90000; });
  put(803, t803);
  const t712 = { name: '옵틱글래스 쌍용 렉스턴W 미러 1셋 [Y111]', price: 150000, content: CONTENT, discountOptions: { coupon: 'Y', point: 'Y', shopping_group_dc: 'Y', period: 'Y' },
    givePointType: 'common', periodDiscount: { target: GROUPS_SET, usePeriod: false }, groups: [group('차량', ['렉스턴W']), group('연식', ['12~17 [No.Y111] BSA X', '12~17 [No.Y111] BSA O'])] };
  t712.details = cartesian(t712);
  t712.details.forEach(d => { if (d.pairs.some(p => /BSA O/.test(p.v.name))) d.price = 170000; });
  put(712, t712);
  const tree = [{ categoryCode: 'cMirror', name: '광각미러', children: [
    { categoryCode: 'cDom', name: '국산차', children: [{ categoryCode: 'cKia', name: '기아', children: [{ categoryCode: 'cK5', name: 'K5', children: [] }] }] },
    { categoryCode: 'cImp', name: '수입차', children: [{ categoryCode: 'cBmw', name: 'BMW', children: [] }] }] }];

  const view = p => ({ prodNo: p.prodNo, name: p.name, price: p.price, prodStatus: p.prodStatus, content: p.content, categories: p.categories,
    productImages: [...p.productImages], periodDiscount: p.periodDiscount, stockUse: p.stockUse, discountOptions: p.discountOptions, givePointType: p.givePointType });
  const get = no => { const p = products.get(String(no)); if (!p) throw Object.assign(new Error('없음'), { status: 404, errorCode: '30006' }); return p; };
  let failNext = null;

  const client = {
    calls, store: products,
    failNextCreate: (e) => { failNext = e; },
    siteInfo: async () => ({ siteCode: 'SB', unitList: [{ unitCode: U, currency: 'KRW' }] }),
    products: async () => { calls.push(['list']); return [...products.values()].map(view); },
    product: async (no) => { calls.push(['get', String(no)]); return view(get(no)); },
    optionDetails: async (no) => { calls.push(['details', String(no)]); return (get(no).details || []).map(detailView); },
    setPrice: async (no, unit, price) => { calls.push(['setPrice', String(no), price]); get(no).price = price; },
    setOptionPrice: async (no, odc, unit, price) => { calls.push(['setOption', String(no), odc, price]); get(no).details.find(d => d.optionDetailCode === odc).price = price; },
    request: async (method, p, { query, body, form } = {}) => {
      calls.push([method, p, body ?? (form ? fromForm(form) : undefined)]);
      let m;
      if (method === 'GET' && (m = p.match(/^\/products\/(\d+)\/options$/))) {
        return { data: { list: get(m[1]).groups.map(g => ({ optionCode: g.optionCode, name: g.name, optionValueList: g.values.map(v => ({ optionValueCode: v.code, optionValueName: v.name })) })) } };
      }
      if (method === 'GET' && p === '/products/shop-categories') return { data: tree };
      if (method === 'POST' && p === '/products') {
        if (failNext) { const e = failNext; failNext = null; if (e.create) { /* 만들어졌지만 응답이 사라짐 */ } else throw e; }
        const { body: b, files } = fromForm(form);
        if (!files.some(f => f.key === 'productImages')) throw Object.assign(new Error('30045 이미지 없음'), { status: 400, errorCode: '30045' });
        const unit = b.productBaseInfo.unitShopProductInfo[0];
        const no = nextNo++;
        const prod = { name: unit.productName, price: Number(b.productPriceInfo[0].price), content: unit.description, prodStatus: b.productBaseInfo.status, stockUse: 'N',
          categories: b.productClassificationInfo.categories, productImages: ['https://cdn/new.jpg'],
          discountOptions: { coupon: b.productDiscountInfo[0].coupon, point: b.productDiscountInfo[0].point, shopping_group_dc: b.productDiscountInfo[0].shoppingGroup, period: b.productDiscountInfo[0].period },
          periodDiscount: { target: Object.fromEntries((b.productDiscountInfo[0].periodOptionData?.targetGroups || []).map((g, i) => ['n' + i,
            { groupType: g.groupType, groupCode: g.groupCode, dcAmount: Number(g.discountAmount), dcType: g.discountType }])), usePeriod: false },
          groups: b.productOptionInfo.optionList.map(o => group(o.optionData[0].name, o.optionData[0].valueList.map(v => v.valueName))) };
        prod.details = cartesian(prod);
        put(no, prod);
        if (failNext === null && client._lostResponse) { client._lostResponse = false; throw Object.assign(new Error('504'), { status: 504 }); }
        return { data: { prodNo: no, prodCode: 'pc' + no, failUploadImages: [] } };
      }
      if (method === 'PATCH' && (m = p.match(/^\/products\/(\d+)$/))) {
        const { body: b } = fromForm(form);
        const prod = get(m[1]);
        if (b.productName) prod.name = b.productName;
        if (b.description) prod.content = b.description;
        if (b.images) prod.productImages = b.images;
        return { data: true };
      }
      if (method === 'PATCH' && (m = p.match(/^\/products\/(\d+)\/status$/))) { get(m[1]).prodStatus = body.status; return { data: true }; }
      if (method === 'PATCH' && (m = p.match(/^\/products\/(\d+)\/(display|relative-info)$/))) { get(m[1])[m[2]] = body; return { data: true }; }
      if (method === 'PATCH' && (m = p.match(/^\/products\/(\d+)\/classification$/))) { get(m[1]).categories = body.categories; return { data: true }; }
      if (method === 'PATCH' && (m = p.match(/^\/products\/(\d+)\/options\/(\w+)$/))) {
        const g = get(m[1]).groups.find(x => x.optionCode === m[2]);
        for (const v of body.optionValueList) g.values.find(x => x.code === v.optionValueCode).name = v.optionValueName;
        return { data: true };
      }
      if (method === 'PATCH' && (m = p.match(/^\/products\/(\d+)\/option-details\/(\w+)$/))) {
        const d = get(m[1]).details.find(x => x.optionDetailCode === m[2]);
        if (body.price !== undefined) d.price = body.price;
        if (body.status) d.status = body.status;
        if (body.stock !== undefined) {
          if (get(m[1]).stockUse !== 'Y') throw Object.assign(new Error('30157 재고 사용을 설정하지 않은 상품'), { status: 400, errorCode: '30157' });
          d.stock += body.stock;
        }
        return { data: true };
      }
      if (method === 'POST' && (m = p.match(/^\/products\/(\d+)\/images$/))) {
        get(m[1]).productImages.push('https://cdn/uploaded.jpg');
        return { data: { success: ['ic1'], fail: [] } };
      }
      throw new Error('예상하지 못한 요청 ' + method + ' ' + p);
    },
  };
  return client;
}

const fakeImage = async () => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'image/jpeg' }), arrayBuffer: async () => new ArrayBuffer(8) });
const apiOf = (client, logs = []) => createB2bApi(client, { log: m => logs.push(m), sleep: async () => {}, fetchImpl: fakeImage });
const regData = (over = {}) => ({ titleBrand: '기아', titleModel: 'K5', brand: '기아', model: 'K5', code: 'K501', year: '20~23',
  bsaX: true, registerIndiv: true, registerSet: true, specImageUrl: 'https://img/spec k5.jpg', mainImageUrl: 'https://img/main.jpg', ...over });

// ── 순수 함수 ──────────────────────────────────────────────────────────

test('이름 · 키: 공통명 · 접미사 · 종류, 조합 키는 BSA 표시와 구성만 본다', () => {
  assert.equal(baseKeyOf('옵틱글래스 기아 K5 미러 1셋 [K501]'), '옵틱글래스 기아 K5');
  assert.equal(suffixOf('옵틱글래스 기아 K5 미러 운전석/조수석'), '미러 운전석/조수석');
  assert.deepEqual(['… 미러 1셋 [1]', '… 미러 운전석/조수석', '기타'].map(typeOf), ['set', 'indiv', 'etc']);
  assert.equal(comboKey('렉스턴W / 12~17 [No.Y111] BSA O / 운전석만'), 'O|운전석만');
  assert.equal(b2bTitle(regData(), 'set'), '옵틱글래스 기아 K5 미러 1셋 [K501]');
  assert.deepEqual(planOf(regData(), 'indiv'), { price: 80000, templateNo: '803' });
  assert.deepEqual(planOf(regData({ bsaX: false, bsaO: true }), 'set'), { price: 220000, templateNo: '1290' });
});

test('옵션 값 계획: 같은 이름은 그대로, 나머지는 BSA 표시가 같은 것끼리 이름을 바꾸고, 남는 옛 값은 숨김, 모자라면 추가 필요', () => {
  const old = [{ valueCode: 'a', valueName: '12~17 [No.Y111] BSA X' }, { valueCode: 'b', valueName: '12~17 [No.Y111] BSA O' }];
  assert.deepEqual(planOptionValues(old, ['20~23 [No.K501] BSA X', '20~23 [No.K501] BSA O']), {
    renames: [{ valueCode: 'a', from: old[0].valueName, to: '20~23 [No.K501] BSA X' }, { valueCode: 'b', from: old[1].valueName, to: '20~23 [No.K501] BSA O' }],
    hide: [], add: [] });
  const fewer = planOptionValues(old, ['20~23 [No.K501] BSA O']);
  assert.deepEqual([fewer.renames.map(r => r.valueCode), fewer.hide.map(v => v.valueCode), fewer.add], [['b'], ['a'], []]);
  assert.deepEqual(planOptionValues([old[1]], ['x BSA X', 'x BSA O']).add, ['x BSA X'], 'BSA O 하나를 BSA X · O 두 개로는 못 늘린다');
  assert.deepEqual(planOptionValues(old, [old[1].valueName, old[0].valueName]), { renames: [], hide: [], add: [] }, '순서만 다르면 바꿀 것 없음');
});

test('템플릿 할인 설정 → 등록 본문: 그룹가격을 쓰기 형식(discountAmount · discountType)으로', () => {
  assert.deepEqual(templateGroups({ target: GROUPS_INDIV }), [{ groupType: 'group', groupCode: 'gFam', discountAmount: 40000, discountType: 'price' }]);
  const info = discountInfoFrom({ discountOptions: { coupon: 'Y', point: 'N', shopping_group_dc: 'Y' }, periodDiscount: { target: GROUPS_SET } }, U);
  assert.deepEqual([info.coupon, info.point, info.shoppingGroup, info.period, info.periodOptionData.targetGroups.length, info.periodOptionData.usePeriod], ['Y', 'N', 'Y', 'Y', 2, 'N']);
  assert.equal(discountInfoFrom({}, U).period, 'N', '그룹가격이 없으면 기간할인을 켜지 않는다');
});

test('등록 본문: 차종 · 연식(BSA X 는 X · O 둘) · 개별만 구성, 숨김 상태 · 본상품 재고 필드 없음 · 세금 포함, multipart 로 펴면 bracket 표기', () => {
  const body = buildCreateBody({ data: regData(), type: 'indiv', unitCode: U, title: 'T', price: 80000, content: 'C', categories: ['c1'], template: { periodDiscount: { target: GROUPS_INDIV } } });
  assert.deepEqual(body.productOptionInfo.optionList.map(o => [o.optionData[0].name, o.optionData[0].valueList.map(v => v.valueName)]), [
    ['차종', ['K5']], ['연식', ['20~23 [No.K501] BSA X', '20~23 [No.K501] BSA O']], ['구성', ['운전석만', '조수석만']]]);
  assert.equal(body.productBaseInfo.status, 'nosale');
  for (const k of ['stock', 'isUseStock', 'isUnlimitedStock']) assert.equal(body.productBaseInfo[k], undefined, `${k}: 옵션 상품은 본상품 재고 기능이 거부된다(30038)`);
  const fields = Object.fromEntries(toFormFields(body));
  assert.equal(fields['productBaseInfo[unitShopProductInfo][0][productName]'], 'T');
  assert.equal(fields['productOptionInfo[optionList][1][optionData][0][valueList][1][valueName]'], '20~23 [No.K501] BSA O');
  assert.equal(fields['productDiscountInfo[0][periodOptionData][targetGroups][0][groupCode]'], 'gFam');
  assert.equal(fields['productPriceInfo[0][isPriceTaxIncluded]'], 'Y');
});

test('조견표 · 상세 이미지 교체: 표시가 없으면 건드리지 않고(null), 이미지는 자리대로 바꾼다', () => {
  const html = replaceSpecBlock(CONTENT, { specUrl: 'https://img/new.jpg', titleBrand: '기아', titleModel: 'K5' });
  assert.ok(html.includes('※기아 K5 조견표※') && html.includes('https://img/new.jpg') && !html.includes('old/spec.jpg'));
  assert.ok(html.includes('<!--3. 상세페이지 영역--><p><img src="https://x/d1.jpg">'), '상세페이지 영역은 그대로');
  assert.equal(replaceSpecBlock('<p>표시 없음</p>', { specUrl: 'u', titleBrand: 'a', titleModel: 'b' }), null);
  assert.equal(replaceDetailImages('<p><img src="a"><img src="b"></p>', ['x']), '<p><img src="x"></p>');
});

// ── 등록 ───────────────────────────────────────────────────────────────

test('등록: 개별 · 세트를 숨김으로 만들고 → 판매중 → 템플릿 조합가 · 그룹가격 · 외부채널 끔 → 확인 → 서로 연관상품', async () => {
  const client = fakeB2b();
  const logs = [];
  const results = await apiOf(client, logs).registerB2bViaApi(regData());
  assert.deepEqual(results.map(r => [r.type, r.ok, r.title, r.error]), [
    ['indiv', true, '옵틱글래스 기아 K5 미러 운전석/조수석 [K501]', ''],
    ['set', true, '옵틱글래스 기아 K5 미러 1셋 [K501]', '']]);
  const [indiv, set] = results.map(r => client.store.get(String(r.no)));
  assert.deepEqual([indiv.prodStatus, indiv.price, set.prodStatus, set.price], ['sale', 80000, 'sale', 150000]);
  assert.deepEqual(indiv.categories, ['cKia', 'cK5', 's20260130ce2d59e3e6905']);
  assert.deepEqual(indiv.details.map(d => d.price).sort(), [80000, 80000, 90000, 90000], 'BSA O 조합은 템플릿처럼 90,000');
  assert.deepEqual(set.details.map(d => d.price).sort(), [150000, 170000]);
  assert.deepEqual(templateGroups(set.periodDiscount).map(g => g.discountAmount), [90000, 100000], '세트는 세트 템플릿의 그룹가격');
  assert.deepEqual(indiv.display, { unitCode: U, display: [] });
  assert.deepEqual(indiv['relative-info'], { relativeData: [{ relativeProdNo: results[1].no, isMutual: 'Y' }] });
  assert.ok(indiv.content.includes('※기아 K5 조견표※') && indiv.content.includes('https://img/spec%20k5.jpg'), '조견표만 바꾼 템플릿 상세설명');
  const create = client.calls.find(c => c[0] === 'POST' && c[1] === '/products')[2];
  assert.equal(create.body.productBaseInfo.status, 'nosale', '처음엔 숨김으로 만든다');
  assert.deepEqual(create.files.map(f => [f.key, f.name]), [['productImages', 'main.jpg']]);
});

test('등록: 응답이 사라지면(504) 상품명으로 찾아 이어 간다 — 같은 상품을 두 번 만들지 않는다', async () => {
  const client = fakeB2b();
  client._lostResponse = true;
  const results = await apiOf(client).registerB2bViaApi(regData({ registerSet: false }));
  assert.equal(results[0].ok, true);
  assert.equal(client.calls.filter(c => c[0] === 'POST' && c[1] === '/products').length, 1);
  assert.equal([...client.store.values()].filter(p => p.name === results[0].title).length, 1);
});

test('등록: 판매중 전환이 거부되면 그 대상은 실패, 상품번호는 남긴다(숨김으로 남은 상품도 원장에 적어야 한다)', async () => {
  const client = fakeB2b();
  const orig = client.request;
  client.request = async (method, p, opts) => {
    if (method === 'PATCH' && /\/status$/.test(p)) throw Object.assign(new Error('판매상태를 바꿀 수 없습니다'), { status: 400 });
    return orig(method, p, opts);
  };
  const [r] = await apiOf(client).registerB2bViaApi(regData({ registerSet: false }));
  assert.equal(r.ok, false);
  assert.ok(r.no > 0);
  assert.equal(client.store.get(String(r.no)).prodStatus, 'nosale');
  assert.match(r.error, /판매중 전환 실패.*숨김/);
  assert.match(r.error, new RegExp(`상품번호 ${r.no}`));
});

test('등록: 확인 결과가 다르면(그룹가격 누락) 그 대상은 실패로 남기고 상품번호를 알려준다', async () => {
  const client = fakeB2b();
  const orig = client.request;
  client.request = async (method, p, opts) => {
    const res = await orig(method, p, opts);
    if (method === 'POST' && p === '/products') client.store.get(String(res.data.prodNo)).periodDiscount = { target: {} };
    return res;
  };
  const [r] = await apiOf(client).registerB2bViaApi(regData({ registerSet: false }));
  assert.equal(r.ok, false);
  assert.match(r.error, /그룹가격이 템플릿과 다름.*상품번호 \d+/);
});

// ── 조회 ───────────────────────────────────────────────────────────────

test('조회: 코드로 B2B 상품을 끝까지(대소문자 무시) 찾고, 연식 옵션 값 · 상품 정보를 읽는다', async () => {
  const client = fakeB2b();
  const api = apiOf(client);
  const { rows, complete } = await api.listB2bRowsByCode('y111');
  assert.deepEqual([rows.map(r => r.prodNo), complete], [[712], true]);
  assert.deepEqual(await api.b2bOptionValuesOf(712), ['12~17 [No.Y111] BSA X', '12~17 [No.Y111] BSA O']);
  assert.deepEqual(await api.extractProductInfo(712), { brand: '쌍용', model: '렉스턴W', code: 'Y111', title: '옵틱글래스 쌍용 렉스턴W 미러' });
  const groups = await api.searchProducts({ code: 'Y111' });
  assert.deepEqual(groups.map(g => g.items.map(i => i.prodNo)), [[712, 803]], '코드로 세트를 찾고 공통명으로 개별까지 짝을 모은다');
});

test('카테고리 동기화: 트리에서 국산차 · 수입차 → 브랜드 → 모델 목록 파일을 만든다', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b2b-cat-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'imweb_categories.json');
  const formatted = await apiOf(fakeB2b()).syncCategories(file);
  assert.deepEqual(formatted, { 국산차: { 기아: ['K5'] }, 수입차: { BMW: [] } });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), formatted);
});

// ── 수정 ───────────────────────────────────────────────────────────────

test('등록 화면의 수정: 상품명 · 조견표 · 판매가 · 연식 값 이름 · 카테고리 · 대표 이미지를 고친다', async () => {
  const client = fakeB2b();
  const api = apiOf(client);
  const data = regData({ code: 'Y111', titleBrand: '쌍용', titleModel: '렉스턴W', brand: '기아', model: 'K5', year: '18~20', registerIndiv: false });
  const [r] = await api.modifyB2bViaApi(data);
  assert.equal(r.ok, true, r.error);
  const p = client.store.get('712');
  assert.equal(p.name, '옵틱글래스 쌍용 렉스턴W 미러 1셋 [Y111]');
  assert.deepEqual(p.groups.find(g => g.name === '연식').values.map(v => v.name), ['18~20 [No.Y111] BSA X', '18~20 [No.Y111] BSA O']);
  assert.deepEqual(p.details.map(d => d.price).sort(), [150000, 170000], '조합(과 가격)은 이름만 바뀌고 그대로');
  assert.deepEqual(p.categories, ['cKia', 'cK5', 's20260130ce2d59e3e6905']);
  assert.deepEqual(p.productImages, ['https://cdn/uploaded.jpg'], '올린 이미지만 남긴다');
  assert.ok(p.content.includes('※쌍용 렉스턴W 조견표※'));
});

test('등록 화면의 수정: BSA 로 바뀌어 연식 값이 줄면 빠진 값의 조합을 숨기고, 늘어야 하면 실패로 알린다', async () => {
  const client = fakeB2b();
  const toBsa = regData({ code: 'Y111', titleBrand: '쌍용', titleModel: '렉스턴W', year: '12~17', bsaX: false, bsaO: true, registerIndiv: false, brand: '', mainImageUrl: '' });
  const [r] = await apiOf(client).modifyB2bViaApi(toBsa);
  assert.equal(r.ok, true, r.error);
  const p = client.store.get('712');
  assert.deepEqual(p.details.map(d => [d.pairs.map(x => x.v.name).join('/').includes('BSA X'), d.status]).sort(), [[false, 'SALE'], [true, 'HIDDEN']]);
  assert.equal(p.price, 220000, 'BSA 세트 판매가');

  const client2 = fakeB2b();
  const yr = client2.store.get('712').groups.find(g => g.name === '연식');
  yr.values = [yr.values[1]];   // BSA O 하나뿐인 상품을
  const [r2] = await apiOf(client2).modifyB2bViaApi(regData({ code: 'Y111', titleBrand: '쌍용', titleModel: '렉스턴W', registerIndiv: false, brand: '', mainImageUrl: '' }));
  assert.equal(r2.ok, false);
  assert.match(r2.error, /값 .*BSA X.* 을 추가해야 합니다 — 아임웹 Open API 는 옵션 값을 추가하지 못합니다/);
});

test('상품수정 탭: 상품명 · 판매가 · 상세 이미지 · 조합 가격과 재고(변경량으로)를 고치고 다시 읽어 확인한다', async () => {
  const client = fakeB2b();
  const api = apiOf(client);
  const cur = await api.loadProduct(803);
  const target = cur.combos[0];
  const summary = await api.updateProduct({ prodNo: 803, title: '옵틱글래스 쌍용 렉스턴W 미러 운전석/조수석 [Y111]', price: 85000,
    detailImages: ['https://x/n1.jpg'], combos: [{ optionDetailCode: target.optionDetailCode, displayText: target.displayText, price: 88000, stock: 5 }] });
  assert.match(summary, /상품 803 수정 완료 — 상품명 .*상세이미지 3 → 1장.*판매가 80000 → 85000원.*옵션 조합 1건/);
  const p = client.store.get('803');
  const d = p.details.find(x => x.optionDetailCode === target.optionDetailCode);
  assert.deepEqual([p.price, d.price, d.stock], [85000, 88000, 5]);
  const stockCall = client.calls.find(c => c[0] === 'PATCH' && c[1].includes(target.optionDetailCode));
  assert.deepEqual(stockCall[2], { unitCode: U, price: 88000, stock: 5 }, '재고는 목표가 아니라 변경량(+5)으로 보낸다');
  await assert.rejects(api.updateProduct({ prodNo: 803 }), /변경할 내용이 없습니다/);
});

test('상품수정 탭: 재고 관리를 쓰지 않는 상품(Open API 로 만든 상품)은 재고만 건너뛰고 알리며, 가격은 저장한다', async () => {
  const client = fakeB2b();
  const api = apiOf(client);
  const [r] = await api.registerB2bViaApi(regData({ registerIndiv: false }));
  const cur = await api.loadProduct(r.no);
  assert.equal(cur.stockUse, 'N');
  const c = cur.combos[0];
  const summary = await api.updateProduct({ prodNo: r.no, combos: [{ optionDetailCode: c.optionDetailCode, displayText: c.displayText, price: 151000, stock: 7 }] });
  assert.match(summary, /옵션 조합 1건 가격\/재고.*재고 1건은 바꾸지 않음 — 재고 관리를 쓰지 않는 상품/);
  const d = client.store.get(String(r.no)).details.find(x => x.optionDetailCode === c.optionDetailCode);
  assert.deepEqual([d.price, d.stock], [151000, 0]);
});
