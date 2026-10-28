/**
 * 신규 등록 중복 예외 — 같은 상품이 이미 그 쇼핑몰에 있으면 새로 만들지 않고 막는다.
 *
 * 왜 필요한가
 *   네이버·쿠팡·아임웹은 등록 버튼을 누를 때마다 '새 상품'을 만든다. 같은 차·같은 번호를
 *   두 번 누르면 판매자센터에 똑같은 상품이 둘 생기고, 되돌리려면 사람이 찾아서 지워야 한다.
 *   아마존은 SKU 로 PUT 이라 같은 SKU 면 기존 리스팅을 조용히 덮어쓴다.
 *
 * 무엇을 '중복'으로 보나 — 정확한 중복만
 *   쿠팡·네이버·아임웹 : 같은 차(브랜드+차종) + 같은 상품번호 + 같은 BSA 판
 *   아마존             : 판매자 + 마켓 + SKU
 *   eBay               : environment + SKU (ebay.js saveDraft/publish 가 직접 막는다)
 *   차종 상품은 있는데 번호가 새로운 경우는 막지 않는다 — 옵션 추가냐 새 상품이냐는
 *   아직 정하지 않은 업무 결정이다.
 *
 * 판정 근거(우선순위)
 *   1) 원장   — 이 PC 가 성공적으로 등록한 기록 (registration_ledger.js, userData)
 *   2) 스냅샷 — data/vehicle_catalog.json 의 쿠팡 상품 671개, 아마존 목록 캐시
 *   3) 실시간 — 등록과 같은 자격증명으로 조회할 수 있을 때
 *   조회가 실패했을 때 막을지(fail-closed) 보낼지(fail-open)는 채널마다 다르다 — 각 check 머리말.
 *
 * 조회가 이상한 답을 주면 '없음'이 아니라 '모름(unknown)'이다. 모름은 원장·스냅샷 적중을 풀지 않는다.
 *
 * 이 파일은 electron 을 import 하지 않는다. 조회 함수는 전부 주입받아 테스트에서 가짜로 바꾼다.
 */

const clean = v => String(v ?? '').replace(/\s+/g, ' ').trim();
const ALNUM = /[a-z0-9]/i;
const MIN = 60 * 1000;
const DELETED = /삭제|DELETE/i;

// ── 오류와 응답 ─────────────────────────────────────────────────────────

/** 정확한 중복. 핸들러는 이걸 { success:false, duplicate:true, … } 로 바꿔 돌려준다. */
export class DuplicateRegistrationError extends Error {
  constructor(message, { channel = '', source = '', existing = null } = {}) {
    super(message);
    this.name = 'DuplicateRegistrationError';
    this.duplicate = true;
    this.channel = channel;
    this.source = source;
    this.existing = existing || { channel, source, key: {}, products: [] };
  }
}

/** 중복인지 확인하지 못해 멈춘 것(fail-closed 채널). 중복이라고 단정하지 않는다. */
export class DuplicateCheckUnavailableError extends Error {
  constructor(message, { channel = '', cause = null } = {}) {
    super(message);
    this.name = 'DuplicateCheckUnavailableError';
    this.duplicate = false;
    this.checkFailed = true;
    this.channel = channel;
    this.cause = cause;
  }
}

export const isGuardError = e => !!(e && (e.duplicate === true || e.checkFailed === true));

export function guardErrorResponse(e) {
  return e.duplicate
    ? { success: false, duplicate: true, error: e.message, existing: e.existing }
    : { success: false, duplicate: false, checkFailed: true, error: e.message };
}

// ── 정규화 ──────────────────────────────────────────────────────────────

// 앞 두 개는 scratch/build_vehicle_catalog.mjs optionNo 와 글자까지 같다 — 스냅샷을 구운 규칙과
// 어긋나면 스냅샷의 번호와 여기서 읽은 번호가 달라져 적중이 안 된다.
// 뒤 두 개는 build 가 못 읽던 '[B301] 2024' · '[B414]' · '2025~ L234' 를 읽는다(스냅샷 3건, 연도 오인 0건).
const NO_PATTERNS = [
  /No\.\s*([A-Za-z]?\d+(?:-\d+(?!\s*세대))?)/id,
  /^([A-Za-z]\d+(?:-\d+(?!\s*세대))?)/d,
  /\[\s*([A-Za-z]?\d{2,5}(?:-\d+)?)\s*\]/d,
  /(?:^|\s)([A-Za-z]\d{2,4})$/d,
];
// 요청 쪽은 사람이 '612' 처럼 번호만 적기도 한다(셸 bareNo 와 같은 규칙).
const BARE_NO = /^(?:No\.?\s*)?([A-Za-z]?\d+(?:-\d+(?!\s*세대))?)/id;

function findNo(text, patterns) {
  const t = clean(text);
  for (const re of patterns) {
    const m = t.match(re);
    if (m) return { no: m[1].toUpperCase(), next: t.charAt(m.indices[1][1]) };
  }
  return null;
}

/** 옵션 문구에서 상품번호. 'No.h131번 (7세대)' → 'H131', 못 찾으면 ''. */
export function optionNo(text) {
  return findNo(text, NO_PATTERNS)?.no || '';
}

/**
 * 요청 쪽 전용. 번호 바로 뒤에 영숫자가 붙어 있으면('612A') 어디까지가 번호인지 알 수 없다 —
 * '612' 로 잘라 판정하면 엉뚱한 상품을 중복으로 막으므로 그 옵션은 판정하지 않는다.
 */
export function requestNo(text) {
  const f = findNo(text, [...NO_PATTERNS, BARE_NO]);
  if (!f) return { no: '', ambiguous: false };
  if (ALNUM.test(f.next)) return { no: '', ambiguous: true };
  return { no: f.no, ambiguous: false };
}

// 상품 쪽(쿠팡 item·네이버 옵션) 문자열은 스냅샷과 같은 optionNo 규칙으로만 읽는다.
// 맨 앞 숫자(BARE_NO)까지 받으면 '2021~'·'24.10~'·'7세대'·'1개' 가 번호로 읽혀 없는 번호가 생기고,
// 네이버 absent 판정의 '후보마다 번호를 1개 이상 읽음' 조건이 헛되이 채워진다.
function productNo(text) {
  return optionNo(text);
}

function codeInfo(code) {
  const s = String(code ?? '').trim();
  const m = s.match(/^(?:No\.?\s*)?([A-Za-z]?\d+(?:-\d+)?)/id);
  if (!m) return { code: '', ambiguous: false };
  if (ALNUM.test(s.charAt(m.indices[1][1]))) return { code: '', ambiguous: true };
  return { code: m[1].toUpperCase(), ambiguous: false };
}

/** 아임웹 상품 코드. ' no.h152 ' → 'H152'. 뒤에 영숫자가 붙어 애매하면 ''. */
export function normCode(code) {
  return codeInfo(code).code;
}

/** 'BSA 없음' · 'BSA X' 처럼 부정 표기는 BSA 가 아니다(스냅샷에 64건). */
export function hasBsa(t) {
  const s = String(t ?? '');
  return /BSA/i.test(s) && !/BSA\s*(?:X\b|없음|미적용|불가)/i.test(s);
}

/**
 * 아임웹 '연식' 옵션값으로 판(BSA/일반)을 가른다. 아임웹은 'BSA O' · 'BSA X' 로 적으므로
 * hasBsa 로 보면 'BSA O' 와 'BSA X' 가 섞인 일반판을 BSA 로 오판한다 — 따로 센다.
 */
export function bsaEditionOfImwebValues(values) {
  const list = (values || []).map(v => String(v ?? ''));
  if (list.some(v => /BSA\s*X/i.test(v))) return 'normal';
  if (list.some(v => /BSA\s*O/i.test(v))) return 'bsa';
  return 'unknown';
}

// 브랜드 별칭. ① 쿠팡 상품명 표기(build COUPANG_BRAND_ALIAS + 운영 중 본 것) ② vehicle_i18n aliases.
const RAW_COUPANG_BRAND_ALIAS = {
  '토요타': '도요타', 'KGM': '쌍용', 'KG모빌리티': '쌍용', '가와자키': '가와사키', '험머': '허머',
  '쎄미시스코': '세미시스코', '아큐라': '어큐라',
  // 쿠팡은 SM6·QM6·필랑트를 '르노' 로, UI 는 '르노삼성'·'르노 코리아' 로 적는다 — 셋 다 같은 키로.
  '르노': '르노 코리아',
};
const RAW_I18N_BRAND_ALIAS = { '르노삼성': '르노 코리아', '허머': 'HUMMER', '혼다 모터스': '혼다 바이크' };
const baseBrand = b => clean(b).replace(/\([^)]*\)/g, '').replace(/\s+/g, '').toLowerCase();
const aliasTable = raw => Object.fromEntries(Object.entries(raw).map(([k, v]) => [baseBrand(k), baseBrand(v)]));
const COUPANG_BRAND_ALIAS = aliasTable(RAW_COUPANG_BRAND_ALIAS);
const I18N_BRAND_ALIAS = aliasTable(RAW_I18N_BRAND_ALIAS);

