// 일일 환율 자동 변경 — 국내 기준가 등급 ÷ 환율 계산과 자동 저장 규칙. 네트워크는 쓰지 않는다.
//
// 정한 규칙 (2026-09-30): 가격 등급표 · 매일 자동 저장 · 아마존 미국+일본 · eBay · 1% 이상 차이날 때만 ·
// 환산한 뒤 앞 두 자리만 남기고 버림(65,000원 → 7,533엔 → 7,500 · 47.98달러 → 47).
// 아임웹 미국·일본은 체크했을 때만(imweb_unit_prices.js). 2026-09 해외가 109.32 / 160.34 USD 는 150,000 / 220,000원 ÷ 1,372원이었다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fromKrw, toKrw, convertKrw, leadingTwo, findTier, planPrice, rateProblem, normalizeTiers, DEFAULT_TIERS } from '../src/utils/fx_pricing.js';
import { createFxAutoPrice, FxPriceStore } from '../src/fx_auto_price.js';
import { registerBulkPriceIPC } from '../src/bulk_price_ipc.js';
import { apiError, markPreSend } from '../src/utils/api_error.js';

const HOUR = 3600000;
const NOW = new Date(2026, 8, 30, 10, 0).getTime();   // 로컬 2026-09-30 10:00
const snap = (fetchedAt = NOW - HOUR, extra = {}) => ({ base: 'USD', source: 'test', marketDate: '2026-09-29',
  rates: { USD: 1, JPY: 157.2689971923828, KRW: 1356.0899658203125 }, fetchedAt: new Date(fetchedAt).toISOString(), ...extra });
const tiers = DEFAULT_TIERS.map(t => ({ ...t }));

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-auto-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ── 계산 규칙 ────────────────────────────────────────────────────────────

test('원화 기준가를 우대 없이 환산한 뒤 앞 두 자리만 남기고 버린다', () => {
  const s = snap();
  assert.equal(convertKrw(150000, 'USD', s).toFixed(2), '110.61');
  assert.deepEqual([150000, 220000, 275000].map(krw => fromKrw(krw, 'USD', s)), ['110', '160', '200']);
  assert.deepEqual([150000, 220000, 275000].map(krw => fromKrw(krw, 'JPY', s)), ['17000', '25000', '31000']);
  // 사용자 예시: 65,000원 → 7,5xx엔 → 7,500 · 47.9x달러 → 47
  assert.deepEqual([fromKrw(65000, 'JPY', s), fromKrw(65000, 'USD', s)], ['7500', '47']);
  assert.deepEqual([leadingTwo(7533, 'JPY'), leadingTwo(47.98, 'USD')], ['7500', '47']);
  assert.deepEqual(['109.99', '999.99', '1083.99', '7.53', '100'].map(v => leadingTwo(v, 'USD')), ['100', '990', '1000', '7.5', '100']);
  assert.equal(leadingTwo(7499.9999999999, 'JPY'), '7500', '부동소수 잡음으로 한 칸 떨어지지 않는다');
  assert.throws(() => fromKrw(150000, 'EUR', s), /지원하지 않는 통화/);
});

test('지금 가격을 원화로 되돌려 −10% ~ +5% 안의 등급을 찾고, 어느 등급에도 안 맞으면 null', () => {
  const s = snap();
  assert.equal(findTier('109.32', 'USD', s, tiers)?.krw, 150000);
  assert.equal(findTier('160.34', 'USD', s, tiers)?.krw, 220000);
  assert.equal(findTier('160.32', 'USD', s, tiers)?.krw, 220000, '오타로 2센트 다른 가격도 같은 등급');
  assert.equal(findTier('200.43', 'USD', s, tiers)?.krw, 275000);
  assert.equal(findTier('100', 'USD', s, tiers)?.krw, 150000, '앞 두 자리로 잘려 9.6% 낮아진 가격도 같은 등급');
  assert.equal(findTier('130', 'USD', s, tiers), null);
  assert.equal(findTier('687.41', 'USD', s, tiers), null, '전동 사이드미러 같은 다른 상품은 건드리지 않는다');
  assert.equal(findTier('17000', 'JPY', s, tiers)?.krw, 150000);
  assert.ok(Math.abs(toKrw('110.61', 'USD', s) - 150000) < 10);
});

