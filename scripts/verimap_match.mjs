/**
 * 베리맵 — 대조 (코드표 × 채널)
 *
 * 입력  data/verimap/codetable.json     기준 코드표 (정규화 완료)
 *       data/verimap/coupang_raw.json   쿠팡 상세 + 재고
 *       data/verimap/naver_items.csv    스마트스토어 옵션
 * 출력  data/verimap/match_명단.csv      채널 옵션 ↔ 코드표 행
 *       data/verimap/match_현황.csv      코드표 행 × 채널 등록 현황
 *       data/verimap/match_미등록.csv    어느 채널에도 없는 코드표 행
 *       data/verimap/match_확인필요.csv  사람이 봐야 하는 건
 *
 * API 를 부르지 않는다 — 이미 받아 둔 파일로만 계산한다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseYears, parseGen } from './verimap_load_codetable.mjs';
import { readCsv } from './verimap_csv.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'data', 'verimap');

const q = v => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const writeCsv = (file, header, rows) => {
  const body = [header.map(q).join(','), ...rows.map(r => r.map(q).join(','))].join('\r\n');
  fs.writeFileSync(file, '﻿' + body, 'utf8');
  console.log(`  저장: ${path.relative(ROOT, file)}  (${rows.length}행)`);
};
const norm = v => String(v ?? '').replace(/\s+/g, '').toLowerCase();
const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);

// ── 추출 ────────────────────────────────────────────────────
// 표기가 채널마다, 심지어 같은 채널 안에서도 제각각이다.
//   쿠팡  No.906-1세대(26.04~)BSA / No.H149[ 1세대/24.04]BSA / [B313] 1세대/24~ / H108-1(...)
//   네이버 26.04~현재[No.906번]BSA / 🔶23~[No.1601] / 1세대/24.04~ [No.H149]BSA
// '-숫자' 뒤에 '세대' 가 오면 서브번호가 아니라 세대 표기다(No.H110-3세대).
const RE_NO    = /No\.\s*([BHKSRY]?)(\d{3,4})(?:-(\d+)(?!\s*세대))?/i;
const RE_BRKT  = /\[\s*([BHKSRY]?)(\d{3,4})(?:-(\d+))?\s*번?\s*\]/i;
// `No.` 도 대괄호도 없이 상품명에 맨몸으로 적힌 번호(H108-1 등). 여기만 3자리로 좁힌다 —
// `BMW R1250RT` · `GSX-S1000 GT` 같은 오토바이 모델명을 번호로 오해했기 때문이다.
// 오토바이 번호는 `No.B1501번` 처럼 B+4자리가 실제로 있어서 B 는 4자리까지 받는다.
// 번호가 `No.` 나 대괄호로 표시돼 있으면 그건 사람이 번호라고 적은 것이므로 그대로 믿는다.
const RE_ALPHA = /(?<![A-Za-z0-9])(?:(B)(\d{3,4})|([HKSRY])(\d{3}))(?:-(\d+)(?!\s*세대))?(?!\d)/;
/** 상품명에 든 코드 전부. 아임웹은 한 상품에 [S106, S114] 처럼 여러 개를 넣는다. */
const RE_ALL = /(?:No\.\s*|\[)\s*([BHKSRY]?\d{3,4}(?:-\d+)?)\s*번?/gi;
export function extractParts(text) {
  const s = String(text ?? '');
  const out = [];
  // 대괄호 묶음 안의 쉼표 나열을 먼저 푼다: [S106, S114] · [105, 121]
  for (const m of s.matchAll(/\[([^\]]*)\]/g)) {
    // B2B 는 한 상품에 여러 코드를 쉼표로 나열한다. No. 접두도 '번' 접미도 없는 맨숫자다:
    //   [1110,1113,1103,1125] · [K150,K151] · [1200,1202,1202-1,1204,]
    for (const piece of m[1].split(/[,·/]/)) {
      const t = piece.replace(/No\.|번|\s+/gi, '');
      if (!t) continue;
      const g = /^([BHKSRY]?)(\d{3,4})(?:-(\d+))?$/i.exec(t);
      if (g) out.push(`${(g[1] || '').toUpperCase()}${g[2]}${g[3] ? '-' + g[3] : ''}`);
    }
  }
  if (out.length) return [...new Set(out)];
  for (const m of s.matchAll(RE_ALL)) {
    const g = /^([BHKSRY]?)(\d{3,4})(?:-(\d+))?$/i.exec(m[1].replace(/\s+/g, ''));
    if (g) out.push(`${(g[1] || '').toUpperCase()}${g[2]}${g[3] ? '-' + g[3] : ''}`);
  }
  return [...new Set(out)];
}

function extractPart(text) {
  const s = String(text ?? '');
  for (const [re, how] of [[RE_NO, 'No.'], [RE_BRKT, '대괄호']]) {
    const m = re.exec(s);
    if (m) return { key: `${(m[1] || '').toUpperCase()}${m[2]}${m[3] ? '-' + m[3] : ''}`, how };
  }
  const a = RE_ALPHA.exec(s);
  if (a) {
    const pre = (a[1] || a[3] || '').toUpperCase();
    const num = a[2] || a[4];
    return { key: `${pre}${num}${a[5] ? '-' + a[5] : ''}`, how: '접두' };
  }
  return null;
}

const RE_RANGE = /(\d{2,4}(?:\.\d{1,2})?)\s*[~\-]\s*(\d{2,4}(?:\.\d{1,2})?|현재)?/g;
function extractYears(text) {
  const s = String(text ?? '').replace(/\s*1개\s*/g, ' ');
  for (const m of s.matchAll(RE_RANGE)) {
    const before = s.slice(Math.max(0, m.index - 6), m.index);
    if (/No\.\s*[BHKSRY]?\d*$/i.test(before) || /[BHKSRY]\d{3,4}$/i.test(before)) continue;
    const y = parseYears(m[0]);
    if (y) return y;
  }
  const one = /(?:^|[^\d.])(\d{2}\.\d{1,2})(?![\d.])/.exec(
    s.replace(/No\.\s*[BHKSRY]?\d{3,4}(-\d+)?/i, ' '));
  return one ? parseYears(one[1]) : null;
}

