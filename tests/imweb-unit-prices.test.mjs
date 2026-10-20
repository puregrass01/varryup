// 아임웹 미국·일본 판매가(Open API) — 본사몰 구역별 가격을 한국 가격 기준으로. 네트워크는 쓰지 않는다(가짜 gateway · 가짜 클라이언트).
//
// 2026-10-01 공개 페이지: 같은 상품(idx 3)이 한국 80,000원 · 미국 $61.30 · 일본 9,387엔, 옵션은 BSA 없음/있음(+70,000원).
// 응답 모양은 같은 날 첫 미리보기에서 받은 본사몰 응답(상품 999)을 따른다. 옵션 조합 가격은 추가금이 아니라 그 조합의
// 최종가다(dataPerUnit[].isRelativePrice: false) — BSA 있음은 150,000원으로 저장돼 있고 화면이 +70,000원으로 보여 준다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeProduct, planProduct, buildPatch, restorePatch, checkAfter,
  createImwebUnitPrices, createOpenApiGateway } from '../src/imweb_unit_prices.js';

const NOW = Date.parse('2026-10-01T04:00:00Z');
const snapshot = { base: 'USD', source: 'test', marketDate: '2026-10-01', fetchedAt: new Date(NOW - 3600000).toISOString(),
  rates: { USD: 1, JPY: 157.036, KRW: 1354.27 } };
const MAP = { uKR: 'KRW', uUS: 'USD', uJP: 'JPY' };
const unitRow = (krw, usd, jpy, texts, isRelativePrice = false) => [['uKR', krw, texts[0]], ['uUS', usd, texts[1]], ['uJP', jpy, texts[2]]]
  .map(([unitCode, price, displayText]) => ({ unitCode, displayText, price, priceSupply: 0, isRelativePrice }));
const wideMirror = () => ({
  baseInfo: { prodBaseInfoByUnit: [{ unitCode: 'uKR', productName: '와이드/광각미러' }, { unitCode: 'uUS', productName: 'Wide View Side Mirror' }, { unitCode: 'uJP', productName: '広角ドアミラー' }] },
  priceInfo: [{ unitCode: 'uKR', price: 80000, isTaxFree: false }, { unitCode: 'uUS', price: 61.3 }, { unitCode: 'uJP', price: 9387 }],
  productOptionInfo: { optionMixType: 'MIX',
    optionList: [{ optionCode: 'o1', optionData: [{ name: 'BSA', valueList: [{ valueCode: 'v0', valueName: '없음' }, { valueCode: 'v1', valueName: '있음' }] }] }],
    optionDetails: [
      { optionDetailCode: 'd0', optionValuePairs: [{ optionCode: 'o1', valueCode: 'v0' }], status: 'SALE', stock: 3, stockSku: '', dataPerUnit: unitRow(80000, 61.3, 9387, ['없음', 'No BSA', 'なし']) },
      { optionDetailCode: 'd1', optionValuePairs: [{ optionCode: 'o1', valueCode: 'v1' }], status: 'SALE', stock: 5, stockSku: 'S1', dataPerUnit: unitRow(150000, 109.33, 17500, ['있음', 'With BSA', 'あり']) },
    ] },
});

// ── 계산 ──────────────────────────────────────────────────────

test('계산: 한국 80,000원 → 미국 $59 · 일본 9,200엔. 옵션은 조합의 최종가라 BSA 있음 150,000원 → $110 · 17,000엔', () => {
  const plan = planProduct(normalizeProduct('3', wideMirror()), MAP, snapshot);
  assert.deepEqual([plan.base.uUS.next, plan.base.uJP.next], [59, 9200]);
  assert.deepEqual(plan.combos.map(c => c.next), [{ uUS: 59, uJP: 9200 }, { uUS: 110, uJP: 17000 }]);
  assert.deepEqual([plan.changedBase, plan.changedCombos, plan.large, plan.changed], [2, 2, false, true]);
  // 이미 맞춘 상품은 바꿀 것이 없다(두 번 실행해도 같은 값).
  const done = wideMirror();
  done.priceInfo = [{ unitCode: 'uKR', price: 80000 }, { unitCode: 'uUS', price: 59 }, { unitCode: 'uJP', price: 9200 }];
  done.productOptionInfo.optionDetails[0].dataPerUnit = unitRow(80000, 59, 9200, ['없음', 'No BSA', 'なし']);
  done.productOptionInfo.optionDetails[1].dataPerUnit = unitRow(150000, 110, 17000, ['있음', 'With BSA', 'あり']);
  assert.equal(planProduct(normalizeProduct('3', done), MAP, snapshot).changed, false);
  // 옵션만 10% 넘게 바뀌어도 큰 변동으로 표시한다.
  const cheap = wideMirror();
  cheap.productOptionInfo.optionDetails[1].dataPerUnit = unitRow(150000, 95, 17500, ['있음', 'With BSA', 'あり']);
  assert.equal(planProduct(normalizeProduct('3', cheap), MAP, snapshot).large, true);
  assert.equal(planProduct(normalizeProduct('9', { priceInfo: [{ unitCode: 'uKR', price: 80000 }] }), MAP, snapshot).skip, '미국·일본 판매가 없음');
});

