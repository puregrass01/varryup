// 아마존 일본 등록용 초안 — 정규화 표 + 아마존 미국 실시간 조회로 일본어 초안을 만든다(검토용 CSV + 업로드용 TSV).
//
// 왜 필요한가 (2026-10)
//   BIL 자동 번역은 982건이 OGWM 브랜드 제한(5461)으로 실패했다. 브랜드가 풀린 뒤 같은 SKU 로
//   일본에 직접 등록해야 하므로, 일본어 제목·불릿·설명·엔화 가격·이미지·필수 속성을 미리 만들어 사람이 고쳐 둔다.
//   이 모듈은 아마존에 아무것도 보내지 않는다(읽기만 한다).
//   2026-10-19 초안 업로드에서 A-C 675건이 거부된 것은 문구 때문이 아니다 — 675건 모두
//   'このSKUはすでにカタログで公開されています' (BIL 로 일본 카탈로그에 이미 있는 SKU) 였다.
//
// 상품·이미지·가격은 한 SKU 로 잇는다(사용자 2026-10-21: 정규화 표 + 실시간 조회)
//   · 상품: data/amazon_listings.json (CSVdatabase/Amazon Listings - normalized.csv 의 앱용 사본) —
//     SKU·부모 SKU·상품번호·BSA·제조사·V2 차량. 부모 SKU(판매 단위 아님)는 초안에 넣지 않는다.
//   · 가격·재고·이미지·ASIN: 아마존 미국 실시간 조회(main_process 가 넣어 준다). 10-05 캐시는 쓰지 않는다.
//   · 메인 이미지: 미국 이미지 순서대로 보고 글자 없는 첫 사진(utils/image_text.js OCR). 글자 든 이미지는 추가 이미지로만.
//
// 일본어 표기는 앱의 정규화 사전 경로를 그대로 탄다
//   · V2 차량(정규화 표가 상품번호+영문 차종으로 이은 것) → 카탈로그 행(vehicle_catalog.json) → 영문 역조회 순서로
//     한글 브랜드·차종·세대를 찾고 vu-suggest.js 의 brandJa / modelJa / genJa (data/vehicle_i18n.json) 로 옮긴다.
//     셸이 아마존 JP 를 고를 때와 같은 함수·같은 일본 모드다. 조회 규칙을 여기서 다시 짜지 않는다.
//   · 사전에 없으면 지어내지 않고 비워 둔 뒤 '확인 필요' 에 적는다 (사전 _설명 의 원칙).
//
// 엔화 가격은 환율 자동 변경과 같은 규칙이다(utils/fx_pricing.js):
//   SKU 의 등급(저장된 연결 → 지금 미국 가격) 국내 기준가 ÷ 오늘 환율, 앞 두 자리만 남김.
//   초안은 등급 연결을 새로 저장하지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FX_SCOPES, findTier, fromKrw, rateProblem } from './utils/fx_pricing.js';
import { amazonImageUrls } from './utils/bulk_images.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export const JP_TITLE_MAX = 75;        // 2026-07-27 부터 아마존 일본 비미디어 상품명 권장 상한(넘으면 아마존이 고쳐 쓴다)
export const JP_HIGHLIGHT_MAX = 125;   // 商品のハイライト
export const BRAND = 'OGWM';           // 미국 리스팅 브랜드. 차량 제조사나 'Optic Glass' 를 넣으면 안 된다.
export const UPLOAD_ROWS_MAX = 999;    // 초안 업로드는 시트 1,000행(머리글 포함)까지 — 2026-10-19 '행 1,000개 제한' 오류

/** data/amazon_listings.json 의 리스팅 행(SKU 한 줄). */
export function loadAmazonListings(file = path.join(ROOT, 'data', 'amazon_listings.json')) {
  const listings = JSON.parse(fs.readFileSync(file, 'utf8')).listings;
  if (!Array.isArray(listings) || !listings.length) throw new Error('정규화 리스팅 표(data/amazon_listings.json)를 읽지 못했습니다.');
  return listings;
}

/**
 * vu-suggest.js 는 셸·iframe 이 <head> 에 싣는 브라우저 IIFE 다. 테스트(japan-mapping.test.mjs)와
 * 같은 최소 window/document 로 평가해서 같은 조회 함수를 쓴다.
 */
export function loadVehicleNames({ names, catalog, source } = {}) {
  const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
  const win = {};
  win.parent = win;   // 셸 문맥 → iframe 자동 IPC 로드 경로를 타지 않는다
  const doc = { addEventListener() {}, body: null, getElementById: () => null };
  new Function('window', 'document', source ?? read('src/ui/vu-suggest.js'))(win, doc);
  const vu = win.VUSuggest;
  const dict = names ?? JSON.parse(read('data/vehicle_i18n.json'));
  if (!vu.setNames(dict)) throw new Error('차량 명칭 사전(vehicle_i18n.json)을 읽지 못했습니다.');
  let cat = catalog;
  if (!cat) {
    cat = JSON.parse(read('data/vehicle_catalog.json'));
    const japan = path.join(ROOT, 'data', 'japan_vehicle_catalog.json');
    if (fs.existsSync(japan)) cat.japan = JSON.parse(fs.readFileSync(japan, 'utf8'));
  }
  vu.setVehicleCatalog(cat);
  vu.setJapanMode(true);   // 셸이 일본(ja) 마켓을 켰을 때와 같다
  return { vu, dict, catalog: cat };
}

const enKey = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const hasHangul = s => /[가-힣]/.test(String(s ?? ''));
const chars = s => [...String(s ?? '')].length;

