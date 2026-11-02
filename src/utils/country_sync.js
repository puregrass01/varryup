/**
 * 나라별 가격 통일 — 일괄 수정의 [한국] [미국] [일본] 버튼.
 *
 * 기준은 그 나라의 아임웹 본사몰 구역이다(한국 imweb-ko · 미국 imweb-en · 일본 imweb-jp, 세 구역은 상품번호가 같다).
 * 기준 상품의 1set 조합가를 같은 나라 다른 몰의 같은 상품 행 '판매가 덮어쓰기' 칸에 넣는다. 보내기는 몰 탭의 선택 변경 저장으로만.
 * 한국은 상세 이미지도 넣는다(본사 · 네이버 · 쿠팡 모두 상세 이미지). 미국 · 일본의 아마존 · eBay 는 대표 갤러리라 넣지 않는다.
 * B2B 는 대상이 아니다(2026-11-02 결정).
 *
 * 같은 상품은 data/country_index.json 으로 찾는다(scripts/build_country_index.mjs — 베리맵 대조표, 없으면 Vehicles 시트).
 * electron · fs 를 import 하지 않는다 — 메인과 화면이 같이 쓴다.
 */
import { hasBsa } from './duplicate_guard.js';

// targets: 기준 값을 따라가는 몰, view: 나라 화면에 보기만 하는 몰(B2B — 값은 바꾸지 않는다, 11-02).
export const COUNTRIES = {
  kr: { label: '한국', ref: 'imweb-ko', targets: ['naver', 'coupang'], view: ['imweb-b2b'], images: true },
  us: { label: '미국', ref: 'imweb-en', targets: ['ebay', 'amazon-us'], view: [], images: false },
  jp: { label: '일본', ref: 'imweb-jp', targets: ['amazon-jp'], view: [], images: false },
};

const SET = /1\s*(?:set|세트|セット)/i, LEFT = /운전석|\bLeft\b|運転席/i;
// 구역마다 옵션 값이 번역돼 있다(imweb_unit_names.js: BSA 있음/없음 · With/No BSA · あり/なし). 조합 문구는 값만 잇는다
// (optionTextOf: '조합 · なし / 1セット(左右)') — 일본 구역은 'BSA' 글자가 없어 값 한 칸이 なし/あり 인지로 읽는다.
// hasBsa 는 'No BSA' 를 BSA 로 읽는다.
export function editionOf(text) {
  const s = String(text ?? '');
  const parts = s.replace(/^조합\s*·\s*/, '').split(/\s*[/·]\s*/).map(p => p.replace(/^[^=]*=\s*/, '').trim());
  if (parts.includes('なし')) return false;
  if (parts.includes('あり')) return true;
  if (!/BSA/i.test(s)) return null;
  if (/BSA\s*(?:X\b|없음|미적용|불가)|No\s+BSA|Without\s+BSA/i.test(s)) return false;
  if (/BSA\s*(?:O\b|있음)|With\s+BSA/i.test(s)) return true;
  return hasBsa(s);
}

/**
 * 기준 상품 한 개의 줄(기본가 + 조합)에서 판(true=BSA · false=일반 · null=구분 없음)별 조합가 두 벌.
 * set: 1set 조합가(쿠팡 · 아마존 · eBay 의 판매 단위), left: 운전석 조합가(네이버 기본 판매가 — 네이버는 한쪽씩 판다:
 * 운전석 +0 · 조수석 −10000 추가금. 베리맵 대조 240개 중 217개가 본사 운전석가와 같고 1set 가와 같은 것은 0개, 11-02).
 * 조합이 하나도 없는 상품은 기본가를 1set 으로 본다.
 */
