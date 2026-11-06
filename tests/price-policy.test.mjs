import test from 'node:test';
import assert from 'node:assert/strict';
import { POLICY, floorTo, percentOff, editionFor, policyPrice, couponGuide } from '../src/utils/price_policy.js';

// 카탈로그 bsa 칸은 '이 차에 BSA판이 있는가' 메모다(빈칸 · 'Bsa가능' · 'Bsa 제작 필요' · 브라켓 메모 등).
const catalog = { variants: [
  { no: '101', bsa: '' }, { no: '101', bsa: '사각브라켓' },
  { no: '610', bsa: 'Bsa가능' }, { no: '610', bsa: 'BSA 가능' },
  { no: '612', bsa: 'Bsa가능' }, { no: '612', bsa: '' },
  { no: '777', bsa: 'Bsa 제작 필요' },
] };
const head = (no, variant, extra = {}) => ({ scope: 'imweb-ko', id: no, optionId: 'od1', variant: '조합 · ' + variant,
  name: `옵틱글래스 BMW X5 광각미러 [No.${no}]`, identity: { nos: [no], bsa: false }, price: 150000, ...extra });
const coupang = (variant, price, bsa) => ({ scope: 'coupang', id: '1', optionId: '2', variant, name: '옵틱글래스 벤츠 G바겐 광각 사이드 와이드미러',
  identity: { nos: ['312'], bsa }, price });

test('정책표: 11-05 · 11-06 표 그대로, 천 원 끝자리, 정가 > 판매가 > 2단계 > 3단계', () => {
  assert.deepEqual(POLICY.imweb.plain, { list: 140000, sale: 100000, tier2: 85000, tier3: 70000 });
  assert.deepEqual(POLICY.imweb.bsa, { list: 180000, sale: 135000, tier2: 120000, tier3: 105000 });
  assert.deepEqual(POLICY.market.plain, { list: 140000, sale: 100000, tier2: 90000, tier3: 80000 });
  assert.deepEqual(POLICY.market.bsa, { list: 180000, sale: 135000, tier2: 125000, tier3: 115000 });
  for (const mall of Object.values(POLICY)) for (const ed of [mall.plain, mall.bsa]) {
    const v = [ed.list, ed.sale, ed.tier2, ed.tier3];
    assert.deepEqual(v.map(x => floorTo(x)), v, '이미 천 원 단위');
    assert.ok(v.every((x, i) => !i || x < v[i - 1]), '단계마다 내려간다');
  }
});

test('쿠폰 금액은 판과 상관없이 같다 — 몰마다 정액 쿠폰 한두 개', () => {
  assert.equal(couponGuide('imweb-ko'), '정회원가 −15,000 · 첫 구매가 −15,000');
  assert.equal(couponGuide('coupang'), '알림설정 할인 −10,000 · 첫 구매가 −10,000');
  assert.equal(couponGuide('naver'), '', '네이버는 단품가 규칙이 정해질 때까지 대상이 아니다');
});

test('내림 · 할인율: 천 원 · 만 원 단위로 내리고, 할인율은 실제보다 크게 쓰지 않는다', () => {
  assert.equal(floorTo(99400), 99000);
  assert.equal(floorTo(99400, 10000), 90000);
  assert.equal(floorTo(100000, 10000), 100000);
  assert.equal(percentOff(140000, 100000), 28, '표는 29% 로 적었지만 28.57% 다');
  assert.equal(percentOff(100000, 90000), 10, '부동소수로 9 가 되지 않는다');
  assert.equal(percentOff(90000, 80000), 11);
  assert.equal(percentOff(120000, 105000), 12);
});