/** 영문 브랜드·차종으로 사전을 거꾸로 찾는다. 하나로 정해질 때만 값을 준다. */
export function reverseLookup(dict) {
  const brandByEn = new Map();
  for (const [key, b] of Object.entries(dict.brands || {})) if (b?.en) brandByEn.set(enKey(b.en), key);
  return {
    brand(en) {
      const key = brandByEn.get(enKey(en));
      return key ? { key, jp: dict.brands[key].jp || null } : null;
    },
    model(brandKey, en) {
      const hits = [...new Set(Object.values(dict.models?.[brandKey] || {})
        .filter(m => enKey(m?.en) && enKey(m.en) === enKey(en)).map(m => m.jp).filter(Boolean))];
      return hits.length === 1 ? hits[0] : hits.length ? undefined : null;   // undefined = 후보 여럿
    },
  };
}

// 이베이 표의 영문 연식 글('2nd gen 18- BSA', '1st gen (early model)')에서 세대·연식을 뽑는다.
// 세대 낱말은 사전 generationTokens 의 일본어를 쓴다(세대→世代, 전기형→前期型 …).
const EN_GEN_WORDS = [['early model', '전기형'], ['late model', '후기형'], ['mid model', '중기형'], ['facelift', '페이스리프트']];
function genFromYearText(text, dict) {
  const tokens = dict.generationTokens || {};
  let rest = String(text ?? '').replace(/\bBSA\b/gi, ' ').trim();
  let gen = '';
  const m = rest.match(/^((?:\d+(?:\.\d+)?(?:st|nd|rd|th)?\s*,\s*)*\d+(?:\.\d+)?(?:st|nd|rd|th))\s*gen\b/i);
  if (m) {
    gen = m[1].replace(/(st|nd|rd|th)/gi, '').replace(/\s+/g, '') + (tokens['세대'] || '世代');
    rest = rest.slice(m[0].length).trim();
  }
  for (const [en, ko] of EN_GEN_WORDS) {
    const re = new RegExp(`\\(?\\b${en}\\b\\)?`, 'i');
    if (re.test(rest) && tokens[ko]) { gen = [gen, tokens[ko]].filter(Boolean).join(' '); rest = rest.replace(re, ' ').trim(); }
  }
  const year = (rest.match(/^\d{2}(?:[-~]\d{2})?[-~]?$/) || [''])[0];
  if (year) rest = '';
  return { gen, year, unknown: rest.replace(/\s+/g, ' ').trim() };
}

// 카탈로그 연식 칸에도 '16~현재' 처럼 한글 낱말이 있다. 세대와 같은 사전 토큰(현재→現在)으로만 옮긴다.
function yearJa(year, dict) {
  const tokens = Object.entries(dict.generationTokens || {}).sort((a, b) => b[0].length - a[0].length);
  let out = String(year ?? '');
  for (const [ko, ja] of tokens) out = out.split(ko).join(ja);
  return out;
}

// 차량코드 칸의 한글 메모('P415 (직사각타입)', 'CU/CP / 브라켓이 2종류', '영국형')는 사전에 없다.
// 연식처럼 사전 토큰만 옮기고, 그래도 한글이 남은 괄호·'/' 조각·낱말은 지어내지 않고 뺀다.
function codeJa(code, dict) {
  const out = yearJa(code, dict);
  if (!hasHangul(out)) return out;
  return out.replace(/\s*\([^()]*[가-힣][^()]*\)/g, ' ')
    .split('/').map(part => part.split(/\s+/).filter(w => w && !hasHangul(w)).join(' ')).filter(Boolean).join('/');
}

// 코드표가 같은 차종의 미러 형태를 가르려고 붙인 꼬리표('어코드-A', '캠리 -D', 'A8-A', '브롱코(normal)').
// 'ATS-V'·'CEVO-C' 같은 진짜 차종명은 하이픈 앞이 영문이라 남는다.
export const untag = s => String(s ?? '').replace(/(?:(?<=[가-힣ァ-ヶー\d])|\s+)-\s*[A-Z]$|\s*\([a-z]+\)$/, '').trim();

// 품번은 미국 상품명의 '[No.1118-1]' 이 SKU 마다 맞다. 카탈로그 no 는 한 행에 묶인 SKU 끼리 같다(11181·1118 → 1118).
const partNoOf = (item, v, listing) =>
  (String(item.name ?? '').match(/\[No\.\s*([A-Za-z]?\d+(?:-\d+)?)\]/i) || [])[1] || v?.no || listing?.no || '';

const countBy = list => {
  const m = new Map();
  for (const k of list) if (k) m.set(k, (m.get(k) || 0) + 1);
  return m;
};

/** 셸 buildTitle 과 같은 규칙: 세대 칸이 연식을 품고 있으면 연식을 또 붙이지 않는다. */
const yearUnlessIn = (year, gen) => (year && String(gen || '').includes(year)) ? '' : year;

// 차 부분('ヒョンデ グレンジャー 7世代 22.11-現在 GN7'). 연식 범위의 '~' 는 '-' 로 쓴다 — 아마존 AI 가 쓴(승인된)
// 제목 400건에 '~' 는 0건이고, 장식 기호로 걸러질 수 있다(2026-10-21).
// 칸마다 바꾼다 — 다 이은 뒤 바꾸면 열린 연식('19.10~')이 뒤 칸과 붙어 '19.10-C8' 처럼 범위로 읽힌다.
// 사전 차종이 브랜드로 시작하면('シトロエン DS5') 브랜드를 한 번만 쓴다.
const carText = ({ brand, model, gen, year, code }) => {
  const own = brand && model && String(model).startsWith(brand + ' ') ? String(model).slice(brand.length + 1) : model;
  return [brand, own, gen, yearUnlessIn(year, gen), code].filter(Boolean).map(v => String(v).replace(/\s*~\s*/g, '-')).join(' ');
};

