/**
 * 베리맵 — 기준 코드표(구글시트) 불러오기 + 정규화
 *
 * 기준 시트: "베리맵-★자동차-코드표 (상품등록)" 의 시트1 (966행)
 * 사본을 만들지 않고 돌릴 때마다 구글시트에서 CSV 로 바로 읽는다 —
 * 낡은 사본으로 대조하면 틀린 답이 나온다(7월 스냅샷으로 겪은 문제).
 *
 * 시트 공유가 "링크가 있는 모든 사용자 - 뷰어" 여야 읽힌다. 아니면 HTML 이 돌아온다.
 *
 * 실행
 *   node scripts/verimap_load_codetable.mjs
 *   node scripts/verimap_load_codetable.mjs --gid=60391226     다른 탭
 *
 * 설정   data/verimap/config.json   (첫 실행 때 기본값으로 만들어진다)
 * 결과   data/verimap/codetable.json          정규화 결과 (대조 스크립트가 읽는다)
 *        data/verimap/codetable_norm.csv      사람이 눈으로 볼 용도
 *        data/verimap/codetable_except.csv    파싱 못 한 행만
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'data', 'verimap');
const CONFIG_PATH = path.join(OUT_DIR, 'config.json');

const DEFAULT_CONFIG = {
  codeTables: [
    { name: '자동차',   enabled: true,  sheetId: '1aJFwiBk0R9eFUTIt5UFX26cxCkZnOoZqQmOyKUYZhWY', gid: '0', tab: '시트1' },
    // 오토바이는 435행 중 부품번호가 있는 게 92행뿐이다(나머지는 '-'). 미러가 아직 없는 모델까지
    // 적어 둔 예정 목록이라 대조 대상이 아니다. 틀만 남겨 두고 끈다 — 필요해지면 enabled 를 true 로.
    { name: '오토바이', enabled: false, sheetId: '1cRqsQQDj4A9ZOtQrcBq14-9ySqJZQ5O42lSDniRI5jg', gid: '0', tab: '기본'  },
  ],
  _메모: 'enabled:false 면 건너뛴다. gid 는 시트 URL 의 #gid= 뒤 숫자이고, 틀리면 tab(탭 이름) 으로 한 번 더 시도한다.',
};

const argVal = name => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3).trim() : '';
};

// ── 설정 ────────────────────────────────────────────────────
function loadConfig() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  let cfg = { ...DEFAULT_CONFIG };
  if (fs.existsSync(CONFIG_PATH)) {
    try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) }; } catch {}
  } else {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf8');
    console.log(`설정 파일 생성: ${path.relative(ROOT, CONFIG_PATH)}`);
  }
  // --only=오토바이 로 꺼져 있는 표도 한 번 돌려볼 수 있다
  const only = argVal('only');
  if (only) cfg.codeTables = cfg.codeTables.filter(t => t.name === only);
  else {
    const off = cfg.codeTables.filter(t => t.enabled === false).map(t => t.name);
    if (off.length) console.log(`건너뜀 (enabled:false): ${off.join(', ')}`);
    cfg.codeTables = cfg.codeTables.filter(t => t.enabled !== false);
  }
  if (!cfg.codeTables?.length) { console.error(`✖ 불러올 코드표가 없습니다 (--only=${only}).`); process.exit(1); }
  return cfg;
}

// ── CSV 읽기/쓰기 ───────────────────────────────────────────
function parseCSV(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; }
      else cell += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
const q = v => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const writeCsv = (file, header, rows) => {
  const body = [header.map(q).join(','), ...rows.map(r => r.map(q).join(','))].join('\r\n');
  fs.writeFileSync(file, '﻿' + body, 'utf8');
  console.log(`  저장: ${path.relative(ROOT, file)}  (${rows.length}행)`);
};

/** 분포를 한눈에 — 무엇이 들어 있는지 보고 판단한다. */
function breakdown(label, pick, rows) {
  const counts = new Map();
  for (const r of rows) {
    const k = String(pick(r) ?? '(없음)').trim() || '(없음)';
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const sorted = [...counts].sort((a, b) => b[1] - a[1]);
  console.log(`    ── ${label} (${sorted.length}종) ──`);
  for (const [k, n] of sorted.slice(0, 20)) {
    console.log(`       ${String(n).padStart(5)}  ${k}`);
  }
  if (sorted.length > 20) console.log(`       … 외 ${sorted.length - 20}종`);
}

// ── 정규화 ──────────────────────────────────────────────────

/**
 * 부품번호 — 자동차·오토바이 공통.
 * 접두: H=현대 K=기아 S=쉐보레 R=르노 Y=쌍용 B=오토바이, 없으면 수입 자동차.
 * 번호는 3~4자리(오토바이에 No.B1501번 처럼 4자리가 있다).
 */
const PART_RE = /^No\.\s?([BHKSRY]?)(\d{3,4})(?:-(\d+))?\s?번?$/i;
const MOTO_PREFIX = 'B';
export function parsePartNo(raw) {
  const s = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  const m = PART_RE.exec(s);
  if (!m) return null;
  return {
    prefix: (m[1] || '').toUpperCase(),
    num: m[2],
    sub: m[3] || '',
    key: `${(m[1] || '').toUpperCase()}${m[2]}${m[3] ? '-' + m[3] : ''}`,
  };
}

// 한 칸에 번호가 둘 이상 적힌 행이 있다. 실제 예(랜드로버 703행):
//   No.703번(옵)
//   구 704번(bsa)
// 앞의 것이 현행 번호, `구 ...` 는 예전 BSA 판 번호다. 둘 다 채널에서 쓰이므로
// 전부 거둬 같은 행을 가리키게 한다 — 안 그러면 구 번호가 '코드표에 없는 번호'로 샌다.
const PART_ALL_RE = /(?:No\.|구)\s*([BHKSRY]?)(\d{3,4})(?:-(\d+))?\s*번?/gi;
export function parsePartNos(raw) {
  const s = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return [];
  const keys = [];
  PART_ALL_RE.lastIndex = 0;
  let m;
  while ((m = PART_ALL_RE.exec(s)) !== null) {
    const key = `${(m[1] || '').toUpperCase()}${m[2]}${m[3] ? '-' + m[3] : ''}`;
    if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

/**
 * 두 자리 연도 → 네 자리.
 * 임계값 30. (90 으로 잡으면 코드표의 80~90년대 표기 30행이 깨진다 —
 *  `82~94`(갤로퍼류)·`89.07~00.08` 이 시작>종료가 되어 파싱 실패했다.)
 */
function yy2yyyy(yy) {
  const n = Number(yy);
  return n >= 30 ? 1900 + n : 2000 + n;
}

const OPEN_END = 999912;

/** 한쪽 끝("12.03" / "11" / "2009" / "2020.11.6") → YYYYMM */
function parseEdge(token, isEnd) {
  const t = String(token).replace(/\s+/g, '');
  if (!t) return null;
  if (/^현재$/.test(t)) return OPEN_END;
  const m = /^(\d{2,4})(?:\.(\d{1,2}))?(?:\.(\d{1,2}))?$/.exec(t);
  if (!m) return null;
  const year = m[1].length === 4 ? Number(m[1]) : yy2yyyy(m[1]);
  const month = m[2] ? Number(m[2]) : (isEnd ? 12 : 1);
  if (month < 1 || month > 12) return null;
  return year * 100 + month;
}

/** 연식 → { start, end, precision, note, raw }. 못 읽으면 null. */
export function parseYears(raw) {
  let s = String(raw ?? '').replace(/\r/g, '').trim();
  if (!s) return null;
  if (/^(ALL|전체|무관)$/i.test(s)) return { start: 1, end: OPEN_END, precision: 'ALL', note: '', raw };
  if (/국내미출시|예정/.test(s)) return null;

  // 괄호 주석은 떼어 note 로
  let note = '';
  s = s.replace(/[(（][^)）]*[)）]/g, m => { note += m.replace(/[()（）]/g, '').trim() + ' '; return ''; });
  note = note.trim();

  // 날짜로 변질된 셀, 줄바꿈 다중구간은 예외
  if (/^\d{4}-\d{2}-\d{2}/.test(s) || /GMT|00:00:00/.test(s)) return null;
  if (/[\n/]/.test(s) && /\d{2}[.~-]/.test(s) && s.split(/[\n/]/).filter(x => /\d/.test(x)).length > 1) return null;

  s = s.replace(/[~–—]/g, '-').replace(/\s+/g, '').replace(/년식?/g, '');
  const parts = s.split('-');
  if (parts.length === 1) {
    const one = parseEdge(parts[0], false);
    if (one === null) return null;
    const endSame = parseEdge(parts[0], true);
    return { start: one, end: endSame ?? one, precision: /\./.test(parts[0]) ? 'M' : 'Y', note, raw };
  }
  if (parts.length > 2) return null;
  const start = parseEdge(parts[0], false);
  const end = parts[1] === '' ? OPEN_END : parseEdge(parts[1], true);
  if (start === null || end === null) return null;
  if (end !== OPEN_END && end < start) return null;   // 역순 — 원본 오류
  return { start, end, precision: /\./.test(s) ? 'M' : 'Y', note, raw };
}

/** 세대 → { no, phase, facelift }. `1세대 전기형` / `1세대전기형` / `1세대-전기형` 전부 같게 본다. */
export function parseGen(raw) {
  const s0 = String(raw ?? '').replace(/\r|\n/g, ' ').trim();
  if (!s0) return null;
  const s = s0.replace(/[\s\-·]/g, '');
  const m = /(\d+(?:\.\d+)?)세대/.exec(s);
  const no = m ? Number(m[1]) : null;
  let phase = null;
  if (/초기형?/.test(s)) phase = '초기';
  else if (/전기형?/.test(s)) phase = '전기';
  else if (/중기형?/.test(s)) phase = '중기';
  else if (/후기형?/.test(s)) phase = '후기';
  let facelift = null;
  if (/F\/L|f\/l|페리|페이스리프트|마이너체인지/.test(s0)) {
    const c = /(\d)차/.exec(s);
    facelift = c ? Number(c[1]) : 1;
  }
  if (no === null && !phase && facelift === null) return null;
  return { no, phase, facelift };
}

/**
 * 제조사 → 표준 국문.
 *   `렉서스 (Lexus)`                  → `렉서스`
 *   `르노 코리아 (Renault)`            → `르노코리아`
 *   `야마하 모터 (YAMAHA)  -  일본`    → `야마하모터`   (오토바이표는 국가를 뒤에 붙인다)
 *   `BMW (모토라드) -  독일`           → `BMW`
 */
export function normBrand(raw) {
  let s = String(raw ?? '').replace(/[(（][^)）]*[)）]/g, ' ');
  s = s.split(/[-–—]/)[0];            // ' - 일본' 같은 국가 꼬리 제거
  return s.replace(/\s+/g, '').trim();
}

// ── 본체 ──────────────────────────────────────────────────

const REQUIRED_COL = '상품번호 (코드표)';

/** 한 탭을 CSV 로 받아온다. gid 로 먼저, 헤더가 안 맞으면 탭 이름으로 한 번 더. */
async function fetchTab(table) {
  const byGid = `https://docs.google.com/spreadsheets/d/${table.sheetId}/export?format=csv&gid=${table.gid}`;
  const byName = table.tab
    ? `https://docs.google.com/spreadsheets/d/${table.sheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(table.tab)}`
    : null;

  for (const [url, how] of [[byGid, `gid=${table.gid}`], [byName, `탭 이름 "${table.tab}"`]]) {
    if (!url) continue;
    let res;
    try {
      res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(60000) });
    } catch (e) {
      console.log(`  ${how} — 연결 실패 (${e.name === 'TimeoutError' ? '시간 초과' : e.message})`);
      continue;
    }
    if (!res.ok) { console.log(`  ${how} — 응답 ${res.status}`); continue; }
    const csv = await res.text();
    if (/^\s*<(!doctype|html)/i.test(csv)) {
      const err = new Error('공유 설정');
      err.sharing = true;
      throw err;
    }
    const rows = parseCSV(csv);
    const header = rows[0] || [];
    const hasCol = header.some(h => String(h).replace(/\s+/g, '') === REQUIRED_COL.replace(/\s+/g, ''));
    if (hasCol) { console.log(`  ${how} — OK (${rows.length - 1}행 / ${header.length}열)`); return rows; }
    console.log(`  ${how} — "${REQUIRED_COL}" 열이 없음. 실제 헤더: ${header.slice(0, 6).join(' | ')}…`);
  }
  return null;
}

