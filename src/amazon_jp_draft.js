// 아마존 일본 등록용 초안 CSV — 미국 리스팅 캐시를 일본어 초안으로 바꿔 엑셀에서 검토하게 한다.
//
// 왜 필요한가 (2026-10)
//   BIL 자동 번역은 982건이 OGWM 브랜드 제한(5461)으로 실패했다. 브랜드가 풀린 뒤 같은 SKU 로
//   일본에 직접 등록해야 하므로, 일본어 제목·불릿·설명·엔화 가격을 미리 만들어 사람이 고쳐 둔다.
//   이 모듈은 아마존에 아무것도 보내지 않는다(읽기만 한다).
//
// 일본어 표기는 앱의 정규화 사전 경로를 그대로 탄다
//   · SKU → 차량 카탈로그 행(vehicle_catalog.json variants[].skus) → 한글 브랜드·차종·세대
//     → vu-suggest.js 의 brandJa / modelJa / genJa (data/vehicle_i18n.json + 일본차 코드표).
//     셸이 아마존 JP 를 고를 때와 같은 함수·같은 일본 모드다. 조회 규칙을 여기서 다시 짜지 않는다.
//   · 카탈로그 행에 이어지지 않은 SKU 는 이베이 상품등록 표(listings)의 영문 브랜드·차종으로
//     같은 사전을 거꾸로 찾는다. 후보가 둘 이상이면 고르지 않는다.
//   · 사전에 없으면 지어내지 않고 비워 둔 뒤 '확인 필요' 에 적는다 (사전 _설명 의 원칙).
//
// 엔화 가격은 환율 자동 변경과 같은 규칙이다(utils/fx_pricing.js):
//   SKU 의 등급(저장된 연결 → 지금 미국 가격) 국내 기준가 ÷ 오늘 환율, 앞 두 자리만 남김.
//   초안은 등급 연결을 새로 저장하지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FX_SCOPES, findTier, fromKrw, rateProblem } from './utils/fx_pricing.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export const JP_TITLE_MAX = 75;        // 2026-07-27 부터 아마존 일본 비미디어 상품명 권장 상한(넘으면 아마존이 고쳐 쓴다)
export const JP_HIGHLIGHT_MAX = 125;   // 商品のハイライト
export const BRAND = 'OGWM';           // 미국 리스팅 브랜드. 차량 제조사나 'Optic Glass' 를 넣으면 안 된다.

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

/**
 * 일본어 상품명. 기존 아마존 JP 템플릿('{차} 用 広角ドアミラーガラス 交換用', index.html)에
 * 브랜드 OGWM 을 앞에 붙이고, BSA 상품은 BSA対応 을 넣는다(같은 차의 BSA·일반 SKU 를 가른다).
 * no(품번)는 같은 제목이 여러 SKU 에 생길 때만 넣는다(buildJpDraft).
 * 左右セット·ヒーター付き 는 75자 안에 들어갈 때만 붙인다. 차 부분과 품번은 줄이지 않는다.
 */
export function jpTitle({ brand, model, gen, year, code, bsa, no }) {
  const car = [brand, model, gen, yearUnlessIn(year, gen), code].filter(Boolean).join(' ');
  let title = `${BRAND} ${car} 用 広角ドアミラーガラス 交換用${no ? ` No.${no}` : ''}${bsa ? ' BSA対応' : ''}`;
  for (const extra of ['左右セット', 'ヒーター付き']) {
    if (chars(`${title} ${extra}`) <= JP_TITLE_MAX) title += ` ${extra}`;
  }
  return title;
}