export function referencePrices(rows) {
  const set = new Map(), left = new Map(), valid = v => v !== '' && v != null && Number.isFinite(Number(v)) && Number(v) > 0;
  if (!rows.some(r => r.optionId)) {
    if (!valid(rows[0]?.price)) return { error: '기준 판매가 없음' };
    set.set(null, String(rows[0].price));
    return { set, left };
  }
  for (const r of rows.filter(r => r.optionId && valid(r.price))) {
    const [table, what] = SET.test(r.variant || '') ? [set, '1set'] : LEFT.test(r.variant || '') ? [left, '운전석'] : [];
    if (!table) continue;
    const key = editionOf(r.variant);
    if (table.has(key) && Number(table.get(key)) !== Number(r.price)) return { error: `같은 판의 ${what} 조합가가 둘 이상` };
    table.set(key, String(r.price));
  }
  return set.size || left.size ? { set, left } : { error: '1set · 운전석 조합가 없음' };
}

/** 기준 상품 조합 줄의 쓰임: 'set'(1set) · 'left'(운전석) · null(조수석 · 기본가 등). 나라 화면이 본사 줄을 고를 때 쓴다. */
export const referenceRole = r => !r.optionId ? null : SET.test(r.variant || '') ? 'set' : LEFT.test(r.variant || '') ? 'left' : null;

/** 판(bsa)에 맞는 기준가. 판을 모르면 기준가가 하나뿐일 때만. what: 기준 칸 이름(1set · 운전석). */
export function pickPrice(table, bsa, what = '1set') {
  if (!table?.size) return { skip: `기준 상품에 ${what} 조합가가 없음` };
  if (typeof bsa !== 'boolean') {
    const values = [...new Set([...table.values()].map(Number))];
    return values.length === 1 ? { price: [...table.values()][0] } : { skip: 'BSA판인지 몰라 기준가(일반 · BSA)를 고를 수 없음' };
  }
  const price = table.get(bsa) ?? (bsa ? undefined : table.get(null));
  return price == null ? { skip: `기준 상품에 ${bsa ? 'BSA' : '일반'}판 ${what} 가격이 없음` } : { price };
}

/**
 * 대상 행 한 줄에 넣을 값 { price, basis } | { skip }. ref: referencePrices 결과 + no, hint.bsa: 인덱스가 아는 판(쿠팡 옵션 문구 · 카탈로그 SKU).
 * 네이버는 기본 판매가(운전석) 하나라 원상품의 번호 · 판이 여럿이면(옵션 추가금으로 가격이 갈린다) 넣지 않는다.
 */
export function countryPrice(scope, row, ref, hint = {}) {
  const options = row.identity?.options || [];
  const nos = [...new Set(options.map(o => o.no))];
  if (ref.no && nos.length && !nos.includes(String(ref.no).toUpperCase())) return { skip: `번호가 다름(기준 No.${ref.no} · 이 행 No.${nos.join(', ')})` };
  if (options.length > 1) return { skip: '번호 · 판이 여럿인 상품 — 옵션 가격은 직접 고치세요' };
  let bsa = options.length === 1 && typeof options[0].bsa === 'boolean' ? options[0].bsa : null;
  // SKU 로 읽은 번호(아마존 · eBay)는 판을 모른다(bsa null) — 인덱스(카탈로그) · 상품명 순으로 정한다.
  if (bsa === null && typeof hint.bsa === 'boolean') bsa = hint.bsa;
  if (bsa === null) bsa = editionOf(row.name);
  const basis = scope === 'naver' ? '운전석' : '1set';
  const picked = pickPrice(scope === 'naver' ? ref.left : ref.set, bsa, basis);
  if (picked.skip) return picked;
  if (scope === 'coupang' && Number(picked.price) % 10 !== 0) return { skip: `쿠팡은 10원 단위만 가능(기준가 ${picked.price})` };
  return { ...picked, basis };
}