test('옵션 가격이 추가금 방식이거나 방식 표시가 없으면 그 상품은 계산하지 않는다', () => {
  const relative = wideMirror();
  relative.productOptionInfo.optionDetails[1].dataPerUnit = unitRow(70000, 53.64, 8213, ['있음', 'With BSA', 'あり'], true);
  assert.match(planProduct(normalizeProduct('3', relative), MAP, snapshot).skip, /추가금 방식/);
  const unknown = wideMirror();
  delete unknown.productOptionInfo.optionDetails[0].dataPerUnit[2].isRelativePrice;
  assert.match(planProduct(normalizeProduct('3', unknown), MAP, snapshot).skip, /방식을 확인할 수 없음/);
  const single = wideMirror();
  single.productOptionInfo = null;
  assert.equal(planProduct(normalizeProduct('3', single), MAP, snapshot).changedBase, 2, '옵션이 없는 상품은 기본가만 바꾼다');
});

test('저장 본문: 바꿀 구역 값만 고치고 한국 값·다른 필드·옵션 조합·재고는 그대로, 옵션은 모든 구역을 쓰기 형식으로 보낸다', () => {
  const product = normalizeProduct('3', wideMirror()), plan = planProduct(product, MAP, snapshot);
  const payload = buildPatch(product, plan);
  assert.deepEqual(payload.priceInfo, [{ unitCode: 'uKR', price: 80000, isTaxFree: false }, { unitCode: 'uUS', price: 59 }, { unitCode: 'uJP', price: 9200 }]);
  assert.deepEqual(payload.productOptionInfo.optionDetails, [
    { no: 1, optionValuePairs: [{ optionCode: 'o1', valueCode: 'v0' }], prices: [{ unitCode: 'uKR', price: 80000 }, { unitCode: 'uUS', price: 59 }, { unitCode: 'uJP', price: 9200 }], status: 'SALE', stock: 3, stockSku: '', optionDetailCode: 'd0' },
    { no: 2, optionValuePairs: [{ optionCode: 'o1', valueCode: 'v1' }], prices: [{ unitCode: 'uKR', price: 150000 }, { unitCode: 'uUS', price: 110 }, { unitCode: 'uJP', price: 17000 }], status: 'SALE', stock: 5, stockSku: 'S1', optionDetailCode: 'd1' },
  ]);
  assert.deepEqual(payload.productOptionInfo.optionList, wideMirror().productOptionInfo.optionList);
  const back = restorePatch(product, payload);
  assert.deepEqual(back.priceInfo, wideMirror().priceInfo);
  assert.deepEqual(back.productOptionInfo.optionDetails[1].prices, [{ unitCode: 'uKR', price: 150000 }, { unitCode: 'uUS', price: 109.33 }, { unitCode: 'uJP', price: 17500 }]);
  // 저장 뒤 확인: 한국 값이 바뀌거나 계획과 다르면 문제로 본다.
  const after = wideMirror();
  after.priceInfo[0].price = 79000; after.priceInfo[1].price = 60;
  assert.deepEqual(checkAfter(normalizeProduct('3', after), product, plan).slice(0, 2), ['한국 판매가가 바뀌었습니다 (80000 → 79000)', 'USD 판매가 60 (요청 59)']);
  // 쓰기 형식에는 방식 표시가 없다. 저장하면서 최종가가 추가금 방식으로 바뀌었으면 문제로 본다.
  const flipped = wideMirror();
  flipped.priceInfo = payload.priceInfo;
  flipped.productOptionInfo.optionDetails[0].dataPerUnit = unitRow(80000, 59, 9200, ['없음', 'No BSA', 'なし']);
  flipped.productOptionInfo.optionDetails[1].dataPerUnit = unitRow(150000, 110, 17000, ['있음', 'With BSA', 'あり'], true);
  assert.deepEqual(checkAfter(normalizeProduct('3', flipped), product, plan), ['옵션 "있음" 가격 방식(최종가/추가금)이 바뀌었습니다']);
});

// ── 미리보기 · 저장 (가짜 gateway) ─────────────────────────────────────────

