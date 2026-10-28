// 아임웹 자사몰(본사몰) 신규 등록 — Open API 로 한국 · 미국 · 일본 구역에 한 번에. 네트워크 대신 메모리 안의 가짜 본사몰을 쓴다.
// 템플릿 값은 오프라인 덤프(data/verimap, 2026-10-22)의 2153 · 2116, 본문 모양은 2026-10-21 실측 주석(imweb_b2b.js)을 따른다.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createImwebHeadCreate, convertWithRates, planUnitPrices } from '../src/imweb_head_create.js';

const UNITS = ['uKR', 'uUS', 'uJP'];
const NOW = Date.parse('2026-10-01T04:00:00Z');
// imweb-unit-prices.test.mjs 와 같은 환율: 80,000원 → $59 · 9,200엔, 150,000원 → $110 · 17,000엔
const SNAPSHOT = { base: 'USD', source: 'test', marketDate: '2026-10-01', fetchedAt: new Date(NOW - 3600000).toISOString(),
  rates: { USD: 1, JPY: 157.036, KRW: 1354.27 } };
const convertPrice = convertWithRates(async () => ({ success: true, data: SNAPSHOT }), () => NOW);
const ESM = 'https://ai.esmplus.com/yhshma/옵틱글래스 상세페이지/';
const TPL_CHART = encodeURI(ESM + '조견표/445.jpg');
const CONTENT = `<p><img src="${TPL_CHART}" class="fr-fic fr-dib"></p><p><img src="https://cdn.imweb.me/upload/banner.jpg"></p>` +
  '<!--<p><img src="https://esm/old.jpg"></p>--><!--B .상세페이지--><p><img src="https://esm/d1.jpg"><img src="https://esm/d2.jpg">' +
  '<img src="https://esm/d3.jpg"><img src="https://esm/d4.jpg"></p>';
const OPTION_NAMES = { uKR: ['구성 선택', ['1set', '운전석', '조수석']], uUS: ['Select Option', ['1set', 'Left', 'Right']],
  uJP: ['セット内容', ['1セット(左右)', '運転席', '助手席']] };
const TREE = [
  { categoryCode: 'cOld', name: '내 차 찾기', children: [{ categoryCode: 'cOldAudi', name: '아우디', children: [] }] },
  { categoryCode: 'cV2', name: '내 차 찾기 ver2', children: [{ categoryCode: 'cAudi', name: '아우디', children: [] }, { categoryCode: 'cCad', name: '캐딜락', children: [] }] }];
const KR_TITLE = '옵틱글래스 아우디 A6 광각미러 [No.777]';

// 바깥에서 받은 FormData 를 bracket 표기 그대로 중첩 객체로 되돌린다(서버가 하는 일 — imweb-b2b.test.mjs 와 같다).
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

