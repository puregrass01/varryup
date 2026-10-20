// 아임웹 B2B몰(블랙스토어B2B · bbstore37.imweb.me) 상품 조회 · 등록 · 수정 — 아임웹 Open API(OAuth).
//
// 예전에는 세 가지를 섞어 썼다: 관리자 화면을 열어 가로챈 토큰으로 부르는 내부 API(조회 · 수정 · 가격 상속),
// v2 API(생성 · 카테고리), 화면 클릭(백업). 2026-10-05 전부 이 모듈로 바꿨다 — 브라우저도 로그인도 쓰지 않는다.
//
// 문서(openapi.json)와 실측(2026-10-05)으로 확인한 것
//   - 사이트 S202101070709acd6138de, 구역(unit) 하나(KRW), 상품 2,473개.
//     템플릿: 일반(BSA X) 세트 712 · 개별 803, BSA 세트 1290 · 개별 1291.
//   - 그룹가격: 조회 응답 periodDiscount.target = { 아이디: { groupType, groupCode, dcAmount, dcType } }.
//     쓰기는 등록 본문 productDiscountInfo[].periodOptionData.targetGroups[{ discountAmount, discountType }].
//   - 조합가격: 옵션 상세(option-details)의 price 가 그 조합의 최종가(712: BSA X 150,000 · BSA O 170,000).
//   - 등록 · 상세 수정은 multipart(중첩 필드는 a[b][0][c] 표기). 등록에는 이미지 파일이 꼭 있어야 한다.
//
// Open API 로 할 수 없는 것(예전 내부 API 는 됐다)
//   - 옵션 값 추가 · 삭제: 옵션 수정은 기존 값의 '이름'만 바꾼다. 값이 줄면 빠진 값이 든 조합을 숨기고(HIDDEN),
//     늘어야 하면 그 대상을 실패로 알린다 — 관리자에서 값을 추가한 뒤 다시 실행하면 된다.
//   - 상단/하단 공통 코드 · 외부 채널 노출 상태는 조회 응답에 없어 확인할 수 없다(설정만 한다).
import fs from 'node:fs/promises';
import path from 'node:path';
import { buildContentFromTemplate, yearValues, extractImageUrl } from './build_payload.js';
import { buildCategories, categoriesFileFromTree } from './categories.js';
import { toFormData } from './imweb_client.js';

export const B2B_SITE_CODE = 'S202101070709acd6138de';
const LIST_TTL_MS = 5 * 60 * 1000;

// 개별(운전석/조수석) · 세트(1셋) × 일반 · BSA. 가격과 템플릿은 예전 등록과 같다.
export const B2B_PLAN = {
  indiv: { label: '개별', suffix: '운전석/조수석', price: { bsa: 115000, plain: 80000 }, template: { bsa: '1291', plain: '803' } },
  set: { label: '세트', suffix: '1셋', price: { bsa: 220000, plain: 150000 }, template: { bsa: '1290', plain: '712' } },
};

/** bsaO · bsaX 가 오면 그것으로 BSA 여부를 정한다(예전과 같은 판정). data.hasBsa 도 맞춰 둔다. */
export function resolveBsa(data) {
  if (data.bsaO !== undefined || data.bsaX !== undefined) data.hasBsa = !data.bsaX && !!data.bsaO;
  return !!data.hasBsa;
}
export const b2bTitle = (data, type) => `옵틱글래스 ${data.titleBrand} ${data.titleModel} 미러 ${B2B_PLAN[type].suffix} [${data.code}]`;
export function planOf(data, type) {
  const k = resolveBsa(data) ? 'bsa' : 'plain';
  return { price: B2B_PLAN[type].price[k], templateNo: B2B_PLAN[type].template[k] };
}

// ── 순수 함수 ─────────────────────────────────────────────────────────────

/** 상품명·제목에 상품번호가 있는지. 대소문자는 가리지 않는다(예전 소문자 '[No.h131]'도 찾아야 한다). */
export const titleHasCode = (text, code) => String(text || '').toUpperCase().includes(String(code || '').toUpperCase());
/** 세트와 개별은 "미러" 앞부분이 같다: '옵틱글래스 인피니티 G25 미러 1셋 [612]' → '옵틱글래스 인피니티 G25' */
export const baseKeyOf = name => String(name || '').split(/\s*미러\s*(?:1셋|운전석\/조수석)/)[0].trim();
export const suffixOf = name => { const n = String(name || '').trim(); return n.slice(baseKeyOf(n).length).trim(); };
export const typeOf = name => String(name).includes('1셋') ? 'set' : (String(name).includes('운전석/조수석') ? 'indiv' : 'etc');

/** 조합 표시문구 → 'BSA 표시|구성' 키. 템플릿 · 기존 조합의 가격을 같은 마크 · 구성끼리 맞추는 데 쓴다. */
export function comboKey(text) {
  const s = String(text || '');
  const mark = /BSA\s*O/i.test(s) ? 'O' : (/BSA\s*X/i.test(s) ? 'X' : '');
  const seat = s.includes('운전석만') ? '운전석만' : (s.includes('조수석만') ? '조수석만' : '');
  return `${mark}|${seat}`;
}
const bsaMark = s => (/BSA\s*O/i.test(s) ? 'O' : (/BSA\s*X/i.test(s) ? 'X' : ''));
export const optionTextOf = d => (d?.optionDetailInfoList || []).map(i => String(i?.optionValue?.optionValueName ?? '')).join(' / ');

export function extractDetailImages(html) {
  if (!html) return [];
  return [...String(html).matchAll(/<img[^>]*src=["']([^"']+)["'][^>]*>/gi)].map(m => m[1]);
}