/**
 * 일본어 상품명: 'OGWM {차}用 ヒーター付き広角ミラーガラス [BSA対応] [No.x] 左右セット'.
 * 아마존 AI 제목처럼 '用' 을 차 뒤에 붙인다. BSA対応 은 같은 차의 BSA·일반 SKU 를, no(품번)는 같은 제목이
 * 여러 SKU 에 생길 때 가른다(buildJpDraft). 75자를 넘으면 左右セット → ヒーター付き 순서로 뺀다.
 * 차 부분·BSA·품번은 줄이지 않는다(그래도 넘으면 buildJpDraft 가 '확인 필요' 에 적는다).
 */
export function jpTitle({ brand, model, gen, year, code, bsa, no }) {
  const car = carText({ brand, model, gen, year, code });
  const title = (noun, set) => [`${BRAND} ${car}用`, noun, bsa && 'BSA対応', no && `No.${no}`, set && '左右セット'].filter(Boolean).join(' ');
  const tries = [['ヒーター付き広角ミラーガラス', true], ['ヒーター付き広角ミラーガラス', false], ['広角ミラーガラス', false]];
  return tries.map(([noun, set]) => title(noun, set)).find(t => chars(t) <= JP_TITLE_MAX) || title('広角ミラーガラス', false);
}

// 불릿·설명은 미국 리스팅에 있는 사실만 쓴다: 광각·곡률로 사각 감소, 순정 디자인에 맞춘 쉬운 장착, 발수 코팅,
// BSA 각인(BSA SKU), 고품질 소재, 열선(미국 상품명 972/972 'Heated'). 크롬 코팅·'순정과 같은 기능' 은 근거가 없어 뺐다.
// 첫 불릿과 설명 첫 문장에 차를 넣는다 — 아마존 AI 초안은 400건 중 395건이 첫 불릿에 차를 적었다(우리 것은 0건).
const HIGHLIGHT = '撥水コーティング';   // 제목에 없는 짧은 말 — 하이라이트는 문장이 아니라 짧은 구(템플릿 설명)
const bulletsOf = (car, bsa) => [
  `適合車種：${car}専用に設計された交換用ドアミラーガラスです。左右セットで、両側を同時に交換できます。`,
  '広角ビュー：最適な曲率で設計した凸面ミラーが死角を減らし、後方と側方を広く見渡せます。',
  'ヒーター機能：内蔵ヒーターがミラーの曇りや霜を取り除き、雨の日や寒い日もクリアな視界を保ちます。',
  bsa ? 'BSA対応：刻印加工により、ブラインドスポットアシスト（BSA）の警告灯がミラー越しに見えます。'
    : '撥水コーティング：撥水コーティングにより、雨の日や濡れた状態でもクリアな視界を保ちます。',
  '簡単取り付け：純正ミラーのデザインに合わせて作られており、今のミラーガラスと差し替えるだけで取り付けできます。取り付け前に適合車種と年式をご確認ください。',
];
const descriptionOf = (car, bsa) => [
  `${car}専用の広角ドアミラーガラス（左右セット）です。`,
  '最適な曲率で設計した凸面ミラーが死角を大幅に減らし、周囲を広く見渡せます。',
  '内蔵ヒーターがミラーの曇りや霜を取り除きます。',
  '純正ミラーのデザインに合わせて作られているため取り付けが簡単で、車の外観もそのまま保てます。',
  '撥水コーティングにより、雨の日や濡れた状態でもクリアな視界を保ちます。',
  bsa && '刻印加工で、BSA（ブラインドスポットアシスト）センサーの警告灯をミラー越しに確認できます。',
  '高品質な素材を使用しており、長距離の運転でも安定した性能を発揮します。',
].filter(Boolean).join('');

/** 미국 가격 → 엔화(등급 기준가 ÷ 환율, 앞 두 자리). 계산 못 하면 이유를 준다. */
function jpyPricer({ fx, snapshot }) {
  const problem = snapshot ? rateProblem(snapshot) : '환율을 불러오지 못했습니다.';
  const tiers = fx?.tiers || [];
  const byId = new Map(tiers.map(t => [t.id, t]));
  const assigned = fx?.assignments || {};
  return (sku, usd) => {
    if (problem) return { error: problem };
    // fx_auto_price.js tierBook.find 와 같은 순서: 저장된 일본 연결 → 지금 미국 가격 → 다른 몰 연결
    let tier = byId.get(assigned['amazon-jp:' + sku]?.tier) || null;
    if (!tier && Number(usd) > 0) tier = findTier(Number(usd), FX_SCOPES['amazon-us'].currency, snapshot, tiers);
    for (const scope of Object.keys(FX_SCOPES)) if (!tier) tier = byId.get(assigned[scope + ':' + sku]?.tier) || null;
    if (!tier) return { error: '가격 등급을 찾지 못함' };
    return { tier, jpy: fromKrw(tier.krw, 'JPY', snapshot) };
  };
}

/**
 * SKU 마다 메인 이미지를 고른다: 미국 이미지 순서대로 보고 글자 없는(hasText === false) 첫 사진.
 * 글자가 든 이미지·판별 못 한 이미지(null)는 추가 이미지로만 쓴다 — 아마존 메인 이미지는 글자·로고·워터마크가 없어야 한다.
 * OCR 은 아직 메인이 없는 SKU 의 다음 후보만 한 번에 묶어 부른다(같은 URL 은 한 번만).
 * @param list   [{ sku, urls }] — urls 는 amazonImageUrls(미국 실시간 상품): [메인, 추가1..8]
 * @param detect urls → [{ url, hasText, text, error? }] (utils/image_text.js detectUrlText)
 * @returns Map sku → { main, others, checked: [{ url, hasText, text, error? }] }
 */