function fakeHead({ content = CONTENT, ignoreUnitPrice = false, loseResponse = false, failCreate = false, lostError = null, listLag = 0, tree = TREE,
  saleResetsCombos = false, failReadAfterSale = false } = {}) {
  const calls = [];
  let nextNo = 3000, seq = 1, lag = listLag;
  const id = p => `${p}${seq++}`;
  const products = new Map();
  // 옵션 하나(SINGLE). 옵션 값 코드 · 조합 코드는 구역끼리 같다.
  const make = (no, { names, prices, content: html, status, mix, brand, discountOptions, categories, display, options, details }) => {
    const codes = (options?.uKR?.[1] || []).map(() => id('V'));
    products.set(String(no), {
      prodNo: Number(no), prodStatus: status, optionMixType: mix, brand, categories, discountOptions,
      givePointType: 'common', periodDiscount: { target: {}, usePeriod: false },
      units: Object.fromEntries(UNITS.map(u => [u, { name: names[u], price: prices[u], content: html?.[u] ?? '', isDisplay: display?.[u] ?? 'Y',
        option: options && { code: 'O' + no, name: options[u][0], values: options[u][1].map((n, i) => ({ code: codes[i], name: n })) } }])),
      details: (details || []).map((price, i) => ({ code: id('od'), idx: i, price: typeof price === 'object' ? price : Object.fromEntries(UNITS.map(u => [u, price])) })),
    });
  };
  const same = v => Object.fromEntries(UNITS.map(u => [u, v]));
  const template = (no, name, base, combos) => make(no, { names: same(name), prices: same(base), content: same(content), status: 'sale', mix: 'SINGLE',
    brand: '옵틱글래스', categories: ['cAudi'], discountOptions: { coupon: 'Y', point: 'Y', shopping_group_dc: 'Y', period: 'N' },
    options: OPTION_NAMES, details: combos });
  template('2153', '옵틱글래스 아우디 S6 - E트론 광각미러 [No.445]', 80000, [150000, 80000, 70000]);
  template('2116', '옵틱글래스 캐딜락 XT5 광각미러 [No.5019]', 115000, [220000, 115000, 105000]);

  const get = no => { const p = products.get(String(no)); if (!p) throw Object.assign(new Error('없음'), { status: 404, errorCode: '30006' }); return p; };
  const view = (p, u) => ({ prodNo: p.prodNo, name: p.units[u].name, price: p.units[u].price, prodStatus: p.prodStatus, content: p.units[u].content,
    isDisplay: p.units[u].isDisplay, optionMixType: p.optionMixType, brand: p.brand, categories: p.categories, discountOptions: p.discountOptions,
    givePointType: p.givePointType, periodDiscount: p.periodDiscount, productImages: ['https://cdn.imweb.me/upload/x.jpg'] });
  const detailView = (p, u) => p.details.map(d => ({ optionDetailCode: d.code, price: d.price[u], stock: 0, status: 'SALE',
    optionDetailInfoList: [{ optionCode: p.units[u].option.code, name: p.units[u].option.name,
      optionValue: { optionValueCode: p.units[u].option.values[d.idx].code, optionValueName: p.units[u].option.values[d.idx].name } }] }));
  const refuse = (code, msg) => Object.assign(new Error(`${code} ${msg}`), { status: 400, errorCode: code });

  return {
    calls, store: products,
    add: (no, name) => make(no, { names: same(name), prices: same(80000), status: 'sale', mix: 'SINGLE' }),
    siteInfo: async () => ({ siteCode: 'SHEAD', unitList: [{ unitCode: 'uKR', currency: 'KRW' }, { unitCode: 'uUS', currency: 'USD' }, { unitCode: 'uJP', currency: 'JPY' }] }),
    // listLag: 새 상품이 목록에 늦게 보이는 서버(처음 listLag 번은 빠진다)
    products: async (u) => { calls.push(['list', u]); const hide = lag-- > 0; return [...products.values()].filter(p => !hide || p.prodNo < 3000).map(p => view(p, u)); },
    product: async (no, u) => {
      calls.push(['get', String(no), u]);
      if (failReadAfterSale && Number(no) >= 3000 && get(no).prodStatus === 'sale') throw new Error('읽기 실패(연결 끊김)');
      return view(get(no), u);
    },
    optionDetails: async (no, u) => { calls.push(['details', String(no), u]); return detailView(get(no), u); },
    setOptionPrice: async (no, code, u, price) => { calls.push(['setOption', String(no), code, u, price]); get(no).details.find(d => d.code === code).price[u] = price; },
    request: async (method, p, { query, body, form } = {}) => {
      let m;
      if (method === 'GET' && (m = p.match(/^\/products\/(\d+)\/options$/))) {
        calls.push(['GET', p, query.unitCode]);
        const o = get(m[1]).units[query.unitCode].option;
        return { data: { list: [{ optionCode: o.code, name: o.name, optionValueList: o.values.map(v => ({ optionValueCode: v.code, optionValueName: v.name })) }] } };
      }
      if (method === 'GET' && p === '/products/shop-categories') { calls.push(['GET', p, query.unitCode]); return { data: tree }; }
      if (method === 'POST' && p === '/products') {
        const parsed = fromForm(form);
        calls.push(['POST', p, parsed]);
        if (failCreate) throw Object.assign(new Error('504 Gateway Timeout'), { status: 504 });
        const { body: b, files } = parsed;
        if (!files.some(f => f.key === 'productImages')) throw refuse('30045', '이미지 파일이 제공되지 않았습니다.');
        for (const k of ['stock', 'isUseStock', 'isUnlimitedStock']) if (k in b.productBaseInfo) throw refuse('30038', '옵션 상품은 본상품 재고 불가');
        const od = b.productOptionInfo.optionList[0].optionData;
        if (UNITS.some(u => !od.find(o => o.unitCode === u))) throw refuse('30053', '모든 유닛의 옵션데이터 필요');
        if (new Set(od.map(o => o.valueList.length)).size !== 1) throw refuse('30204', '유닛별 옵션 값 개수가 같아야 함');
        const no = nextNo++;
        const unitOf = u => b.productBaseInfo.unitShopProductInfo.find(x => x.unitCode === u);
        // ignoreUnitPrice: 미국 · 일본 판매가를 무시하고 한국 값을 복사하는 서버(확인 단계가 잡아야 한다)
        const price = u => Number(b.productPriceInfo.find(x => x.unitCode === (ignoreUnitPrice ? 'uKR' : u)).price);
        make(no, {
          names: Object.fromEntries(UNITS.map(u => [u, unitOf(u).productName])), prices: Object.fromEntries(UNITS.map(u => [u, price(u)])),
          content: Object.fromEntries(UNITS.map(u => [u, unitOf(u).description])), status: b.productBaseInfo.status,
          mix: b.productOptionInfo.optionMixType, brand: b.productClassificationInfo.brand, categories: b.productClassificationInfo.categories,
          display: Object.fromEntries((b.productExhibitionInfo || []).map(x => [x.unitCode, x.isDisplay])),
          options: Object.fromEntries(od.map(o => [o.unitCode, [o.name, o.valueList.map(v => v.valueName)]])),
          details: od[0].valueList.map(() => Object.fromEntries(UNITS.map(u => [u, price(u)]))),   // 새 조합은 기본가로 생긴다
        });
        if (loseResponse) throw lostError ? lostError() : Object.assign(new Error('504 Gateway Timeout'), { status: 504 });   // 만들어졌지만 응답이 사라짐
        return { data: { prodNo: no, prodCode: 'pc' + no, failUploadImages: [] } };
      }
      if (method === 'PATCH' && (m = p.match(/^\/products\/(\d+)\/status$/))) {
        calls.push(['PATCH', p, body]);
        const prod = get(m[1]);
        prod.prodStatus = body.status;
        // saleResetsCombos: 판매중 전환이 조합가를 기본가로 되돌리는 서버(imweb_b2b.js 의 옛 기록)
        if (saleResetsCombos && body.status === 'sale') prod.details.forEach(d => UNITS.forEach(u => { d.price[u] = prod.units[u].price; }));
        return { data: true };
      }
      throw new Error('예상하지 못한 요청 ' + method + ' ' + p);
    },
  };
}