function fakeHead(products, { onSave } = {}) {
  const calls = [];
  const apply = (d, payload) => {
    if (payload.priceInfo) d.priceInfo = payload.priceInfo;
    if (payload.productOptionInfo) d.productOptionInfo.optionDetails = payload.productOptionInfo.optionDetails.map(w => {
      const old = d.productOptionInfo.optionDetails.find(o => o.optionDetailCode === w.optionDetailCode);
      return { ...old, dataPerUnit: w.prices.map(p => ({ ...old.dataPerUnit.find(u => u.unitCode === p.unitCode), unitCode: p.unitCode, price: p.price })) };
    });
  };
  return {
    calls, products,
    units: async () => ({ map: MAP, how: 'declared' }),
    list: async () => { calls.push(['list']); return Object.keys(products).map(prodNo => ({ prodNo, name: 'P' + prodNo })); },
    base: prodNo => products[prodNo].priceInfo.map(e => ({ unitCode: e.unitCode, price: e.price })),
    product: async prodNo => { calls.push(['get', prodNo]); return JSON.parse(JSON.stringify(products[prodNo])); },
    save: async (prodNo, payload) => { calls.push(['patch', prodNo, payload]); apply(products[prodNo], payload); onSave?.(products[prodNo], payload); },
  };
}
function fixture(t, head, { clock = () => NOW, rate = { success: true, data: snapshot } } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imweb-unit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const service = createImwebUnitPrices({ rates: async () => rate, dir, gateway: () => head, clock,
    sleep: async () => {}, log: { log() {}, error() {} } });
  return { service, dir };
}

test('미리보기는 읽기만 하고 바꿀 내용과 구역 판별을 보여 준다. 저장은 미리보기대로 보내고 다시 읽어 확인한다', async t => {
  const head = fakeHead({ 3: wideMirror(), 9: { ...wideMirror(), priceInfo: [{ unitCode: 'uKR', price: 30000 }] } });
  const { service, dir } = fixture(t, head);
  const summary = await service.preview();
  assert.equal(head.calls.some(c => c[0] === 'patch'), false, '미리보기는 저장하지 않는다');
  assert.deepEqual([summary.products, summary.changes, summary.skipped, summary.site.map], [2, 1, 1, MAP]);
  assert.equal(summary.lines[0], '와이드/광각미러 — 한국 80,000원 · 미국 $61.30 → $59 · 일본 9,387엔 → 9,200엔 · 옵션 2건');
  const samples = JSON.parse(fs.readFileSync(path.join(dir, 'imweb_unit_prices_sample.json'), 'utf8'));
  assert.deepEqual(samples.map(x => x.prodNo), ['3', '9'], '첫 상품과 옵션 조합이 둘 이상인 첫 상품 응답을 남긴다');
  const [row] = JSON.parse(fs.readFileSync(path.join(dir, 'imweb_unit_prices_rows.json'), 'utf8'));
  assert.deepEqual(row.combos[1], { text: '있음', kr: 150000, now: { uUS: 109.33, uJP: 17500 }, next: { uUS: 110, uJP: 17000 } },
    '결과 파일에 옵션 조합별 지금 값 → 새 값을 남긴다');
  const result = await service.save();
  assert.deepEqual(result.count, { saved: 1, changedSince: 0, failed: 0 });
  assert.equal(result.stopped, '');
  assert.deepEqual(head.products[3].priceInfo.map(e => e.price), [80000, 59, 9200]);
  assert.deepEqual(head.products[3].productOptionInfo.optionDetails[1].dataPerUnit.map(u => u.price), [150000, 110, 17000]);
  await assert.rejects(service.save(), /먼저 미리보기/, '같은 미리보기로 두 번 저장하지 않는다');
});

test('미리보기 뒤에 가격이 바뀐 상품은 보내지 않고, 30분이 지나면 다시 미리보기를 요구한다', async t => {
  let now = NOW;
  const head = fakeHead({ 3: wideMirror() });
  const { service } = fixture(t, head, { clock: () => now });
  await service.preview();
  head.products[3].priceInfo[1].price = 65;
  const result = await service.save();
  assert.deepEqual(result.count, { saved: 0, changedSince: 1, failed: 0 });
  assert.equal(head.calls.some(c => c[0] === 'patch'), false);
  await service.preview();
  now += 31 * 60 * 1000;
  await assert.rejects(service.save(), /30분/);
});

