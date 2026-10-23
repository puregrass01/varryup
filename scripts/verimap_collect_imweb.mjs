/**
 * 베리맵 — 아임웹(본사몰 · 해외본사몰 · B2B몰) 등록상품 수집
 *
 * 아임웹 Open API(OAuth). 설정은 암호화되어 있지 않고 OAuth 승인도 자동이라
 * 일반 node 로 돌아간다 — Electron 이 필요 없다.
 *
 * 구조 (main_process.js 에서 확인):
 *   본사몰  사이트 S20260120dfa7cee190bbb — 한 사이트 안에 KR · US · JP 구역(unitCode)
 *           → '해외본사몰' 은 별개 사이트가 아니라 이 사이트의 US · JP 구역이다
 *   B2B몰   사이트 S202101070709acd6138de (같은 앱이 두 사이트에 연동돼 있다)
 *
 * 실행
 *   node scripts/verimap_collect_imweb.mjs --probe      구역 목록 + 3건만 (구조 확인)
 *   node scripts/verimap_collect_imweb.mjs              본사몰 전 구역
 *   node scripts/verimap_collect_imweb.mjs --site=b2b   B2B몰
 *
 * 결과  data/verimap/imweb_list.csv        구역별 상품
 *       data/verimap/imweb_sample.json     구조 확인용 원본
 *       data/verimap/imweb_raw.json        원본
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createImwebSession, createImwebClient } from '../src/platforms/openapi/imweb_client.js';
import { createImwebLock } from '../src/utils/imweb_lock.js';
import { oauthCredentialsFromConfig, looksLikeOAuthClientId } from '../src/platforms/openapi/imweb_oauth.js';
import { serverLogin, fetchCredentials } from '../src/utils/server_keys.js';
import { writeJsonAtomic } from '../src/utils/json_file.js';
import { readCsv } from './verimap_csv.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'data', 'verimap');

// main_process.js 의 상수와 같은 값이어야 한다.
const SITES = {
  본사몰: { code: 'S20260120dfa7cee190bbb', redirect: 'https://optic-glass.co.kr/' },
  b2b:    { code: 'S202101070709acd6138de', redirect: 'https://optic-glass.co.kr/' },
};

const argVal = n => {
  const h = process.argv.find(a => a.startsWith(`--${n}=`));
  return h ? h.slice(n.length + 3).trim() : '';
};
const PROBE = process.argv.includes('--probe');
// 옵션 조회 — B2B·본사몰은 연식·세대가 상품명이 아니라 옵션에 들어 있다.
// 전량은 비싸므로 기본은 '대조에서 후보다중으로 걸린 상품' 만 받는다(--options-all 로 전량).
const OPTIONS = process.argv.includes('--options') || process.argv.includes('--options-all');
// 저장된 옵션 원본만 다시 해석한다 — 추출 규칙을 고칠 때 재수집이 필요 없다.
const REPARSE = process.argv.includes('--reparse');
// 옵션 캐시 — 상품번호+수정일이 열쇠다. 수정일이 바뀌면 자동으로 다시 받는다.
const FRESH_OPTIONS = process.argv.includes('--fresh-options') || process.argv.includes('--fresh');
const cacheKey = (unit, p) => `${unit}|${p.prodNo ?? p.no ?? ''}|${p.editTime ?? p.addTime ?? ''}`;
let OPT_CACHE = new Map();
const OPTIONS_ALL = process.argv.includes('--options-all');
const LIMIT = Number(argVal('limit') || 0) || 0;   // 구조 확인용 소량 조회
const SITE  = argVal('site') || '본사몰';
const ONLY_UNIT = argVal('unit');
const ADMIN_SERVER_URL =
  (process.env.ADMIN_SERVER_URL || 'https://admin.veryup-domain.duckdns.org').replace(/\/+$/, '');

// 옵션 축 이름이 몰마다 다르다 — B2B 는 `구성`, 본사몰은 `구성 선택` 이다.
// 정확히 같은 이름만 찾으면 본사몰의 운전석·조수석·1set 이 통째로 비어 버린다.
function pickAxis(axis, words) {
  for (const w of words) if (axis[w] != null && axis[w] !== '') return axis[w];
  for (const [k, v] of Object.entries(axis)) {
    const n = String(k).replace(/\s+/g, '');
    if (v && words.some(w => n.includes(w))) return v;
  }
  return '';
}

// 옵션 한 건 → CSV 한 행. 확인된 구조(2026-10-21 실응답):
//   optionDetailInfoList: [{ name: '차종'|'연식'|'구성 선택', optionValue: { optionValueName } }, …]
// 축 이름이 상품마다 달라서 '이름=값' 쌍을 그대로 남기고, 차종·연식·구성은 따로도 뽑는다.
function optionRow(unitCode, prodNo, prodName, o) {
  const infos = o.optionDetailInfoList || o.optionValues || [];
  const pairs = [];
  const axis = {};
  for (const it of infos) {
    const k = String(it?.name ?? '').trim();
    const v = String(it?.optionValue?.optionValueName ?? it?.optionValueName ?? it?.value ?? '').trim();
    if (!k && !v) continue;
    pairs.push(`${k}=${v}`);
    if (k) axis[k] = v;
  }
  return [
    SITE, unitCode, prodNo, prodName,
    o.optionDetailCode ?? o.code ?? '',
    pairs.join(' / '),
    pickAxis(axis, ['차종', '차량명', '모델명', '차량', '모델']),
    pickAxis(axis, ['연식', '년식', '연도']),
    pickAxis(axis, ['구성', '운전석', '조수석', '선택', '세트']),
    o.stock ?? o.stockQuantity ?? '', o.price ?? '',
    o.stockSku ?? o.stock_sku ?? o.sku ?? '',
    o.status ?? o.isView ?? o.isDisplay ?? '',
  ];
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

function ask(question, hidden = false) {
  return new Promise(resolve => {
    process.stdout.write(question);
    const stdin = process.stdin;
    stdin.resume(); stdin.setEncoding('utf8');
    let buf = '';
    const wasRaw = Boolean(stdin.isRaw);
    if (hidden && stdin.isTTY) stdin.setRawMode(true);
    const finish = () => {
      if (hidden && stdin.isTTY) stdin.setRawMode(wasRaw);
      stdin.pause(); stdin.off('data', onData);
      if (hidden) process.stdout.write('\n');
      resolve(buf.trim());
    };
    const onData = chunk => {
      if (!hidden) { buf = String(chunk); return finish(); }
      for (const ch of String(chunk)) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') return finish();
        if (ch === '\u0003') { process.stdout.write('\n'); process.exit(130); }
        if (ch === '\u007f' || ch === '\b') { buf = buf.slice(0, -1); continue; }
        buf += ch; process.stdout.write('*');
      }
    };
    stdin.on('data', onData);
  });
}

/**
 * 아임웹 OAuth 키는 관리자 서버가 내려준다(main_process 의 SYNC_PLATFORMS 에 'imweb' 이 있다).
 * 베리업으로 한 번 로그인한 PC 에는 설정 파일에 들어 있지만, 없으면 여기서 직접 받아온다.
 * 받은 키는 파일에 쓰지 않고 이 실행 동안 메모리에만 둔다.
 */