/** '기아 (KIA)' · '르노삼성' · '토요타' 를 같은 키로. */
export function brandKey(b) {
  let k = baseBrand(b);
  if (!k) return '';
  if (k.includes('/')) k = k.split('/')[0];   // 카탈로그의 '어큐라/아큐라'
  k = COUPANG_BRAND_ALIAS[k] || k;
  return I18N_BRAND_ALIAS[k] || k;
}

export const squash = s => clean(s).toLowerCase().replace(/\s+/g, '');
export const spaced = s => clean(s).toLowerCase();
const modelKey = squash;

// short 가 long 안에 '경계가 맞게' 들어 있는가. 짧은 쪽 끝이 영숫자면 바로 바깥 글자는 영숫자가 아니어야 한다.
//   X3 ⊂ iX3 → 앞이 'i' 라 불일치,  SL ⊂ SLK → 뒤가 'k' 라 불일치,  K5 ⊂ 'K5 680R' → 일치
function boundedContains(long, short) {
  if (!short || short.length > long.length) return false;
  const guardFront = ALNUM.test(short[0]);
  const guardBack = ALNUM.test(short[short.length - 1]);
  for (let i = long.indexOf(short); i !== -1; i = long.indexOf(short, i + 1)) {
    const before = long[i - 1], after = long[i + short.length];
    if (guardFront && before && ALNUM.test(before)) continue;
    if (guardBack && after && ALNUM.test(after)) continue;
    return true;
  }
  return false;
}

/**
 * 차종 비교: 같거나, 경계가 맞게 포함되면 같은 차.
 *   같은 차 : 골프A↔골프, K5↔K5 680R, M4↔M3/M4, 싼타페↔디올뉴싼타페
 *   다른 차 : X3↔iX3, S클래스↔CLS클래스, SL↔SLK, A6↔"A4-A 680R"
 */
export function sameModel(a, b) {
  const sa = squash(a), sb = squash(b);
  if (!sa || !sb) return { match: false, exact: false };
  if (sa === sb) return { match: true, exact: true };
  for (const [x, y] of [[spaced(a), spaced(b)], [sa, sb]]) {
    const [long, short] = x.length >= y.length ? [x, y] : [y, x];
    if (boundedContains(long, short)) return { match: true, exact: false };
  }
  return { match: false, exact: false };
}

/** 카탈로그에서 브랜드 이름 목록(상품명에서 브랜드를 가를 때). 긴 것부터 — '르노 코리아' 가 '르노' 보다 먼저. */
export function brandsFromCatalog(catalog) {
  const set = new Set();
  const add = b => {
    const c = clean(b);
    if (!c) return;
    set.add(c);
    const bare = clean(c.replace(/\([^)]*\)/g, ' '));
    if (bare) set.add(bare);
  };
  for (const v of catalog?.variants || []) add(v?.brand);
  for (const p of catalog?.coupang || []) add(p?.brand);
  for (const k of [...Object.keys(RAW_COUPANG_BRAND_ALIAS), ...Object.keys(RAW_I18N_BRAND_ALIAS)]) add(k);
  return [...set].sort((a, b) => b.length - a.length);
}
const DEFAULT_BRANDS = brandsFromCatalog(null);

// UI 카테고리(imweb_categories)는 제네시스를 '현대' 밑, 허머를 'GMC'·'기타' 밑, GMC 유콘을 '캐딜락' 밑
// 차종으로 두고, 쿠팡 상품명은 이들을 브랜드로 쓴다. 차종 앞머리에 있으면 브랜드로 올려 양쪽을 같은 모양으로 맞춘다.
// 나머지를 모르는 브랜드까지 일반화하지 않는다 — '현대' + '제네시스'(뒤가 빔)처럼 애매하면 그대로 둔다.
const EMBEDDED_BRANDS = ['제네시스', 'GMC', '허머', '험머'];
function liftEmbeddedBrand(brand, model) {
  let b = brand, m = model;
  for (let i = 0; i < 3; i++) {
    const lower = m.toLowerCase();
    const hit = EMBEDDED_BRANDS.find(e => lower.startsWith(e.toLowerCase()));
    if (!hit) break;
    const rest = clean(m.slice(hit.length));
    if (!rest) break;
    b = m.slice(0, hit.length); m = rest;
  }
  return [b, m];
}

function carFrom(brand, model) {
  const [b, m] = liftEmbeddedBrand(clean(brand), clean(model));
  return { brand: b, model: m, brandKey: brandKey(b), modelKey: modelKey(m) };
}

/**
 * 상품명 → {brand, model}. 규칙은 build splitName 과 같다(가장 긴 브랜드 앞머리, 못 찾으면 첫 낱말).
 * 쿠팡 '… 광각 사이드 와이드미러' · 아임웹 '… 미러 1셋 [612]' 꼬리를 뗀다.
 */
export function splitCarTitle(title, brands = DEFAULT_BRANDS) {
  const core = clean(title)
    .replace(/^옵틱\s*글래스?\s+/, '')
    .replace(/^(?:19|20)\d{2}\s*년?\s+/, '')
    .replace(/^오토바이\s+/, '')
    .replace(/\s*광각\s*사이드\s*(?:와이드\s*)?미러.*$/, '')
    .replace(/\s+미러\s+(1셋|운전석\/조수석)\s*(\[[^\]]*\])?$/, '')
    .trim();
  const lower = core.toLowerCase();
  const fit = b => {
    const bl = String(b).toLowerCase();
    return lower === bl || lower.startsWith(bl + ' ')
      || (lower.startsWith(bl) && /^[A-Za-z0-9]/.test(core.slice(bl.length)));   // 테슬라S
  };
  const hit = [...(brands || DEFAULT_BRANDS)].sort((a, b) => b.length - a.length).find(b => b && fit(b));
  let brand, model;
  if (hit) { brand = core.slice(0, hit.length); model = core.slice(hit.length).trim(); }
  else {
    const i = core.indexOf(' ');
    brand = i === -1 ? core : core.slice(0, i);
    model = i === -1 ? '' : core.slice(i + 1).trim();
  }
  return carFrom(brand, model);
}

/** 요청 데이터의 차. brand·model 이 오면 그대로, 없으면 상품명에서 가른다. */
export function carOf(data, brands) {
  if (data?.brand && data?.model) return carFrom(data.brand, data.model);
  return splitCarTitle(data?.title || data?.optionModel || '', brands);
}

/**
 * 같은 차인가 → {match, exact}. 브랜드가 별칭까지 같으면 차종을 sameModel 로 본다.
 * 브랜드 키가 다르면 '브랜드 차종' 전체로 한 번 더 본다 — UI 가 브랜드를 차종 칸에 넣은
 * '기타' › '피아트500X' 와 쿠팡 '피아트 500X' 가 같은 차로 잡힌다(X3↔iX3 는 경계 규칙으로 여전히 다름).
 */
export function sameCar(a, b) {
  const A = carFrom(a?.brand, a?.model), B = carFrom(b?.brand, b?.model);
  if (A.brandKey && A.modelKey && B.brandKey && B.modelKey) {
    if (A.brandKey === B.brandKey) return sameModel(A.model, B.model);
    const full = sameModel(`${A.brand} ${A.model}`, `${B.brand} ${B.model}`);
    return full.match ? { match: true, exact: false } : full;
  }
  return sameModel(`${A.brand} ${A.model}`, `${B.brand} ${B.model}`);
}

// 아마존 — amazon.js registerProduct 가 같은 함수를 쓴다(판정한 SKU 와 등록한 SKU 가 어긋나지 않게).
export const AMAZON_JP_MARKETPLACE_ID = 'A1VC38T7YXB528';
export const amazonSkuOf = data => String(data?.sku || data?.itemCode || data?.code || '').trim();
export const amazonMarketplaceOf = (data, config) => data?.marketplaceId || config?.marketplaceId || 'ATVPDKIKX0DER';
export function amazonListingUrl(mp, asin) {
  if (!asin) return '';
  return mp === AMAZON_JP_MARKETPLACE_ID ? `https://www.amazon.co.jp/dp/${asin}` : `https://www.amazon.com/dp/${asin}`;
}