const fakeImage = async () => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'image/jpeg' }), arrayBuffer: async () => new ArrayBuffer(8) });
const apiOf = (client, logs = []) => createImwebHeadCreate(client, { log: m => logs.push(m), convertPrice, sleep: async () => {}, fetchImpl: fakeImage });
const DATA = () => ({
  brand: '아우디', model: 'A6', titleBrand: '아우디', titleModel: 'A6', code: '777', bsaO: false, bsaX: true,
  titleBrandEn: 'Audi', titleModelEn: 'A6', titleBrandJp: 'アウディ', titleModelJp: 'A6',
  specImageUrl: ESM + '조견표/777_A6.jpg', specImageUrlEn: ESM + 'Compatibility Chart/CAR/777_A6.jpg',
  mainImageUrl: 'https://ai.esmplus.com/yhshma/thumb.jpg',
  detailHtml: '<p><img src="https://esm/n1.jpg"></p>\n<p><img src="https://esm/n2.jpg"></p>',
});
const postBody = client => client.calls.find(c => c[0] === 'POST')[2];
const comboPrices = p => Object.fromEntries(UNITS.map(u => [u, p.details.map(d => d.price[u])]));
const wrote = client => client.calls.some(c => ['POST', 'PATCH', 'setOption'].includes(c[0]));