export async function pickMainImages(list, detect, onRound = () => {}) {
  const state = list.map(x => ({ sku: x.sku, urls: [...new Set((x.urls || []).filter(Boolean))], next: 0, main: '', checked: [] }));
  for (let round = 1; ; round++) {
    const pending = state.filter(s => !s.main && s.next < s.urls.length);
    if (!pending.length) break;
    const urls = [...new Set(pending.map(s => s.urls[s.next]))];
    onRound(round, urls.length);
    const found = new Map((await detect(urls)).map(r => [r.url, r]));
    for (const s of pending) {
      const url = s.urls[s.next++], r = found.get(url) || { url, hasText: null, text: '' };
      s.checked.push(r);
      if (r.hasText === false) s.main = url;
    }
  }
  return new Map(state.map(s => [s.sku, { main: s.main, others: s.urls.filter(u => u !== s.main).slice(0, 8), checked: s.checked }]));
}

// V2 차량의 세대 칸은 연식을 품는다('1세대 11.03~19.03', '1세대 전기형 05.06~07.05', '3세대').
const isComplete = car => !!(car && (car.brand || car.makerInModel) && car.model);
// 4자리 연도('2001~2004')·일 단위('22.11.14~')·'2018 .04 ~' 도 받고, 숫자 한가운데서 자르지 않는다.
// 엑셀이 날짜로 바꾼 칸의 시간 꼬리(' 00:00:00')는 뺀다. 여러 줄 글은 한 줄로 편다(부르는 쪽이 메모를 단다).
const flat = s => String(s ?? '').replace(/\s+/g, ' ').trim();
const splitGen = text => {
  const t = flat(text).replace(/\s+\d{2}:\d{2}:\d{2}$/, '');
  const m = t.match(/^(.*?)\s*((?<![\d.])\d{2}(?:\d{2})?(?:\s*\.\s*\d{1,2})*\s*[~-].*)?$/);
  return { gen: (m?.[1] || '').trim(), year: (m?.[2] || '').replace(/\s*\.\s*/g, '.').trim() };
};
// 정규화 표의 차대 칸은 미국 연식 글에서 뽑은 것이라 숫자만 남은 찌꺼기('15'·'19')가 있다 — 그런 칸은 버린다.
const chassisOf = n => (/^\d{1,4}$/.test(flat(n?.chassis)) ? '' : flat(n?.chassis));
// 연식의 첫 해(두 자리 → 19xx/20xx). 카탈로그 행이 정규화 표와 다른 차인지 볼 때만 쓴다.
const firstYear = s => { const m = flat(s).match(/(?<!\d)(\d{4}|\d{2})(?!\d)/); if (!m) return null; const y = Number(m[1].slice(-2)); return y < 50 ? 2000 + y : 1900 + y; };
const chassisTokens = s => new Set(flat(s).toUpperCase().split(/[\s/,()]+/).filter(t => /[A-Z]/.test(t) && t.length >= 2));

/**
 * @param items    [{ sku, asin, name(미국 상품명), price, stock, productType, live, images, listing }]
 *                   live: 미국 실시간 조회에 있었는지(false 면 '미국 리스팅 없음'). images: pickMainImages 의 값.
 *                   listing: data/amazon_listings.json 의 행(상품번호·BSA·부모·V2 차량). sku 대신 id 도 받는다.
 * @param names    loadVehicleNames() 결과 { vu, dict, catalog }
 * @param fx       FxPriceStore.read() — { tiers, assignments }
 * @param snapshot 환율(currency-rates-get 의 data). 없으면 엔화 칸을 비운다.
 */
