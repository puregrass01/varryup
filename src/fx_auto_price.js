// 일일 환율 자동 변경 — 아마존 미국·일본과 eBay 판매가를 '국내 기준가(원) ÷ 오늘 환율'로 맞춘다.
//
// 정한 규칙 (2026-09-30)
//   · 기준가는 가격 등급표다. 해외 상품은 처음 본 가격으로 등급을 한 번 정해 저장한다(utils/fx_pricing.js).
//   · 이 PC 에서 켠 경우에만, 앱이 켜져 있는 동안 새 환율이 들어온 뒤 하루 한 번 자동 저장한다.
//     설정은 PC 마다 따로다. 여러 PC 에서 켜면 같은 상품을 PC 수만큼 조회한다.
//   · 환산한 뒤 앞 두 자리만 남기고 버린다(110.61 → 110, 17,396엔 → 17,000엔).
//   · 환율로 계산한 값이 지금 판매가와 1% 이상 차이날 때만 저장하고, 10% 넘게 바뀌는 상품은 자동으로 저장하지 않는다.
//     두 자리 가격이 아닌 지금 가격(109.32 등)은 1% 미만이어도 한 번 정리한다(fx_pricing.js planPrice).
//   · 한 번 실행하는 동안 환율 하나로 고정한다. 환율 우대·마진 없음.
//   · 조회·저장은 상품 일괄 수정과 같은 경로(bulk_price_ipc.js)다: 보내기 직전 현재가 비교 → 저장 → 재조회.
//   · 아임웹(미국·일본 구역)은 등급표 대신 같은 상품의 한국 가격을 환산한다(imweb_unit_prices.js 미리보기 → 저장).
//     처음엔 꺼져 있고, 10% 넘게 바뀌는 상품은 여기서도 건너뛴다.
import fs from 'node:fs';
import path from 'node:path';
import { describeError } from './utils/api_error.js';
import { writeJsonAtomic } from './utils/json_file.js';
import { FX_SCOPES, DEFAULT_TIERS, MIN_CHANGE, MAX_AUTO_CHANGE, TIER_BELOW, TIER_ABOVE,
  rateProblem, fromKrw, findTier, planPrice, normalizeTiers, rateInfo } from './utils/fx_pricing.js';

// 아마존 일본은 가격을 따로 매긴 상품이 있어, 미국·eBay 에서 같은 SKU 가 받은 등급을 빌릴 수 있게 마지막에 돈다.
const ORDER = Object.keys(FX_SCOPES).filter(scope => !FX_SCOPES[scope].unavailable);
const COUNTS = ['updated', 'accepted', 'unchanged', 'check', 'small', 'large', 'noTier', 'noPrice', 'failed', 'notSent', 'rejected', 'unknown'];
const blank = () => Object.fromEntries(COUNTS.map(kind => [kind, 0]));
const pct = change => (change > 0 ? '+' : '') + (change * 100).toFixed(1) + '%';
// 기록용: 자르기 전 환산값(110.61)과 저장할 두 자리 가격(110)을 같이 남긴다.
const planned = (info, plan, currency) => ({ ...info, raw: plan.raw.toFixed(currency === 'JPY' ? 0 : 2), target: plan.target, change: plan.change });
const SKIP = { same: ['unchanged', '이미 같은 가격'], small: ['small', '환율 변동 1% 미만 — 그대로 둠'] };
// 후보 현재가를 미리 묶어 읽는 수. 아마존은 searchListingsItems 한 요청 20건, eBay 는 Offer 묶음 조회가 없어 동시 4건.
const PREFETCH = { 'amazon-us': 20, 'amazon-jp': 20, ebay: 4 };

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
const writeJson = (file, data) => writeJsonAtomic(file, data, 0);