test('판단: 같으면 same, 두 자리 가격이 아니면 정리, 두 자리 가격은 환율이 1% 넘게 움직여야 바꾼다, 10% 초과는 large', () => {
  const s = snap(), at = krw => ({ ...s, rates: { ...s.rates, KRW: krw } });
  const p = (current, input = {}) => { const r = planPrice({ current, currency: 'USD', krw: 150000, snapshot: s, ...input }); return [r.target, r.action]; };
  assert.deepEqual(p('110'), ['110', 'same']);
  assert.deepEqual(p('109.32'), ['110', 'update'], '0.6% 차이지만 두 자리 가격이 아니라 한 번 정리한다');
  assert.deepEqual(p('110.61'), ['110', 'update']);
  assert.deepEqual(p('95'), ['110', 'large']);
  assert.deepEqual(p('95', { maxChange: Infinity }), ['110', 'update']);
  // 1,364원이면 환산값 109.97 → 100 이지만 110 에서 0.03% 움직였을 뿐이라 그대로 둔다(경계에서 오가지 않게).
  assert.deepEqual(p('110', { snapshot: at(1364) }), ['100', 'small']);
  assert.deepEqual(p('110', { snapshot: at(1379) }), ['100', 'update'], '108.77 — 1.1% 내려가면 100');
  assert.deepEqual(p('100', { snapshot: at(1370) }), ['100', 'same'], '109.49 — 두 자리로는 여전히 100');
  assert.deepEqual(p('100', { snapshot: at(1362) }), ['110', 'update'], '딱 +10% 는 자동 저장 범위');
  const cheap = (current, snapshot) => planPrice({ current, currency: 'USD', krw: 65000, snapshot }).action;
  assert.equal(cheap('48', s), 'small', '47.93 은 48 에서 0.15% — 그대로');
  assert.equal(cheap('48', at(1370)), 'update', '47.45 는 48 에서 1.2% — 47 로');
  assert.throws(() => p(''), /지금 판매가/);
});

test('환율: 24시간 지났거나 stale·미래 시각·형식 오류면 쓰지 않는다', () => {
  assert.equal(rateProblem(snap(), NOW), '');
  assert.match(rateProblem(snap(NOW - 25 * HOUR), NOW), /24시간/);
  assert.match(rateProblem(snap(NOW + HOUR), NOW), /24시간/);
  assert.match(rateProblem(snap(NOW - HOUR, { stale: true }), NOW), /24시간/);
  assert.match(rateProblem({ ...snap(), rates: { USD: 1, JPY: 0, KRW: 1356 } }, NOW), /올바르지/);
});

test('등급표: 17% 안쪽으로 붙은 등급·정수가 아닌 금액은 거부하고, 빠진 id 는 채운다', () => {
  assert.throws(() => normalizeTiers([{ krw: 150000 }, { krw: 170000 }]), /17% 이상/);
  assert.equal(normalizeTiers([{ krw: 150000 }, { krw: 176000 }]).length, 2);
  assert.throws(() => normalizeTiers([{ krw: '150,000.5' }]), /정수/);
  assert.throws(() => normalizeTiers([]), /하나 이상/);
  const out = normalizeTiers([{ id: 'tier-1', label: ' 일반 ', krw: '150,000' }, { id: 'tier-1', krw: 220000 }]);
  assert.deepEqual(out.map(t => [t.id, t.label, t.krw]), [['tier-1', '일반', 150000], ['tier-2', '', 220000]]);
});

// ── 자동 실행 (가짜 조회·저장) ──────────────────────────────────────────

