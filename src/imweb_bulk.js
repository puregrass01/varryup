// 아임웹 상품 일괄 수정(가격 · 상세 이미지) — 아임웹 Open API. 상품 일괄 수정 화면(bulk_price_ipc · bulk_image_service)이 쓴다.
//
// 범위 → 사이트 · 구역
//   imweb-b2b : B2B몰(블랙스토어B2B)  — KRW
//   imweb-ko  : 본사몰 한국 구역       — KRW
//   imweb-en  : 본사몰 미국 구역       — USD
//   imweb-jp  : 본사몰 일본 구역       — JPY
// 예전엔 네 범위를 '차량 카탈로그 참조 · API 연동 전'으로 묶어 읽기만 했다(imweb_catalog.js). 2026-10-05 Open API 로 바꿨다.
//
// 가격: 아임웹 옵션(조합) 가격은 추가금이 아니라 그 조합의 최종가다(본사 상품 3: 기본 80,000 · BSA 있음 운전석 115,000).
// 그래서 기본 판매가 한 줄 + 조합마다 한 줄로 보여 주고 각각 저장한다 — 쿠팡의 옵션별 가격과 같은 방식이다.
// 저장 직전에 다시 읽어, 불러온 뒤에 바뀌었으면 보내지 않는다(pre-send).
// 이미지: 그 구역 상품 상세설명(HTML)의 이미지. 기존 자리를 순서대로 바꾸고 글 · 배치는 그대로 둔다(replaceDetailImages).
import { extractDetailImages, replaceDetailImages, optionTextOf } from './platforms/openapi/imweb_b2b.js';
import { toFormData } from './platforms/openapi/imweb_client.js';
import { markPreSend } from './utils/api_error.js';

export const IMWEB_BULK_SCOPES = {
  'imweb-b2b': { site: 'b2b', currency: 'KRW', label: 'B2B몰' },
  'imweb-ko': { site: 'head', currency: 'KRW', label: '본사몰 한국' },
  'imweb-en': { site: 'head', currency: 'USD', label: '본사몰 미국' },
  'imweb-jp': { site: 'head', currency: 'JPY', label: '본사몰 일본' },
};
export const isImwebBulkScope = scope => Object.hasOwn(IMWEB_BULK_SCOPES, scope);
const STATUS_TEXT = { SOLDOUT: ' · 품절', HIDDEN: ' · 숨김' };

/** clientFor('b2b' | 'head') → createImwebClient(그 사이트 세션). */
export function createImwebBulk({ clientFor }) {
  const units = new Map();

  async function target(scope) {
    const spec = IMWEB_BULK_SCOPES[scope];
    if (!spec) throw new Error('아임웹 범위가 아닙니다: ' + scope);
    const client = clientFor(spec.site);
    if (!units.has(scope)) {
      const info = await client.siteInfo();
      const unit = (info?.unitList || []).find(u => String(u.currency).toUpperCase() === spec.currency);
      if (!unit?.unitCode) throw new Error(`아임웹 ${spec.label} 구역(${spec.currency})을 사이트 정보에서 찾지 못했습니다.`);
      units.set(scope, unit.unitCode);
    }
    return { client, unitCode: units.get(scope) };
  }

  async function list(scope) {
    const { client, unitCode } = await target(scope);
    return (await client.products(unitCode)).map(p => ({
      id: String(p.prodNo), name: String(p.name || ''), price: p.price,
      image: (p.productImages || [])[0] || '', status: p.prodStatus || '',
    }));
  }

  /** 가격 행: 기본 판매가 한 줄 + 조합(옵션 상세)마다 한 줄. detailImages 는 이미지 상태용이다. */
  async function load(scope, id) {
    const { client, unitCode } = await target(scope);
    const p = await client.product(id, unitCode);
    if (!p) throw new Error(`상품 ${id} 을 찾지 못했습니다.`);
    const details = await client.optionDetails(id, unitCode);
    const base = { id: String(p.prodNo ?? id), name: String(p.name || ''), image: (p.productImages || [])[0] || '',
      detailImages: extractDetailImages(p.content) };
    return [
      { ...base, optionId: '', variant: details.length ? '기본 판매가 (조합 가격은 아래 줄)' : '기본 판매가', price: p.price },
      ...details.map(d => ({ ...base, optionId: String(d.optionDetailCode),
        variant: '조합 · ' + optionTextOf(d) + (STATUS_TEXT[d.status] || ''), price: d.price })),
    ];
  }

  async function currentPrice(scope, id, optionId) {
    const { client, unitCode } = await target(scope);
    if (!optionId) return (await client.product(id, unitCode))?.price;
    const d = (await client.optionDetails(id, unitCode)).find(x => String(x.optionDetailCode) === String(optionId));
    if (!d) throw new Error(`조합 ${optionId} 을 찾지 못했습니다 — 옵션이 바뀌었을 수 있습니다. 현재가를 다시 불러오세요.`);
    return d.price;
  }

  /** 저장 직전에 지금 값을 다시 읽는다. 불러온 값과 다르면 보내지 않고, 이미 같은 값이면 보내지 않는다. */
  async function writePrice({ scope, id, optionId, price, expected }) {
    let now;
    try { now = await currentPrice(scope, id, optionId); }
    catch (e) { throw markPreSend(e); }
    if (expected !== '' && expected != null && Number(now) !== Number(expected)) {
      throw markPreSend(new Error(`불러온 뒤 판매가가 바뀌었습니다(지금 ${now}). 현재가를 다시 불러오세요.`));
    }
    if (Number(now) === Number(price)) return { unchanged: true, salePrice: now };
    const { client, unitCode } = await target(scope);
    if (optionId) await client.setOptionPrice(id, optionId, unitCode, Number(price));
    else await client.setPrice(id, unitCode, Number(price));
    return {};
  }

  // ── 상세 이미지 ──
  async function readImages(scope, id) {
    const { client, unitCode } = await target(scope);
    const p = await client.product(id, unitCode);
    if (!p) throw new Error(`상품 ${id} 을 찾지 못했습니다.`);
    const content = String(p.content || '');
    return { content, images: extractDetailImages(content) };
  }
  async function saveImages(scope, id, images, content) {
    if (!images.length) throw markPreSend(new Error('상세 이미지가 0장입니다. 최소 1장은 있어야 합니다.'));
    const { client, unitCode } = await target(scope);
    await client.request('PATCH', `/products/${encodeURIComponent(id)}`,
      { form: toFormData({ unitCode, description: replaceDetailImages(content, images) }) });
  }

  return { list, load, currentPrice, writePrice, readImages, saveImages };
}
