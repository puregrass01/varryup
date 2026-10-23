/**
 * 베리맵 — 쿠팡 등록상품 실시간 수집 (스크립트 단독 실행용)
 *
 * 쿠팡 Open API 로 현재 등록된 상품을 전량 긁어온다. 시트를 거치지 않는다.
 * 기존 src/platforms/coupang_api.js 의 CoupangAPI 를 그대로 재사용한다 —
 * HMAC 서명·초당 호출 간격·429 쿨다운이 이미 그 안에 들어 있다.
 *
 * 쿠팡은 허용 IP 목록(화이트리스트)을 쓴다. 직원 PC 의 IP 는 등록돼 있지 않으므로
 * 베리업과 똑같이 관리자 서버(고정 IP)를 경유한다. 그래서 직원 계정 로그인이 필요하다.
 *
 * 실행
 *   node scripts/verimap_collect_coupang.mjs            목록 전량
 *   node scripts/verimap_collect_coupang.mjs --probe     첫 페이지만 (연결 확인용)
 *   node scripts/verimap_collect_coupang.mjs --detail    목록 + 상세(옵션·업체상품코드)
 *   node scripts/verimap_collect_coupang.mjs --direct    서버 경유 없이 이 PC 에서 직접
 *
 * 계정을 물어보지 않게 하려면 환경변수 VERYUP_USER / VERYUP_PW 를 미리 넣어 둔다.
 *
 * 결과
 *   data/verimap/coupang_list.csv      상품 단위
 *   data/verimap/coupang_items.csv     옵션 단위 (--detail 일 때만)
 *   data/verimap/coupang_raw.json      원본 응답
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { CoupangAPI } from '../src/platforms/coupang_api.js';
import { serverLogin } from '../src/utils/server_keys.js';
import { resolveRuntimeProxy } from '../src/utils/runtime_proxy.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'data', 'verimap');
const ADMIN_SERVER_URL =
  (process.env.ADMIN_SERVER_URL || 'https://admin.veryup-domain.duckdns.org').replace(/\/+$/, '');

const PROBE  = process.argv.includes('--probe');
const DETAIL = process.argv.includes('--detail');
const DIRECT = process.argv.includes('--direct');
// 재고 조회 — 쿠팡 상세 응답에는 재고가 없다. 옵션마다 재고 조회 API 를 한 번 더 불러야 한다.
// 품절(재고 0 / 판매중지) 옵션은 지난 버전 상품이라 대조 대상이 아니다.
const STOCK  = process.argv.includes('--stock') || process.argv.includes('--skip-soldout');

// ── 걸러내기 ────────────────────────────────────────────────
// 베리맵이 대조할 대상은 '자동차 광각미러' 뿐이다. 전동사이드스텝·후방모니터·매트 등
// 다른 브랜드 상품은 코드표에 없으므로 상세 조회 대상에서 빼야 한다(호출 수·시간 절약).
const argVal = name => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3).trim() : '';
};
const F_BRAND    = argVal('brand');      // 예: --brand=옵틱글래스
const F_CATEGORY = argVal('category');   // 예: --category=78732
const F_NAME     = argVal('name');       // 예: --name=광각
const F_EXCLUDE  = argVal('exclude');    // 예: --exclude=오토바이
const HAS_FILTER = Boolean(F_BRAND || F_CATEGORY || F_NAME || F_EXCLUDE);

const norm = v => String(v ?? '').replace(/\s+/g, '').toLowerCase();
function keep(p) {
  if (F_BRAND    && norm(p.brand) !== norm(F_BRAND)) return false;
  if (F_CATEGORY && String(p.displayCategoryCode ?? '') !== F_CATEGORY) return false;
  if (F_NAME     && !norm(p.sellerProductName).includes(norm(F_NAME))) return false;
  if (F_EXCLUDE  && norm(p.sellerProductName).includes(norm(F_EXCLUDE))) return false;
  return true;
}

/** 무엇이 올라와 있는지 한눈에 — 필터를 정하기 전에 이걸 보고 판단한다. */
function breakdown(label, pick, rows) {
  const counts = new Map();
  for (const r of rows) {
    const k = String(pick(r) ?? '(없음)').trim() || '(없음)';
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const sorted = [...counts].sort((a, b) => b[1] - a[1]);
  console.log(`\n── ${label} (${sorted.length}종) ──`);
  for (const [k, n] of sorted.slice(0, 25)) {
    console.log(`   ${String(n).padStart(5)}  ${k}`);
  }
  if (sorted.length > 25) console.log(`   … 외 ${sorted.length - 25}종`);
}

// ── 콘솔 입력 (비밀번호는 화면에 안 보이게) ──────────────────
function ask(question, hidden = false) {
  return new Promise(resolve => {
    process.stdout.write(question);
    const stdin = process.stdin;
    stdin.resume();
    stdin.setEncoding('utf8');
    let buf = '';
    const wasRaw = Boolean(stdin.isRaw);
    if (hidden && stdin.isTTY) stdin.setRawMode(true);

    const finish = () => {
      if (hidden && stdin.isTTY) stdin.setRawMode(wasRaw);
      stdin.pause();
      stdin.off('data', onData);
      if (hidden) process.stdout.write('\n');
      resolve(buf.trim());
    };
    const onData = chunk => {
      if (!hidden) { buf = String(chunk); return finish(); }
      for (const ch of String(chunk)) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') return finish();
        if (ch === '\u0003') { process.stdout.write('\n'); process.exit(130); }
        if (ch === '\u007f' || ch === '\b') { buf = buf.slice(0, -1); continue; }
        buf += ch;
        process.stdout.write('*');
      }
    };
    stdin.on('data', onData);
  });
}