function fakeService({ lists = {}, live = {}, onSave } = {}) {
  const calls = [];
  const service = {
    calls, live,
    async list({ scope }) {
      calls.push(['list', scope]);
      if (lists[scope] instanceof Error) throw lists[scope];
      return { items: (lists[scope] || []).map(item => ({ ...item })) };
    },
    async load({ scope, id }) {
      calls.push(['load', scope, id]);
      const price = live[scope + ':' + id];
      if (price instanceof Error) throw price;
      return [{ scope, id, price: String(price ?? ''), ready: true }];
    },
    async save(input) {
      calls.push(['save', input.scope, input.id, input.newPrice, input.expectedPrice]);
      const result = onSave?.(input);
      if (result instanceof Error) throw result;
      live[input.scope + ':' + input.id] = input.newPrice;
      return result || { status: 'VERIFIED', price: input.newPrice };
    },
    async exclusive(work) { calls.push(['lock']); return work(); },
  };
  return service;
}

function fixture(t, { service, imwebUnits, clock = () => NOW, rate = () => ({ success: true, data: snap() }) } = {}) {
  const store = new FxPriceStore(tmpDir(t));
  const notices = [];
  const fx = createFxAutoPrice({ store, service, imwebUnits, rates: async () => rate(), clock, sleep: async () => {},
    notify: n => notices.push(n), log: { log() {}, error() {} } });
  return { fx, store, notices };
}

test('기본값: 꺼짐 · 아마존 미국·일본·eBay 대상(아임웹은 꺼 둠) · 등급 150,000/220,000/275,000원', t => {
  const cfg = new FxPriceStore(tmpDir(t)).read();
  assert.equal(cfg.enabled, false);
  assert.deepEqual(cfg.scopes, { 'amazon-us': true, ebay: true, 'amazon-jp': true, 'imweb-en': false });
  assert.deepEqual(cfg.tiers.map(t => t.krw), [150000, 220000, 275000]);
});

test('아임웹 미국·일본: 체크했을 때만 읽고 바로 저장(sync)을 부르고 결과를 몰 결과로 센다. 중단은 아임웹 도중에도 듣는다', async t => {
  const calls = [];
  const imwebUnits = {
    async sync({ stop }) {
      calls.push(stop());
      fx.cancel();   // 도중에 중단을 누른 것처럼 — sync 가 다음 상품에서 stop() 을 본다
      return { count: { products: 5, skipped: 1, unchanged: 1, large: 1, saved: 2, failed: 0 }, stopped: stop() ? '사용자가 중단했습니다.' : '' };
    },
  };
  const { fx } = fixture(t, { service: fakeService(), imwebUnits });
  fx.saveConfig({ scopes: { 'amazon-us': false, ebay: false, 'amazon-jp': false } });
  await fx.run();
  assert.deepEqual(calls, [], '체크하지 않으면 아임웹을 건드리지 않는다');
  fx.saveConfig({ scopes: { 'imweb-en': true } });
  const result = await fx.run();
  assert.deepEqual(calls, [false]);
  const s = result.scopes['imweb-en'];
  assert.deepEqual([s.total, s.counts.updated, s.counts.large, s.counts.check, s.counts.unchanged, s.error], [5, 2, 1, 1, 1, '']);
  assert.equal(s.stopped, '사용자가 중단했습니다.');
});

