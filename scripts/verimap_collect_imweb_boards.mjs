/**
 * 베리맵 — 아임웹 게시판(해외몰: 미국 · 일본) 등록현황 수집
 *
 * 왜 따로 만드나:
 *   미국몰 · 일본몰은 상품 페이지가 아니라 **게시물**로 운영된다. 그리고 아임웹 Open API 에는
 *   게시판 엔드포인트가 아예 없다(/boards 류 전부 404 "Cannot GET"; 공식 문서의 Community 도
 *   상품문의 · 구매평 · 폼 신청서뿐이다). 그래서 상품 API 로는 해외몰 등록현황을 알 수 없다.
 *
 *   베리업은 이미 이 문제를 관리자 세션의 cm API 로 풀어 뒀다(src/platforms/imweb_edit.js).
 *   이 스크립트는 그 기능을 **그대로 불러 쓴다** — 베리업 파일은 한 줄도 고치지 않는다.
 *     게시판 목록 : POST endpoint=boards
 *     게시물 목록 : POST endpoint=posts&board_code=X&page=N   (20건씩, pagination.total_pages)
 *
 *   게시판이 두 사이트에 나뉘어 있다:
 *     en → optic-glass-us.imweb.me   (미국몰, 별개 사이트)
 *     jp → optic-glass.imweb.me      (본사몰 안의 일본어 게시판)
 *   어느 게시판이 상품 게시판인지는 data/imweb_boards.json 의 브랜드 매핑으로 가린다.
 *
 * 실행 (일반 node):
 *   node scripts\verimap_collect_imweb_boards.mjs
 *
 * 플래그
 *   --lang=en,jp        수집할 언어 (기본 en,jp — ko 도 가능)
 *   --boards-limit=3    게시판 몇 개만 (구조 확인용)
 *   --headless          창 없이
 *   --no-server         서버에서 로그인 계정을 받지 않는다(저장된 세션만으로 시도)
 *
 * 결과  data/verimap/imweb_board_posts.csv   게시물 한 건 = 한 행
 *       data/verimap/imweb_board_posts.json  원본
 *
 * 제목 형식은 베리업이 등록할 때 쓰는 것과 같다: `브랜드 모델명 [코드]`
 * 코드 해석은 대조(verimap_match.mjs)에서 한다 — 여기서는 제목을 그대로 담는다.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { ImwebEdit } from '../src/platforms/imweb_edit.js';
import { selectImwebProductBoards } from '../src/utils/imweb_product_boards.js';
import { serverLogin, fetchCredentials } from '../src/utils/server_keys.js';
import { readCsv } from './verimap_csv.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'data', 'verimap');
const BOARDS_JSON = path.join(ROOT, 'data', 'imweb_boards.json');
const ADMIN_SERVER_URL =
  (process.env.ADMIN_SERVER_URL || 'https://admin.veryup-domain.duckdns.org').replace(/\/+$/, '');

const argVal = n => {
  const h = process.argv.find(a => a.startsWith(`--${n}=`));
  return h ? h.slice(n.length + 3).trim() : '';
};
const LANGS = (argVal('lang') || 'en,jp').split(',').map(s => s.trim()).filter(Boolean);
const BOARDS_LIMIT = Number(argVal('boards-limit') || 0) || 0;
const HEADLESS = process.argv.includes('--headless');
const DETAIL = process.argv.includes('--detail') || process.argv.includes('--detail-all');          // 게시물 본문까지 읽는다
const DETAIL_LIMIT = Number(argVal('detail-limit') || 0) || 0;
// 저장된 본문(imweb_board_detail_raw.json)만 다시 해석한다 — 파싱 규칙을 고칠 때 재수집이 필요 없다.
const PARSE_ONLY = process.argv.includes('--parse-only');
// 확인필요분만이 아니라 전량. idx 는 공개 주소에 필요해서 결국 전부 받아야 한다.
const DETAIL_ALL = process.argv.includes('--detail-all');
const NO_SERVER = process.argv.includes('--no-server');
const LANG_NAME = { ko: '한국', en: '미국', jp: '일본' };

const q = v => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const writeCsv = (file, header, rows) => {
  const body = [header.map(q).join(','), ...rows.map(r => r.map(q).join(','))].join('\r\n');
  fs.writeFileSync(file, '﻿' + body, 'utf8');
  console.log(`  저장: ${path.relative(ROOT, file)}  (${rows.length}행)`);
};

// 비밀번호는 화면에 찍지 않는다 — 7·8번(verimap_collect_imweb.mjs)에서 쓰는 것과 같은 구현.
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

/** 아임웹 관리자 자동 로그인 계정을 관리자 서버에서 받아온다(파일에 쓰지 않는다). */
async function autoLoginFromServer() {
  const user = process.env.VERYUP_USER || await ask('직원 계정 아이디: ');
  const pw   = process.env.VERYUP_PW   || await ask('비밀번호: ', true);
  if (!user || !pw) throw new Error('아이디·비밀번호가 필요합니다.');
  const auth = await serverLogin(ADMIN_SERVER_URL, user, pw);
  console.log(`로그인 성공: ${auth.name || user}`);
  const creds = await fetchCredentials(ADMIN_SERVER_URL, auth.token, 'imweb');
  for (const c of creds || []) {
    const d = c.data || {};
    if (d.loginId && d.password) return d;
  }
  return null;
}

