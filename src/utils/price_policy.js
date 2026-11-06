/**
 * 가격 정책 — 일괄 수정 값 출처의 '가격 정책'. 표: 2026-11-05 스토어팜 · 쿠팡, 11-06 본사 자사몰(docs/coupon-discount.md).
 *
 * 표의 정가 · 판매가는 1set 가격이다. 11-06 소유자 승인(범위 A)에 따라 판매가만 1set 줄에 채운다.
 *   - 운전석 · 조수석 줄과 네이버(한쪽씩 판다)는 단품가 규칙이 정해지지 않아 지금 값을 둔다.
 *   - 정가(취소선)는 쓰지 않는다.
 * 2 · 3단계(정회원 · 알림설정 · 첫 구매)는 판매자센터에서 손으로 만드는 쿠폰이다.
 *   할인 금액이 판(BSA · 일반)과 상관없이 같아서 몰마다 정액 쿠폰 한두 개면 된다.
 * electron · fs 를 import 하지 않는다 — 메인과 화면이 같이 쓴다.
 */
import { editionOf, referenceRole } from './country_sync.js';

// list 정가 · sale 판매가 · tier2/tier3 2 · 3단계 가격(쿠폰 · 그룹 할인 뒤 값).
export const POLICY = {
  imweb: { tiers: ['정회원가', '첫 구매가'],
    plain: { list: 140000, sale: 100000, tier2: 85000, tier3: 70000 },
    bsa: { list: 180000, sale: 135000, tier2: 120000, tier3: 105000 } },
  market: { tiers: ['알림설정 할인', '첫 구매가'],
    plain: { list: 140000, sale: 100000, tier2: 90000, tier3: 80000 },
    bsa: { list: 180000, sale: 135000, tier2: 125000, tier3: 115000 } },
};
// 값 출처 '가격 정책'을 고를 수 있는 일괄 수정 범위. 네이버는 단품가 규칙이 정해지면 'market' 으로 붙인다.
export const POLICY_SCOPES = { 'imweb-ko': 'imweb', coupang: 'market' };

/** 천 원(unit 1000) · 만 원(10000) 단위로 내려 끝자리를 맞춘다. 할인율로 가격을 만들 때 쓴다. */
export const floorTo = (won, unit = 1000) => Math.floor(won / unit) * unit;
/** 할인율(%). 실제보다 크게 쓰지 않게 버린다. 정수로 계산해 100,000→90,000 이 9% 로 떨어지지 않는다. */
export const percentOff = (from, to) => Math.floor((from - to) * 100 / from);
const won = n => Number(n).toLocaleString('ko-KR');

/**
 * 한 줄의 판. { bsa: true|false, by } | { bsa: null, why }.
 * 근거 순서: 옵션 · 상품명 표기 → (쿠팡) 옵션 문구 → 차량 카탈로그(상품번호의 bsa 칸이 모두 같을 때).
 * 아임웹은 BSA 표기가 없으면 일반이라고 보지 않는다. BSA판을 따로 만든 상품은 옵션에도 이름에도 BSA 가 없다
 * (11-06 스냅샷 본사몰 217개 중 54개 — 1set 220,000). 쿠팡은 BSA 표기가 없으면 일반판이다(나라 탭 · 인덱스와 같은 규칙).
 */
export function editionFor(scope, row, catalog) {
  const text = editionOf(row.variant) ?? editionOf(row.name);
  if (text !== null) return { bsa: text, by: '옵션 · 상품명 표기' };
  if (scope === 'coupang' && typeof row.identity?.bsa === 'boolean') return { bsa: row.identity.bsa, by: '쿠팡 옵션 표기' };
  const nos = row.identity?.nos || [];
  if (nos.length !== 1) return { bsa: null, why: '상품번호를 하나로 읽지 못해 판(BSA · 일반)을 모름' };
  const no = nos[0];
  // 'Bsa 제작 필요' 는 아직 BSA판이 없다는 뜻이다. 브라켓 · 크기 메모는 BSA 와 상관없다.
  const marks = (catalog?.variants || []).filter(v => String(v.no).toUpperCase() === no)
    .map(v => /bsa/i.test(v.bsa || '') && !/제작/.test(v.bsa));
  if (!marks.length) return { bsa: null, why: `카탈로그에서 No.${no} 를 찾지 못해 판을 모름` };
  if (marks.every(Boolean)) return { bsa: true, by: `카탈로그 No.${no} BSA 가능` };
  if (!marks.some(Boolean)) return { bsa: false, by: `카탈로그 No.${no} BSA 없음` };
  return { bsa: null, why: `카탈로그 No.${no} 에 BSA 가능 · 불가 줄이 섞여 판을 모름` };
}

/**
 * 일괄 수정 한 줄에 넣을 정책 판매가. { price, result } | { skip }.
 * row: 몰 탭의 행(scope · id · optionId · variant · name · identity).
 * hasCombos: 같은 상품에 조합 줄이 있는지. 아임웹 기본가 줄은 1set 가 아니다(기본 80,000 · 1set 150,000).
 */
export function policyPrice(scope, row, { hasCombos = false, catalog = null } = {}) {
  const mall = POLICY_SCOPES[scope];
  if (!mall) return { skip: '가격 정책 대상 몰이 아님' };
  if (/오토바이|바이크/.test(row.name || '')) return { skip: '오토바이 상품 — 정책표 대상 아님' };
  // 쿠팡은 1set 단위로 판다('1개' = 1set). 아임웹은 조합 줄의 구성으로 가른다.
  const role = scope === 'coupang' ? (/운전석|조수석/.test(row.variant || '') ? 'side' : 'set')
    : !row.optionId ? (hasCombos ? 'base' : 'set') : referenceRole(row) || 'side';
  if (role === 'base') return { skip: '기본가 줄 — 1set 조합 줄만 채움' };
  if (role !== 'set') return { skip: '운전석 · 조수석 — 단품가 규칙 미정(지금 값 유지)' };
  const ed = editionFor(scope, row, catalog);
  if (ed.bsa === null) return { skip: ed.why };
  const p = POLICY[mall][ed.bsa ? 'bsa' : 'plain'];
  // 쿠팡은 한 번에 50% 넘게 내리면 저장이 그 상품째 멈춘다(coupang.js). 스냅샷에서 이런 줄은 대개 옵션의 BSA 표기가 빠진
  // BSA판(220,000)이거나 가격 오타(1,500,000)였다 — 채우지 않고 알린다.
  if (scope === 'coupang' && Number(row.price) > 0 && p.sale < Number(row.price) * 0.5)
    return { skip: `지금 ${won(row.price)} 의 절반 아래 — 옵션의 BSA 표기 · 가격을 확인(쿠팡 50% 인하 상한)` };
  return { price: p.sale,
    result: `정책 ${ed.bsa ? 'BSA' : '일반'} 1set ${won(p.sale)} (정가 ${won(p.list)} 대비 ${percentOff(p.list, p.sale)}%↓ · 판: ${ed.by})` };
}

/** 판매자센터에서 만들 쿠폰 금액 안내. 판별 금액이 같으면 하나로 적는다. */
export function couponGuide(scope) {
  const p = POLICY[POLICY_SCOPES[scope]];
  if (!p) return '';
  const step = (a, b) => [...new Set(['plain', 'bsa'].map(e => p[e][a] - p[e][b]))].map(won).join(' / ');
  return `${p.tiers[0]} −${step('sale', 'tier2')} · ${p.tiers[1]} −${step('tier2', 'tier3')}`;
}
