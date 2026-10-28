import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseFragment } from 'parse5';
import { markPreSend } from '../utils/api_error.js';

const clone = value => JSON.parse(JSON.stringify(value));
const revisionOf = body => createHash('sha256').update(JSON.stringify(body)).digest('hex');
const attr = (node, name) => node.attrs?.find(a => a.name === name)?.value || '';
const escapeAttr = value => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function productNo(value) {
  const no = String(value ?? '').trim();
  if (!/^[1-9]\d*$/.test(no) || !Number.isSafeInteger(Number(no))) throw new Error('올바른 숫자 상품번호를 입력해주세요.');
  return no;
}

function integer(value, label, { negative = false } = {}) {
  if (!/^-?\d+$/.test(String(value ?? '').trim())) throw new Error(`${label}은 정수로 입력해주세요.`);
  const n = Number(value);
  if (!Number.isSafeInteger(n) || (!negative && n < 0)) throw new Error(`${label} 값이 올바르지 않습니다.`);
  return n;
}

function walk(node, visit) {
  visit(node);
  for (const child of node.childNodes || []) walk(child, visit);
}

// Source offsets preserve the original HTML, scripts, videos and text byte for byte.
// A SmartEditor image component moves together with its link, caption and metadata.
function imageBlocks(html) {
  const root = parseFragment(html, { sourceCodeLocationInfo: true });
  const images = [];
  walk(root, node => {
    if (node.tagName === 'img' && node.sourceCodeLocation && attr(node, 'src')) images.push(node);
  });
  const countImages = node => { let n = 0; walk(node, child => { if (child.tagName === 'img') n++; }); return n; };
  return images.map((node, index) => {
    let block = node;
    let grouped = false;
    for (let parent = node.parentNode; parent; parent = parent.parentNode) {
      if (attr(parent, 'class').split(/\s+/).includes('se-component')) {
        grouped = countImages(parent) > 1;
        if (!grouped && parent.sourceCodeLocation) block = parent;
        break;
      }
      if (['a', 'figure'].includes(parent.tagName) && countImages(parent) === 1 && parent.sourceCodeLocation) block = parent;
    }
    const { startOffset: start, endOffset: end } = block.sourceCodeLocation;
    return { id: `naver-image-${index}`, url: attr(node, 'src'), isNew: false, start, end, html: html.slice(start, end), grouped };
  });
}

export function extractNaverDetailImages(html = '') {
  return imageBlocks(html).map(({ id, url, isNew }) => ({ id, url, isNew }));
}

export function replaceNaverDetailImages(html, wanted) {
  if (!Array.isArray(wanted)) throw new Error('상세이미지 목록이 올바르지 않습니다.');
  const blocks = imageBlocks(html);
  if (wanted.length === blocks.length && wanted.every((im, i) => !im.isNew && im.id === blocks[i].id && im.url === blocks[i].url)) return html;
  if (blocks.some(b => b.grouped)) throw new Error('묶음 이미지가 포함된 상세설명은 이 화면에서 이미지 순서를 바꿀 수 없습니다. 이미지 목록을 다시 불러와 주세요.');
  const byId = new Map(blocks.map(b => [b.id, b]));
  const used = new Set();
  const next = wanted.map(im => {
    if (im.isNew) {
      let url;
      try { url = new URL(String(im.url || '')); } catch { throw new Error('상세이미지 URL을 확인해주세요.'); }
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('상세이미지는 HTTP 또는 HTTPS 주소여야 합니다.');
      return `<div><img src="${escapeAttr(url.href)}" style="max-width:100%;height:auto;" /></div>`;
    }
    const original = byId.get(im.id);
    if (!original || original.url !== im.url || used.has(im.id)) throw new Error('상세이미지 정보가 변경됐습니다. 상품을 다시 불러와 주세요.');
    used.add(im.id);
    return original.html;
  });
  if (!blocks.length) return next.join('') + html;
  let out = '', cursor = 0;
  blocks.forEach((block, i) => {
    if (block.start < cursor) throw new Error('중첩된 상세이미지 구조를 안전하게 수정할 수 없습니다.');
    out += html.slice(cursor, block.start) + (next[i] || '');
    if (i === blocks.length - 1) out += next.slice(blocks.length).join('');
    cursor = block.end;
  });
  return out + html.slice(cursor);
}

function combinationGroups(oi) {
  const names = oi.optionCombinationGroupNames || {};
  return [1, 2, 3, 4].map(i => names[`optionGroupName${i}`] || '').filter(Boolean);
}