// ── 공통 실행기 ─────────────────────────────────────────────────────────

/**
 * 같은 상품 등록이 동시에 두 번 들어오면(버튼 연타·창 두 개) 둘 다 '아직 없음'으로 판정된다.
 * 판정~등록~기록 동안 키를 잡아 두 번째를 막는다. 키에서 차종 이름은 뺐다 —
 * 싼타페와 디올뉴싼타페처럼 포함 비교로 같은 차인 두 요청이 서로 다른 키로 빠져나가지 않게.
 * 등록이 멈춰 잠금이 안 풀리는 경우를 대비해 ttl 이 지나면 넘겨받는다.
 */
export function createInflightLock({ ttlMs = 15 * MIN, now = Date.now, log = console } = {}) {
  const held = new Map();   // key → { at, channel, token }
  return {
    acquire(keys, channel) {
      const list = [...new Set((keys || []).filter(Boolean))];
      if (!list.length) return () => {};
      const t = now();
      for (const k of list) {
        const h = held.get(k);
        if (h && t - h.at < ttlMs) {
          throw new DuplicateRegistrationError('같은 상품 등록이 이미 진행 중입니다 — 끝난 뒤 다시 시도하세요.', {
            channel, source: 'inflight', existing: { channel, source: 'inflight', key: { lockKey: k }, products: [] },
          });
        }
      }
      for (const k of list) {
        const h = held.get(k);
        if (h) log.warn?.(`[중복검사] ${Math.round((t - h.at) / 1000)}초 된 등록 잠금을 넘겨받음: ${k}`);
      }
      const token = {};
      for (const k of list) held.set(k, { at: t, channel, token });
      let released = false;
      return () => {
        if (released) return;
        released = true;
        for (const k of list) if (held.get(k)?.token === token) held.delete(k);
      };
    },
  };
}

/**
 * 판정 → 등록 → 원장 기록. 기록 실패는 등록 성공을 실패로 바꾸지 않는다(notice 만 남긴다).
 * data.allowDuplicate === true 면 check 에 bypass 를 넘긴다 — 무엇을 풀지는 채널이 정한다
 * (아마존은 덮어쓰기 방지라 bypass 여도 실시간 조회로 막는다).
 */
export async function runGuardedRegistration({ channel, data, plan, check, register, record, inflight, log = console }) {
  const notices = [...(plan.notices || [])];
  const bypass = data?.allowDuplicate === true;
  if (plan.skip && plan.skipReason) { notices.push(plan.skipReason); log.warn(`[중복검사] ${channel}: ${plan.skipReason}`); }
  const release = inflight ? inflight.acquire(plan.lockKeys || [], channel) : () => {};
  try {
    if (bypass) log.warn(`[중복검사] ${channel}: allowDuplicate=true — 중복 검사 일부를 건너뜀 (${(plan.lockKeys || []).join(', ') || '키 없음'})`);
    if (!plan.skip) { const v = await check(plan, { bypass }); notices.push(...(v?.notices || [])); }
    const result = await register();
    try { const w = await record(plan, result, { bypass }); if (w) notices.push(...[].concat(w)); }
    catch (e) {
      log.warn(`[중복검사] ${channel} 원장 기록 실패(등록은 성공): ${e.message}`);
      notices.push('중복 방지 기록 저장에 실패했습니다 — 등록은 정상 완료.');
    }
    return { result, notices, bypassed: bypass };
  } finally { release(); }
}

export const noticeSuffix = n => (n.length ? ` ⚠ ${n.join(' / ')}` : '');