/**
 * 게시물이 어느 몰 것인지 제목의 문자로 가린다.
 *   가타카나·히라가나가 있으면 일본, 한글이 있으면 한국(해외몰이 아니므로 제외), 둘 다 없으면 미국.
 * 게시판 이름으로 가르면 BMW · GMC · BYD · Tesla 처럼 세 언어 이름이 같은 브랜드를 구분할 수 없다
 * (실제로 일본어 게시판 'BMW' 가 영문으로 분류돼 101번 일본몰 등록이 미국으로 세어졌다).
 */
function langOfTitle(title) {
  const t = String(title || '');
  if (/[\u3040-\u30ff]/.test(t)) return 'jp';
  if (/[\uac00-\ud7a3]/.test(t)) return 'ko';
  return 'en';
}

/** 게시판 이름 → 한글 브랜드명 (data/imweb_boards.json 매핑의 역방향) */
function brandLookup() {
  const { brands } = JSON.parse(fs.readFileSync(BOARDS_JSON, 'utf8'));
  const norm = s => String(s || '').normalize('NFC').replace(/\s+/g, '').toLowerCase();
  const map = new Map();
  for (const [brand, langs] of Object.entries(brands || {})) {
    for (const name of Object.values(langs || {})) if (name) map.set(norm(name), brand);
  }
  return name => map.get(norm(name)) || '';
}

// ── 본문 파싱 ────────────────────────────────────────────────
// 본문은 배너 한 줄 + 이미지마다 `<세대 표현> [No.<코드>]` 쌍이다. 실제 예:
//   ※ LAND ROVER Range Rover Sport Fitment Guide ※
//   1th gen Early model [No.706] | 2th gen [No.702] | 3th gen [No.710]
// 세대는 영문·일문으로 적혀 있어서, 대조의 세대 판정이 바로 읽도록 국문으로 바꿔 둔다.
const plainText = html => String(html || '')
  .replace(/<br\s*\/?>/gi, ' | ').replace(/<\/(p|div|li|tr)>/gi, ' | ')
  .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ').trim();

const RE_BODY_CODE = /\[\s*No\.\s*([BHKSRY]?\d{3,4}(?:-\d+)?)\s*\]/gi;

/** 영문 `3th gen late model` · 일문 `3世代 後期` → `3세대 후기` */
function genToKorean(raw) {
  const s = String(raw || '');
  let out = '';
  // 일문은 `4代目` 로도 쓴다 — 世代 만 보면 250건을 놓친다.
  const n = /(\d+(?:\.\d+)?)\s*(?:th|st|nd|rd)?\s*(?:gen(?:eration)?|世代|代目|세대)/i.exec(s);
  if (n) out += `${n[1]}세대`;
  if (/early|前期|초기/i.test(s)) out += ' 초기';
  else if (/\bmid|中期|중기/i.test(s)) out += ' 중기';
  else if (/late|後期|후기/i.test(s)) out += ' 후기';
  if (/f\/l|facelift|페이스|フェイス|マイナーチェンジ|마이너체인지/i.test(s)) out += ' F/L';
  return out.trim();
}