export function naverEditProduct(body, originNo, inputNo = originNo) {
  const p = body?.originProduct;
  if (!p || typeof p !== 'object') throw new Error('네이버 원상품 응답 형식을 확인할 수 없습니다.');
  if (typeof p.detailContent !== 'string') throw new Error('네이버 상세설명 응답이 HTML 형식이 아닙니다.');
  const oi = p.detailAttribute?.optionInfo || {};
  const groups = combinationGroups(oi);
  const options = (oi.optionCombinations || []).map((o, index) => ({
    index, id: o.id ?? null, isNew: false,
    names: Array.from({ length: groups.length }, (_, i) => o[`optionName${i + 1}`] ?? ''),
    stockQuantity: o.stockQuantity ?? 0, price: o.price ?? 0, usable: o.usable !== false
  }));
  return {
    inputNo: String(inputNo), originNo: String(originNo), title: p.name || '',
    statusType: p.statusType || '', salePrice: p.salePrice ?? 0, groups, options,
    detailImages: extractNaverDetailImages(p.detailContent), revision: revisionOf(body),
    optionNotice: (oi.optionSimple?.length || oi.optionStandards?.length)
      ? '단독형·표준형 옵션은 현재 값을 유지합니다. 이 화면에서는 조합형 옵션을 편집할 수 있습니다.' : ''
  };
}

export function buildNaverProductUpdate(body, data) {
  const next = clone(body);
  const p = next.originProduct;
  if (!p) throw new Error('네이버 원상품 응답 형식이 올바르지 않습니다.');
  if (data.title !== undefined) {
    const title = String(data.title).trim();
    if (!title) throw new Error('상품명을 입력해주세요.');
    p.name = title;
  }
  if (data.salePrice !== undefined) {
    p.salePrice = integer(data.salePrice, '판매가');
    if (p.salePrice <= 0) throw new Error('판매가는 0보다 커야 합니다.');
  }
  if (data.options !== undefined) {
    if (!Array.isArray(data.options)) throw new Error('옵션 목록이 올바르지 않습니다.');
    const oi = p.detailAttribute?.optionInfo || {};
    const current = oi.optionCombinations || [];
    const groups = combinationGroups(oi);
    if (current.length && !data.options.length) throw new Error('조합형 옵션을 모두 삭제할 수 없습니다.');
    if (data.options.length) {
      if (!groups.length || oi.optionSimple?.length || oi.optionStandards?.length) throw new Error('이 상품의 옵션 형식은 조합형 옵션 편집을 지원하지 않습니다.');
      const ids = new Set(), names = new Set();
      oi.optionCombinations = data.options.map(o => {
        if (!Array.isArray(o.names) || o.names.length !== groups.length || o.names.some(n => !String(n).trim())) throw new Error('옵션 그룹별 값을 모두 입력해주세요.');
        const signature = JSON.stringify(o.names.map(n => String(n).trim()));
        if (names.has(signature)) throw new Error('동일한 조합의 옵션이 중복되었습니다.');
        names.add(signature);
        let option = {};
        if (!o.isNew) {
          const existing = current.find(c => c.id != null && String(c.id) === String(o.id));
          if (!existing || ids.has(String(o.id))) throw new Error('기존 옵션을 확인할 수 없습니다. 상품을 다시 불러와 주세요.');
          ids.add(String(o.id));
          option = clone(existing);
        }
        o.names.forEach((name, i) => { option[`optionName${i + 1}`] = String(name).trim(); });
        option.price = integer(o.price, '옵션가', { negative: true });
        option.stockQuantity = integer(o.stockQuantity, '옵션 재고');
        option.usable = o.usable !== false;
        return option;
      });
      if (oi.useStockManagement) p.stockQuantity = oi.optionCombinations.reduce((sum, o) => sum + o.stockQuantity, 0);
    }
  }
  if (data.detailImages !== undefined) p.detailContent = replaceNaverDetailImages(p.detailContent, data.detailImages);
  return next;
}

// ── 신규 복사등록 ────────────────────────────────────────────────
// 판매자센터 '복사등록' 화면에서 하던 일을 원상품 본문으로 옮겼다(옛 naver_smartstore.js — 2026-10-28 삭제).
// 상품명·판매가·재고·옵션·상세설명·대표이미지만 바꾸고 배송·반품·고시정보·원산지는 템플릿 값을 쓴다.
const splitValues = text => [...new Set(String(text ?? '').split(',').map(s => s.trim()).filter(Boolean))];
const OPTION_LABELS = ['모델명', '상품선택', '운전석/조수석'];
const PASSENGER_SEAT_PRICE = -10000;   // 자동차 조수석 옵션가 — 판매자센터에서 넣던 값 그대로