test('등록: 세 구역을 숨김으로 만들고 → 구역마다 조합가 → 다시 읽어 확인 → 판매중', async () => {
  const client = fakeHead(), logs = [];
  const r = await apiOf(client, logs).register(DATA());
  assert.equal(r.ok, true, r.error);
  assert.equal(r.title, KR_TITLE);
  assert.deepEqual(r.warnings, []);

  const { body: b, files } = postBody(client);
  assert.ok(files.some(f => f.key === 'productImages' && f.type === 'image/jpeg' && f.name === 'thumb.jpg'), '대표 이미지 파일');
  assert.equal(b.productBaseInfo.status, 'nosale');
  for (const k of ['stock', 'isUseStock', 'isUnlimitedStock']) assert.equal(b.productBaseInfo[k], undefined, `${k}: 30038`);
  assert.deepEqual(b.productBaseInfo.unitShopProductInfo.map(x => [x.unitCode, x.productName]), [
    ['uKR', KR_TITLE], ['uUS', 'Optic-glass Audi A6 Wide View Side Mirror [No.777]'], ['uJP', 'Optic-glass アウディ A6 広角ドアミラー [No.777]']]);
  assert.deepEqual(b.productPriceInfo.map(x => [x.unitCode, Number(x.price)]), [['uKR', 80000], ['uUS', 59], ['uJP', 9200]], '미국 · 일본은 환율 탭 규칙');
  assert.deepEqual(b.productDiscountInfo.map(x => [x.unitCode, x.coupon, x.point, x.shoppingGroup, x.period]),
    UNITS.map(u => [u, 'Y', 'Y', 'Y', 'N']), '템플릿의 할인 설정을 구역마다');
  assert.deepEqual(b.productExhibitionInfo.map(x => [x.unitCode, x.isDisplay]), UNITS.map(u => [u, 'Y']));
  assert.deepEqual(b.productClassificationInfo, { categories: ['cAudi'], brand: '옵틱글래스' }, "'내 차 찾기 ver2 > 아우디'");
  assert.equal(b.productOptionInfo.optionMixType, 'SINGLE');
  assert.deepEqual(b.productOptionInfo.optionList[0].optionData.map(o => [o.unitCode, o.name, o.valueList.map(v => v.valueName)]), [
    ['uKR', '구성 선택', ['1set', '운전석', '조수석']], ['uUS', 'Select Option', ['1set', 'Left', 'Right']],
    ['uJP', 'セット内容', ['1セット(左右)', '運転席', '助手席']]], '템플릿의 구역별 옵션 이름');

  const [kr, us, jp] = b.productBaseInfo.unitShopProductInfo.map(x => x.description);
  assert.ok(kr.includes(encodeURI(DATA().specImageUrl)) && !kr.includes(TPL_CHART), '한국: 국내용 조견표로 바뀜');
  assert.ok([us, jp].every(h => h.includes(encodeURI(DATA().specImageUrlEn)) && !h.includes(TPL_CHART)), '미국 · 일본: 해외용 조견표');
  assert.ok(kr.includes('<!--B .상세페이지--><p><img src="https://esm/n1.jpg"><img src="https://esm/n2.jpg"></p>'), '상세 이미지만 바뀜');
  assert.ok(kr.includes('banner.jpg') && kr.includes('<!--<p><img src="https://esm/old.jpg"></p>-->'), '배너 · 주석 속 옛 이미지는 그대로');

  const no = String(r.no);
  const writes = client.calls.filter(c => ['POST', 'PATCH', 'setOption'].includes(c[0]))
    .map(c => c[0] === 'setOption' ? `setOption ${c[3]} ${c[4]}` : `${c[0]} ${c[1]}`);
  assert.deepEqual(writes, ['POST /products', 'setOption uKR 150000', 'setOption uKR 70000', 'setOption uUS 110', 'setOption uUS 51',
    'setOption uJP 17000', 'setOption uJP 8100', `PATCH /products/${no}/status`], '기본가와 같은 조합(운전석)은 보내지 않는다');
  const lastSet = client.calls.findLastIndex(c => c[0] === 'setOption'), sale = client.calls.findIndex(c => c[0] === 'PATCH');
  for (const u of UNITS) {
    assert.ok(client.calls.some((c, i) => i > lastSet && i < sale && c[0] === 'get' && c[1] === no && c[2] === u), `${u} 확인 읽기는 판매중 전환 앞`);
  }
  assert.deepEqual(client.calls.find(c => c[0] === 'PATCH')[2], { status: 'sale' });
  const p = client.store.get(no);
  assert.equal(p.prodStatus, 'sale');
  assert.deepEqual(comboPrices(p), { uKR: [150000, 80000, 70000], uUS: [110, 59, 51], uJP: [17000, 9200, 8100] });
  assert.ok(logs.length && logs.every(m => m.includes('[자사몰]')), logs.join('\n'));
});