test('목록가로 이미 같으면 API 를 부르지 않고, 후보만 지금 가격을 다시 읽어 기대가와 함께 두 자리 가격을 저장한다', async t => {
  const service = fakeService({
    lists: { 'amazon-us': [{ id: 'A', price: '109.32' }, { id: 'B', price: '110' }, { id: 'C', price: '' }, { id: 'D', price: '687.41' }] },
    live: { 'amazon-us:A': '109.32' },
  });
  const { fx, store } = fixture(t, { service });
  const result = await fx.run({ trigger: 'manual' });
  assert.deepEqual(service.calls.filter(c => c[0] !== 'list'), [
    ['load', 'amazon-us', 'A'], ['lock'], ['save', 'amazon-us', 'A', '110', '109.32']]);
  assert.deepEqual(result.scopes['amazon-us'].counts, { updated: 1, accepted: 0, unchanged: 1, check: 0, small: 0, large: 0,
    noTier: 1, noPrice: 1, failed: 0, notSent: 0, rejected: 0, unknown: 0 });
  assert.equal(result.rate.KRW, 1356.0899658203125);
  const saved = store.read();
  assert.equal(saved.assignments['amazon-us:A'].tier, 'tier-1');
  assert.equal(saved.assignments['amazon-us:D'], undefined);
  assert.equal(saved.lastRun.trigger, 'manual');
  const row = store.rows().find(r => r.id === 'A');
  assert.deepEqual([row.raw, row.target], ['110.61', '110'], '결과에 자르기 전 환산값도 남긴다');
});

test('저장된 등급은 등급표 금액을 따라가고, 10% 넘게 바뀌면 자동 저장하지 않는다', async t => {
  const service = fakeService({
    lists: { 'amazon-us': [{ id: 'A', price: '110' }], ebay: [{ id: 'E', price: '90' }] },
    live: { 'amazon-us:A': '110', 'ebay:E': '90' },
  });
  const { fx, store } = fixture(t, { service });
  store.update({ assignments: { 'amazon-us:A': { tier: 'tier-1' }, 'ebay:E': { tier: 'tier-1' } } });
  fx.saveConfig({ tiers: [{ id: 'tier-1', label: '일반', krw: 165000 }, { id: 'tier-2', krw: 220000 }] });
  const result = await fx.run();
  assert.deepEqual(service.calls.filter(c => c[0] === 'save'), [['save', 'amazon-us', 'A', '120', '110']], '165,000원 ÷ 1,356원 = 121.67 → 120');
  assert.equal(result.scopes.ebay.counts.large, 1, '90 → 120 USD 는 +33%');
  assert.match(store.rows().find(r => r.id === 'E').result, /자동 저장 안 함/);
});

test('손으로 다른 등급 가격으로 바꾼 상품은 그 등급으로 옮기고, 10% 초과는 환율 탭에서 고른 것만 본 가격 그대로일 때 저장한다', async t => {
  const ids = ['M', 'K', 'L1', 'L2', 'L3'], prices = { M: '160', K: '115', L1: '90', L2: '90', L3: '90' };
  const service = fakeService({ lists: { ebay: ids.map(id => ({ id, price: prices[id] })) },
    live: Object.fromEntries(ids.map(id => ['ebay:' + id, prices[id]])) });
  const { fx, store } = fixture(t, { service });
  store.update({ assignments: Object.fromEntries(ids.map(id => ['ebay:' + id, { tier: 'tier-1' }])) });
  fx.saveConfig({ scopes: { ebay: true } });
  const result = await fx.run();
  assert.equal(store.read().assignments['ebay:M'].tier, 'tier-2', '160 USD 는 220,000원 등급 범위 — 옮기고 그대로 둔다');
  assert.equal(store.read().assignments['ebay:K'].tier, 'tier-1', '115 는 같은 등급 범위 — 등급 가격으로 되돌린다');
  const saves = () => service.calls.filter(c => c[0] === 'save').map(c => c.slice(2));
  assert.deepEqual(saves(), [['K', '110', '115']]);
  assert.deepEqual(result.review.map(r => r.id), ['L1', 'L2', 'L3']);
  service.live['ebay:L2'] = '95';   // 검토하는 사이 누가 바꿨다
  const r = await fx.approve({ keys: ['ebay:L1', 'ebay:L2'] });
  assert.deepEqual([r.counts.updated, r.counts.check], [1, 1]);
  assert.deepEqual(saves().slice(1), [['L1', '110', '90']], '+22% 지만 고른 상품이라 저장, 바뀐 L2 는 보내지 않는다');
  const last = store.read().lastRun;
  assert.deepEqual(last.review.map(x => x.id), ['L3']);
  assert.deepEqual([last.scopes.ebay.counts.large, last.scopes.ebay.counts.updated, last.scopes.ebay.counts.check], [1, 2, 1]);
  assert.match(store.rows().find(x => x.id === 'L2').result, /검토한 뒤/);
  assert.deepEqual(fx.links('ebay'), { on: false, links: { M: 'BSA 미러', K: '일반 미러', L1: '일반 미러', L2: '일반 미러', L3: '일반 미러' } });
});