// ── 쿠팡 인증키 찾기 ────────────────────────────────────────
// 앱은 app.getPath('userData') 에 저장한다. 이 스크립트는 Electron 밖이라 직접 짚는다.
function findConfig() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const candidates = [
    path.join(appData, 'very-up-ver2', 'coupang_config.json'),
    path.join(appData, 'VERY UP VER3', 'coupang_config.json'),
    path.join(ROOT, 'data', 'coupang_config.json'),
  ];
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    let cfg;
    try { cfg = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { continue; }
    if (cfg.vendorId && cfg.accessKey && cfg.secretKey) return { path: p, cfg };
    console.log(`  (건너뜀 — 키가 비어 있음) ${p}`);
  }
  console.error('\n✖ 쿠팡 인증키를 찾지 못했습니다. 찾아본 곳:');
  candidates.forEach(p => console.error('   ' + p));
  console.error('\n  베리업을 한 번 실행해 직원 계정으로 로그인하면 키가 저장됩니다.');
  process.exit(1);
}

// ── CSV ─────────────────────────────────────────────────────
const q = v => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const writeCsv = (file, header, rows) => {
  const body = [header.map(q).join(','), ...rows.map(r => r.map(q).join(','))].join('\r\n');
  fs.writeFileSync(file, '﻿' + body, 'utf8');   // BOM — 엑셀에서 한글 안 깨지게
  console.log(`  저장: ${path.relative(ROOT, file)}  (${rows.length}행)`);
};