test('매일 자동 실행(sync)은 읽고 바로 저장하고, 10% 넘게 바뀌는 상품은 보내지 않는다. 화면 저장은 그대로 보낸다', async t => {
  const cheap = wideMirror();
  cheap.productOptionInfo.optionDetails[1].dataPerUnit = unitRow(150000, 95, 17500, ['있음', 'With BSA', 'あり']);
  const head = fakeHead({ 3: wideMirror(), 4: cheap, 9: { ...wideMirror(), priceInfo: [{ unitCode: 'uKR', price: 30000 }] } });
  const { service, dir } = fixture(t, head);
  const result = await service.sync();
  assert.deepEqual(result.count, { products: 3, skipped: 1, unchanged: 0, large: 1, saved: 1, failed: 0 });
  assert.equal(result.stopped, '');
  assert.deepEqual(head.calls.filter(c => c[0] === 'patch').map(c => c[1]), ['3']);
  assert.deepEqual(head.calls.filter(c => c[0] === 'get').map(c => c[1]), ['3', '3', '4', '9'], '상품마다 한 번 읽고, 저장한 상품만 확인으로 한 번 더');
  const rows = JSON.parse(fs.readFileSync(path.join(dir, 'imweb_unit_prices_rows.json'), 'utf8'));
  assert.deepEqual(rows.map(r => r.prodNo), ['3', '4', '9']);
  assert.deepEqual([rows[0].result, rows[2].result], ['저장·확인 완료', '미국·일본 판매가 없음']);
  assert.match(rows[1].result, /10% 넘게/);
  assert.deepEqual(rows[0].units.map(u => [u.current, u.next]), [[61.3, 59], [9387, 9200]], '결과 CSV 에 지금 값 → 새 값');
  // 같은 상품을 화면에서 미리보기 → 저장하면 10% 넘게 바뀌어도 보낸다.
  await service.preview();
  assert.deepEqual((await service.save()).count, { saved: 1, changedSince: 0, failed: 0 });
  assert.deepEqual(head.calls.filter(c => c[0] === 'patch').map(c => c[1]), ['3', '4']);
});

test('매일 자동 실행: 목록은 시작 · 첫 저장 뒤 · 저장 100개마다 · 끝에만 다시 읽는다 — 바꿀 것이 없으면 시작 한 번', async t => {
  const head = fakeHead(Object.fromEntries(Array.from({ length: 102 }, (_, i) => [String(100 + i), wideMirror()])));
  const { service } = fixture(t, head);
  assert.equal((await service.sync()).count.saved, 102);
  assert.equal(head.calls.filter(c => c[0] === 'list').length, 4, '시작 · 첫 저장 뒤 · 101번째 저장 뒤 · 끝');
  head.calls.length = 0;
  assert.equal((await service.sync()).count.unchanged, 102);
  assert.equal(head.calls.filter(c => c[0] === 'list').length, 1);
});

test('저장 결과가 계획과 다르면(한국 가격이 바뀜) 미리보기 때 값으로 되돌리고 멈춘다', async t => {
  const head = fakeHead({ 3: wideMirror(), 4: wideMirror() }, {
    onSave: (d, payload) => { if (payload.priceInfo?.[1]?.price === 59) d.priceInfo[0].price = 1; },
  });
  const { service } = fixture(t, head);
  await service.preview();
  const result = await service.save();
  assert.equal(result.count.failed, 1);
  assert.match(result.stopped, /계획과 달라 멈췄습니다/);
  assert.match(result.results[0].result, /되돌림.*한국 판매가가 바뀌었습니다/);
  assert.deepEqual(head.products[3].priceInfo.map(e => e.price), [80000, 61.3, 9387], '원래 값으로 되돌렸다');
  assert.deepEqual(head.calls.filter(c => c[0] === 'patch').map(c => c[1]), ['3', '3'], '두 번째 상품은 보내지 않았다');
});

test('저장하면서 옵션 가격 방식이 추가금으로 바뀌면 되돌리기를 보내고 멈춘다', async t => {
  const head = fakeHead({ 3: wideMirror(), 4: wideMirror() }, {
    onSave: d => { for (const o of d.productOptionInfo.optionDetails) for (const u of o.dataPerUnit) u.isRelativePrice = true; },
  });
  const { service } = fixture(t, head);
  await service.preview();
  const result = await service.save();
  assert.equal(result.count.failed, 1);
  assert.match(result.results[0].result, /되돌림.*가격 방식\(최종가\/추가금\)이 바뀌었습니다/);
  assert.deepEqual(head.calls.filter(c => c[0] === 'patch').map(c => c[1]), ['3', '3'], '되돌리기만 보내고 다음 상품은 보내지 않았다');
});

test('저장 본문은 저장 직전에 읽은 원본으로 만든다 — 미리보기 뒤 주문으로 줄어든 재고·품절을 되살리지 않는다', async t => {
  const head = fakeHead({ 3: wideMirror() });
  const { service } = fixture(t, head);
  await service.preview();
  const [sold, soldOut] = head.products[3].productOptionInfo.optionDetails;
  sold.stock = 1; soldOut.stock = 0; soldOut.status = 'SOLDOUT';
  const result = await service.save();
  assert.equal(result.count.saved, 1);
  const patch = head.calls.find(c => c[0] === 'patch')[2];
  assert.deepEqual(patch.productOptionInfo.optionDetails.map(d => [d.stock, d.status]), [[1, 'SALE'], [0, 'SOLDOUT']]);
});