/**
 * 상세설명 HTML 의 이미지만 새 목록으로 바꾼다. 텍스트 · 레이아웃은 두고 기존 <img> 를 순서대로 치환하며,
 * 목록이 길면 마지막 자리에 이어 넣고 짧으면 남는 <img> 만 뺀다(태그 속성 · 클래스는 그대로 물려받는다).
 */
export function replaceDetailImages(html, images) {
  const src = String(html || '');
  const tags = [...src.matchAll(/<img[^>]*src=["']([^"']+)["'][^>]*>/gi)];
  const list = images || [];
  if (!tags.length) return src + list.map(u => `<p style="text-align: center;"><img src="${u}" class="fr-fic fr-dii"></p>`).join('');
  const swapSrc = (tag, url) => tag.replace(/src=["'][^"']+["']/i, `src="${url}"`);
  const n = Math.min(tags.length, list.length);
  let out = '', cursor = 0;
  for (let i = 0; i < n; i++) {
    const t = tags[i];
    out += src.slice(cursor, t.index);
    out += (i === n - 1 && list.length > tags.length) ? list.slice(i).map(u => swapSrc(t[0], u)).join('') : swapSrc(t[0], list[i]);
    cursor = t.index + t[0].length;
  }
  for (let i = n; i < tags.length; i++) { out += src.slice(cursor, tags[i].index); cursor = tags[i].index + tags[i][0].length; }
  return out + src.slice(cursor);
}

const SPEC_START = '<!--2. 조견표 영역-->';
const SPEC_END = '<!--3. 상세페이지 영역-->';
/** 상세설명의 조견표 영역만 바꾼다. 표시가 없으면 null(건드리지 않는다). */
export function replaceSpecBlock(html, { specUrl, titleBrand, titleModel }) {
  const s = String(html || ''), a = s.indexOf(SPEC_START), b = s.indexOf(SPEC_END);
  if (a === -1 || b === -1 || b <= a) return null;
  const block = `${SPEC_START}<p><br></p><p style="text-align: center;"><span style="font-size: 36px;">` +
    `<strong>※${titleBrand} ${titleModel} 조견표※</strong></span></p><p><img src="${specUrl}" class="fr-fic fr-dib"></p>`;
  return s.slice(0, a) + block + s.slice(b);
}

/** 템플릿 조회 응답의 periodDiscount → 쓰기 형식 targetGroups. target 은 객체(아이디 → 그룹)로 온다. */
export function templateGroups(periodDiscount) {
  const target = periodDiscount?.target;
  const list = Array.isArray(target) ? target : Object.values(target || {});
  return list.filter(g => g && g.groupType && Number.isFinite(Number(g.dcAmount)) && g.dcType).map(g => ({
    groupType: g.groupType,
    ...(g.groupCode ? { groupCode: g.groupCode } : {}),
    discountAmount: Number(g.dcAmount),
    discountType: g.dcType,
  }));
}

/** 템플릿의 할인 설정(쿠폰 · 적립금 · 쇼핑등급 · 그룹가격)을 등록 본문 한 줄로. */
export function discountInfoFrom(template, unitCode) {
  const flags = template?.discountOptions || {};
  const yn = v => (v === 'Y' || v === true ? 'Y' : 'N');
  const groups = templateGroups(template?.periodDiscount);
  const pd = template?.periodDiscount || {};
  const info = {
    unitCode,
    coupon: yn(flags.coupon), point: yn(flags.point), shoppingGroup: yn(flags.shopping_group_dc),
    givePointType: template?.givePointType === 'individual' ? 'individual' : 'common',
    period: groups.length ? 'Y' : 'N',
  };
  if (info.givePointType === 'individual') {
    info.pointCriteria = { givePointValueType: template.givePointValueType || 'percent', givePointValue: Number(template.givePointValue) || 0 };
  }
  if (groups.length) {
    info.periodOptionData = { targetGroups: groups, usePeriod: pd.usePeriod ? 'Y' : 'N' };
    if (pd.usePeriod) Object.assign(info.periodOptionData, { startTime: pd.startTime, endTime: pd.endTime });
  }
  return info;
}

/** 등록 본문(POST /products). 상태는 숨김(nosale)으로 만들고, 설정을 다 넣은 뒤 판매중으로 바꾼다. */
export function buildCreateBody({ data, type, unitCode, title, price, content, categories, template }) {
  const option = (name, values) => ({
    type: 'default', isRequire: 'Y',
    optionData: [{ unitCode, name, valueList: values.map(valueName => ({ valueName })) }],
  });
  const optionList = [option('차종', [data.titleModel || data.model]), option('연식', yearValues(data))];
  if (type === 'indiv') optionList.push(option('구성', ['운전석만', '조수석만']));
  return {
    productBaseInfo: {
      status: 'nosale', productType: 'normal',
      unitShopProductInfo: [{
        unitCode, productName: title, description: content,
        commonHeaderSettingType: 'default', commonFooterSettingType: 'default',
      }],
      // 재고 필드(stock · isUseStock · isUnlimitedStock)는 보내지 않는다 — 옵션이 있는 상품은 본상품 재고 기능을
      // 쓸 수 없다며 30038 로 거부된다(2026-10-05 실서버). 재고는 조합(옵션 상세) 단위다.
    },
    productClassificationInfo: { categories },
    productPriceInfo: [{ unitCode, price, originalPrice: 0, isPriceTaxIncluded: 'Y' }],
    productDiscountInfo: [discountInfoFrom(template, unitCode)],
    productOptionInfo: { optionMixType: 'MIX', optionList },
  };
}

/**
 * 옵션 값 맞추기 계획. 같은 이름은 그대로, 남은 것끼리는 BSA 표시(X/O)가 같은 것끼리 먼저, 그다음 순서대로 짝지어
 * 이름을 바꾼다. 짝이 없는 기존 값은 숨기고(hide), 짝이 없는 새 값은 추가할 수 없다(add — Open API 불가).
 */