function toEntries(rows, tableName) {
  const header = rows[0];
  const col = (...names) => {
    for (const nm of names) {
      const i = header.findIndex(h => String(h).replace(/\s+/g, '') === nm.replace(/\s+/g, ''));
      if (i >= 0) return i;
    }
    return -1;
  };
  const iPart = col('상품번호 (코드표)');
  const iBrand = col('제조사');
  const iModel = col('모델명 (코드표)');
  // 자동차표는 '모델명 (영문)', 오토바이표는 '표시이름' 을 쓴다
  const iAlt = col('모델명 (영문)', '표시이름');
  const iGen = col('세대 (코드표)');
  const iYear = col('연식 (코드표)');
  // v8 Apps Script 가 쓰던 보조 열 — 코드표 칸이 비면 이미지표 칸의 값을 쓴다.
  const iGen2 = col('세대 (이미지표)');
  const iYear2 = col('연식 (이미지표)');
  const iChassis = col('차량코드');
  const iBsa = col('BSA 여부');

  const entries = [], except = [];
  let n = 1;
  for (const r of rows.slice(1)) {
    n++;
    if (!r.some(c => String(c).trim() !== '')) continue;
    const partRaw = r[iPart] ?? '';
    // 'O' 는 '이미지표에 있음' 표시일 뿐 값이 아니다 — 보조 열로 쓸 때는 걸러낸다.
    const spare = v => { const t = String(v ?? '').trim(); return (!t || t === 'O' || t === 'o') ? '' : t; };
    const yearRaw = String(r[iYear] ?? '').trim() || (iYear2 >= 0 ? spare(r[iYear2]) : '');
    const genRaw  = String(r[iGen] ?? '').trim()  || (iGen2 >= 0 ? spare(r[iGen2]) : '');
    const part = parsePartNo(partRaw);
    const partKeys = parsePartNos(partRaw);
    const years = parseYears(yearRaw);
    const gen = parseGen(genRaw);

    entries.push({
      table: tableName,
      row: n,
      partRaw: String(partRaw).trim(),
      partKey: part?.key ?? partKeys[0] ?? null,
      // 같은 행을 가리키는 번호 전부(현행 + 구 번호). partKey 는 그중 첫 번호다.
      partKeys,
      partPrefix: part?.prefix ?? null,
      brand: normBrand(r[iBrand]),
      brandRaw: String(r[iBrand] ?? '').replace(/\s+/g, ' ').trim(),
      model: String(r[iModel] ?? '').replace(/\s+/g, ' ').trim(),
      modelAlt: iAlt >= 0 ? String(r[iAlt] ?? '').replace(/\s+/g, ' ').trim() : '',
      genNo: gen?.no ?? null,
      genPhase: gen?.phase ?? null,
      genFacelift: gen?.facelift ?? null,
      genRaw: String(genRaw).replace(/\s+/g, ' ').trim(),
      ymStart: years?.start ?? null,
      ymEnd: years?.end ?? null,
      ymRaw: String(yearRaw).replace(/\s+/g, ' ').trim(),
      chassis: iChassis >= 0 ? String(r[iChassis] ?? '').trim() : '',
      bsa: iBsa >= 0 ? String(r[iBsa] ?? '').trim() : '',
    });

    const why = [];
    if (!part && !partKeys.length) {
      const t = String(partRaw).trim();
      why.push(!t || t === '-' ? '부품번호 미부여' : '부품번호 형식');
    }
    if (!years) why.push(String(yearRaw).trim() ? '연식 형식' : '연식 없음');
    if (why.length) {
      const e = entries[entries.length - 1];
      except.push([tableName, n, e.partRaw, e.brandRaw, e.model, e.genRaw, e.ymRaw, why.join(' / ')]);
    }
  }
  return { entries, except };
}