export function withTimeout(promise, ms, label = '작업') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 시간 초과(${Math.round(ms / 1000)}초)`)), ms);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

/** 원장 적중이 유효한가. 실시간으로 '없음'이 확인됐고 기록 뒤 graceMs 가 지났을 때만 푼다. */
export function ledgerHitStands(entry, liveState, now, graceMs) {
  if (liveState !== 'absent') return true;
  const t = typeof now === 'function' ? +now() : +now;
  const at = Date.parse(entry?.registeredAt);
  if (!Number.isFinite(at)) return false;
  return t - at < graceMs;
}

// ── 내부 헬퍼 ───────────────────────────────────────────────────────────

function fmtTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso || '?');
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const itemLabel = i => `No.${i.no}${i.bsa ? ' BSA' : ''}`;
const pushOnce = (list, s) => { if (s && !list.includes(s)) list.push(s); };
const escapeRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const codeToken = code => new RegExp(`\\[\\s*(?:No\\.?\\s*)?${escapeRe(code)}\\s*\\]`, 'i');

// 원장 읽기가 실패해도 등록을 막지 않는다 — 스냅샷·실시간 조회로 넘어가고 notice 를 남긴다.
function readActive(ledger, channel, notices) {
  if (!ledger) return [];
  try {
    const rows = ledger.active(channel);
    if (ledger.lastReadError) pushOnce(notices, ledger.lastReadError);
    return rows;
  } catch (e) {
    pushOnce(notices, `중복 방지 기록을 읽지 못했습니다(${e.message}) — 스냅샷·실시간 조회로만 확인합니다`);
    return [];
  }
}

function supersedeQuietly(ledger, entry, reason, log) {
  try { ledger?.supersede(entry.id, reason); }
  catch (e) { log?.warn?.(`[중복검사] 원장 해제 표시 실패: ${e.message}`); }
}

// 쉼표로 나눈 옵션 → 판정할 item. 등록 본체(coupang.js _buildCopyPayload)와 같은 규칙으로 나눠야
// 스냅샷·실시간 결과(= 그렇게 만들어진 상품)와 맞는다.
function requestItems(text, notices) {
  const items = [], missing = [];
  for (const raw of String(text || '').split(',').map(s => s.trim()).filter(Boolean)) {
    const r = requestNo(raw);
    if (r.ambiguous) { notices.push(`옵션 "${raw}" 의 상품번호가 애매해(번호 뒤에 글자가 붙음) 중복 확인에서 뺐습니다`); continue; }
    if (!r.no) { missing.push(raw); continue; }
    const item = { text: raw, no: r.no, bsa: hasBsa(raw) };
    if (!items.some(x => x.no === item.no && x.bsa === item.bsa)) items.push(item);
  }
  if (items.length) for (const raw of missing) notices.push(`옵션 "${raw}" 에서 상품번호를 찾지 못해 중복 확인에서 뺐습니다`);
  return items;
}

const bsaKey = bsa => (bsa ? 'BSA' : '-');

// ── 쿠팡: 원장·스냅샷은 fail-closed, 실시간 조회 실패는 fail-open ─────────────
//   fail-open 인 이유: 복사등록은 늘 새 상품이라 Wing 에서 되돌릴 수 있고, 조회는 등록과 같은
//   HMAC·프록시 경로라 조회가 죽으면 등록도 대개 죽는다. 목록이 7페이지 이상이라 한 번의
//   실패로 등록 업무 전체가 멈추게 두면 안 된다. 이 PC 의 반복 등록은 원장이, 대량의
//   기존 상품은 스냅샷이 막는다.

export function planCoupang(data, { vendorId = '', brands = DEFAULT_BRANDS } = {}) {
  const notices = [];
  const base = { channel: 'coupang', vendorId: String(vendorId ?? ''), brands, notices, lockKeys: [], title: data?.title || '' };
  const car = carOf(data, brands);
  if (!car.brandKey || !car.modelKey) return { ...base, car, skip: true, skipReason: '차종을 알 수 없어 중복 확인 생략' };
  const items = requestItems(data?.optionModel, notices);
  if (!items.length) return { ...base, car, skip: true, skipReason: '옵션에서 상품번호를 찾지 못해 중복 확인 생략' };
  return {
    ...base, car, items, skip: false,
    // data.productId 는 복사할 **템플릿** ID 다 — 기존 상품이 아니므로 판정에 쓰지 않는다.
    templateId: data?.productId || null,
    category: data?.category || '',
    lockKeys: items.map(i => `coupang|${base.vendorId}|${car.brandKey}|${i.no}|${bsaKey(i.bsa)}`),
  };
}

// 쿠팡 상품 한 건의 (번호, BSA) 목록. 같은 문자열 안에서 번호와 BSA 를 함께 읽는다 —
// itemName 의 BSA 와 다른 속성의 번호를 섞으면 없는 조합이 생긴다.
function coupangOptionPairs(items) {
  const out = [];
  for (const it of items || []) {
    for (const s of [it?.itemName, ...((it?.attributes || []).map(a => a?.attributeValueName))]) {
      const no = productNo(s);
      if (no) out.push({ no, bsa: hasBsa(s), text: String(s) });
    }
  }
  return out;
}

async function coupangProductState(lookup, id, wanted) {
  if (!lookup?.getProduct) return 'unknown';
  let res;
  try { res = await withTimeout(lookup.getProduct(id), 20000, `쿠팡 ${id} 조회`); }
  catch (e) {
    // 문구는 실제 응답으로 확인하지 못했다. 두 조건을 다 만족할 때만 '없음'으로 본다.
    const msg = String(e?.message || '');
    if (/\((?:400|404)\)/.test(msg) && /(존재하지|없는|찾을 수 없|not\s*found)/i.test(msg)) return 'absent';
    return 'unknown';
  }
  if (!(res?.code === 'SUCCESS' && String(res.data?.sellerProductId) === String(id))) return 'unknown';
  if (DELETED.test(String(res.data.statusName || ''))) return 'absent';
  const pairs = coupangOptionPairs(res.data.items);
  if (wanted.some(w => pairs.some(p => p.no === w.no && p.bsa === w.bsa))) return 'present';
  return 'unknown';   // 옵션을 못 찾은 것은 '없음'의 증거가 아니다
}

function coupangSourceLabel(h, catalog) {
  if (h.source === 'ledger') return `원장(이 PC, ${fmtTime(h.entry?.registeredAt)} 등록)`;
  if (h.source === 'snapshot') return `쿠팡 상품 스냅샷 ${String(catalog?._built || '').slice(0, 10) || '(날짜 없음)'}`;
  return '쿠팡 실시간 조회';
}

function coupangDuplicate(plan, hits, catalog) {
  const lines = hits.map(h => `${itemLabel(h.item)} → 기존 상품 ${h.id || '(ID 없음)'}`
    + (h.name ? ` "${h.name}"` : '') + (h.optionText ? ` 옵션 "${h.optionText}"` : '')
    + ` [근거: ${coupangSourceLabel(h, catalog)}]` + (h.exact ? '' : ' (차종 표기 다름)'));
  const message = `중복 등록 차단: 쿠팡에 같은 상품이 이미 있습니다 — ${plan.car.brand} ${plan.car.model}. `
    + `${lines.join(' / ')}. 새 상품을 만들지 않았습니다. 옵션을 바꾸려면 상품수정 모드에서 이 ID를 불러오세요.`;
  const source = hits[0].source;
  return new DuplicateRegistrationError(message, {
    channel: 'coupang', source,
    existing: {
      channel: 'coupang', source,
      key: { vendorId: plan.vendorId, brand: plan.car.brand, model: plan.car.model, items: plan.items.map(i => ({ no: i.no, bsa: i.bsa })) },
      products: hits.map(h => ({ id: h.id || null, name: h.name || '', optionText: h.optionText || '', url: null, status: h.status || null, registeredAt: h.entry?.registeredAt || null, source: h.source })),
    },
  });
}

async function coupangLiveScan(plan, lookup, notices) {
  const rows = [];
  let token = '', pages = 0;
  do {
    const r = await lookup.listPage(token);
    if (!(r?.code === 'SUCCESS' && Array.isArray(r.data))) throw new Error(`목록 응답이 예상과 다름(code=${r?.code ?? '없음'})`);
    rows.push(...r.data);
    token = r.nextToken || '';
    pages++;
  } while (token && pages < 50);
  if (token) notices.push('목록 5000건 초과 — 일부만 확인');

  const cands = [];
  for (const d of rows) {
    const name = String(d?.sellerProductName || '');
    if (d?.statusName && DELETED.test(String(d.statusName))) continue;
    const sc = sameCar(plan.car, splitCarTitle(name, plan.brands));
    const loose = !!plan.car.modelKey && squash(name).includes(plan.car.modelKey);
    if (!sc.match && !loose) continue;
    cands.push({ id: String(d.sellerProductId), name, sc, rank: sc.match ? (sc.exact ? 0 : 1) : 2 });
  }
  cands.sort((a, b) => a.rank - b.rank);
  if (cands.length > 20) notices.push(`쿠팡 후보 ${cands.length}건 중 20건만 확인`);

  const hits = [];
  for (const c of cands.slice(0, 20)) {
    let res;
    try { res = await lookup.getProduct(c.id); }
    catch (e) { notices.push(`쿠팡 ${c.id} 조회 실패(${e.message})`); continue; }
    if (!(res?.code === 'SUCCESS' && String(res.data?.sellerProductId) === c.id)) { notices.push(`쿠팡 ${c.id} 조회 응답 이상`); continue; }
    if (DELETED.test(String(res.data.statusName || ''))) continue;
    const pairs = coupangOptionPairs(res.data.items);
    for (const item of plan.items) {
      const x = pairs.find(p => p.no === item.no && p.bsa === item.bsa);
      if (!x) continue;
      // 이름만 느슨하게 걸린 후보(차종 판정 불일치)는 막지 않는다 — X3 요청이 iX3 상품에 막히면 안 된다.
      if (c.sc.match) hits.push({ source: 'live', id: c.id, name: c.name, optionText: x.text, item, exact: c.sc.exact, status: res.data.statusName || null });
      else pushOnce(notices, `쿠팡 ${c.id}(${c.name}) 에 같은 번호 옵션이 있으나 차종이 달라 막지 않음`);
    }
  }
  return hits;
}

export async function checkCoupang(plan, { bypass } = {}, { ledger = null, catalog = null, lookup = null, now = () => new Date(), log = console } = {}) {
  if (bypass) return { notices: [] };
  const notices = [];
  const hits = [];

  // 1) 원장
  for (const e of readActive(ledger, 'coupang', notices)) {
    const d = e.detail || {};
    if (String(d.vendorId ?? '') !== plan.vendorId) continue;
    const sc = sameCar(plan.car, d);
    if (!sc.match) continue;
    for (const item of plan.items) {
      const x = (d.items || []).find(x => x.no === item.no && !!x.bsa === item.bsa);
      if (x) hits.push({ source: 'ledger', id: String(e.externalId || ''), name: e.title || '', optionText: x.text || '', item, exact: sc.exact, entry: e });
    }
  }

  // 2) 스냅샷 — 번호·BSA 는 저장된 no/bsa 대신 문구에서 다시 읽는다(부정 표기 'BSA 없음' 64건).
  for (const p of catalog?.coupang || []) {
    const sc = sameCar(plan.car, { brand: p.brand, model: p.model });
    if (!sc.match) continue;
    for (const o of p.options || []) {
      const no = optionNo(o?.text);
      if (!no) continue;
      for (const item of plan.items) {
        if (no === item.no && hasBsa(o.text) === item.bsa) {
          hits.push({ source: 'snapshot', id: String(p.id), name: p.name || '', optionText: o.text, item, exact: sc.exact });
        }
      }
    }
  }

  // 3) 로컬 적중 확인 — 쿠팡에서 삭제가 '확인'될 때만 푼다(유예시간 0). 모르면 막는다.
  if (hits.length) {
    const ids = [...new Set(hits.map(h => h.id).filter(Boolean))];
    const state = new Map();
    for (const id of ids.slice(0, 5)) {
      const wanted = hits.filter(h => h.id === id).map(h => h.item);
      state.set(id, await coupangProductState(lookup, id, wanted));
    }
    const kept = [];
    const released = new Set();
    for (const h of hits) {
      const st = state.get(h.id) || 'unknown';
      if (h.source === 'ledger') {
        if (!ledgerHitStands(h.entry, st, now, 0)) {
          if (!released.has(h.entry.id)) { released.add(h.entry.id); supersedeQuietly(ledger, h.entry, '쿠팡에서 삭제 확인', log); }
          continue;
        }
      } else if (st === 'absent') {
        pushOnce(notices, `스냅샷의 ${h.id} 는 쿠팡에서 삭제된 상품이라 제외`);
        continue;
      }
      kept.push(h);
    }
    if (kept.length) throw coupangDuplicate(plan, kept, catalog);
  }

  // 4) 실시간 조회 — 로컬 적중이 없을 때만. 실패는 fail-open.
  if (!lookup?.listPage || !lookup?.getProduct) {
    notices.push('쿠팡 실시간 중복 확인 실패 — 원장·스냅샷만 확인함(조회 수단 없음)');
    return { notices };
  }
  try {
    const liveHits = await withTimeout(coupangLiveScan(plan, lookup, notices), 45000, '쿠팡 실시간 중복 확인');
    if (liveHits.length) throw coupangDuplicate(plan, liveHits, catalog);
  } catch (e) {
    if (isGuardError(e)) throw e;
    notices.push(`쿠팡 실시간 중복 확인 실패 — 원장·스냅샷만 확인함(${e.message})`);
  }
  return { notices };
}

export function recordCoupang(ledger, plan, result, { bypass = false } = {}) {
  if (plan.skip) return null;
  if (!/^\d+$/.test(String(result?.data ?? ''))) return '등록 응답에 상품ID가 없어 중복 방지 기록을 남기지 않음';
  ledger.record({
    channel: 'coupang', keys: plan.lockKeys, externalId: String(result.data), url: null, verified: true,
    title: plan.title,
    detail: {
      vendorId: plan.vendorId, brand: plan.car.brand, model: plan.car.model,
      brandKey: plan.car.brandKey, modelKey: plan.car.modelKey,
      category: plan.category, templateId: plan.templateId, items: plan.items,
    },
    bypass: !!bypass,
  });
  return null;
}

// ── 네이버: 실시간 조회 실패는 fail-open ──────────────────────────────────
//   등록은 커머스API 없이 브라우저로 되고, 조회(커머스API)와 등록(판매자센터 로그인)의
//   자격증명이 다르다. 조회가 안 된다고 등록을 막으면 API 없는 PC 는 영영 등록을 못 한다.
//   판매자센터에서 되돌릴 수도 있다.
//   원장 행 해제: 확인된 행(상품번호 있음)은 30분 + 실시간 '없음'. 미확인 행(URL 을 못 받음)은
//   10분 동안 무조건 막고, 그 뒤는 조회 결과에 따라(아래 checkNaver).

const NAVER_CONFIRMED_GRACE = 30 * MIN;
const NAVER_UNVERIFIED_HOLD = 10 * MIN;
const NAVER_PARTIAL_HOLD = 24 * 60 * MIN;

export function planNaver(data, { brands = DEFAULT_BRANDS } = {}) {
  const notices = [];
  const base = { channel: 'naver', brands, notices, lockKeys: [], title: data?.title || '' };
  if (data?.mode === 'edit') return { ...base, skip: true };   // 상품수정 경로는 건드리지 않는다
  const car = carOf(data, brands);
  if (!car.brandKey || !car.modelKey) return { ...base, car, skip: true, skipReason: '차종을 알 수 없어 네이버 중복 확인 생략' };
  const items = requestItems(data?.optionProduct, notices);
  if (!items.length) return { ...base, car, skip: true, skipReason: '옵션에서 상품번호를 찾지 못해 네이버 중복 확인 생략' };
  return {
    ...base, car, items, skip: false, templateId: data?.templateId || null,
    lockKeys: items.map(i => `naver|${car.brandKey}|${i.no}|${bsaKey(i.bsa)}`),
  };
}

const naverConfirmed = e => !!(e?.verified && (e.detail?.channelProductNo || e.externalId));

async function naverLiveScan(plan, api) {
  const rows = await api.allProducts({ force: true });
  if (!Array.isArray(rows)) throw new Error('상품 목록 응답 형식 이상');
  const cands = [];
  for (const r of rows) {
    if (r?.statusType === 'DELETE') continue;
    const name = String(r?.name || '');
    const sc = sameCar(plan.car, splitCarTitle(name, plan.brands));
    const loose = squash(name).includes(plan.car.modelKey);
    if (!sc.match && !loose) continue;
    cands.push({ r, name, sc, rank: sc.match ? (sc.exact ? 0 : 1) : 2 });
  }
  cands.sort((a, b) => a.rank - b.rank);
  const truncated = cands.length > 20;
  let complete = !truncated;
  const problems = [];
  if (truncated) problems.push(`후보 ${cands.length}건 중 20건만 확인`);
  const hits = [];
  for (const c of cands.slice(0, 20)) {
    const originNo = c.r.originProductNo ?? c.r.id;
    let body;
    try { body = await api.originProduct(originNo); }
    catch (e) { complete = false; problems.push(`${originNo} 조회 실패: ${e.message}`); continue; }
    const oi = body?.originProduct?.detailAttribute?.optionInfo || {};
    const strings = [];
    for (const o of oi.optionCombinations || []) {
      for (const k of [1, 2, 3, 4]) { const s = o?.[`optionName${k}`]; if (s) strings.push({ s: String(s), opt1: String(o.optionName1 || '') }); }
    }
    for (const o of oi.optionSimple || []) if (o?.name) strings.push({ s: String(o.name), opt1: '' });
    for (const o of oi.optionStandards || []) if (o?.name) strings.push({ s: String(o.name), opt1: '' });
    const pairs = strings.map(x => ({ ...x, no: productNo(x.s), bsa: hasBsa(x.s) })).filter(x => x.no);
    if (!pairs.length) { complete = false; problems.push(`${originNo} 옵션에서 번호를 찾지 못함`); continue; }
    const carInOption = opt1 => !!opt1 && (sameModel(plan.car.model, opt1).match || sameCar(plan.car, splitCarTitle(opt1, plan.brands)).match);
    for (const item of plan.items) {
      const x = pairs.find(p => p.no === item.no && p.bsa === item.bsa && (c.sc.match || carInOption(p.opt1)));
      if (x) hits.push({ source: 'live', id: String(c.r.channelProductNo ?? originNo), originNo: String(originNo), name: c.name, optionText: x.s, item, exact: c.sc.match && c.sc.exact, status: c.r.statusType || null });
    }
  }
  const absent = rows.length > 0 && !truncated && complete && hits.length === 0;
  return { rows, hits, state: absent ? 'absent' : 'unknown', problems };
}

function naverDuplicate(plan, hits, source) {
  const lines = hits.map(h => {
    const e = h.entry;
    const where = source === 'ledger'
      ? `원장(이 PC, ${fmtTime(e.registeredAt)} 등록${naverConfirmed(e) ? '' : ', 상품번호 미확인'})`
      : '네이버 실시간 조회';
    const id = source === 'ledger' ? (e.detail?.channelProductNo || e.externalId || '') : h.id;
    const url = source === 'ledger' ? (e.url || '') : '';
    // _saveProduct 는 저장 실패를 삼키고 결과 주소로 현재 화면을 돌려준다 — 앞 등록의 결과 주소가
    // 복사·편집 화면이면 저장되지 않았을 수 있다는 것을 같이 알린다(막는 시간은 그대로).
    const maybeUnsaved = source === 'ledger' && !naverConfirmed(e) && /#\/products\/(?:copy|edit)\//.test(url)
      ? ' — 앞 등록 결과가 복사·편집 화면 주소라 저장되지 않았을 수 있습니다. 판매자센터에 없으면 '
        + `${fmtTime(new Date(e.registeredAt).getTime() + NAVER_UNVERIFIED_HOLD)} 이후 다시 시도하세요`
        + '(커머스API 조회 결과가 애매하면 최대 24시간 막힘)'
      : '';
    return `${itemLabel(h.item)} → 기존 상품 ${id || '(번호 미확인)'}` + (h.name ? ` "${h.name}"` : '')
      + (h.optionText ? ` 옵션 "${h.optionText}"` : '') + (url ? ` ${url}` : '')
      + ` [근거: ${where}]` + (h.exact ? '' : ' (차종 표기 다름)') + maybeUnsaved;
  });
  const message = `중복 등록 차단: 네이버 스마트스토어에 같은 상품이 이미 있습니다 — ${plan.car.brand} ${plan.car.model}. `
    + `${lines.join(' / ')}. 새 상품을 만들지 않았습니다. 옵션을 바꾸려면 상품수정 모드에서 이 상품번호를 불러오세요.`;
  return new DuplicateRegistrationError(message, {
    channel: 'naver', source,
    existing: {
      channel: 'naver', source,
      key: { brand: plan.car.brand, model: plan.car.model, items: plan.items.map(i => ({ no: i.no, bsa: i.bsa })) },
      products: hits.map(h => ({
        id: source === 'ledger' ? (h.entry.detail?.channelProductNo || h.entry.externalId || null) : h.id,
        name: h.name || '', optionText: h.optionText || '', url: source === 'ledger' ? (h.entry.url || null) : null,
        status: h.status || null, registeredAt: h.entry?.registeredAt || null,
      })),
    },
  });
}

export async function checkNaver(plan, { bypass } = {}, { ledger = null, api = null, apiError = null, now = () => new Date(), log = console } = {}) {
  if (bypass) return { notices: [] };
  const notices = [];
  const nowMs = +now();
  const nos = plan.items.map(i => `${i.no}${i.bsa ? ' BSA' : ''}`).join(', ');
  const failOpen = reason => `네이버 중복 확인을 못 했습니다(${reason}) — 원장만 확인하고 등록을 진행합니다. 판매자센터에서 ${plan.car.brand} ${plan.car.model} No.${nos} 를 확인하세요`;

  // 1) 원장
  const ledgerHits = [];
  for (const e of readActive(ledger, 'naver', notices)) {
    const d = e.detail || {};
    const sc = sameCar(plan.car, d);
    if (!sc.match) continue;
    const item = plan.items.find(i => (d.items || []).some(x => x.no === i.no && !!x.bsa === i.bsa));
    if (item) {
      const x = (d.items || []).find(x => x.no === item.no && !!x.bsa === item.bsa);
      ledgerHits.push({ entry: e, item, exact: sc.exact, name: e.title || '', optionText: x?.text || '' });
    }
  }
  // 10분 안의 미확인 행은 조회 결과와 상관없이 막는다 — 방금 누른 등록이 아직 목록에 안 보일 수 있다.
  const fresh = ledgerHits.filter(h => !naverConfirmed(h.entry) && nowMs - Date.parse(h.entry.registeredAt) < NAVER_UNVERIFIED_HOLD);
  if (fresh.length) throw naverDuplicate(plan, fresh, 'ledger');

  // 2) 실시간
  let scan = null, unavailable = '';
  if (!api) unavailable = apiError || '커머스API 인증정보 없음';
  else {
    try { scan = await withTimeout(naverLiveScan(plan, api), 60000, '네이버 중복 확인'); }
    catch (e) { unavailable = e.message; }
  }
  if (scan?.hits.length) throw naverDuplicate(plan, scan.hits, 'live');
  if (!scan) notices.push(failOpen(unavailable));
  else if (scan.problems.length) notices.push(failOpen(scan.problems.join(', ')));
  const liveState = scan ? scan.state : 'unavailable';

  // 3) 원장 행 판정
  const standing = [];
  for (const h of ledgerHits) {
    const e = h.entry;
    if (naverConfirmed(e)) {
      let st = liveState;
      if (st === 'absent') {
        const cp = String(e.detail?.channelProductNo || e.externalId);
        const row = scan.rows.find(r => String(r?.channelProductNo) === cp);
        if (row && row.statusType !== 'DELETE') st = 'unknown';   // 상품은 살아 있고 옵션만 바뀐 것
      }
      if (ledgerHitStands(e, st, nowMs, NAVER_CONFIRMED_GRACE)) standing.push(h);
      else supersedeQuietly(ledger, e, '네이버에서 없음 확인', log);
      continue;
    }
    const age = nowMs - Date.parse(e.registeredAt);
    const tried = `이 PC에서 ${fmtTime(e.registeredAt)}에 같은 상품 등록을 시도한 기록이 있습니다 — 판매자센터에서 확인하세요`;
    if (liveState === 'absent') supersedeQuietly(ledger, e, '네이버에서 없음 확인', log);
    else if (liveState === 'unavailable') pushOnce(notices, tried);
    else if (age < NAVER_PARTIAL_HOLD) standing.push(h);   // 조회는 됐는데 증거가 부분적 — 하루까지 막는다
    else pushOnce(notices, tried);
  }
  if (standing.length) throw naverDuplicate(plan, standing, 'ledger');
  return { notices };
}

export function recordNaver(ledger, plan, url, { bypass = false } = {}) {
  if (plan.skip) return null;
  // 판매자센터 편집 화면 URL(#/products/copy|edit/{n})의 숫자는 템플릿 번호다 — 절대 쓰지 않는다.
  const m = String(url || '').match(/^https?:\/\/(m\.)?smartstore\.naver\.com\/[^/]+\/products\/(\d+)/);
  const channelProductNo = m ? m[2] : null;
  ledger.record({
    channel: 'naver', keys: plan.lockKeys, externalId: channelProductNo, url: url || null, verified: !!channelProductNo,
    title: plan.title,
    detail: {
      brand: plan.car.brand, model: plan.car.model, brandKey: plan.car.brandKey, modelKey: plan.car.modelKey,
      items: plan.items, channelProductNo, templateId: plan.templateId,
    },
    bypass: !!bypass,
  });
  return null;
}

// ── 아마존: 실시간 조회가 주 판정, fail-closed ───────────────────────────
//   같은 SKU 는 '새 상품'이 아니라 기존 리스팅 덮어쓰기다. 되돌릴 수 없으므로 확인하지 못하면
//   멈춘다. allowDuplicate 도 이 덮어쓰기 방지는 풀지 않는다.

export function planAmazon(data, { config = {} } = {}) {
  const sku = amazonSkuOf(data);
  const mp = amazonMarketplaceOf(data, config);
  const sellerId = String(mp === AMAZON_JP_MARKETPLACE_ID && config.jpRefreshToken ? config.jpSellerId || config.sellerId || '' : config.sellerId || '');
  const base = { channel: 'amazon', notices: [], lockKeys: [], sku, SKU: sku.toUpperCase(), mp, sellerId,
    title: data?.titleEn || data?.title || '', brand: data?.brand || '', model: data?.model || '' };
  if (!sku) return { ...base, skip: true };   // registerProduct 가 'SKU 필수' 로 던진다
  return { ...base, skip: false, lockKeys: [`amazon|${sellerId}|${mp}|${base.SKU}`] };
}

const amazonMarketLabel = mp => (mp === AMAZON_JP_MARKETPLACE_ID ? '일본(amazon.co.jp)' : mp === 'ATVPDKIKX0DER' ? '미국(amazon.com)' : mp);

function amazonDuplicate(plan, source, row, basis, tail) {
  const url = amazonListingUrl(plan.mp, row?.asin);
  const message = `중복 등록 차단: 아마존 ${amazonMarketLabel(plan.mp)}에 SKU ${plan.sku} 리스팅이 이미 있습니다 — `
    + `ASIN ${row?.asin || '미확인'}${row?.name ? ` "${row.name}"` : ''}${url ? ` ${url}` : ''} [근거: ${basis}]. ${tail}`;
  return new DuplicateRegistrationError(message, {
    channel: 'amazon', source,
    existing: {
      channel: 'amazon', source, key: { sellerId: plan.sellerId, marketplaceId: plan.mp, sku: plan.sku },
      products: [{ id: row?.asin || null, name: row?.name || '', optionText: '', url: url || null, status: row?.status || null, registeredAt: null, sku: row?.id || plan.sku }],
    },
  });
}

const OVERWRITE_TAIL = '같은 SKU로 등록하면 기존 리스팅을 덮어쓰므로 등록하지 않았습니다(allowDuplicate 로도 풀리지 않음). 값을 바꾸려면 상품수정 모드를 쓰세요.';

export async function checkAmazon(plan, { bypass } = {}, { ledger = null, searchBySkus = null, toRow = null, cache = null, now = () => new Date() } = {}) {
  const notices = [];
  // identifiers 는 쉼표로 이어 보내므로 SKU 안의 쉼표는 SKU 두 개로 쪼개진다.
  if (plan.sku.includes(',')) {
    throw new DuplicateCheckUnavailableError('SKU에 쉼표가 있어 아마존 중복 확인을 할 수 없습니다 — 쉼표를 뺀 SKU로 등록하세요.', { channel: 'amazon' });
  }
  const ids = [...new Set([plan.sku, plan.sku.toUpperCase(), plan.sku.toLowerCase()])];
  const readCache = () => {
    try {
      const c = cache ? cache(plan.mp) : null;
      const row = (c?.items || []).find(r => String(r?.id ?? r?.sku ?? '').trim().toUpperCase() === plan.SKU);
      return row ? { row, updatedAt: c.updatedAt || '?' } : null;
    } catch (e) { pushOnce(notices, `아마존 목록 캐시를 읽지 못함(${e.message})`); return null; }
  };

  let res, liveErr = null;
  try {
    if (!searchBySkus) throw new Error('조회 수단 없음');
    res = await withTimeout(searchBySkus(ids, plan.mp), 45000, '아마존 SKU 조회');
    if (!Array.isArray(res?.items)) throw new Error(res?.rawResponse !== undefined ? '응답이 JSON 이 아님' : '응답 형식이 예상과 다름');
  } catch (e) { liveErr = e; }

  if (liveErr) {
    if (!bypass) {
      const c = readCache();
      if (c) throw amazonDuplicate(plan, 'cache', c.row, `아마존 목록 캐시(${c.updatedAt} 동기화) — 실시간 조회 실패: ${liveErr.message}`, OVERWRITE_TAIL);
    }
    throw new DuplicateCheckUnavailableError(`아마존에 같은 SKU 리스팅이 있는지 확인하지 못해 등록을 멈췄습니다(원인: ${liveErr.message}). 잠시 후 다시 시도하세요.`, { channel: 'amazon', cause: liveErr });
  }

  const hit = res.items.find(l => String(l?.sku ?? '').trim().toUpperCase() === plan.SKU);
  if (hit) {
    let row;
    try { row = toRow ? toRow(hit, plan.mp) : null; } catch { row = null; }
    row = row || { id: hit.sku, name: '', asin: hit.summaries?.[0]?.asin || null };
    throw amazonDuplicate(plan, 'live', row, '아마존 실시간 조회', OVERWRITE_TAIL);
  }
  if (bypass) return { notices };

  const c = readCache();
  if (c) {
    throw amazonDuplicate(plan, 'cache', c.row,
      `아마존 목록 캐시(${c.updatedAt} 동기화)에는 있으나 실시간 조회에서 찾지 못했습니다`,
      '삭제했다면 [전체 목록 동기화] 후 다시 등록하세요.');
  }
  // 원장 적중은 막지 않는다 — 덮어쓸 리스팅이 없고, 막으면 수정 경로(404)와 겹쳐 빠져나갈 길이 없다.
  const prior = readActive(ledger, 'amazon', notices).filter(e => e.detail?.sellerId === plan.sellerId
    && e.detail?.marketplaceId === plan.mp && String(e.detail?.sku || '').toUpperCase() === plan.SKU);
  if (prior.length) {
    const last = prior[prior.length - 1];
    notices.push(`${fmtTime(last.registeredAt)}에 제출한 SKU를 다시 제출합니다(앞 제출은 아직 리스팅으로 확인되지 않음)`);
  }
  return { notices };
}

export function recordAmazon(ledger, plan, result, { bypass = false } = {}) {
  if (plan.skip || result?.status !== 'ACCEPTED') return null;
  ledger.record({
    channel: 'amazon', keys: plan.lockKeys, externalId: result.raw?.submissionId || null, url: null, verified: false,
    title: plan.title,
    detail: { sellerId: plan.sellerId, marketplaceId: plan.mp, sku: plan.sku, status: result.status, brand: plan.brand, model: plan.model },
    bypass: !!bypass,
  });
  return null;
}

// ── 아임웹: fail-closed, 스냅샷 없음 ─────────────────────────────────────
//   조회가 등록과 같은 토큰·세션을 쓰고(조회가 안 되면 등록도 안 될 공산이 크다), 대신 볼
//   스냅샷이 없으며, B2B 상품은 등록 즉시 공개된다 — 확인하지 못하면 멈춘다.

const IMWEB_B2B_TITLE = /^옵틱글래스\s+(.+?)\s+미러\s+(1셋|운전석\/조수석)\s*(?:\[(?:No\.?\s*)?([A-Za-z]?\d+(?:-\d+)?)\])?\s*$/i;
const IMWEB_EDITION_BY_PRICE = { 220000: 'bsa', 115000: 'bsa', 150000: 'normal', 80000: 'normal' };
const IMWEB_LEDGER_GRACE = 30 * MIN;
export const imwebAdminProductUrl = no => `https://bbstore37.imweb.me/admin/shopping/product/detail?idx=${no}`;