/** 상세설명에 ESM 이미지를 넣는다. 첫 이미지를 지우고 자동차는 그 자리, 오토바이는 맨 위에 넣는다. 전체 교체도 지원한다. */
export function insertNaverDetail(html, insert, { category = '', replaceAll = false } = {}) {
  const piece = String(insert ?? '').trim();
  if (!piece) return html;
  if (replaceAll) return piece;
  const tag = /<img/i.test(piece) ? piece : `<img src="${escapeAttr(piece)}" />`;
  const [first] = imageBlocks(html);
  if (!first) return tag + html;
  const rest = html.slice(0, first.start) + html.slice(first.end);
  return /오토바이|바이크/.test(category) ? tag + rest : html.slice(0, first.start) + tag + html.slice(first.end);
}

function copyOptions(oi, data, stock) {
  const groups = combinationGroups(oi);
  if (!groups.length || oi.optionSimple?.length || oi.optionStandards?.length) {
    throw new Error('템플릿 상품에 조합형 옵션이 없어 옵션을 바꿀 수 없습니다. 템플릿 번호를 확인해주세요.');
  }
  const typed = [data.optionModel, data.optionProduct, data.optionSeat].map(splitValues);
  typed.forEach((values, i) => {
    if (values.length && i >= groups.length) throw new Error(`템플릿 옵션 그룹이 ${groups.length}개라 "${OPTION_LABELS[i]}" 값을 넣을 수 없습니다.`);
  });
  // 비운 칸은 템플릿 값을 유지한다(판매자센터에서 입력칸을 건드리지 않던 것과 같다).
  const values = groups.map((_, i) => typed[i]?.length ? typed[i]
    : [...new Set((oi.optionCombinations || []).map(o => o[`optionName${i + 1}`]).filter(Boolean))]);
  let combos = [[]];
  for (const list of values) combos = combos.flatMap(c => list.map(v => [...c, v]));
  if (!combos.length) throw new Error('옵션 값이 비어 있습니다.');
  const car = data.category === '자동차';
  oi.optionCombinations = combos.map(names => ({
    ...Object.fromEntries(names.map((name, i) => [`optionName${i + 1}`, name])),
    stockQuantity: stock,
    price: car && names.some(n => n.includes('조수석')) ? PASSENGER_SEAT_PRICE : 0,
    usable: true
  }));
}

/** 템플릿 원상품 응답 → 새 상품 등록 본문. 네트워크 없이 검사할 수 있게 순수 함수로 둔다. */
export function buildNaverCopyProduct(template, data) {
  const next = clone(template);
  const p = next.originProduct;
  if (!p || typeof p.detailContent !== 'string') throw new Error('네이버 템플릿 원상품 응답 형식을 확인할 수 없습니다.');
  const title = String(data.title ?? '').trim();
  if (!title) throw new Error('상품명을 입력해주세요.');
  // 옵션을 못 바꾸면 템플릿(다른 차종) 옵션이 붙은 상품이 생긴다 → 모델명 없이는 등록하지 않는다.
  if (!splitValues(data.optionModel).length) throw new Error('옵션 > 모델명을 입력해주세요.');
  p.name = title;
  if (String(data.price ?? '').trim()) {
    p.salePrice = integer(data.price, '판매가');
    if (p.salePrice <= 0) throw new Error('판매가는 0보다 커야 합니다.');
  }
  const stock = integer(String(data.stock ?? '').trim() || '999', '재고');
  p.statusType = 'SALE';
  const oi = p.detailAttribute?.optionInfo || {};
  copyOptions(oi, data, stock);
  p.stockQuantity = oi.useStockManagement ? oi.optionCombinations.reduce((sum, o) => sum + o.stockQuantity, 0) : stock;
  const detail = [data.esmHtml, data.detailHtml].filter(Boolean).join('\n');
  p.detailContent = insertNaverDetail(p.detailContent, detail, { category: data.category, replaceAll: !!data.detailHtml });
  // 조회 응답에만 있는 필드(등록 명세에 없음)와 템플릿의 카탈로그 연결을 뺀다 — 남기면 새 상품이 템플릿 모델로 묶인다.
  delete next.groupProduct;
  delete next.windowChannelProduct;
  delete p.customerBenefit?.promotionDiscountPolicies;
  const search = p.detailAttribute?.naverShoppingSearchInfo;
  if (search) { delete search.catalogMatchingYn; delete search.matchedCatalogId; delete search.modelId; }
  const channel = next.smartstoreChannelProduct;
  if (!channel) throw new Error('네이버 템플릿 응답에 스마트스토어 채널 정보가 없습니다.');
  delete channel.channelProductName;   // 남기면 원상품명보다 먼저 노출된다
  channel.channelProductDisplayStatusType = 'ON';
  return next;
}