test('등급을 못 찾으면 같은 SKU 가 다른 몰에서 받은 등급을 쓴다 (아마존 일본)', async t => {
  const service = fakeService({
    lists: { 'amazon-us': [{ id: 'S1', price: '109.32' }], 'amazon-jp': [{ id: 'S1', price: '18500' }] },
    live: { 'amazon-us:S1': '109.32', 'amazon-jp:S1': '18500' },
  });
  const { fx, store } = fixture(t, { service });
  await fx.run();
  assert.deepEqual(service.calls.filter(c => c[0] === 'save').map(c => c.slice(1)), [
    ['amazon-us', 'S1', '110', '109.32'], ['amazon-jp', 'S1', '17000', '18500']]);
  assert.equal(store.read().assignments['amazon-jp:S1'].via, 'amazon-us');
});

test('차단 오류(429)는 그 몰만 멈추고, 결과를 모르는데 다시 읽지도 못하면 멈춘다. 보내기 전 거절은 건너뛰고 계속한다', async t => {
  const live = { 'amazon-us:A1': apiError('too many', { status: 429 }), 'ebay:E1': '109.32', 'ebay:E2': '109.32', 'ebay:E3': '109.32',
    'amazon-jp:J1': '17300', 'amazon-jp:J2': '17300' };
  const service = fakeService({
    lists: {
      'amazon-us': [{ id: 'A1', price: '109.32' }, { id: 'A2', price: '109.32' }],
      ebay: [{ id: 'E1', price: '109.32' }, { id: 'E2', price: '109.32' }, { id: 'E3', price: '109.32' }],
      'amazon-jp': [{ id: 'J1', price: '17300' }, { id: 'J2', price: '17300' }],
    },
    live,
    onSave: ({ id }) => {
      if (id === 'E1') return Object.assign(markPreSend(new Error('가격이 변경됐습니다.')), { sent: true });
      if (id !== 'E2') return null;
      live['ebay:E2'] = new Error('read failed');   // 결과 불명 뒤 다시 읽기도 실패
      return Object.assign(apiError('timeout', { timeout: true }), { sent: true });
    },
  });
  const { fx } = fixture(t, { service });
  const result = await fx.run();
  assert.match(result.scopes['amazon-us'].stopped, /같은 이유로 실패/);
  assert.equal(service.calls.some(c => c[2] === 'A2'), false, '429 뒤 상품은 조회하지 않는다');
  assert.deepEqual([result.scopes.ebay.counts.notSent, result.scopes.ebay.counts.unknown], [1, 1]);
  assert.match(result.scopes.ebay.stopped, /결과를 확인하지 못해/);
  assert.equal(service.calls.some(c => c[2] === 'E3'), false);
  assert.equal(result.scopes['amazon-jp'].counts.updated, 2, '다른 몰은 계속한다');
});