async function credentialsFromServer() {
  const user = process.env.VERYUP_USER || await ask('직원 계정 아이디: ');
  const pw   = process.env.VERYUP_PW   || await ask('비밀번호: ', true);
  if (!user || !pw) throw new Error('아이디·비밀번호가 필요합니다.');
  const auth = await serverLogin(ADMIN_SERVER_URL, user, pw);
  console.log(`로그인 성공: ${auth.name || user}`);
  const creds = await fetchCredentials(ADMIN_SERVER_URL, auth.token, 'imweb');
  for (const c of creds || []) {
    const got = oauthCredentialsFromConfig(c.data || {});
    if (got?.clientId && got?.clientSecret) {
      console.log('아임웹 OAuth 키를 서버에서 받았습니다.');
      return got;
    }
  }
  return null;
}

/**
 * 직접 입력. 값은 아임웹 개발자센터 > 앱 관리에 있다(clientId 는 UUID 모양).
 * 원하면 설정 파일에 저장해 다음부터 안 묻게 한다 — 저장하면 베리업도 같은 키를 쓴다.
 */
async function credentialsByHand() {
  console.log('\n아임웹 개발자센터 > 앱 관리 에서 OAuth 값을 확인해 입력해주세요.');
  console.log('  모양: 8-4-4-4-12 자 (예: 153aa77a-d13f-40b1-ae85-00dffc5ae76a)');
  const given = Boolean(argVal('client-id') || process.env.IMWEB_CLIENT_ID);

  let clientId = '', clientSecret = '';
  for (let tries = 1; ; tries++) {
    clientId = (argVal('client-id') || process.env.IMWEB_CLIENT_ID || await ask('\n  Client ID: ')).trim();
    // Secret 도 UUID 라 가려서 받으면 오타를 확인할 수 없다. 모양 검사로 대신한다.
    clientSecret = (argVal('client-secret') || process.env.IMWEB_CLIENT_SECRET || await ask('  Client Secret: ', true)).trim();
    if (!clientId || !clientSecret) throw new Error('Client ID / Secret 이 필요합니다.');

    const bad = [];
    if (!looksLikeOAuthClientId(clientId)) bad.push(`Client ID 가 UUID 모양이 아닙니다 (${clientId.length}자)`);
    if (!looksLikeOAuthClientId(clientSecret)) bad.push(`Client Secret 이 UUID 모양이 아닙니다 (${clientSecret.length}자)`);

    // 입력한 값을 확인할 수 있게 보여 준다 — Secret 은 앞 8자와 끝 4자만.
    console.log(`\n  Client ID     : ${clientId}`);
    console.log(`  Client Secret : ${clientSecret.slice(0, 8)}…${clientSecret.slice(-4)}  (${clientSecret.length}자)`);
    for (const b of bad) console.log(`  ⚠ ${b}`);

    if (given || !process.stdin.isTTY) break;
    const ok = (await ask('  이대로 진행할까요? (Y/다시입력=n): ')).toLowerCase();
    if (ok !== 'n') break;
    if (tries >= 5) throw new Error('입력을 5번 다시 받았습니다 — 중단합니다.');
  }
  // 환경변수·인자로 받았고 저장을 명시하지 않았으면 묻지 않는다(TTY 가 없는 환경에서 멈추지 않게).
  const save = process.argv.includes('--save-keys') ? 'y'
    : (!process.stdin.isTTY) ? 'n'
    : (Boolean(argVal('client-id') || process.env.IMWEB_CLIENT_ID) && !process.argv.includes('--ask')) ? 'n'
    : (await ask('  이 키를 설정 파일에 저장할까요? (y/N): ')).toLowerCase();
  if (save === 'y') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    const target = path.join(appData, 'very-up-ver2', 'imweb_openapi_config.json');
    let cur = {};
    try { if (fs.existsSync(target)) cur = JSON.parse(fs.readFileSync(target, 'utf8')) || {}; } catch {}
    // 앱과 같은 설정 파일이다 — 쓰다 꺼져서 잘리면 앱의 아임웹 키까지 날아간다
    writeJsonAtomic(target, { ...cur, clientId, clientSecret }, 2);
    console.log(`  저장했습니다: ${target}`);
  }
  return { clientId, clientSecret, from: 'clientId' };
}