test('영문 이름이 없으면 미국 구역은 한국 이름 + 경고(막지 않는다)', async () => {
  const client = fakeHead();
  const r = await apiOf(client).register({ ...DATA(), titleBrandEn: '', titleModelEn: '' });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(postBody(client).body.productBaseInfo.unitShopProductInfo.map(x => x.productName),
    [KR_TITLE, KR_TITLE, 'Optic-glass アウディ A6 広角ドアミラー [No.777]']);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /미국 상품명.*한국 이름/);
  assert.equal(client.store.get(String(r.no)).units.uUS.name, KR_TITLE);
});

test('템플릿 본문에 상세 표시나 조견표가 없으면 아무것도 만들지 않고 멈춘다', async () => {
  for (const content of [CONTENT.replace('<!--B .상세페이지-->', ''), CONTENT.replace(TPL_CHART, 'https://cdn.imweb.me/upload/chart.jpg'),
    CONTENT.replace('<p><img src="https://cdn', `<p><img src="${TPL_CHART}"></p><p><img src="https://cdn`)]) {   // 조견표가 둘이면 어느 것인지 모른다
    const client = fakeHead({ content });
    await assert.rejects(apiOf(client).register(DATA()), /<!--B \.상세페이지-->.*아무것도 만들지 않았습니다/);
    assert.equal(wrote(client), false);
  }
  // 템플릿 차 이름이 글로 적힌 본문은 다른 차 상품이 되므로 멈춘다
  const client = fakeHead({ content: CONTENT.replace('<p><img src="https://cdn', '<p>※아우디 S6 - E트론 조견표※</p><p><img src="https://cdn') });
  await assert.rejects(apiOf(client).register(DATA()), /템플릿 차/);
  assert.equal(wrote(client), false);
});

test("카테고리 '내 차 찾기 ver2 > 브랜드' 가 없으면 아무것도 만들지 않고 멈춘다", async () => {
  const client = fakeHead();
  await assert.rejects(apiOf(client).register({ ...DATA(), brand: '부가티', titleBrand: '부가티' }),
    /카테고리 '내 차 찾기 ver2 > 부가티' 가 없습니다 — 아임웹 관리자에서 만든 뒤 다시 등록하세요/);
  assert.equal(wrote(client), false);
});

test('확인이 어긋나면 숨김으로 두고 상품번호와 문제를 돌려준다', async () => {
  const client = fakeHead({ ignoreUnitPrice: true });
  const r = await apiOf(client).register(DATA());
  assert.equal(r.ok, false);
  assert.ok(r.no > 0);
  assert.match(r.error, /미국 판매가 80000 \(요청 59\)/);
  assert.match(r.error, /일본 판매가 80000 \(요청 9200\)/);
  assert.match(r.error, new RegExp(`상품번호 ${r.no}`));
  assert.equal(client.store.get(String(r.no)).prodStatus, 'nosale');
  assert.equal(client.calls.some(c => c[0] === 'PATCH'), false, '판매중으로 바꾸지 않는다');
});

test('등록 응답이 사라지면(504) 한국 상품명으로 찾아 이어간다 — 다시 만들지 않는다', async () => {
  const client = fakeHead({ loseResponse: true });
  const r = await apiOf(client).register(DATA());
  assert.equal(r.ok, true, r.error);
  assert.equal(client.calls.filter(c => c[0] === 'POST').length, 1);
  assert.ok(client.calls.some(c => c[0] === 'list' && c[1] === 'uKR'));
  assert.equal(client.store.get(String(r.no)).units.uKR.name, KR_TITLE);
  // 보낸 뒤 연결이 끊긴 'fetch failed'(TypeError)도 같고, 목록에 늦게 보이면 다시 본다
  const late = fakeHead({ loseResponse: true, lostError: () => new TypeError('fetch failed'), listLag: 2 });
  const r2 = await apiOf(late).register(DATA());
  assert.equal(r2.ok, true, r2.error);
  assert.deepEqual([late.calls.filter(c => c[0] === 'POST').length, late.calls.filter(c => c[0] === 'list').length], [1, 3]);
  // 끝내 찾지 못하면 다시 만들지 않고 '만들어졌을 수 있음'으로 멈춘다
  const lost = fakeHead({ failCreate: true });
  await assert.rejects(apiOf(lost).register(DATA()), /504 Gateway Timeout.*만들어졌을 수 있습니다.*관리자에서/);
  assert.deepEqual([lost.calls.filter(c => c[0] === 'POST').length, lost.calls.filter(c => c[0] === 'list').length], [1, 3]);
});