test('판: 표기 → (쿠팡) 옵션 문구 → 카탈로그. 아임웹은 표기가 없다고 일반으로 보지 않는다', () => {
  assert.equal(editionFor('imweb-ko', head('101', 'BSA 있음 / 1set'), catalog).bsa, true);
  assert.equal(editionFor('imweb-ko', head('610', 'BSA 없음 / 1set'), catalog).bsa, false, '문구가 카탈로그보다 먼저');
  assert.equal(editionFor('imweb-ko', head('101', '1set', { name: '옵틱글래스 BMW X5 (BSA) 광각미러 [No.101]' }), catalog).bsa, true);
  // identity.bsa(false)는 상품명에 BSA 가 없다는 뜻일 뿐이다 — 아임웹은 카탈로그로 정한다.
  assert.deepEqual(editionFor('imweb-ko', head('610', '1set'), catalog), { bsa: true, by: '카탈로그 No.610 BSA 가능' });
  assert.equal(editionFor('imweb-ko', head('101', '1set'), catalog).bsa, false, '빈칸 · 브라켓 메모는 BSA 아님');
  assert.equal(editionFor('imweb-ko', head('777', '1set'), catalog).bsa, false, "'Bsa 제작 필요' 는 아직 BSA판 없음");
  assert.match(editionFor('imweb-ko', head('612', '1set'), catalog).why, /섞여/);
  assert.match(editionFor('imweb-ko', head('999', '1set'), catalog).why, /찾지 못해/);
  assert.match(editionFor('imweb-ko', head('101', '1set', { identity: { nos: ['101', '102'] } }), catalog).why, /하나로/);
  assert.equal(editionFor('coupang', coupang('1개 No.312(3세대/18.09~)', 150000, false), catalog).bsa, false, '쿠팡: 표기 없음 = 일반');
  assert.equal(editionFor('coupang', coupang('1개 No.906-1세대(26.04~)BSA', 220000, true), catalog).bsa, true);
});

test('정책 판매가: 1set 줄만 판별로 채우고 나머지는 이유를 달아 건너뛴다', () => {
  const at = (row, o) => policyPrice(row.scope, row, { catalog, ...o });
  assert.equal(at(head('101', 'BSA 없음 / 1set')).price, 100000);
  assert.equal(at(head('101', 'BSA 있음 / 1set', { price: 220000 })).price, 135000);
  assert.match(at(head('101', 'BSA 없음 / 1set')).result, /^정책 일반 1set 100,000 \(정가 140,000 대비 28%↓ · 판: 옵션 · 상품명 표기\)$/);
  assert.equal(at(head('610', '1set', { price: 220000 })).price, 135000, '표기 없는 BSA판 상품(카탈로그)');
  assert.match(at(head('101', 'BSA 없음 / 운전석')).skip, /단품가 규칙 미정/);
  assert.match(at(head('101', 'BSA 없음 / 조수석')).skip, /단품가 규칙 미정/);
  assert.match(at({ ...head('101', ''), optionId: '', variant: '기본 판매가 (조합 가격은 아래 줄)' }, { hasCombos: true }).skip, /기본가 줄/);
  assert.equal(at({ ...head('101', ''), optionId: '', variant: '' }, { hasCombos: false }).price, 100000, '조합 없는 상품은 기본가가 1set');
  assert.match(at(head('612', '1set')).skip, /섞여/);
  assert.match(at({ ...head('101', 'BSA 없음 / 1set'), scope: 'naver' }).skip, /대상 몰이 아님/);
  assert.equal(at(coupang('1개 No.312(3세대/18.09~)', 150000, false)).price, 100000);
  assert.equal(at(coupang('1개 No.906 BSA', 220000, true)).price, 135000);
  assert.match(at({ ...coupang('[B313] 1세대/24~ 1개', 120000, false), name: '옵틱글래스 BMWR 12 nine T 오토바이 광각 사이드 와이드미러' }).skip, /오토바이/);
  // 쿠팡 50% 인하 상한에 걸릴 줄(BSA 표기가 빠진 220,000 · 가격 오타)은 채우지 않는다.
  assert.match(at(coupang('1개 No.312(3세대/18.09~)', 220000, false)).skip, /절반 아래/);
  assert.match(at(coupang('1개 No.415', 1500000, false)).skip, /절반 아래/);
  assert.equal(at(coupang('1개 No.312', 0, false)).price, 100000, '현재가 0(미판매)은 비교하지 않는다');
});