/** userData/fx_auto_price.json — 켜기·대상·등급표·등급 연결·마지막 실행. 행별 결과는 크므로 따로 둔다. */
export class FxPriceStore {
  constructor(dir) {
    this.file = path.join(dir, 'fx_auto_price.json');
    this.rowsFile = path.join(dir, 'fx_auto_price_rows.json');
  }
  read() {
    const saved = readJson(this.file, null) || {};
    let tiers;
    try { tiers = normalizeTiers(saved.tiers); } catch { tiers = DEFAULT_TIERS.map(tier => ({ ...tier })); }
    return {
      enabled: saved.enabled === true,
      scopes: Object.fromEntries(ORDER.map(scope => [scope,
        FX_SCOPES[scope].optIn ? saved.scopes?.[scope] === true : saved.scopes?.[scope] !== false])),
      tiers,
      assignments: saved.assignments && typeof saved.assignments === 'object' ? saved.assignments : {},
      lastAuto: saved.lastAuto || null,
      lastRun: saved.lastRun || null,
    };
  }
  update(patch) {
    const next = { ...this.read(), ...patch };
    writeJson(this.file, next);
    return next;
  }
  rows() {
    const rows = readJson(this.rowsFile, []);
    return Array.isArray(rows) ? rows : [];
  }
  saveRows(rows) { writeJson(this.rowsFile, rows); }
}

const localDay = time => {
  const d = new Date(time);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
};

/**
 * @param store   FxPriceStore
 * @param rates   () => currency-rates-get 와 같은 { success, data } (currency_rates_ipc.js)
 * @param service bulk_price_ipc.js 가 돌려주는 { list, load, save, exclusive }
 */