test('판매중 전환 뒤 다시 읽어 어긋나면(조합가가 되돌아감) 숨김으로 되돌린다', async () => {
  const client = fakeHead({ saleResetsCombos: true });
  const r = await apiOf(client).register(DATA());
  assert.equal(r.ok, false);
  assert.match(r.error, /판매중 전환 뒤 한국 조합 '1set' 가격 80000 \(요청 150000\)/);
  assert.match(r.error, new RegExp(`상품번호 ${r.no} — 숨김 상태입니다`));
  assert.deepEqual(client.calls.filter(c => c[0] === 'PATCH').map(c => c[2].status), ['sale', 'nosale']);
  assert.equal(client.store.get(String(r.no)).prodStatus, 'nosale');
  // 전환 뒤 읽기가 실패하면 '바꾸지 않았다' 가 아니라 '보냈지만 확인하지 못함'
  const blind = fakeHead({ failReadAfterSale: true });
  const b = await apiOf(blind).register(DATA());
  assert.equal(b.ok, false);
  assert.match(b.error, /판매중 전환 · 확인 실패: 읽기 실패.*판매중 전환을 보냈지만 확인하지 못했습니다/);
});

test("카테고리: 르노삼성 → '르노 코리아', ver2 에 없는 브랜드는 '기타' + 경고 · 로컬 대표 이미지 형식은 확장자로", async () => {
  const tree = [{ categoryCode: 'cV2', name: '내 차 찾기 ver2', children: [{ categoryCode: 'cAudi', name: '아우디', children: [] },
    { categoryCode: 'cRenault', name: '르노 코리아', children: [] }, { categoryCode: 'cEtc', name: '기타', children: [] }] }];
  const renault = fakeHead({ tree });
  const r = await apiOf(renault).register({ ...DATA(), brand: '르노삼성', titleBrand: '르노삼성' });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(postBody(renault).body.productClassificationInfo.categories, ['cRenault']);
  assert.deepEqual(r.warnings, []);
  const mazda = fakeHead({ tree });
  const m = await createImwebHeadCreate(mazda, { convertPrice, sleep: async () => {}, fetchImpl: fakeImage, readFile: async () => Buffer.from('x') })
    .register({ ...DATA(), brand: '마쯔다', titleBrand: '마쯔다', mainImagePath: 'C:/img/main.webp' });
  assert.equal(m.ok, true, m.error);
  assert.deepEqual(postBody(mazda).body.productClassificationInfo.categories, ['cEtc']);
  assert.match(m.warnings.join(' '), /'내 차 찾기 ver2 > 마쯔다' 가 없어 '기타' 에 넣습니다/);
  assert.ok(postBody(mazda).files.some(f => f.key === 'productImages' && f.type === 'image/webp' && f.name === 'main.webp'));
});

test('BSA O 는 템플릿 2116 의 가격(220,000 / 115,000 / 105,000)', async () => {
  const client = fakeHead();
  const r = await apiOf(client).register({ ...DATA(), bsaO: true, bsaX: false });
  assert.equal(r.ok, true, r.error);
  assert.ok(client.calls.some(c => c[0] === 'get' && c[1] === '2116'));
  assert.equal(client.calls.some(c => c[0] === 'get' && c[1] === '2153'), false);
  const p = client.store.get(String(r.no));
  assert.deepEqual(UNITS.map(u => p.units[u].price), [115000, 84, 13000]);
  assert.deepEqual(comboPrices(p), { uKR: [220000, 115000, 105000], uUS: [160, 84, 77], uJP: [25000, 13000, 12000] });
});

test('환율: 환율 탭과 같은 규칙(앞 두 자리) · 24시간 지난 환율이면 아무것도 만들지 않는다', async () => {
  assert.deepEqual([await convertPrice('USD', 80000), await convertPrice('JPY', 150000)], [59, 17000]);
  const stale = convertWithRates(async () => ({ success: true, data: { ...SNAPSHOT, stale: true } }), () => NOW);
  await assert.rejects(stale('USD', 80000), /24시간/);
  const client = fakeHead();
  await assert.rejects(createImwebHeadCreate(client, { convertPrice: stale, fetchImpl: fakeImage }).register(DATA()), /24시간/);
  assert.equal(wrote(client), false);
});

