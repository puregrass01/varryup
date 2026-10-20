// data/vehicle_catalog.json — 엑셀 표(코드표·이베이·쿠팡)에서 구운 차량 카탈로그.
// 손으로 고치는 파일이 아니다(scratch/build_vehicle_catalog.mjs 로 다시 굽는다). 여기서는
// 다시 구웠을 때 깨지면 안 되는 약속만 본다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const raw = readFileSync(path.join(ROOT, 'data/vehicle_catalog.json'), 'utf-8');
const cat = JSON.parse(raw);

test('세 표가 모두 들어 있다', () => {
  assert.ok(Array.isArray(cat.variants) && cat.variants.length > 500, '코드표 차량 행');
  assert.ok(Array.isArray(cat.listings) && cat.listings.length > 500, '이베이 SKU 행');
  assert.ok(Array.isArray(cat.coupang) && cat.coupang.length > 300, '쿠팡 상품');
});

test('쿠팡 표에서는 네 열만 가져온다 — 검색어·승인상태·판매상태·노출상품명 등은 쓰지 않는다', () => {
  // 운영자 지시: 이 프로젝트에서 참조하지 않는다. 빌드 스크립트를 고치다 열을 하나 더 읽어도
  // 여기서 걸린다.
  const productKeys = new Set(['id', 'name', 'brand', 'model', 'options']);
  const optionKeys = new Set(['id', 'text', 'no', 'bsa']);
  for (const p of cat.coupang) {
    for (const k of Object.keys(p)) assert.ok(productKeys.has(k), `쿠팡 상품에 쓰지 않기로 한 칸: ${k}`);
    for (const o of p.options) {
      for (const k of Object.keys(o)) assert.ok(optionKeys.has(k), `쿠팡 옵션에 쓰지 않기로 한 칸: ${k}`);
    }
  }
  // 값으로도 새어 들어오지 않았는지 — 그 열들의 전형적인 값들.
  for (const word of ['승인완료', '판매중지', '검색어', '노출상품명', '승인상태', '판매상태']) {
    assert.ok(!raw.includes(word), `카탈로그에 '${word}' 가 들어 있다`);
  }
});

test('이베이 SKU 는 모두 표의 SKU 모양이다', () => {
  for (const l of cat.listings) assert.match(l.sku, /^[A-Z]{2,3}\d{4}N[A-Z]?\d+$/, l.sku);
});

// 아마존 표(실측값과 같은 줄만)에서 온 값. 같은 차라도 두 몰의 SKU 가 다를 수 있어(3시리즈 6세대: 이베이
// OBM0305N101 · 아마존 OBM0304N101) 차량 행은 이베이 SKU(skus)와 아마존 SKU(amazonSkus)를 따로 든다.
test('몰별 SKU: 이베이 칸은 이베이 표 SKU 만, 아마존 칸은 아마존에 있는(ASIN 있는) SKU 만', () => {
  const bySku = new Map(cat.listings.map(l => [l.sku, l]));
  for (const l of cat.listings) if (l.asin) assert.match(l.asin, /^B0[A-Z0-9]{8}$/, l.sku);
  const amazonKnown = cat.listings.some(l => l.asin);
  for (const v of cat.variants) {
    for (const s of v.skus) assert.notEqual(bySku.get(s)?.source, 'amazon', `${v.brand} ${v.model} ${v.gen}: 이베이 칸에 아마존 표 SKU ${s}`);
    for (const s of v.amazonSkus || []) assert.ok(!amazonKnown || bySku.get(s)?.asin, `${v.brand} ${v.model} ${v.gen}: 아마존 칸에 ASIN 없는 SKU ${s}`);
  }
});

test('SKU 가 이어진 차량 행은 SKU 의 번호와 상품번호가 같다', () => {
  // 번호가 다른 SKU 를 이으면 그 차가 다른 차 리스팅을 덮어쓴다.
  for (const v of cat.variants) {
    for (const sku of [...v.skus, ...(v.amazonSkus || [])]) {
      const n = sku.match(/N([A-Z]?\d+)$/)[1];
      assert.ok(n === v.no || n.slice(0, -1) === v.no, `${v.brand} ${v.model} No.${v.no} ↔ ${sku}`);
    }
  }
});

