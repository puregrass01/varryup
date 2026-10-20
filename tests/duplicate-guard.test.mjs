// 신규 등록 중복 예외 — src/utils/duplicate_guard.js · registration_ledger.js · ebay.js 레거시 검사.
// 외부 API 는 부르지 않는다. 조회는 전부 가짜 함수로 주입한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as g from '../src/utils/duplicate_guard.js';
import { RegistrationLedger } from '../src/utils/registration_ledger.js';
import { EbayStore } from '../src/platforms/ebay_store.js';
import { Ebay } from '../src/platforms/ebay.js';
import { registerEbayIPC } from '../src/ebay_ipc.js';
import { ImwebEdit } from '../src/platforms/imweb_edit.js';
import { createB2bApi } from '../src/platforms/openapi/imweb_b2b.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const quiet = { warn() {}, log() {}, error() {} };
const MIN = 60 * 1000;
const NOW = '2026-09-23T10:00:00.000Z';

function tmpDir(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'veryup-dup-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}
function clock(iso = NOW) {
  let at = Date.parse(iso);
  const now = () => new Date(at);
  now.advance = ms => { at += ms; };
  return now;
}
function ledgerAt(t, now = clock()) {
  return new RegistrationLedger(tmpDir(t), { now });
}

// ── 쿠팡 픽스처 ──────────────────────────────────────────────────────────
const CATALOG = {
  _built: '2026-09-23T07:30:43.221Z',
  variants: [{ brand: '현대', model: '싼타페' }, { brand: '기아 (KIA)', model: 'K5' }, { brand: '쌍용', model: '토레스' }],
  coupang: [
    { id: '111', name: '옵틱글래스 현대 싼타페 광각 사이드 와이드미러', brand: '현대', model: '싼타페',
      options: [{ text: 'No.H131번 (7세대/21.07-) BSA' }, { text: 'No.H120 - 4세대' }] },
    { id: '222', name: '옵틱글래스 현대 디올뉴싼타페 광각 사이드 와이드미러', brand: '현대', model: '디올뉴싼타페',
      options: [{ text: 'No.H131 BSA' }] },
  ],
};
const BRANDS = g.brandsFromCatalog(CATALOG);
const cpData = (over = {}) => ({
  productId: '13670011949', category: '자동차',
  title: '옵틱글래스 현대 싼타페 광각 사이드 와이드미러', optionModel: 'No.H131번 (7세대) BSA', ...over,
});
const toresData = (over = {}) => cpData({ title: '옵틱글래스 쌍용 토레스 광각 사이드 와이드미러', optionModel: 'No.T100 - 1세대', ...over });
const cpProduct = (id, texts, statusName = '승인완료') => ({
  code: 'SUCCESS',
  data: { sellerProductId: Number(id), statusName,
    items: texts.map(t => ({ itemName: `${t} / 1개`, attributes: [{ attributeValueName: t }, { attributeValueName: '1개' }] })) },
});
function fakeCoupang({ products = {}, throwOn = {}, pages = [[]], listCode = 'SUCCESS', endless = false } = {}) {
  const calls = { list: 0, get: [] };
  return {
    calls,
    listPage: async token => {
      calls.list++;
      if (listCode !== 'SUCCESS') return { code: listCode };
      if (endless) return { code: 'SUCCESS', data: [], nextToken: 'more' };
      const i = token ? Number(token) : 0;
      return { code: 'SUCCESS', data: pages[i] || [], nextToken: i + 1 < pages.length ? String(i + 1) : '' };
    },
    getProduct: async id => {
      calls.get.push(id);
      if (throwOn[id]) throw new Error(throwOn[id]);
      return products[id] ?? { code: 'ERROR', data: null };
    },
  };
}
async function runCoupang(data, { ledger = null, lookup = fakeCoupang(), catalog = CATALOG, result = { code: 'SUCCESS', data: 555 }, now = clock(), inflight = null, record } = {}) {
  const plan = g.planCoupang(data, { vendorId: 'A001', brands: BRANDS });
  let registered = 0;
  const out = await g.runGuardedRegistration({
    channel: 'coupang', data, plan, inflight, log: quiet,
    check: (p, opts) => g.checkCoupang(p, opts, { ledger, catalog, lookup, now, log: quiet }),
    register: async () => { registered++; return result; },
    record: record || ((p, r, opts) => g.recordCoupang(ledger, p, r, opts)),
  });
  return { ...out, registered };
}

// ── 1. 정규화 ───────────────────────────────────────────────────────────
test('정규화: 번호·BSA·코드·브랜드·상품명 가르기', () => {
  assert.equal(g.optionNo('No.h131번 (7세대)'), 'H131');
  assert.equal(g.optionNo('No.310-1세대 전기'), '310');
  assert.equal(g.optionNo('24.10~[No.K138]BSA'), 'K138');
  assert.equal(g.optionNo('[B301] 2024'), 'B301');
  assert.equal(g.optionNo('[No.]'), '');
  assert.deepEqual(g.requestNo('612A'), { no: '', ambiguous: true });
  assert.deepEqual(g.requestNo('No.612 - 4세대'), { no: '612', ambiguous: false });
  assert.equal(g.normCode(' no.h152 '), 'H152');
  assert.equal(g.hasBsa('BSA 없음'), false);
  assert.equal(g.hasBsa('BSA X'), false);
  assert.equal(g.hasBsa('No.1 BSA'), true);
  assert.equal(g.bsaEditionOfImwebValues(['21~ BSA X', '21~ BSA O']), 'normal');
  assert.equal(g.bsaEditionOfImwebValues(['21~ BSA O']), 'bsa');
  assert.equal(g.bsaEditionOfImwebValues(['21~']), 'unknown');
  assert.equal(g.brandKey('기아 (KIA)'), g.brandKey('기아'));
  assert.equal(g.brandKey('토요타'), g.brandKey('도요타'));
  assert.equal(g.brandKey('르노삼성'), g.brandKey('르노 코리아'));
  assert.equal(g.brandKey('쎄미시스코'), g.brandKey('세미시스코'));
  const qm6 = g.splitCarTitle('옵틱글래스 르노 코리아 QM6 광각 사이드 와이드미러', g.brandsFromCatalog({ coupang: [{ brand: '르노 코리아' }, { brand: '르노' }] }));
  assert.equal(qm6.brand, '르노 코리아'); assert.equal(qm6.model, 'QM6');
  const unknown = g.splitCarTitle('옵틱글래스 모르는차 모델X 광각 사이드 미러', BRANDS);
  assert.equal(unknown.brand, '모르는차'); assert.equal(unknown.model, '모델X');
});

// ── 2. 차종 비교 ────────────────────────────────────────────────────────
test('sameModel: 경계가 맞는 포함만 같은 차', () => {
  for (const [a, b] of [['X3', 'iX3'], ['S클래스', 'CLS클래스'], ['SL', 'SLK'], ['A6', 'A4-A 680R']]) {
    assert.equal(g.sameModel(a, b).match, false, `${a} ↔ ${b}`);
  }
  for (const [a, b] of [['골프A', '골프'], ['K5', 'K5 680R'], ['M4', 'M3/M4'], ['싼타페', '디올뉴싼타페'], ['EQB 전기차', 'EQC EQA EQB 전기차']]) {
    assert.deepEqual(g.sameModel(a, b), { match: true, exact: false }, `${a} ↔ ${b}`);
  }
  assert.deepEqual(g.sameModel('K 5', 'k5'), { match: true, exact: true });
  assert.equal(g.sameCar({ brand: '현대', model: '싼타페' }, { brand: '기아', model: '싼타페' }).match, false);
  assert.equal(g.sameCar({ brand: '르노삼성', model: 'QM6' }, { brand: '르노 코리아', model: 'QM6' }).match, true);
});

// ── 3~8. 쿠팡 스냅샷 판정 ───────────────────────────────────────────────
test('쿠팡: 스냅샷 두 벌에 적중하면 두 ID 를 모두 보여 주고 막는다', async () => {
  await assert.rejects(runCoupang(cpData()), e => {
    assert.equal(e.duplicate, true);
    assert.match(e.message, /111/); assert.match(e.message, /222/); assert.match(e.message, /스냅샷/);
    assert.match(e.message, /차종 표기 다름/);   // 222 는 디올뉴싼타페
    assert.match(e.message, /상품수정 모드/);
    assert.deepEqual(e.existing.products.map(p => p.id).sort(), ['111', '222']);
    assert.equal(e.existing.source, 'snapshot');
    return true;
  });
});

test('쿠팡: 번호가 다르거나 BSA 판이 다르면 통과한다', async () => {
  assert.equal((await runCoupang(cpData({ optionModel: 'No.H999 - 1세대' }))).registered, 1);
  assert.equal((await runCoupang(cpData({ optionModel: 'No.H131번 (7세대)' }))).registered, 1);          // BSA 없는 판
  assert.equal((await runCoupang(cpData({ optionModel: 'No.H120 - 4세대 BSA' }))).registered, 1);        // 스냅샷은 일반판
  assert.equal((await runCoupang(cpData({ optionModel: 'No.H131 BSA 없음' }))).registered, 1);          // 부정 표기
});

test('쿠팡: 소문자 입력도 막고, 포함 일치는 표기 다름으로 알리며, 브랜드가 다르면 통과', async () => {
  await assert.rejects(runCoupang(cpData({ optionModel: 'no.h131 bsa' })), /111/);
  await assert.rejects(runCoupang(cpData({ title: '옵틱글래스 현대 디올뉴싼타페 광각 사이드 와이드미러', optionModel: 'No.H120 - 4세대' })),
    e => /111/.test(e.message) && /차종 표기 다름/.test(e.message));
  assert.equal((await runCoupang(cpData({ title: '옵틱글래스 기아 싼타페 광각 사이드 와이드미러' }))).registered, 1);
});

test('쿠팡: 여러 옵션 중 하나라도 중복이면 전체를 막고 중복 옵션을 모두 적는다', async () => {
  await assert.rejects(runCoupang(cpData({ optionModel: 'No.H999 - 1세대, No.H131 BSA' })),
    e => /No\.H131 BSA/.test(e.message) && !/No\.H999/.test(e.message));
  await assert.rejects(runCoupang(cpData({ optionModel: 'No.H131 BSA, No.H120 - 4세대' })),
    e => /No\.H131 BSA/.test(e.message) && /No\.H120 →/.test(e.message));
});

test('쿠팡: 번호가 애매하면 그 옵션은 판정하지 않고 알린다, 차종을 모르면 건너뛴다', async () => {
  const r = await runCoupang(toresData({ optionModel: '612A' }));
  assert.equal(r.registered, 1);
  assert.ok(r.notices.some(n => /애매/.test(n)));
  const plan = g.planCoupang({ title: '', optionModel: 'No.1' }, { vendorId: 'A001', brands: BRANDS });
  assert.equal(plan.skip, true);
});

// ── 9. 쿠팡 적중 해제 ───────────────────────────────────────────────────
test('쿠팡: 조회가 모름이면 계속 막고, 삭제가 확인될 때만 스냅샷 적중을 푼다', async () => {
  const one = cpData({ optionModel: 'No.H120 - 4세대' });   // 111 에만 있음
  await assert.rejects(runCoupang(one, { lookup: fakeCoupang({ products: { 111: { code: 'ERROR', data: null } } }) }), /111/);
  await assert.rejects(runCoupang(one, { lookup: fakeCoupang({ products: { 111: cpProduct('111', ['공용']) } }) }), /111/);
  const deleted = await runCoupang(one, { lookup: fakeCoupang({ products: { 111: cpProduct('111', ['No.H120 - 4세대'], '삭제') } }) });
  assert.equal(deleted.registered, 1);
  assert.ok(deleted.notices.includes('스냅샷의 111 는 쿠팡에서 삭제된 상품이라 제외'));
  for (const msg of ['쿠팡 API 오류 (404): 상품이 존재하지 않습니다.', '쿠팡 API 오류 (400): Product not found']) {
    assert.equal((await runCoupang(one, { lookup: fakeCoupang({ throwOn: { 111: msg } }) })).registered, 1, msg);
  }
  await assert.rejects(runCoupang(one, { lookup: fakeCoupang({ throwOn: { 111: '쿠팡 API 오류 (500): 존재하지 않습니다' } }) }), /111/);
});

test('쿠팡: 원장 행은 유예시간 없이 삭제 확인 즉시 해제된다', async t => {
  const ledger = ledgerAt(t);
  await runCoupang(toresData(), { ledger, result: { code: 'SUCCESS', data: 777 } });
  const lookup = fakeCoupang({ products: { 777: cpProduct('777', ['No.T100 - 1세대'], 'DELETED') } });
  const again = await runCoupang(toresData(), { ledger, lookup });
  assert.equal(again.registered, 1);
  const rows = ledger.entries();
  assert.equal(rows[0].supersededReason, '쿠팡에서 삭제 확인');
  assert.equal(ledger.active('coupang').length, 1);   // 두 번째 등록의 새 행
});

// ── 10. 쿠팡 실시간 목록 ────────────────────────────────────────────────
test('쿠팡 실시간: 목록 응답 이상은 fail-open, 5000건 초과·후보 20건 초과는 알린다', async () => {
  const bad = await runCoupang(toresData(), { lookup: fakeCoupang({ listCode: 'ERROR' }) });
  assert.equal(bad.registered, 1);
  assert.ok(bad.notices.some(n => /쿠팡 실시간 중복 확인 실패/.test(n)));

  const endless = fakeCoupang({ endless: true });
  const many = await runCoupang(toresData(), { lookup: endless });
  assert.equal(endless.calls.list, 50);
  assert.ok(many.notices.includes('목록 5000건 초과 — 일부만 확인'));

  const rows = Array.from({ length: 21 }, (_, i) => ({ sellerProductId: 1000 + i, sellerProductName: '옵틱글래스 쌍용 토레스 광각 사이드 와이드미러' }));
  const lookup = fakeCoupang({ pages: [rows] });
  const cut = await runCoupang(toresData(), { lookup });
  assert.equal(cut.registered, 1);
  assert.equal(lookup.calls.get.length, 20);
  assert.ok(cut.notices.some(n => /21건 중 20건만 확인/.test(n)));
});

test('쿠팡 실시간: 같은 차·번호·판이 있으면 막고, 차종이 다른 후보는 알리기만 한다', async () => {
  const rows = [{ sellerProductId: 4242, sellerProductName: '옵틱글래스 쌍용 토레스 광각 사이드 와이드미러' }];
  await assert.rejects(runCoupang(toresData(), { lookup: fakeCoupang({ pages: [rows], products: { 4242: cpProduct('4242', ['No.T100 - 1세대']) } }) }),
    e => e.source === 'live' && /4242/.test(e.message) && /쿠팡 실시간 조회/.test(e.message));
  // 이름에는 'x3' 가 들어 있지만(느슨한 후보) 차종은 iX3 — 같은 번호가 있어도 막지 않는다
  const loose = [{ sellerProductId: 5151, sellerProductName: '옵틱글래스 BMW iX3 광각 사이드 와이드미러' }];
  const x3 = cpData({ title: '옵틱글래스 BMW X3 광각 사이드 와이드미러', optionModel: 'No.101' });
  const r = await runCoupang(x3, { lookup: fakeCoupang({ pages: [loose], products: { 5151: cpProduct('5151', ['No.101']) } }) });
  assert.equal(r.registered, 1);
  assert.ok(r.notices.some(n => /5151/.test(n) && /차종이 달라/.test(n)));
});

// ── 11. allowDuplicate ──────────────────────────────────────────────────
test('allowDuplicate: 쿠팡은 true 일 때만 새 상품 중복 검사를 건너뛰고 원장에 bypass 를 남긴다', async t => {
  const ledger = ledgerAt(t);
  const lookup = fakeCoupang();
  const r = await runCoupang(cpData({ allowDuplicate: true }), { ledger, lookup });
  assert.equal(r.registered, 1);
  assert.equal(r.bypassed, true);
  assert.equal(lookup.calls.get.length + lookup.calls.list, 0);
  assert.equal(ledger.entries()[0].bypass, true);
  await assert.rejects(runCoupang(cpData({ allowDuplicate: 'true' }), { ledger }), /중복 등록 차단/);
});

// ── 12. 원장 뒤 재등록 ──────────────────────────────────────────────────
test('쿠팡: 이 PC 에서 등록한 상품을 다시 등록하면 원장 근거로 막는다(새 인스턴스로 읽어도)', async t => {
  const dir = tmpDir(t);
  const now = clock();
  const ledger = new RegistrationLedger(dir, { now });
  const first = await runCoupang(toresData(), { ledger, result: { code: 'SUCCESS', data: 555 } });
  assert.equal(first.registered, 1);
  await assert.rejects(runCoupang(toresData(), { ledger }), e => e.source === 'ledger' && /555/.test(e.message) && /원장\(이 PC/.test(e.message));
  await assert.rejects(runCoupang(toresData(), { ledger: new RegistrationLedger(dir, { now }) }), /555/);
});

// ── 13. 기록 실패 ───────────────────────────────────────────────────────
test('원장 기록이 실패해도 등록 성공은 유지되고 알림만 남는다', async t => {
  const r = await runCoupang(toresData(), { record: () => { throw new Error('disk full'); } });
  assert.equal(r.registered, 1);
  assert.ok(r.notices.includes('중복 방지 기록 저장에 실패했습니다 — 등록은 정상 완료.'));

  const dir = tmpDir(t);
  const blocker = path.join(dir, 'not-a-dir');
  fs.writeFileSync(blocker, 'x');
  const blocked = await runCoupang(toresData(), { ledger: new RegistrationLedger(blocker) });
  assert.equal(blocked.registered, 1);
  assert.ok(blocked.notices.includes('중복 방지 기록 저장에 실패했습니다 — 등록은 정상 완료.'));

  const ledger = ledgerAt(t);
  const err = await runCoupang(toresData(), { ledger, result: { code: 'ERROR', data: null } });
  assert.equal(ledger.entries().length, 0);
  assert.ok(err.notices.includes('등록 응답에 상품ID가 없어 중복 방지 기록을 남기지 않음'));
});

// ── 14~15. 네이버 ───────────────────────────────────────────────────────
const nvData = (over = {}) => ({ templateId: '999', title: '옵틱글래스 기아 K5 광각 사이드 와이드미러', optionProduct: '24.10~[No.K138]BSA', mode: 'copy', ...over });
const nvOrigin = names => ({ originProduct: { detailAttribute: { optionInfo: { optionCombinations: names.map(n => ({ optionName1: n })) } } } });
function fakeNaver({ rows = [], origins = {}, failList = null } = {}) {
  return {
    allProducts: async () => { if (failList) throw new Error(failList); return rows; },
    originProduct: async no => { const o = origins[no]; if (o instanceof Error) throw o; return o ?? { originProduct: { detailAttribute: { optionInfo: {} } } }; },
  };
}
const nvRow = (no, name, extra = {}) => ({ id: String(no), originProductNo: no, channelProductNo: no * 10, name, statusType: 'SALE', ...extra });
const naverCheck = (data, deps) => g.checkNaver(g.planNaver(data, { brands: BRANDS }), { bypass: false }, { log: quiet, ...deps });

test('네이버 원장: 미확인 행은 10분 무조건, 그 뒤는 조회 결과에 따라, 확인된 행은 30분+없음 확인', async t => {
  const now = clock();
  const ledger = ledgerAt(t, now);
  const plan = g.planNaver(nvData(), { brands: BRANDS });
  g.recordNaver(ledger, plan, 'https://sell.smartstore.naver.com/#/products/copy/999');
  now.advance(9 * MIN);
  await assert.rejects(naverCheck(nvData(), { ledger, api: null, now }), e => e.source === 'ledger' && /상품번호 미확인/.test(e.message));
  now.advance(2 * MIN);
  const open = await naverCheck(nvData(), { ledger, api: null, now });
  assert.ok(open.notices.some(n => /등록을 시도한 기록/.test(n)));
  const partial = fakeNaver({ rows: [nvRow(1, '옵틱글래스 기아 K5 광각 사이드 와이드미러')], origins: { 1: nvOrigin(['공용']) } });
  await assert.rejects(naverCheck(nvData(), { ledger, api: partial, now }), /원장/);
  now.advance(25 * 60 * MIN);
  const late = await naverCheck(nvData(), { ledger, api: partial, now });
  assert.ok(late.notices.some(n => /등록을 시도한 기록/.test(n)));

  const now2 = clock();
  const ledger2 = ledgerAt(t, now2);
  g.recordNaver(ledger2, plan, 'https://smartstore.naver.com/opticglass/products/987');
  now2.advance(31 * MIN);
  await assert.rejects(naverCheck(nvData(), { ledger: ledger2, api: fakeNaver({ rows: [] }), now: now2 }), /987/);   // 빈 목록은 모름
  const other = fakeNaver({ rows: [nvRow(5, '옵틱글래스 현대 싼타페 광각 사이드 와이드미러')] });
  await naverCheck(nvData(), { ledger: ledger2, api: other, now: now2 });
  assert.equal(ledger2.entries()[0].supersededReason, '네이버에서 없음 확인');
});

test('네이버: 수정 모드는 검사하지 않고, 같은 번호·BSA 만 막는다', async () => {
  const plan = g.planNaver(nvData({ mode: 'edit' }), { brands: BRANDS });
  let checked = 0;
  await g.runGuardedRegistration({ channel: 'naver', data: nvData({ mode: 'edit' }), plan, log: quiet,
    check: async () => { checked++; return { notices: [] }; }, register: async () => 'url', record: () => null });
  assert.equal(checked, 0);

  const api = fakeNaver({ rows: [nvRow(1, '옵틱글래스 기아 K5 광각 사이드 와이드미러')], origins: { 1: nvOrigin(['24.10~[No.K138]BSA']) } });
  await assert.rejects(naverCheck(nvData(), { api }), e => e.source === 'live' && /K138/.test(e.message));
  const plain = await naverCheck(nvData({ optionProduct: '24.10~[No.K138]' }), { api });
  assert.deepEqual(plain.notices, []);
  const hybrid = fakeNaver({ rows: [nvRow(2, '옵틱글래스 기아 K5 하이브리드 광각 사이드 와이드미러')], origins: { 2: nvOrigin(['No.K138 BSA']) } });
  await assert.rejects(naverCheck(nvData(), { api: hybrid }), /K5 하이브리드/);
});

test('네이버: 조회 불가·조회 실패는 알리고 진행하며, 원장 번호는 스마트스토어 주소에서만 뽑는다', async t => {
  const none = await naverCheck(nvData(), { api: null, apiError: '커머스API 인증정보 없음' });
  assert.ok(none.notices.some(n => /네이버 중복 확인을 못 했습니다\(커머스API 인증정보 없음\)/.test(n)));
  const broken = fakeNaver({ rows: [nvRow(1, '옵틱글래스 기아 K5 광각 사이드 와이드미러')], origins: { 1: new Error('HTTP 500') } });
  const r = await naverCheck(nvData(), { api: broken });
  assert.ok(r.notices.some(n => /HTTP 500/.test(n)));

  const ledger = ledgerAt(t);
  const plan = g.planNaver(nvData(), { brands: BRANDS });
  g.recordNaver(ledger, plan, 'https://sell.smartstore.naver.com/#/products/copy/12345');
  g.recordNaver(ledger, plan, 'https://smartstore.naver.com/opticglass/products/987');
  const [copy, real] = ledger.entries();
  assert.equal(copy.externalId, null); assert.equal(copy.verified, false);
  assert.equal(real.externalId, '987'); assert.equal(real.verified, true);
});

// ── 16. 아마존 ──────────────────────────────────────────────────────────
const JP = 'A1VC38T7YXB528';
const amzConfig = { sellerId: 'SELLER', marketplaceId: 'ATVPDKIKX0DER' };
function amzDeps({ items = [], raw = null, fail = null, cacheItems = null, ledger = null, now = clock() } = {}) {
  const calls = [];
  return {
    calls,
    deps: {
      ledger, now,
      searchBySkus: async (ids, mp) => { calls.push({ ids, mp }); if (fail) throw new Error(fail); return raw ?? { items }; },
      toRow: l => ({ id: l.sku, name: l.name, asin: l.asin }),
      cache: () => (cacheItems ? { updatedAt: '2026-09-20T00:00:00Z', items: cacheItems } : null),
    },
  };
}
const amzCheck = (data, deps, bypass = false) => g.checkAmazon(g.planAmazon(data, { config: amzConfig }), { bypass }, deps);

test('아마존: 실시간에 같은 SKU 가 있으면 막고 ASIN·주소를 보여 준다(JP 는 co.jp)', async () => {
  const { deps, calls } = amzDeps({ items: [{ sku: 'og-1', asin: 'B0TEST', name: 'Mirror' }] });
  await assert.rejects(amzCheck({ sku: 'OG-1' }, deps), e => e.source === 'live' && /B0TEST/.test(e.message) && /amazon\.com\/dp\/B0TEST/.test(e.message));
  assert.deepEqual(calls[0].ids.sort(), ['OG-1', 'og-1']);
  const jp = amzDeps({ items: [{ sku: 'OG-1', asin: 'B0JP' }] });
  await assert.rejects(amzCheck({ sku: 'OG-1', marketplaceId: JP }, jp.deps), /amazon\.co\.jp\/dp\/B0JP/);
  assert.equal(jp.calls[0].mp, JP);
  const mixed = amzDeps({ items: [] });
  await amzCheck({ sku: 'Og-1' }, mixed.deps);
  assert.deepEqual(mixed.calls[0].ids.sort(), ['OG-1', 'Og-1', 'og-1']);
});

test('아마존: 조회 이상·쉼표 SKU 는 확인 불가로 멈추고, 캐시 적중은 막는다', async () => {
  await assert.rejects(amzCheck({ sku: 'OG-1' }, amzDeps({ raw: { rawResponse: '<html>' } }).deps), e => e.checkFailed === true && e.duplicate === false);
  await assert.rejects(amzCheck({ sku: 'A,B' }, amzDeps().deps), e => e.checkFailed === true && /쉼표/.test(e.message));
  await assert.rejects(amzCheck({ sku: 'OG-1' }, amzDeps({ cacheItems: [{ id: 'og-1', name: 'Old', asin: 'B0OLD' }] }).deps),
    e => e.source === 'cache' && /전체 목록 동기화/.test(e.message));
  await assert.rejects(amzCheck({ sku: 'OG-1' }, amzDeps({ fail: 'timeout', cacheItems: [{ id: 'OG-1' }] }).deps), e => e.source === 'cache');
  await assert.rejects(amzCheck({ sku: 'OG-1' }, amzDeps({ fail: 'timeout' }).deps), e => e.checkFailed && /timeout/.test(e.message));
});

test('아마존 allowDuplicate: 덮어쓰기 방지는 풀리지 않는다', async () => {
  await assert.rejects(amzCheck({ sku: 'OG-1', allowDuplicate: true }, amzDeps({ items: [{ sku: 'OG-1' }] }).deps, true), e => e.duplicate === true);
  await assert.rejects(amzCheck({ sku: 'OG-1' }, amzDeps({ fail: 'down', cacheItems: [{ id: 'OG-1' }] }).deps, true), e => e.checkFailed === true);
  const ok = await amzCheck({ sku: 'OG-1' }, amzDeps({ cacheItems: [{ id: 'OG-1' }] }).deps, true);
  assert.deepEqual(ok.notices, []);
});

test('아마존: 원장만 있고 실시간에 없으면 다시 제출을 알리고 통과, 다른 마켓 원장은 무관, INVALID 는 기록 안 함', async t => {
  const now = clock();
  const ledger = ledgerAt(t, now);
  const plan = g.planAmazon({ sku: 'OG-1', titleEn: 'Mirror' }, { config: amzConfig });
  g.recordAmazon(ledger, plan, { status: 'ACCEPTED', raw: { submissionId: 'S1' } });
  g.recordAmazon(ledger, g.planAmazon({ sku: 'OG-2', marketplaceId: JP }, { config: amzConfig }), { status: 'ACCEPTED', raw: {} });
  g.recordAmazon(ledger, plan, { status: 'INVALID', raw: {} });
  assert.equal(ledger.entries().length, 2);
  now.advance(5 * MIN);
  const r = await amzCheck({ sku: 'OG-1' }, amzDeps({ ledger, now }).deps);
  assert.ok(r.notices.some(n => /다시 제출/.test(n)));
  const jp = await amzCheck({ sku: 'OG-1', marketplaceId: JP }, amzDeps({ ledger, now }).deps);
  assert.deepEqual(jp.notices, []);
  assert.equal(g.amazonSkuOf({ itemCode: ' X1 ' }), 'X1');
});

// ── 17. 아임웹 ──────────────────────────────────────────────────────────
const iwData = (over = {}) => ({
  targetB2b: true, targetHead: false, targetUs: false, targetJp: false, isEditMode: false,
  brand: '현대', model: '싼타페', titleBrand: '현대', titleModel: '싼타페', code: 'H152',
  bsaO: true, bsaX: false, registerIndiv: false, registerSet: true, ...over,
});
const iwRow = (over = {}) => ({ prodNo: 900, name: '옵틱글래스 현대 싼타페 미러 1셋 [H152]', price: 220000, status: 'SALE', type: 'set', ...over });
function iwCheck(data, { rows = [iwRow()], complete = true, options = null, posts = [], boardNames = { ko: '현대', en: 'HYUNDAI' }, ledger = null, now = clock(), b2bRows } = {}) {
  const plan = g.planImweb(data, {
    brands: BRANDS, boardNameFor: (b, l) => boardNames[l] || null,
    nameForLang: (d, f, l) => (l === 'ko' ? d[f] : d[f + 'En'] || d[f]), extractImageUrl: s => String(s || '').trim(),
  });
  return { plan, run: () => g.checkImweb(plan, { bypass: false }, {
    ledger, now, log: quiet,
    b2bRows: b2bRows || (async () => ({ rows, complete })),
    b2bOptionValues: async () => { if (options instanceof Error) throw options; return options || []; },
    boardPosts: async () => ({ rows: posts, complete: true }),
  }) };
}

test('아임웹 B2B: 같은 종류·코드·판이면 막고, 종류·코드가 다르면 통과', async () => {
  await assert.rejects(iwCheck(iwData()).run(), e => /900/.test(e.message) && /세트/.test(e.message) && /체크/.test(e.message)
    && /detail\?idx=900/.test(e.message));
  assert.deepEqual((await iwCheck(iwData({ registerSet: false, registerIndiv: true })).run()).notices, []);
  assert.deepEqual((await iwCheck(iwData(), { rows: [iwRow({ name: '옵틱글래스 현대 싼타페 미러 1셋 [H1520]' })] }).run()).notices, []);
  const other = await iwCheck(iwData({ bsaO: false, bsaX: true })).run();
  assert.ok(other.notices.some(n => /BSA판 상품 900/.test(n)));
});

test('아임웹 B2B: 가격으로 판을 모르면 연식 옵션으로, 그래도 모르면 막는다', async () => {
  await assert.rejects(iwCheck(iwData(), { rows: [iwRow({ price: 99000 })], options: ['21~ BSA O'] }).run(), /900/);
  await assert.rejects(iwCheck(iwData(), { rows: [iwRow({ price: 99000 })], options: new Error('500') }).run(), /판 확인 불가\(가격 99000원\)/);
});

test('아임웹 B2B: 목록을 못 받거나 끝까지 못 받으면 확인 불가로 멈춘다', async () => {
  // B2B 목록은 Open API(imweb_b2b.js)로 전체를 읽는다. 목록 호출이 실패하면 '없음'이 아니라 확인 불가다.
  const iw = Object.create(ImwebEdit.prototype);
  iw.b2b = createB2bApi({
    siteInfo: async () => ({ unitList: [{ unitCode: 'u', currency: 'KRW' }] }),
    products: async () => { throw new Error('아임웹 API 오류 (500)'); },
  });
  await assert.rejects(iwCheck(iwData(), { b2bRows: code => iw.listB2bRowsByCode(code) }).run(), e => e.checkFailed === true && /500/.test(e.message));
  await assert.rejects(iwCheck(iwData(), { complete: false }).run(), e => e.checkFailed === true && /끝까지/.test(e.message));
  // 전체를 읽으므로 잘리지 않는다 — 코드가 든 상품만 남기고 complete 는 true
  iw.b2b = createB2bApi({
    siteInfo: async () => ({ unitList: [{ unitCode: 'u', currency: 'KRW' }] }),
    products: async () => Array.from({ length: 120 }, (_, i) => ({ prodNo: i + 1, name: i === 7 ? '옵틱글래스 현대 싼타페 미러 1셋 [h152]' : `상품 ${i}`, price: 1000 })),
  });
  const got = await iw.listB2bRowsByCode('H152');
  assert.deepEqual([got.rows.map(r => r.prodNo), got.complete], [[8], true]);
});

test('아임웹 B2B: 제목 형식이 달라도 [코드]·차종·종류가 맞으면 막고, 숨김 상품은 안내한다', async () => {
  await assert.rejects(iwCheck(iwData(), { rows: [iwRow({ name: '현대 싼타페 사이드미러 세트 [H152]', type: 'etc' })] }).run(), /제목 형식 다름/);
  await assert.rejects(iwCheck(iwData(), { rows: [iwRow({ status: 'HIDDEN' })] }).run(), /판매중으로 바꾸세요/);
});

test('아임웹 게시판: 매핑 없는 언어는 빼고, 같은 제목 글이 있으면 막는다', async () => {
  const data = iwData({ targetB2b: false, targetHead: true, targetUs: true, targetJp: true, titleBrandEn: 'Hyundai', titleModelEn: 'Santa Fe', specImageUrl: 'https://x/spec.png' });
  const { plan, run } = iwCheck(data, { posts: [{ postCode: 'P1', subject: '현대 싼타페 [H152]' }], boardNames: { ko: '현대', en: 'HYUNDAI' } });
  assert.deepEqual(plan.targets.map(t => t.lang), ['ko', 'en']);
  await assert.rejects(run(), e => /본사몰 게시판/.test(e.message) && /P1/.test(e.message));
});

// ── 18. 동시 실행 잠금 ──────────────────────────────────────────────────
test('잠금: 진행 중인 같은 키는 막고, 끝나면 풀리며, 오래된 잠금은 넘겨받는다', async () => {
  const inflight = g.createInflightLock({ log: quiet });
  let finish;
  const plan = g.planCoupang(toresData(), { vendorId: 'A001', brands: BRANDS });
  const gate = new Promise(r => { finish = r; });
  // 먼저 시작한 등록이 register 에서 멈춰 있는 동안(잠금을 쥔 채)
  const held = g.runGuardedRegistration({ channel: 'coupang', data: toresData(), plan, inflight, log: quiet,
    check: async () => ({ notices: [] }), register: () => gate, record: () => null });
  await assert.rejects(runCoupang(toresData(), { inflight }), /이미 진행 중/);
  // 싼타페 등록 중에 같은 번호의 디올뉴싼타페는 같은 키
  const a = g.planCoupang(cpData({ optionModel: 'No.H555' }), { vendorId: 'A001', brands: BRANDS });
  const b = g.planCoupang(cpData({ title: '옵틱글래스 현대 디올뉴싼타페 광각 사이드 와이드미러', optionModel: 'No.H555' }), { vendorId: 'A001', brands: BRANDS });
  assert.deepEqual(a.lockKeys, b.lockKeys);
  finish({ code: 'SUCCESS', data: 1 });
  await held;
  assert.equal((await runCoupang(toresData(), { inflight })).registered, 1);

  let at = 0;
  const warns = [];
  const lock = g.createInflightLock({ ttlMs: 1000, now: () => at, log: { warn: m => warns.push(m) } });
  lock.acquire(['k'], 'x');
  assert.throws(() => lock.acquire(['k'], 'x'), /진행 중/);
  at = 2000;
  lock.acquire(['k'], 'x');
  assert.equal(warns.length, 1);
});

// ── 19. 원장 손상 ───────────────────────────────────────────────────────
test('원장: 깨진 파일은 .corrupt-* 로 보존하고 빈 원장으로 시작한다', t => {
  const dir = tmpDir(t);
  fs.writeFileSync(path.join(dir, 'registration_ledger.json'), '{ broken');
  const ledger = new RegistrationLedger(dir);
  assert.deepEqual(ledger.entries(), []);
  assert.match(ledger.lastReadError, /손상/);
  assert.ok(fs.readdirSync(dir).some(f => f.startsWith('registration_ledger.json.corrupt-')));
  ledger.record({ channel: 'coupang', keys: ['k'] });
  assert.equal(new RegistrationLedger(dir).entries().length, 1);
});

// ── 20. eBay 레거시 리스팅 ──────────────────────────────────────────────
const ebayConfig = { environment: 'sandbox', clientId: 'app', clientSecret: 'test-secret', refreshToken: 'test-refresh', ruName: 'test-runame', merchantLocationKey: 'warehouse', fulfillmentPolicyId: 'shipping', paymentPolicyId: 'payment', returnPolicyId: 'returns' };
const ebayProduct = { sku: 'OG-1-L', title: 'OpticGlass Left Mirror Glass', brand: 'OpticGlass', mpn: 'OG-1', price: '59.99', quantity: '5', categoryId: '123', description: 'Mirror glass', imageUrls: 'https://images.example.com/glass.jpg', aspects: {} };
const mockEncryption = { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(`encrypted:${s}`), decryptString: b => b.toString().slice(10) };
function ebayFixture(t) {
  const directory = tmpDir(t);
  const store = new EbayStore(directory, mockEncryption); store.save(ebayConfig);
  const remote = { inventory: null, offers: [], calls: [] };
  const api = {
    inventory: async () => structuredClone(remote.inventory), offers: async () => structuredClone(remote.offers), aspects: async () => ({ aspects: [] }),
    async request(method, url, body) {
      remote.calls.push({ method, url, body });
      if (method === 'PUT' && url.includes('inventory_item')) { remote.inventory = structuredClone(body); return {}; }
      if (method === 'POST' && url.endsWith('/offer')) { remote.offers = [{ ...structuredClone(body), offerId: 'offer-1', status: 'UNPUBLISHED' }]; return { offerId: 'offer-1' }; }
      if (url.endsWith('/publish')) { remote.offers[0].status = 'PUBLISHED'; remote.offers[0].listing = { listingId: 'listing-1' }; return { listingId: 'listing-1' }; }
      throw new Error(`Unexpected request ${url}`);
    },
  };
  const cache = items => store.saveListingsCache({ updatedAt: '2026-09-20T00:00:00Z', environment: 'sandbox', total: items.length, items });
  return { store, remote, api, cache, service: new Ebay(store, () => api) };
}
const legacyRow = (sku, listingId = 'L9') => ({ id: sku || listingId, sku, listingId, name: 'Legacy', price: '1', stock: '1', url: `https://www.ebay.com/itm/${listingId}`, status: 'Active' });

test('eBay: 활성 리스팅 캐시에 같은 SKU 가 있으면 새 Offer 를 만들지 않는다', async t => {
  const { service, remote, cache } = ebayFixture(t);
  cache([legacyRow('og-1-l')]);
  await assert.rejects(service.saveDraft(ebayProduct), e => /이미 eBay에 게시 중/.test(e.message) && e.duplicate === true && e.existing.products[0].id === 'L9');
  assert.equal(remote.calls.filter(c => c.method === 'PUT').length, 0);
});

test('eBay: sku 없는 행은 무시하고, 캐시가 깨져도 진행한다', async t => {
  const a = ebayFixture(t);
  a.cache([legacyRow('', 'OG-1-L')]);
  assert.equal((await a.service.saveDraft(ebayProduct)).status, 'DRAFT');
  const b = ebayFixture(t);
  fs.writeFileSync(b.store.listingsPath, '{ broken');
  assert.equal((await b.service.saveDraft(ebayProduct)).status, 'DRAFT');
});

test('eBay: allowDuplicate 면 초안·게시가 통과하고 job 에 bypassLegacy 가 남는다', async t => {
  const { service, store, cache } = ebayFixture(t);
  cache([legacyRow('OG-1-L')]);
  assert.equal((await service.saveDraft({ ...ebayProduct, allowDuplicate: true })).status, 'DRAFT');
  assert.equal(store.job(store.jobKey(store.config(), 'OG-1-L')).bypassLegacy, true);
  assert.equal((await service.publish('OG-1-L')).status, 'PUBLISHED');
});

test('eBay: 초안 저장 뒤 캐시에 같은 SKU 가 생기면 게시를 거부한다', async t => {
  const { service, remote, cache } = ebayFixture(t);
  await service.saveDraft(ebayProduct);
  cache([legacyRow('OG-1-L')]);
  await assert.rejects(service.publish('OG-1-L'), /이미 eBay에 게시 중/);
  assert.equal(remote.calls.filter(c => c.url.endsWith('/publish')).length, 0);
});

test('eBay IPC: 중복 응답에 duplicate·existing 이 실린다', async t => {
  const { service, cache } = ebayFixture(t);
  cache([legacyRow('OG-1-L')]);
  const handlers = {};
  const uiDirectory = path.join(ROOT, 'src', 'ui');
  registerEbayIPC({ app: { getPath: () => { throw new Error('must not read'); } }, ipcMain: { handle: (n, fn) => { handlers[n] = fn; } },
    safeStorage: {}, shell: {}, uiDirectory, getEbayService: () => service });
  const res = await handlers['ebay-save-draft']({ senderFrame: { url: pathToFileURL(path.join(uiDirectory, 'index.html')).href } }, ebayProduct);
  assert.equal(res.success, false);
  assert.equal(res.duplicate, true);
  assert.equal(res.existing.channel, 'ebay');
});

test('eBay: allowDuplicate 는 그 저장에만 적용된다 — 다음 저장이 bypassLegacy 를 false 로 덮는다', async t => {
  const { service, store, remote, cache } = ebayFixture(t);
  cache([legacyRow('OG-1-L')]);
  await service.saveDraft({ ...ebayProduct, allowDuplicate: true });
  // 같은 입력으로 다시 저장(멱등 복구 경로) — 이번에는 우회 요청이 없다
  assert.equal((await service.saveDraft(ebayProduct)).status, 'DRAFT');
  assert.equal(store.job(store.jobKey(store.config(), 'OG-1-L')).bypassLegacy, false);
  await assert.rejects(service.publish('OG-1-L'), /이미 eBay에 게시 중/);
  assert.equal(remote.calls.filter(c => c.url.endsWith('/publish')).length, 0);
});

// ── 리뷰 회귀: 브랜드 표기 차이 (실제 카탈로그 행) ─────────────────────────
// UI 카테고리는 제네시스를 '현대' 밑, 험머를 '기타'·'GMC' 밑, 르노를 '르노삼성'으로 적고
// 쿠팡 상품명은 '제네시스'·'허머'·'르노' 를 브랜드로 쓴다 — 정확한 중복이 빠져나가면 안 된다.
const REAL = {
  _built: '2026-09-23T07:30:43.221Z',
  variants: [{ brand: '현대 (Hyundai)', model: '제네시스 GV80' }, { brand: '기타', model: 'GMC 험머 H3' }, { brand: '르노 코리아 (Renault)', model: 'SM6' }],
  coupang: [
    { id: '13706995842', name: '옵틱글래스 제네시스 GV80 광각 사이드 와이드미러', brand: '제네시스', model: 'GV80', options: [{ text: 'No.H127 - 1세대(20~)BSA' }] },
    { id: '13706986807', name: '옵틱글래스 제네시스 G90 광각 사이드 와이드미러', brand: '제네시스', model: 'G90', options: [{ text: 'No.H110-3세대 페리(18.11~21.12)BSA' }] },
    { id: '13678340521', name: '옵틱글래스 르노 SM6 광각 사이드 와이드미러', brand: '르노', model: 'SM6', options: [{ text: 'No.R106 - (1세대 전기/16.03~20.07)' }] },
    { id: '13675645189', name: '옵틱글래스 험머 H3 광각 사이드 와이드미러', brand: '허머', model: 'H3', options: [{ text: 'No.5557-단일 세대/06.07~10.05거울교체형' }] },
    { id: '13675632631', name: '옵틱글래스 피아트500X 광각 사이드 와이드미러', brand: '피아트', model: '500X', options: [{ text: 'No.5003-(1세대/15.07~19.10)BSA' }] },
  ],
};
test('브랜드 표기 차이: 현대›제네시스·기타›GMC 험머·르노삼성·기타›피아트 도 같은 차로 막는다', async () => {
  const brands = g.brandsFromCatalog(REAL);
  const run = data => g.checkCoupang(g.planCoupang(data, { vendorId: 'A001', brands }), { bypass: false }, { catalog: REAL, lookup: fakeCoupang(), log: quiet });
  const cases = [
    [{ title: '옵틱글래스 현대 제네시스 GV80 광각 사이드 와이드미러', optionModel: 'No.H127번 (1세대) BSA' }, '13706995842'],
    [{ title: '옵틱글래스 현대 제네시스G90 광각 사이드 와이드미러', optionModel: 'No.H110 BSA' }, '13706986807'],
    [{ title: '옵틱글래스 르노삼성 SM6 광각 사이드 와이드미러', optionModel: 'No.R106번 (1세대 전기)' }, '13678340521'],
    [{ title: '옵틱글래스 GMC 허머 H3 광각 사이드 와이드미러', optionModel: 'No.5557번' }, '13675645189'],
    [{ brand: '기타', model: 'GMC 험머 H3', title: 'x', optionModel: 'No.5557번' }, '13675645189'],
    [{ brand: '기타', model: '피아트500X', title: 'x', optionModel: 'No.5003 BSA' }, '13675632631'],
  ];
  for (const [data, id] of cases) {
    await assert.rejects(run(data), e => e.duplicate === true && e.existing.products.some(p => p.id === id), JSON.stringify(data));
  }
  // 같은 번호라도 다른 차는 그대로 통과
  assert.deepEqual((await run({ title: '옵틱글래스 현대 제네시스 G80 광각 사이드 와이드미러', optionModel: 'No.H127 BSA' })).notices, []);
  assert.deepEqual(g.sameCar({ brand: '현대', model: '제네시스 GV80' }, { brand: '제네시스', model: 'GV80' }), { match: true, exact: true });
  assert.deepEqual(g.sameCar({ brand: '기타', model: '피아트500X' }, { brand: '피아트', model: '500X' }), { match: true, exact: false });
  assert.equal(g.sameCar({ brand: '현대', model: '제네시스' }, { brand: '제네시스', model: 'BH' }).match, false);   // 뒤가 비면 올리지 않는다
  assert.equal(g.sameCar({ brand: '기타', model: 'X3' }, { brand: 'BMW', model: 'iX3' }).match, false);
  assert.equal(g.sameCar({ brand: 'BMW', model: 'X3' }, { brand: 'BMW', model: 'iX3' }).match, false);
  assert.equal(g.brandKey('르노'), g.brandKey('르노삼성'));
});

test('브랜드 표기 차이: 아임웹 B2B 도 현대 제네시스 요청과 제네시스 제목을 같은 차로 본다', async () => {
  const data = iwData({ titleBrand: '현대', titleModel: '제네시스 GV80', brand: '현대', model: '제네시스 GV80', code: 'H127' });
  await assert.rejects(iwCheck(data, { rows: [iwRow({ name: '옵틱글래스 제네시스 GV80 미러 1셋 [H127]' })] }).run(), /900/);
});

// ── 리뷰 회귀: 상품 쪽 번호는 optionNo 로만 읽는다 ────────────────────────
test('상품 쪽 번호: 연식·세대 숫자를 상품번호로 읽지 않는다', async t => {
  // 쿠팡 실시간 — '7세대'·'2021~' 옵션만 있는 상품은 No.7 요청의 중복이 아니다
  const rows = [{ sellerProductId: 4343, sellerProductName: '옵틱글래스 쌍용 토레스 광각 사이드 와이드미러' }];
  const r = await runCoupang(toresData({ optionModel: 'No.7 - 1세대' }), { lookup: fakeCoupang({ pages: [rows], products: { 4343: cpProduct('4343', ['7세대', '2021~']) } }) });
  assert.equal(r.registered, 1);
  // 네이버 — 번호를 못 읽은 후보는 '부분 증거'라 11분 된 미확인 원장 행을 풀지 않는다
  const now = clock();
  const ledger = ledgerAt(t, now);
  g.recordNaver(ledger, g.planNaver(nvData(), { brands: BRANDS }), 'https://sell.smartstore.naver.com/#/products/copy/999');
  now.advance(11 * MIN);
  const api = fakeNaver({ rows: [nvRow(1, '옵틱글래스 기아 K5 광각 사이드 와이드미러')], origins: { 1: nvOrigin(['2021~ BSA', '24.10~']) } });
  await assert.rejects(naverCheck(nvData(), { ledger, api, now }), e => e.source === 'ledger' && /저장되지 않았을 수/.test(e.message));
  assert.equal(ledger.active('naver').length, 1);
});

// ── 리뷰 회귀: 네이버 확인된 행 · 아임웹 원장 ─────────────────────────────
test('네이버 확인된 행: 채널상품이 목록에 살아 있으면 31분이 지나도 풀지 않는다', async t => {
  const now = clock();
  const ledger = ledgerAt(t, now);
  g.recordNaver(ledger, g.planNaver(nvData(), { brands: BRANDS }), 'https://smartstore.naver.com/opticglass/products/987');
  now.advance(31 * MIN);
  const alive = fakeNaver({ rows: [nvRow(5, '옵틱글래스 현대 싼타페 광각 사이드 와이드미러', { channelProductNo: 987 })] });
  await assert.rejects(naverCheck(nvData(), { ledger, api: alive, now }), e => e.source === 'ledger' && /987/.test(e.message));
  const gone = fakeNaver({ rows: [nvRow(5, '옵틱글래스 현대 싼타페 광각 사이드 와이드미러', { channelProductNo: 987, statusType: 'DELETE' })] });
  await naverCheck(nvData(), { ledger, api: gone, now });
  assert.equal(ledger.entries()[0].supersededReason, '네이버에서 없음 확인');
});

test('아임웹 원장: B2B·게시판 모두 30분 안에는 막고, 목록에 없음이 확인되면 30분 뒤 푼다', async t => {
  const now = clock();
  const ledger = ledgerAt(t, now);
  const b2b = iwCheck(iwData(), { rows: [] });
  g.recordImweb(ledger, b2b.plan, [{ kind: 'b2b', type: 'set', ok: true, no: 901, title: '옵틱글래스 현대 싼타페 미러 1셋 [H152]' }]);
  now.advance(5 * MIN);
  await assert.rejects(iwCheck(iwData(), { rows: [], ledger, now }).run(), e => e.source === 'ledger' && /901/.test(e.message));
  // 목록에 그 상품번호가 살아 있으면(이름이 바뀌어 실시간 판정에 안 걸려도) 모름 — 30분 뒤에도 막는다
  now.advance(26 * MIN);
  await assert.rejects(iwCheck(iwData(), { rows: [iwRow({ prodNo: 901, name: '이름 바꾼 상품' })], ledger, now }).run(), /901/);
  await iwCheck(iwData(), { rows: [], ledger, now }).run();
  assert.equal(ledger.entries()[0].supersededReason, '아임웹 목록에 없음 확인');

  const bd = iwData({ targetB2b: false, targetHead: true, specImageUrl: 'https://x/spec.png' });
  const board = iwCheck(bd, { posts: [] });
  g.recordImweb(ledger, board.plan, [{ kind: 'board', lang: 'ko', boardCode: 'b1', boardName: '현대', subject: '현대 싼타페 [H152]', postCode: 'P9' }]);
  now.advance(5 * MIN);
  await assert.rejects(iwCheck(bd, { posts: [], ledger, now }).run(), e => e.source === 'ledger' && /P9/.test(e.message));
  now.advance(26 * MIN);
  await iwCheck(bd, { posts: [], ledger, now }).run();
  assert.equal(ledger.active('imweb-board').length, 0);
});

// ── 21. 정적 회귀 ───────────────────────────────────────────────────────
test('main_process: 네 신규 등록 핸들러가 모두 중복 검사를 거친다', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'main_process.js'), 'utf8');
  for (const ch of ['naver', 'coupang', 'amazon', 'imweb']) {
    const start = src.indexOf(`ipcMain.handle('${ch}-register'`);
    assert.ok(start !== -1, ch);
    const end = src.indexOf('ipcMain.handle(', start + 10);
    const block = src.slice(start, end === -1 ? undefined : end);
    assert.match(block, /runGuardedRegistration/, ch);
    assert.match(block, /isGuardError\(error\)/, ch);
  }
  // 아임웹: B2B 조회는 Open API 라 준비가 없다. 게시판 로그인(수 분)은 조회 시간 제한 밖에서 먼저,
  // 끝나면 조회 창을 닫아 등록 단계의 리스너 중복을 막는다.
  const imwebBlock = src.slice(src.indexOf("ipcMain.handle('imweb-register'"), src.indexOf('ipcMain.handle(', src.indexOf("ipcMain.handle('imweb-register'") + 10));
  assert.doesNotMatch(imwebBlock, /ensureToken/);
  const warm = imwebBlock.search(/await imweb\.ensureBoardBase\(boardLangs\[0\]\)/);
  assert.ok(warm !== -1 && warm < imwebBlock.indexOf('await checkImweb('));
  assert.match(imwebBlock, /if \(boardLangs\.length\) \{\s*try \{ await imweb\.close\(\); \}/);
});
