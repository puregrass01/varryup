// 아임웹 미국·일본 상품명 · 옵션 이름 — 본사몰 한 사이트 안의 구역(unit)별 이름을 한국 이름에서 번역해 넣는다.
//
// 아임웹은 상품을 만들 때 한국 구역의 이름 · 옵션 이름을 미국 · 일본 구역에 그대로 복사한다(2026-10-20 실측: 1,644개 중
// 1,576개가 미국 · 일본 이름에 한글). 가격은 imweb_unit_prices.js 가 맡고, 여기는 이름만 한다.
// 번역 원본: 차량 명칭 사전(data/vehicle_i18n.json ← CSVdatabase V2 Vehicles · Manufacturers, 일본차는 japan_vehicle_catalog)
// → 코드표 카탈로그의 영문 차종, 그리고 아래 고정 단어표. 기계번역은 하지 않는다 — 모르는 이름은 건너뛰고 결과 CSV 에 남긴다.
// 한글이 없는 이름(이미 번역된 상품)은 건드리지 않는다. 저장은 미리보기로 확인한 뒤에만 한다.
import fs from 'node:fs';
import path from 'node:path';
import { loadVehicleNames, reverseLookup, untag } from './amazon_jp_draft.js';
import { toFormData } from './platforms/openapi/imweb_client.js';
import { hasBsa } from './utils/duplicate_guard.js';
import { writeJsonAtomic } from './utils/json_file.js';

const TARGETS = { USD: 0, JPY: 1 };    // 구역 통화 → 단어표의 [영어, 일본어] 자리
const PLAN_TTL = 30 * 60 * 1000;
const HANGUL = /[가-힣]/;
// 2026-10-20 사용자: 옵틱글래스 → Optic-glass (영어 · 일본어 같은 표기). 미러 이름은 이미 번역된 상품 3 · 126 의 표기다.
const SHOP = 'Optic-glass';
const MIRROR = ['Wide View Side Mirror', '広角ドアミラー'];
// 옵션 그룹 · 값 [영어, 일본어] — 이미 번역된 상품 3 · 126 의 구역별 표기 그대로(2026-10-20 읽음).
export const OPTION_WORDS = {
  '구성 선택': ['Select Option', 'セット内容'],
  '구성': ['Select Option', 'セット内容'],
  'BSA 여부': ['BSA Sensor', 'BSA(後側方警戒システム)の有無'],
  '측후방센서(BSA)등 유/무': ['BSA Sensor', 'BSA(後側方警戒システム)の有無'],
  '제조사명 | 연식 | 모델명': ['Brand | Year | Model', 'メーカー | 年式 | 車種名'],
  '상품 번호': ['Product number', '商品番号'],
  '1set': ['1set', '1セット(左右)'],
  '운전석': ['Left', '運転席'],
  '조수석': ['Right', '助手席'],
  'BSA 없음': ['No BSA', 'なし'],
  'BSA 있음': ['With BSA', 'あり'],
  '2set': ['2set', '2セット'],
  '3set': ['3set', '3セット'],
  '1세트(운전석+조수석)': ['1set (Left + Right)', '1セット(運転席+助手席)'],
  // 2026-10-21 사용자 승인 — 미러가 아닌 상품(사이드스텝 · 스피커)의 옵션
  '차량 제조사|차량 연식|차량명': ['Brand | Year | Model', 'メーカー | 年式 | 車種名'],
  '차량 제조사|차량연식|차량명': ['Brand | Year | Model', 'メーカー | 年式 | 車種名'],
  '차량연식': ['Year', '年式'],
  '차량선택': ['Select Vehicle', '車種選択'],
  '벤츠 GLS': ['Mercedes-Benz GLS', 'メルセデス・ベンツ GLS'],
  '벤츠 GLE': ['Mercedes-Benz GLE', 'メルセデス・ベンツ GLE'],
  '장착 유무': ['Installation', '取付'],
  '본사장착': ['Installed at HQ', '本社で取付'],
  '장착없이 구매만': ['Purchase only', '購入のみ'],
};