test('결과 불명(eBay 25001)이면 다시 읽어 확인한다: 반영됐으면 저장으로 세고, 안 됐으면 넘어가되 3번 연속이면 멈춘다', async t => {
  const systemError = () => Object.assign(apiError('[25001] A system error has occurred.', { status: 500 }), { sent: true });
  const ids = ['A', 'B1', 'B2', 'C', 'D1', 'D2', 'D3', 'E'];
  const live = Object.fromEntries(ids.map(id => ['ebay:' + id, '109.32']));
  const service = fakeService({
    lists: { ebay: ids.map(id => ({ id, price: '109.32' })) },
    live,
    onSave: ({ id, newPrice }) => {
      if (id === 'A') { live['ebay:A'] = newPrice; return systemError(); }   // 실제로는 반영됨
      if (/^[BD]/.test(id)) return systemError();                            // 반영 안 됨
      return null;
    },
  });
  const { fx, store } = fixture(t, { service });
  const result = await fx.run();
  const counts = result.scopes.ebay.counts;
  assert.deepEqual([counts.updated, counts.notSent, counts.unknown], [2, 5, 0], 'A·C 저장, B1·B2·D1·D2·D3 반영 안 됨');
  assert.match(result.scopes.ebay.stopped, /3번 연속 반영되지 않아/);
  assert.equal(service.calls.some(c => c[2] === 'E'), false, '세 번 연속 뒤에는 멈춘다');
  assert.match(store.rows().find(r => r.id === 'A').result, /다시 읽어 확인/);
  assert.match(store.rows().find(r => r.id === 'B1').result, /다음 실행에서 다시 시도/);
});

test('환율이 24시간 지났으면 목록도 부르지 않고 이유를 기록한다', async t => {
  const service = fakeService({ lists: { 'amazon-us': [{ id: 'A', price: '109.32' }] } });
  const { fx, store } = fixture(t, { service, rate: () => ({ success: true, data: snap(NOW - 25 * HOUR) }) });
  const result = await fx.run();
  assert.match(result.error, /24시간/);
  assert.deepEqual(service.calls, []);
  assert.match(store.read().lastRun.error, /24시간/);
});

test('목록이 잘렸으면(아마존 캐시 없음 → 1000건 한도) 그 몰은 조회·저장 없이 멈추고 이유를 남긴다', async t => {
  const service = fakeService({ live: { 'amazon-us:A': '109.32' } });
  service.list = async ({ scope }) => {
    service.calls.push(['list', scope]);
    return scope === 'amazon-us'
      ? { items: [{ id: 'A', price: '109.32' }], truncated: true, note: '주의: 아마존 목록이 1000/1386건에서 잘렸습니다' }
      : { items: [] };
  };
  const { fx } = fixture(t, { service });
  const result = await fx.run();
  assert.match(result.scopes['amazon-us'].error, /잘렸습니다/);
  assert.equal(service.calls.some(c => c[0] === 'load' || c[0] === 'save'), false);
});

test('중단하면 지금 상품까지만 하고 멈춘다', async t => {
  let fx;
  const service = fakeService({
    lists: { 'amazon-us': [{ id: 'A1', price: '109.32' }, { id: 'A2', price: '109.32' }], ebay: [{ id: 'E', price: '109.32' }] },
    live: { 'amazon-us:A1': '109.32', 'amazon-us:A2': '109.32', 'ebay:E': '109.32' },
    onSave: () => { fx.cancel(); return null; },
  });
  ({ fx } = fixture(t, { service }));
  const result = await fx.run();
  assert.equal(result.cancelled, true);
  assert.deepEqual(service.calls.filter(c => c[0] === 'save').map(c => c[2]), ['A1']);
  assert.equal(fx.running(), false);
});

test('자동 실행: 꺼져 있으면 안 돌고, 켜면 새 환율이 들어온 뒤 하루 한 번만 돈다', async t => {
  let now = NOW, rate = snap(NOW - HOUR);
  const service = fakeService({ lists: { 'amazon-us': [{ id: 'A', price: '109.32' }] }, live: { 'amazon-us:A': '109.32' } });
  const { fx, store } = fixture(t, { service, clock: () => now, rate: () => ({ success: true, data: rate }) });
  assert.equal(await fx.tick(), 'disabled');
  fx.saveConfig({ enabled: true });
  assert.equal(await fx.tick(), 'ran');
  assert.equal(store.read().lastRun.trigger, 'auto');
  assert.equal(await fx.tick(), 'done-today');
  now = new Date(2026, 9, 1, 6, 0).getTime();         // 다음 날 아침, 서버는 아직 어제 환율
  assert.equal(await fx.tick(), 'same-rate');
  rate = snap(new Date(2026, 9, 1, 5, 30).getTime());  // 새 환율
  assert.equal(await fx.tick(), 'ran');
  fx.saveConfig({ scopes: {} });
  now += 24 * HOUR; rate = snap(now - HOUR);
  assert.equal(await fx.tick(), 'no-scope');
});