test('한국가가 자리표시 값이면 하한(미국 $1 · 일본 100엔) 아래 환산가라 건너뛰고, 계산 오류는 그 상품만 건너뛴다', async t => {
  const placeholder = wideMirror(); placeholder.priceInfo[0].price = 100;   // → $0.07 · 11엔
  const tiny = wideMirror(); tiny.priceInfo[0].price = 5;                   // → 환산 금액이 너무 작아 계산 오류
  const head = fakeHead({ 3: wideMirror(), 4: placeholder, 5: tiny });
  const { service, dir } = fixture(t, head);
  const summary = await service.preview();
  assert.deepEqual([summary.products, summary.changes, summary.skipped], [3, 1, 2]);
  const rows = JSON.parse(fs.readFileSync(path.join(dir, 'imweb_unit_prices_rows.json'), 'utf8'));
  assert.match(rows[1].result, /하한\(미국 \$1 · 일본 100엔\) 아래 — 건너뜀/);
  assert.match(rows[2].result, /^계산 실패 — 건너뜀: 환산 금액이 너무 작습니다/);
  const result = await service.save();
  assert.deepEqual(head.calls.filter(c => c[0] === 'patch').map(c => c[1]), ['3'], '정상 상품만 보낸다');
  assert.equal(result.count.saved, 1);
});

test('환율이 24시간 지났으면 미리보기를 시작하지 않고, 동시에 두 번 실행하지 않는다', async t => {
  const stale = fixture(t, fakeHead({ 3: wideMirror() }), { rate: { success: true, data: { ...snapshot, fetchedAt: new Date(NOW - 25 * 3600000).toISOString() } } });
  await assert.rejects(stale.service.preview(), /24시간/);
  let release;
  const head = fakeHead({ 3: wideMirror() });
  head.list = () => new Promise(r => { release = () => r([]); });
  const { service } = fixture(t, head);
  const first = service.preview();
  await new Promise(r => setImmediate(r));
  await assert.rejects(service.preview(), /이미 진행 중/);
  release();
  await first;
});

// ── Open API gateway (가짜 클라이언트) ─────────────────────────────────────
// 모양은 2026-10-05 실제 응답을 따른다: 사이트 정보 unitList[{unitCode, currency}], 목록 [{prodNo, name, price}],
// 옵션 상세 [{optionDetailCode, price, status, stock, optionDetailInfoList[{optionValue{optionValueName}}]}] — 구역별 호출.

function fakeClient(products, { unitList = [{ unitCode: 'uUS', currency: 'USD' }, { unitCode: 'uKR', currency: 'KRW' }, { unitCode: 'uJP', currency: 'JPY' }], failOn } = {}) {
  const calls = [];
  const notFound = () => Object.assign(new Error('없는 상품'), { status: 404, errorCode: '30006' });
  return {
    calls, store: products,
    siteInfo: async () => ({ siteCode: 'S1', unitList }),
    products: async unit => {
      calls.push(['list', unit]);
      return Object.entries(products).filter(([, p]) => p[unit]).map(([no, p]) => ({ prodNo: Number(no), name: p[unit].name, price: p[unit].price }));
    },
    product: async (no, unit) => {
      calls.push(['get', String(no), unit]);
      const p = products[no]?.[unit];
      if (!p) throw notFound();
      return { prodNo: Number(no), name: p.name, price: p.price };
    },
    optionDetails: async (no, unit) => {
      calls.push(['options', String(no), unit]);
      return (products[no]?.[unit]?.options || []).map(o => ({ optionDetailCode: o.code, price: o.price, status: o.status || 'SALE', stock: o.stock ?? 0,
        optionDetailInfoList: o.names.map(n => ({ optionCode: 'o1', name: 'BSA', optionValue: { optionValueCode: 'v', optionValueName: n } })) }));
    },
    setPrice: async (no, unit, price) => {
      calls.push(['setPrice', String(no), unit, price]);
      if (failOn?.('price', unit)) throw Object.assign(new Error('거부됨'), { status: 400, errorCode: '10003' });
      products[no][unit].price = price;
    },
    setOptionPrice: async (no, code, unit, price) => {
      calls.push(['setOption', String(no), code, unit, price]);
      if (failOn?.(code, unit)) throw Object.assign(new Error('거부됨'), { status: 400, errorCode: '10003' });
      products[no][unit].options.find(o => o.code === code).price = price;
    },
  };
}
// 상품 3 — 한국 80,000원 · 미국 $61.30 · 일본 9,387엔, BSA 있음은 최종가 150,000원(위 wideMirror 와 같은 값).
const apiMirror = () => ({
  uKR: { name: '와이드/광각미러', price: 80000, options: [{ code: 'd0', price: 80000, names: ['없음'], stock: 3 }, { code: 'd1', price: 150000, names: ['있음'], stock: 5 }] },
  uUS: { name: 'Wide View Side Mirror', price: 61.3, options: [{ code: 'd0', price: 61.3, names: ['No BSA'] }, { code: 'd1', price: 109.33, names: ['With BSA'] }] },
  uJP: { name: '広角ドアミラー', price: 9387, options: [{ code: 'd0', price: 9387, names: ['なし'] }, { code: 'd1', price: 17500, names: ['あり'] }] },
});