/**
 * 판매 구성 — 같은 차종이라도 페이지가 여러 개다.
 *   1셋            운전석 + 조수석 묶음
 *   운전석/조수석    한 페이지에서 고르는 방식
 *   운전석 · 조수석  한쪽만 파는 페이지
 * 차종별로 어떤 구성이 있고 없는지가 확인 대상이라 따로 뽑는다.
 */
function sellForm(text) {
  const s = String(text ?? '');
  const hasL = /운전석/.test(s), hasR = /조수석/.test(s);
  if (/1\s*(셋|세트|set)/i.test(s)) return hasL && hasR ? '1셋(좌우)' : '1셋';
  if (hasL && hasR) return '운전석/조수석';
  if (hasL) return '운전석';
  if (hasR) return '조수석';
  return '(미표기)';
}

/** '전차종 / 전 차종 가능' 은 여러 차종을 한 상품에 묶어 등록한 것 — 의도된 구조다. */
function isBundle(text) {
  return /전\s*차종|전차종|공동구매/.test(String(text ?? ''));
}

/**
 * 광각미러가 아닌 것 — 코드표에 있을 수 없으므로 분모에서 뺀다.
 * B2B 는 브랜드가 전부 '옵틱글래스' 로 묶여 있어 브랜드·카테고리로 못 거른다.
 *   스타포쉬 전동 사이드스텝 · BSA 센서 · 와이퍼 · 테스트/더미 상품
 */
function notMirror(text) {
  const s = String(text ?? '');
  if (/사이드\s?스텝|스타포쉬/.test(s)) return '대상아님(사이드스텝)';
  if (/감지센서|BSA\)?\s?익스텐션|옵틱시스템|OPS\d/i.test(s)) return '대상아님(BSA센서)';
  if (/와이퍼|옵틱클리어/.test(s)) return '대상아님(와이퍼)';
  if (/테스트|TEST|복제|임의\s?결제|^옵틱글래스\s*#C\d/i.test(s)) return '대상아님(테스트·더미)';
  return null;
}

