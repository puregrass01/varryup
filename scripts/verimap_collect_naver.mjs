/**
 * 베리맵 — 스마트스토어(네이버 커머스API) 등록상품 수집
 *
 * ⚠ Electron 으로 실행해야 한다.
 *   네이버 clientSecret 은 OS 암호화 저장소(safeStorage)에 암호화되어 있어
 *   일반 node 로는 복호화할 수 없다. Electron 안에서 돌리면 베리업이 이미 저장해 둔
 *   키를 그대로 쓸 수 있다 — 다시 입력할 필요가 없다.
 *
 *   node_modules\.bin\electron.cmd scripts\verimap_collect_naver.mjs
 *
 * 환경변수 NAVER_CLIENT_ID / NAVER_CLIENT_SECRET / NAVER_ACCOUNT_ID 가 있으면 그쪽이 먼저다.
 *
 * 결과  data/verimap/naver_list.csv    상품 단위
 *       data/verimap/naver_raw.json    원본
 *
 * 네이버는 허용 IP 목록(화이트리스트)을 쓴다. 두 경로가 다 가능하다:
 *   --direct  이 PC 에서 직접 호출 — 이 PC 의 외부 IP 가 등록돼 있어야 한다.
 *   (기본)    관리자 서버(AWS 고정 IP) 경유 — 서버 IP 가 등록돼 있어야 하고,
 *             직원 계정 로그인이 필요하다. NaverAPI 와 server/proxy.py 의 /naver 를
 *             그대로 쓴다 — 베리업 파일은 고치지 않는다.
 */
import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NaverStore } from '../src/platforms/naver_store.js';
import { NaverAPI } from '../src/platforms/naver_api.js';
import { serverLogin } from '../src/utils/server_keys.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'data', 'verimap');

// 앱과 같은 userData 를 쓰도록 못 박는다. `electron <script>` 로 띄우면 앱 이름이
// 달라져 엉뚱한 폴더를 보게 되고, 저장된 키를 못 찾는다.
app.setName('very-up-ver2');
app.setPath('userData', path.join(app.getPath('appData'), 'very-up-ver2'));

const argVal = name => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3).trim() : '';
};
const F_NAME    = argVal('name');       // 예: --name=광각
const F_EXCLUDE = argVal('exclude');
const DIRECT    = process.argv.includes('--direct');
const F_CATEGORY= argVal('category');   // 예: --category=50004061 (자동차 광각미러)
const DETAIL    = process.argv.includes('--detail');
const LIMIT     = Number(argVal('limit') || 0) || 0;   // 구조 확인용 소량 조회
// 네이버는 상품명에 부품번호가 없다(1049개 중 0개). 번호는 옵션에 들어 있어서
// 채널상품 상세를 불러야 보인다. 판매자 관리코드도 상세에만 있다.
const ADMIN_SERVER_URL =
  (process.env.ADMIN_SERVER_URL || 'https://admin.veryup-domain.duckdns.org').replace(/\/+$/, '');
const norm = v => String(v ?? '').replace(/\s+/g, '').toLowerCase();

// Electron 은 Windows 에서 GUI 앱으로 빌드돼 있어 cmd 창에 출력이 안 보일 수 있다.
// 화면에 쓰면서 로그 파일에도 같이 남긴다 — 배치가 끝에서 이 파일을 보여 준다.
const LOG_PATH = path.join(OUT_DIR, 'naver_log.txt');
fs.mkdirSync(OUT_DIR, { recursive: true });
try { fs.writeFileSync(LOG_PATH, ''); } catch {}
function tee(stream, args) {
  const line = args.map(a => (typeof a === 'string' ? a : String(a))).join(' ');
  try { fs.appendFileSync(LOG_PATH, line.replace(/\r/g, '') + '\n'); } catch {}
  stream(line);
}
const rawLog = console.log.bind(console);
const rawErr = console.error.bind(console);
console.log = (...a) => tee(rawLog, a);
console.error = (...a) => tee(rawErr, a);