export function buildJpDraft({ items, names, fx, snapshot }) {
  const { vu, dict, catalog } = names;
  const variantsBySku = new Map();
  // 미국 SKU 는 아마존 SKU 다 — 이베이 SKU(v.skus)와 다른 차가 있어 아마존 쪽(v.amazonSkus)을 먼저 본다.
  for (const v of catalog.variants || []) for (const sku of new Set([...(v.amazonSkus || []), ...(v.skus || [])])) {
    if (!variantsBySku.has(sku)) variantsBySku.set(sku, []);
    variantsBySku.get(sku).push(v);
  }
  const reverse = reverseLookup(dict);
  const price = jpyPricer({ fx, snapshot });

  const sorted = [...items].map(i => ({ ...i, sku: String(i.sku ?? i.id ?? '') })).sort((a, b) => a.sku.localeCompare(b.sku));
  const drafts = sorted.map(item => {
    const { sku } = item, n = item.listing || null;
    const notes = [];
    const listing = vu.listing(sku);
    const variants = variantsBySku.get(sku) || [];
    const v2 = n?.vehicles?.[0];
    // 차 이름 후보: V2 차량(정규화 표의 링크) → 카탈로그 행 → 정규화 표의 영문 차종 → 이베이 표 영문 역조회.
    // 일본어(브랜드·차종)가 다 갖춰진 첫 후보를 쓰고, 하나도 없으면 첫 후보의 빈칸 사유를 적는다.
    const fromV2 = () => {
      // 정규화 표가 상품번호 + 영문 차종으로 이은 V2 차량. 한글 키가 사전(vehicle_i18n.json, V2 에서 만든 것)과 같다.
      // V2 세대 칸의 홀로 남은 'no.'(2026-10-21 AU0201N404 '2세대 no.')는 버린다.
      const out = [], g = splitGen(String(v2.gen ?? '').replace(/(^|\s)no\.(?=\s|$)/gi, ' '));
      if (n.vehicles.length > 1) out.push(`V2 차량 ${n.vehicles.length}개에 이어진 SKU — 세대·연식 확인`);
      if (/\n/.test(`${v2.gen}${v2.option}`)) out.push(`V2 세대·차량코드 칸이 여러 줄 — 확인: ${flat(v2.gen)} / ${flat(v2.option)}`);
      // 코드표 꼬리표('브롱코(normal)')는 카탈로그 후보처럼 뗀다.
      const car = { brand: vu.brandJa(n.maker), model: untag(vu.modelJa(n.maker, untag(v2.model)) || vu.modelJa(n.maker, v2.model)) || null,
        gen: g.gen ? codeJa(vu.genJa(g.gen), dict) : '', year: codeJa(g.year, dict), code: codeJa(chassisOf(n) || flat(v2.option), dict) };
      // V2 세대 칸의 한글 메모('(미국직수입)'·'(쿠페 가능)')는 차량코드처럼 뺀다 — 사전에 없다.
      if (car.year !== yearJa(g.year, dict)) out.push(`연식 한글 메모 뺌: ${g.year}`);
      if (!car.brand) out.push(`브랜드 일본어 없음: ${n.maker}`);
      if (!car.model) out.push(`차종 일본어 없음: ${n.maker} ${v2.model}`);
      if (g.gen && !car.gen) out.push(`세대 일본어 없음: ${g.gen}`);
      return { source: 'V2 차량', car, notes: out };
    };
    const catalogConflict = v => {
      if (!n) return '';
      const a = chassisTokens(chassisOf(n)), b = chassisTokens(v.code);
      if (a.size && b.size && ![...a].some(t => b.has(t))) return 'chassis';
      const y1 = firstYear(n.years), y2 = firstYear(v.year);
      return y1 && y2 && Math.abs(y1 - y2) > 3 ? 'year' : '';
    };
    const fromCatalog = () => {
      const v = variants[0], out = [];
      const clash = catalogConflict(v);
      if (clash) return { source: '카탈로그', car: null, conflict: true,
        notes: [`카탈로그 차량(${[v.model, v.gen, v.year, v.code].filter(Boolean).join(' ')})이 정규화 표(${[n.years, chassisOf(n)].filter(Boolean).join(' ')})와 다름`] };
      if (variants.length > 1) out.push(`차량 행 ${variants.length}개에 이어진 SKU — 세대·연식 확인`);
      // 코드표 '기타' 브랜드는 차종 칸에 제조사가 들어 있다('마쯔다 CX-9') — その他 를 제목에 넣지 않는다.
      const makerInModel = vu.brandEn(v.brand) === 'Others';
      const car = { brand: makerInModel ? '' : vu.brandJa(v.brand),
        model: vu.modelJa(v.brand, untag(v.model)) || untag(vu.modelJa(v.brand, v.model)) || null,
        gen: v.gen ? vu.genJa(v.gen) : '', year: yearJa(v.year, dict), code: codeJa(v.code, dict), makerInModel };
      if (!car.brand && !makerInModel) out.push(`브랜드 일본어 없음: ${v.brand}`);
      if (!car.model) out.push(`차종 일본어 없음: ${v.brand} ${v.model}`);
      if (v.gen && !car.gen) out.push(`세대 일본어 없음: ${v.gen}`);
      if (car.code !== yearJa(v.code, dict)) out.push(`차량코드 한글 메모 뺌: ${v.code}`);
      return { source: '카탈로그', car, notes: out };
    };
    const fromNormalized = () => {
      // 정규화 표의 한글 제조사 + 영문 차종으로 사전을 거꾸로 찾는다. 세대는 서수(1·2)뿐이다.
      const out = [], en = n.subModel || n.modelEn, brandEn = String(dict.brands?.[n.maker]?.en || '');
      const bare = brandEn && en.toLowerCase().startsWith(brandEn.toLowerCase() + ' ') ? en.slice(brandEn.length + 1) : '';
      const lookup = name => (dict.models?.[n.maker] ? reverse.model(n.maker, name) : null);
      const model = lookup(en) || (bare ? lookup(bare) : null) || lookup(en);
      const car = { brand: vu.brandJa(n.maker), model: model || null,
        gen: n.gens?.length ? n.gens.join('/') + (dict.generationTokens?.['세대'] || '世代') : '', year: yearJa(n.years, dict), code: codeJa(chassisOf(n), dict) };
      if (!car.brand) out.push(`브랜드 일본어 없음: ${n.maker}`);
      if (model === undefined) out.push(`차종 일본어 후보 여러 개: ${n.maker} ${en}`);
      else if (!car.model) out.push(`차종 일본어 없음: ${n.maker} ${en}`);
      return { source: '정규화 영문', car, notes: out };
    };
    const fromListing = () => {
      const out = [], b = reverse.brand(listing.brandEn);
      const model = b ? reverse.model(b.key, listing.modelEn) : null;
      const g = genFromYearText(listing.yearText, dict);
      const car = { brand: b?.jp || null, model: model || null, gen: g.gen, year: g.year, code: '' };
      if (!car.brand) out.push(`브랜드 일본어 없음: ${listing.brandEn}`);
      if (model === undefined) out.push(`차종 일본어 후보 여러 개: ${listing.brandEn} ${listing.modelEn}`);
      else if (!car.model) out.push(`차종 일본어 없음: ${listing.brandEn} ${listing.modelEn}`);
      if (g.unknown) out.push(`세대·연식 해석 못 함: ${listing.yearText}`);
      out.push('차량코드 없음(카탈로그 행에 안 이어짐)');
      return { source: '영문 역조회', car, notes: out };
    };
    const all = [v2 && fromV2, variants.length && fromCatalog, n && fromNormalized, listing && fromListing].filter(Boolean).map(f => f());
    const tries = all.filter(t => !t.conflict);
    const picked = tries.find(t => isComplete(t.car)) || tries[0];
    if (!isComplete(picked?.car)) for (const t of all) if (t.conflict) notes.push(...t.notes);
    const car = picked?.car || null, source = picked?.source || '';
    notes.push(...(picked ? picked.notes : ['차량을 찾지 못한 SKU — 제목·불릿을 직접 입력']));

    // BSA·품번은 정규화 표가 정본이다. 표에 없는 SKU 만 예전처럼 이베이 표·미국 상품명에서 읽는다.
    const bsa = n ? !!n.bsa : !!listing?.bsa;
    const complete = isComplete(car);
    const usd = String(item.price ?? '').trim();
    if (item.live === false) notes.push('미국 리스팅 없음(실시간 조회)');
    // 일본에 이미 있는 SKU 는 초안 업로드가 받지 않는다(2026-10-19 A-C 675건 'すでにカタログで公開されています').
    if (item.onJp) notes.push('일본에 이미 있는 SKU — 초안 업로드 불가(기존 리스팅 수정 필요)');
    for (const issue of n?.issues || []) notes.push('정규화 표: ' + issue);
    if (n?.asin && item.asin && n.asin !== item.asin) notes.push(`ASIN 다름: 정규화 ${n.asin} · 미국 ${item.asin}`);
    const p = price(sku, usd);
    if (p.error) notes.push(`엔화 가격: ${p.error}`);
    else if (n && /BSA/i.test(p.tier.label || '') !== bsa) notes.push(`BSA 여부(${bsa ? 'O' : 'X'})와 가격 등급(${p.tier.label || p.tier.id}) 다름`);

    const img = item.images || null;
    if (!img?.main) notes.push(img?.checked?.length ? '글자 없는 메인 이미지 없음 — 직접 고르기' : '이미지 없음');
    const car2 = complete ? carText(car) : '';

    return {
      car: complete ? car : null, partNo: n?.no || partNoOf(item, variants[0], listing), notes,
      row: {
        sku, parentSku: n?.parentSku || '', partNo: n?.no || partNoOf(item, variants[0], listing),
        asin: item.asin || '', usTitle: item.name || '', brand: BRAND,
        makerJa: car?.brand || '', modelJa: car?.model || '', genJa: car?.gen || '', year: car?.year || '', code: car?.code || '',
        bsa,
        highlight: complete ? HIGHLIGHT : '',
        bullets: complete ? bulletsOf(car2, bsa) : ['', '', '', '', ''],
        description: complete ? descriptionOf(car2, bsa) : '',
        usd, tier: p.tier ? (p.tier.label || p.tier.id) + ` (${p.tier.krw.toLocaleString('ko-KR')}원)` : '',
        jpy: p.jpy || '', stock: String(item.stock ?? ''),
        productType: item.productType || (n || listing || variants.length ? 'VEHICLE_MIRROR' : ''),
        mainImage: img?.main || '', otherImages: img?.others || [],
        imageText: (img?.checked || []).filter(c => c.hasText !== false)
          .map(c => (c.hasText === null ? '판별 못 함' : '글자') + (c.text || c.error ? ': ' + (c.text || c.error) : '')).join(' / '),
        live: item.live !== false, onJp: !!item.onJp,
        source,
      },
    };
  });

  // 같은 차·다른 미러라 제목이 같아진 SKU 는 품번(No.)을 넣어 가른다 — 구매자가 어느 것인지 골라야 한다.
  // 품번까지 같은 묶음(한 미러를 세대별로 따로 올린 것)은 넣어도 못 가르니 그대로 두고 확인 필요로 넘긴다.
  const titleOf = (d, no) => d.car ? jpTitle({ ...d.car, bsa: d.row.bsa, no }) : '';
  const partNos = new Map();   // 품번 없는 제목 → 그 제목을 쓰는 SKU 들의 품번
  for (const d of drafts) if (d.car) partNos.set(titleOf(d), (partNos.get(titleOf(d)) || new Set()).add(d.partNo));
  const titles = drafts.map(d => partNos.get(titleOf(d))?.size > 1 && d.partNo ? titleOf(d, d.partNo) : titleOf(d));
  const same = countBy(titles);
  const rows = drafts.map(({ row, notes }, i) => {
    const title = titles[i];
    if (same.get(title) > 1) notes.push(`같은 상품명 ${same.get(title)}건 — 구분 정보를 직접 넣기`);
    if (title && chars(title) > JP_TITLE_MAX) notes.push(`상품명 ${chars(title)}자 — ${JP_TITLE_MAX}자 이하로 줄이기`);
    if (hasHangul(title)) notes.push('상품명에 한글이 남음');
    // 업로드 TSV 에 넣는 줄: 제목·엔화·메인 이미지가 있고, 실시간 조회에 있었고, 확인 필요 메모가 없다
    // (제목 겹침·길이·한글·ASIN·BSA/등급·여러 차량·일본에 이미 있음·정규화 표 Issues 모두 메모로 남는다).
    // 지어내지 않은 것을 덜어낸 정보성 메모(한글 메모 뺌·차량코드 없음)는 막지 않는다.
    const blocking = notes.filter(x => !/한글 메모 뺌|^차량코드 없음\(카탈로그 행에 안 이어짐\)$/.test(x));
    const ready = !!(title && row.jpy && row.mainImage && row.live && !blocking.length);
    return { ...row, title, titleLength: title ? chars(title) : '', ready, notes: notes.join(' / ') };
  });

  const summary = {
    total: rows.length,
    titled: rows.filter(r => r.title).length,
    priced: rows.filter(r => r.jpy).length,
    mainImage: rows.filter(r => r.mainImage).length,
    ready: rows.filter(r => r.ready).length,
    needsReview: rows.filter(r => r.notes).length,
    overLength: rows.filter(r => Number(r.titleLength) > JP_TITLE_MAX).length,
    onJp: rows.filter(r => r.onJp).length,
    warrantyMissing: !WARRANTY,   // 필수(warranty_description) — 비어 있으면 화면이 알린다
  };
  for (const r of rows) if (chars(r.highlight) > JP_HIGHLIGHT_MAX) throw new Error(`하이라이트가 ${JP_HIGHLIGHT_MAX}자를 넘습니다: ${r.sku}`);
  return { rows, summary };
}