const collect = (index, p) => {
  const t = { naver: [], coupang: [], skus: [], b2b: [] };
  for (const row of p.rows || []) for (const k of Object.keys(t)) t[k].push(...(index.rows?.[row]?.[k] || []));
  for (const k of Object.keys(t)) t[k] = [...new Map(t[k].map(x => [x.slice(0, 2).join(':'), x])).values()];
  return t;
};
// 네이버 원상품 · 쿠팡 등록상품마다 그 상품을 가리키는 본사몰 상품 수. 여러 차가 묶인 상품(쿠팡 570개 중 177개 등)은
// 상세 이미지가 상품 하나라 한 차의 이미지로 덮으면 나머지 차가 틀린다 — 이미지를 넣지 않는다(가격은 옵션 · 번호로 가른다).
const owners = new WeakMap();
function ownersOf(index) {
  if (!owners.has(index)) {
    const count = new Map();
    for (const p of Object.values(index.products || {})) {
      const t = collect(index, p);
      for (const pid of new Set([...t.naver.map(x => 'naver:' + x[0]), ...t.coupang.map(x => 'coupang:' + x[0])])) count.set(pid, (count.get(pid) || 0) + 1);
    }
    owners.set(index, count);
  }
  return owners.get(index);
}

/**
 * 기준 상품번호마다 인덱스의 짝. { [prodNo]: { via, no, naver: [[원상품, 채널상품]], coupang: [[등록상품, 옵션, bsa]], skus: [[sku, bsa]], b2b: [[상품번호]],
 * shared: { naver: [원상품], coupang: [등록상품] } } | { missing } }. shared 는 다른 본사몰 상품도 가리키는 대상 상품이다.
 */
export function countryTargets(index, ids) {
  const out = {}, count = ownersOf(index || {});
  for (const id of ids.map(String)) {
    const p = index?.products?.[id];
    if (!p) { out[id] = { missing: '인덱스 · Vehicles 시트에 없음' }; continue; }
    const t = collect(index, p);
    const shared = scope => [...new Set(t[scope].map(x => x[0]))].filter(pid => count.get(scope + ':' + pid) > 1);
    out[id] = { via: p.via, no: p.no || '', ...t, shared: { naver: shared('naver'), coupang: shared('coupang') } };
  }
  return out;
}

const NUM = /^\d{1,15}$/;
/**
 * 행의 판매 페이지(손님이 보는 화면). 만들 수 없으면 ''. 메인(open-product-page)이 이 주소로만 연다 — 렌더러가 URL 을 넘기지 않는다.
 * 아임웹 영문 · 일본은 판매 페이지 도메인을 확인하지 못해 링크가 없다.
 */
export function productPageUrl(r) {
  const scope = String(r?.scope || ''), id = String(r?.id ?? '');
  const num = v => NUM.test(String(v ?? ''));
  if (scope === 'naver') return num(r.channelProductNo) ? `https://smartstore.naver.com/b-store/products/${r.channelProductNo}` : '';
  // 쿠팡은 검색 맥락(q · sourceType · rank) 없이 바로 들어가면 '사용권한이 없습니다' 로 막히는 상품이 있다(verimap_match.mjs 의 쿠팡 url 과 같게).
  if (scope === 'coupang') return num(r.displayProductId)
    ? `https://www.coupang.com/vp/products/${r.displayProductId}?` + new URLSearchParams({ ...(num(r.optionId) && { vendorItemId: r.optionId }),
      q: String(r.name ?? ''), sourceType: 'search', rank: '0', itemsCount: '1', searchRank: '0' }) : '';
  if (scope === 'amazon-us' || scope === 'amazon-jp')
    return /^[A-Z0-9]{10}$/.test(String(r.asin ?? '')) ? `https://www.amazon.${scope === 'amazon-jp' ? 'co.jp' : 'com'}/dp/${r.asin}` : '';
  if (scope === 'ebay') return num(r.listingId) ? `https://www.ebay.com/itm/${r.listingId}` : '';
  if (scope === 'imweb-ko') return num(id) ? `https://optic-glass.co.kr/shop_view/?idx=${id}` : '';
  if (scope === 'imweb-b2b') return num(id) ? `https://bb-store.co.kr/shop_view?idx=${id}` : '';
  return '';
}