export function createFxAutoPrice({ store, rates, service, imwebUnits = null, clock = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)),
  notify = () => {}, log = console, pace = 0 }) {
  let job = null, timer = null, noticeAt = 0;
  const iso = () => new Date(clock()).toISOString();
  const view = j => ({ trigger: j.trigger, startedAt: j.startedAt, scope: j.scope, index: j.index, total: j.total,
    counts: { ...j.counts }, cancel: j.cancel });

  function progress(force = false) {
    if (!force && clock() - noticeAt < 400) return;
    noticeAt = clock();
    try { notify({ running: job ? view(job) : null }); } catch { /* 닫히는 창 */ }
  }

  async function snapshotOf(given) {
    if (given) return given;
    const got = await rates();
    if (!got?.success || !got.data) throw new Error(got?.error || '환율을 불러오지 못했습니다.');
    return got.data;
  }

  // 등급 찾기: 저장된 연결 → 지금 가격 → 같은 SKU 가 다른 몰에서 받은 등급. 새 연결은 모았다가 한 번에 저장한다.
  function tierBook(cfg, snapshot) {
    const byId = new Map(cfg.tiers.map(tier => [tier.id, tier]));
    const assignments = { ...cfg.assignments }, added = {};
    return {
      find(scope, id, price) {
        const key = scope + ':' + id;
        const saved = byId.get(assignments[key]?.tier);
        if (saved) return saved;
        let tier = findTier(price, FX_SCOPES[scope].currency, snapshot, cfg.tiers), via = 'price';
        for (const other of Object.keys(FX_SCOPES)) {
          if (tier) break;
          if (other !== scope && byId.has(assignments[other + ':' + id]?.tier)) { tier = byId.get(assignments[other + ':' + id].tier); via = other; }
        }
        if (tier) assignments[key] = added[key] = { tier: tier.id, price: String(price), via, at: iso() };
        return tier || null;
      },
      save() {
        if (!Object.keys(added).length) return;
        store.update({ assignments: { ...store.read().assignments, ...added } });
        for (const key of Object.keys(added)) delete added[key];
      },
    };
  }

  // 결과를 모르는 저장 뒤 지금 가격을 다시 읽는다. 못 읽으면 null.
  async function recheck(scope, id) {
    await sleep(2000);
    try {
      const [row] = await service.load({ scope, id });
      const price = String(row?.price ?? '').trim();
      return Number(price) > 0 ? price : null;
    } catch { return null; }
  }

  // 목록 가격만으로 본 한 상품. 저장 후보면 { base, tier, info }, 아니면 skip 에 남길 기록.
  function screen(scope, item, { snapshot, book }) {
    const currency = FX_SCOPES[scope].currency;
    const base = { scope, id: String(item.id ?? ''), name: String(item.name || ''), current: String(item.price ?? '').trim() };
    if (!base.id || !(Number(base.current) > 0)) return { base, skip: ['noPrice', '현재가 없음 (목록)'] };
    const tier = book.find(scope, base.id, base.current);
    if (!tier) return { base, skip: ['noTier', '등급 없음 — 국내 기준가 등급표에 맞는 가격이 아닙니다'] };
    const info = { tier: tier.label, krw: tier.krw };
    const plan = planPrice({ current: base.current, currency, krw: tier.krw, snapshot });
    // 목록 가격(저장할 때 같이 고쳐지는 캐시)으로 이미 같거나 1% 미만이면 API 를 부르지 않는다. 후보만 지금 가격을 다시 읽는다.
    if (SKIP[plan.action]) return { base, skip: [...SKIP[plan.action], planned(info, plan, currency)] };
    return { base, tier, info };
  }

  // 후보의 지금 가격. 처음 부를 때 뒤따르는 후보까지 몰이 한 요청에 허용하는 만큼(아마존 20건) 묶어 읽어 둔다.
  // 저장 직전에 몰에서 한 번 더 비교하므로(bulk_price_ipc save) 몇십 초 앞서 읽은 값이어도 잘못 저장되지 않는다.
  // 묶음에서 빠졌거나 실패한 상품은 1건 조회로 다시 읽어 오류 종류를 그대로 받는다.
  function liveLoader(scope, items, ctx) {
    const cache = new Map(), width = PREFETCH[scope] || 1;
    return async (index, id) => {
      if (!cache.has(id) && width > 1 && service.loadMany) {
        const ids = [];
        for (let k = index; k < items.length && ids.length < width; k++) {
          const s = screen(scope, items[k], ctx);
          if (!s.skip && !ids.includes(s.base.id)) ids.push(s.base.id);
        }
        try { for (const item of (await service.loadMany({ scope, ids })).items) if (item.rows) cache.set(item.id, item.rows); }
        catch { /* 아래 1건 조회 */ }
      }
      const hit = cache.get(id);
      cache.delete(id);
      return hit || service.load({ scope, id });
    };
  }

  // 한 상품. 이 몰의 나머지 상품을 멈춰야 하면 이유를 돌려준다.
  async function runItem(scope, item, { snapshot, book, rows, counts, flow, live: loadLive }) {
    const currency = FX_SCOPES[scope].currency;
    const { base, skip, tier, info } = screen(scope, item, { snapshot, book });
    const note = (kind, result, extra = {}) => { counts[kind]++; rows.push({ ...base, kind, result, ...extra }); };
    if (skip) { note(...skip); return ''; }
    let row;
    try { [row] = await loadLive(base.id); }
    catch (e) {
      const d = describeError(e);
      note('failed', '조회 실패: ' + d.error, info);
      await sleep(pace);
      return d.blocking ? '다음 상품도 같은 이유로 실패할 오류라 멈췄습니다: ' + d.error : '';
    }
    const live = String(row?.price ?? '').trim();
    if (!row?.ready || row.readonly || !(Number(live) > 0)) { note('noPrice', row?.result || '현재가 없음', info); await sleep(pace); return ''; }
    base.current = live;
    const plan = planPrice({ current: live, currency, krw: tier.krw, snapshot });
    const detail = planned(info, plan, currency);
    if (SKIP[plan.action]) { note(...SKIP[plan.action], detail); await sleep(pace); return ''; }
    if (plan.action === 'large') {
      note('large', '변동 폭 ' + pct(plan.change) + ' — 자동 저장 안 함 (상품 일괄 수정의 환율가 입력으로 확인 후 저장)', detail);
      await sleep(pace);
      return '';
    }
    try {
      const saved = await service.exclusive(() => service.save({ scope, id: base.id, optionId: row.optionId,
        newPrice: plan.target, expectedPrice: live }));
      if (saved?.status === 'VERIFIED') note('updated', '저장·재조회 완료', detail);
      else if (saved?.status === 'ACCEPTED') note('accepted', saved.message || '아마존 접수 완료', detail);
      else if (saved?.status === 'UNCHANGED') note('unchanged', '이미 같은 가격', detail);
      else note('check', '확인 필요: ' + (saved?.message || '반영 확인 필요'), detail);
      flow.misses = 0;
      log.log?.(`[fx-auto] ${scope} ${base.id} ${live} → ${plan.target} ${currency} (${pct(plan.change)}) ${saved?.status || ''}`);
      await sleep(pace);
      return '';
    } catch (e) {
      const d = describeError(e, { sent: !!e?.sent });
      // 결과를 모르면 바로 멈추지 않고 지금 가격을 다시 읽어 확인한다(운영 전략: 응답이 불명확하면 조회로 먼저 확인).
      // 2026-10-01 eBay 가 382번째 상품에서 '[25001] A system error has occurred' 로 답해 나머지 513개가 처리되지 않았다.
      const seen = d.stage === 'unknown' && !d.blocking ? await recheck(scope, base.id) : null;
      if (seen !== null && Number(seen) === Number(plan.target)) {
        note('updated', '저장 확인 (오류 응답 뒤 다시 읽어 확인): ' + d.error, detail);
        flow.misses = 0;
        await sleep(pace);
        return '';
      }
      if (seen !== null && Number(seen) === Number(live)) {
        note('notSent', '반영 안 됨 (오류 응답 뒤 다시 읽어 확인) · 다음 실행에서 다시 시도: ' + d.error, detail);
        await sleep(pace);
        // 같은 일이 연달아 생기면 일시 오류가 아니다. 계속 두드리지 않는다.
        return ++flow.misses >= 3 ? '저장이 3번 연속 반영되지 않아 멈췄습니다: ' + d.error : '';
      }
      if (d.stage === 'pre-send') note('notSent', '전송 안 됨: ' + d.error, detail);
      else if (d.stage === 'rejected') note('rejected', '거부됨 (반영 안 됨): ' + d.error, detail);
      else note('unknown', '결과 불명 — 다시 보내기 전에 현재가 확인: ' + d.error, detail);
      log.error?.(`[fx-auto] ${scope} ${base.id} 저장 실패(${d.kind} ${d.stage}): ${d.error}`);
      await sleep(pace);
      if (d.blocking) return '다음 상품도 같은 이유로 실패할 오류라 멈췄습니다: ' + d.error;
      if (d.stage === 'unknown') return '보낸 요청의 결과를 확인하지 못해 멈췄습니다. 해당 상품의 현재가를 확인하세요.';
      return '';
    }
  }

  async function runScope(scope, ctx) {
    const counts = blank(), summary = { total: 0, counts, error: '', stopped: '' };
    Object.assign(job, { scope, index: 0, total: 0, counts });
    progress(true);
    let items;
    try {
      const listed = await service.list({ scope, query: '' });
      // 잘린 목록(아마존 캐시 없음 → API 1000건 한도)으로 돌면 나머지 상품을 말없이 건너뛴 채 끝난 것처럼 보인다.
      if (listed?.truncated) { summary.error = listed.note || '상품 목록이 잘려 일부만 보입니다.'; return summary; }
      items = listed?.items || [];
    }
    catch (e) { summary.error = describeError(e).error; return summary; }
    items = items.filter(item => !item.readonly && !item.priceReadonly);
    summary.total = job.total = items.length;
    const flow = { misses: 0 };   // 오류 응답 뒤 다시 읽어 보니 반영되지 않은 저장이 연달아 몇 번인지
    const loader = liveLoader(scope, items, ctx);
    for (const [index, item] of items.entries()) {
      if (job.cancel) { summary.stopped = '사용자가 중단했습니다.'; break; }
      job.index = index + 1;
      const stop = await runItem(scope, item, { ...ctx, counts, flow, live: id => loader(index, id) });
      progress();
      if (stop) { summary.stopped = stop; break; }
    }
    progress(true);
    return summary;
  }

  // 아임웹: 상품마다 옵션 조합 가격이 따로라 상품마다 읽고 → 계산하고 → 바로 저장한다(imweb_unit_prices.js sync —
  // 환율은 그쪽이 같은 서비스에서 다시 읽는다). 바꿀 상품이 많으면 몇 시간 걸린다 — 중단은 다음 상품에서 듣는다.
  async function runImweb() {
    const counts = blank(), summary = { total: 0, counts, error: '', stopped: '' };
    Object.assign(job, { scope: 'imweb-en', index: 0, total: 0, counts });
    progress(true);
    try {
      if (!imwebUnits) throw new Error('아임웹 Open API 연결이 없습니다.');
      const { count, stopped } = await imwebUnits.sync({ stop: () => job.cancel });
      summary.total = job.total = count.products;
      // check: 한국가 없음·추가금 방식 등 — 관리자에서 확인
      Object.assign(counts, { updated: count.saved, unchanged: count.unchanged, check: count.skipped, large: count.large, failed: count.failed });
      summary.stopped = stopped;
    } catch (e) { summary.error = e?.message || String(e); }
    progress(true);
    return summary;
  }

  async function run({ trigger = 'manual', snapshot: given = null } = {}) {
    if (job) throw new Error('환율 자동 변경이 이미 실행 중입니다.');
    job = { trigger, startedAt: iso(), scope: '', index: 0, total: 0, counts: blank(), cancel: false };
    const cfg = store.read(), rows = [], result = { trigger, startedAt: job.startedAt, scopes: {} };
    progress(true);
    try {
      let snapshot;
      try { snapshot = await snapshotOf(given); } catch (e) { result.error = e.message; return result; }
      const problem = rateProblem(snapshot, clock());
      if (problem) { result.error = problem; return result; }
      snapshot = JSON.parse(JSON.stringify(snapshot));   // 실행이 끝날 때까지 이 환율 하나로 계산한다
      result.rate = rateInfo(snapshot);
      const book = tierBook(cfg, snapshot);
      for (const scope of ORDER) {
        if (!cfg.scopes[scope] || job.cancel) continue;
        try { result.scopes[scope] = await (scope === 'imweb-en' ? runImweb() : runScope(scope, { snapshot, book, rows })); }
        finally { book.save(); }
      }
      result.cancelled = job.cancel;
      return result;
    } catch (e) {
      result.error = e?.message || String(e);
      return result;
    } finally {
      result.finishedAt = iso();
      try { store.saveRows(rows); store.update({ lastRun: result }); }
      catch (e) { log.error?.('[fx-auto] 결과 저장 실패: ' + e.message); }
      job = null;
      try { notify({ running: null, lastRun: result }); } catch { /* 닫히는 창 */ }
    }
  }

  // 켜져 있으면 새 환율이 들어온 뒤 하루 한 번. 어제 돌린 환율 그대로면 다음 확인까지 기다린다.
  async function tick() {
    if (job) return 'running';
    const cfg = store.read();
    if (!cfg.enabled) return 'disabled';
    if (!ORDER.some(scope => cfg.scopes[scope])) return 'no-scope';
    const day = localDay(clock());
    if (cfg.lastAuto?.day === day) return 'done-today';
    let snapshot;
    try { snapshot = await snapshotOf(null); } catch { return 'no-rate'; }
    if (rateProblem(snapshot, clock())) return 'no-rate';
    if (cfg.lastAuto?.fetchedAt === snapshot.fetchedAt) return 'same-rate';
    if (job) return 'running';   // 환율을 기다리는 사이 수동 실행이 시작됐다
    // 시작할 때 기록한다. 도중에 앱을 닫아도 같은 날 다시 돌지 않고, 남은 상품은 다음 실행이 이어받는다.
    store.update({ lastAuto: { day, fetchedAt: snapshot.fetchedAt, startedAt: iso() } });
    await run({ trigger: 'auto', snapshot });
    return 'ran';
  }

  function start({ delay = 2 * 60 * 1000, every = 15 * 60 * 1000 } = {}) {
    if (timer) return;
    const loop = async () => {
      try { await tick(); }
      catch (e) { log.error?.('[fx-auto] 자동 실행 확인 실패: ' + (e?.message || e)); }
      finally { if (timer) timer = setTimeout(loop, every); }
    };
    timer = setTimeout(loop, delay);
  }
  function stop() {
    clearTimeout(timer);
    timer = null;
    if (job) job.cancel = true;
  }
  function cancel() {
    if (!job) return false;
    job.cancel = true;
    progress(true);
    return true;
  }

  async function state({ withRate = true } = {}) {
    const cfg = store.read(), linked = {};
    for (const a of Object.values(cfg.assignments)) linked[a?.tier] = (linked[a?.tier] || 0) + 1;
    let snapshot = null, rateError = '';
    if (withRate) {
      try { snapshot = await snapshotOf(null); rateError = rateProblem(snapshot, clock()); }
      catch (e) { rateError = e.message; }
    }
    const usable = snapshot && !rateError;
    return {
      enabled: cfg.enabled, scopes: cfg.scopes,
      tiers: cfg.tiers.map(tier => ({ ...tier, linked: linked[tier.id] || 0,
        preview: usable ? { USD: fromKrw(tier.krw, 'USD', snapshot), JPY: fromKrw(tier.krw, 'JPY', snapshot) } : null })),
      channels: Object.entries(FX_SCOPES).map(([id, s]) => ({ id, label: s.label, currency: s.currency, unavailable: s.unavailable || '' })),
      rules: { minChange: MIN_CHANGE, maxChange: MAX_AUTO_CHANGE, tierBelow: TIER_BELOW, tierAbove: TIER_ABOVE },
      rate: usable ? rateInfo(snapshot) : null, rateError: withRate ? rateError : '',
      lastRun: cfg.lastRun, lastAuto: cfg.lastAuto, running: job ? view(job) : null,
    };
  }

  function saveConfig(input = {}) {
    const cfg = store.read(), patch = {};
    if (input.enabled !== undefined) patch.enabled = input.enabled === true;
    if (input.scopes) patch.scopes = Object.fromEntries(ORDER.map(scope => [scope, input.scopes[scope] === true]));
    if (input.tiers !== undefined) {
      // 새 등급은 지금 쓰는 id 를 받지 않는다. 지운 등급의 id 를 다시 주면 그 등급의 상품이 새 금액으로 넘어간다.
      patch.tiers = normalizeTiers(input.tiers, [...cfg.tiers.map(tier => tier.id), ...Object.values(cfg.assignments).map(a => a?.tier)]);
      // 지운 등급에 연결됐던 상품은 다음 실행에서 지금 가격으로 등급을 다시 찾는다.
      const kept = new Set(patch.tiers.map(tier => tier.id));
      patch.assignments = Object.fromEntries(Object.entries(cfg.assignments).filter(([, a]) => kept.has(a?.tier)));
    }
    store.update(patch);
  }

  // 상품 일괄 수정의 '환율가 입력' — 화면에 불러온 행의 새 판매가만 계산한다. 저장은 화면의 '선택 변경 저장'.
  // action 은 자동 실행과 같은 판단(same·small·large·update)이다. 화면은 update·large 만 채운다.
  async function plan({ scope, rows = [] } = {}) {
    const channel = Object.hasOwn(FX_SCOPES, scope) ? FX_SCOPES[scope] : null;
    if (scope === 'imweb-en') throw new Error('아임웹은 환율 자동 변경의 「아임웹 미국·일본」 미리보기로 바꿉니다(옵션 조합 가격을 함께 맞춘다).');
    if (!channel || channel.unavailable) throw new Error(channel?.unavailable || '환율가는 아마존·eBay 에서만 입력할 수 있습니다.');
    if (!Array.isArray(rows) || rows.length > 5000) throw new Error('계산할 행 목록이 올바르지 않습니다.');
    const snapshot = await snapshotOf(null), problem = rateProblem(snapshot, clock());
    if (problem) throw new Error(problem);
    const book = tierBook(store.read(), snapshot);
    const out = rows.map(r => {
      const id = String(r?.id ?? ''), optionId = String(r?.optionId ?? ''), price = String(r?.price ?? '').trim();
      if (!id) return { id, optionId, error: '상품번호 없음' };
      if (!(Number(price) > 0)) return { id, optionId, error: '현재가 없음' };
      const tier = book.find(scope, id, price);
      if (!tier) return { id, optionId, error: '등급 없음' };
      const p = planPrice({ current: price, currency: channel.currency, krw: tier.krw, snapshot });
      return { id, optionId, target: p.target, raw: p.raw, change: p.change, action: p.action,
        tier: { id: tier.id, label: tier.label, krw: tier.krw } };
    });
    book.save();
    return { rate: rateInfo(snapshot), rows: out };
  }

  return { run, tick, start, stop, cancel, state, saveConfig, plan, rows: () => store.rows(), running: () => !!job };
}

export function registerFxAutoPriceIPC({ ipcMain, dir, log = console, ...deps }) {
  const fx = createFxAutoPrice({ store: new FxPriceStore(dir), log, ...deps });
  const handle = (channel, work) => ipcMain.handle(channel, async (_, input) => {
    try { return { success: true, data: await work(input || {}) }; }
    catch (e) { return { success: false, error: e?.message || String(e) }; }
  });
  handle('fx-auto-price-get', () => fx.state());
  handle('fx-auto-price-save', input => { fx.saveConfig(input); return fx.state(); });
  handle('fx-auto-price-run', () => {
    if (fx.running()) throw new Error('환율 자동 변경이 이미 실행 중입니다.');
    // 끝까지 기다리지 않는다. 진행 상황은 fx-auto-price-progress 로 보낸다.
    fx.run({ trigger: 'manual' }).catch(e => log.error?.('[fx-auto] ' + (e?.message || e)));
    return fx.state({ withRate: false });
  });
  handle('fx-auto-price-cancel', () => { fx.cancel(); return fx.state({ withRate: false }); });
  handle('fx-auto-price-rows', () => fx.rows());
  handle('fx-auto-price-plan', input => fx.plan(input));
  return fx;
}