const HEADER = ['SKU', '부모 SKU', '상품번호', '미국 ASIN', '미국 상품명', '브랜드', '제조사(日)', '차종(日)', '세대(日)', '연식', '차량코드', 'BSA',
  '일본어 상품명', '상품명 글자수', '제품 하이라이트', '불릿1', '불릿2', '불릿3', '불릿4', '불릿5', '상품 설명',
  '미국 판매가(USD)', '가격 등급', '일본 판매가(JPY)', '재고', '상품 유형', '메인 이미지', '추가 이미지', '이미지 글자 판별',
  '일본어 출처', '업로드', '확인 필요'];

/** 검토용 CSV. 엑셀이 한글·일본어를 깨지 않게 BOM 을 붙이고, 줄바꿈이 든 칸은 따옴표로 감싼다. */
export function draftCsv(rows) {
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = rows.map(r => [r.sku, r.parentSku, r.partNo, r.asin, r.usTitle, r.brand, r.makerJa, r.modelJa, r.genJa, r.year, r.code, r.bsa ? 'O' : '',
    r.title, r.titleLength, r.highlight, ...r.bullets, r.description, r.usd, r.tier, r.jpy, r.stock, r.productType,
    r.mainImage, (r.otherImages || []).join(' | '), r.imageText, r.source, r.ready ? 'O' : '', r.notes].map(q).join(','));
  return '﻿' + [HEADER.map(q).join(','), ...lines].join('\r\n');
}