// 업로드 파트의 Content-Type 은 확장자가 아니라 실제 형식이어야 한다(커머스API: JPG·GIF·PNG·BMP 만).
function imageType(bytes) {
  const hex = bytes.subarray(0, 4).toString('hex');
  if (hex.startsWith('ffd8ff')) return 'image/jpeg';
  if (hex === '89504e47') return 'image/png';
  if (hex.startsWith('474946')) return 'image/gif';
  if (hex.startsWith('424d')) return 'image/bmp';
  return '';
}

/** Browser-free product registration and editing; all credentials and transport stay in NaverAPI. */
export class NaverProducts {
  constructor(api) { this.api = api; this.busy = false; }

  // 원상품번호 또는 채널상품번호 → { originNo, body }
  async _origin(no) {
    try { return { originNo: no, body: await this.api.originProduct(no) }; }
    catch (error) {
      // An auth, proxy or network error is never evidence of a channel number.
      if (error.status !== 404 || error.proxyError) throw error;
      const found = await this.api.searchProducts({ searchKeywordType: 'CHANNEL_PRODUCT_NO', channelProductNos: [Number(no)], page: 1, size: 100 });
      const match = (found?.contents || []).find(row => (row.channelProducts || []).some(c => String(c.channelProductNo) === no));
      if (!match?.originProductNo) throw new Error(`상품번호 ${no}에 해당하는 원상품 또는 채널상품을 찾을 수 없습니다.`);
      const originNo = productNo(match.originProductNo);
      return { originNo, body: await this.api.originProduct(originNo) };
    }
  }

  async loadProductForEdit(inputNo) {
    const no = productNo(inputNo);
    const { originNo, body } = await this._origin(no);
    return naverEditProduct(body, originNo, no);
  }

  /** 상품 이미지 업로드 → 네이버 이미지 서버 주소. 상품 본문의 대표이미지는 이 주소만 받는다. */
  async uploadImage(file) {
    let bytes;
    try { bytes = await fs.promises.readFile(file); }
    catch { throw new Error('네이버 대표 이미지 파일을 찾을 수 없습니다.'); }
    const type = imageType(bytes);
    if (!type) throw new Error(`네이버는 JPG·PNG·GIF·BMP 이미지만 받습니다: ${path.basename(file)}`);
    if (bytes.length >= 10_000_000) throw new Error('네이버 이미지 업로드는 10MB 미만이어야 합니다.');
    const form = new FormData();
    form.append('imageFiles', new Blob([bytes], { type }), path.basename(file));
    const result = await this.api.request('POST', '/v1/product-images/upload', form);
    const url = result?.images?.[0]?.url;
    if (!url) throw new Error('네이버 이미지 업로드 응답에 주소가 없습니다. 상품은 등록하지 않았습니다.');
    return url;
  }

  /**
   * 신규 복사등록: 템플릿 원상품 조회 → 본문 수정 → 새 상품 등록. 브라우저를 쓰지 않는다.
   * @returns {Promise<string>} 스마트스토어 상품 주소 (duplicate_guard.recordNaver 가 채널상품번호를 읽는다)
   */
  async copyRegister(data) {
    if (this.busy) throw new Error('네이버 상품 저장이 진행 중입니다. 완료 후 다시 시도해주세요.');
    const templateNo = productNo(data?.templateId);
    this.busy = true;
    try {
      const { body } = await this._origin(templateNo);
      const product = buildNaverCopyProduct(body, data);   // 입력 오류는 이미지 업로드 전에 걸러진다
      if (data.mainImagePath) product.originProduct.images = { ...product.originProduct.images, representativeImage: { url: await this.uploadImage(data.mainImagePath) } };
      const created = await this.api.request('POST', '/v2/products', product);
      this.api.invalidateProducts();
      const channelNo = created?.smartstoreChannelProductNo;
      if (!channelNo) {
        throw new Error(`등록 응답에 스마트스토어 채널상품번호가 없습니다 (원상품 ${created?.originProductNo ?? '?'}). 다시 등록하지 말고 판매자센터에서 확인해주세요.`);
      }
      return `https://smartstore.naver.com/main/products/${channelNo}`;
    } finally { this.busy = false; }
  }

