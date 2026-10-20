// 아임웹 미국·일본 판매가 — 본사몰 한 사이트 안의 구역(unit)별 가격을 같은 상품의 한국 구역 가격(국내가) 기준으로 바꾼다.
//
// 아임웹 Open API(OAuth)로 읽고 쓴다(2026-10-05). 예전의 크롤링(자동화 브라우저로 관리자 토큰을 잡아 백오피스 API 를
// 쓰던 방식)은 지웠다. 구역 · 통화는 사이트 정보(GET /site-info)가 알려준다 — KRW · USD · JPY 구역이 한 사이트에 있다.
//
// 규칙은 아마존·eBay 와 같다(fx_pricing.js): 환율 우대 없이 환산 → 앞 두 자리만 남김 → 두 자리 가격이면 환율이 1% 넘게
// 움직였을 때만 바꿈. 옵션 조합 가격은 추가금이 아니라 그 조합의 최종가다(Open API 옵션 상세 price — 2026-10-05 상품 3:
// 기본 80,000 · BSA 있음 운전석 115,000 · 1set 150,000). 그래서 한국 조합가를 그대로 환산한다. 추가금 방식으로 보이는
// 상품은 건너뛴다(createOpenApiGateway 의 판단 참고). 저장은 미리보기로 확인한 뒤에만 한다.
import fs from 'node:fs';
import path from 'node:path';
import { rateProblem, planPrice, rateInfo } from './utils/fx_pricing.js';