/** 배너에서 본문 기준 모델명을 뽑는다 — 제목보다 구체적인 경우가 있다(Discovery → Discovery4) */
function modelFromBanner(text) {
  const m = /※\s*(.+?)\s*(?:Fitment\s*Guide|適合表|조견표|世代別コード|세대별코드)\s*※/i.exec(text);
  return m ? m[1].trim() : '';
}

/** 본문 → [{ code, genRaw, gen }] */
function parseBody(html) {
  const text = plainText(html);
  const banner = modelFromBanner(text);
  // 배너 줄을 통째로 건너뛴 뒤부터 본다 — 'Fitment Guide ※' 꼬리가 세대 원문에 섞이지 않게.
  const bm = /※\s*.+?\s*(?:Fitment\s*Guide|適合表|조견표|世代別コード|세대별코드)\s*※/i.exec(text);
  const bEnd = bm ? bm.index + bm[0].length : 0;
  const body = text.slice(bEnd);
  const pairs = [];
  let last = 0, m;
  RE_BODY_CODE.lastIndex = 0;
  while ((m = RE_BODY_CODE.exec(body)) !== null) {
    const genRaw = body.slice(last, m.index).replace(/[|·\s]+/g, ' ').trim();
    pairs.push({ code: m[1].toUpperCase(), genRaw, gen: genToKorean(genRaw) });
    last = m.index + m[0].length;
  }
  return { banner, pairs };
}

/** 읽어 둔 본문을 해석해 CSV 로 쓴다. --parse-only 로 재수집 없이 다시 돌릴 수 있다. */
function writeDetailCsv(raw) {
  const HEAD = ['언어', '몰', '게시물코드', 'idx', '제목', '본문모델명', '부품번호', '세대원문', '세대'];
  const rows = [];
  const noPair = [];
  for (const r of raw) {
    const { banner, pairs } = parseBody(r.content);
    if (!pairs.length) { noPair.push(r); continue; }
    for (const p of pairs) {
      rows.push([r.lang, LANG_NAME[r.lang] || r.lang, r.postCode, r.idx ?? '', r.subject, banner, p.code, p.genRaw, p.gen]);
    }
  }
  writeCsv(path.join(OUT_DIR, 'imweb_board_details.csv'), HEAD, rows);
  const withGen = rows.filter(r => r[8]).length;
  console.log(`  코드 ${rows.length}개 — 세대를 읽은 것 ${withGen}개 / 본문에서 코드를 못 찾은 글 ${noPair.length}건`);
  for (const r of noPair.slice(0, 5)) console.log(`    코드 없음: ${r.postCode} ${r.subject}`);
  for (const r of rows.slice(0, 8)) console.log(`    ${r[1]} ${String(r[6]).padEnd(7)} ${(r[8] || '(세대없음)').padEnd(10)} ← ${r[7]}`);
}

/**
 * 게시물 본문 읽기. 제목에는 연식·세대가 없어서 번호 하나가 코드표 여러 행에 걸리는 글이 있다.
 * 베리업이 올릴 때 본문 배너에 세대를 넣으므로(`4th gen [No.612]`), 본문을 읽으면 가려진다.
 * 대상은 대조 결과(match_명단.csv)에서 해외몰 + 후보다중·고아 로 걸린 게시물만 — 전량은 낭비다.
 */