function findConfigPath() {
  if (process.env.IMWEB_OPENAPI_CONFIG) return process.env.IMWEB_OPENAPI_CONFIG;
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const cands = [
    path.join(appData, 'very-up-ver2', 'imweb_openapi_config.json'),
    path.join(appData, 'VERY UP VER3', 'imweb_openapi_config.json'),
    path.join(ROOT, 'data', 'imweb_openapi_config.json'),
  ];
  for (const p of cands) {
    if (!fs.existsSync(p)) continue;
    try {
      const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
      const { clientId, clientSecret } = oauthCredentialsFromConfig(cfg) || {};
      if (clientId && clientSecret) return p;
      console.log(`  (건너뜀 — OAuth 키 없음) ${p}`);
    } catch { /* 다음 후보 */ }
  }
  console.log('  설정 파일에 OAuth 키가 없습니다 — 관리자 서버에서 받아옵니다.');
  return null;
}

/**
 * 진단 — 아임웹 관련 설정 파일에 어떤 칸이 있는지만 본다.
 * 값은 찍지 않는다(길이와 모양만). 키가 어디에 어떤 이름으로 있는지 찾는 용도다.
 */
function diagnose() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const dirs = [path.join(appData, 'very-up-ver2'), path.join(appData, 'VERY UP VER3'), path.join(ROOT, 'data')];
  const shape = v => {
    const t = String(v ?? '');
    if (!t.trim()) return '(빈값)';
    const uuid = looksLikeOAuthClientId(t) ? ' UUID모양' : '';
    return `${t.length}자${uuid}`;
  };
  console.log('아임웹 관련 설정 파일 — 칸 이름과 길이만 (값은 찍지 않음)\n');
  let found = 0;
  for (const d of dirs) {
    if (!fs.existsSync(d)) { console.log(`  [없음] ${d}`); continue; }
    const files = fs.readdirSync(d).filter(f => /imweb/i.test(f) && f.endsWith('.json'));
    console.log(`  ${d}`);
    if (!files.length) { console.log('     imweb 관련 json 없음'); continue; }
    for (const f of files) {
      const fp = path.join(d, f);
      let cfg;
      try { cfg = JSON.parse(fs.readFileSync(fp, 'utf8')); }
      catch (e) { console.log(`     ${f} — 읽기 실패 (${e.message})`); continue; }
      found++;
      const keys = Object.keys(cfg || {});
      console.log(`     ${f}  (${keys.length}칸)`);
      for (const k of keys) {
        const v = cfg[k];
        const desc = (v && typeof v === 'object') ? `{${Object.keys(v).join(', ')}}` : shape(v);
        console.log(`        ${k} = ${desc}`);
      }
      const got = oauthCredentialsFromConfig(cfg);
      console.log(`        → OAuth 인식: ${got ? `됨 (${got.from} 칸에서)` : '안 됨'}`);
    }
  }
  if (!found) console.log('\n  imweb 설정 파일을 하나도 찾지 못했습니다.');
  console.log('\n베리업의 아임웹 기능이 실제로 돌아간다면, 그 기능이 쓰는 칸이 위에 있어야 합니다.');
  console.log('OAuth 인식이 모두 "안 됨" 이면 구 v2 키(apiKey/apiSecret)나 화면 자동화로 돌고 있을 수 있습니다.');
}