test('중복 검사: 이름에 [No.코드] · [No.코드(옵)] 와 한국 차종이 함께 든 한국 구역 상품만', async () => {
  const client = fakeHead();
  client.add('900', '옵틱글래스 아우디 A6 광각미러 [No.777]');
  client.add('901', '옵틱글래스 아우디 A6 광각미러 [No.777(옵)]');
  client.add('902', '옵틱글래스 아우디 A6 광각미러 [No.7770]');
  client.add('903', '옵틱글래스 아우디 Q7 광각미러 [No.777]');
  const res = await apiOf(client).findExisting({ code: '777', titleModel: 'A6' });
  assert.equal(res.complete, true);
  assert.deepEqual(res.rows.map(r => [r.prodNo, r.status]), [[900, 'sale'], [901, 'sale']]);
  assert.ok(client.calls.every(c => c[0] !== 'list' || c[1] === 'uKR'));
  // 차종은 경계를 본다(sameModel): X3 ≠ IX3, S5 ≠ RS5 — 부분 문자열로 막지 않는다
  client.add('910', '옵틱글래스 BMW IX3 광각미러 [No.112]');
  client.add('911', '옵틱글래스 아우디 RS5 광각미러 [No.113]');
  client.add('912', '옵틱글래스 BMW X3 광각미러 [No.112(옵)]');
  assert.deepEqual((await apiOf(client).findExisting({ code: '112', titleModel: 'X3' })).rows.map(r => r.prodNo), [912]);
  assert.deepEqual((await apiOf(client).findExisting({ code: '113', titleModel: 'S5' })).rows, []);
});

test('미국 · 일본 1set: 판매가(USD)가 있으면 미국 1set = 그 값, 일본 1set = 그 값의 환율 환산(또는 일본 칸) · 나머지는 한국가 환산', async () => {
  const krw = { base: 115000, combos: [220000, 115000, 105000] };
  const fx = await planUnitPrices(krw, '', convertPrice);
  const usd = await planUnitPrices(krw, '$90', convertPrice);
  assert.equal(usd.USD.combos[0], 90);
  assert.equal(usd.JPY.combos[0], await convertPrice('JPY', 90, 'USD'));
  assert.notEqual(usd.JPY.combos[0], fx.JPY.combos[0], '일본은 한국가가 아니라 달러에서 환산');
  assert.deepEqual([usd.USD.base, usd.JPY.base, usd.USD.combos.slice(1), usd.JPY.combos.slice(1)],
    [fx.USD.base, fx.JPY.base, fx.USD.combos.slice(1), fx.JPY.combos.slice(1)], '기본가(운전석) · 운전석 · 조수석은 한국가 환산 그대로');
  assert.equal(fx.USD.combos[0], await convertPrice('USD', 220000));
  assert.equal((await planUnitPrices(krw, '90', convertPrice, '9,900')).JPY.combos[0], 9900, '일본 칸 값이 이긴다');
  await assert.rejects(planUnitPrices(krw, '0.5', convertPrice), /하한/);
});

test('탭 칸 값으로 등록: 한국 1set · 운전석 · 조수석 · 미국 · 일본 1set · 본문 맨 위 덧붙임 글', async () => {
  const client = fakeHead();
  const r = await apiOf(client).register({ ...DATA(), bsaO: true, bsaX: false,
    krwPrices: ['230000', '120000', '110000'], usdPrice: '170', jpyPrice: '26000', intro: '정품 <6개월> 보증\n두 번째 줄' });
  assert.equal(r.ok, true, r.error);
  const p = client.store.get(String(r.no));
  assert.equal(p.units.uKR.price, 120000, '기본가 = 운전석 칸(템플릿과 같은 자리)');
  assert.deepEqual([comboPrices(p).uKR, comboPrices(p).uUS[0], comboPrices(p).uJP[0]], [[230000, 120000, 110000], 170, 26000]);
  assert.ok(postBody(client).body.productBaseInfo.unitShopProductInfo.map(x => x.description).every(html => html.startsWith('<p>정품 &lt;6개월&gt; 보증</p><p>두 번째 줄</p>')), '세 구역 본문 맨 위');
  await assert.rejects(apiOf(fakeHead()).register({ ...DATA(), krwPrices: ['150000', '', '70000'] }).then(x => { if (!x.ok) throw new Error(x.error); }), /한국 판매가/);
});