export function planImweb(data, { brands = DEFAULT_BRANDS } = {}) {
  const notices = [];
  const base = { channel: 'imweb', brands, notices, lockKeys: [], targets: [] };
  // isEditMode 로 건너뛰지 않는다 — imweb-register 는 이제 언제나 새로 만든다(수정은 B2B API).
  const targets = [];
  const ci = codeInfo(data?.code);

  if (data?.targetB2b) {
    const titleBrand = data.titleBrand || data.brand, titleModel = data.titleModel || data.model;
    const car = carFrom(titleBrand, titleModel);
    const bsa = !data.bsaX && !!data.bsaO;
    const types = [data.registerIndiv && 'indiv', data.registerSet && 'set'].filter(Boolean);
    if (!ci.code) notices.push(`B2B 상품 코드 "${data.code ?? ''}" 를 ${ci.ambiguous ? '어디까지로 볼지 애매해' : '읽을 수 없어'} B2B 중복 확인을 건너뜀`);
    else if (!car.brandKey || !car.modelKey) notices.push('B2B 차종을 알 수 없어 B2B 중복 확인을 건너뜀');
    else {
      for (const type of types) {
        targets.push({
          kind: 'b2b', type, code: ci.code, bsa, car,
          title: `옵틱글래스 ${titleBrand} ${titleModel} 미러 ${type === 'set' ? '1셋' : '운전석/조수석'} [${data.code}]`,
          lockKey: `imweb-b2b|${car.brandKey}|${ci.code}|${bsaKey(bsa)}|${type}`,
        });
      }
    }
  }
  if (!targets.length) return { ...base, skip: true };
  return { ...base, skip: false, targets, lockKeys: targets.map(t => t.lockKey) };
}