/**
 * 게시판 탐색 — 미국몰·일본몰은 상품이 아니라 게시물로 운영된다.
 * Open API 에 게시판·게시물 조회 경로가 있는지, 지금 scope 로 닿는지 확인한다.
 * 404 = 경로 없음 / 401·403 = 경로는 있으나 권한 없음 / 200 = 쓸 수 있음.
 */
async function probeBoards(client) {
  const paths = [
    '/boards', '/board', '/site-boards', '/contents/boards',
    '/posts', '/board-posts', '/contents/posts',
    '/boards/categories', '/site-info',
  ];
  console.log('\n게시판 관련 경로 탐색 — 404=없음 / 401·403=권한없음 / 200=사용가능\n');
  for (const pth of paths) {
    try {
      const res = await client.request('GET', pth);
      const n = Array.isArray(res?.data) ? res.data.length
        : Array.isArray(res?.data?.list) ? res.data.list.length : null;
      console.log(`  200  ${pth}${n !== null ? `   (${n}건)` : ''}`);
      if (n) console.log(`       필드: ${Object.keys((res.data.list || res.data)[0] || {}).join(', ').slice(0, 160)}`);
    } catch (e) {
      const code = e.status || e.errorCode || '?';
      console.log(`  ${String(code).padStart(3)}  ${pth}   ${String(e.message).slice(0, 70)}`);
    }
  }
  console.log('\n현재 OAuth scope: ' + (client.scope ? '(확인 불가)' : 'site-info / member-info / product / order'));
  console.log('게시판 권한이 따로 필요하면 아임웹 개발자센터 > 앱 > API 설정에서 켜야 합니다.');
}