  /**
   * 기본 판매가만 바꾼다(일괄 수정용). 조회 → 기대 가격 비교 → 원상품 PUT 까지만 하고 검증은 호출하는
   * 쪽(bulk_price_ipc)이 판매가만으로 한 번 한다. updateProduct 의 엄격 검증(재고·상세이미지 비교)은
   * 주문으로 재고가 바뀌기만 해도 '실패'로 보고해서 일괄 수정에는 맞지 않는다.
   * 네이버에는 절대 판매가를 지정하는 부분 수정 API 가 없어(bulk-update 는 상대 증감만) 원상품 전체를 다시 보낸다.
   * @returns {{ originNo, unchanged: boolean, salePrice: number }}
   */
  async updateSalePrice({ originNo: inputNo, salePrice, expectedPrice }) {
    if (this.busy) throw markPreSend(new Error('네이버 상품 저장이 진행 중입니다. 완료 후 다시 시도해주세요.'));
    let originNo, price;
    try { originNo = productNo(inputNo); price = integer(salePrice, '판매가'); }
    catch (e) { throw markPreSend(e); }
    if (price <= 0) throw markPreSend(new Error('판매가는 0보다 커야 합니다.'));
    this.busy = true;
    try {
      let current;
      try { current = await this.api.originProduct(originNo); }
      catch (e) { throw markPreSend(e); }
      const now = current?.originProduct?.salePrice;
      if (now == null) throw markPreSend(new Error('네이버 원상품 응답에 판매가가 없습니다.'));
      if (expectedPrice !== undefined && Number(now) !== Number(expectedPrice)) {
        throw markPreSend(new Error(`현재 판매가(${now})가 조회 이후 변경됐습니다. 다시 불러온 뒤 수정하세요.`));
      }
      if (Number(now) === price) return { originNo, unchanged: true, salePrice: Number(now) };
      const body = buildNaverProductUpdate(current, { salePrice: price });
      await this.api.request('PUT', `/v2/products/origin-products/${originNo}`, body);
      this.api.invalidateProducts();
      return { originNo, unchanged: false, salePrice: price };
    } finally { this.busy = false; }
  }

  async updateProduct(data) {
    if (this.busy) throw new Error('네이버 상품 저장이 진행 중입니다. 완료 후 다시 시도해주세요.');
    const originNo = productNo(data?.originNo);
    this.busy = true;
    try {
      const current = await this.api.originProduct(originNo);
      if (data.revision && data.revision !== revisionOf(current)) throw new Error('상품이 다른 곳에서 변경됐습니다. 다시 불러온 뒤 수정해주세요.');
      const body = buildNaverProductUpdate(current, data);
      await this.api.request('PUT', `/v2/products/origin-products/${originNo}`, body);
      this.api.invalidateProducts();
      let after;
      try { after = await this.api.originProduct(originNo); }
      catch { throw new Error('수정 요청은 성공했지만 반영 결과를 조회하지 못했습니다. 다시 저장하지 말고 상품을 불러와 확인해주세요.'); }
      const product = naverEditProduct(after, originNo);
      const expected = naverEditProduct(body, originNo);
      const optionsMatch = (a, b) => JSON.stringify(a.map(({ names, price, stockQuantity, usable }) => ({ names, price, stockQuantity, usable })))
        === JSON.stringify(b.map(({ names, price, stockQuantity, usable }) => ({ names, price, stockQuantity, usable })));
      if (product.salePrice !== expected.salePrice || product.title !== expected.title || !optionsMatch(product.options, expected.options)
          || JSON.stringify(product.detailImages.map(x => x.url)) !== JSON.stringify(expected.detailImages.map(x => x.url))) {
        throw new Error('수정 요청은 성공했지만 조회 결과가 요청과 다릅니다. 상품을 다시 불러와 확인해주세요.');
      }
      return { originNo, product, verified: `옵션 ${product.options.length}개, 상세이미지 ${product.detailImages.length}장` };
    } finally { this.busy = false; }
  }
}