async function imwebList(fn, label) {
  let res;
  try {
    if (!fn) throw new Error('조회 수단 없음');
    res = await withTimeout(fn(), 90000, `아임웹 ${label} 조회`);
  } catch (e) {
    throw new DuplicateCheckUnavailableError(`아임웹 ${label} 중복 확인을 하지 못해 등록을 멈췄습니다: ${e.message} — 잠시 후 다시 시도하세요.`, { channel: 'imweb', cause: e });
  }
  if (!res || !Array.isArray(res.rows)) {
    throw new DuplicateCheckUnavailableError(`아임웹 ${label} 중복 확인을 하지 못해 등록을 멈췄습니다: 응답 형식이 예상과 다름 — 잠시 후 다시 시도하세요.`, { channel: 'imweb' });
  }
  if (!res.complete) {
    throw new DuplicateCheckUnavailableError(`아임웹 ${label} 중복 확인을 하지 못해 등록을 멈췄습니다: 목록을 끝까지 받지 못함 — 잠시 후 다시 시도하세요.`, { channel: 'imweb' });
  }
  return res.rows;
}

async function imwebB2bMatches(t, rows, optionValuesOf, notices, brands) {
  const out = [];
  const token = codeToken(t.code);
  for (const r of rows) {
    const name = String(r?.name || '');
    const m = name.match(IMWEB_B2B_TITLE);
    let exact = true, formatDiff = false;
    if (m) {
      if ((m[2] === '1셋' ? 'set' : 'indiv') !== t.type) continue;
      if (!m[3] || normCode(m[3]) !== t.code) continue;   // 부분일치(includes)는 쓰지 않는다 — [H1520] ≠ H152
      const sc = sameCar(t.car, splitCarTitle(m[1], brands));
      if (!sc.match) continue;
      exact = sc.exact;
    } else {
      // 옛 제목·손으로 고친 제목. 경계가 맞는 [CODE] 토큰 + 차종 + 종류가 맞을 때만 후보.
      if (!token.test(name)) continue;
      if (!t.car.modelKey || !squash(name).includes(t.car.modelKey)) continue;
      if (!(r.type === t.type || r.type === 'etc')) continue;
      formatDiff = true;
    }
    // 판(BSA/일반)은 가격으로 먼저 가르고, 모르는 가격이면 '연식' 옵션값으로.
    let edition = IMWEB_EDITION_BY_PRICE[Math.round(Number(r.price))] || null;
    if (!edition) {
      try { edition = bsaEditionOfImwebValues(await optionValuesOf(r.prodNo)); }
      catch { edition = 'unknown'; }
    }
    const want = t.bsa ? 'bsa' : 'normal';
    if (edition !== 'unknown' && edition !== want) {
      pushOnce(notices, `같은 제목의 ${edition === 'bsa' ? 'BSA' : '일반'}판 상품 ${r.prodNo} 이 이미 있음`);
      continue;
    }
    out.push({
      source: 'live', target: t, id: String(r.prodNo), name, status: String(r.status || ''), url: imwebAdminProductUrl(r.prodNo),
      exact, formatDiff, editionNote: edition === 'unknown' ? `판 확인 불가(가격 ${r.price}원)` : '',
    });
  }
  return out;
}