// '옵틱글래스 아우디 S6 광각미러 [No.445]' · '옵틱글래스 광각미러 [No.104(옵)]' — 본사몰 미러 상품명(2026-10-20 1,573개)
const MIRROR_NAME = /^옵틱글래스\s+(?:(.+?)\s+)?광각미러\s*\[No\.\s*([^\]]+?)\s*\]\s*(?:\(옵\))?$/;
const alnum = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const optionKey = s => String(s).replace(/_x000D_/g, '').trim();
// 앞에 붙은 브랜드를 뗀다. (?![a-z]) 는 'Ram' 이 'Rampage' 를 자르지 않게 한다. 다 지워지면 원래 값을 둔다.
const cut = (s, ...brands) => brands.reduce((x, b) =>
  x.replace(new RegExp('^' + b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![a-z])\\s*', 'i'), '').trim() || x, s);

/** names = loadVehicleNames() → 한국 상품명 하나를 { en, ja, note } 또는 { skip } 으로. */
export function makeTranslator({ vu, dict, catalog }) {
  const reverse = reverseLookup(dict);
  const catalogEn = new Map();   // '영문 브랜드|코드표 차종' → 영문 차종들
  for (const v of catalog?.variants || []) {
    if (!v.modelEn) continue;
    const key = vu.brandEn(v.brand) + '|' + v.model;
    if (!catalogEn.has(key)) catalogEn.set(key, new Set());
    catalogEn.get(key).add(v.modelEn);
  }
  function model(brand, be, text) {
    const plain = text.replace(/\s*\([^)]*\)/g, '').trim();
    for (const t of new Set([text, untag(text), plain, untag(plain)])) {
      const en = vu.modelEn(brand, t), ja = vu.modelJa(brand, t);
      if (en && ja) return { en, ja };
    }
    // 차종 칸에 다른 브랜드가 든 이름('GMC 아카디아', '제네시스G90', '더뉴 제네시스 쿠페')은 그 브랜드의 사전에서 찾는다
    for (const b of Object.keys(dict.brands)) {
      if (b === brand || !text.includes(b)) continue;
      const rest = text.replace(b, ' ').replace(/\s+/g, ' ').trim(), sb = vu.brandEn(b), sj = vu.brandJa(b);
      for (const t of new Set([rest, untag(rest)])) {
        const en = vu.modelEn(b, t), ja = vu.modelJa(b, t);
        if (sb && sj && en && ja) return { en: sb + ' ' + en, ja: sj + ' ' + ja };
      }
      break;   // 못 찾으면 아래 카탈로그('MINI 쿠퍼 해치백' → MINI Cooper Hatchback)로
    }
    // 사전(V2 Vehicles)에 없는 코드표 표기('더뉴 K7', 'MINI 쿠퍼 해치백')는 카탈로그 영문 차종 → 일본어는 사전을 영문으로 거꾸로.
    // 카탈로그 영문은 이베이용 줄임말이라 세대 코드를 뺀다('YF소나타' → 'Sonata') — 한국 이름의 영문 · 숫자가 다 들어 있을 때만 쓴다.
    const ens = catalogEn.get(be + '|' + text);
    if (ens?.size !== 1) return null;
    const en = [...ens][0];
    if ((untag(plain).match(/[A-Za-z0-9]+/g) || []).some(w => !alnum(en).includes(alnum(w)))) return null;
    const ja = vu.modelJa(brand, en) || reverse.model(reverse.brand(be)?.key, en);
    return { en, ja: ja || en, note: ja ? '' : '일본어 차종 없음 — 영어 표기' };
  }
  function car(text) {
    const words = text.split(/\s+/);
    for (let k = Math.min(3, words.length - 1); k >= 1; k--) {   // 두 낱말 브랜드('르노 코리아')부터
      const brand = words.slice(0, k).join(' '), be = vu.brandEn(brand), bj = vu.brandJa(brand);
      if (!be || !bj) continue;
      const m = model(brand, be, words.slice(k).join(' '));
      // 차종 영문에 브랜드가 또 붙은 값('Tesla Model S', 'SUZUKI JIMNY')은 앞의 브랜드를 뗀다. 일본어 칸은 영문 대체일 수 있어 둘 다 본다.
      return m ? { en: be + ' ' + cut(m.en, be), ja: bj + ' ' + cut(m.ja, bj, be), note: m.note } : { skip: '사전에 없는 차종: ' + text };
    }
    return { skip: '사전에 없는 브랜드: ' + text };
  }
  return kr => {
    const m = String(kr ?? '').trim().match(MIRROR_NAME);
    if (!m) return { skip: '모르는 상품명 형식 — 관리자에서 직접 번역' };
    const no = `[No.${m[2].replace(/\s*\(옵\)$/, '')}]`;   // 상품 126 의 기존 번역처럼 (옵) 표시는 뺀다
    const c = m[1] ? car(m[1]) : { en: '', ja: '' };
    if (c.skip) return c;
    // 한국 이름의 BSA 표시는 같은 차의 일반 상품과 가르는 값이다(상품번호 'No.K130 BSA'). 사전 · 괄호 빼기에서 빠지면 다시 붙인다
    // — 2026-10-21 상품 1038 '더 뉴 기아 레이 (bsa버젼)' 이 영어에서 'THE NEW RAY' 만 남았다.
    if (hasBsa(m[1] || '')) for (const k of ['en', 'ja']) if (c[k] && !/BSA/i.test(c[k])) c[k] += ' (BSA)';
    // 카탈로그 영문 칸에 한글 메모가 있다('Picanto (피칸토)') — 괄호째 빼고, 그래도 한글이 남으면 건너뛴다.
    const join = (...xs) => xs.filter(Boolean).join(' ').replace(/\s*\([^)]*[가-힣][^)]*\)/g, '');
    const en = join(SHOP, c.en, MIRROR[0], no), ja = join(SHOP, c.ja, MIRROR[1], no);
    if (HANGUL.test(en + ja)) return { skip: '번역에 한글이 남음: ' + en + ' / ' + ja };
    return { en, ja, note: c.note || '' };
  }
}