test('Open API: 구역은 사이트 정보에서 — 한국을 맨 앞에 두고, 한국 구역이 없으면 멈춘다', async () => {
  const gw = createOpenApiGateway(fakeClient({}));
  assert.deepEqual(await gw.units(), { map: { uKR: 'KRW', uUS: 'USD', uJP: 'JPY' }, how: 'declared' });
  const noKr = createOpenApiGateway(fakeClient({}, { unitList: [{ unitCode: 'uUS', currency: 'USD' }] }));
  await assert.rejects(noKr.units(), /한국\(KRW\) 구역/);
});

test('Open API: 상품을 계산용 모양으로 — 구역별 가격 · 이름 · 옵션 최종가, 통화 표기까지', async () => {
  const client = fakeClient({ 3: apiMirror() });
  const gw = createOpenApiGateway(client);
  const product = normalizeProduct('3', await gw.product(3));
  assert.equal(product.name, '와이드/광각미러', '상품명은 한국 구역 것');
  assert.deepEqual(product.priceInfo.map(e => [e.unitCode, e.currency, e.price]), [['uKR', 'KRW', 80000], ['uUS', 'USD', 61.3], ['uJP', 'JPY', 9387]]);
  assert.deepEqual(product.combos.map(c => [c.code, c.text, c.prices]), [
    ['d0', '없음', { uKR: 80000, uUS: 61.3, uJP: 9387 }],
    ['d1', '있음', { uKR: 150000, uUS: 109.33, uJP: 17500 }],
  ]);
  assert.deepEqual(product.combos[1].relative, { uKR: false, uUS: false, uJP: false }, '한국 옵션가가 모두 0원보다 큼 → 최종가');
  const plan = planProduct(product, (await gw.units()).map, snapshot);
  assert.deepEqual([plan.base.uUS.next, plan.base.uJP.next, plan.combos[1].next], [59, 9200, { uUS: 110, uJP: 17000 }]);
});

test('Open API: 한국 옵션가에 0원이 있으면(추가금으로 보임) 그 상품은 계산하지 않는다', async () => {
  const relative = apiMirror();
  relative.uKR.options = [{ code: 'd0', price: 0, names: ['없음'] }, { code: 'd1', price: 70000, names: ['있음'] }];
  const gw = createOpenApiGateway(fakeClient({ 3: relative }));
  const product = normalizeProduct('3', await gw.product(3));
  assert.match(planProduct(product, (await gw.units()).map, snapshot).skip, /추가금 방식으로 보이거나/);
});

test('Open API: 조수석이 기본가보다 싸도 최종가다. 한국 가격을 복사해 둔 미국·일본 값은 매일 자동 실행(sync)도 환산해 저장한다', async t => {
  // 2026-10-19 상품 2152(새로 등록): 세 구역 모두 기본 80,000 · 1set 150,000 · 운전석 80,000 · 조수석 70,000.
  const krw = { price: 80000, options: [{ code: 'd0', price: 150000, names: ['1set'] }, { code: 'd1', price: 80000, names: ['운전석'] }, { code: 'd2', price: 70000, names: ['조수석'] }] };
  const client = fakeClient({ 2152: { uKR: { name: '재규어 XJ 광각미러', ...structuredClone(krw) }, uUS: { name: 'XJ', ...structuredClone(krw) }, uJP: { name: 'XJ', ...structuredClone(krw) } } });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imweb-unit-copy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const service = createImwebUnitPrices({ rates: async () => ({ success: true, data: snapshot }), dir,
    gateway: () => createOpenApiGateway(client), clock: () => NOW, sleep: async () => {}, log: { log() {}, error() {} } });
  assert.equal((await service.sync({ stop: () => true })).stopped, '사용자가 중단했습니다.');
  assert.equal(client.calls.some(c => c[0].startsWith('set')), false, '중단하면 보내지 않는다');
  const before = client.calls.length;
  assert.deepEqual((await service.sync()).count, { products: 1, skipped: 0, unchanged: 0, large: 0, saved: 1, failed: 0 });
  const p = client.store[2152];
  assert.deepEqual([p.uKR.price, p.uUS.price, p.uJP.price], [80000, 59, 9200]);
  assert.deepEqual([p.uUS.options.map(o => o.price), p.uJP.options.map(o => o.price)], [[110, 59, 51], [17000, 9200, 8100]]);
  assert.deepEqual(p.uKR.options.map(o => o.price), [150000, 80000, 70000], '한국 가격은 그대로');
  // 호출: 기본가는 목록(구역마다 한 번에 100개)으로만 읽는다 — 시작 3번 + 첫 저장 확인 3번. 상품마다 따로 읽지 않는다.
  const used = {};
  for (const [kind] of client.calls.slice(before)) used[kind] = (used[kind] || 0) + 1;
  assert.deepEqual(used, { list: 6, options: 6, setPrice: 2, setOption: 6 });
});

