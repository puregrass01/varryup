/**
 * 상품 표준 표기 — 몰마다 다른 행을 '상품번호 · BSA 판 · SKU' 한 가지로 읽는다.
 *
 * 몰마다 상품을 가리키는 값이 다르다. 네이버는 원상품번호, 쿠팡은 등록상품ID·옵션ID, 아마존·eBay 는 SKU,
 * 아임웹은 카탈로그 행이다. 사람이 말하는 '상품번호'는 그중 어느 것도 아니고 옵션 문구의 'No.101번' 이다.
 * 번호는 duplicate_guard 와 같은 규칙(optionNo·hasBsa)으로 읽고, SKU 는 차량 카탈로그로 번호에 잇는다
 * (카탈로그의 SKU 는 모두 번호 하나에만 대응한다. 같은 SKU 가 BSA 판·일반 판에 함께 쓰이므로 SKU 로 판은 모른다).
 *
 * 보여 주기·검색용이다. 중복 판정 키(duplicate_guard 의 채널별 키)와 저장에 쓰는 몰 ID 는 바꾸지 않는다.
 * electron·fs 를 import 하지 않는다 — 메인과 화면이 같이 쓴다.
 */
import { optionNo, hasBsa } from './duplicate_guard.js';

const upper = v => String(v ?? '').trim().toUpperCase();
// 상품명은 'No.' 가 붙은 번호만 읽는다. optionNo 의 끝자리 규칙은 '인피니티 Q50' 의 Q50 을 번호로 읽는다.
const NAMED_NO = /No\.\s*([A-Za-z]?\d+(?:-\d+(?!\s*세대))?)/i;
const SKU_ID_SCOPES = /^(?:amazon-|ebay$)/;

/** 카탈로그에서 SKU → 번호, 쿠팡 등록상품ID → 옵션(번호·BSA) 표를 만든다. */
export function createIdentityIndex(catalog) {
  const skuNo = new Map(), coupang = new Map();
  const add = (sku, no) => { const k = upper(sku), n = upper(no); if (k && n && !skuNo.has(k)) skuNo.set(k, n); };
  for (const v of catalog?.variants || []) for (const sku of [...(v?.skus || []), ...(v?.amazonSkus || [])]) add(sku, v.no);
  for (const l of catalog?.listings || []) add(l?.sku, l?.no);
  for (const p of catalog?.coupang || []) {
    if (p?.id == null) continue;
    coupang.set(String(p.id), (p.options || []).map(o => ({ id: String(o?.id ?? ''), no: upper(o?.no), bsa: !!o?.bsa })).filter(o => o.no));
  }
  return { skuNo, coupang };
}
const EMPTY = createIdentityIndex(null);

const splitSkus = v => String(v ?? '').split('|').map(upper).filter(Boolean);
const fromOption = text => { const no = optionNo(text); return no ? { no, bsa: hasBsa(text) } : null; };

/**
 * 한 행의 표준 식별값 { nos, bsa, skus }.
 * nos 가 여럿이면 옵션이 여럿인 상품(네이버 원상품·쿠팡 등록상품)이다. bsa 는 모든 번호의 판이 같을 때만 정하고,
 * 모르면 null 이다. 근거 순서: 행이 직접 준 번호 → 옵션 문구 → 쿠팡 스냅샷 → SKU → 상품명의 'No.번호'.
 */
export function productIdentity(row, index = EMPTY) {
  const scope = String(row?.scope || '');
  const skus = [...new Set([...splitSkus(row?.sku), ...(SKU_ID_SCOPES.test(scope) ? splitSkus(row?.id) : [])])];
  let entries = [];
  if (row?.productNo) entries = [{ no: upper(row.productNo), bsa: typeof row.bsaEdition === 'boolean' ? row.bsaEdition : null }];
  if (!entries.length && row?.variant) entries = [fromOption(row.variant)].filter(Boolean);
  if (!entries.length && Array.isArray(row?.optionTexts)) entries = row.optionTexts.map(fromOption).filter(Boolean);
  if (!entries.length && scope === 'coupang') {
    // 옵션 행이면 그 옵션만 본다. 못 찾았다고 상품의 다른 옵션 번호를 붙이면 엉뚱한 번호가 보인다.
    const options = index.coupang.get(String(row?.id ?? '')) || [];
    entries = row?.optionId ? options.filter(o => o.id === String(row.optionId)) : options;
  }
  if (!entries.length) entries = skus.map(sku => index.skuNo.get(sku)).filter(Boolean).map(no => ({ no, bsa: null }));
  if (!entries.length) {
    const m = String(row?.name ?? '').match(NAMED_NO);
    if (m) entries = [{ no: upper(m[1]), bsa: hasBsa(row.name) }];
  }
  const unique = [...new Map(entries.map(e => [e.no + '|' + e.bsa, e])).values()];
  const nos = [...new Set(unique.map(e => e.no))];
  const bsa = unique.length && unique.every(e => e.bsa === unique[0].bsa) ? unique[0].bsa : null;
  return { nos, bsa, skus, options: unique };
}

/** 번호 하나의 표기. duplicate_guard 의 안내 문구와 같은 'No.101 BSA'. */
export const noLabel = (no, bsa) => 'No.' + no + (bsa ? ' BSA' : '');

/** 표·CSV·검색에 쓰는 글자. main 은 대표 표기, all 은 옵션 전체, search 는 'No.' 유무 모두로 찾게 한다. */
export function identityText(identity) {
  const { nos = [], bsa = null, skus = [], options = [] } = identity || {};
  const all = options.map(o => noLabel(o.no, o.bsa)).join(', ');
  const main = !nos.length ? '' : nos.length === 1 ? noLabel(nos[0], bsa) : noLabel(nos[0], false) + ' 외 ' + (nos.length - 1) + '개';
  return { main, all, count: nos.length, skus: skus.join(' | '),
    search: [...nos.flatMap(no => ['No.' + no, no]), bsa ? 'BSA' : '', ...skus].filter(Boolean).join(' ') };
}