/** 한 구역의 옵션 그룹들 → 보낼 PATCH 들. 단어표에 있는(= 한국어 그대로인) 그룹명 · 값만 바꾼다. lang 0 영어 · 1 일본어 */
export function planOptions(groups, lang) {
  // 엑셀로 올린 옵션에는 줄바꿈 찌꺼기 '_x000D_' 가 붙어 있다('BSA 여부_x000D_' — 2026-10-20 상품 6개).
  const to = s => OPTION_WORDS[optionKey(s)]?.[lang];
  return groups.flatMap(g => {
    const changes = [], body = {};
    if (to(g.name) && to(g.name) !== g.name) { body.name = to(g.name); changes.push(g.name + '→' + body.name); }
    const values = g.values.map(v => ({ optionValueCode: v.code, optionValueName: to(v.name) || v.name }));
    values.forEach((v, i) => { if (v.optionValueName !== g.values[i].name) changes.push(g.values[i].name + '→' + v.optionValueName); });
    if (values.some((v, i) => v.optionValueName !== g.values[i].name)) body.optionValueList = values;
    return changes.length ? [{ optionCode: g.code, body, changes }] : [];
  });
}

const RELIST_MS = 5 * 60 * 1000;   // 저장이 한 시간 넘게 걸린다 — 그동안 관리자에서 고친 이름을 덮지 않게 목록을 5분마다 다시 읽는다