function imwebDuplicate(plan, blocks) {
  const lines = blocks.map(b => {
    const t = b.target;
    const basis = b.source === 'ledger' ? `원장(이 PC, ${fmtTime(b.entry.registeredAt)} 등록)` : '아임웹 실시간 조회';
    const notes = [`상태 ${b.status || '알 수 없음'}`];
    if (b.formatDiff) notes.push('제목 형식 다름');
    if (b.exact === false) notes.push('차종 표기 다름');
    if (b.editionNote) notes.push(b.editionNote);
    const notOnSale = b.status && !/^sale$/i.test(b.status);
    return `B2B ${t.type === 'set' ? '세트' : '개별'} [${t.code}]${t.bsa ? ' BSA' : ''} → 기존 상품 ${b.id || '(번호 없음)'}`
      + (b.name ? ` "${b.name}"` : '') + ` (${notes.join(', ')})` + (b.url ? ` ${b.url}` : '') + ` [근거: ${basis}]`
      + (notOnSale ? ' — 숨김·판매중지 상품이면 관리자에서 삭제하거나 판매중으로 바꾸세요' : '');
  });
  const message = `중복 등록 차단: 아임웹에 같은 상품이 이미 있습니다. ${lines.join(' / ')}. `
    + '아무것도 새로 만들지 않았습니다 — 해당 체크(개별/세트)를 끄고 다시 실행하세요.';
  const source = blocks[0].source;
  return new DuplicateRegistrationError(message, {
    channel: 'imweb', source,
    existing: {
      channel: 'imweb', source,
      key: { targets: blocks.map(b => b.target.lockKey) },
      products: blocks.map(b => ({ id: b.id || null, name: b.name || '', optionText: '', url: b.url || null, status: b.status || null, registeredAt: b.entry?.registeredAt || null, target: b.target.lockKey })),
    },
  });
}