test('Open API: 기본가는 목록 값을 다음 목록까지 쓰고, 저장하면 보낸 값으로 고쳐 둔다. 옵션 없는 상품은 다른 구역 옵션을 읽지 않는다', async () => {
  const plain = apiMirror();
  for (const u of ['uKR', 'uUS', 'uJP']) plain[u].options = [];
  const client = fakeClient({ 3: apiMirror(), 7: plain });
  const gw = createOpenApiGateway(client);
  assert.deepEqual((await gw.list()).map(r => r.prodNo), ['3', '7']);
  assert.deepEqual(client.calls.filter(c => c[0] === 'list').map(c => c[1]), ['uKR', 'uUS', 'uJP'], '목록은 구역마다 한 번');
  const product = normalizeProduct('3', await gw.product(3));
  await gw.product(7);
  await gw.product(3);
  assert.equal(client.calls.filter(c => c[0] === 'get').length, 0, '목록에서 읽은 기본가를 쓴다 — 상품마다 따로 읽지 않는다');
  assert.deepEqual(client.calls.filter(c => c[0] === 'options' && c[1] === '7').map(c => c[2]), ['uKR'], '한국에 옵션이 없으면 다른 구역은 읽지 않는다');
  await gw.save(3, buildPatch(product, planProduct(product, (await gw.units()).map, snapshot)));
  assert.deepEqual(gw.base(3), [{ unitCode: 'uKR', price: 80000 }, { unitCode: 'uUS', price: 59 }, { unitCode: 'uJP', price: 9200 }], '보낸 값으로 고쳐 둔다');
  client.store[8] = apiMirror();   // 목록 뒤에 등록한 상품은 구역마다 하나씩 읽는다
  await gw.product(8);
  assert.deepEqual(client.calls.filter(c => c[0] === 'get').map(c => c[1]), ['8', '8', '8']);
});

test('Open API: 저장한 기본가는 목록으로 확인한다 — 첫 저장 바로 뒤에 읽어, 한국 구역까지 바뀌었으면 멈춘다', async t => {
  // 구역을 잘못 받아 한국 기본가까지 바꾸는 저장을 흉내 낸다(옵션은 저장 직후 다시 읽어 확인하므로 기본가로 만든다).
  const client = fakeClient({ 3: apiMirror(), 4: apiMirror() });
  const setPrice = client.setPrice;
  client.setPrice = async (no, unit, price) => { await setPrice(no, unit, price); client.store[no].uKR.price = price; };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imweb-unit-settle-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const service = createImwebUnitPrices({ rates: async () => ({ success: true, data: snapshot }), dir,
    gateway: () => createOpenApiGateway(client), clock: () => NOW, sleep: async () => {}, log: { log() {}, error() {} } });
  const result = await service.sync();
  assert.deepEqual([result.count.saved, result.count.failed], [0, 1]);
  assert.match(result.stopped, /목록에서 읽은 기본가가 계획과 달라 멈췄습니다/);
  assert.deepEqual([...new Set(client.calls.filter(c => c[0] === 'setPrice').map(c => c[1]))], ['3'], '다음 상품은 보내지 않는다');
  const [row] = JSON.parse(fs.readFileSync(path.join(dir, 'imweb_unit_prices_rows.json'), 'utf8'));
  assert.match(row.result, /^기본가 확인 실패\(목록\): 한국 판매가가 바뀌었습니다/);
});

