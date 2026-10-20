// 아임웹 미국·일본 상품명 · 옵션 이름 번역(imweb_unit_names.js). 네트워크는 쓰지 않는다(가짜 본사몰).
// 2026-10-20 실측: 상품 2152 는 세 구역 모두 '옵틱글래스 재규어 XJ 광각미러 [No.960]', 옵션 '구성 선택: 1set · 운전석 · 조수석'.
// 이미 번역된 상품 3 · 126 의 표기(Wide View Side Mirror / 広角ドアミラー, Select Option / セット内容 …)를 따른다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeTranslator, planOptions, createImwebUnitNames } from '../src/imweb_unit_names.js';
import { loadVehicleNames } from '../src/amazon_jp_draft.js';

const names = loadVehicleNames();
const translate = makeTranslator(names);
const XJ = '옵틱글래스 재규어 XJ 광각미러 [No.960]';

test('번역: 사전의 브랜드 · 차종으로 영어 · 일본어 상품명을 만든다. 차가 없는 이름 · (옵) 표시 · 모르는 이름', () => {
  assert.deepEqual(translate(XJ), { en: 'Optic-glass Jaguar XJ Wide View Side Mirror [No.960]', ja: 'Optic-glass ジャガー XJ 広角ドアミラー [No.960]', note: '' });
  assert.deepEqual(translate('옵틱글래스 광각미러 [No.104(옵)]'),
    { en: 'Optic-glass Wide View Side Mirror [No.104]', ja: 'Optic-glass 広角ドアミラー [No.104]', note: '' }, '기존 번역(상품 126)처럼 (옵)은 뺀다');
  assert.match(translate('옵틱글래스 롤스로이스 레이스 광각미러 [No.5]').skip, /사전에 없는 브랜드/);
  assert.match(translate('스타포쉬 | 전동 사이드스텝 Pro (고급형) 복제').skip, /모르는 상품명 형식/);
  assert.match(translate('옵틱글래스 광각미러 [No.5578').skip, /모르는 상품명 형식/, '닫는 괄호가 없는 이름은 짐작하지 않는다');
});

// 2026-10-20 실제 미리보기 검토에서 나온 것들(상품 1962 · 1777 · 2131 · 1714 · 1400).
test('번역: 차종 칸의 다른 브랜드는 그 사전으로, 브랜드는 두 번 쓰지 않고, 세대 코드를 잃는 카탈로그 영문은 쓰지 않는다', () => {
  const car = kr => { const t = translate('옵틱글래스 ' + kr + ' 광각미러 [No.1]'); return t.skip || t.en + ' / ' + t.ja; };
  assert.equal(car('쉐보레 GMC 아카디아'), 'Optic-glass Chevrolet GMC ACADIA Wide View Side Mirror [No.1] / Optic-glass シボレー GMC アカディア 広角ドアミラー [No.1]',
    '카탈로그의 Acadia 만 쓰면 쉐보레 차로 읽힌다');
  assert.match(car('현대 제네시스 쿠페'), /Hyundai GENESIS COUPE .* ヒョンデ ジェネシス クーペ/, "카탈로그의 'Coupe'(투스카니 수출명)가 아니다");
  assert.match(car('테슬라 테슬라s'), /Optic-glass Tesla Model S .* テスラ Model S /, "'Tesla Tesla Model S' 가 아니다");
  assert.match(car('현대 YF소나타'), /사전에 없는 차종/, "카탈로그 'Sonata' 는 YF 를 잃는다 — 다른 세대와 같은 이름이 된다");
  assert.match(car('BMW MINI 쿠퍼 해치백'), /BMW MINI Cooper Hatchback/, '하위 브랜드 사전에 없으면 카탈로그로 넘어간다');
});

test('옵션: 단어표에 있는 한국어 그룹명 · 값만 바꾸고, 이미 번역된 값은 두고, 값 코드는 그대로 보낸다', () => {
  const groups = [{ code: 'o1', name: '구성 선택', values: [{ code: 'v1', name: '1set' }, { code: 'v2', name: '운전석' }, { code: 'v3', name: '조수석' }] },
    { code: 'o2', name: 'BSA Sensor', values: [{ code: 'v4', name: 'No BSA' }] }];
  assert.deepEqual(planOptions(groups, 0), [{ optionCode: 'o1', changes: ['구성 선택→Select Option', '운전석→Left', '조수석→Right'],
    body: { name: 'Select Option', optionValueList: [{ optionValueCode: 'v1', optionValueName: '1set' }, { optionValueCode: 'v2', optionValueName: 'Left' }, { optionValueCode: 'v3', optionValueName: 'Right' }] } }]);
  assert.deepEqual(planOptions(groups, 1)[0].body.optionValueList.map(v => v.optionValueName), ['1セット(左右)', '運転席', '助手席']);
});