// ── 업로드용 TSV ──────────────────────────────────────────────────────────
// 아마존 일본 VEHICLE_MIRROR 템플릿(2026-10-19 초안 xlsm 'テンプレート' 5행)의 속성 키가 머리글이다 — 한글 머리글을
// 아마존 AI 가 짐작해 옮기지 않게 한다. 값은 그 템플릿 드롭다운의 표기다.
// 사용자 2026-10-21: 원산국 大韓民国, 재고는 미국 재고 그대로. 2026-10-19 VALIDATION_PREVIEW(jp_5461_check.mjs)가 요구한
// 필수: list_price · model_name · warranty_description · distribution_designation · included_components ·
// is_exclusive_product · automotive_fit_type. 아마존 AI 초안은 fit_type 에 목록 밖 값(車種専用フィット)을 넣었다 — 車種限定フィット.
export const WARRANTY = '6ヶ月保証';   // 필수(保証内容) — 사용자 2026-10-21: 6개월
const MP = '[marketplace_id=A1VC38T7YXB528]', JA = '[language_tag=ja_JP]';
const UPLOAD = [
  ['::record_action', () => 'フルアップデート'],
  ['contribution_sku#1.value', r => r.sku],
  ['product_type#1.value', r => r.productType],
  [`item_name${MP}${JA}#1.value`, r => r.title],
  [`title_differentiation${MP}${JA}#1.value`, r => r.highlight],
  [`brand${MP}${JA}#1.value`, () => BRAND],
  [`condition_type${MP}#1.value`, () => '新品'],
  ['amzn1.volt.ca.product_id_type', () => 'GTIN免除'],   // 일본 계정 GTIN 면제 승인됨(사용자 2026-10-21)
  [`recommended_browse_nodes${MP}#1.value`, () => '14616429051'],   // 車用交換ミラーグラス
  [`model_number${MP}#1.value`, r => r.partNo ? 'No.' + r.partNo : ''],
  [`model_name${MP}${JA}#1.value`, r => r.partNo ? 'No.' + r.partNo : ''],
  [`manufacturer${MP}${JA}#1.value`, () => BRAND],
  [`main_product_image_locator${MP}#1.media_location`, r => r.mainImage],
  ...Array.from({ length: 8 }, (_, i) => [`other_product_image_locator_${i + 1}${MP}#1.media_location`, r => r.otherImages?.[i] || '']),
  [`product_description${MP}${JA}#1.value`, r => r.description],
  ...Array.from({ length: 5 }, (_, i) => [`bullet_point${MP}${JA}#${i + 1}.value`, r => r.bullets[i]]),
  [`special_feature${MP}${JA}#1.value`, () => '加熱'],
  [`special_feature${MP}${JA}#2.value`, () => '広角'],
  [`material${MP}${JA}#1.value`, () => 'ガラス'],
  [`number_of_items${MP}#1.value`, () => '2'],
  [`part_number${MP}#1.value`, r => r.sku],
  [`fit_type${MP}${JA}#1.value`, () => '車種限定フィット'],
  [`distribution_designation${MP}#1.value`, () => '正規品'],
  [`is_exclusive_product${MP}#1.value`, () => 'いいえ'],
  [`auto_part_position${MP}#1.value`, () => '左'],
  [`auto_part_position${MP}#2.value`, () => '右'],
  [`included_components${MP}${JA}#1.value`, () => '左側ミラーガラス'],
  [`included_components${MP}${JA}#2.value`, () => '右側ミラーガラス'],
  [`lens_curvature_description${MP}${JA}#1.value`, () => '凸面'],
  [`automotive_fit_type${MP}#1.value`, () => '車種専用フィット'],
  [`list_price${MP}#1.value`, r => r.jpy],
  ['fulfillment_availability#1.fulfillment_channel_code', () => '出品者出荷（デフォルト）'],
  ['fulfillment_availability#1.quantity', r => r.stock],
  [`purchasable_offer${MP}[audience=ALL]#1.our_price#1.schedule#1.value_with_tax`, r => r.jpy],
  [`country_of_origin${MP}#1.value`, () => '大韓民国'],
  [`warranty_description${MP}${JA}#1.value`, () => WARRANTY],
  [`batteries_required${MP}#1.value`, () => 'いいえ'],
  [`supplier_declared_dg_hz_regulation${MP}#1.value`, () => '該当なし'],
];
export const UPLOAD_KEYS = UPLOAD.map(([key]) => key);