async function main() {
  if (REPARSE) {
    const suffix = SITE === 'b2b' ? '_b2b' : '';
    const f = path.join(OUT_DIR, `imweb_options_raw${suffix}.json`);
    if (!fs.existsSync(f)) { console.error(`✖ 저장된 옵션 원본이 없습니다: ${path.basename(f)}`); process.exit(1); }
    const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
    const rows = [];
    for (const r of raw) for (const o of (r.options || [])) rows.push(optionRow(r.unitCode, r.prodNo, r.name ?? '', o));
    writeCsv(path.join(OUT_DIR, `imweb_options${suffix}.csv`),
      ['사이트', '구역', '상품번호', '상품명', '옵션코드', '옵션값전체',
       '차종', '연식', '구성', '재고', '가격', 'SKU', '상태'], rows);
    const filled = rows.filter(r => String(r[8]).trim()).length;
    console.log(`  상품 ${raw.length}건 / 옵션 ${rows.length}행 — 구성 칸이 채워진 행 ${filled}`);
    return 0;
  }

  if (process.argv.includes('--diag')) { diagnose(); return; }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const site = SITES[SITE];
  if (!site) { console.error(`✖ 사이트 이름이 잘못됐습니다: ${SITE} (가능: ${Object.keys(SITES).join(', ')})`); process.exit(1); }

  // 키를 어디서 쓸지 — 명령줄·환경변수·--ask 가 저장된 파일보다 먼저다.
  // (잘못 저장된 값이 있어도 새 값으로 덮어쓸 수 있어야 한다.)
  const ASK = process.argv.includes('--ask');
  const GIVEN = Boolean(argVal('client-id') || process.env.IMWEB_CLIENT_ID);
  let cfg = {};
  let cfgPath = null;
  let fromServer = null;

  if (GIVEN || ASK) {
    const p0 = findConfigPath();
    if (p0) { try { cfg = JSON.parse(fs.readFileSync(p0, 'utf8')) || {}; } catch { cfg = {}; } }
    fromServer = await credentialsByHand();
  } else {
    cfgPath = findConfigPath();
    if (cfgPath) {
      process.env.IMWEB_OPENAPI_CONFIG = cfgPath;
      console.log(`설정: ${cfgPath}`);
      try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) || {}; } catch { cfg = {}; }
    } else if (process.argv.includes('--no-server')) {
      // 서버에 아임웹 키가 없다는 게 확인됐으면 직원 로그인 단계를 건너뛴다.
      fromServer = await credentialsByHand();
    } else {
      try { fromServer = await credentialsFromServer(); }
      catch (e) { console.log(`  서버에서 받지 못했습니다 (${e.message})`); }
      if (!fromServer) {
        console.log('  서버에 아임웹 OAuth 키가 등록돼 있지 않습니다.');
        fromServer = await credentialsByHand();
      }
    }
  }
  // 설정 파일에 siteCode · redirectUri 가 있으면 그 값이 이긴다(main_process 와 같은 규칙).
  // 그 값이 낡아 있으면 10004 · 30123 · 30132 가 난다 — 그래서 실제로 쓰는 값을 찍는다.
  const siteCode = argVal('site-code') || cfg.siteCode || site.code;
  const redirectUri = argVal('redirect') || cfg.redirectUri || site.redirect;
  console.log(`사이트 이름 : ${SITE}`);
  console.log(`siteCode    : ${siteCode}${siteCode !== site.code ? `   ⚠ 코드 기본값(${site.code}) 과 다릅니다 — 설정 파일 값을 쓰는 중` : ''}`);
  console.log(`redirectUri : ${redirectUri}${redirectUri !== site.redirect ? `   ⚠ 기본값(${site.redirect}) 과 다릅니다` : ''}`);
  const creds = fromServer || oauthCredentialsFromConfig(cfg);
  console.log(`clientId    : ${creds?.clientId || '(없음)'}  (${creds?.from || '?'} 칸)`);
  console.log('');

  // 토큰 관련 줄은 세기만 하고 흘리지 않는다 — 많이 나오면 화면을 덮어 다른 로그를 못 본다.
  // (30170 = 이 사이트가 refreshToken 을 안 받는다는 뜻. imweb_client.js 가 한 번 겪으면
  //  이후로는 갱신을 건너뛰고 바로 발급해서, 예전처럼 페이지마다 두 번씩 부르지 않는다.)
  let reissued = 0;
  const quietLog = msg => {
    const t = String(msg);
    if (/토큰 갱신 실패\(30170\)|토큰 발급|토큰 갱신/.test(t)) { reissued++; return; }
    console.log('  ' + t);
  };

  const readCfg = () => { try { return cfgPath ? (JSON.parse(fs.readFileSync(cfgPath, 'utf8')) || {}) : {}; } catch { return {}; } };
  // 베리업과 같은 앱으로 토큰을 받으므로, 둘이 겹치면 서로의 토큰을 무효화한다 → 베리업이 아임웹을 쓰는 중이면
  // 시작하지 않고, 도는 동안은 베리업이 기다리게 한다. 베리맵은 개발 PC 전용이라 userData 는 very-up-ver2 다.
  const lock = createImwebLock(path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'very-up-ver2', 'imweb_api.lock'));
  try { lock.acquire(); } catch (e) { console.error(`\n✖ ${e.message}`); process.exit(1); }
  process.on('exit', () => lock.release());
  const session = createImwebSession({
    credentials: () => fromServer || oauthCredentialsFromConfig(readCfg()),
    siteCode,
    redirectUri,
    need: ['product:write'],
    log: quietLog,
  });
  // ── 토큰 진단 ──
  // imweb_client.js 는 매 요청의 첫 시도가 401 이면 토큰을 버리고 다시 발급한다.
  // 그래서 요청 1건에 HTTP 4번이 나간다. 원인을 보려면 실제 응답을 봐야 하는데,
  // createImwebClient 가 fetchImpl 을 받으므로 베리업 파일을 고치지 않고 끼울 수 있다.
  const TRACE = process.argv.includes('--trace');
  const stats = { calls: 0, by: new Map() };
  const tracedFetch = async (url, init) => {
    const res = await fetch(url, init);
    stats.calls++;
    const short = String(url).replace('https://openapi.imweb.me', '');
    const code = res.status;
    const k = `${code} ${short.split('?')[0]}`;
    stats.by.set(k, (stats.by.get(k) || 0) + 1);
    if (TRACE && code >= 400) {
      const clone = res.clone();
      let body = '';
      try { body = (await clone.text()).slice(0, 220); } catch {}
      const tok = String(init?.headers?.Authorization || '').slice(7, 27);
      console.log(`  [추적] ${code} ${short.split('?')[0]}  토큰앞:${tok}…  ${body.replace(/\s+/g, ' ')}`);
      console.log(`         ratelimit-remaining=${res.headers.get('x-ratelimit-remaining')}`);
    }
    return res;
  };

  const client = createImwebClient(session, { log: quietLog, fetchImpl: tracedFetch });

  if (process.argv.includes('--boards')) { await probeBoards(client); return 0; }

  // 사이트 정보(구역) 먼저 — 쇼핑 카테고리 조회에 unitCode 가 필요하다.
  console.log('사이트 정보 조회…');
  let info;
  try { info = await client.siteInfo(); }
  catch (e) { console.error(`\n✖ 사이트 정보 조회 실패: ${e.message}`); process.exit(1); }

  const units = (info?.unitList || []).map(u => ({ unitCode: u.unitCode, currency: String(u.currency || '').toUpperCase(), name: u.name || '' }));
  console.log(`구역 ${units.length}개:`);
  for (const u of units) console.log(`   ${u.unitCode}  ${u.currency}  ${u.name}`);
  if (!units.length) { console.error('✖ 구역(unitList)이 없습니다.'); process.exit(1); }

  // 쇼핑 카테고리로 거르기 — 본사몰은 '내차찾기 ver2' 카테고리만 광각미러다.
  // 코드 대신 이름 일부로도 지정할 수 있다: --cat=내차찾기
  const F_CAT = argVal('cat') || argVal('category');

  // 쇼핑 카테고리 목록 — 상품의 categories 코드가 어떤 이름인지 알아야 거를 수 있다.
  // unitCode 가 필수다 (없으면 10003 "unitCode must be a string").
  const CAT_UNIT = ONLY_UNIT || (units.find(u => u.currency === 'KRW') || units[0]).unitCode;
  let cats = [];
  try {
    const res = await client.request('GET', '/products/shop-categories', { query: { unitCode: CAT_UNIT } });
    if (process.argv.includes('--cats')) {
      fs.writeFileSync(path.join(OUT_DIR, `imweb_categories_raw${SITE === 'b2b' ? '_b2b' : ''}.json`),
        JSON.stringify(res, null, 2), 'utf8');
    }
    const list = res?.data?.list || res?.data || [];
    const walk = (nodes, depth, parent) => {
      for (const n of (nodes || [])) {
        const code = n.categoryCode ?? n.code ?? n.categoryId ?? '';
        const name = n.name ?? n.categoryName ?? '';
        const full = parent ? `${parent} > ${name}` : name;
        cats.push({ code, name, depth, path: full });
        walk(n.children || n.subCategories || n.childList, depth + 1, full);
      }
    };
    walk(list, 0, '');
  } catch (e) { console.log(`  (쇼핑 카테고리 조회 실패: ${e.message})`); }

  if (process.argv.includes('--cats')) {
    console.log(`\n쇼핑 카테고리 ${cats.length}개  (구역 ${CAT_UNIT})`);
    for (const c of cats) console.log(`  ${c.code}  ${'  '.repeat(c.depth)}${c.name}`);
    writeCsv(path.join(OUT_DIR, `imweb_categories${SITE === 'b2b' ? '_b2b' : ''}.csv`),
      ['코드', '깊이', '이름', '전체경로'], cats.map(c => [c.code, c.depth, c.name, c.path]));
    return 0;
  }

  // --cat 으로 준 값(이름 일부 또는 코드)을 카테고리 코드 묶음으로 바꾼다.
  // 상품은 상위가 아니라 브랜드 하위 카테고리에 들어 있으므로 하위 전체를 포함한다.
  let catCodes = null;
  if (F_CAT) {
    const norm = s => String(s || '').replace(/\s+/g, '').toLowerCase();
    const key = norm(F_CAT);
    const hits = cats.filter(c => c.code === F_CAT || norm(c.name).includes(key));
    if (!hits.length) {
      console.error(`\n✖ 카테고리 "${F_CAT}" 를 본사몰 쇼핑 카테고리 ${cats.length}개에서 찾지 못했습니다.`);
      console.error('  17번(쇼핑 카테고리 목록)으로 현재 이름·코드를 확인하세요.');
      process.exit(1);
    }
    catCodes = new Set();
    for (const h of hits) {
      catCodes.add(h.code);
      for (const c of cats) if (c.path.startsWith(h.path + ' > ')) catCodes.add(c.code);
    }
    console.log(`\n카테고리로 거릅니다 — ${F_CAT}`);
    for (const h of hits) console.log(`   ${h.code}  ${h.path}`);
    console.log(`   하위 포함 ${catCodes.size}개 카테고리`);
  }

  // 미국·일본몰은 상품 페이지가 아니라 게시물로 운영된다. 아임웹은 같은 상품을 모든 구역에
  // 복제해 들고 있어서 /products 를 구역마다 받으면 같은 1,644개를 세 번 받게 된다 — 낭비이고
  // 그 숫자는 실제 해외몰 노출과도 무관하다. 그래서 기본은 KRW 구역 하나만 받는다.
  const ALL_UNITS = process.argv.includes('--all-units');
  let targets = ONLY_UNIT ? units.filter(u => u.unitCode === ONLY_UNIT) : units;
  if (!ONLY_UNIT && !ALL_UNITS && units.length > 1) {
    const krw = units.filter(u => u.currency === 'KRW');
    if (krw.length) {
      targets = krw;
      const skipped = units.filter(u => u.currency !== 'KRW').map(u => `${u.unitCode}(${u.currency})`);
      console.log(`\n기본값: KRW 구역만 받습니다. 건너뜀 — ${skipped.join(', ')}`);
      console.log('  (미국·일본몰은 게시물 구조라 /products 숫자가 의미 없습니다. --all-units 로 전부 받을 수 있습니다.)');
    }
  }
  const HEAD = ['사이트', '구역', '통화', '상품번호', '상품명', '자체상품코드', '판매상태', '가격', '재고', '옵션있음', '등록일', '수정일'];
  const all = [];
  const raw = { collectedAt: new Date().toISOString(), site: SITE, siteCode: site.code, units, byUnit: {} };

  for (const u of targets) {
    console.log(`\n■ 구역 ${u.unitCode} (${u.currency}) 상품 목록…`);
    let rows;
    try { rows = await client.products(u.unitCode); }
    catch (e) { console.error(`  ✖ 실패: ${e.message}`); continue; }
    console.log(`  상품 ${rows.length}개`);
    if (catCodes) {
      const before = rows.length;
      rows = rows.filter(p => (p.categories || []).some(c => catCodes.has(String(c))));
      console.log(`  카테고리 적용 — ${rows.length} / ${before}개`);
    }
    raw.byUnit[u.unitCode] = PROBE ? rows.slice(0, 3) : rows;

    // 응답 필드 이름이 문서로 확정되지 않아, 첫 건의 키를 그대로 보여 준다.
    if (rows.length) {
      console.log('  응답 필드: ' + Object.keys(rows[0]).join(', '));
      fs.writeFileSync(path.join(OUT_DIR, 'imweb_sample.json'), JSON.stringify(rows.slice(0, 3), null, 2), 'utf8');
    }

    const pick = (o, ...keys) => { for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k]; return ''; };
    for (const p of (PROBE ? rows.slice(0, 3) : rows)) {
      all.push([
        SITE, u.unitCode, u.currency,
        pick(p, 'prodNo', 'no', 'productNo'),
        pick(p, 'productName', 'name', 'title'),
        pick(p, 'customProdCode', 'custom_prod_code', 'prodCode', 'sku'),
        pick(p, 'prodStatus', 'status', 'saleStatus'),
        pick(p, 'price', 'salePrice'),
        pick(p, 'stock', 'stockQuantity'),
        pick(p, 'isExistOptions', 'is_exist_options'),
        pick(p, 'addTime', 'createdAt', 'add_time'),
        pick(p, 'editTime', 'updatedAt', 'edit_time'),
      ]);
    }
  }

  writeCsv(path.join(OUT_DIR, `imweb_list${SITE === 'b2b' ? '_b2b' : ''}.csv`), HEAD, all);

  // ── 옵션 조회 ──
  if (OPTIONS) {
    // 받아둔 옵션 캐시를 연다(열쇠: 구역|상품번호|수정일). --fresh-options 면 무시하고 전부 다시 받는다.
    if (!FRESH_OPTIONS) {
      const cf = path.join(OUT_DIR, `imweb_options_cache${SITE === 'b2b' ? '_b2b' : ''}.json`);
      if (fs.existsSync(cf)) {
        try { OPT_CACHE = new Map(Object.entries(JSON.parse(fs.readFileSync(cf, 'utf8')))); }
        catch (e) { console.log(`  (옵션 캐시를 읽지 못했습니다: ${e.message})`); }
      }
    }
    const suffix = SITE === 'b2b' ? '_b2b' : '';
    // 대조 결과에서 후보다중으로 걸린 상품번호만 추린다(파일이 있을 때).
    let want = null;
    if (!OPTIONS_ALL) {
      const mp = path.join(OUT_DIR, 'match_확인필요.csv');
      if (fs.existsSync(mp)) {
        // 상품명 · 옵션 칸에 쉼표가 들어 있어 split(',') 로는 열이 밀린다(10-23: 837개 중 81개를 놓쳤다).
        want = new Set(readCsv(mp)
          .filter(r => r['채널'] && (r['판정'] === '후보다중' || r['판정'] === '미해결'))
          .map(r => String(r['상품ID']).trim()));
        console.log(`\n대조에서 확인필요로 걸린 상품 ${want.size}개만 옵션을 받습니다 (--options-all 로 전량).`);
      }
    }

    const optRows = [];
    const optRaw = [];        // 원본을 남긴다 — 추출을 고칠 때 다시 받지 않아도 되게
    let sampled = false;
    for (const u of targets) {
      const rows = raw.byUnit[u.unitCode] || [];
      const list = rows.filter(p => {
        const no = String(p.prodNo ?? p.no ?? '');
        return !want || want.has(no);
      });
      const take = LIMIT ? list.slice(0, LIMIT) : list;
      if (!take.length) continue;
      // 옵션 조회는 상품 하나당 한 번이고 초당 2회 제한이라 453개면 5~6분이 걸린다.
      // 상품의 수정일(editTime)이 그대로면 옵션도 그대로이므로 받아둔 것을 다시 쓴다.
      const hit = [], miss = [];
      for (const p of take) (OPT_CACHE.get(cacheKey(u.unitCode, p)) ? hit : miss).push(p);
      if (hit.length) console.log(`  (수정일이 그대로인 ${hit.length}건은 받아둔 옵션을 씁니다 — --fresh-options 로 다시 받습니다)`);
      console.log(`\n■ 구역 ${u.unitCode} (${u.currency}) 옵션 조회 — ${miss.length}건 (약 ${Math.ceil(miss.length * 0.6)}초)`);
      for (const p of hit) {
        const no = String(p.prodNo ?? p.no ?? '');
        const opts = OPT_CACHE.get(cacheKey(u.unitCode, p)) || [];
        optRaw.push({ unitCode: u.unitCode, prodNo: no, name: p.name ?? '', options: opts });
        for (const o of opts) optRows.push(optionRow(u.unitCode, no, p.name ?? '', o));
      }
      let done = 0, failed = 0;
      for (const p of miss) {
        const no = String(p.prodNo ?? p.no ?? '');
        try {
          const opts = await client.optionDetails(no, u.unitCode);
          OPT_CACHE.set(cacheKey(u.unitCode, p), opts || []);
          optRaw.push({ unitCode: u.unitCode, prodNo: no, name: p.name ?? '', options: opts || [] });
          if (!sampled && opts?.length) {
            fs.writeFileSync(path.join(OUT_DIR, `imweb_options_sample${suffix}.json`),
              JSON.stringify({ prodNo: no, name: p.name, options: opts.slice(0, 6) }, null, 2), 'utf8');
            console.log('  옵션 응답 필드: ' + Object.keys(opts[0]).join(', '));
            sampled = true;
          }
          for (const o of (opts || [])) optRows.push(optionRow(u.unitCode, no, p.name ?? '', o));
        } catch (e) { failed++; if (failed <= 3) console.log(`  ⚠ ${no} 실패: ${e.message}`); }
        done++;
        if (done % 50 === 0) console.log(`  옵션 ${done}/${miss.length} (실패 ${failed})`);
      }
      console.log(`  옵션 완료 ${done}/${miss.length} (실패 ${failed}) · 받아둔 것 ${hit.length}건`);
    }
    writeCsv(path.join(OUT_DIR, `imweb_options${suffix}.csv`),
      ['사이트', '구역', '상품번호', '상품명', '옵션코드', '옵션값전체',
       '차종', '연식', '구성', '재고', '가격', 'SKU', '상태'],
      optRows);
    const axes = new Map();
    for (const r of optRows) for (const kv of String(r[5]).split(' / ')) {
      const k = kv.split('=')[0]; if (k) axes.set(k, (axes.get(k) || 0) + 1);
    }
    fs.writeFileSync(path.join(OUT_DIR, `imweb_options_raw${suffix}.json`), JSON.stringify(optRaw), 'utf8');
    try {
      fs.writeFileSync(path.join(OUT_DIR, `imweb_options_cache${suffix}.json`),
        JSON.stringify(Object.fromEntries(OPT_CACHE)), 'utf8');
    } catch (e) { console.log(`  (옵션 캐시 저장 실패: ${e.message})`); }
    console.log(`  저장: data/verimap/imweb_options_raw${suffix}.json  (원본 ${optRaw.length}건)`);
    console.log('  옵션 축 이름:');
    for (const [k, v] of [...axes].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`     ${String(v).padStart(6)}  ${k}`);
  }
  fs.writeFileSync(path.join(OUT_DIR, `imweb_raw${SITE === 'b2b' ? '_b2b' : ''}.json`), JSON.stringify(raw), 'utf8');
  console.log(`  저장: data/verimap/imweb_raw${SITE === 'b2b' ? '_b2b' : ''}.json`);
  if (PROBE) console.log('\n(구조 확인 모드 — 구역마다 3건만 담았습니다)');
  console.log(`\nHTTP 호출 ${stats.calls}회 — 응답별:`);
  for (const [k, v] of [...stats.by].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`   ${String(v).padStart(5)}  ${k}`);
  // 토큰은 한 번 받아 만료까지 돌려써야 정상이다. 횟수가 호출 페이지 수만큼 나오면
  // 요청마다 401 을 맞고 다시 받는다는 뜻이라, 그때만 알린다. (예전엔 횟수와 무관하게 경고했다)
  if (reissued > 2) {
    console.log(`\n⚠ 토큰을 ${reissued}회 받았습니다 — 한 번 받아 재사용해야 정상입니다.`);
    console.log('  요청마다 401 을 맞고 다시 받는 상태일 수 있습니다. --diag 로 응답을 확인하세요.');
  } else if (reissued) {
    console.log(`\n토큰 발급 ${reissued}회 (정상 — 받은 토큰을 만료까지 그대로 씁니다).`);
  }
  console.log('\n끝.');
}

main().catch(e => { console.error('\n✖ 실패:', e?.message || e); process.exit(1); });
