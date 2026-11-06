import test from 'node:test';
import assert from 'node:assert/strict';
import { POLICY, POLICY_SCOPES, percentOff, policyPrice, couponGuide } from '../src/utils/price_policy.js';

test('정책표(11-06): 판 구분 없이 정가 140,000 · 판매가 100,000 → 알람 90,000 → 첫 구매 80,000, 쿠팡 · 스마트스토어만', () => {
  assert.deepEqual(POLICY, { list: 140000, sale: 100000, tiers: [['알람설정 할인', 90000], ['첫 구매가', 80000]] });
  assert.deepEqual([...POLICY_SCOPES], ['coupang', 'naver'], '아임웹은 이 기능으로 하지 않는다(11-06)');
  const v = [POLICY.list, POLICY.sale, ...POLICY.tiers.map(t => t[1])];
  assert.ok(v.every(x => x % 1000 === 0), '모두 천 원 단위');
  assert.ok(v.every((x, i) => !i || x < v[i - 1]), '단계마다 내려간다');
  assert.equal(couponGuide(), '알람설정 할인 90,000(−10,000) · 첫 구매가 80,000(−10,000)');
});

test('할인율은 실제보다 크게 쓰지 않는다(표시용 — 표의 % 와 달라도 상관없음, 11-06)', () => {
  assert.equal(percentOff(140000, 100000), 28, '28.57% → 28');
  assert.equal(percentOff(100000, 90000), 10, '부동소수로 9 가 되지 않는다');
});

test('정책 판매가: 판매 단위 줄에 판매가 100,000 · 정가 140,000, 나머지는 이유를 달아 건너뛴다', () => {
  const coupang = (variant, price, name = '옵틱글래스 벤츠 G바겐 광각 사이드 와이드미러') => policyPrice('coupang', { variant, price, name });
  assert.deepEqual(coupang('1개 No.906 BSA', 140000), { price: 100000, list: 140000, result: '정책 판매가 100,000 · 정가 140,000 (28%↓)' });
  assert.equal(coupang('1개 No.312', 140000).price, 100000, 'BSA · 일반 같은 값');
  assert.equal(policyPrice('naver', { variant: '기본 판매가 · 옵션 추가금 유지', price: 140000, name: '옵틱글래스 크라이슬러200C' }).price, 100000);
  assert.match(coupang('운전석', 80000).skip, /단품가 규칙 미정/);
  assert.match(coupang('[B313] 1세대/24~ 1개', 120000, '옵틱글래스 BMWR 12 nine T 오토바이 광각 사이드 와이드미러').skip, /오토바이/);
  assert.match(coupang('1개 No.415', 1500000).skip, /절반 아래/, '쿠팡 50% 인하 상한에 걸릴 줄(가격 오타)');
  assert.equal(coupang('1개 No.312', 0).price, 100000, '현재가 0(미판매)은 비교하지 않는다');
  assert.match(policyPrice('imweb-ko', { variant: '조합 · 1set', price: 140000 }).skip, /대상 몰이 아님/);
});