// 미국 기본 불릿·설명(index_up.html DEFAULT_AMAZON_*)의 일본어판. 사람이 한 번 감수해야 한다.
const BULLETS = [
  '死角を軽減：最適な曲率で設計した凸面ミラーが死角を大幅に減らし、広い視野を確保します。周囲の状況を把握しやすく、運転の安全性を高めます。',
  'クリアな視界：クロームコーティングが乱反射を抑え、強い日差しの下でもはっきり見えます。撥水コーティングにより、雨天時も良好な視界を保ちます。',
  'ヒーター機能：内蔵ヒーターが冬の曇りや夏の結露を取り除きます。純正のヒーター付きミラーと同じ機能で、一年中快適にお使いいただけます。',
  '簡単取り付け：既存ミラーの配線にそのまま合うコネクター付き。今のミラーガラスのコネクターを外し、本製品を差し込むだけで交換できます。',
];
const BULLET_BSA = 'BSA対応：ブラインドスポットアシスト（BSA）の警告灯がミラー越しに見えるよう、刻印加工を施しています。';
const BULLET_PLAIN = '高品質素材：耐久性の高い素材を使用しており、長距離の運転でも安定した性能を発揮します。';
const HIGHLIGHT = 'ヒーター付き広角ミラーで死角を軽減。純正ミラーガラスと差し替えるだけで取り付けできます。';
const HIGHLIGHT_BSA = 'BSA警告灯が見える刻印加工済み。';
// 일반 SKU 설명에 있으면 BSA 가 들어 있는 줄로 읽힌다 — BSA SKU 에만 남긴다.
const DESCRIPTION_BSA = '刻印加工で、BSA（ブラインドスポットアシスト）センサーの警告灯をミラー越しに確認できます。';
const DESCRIPTION = [
  '死角を減らし、運転に自信を。',
  '最適な曲率で設計した広角ミラーが死角を大幅に減らし、周囲を広く見渡せます。',
  '純正ミラーのデザインに合わせて作られているため取り付けが簡単で、車の外観もそのまま保てます。',
  '撥水コーティングにより、雨の日や濡れた状態でもクリアな視界を保ちます。',
  DESCRIPTION_BSA,
  '安全性・使いやすさ・見やすさを重視した設計で、毎日の運転をより快適にします。',
  '高品質な素材を使用しており、長距離の運転でも安定した性能を発揮します。',
];
const description = bsa => DESCRIPTION.filter(line => bsa || line !== DESCRIPTION_BSA).join('\n');

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
 * @param items    미국 리스팅 캐시 행 [{ id: sku, asin, name, price, stock }]
 * @param names    loadVehicleNames() 결과 { vu, dict, catalog }
 * @param fx       FxPriceStore.read() — { tiers, assignments }
 * @param snapshot 환율(currency-rates-get 의 data). 없으면 엔화 칸을 비운다.
 */