// client() = 본사몰 Open API 클라이언트(main_process getImwebApiClient). names() 는 미리보기마다 다시 읽는다(사전을 고친 뒤 재시작 없이).
export function createImwebUnitNames({ client, dir, names = () => loadVehicleNames(), clock = Date.now,
  notify = () => {}, log = console }) {
  let busy = false, plan = null;
  const rowsFile = path.join(dir, 'imweb_unit_names_rows.json');
  const progress = running => { try { notify({ running }); } catch { /* 닫히는 창 */ } };
  const writeRows = rows => { try { writeJsonAtomic(rowsFile, rows, 1); } catch (e) { log.error?.('[imweb-names] 저장 실패: ' + e.message); } };

  async function units(api) {
    const list = (await api.siteInfo())?.unitList || [];
    const code = c => list.find(u => String(u.currency).toUpperCase() === c)?.unitCode;
    const u = { KRW: code('KRW'), USD: code('USD'), JPY: code('JPY') };
    if (!u.KRW || !u.USD || !u.JPY) throw new Error('본사몰 사이트 정보에서 한국 · 미국 · 일본 구역을 모두 찾지 못했습니다.');
    return u;
  }
  // prodNo → { KRW, USD, JPY } 이름. 구역마다 목록(한 번에 100개)으로 읽는다.
  async function listNames(api, u) {
    const all = {};
    for (const [cur, unitCode] of Object.entries(u)) {
      for (const p of await api.products(unitCode)) (all[String(p.prodNo)] ||= {})[cur] = String(p.name ?? '');
    }
    return all;
  }
  async function optionGroups(api, no, unitCode) {
    const res = await api.request('GET', `/products/${encodeURIComponent(no)}/options`, { query: { unitCode, page: 1, limit: 100 } });
    const list = res?.data?.list ?? res?.data ?? [];
    return (Array.isArray(list) ? list : []).map(o => ({ code: o.optionCode, name: String(o.name ?? ''),
      values: (o.optionValueList || []).map(v => ({ code: v.optionValueCode, name: String(v.optionValueName ?? '') })) }));
  }
  const setName = (api, no, unitCode, productName) =>
    api.request('PATCH', `/products/${encodeURIComponent(no)}`, { form: toFormData({ unitCode, productName }) });
  const setOption = (api, no, unitCode, optionCode, body) =>
    api.request('PATCH', `/products/${encodeURIComponent(no)}/options/${encodeURIComponent(optionCode)}`, { body: { unitCode, ...body } });

  async function preview() {
    const translate = makeTranslator(names());
    const api = client(), u = await units(api);
    progress({ step: 'preview', message: '구역별 상품 목록을 읽는 중' });
    const all = await listNames(api, u);
    const rows = [];
    let done = 0;
    for (const [prodNo, n] of Object.entries(all).sort((a, b) => a[0] - b[0])) {
      const todo = Object.keys(TARGETS).filter(c => HANGUL.test(n[c] ?? ''));
      if (!n.KRW) continue;
      if (!todo.length) { done++; continue; }
      const t = translate(n.KRW);
      const row = { prodNo, kr: n.KRW, usNow: n.USD ?? '', jpNow: n.JPY ?? '', usNext: '', jpNext: '', note: t.note || '', options: '' };
      if (t.skip) { rows.push({ ...row, result: t.skip }); continue; }
      if (todo.includes('USD')) row.usNext = t.en;
      if (todo.includes('JPY')) row.jpNext = t.ja;
      rows.push({ ...row, result: '바꿀 예정' });
    }
    plan = { at: clock(), rows };
    writeRows(rows);
    const changes = rows.filter(r => r.result === '바꿀 예정');
    return { products: Object.keys(all).length, translated: done, changes: changes.length, skipped: rows.length - changes.length,
      lines: changes.slice(0, 30).map(r => r.kr + ' → ' + [r.usNext, r.jpNext].filter(Boolean).join(' · ') + (r.note ? ' (' + r.note + ')' : '')),
      // 옵션은 저장 때 상품마다 읽어 이 표대로만 바꾼다(미리보기에서 1,500개 × 2구역을 더 읽지 않는다). 상품별 결과는 저장 후 CSV.
      options: Object.entries(OPTION_WORDS).map(([ko, [en, ja]]) => ko + '→' + en + '/' + ja).join(', ') };
  }

  // 한국 구역 이름 · 옵션이 그대로인지 본다. 구역별 PATCH 가 한국까지 바꾸면 되돌리고 멈춘다.
  async function checkKorea(api, u, row, before) {
    const now = await optionGroups(api, row.prodNo, u.KRW);
    const name = String((await api.product(row.prodNo, u.KRW))?.name ?? '');
    if (name === row.kr && JSON.stringify(now) === JSON.stringify(before)) return '';
    try {
      if (name !== row.kr) await setName(api, row.prodNo, u.KRW, row.kr);
      for (const g of before) await setOption(api, row.prodNo, u.KRW, g.code,
        { name: g.name, ...(g.values.length ? { optionValueList: g.values.map(v => ({ optionValueCode: v.code, optionValueName: v.name })) } : {}) });
      return '한국 구역 이름이 함께 바뀌어 되돌리고 멈췄습니다: ' + row.kr;
    } catch (e) { return '한국 구역 이름이 함께 바뀌었고 되돌리지 못했습니다(' + e.message + '). 관리자에서 확인하세요: ' + row.kr; }
  }

  async function save() {
    const todo = plan?.rows.filter(r => r.result === '바꿀 예정') || [];
    if (!todo.length) throw new Error('먼저 미리보기를 실행하세요. 바꿀 이름이 없으면 저장할 것도 없습니다.');
    if (clock() - plan.at > PLAN_TTL) throw new Error('미리보기를 한 지 30분이 지났습니다. 미리보기를 다시 실행하세요.');
    const api = client(), u = await units(api), rows = plan.rows;
    plan = null;   // 같은 미리보기로 두 번 저장하지 않는다
    const count = { saved: 0, changedSince: 0, failed: 0 };
    let stopped = '', fresh = null, freshAt = 0, koreaChecked = false;
    for (const [i, row] of todo.entries()) {
      progress({ step: 'save', index: i + 1, total: todo.length, message: row.kr });
      if (clock() - freshAt > RELIST_MS) {
        try { fresh = await listNames(api, u); freshAt = clock(); }
        catch (e) { stopped = '상품 목록을 다시 읽지 못해 멈췄습니다: ' + e.message; break; }
      }
      const n = fresh[row.prodNo] || {};
      if (n.KRW !== row.kr || (n.USD ?? '') !== row.usNow || (n.JPY ?? '') !== row.jpNow) {
        count.changedSince++; row.result = '미리보기 뒤에 이름이 바뀌어 보내지 않음'; continue;
      }
      const done = [];
      try {
        // 한국 구역 확인은 옵션까지 실제로 바꾼 상품 하나를 확인할 때까지 상품마다 한다(구역별 PATCH 가 한국을 건드리는지).
        const before = koreaChecked ? null : await optionGroups(api, row.prodNo, u.KRW);
        // 옵션을 먼저, 상품명을 마지막에 바꾼다. 중간에 멈추면 이름에 한글이 남아 다음 미리보기가 이 상품을 다시 잡는다.
        for (const [cur, lang] of Object.entries(TARGETS)) {
          const groups = await optionGroups(api, row.prodNo, u[cur]);
          for (const p of planOptions(groups, lang)) {
            await setOption(api, row.prodNo, u[cur], p.optionCode, p.body);
            done.push((cur === 'USD' ? '미국 ' : '일본 ') + p.changes.join(', '));
          }
          // 단어표에 없는 한국어 옵션은 그대로 두고 결과 CSV '확인' 칸에 적는다(관리자에서 직접 번역).
          const left = [...new Set(groups.flatMap(g => [g.name, ...g.values.map(v => v.name)]).filter(s => HANGUL.test(s) && !OPTION_WORDS[optionKey(s)]))];
          if (left.length) row.note = [row.note, (cur === 'USD' ? '미국' : '일본') + ' 옵션 한국어 남음: ' + left.join(', ')].filter(Boolean).join(' / ');
        }
        if (row.usNext) await setName(api, row.prodNo, u.USD, row.usNext);
        if (row.jpNext) await setName(api, row.prodNo, u.JPY, row.jpNext);
        row.options = done.join(' / ');
        if (before) {
          if ((stopped = await checkKorea(api, u, row, before))) { count.failed++; row.result = stopped; break; }
          koreaChecked = done.length > 0;
        }
        count.saved++; row.result = '저장 완료';
      } catch (e) {
        row.options = done.join(' / ');
        count.failed++; row.result = '저장 실패: ' + e.message; stopped = '저장이 거부돼 멈췄습니다: ' + e.message; break;
      }
    }
    // 이름은 끝에 목록으로 한 번에 확인한다(상품마다 다시 읽지 않는다). 한국 이름이 바뀌었거나 요청과 다르면 실패로 고친다.
    if (count.saved) {
      try {
        const after = await listNames(api, u);
        for (const row of todo.filter(r => r.result === '저장 완료')) {
          const a = after[row.prodNo] || {};
          const wrong = [a.KRW !== row.kr && '한국 ' + a.KRW, row.usNext && a.USD !== row.usNext && '미국 ' + a.USD,
            row.jpNext && a.JPY !== row.jpNext && '일본 ' + a.JPY].filter(Boolean);
          if (wrong.length) { count.saved--; count.failed++; row.result = '확인 실패(지금 ' + wrong.join(' · ') + ')'; }
        }
      } catch (e) { stopped ||= '저장 뒤 목록을 읽지 못해 이름을 확인하지 못했습니다: ' + e.message; }
    }
    writeRows(rows);
    log.log?.(`[imweb-names] 저장 ${count.saved} · 실패 ${count.failed}`);
    return { count, stopped, results: todo.filter(r => r.result !== '저장 완료').slice(0, 30).map(r => ({ name: r.kr, result: r.result })) };
  }

  async function exclusive(work) {
    if (busy) throw new Error('아임웹 상품명 번역이 이미 진행 중입니다.');
    busy = true;
    try { return await work(); } finally { busy = false; progress(null); }
  }
  return {
    preview: () => exclusive(preview),
    save: () => exclusive(save),
    rows: () => { try { return JSON.parse(fs.readFileSync(rowsFile, 'utf8')); } catch { return []; } },
  };
}

export function registerImwebUnitNamesIPC({ ipcMain, ...deps }) {
  const service = createImwebUnitNames(deps);
  const handle = (channel, work) => ipcMain.handle(channel, async () => {
    try { return { success: true, data: await work() }; }
    catch (e) { return { success: false, error: e?.message || String(e) }; }
  });
  handle('imweb-unit-names-preview', () => service.preview());
  handle('imweb-unit-names-save', () => service.save());
  handle('imweb-unit-names-rows', () => service.rows());
  return service;
}