async function main() {
  const cfg = loadConfig();
  const all = [];
  const allExcept = [];

  for (const table of cfg.codeTables) {
    console.log(`\n■ ${table.name} 코드표 — ${table.sheetId}`);
    let rows;
    try {
      rows = await fetchTab(table);
    } catch (e) {
      if (e.sharing) {
        console.error(`  ✖ 시트에 접근할 수 없습니다 (로그인 페이지가 돌아왔습니다).`);
        console.error(`    공유를 "링크가 있는 모든 사용자 - 뷰어" 로 바꿔야 합니다.`);
        console.error(`    소유자가 다른 계정이면 소유자에게 요청해야 합니다.`);
        process.exitCode = 1;
        continue;
      }
      throw e;
    }
    if (!rows) {
      console.error(`  ✖ ${table.name} 코드표를 읽지 못했습니다. config.json 의 gid / tab 을 확인해주세요.`);
      process.exitCode = 1;
      continue;
    }
    const { entries, except } = toEntries(rows, table.name);
    all.push(...entries);
    allExcept.push(...except);

    const okPart = entries.filter(e => e.partKey).length;
    const okYear = entries.filter(e => e.ymStart !== null).length;
    const okGen = entries.filter(e => e.genNo !== null).length;
    const bothOk = entries.filter(e => e.partKey && e.ymStart !== null).length;
    console.log(`  행 ${entries.length}`);
    console.log(`    부품번호 ${okPart}  연식 ${okYear}  세대 ${okGen}`);
    console.log(`    대조 가능(부품번호+연식) ${bothOk} / ${entries.length}  (${(bothOk / entries.length * 100).toFixed(1)}%)`);
    breakdown(`${table.name} — 접두문자별`, e => e.partPrefix === null ? '(파싱실패)' : (e.partPrefix || '(무접두)'), entries);
  }

  if (!all.length) { console.error('\n✖ 읽어온 행이 없습니다.'); process.exit(1); }

  // 접두문자가 표를 가리키는지 교차 확인 — B 는 오토바이, 나머지는 자동차여야 한다
  const wrong = all.filter(e =>
    e.partPrefix !== null &&
    ((e.partPrefix === MOTO_PREFIX) !== (e.table === '오토바이'))
  );
  console.log(`\n접두문자 ↔ 코드표 교차 확인 — 어긋난 행 ${wrong.length}`);
  for (const e of wrong.slice(0, 10)) {
    console.log(`   ${e.table} ${e.row}행  ${e.partRaw}  ${e.brand} ${e.model}`);
  }

  // 키 유일성 — v2 가 성립하는지의 핵심 검증
  const keyCount = new Map();
  for (const e of all) {
    if (!e.partKey || e.ymStart === null) continue;
    const k = [e.table, e.brand, e.model.replace(/\s+/g, ''), e.ymStart, e.ymEnd].join('|');
    keyCount.set(k, (keyCount.get(k) || 0) + 1);
  }
  const dupKeys = [...keyCount].filter(([, v]) => v > 1);
  console.log(`\n제조사+모델명+연식 조합 ${keyCount.size}종 — 중복 ${dupKeys.length}종`);
  if (dupKeys.length) {
    console.log('  ⚠ 중복이 남으면 모델명을 넣어도 행이 특정되지 않는다. 상위 5종:');
    for (const [k, v] of dupKeys.slice(0, 5)) console.log(`     ${v}회  ${k}`);
  }

  // ── 저장 ──
  fs.writeFileSync(
    path.join(OUT_DIR, 'codetable.json'),
    JSON.stringify({
      loadedAt: new Date().toISOString(),
      tables: cfg.codeTables.map(t => ({ name: t.name, sheetId: t.sheetId, gid: t.gid, tab: t.tab })),
      count: all.length,
      entries: all,
    }),
    'utf8'
  );
  console.log(`\n  저장: ${path.relative(ROOT, path.join(OUT_DIR, 'codetable.json'))}  (${all.length}행)`);

  writeCsv(
    path.join(OUT_DIR, 'codetable_norm.csv'),
    ['코드표', '행', '부품번호', '부품키', '제조사', '제조사원문', '모델명', '보조명', '세대no', '시기', '페리', '연식시작', '연식종료', '연식원문', '차량코드', 'BSA'],
    all.map(e => [
      e.table, e.row, e.partRaw, e.partKey ?? '', e.brand, e.brandRaw, e.model, e.modelAlt,
      e.genNo ?? '', e.genPhase ?? '', e.genFacelift ?? '',
      e.ymStart ?? '', e.ymEnd ?? '', e.ymRaw, e.chassis, e.bsa,
    ])
  );
  writeCsv(
    path.join(OUT_DIR, 'codetable_except.csv'),
    ['코드표', '행', '부품번호', '제조사', '모델명', '세대', '연식', '사유'],
    allExcept
  );

  console.log('\n끝.');
}

// 이 파일은 다른 스크립트가 정규화 함수를 가져다 쓰기도 한다(verimap_match.mjs).
// 직접 실행했을 때만 main 을 돌린다 — import 만으로 시트를 받아오면 안 된다.
const directRun = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (directRun) main().catch(e => { console.error('\n✖ 실패:', e.message); process.exit(1); });