export function planOptionValues(oldValues, wantNames) {
  const old = oldValues.map(v => ({ ...v }));
  const want = [...new Set(wantNames.map(n => String(n).trim()).filter(Boolean))];
  const keep = old.filter(v => want.includes(v.valueName));
  let restOld = old.filter(v => !keep.includes(v));
  let restWant = want.filter(n => !keep.some(v => v.valueName === n));
  const renames = [];
  for (const pass of [true, false]) {
    for (const name of [...restWant]) {
      const i = restOld.findIndex(v => !pass || bsaMark(v.valueName) === bsaMark(name));
      if (i === -1) continue;
      renames.push({ valueCode: restOld[i].valueCode, from: restOld[i].valueName, to: name });
      restOld = restOld.filter((_, j) => j !== i);
      restWant = restWant.filter(n => n !== name);
    }
  }
  return { renames, hide: restOld, add: restWant };
}

const mimeOf = name => {
  const ext = String(name).toLowerCase().split('?')[0].split('.').pop();
  return { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' }[ext] || 'image/jpeg';
};
// 만들어졌는지 모르는 실패 — 다시 만들면 중복이 되므로 먼저 찾아본다.
const isAmbiguous = e => e?.name === 'TimeoutError' || e?.name === 'AbortError' || (Number(e?.status) >= 500);

// ── Open API 연결 ─────────────────────────────────────────────────────────

/**
 * client = createImwebClient(B2B 사이트 세션). log 는 진행 로그(화면의 아임웹 로그로 간다).
 * 결과 모양은 예전 ImwebEdit 의 같은 이름 메서드와 같다 — 화면 · 중복 검사 · 원장이 그대로 쓴다.
 */
export function createB2bApi(client, {
  log = () => {}, sleep = ms => new Promise(r => setTimeout(r, ms)), fetchImpl = fetch,
  readFile = fs.readFile, fileExists = async p => { try { await fs.access(p); return true; } catch { return false; } },
  now = Date.now,
} = {}) {
  let unitCode = null, rowsCache = null, treeCache = null;

  async function unit() {
    if (unitCode) return unitCode;
    const info = await client.siteInfo();
    const u = (info?.unitList || []).find(x => String(x.currency).toUpperCase() === 'KRW') || info?.unitList?.[0];
    if (!u?.unitCode) throw new Error('B2B몰 사이트 정보에서 구역(unit)을 찾지 못했습니다.');
    unitCode = u.unitCode;
    return unitCode;
  }

  // ── 조회 ──
  const rowOf = p => {
    const name = String(p.name || '').trim();
    return { prodNo: Number(p.prodNo), name, baseKey: baseKeyOf(name), price: Math.round(Number(p.price) || 0), status: p.prodStatus || '', type: typeOf(name) };
  };
  /** B2B 상품 전체(2,473개 · 25번 호출). 5분 동안 다시 쓰고, 상품을 만들거나 이름을 바꾸면 버린다. */
  async function allRows({ fresh = false } = {}) {
    if (!fresh && rowsCache && now() - rowsCache.at < LIST_TTL_MS) return rowsCache.rows;
    const rows = (await client.products(await unit())).map(rowOf).filter(r => r.prodNo && r.name);
    rowsCache = { at: now(), rows };
    return rows;
  }
  const invalidateRows = () => { rowsCache = null; };
  /**
   * 예전 관리자 검색처럼 '단어 AND' — 모든 단어가 상품명에 들어 있는 것(대소문자 무시).
   * limit 를 주면 예전 검색(첫 쪽 50건)처럼 그만큼만 돌려준다 — '옵틱글래스 광각미러 …' 계열은 공통명이
   * '옵틱글래스 광각'으로 잘려 수백 건이 한 묶음이 되므로, 상품수정 탭 검색은 상한을 둔다.
   */
  async function searchRows(keyword, { limit, ...opts } = {}) {
    const words = String(keyword || '').toUpperCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    const hits = (await allRows(opts)).filter(r => { const n = r.name.toUpperCase(); return words.every(w => n.includes(w)); });
    return limit ? hits.slice(0, limit) : hits;
  }
  /** 중복 검사용: 상품번호가 이름에 든 B2B 상품. 전체를 읽으므로 잘리지 않는다(complete 는 늘 true). */
  async function listB2bRowsByCode(code) {
    const c = String(code || '').trim();
    if (!c) return { rows: [], complete: true };
    return { rows: (await allRows({ fresh: true })).filter(r => titleHasCode(r.name, c)), complete: true };
  }

  async function optionGroups(prodNo) {
    const u = await unit();
    const res = await client.request('GET', `/products/${encodeURIComponent(prodNo)}/options`, { query: { unitCode: u, page: 1, limit: 100 } });
    const list = res?.data?.list ?? res?.data ?? [];
    return (Array.isArray(list) ? list : []).map(o => ({
      optionCode: o.optionCode, name: String(o.name || '').trim(),
      values: (o.optionValueList || []).map(v => ({ valueCode: v.optionValueCode, valueName: v.optionValueName })),
    }));
  }
  /** '연식' 옵션 값 목록 — 가격으로 판(BSA/일반)을 못 가를 때 중복 검사가 쓴다. */
  async function b2bOptionValuesOf(prodNo) {
    const year = (await optionGroups(prodNo)).find(g => g.name === '연식');
    return year ? year.values.map(v => v.valueName) : [];
  }

  async function loadProduct(prodNo) {
    const u = await unit();
    const p = await client.product(prodNo, u);
    if (!p) throw new Error(`상품 ${prodNo} 을 찾지 못했습니다.`);
    const groups = await optionGroups(prodNo);
    const details = await client.optionDetails(prodNo, u);
    const content = String(p.content || '');
    const combos = details.map(d => ({
      optionDetailCode: d.optionDetailCode, displayText: optionTextOf(d),
      price: Number(d.price) || 0, stock: Number(d.stock) || 0, status: d.status || 'SALE',
    }));
    return {
      prodNo: Number(prodNo), title: String(p.name || ''), price: Number(p.price) || 0, unitCode: u,
      optionGroups: groups, combos, detailImages: extractDetailImages(content), content,
      categories: p.categories || [], images: p.productImages || [], status: p.prodStatus || '',
      stockUse: p.stockUse || '',   // 'Y' 일 때만 조합 재고를 바꿀 수 있다(아니면 30157)
      periodDiscount: p.periodDiscount || null,
    };
  }

  /** 상품 번호로 브랜드 · 차종 · 코드를 뽑는다(상품명 '옵틱글래스 브랜드 차종 … 미러 1셋 [코드]'). */
  async function extractProductInfo(idx) {
    const p = await client.product(idx, await unit());
    const rawTitle = String(p?.name || '').trim();
    if (!rawTitle) throw new Error(`상품 ${idx} 을 찾지 못했습니다.`);
    const title = rawTitle.replace(/\s*(?:1셋|운전석\/조수석)\s*(?:\[\w+\])?\s*$/, '').trim();
    const code = (rawTitle.match(/\[([^\]]+)\]$/) || [])[1] || '';
    const words = title.replace(/^옵틱글래스\s+/, '').split(/\s+/);
    return { brand: words[0] || '', model: words[1] || '', code, title };
  }

  // ── 카테고리 ──
  async function categoryTree({ fresh = false } = {}) {
    if (treeCache && !fresh) return treeCache;
    const res = await client.request('GET', '/products/shop-categories', { query: { unitCode: await unit() } });
    treeCache = Array.isArray(res?.data) ? res.data : [];
    return treeCache;
  }
  /** 화면의 브랜드/차종 목록 파일을 B2B몰 카테고리로 새로 만든다(예전엔 관리자 화면을 열어 응답을 가로챘다). */
  async function syncCategories(filePath) {
    const formatted = categoriesFileFromTree(await categoryTree({ fresh: true }));
    const d = Object.keys(formatted['국산차']).length, f = Object.keys(formatted['수입차']).length;
    if (!d && !f) throw new Error('B2B몰 카테고리에서 국산차/수입차를 찾지 못했습니다.');
    if (filePath) await fs.writeFile(filePath, JSON.stringify(formatted, null, 2), 'utf-8');
    log(`[카테고리 동기화] ✓ 국산차 ${d}개 / 수입차 ${f}개 제조사 저장됨 (Open API).`);
    return formatted;
  }

  // ── 쓰기 도우미 ──
  const patchDetail = async (prodNo, fields) =>
    client.request('PATCH', `/products/${encodeURIComponent(prodNo)}`, { form: toFormData({ unitCode: await unit(), ...fields }) });
  const setPrice = async (prodNo, price) => client.setPrice(prodNo, await unit(), price);
  const setStatus = (prodNo, status) => client.request('PATCH', `/products/${encodeURIComponent(prodNo)}/status`, { body: { status } });
  const patchOptionDetail = async (prodNo, code, body) =>
    client.request('PATCH', `/products/${encodeURIComponent(prodNo)}/option-details/${encodeURIComponent(code)}`, { body: { unitCode: await unit(), ...body } });

  /** 대표 이미지 파일. 로컬 파일 → 주소 → 템플릿 이미지 순으로 고른다(등록에는 이미지 파일이 꼭 있어야 한다). */
  async function imageFile(data, fallbackUrl) {
    if (data.mainImagePath && await fileExists(data.mainImagePath)) {
      const buf = await readFile(data.mainImagePath);
      return { blob: new Blob([buf], { type: mimeOf(data.mainImagePath) }), name: path.basename(data.mainImagePath), from: '로컬 파일' };
    }
    const url = extractImageUrl(data.mainImageUrl) || fallbackUrl;
    if (!url) throw new Error('대표 이미지가 없습니다(이미지 주소 · 파일 · 템플릿 이미지 모두 없음).');
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`대표 이미지를 내려받지 못했습니다 (HTTP ${res.status}): ${url}`);
    const type = (res.headers.get('content-type') || '').split(';')[0].trim() || mimeOf(url);
    if (!/^image\//i.test(type)) throw new Error(`대표 이미지 주소가 이미지가 아닙니다 (${type}): ${url}`);
    let name = 'image.jpg';
    try { name = decodeURIComponent(path.basename(new URL(url).pathname)) || name; } catch { /* 기본 이름 */ }
    return { blob: new Blob([Buffer.from(await res.arrayBuffer())], { type }), name, from: url === fallbackUrl ? '템플릿 이미지' : '이미지 주소' };
  }

  /** 대표 이미지 교체: 올린 뒤 그 이미지만 남긴다(예전 v2 의 images: [주소] 와 같은 결과). */
  async function replaceMainImage(prodNo, data) {
    const before = [...((await client.product(prodNo, await unit()))?.productImages || [])];   // 복사해 둔다 — 비교 기준이다
    const file = await imageFile(data, '');
    const form = toFormData({}, [{ field: 'images', blob: file.blob, name: file.name }]);
    const up = (await client.request('POST', `/products/${encodeURIComponent(prodNo)}/images`, { form }))?.data;
    if (up?.fail?.length) throw new Error(`대표 이미지 업로드 실패: ${up.fail.join(', ')}`);
    const after = (await client.product(prodNo, await unit()))?.productImages || [];
    const added = after.filter(u => !before.includes(u));
    if (!added.length) throw new Error('올린 대표 이미지를 상품에서 찾지 못했습니다.');
    await patchDetail(prodNo, { images: [added[added.length - 1]] });
  }

  /** 옵션 값 맞추기(이름 바꾸기 · 빠진 값 숨기기). 추가가 필요하면 아무것도 바꾸지 않고 던진다. */
  async function applyOptionValues(prodNo, group, wantNames, details) {
    const plan = planOptionValues(group.values, wantNames);
    if (plan.add.length) {
      throw new Error(`옵션 "${group.name}"에 값 ${plan.add.map(v => `"${v}"`).join(', ')} 을 추가해야 합니다 — 아임웹 Open API 는 `
        + '옵션 값을 추가하지 못합니다. 관리자에서 값을 추가한 뒤 다시 실행하세요.');
    }
    const done = [];
    if (plan.renames.length) {
      const names = new Map(plan.renames.map(r => [r.valueCode, r.to]));
      await client.request('PATCH', `/products/${encodeURIComponent(prodNo)}/options/${encodeURIComponent(group.optionCode)}`, {
        body: { unitCode: await unit(), optionValueList: group.values.map(v => ({ optionValueCode: v.valueCode, optionValueName: names.get(v.valueCode) ?? v.valueName })) },
      });
      done.push(`옵션 "${group.name}" ${plan.renames.map(r => `${r.from} → ${r.to}`).join(', ')}`);
    }
    if (plan.hide.length) {
      const hiddenNames = new Set(plan.hide.map(v => v.valueName));
      const targets = details.filter(d => (d.optionDetailInfoList || []).some(i => i.optionCode === group.optionCode && hiddenNames.has(i.optionValue?.optionValueName)));
      for (const d of targets) if (d.status !== 'HIDDEN') await patchOptionDetail(prodNo, d.optionDetailCode, { status: 'HIDDEN' });
      done.push(`옵션 "${group.name}" 값 ${[...hiddenNames].map(v => `"${v}"`).join(', ')} 조합 ${targets.length}개 숨김`);
    }
    return done;
  }

  // ── 등록 ──
  async function template(templateNo) {
    const u = await unit();
    const product = await client.product(templateNo, u);
    if (!product) throw new Error(`템플릿 상품 ${templateNo} 을 찾지 못했습니다.`);
    const details = await client.optionDetails(templateNo, u);
    const priceByKey = {};
    for (const d of details) priceByKey[comboKey(optionTextOf(d))] = Number(d.price) || 0;
    return { product, priceByKey };
  }

  async function findByTitle(title) {
    const hit = (await allRows({ fresh: true })).filter(r => r.name === title).sort((a, b) => b.prodNo - a.prodNo)[0];
    return hit ? hit.prodNo : null;
  }

  /** 새 상품의 조합가격을 템플릿과 같은 마크 · 구성끼리 맞춘다. 조합이 늦게 생길 수 있어 잠시 기다린다. */
  async function applyComboPrices(prodNo, priceByKey, basePrice) {
    const u = await unit();
    let details = [];
    for (let i = 0; i < 5 && !details.length; i++) {
      details = await client.optionDetails(prodNo, u);
      if (!details.length) await sleep(2000);
    }
    if (!details.length) throw new Error('조합(옵션 상세)이 만들어지지 않았습니다');
    const set = [];
    for (const d of details) {
      const want = priceByKey[comboKey(optionTextOf(d))] ?? basePrice;
      if (Number(d.price) !== want) await client.setOptionPrice(prodNo, d.optionDetailCode, u, want);
      set.push(`${optionTextOf(d)}=${want}`);
    }
    return set;
  }

  /** 만든 뒤 다시 읽어 확인: 판매가 · 그룹가격 · 조합가격. 다르면 문제 목록. */
  async function verifyCreated(prodNo, { price, groups, priceByKey, sale }) {
    const problems = [];
    const u = await unit();
    const p = await client.product(prodNo, u);
    if (Number(p?.price) !== price) problems.push(`판매가 ${p?.price} (요청 ${price})`);
    if (sale && p?.prodStatus !== 'sale') problems.push(`상태가 판매중이 아님 (${p?.prodStatus})`);
    const got = templateGroups(p?.periodDiscount);
    const sig = g => `${g.groupCode || g.groupType}:${g.discountAmount}${g.discountType}`;
    const want = groups.map(sig).sort().join(','), have = got.map(sig).sort().join(',');
    if (want !== have) problems.push(`그룹가격이 템플릿과 다름 (템플릿 ${groups.length}건 · 상품 ${got.length}건)`);
    for (const d of await client.optionDetails(prodNo, u)) {
      const expect = priceByKey[comboKey(optionTextOf(d))] ?? price;
      if (Number(d.price) !== expect) problems.push(`조합 "${optionTextOf(d)}" 가격 ${d.price} (요청 ${expect})`);
    }
    return problems;
  }

  /** 개별 · 세트 등록. 결과: [{ type, ok, no, title, error }] — no 는 상품이 만들어졌으면 ok 와 상관없이 채운다. */
  async function registerB2bViaApi(data) {
    resolveBsa(data);
    const u = await unit();
    const results = [];
    const doOne = async (type) => {
      const { label } = B2B_PLAN[type];
      const title = b2bTitle(data, type);
      const { price, templateNo } = planOf(data, type);
      const r = { type, ok: false, no: null, title, error: '' };
      results.push(r);
      const errors = [];
      try {
        log(`[B2B] ${label} 등록: ${title} (${price}원, 템플릿 ${templateNo})`);
        const tpl = await template(templateNo);
        const content = buildContentFromTemplate(String(tpl.product.content || ''), data);
        const { categories, brandCode, modelCode } = buildCategories(await categoryTree(), data.brand, data.model);
        if (!brandCode || !modelCode) log(`⚠ 카테고리 코드 확인 실패 (브랜드=${brandCode ? 'OK' : '없음'}, 차종=${modelCode ? 'OK' : '없음'}) — 등록은 진행`);
        const image = await imageFile(data, (tpl.product.productImages || [])[0]);
        log(`[B2B] 대표 이미지: ${image.from} (${image.name})`);
        const body = buildCreateBody({ data, type, unitCode: u, title, price, content, categories, template: tpl.product });
        let created;
        try {
          created = (await client.request('POST', '/products', { form: toFormData(body, [{ field: 'productImages', blob: image.blob, name: image.name }]) }))?.data;
        } catch (e) {
          if (!isAmbiguous(e)) throw e;
          log(`⚠ [B2B] 등록 응답을 받지 못함(${e.message}) — 만들어졌는지 상품명으로 찾아봅니다`);
          const found = await findByTitle(title);
          if (!found) throw e;
          created = { prodNo: found };
        }
        invalidateRows();
        r.no = Number(created?.prodNo) || null;
        if (!r.no) throw new Error('상품 생성 실패 — 상품번호를 받지 못했습니다');
        log(`[B2B] ${label} 생성됨: 상품번호 ${r.no}`);
        if (created.failUploadImages?.length) errors.push(`대표 이미지 업로드 실패 (${created.failUploadImages.map(f => f.fileName).join(', ')})`);

        // 판매중 전환을 먼저 한다(예전 내부 API 에서 전환이 조합가격을 되돌린 적이 있어 순서를 지킨다).
        let sale = false;
        try { await setStatus(r.no, 'sale'); sale = true; log(`[B2B] ${label} 판매중 전환 완료`); }
        catch (e) { errors.push(`판매중 전환 실패 — 숨김 상태로 남았습니다 (${e.message})`); }

        try { log(`[B2B] 조합가격: ${(await applyComboPrices(r.no, tpl.priceByKey, price)).join(' / ')}`); }
        catch (e) { errors.push(`조합가격 설정 실패 — 기본가로 남았을 수 있습니다 (${e.message})`); }

        // B2B 전용 가격이 외부 채널(네이버 등)에 나가면 안 된다. 조회로 확인할 수 없어 설정 응답으로만 판정한다.
        try { await client.request('PATCH', `/products/${r.no}/display`, { body: { unitCode: u, display: [] } }); log(`[B2B] 외부 채널 노출 끔`); }
        catch (e) { errors.push(`외부 채널 노출 끄기 실패: ${e.message}`); }

        const problems = await verifyCreated(r.no, { price, groups: templateGroups(tpl.product.periodDiscount), priceByKey: tpl.priceByKey, sale });
        if (problems.length) errors.push(`확인 결과가 다름: ${problems.join(' / ')}`);
        else log(`[B2B] ✅ ${label} 확인 완료 (판매가 · 그룹가격 ${templateGroups(tpl.product.periodDiscount).length}건 · 조합가격)`);
      } catch (e) {
        log(`⚠ [B2B] ${label} 등록 중 오류: ${e.message}`);
        errors.push(e.message);
      } finally {
        r.ok = !!r.no && errors.length === 0;
        r.error = errors.join(' / ') + (r.no && errors.length ? ` (상품번호 ${r.no} — 아임웹 관리자에서 확인해주세요)` : '');
      }
    };
    if (data.registerIndiv) { await doOne('indiv'); await sleep(1000); }
    if (data.registerSet) await doOne('set');

    // 개별 + 세트가 둘 다 만들어졌으면 서로 연관상품으로. 실패는 세트 쪽 실패로 센다.
    const made = results.filter(x => x.no);
    if (made.length === 2) {
      try {
        await client.request('PATCH', `/products/${made[0].no}/relative-info`, { body: { relativeData: [{ relativeProdNo: made[1].no, isMutual: 'Y' }] } });
        log(`[B2B] 연관상품 연결 완료: ${made[0].no} ↔ ${made[1].no}`);
      } catch (e) {
        log(`⚠ [B2B] 연관상품 연결 실패: ${e.message}`);
        made[1].ok = false;
        made[1].error = [made[1].error, `개별↔세트 연관상품 연결 실패: ${e.message}`].filter(Boolean).join(' / ');
      }
    }
    return results;
  }

  // ── 등록 화면의 '수정' ──
  /** 결과: [{ type, ok, prodNo, error }]. 요청한 변경 중 하나라도 거부되면 그 대상은 실패다. */
  async function modifyB2bViaApi(data) {
    resolveBsa(data);
    log('========== B2B몰 쇼핑 상품 수정 시작 (Open API) ==========');
    const results = [];
    await allRows({ fresh: true });
    const doOne = async (type) => {
      const isSet = type === 'set';
      const keyword = `${B2B_PLAN[type].suffix} [${data.code}]`;
      const match = (await searchRows(keyword)).find(r => titleHasCode(r.name, data.code));
      if (!match) { results.push({ type, ok: false, error: `수정할 상품을 찾지 못했습니다 ("${keyword}")` }); return; }
      const prodNo = match.prodNo;
      log(`[B2B 수정] 상품 발견: ${match.name} (상품번호: ${prodNo})`);
      const cur = await loadProduct(prodNo);
      const { price: newPrice } = planOf(data, type);
      const done = [], errors = [];

      const fields = {};
      const newTitle = b2bTitle(data, type);
      if (newTitle !== cur.title) { fields.productName = newTitle; done.push(`상품명 → "${newTitle}"`); }
      const specUrl = extractImageUrl(data.specImageUrl);
      if (specUrl) {
        const html = replaceSpecBlock(cur.content, { specUrl, titleBrand: data.titleBrand, titleModel: data.titleModel });
        if (html === null) log('⚠ [B2B 수정] 조견표 표시를 찾지 못해 상세설명은 바꾸지 않습니다');
        else if (html !== cur.content) { fields.description = html; done.push('상세설명(조견표)'); }
      }
      if (Object.keys(fields).length) { await patchDetail(prodNo, fields); invalidateRows(); }
      if (newPrice !== cur.price) { await setPrice(prodNo, newPrice); done.push(`판매가 → ${newPrice}원`); }

      // 옵션: 차종(예전 템플릿은 '차량') 값 하나, 연식 값들. 이름만 바꾸고, 빠지는 값의 조합은 숨긴다.
      const details = await client.optionDetails(prodNo, cur.unitCode);
      const modelGroup = cur.optionGroups.find(g => g.name === '차종' || g.name === '차량');
      const yearGroup = cur.optionGroups.find(g => g.name === '연식');
      try {
        if (modelGroup) done.push(...await applyOptionValues(prodNo, modelGroup, [data.titleModel || data.model], details));
        if (yearGroup) done.push(...await applyOptionValues(prodNo, yearGroup, yearValues(data), details));
      } catch (e) { errors.push(e.message); }

      if (data.brand && data.model) {
        try {
          const { categories } = buildCategories(await categoryTree(), data.brand, data.model);
          await client.request('PATCH', `/products/${prodNo}/classification`, { body: { categories } });
          done.push('카테고리');
        } catch (e) { errors.push(`카테고리 변경 실패: ${e.message}`); }
      }
      if (data.mainImageUrl || data.mainImagePath) {
        try { await replaceMainImage(prodNo, data); done.push('대표 이미지'); }
        catch (e) { errors.push(`대표 이미지 교체 실패: ${e.message}`); }
      }
      log(`[B2B 수정] ${isSet ? '세트' : '개별'} ${prodNo}: ${done.join(', ') || '변경 사항 없음'}`);
      results.push({ type, ok: errors.length === 0, prodNo, ...(errors.length ? { error: errors.join(' / ') } : {}) });
    };
    const runOne = async (type) => {
      try { await doOne(type); }
      catch (e) { log(`⚠ [B2B 수정] ${type === 'set' ? '세트' : '개별'} 수정 실패: ${e.message}`); results.push({ type, ok: false, error: e.message }); }
    };
    if (data.registerIndiv) { await runOne('indiv'); await sleep(500); }
    if (data.registerSet) await runOne('set');
    return results;
  }

  // ── 상품수정 탭 ──
  /** 제조사 · 차종 · 코드(또는 상품번호)로 찾아 '세트 + 개별' 짝으로 묶는다. */
  async function searchProducts({ brand, model, code, idx }) {
    if (idx) {
      log(`[B2B] 상품 번호(${idx})로 검색 정보를 뽑습니다...`);
      ({ brand, model, code } = await extractProductInfo(idx));
    }
    code = String(code || '').trim();
    const keyword = [brand, model].filter(Boolean).join(' ').trim();
    if (!keyword && !code) throw new Error('제조사·차종 또는 상품 코드를 입력해 주세요.');
    log(`[B2B] 검색 중 (제조사: ${brand || '-'}, 차종: ${model || '-'}, 코드: ${code || '-'})...`);
    const seen = new Map();
    const add = rows => rows.forEach(r => { if (!seen.has(r.prodNo)) seen.set(r.prodNo, r); });
    await allRows({ fresh: true });
    const SEARCH_LIMIT = { limit: 50 };
    if (keyword) add(await searchRows(keyword, SEARCH_LIMIT));
    if (code) {
      const codeRows = await searchRows(code, SEARCH_LIMIT);
      add(codeRows);
      // 개별 상품명에는 코드가 없는 경우가 많다 — 코드로 찾은 상품의 공통명으로 짝까지 모은다.
      for (const bk of new Set(codeRows.map(r => r.baseKey).filter(Boolean))) add(await searchRows(bk, SEARCH_LIMIT));
    }
    const norm = s => String(s || '').replace(/\s+/g, '');
    const byKey = new Map();
    for (const r of seen.values()) {
      const k = norm(r.baseKey);
      if (!byKey.has(k)) byKey.set(k, { baseKey: r.baseKey, items: [] });
      byKey.get(k).items.push(r);
    }
    let groups = [...byKey.values()];
    if (code) groups = groups.filter(g => g.items.some(i => titleHasCode(i.name, code)));
    if (model) groups = groups.filter(g => norm(g.baseKey).includes(norm(model)));
    if (brand) { const withBrand = groups.filter(g => norm(g.baseKey).includes(norm(brand))); if (withBrand.length) groups = withBrand; }
    groups.forEach(g => g.items.sort((a, b) => (a.type === 'set' ? -1 : 1) - (b.type === 'set' ? -1 : 1)));
    log(`[B2B] 검색 결과 ${groups.length}묶음 / 상품 ${groups.reduce((n, g) => n + g.items.length, 0)}건`);
    if (!groups.length) throw new Error(`상품을 찾지 못했습니다 (${keyword || ''}${code ? ' / ' + code : ''}).`);
    return groups;
  }

  async function loadGroup(prodNos) {
    const products = [];
    for (const no of prodNos) products.push(await loadProduct(no));
    const baseKey = baseKeyOf(products[0].title);
    products.forEach(p => { p.suffix = suffixOf(p.title); p.type = p.title.includes('1셋') ? 'set' : 'indiv'; });
    const nameSets = products.map(p => new Set(p.optionGroups.map(g => g.name)));
    const sharedNames = [...nameSets[0]].filter(n => nameSets.every(s => s.has(n)));
    const sharedGroups = sharedNames.map(n => ({ name: n, values: products[0].optionGroups.find(x => x.name === n).values.map(v => v.valueName) }));
    log(`[B2B] 짝 불러오기 완료 — ${products.map(p => `${p.type}(${p.prodNo})`).join(' + ')}`);
    return { baseKey, products, sharedGroups };
  }

  /** data = { prodNo, title?, price?, detailImages?, optionValues?:[{optionCode, values[]}], combos?:[{optionDetailCode?, displayText?, price?, stock?}] } */
  async function updateProduct(data) {
    const { prodNo } = data;
    if (!prodNo) throw new Error('수정할 상품번호가 없습니다.');
    const cur = await loadProduct(prodNo);
    const done = [];
    const fields = {};
    const newTitle = String(data.title ?? '').trim();
    if (newTitle && newTitle !== cur.title) { fields.productName = newTitle; done.push(`상품명 "${cur.title}" → "${newTitle}"`); }
    if (Array.isArray(data.detailImages)) {
      if (!data.detailImages.length) throw new Error('상세페이지 이미지가 0장입니다. 최소 1장은 있어야 합니다.');
      fields.description = replaceDetailImages(cur.content, data.detailImages);
      done.push(`상세이미지 ${cur.detailImages.length} → ${data.detailImages.length}장`);
    }
    const wantPrice = data.price != null && data.price !== '' ? Number(data.price) : null;
    const wantValues = Array.isArray(data.optionValues) && data.optionValues.length;
    const wantCombos = Array.isArray(data.combos) && data.combos.length;
    if (!Object.keys(fields).length && (wantPrice === null || wantPrice === cur.price) && !wantValues && !wantCombos) {
      throw new Error('변경할 내용이 없습니다.');
    }

    if (Object.keys(fields).length) { await patchDetail(prodNo, fields); invalidateRows(); }
    if (wantPrice !== null && wantPrice !== cur.price) { await setPrice(prodNo, wantPrice); done.push(`판매가 ${cur.price} → ${wantPrice}원`); }

    if (wantValues) {
      const details = await client.optionDetails(prodNo, cur.unitCode);
      for (const g of data.optionValues) {
        const group = cur.optionGroups.find(x => x.optionCode === g.optionCode);
        if (group) done.push(...await applyOptionValues(prodNo, group, g.values, details));
      }
    }
    if (wantCombos) {
      // 이름을 바꿨을 수 있어 조합을 다시 읽는다. 코드로 먼저, 없으면 표시문구로 찾는다.
      const now2 = await loadProduct(prodNo);
      let n = 0, stockSkipped = 0;
      for (const c of data.combos) {
        const hit = (c.optionDetailCode && now2.combos.find(x => x.optionDetailCode === c.optionDetailCode))
          || now2.combos.find(x => String(x.displayText).trim() === String(c.displayText || '').trim());
        if (!hit) continue;
        const body = {};
        if (c.price != null && c.price !== '' && (parseInt(c.price) || 0) !== hit.price) body.price = parseInt(c.price) || 0;
        // 재고는 Open API 가 '변경량(+/-)'으로 받는다. 화면은 목표 수량이라 차이를 보낸다.
        // 재고 관리를 쓰지 않는 상품(Open API 로 만든 상품 등)은 재고를 바꿀 수 없다(30157) — 건너뛰고 알린다.
        if (c.stock != null && c.stock !== '' && (parseInt(c.stock) || 0) !== hit.stock) {
          if (now2.stockUse === 'Y') body.stock = (parseInt(c.stock) || 0) - hit.stock;
          else stockSkipped++;
        }
        if (Object.keys(body).length) { await patchOptionDetail(prodNo, hit.optionDetailCode, body); n++; }
      }
      if (n) done.push(`옵션 조합 ${n}건 가격/재고`);
      if (stockSkipped) done.push(`재고 ${stockSkipped}건은 바꾸지 않음 — 재고 관리를 쓰지 않는 상품(수량 제한 없이 판매)`);
    }

    await sleep(1000);
    const after = await loadProduct(prodNo);
    const problems = [];
    if (fields.productName && after.title !== newTitle) problems.push(`상품명 미반영 (현재 "${after.title}")`);
    if (wantPrice !== null && after.price !== wantPrice) problems.push(`판매가 미반영 (현재 ${after.price})`);
    if (fields.description && after.detailImages.length !== data.detailImages.length) problems.push(`상세이미지 ${after.detailImages.length}장 (요청 ${data.detailImages.length}장)`);
    if (wantCombos) for (const c of data.combos) {
      if (c.price == null || c.price === '' || c.displayText == null) continue;
      const got = after.combos.find(x => String(x.displayText).trim() === String(c.displayText).trim());
      if (got && got.price !== (parseInt(c.price) || 0)) problems.push(`조합 "${got.displayText}" 가격 ${got.price} (요청 ${c.price})`);
    }
    if (problems.length) throw new Error(`저장은 됐지만 반영이 다릅니다: ${problems.join(' / ')}`);
    const summary = `상품 ${prodNo} 수정 완료 — ${done.join(', ') || '변경 없음'}`;
    log(`✓ ${summary}`);
    return summary;
  }

  async function updateGroup(data) {
    const results = [];
    for (const p of (data.products || [])) {
      const cur = await loadProduct(p.prodNo);
      const one = { prodNo: p.prodNo };
      if (data.baseKey) one.title = `${String(data.baseKey).trim()} ${suffixOf(cur.title)}`.trim();
      if (p.price != null && p.price !== '') one.price = p.price;
      if (Array.isArray(data.detailImages) && data.detailImages.length) one.detailImages = data.detailImages;
      if (Array.isArray(data.sharedGroups) && data.sharedGroups.length) {
        one.optionValues = cur.optionGroups.map(g => {
          const shared = data.sharedGroups.find(s => s.name === g.name);
          return { optionCode: g.optionCode, values: shared ? shared.values.slice() : g.values.map(v => v.valueName) };
        });
      }
      if (Array.isArray(p.combos) && p.combos.length) one.combos = p.combos;
      results.push(await updateProduct(one));
    }
    return results.join(' / ');
  }

  return {
    unit, allRows, searchRows, listB2bRowsByCode, b2bOptionValuesOf, loadProduct, extractProductInfo,
    categoryTree, syncCategories, registerB2bViaApi, modifyB2bViaApi, searchProducts, loadGroup, updateProduct, updateGroup,
  };
}