const q = v => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const writeCsv = (file, header, rows) => {
  const body = [header.map(q).join(','), ...rows.map(r => r.map(q).join(','))].join('\r\n');
  fs.writeFileSync(file, '﻿' + body, 'utf8');
  console.log(`  저장: ${path.relative(ROOT, file)}  (${rows.length}행)`);
};
function breakdown(label, pick, rows) {
  const counts = new Map();
  for (const r of rows) {
    const k = String(pick(r) ?? '(없음)').trim() || '(없음)';
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const sorted = [...counts].sort((a, b) => b[1] - a[1]);
  console.log(`\n── ${label} (${sorted.length}종) ──`);
  for (const [k, n] of sorted.slice(0, 20)) console.log(`   ${String(n).padStart(5)}  ${k}`);
  if (sorted.length > 20) console.log(`   … 외 ${sorted.length - 20}종`);
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const store = new NaverStore(app.getPath('userData'), safeStorage);
  let saved = {};
  try { saved = store.config(); } catch (e) { console.log(`저장된 설정 읽기 실패: ${e.message}`); }

  const config = {
    clientId: (process.env.NAVER_CLIENT_ID || '').trim() || saved.clientId || '',
    clientSecret: (process.env.NAVER_CLIENT_SECRET || '').trim() || saved.clientSecret || '',
    accountId: (process.env.NAVER_ACCOUNT_ID || '').trim() || saved.accountId || '',
    type: saved.type || 'SELF',
  };
  console.log(`설정 폴더: ${app.getPath('userData')}`);
  if (!config.clientId || !config.clientSecret) {
    console.error('\n✖ 네이버 커머스API 인증정보가 없습니다.');
    console.error('  베리업을 한 번 실행해 네이버 API 키를 저장하거나,');
    console.error('  환경변수 NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 를 넣고 다시 실행해주세요.');
    return 1;
  }
  console.log(`clientId: ${config.clientId.slice(0, 6)}… / type: ${config.type}\n`);

  // 서버 경유 — resolveRuntimeProxy 는 쿠팡만 통과시키므로 여기서 직접 만든다.
  // NaverAPI._send 가 proxyUrl 이 있으면 {proxyUrl}/naver 로 보낸다(이미 구현돼 있다).
  let proxy = {};
  if (!DIRECT) {
    const user = process.env.VERYUP_USER || '';
    const pw   = process.env.VERYUP_PW   || '';
    if (!user || !pw) {
      console.error('\n✖ 서버 경유에는 직원 계정이 필요합니다.');
      console.error('  Electron 창에서는 비밀번호를 받을 수 없으니 환경변수로 넘겨주세요:');
      console.error('    set VERYUP_USER=아이디');
      console.error('    set VERYUP_PW=비밀번호');
      console.error('  이 PC 의 IP 가 네이버에 등록돼 있다면 --direct 로 직접 호출하면 됩니다.');
      return 1;
    }
    try {
      const auth = await serverLogin(ADMIN_SERVER_URL, user, pw);
      proxy = { proxyUrl: ADMIN_SERVER_URL, proxyToken: auth.token };
      console.log(`로그인 성공: ${auth.name || user} — 서버 경유 (${ADMIN_SERVER_URL})`);
    } catch (e) {
      console.error(`\n✖ 관리자 서버 로그인 실패: ${e.message}`);
      return 1;
    }
  } else {
    console.log('경로: 이 PC 에서 직접 호출 — 이 PC 의 IP 가 네이버에 등록돼 있어야 합니다.');
  }

  const api = new NaverAPI(config, { proxy });

  console.log('토큰 발급…');
  try {
    await api.token();
  } catch (e) {
    console.error(`\n✖ 토큰 발급 실패: ${e.message}`);
    console.error('  키가 맞는지, 이 PC 의 IP 가 네이버 허용목록에 있는지 확인해주세요.');
    return 1;
  }
  console.log('토큰 OK\n');

  console.log('상품 목록 조회… (페이지당 100건)');
  let rows;
  try {
    rows = await api.allProducts({
      pageSize: 100, force: true,
      onProgress: (n, total) => console.log(`  누적 ${n}${total ? ' / ' + total : ''}`),
    });
  } catch (e) {
    console.error(`\n✖ 목록 조회 실패: ${e.message}`);
    return 1;
  }
  console.log(`\n목록 완료 — 상품 ${rows.length}개\n`);

  const HEAD = ['원상품번호', '채널상품번호', '상품명', '판매상태', '판매가', '재고', '브랜드', '모델명', '카테고리'];
  const toRow = p => [p.originProductNo, p.channelProductNo ?? '', p.name, p.statusType,
                      p.salePrice, p.stockQuantity, p.brandName, p.modelName, p.categoryId];
  writeCsv(path.join(OUT_DIR, 'naver_list.csv'), HEAD, rows.map(toRow));

  breakdown('판매상태별', p => p.statusType, rows);
  breakdown('브랜드별', p => p.brandName, rows);
  breakdown('카테고리별', p => p.categoryId, rows);

  let targets = rows;
  if (F_NAME || F_EXCLUDE || F_CATEGORY) {
    targets = rows.filter(p =>
      (!F_CATEGORY || String(p.categoryId) === F_CATEGORY) &&
      (!F_NAME || norm(p.name).includes(norm(F_NAME))) &&
      (!F_EXCLUDE || !norm(p.name).includes(norm(F_EXCLUDE))));
    console.log(`\n걸러냄 — ${[F_CATEGORY && `카테고리=${F_CATEGORY}`, F_NAME && `상품명에 "${F_NAME}"`, F_EXCLUDE && `"${F_EXCLUDE}" 제외`].filter(Boolean).join(' / ')}`);
    console.log(`  대상 ${targets.length}개 / 전체 ${rows.length}개`);
    writeCsv(path.join(OUT_DIR, 'naver_list_filtered.csv'), HEAD, targets.map(toRow));
  }

  // ── 상세 조회 — 옵션과 판매자 관리코드는 여기에만 있다 ──
  let details = null;
  if (DETAIL) {
    const list = LIMIT ? targets.slice(0, LIMIT) : targets;
    console.log(`\n상세 조회 — ${list.length}건 (API별 2RPS 라 약 ${Math.ceil(list.length * 0.6)}초)`);
    details = [];
    const items = [];
    let done = 0, failed = 0;
    for (const p of list) {
      if (!p.channelProductNo) { failed++; done++; continue; }
      try {
        // 베리업 NaverAPI 에서 channelProduct() 가 정리돼 빠졌으므로 공개 request() 로 직접 부른다.
        const res = await api.request('GET', `/v2/products/channel-products/${encodeURIComponent(p.channelProductNo)}`);
        details.push({ channelProductNo: p.channelProductNo, originProductNo: p.originProductNo, name: p.name, data: res });

        // 확인된 구조 (2026-10-21 실응답):
        //   originProduct.detailAttribute.optionInfo.optionCombinations[]
        //   그룹명 1=모델명, 2=상품선택(연식+[No.번호]), 3=운전석/조수석
        // 쿠팡과 달리 모델명이 별도 칸이라 후보 가르기에 바로 쓸 수 있다.
        const op = res?.originProduct ?? res?.data?.originProduct ?? res ?? {};
        const da = op.detailAttribute ?? {};
        const prodCode = da.sellerCodeInfo?.sellerManagementCode ?? '';
        const oi = da.optionInfo ?? {};
        const g = oi.optionCombinationGroupNames ?? {};
        const combos = oi.optionCombinations ?? [];
        if (combos.length) {
          for (const c of combos) {
            items.push([
              p.originProductNo, p.channelProductNo, p.name,
              c.optionName1 ?? '', c.optionName2 ?? '', c.optionName3 ?? '',
              [g.optionGroupName1, g.optionGroupName2, g.optionGroupName3].filter(Boolean).join(' / '),
              c.id ?? '', c.sellerManagerCode ?? '', prodCode,
              c.stockQuantity ?? '', c.price ?? '', c.usable === false ? 'N' : 'Y',
            ]);
          }
        } else {
          items.push([p.originProductNo, p.channelProductNo, p.name, '', '', '', '(옵션 없음)',
                      '', '', prodCode, p.stockQuantity ?? '', p.salePrice ?? '', 'Y']);
        }
      } catch (e) {
        failed++;
        console.log(`  ⚠ ${p.channelProductNo} 실패: ${e.message}`);
      }
      done++;
      if (done % 20 === 0) console.log(`  상세 ${done}/${list.length} (실패 ${failed})`);
    }
    console.log(`  상세 완료 ${done}/${list.length} (실패 ${failed})`);

    writeCsv(path.join(OUT_DIR, 'naver_items.csv'),
      ['원상품번호', '채널상품번호', '상품명', '옵션1_모델명', '옵션2_상품선택', '옵션3_좌우',
       '옵션그룹명', '옵션조합ID', '옵션_판매자코드', '상품_판매자코드', '재고', '가격차', '사용'],
      items);

    const c1 = items.filter(r => String(r[8]).trim()).length;
    const c2 = items.filter(r => String(r[9]).trim()).length;
    const live = items.filter(r => r[12] === 'Y').length;
    const prods = new Set(items.map(r => String(r[1]))).size;
    console.log(`\n  옵션 ${items.length}개 / 상품 ${prods}개 (사용중 옵션 ${live})`);
    console.log(`    옵션 판매자코드 채워짐 ${c1} / ${items.length}`);
    console.log(`    상품 판매자코드 채워짐 ${c2} / ${items.length}`);
    const groups = new Map();
    for (const r of items) groups.set(r[6], (groups.get(r[6]) || 0) + 1);
    console.log('    옵션 구성 (그룹명):');
    for (const [k, v] of [...groups].sort((a, b) => b[1] - a[1]).slice(0, 6)) console.log(`      ${String(v).padStart(5)}  ${k}`);

    // 구조 확인용 — 첫 건의 원본을 그대로 남긴다
    if (details.length) {
      fs.writeFileSync(path.join(OUT_DIR, 'naver_detail_sample.json'),
        JSON.stringify(details.slice(0, 2), null, 2), 'utf8');
      console.log(`  저장: ${path.relative(ROOT, path.join(OUT_DIR, 'naver_detail_sample.json'))} (구조 확인용 2건)`);
    }
  }

  fs.writeFileSync(
    path.join(OUT_DIR, 'naver_raw.json'),
    JSON.stringify({
      collectedAt: new Date().toISOString(),
      filter: (F_NAME || F_EXCLUDE || F_CATEGORY) ? { name: F_NAME, exclude: F_EXCLUDE, category: F_CATEGORY } : null,
      count: rows.length, products: rows,
      ...(details ? { details } : {}),
    }),
    'utf8'
  );
  console.log(`  저장: ${path.relative(ROOT, path.join(OUT_DIR, 'naver_raw.json'))}`);
  console.log('\n끝.');
  return 0;
}

app.whenReady().then(async () => {
  let code = 1;
  try { code = await main(); }
  catch (e) { console.error('\n✖ 실패:', e?.message || e); }
  app.exit(code);
});