test('등급을 지우고 새 등급을 추가해도 지운 등급의 상품이 새 등급으로 넘어가지 않는다', async t => {
  const { fx, store } = fixture(t, { service: fakeService() });
  store.update({ assignments: { 'ebay:B1': { tier: 'tier-2' }, 'ebay:A1': { tier: 'tier-1' } } });
  // 화면은 기존 등급의 id 를 그대로, 새 등급은 빈 id 로 보낸다.
  fx.saveConfig({ tiers: [{ id: 'tier-1', krw: 150000 }, { id: '', label: '새 등급', krw: 300000 }] });
  const cfg = store.read();
  const added = cfg.tiers.find(t => t.krw === 300000);
  assert.notEqual(added.id, 'tier-2');
  assert.notEqual(added.id, 'tier-3');
  assert.equal(cfg.assignments['ebay:B1'], undefined, '지운 등급의 연결은 버리고 다음 실행에서 다시 찾는다');
  assert.equal(cfg.assignments['ebay:A1'].tier, 'tier-1');
});

test('환율가 입력: 불러온 행의 새 판매가와 자동 실행과 같은 판단을 돌려준다. 아임웹은 미국·일본 미리보기로 보낸다', async t => {
  const { fx, store } = fixture(t, { service: fakeService() });
  store.update({ assignments: { 'ebay:E5': { tier: 'tier-1' } } });
  const out = await fx.plan({ scope: 'ebay', rows: [{ id: 'E1', price: '160.34' }, { id: 'E2', price: '160' }, { id: 'E3', price: '' },
    { id: 'E4', price: '1072' }, { id: 'E5', price: '90' }] });
  assert.deepEqual(out.rows.map(r => r.target || r.error), ['160', '160', '현재가 없음', '등급 없음', '110']);
  assert.deepEqual(out.rows.map(r => r.action), ['update', 'same', undefined, undefined, 'large']);
  assert.equal(out.rows[0].raw.toFixed(2), '162.23');
  assert.equal(store.read().assignments['ebay:E1'].tier, 'tier-2');
  await assert.rejects(fx.plan({ scope: 'imweb-en', rows: [] }), /아임웹 미국·일본/);
  await assert.rejects(fx.plan({ scope: 'naver', rows: [] }), /아마존·eBay/);
});

// ── 상품 일괄 수정과 저장 잠금 공유 ──────────────────────────────────────