export function buildJpDraft({ items, names, fx, snapshot }) {
  const { vu, dict, catalog } = names;
  const variantsBySku = new Map();
  // 미국 캐시의 SKU 는 아마존 SKU 다 — 이베이 SKU(v.skus)와 다른 차가 있어 아마존 쪽(v.amazonSkus)을 먼저 본다.
  for (const v of catalog.variants || []) for (const sku of new Set([...(v.amazonSkus || []), ...(v.skus || [])])) {
    if (!variantsBySku.has(sku)) variantsBySku.set(sku, []);
    variantsBySku.get(sku).push(v);
  }
  const reverse = reverseLookup(dict);
  const price = jpyPricer({ fx, snapshot });

  const drafts = [...items].sort((a, b) => String(a.id).localeCompare(String(b.id))).map(item => {
    const sku = String(item.id ?? '');
    const notes = [];
    const listing = vu.listing(sku);
    const variants = variantsBySku.get(sku) || [];
    let car = null, source = '';

    if (variants.length) {
      const v = variants[0];
      source = '카탈로그';
      if (variants.length > 1) notes.push(`차량 행 ${variants.length}개에 이어진 SKU — 세대·연식 확인`);
      // 코드표 '기타' 브랜드는 차종 칸에 제조사가 들어 있다('마쯔다 CX-9') — その他 를 제목에 넣지 않는다.
      const makerInModel = vu.brandEn(v.brand) === 'Others';
      car = { brand: makerInModel ? '' : vu.brandJa(v.brand),
        model: vu.modelJa(v.brand, untag(v.model)) || untag(vu.modelJa(v.brand, v.model)) || null,
        gen: v.gen ? vu.genJa(v.gen) : '', year: yearJa(v.year, dict), code: codeJa(v.code, dict), makerInModel };
      if (!car.brand && !makerInModel) notes.push(`브랜드 일본어 없음: ${v.brand}`);
      if (!car.model) notes.push(`차종 일본어 없음: ${v.brand} ${v.model}`);
      if (v.gen && !car.gen) notes.push(`세대 일본어 없음: ${v.gen}`);
      if (car.code !== yearJa(v.code, dict)) notes.push(`차량코드 한글 메모 뺌: ${v.code}`);
    } else if (listing) {
      source = '영문 역조회';
      const b = reverse.brand(listing.brandEn);
      const model = b ? reverse.model(b.key, listing.modelEn) : null;
      const g = genFromYearText(listing.yearText, dict);
      car = { brand: b?.jp || null, model: model || null, gen: g.gen, year: g.year, code: '' };
      if (!car.brand) notes.push(`브랜드 일본어 없음: ${listing.brandEn}`);
      if (model === undefined) notes.push(`차종 일본어 후보 여러 개: ${listing.brandEn} ${listing.modelEn}`);
      else if (!car.model) notes.push(`차종 일본어 없음: ${listing.brandEn} ${listing.modelEn}`);
      if (g.unknown) notes.push(`세대·연식 해석 못 함: ${listing.yearText}`);
      notes.push('차량코드 없음(카탈로그 행에 안 이어짐)');
    } else {
      notes.push('차량 카탈로그에 없는 SKU — 제목·불릿을 직접 입력');
    }

    const bsa = !!listing?.bsa;
    const complete = car && (car.brand || car.makerInModel) && car.model;
    const usd = String(item.price ?? '').trim();
    const p = price(sku, usd);
    if (p.error) notes.push(`엔화 가격: ${p.error}`);

    return {
      car: complete ? car : null, partNo: partNoOf(item, variants[0], listing), notes,
      row: {
        sku, asin: item.asin || '', usTitle: item.name || '', brand: BRAND,
        makerJa: car?.brand || '', modelJa: car?.model || '', genJa: car?.gen || '', year: car?.year || '', code: car?.code || '',
        bsa,
        highlight: complete ? (bsa ? HIGHLIGHT_BSA + HIGHLIGHT : HIGHLIGHT) : '',
        bullets: complete ? [...BULLETS, bsa ? BULLET_BSA : BULLET_PLAIN] : ['', '', '', '', ''],
        description: complete ? description(bsa) : '',
        usd, tier: p.tier ? (p.tier.label || p.tier.id) + ` (${p.tier.krw.toLocaleString('ko-KR')}원)` : '',
        jpy: p.jpy || '', stock: String(item.stock ?? ''),
        productType: listing || variants.length ? 'VEHICLE_MIRROR' : '',
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
    return { ...row, title, titleLength: title ? chars(title) : '', notes: notes.join(' / ') };
  });

  const summary = {
    total: rows.length,
    titled: rows.filter(r => r.title).length,
    priced: rows.filter(r => r.jpy).length,
    needsReview: rows.filter(r => r.notes).length,
    overLength: rows.filter(r => Number(r.titleLength) > JP_TITLE_MAX).length,
  };
  for (const r of rows) if (chars(r.highlight) > JP_HIGHLIGHT_MAX) throw new Error(`하이라이트가 ${JP_HIGHLIGHT_MAX}자를 넘습니다: ${r.sku}`);
  return { rows, summary };
}

const HEADER = ['SKU', '미국 ASIN', '미국 상품명', '브랜드', '제조사(日)', '차종(日)', '세대(日)', '연식', '차량코드', 'BSA',
  '일본어 상품명', '상품명 글자수', '제품 하이라이트', '불릿1', '불릿2', '불릿3', '불릿4', '불릿5', '상품 설명',
  '미국 판매가(USD)', '가격 등급', '일본 판매가(JPY)', '재고', '상품 유형', '일본어 출처', '확인 필요'];

/** 엑셀이 한글·일본어를 깨지 않게 BOM 을 붙이고, 줄바꿈이 든 칸은 따옴표로 감싼다. */
export function draftCsv(rows) {
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = rows.map(r => [r.sku, r.asin, r.usTitle, r.brand, r.makerJa, r.modelJa, r.genJa, r.year, r.code, r.bsa ? 'O' : '',
    r.title, r.titleLength, r.highlight, ...r.bullets, r.description, r.usd, r.tier, r.jpy, r.stock, r.productType, r.source, r.notes].map(q).join(','));
  return '﻿' + [HEADER.map(q).join(','), ...lines].join('\r\n');
}