// 가짜 본사몰: 구역마다 이름 · 옵션. leak 이면 미국 · 일본 PATCH 가 한국 구역까지 바꾼다(그럴 때 되돌리는지 본다).
function fakeShop({ leak = false, failOption = 0 } = {}) {
  const U = { KRW: 'uKR', USD: 'uUS', JPY: 'uJP' };
  const opts = () => [{ optionCode: 'o1', name: '구성 선택', optionValueList: [
    { optionValueCode: 'v1', optionValueName: '1set' }, { optionValueCode: 'v2', optionValueName: '운전석' }, { optionValueCode: 'v3', optionValueName: '조수석' }] }];
  const shop = {
    names: { 2152: { uKR: XJ, uUS: XJ, uJP: XJ }, 3: { uKR: '와이드/광각미러', uUS: 'Wide View Side Mirror', uJP: '広角ドアミラー' },
      9: { uKR: '옵틱글래스 롤스로이스 레이스 광각미러 [No.5]', uUS: '옵틱글래스 롤스로이스 레이스 광각미러 [No.5]', uJP: '옵틱글래스 롤스로이스 레이스 광각미러 [No.5]' } },
    options: { 2152: { uKR: opts(), uUS: opts(), uJP: opts() } },
    writes: [],
  };
  const targets = unit => leak ? [unit, 'uKR'] : [unit];
  const api = {
    siteInfo: async () => ({ unitList: Object.entries(U).map(([currency, unitCode]) => ({ currency, unitCode })) }),
    products: async unit => Object.entries(shop.names).map(([prodNo, n]) => ({ prodNo: Number(prodNo), name: n[unit] })),
    product: async (no, unit) => ({ prodNo: Number(no), name: shop.names[no][unit] }),
    async request(method, p, { query, body, form } = {}) {
      const [, , no, , code] = p.split('/');
      if (method === 'GET') return { data: { list: structuredClone(shop.options[no]?.[query.unitCode] || []) } };
      if (form) {
        const unit = form.get('unitCode');
        shop.writes.push(['name', no, unit, form.get('productName')]);
        for (const u of targets(unit)) shop.names[no][u] = form.get('productName');
        return {};
      }
      if (failOption-- > 0) throw Object.assign(new Error('timeout'), { status: 504 });
      shop.writes.push(['option', no, body.unitCode, code, body]);
      for (const u of targets(body.unitCode)) {
        const g = shop.options[no][u].find(x => x.optionCode === code);
        if (body.name) g.name = body.name;
        for (const v of body.optionValueList || []) g.optionValueList.find(x => x.optionValueCode === v.optionValueCode).optionValueName = v.optionValueName;
      }
      return {};
    },
  };
  return { shop, api };
}
const service = api => createImwebUnitNames({ client: () => api, dir: fs.mkdtempSync(path.join(os.tmpdir(), 'iw-names-')), names: () => names, log: {} });

test('미리보기 → 저장: 미국 · 일본 이름과 옵션만 바꾸고, 한국 구역과 이미 번역된 상품은 그대로, 못 찾은 상품은 이유를 남긴다', async () => {
  const { shop, api } = fakeShop();
  const s = service(api);
  const p = await s.preview();
  assert.deepEqual([p.products, p.translated, p.changes, p.skipped], [3, 1, 1, 1]);
  const r = await s.save();
  assert.deepEqual(r.count, { saved: 1, changedSince: 0, failed: 0 });
  assert.equal(shop.names[2152].uKR, XJ);
  assert.equal(shop.names[2152].uUS, 'Optic-glass Jaguar XJ Wide View Side Mirror [No.960]');
  assert.equal(shop.names[2152].uJP, 'Optic-glass ジャガー XJ 広角ドアミラー [No.960]');
  assert.deepEqual(shop.options[2152].uUS[0].optionValueList.map(v => v.optionValueName), ['1set', 'Left', 'Right']);
  assert.deepEqual(shop.options[2152].uJP[0].optionValueList.map(v => v.optionValueName), ['1セット(左右)', '運転席', '助手席']);
  assert.equal(shop.options[2152].uKR[0].name, '구성 선택');
  assert.ok(!shop.writes.some(w => w[1] === '3' || w[2] === 'uKR'), '번역된 상품 · 한국 구역에는 보내지 않는다');
  const rows = s.rows();
  assert.equal(rows.find(x => x.prodNo === '2152').result, '저장 완료');
  assert.match(rows.find(x => x.prodNo === '2152').options, /^미국 구성 선택→Select Option/);
  assert.match(rows.find(x => x.prodNo === '9').result, /사전에 없는 브랜드/);
  await assert.rejects(s.save(), /먼저 미리보기/, '같은 미리보기로 두 번 저장하지 않는다');
});

test('구역별 PATCH 가 한국 구역까지 바꾸면 첫 상품에서 한국 이름 · 옵션을 되돌리고 멈춘다', async () => {
  const { shop, api } = fakeShop({ leak: true });
  const s = service(api);
  await s.preview();
  const r = await s.save();
  assert.equal(r.count.saved, 0);
  assert.match(r.stopped, /한국 구역 이름이 함께 바뀌어 되돌리고 멈췄습니다/);
  assert.equal(shop.names[2152].uKR, XJ);
  assert.deepEqual([shop.options[2152].uKR[0].name, ...shop.options[2152].uKR[0].optionValueList.map(v => v.optionValueName)], ['구성 선택', '1set', '운전석', '조수석']);
});

test('옵션 저장이 실패하면 상품명은 한국어로 남아, 다음 미리보기가 그 상품을 다시 잡는다', async () => {
  const { shop, api } = fakeShop({ failOption: 1 });
  const s = service(api);
  await s.preview();
  const r = await s.save();
  assert.equal(r.count.failed, 1);
  assert.equal(shop.names[2152].uUS, XJ, '옵션이 끝나기 전에는 이름을 바꾸지 않는다');
  assert.equal((await s.preview()).changes, 1);
  assert.equal((await s.save()).count.saved, 1);
  assert.deepEqual(shop.options[2152].uUS[0].optionValueList.map(v => v.optionValueName), ['1set', 'Left', 'Right']);
});

test('미리보기 뒤에 이름이 바뀐 상품은 보내지 않는다', async () => {
  const { shop, api } = fakeShop();
  const s = service(api);
  await s.preview();
  shop.names[2152].uUS = 'Edited by hand';
  const r = await s.save();
  assert.deepEqual(r.count, { saved: 0, changedSince: 1, failed: 0 });
  assert.equal(shop.writes.length, 0);
});
