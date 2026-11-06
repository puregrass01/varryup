/**
 * 가격 정책 — 일괄 수정 값 출처의 '가격 정책'(쿠팡 · 스마트스토어). 근거: docs/coupon-discount.md.
 *
 * 11-06 소유자 결정: 판(BSA · 일반) 구분 없이 1set 정가 140,000 · 판매가 100,000.
 *   (220,000 · 219,000 → 150,000 → 140,000 으로 맞춘 뒤의 구조 — 지금 1set 값이 정가가 된다.)
 *   2 · 3단계는 판매자센터에서 손으로 만드는 쿠폰이다: 알람설정 90,000(−10,000) → 첫 구매 80,000(−10,000).
 *   할인율 표기는 맞추지 않는다. 아임웹 본사는 이 기능으로 하지 않는다(11-06 — 판매 페이지 스크립트가 정가를 그린다).
 * 채우는 값: 판매가(newPrice)와 정가(newList). 정가는 [선택 변경 저장]이 판매가와 함께 보낸다 —
 *   쿠팡 할인율 기준가(vendor-items original-prices), 네이버는 판매가(salePrice) = 정가 + 즉시할인(원).
 * 판매 단위 줄만 채운다: 쿠팡 옵션('1개' = 1set — 운전석 · 조수석이라고 적힌 옵션만 뺀다), 네이버 상품 한 줄(기본가).
 * electron · fs 를 import 하지 않는다 — 메인과 화면이 같이 쓴다.
 */
// tiers: [이름, 그 단계 가격] — 앞 단계(첫 단계는 판매가)에서 뺀 만큼이 쿠폰 금액이다. 이름은 소유자 표기(11-06) 그대로.
// 값은 모두 정해진 천 원 단위다 — 할인율로 계산하는 가격이 없어 '천 원 · 만 원 내림' 규칙(11-06 첫 지시)은 쓸 곳이 없어졌다.
export const POLICY = { list: 140000, sale: 100000, tiers: [['알람설정 할인', 90000], ['첫 구매가', 80000]] };
// 값 출처 '가격 정책'을 고를 수 있는 일괄 수정 범위.
export const POLICY_SCOPES = new Set(['coupang', 'naver']);

/** 할인율(%). 실제보다 크게 쓰지 않게 버린다. 정수로 계산해 100,000→90,000 이 9% 로 떨어지지 않는다. */
export const percentOff = (from, to) => Math.floor((from - to) * 100 / from);
const won = n => Number(n).toLocaleString('ko-KR');

/** 일괄 수정 한 줄에 넣을 값. { price, list, result } | { skip }. row: 몰 탭의 행(variant · name · price). */
export function policyPrice(scope, row) {
  if (!POLICY_SCOPES.has(scope)) return { skip: '가격 정책 대상 몰이 아님' };
  if (/오토바이|바이크/.test(row.name || '')) return { skip: '오토바이 상품 — 정책표 대상 아님' };
  if (scope === 'coupang' && /운전석|조수석/.test(row.variant || '')) return { skip: '운전석 · 조수석 — 단품가 규칙 미정(지금 값 유지)' };
  // 쿠팡은 한 번에 50% 넘게 내리면 저장이 그 상품째 멈춘다(coupang.js). 대개 가격 오타(1,500,000 등)다.
  if (scope === 'coupang' && Number(row.price) > 0 && POLICY.sale < Number(row.price) * 0.5)
    return { skip: `지금 ${won(row.price)} 의 절반 아래 — 가격을 확인(쿠팡 50% 인하 상한)` };
  return { price: POLICY.sale, list: POLICY.list,
    result: `정책 판매가 ${won(POLICY.sale)} · 정가 ${won(POLICY.list)} (${percentOff(POLICY.list, POLICY.sale)}%↓)` };
}

/** 판매자센터에서 만들 쿠폰 금액 안내 한 줄. */
export const couponGuide = () =>
  POLICY.tiers.map(([name, price], i) => `${name} ${won(price)}(−${won((i ? POLICY.tiers[i - 1][1] : POLICY.sale) - price)})`).join(' · ');