test('저장 잠금: 자동 변경은 화면 저장이 끝난 뒤 저장하고, 화면 조회는 자동 변경 저장을 기다린다(BUSY 아님)', async () => {
  const handlers = {}, order = [], prices = { A: '109.32', B: '109.32' };
  let openGate; const gate = new Promise(r => { openGate = r; });
  const amazon = {
    loadConfig() {},
    async loadProductForEdit(sku) { return { price: prices[sku], title: sku }; },
    async loadProductsForEdit(skus) { return new Map(skus.map(sku => [sku, { price: prices[sku], title: sku }])); },
    async updateExistingProduct({ sku, price }) { order.push('write ' + sku); if (sku === 'A') await gate; prices[sku] = price; return { status: 'ACCEPTED' }; },
  };
  const service = registerBulkPriceIPC({
    ipcMain: { handle: (channel, fn) => { handlers[channel] = fn; } },
    naverAPI: () => ({}), naverProducts: () => ({}), coupang: () => ({}), amazon: () => amazon, ebay: () => ({}),
    imweb: async () => ({}), board: async () => ({}), rates: async () => ({ data: {} }), log: { error() {} }, sleep: async () => {},
  });
  const ui = handlers['bulk-save-batch'](null, { jobId: 'fx-lock-test', scope: 'amazon-us',
    jobs: [{ type: 'price', id: 'A', newPrice: '110.61', expectedPrice: '109.32' }] });
  await new Promise(r => setImmediate(r));
  const fx = service.exclusive(() => { order.push('fx start'); return service.save({ scope: 'amazon-us', id: 'B', newPrice: '110.61', expectedPrice: '109.32' }); });
  await new Promise(r => setImmediate(r));
  assert.deepEqual(order, ['write A'], '화면 저장이 끝나기 전에는 시작하지 않는다');
  openGate();
  assert.equal((await ui).data.results[0].data.status, 'ACCEPTED');
  assert.equal((await fx).status, 'ACCEPTED');
  assert.deepEqual(order, ['write A', 'fx start', 'write B']);

  let release; const hold = new Promise(r => { release = r; });
  const busy = service.exclusive(() => hold);
  const read = handlers['bulk-price-load-many'](null, { scope: 'amazon-us', ids: ['A'] });
  release();
  await busy;
  const loaded = await read;
  assert.equal(loaded.success, true, loaded.error);
  assert.equal(loaded.data.items[0].rows[0].price, '110.61');

  // 화면 쓰기(아임웹 자사몰 신규 등록 · main imweb-head-register)도 화면 저장과 같은 줄: 서로 BUSY, 자동 변경은 기다린다.
  let done; const register = service.uiWrite(() => new Promise(r => { done = r; }));
  await new Promise(r => setImmediate(r));
  const blocked = await handlers['bulk-save-batch'](null, { jobId: 'ui-write-test', scope: 'amazon-us',
    jobs: [{ type: 'price', id: 'A', newPrice: '111', expectedPrice: '110.61' }] });
  assert.deepEqual([blocked.success, blocked.kind, blocked.stage], [false, 'BUSY', 'pre-send']);
  assert.equal((await service.uiWrite(async () => 'x')).kind, 'BUSY');
  const fxAfter = service.exclusive(async () => order.push('fx after register'));
  await new Promise(r => setImmediate(r));
  assert.equal(order.includes('fx after register'), false, '등록이 끝나기 전에는 자동 변경도 기다린다');
  done({ success: true });
  assert.deepEqual(await register, { success: true });
  await fxAfter;
  assert.equal(order.at(-1), 'fx after register');
});

test('후보 현재가는 아마존 한 요청 20건까지 묶어 미리 읽고, 목록가로 걸러진 상품·묶음에서 빠진 상품만 따로 다룬다', async t => {
  // 36개 중 6개는 목록가가 이미 두 자리 가격(110)이라 후보가 아니다. 후보 30개 → 20 + 10 두 번.
  const items = Array.from({ length: 36 }, (_, i) => ({ id: 'S' + i, price: i % 6 === 0 ? '110' : '109.32' }));
  const live = Object.fromEntries(items.map(item => ['amazon-us:' + item.id, item.price]));
  const service = fakeService({ lists: { 'amazon-us': items }, live });
  const batches = [];
  service.loadMany = async ({ scope, ids }) => {
    batches.push(ids.length);
    // S1 은 묶음 응답에서 빠진다 → 1건 조회로 읽는다.
    return { items: ids.filter(id => id !== 'S1').map(id => ({ id, rows: [{ scope, id, price: live[scope + ':' + id], ready: true }] })), blocked: '' };
  };
  const { fx } = fixture(t, { service });
  const result = await fx.run();
  assert.deepEqual(batches, [20, 10]);
  assert.deepEqual(service.calls.filter(c => c[0] === 'load'), [['load', 'amazon-us', 'S1']]);
  assert.equal(service.calls.filter(c => c[0] === 'save').length, 30);
  assert.equal(result.scopes['amazon-us'].counts.updated, 30);
  assert.equal(result.scopes['amazon-us'].counts.unchanged, 6);
});