// 빌드와 셸이 상품번호를 같은 규칙으로 읽어야 한다. 어긋나면 목록에서 고른 번호와 등록에
// 쓰이는 번호가 달라진다(둘 다 주석으로 '같아야 한다' 고만 적혀 있었다).
test('상품번호 읽는 규칙이 빌드 스크립트와 셸에서 같다', () => {
  const build = readFileSync(path.join(ROOT, 'scratch/build_vehicle_catalog.mjs'), 'utf-8');
  const shell = readFileSync(path.join(ROOT, 'src/ui/index_up.html'), 'utf-8');
  const vu = readFileSync(path.join(ROOT, 'src/ui/vu-suggest.js'), 'utf-8');
  const re = src => src.match(/match\((\/\^\(\?:No\\\.\?\\s\*\)\?\(\[A-Za-z\]\?\\d\+\(\?:-\\d\+\)\?\)\/i)\)/)?.[1];
  const a = re(build), b = re(shell), c = re(vu);
  assert.ok(a && b && c, `규칙을 못 찾았다 — build:${!!a} shell:${!!b} vu:${!!c}`);
  assert.equal(a, b);
  assert.equal(b, c);
});

// 정규식이 같아도 결과가 달랐다: 셸만 대문자로 바꾸지 않아서 'h131' 을 치면 카탈로그(H131)와
// 어긋났다 — 거짓 'SKU … 의 것이 아닙니다' 경고, 쿠팡 중복 확인 빗나감, 제목 '[No.h131]'.
// 그래서 세 구현을 잘라 내 같은 입력에 같은 답을 내는지 직접 돌려 본다.
test('상품번호 읽기 — 빌드·셸·자동완성이 같은 입력에 같은 답을 낸다(대소문자 포함)', () => {
  const build = readFileSync(path.join(ROOT, 'scratch/build_vehicle_catalog.mjs'), 'utf-8');
  const shell = readFileSync(path.join(ROOT, 'src/ui/index_up.html'), 'utf-8');
  const vu = readFileSync(path.join(ROOT, 'src/ui/vu-suggest.js'), 'utf-8');
  const cut = (src, start, end) => {
    const i = src.indexOf(start);
    assert.ok(i !== -1, `못 찾았다: ${start}`);
    return src.slice(i, src.indexOf(end, i) + end.length);
  };
  const fromBuild = new Function(`${cut(build, 'const clean = ', ';\n')}\n${cut(build, 'function bareNo(s) {', '\n}\n')}\nreturn bareNo;`)();
  const fromShell = new Function('no', `${cut(shell, 'const bareNo = (() => {', '})();')}\nreturn bareNo;`);
  const fromVu = new Function(`${cut(vu, 'const nz = ', ';\n')}\n${cut(vu, 'const bareNoOf = ', ';\n')}\nreturn bareNoOf;`)();

  const samples = ['101', 'No.101번', 'No.H131번(옵)', 'h131', 'no.h131번', 'No.H123-1번 (옵) 각진모양', ' 612 ', 'K138', 'k138'];
  for (const x of samples) {
    const want = fromBuild(x);
    assert.equal(fromShell(x), want, `셸: ${JSON.stringify(x)}`);
    assert.equal(fromVu(x), want, `자동완성: ${JSON.stringify(x)}`);
  }
  assert.equal(fromShell('h131'), 'H131');
});

// 셸이 상품번호를 대문자로 보내게 되면서(위 테스트), 아임웹 수정 탭의 검색도 대소문자를 가리지 않아야
// 한다. 예전에 소문자로 등록된 제목('[No.h131]')을 대문자 'H131' 로 못 찾으면 수정할 글이 안 나온다.
test('아임웹 수정 검색은 상품번호의 대소문자를 가리지 않는다', async () => {
  const { titleHasCode } = await import('../src/platforms/imweb_edit.js');
  assert.equal(titleHasCode('HYUNDAI 아반떼 [No.h131]', 'H131'), true);
  assert.equal(titleHasCode('HYUNDAI 아반떼 [No.H131]', 'h131'), true);
  assert.equal(titleHasCode('HYUNDAI 아반떼 [No.H131]', 'H132'), false);
  // 두 검색이 모두 이 규칙을 쓴다 — 한쪽만 includes 로 돌아가면 다시 어긋난다.
  // B2B 상품 검색은 imweb_b2b.js(Open API), 게시글 검색은 imweb_edit.js 에 있다.
  const b2b = readFileSync(path.join(ROOT, 'src/platforms/openapi/imweb_b2b.js'), 'utf-8');
  const board = readFileSync(path.join(ROOT, 'src/platforms/imweb_edit.js'), 'utf-8');
  assert.match(b2b, /titleHasCode\(i\.name, code\)/);
  assert.match(board, /titleHasCode\(r\.subject, code\)/);
});