async function collectDetail(imweb) {
  const postsFile = path.join(OUT_DIR, 'imweb_board_posts.csv');
  if (!fs.existsSync(postsFile)) throw new Error('먼저 게시판 수집(18번)을 돌려야 합니다.');
  const posts = readCsv(postsFile);
  const langOf = new Map(posts.map(r => [String(r['게시물코드']), r['언어']]));
  const titleOf = new Map(posts.map(r => [String(r['게시물코드']), r['제목']]));

  let targets;
  const listFile = path.join(OUT_DIR, 'match_명단.csv');
  if (DETAIL_ALL) {
    targets = posts.map(r => String(r['게시물코드']));
    console.log(`전량 ${targets.length}건 — 공개 주소에 쓰는 idx 를 모두 받아 둡니다.`);
  } else if (fs.existsSync(listFile)) {
    const need = readCsv(listFile).filter(r =>
      String(r['채널']).startsWith('해외몰') && ['후보다중', '고아', '미해결'].includes(r['판정']));
    targets = [...new Set(need.map(r => String(r['상품ID'])))].filter(c => langOf.has(c));
    console.log(`대조에서 확인필요로 걸린 해외몰 게시물 ${targets.length}건`);
  } else {
    targets = posts.map(r => String(r['게시물코드']));
    console.log(`대조 결과가 없어 전체 ${targets.length}건을 대상으로 합니다.`);
  }
  if (DETAIL_LIMIT) { targets = targets.slice(0, DETAIL_LIMIT); console.log(`  구조 확인 — ${targets.length}건만`); }

  const byLang = new Map();
  for (const code of targets) {
    const l = langOf.get(code);
    if (!byLang.has(l)) byLang.set(l, []);
    byLang.get(l).push(code);
  }

  const raw = [];
  for (const [lang, codes] of byLang) {
    console.log(`\n■ ${LANG_NAME[lang] || lang}몰 본문 ${codes.length}건`);
    await imweb.ensureBoardBase(lang);
    let n = 0;
    for (const code of codes) {
      try {
        const d = await imweb.loadPost(code, lang);
        raw.push({ lang, postCode: code, idx: d.idx ?? '', subject: d.subject, content: d.content });
      } catch (e) {
        console.log(`    ${code} — 실패: ${e.message}`);
        raw.push({ lang, postCode: code, idx: '', subject: titleOf.get(code) || '', content: '', error: e.message });
      }
      if (++n % 25 === 0) console.log(`    ${n}/${codes.length}`);
    }
  }

  const out = path.join(OUT_DIR, 'imweb_board_detail_raw.json');
  fs.writeFileSync(out, JSON.stringify(raw, null, 2), 'utf8');
  console.log(`\n  저장: ${path.relative(ROOT, out)}  (${raw.length}건)`);

  writeDetailCsv(raw);
  // 본문에서 태그를 걷어낸 글자만 보여 준다 — 배너가 어떻게 들어가 있는지 눈으로 확인하는 용도.
  for (const r of raw.slice(0, 3)) {
    const text = String(r.content || '').replace(/<br\s*\/?>/gi, ' | ').replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
    console.log(`\n── ${LANG_NAME[r.lang] || r.lang} / ${r.postCode} / ${r.subject}`);
    console.log(`   본문글자: ${text.slice(0, 600)}`);
  }
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  if (PARSE_ONLY) {
    const f = path.join(OUT_DIR, 'imweb_board_detail_raw.json');
    if (!fs.existsSync(f)) { console.error('✖ 읽어 둔 본문이 없습니다 — 먼저 20번(또는 --detail)을 돌리세요.'); process.exit(1); }
    writeDetailCsv(JSON.parse(fs.readFileSync(f, 'utf8')));
    return 0;
  }

  const appdata = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const configPath = path.join(appdata, 'very-up-ver2', 'imweb_config.json');
  if (!fs.existsSync(configPath)) {
    console.error(`✖ 아임웹 설정 파일이 없습니다: ${configPath}`);
    console.error('  베리업을 한 번 실행해 아임웹 작업을 거친 PC 에서 돌려야 합니다.');
    process.exit(1);
  }
  console.log(`설정: ${configPath}`);
  console.log(`대상 언어: ${LANGS.map(l => `${l}(${LANG_NAME[l] || l})`).join(', ')}`);

  let autoLogin = null;
  if (!NO_SERVER) {
    try { autoLogin = await autoLoginFromServer(); }
    catch (e) { console.log(`  (서버에서 로그인 계정을 받지 못했습니다: ${e.message})`); }
  }
  if (!autoLogin) console.log('  저장된 관리자 세션만으로 진행합니다 — 로그인 화면이 뜨면 직접 로그인하세요.');

  let browser = null;
  const imweb = new ImwebEdit(configPath, () => browser);
  if (autoLogin) imweb.autoLogin = autoLogin;

  const toBrand = brandLookup();
  // board_no 가 공개 게시판 경로다: https://<몰 도메인>/{board_no}/?idx={게시물 idx}&bmode=view
  const HEAD = ['언어', '몰', '브랜드', '게시판명', '게시판번호', '게시판코드', '게시물코드', '제목'];
  const rows = [];
  const raw = { collectedAt: new Date().toISOString(), byLang: {} };

  browser = await chromium.launch({ headless: HEADLESS, channel: 'msedge' });
  if (DETAIL) {
    try { await collectDetail(imweb); } finally { await browser.close().catch(() => {}); }
    return 0;
  }
  try {
    {
      // 게시판 목록은 어느 몰 관리자로 들어가도 같은 179개가 온다(실측). 그래서 한 번만 받는다.
      console.log('\n■ 게시판 목록');
      await imweb.ensureBoardBase('en');
      const boards = await imweb.cmJson('boards', { method: 'POST' });
      fs.writeFileSync(path.join(OUT_DIR, 'imweb_boards_raw.json'), JSON.stringify(boards, null, 2), 'utf8');
      // 상품 게시판은 세 언어 이름을 모두 합쳐서 고른다 — 한 언어로만 고르면 그 언어 이름이
      // 없는 브랜드(일문 이름이 비어 있는 BMW 등)의 게시판을 통째로 놓친다.
      const seenB = new Set();
      let picked = [];
      for (const l of ['en', 'jp', 'ko']) {
        for (const b of selectImwebProductBoards(boards, l)) {
          if (!seenB.has(b.code)) { seenB.add(b.code); picked.push(b); }
        }
      }
      console.log(`  게시판 ${boards.length}개 중 상품 게시판 ${picked.length}개 (한국어 게시판 포함 — 제목으로 걸러낸다)`);
      if (BOARDS_LIMIT) picked = picked.slice(0, BOARDS_LIMIT);

      const langRows = [];
      let skippedKo = 0;
      for (const b of picked) {
        let pageNo = 1, totalPages = 1, got = 0;
        do {
          const d = await imweb.cmJson(
            `posts&type=post&board_code=${encodeURIComponent(b.code)}&keyword=&status=&page=${pageNo}`,
            { method: 'POST' });
          for (const p of (d.posts || [])) {
            const post = p.post || p;
            if (!post?.code) continue;
            // 게시판 응답에는 전체 공지도 섞여 들어온다 — 상품 글이 아니다.
            if (['y', 'true', '1'].includes(String(post.is_notice ?? '').toLowerCase())) continue;
            // 몰은 게시판 이름이 아니라 제목의 문자로 가린다.
            const lang = langOfTitle(post.subject);
            if (lang === 'ko') { skippedKo++; continue; }
            // 목록 응답의 post.idx 는 null 이다 — 공개 주소에 쓰는 숫자는 상세(22·23번)에서 받는다.
            rows.push([lang, LANG_NAME[lang], toBrand(b.name), b.name, b.board_no ?? '', b.code,
                       post.code, post.subject ?? '']);
            langRows.push({ lang, boardCode: b.code, boardName: b.name, post });
            got++;
          }
          totalPages = parseInt(d.pagination?.total_pages) || 1;
          pageNo++;
        } while (pageNo <= totalPages && pageNo <= 200);
        console.log(`    ${b.name} — ${got}건`);
      }
      for (const l of ['en', 'jp']) raw.byLang[l] = langRows.filter(x => x.lang === l);
      const cnt = l => langRows.filter(x => x.lang === l).length;
      console.log(`\n  미국몰 ${cnt('en')}건 / 일본몰 ${cnt('jp')}건 / 한국어 글 ${skippedKo}건은 제외`);
    }
  } finally {
    await browser.close().catch(() => {});
  }

  console.log('');
  writeCsv(path.join(OUT_DIR, 'imweb_board_posts.csv'), HEAD, rows);
  fs.writeFileSync(path.join(OUT_DIR, 'imweb_board_posts.json'), JSON.stringify(raw, null, 2), 'utf8');
  console.log(`  저장: data/verimap/imweb_board_posts.json`);
  const withCode = rows.filter(r => /\[[^\]]+\]/.test(String(r[7]))).length;
  console.log(`\n게시물 ${rows.length}건 — 제목에 [코드] 있는 글 ${withCode}건`);
  return 0;
}

main().then(c => process.exit(c)).catch(e => {
  console.error(`\n✖ 실패: ${e.message}`);
  process.exit(1);
});