/**
 * 업로드용 TSV(아마존 '스프레드시트 업로드'). 검토를 마친(ready) 줄만, 999줄씩 나눈다(머리글 포함 1,000행 제한).
 * UTF-8 BOM 없음 · 탭 구분 · 칸 안의 탭·줄바꿈은 공백으로 — 2026-10-19 '열이 1개만 포함' 오류가 칸 안 줄바꿈 때문이었다.
 * @returns string[] 파일 내용(나눈 조각마다 하나). ready 줄이 없으면 빈 배열.
 */
export function draftTsv(rows) {
  const ready = rows.filter(r => r.ready), parts = [];
  for (let i = 0; i < ready.length; i += UPLOAD_ROWS_MAX) {
    const body = ready.slice(i, i + UPLOAD_ROWS_MAX).map(r => { const rec = uploadRecord(r); return UPLOAD_KEYS.map(k => rec[k]).join('\t'); });
    parts.push([UPLOAD_KEYS.join('\t'), ...body].join('\r\n') + '\r\n');
  }
  return parts;
}

/** 한 줄의 업로드 값 { 템플릿 속성 키: 값 } — 칸 안의 탭·줄바꿈은 공백으로. 템플릿 엑셀에 옮겨 넣을 때도 쓴다. */
export function uploadRecord(r) {
  const cell = v => String(v ?? '').replace(/[\t\r\n]+/g, ' ').trim();
  return Object.fromEntries(UPLOAD.map(([key, value]) => [key, cell(value(r))]));
}

const US_MARKET = 'ATVPDKIKX0DER', JP_MARKET = 'A1VC38T7YXB528';
/**
 * 초안 전체 흐름(앱의 'amazon-jp-draft' 와 사람이 돌리는 스크립트가 같이 쓴다). 아마존에는 읽기만 한다.
 *   정규화 표 → 판매 단위(부모 SKU 제외) → 미국 실시간 조회(가격·재고·이미지·ASIN) → 일본에 이미 있는 SKU(한 건씩)
 *   → 메인 이미지(글자 없는 첫 사진) → buildJpDraft.
 * 일본 조회·OCR 이 통째로 실패해도 초안은 만든다 — 실패 이유는 jpError · ocrError 로 돌려준다.
 * @param amazon  Amazon 인스턴스(loadConfig 된 것)
 * @param detect  urls → [{ url, hasText, text, error? }] (utils/image_text.js detectUrlText)
 */
export async function makeJpDraft({ amazon, names, fx, snapshot, detect, listings = loadAmazonListings(), progress = () => {} }) {
  const parents = new Set(listings.map(l => l.parentSku).filter(Boolean));
  const children = listings.filter(l => !parents.has(l.sku));   // 부모 SKU 는 판매 단위가 아니라 초안에 넣지 않는다
  const skus = children.map(l => l.sku);
  progress(`아마존 미국 현재 상품 ${skus.length}개 읽는 중…`);
  let live;
  // 묶음 하나라도 실패하면 전체가 던진다(호출 한도 429 등) — 한 번만 다시 부른다.
  try { live = await amazon.loadProductsForEdit(skus, US_MARKET); }
  catch (e) { progress(`미국 조회 실패(${e.message}) — 한 번 더 시도…`); live = await amazon.loadProductsForEdit(skus, US_MARKET); }

  // 일본에 이미 있는 SKU(BIL 로 생긴 오퍼만 있는 것)는 초안 업로드가 받지 않는다. 검색 API 는 그런 SKU 를 안 돌려주므로 한 건씩.
  let onJp = null, jpError = '';
  try {
    onJp = await amazon.skusOnMarketplace(skus, JP_MARKET, {
      onProgress: (done, total) => { if (done % 100 === 0 || done === total) progress(`아마존 일본에 이미 있는 SKU 확인 ${done}/${total}…`); } });
  } catch (e) { jpError = e.message; }

  // OCR 이 통째로 실패하면(PowerShell 차단·인식기 없음) 메인을 고르지 않는다 — 다음 회차는 내려받지도 않는다.
  let ocrError = '';
  const unreadable = (urls, error) => urls.map(url => ({ url, hasText: null, text: '', error }));
  const safeDetect = urls => ocrError ? Promise.resolve(unreadable(urls, ocrError)) : detect(urls).catch(e => {
    ocrError = e.message; progress('이미지 글자 확인 실패: ' + e.message);
    return unreadable(urls, e.message);
  });
  const images = await pickMainImages(
    children.map(l => ({ sku: l.sku, urls: live.has(l.sku) ? amazonImageUrls(live.get(l.sku), US_MARKET) : [] })),
    safeDetect, (round, count) => progress(`메인 이미지 글자 확인 ${round}회차 · ${count}장 내려받아 확인 중…`));

  const items = children.map(l => {
    const p = live.get(l.sku);
    return { sku: l.sku, listing: l, live: !!p, asin: p?.asin || '', name: p?.title || '', price: p?.price ?? '', stock: p?.stock ?? '',
      productType: p?.raw?.summaries?.find(s => s.marketplaceId === US_MARKET)?.productType || '', images: images.get(l.sku),
      onJp: onJp ? onJp.has(l.sku) : undefined };
  });
  const { rows, summary } = buildJpDraft({ items, names, fx, snapshot });
  return { rows, summary: { ...summary, parents: parents.size, live: live.size, jpError, ocrError } };
}
