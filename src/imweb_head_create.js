// 아임웹 자사몰(본사몰 optic-glass.co.kr) 신규 등록 — 아임웹 Open API 만. 한 사이트의 한국 · 미국 · 일본 구역(unit)에 한 번에 만든다.
// 브라우저 · 관리자 세션 · cm API · 스토어프론트는 쓰지 않는다.
//
// 형식(2026-10-28 소유자 결정)
//   상품명   한국 '옵틱글래스 {브랜드} {차종} 광각미러 [No.{코드}]'. 미국 · 일본은 imweb_unit_names.js 의 번역 형식
//            'Optic-glass {Brand} {Model} Wide View Side Mirror [No.x]' · 'Optic-glass {ブランド} {車種} 広角ドアミラー [No.x]'
//            을 좌측 영문 · 일문 칸으로 만든다. 없으면 그 구역은 한국 이름 + 경고(막지 않는다) — 환율 탭 이름 번역이 나중에 고친다.
//   카테고리 '내 차 찾기 ver2 > {브랜드}'(르노삼성 → 르노 코리아, ver2 에 없는 브랜드는 '기타' + 경고). 옵션 '구성 선택' 1set / 운전석 / 조수석.
//   템플릿   BSA X 2153(150,000 / 80,000 / 70,000) · BSA O 2116(220,000 / 115,000 / 105,000). 기본가 · 조합 최종가 · 할인 설정 ·
//            옵션 조합 방식 · 본문을 템플릿에서 가져오고, 미국 · 일본 옵션 이름은 템플릿의 그 구역 이름을 그대로 쓴다.
//   본문     템플릿 한국 본문에서 조견표 이미지 하나(상세 표시 '<!--B .상세페이지-->' 앞, ESM 조견표 · Compatibility Chart 폴더)와
//            표시 뒤 상세 이미지만 바꾼다(B2B buildContentFromTemplate 과 같은 생각). 한국은 국내용, 미국 · 일본은 해외용 조견표.
//            표시나 조견표를 하나로 찾지 못하면 아무것도 만들지 않고 멈춘다.
//   가격     미국 · 일본은 한국 가격을 환율 탭과 같은 환율 · 같은 규칙(앞 두 자리 버림, 하한)으로 — convertPrice(convertWithRates).
//   순서     숨김(nosale)으로 만들고 → 구역마다 조합가 → 세 구역을 다시 읽어 확인 → 모두 맞을 때만 판매중 → 판매중으로 다시 읽어
//            어긋나면 숨김으로 되돌린다.
//            Open API 에 상품 삭제가 없다 — 어긋나면 숨김으로 두고 상품번호와 문제를 돌려준다.
// 세션 · 파일 잠금(getImwebApiClient)과 같은 프로세스 안 아임웹 쓰기 직렬화(bulkPriceService.uiWrite)는 부르는 쪽(main)이 맡는다.
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveBsa, discountInfoFrom, extractDetailImages, replaceDetailImages, optionTextOf, mimeOf } from './platforms/openapi/imweb_b2b.js';
import { extractImageUrl } from './platforms/openapi/build_payload.js';
import { toFormData } from './platforms/openapi/imweb_client.js';
import { rateProblem, fromKrw, toKrw } from './utils/fx_pricing.js';
import { hasBsa, sameModel } from './utils/duplicate_guard.js';

const HEAD_TEMPLATE = { plain: '2153', bsa: '2116' };
const CUR = ['KRW', 'USD', 'JPY'];
const LABEL = { KRW: '한국', USD: '미국', JPY: '일본' };
const CATEGORY_ROOT = '내 차 찾기 ver2';
const OPTION_NAME = '구성 선택', OPTION_VALUES = ['1set', '운전석', '조수석'];
const DETAIL_MARK = '<!--B .상세페이지-->';
const CHART_DIR = /\/(?:조견표|Compatibility Chart)\//;   // main_process esmBasePath 의 조견표 폴더
const SHOP = 'Optic-glass', MIRROR = { USD: 'Wide View Side Mirror', JPY: '広角ドアミラー' };   // imweb_unit_names.js 와 같은 표기
const MIN_TARGET = { USD: 1, JPY: 100 };   // imweb_unit_prices.js 의 새 판매가 하한과 같다
const HANGUL = /[가-힣]/;
const clean = s => String(s ?? '').replace(/_x000D_/g, '').trim();
const norm = s => clean(s).replace(/\s+/g, '').toLowerCase();
const decode = u => { try { return decodeURI(u); } catch { return u; } };
const codeOf = data => clean(data.code).replace(/^No\.\s*/i, '');
// 만들어졌는지 모르는 실패 — 다시 만들면 중복이 되므로 먼저 찾아본다(imweb_b2b.js 와 같은 판단 + 보낸 뒤 연결이 끊긴 'fetch failed').
const isAmbiguous = e => e?.name === 'TimeoutError' || e?.name === 'AbortError' || e?.name === 'TypeError' || (Number(e?.status) >= 500);
// 앱 브랜드와 '내 차 찾기 ver2' 칸 이름이 다른 것. ver2 에 없는 브랜드는 기존 본사 상품처럼 '기타'(2026-10-22 덤프: 마쯔다 · 피아트 · 미쓰비시 …).
const CATEGORY_ALIAS = { 르노삼성: '르노 코리아' }, CATEGORY_OTHER = '기타';

