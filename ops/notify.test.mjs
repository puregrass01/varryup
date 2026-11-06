// node --test ops/notify.test.mjs  (Electron 없이 돈다)
import test from 'node:test';
import assert from 'node:assert/strict';
import { naverWindows, naverWanted, naverOrderText, kstIso, kstDate, tick, summaryText } from './notify.mjs';

const H = 3600e3;

test('네이버 창은 24시간 이하로 잘리고 끝은 지금-5초(초 단위 버림)', () => {
  const now = Date.UTC(2026, 10, 6, 3, 0, 7, 500);
  const w = naverWindows(now - 50 * H, now);
  assert.equal(w.length, 3);
  assert.ok(w.every(([a, b]) => b - a <= 24 * H && b > a));
  assert.equal(w.at(-1)[1], Date.UTC(2026, 10, 6, 3, 0, 2));
  for (let i = 1; i < w.length; i++) assert.equal(w[i][0], w[i - 1][1]);
  assert.deepEqual(naverWindows(now, now), []);
});

test('네이버 알림 대상 유형', () => {
  for (const t of ['PAYED', 'PAY_WAITING', 'CLAIM_REQUESTED', 'DELIVERY_ADDRESS_CHANGED']) assert.ok(naverWanted({ lastChangedType: t }), t);
  assert.ok(naverWanted({ lastChangedType: 'CLAIM_COMPLETED', claimType: 'CANCEL' }));
  assert.ok(!naverWanted({ lastChangedType: 'CLAIM_COMPLETED', claimType: 'RETURN' }));
  for (const t of ['DISPATCHED', 'PURCHASE_DECIDED', 'COLLECT_DONE']) assert.ok(!naverWanted({ lastChangedType: t }), t);
});

test('한국 시각 형식', () => {
  const ms = Date.UTC(2026, 10, 5, 15, 30, 0, 999);
  assert.equal(kstIso(ms), '2026-11-06T00:30:00.000+09:00');
  assert.equal(kstDate(ms), '2026-11-06');
});

test('첫 실행은 기록만, 그다음은 새 건만, 카톡 실패면 cursor 를 넘기지 않음, 5회 실패 알림', async () => {
  let rows = [{ id: 'a', text: 'A' }];
  let fail = false;
  const feed = { name: 'x.order', mall: 'X', open: 'order', poll: async (st, now) => { if (fail) throw new Error('boom'); return { items: rows, cursor: now }; } };
  const sent = [];
  let kakaoDown = false;
  const send = async (t) => { if (kakaoDown) throw new Error('kakao'); sent.push(t); };
  const state = {};

  await tick({ feeds: [feed], state, send, now: 1 });
  assert.deepEqual(sent, []);
  assert.equal(state.feeds['x.order'].cursor, 1);

  rows = [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }, { id: 'c', text: 'C' }];
  kakaoDown = true;
  await tick({ feeds: [feed], state, send, now: 2 });
  assert.equal(state.feeds['x.order'].cursor, 1, '못 보냈으면 같은 창을 다시 읽는다');

  kakaoDown = false;
  await tick({ feeds: [feed], state, send, now: 3 });
  assert.deepEqual(sent, ['B', 'C']);
  assert.equal(state.feeds['x.order'].cursor, 3);
  assert.equal(state.sent.X, 2);
  assert.equal(state.feeds['x.order'].open, 3);

  await tick({ feeds: [feed], state, send, now: 4 });
  assert.deepEqual(sent, ['B', 'C'], '이미 보낸 건은 다시 안 보낸다');

  fail = true;
  for (let i = 0; i < 6; i++) await tick({ feeds: [feed], state, send, now: 5 + i });
  assert.equal(sent.filter((t) => t.startsWith('⚠')).length, 1, '연속 실패 알림은 한 번');
  fail = false;
  await tick({ feeds: [feed], state, send, now: 20 });
  assert.ok(sent.at(-1).startsWith('✅'));
  assert.match(summaryText([feed], state, Date.UTC(2026, 10, 6, 0, 0)), /X: 처리 대기 주문 3 · 알림 2건/);
});

test('같은 회차의 중복 id 는 한 번만, 실패 알림은 카톡이 될 때까지 다시', async () => {
  const sent = [];
  let kakaoDown = false, fail = false;
  const send = async (t) => { if (kakaoDown) throw new Error('kakao'); sent.push(t); };
  const feed = { name: 'y', mall: 'Y', poll: async () => { if (fail) throw new Error('x'); return { items: [{ id: 'd', text: 'D' }, { id: 'd', text: 'D' }] }; } };
  const state = { feeds: { y: { seen: [] } } };
  await tick({ feeds: [feed], state, send });
  assert.deepEqual(sent, ['D']);

  fail = true;
  kakaoDown = true;
  for (let i = 0; i < 5; i++) await tick({ feeds: [feed], state, send });
  kakaoDown = false;
  await tick({ feeds: [feed], state, send });
  assert.equal(sent.filter((t) => t.startsWith('⚠')).length, 1, '카톡이 살아나면 경고를 보낸다');
});

test('네이버 부분 취소는 요청 수량과 남은 수량, 가려진 새 주문은 새 주문으로', () => {
  const d = { order: { ordererName: '홍길동' }, productOrder: { productName: '미러', quantity: 3, remainQuantity: 2 }, currentClaim: { cancel: { requestQuantity: 1 } } };
  assert.match(naverOrderText({ orderId: '1', lastChangedType: 'CLAIM_COMPLETED', claimType: 'CANCEL' }, d), /\[네이버 취소 완료\][\s\S]*x1 \(남은 2\)/);
  assert.match(naverOrderText({ orderId: '1', lastChangedType: 'DELIVERY_ADDRESS_CHANGED' }, {}, true), /\[네이버 새 주문 · 배송지 변경됨\]/);
});