// ── 본체 ────────────────────────────────────────────────────
async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const { path: cfgPath, cfg } = findConfig();
  console.log(`설정: ${cfgPath}`);
  console.log(`판매자(vendorId): ${cfg.vendorId}`);

  // 서버 경유 준비 — 쿠팡 허용 IP 때문에 기본값이 '경유' 다.
  let proxy = null;
  if (!DIRECT) {
    const user = process.env.VERYUP_USER || await ask('\n직원 계정 아이디: ');
    const pw   = process.env.VERYUP_PW   || await ask('비밀번호: ', true);
    if (!user || !pw) { console.error('✖ 아이디·비밀번호가 필요합니다.'); process.exit(1); }
    let auth;
    try {
      auth = await serverLogin(ADMIN_SERVER_URL, user, pw);
    } catch (e) {
      console.error(`\n✖ 관리자 서버 로그인 실패: ${e.message}`);
      console.error(`   서버: ${ADMIN_SERVER_URL}`);
      if (e.offline) console.error('   서버에 닿지 못했습니다. 주소·네트워크를 확인해주세요.');
      process.exit(1);
    }
    proxy = resolveRuntimeProxy({ platform: 'coupang', baseUrl: ADMIN_SERVER_URL, token: auth.token });
    if (!proxy) { console.error('✖ 프록시 설정을 만들지 못했습니다 (USE_SERVER_PROXY=0 인지 확인).'); process.exit(1); }
    console.log(`로그인 성공: ${auth.name || user} — 서버 경유 (${ADMIN_SERVER_URL})\n`);
  } else {
    console.log('경로: 이 PC 에서 직접 호출 — 쿠팡 허용 IP 에 이 PC 가 있어야 합니다.\n');
  }

  const api = new CoupangAPI(
    cfg.vendorId, cfg.accessKey, cfg.secretKey,
    cfg.vendorUserId || cfg.vendorId,
    proxy || {}
  );

  // 1) 목록 — nextToken 이 빌 때까지
  const products = [];
  let nextToken = '';
  let page = 0;
  while (true) {
    page++;
    const res = await api.listProducts(nextToken, 100);
    const list = Array.isArray(res?.data) ? res.data : [];
    products.push(...list);
    process.stdout.write(`\r목록 ${page}쪽 — 누적 ${products.length}개`);
    nextToken = res?.nextToken ? String(res.nextToken) : '';
    if (PROBE || !nextToken || !list.length) break;
    if (page > 200) { console.warn('\n⚠ 200쪽을 넘었습니다 — 중단'); break; }
  }
  console.log(`\n목록 완료 — 상품 ${products.length}개${PROBE ? ' (첫 페이지만)' : ''}\n`);

  const LIST_HEADER = ['등록상품ID', '노출상품ID', '상품명', '상태', '브랜드', '전시카테고리', '등록일', '판매시작', '판매종료'];
  const listRow = p => [
    p.sellerProductId, p.productId, p.sellerProductName, p.statusName,
    p.brand, p.displayCategoryCode, p.createdAt, p.saleStartedAt, p.saleEndedAt,
  ];
  writeCsv(path.join(OUT_DIR, 'coupang_list.csv'), LIST_HEADER, products.map(listRow));

  // 무엇이 올라와 있는지 분포를 먼저 보여 준다
  breakdown('브랜드별', p => p.brand, products);
  breakdown('전시카테고리별', p => p.displayCategoryCode, products);
  breakdown('상태별', p => p.statusName, products);

  // 걸러내기
  let targets = products;
  if (HAS_FILTER) {
    targets = products.filter(keep);
    const cond = [
      F_BRAND    && `브랜드=${F_BRAND}`,
      F_CATEGORY && `카테고리=${F_CATEGORY}`,
      F_NAME     && `상품명에 "${F_NAME}" 포함`,
      F_EXCLUDE  && `상품명에 "${F_EXCLUDE}" 제외`,
    ].filter(Boolean).join(' / ');
    console.log(`\n걸러냄 — ${cond}`);
    console.log(`  대상 ${targets.length}개 / 전체 ${products.length}개`);
    writeCsv(path.join(OUT_DIR, 'coupang_list_filtered.csv'), LIST_HEADER, targets.map(listRow));
  }

  const raw = {
    collectedAt: new Date().toISOString(), vendorId: cfg.vendorId,
    viaProxy: Boolean(proxy),
    filter: HAS_FILTER ? { brand: F_BRAND, category: F_CATEGORY, name: F_NAME, exclude: F_EXCLUDE } : null,
    products,
  };

  // 2) 상세 — 옵션(아이템) 단위 업체상품코드까지. 목록에는 없다.
  if (DETAIL && targets.length) {
    // 상세(옵션명·코드)는 자주 바뀌지 않는다 — 디스크에 캐시해 두고 신규 상품만 새로 받는다.
    // 재고는 매일 바뀌므로 캐시하지 않는다.
    const CACHE_PATH = path.join(OUT_DIR, 'coupang_detail_cache.json');
    // 상품 상세는 거의 안 바뀐다 — 한 달 둔다. 바로 다시 받으려면 --fresh.
    const CACHE_DAYS = Number(argVal('cache-days') || 30);
    const FRESH = process.argv.includes('--fresh');
    let cache = {};
    if (!FRESH && fs.existsSync(CACHE_PATH)) {
      try { cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')) || {}; } catch { cache = {}; }
    }
    const cutoff = Date.now() - CACHE_DAYS * 86400000;
    const fresh = id => { const c = cache[String(id)]; return c && c.at > cutoff ? c.data : null; };
    const hitCount = targets.filter(p => fresh(p.sellerProductId)).length;
    console.log(`\n상세 조회 — 전체 ${targets.length}건 / 캐시 재사용 ${hitCount}건 / 새로 받을 ${targets.length - hitCount}건`);
    console.log(`  (캐시 ${CACHE_DAYS}일. --fresh 로 전부 다시 받습니다.)`);

    const items = [];
    const details = [];
    let done = 0, failed = 0, fetched = 0;
    for (const p of targets) {
      try {
        const cached = fresh(p.sellerProductId);
        let res;
        if (cached) { res = cached; }
        else {
          res = await api.getProduct(p.sellerProductId);
          fetched++;
          cache[String(p.sellerProductId)] = { at: Date.now(), data: res };
        }
        const d = res?.data;
        if (d) {
          details.push(d);
          for (const it of (d.items || [])) {
            items.push([
              d.sellerProductId, it.vendorItemId ?? '', it.sellerProductItemId ?? '',
              d.sellerProductName, it.itemName ?? '', it.externalVendorSku ?? '',
              it.modelNo ?? '', it.barcode ?? '',
            ]);
          }
        }
      } catch (e) {
        failed++;
        console.warn(`\n  ⚠ ${p.sellerProductId} 실패: ${e.message}`);
      }
      done++;
      if (done % 10 === 0) process.stdout.write(`\r  상세 ${done}/${targets.length} (실패 ${failed})`);
    }
    console.log(`\r  상세 완료 ${done}/${targets.length} (새로 받음 ${fetched} / 실패 ${failed})        \n`);
    try {
      fs.writeFileSync(CACHE_PATH, JSON.stringify(cache), 'utf8');
      console.log(`  캐시 저장: ${path.relative(ROOT, CACHE_PATH)}  (${Object.keys(cache).length}건)`);
    } catch (e) { console.log(`  ⚠ 캐시 저장 실패: ${e.message}`); }

    raw.details = details;

    // ── 재고 조회 (품절 걸러내기) ──
    let stockBy = null;
    if (STOCK) {
      const ids = items.map(r => String(r[1])).filter(v => v && v !== 'undefined');

      // 재고도 캐시한다 — 상세와 달리 매일 바뀌므로 수명을 짧게 둔다(기본 1일).
      // 하루에 여러 번 돌리거나 대조만 다시 할 때 1,500회를 또 부르지 않게 하려는 것이다.
      // 꼭 지금 값이 필요하면 --fresh-stock 으로 전부 다시 받는다.
      const SPATH = path.join(OUT_DIR, 'coupang_stock_cache.json');
      // 재고도 자주 바뀌지 않아 한 달 둔다(720시간). 지금 값이 필요하면 --fresh-stock.
      const SHOURS = Number(argVal('stock-hours') || 720);
      const FRESH_STOCK = process.argv.includes('--fresh-stock') || process.argv.includes('--fresh');
      let scache = {};
      if (!FRESH_STOCK && fs.existsSync(SPATH)) {
        try { scache = JSON.parse(fs.readFileSync(SPATH, 'utf8')) || {}; } catch { scache = {}; }
      }
      const scut = Date.now() - SHOURS * 3600000;
      stockBy = new Map();
      const askIds = [];
      for (const vid of ids) {
        const c = scache[vid];
        if (c && c.at > scut) stockBy.set(vid, c.data);
        else askIds.push(vid);
      }
      console.log(`\n재고 조회 — 전체 ${ids.length}건 / 캐시 재사용 ${stockBy.size}건 / 새로 받을 ${askIds.length}건`);
      console.log(`  (캐시 ${SHOURS}시간. 지금 값이 필요하면 --fresh-stock)`);
      if (askIds.length) console.log(`  약 ${Math.ceil(askIds.length / 4)}초`);
      let k = 0, kf = 0;
      for (const vid of askIds) {
        try {
          const inv = await api.getItemInventory(vid);
          const data = {
            stock: inv?.amountInStock ?? null,
            onSale: inv?.onSale ?? null,
            price: inv?.salePrice ?? null,
          };
          stockBy.set(vid, data);
          scache[vid] = { at: Date.now(), data };
        } catch { kf++; }
        k++;
        if (k % 25 === 0) process.stdout.write(`\r  재고 ${k}/${askIds.length} (실패 ${kf})`);
      }
      console.log(`\r  재고 완료 ${k}/${askIds.length} (실패 ${kf})        `);
      try {
        fs.writeFileSync(SPATH, JSON.stringify(scache), 'utf8');
        console.log(`  캐시 저장: ${path.relative(ROOT, SPATH)}  (${Object.keys(scache).length}건)`);
      } catch (e) { console.log(`  ⚠ 재고 캐시 저장 실패: ${e.message}`); }
    }

    const HEAD = ['등록상품ID', '옵션ID', '옵션항목ID', '상품명', '옵션명', '업체상품코드', '모델번호', '바코드'];
    if (stockBy) {
      const withStock = items.map(r => {
        const st = stockBy.get(String(r[1])) || {};
        return [...r, st.stock ?? '', st.onSale === null || st.onSale === undefined ? '' : (st.onSale ? 'Y' : 'N'), st.price ?? ''];
      });
      const H2 = [...HEAD, '재고', '판매중', '판매가'];

      // 판매상태 — 대조 대상은 '판매중' 뿐이다.
      //   판매불가: 옵션ID 가 없거나(승인 전), 판매가가 비었거나(구매 불가),
      //             재고 조회가 400 으로 거절된 것. 셋 다 실제로는 팔리지 않는다.
      //   품절    : 재고 0 또는 판매중지.
      const sellState = r => {
        const vid = String(r[1] ?? '').trim();
        if (!vid) return '판매불가(옵션ID없음)';
        const price = String(r[10] ?? '').trim();
        const st = stockBy.get(vid);
        if (!st) return '판매불가(재고조회거절)';
        if (!price && (st.price === null || st.price === undefined)) return '판매불가(가격없음)';
        if (st.onSale === false) return '품절(판매중지)';
        if (st.stock === 0) return '품절(재고0)';
        return '판매중';
      };
      const stated = withStock.map(r => [...r, sellState(r)]);
      const H3 = [...H2, '판매상태'];
      writeCsv(path.join(OUT_DIR, 'coupang_items.csv'), H3, stated);

      const onSaleRows = stated.filter(r => r[r.length - 1] === '판매중');
      writeCsv(path.join(OUT_DIR, 'coupang_items_onsale.csv'), H3, onSaleRows);

      const tally = new Map();
      for (const r of stated) { const k = r[r.length - 1]; tally.set(k, (tally.get(k) || 0) + 1); }
      console.log('\n  판매상태:');
      for (const [k, v] of [...tally].sort((a, b) => b[1] - a[1])) console.log(`     ${String(v).padStart(5)}  ${k}`);
      console.log('  → 대조에는 coupang_items_onsale.csv (판매중) 를 쓴다.');
      raw.stock = Object.fromEntries(stockBy);
    } else {
      writeCsv(path.join(OUT_DIR, 'coupang_items.csv'), HEAD, items);
      console.log('\n  (재고는 조회하지 않았다 — 품절 구분이 필요하면 --stock 을 붙인다)');
    }

    const filled = items.filter(r => String(r[5]).trim() !== '').length;
    console.log(`업체상품코드(externalVendorSku) 채워진 옵션: ${filled} / ${items.length}`);
  }

  // 목록만 받는 실행(3번)이 상세·재고를 날려 버리면 대조가 못 돈다 — 있던 것을 그대로 옮겨 둔다.
  const RAW_PATH = path.join(OUT_DIR, 'coupang_raw.json');
  if (!raw.details && fs.existsSync(RAW_PATH)) {
    try {
      const prev = JSON.parse(fs.readFileSync(RAW_PATH, 'utf8'));
      if (prev.details) {
        raw.details = prev.details;
        raw.detailsFrom = prev.collectedAt || '이전 실행';
        console.log(`  (상세 ${prev.details.length}건은 이전 수집분을 그대로 둡니다 — ${raw.detailsFrom})`);
      }
      if (prev.stock && !raw.stock) raw.stock = prev.stock;   // :373 이 쓰고 match 가 읽는 키는 stock(단수)
    } catch (e) { console.log(`  (이전 원본을 읽지 못했습니다: ${e.message})`); }
  }
  fs.writeFileSync(RAW_PATH, JSON.stringify(raw), 'utf8');
  console.log(`  저장: ${path.relative(ROOT, RAW_PATH)}`);
  console.log('\n끝.');
  process.exit(0);
}

main().catch(e => {
  console.error('\n✖ 실패:', e.message);
  if (e.status) console.error('   HTTP', e.status);
  process.exit(1);
});
