// 해외몰 판매가 = 국내 기준가(원) ÷ 환율을 앞 두 자리만 남기고 버린 값. 환율 우대·마진 없이 서버가 수집한 환율을 그대로 쓴다.
// (2026-09-30 결정: 65,000원 → 7,533엔 → 7,500엔 · 47.98달러 → 47달러 · 110.61달러 → 110달러)
//
// 국내 상품과 해외 SKU 를 잇는 공통 키가 없다(쿠팡 externalVendorSku 비어 있음, 카탈로그 자동 매칭 3%).
// 그래서 국내 판매가를 등급(150,000원·220,000원 …)으로 두고, 해외 상품은 지금 가격을 원화로 되돌려
// 가장 가까운 등급에 한 번 연결한다. 2026-09 기준 109.32 USD 는 150,000원 ÷ 1,372원이었다.
import { validRates, DAY } from './currency_rates.js';

export const FX_SCOPES = Object.freeze({
  'amazon-us': Object.freeze({ label: '아마존 미국', currency: 'USD' }),
  ebay: Object.freeze({ label: 'eBay', currency: 'USD' }),
  'amazon-jp': Object.freeze({ label: '아마존 일본', currency: 'JPY' }),
  // 아임웹은 옵션 조합마다 가격이 따로라 등급표 대신 같은 상품의 한국 가격을 환산한다(imweb_unit_prices.js) —
  // 미국·일본 구역을 함께 바꾼다. optIn: 처음엔 꺼 둔다(업데이트만으로 PC 마다 아임웹 자동 저장이 켜지지 않게).
  'imweb-en': Object.freeze({ label: '아임웹 미국·일본', currency: 'USD', optIn: true }),
});
export const MIN_CHANGE = 0.01;       // 환율로 계산한 값(자르기 전)이 지금 판매가와 1% 미만 차이면 그대로 둔다
export const MAX_AUTO_CHANGE = 0.1;   // 10% 넘게 바뀌는 상품은 자동으로 저장하지 않는다
// 지금 가격을 원화로 되돌려 등급을 찾는 범위. 앞 두 자리만 남기면 가격이 최대 9% 내려가므로 아래로 넓게 본다.
export const TIER_BELOW = 0.1;
export const TIER_ABOVE = 0.05;
export const DEFAULT_TIERS = Object.freeze([
  Object.freeze({ id: 'tier-1', label: '일반 미러', krw: 150000 }),
  Object.freeze({ id: 'tier-2', label: 'BSA 미러', krw: 220000 }),
  Object.freeze({ id: 'tier-3', label: '', krw: 275000 }),
]);

const DIGITS = { USD: 2, JPY: 0 };   // 통화의 최소 단위: USD 0.01, JPY 1
const EPS = 1e-9;                     // 110 / 100 - 1 = 0.10000000000000009 같은 부동소수 잡음
const won = krw => Number(krw).toLocaleString('ko-KR') + '원';

/** 가격 계산에 쓸 수 없는 환율이면 이유를, 쓸 수 있으면 빈 문자열을 돌려준다. */
export function rateProblem(snapshot, now = Date.now()) {
  if (!validRates(snapshot)) return '환율 데이터가 없거나 올바르지 않습니다.';
  const age = now - Date.parse(snapshot.fetchedAt);
  if (snapshot.stale || age < 0 || age >= DAY) return '환율을 수집한 지 24시간이 지났습니다. 인터넷 연결을 확인하세요.';
  return '';
}

function digitsOf(currency) {
  if (!Object.hasOwn(DIGITS, currency)) throw new Error('지원하지 않는 통화입니다: ' + currency);
  return DIGITS[currency];
}

/** 원화 금액을 대상 통화로 환산한 값(자르기 전). */
export function convertKrw(krw, currency, snapshot) {
  digitsOf(currency);
  const value = Number(krw) / snapshot.rates.KRW * snapshot.rates[currency];
  if (!Number.isFinite(value) || value <= 0) throw new Error('환산 금액을 계산할 수 없습니다.');
  return value;
}

/**
 * 앞 두 자리만 남기고 나머지는 버린다. 7,533 → 7,500 · 47.98 → 47 · 110.61 → 110 · 17,396 → 17,000.
 * 통화의 최소 단위(USD 0.01, JPY 1)보다 잘게 자르지 않는다. 뒤의 0 은 붙이지 않는다('110', '7500').
 */
export function leadingTwo(value, currency) {
  const digits = digitsOf(currency), amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('금액이 올바르지 않습니다.');
  const step = Math.max(10 ** (Math.floor(Math.log10(amount)) - 1), 10 ** -digits);
  // 7499.9999999 같은 부동소수 잡음이 한 칸 아래로 떨어뜨리지 않게 소수 여섯째 자리에서 먼저 자른다.
  const kept = Math.floor(Number((amount / step).toFixed(6))) * step;
  if (!(kept > 0)) throw new Error('환산 금액이 너무 작습니다.');
  return String(Number(kept.toFixed(digits)));
}