/** 템플릿 본문의 조견표 이미지 하나만 바꾼다 — 상세 표시 앞 · 주석 밖 · 조견표(Compatibility Chart) 폴더. 하나가 아니면 null. */
function replaceChart(html, url) {
  const s = String(html || ''), end = s.indexOf(DETAIL_MARK);
  if (end < 0) return null;
  const comments = [...s.matchAll(/<!--[\s\S]*?-->/g)].map(m => [m.index, m.index + m[0].length]);
  const hits = [...s.slice(0, end).matchAll(/<img[^>]*src=["']([^"']+)["'][^>]*>/gi)]
    .filter(m => CHART_DIR.test(decode(m[1])) && !comments.some(([a, b]) => m.index >= a && m.index < b));
  if (hits.length !== 1) return null;
  const [t] = hits;
  return s.slice(0, t.index) + t[0].replace(/src=["'][^"']+["']/i, `src="${url}"`) + s.slice(t.index + t[0].length);
}
const visibleText = html => String(html).replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]*>/g, ' ');

/** main 이 넘길 convertPrice — 환율 탭(imweb_unit_prices.js open · planProduct)과 같은 환율 출처 · 같은 규칙(fromKrw).
 *  from = 'USD' 이면 amount 는 달러다 — 원화로 되돌린 뒤 같은 규칙으로 환산한다(셸 판매가(USD) → 일본 구역). */
export const convertWithRates = (rates, clock = Date.now) => async (currency, amount, from = 'KRW') => {
  const got = await rates();
  if (!got?.success) throw new Error(got?.error || '환율을 불러오지 못했습니다.');
  const problem = rateProblem(got.data, clock());
  if (problem) throw new Error(problem);
  return Number(fromKrw(from === 'KRW' ? amount : toKrw(amount, from, got.data), currency, got.data));
};

/** 미국 · 일본 구역 가격. 기본 판매가와 조합(1set · 운전석 · 조수석) 최종가는 한국 값을 환율 규칙으로 환산한다.
 *  1set 조합만 예외: usd(셸 '판매가 (USD)' 자동완성 · 탭 '미국 1set')가 있으면 미국 1set = usd, 일본 1set = usd 의 환율 환산.
 *  jpy(탭 '일본 1set' 칸)가 있으면 일본 1set = jpy. 템플릿의 기본 판매가는 운전석 값이라 1set 칸과 따로 간다. 미리보기 · 등록이 같이 쓴다. */
export async function planUnitPrices({ base, combos }, usd, convertPrice, jpy) {
  const plan = {}, num = v => Number(String(v ?? '').replace(/[$¥,\s]/g, '')) || 0;
  usd = num(usd); jpy = num(jpy);
  for (const c of ['USD', 'JPY']) {
    const check = v => {
      if (!(v >= MIN_TARGET[c])) throw new Error(`${LABEL[c]} 환산가 ${v} 가 하한(${MIN_TARGET[c]}) 아래입니다 — 가격을 확인하세요.`);
      return v;
    };
    const conv = async krw => check(Number(await convertPrice(c, krw)));
    plan[c] = { base: await conv(base), combos: [] };
    for (const krw of combos) plan[c].combos.push(await conv(krw));
    const set = c === 'JPY' && jpy ? jpy : usd ? (c === 'USD' ? usd : Number(await convertPrice(c, usd, 'USD'))) : 0;
    if (set && plan[c].combos.length) plan[c].combos[0] = check(set);
  }
  return plan;
}