const TARGETS = ['USD', 'JPY'];
const PLAN_TTL = 30 * 60 * 1000;   // 미리보기 후 30분 안에만 저장한다
const SETTLE_EVERY = 100;           // 저장 100개마다 목록(한 번에 최대 100개)을 다시 읽어 기본가를 확인한다
// 새 판매가 하한. 한국가에 자리표시 값(100원 등)이 있으면 $0.07 · 10엔 같은 값이 나온다 — 그런 상품은 저장하지 않는다.
const MIN_TARGET = { USD: 1, JPY: 100 };
const clone = value => JSON.parse(JSON.stringify(value ?? null));
const money = (value, currency) => {
  const n = Number(value);
  if (currency === 'KRW') return n.toLocaleString('ko-KR') + '원';
  if (currency === 'JPY') return n.toLocaleString('ko-KR') + '엔';
  return '$' + n.toLocaleString('en-US', Number.isInteger(n) ? {} : { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

// ── 응답 정리 · 계산 (순수 함수) ─────────────────────────────

/** 상품 상세 응답(data)을 계산에 필요한 모양으로. 원본은 저장·되돌리기에 그대로 쓴다. */
export function normalizeProduct(prodNo, d) {
  const byUnit = d?.baseInfo?.prodBaseInfoByUnit || [];
  return {
    prodNo: String(prodNo), name: String(byUnit[0]?.productName || ''),
    names: Object.fromEntries(byUnit.filter(u => u?.unitCode).map(u => [u.unitCode, String(u.productName || '')])),
    priceInfo: (d?.priceInfo || []).filter(e => e?.unitCode).map(e => ({ ...e, price: Number(e.price) })),
    combos: (d?.productOptionInfo?.optionDetails || []).map(c => ({
      code: c.optionDetailCode || '', text: String(c.dataPerUnit?.[0]?.displayText || ''),
      prices: Object.fromEntries((c.dataPerUnit || []).filter(u => u?.unitCode).map(u => [u.unitCode, Number(u.price) || 0])),
      relative: Object.fromEntries((c.dataPerUnit || []).filter(u => u?.unitCode).map(u => [u.unitCode, u.isRelativePrice])),
    })),
    raw: { priceInfo: clone(d?.priceInfo || []), productOptionInfo: clone(d?.productOptionInfo || null) },
  };
}

const keep = action => action === 'same' || action === 'small';

/**
 * 한 상품의 새 가격. base[구역] = 기본가, combos[i].next[구역] = 옵션 조합의 최종가.
 * 같거나 환율 변동 1% 미만인 값은 지금 값을 그대로 둔다(아마존·eBay 와 같은 판단).
 */
export function planProduct(product, unitMap, snapshot) {
  const kr = product.priceInfo.find(e => unitMap[e.unitCode] === 'KRW');
  if (!kr || !(kr.price > 0)) return { skip: '한국 판매가 없음' };
  const units = product.priceInfo.filter(e => TARGETS.includes(unitMap[e.unitCode]) && e.price > 0);
  if (!units.length) return { skip: '미국·일본 판매가 없음' };
  if (product.combos.some(c => Object.values(c.relative).some(flag => flag !== false)))
    return { skip: '옵션 가격이 추가금 방식으로 보이거나 방식을 확인할 수 없음 — 건너뜀 (관리자에서 확인)' };
  let large = false, low = false;
  const plan = (current, krw, currency) => {
    const p = planPrice({ current, currency, krw, snapshot, maxChange: Infinity });
    const next = keep(p.action) ? current : Number(p.target);
    // 한국 가격을 그대로 복사해 둔 값(새로 등록한 상품의 80,000달러·80,000엔 — 2026-10-19 상품 2152)은 처음 환산하는 것이라
    // 10% 판단에서 뺀다. 매일 자동 실행이 이것까지 건너뛰면 새 상품은 계속 원화 숫자로 팔린다.
    if (next !== current && current !== krw && Math.abs(next / current - 1) > 0.1) large = true;
    if (next !== current && next < MIN_TARGET[currency]) low = true;
    return { next, raw: p.raw, change: p.change, action: p.action };
  };
  const base = {};
  for (const e of units) {
    const currency = unitMap[e.unitCode];
    base[e.unitCode] = { currency, current: e.price, ...plan(e.price, kr.price, currency) };
  }
  const combos = product.combos.map(c => {
    const krPrice = c.prices[kr.unitCode] ?? 0, next = {};
    for (const [unit, b] of Object.entries(base)) {
      if (!(unit in c.prices)) continue;
      const current = c.prices[unit];
      next[unit] = current > 0 && krPrice > 0 ? plan(current, krPrice, b.currency).next : current;
    }
    return { ...c, next };
  });
  if (low) return { skip: '환산가가 하한(미국 $' + MIN_TARGET.USD + ' · 일본 ' + MIN_TARGET.JPY + '엔) 아래 — 건너뜀 (한국 판매가 확인)' };
  const changedBase = Object.values(base).filter(b => b.next !== b.current).length;
  const changedCombos = combos.filter(c => Object.entries(c.next).some(([u, v]) => v !== c.prices[u])).length;
  return { base, combos, krPrice: kr.price, krUnit: kr.unitCode, changedBase, changedCombos, large, changed: changedBase + changedCombos > 0 };
}

/** 저장 본문. 기본가는 응답의 priceInfo 를 통째로 두고 바꿀 구역 값만 고친다. 옵션은 쓰기 형식(prices[{unitCode, price}])으로 모든 구역을 보낸다. */
export function buildPatch(product, plan) {
  const payload = {};
  if (plan.changedBase) {
    payload.priceInfo = clone(product.raw.priceInfo).map(e => plan.base[e.unitCode] ? { ...e, price: plan.base[e.unitCode].next } : e);
  }
  if (plan.changedCombos) payload.productOptionInfo = optionWrite(product.raw.productOptionInfo, (detail, unit, price) => {
    const combo = plan.combos.find(c => c.code === (detail.optionDetailCode || '') && c.text === String(detail.dataPerUnit?.[0]?.displayText || ''));
    return combo && unit in combo.next ? combo.next[unit] : price;
  });
  return payload;
}

// 옵션 조합을 쓰기 형식으로(imweb_edit.js updateProduct 와 같은 모양). 조합 목록·순서는 그대로 둔다.
function optionWrite(poiRaw, priceOf) {
  const poi = clone(poiRaw);
  poi.optionDetails = (poiRaw?.optionDetails || []).map((d, i) => {
    const detail = {
      no: i + 1,
      optionValuePairs: (d.optionValuePairs || []).map(p => ({ optionCode: p.optionCode, valueCode: p.valueCode })),
      prices: (d.dataPerUnit || []).map(u => ({ unitCode: u.unitCode, price: priceOf(d, u.unitCode, Number(u.price) || 0) })),
      status: d.status || 'SALE', stock: d.stock ?? 0, stockSku: d.stockSku || '',
    };
    if (d.optionDetailCode) detail.optionDetailCode = d.optionDetailCode;
    return detail;
  });
  return poi;
}

/** 되돌리기 본문 — 넘겨받은 원본(저장 직전에 읽은 값) 그대로. */
export function restorePatch(product, payload) {
  const back = {};
  if (payload.priceInfo) back.priceInfo = clone(product.raw.priceInfo);
  if (payload.productOptionInfo) back.productOptionInfo = optionWrite(product.raw.productOptionInfo, (_, __, price) => price);
  return back;
}

/** 기본가 확인: 한국 구역은 그대로, 미국·일본은 계획대로여야 한다. priceInfo = [{ unitCode, price }] */
export function baseProblems(priceInfo, plan) {
  const problems = [], now = new Map(priceInfo.map(e => [e.unitCode, e.price]));
  if (now.get(plan.krUnit) !== plan.krPrice) problems.push('한국 판매가가 바뀌었습니다 (' + plan.krPrice + ' → ' + now.get(plan.krUnit) + ')');
  for (const [unit, b] of Object.entries(plan.base)) {
    if (now.get(unit) !== b.next) problems.push(b.currency + ' 판매가 ' + now.get(unit) + ' (요청 ' + b.next + ')');
  }
  return problems;
}

/** 저장 뒤 다시 읽은 값 확인. 한국 구역은 그대로, 미국·일본은 계획대로여야 한다. */
export function checkAfter(after, product, plan) {
  const problems = baseProblems(after.priceInfo, plan);
  for (const c of plan.combos) {
    const got = after.combos.find(x => x.code === c.code && x.text === c.text);
    if (!got) { problems.push('옵션 "' + c.text + '"이 없어졌습니다'); continue; }
    if ((got.prices[plan.krUnit] ?? 0) !== (c.prices[plan.krUnit] ?? 0)) problems.push('옵션 "' + c.text + '" 한국 가격이 바뀌었습니다');
    for (const [unit, value] of Object.entries(c.next)) if ((got.prices[unit] ?? 0) !== value) problems.push('옵션 "' + c.text + '" 가격 ' + got.prices[unit] + ' (요청 ' + value + ')');
    // 쓰기 형식에는 방식 표시가 없다. 저장하면서 최종가가 추가금 방식으로 바뀌면 판매가가 두 배가 된다.
    if (Object.entries(c.relative).some(([unit, flag]) => got.relative[unit] !== flag)) problems.push('옵션 "' + c.text + '" 가격 방식(최종가/추가금)이 바뀌었습니다');
  }
  return problems;
}

// ── 본사몰 Open API 연결 ─────────────────────────────────────────────────

/**
 * 본사몰 상품을 아임웹 Open API(OAuth)로 읽고 쓴다 — 브라우저도 관리자 로그인도 필요 없다.
 * product() 는 계산 · 확인 · 되돌리기(planProduct · checkAfter · restorePatch)가 쓰는 모양으로 바꿔서 돌려주고,
 * save() 는 그 모양의 저장 본문(buildPatch · restorePatch)을 구역별 PATCH 로 풀어서 보낸다.
 *
 *  - 가격이 구역(unitCode)별 호출이다. 기본가는 목록으로 읽는다 — 한 번에 100개가 최대다(2026-10-20 확인: 목록 ·
 *    옵션 상세 모두 limit 200 이상은 400 "limit must not be greater than 100"). 옵션 가격은 상품 × 구역마다 읽어야 한다
 *    (여러 상품을 한 번에 읽는 GET /products/options 는 최대 10개에 가격이 없다). 호출 제한 초당 2.
 *    목록의 기본가는 다음 list() 까지 쓰고, 저장하면 보낸 값으로 고쳐 둔다 — 저장한 값은 다음 목록에서 확인한다(base()).
 *  - 구역의 통화는 사이트 정보가 알려준다(units()). 금액으로 추측하지 않는다.
 *  - 옵션 가격 방식(최종가/추가금) 표시가 응답에 없다. 추가금이면 기본 조합이 0원이고, 최종가는 모두 0원보다 크다 —
 *    기본가보다 싼 조합도 있다(2026-10-05 상품 3: 기본 80,000 · BSA 있음 운전석 115,000 · 1set 150,000,
 *    2026-10-19 상품 2152: 기본 80,000 · 운전석 80,000 · 조수석 70,000 · 1set 150,000 — 둘 다 최종가).
 *    그래서 한국 옵션가가 모두 0원보다 클 때만 최종가(isRelativePrice false)로, 아니면 추가금으로 보고(true)
 *    planProduct 가 건너뛰게 한다. (예전엔 '모두 기본가 이상'으로 봐서 조수석이 기본가보다 싼 상품을 모두 건너뛰었다.)
 *  - 저장은 바뀐 값만 구역별로 보낸다(기본가 PATCH /price, 옵션 PATCH /option-details/{code}). 재고 · 판매상태는 보내지
 *    않는다 — 옵션 전체를 다시 쓰지 않으니 그 사이 주문으로 바뀐 재고 · 품절을 되살릴 일이 없다.
 *    한국 구역은 보내지 않는다(국내가는 기준값이다 — 보내려 하면 멈춘다). 중간에 거부되면 앞서 보낸 것을 되돌린다.
 */
export function createOpenApiGateway(client, { log = () => {} } = {}) {
  let units = null;                  // [{ unitCode, currency }] 한국이 맨 앞
  const listed = new Map();          // prodNo → { [unitCode]: { price, name } } — 마지막 목록의 기본가(저장하면 보낸 값으로)
  const lastRead = new Map();        // prodNo → 마지막으로 읽은 값. 저장 때 바뀐 것만 보내려고 둔다

  async function siteUnits() {
    if (units) return units;
    const info = await client.siteInfo();
    const found = (info?.unitList || [])
      .filter(u => u?.unitCode && /^(KRW|USD|JPY)$/i.test(String(u.currency || '')))
      .map(u => ({ unitCode: u.unitCode, currency: String(u.currency).toUpperCase() }));
    if (found.filter(u => u.currency === 'KRW').length !== 1) {
      throw new Error('본사몰 사이트 정보에서 한국(KRW) 구역을 하나로 찾지 못했습니다 — 기준(국내가)을 잡을 수 없어 멈춥니다.');
    }
    units = [...found].sort((a, b) => (b.currency === 'KRW') - (a.currency === 'KRW'));
    return units;
  }
  // 그 구역에서 팔지 않는 상품. 그 구역만 빼고 나머지는 계속한다.
  const missingInUnit = e => e?.status === 404 || e?.errorCode === '30006' || e?.errorCode === '10002';
  const optionText = d => (d?.optionDetailInfoList || []).map(i => String(i?.optionValue?.optionValueName ?? '')).join(' / ');

  async function readBase(prodNo) {
    if (listed.has(prodNo)) return listed.get(prodNo);
    const base = {};   // 목록에 없는 상품(목록 뒤에 등록 등)만 구역마다 하나씩 읽는다
    for (const u of await siteUnits()) {
      try {
        const p = await client.product(prodNo, u.unitCode);
        if (p) base[u.unitCode] = { price: Number(p.price), name: String(p.name || '') };
      } catch (e) { if (!missingInUnit(e)) throw e; }
    }
    return base;
  }

  async function product(prodNo) {
    const no = String(prodNo);
    const all = await siteUnits();
    const kr = all[0];
    const base = await readBase(no);
    const present = all.filter(u => base[u.unitCode]);
    const options = {};
    for (const u of present) {
      try { options[u.unitCode] = await client.optionDetails(no, u.unitCode); }
      catch (e) { if (!missingInUnit(e)) throw e; options[u.unitCode] = []; }
      if (u === kr && !options[u.unitCode].length) break;   // 한국에 옵션이 없으면 다른 구역도 읽지 않는다
    }
    const krList = options[kr.unitCode] || [];
    const finalPrices = base[kr.unitCode]?.price > 0 && krList.every(d => Number(d.price) > 0);
    const byUnit = Object.fromEntries(present.map(u => [u.unitCode, new Map((options[u.unitCode] || []).map(d => [d.optionDetailCode, d]))]));
    const data = {
      baseInfo: { prodBaseInfoByUnit: present.map(u => ({ unitCode: u.unitCode, productName: base[u.unitCode].name })) },
      priceInfo: present.map(u => ({ unitCode: u.unitCode, currency: u.currency, price: base[u.unitCode].price })),
      productOptionInfo: {
        optionDetails: krList.map(d => ({
          optionDetailCode: d.optionDetailCode, status: d.status, stock: d.stock,
          dataPerUnit: present.filter(u => byUnit[u.unitCode].has(d.optionDetailCode)).map(u => {
            const x = byUnit[u.unitCode].get(d.optionDetailCode);
            return { unitCode: u.unitCode, displayText: optionText(x), price: Number(x.price) || 0, isRelativePrice: !finalPrices };
          })
        }))
      }
    };
    lastRead.set(no, data);
    return data;
  }

  /** buildPatch · restorePatch 의 본문(옵션 전체를 담은 쓰기 형식)을 구역별 PATCH 로 바꿔 보낸다. 마지막으로 읽은 값과 다른 것만. */
  async function save(prodNo, payload) {
    const no = String(prodNo);
    const before = lastRead.get(no) || await product(no);
    const krUnit = (await siteUnits())[0].unitCode;
    const curBase = new Map((before.priceInfo || []).map(e => [e.unitCode, Number(e.price)]));
    const curOption = new Map();
    for (const d of before.productOptionInfo?.optionDetails || []) {
      for (const u of d.dataPerUnit || []) curOption.set(d.optionDetailCode + '|' + u.unitCode, Number(u.price));
    }
    const steps = [];
    for (const e of payload?.priceInfo || []) {
      const prev = curBase.get(e.unitCode), next = Number(e.price);
      if (prev !== undefined && next !== prev) steps.push({ unitCode: e.unitCode, next, prev });
    }
    for (const d of payload?.productOptionInfo?.optionDetails || []) {
      for (const p of d.prices || []) {
        const prev = curOption.get((d.optionDetailCode || '') + '|' + p.unitCode), next = Number(p.price);
        if (prev === undefined || next === prev) continue;
        if (!d.optionDetailCode) throw new Error('옵션 상세 코드가 없는 옵션은 Open API 로 고칠 수 없습니다 — 보내지 않았습니다.');
        steps.push({ code: d.optionDetailCode, unitCode: p.unitCode, next, prev });
      }
    }
    if (steps.some(s => s.unitCode === krUnit)) {
      throw new Error('한국 구역 가격을 바꾸는 요청이라 보내지 않았습니다 — 국내가는 기준값이라 이 기능으로 바꾸지 않습니다.');
    }
    const send = (s, price) => s.code ? client.setOptionPrice(no, s.code, s.unitCode, price) : client.setPrice(no, s.unitCode, price);
    const done = [];
    try {
      for (const s of steps) { await send(s, s.next); done.push(s); }
    } catch (error) {
      // 한 상품의 가격이 구역마다 반쯤 바뀐 채로 남지 않게, 앞서 보낸 것을 거꾸로 되돌린다.
      let undone = 0;
      for (const s of [...done].reverse()) {
        try { await send(s, s.prev); undone++; } catch (e) { log(`[imweb-unit] ${no} 되돌리기 실패: ${e.message}`); }
      }
      if (done.length) error.message += ` (앞서 보낸 ${done.length}건 중 ${undone}건 되돌림)`;
      throw error;
    }
    lastRead.delete(no);   // 다음 product() 는 옵션을 새로 읽는다
    for (const s of steps) if (!s.code && listed.get(no)?.[s.unitCode]) listed.get(no)[s.unitCode].price = s.next;
    return { sent: steps.length };
  }

  return {
    /** 사이트의 구역 → 통화. 한국 구역이 정확히 하나가 아니면 siteUnits() 가 멈춘다. */
    async units() {
      return { map: Object.fromEntries((await siteUnits()).map(u => [u.unitCode, u.currency])), how: 'declared' };
    },
    async list() {
      const all = await siteUnits();
      const rows = [];
      listed.clear();
      for (const u of all) {
        for (const p of await client.products(u.unitCode)) {
          const no = String(p.prodNo);
          if (!listed.has(no)) listed.set(no, {});
          listed.get(no)[u.unitCode] = { price: Number(p.price), name: String(p.name || '') };
          if (u === all[0]) rows.push({ prodNo: no, name: String(p.name || '') });
        }
      }
      return rows;
    },
    /** 마지막 목록의 기본가 [{ unitCode, price }] — 저장한 값을 목록으로 확인할 때(호출 없음). */
    base: prodNo => Object.entries(listed.get(String(prodNo)) || {}).map(([unitCode, b]) => ({ unitCode, price: b.price })),
    product,
    save
  };
}

// ── 미리보기 · 저장 ──────────────────────────────────────────────────────

// gateway() 는 createOpenApiGateway 로 만든 연결을 돌려준다(main_process 가 OAuth 클라이언트를 넣어 준다).
export function createImwebUnitPrices({ rates, dir, gateway, clock = Date.now,
  sleep = ms => new Promise(r => setTimeout(r, ms)), notify = () => {}, log = console, pace = 800 }) {
  let busy = null, plan = null;
  const rowsFile = path.join(dir, 'imweb_unit_prices_rows.json'), sampleFile = path.join(dir, 'imweb_unit_prices_sample.json');
  const progress = running => { try { notify({ running }); } catch { /* 닫히는 창 */ } };
  const writeJson = (file, data) => { try { fs.writeFileSync(file, JSON.stringify(data, null, 1), 'utf8'); } catch (e) { log.error?.('[imweb-unit] 저장 실패: ' + e.message); } };

  async function open() {
    const got = await rates();
    if (!got?.success) throw new Error(got?.error || '환율을 불러오지 못했습니다.');
    const problem = rateProblem(got.data, clock());
    if (problem) throw new Error(problem);
    return { snapshot: JSON.parse(JSON.stringify(got.data)), api: await gateway() };
  }

  // 한 상품의 계산. 계산 오류(한국가가 너무 작아 환산이 안 되는 등)는 전체를 멈추지 않고 그 상품만 건너뛴다.
  const planOf = (product, site, snapshot) => {
    try { return planProduct(product, site.map, snapshot); }
    catch (e) { return { skip: '계산 실패 — 건너뜀: ' + e.message }; }
  };
  // 결과 파일 한 줄: 구역별 지금 값 → 새 값, 옵션 조합별 지금 값 → 새 값(결과 CSV 로 저장 전에 확인한다).
  const planRow = (product, p, result) => ({
    prodNo: product.prodNo, name: product.name, kr: p.krPrice,
    units: Object.entries(p.base).map(([unit, b]) => ({ unit, currency: b.currency, current: b.current, next: b.next, raw: b.raw, change: b.change })),
    options: p.changedCombos,
    combos: p.combos.map(c => ({ text: c.text, kr: c.prices[p.krUnit] ?? 0,
      now: Object.fromEntries(Object.keys(c.next).map(unit => [unit, c.prices[unit]])), next: c.next })),
    large: p.large, result,
  });

  async function preview() {
    const { snapshot, api } = await open();
    progress({ step: 'preview', index: 0, total: 0, message: 'Open API 로 상품 목록을 읽는 중' });
    const site = await api.units();
    const list = await api.list();
    const rows = [], changes = [], samples = [];
    for (const [i, row] of list.entries()) {
      progress({ step: 'preview', index: i + 1, total: list.length, message: row.name });
      const d = await api.product(row.prodNo);   // 호출 간격은 클라이언트가 남은 호출 수를 보고 맞춘다
      // 첫 상품과 옵션 조합이 둘 이상인 첫 상품의 응답을 남겨 구역·가격·옵션 필드를 사람이 확인할 수 있게 한다.
      if (i === 0 || (samples.length < 2 && (d?.productOptionInfo?.optionDetails || []).length > 1)) {
        samples.push({ prodNo: row.prodNo, priceInfo: d?.priceInfo, productOptionInfo: d?.productOptionInfo,
          prodBaseInfoByUnit: d?.baseInfo?.prodBaseInfoByUnit });
        writeJson(sampleFile, samples);
      }
      const product = normalizeProduct(row.prodNo, d), p = planOf(product, site, snapshot);
      if (p.skip) { rows.push({ prodNo: product.prodNo, name: product.name, result: p.skip }); continue; }
      rows.push(planRow(product, p, p.changed ? '바꿀 예정' : '이미 같은 가격'));
      if (p.changed) changes.push({ product, plan: p });
    }
    plan = { at: clock(), rate: rateInfo(snapshot), fetchedAt: snapshot.fetchedAt, site, changes, skipped: rows.filter(r => !r.units) };
    writeJson(rowsFile, rows);
    return summary(rows);
  }

  function summary(rows) {
    return {
      rate: plan?.rate || null, site: plan?.site ? { map: plan.site.map, how: plan.site.how } : null,
      products: rows.length, changes: plan?.changes.length || 0,
      large: rows.filter(r => r.large && r.result === '바꿀 예정').length,
      skipped: rows.filter(r => !r.units).length,
      lines: rows.filter(r => r.result === '바꿀 예정').slice(0, 30).map(r => r.name + ' — 한국 ' + money(r.kr, 'KRW') + ' · ' +
        r.units.map(u => (u.currency === 'USD' ? '미국 ' : '일본 ') + money(u.current, u.currency) + (u.next !== u.current ? ' → ' + money(u.next, u.currency) : ' 그대로')).join(' · ') +
        (r.options ? ' · 옵션 ' + r.options + '건' : '') + (r.large ? ' · 10% 넘게 바뀜' : '')),
    };
  }

  // 저장 한 건: now(방금 읽은 값)로 본문을 만들어 보내고 → 옵션을 다시 읽어 확인한다. 다르면 now 로 되돌리고 멈춘다.
  // 본문을 now 로 만드는 까닭: 옵션 쓰기 형식은 재고·판매상태까지 통째로 담아서, 오래된 원본을 쓰면 그 사이 주문으로
  // 줄어든 재고·품절이 되살아난다. 기본가는 상품마다 다시 읽지 않고 다음 목록에서 확인한다(settle).
  async function writeOne(api, product, p, now) {
    const payload = buildPatch(now, p);
    try { await api.save(product.prodNo, payload); }
    catch (e) { return { result: '저장 실패: ' + e.message, stop: '저장이 거부돼 멈췄습니다: ' + e.message }; }
    await sleep(pace);
    let problems;
    try { problems = checkAfter(normalizeProduct(product.prodNo, await api.product(product.prodNo)), product, p); }
    catch (e) { problems = ['저장 뒤 다시 읽지 못함: ' + e.message]; }
    if (problems.length) {
      let restored = '되돌림';
      try { await api.save(product.prodNo, restorePatch(now, payload)); } catch (e) { restored = '되돌리기 실패: ' + e.message; }
      return { result: '확인 실패(' + restored + '): ' + problems.join(' / '),
        stop: '저장 결과가 계획과 달라 멈췄습니다. 이 상품을 관리자에서 확인하세요: ' + product.name };
    }
    log.log?.(`[imweb-unit] ${product.prodNo} ${product.name} 저장`);
    return { result: '저장·확인 완료' };
  }

  // 목록을 다시 읽는다(구역마다 한 번에 100개): 앞서 저장한 상품의 기본가를 확인하고, 다음 상품들의 기본가를 새로 한다.
  // 첫 저장 바로 뒤(구역이 뒤바뀌어 저장되는 것 같은 문제를 한 상품에서 잡는다), 그다음 저장 100개마다, 끝에 한 번 —
  // 바꿀 것이 없는 날은 목록을 더 읽지 않는다. 다르면 되돌리지 않고 멈춘다(저장하고 몇 분 사이에 사람이 고친 값일 수 있다).
  const due = (count, pending) => count.saved === 1 || pending.length >= SETTLE_EVERY;
  async function settle(api, pending, count) {
    await api.list();
    let first = '';
    for (const x of pending.splice(0)) {
      const problems = baseProblems(api.base(x.row.prodNo), x.p);
      if (!problems.length) continue;
      x.row.result = '기본가 확인 실패(목록): ' + problems.join(' / ');
      count.saved--; count.failed++;
      first ||= '저장 뒤 목록에서 읽은 기본가가 계획과 달라 멈췄습니다. 이 상품을 관리자에서 확인하세요: ' + x.row.name;
    }
    return first;
  }
  const settleLast = (api, pending, count) => pending.length
    ? settle(api, pending, count).catch(e => '저장 뒤 목록을 읽지 못해 기본가를 확인하지 못했습니다: ' + e.message) : '';

  async function save() {
    if (!plan?.changes.length) throw new Error('먼저 미리보기를 실행하세요. 바꿀 가격이 없으면 저장할 것도 없습니다.');
    if (clock() - plan.at > PLAN_TTL) throw new Error('미리보기를 한 지 30분이 지났습니다. 미리보기를 다시 실행하세요.');
    const { api } = await open();
    const results = [], pending = [], count = { saved: 0, changedSince: 0, failed: 0 }, skipped = plan.skipped;
    let stopped = '';
    try {
      await api.list();   // 저장 직전 기본가 — 미리보기 때 읽은 목록은 30분까지 지났을 수 있다
      for (const [i, { product, plan: p }] of plan.changes.entries()) {
        progress({ step: 'save', index: i + 1, total: plan.changes.length, message: product.name });
        const row = { prodNo: product.prodNo, name: product.name, result: '' };
        results.push(row);
        let now;
        try { now = normalizeProduct(product.prodNo, await api.product(product.prodNo)); }
        catch (e) { count.failed++; row.result = '조회 실패: ' + e.message; if (e.status === 401 || e.status === 403) { stopped = e.message; break; } continue; }
        // 미리보기 뒤에 누가 가격을 고쳤으면 보내지 않는다.
        if (JSON.stringify(now.priceInfo.map(e => [e.unitCode, e.price])) !== JSON.stringify(product.priceInfo.map(e => [e.unitCode, e.price])) ||
            JSON.stringify(now.combos.map(c => c.prices)) !== JSON.stringify(product.combos.map(c => c.prices))) {
          count.changedSince++; row.result = '미리보기 뒤에 가격이 바뀌어 보내지 않음'; continue;
        }
        const w = await writeOne(api, product, p, now);
        row.result = w.result;
        if (w.stop) { count.failed++; stopped = w.stop; break; }
        count.saved++; pending.push({ row, p });
        if (due(count, pending) && (stopped = await settle(api, pending, count))) break;
      }
    } finally {
      plan = null;   // 같은 미리보기로 두 번 저장하지 않는다
      stopped ||= await settleLast(api, pending, count);
    }
    writeJson(rowsFile, [...results, ...skipped]);   // 건너뛴 상품과 이유도 남긴다(결과 CSV)
    return { count, stopped, results: results.slice(0, 30) };
  }

  // 매일 자동 실행(fx_auto_price.js): 상품마다 읽고 → 계산하고 → 바로 저장한다(미리보기 → 저장처럼 옵션을 두 번 읽지 않는다).
  // 10% 넘게 바뀌는 상품은 아마존·eBay 처럼 건너뛴다(화면의 미리보기로 보고 저장). stop: 다음 상품에서 멈춘다.
  async function sync({ stop = () => false } = {}) {
    const { snapshot, api } = await open();
    const site = await api.units();
    const list = await api.list();
    const rows = [], pending = [], count = { products: list.length, skipped: 0, unchanged: 0, large: 0, saved: 0, failed: 0 };
    let stopped = '';
    try {
      for (const [i, row] of list.entries()) {
        if (stop()) { stopped = '사용자가 중단했습니다.'; break; }
        progress({ step: 'save', index: i + 1, total: list.length, message: row.name });
        let product;
        try { product = normalizeProduct(row.prodNo, await api.product(row.prodNo)); }
        catch (e) { count.failed++; rows.push({ ...row, result: '조회 실패: ' + e.message }); if (e.status === 401 || e.status === 403) { stopped = e.message; break; } continue; }
        const p = planOf(product, site, snapshot);
        if (p.skip) { count.skipped++; rows.push({ ...row, result: p.skip }); continue; }
        if (!p.changed) { count.unchanged++; rows.push(planRow(product, p, '이미 같은 가격')); continue; }
        if (p.large) { count.large++; rows.push(planRow(product, p, '10% 넘게 바뀌어 자동 저장 안 함 — 미리보기로 확인 후 저장')); continue; }
        const w = await writeOne(api, product, p, product), done = planRow(product, p, w.result);
        rows.push(done);
        if (w.stop) { count.failed++; stopped = w.stop; break; }
        count.saved++; pending.push({ row: done, p });
        if (due(count, pending) && (stopped = await settle(api, pending, count))) break;
      }
    } finally {
      stopped ||= await settleLast(api, pending, count);
      writeJson(rowsFile, rows);
    }
    return { count, stopped, rate: rateInfo(snapshot) };
  }

  async function exclusive(kind, work) {
    if (busy) throw new Error('아임웹 가격 ' + (busy === 'save' ? '저장' : '미리보기') + '이 이미 진행 중입니다.');
    busy = kind;
    try { return await work(); } finally { busy = null; progress(null); }
  }
  return {
    preview: () => exclusive('preview', preview),
    save: () => exclusive('save', save),
    sync: options => exclusive('save', () => sync(options)),
    rows: () => { try { return JSON.parse(fs.readFileSync(rowsFile, 'utf8')); } catch { return []; } },
  };
}

export function registerImwebUnitPricesIPC({ ipcMain, log = console, ...deps }) {
  const service = createImwebUnitPrices({ log, ...deps });
  const handle = (channel, work) => ipcMain.handle(channel, async () => {
    try { return { success: true, data: await work() }; }
    catch (e) { return { success: false, error: e?.message || String(e) }; }
  });
  handle('imweb-unit-prices-preview', () => service.preview());
  handle('imweb-unit-prices-save', () => service.save());
  handle('imweb-unit-prices-rows', () => service.rows());
  return service;
}