// 이름이 다른 이름 **안에** 들어 있는 경우를 가린다.
//   '벤츠 GLA클래스' 에는 'A클래스' 가 통째로 들어 있다(gl‖a클래스) — 벤츠 A클래스가 아니다.
// 그래서 단순 포함이 아니라 낱말 경계를 본다: 찾은 자리의 앞뒤가 같은 영문·숫자 덩어리의
// 일부면 낱말 중간이므로 아니라고 본다. 한글·기호가 닿아 있으면 경계로 친다.
// 공백을 지우고 비교하되, **공백이 있던 자리를 기억**해 둔다.
// 안 그러면 'GMC Sierra' → 'gmcsierra' 가 되어 'sierra' 앞에 영문 c 가 닿아
// 낱말 중간으로 오해한다(미국몰 67행이 이렇게 떨어졌다).
function words(v) {
  const parts = String(v ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const starts = new Set();
  let s = '';
  for (const p of parts) { starts.add(s.length); s += p; }
  return { s, starts };
}
// 같은 종류(영문끼리 · 숫자끼리)가 맞닿아 있으면 낱말 중간으로 본다. 단 원래 낱말이
// 시작하던 자리면 경계다.
//   '벤츠 GLA클래스' 안의 'A클래스'  → 앞이 영문 l, 낱말 시작도 아님 → 중간 → 아니다
//   'GMC Sierra' 안의 'Sierra'     → 원래 낱말이 시작하던 자리 → 경계 → 맞다
//   'BMW 1Series' 안의 '1 Series'  → 종류가 영문→숫자로 바뀜 → 경계 → 맞다
//   'x30' 안의 'x3'               → 뒤가 숫자 0, 이름 끝도 숫자 3 → 중간 → 아니다
const kindOf = c => /[a-z]/.test(c) ? 'a' : (/[0-9]/.test(c) ? 'n' : '');
function containsWord(hay, needle) {
  const H = typeof hay === 'string' ? words(hay) : hay;
  const n = typeof needle === 'string' ? words(needle).s : needle.s;
  if (!H.s || !n) return false;
  let i = H.s.indexOf(n);
  while (i !== -1) {
    const before = i > 0 ? H.s[i - 1] : '';
    const after = H.s[i + n.length] || '';
    const headCut = !H.starts.has(i) && kindOf(before) !== '' && kindOf(before) === kindOf(n[0]);
    const tailCut = !H.starts.has(i + n.length) && i + n.length < H.s.length
      && kindOf(after) !== '' && kindOf(after) === kindOf(n[n.length - 1]);
    if (!headCut && !tailCut) return true;
    i = H.s.indexOf(n, i + 1);
  }
  return false;
}

function cleanModel(s) {
  return String(s ?? '')
    .replace(/옵틱글래스|오토바이|광각|사이드|와이드미러|미러킷|미러|\(공동구매\)/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')          // 제목 끝의 코드 묶음 [101, 121] 은 모델명이 아니다
    .replace(/\s+/g, ' ').trim();
}

// 코드표에는 모델명이 국문·영문 두 칸뿐이라 일본몰 제목(가타카나)이 어느 칸과도 안 붙는다.
// 다국어 표기 시트에서 뽑은 사전(model_names.json)으로 일문·영문 차량명을 국문으로 바꿔 비교한다.
// 사전이 없으면 자주 쓰이는 표기만 손으로 바꾼다(아래 JP_WORDS) — 없어도 동작은 한다.
const JP_WORDS = [
  ['シリーズ', '시리즈'], ['クラス', '클래스'], ['モデル', '모델'], ['クーペ', '쿠페'],
  ['ワゴン', '웨건'], ['セダン', '세단'], ['ハッチバック', '해치백'], ['ツアラー', '투어러'],
  ['グラン', '그란'], ['スポーツ', '스포츠'], ['バン', '밴'], ['ピックアップ', '픽업'],
];
const MODEL_DICT = (() => {
  const f = path.join(DIR, 'model_names.json');
  const empty = { jp2ko: {}, pair: {} };
  if (!fs.existsSync(f)) return empty;
  try {
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    // 쓰는 건 일문 사전뿐이다 — 영문은 코드표의 '모델명 (영문)' 칸으로 이미 붙고,
    // 사전을 영문·한글 제목에까지 쓰면 짧은 이름이 엉뚱하게 걸려 정확도가 떨어진다.
    return { jp2ko: d.jp2ko || {}, pair: d.pair || {} };
  } catch (e) { console.log(`  (모델명 사전을 읽지 못했습니다: ${e.message})`); return empty; }
})();
if (Object.keys(MODEL_DICT.jp2ko).length) {
  console.log(`모델명 사전: 일문 ${Object.keys(MODEL_DICT.jp2ko).length}개 · 부품번호별 이름 ${Object.keys(MODEL_DICT.pair).length}개`);
}
function jpToKo(s) {
  let t = String(s ?? '');
  for (const [a, b] of JP_WORDS) t = t.split(a).join(b);
  return t;
}
/**
 * 제목에서 사전에 있는 일문 차량명을 찾아 국문 이름을 돌려준다(긴 이름부터, 최대 2개).
 * 가타카나·히라가나가 있는 제목에만 쓴다 — 한글·영문 제목에 걸면 사전의 짧은 이름이
 * 엉뚱하게 걸려 다른 채널 정확도가 떨어진다(실측: 미국 −34행, 본사몰 −19행).
 * 영문 제목은 코드표의 '모델명 (영문)' 칸으로 이미 붙으므로 사전이 필요 없다.
 */
// 일문 제목 → 국문 차량명. 가타카나가 든 제목에만 쓴다 — 한글·영문 제목에 걸면 사전의 짧은
// 이름이 엉뚱하게 잡혀 오히려 정확도가 떨어진다(실측: 미국 −34행, 본사몰 −19행).
const DICT_KEYS_JP = Object.keys(MODEL_DICT.jp2ko).sort((a, b) => b.length - a.length);
function dictNames(text) {
  const raw = String(text ?? '');
  if (!/[\u3040-\u30ff]/.test(raw)) return [];
  const t = norm(raw);
  if (!t) return [];
  const got = [];
  for (const k of DICT_KEYS_JP) {
    if (k.length < 2 || !t.includes(k)) continue;
    const ko = MODEL_DICT.jp2ko[k];
    if (ko && !got.includes(ko)) got.push(ko);
    if (got.length >= 2) break;
  }
  return got;
}

/**
 * 코드표 한 행의 '다른 이름'. 코드표에는 영문 모델명 칸이 비어 있는 행이 있어서
 * (MINI 쿠퍼 해치백 15·16행 등) 영문 제목이 어느 행과도 안 붙는다. 다국어 표기 시트에서
 * 부품번호 + 국문 모델명으로 짝지어 그 행의 공식 영문·일문 이름을 채워 넣는다.
 * 제목 전체에서 아무 이름이나 찾는 사전과 달리 행 단위라 엉뚱하게 걸릴 일이 없다.
 */
const MODEL_ALIAS = (() => {
  const f = path.join(DIR, 'model_aliases.json');
  if (!fs.existsSync(f)) return {};
  try { return JSON.parse(fs.readFileSync(f, 'utf8')).aliases || {}; }
  catch (e) { console.log(`  (별칭 파일을 읽지 못했습니다: ${e.message})`); return {}; }
})();
if (Object.keys(MODEL_ALIAS).length) console.log(`모델명 별칭: ${Object.keys(MODEL_ALIAS).length}개`);

function rowAltNames(e) {
  const got = [];
  if (e.modelAlt) got.push(e.modelAlt);
  const key = `${e.partKey}|${norm(e.model)}`;
  const p = MODEL_DICT.pair[key];
  if (p) for (const v of [...(p.en || []), ...(p.jp || [])]) if (v && !got.includes(v)) got.push(v);
  for (const v of (MODEL_ALIAS[key] || [])) if (v && !got.includes(v)) got.push(v);
  return got;
}

// 현황 칸에 적을 내용 — 채널마다 '무엇이 등록됐는지' 가 어디 적혀 있는지가 다르다.
//   쿠팡 · 본사몰          : 상품명에 차종이 들어 있다.
//   B2B · 스마트스토어     : 한 상품에 차종이 여러 개라 옵션 내용이라야 어느 차종인지 알 수 있다.
function cellText(rec) {
  const opt = String(rec.optionText || '').trim();
  const name = String(rec.productName || '').trim();
  if (rec.channel === 'B2B' || rec.channel === '스마트스토어') return opt || name;
  return name || opt;
}

// ── 채널 레코드 만들기 ──────────────────────────────────────
/** 한 건 = '한 차종(적합)' 단위. 운전석/조수석·BSA 유무는 같은 차종이라 묶는다. */
function coupangRecords() {
  const raw = JSON.parse(fs.readFileSync(path.join(DIR, 'coupang_raw.json'), 'utf8'));
  if (!raw.details) {
    // 목록만 받은 원본에는 차종(옵션)이 없다 — 쿠팡은 한 상품에 여러 차종이 옵션으로 들어 있어서
    // 상세를 받아야 어느 차종이 올라가 있는지 알 수 있다.
    console.log('⚠ 쿠팡 상세(details)가 없어 쿠팡은 건너뜁니다 — 4번(광각미러 상세 + 재고)을 먼저 돌리세요.');
    return [];
  }
  const stock = raw.stock || {};
  const seen = new Map();
  for (const d of raw.details) {
    for (const it of (d.items || [])) {
      const vid = it.vendorItemId ? String(it.vendorItemId) : '';
      const st = stock[vid];
      // 옵션ID·재고를 못 받은 것은 '안 팔림' 이 아니라 '재고를 확인 못 함' 이다.
      // 예전엔 판매불가로 묶어 대조에서 빼버렸는데, 실제로 구매 페이지가 살아 있는 상품이 있었다
      // (BMW 5GT 680R). 등록 여부를 보는 게 목적이므로 대조 대상에 넣고 꼬리표만 남긴다.
      let state;
      if (!vid) state = '판매중(옵션ID없음)';
      else if (!st) state = '판매중(재고조회거절)';
      else if (it.salePrice === null || it.salePrice === undefined) state = '판매불가(가격없음)';
      else if (st.onSale === false) state = '품절(판매중지)';
      else if (st.stock === 0) state = '품절(재고0)';
      else state = '판매중';

      // 구매 페이지 주소. 상품번호(productId) 는 여러 등록상품이 같이 쓰는 경우가 있어서,
      // 옵션 번호(itemId · vendorItemId)까지 붙여야 그 차종으로 제대로 열린다.
      // (실제 구매 링크와 글자까지 같은 것을 테슬라 모델X 로 확인했다.)
      // 검색을 거치지 않은 직접 접근이 '사용권한이 없습니다' 로 막히는 상품이 있다(볼보 EX90).
      // 같은 주소에 검색 맥락(q·sourceType·rank)을 붙이면 열린다 — 안 막히던 상품도 그대로 열려
      // 전부 붙인다. q 는 상품명으로 채운다.
      const pid = d.productId ?? '';
      const qs = [];
      if (it.itemId) qs.push(`itemId=${it.itemId}`);
      if (vid) qs.push(`vendorItemId=${vid}`);
      qs.push(`q=${encodeURIComponent(d.sellerProductName ?? '')}`,
              'sourceType=search', 'rank=0', 'itemsCount=1', 'searchRank=0');
      const url = pid ? `https://www.coupang.com/vp/products/${pid}?${qs.join('&')}` : '';

      const key = `${d.sellerProductId}|${String(it.itemName ?? '').replace(/\s+/g, '')}`;
      if (seen.has(key)) { seen.get(key).optionIds.push(vid); continue; }
      seen.set(key, {
        channel: '쿠팡',
        productId: String(d.sellerProductId),
        url,
        optionIds: [vid],
        productName: d.sellerProductName ?? '',
        optionText: it.itemName ?? '',
        model: cleanModel(d.sellerProductName),
        form: sellForm(`${it.itemName ?? ''} ${d.sellerProductName ?? ''}`),
        state: notMirror(d.sellerProductName) || (isBundle(d.sellerProductName) ? '통합상품' : state),
      });
    }
  }
  return [...seen.values()];
}

function naverRecords() {
  const file = path.join(DIR, 'naver_items.csv');
  if (!fs.existsSync(file)) return [];
  const rows = readCsv(file);
  const seen = new Map();
  for (const r of rows) {
    const group = r['옵션그룹명'] || '';
    const opt2 = r['옵션2_상품선택'] || '';
    const opt1 = r['옵션1_모델명'] || '';
    // '제조사 선택 / 운전석·조수석 / BSA 여부' 처럼 **차종 축이 없는** 구성이 전 차종 통합상품이다.
    // 축 이름만 보면 안 된다 — '브랜드 / 차종 / 운전석·조수석' 은 이름에 '브랜드' 가 들어가도
    // 옵션1 에 차종이 들어 있는 정상 상품이다(BMW X7 등 86행이 통째로 빠져 있었다).
    // 그래서 옵션에 부품번호가 적혀 있으면 통합상품으로 보지 않는다.
    const hasPart = /No\.|\[\s*[BHKSRY]?\d{3,4}/i.test(`${opt1} ${opt2}`);
    const bundle = !hasPart
      && /제조사\s*선택|브랜드/.test(group)
      && !/모델명|차량명|차종/.test(group);
    const stockQ = String(r['재고'] ?? '').trim();
    let state;
    if (r['사용'] === 'N') state = '품절(미사용)';
    else if (stockQ === '0') state = '품절(재고0)';
    else state = '판매중';

    const key = `${r['채널상품번호']}|${norm(opt1)}|${norm(opt2)}`;
    if (seen.has(key)) continue;
    seen.set(key, {
      channel: '스마트스토어',
      productId: String(r['채널상품번호']),
      optionIds: [String(r['옵션조합ID'] ?? '')],
      productName: r['상품명'] ?? '',
      optionText: [opt1, opt2].filter(Boolean).join(' / '),
      // 네이버는 모델명이 옵션1 에 따로 있다 — 쿠팡보다 유리하다.
      model: cleanModel(opt1) || cleanModel(r['상품명']),
      // 네이버는 옵션3 이 운전석/조수석·BSA 여부다.
      form: sellForm(`${r['옵션3_좌우'] || ''} ${opt2} ${r['상품명'] || ''}`),
      state: notMirror(r['상품명']) || ((bundle || isBundle(r['상품명'])) ? '통합상품' : state),
    });
  }
  return [...seen.values()];
}

// 구역 코드 → 채널 이름 (main_process 와 실제 응답에서 확인한 값)
const IMWEB_UNITS = {
  u2026012071cb0d215bc67: '본사몰',
  u202101075ff68e15971f2: 'B2B',
};

/**
 * 해외 구역(USD·JPY)은 대조에서 뺀다.
 * 미국몰·일본몰은 상품 페이지가 아니라 '게시물' 로 운영된다(제목 + 본문 이미지가 옵션 역할).
 * 아임웹은 같은 상품을 모든 구역에 복제해 들고 있어서 /products 로는 세 구역이 전부 같은
 * 숫자로 나온다 — 그걸 '등록됨' 으로 세면 실제 게시물 노출과 무관한 가짜 숫자가 된다.
 * 게시물은 아임웹 Open API 에 없어 대조하지 않는다.
 */
const IMWEB_SKIP_UNITS = new Set(['u2026022769a0fa6e4f7f8', 'u2026040869d592902883d']);

/**
 * 아임웹은 상품명에 부품번호가 들어 있어 목록만으로 대조가 된다(상세 조회 불필요).
 * 다만 연식·세대는 상품명에 없고, 한 상품이 코드 여러 개를 담을 수 있다 — 코드마다 한 건으로 펼친다.
 */
/**
 * 차종명 열쇠 — 코드·구성 표기를 떼어낸 나머지.
 * B2B 는 같은 차종을 '1셋'(코드 있음) · '운전석/조수석'(코드 없음) 두 페이지로 판다.
 * 코드는 1셋 쪽에만 적는 규칙이라, 짝을 찾아 코드를 물려받아야 한다.
 *   3244 렉서스 LM500H / LM350h 미러 운전석/조수석      ← 코드 없음
 *   3245 렉서스 LM500H / LM350h 미러 1셋 [1601]        ← 짝
 */
const channelOfUnit = unit => IMWEB_UNITS[unit] || `아임웹(${String(unit).slice(0, 10)})`;

function modelKey(name) {
  return String(name ?? '')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/옵틱글래스|광각미러|광각|미러|운전석\/조수석|운전석|조수석|1\s*셋|1\s*세트|바이크/g, ' ')
    .replace(/\s+/g, '')
    .toLowerCase();
}

/**
 * 아임웹 옵션 — 연식 칸에 부품번호가 같이 들어 있다(실응답으로 확인).
 *   차종=LM / 연식=2023~ [No.1601] BSA X / 구성=운전석만
 *   연식=18.11-23.03 [No.1205] BSA X   ·   연식=18.11-23.03 [No.1232] BSA O
 * 옵션 한 줄이 코드표 한 행에 대응하므로, 옵션이 있으면 상품명보다 옵션을 먼저 쓴다.
 * 축 이름은 흔들린다: 구성/구성 선택, BSA 여부/BSA 유무, 차종/차량.
 */
function imwebOptionRecords(channelOf) {
  const recs = [];
  for (const f of ['imweb_options.csv', 'imweb_options_b2b.csv']) {
    const file = path.join(DIR, f);
    if (!fs.existsSync(file)) continue;
    for (const r of readCsv(file)) {
      if (IMWEB_SKIP_UNITS.has(r['구역'] || '')) continue;
      const channel = channelOf(r['구역']);
      const whole = r['옵션값전체'] || '';
      const codes = extractParts(whole);
      if (!codes.length) continue;                       // 번호가 없는 옵션은 상품명 경로에 맡긴다
      const 연식 = r['연식'] || '';
      const 차종 = r['차종'] || '';
      const 구성 = r['구성'] || '';
      const form = sellForm(구성 || whole) ;
      const state = /품절|SOLDOUT/i.test(r['상태'] || '') ? '품절(재고0)' : '판매중';
      for (const code of codes) {
        recs.push({
          channel, productId: String(r['상품번호']), optionIds: [String(r['옵션코드'] || '')],
          productName: r['상품명'] || '',
          optionText: whole,
          model: cleanModel(차종) || cleanModel(r['상품명']),
          state, form, forcedPart: code, multi: codes.length,
          via: '옵션에서 읽음', fromOption: true,
          // 옵션의 연식 문자열을 그대로 넘겨 연식 비교에 쓰게 한다
          yearText: 연식 || whole,
        });
      }
    }
  }
  return recs;
}

function imwebRecords() {
  const recs = [];
  for (const f of ['imweb_list.csv', 'imweb_list_b2b.csv']) {
    const file = path.join(DIR, f);
    if (!fs.existsSync(file)) continue;
    const all = readCsv(file);
    // 구역마다 따로 — 같은 구역 안에서만 짝을 찾는다.
    const twin = new Map();   // '구역|차종키' → 코드 배열
    for (const r of all) {
      const codes = extractParts(r['상품명'] || '');
      if (!codes.length) continue;
      const k = `${r['구역']}|${modelKey(r['상품명'])}`;
      if (!twin.has(k)) twin.set(k, codes);
    }
    for (const r of all) {
      const unit = r['구역'] || '';
      if (IMWEB_SKIP_UNITS.has(unit)) continue;
      const channel = channelOfUnit(unit);
      const name = r['상품명'] || '';
      const status = String(r['판매상태'] || '').toLowerCase();
      let state;
      if (status === 'soldout') state = '품절(재고0)';
      else if (status && status !== 'sale') state = `대상아님(${status})`;
      else state = '판매중';

      const form = sellForm(name);
      const st = notMirror(name) || (isBundle(name) ? '통합상품' : state);
      let codes = extractParts(name);
      let via = '';
      if (!codes.length) {
        const t = twin.get(`${r['구역']}|${modelKey(name)}`);
        if (t?.length) { codes = t; via = '짝 상품에서 물려받음'; }
      }
      if (!codes.length) {
        recs.push({ channel, productId: String(r['상품번호']), optionIds: [], productName: name,
                    optionText: '', model: cleanModel(name), state: st, form, forcedPart: null, multi: 0, via });
        continue;
      }
      for (const code of codes) {
        recs.push({ channel, productId: String(r['상품번호']), optionIds: [], productName: name,
                    optionText: '', model: cleanModel(name), state: st, form, forcedPart: code, multi: codes.length, via });
      }
    }
  }
  return recs;
}

/** 채널별 '링크에 쓸 번호'. 못 찾으면 빈 문자열 — 그 칸은 링크 없이 글자만 남는다. */
function linkId(rec) {
  // 쿠팡처럼 주소를 미리 만들어 둔 채널은 그 주소를 그대로 쓴다(설정의 틀은 {id}).
  if (rec.url) return rec.url;
  // 쿠팡은 등록상품번호(sellerProductId)를 그대로 쓴다 — 판매자 화면 주소가 이 번호를 받는다.
  return String(rec.productId || '');
}

// ── 본체 ────────────────────────────────────────────────────
const ct = JSON.parse(fs.readFileSync(path.join(DIR, 'codetable.json'), 'utf8'));
const CT = ct.entries;
const byPart = new Map();
// 한 행에 번호가 둘 이상인 경우가 있다(`No.703번(옵)` / `구 704번(bsa)`) — 전부 같은 행을 가리키게 한다.
for (const e of CT) {
  const keys = (e.partKeys && e.partKeys.length) ? e.partKeys : (e.partKey ? [e.partKey] : []);
  for (const k of keys) {
    if (!byPart.has(k)) byPart.set(k, []);
    if (!byPart.get(k).includes(e)) byPart.get(k).push(e);
  }
}
console.log(`코드표: ${ct.count}행  (불러온 시각 ${ct.loadedAt})`);

// 구 번호 → 현행 번호. 원본 코드표에는 `No.703번(옵) / 구 704번(bsa)` 처럼 둘이 같이 적혀 있지만
// 기준 시트로 추출될 때 구 번호가 떨어져 나간다. 채널·게시물에는 아직 구 번호가 남아 있다.
const ALIAS = (() => {
  const f = path.join(DIR, 'part_aliases.json');
  if (!fs.existsSync(f)) return {};
  try { return JSON.parse(fs.readFileSync(f, 'utf8')).aliases || {}; }
  catch (e) { console.log(`  (구 번호 표를 읽지 못했습니다: ${e.message})`); return {}; }
})();
if (Object.keys(ALIAS).length) console.log(`구 번호 표: ${Object.keys(ALIAS).length}개`);

const optRecs = imwebOptionRecords(channelOfUnit);
// 옵션으로 정확히 잡힌 상품은 상품명 기반 추정을 버린다 — 같은 상품을 두 번 세지 않게.
const byOption = new Set(optRecs.map(r => `${r.channel}|${r.productId}`));
const records = [
  ...coupangRecords(),
  ...naverRecords(),
  ...imwebRecords().filter(r => !byOption.has(`${r.channel}|${r.productId}`)),
  ...optRecs,
];
const channels = [...new Set(records.map(r => r.channel))];
console.log(`채널: ${channels.join(', ')}  — 적합 단위 ${records.length}건\n`);

const out = [];
const matched = new Map();   // '표:행' → Set(채널)
const forms = new Map();     // '표:행|채널' → Set(칸에 적을 내용)
const links = new Map();     // '표:행|채널' → Map(링크번호 → 제목)
const perChannel = new Map();

for (const rec of records) {
  if (!perChannel.has(rec.channel)) perChannel.set(rec.channel, { state: new Map(), verdict: new Map() });
  const tally = perChannel.get(rec.channel);
  bump(tally.state, rec.state);

  const row = {
    ...rec, optionIds: rec.optionIds.join(' '),
    partKey: '', how: '', genNo: '', ymStart: '', ymEnd: '',
    ctRow: '', ctTable: '', ctBrand: '', ctModel: '', ctGen: '', ctYm: '',
    verdict: '', note: '',
  };

  // '판매중(옵션ID없음)' 처럼 꼬리표가 붙은 것도 대조 대상이다.
  if (!String(rec.state).startsWith('판매중')) {
    row.verdict = rec.state === '통합상품' ? '통합상품'
      : rec.state.startsWith('대상아님') ? rec.state : '대상아님';
    bump(tally.verdict, row.verdict);
    out.push(row);
    continue;
  }

  const text = `${rec.optionText} ${rec.productName}`;
  const part = rec.forcedPart ? { key: rec.forcedPart, how: '상품명' }
    : (extractPart(rec.optionText) || extractPart(text));
  if (rec.multi > 1) row.note = `한 상품에 코드 ${rec.multi}개`;
  if (rec.via) row.note = [row.note, rec.via].filter(Boolean).join(' / ');
  const years = rec.yearText ? (extractYears(rec.yearText) || extractYears(text))
    : (extractYears(rec.optionText) || extractYears(text));
  const gen = parseGen(rec.optionText);
  row.partKey = part?.key ?? ''; row.how = part?.how ?? '';
  row.genNo = gen?.no ?? ''; row.ymStart = years?.start ?? ''; row.ymEnd = years?.end ?? '';

  if (!part) { row.verdict = '미해결'; row.note = '부품번호를 찾지 못함'; bump(tally.verdict, '미해결'); out.push(row); continue; }
  let cands = byPart.get(part.key) || [];
  // 합쳐진 번호(703 ← 704)로 붙은 경우를 표시해 둔다 — 아직 구 번호를 쓰는 상품·게시물을 찾아 고칠 수 있게.
  if (cands.length && cands.every(e => e.partKey && e.partKey !== part.key)) {
    row.note = [row.note, `구 번호 ${part.key} → 현행 ${cands[0].partKey}`].filter(Boolean).join(' / ');
  }
  // v8 Apps Script 와 같은 규칙: 서브번호가 있으면 앞부분도 후보로 본다(H101-1 → H101).
  // 채널에만 파생 번호가 있고 코드표에는 본번호만 있는 경우를 고아로 버리지 않는다.
  if (!cands.length && part.key.includes('-')) {
    const base = part.key.split('-')[0];
    const alt = byPart.get(base) || [];
    if (alt.length) { cands = alt; row.note = `코드표에 ${part.key} 가 없어 ${base} 로 봄`; }
  }
  if (!cands.length && ALIAS[part.key]) {
    const cur = ALIAS[part.key];
    const alt = byPart.get(cur) || [];
    if (alt.length) {
      cands = alt;
      row.note = [row.note, `구 번호 ${part.key} → 현행 ${cur}`].filter(Boolean).join(' / ');
    }
  }
  if (!cands.length) { row.verdict = '고아'; row.note = '코드표에 없는 부품번호'; bump(tally.verdict, '고아'); out.push(row); continue; }

  const take = (list, label) => {
    if (list.length !== 1) return false;
    const e = list[0];
    // 앞서 붙은 메모(구 번호·짝 상품 등)를 지우지 않는다 — 어느 상품을 고쳐야 하는지가 거기 적혀 있다.
    Object.assign(row, { ctRow: e.row, ctTable: e.table, ctBrand: e.brand, ctModel: e.model, ctGen: e.genRaw, ctYm: e.ymRaw,
      verdict: '확정', note: [row.note, label].filter(Boolean).join(' / ') });
    const k = `${e.table}:${e.row}`;
    if (!matched.has(k)) matched.set(k, new Set());
    matched.get(k).add(rec.channel);
    const fk = `${k}|${rec.channel}`;
    if (!forms.has(fk)) forms.set(fk, new Set());
    forms.get(fk).add(cellText(rec) || '(이름없음)');
    const id = linkId(rec);
    if (id) {
      if (!links.has(fk)) links.set(fk, new Map());
      links.get(fk).set(id, cellText(rec) || '');
    }
    return true;
  };

  // 후보가 여럿이어도 전부 같은 차종(모델명+세대)이면 어느 줄에 붙든 결과가 같다 —
  // 코드표에 같은 내용이 두 줄 있는 경우가 있어서, 그때는 전부 등록으로 본다.
  //   예: No.339번 벤츠 S클래스 7세대 전기형 이 191행·194행에 똑같이 들어 있다.
  const takeAll = (list, label) => {
    if (list.length < 2) return false;
    const key = e => `${norm(e.model)}|${norm(e.genRaw)}`;
    if (new Set(list.map(key)).size !== 1) return false;
    const e0 = list[0];
    Object.assign(row, {
      ctRow: list.map(e => e.row).join('+'), ctTable: e0.table, ctBrand: e0.brand,
      ctModel: e0.model, ctGen: e0.genRaw, ctYm: e0.ymRaw, verdict: '확정',
      note: [row.note, `${label} (같은 차종 ${list.length}행에 모두 표시)`].filter(Boolean).join(' / '),
    });
    for (const e of list) {
      const k = `${e.table}:${e.row}`;
      if (!matched.has(k)) matched.set(k, new Set());
      matched.get(k).add(rec.channel);
      const fk = `${k}|${rec.channel}`;
      if (!forms.has(fk)) forms.set(fk, new Set());
      forms.get(fk).add(cellText(rec) || '(이름없음)');
      const id = linkId(rec);
      if (id) {
        if (!links.has(fk)) links.set(fk, new Map());
        links.get(fk).set(id, cellText(rec) || '');
      }
    }
    return true;
  };

  let pool = cands;
  if (take(pool, '부품번호 유일')) { bump(tally.verdict, '확정'); out.push(row); continue; }

  // 모델명을 먼저 좁힌다. 세대를 먼저 보면, 코드표 세대가 '1세대/2세대' 처럼 둘을 겹쳐 쓴 행이
  // 숫자 하나로만 읽혀 떨어져 나가고 엉뚱한 차종 행에 붙는다 —
  // 실제로 'BMW X1 [101] 2세대' 가 X1 행 대신 '1시리즈 2세대' 행에 붙었다.
  if (rec.model) {
    // 해외 구역은 상품명이 영문·일문이라 코드표의 '모델명 (영문)' 칸(modelAlt)도 같이 보고,
    // 일문은 가타카나를 한글로 바꾼 것까지 함께 견준다.
    // 공백을 지운 값이 아니라 **원문**을 넘긴다 — containsWord 가 공백 자리를 낱말 경계로 쓴다.
    const namesRaw = [rec.model, jpToKo(rec.model), ...dictNames(rec.model)]
      .filter(Boolean).filter((v, i, a) => a.findIndex(x => norm(x) === norm(v)) === i);
    const namesW = namesRaw.map(words);

    const hit = e => {
      // 이름이 서로 품고 있는 경우를 낱말 경계로 가린다 —
      // '벤츠 GLA클래스' 가 '벤츠 A클래스' 로 잘못 붙던 것을 막는다.
      const tight = raw => {
        const W = words(raw);
        return namesW.some(V => V.s === W.s || containsWord(V, W) || containsWord(W, V));
      };
      // 앞부분만 일치하는 느슨한 비교는 영문·일문 이름에만 쓴다. 국문 모델명에까지 쓰면
      // '싼타페' ↔ '싼타페 DM' 처럼 다른 차종이 서로 붙어 본사몰이 26행 깎였다(실측).
      const loose = raw => {
        const n = norm(raw);
        return namesRaw.some(v => {
          const nmv = norm(v);
          return n.length >= 8 && nmv.length >= 8 && (n.startsWith(nmv) || nmv.startsWith(n));
        });
      };
      if (tight(e.model)) return true;
      return rowAltNames(e).filter(Boolean).some(m => tight(m) || loose(m));
    };
    let f = pool.filter(hit);
    // 여럿이 걸리면 더 구체적인 이름이 이긴다 — '해치백 S' 는 '해치백' 도 품고 있어서 둘 다
    // 걸리는데, 제목이 'MINI 쿠퍼 해치백 S' 면 긴 쪽이 맞다. 제목 안에 통째로 든 이름만 견준다.
    if (f.length > 1) {
      const fit = e => Math.max(0, ...[e.model, ...rowAltNames(e)].filter(Boolean)
        .filter(m => namesW.some(V => containsWord(V, m))).map(m => norm(m).length));
      const best = Math.max(...f.map(fit));
      if (best > 0) {
        const top = f.filter(e => fit(e) === best);
        if (top.length === 1) f = top;
      }
    }
    if (take(f, '모델명까지')) { bump(tally.verdict, '확정'); out.push(row); continue; }
    if (f.length) pool = f;
  }
  if (years) {
    if (take(pool.filter(e => e.ymStart === years.start && e.ymEnd === years.end), '모델명+연식')) { bump(tally.verdict, '확정'); out.push(row); continue; }
    const g = pool.filter(e => e.ymStart === years.start);
    if (take(g, '모델명+연식시작')) { bump(tally.verdict, '확정'); out.push(row); continue; }
    if (g.length) pool = g;
  }
  if (gen?.no != null) {
    const f = pool.filter(e => e.genNo === gen.no);
    if (take(f, '모델명+세대')) { bump(tally.verdict, '확정'); out.push(row); continue; }
    if (f.length) pool = f;
  }
  // 이름 전체가 포함돼야 붙는 비교로는 'Porsche Cayman' 이 코드표 '718카이맨' 과 안 붙는다.
  // 마지막으로 **낱말** 겹침을 본다 — Cayman · Ghibli · Panamera 처럼 그 차종에서만 쓰는 말이
  // 후보 중 딱 한 행에서만 나오면 그 행으로 본다. 둘 이상이면 손대지 않는다(엉뚱하게 붙느니 남긴다).
  if (pool.length > 1 && rec.model) {
    // 숫자를 낱말에서 떼면 '6시리즈' 가 '시리즈' 가 되어 1시리즈와 겹친다(실제로 오매칭했다).
    // 영문·숫자·한글이 붙은 덩어리를 통째로 한 낱말로 본다: '6시리즈', '718', 'cayman'.
    const words = t => new Set(String(t).toLowerCase().match(/[a-z0-9가-힣]{2,}/g) || []);
    const mine = words(`${rec.model} ${jpToKo(rec.model)} ${dictNames(rec.model).join(' ')}`);
    if (mine.size) {
      const scored = pool.filter(e => {
        const theirs = words(`${e.model} ${rowAltNames(e).join(' ')}`);
        for (const w of theirs) if (mine.has(w)) return true;
        return false;
      });
      if (take(scored, '낱말 겹침')) { bump(tally.verdict, '확정'); out.push(row); continue; }
    }
  }
  if (takeAll(pool, '후보가 같은 차종')) { bump(tally.verdict, '확정'); out.push(row); continue; }
  row.verdict = '후보다중';
  row.note = [row.note, `후보 ${pool.length}행: ` + pool.slice(0, 5).map(e => `${e.row}(${e.model}/${e.ymRaw})`).join(' , ')]
    .filter(Boolean).join(' / ');
  bump(tally.verdict, '후보다중');
  out.push(row);
}

// ── 보고 ──
for (const ch of channels) {
  const t = perChannel.get(ch);
  const live = [...t.verdict].filter(([k]) => k !== '통합상품' && !k.startsWith('대상아님')).reduce((a, [, v]) => a + v, 0);
  console.log(`■ ${ch}`);
  console.log('  판매상태: ' + [...t.state].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' / '));
  console.log(`  판정 (대조 대상 ${live}건):`);
  for (const [k, v] of [...t.verdict].sort((a, b) => b[1] - a[1])) {
    if (k === '통합상품' || k.startsWith('대상아님')) continue;
    console.log(`    ${String(v).padStart(5)}  ${k}   ${(v / live * 100).toFixed(1)}%`);
  }
  console.log('');
}

const carRows = CT.filter(e => e.table === '자동차');
console.log('■ 코드표 자동차 ' + carRows.length + '행 — 채널별 등록');
for (const ch of channels) {
  const n = carRows.filter(e => matched.get(`자동차:${e.row}`)?.has(ch)).length;
  console.log(`  ${ch}: ${n}  (미등록 ${carRows.length - n})`);
}
const both = carRows.filter(e => channels.every(ch => matched.get(`자동차:${e.row}`)?.has(ch))).length;
const none = carRows.filter(e => !matched.has(`자동차:${e.row}`)).length;
console.log(`  전 채널 등록: ${both}  (${channels.join(', ')})`);
console.log(`  어느 채널에도 없음: ${none}`);

writeCsv(path.join(DIR, 'match_명단.csv'),
  ['채널', '상품ID', '옵션ID', '상품명', '옵션', '판매구성', '판매상태', '추출_부품번호', '추출방식', '추출_세대', '연식시작', '연식종료',
   '코드표_행', '코드표', '제조사', '모델명', '세대', '연식', '판정', '비고'],
  out.map(r => [r.channel, r.productId, r.optionIds, r.productName, r.optionText, r.form || '', r.state,
    r.partKey, r.how, r.genNo, r.ymStart, r.ymEnd,
    r.ctRow, r.ctTable, r.ctBrand, r.ctModel, r.ctGen, r.ctYm, r.verdict, r.note]));

writeCsv(path.join(DIR, 'match_현황.csv'),
  ['코드표_행', '부품번호', '제조사', '모델명', '세대', '연식', ...channels, '등록채널수'],
  carRows.map(e => {
    const s = matched.get(`자동차:${e.row}`) || new Set();
    return [e.row, e.partRaw, e.brand, e.model, e.genRaw, e.ymRaw,
      // 칸에 O 대신 실제 등록된 내용을 적는다 — 어느 상품·게시물로 올라가 있는지 바로 보이게.
      // 한 코드표 행에 여러 건이 걸리면 3건까지만 적고 나머지는 개수로 줄인다.
      ...channels.map(ch => {
        if (!s.has(ch)) return '';
        const v = [...(forms.get(`자동차:${e.row}|${ch}`) || ['O'])];
        return v.length > 3 ? v.slice(0, 3).join(' | ') + ` | 외 ${v.length - 3}건` : v.join(' | ');
      }),
      s.size];
  }));

// 칸을 눌러 구매 페이지로 가기 위한 번호표. 현황 CSV 를 무겁게 하지 않으려고 따로 쓴다.
const linkRows = [];
for (const [fk, m] of links) {
  const [k, ch] = fk.split('|');
  const row = k.split(':')[1];
  for (const [id, title] of m) linkRows.push([row, ch, id, title]);
}
writeCsv(path.join(DIR, 'match_링크.csv'), ['코드표_행', '채널', '상품ID', '제목'], linkRows);

const unmatched = carRows.filter(e => !matched.has(`자동차:${e.row}`));
writeCsv(path.join(DIR, 'match_미등록.csv'),
  ['코드표_행', '부품번호', '제조사', '모델명', '세대', '연식', '차량코드', 'BSA', '사유'],
  unmatched.map(e => [e.row, e.partRaw, e.brand, e.model, e.genRaw, e.ymRaw, e.chassis, e.bsa,
    !e.partKey ? '부품번호 미부여/형식오류' : (e.ymStart === null ? '연식 파싱 불가' : '어느 채널에도 미등록')]));

const need = out.filter(r => ['미해결', '고아', '후보다중'].includes(r.verdict));
writeCsv(path.join(DIR, 'match_확인필요.csv'),
  ['채널', '상품ID', '상품명', '옵션', '추출_부품번호', '판정', '비고'],
  need.map(r => [r.channel, r.productId, r.productName, r.optionText, r.partKey, r.verdict, r.note]));

console.log('\n끝.');