test('Open API: 그 구역에서 팔지 않는 상품(404 · 30006)은 그 구역만 빼고 읽는다', async () => {
  const krUs = apiMirror();
  delete krUs.uJP;
  const gw = createOpenApiGateway(fakeClient({ 5: krUs }));
  const product = normalizeProduct('5', await gw.product(5));
  assert.deepEqual(product.priceInfo.map(e => e.unitCode), ['uKR', 'uUS']);
  assert.deepEqual(Object.keys(product.combos[0].prices), ['uKR', 'uUS']);
});

test('Open API 저장: 바뀐 값만 구역별로 보낸다 — 한국 값 · 재고 · 판매상태는 보내지 않는다', async () => {
  const client = fakeClient({ 3: apiMirror() });
  const gw = createOpenApiGateway(client);
  const product = normalizeProduct('3', await gw.product(3));
  const plan = planProduct(product, (await gw.units()).map, snapshot);
  const result = await gw.save(3, buildPatch(product, plan));
  assert.equal(result.sent, 6);
  assert.deepEqual(client.calls.filter(c => c[0].startsWith('set')), [
    ['setPrice', '3', 'uUS', 59], ['setPrice', '3', 'uJP', 9200],
    ['setOption', '3', 'd0', 'uUS', 59], ['setOption', '3', 'd0', 'uJP', 9200],
    ['setOption', '3', 'd1', 'uUS', 110], ['setOption', '3', 'd1', 'uJP', 17000],
  ]);
  assert.deepEqual([client.store[3].uKR.price, client.store[3].uKR.options.map(o => o.price)], [80000, [80000, 150000]]);
  // 같은 본문을 다시 보내면 이미 그 값이라 보낼 것이 없다.
  const again = normalizeProduct('3', await gw.product(3));
  assert.equal((await gw.save(3, buildPatch(again, plan))).sent, 0);
});

test('Open API 저장: 한국 구역 값을 바꾸는 본문은 보내지 않는다', async () => {
  const client = fakeClient({ 3: apiMirror() });
  const gw = createOpenApiGateway(client);
  const product = normalizeProduct('3', await gw.product(3));
  const payload = { priceInfo: product.raw.priceInfo.map(e => e.unitCode === 'uKR' ? { ...e, price: 1 } : e) };
  await assert.rejects(gw.save(3, payload), /한국 구역 가격/);
  assert.equal(client.calls.some(c => c[0].startsWith('set')), false);
});

test('Open API 저장: 중간에 거부되면 앞서 보낸 것을 거꾸로 되돌리고 오류를 낸다', async () => {
  const client = fakeClient({ 3: apiMirror() }, { failOn: (code, unit) => code === 'd1' && unit === 'uJP' });
  const gw = createOpenApiGateway(client);
  const product = normalizeProduct('3', await gw.product(3));
  const plan = planProduct(product, (await gw.units()).map, snapshot);
  await assert.rejects(gw.save(3, buildPatch(product, plan)), /앞서 보낸 5건 중 5건 되돌림/);
  const p = client.store[3];
  assert.deepEqual([p.uUS.price, p.uJP.price, p.uUS.options.map(o => o.price), p.uJP.options.map(o => o.price)],
    [61.3, 9387, [61.3, 109.33], [9387, 17500]], '원래 값으로 돌아갔다');
  assert.deepEqual(client.calls.filter(c => c[0].startsWith('set')).slice(-5).map(c => c.at(-1)), [109.33, 9387, 61.3, 9387, 61.3], '거꾸로 되돌린다');
});

test('Open API: 미리보기 → 저장 → 다시 읽어 확인까지 서비스 전체가 Open API gateway 로 돈다', async t => {
  const client = fakeClient({ 3: apiMirror() });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imweb-unit-api-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const service = createImwebUnitPrices({ rates: async () => ({ success: true, data: snapshot }), dir,
    gateway: () => createOpenApiGateway(client), clock: () => NOW, sleep: async () => {}, log: { log() {}, error() {} } });
  const summary = await service.preview();
  assert.deepEqual([summary.products, summary.changes, summary.site], [1, 1, { map: { uKR: 'KRW', uUS: 'USD', uJP: 'JPY' }, how: 'declared' }]);
  assert.equal(client.calls.some(c => c[0].startsWith('set')), false, '미리보기는 쓰지 않는다');
  const result = await service.save();
  assert.deepEqual(result.count, { saved: 1, changedSince: 0, failed: 0 });
  const p = client.store[3];
  assert.deepEqual([p.uKR.price, p.uUS.price, p.uJP.price], [80000, 59, 9200]);
  assert.deepEqual(p.uUS.options.map(o => o.price), [59, 110]);
  assert.deepEqual(p.uKR.options.map(o => [o.price, o.stock]), [[80000, 3], [150000, 5]], '한국 가격 · 재고는 그대로');
});