export async function checkImweb(plan, { bypass } = {}, { ledger = null, b2bRows = null, b2bOptionValues = null, now = () => new Date(), log = console } = {}) {
  if (bypass) return { notices: [] };
  const notices = [];
  const blocks = [];
  const active = readActive(ledger, 'imweb-b2b', notices);
  const rowsByCode = new Map();
  const optionValuesOf = no => (b2bOptionValues ? b2bOptionValues(no) : Promise.reject(new Error('조회 수단 없음')));

  for (const t of plan.targets) {
    if (!rowsByCode.has(t.code)) rowsByCode.set(t.code, await imwebList(b2bRows && (() => b2bRows(t.code)), 'B2B'));
    const rows = rowsByCode.get(t.code);
    const found = await imwebB2bMatches(t, rows, optionValuesOf, notices, plan.brands);
    blocks.push(...found);
    for (const e of active) {
      if (e.channel !== 'imweb-b2b' || !(e.keys || []).includes(t.lockKey) || !sameCar(t.car, e.detail).match) continue;
      if (found.some(b => b.id === String(e.externalId))) continue;   // 실시간이 이미 막았다
      const st = rows.some(r => String(r.prodNo) === String(e.externalId)) ? 'unknown' : 'absent';
      if (ledgerHitStands(e, st, now, IMWEB_LEDGER_GRACE)) {
        blocks.push({ source: 'ledger', target: t, entry: e, id: String(e.externalId || ''), name: e.title || '', status: '', url: e.url || '' });
      } else supersedeQuietly(ledger, e, '아임웹 목록에 없음 확인', log);
    }
  }
  // 대상 중 하나라도 중복이면 전체를 막는다 — 일부만 올리면 개별/세트 짝이 어긋난다.
  if (blocks.length) throw imwebDuplicate(plan, blocks);
  return { notices };
}

/** registered = imweb.lastRegistered: [{kind:'b2b', type, ok, no, title}] */
export function recordImweb(ledger, plan, registered, { bypass = false } = {}) {
  if (plan.skip) return null;
  for (const r of registered || []) {
    if (r?.kind === 'b2b') {
      if (!(r.ok && r.no)) continue;
      const t = plan.targets.find(x => x.kind === 'b2b' && x.type === r.type);
      if (!t) continue;
      ledger.record({
        channel: 'imweb-b2b', keys: [t.lockKey], externalId: String(r.no), url: imwebAdminProductUrl(r.no), verified: true,
        title: r.title || t.title,
        detail: { brand: t.car.brand, model: t.car.model, brandKey: t.car.brandKey, modelKey: t.car.modelKey, code: t.code, bsa: t.bsa, type: t.type },
        bypass: !!bypass,
      });
    }
  }
  return null;
}

// ── 아임웹 자사몰(본사몰): fail-closed, 원장 30분 ─────────────────────────────
//   등록 한 번이 상품 하나(KR·US·JP 세 구역)다. 한국 구역 이름에 같은 [No.코드] · 차종이 든 상품이 있으면 막는다
//   — rows 는 imweb_head_create.js findExisting(한국 구역 전체를 읽는다). 판(BSA)은 가르지 않는다(이름에 판이 없다).
export function planImwebHead(data) {
  const ci = codeInfo(data?.code);
  const car = carFrom(data?.titleBrand || data?.brand, data?.titleModel || data?.model);
  const base = { channel: 'imweb-head', notices: [], lockKeys: [], code: ci.code, car };
  if (!ci.code || !car.brandKey || !car.modelKey) {
    return { ...base, skip: true, skipReason: `자사몰 상품번호 "${data?.code ?? ''}" 나 차종을 읽을 수 없어 자사몰 중복 확인을 건너뜀` };
  }
  return { ...base, skip: false, lockKeys: [`imweb-head|${car.brandKey}|${ci.code}`] };
}

export async function checkImwebHead(plan, { bypass } = {}, { ledger = null, rows = null, now = () => new Date(), log = console } = {}) {
  if (bypass) return { notices: [] };
  const notices = [];
  const blocks = (await imwebList(rows, '자사몰')).map(r => ({ source: 'live', id: String(r.prodNo), name: String(r.name || ''), status: String(r.status || '') }));
  // 원장: 목록에 안 보여도(이름을 고쳤거나 목록이 늦음) 등록 뒤 30분은 막는다.
  for (const e of readActive(ledger, 'imweb-head', notices)) {
    if (!(e.keys || []).includes(plan.lockKeys[0]) || !sameCar(plan.car, e.detail).match) continue;
    if (blocks.some(b => b.id === String(e.externalId))) continue;   // 실시간이 이미 막았다
    if (ledgerHitStands(e, 'absent', now, IMWEB_LEDGER_GRACE)) blocks.push({ source: 'ledger', entry: e, id: String(e.externalId || ''), name: e.title || '', status: '' });
    else supersedeQuietly(ledger, e, '아임웹 자사몰 목록에 없음 확인', log);
  }
  if (!blocks.length) return { notices };
  const lines = blocks.map(b => `상품 ${b.id}${b.name ? ` "${b.name}"` : ''}${b.status ? ` (상태 ${b.status})` : ''}`
    + ` [근거: ${b.source === 'ledger' ? `원장(이 PC, ${fmtTime(b.entry.registeredAt)} 등록)` : '아임웹 실시간 조회'}]`);
  throw new DuplicateRegistrationError(`중복 등록 차단: 아임웹 자사몰에 [No.${plan.code}] ${plan.car.model} 상품이 이미 있습니다 — ${lines.join(' / ')}. `
    + '아무것도 새로 만들지 않았습니다 — 그 상품은 단일 상품 수정으로 고치세요(숨김 상품이면 확인 뒤 아임웹 관리자에서 판매중으로).', {
    channel: 'imweb-head', source: blocks[0].source,
    existing: {
      channel: 'imweb-head', source: blocks[0].source, key: { lockKey: plan.lockKeys[0] },
      products: blocks.map(b => ({ id: b.id || null, name: b.name, optionText: '', url: null, status: b.status || null, registeredAt: b.entry?.registeredAt || null })),
    },
  });
}

/** result = imweb_head_create register 의 { ok, no, title }. 확인이 어긋나 숨김으로 남은 상품(ok:false)도 적는다 — 만들어진 상품이다. */
export function recordImwebHead(ledger, plan, result, { bypass = false } = {}) {
  if (plan.skip || !result?.no) return null;
  ledger.record({
    channel: 'imweb-head', keys: plan.lockKeys, externalId: String(result.no), url: null, verified: !!result.ok, title: result.title || '',
    detail: { brand: plan.car.brand, model: plan.car.model, brandKey: plan.car.brandKey, modelKey: plan.car.modelKey, code: plan.code },
    bypass: !!bypass,
  });
  return null;
}