/** client = 본사몰 Open API 클라이언트(main getImwebApiClient()). convertPrice(currency, krw) → 그 통화 판매가(convertWithRates). */
export function createImwebHeadCreate(client, {
  log = () => {}, convertPrice, sleep = ms => new Promise(r => setTimeout(r, ms)), fetchImpl = fetch, readFile = fs.readFile,
} = {}) {
  if (typeof convertPrice !== 'function') throw new Error('convertPrice 가 없습니다(환율 탭 규칙).');
  let unitCache = null;

  async function units() {
    if (unitCache) return unitCache;
    const list = (await client.siteInfo())?.unitList || [];
    const u = Object.fromEntries(CUR.map(c => [c, list.find(x => String(x.currency).toUpperCase() === c)?.unitCode]));
    if (CUR.some(c => !u[c])) throw new Error('본사몰 사이트 정보에서 한국 · 미국 · 일본 구역을 모두 찾지 못했습니다.');
    return (unitCache = u);
  }
  async function optionGroups(no, unitCode) {
    const res = await client.request('GET', `/products/${encodeURIComponent(no)}/options`, { query: { unitCode, page: 1, limit: 100 } });
    const list = res?.data?.list ?? res?.data ?? [];
    return (Array.isArray(list) ? list : []).map(o => ({ name: clean(o.name),
      values: (o.optionValueList || []).map(v => ({ code: v.optionValueCode, name: clean(v.optionValueName) })) }));
  }

  // 템플릿: 한국 상품 · 옵션 · 조합가, 미국 · 일본 옵션 이름. 옵션이 '구성 선택' 1set/운전석/조수석 하나가 아니면 멈춘다.
  async function readTemplate(no, u) {
    const p = await client.product(no, u.KRW);
    if (!p) throw new Error(`템플릿 상품 ${no} 을 찾지 못했습니다.`);
    const groups = {};
    for (const c of CUR) groups[c] = await optionGroups(no, u[c]);
    const kr = groups.KRW;
    if (kr.length !== 1 || kr[0].name !== OPTION_NAME || kr[0].values.map(v => v.name).join('|') !== OPTION_VALUES.join('|')) {
      throw new Error(`템플릿 상품 ${no} 의 옵션이 '${OPTION_NAME}' ${OPTION_VALUES.join(' / ')} 하나가 아닙니다 — 템플릿을 확인하세요.`);
    }
    const details = await client.optionDetails(no, u.KRW);
    const prices = OPTION_VALUES.map(v => {
      const hit = details.filter(d => clean(optionTextOf(d)) === v);
      if (hit.length !== 1 || !(Number(hit[0].price) > 0)) throw new Error(`템플릿 상품 ${no} 의 조합 '${v}' 가격을 하나로 정하지 못했습니다.`);
      return Number(hit[0].price);
    });
    if (!(Number(p.price) > 0)) throw new Error(`템플릿 상품 ${no} 의 판매가가 없습니다.`);
    return { p, groups, prices };
  }

  // 구역별 옵션(값 순서는 한국과 같게). 미국 · 일본은 템플릿의 그 구역 이름 — 못 맞추면 한국 이름 + 경고.
  function optionDataOf(tpl, u, warn) {
    const k = tpl.groups.KRW[0];
    return CUR.map(c => {
      const g = tpl.groups[c][0];
      let values = g && g.values.length === k.values.length ? k.values.map((v, i) => (g.values.find(x => x.code === v.code) ?? g.values[i]).name) : [];
      let name = g?.name || '';
      if (!name || values.length !== k.values.length || values.some(v => !v) || new Set(values).size !== values.length) {
        name = k.name; values = k.values.map(v => v.name);
      }
      if (c !== 'KRW' && HANGUL.test(name + values.join(''))) warn(`${LABEL[c]} 옵션 이름이 한국어로 남습니다(템플릿에 그 구역 이름이 없음) — 환율 탭 '이름 번역'으로 고치세요.`);
      return { unitCode: u[c], name, valueList: values.map(valueName => ({ valueName })) };
    });
  }

  function titlesOf(data, code, model, kr, warn) {
    const unit = (c, b, m, field) => {
      let mm = clean(m);
      if (mm && hasBsa(model) && !/BSA/i.test(mm)) mm += ' (BSA)';   // imweb_unit_names: 일반 상품과 가르는 BSA 표시는 남긴다
      const name = [SHOP, clean(b), mm, MIRROR[c], `[No.${code}]`].join(' ').replace(/\s*\([^)]*[가-힣][^)]*\)/g, '');
      if (clean(b) && mm && !HANGUL.test(name)) return name;
      warn(`${LABEL[c]} 상품명: ${field} 제조사 · 차종이 없거나 한글이 섞여 한국 이름으로 둡니다 — 환율 탭 '이름 번역'으로 고치세요.`);
      return kr;
    };
    return { KRW: kr, USD: unit('USD', data.titleBrandEn, data.titleModelEn, '영문'), JPY: unit('JPY', data.titleBrandJp, data.titleModelJp, '일문') };
  }

  /** 대표 이미지 파일(등록에는 이미지 파일이 꼭 있어야 한다). 로컬 파일 → 주소. 템플릿 이미지는 다른 차라 쓰지 않는다. */
  async function imageFile(data) {
    if (data.mainImagePath) {
      try {
        const buf = await readFile(data.mainImagePath);
        return { blob: new Blob([buf], { type: mimeOf(data.mainImagePath) }), name: path.basename(data.mainImagePath) };
      } catch { /* 주소로 */ }
    }
    const url = extractImageUrl(data.mainImageUrl);
    if (!url) throw new Error('대표 이미지가 없습니다(이미지 파일 · 주소 모두 없음) — 등록에는 대표 이미지가 꼭 있어야 합니다.');
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`대표 이미지를 내려받지 못했습니다 (HTTP ${res.status}): ${url}`);
    const type = (res.headers.get('content-type') || '').split(';')[0].trim();
    if (!/^image\//i.test(type)) throw new Error(`대표 이미지 주소가 이미지가 아닙니다 (${type || '형식 없음'}): ${url}`);
    let name = 'image.jpg';
    try { name = decodeURIComponent(path.basename(new URL(url).pathname)) || name; } catch { /* 기본 이름 */ }
    return { blob: new Blob([Buffer.from(await res.arrayBuffer())], { type }), name };
  }

  // 구역마다 조합을 값 이름으로 찾아 최종가를 맞춘다. 조합 코드는 구역끼리 같아야 한다(imweb_unit_prices 가 그 전제로 맞춘다).
  async function setComboPrices(no, u, optionData, plan, problems) {
    let krCodes = null;
    for (const [i, c] of CUR.entries()) {
      let details = [];
      for (let k = 0; k < 5 && !details.length; k++) {   // 조합이 늦게 생길 수 있다
        details = await client.optionDetails(no, u[c]);
        if (!details.length) await sleep(2000);
      }
      const codes = [];
      for (const [j, { valueName }] of optionData[i].valueList.entries()) {
        const hit = details.filter(d => clean(optionTextOf(d)) === valueName);
        if (hit.length !== 1) { problems.push(`${LABEL[c]} 조합 '${valueName}' 을 하나로 찾지 못함`); codes.push(null); continue; }
        const d = hit[0];
        codes.push(d.optionDetailCode);
        if (krCodes && krCodes[j] && d.optionDetailCode !== krCodes[j]) problems.push(`${LABEL[c]} 조합 '${valueName}' 코드가 한국과 다름 (${d.optionDetailCode} · 한국 ${krCodes[j]})`);
        if (Number(d.price) !== plan[c].combos[j]) await client.setOptionPrice(no, d.optionDetailCode, u[c], plan[c].combos[j]);
      }
      krCodes ||= codes;
      log(`[자사몰] ${LABEL[c]} 조합가: ${optionData[i].valueList.map((v, j) => `${v.valueName}=${plan[c].combos[j]}`).join(' / ')}`);
    }
  }

  // 세 구역을 다시 읽는다: 상품명 · 기본가 · 조합가(값 이름으로) · 상태(status) · 진열, 한국 본문의 새 조견표.
  async function verify(no, u, titles, plan, optionData, specKr, status) {
    const problems = [];
    for (const [i, c] of CUR.entries()) {
      const p = await client.product(no, u[c]), L = LABEL[c];
      if (String(p?.name ?? '') !== titles[c]) problems.push(`${L} 상품명 "${p?.name}" (요청 "${titles[c]}")`);
      if (Number(p?.price) !== plan[c].base) problems.push(`${L} 판매가 ${p?.price} (요청 ${plan[c].base})`);
      if (p?.isDisplay !== 'Y') problems.push(`${L} 진열 안 됨 (${p?.isDisplay})`);
      if (c === 'KRW' && p?.prodStatus !== status) problems.push(`상태 ${p?.prodStatus} (${status === 'sale' ? '판매중' : '숨김'}이어야 함)`);
      if (c === 'KRW' && !String(p?.content || '').includes(specKr)) problems.push('한국 상세설명에 새 조견표가 없음');
      const details = await client.optionDetails(no, u[c]);
      if (details.length !== optionData[i].valueList.length) problems.push(`${L} 조합 ${details.length}개 (요청 ${optionData[i].valueList.length}개)`);
      optionData[i].valueList.forEach(({ valueName }, j) => {
        const d = details.find(x => clean(optionTextOf(x)) === valueName);
        if (!d) problems.push(`${L} 조합 '${valueName}' 없음`);
        else if (Number(d.price) !== plan[c].combos[j]) problems.push(`${L} 조합 '${valueName}' 가격 ${d.price} (요청 ${plan[c].combos[j]})`);
      });
    }
    return problems;
  }

  /**
   * data: titleBrand · titleModel(상품명, 없으면 brand · model), brand(카테고리, 없으면 titleBrand), code, bsaO · bsaX(또는 hasBsa),
   *       titleBrandEn · titleModelEn · titleBrandJp · titleModelJp, specImageUrl(국내용) · specImageUrlEn(해외용),
   *       mainImagePath · mainImageUrl(대표), detailHtml(상세 이미지 — 이미지 목록 domestic 묶음).
   * 만들기 전 문제는 던진다(아무것도 만들지 않음). 만든 뒤에는 던지지 않고 { ok, no, title, warnings, error } — no 는 늘 채운다.
   */
  async function register(data) {
    const warnings = [];
    const warn = m => { warnings.push(m); log(`⚠ [자사몰] ${m}`); };
    const code = codeOf(data), model = clean(data.titleModel || data.model), brand = clean(data.titleBrand || data.brand);
    const catBrand = clean(data.brand || data.titleBrand);
    if (!brand || !model || !code) throw new Error('제조사 · 차종 · 상품 코드를 모두 입력해 주세요.');
    const specKr = extractImageUrl(data.specImageUrl);
    if (!specKr) throw new Error('조견표 이미지 URL(국내용)을 입력해 주세요.');
    let specEn = extractImageUrl(data.specImageUrlEn);
    if (!specEn) { warn('해외용 조견표(Compatibility Chart)가 없어 미국 · 일본에도 국내용을 넣습니다.'); specEn = specKr; }

    const bsa = resolveBsa(data), tplNo = bsa ? HEAD_TEMPLATE.bsa : HEAD_TEMPLATE.plain;
    const title = `옵틱글래스 ${brand} ${model} 광각미러 [No.${code}]`;
    log(`[자사몰] 등록 준비: ${title} (BSA ${bsa ? 'O' : 'X'}, 템플릿 ${tplNo})`);
    const u = await units();
    const tpl = await readTemplate(tplNo, u);
    const titles = titlesOf(data, code, model, title, warn);
    const optionData = optionDataOf(tpl, u, warn);

    // 본문: 조견표 · 상세 이미지만 바꾼다. 템플릿 차의 이름 · 번호가 글로 남으면 다른 차 상품이 되므로 멈춘다.
    const detail = extractDetailImages(data.detailHtml || '');
    if (!detail.length) warn('상세 이미지가 없어 템플릿의 상세 이미지를 그대로 둡니다.');
    const tplName = clean(tpl.p.name).match(/^옵틱글래스\s+(.+?)\s+광각미러\s*\[(No\.[^\]]+?)\s*\]/);
    const bodyOf = url => {
      const html = replaceChart(tpl.p.content, url);
      if (html === null) throw new Error(`템플릿 상품 ${tplNo} 본문에서 '${DETAIL_MARK}' 표시와 그 앞 조견표 이미지(조견표 · Compatibility Chart 폴더) 하나를 찾지 못했습니다 — 템플릿 본문을 확인하세요. 아무것도 만들지 않았습니다.`);
      const text = visibleText(html);
      if (tplName && (text.includes(tplName[1]) || text.includes(tplName[2]))) throw new Error(`템플릿 상품 ${tplNo} 본문에 템플릿 차(${tplName[1]} ${tplName[2]})가 글로 적혀 있어 바꿀 수 없습니다 — 템플릿 본문을 확인하세요. 아무것도 만들지 않았습니다.`);
      return detail.length ? replaceDetailImages(html, detail) : html;
    };
    // 탭 '상세설명' 칸의 글은 세 구역 본문 맨 위에 덧붙인다(줄마다 <p>, HTML 은 글자 그대로).
    const intro = String(data.intro || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean)
      .map(s => `<p>${s.replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]))}</p>`).join('');
    const bodies = { KRW: intro + bodyOf(specKr), USD: intro + bodyOf(specEn), JPY: intro + bodyOf(specEn) };

    const tree = (await client.request('GET', '/products/shop-categories', { query: { unitCode: u.KRW } }))?.data;
    const root = (Array.isArray(tree) ? tree : []).find(n => norm(n.name) === norm(CATEGORY_ROOT));
    const child = name => (root?.children || []).find(n => n.categoryCode && norm(n.name) === norm(name));
    let category = child(CATEGORY_ALIAS[catBrand] || catBrand);
    if (!category && (category = child(CATEGORY_OTHER))) warn(`카테고리 '${CATEGORY_ROOT} > ${catBrand}' 가 없어 '${CATEGORY_OTHER}' 에 넣습니다(기존 본사 상품과 같은 방식).`);
    if (!category) throw new Error(`카테고리 '${CATEGORY_ROOT} > ${catBrand}' 가 없습니다 — 아임웹 관리자에서 만든 뒤 다시 등록하세요`);

    // 한국 가격: 탭 칸(1set · 운전석 · 조수석)을 쓴다. 칸 값이 없으면(셸 일괄 등록 등) 템플릿 가격.
    const krw = (Array.isArray(data.krwPrices) ? data.krwPrices : []).map(Number);
    const typed = krw.length === 3 && krw.every(v => v > 0);
    if (Array.isArray(data.krwPrices) && data.krwPrices.some(v => String(v ?? '').trim()) && !typed) throw new Error('한국 판매가(1set · 운전석 · 조수석)를 모두 0보다 큰 숫자로 넣어 주세요.');
    // 기본 판매가는 템플릿이 쓰는 조합(지금은 운전석)의 칸 값을 따른다.
    const baseAt = Math.max(0, tpl.prices.indexOf(Number(tpl.p.price)));
    const plan = { KRW: typed ? { base: krw[baseAt], combos: krw } : { base: Number(tpl.p.price), combos: tpl.prices } };
    Object.assign(plan, await planUnitPrices(plan.KRW, data.usdPrice, convertPrice, data.jpyPrice));
    const image = await imageFile(data);

    const body = {
      productBaseInfo: {
        status: 'nosale', productType: 'normal',
        unitShopProductInfo: CUR.map(c => ({ unitCode: u[c], productName: titles[c], description: bodies[c],
          commonHeaderSettingType: 'default', commonFooterSettingType: 'default' })),
        // 재고 필드는 보내지 않는다 — 옵션 상품은 30038 로 거부된다(imweb_b2b buildCreateBody).
      },
      productClassificationInfo: { categories: [category.categoryCode], ...(tpl.p.brand ? { brand: tpl.p.brand } : {}) },
      productPriceInfo: CUR.map(c => ({ unitCode: u[c], price: plan[c].base, originalPrice: 0, isPriceTaxIncluded: 'Y' })),
      productDiscountInfo: CUR.map(c => discountInfoFrom(tpl.p, u[c])),
      productExhibitionInfo: CUR.map(c => ({ unitCode: u[c], isDisplay: 'Y' })),
      // 30053: 옵션은 모든 구역의 optionData 가 있어야 하고, 30204: 구역마다 값 개수가 같아야 한다.
      productOptionInfo: { optionMixType: tpl.p.optionMixType || 'SINGLE', optionList: [{ type: 'default', isRequire: 'Y', optionData }] },
    };
    const form = toFormData(body, [{ field: 'productImages', blob: image.blob, name: image.name }]);
    let created;
    try {
      created = (await client.request('POST', '/products', { form }))?.data;
    } catch (e) {
      if (!isAmbiguous(e)) throw e;
      log(`⚠ [자사몰] 등록 응답을 받지 못함(${e.message}) — 만들어졌는지 상품명으로 찾아봅니다`);
      // 목록에 늦게 보일 수 있고 목록 읽기도 실패할 수 있다 — 몇 번 다시 본다. 끝내 못 찾으면 '만들어졌을 수 있음'으로 멈춘다.
      let hit = null;
      for (let k = 0; k < 3 && !hit; k++) {
        if (k) await sleep(3000);
        try { hit = (await client.products(u.KRW)).filter(p => String(p.name) === title).sort((a, b) => b.prodNo - a.prodNo)[0]; }
        catch (le) { log(`⚠ [자사몰] 목록 읽기 실패(${le.message})`); }
      }
      if (!hit) throw new Error(`등록 응답을 받지 못했고(${e.message}) 목록에서도 찾지 못했습니다 — 상품이 숨김으로 만들어졌을 수 있습니다. 다시 등록하기 전에 아임웹 관리자에서 '${title}' 을 확인하세요.`);
      created = { prodNo: hit.prodNo };
    }
    const no = Number(created?.prodNo);
    if (!no) throw new Error('상품 생성 실패 — 상품번호를 받지 못했습니다');
    log(`[자사몰] 숨김으로 생성됨: 상품번호 ${no}`);

    // 여기부터는 상품이 있다 — 던지지 않고 문제를 모은다. 하나라도 있으면 판매중으로 바꾸지 않는다.
    const problems = [];
    if (created.failUploadImages?.length) problems.push(`대표 이미지 업로드 실패 (${created.failUploadImages.map(f => f.fileName).join(', ')})`);
    try { await setComboPrices(no, u, optionData, plan, problems); }
    catch (e) { problems.push(`조합 가격 설정 실패: ${e.message}`); }
    try { problems.push(...await verify(no, u, titles, plan, optionData, specKr, 'nosale')); }
    catch (e) { problems.push(`확인하려고 다시 읽지 못함: ${e.message}`); }
    // sent: 판매중 전환을 보냈고 숨김으로 되돌렸다고 확인하지 못했다 — 실제 상태가 판매중일 수 있다.
    let sent = false;
    if (!problems.length) {
      const setStatus = status => client.request('PATCH', `/products/${encodeURIComponent(no)}/status`, { body: { status } });
      try {
        sent = true;
        await setStatus('sale');
        // 판매중 전환이 조합가를 되돌린 적이 있다(imweb_b2b.js) — 전환 뒤 세 구역을 다시 읽고, 어긋나면 숨김으로 되돌린다.
        const after = await verify(no, u, titles, plan, optionData, specKr, 'sale');
        if (after.length) {
          problems.push(...after.map(p => `판매중 전환 뒤 ${p}`));
          await setStatus('nosale');
          sent = false;
        }
      } catch (e) { problems.push(`판매중 전환 · 확인 실패: ${e.message}`); }
    }
    if (problems.length) log(`⚠ [자사몰] ${no} 확인 결과가 다름: ${problems.join(' / ')}`);
    else log(`[자사몰] ✅ ${no} 세 구역 확인 완료 → 판매중`);
    const state = sent ? '판매중 전환을 보냈지만 확인하지 못했습니다 — 지금 상태를' : '숨김 상태입니다.';
    return { ok: !problems.length, no, title, warnings,
      error: problems.length ? `${problems.join(' / ')} (상품번호 ${no} — ${state} 아임웹 관리자에서 확인하세요)` : '' };
  }

  /** 중복 검사용: 한국 구역에서 이름에 [No.{코드}] · [No.{코드}(옵)] 와 한국 차종이 함께 든 상품. 전체를 읽으므로 complete 는 늘 true. */
  async function findExisting(data) {
    const code = codeOf(data), model = clean(data.titleModel || data.model);
    if (!code) return { rows: [], complete: true };
    const esc = code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('\\[No\\.\\s*' + esc + '\\s*(?:\\(옵\\))?\\]', 'i');
    // 차종은 경계를 보고 견준다(sameModel: X3 ≠ IX3, S5 ≠ RS5) — 이름의 '{브랜드} {차종}' 부분과.
    const carOfName = name => name.replace(/^옵틱글래스\s+/, '').replace(/\s*광각미러.*$/, '');
    const rows = (await client.products((await units()).KRW))
      .filter(p => re.test(String(p.name || '')) && (!model || sameModel(model, carOfName(String(p.name || ''))).match))
      .map(p => ({ prodNo: Number(p.prodNo), name: String(p.name || ''), status: p.prodStatus || '' }));
    return { rows, complete: true };
  }

  return { register, findExisting };
}