/** 원화 기준가의 해외 판매가: 환산한 뒤 앞 두 자리만 남긴다. */
export function fromKrw(krw, currency, snapshot) {
  return leadingTwo(convertKrw(krw, currency, snapshot), currency);
}

export function toKrw(price, currency, snapshot) {
  digitsOf(currency);
  return Number(price) / snapshot.rates[currency] * snapshot.rates.KRW;
}

/** 지금 가격을 원화로 되돌려 등급의 −10% ~ +5% 안에 드는 가장 가까운 등급. 없으면 null. */
export function findTier(price, currency, snapshot, tiers) {
  const krw = toKrw(price, currency, snapshot);
  if (!Number.isFinite(krw) || krw <= 0) return null;
  let best = null;
  for (const tier of tiers) {
    const gap = krw / tier.krw - 1;
    if (gap >= -TIER_BELOW - EPS && gap <= TIER_ABOVE + EPS && (!best || Math.abs(gap) < best.gap)) best = { tier, gap: Math.abs(gap) };
  }
  return best?.tier || null;
}

/**
 * 새 판매가와 처리 방법.
 *   same   계산한 두 자리 가격이 지금 판매가와 같다
 *   small  지금 판매가가 이미 두 자리 가격이고 환율로 계산한 값(자르기 전)이 1% 미만 움직였다.
 *          자른 값만 보면 환율이 1,364원 근처에서 조금만 흔들려도 110 ↔ 100달러를 오가므로 그대로 둔다.
 *   large  10% 넘게 바뀐다(자동 저장 안 함)
 *   update 저장한다. 109.32 처럼 두 자리 가격이 아닌 지금 가격은 1% 미만 차이여도 한 번 정리한다.
 * change 는 실제로 바뀌는 비율, drift 는 환율로 계산한 값이 지금 판매가에서 움직인 비율이다.
 */
export function planPrice({ current, currency, krw, snapshot, maxChange = MAX_AUTO_CHANGE }) {
  const now = Number(current);
  if (!Number.isFinite(now) || now <= 0) throw new Error('지금 판매가가 없습니다.');
  const raw = convertKrw(krw, currency, snapshot), target = leadingTwo(raw, currency);
  const change = Number(target) / now - 1, drift = raw / now - 1;
  const clean = Number(leadingTwo(now, currency)) === now;
  const action = Number(target) === now ? 'same'
    : clean && Math.abs(drift) < MIN_CHANGE - EPS ? 'small'
      : Math.abs(change) > maxChange + EPS ? 'large' : 'update';
  return { target, raw, change, drift, action };
}

/**
 * 등급표를 검사해 정리한다. 가까운 두 등급은 지금 가격만으로 구분할 수 없으므로
 * 등급을 찾는 범위(−10% ~ +5%)가 겹치지 않게 약 17% 이상 떨어져 있어야 한다.
 * reserved: 새 등급에 주면 안 되는 id(지운 등급·연결이 남은 등급). 다시 주면 지운 등급의 상품이 새 금액으로 넘어간다.
 */
export function normalizeTiers(input, reserved = []) {
  if (!Array.isArray(input) || !input.length) throw new Error('국내 기준가 등급을 하나 이상 입력하세요.');
  if (input.length > 20) throw new Error('국내 기준가 등급은 20개까지 둘 수 있습니다.');
  const ids = new Set(), taken = new Set([...reserved, ...input.map(t => t?.id)]);
  const tiers = input.map((tier, index) => {
    const krw = Number(String(tier?.krw ?? '').replaceAll(',', '').trim());
    if (!Number.isInteger(krw) || krw < 1000 || krw > 100000000)
      throw new Error(`${index + 1}번째 등급의 국내 기준가를 1,000원 이상 정수로 입력하세요.`);
    let id = String(tier?.id ?? '').trim();
    if (!/^[\w-]{1,40}$/.test(id) || ids.has(id)) {
      let n = 1;
      while (ids.has('tier-' + n) || taken.has('tier-' + n)) n++;
      id = 'tier-' + n;
    }
    ids.add(id); taken.add(id);
    return { id, label: String(tier?.label ?? '').trim().slice(0, 30), krw };
  });
  const sorted = [...tiers].sort((a, b) => a.krw - b.krw);
  const gap = (1 + TIER_ABOVE) / (1 - TIER_BELOW);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].krw / sorted[i - 1].krw < gap)
      throw new Error(`국내 기준가 ${won(sorted[i - 1].krw)}과 ${won(sorted[i].krw)}이 너무 가깝습니다. 지금 가격으로 등급을 구분할 수 있게 17% 이상 차이 나야 합니다.`);
  }
  return tiers;
}

/** 화면·기록용으로 줄인 환율 정보. */
export function rateInfo(snapshot) {
  return { marketDate: snapshot.marketDate, fetchedAt: snapshot.fetchedAt, source: snapshot.source || '',
    KRW: snapshot.rates.KRW, JPY: snapshot.rates.JPY };
}
