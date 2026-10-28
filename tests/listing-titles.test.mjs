// 판매 채널 상품명 문형 (아마존 · 이베이).
//
// 이 문자열은 그대로 아마존에 올라간다. 오타 하나가 리스팅에 박히고, 되돌리려면
// 상품을 다시 수정해야 한다. 그래서 '대충 이런 모양' 이 아니라 글자 단위로 고정한다.
//
// 문형은 index.html 의 인라인 <script> 안에 있어서 import 할 수 없다. 대신 그 객체
// 리터럴만 잘라내 평가한다 — 파일이 바뀌면 여기서 바로 깨지는 쪽이 낫다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync as readRaw } from 'node:fs';
// git core.autocrlf=true 체크아웃은 CRLF 로 풀린다 — 아래 '\n}\n' 같은 경계로 자르니 줄바꿈을 맞춰 읽는다.
const readFileSync = (...a) => readRaw(...a).replace(/\r\n/g, '\n');
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(path.join(ROOT, 'src/ui/index.html'), 'utf-8');

function marketplaces() {
  const open = html.indexOf('const AMZ_MARKETPLACES = {');
  const end = html.indexOf('const amzMarketplace =', open);
  assert.ok(open !== -1 && end > open, 'AMZ_MARKETPLACES 블록을 못 찾았다 — 이름이 바뀌었나?');
  const body = html.slice(open + 'const AMZ_MARKETPLACES = '.length, end).trim().replace(/;$/, '');
  return eval('(' + body + ')');   // eslint-disable-line no-eval
}

const 차량 = { brand: 'BMW', model: '1 Series', gen: '2nd gen', year: '12.03~19', code: 'F20 F21' };

test('미국 상품명은 브랜드·차종·세대·연식·차량코드를 정해진 자리에 끼운다', () => {
  const title = marketplaces().ATVPDKIKX0DER.title(차량);
  assert.equal(
    title,
    'OGWM Optic-Glass Heated Mirror Glass Replacement Wide Angle View Car Mirror for '
    + 'BMW 1 Series 2nd gen 12.03~19 F20 F21 '
    + 'Exterior Side View Accessories Left/Right 1 set'   // 좌우 한 쌍으로 판다
  );
});

test('빈 항목이 있어도 공백이 겹치지 않는다', () => {
  // 세대·차량코드가 없는 차종이 흔하다. 예전처럼 문자열을 이어붙이면 'for BMW  1 Series'
  // 처럼 공백이 두 번 들어가고, 그대로 아마존에 올라간다.
  const title = marketplaces().ATVPDKIKX0DER.title({ ...차량, gen: '', code: '' });
  assert.ok(!/ {2}/.test(title), `공백이 겹쳤다: ${title}`);
  assert.ok(title.includes('for BMW 1 Series 12.03~19 Exterior'), title);
});

test('일본 상품명도 같은 다섯 항목을 받는다', () => {
  const title = marketplaces().A1VC38T7YXB528.title(차량);
  for (const part of ['BMW', '1 Series', '2nd gen', '12.03~19', 'F20 F21']) {
    assert.ok(title.includes(part), `일본 제목에 "${part}" 가 빠졌다: ${title}`);
  }
  assert.ok(!/ {2}/.test(title), `공백이 겹쳤다: ${title}`);
});

test('아마존 제목 길이 한도가 코드에 남아 있다', () => {
  // 200자를 넘기면 아마존이 등록을 거부하는데, 사유가 '길다' 가 아니라 속성 오류로 온다.
  // 한도를 지우면 그 경고가 조용히 사라지므로 상수 자체를 고정한다.
  assert.match(html, /const AMZ_TITLE_MAX = 200;/);
  assert.match(html, /title\.length > AMZ_TITLE_MAX/);
});

test('셸이 채우는 다섯 칸이 폼에 모두 있다', () => {
  // fillIframe 이 setVal 로 쓰는 id 들. 하나라도 지우면 그 항목만 제목에서 조용히 빠진다.
  for (const id of ['amzBrand', 'amzModel', 'amzGen', 'amzYear', 'amzCode']) {
    assert.ok(html.includes(`id="${id}"`), `${id} 입력칸이 없다`);
  }
  const shell = readFileSync(path.join(ROOT, 'src/ui/index_up.html'), 'utf-8');
  for (const id of ['amzBrand', 'amzModel', 'amzGen', 'amzYear', 'amzCode']) {
    assert.ok(shell.includes(`setVal('${id}'`), `셸이 ${id} 를 채우지 않는다`);
  }
});

// ── eBay ────────────────────────────────────────────────────────────────
// eBay 제목은 80자다. 아마존(200자)과 달라서 같은 문형을 쓸 수 없다.
const ebay = readFileSync(path.join(ROOT, 'src/ui/ebay.js'), 'utf-8');

function ebTitleFor() {
  const open = ebay.indexOf('const ebTitleFor = ');
  assert.ok(open !== -1, 'ebTitleFor 를 못 찾았다 — 이름이 바뀌었나?');
  const end = ebay.indexOf(';', ebay.indexOf(".join(' ')", open));
  return eval('(' + ebay.slice(open + 'const ebTitleFor = '.length, end) + ')');   // eslint-disable-line no-eval
}

// 실제 판매 중인 eBay 리스팅 그대로다. 아마존과 달리 차량코드·좌우 표기가 없고 BSA 만 붙는다.
// (원본 목록의 'LincolnNAUTILUS' 는 띄어쓰기가 빠진 오타라 여기서는 띄워 둔다.)
const 이베이예시 = [
  [{ brand: 'FORD', model: 'Bronco', generation: '6th gen', year: '22.03-', bsa: true },
   'Optic-glass Wide Angle View Car Mirror for FORD Bronco 6th gen 22.03- BSA'],
  [{ brand: 'Honda', model: 'Accord-C', generation: '10,11th gen', year: '18.11-23', bsa: false },
   'Optic-glass Wide Angle View Car Mirror for Honda Accord-C 10,11th gen 18.11-23'],
  [{ brand: 'Lincoln', model: 'NAUTILUS', generation: '2nd gen', year: '23.11-', bsa: true },
   'Optic-glass Wide Angle View Car Mirror for Lincoln NAUTILUS 2nd gen 23.11- BSA'],
  [{ brand: 'Toyota', model: 'GR86', generation: '2nd gen', year: '24-', bsa: false },
   'Optic-glass Wide Angle View Car Mirror for Toyota GR86 2nd gen 24-'],
  [{ brand: 'Honda', model: 'Civic', generation: '8th gen', year: '06-11', bsa: false },
   'Optic-glass Wide Angle View Car Mirror for Honda Civic 8th gen 06-11'],
];

test('이베이 제목이 판매 중인 리스팅과 같은 문형이다', () => {
  const build = ebTitleFor();
  for (const [d, want] of 이베이예시) assert.equal(build(d), want);
});

test('이베이 제목에는 차량코드가 들어가지 않는다', () => {
  // 아마존 제목에는 들어간다. 같은 데이터를 넘겨도 이베이는 빼야 한다.
  const title = ebTitleFor()({ ...이베이예시[0][0], code: 'U725' });
  assert.ok(!title.includes('U725'), title);
});

test('판매 중인 이베이 예시는 모두 80자 안에 든다', () => {
  const build = ebTitleFor();
  for (const [d] of 이베이예시) {
    const t = build(d);
    assert.ok(t.length <= 80, `${t.length}자: ${t}`);
  }
});

test('이베이 제목 길이 한도가 코드에 남아 있다', () => {
  assert.match(ebay, /const EB_TITLE_MAX = 80;/);
  assert.match(ebay, /n > EB_TITLE_MAX/);
});

test('이베이도 셸이 넘긴 값으로 제목을 채운다', () => {
  // 예전에는 설명만 채우고 제목은 빈 칸이었다 — 같은 값을 손으로 다시 적어야 했다.
  // 지금은 셸이 좌측 칸이 바뀔 때마다 직접 채우고(다른 몰 탭과 같은 방식), 문형은 ebay.js 가 준다.
  assert.match(ebay, /window\.ebayTitleFor = ebTitleFor;/, 'ebay.js 가 제목 문형을 내주지 않는다');
  assert.ok(ebay.includes("$('ebTitle').value = ebTitleFor(data)"),
            '셸 없이 쓰는 ebayImportCommon 이 제목을 채우지 않는다');

  // 셸이 다섯 항목을 다 넘기는지. 하나라도 빠지면 그 항목만 제목에서 조용히 사라진다.
  const shell = readFileSync(path.join(ROOT, 'src/ui/index_up.html'), 'utf-8');
  const at = shell.indexOf('const ebData = {');
  assert.ok(at !== -1, '셸이 이베이 제목 재료(ebData)를 만들지 않는다');
  const call = shell.slice(at, shell.indexOf('};', at));
  // bsa 는 제목 끝 'BSA' 를 가른다 — 빠지면 BSA 상품이 일반 상품 이름으로 올라간다.
  for (const key of ['brand:', 'model:', 'generation:', 'year', 'code', 'bsa']) {
    assert.ok(call.includes(key), `ebData 에 ${key} 가 없다`);
  }
  assert.match(shell, /setVal\('ebTitle', [^\n]*win\.ebayTitleFor\(ebData\)/, '셸이 ebTitle 을 채우지 않는다');
});

// 이베이 표의 연식 칸은 사람이 친 서수가 틀린 곳이 있다('3th gen', '2st gen', '3nd gen BSA').
// 표에서 제목 후보를 만들 때 그대로 쓰면 틀린 영어가 제목에 박힌다.
test('이베이 표 제목 후보는 틀린 서수를 바로잡는다', () => {
  const pick = (start, end) => { const i = shellSrc.indexOf(start); assert.ok(i !== -1, start); return shellSrc.slice(i, shellSrc.indexOf(end, i) + end.length); };
  const ordinal = pick('function ordinalOf(', '\n}\n');
  const fix = pick('function fixOrdinals(', '\n}\n');
  const f = new Function(`${ordinal}\n${fix}\nreturn fixOrdinals;`)();
  assert.equal(f('3th gen'), '3rd gen');
  assert.equal(f('1th gen, 2th gen F26'), '1st gen, 2nd gen F26');
  assert.equal(f('3nd gen BSA'), '3rd gen BSA');
  assert.equal(f('11st gen 20-'), '11th gen 20-');
  assert.equal(f('2nd gen 12-16'), '2nd gen 12-16');   // 맞는 건 그대로
});

// ── 네이버 · 쿠팡 ────────────────────────────────────────────────────────
// 기준은 실제 등록된 상품명(CSV DB)이다. 국내몰은 제목에 세대·차량코드를 넣지 않는다 —
// 세대·연식·상품번호는 쿠팡에서 '옵션' 으로 붙는다. 아래 기대값은 운영 중인 상품명 그대로다.
const shellSrc = readFileSync(path.join(ROOT, 'src/ui/index_up.html'), 'utf-8');

function krTitle(fnName) {
  // updateTitlePreview / updateCoupangTitle 의 자동차 분기 문형만 잘라 평가한다.
  const at = html.indexOf(`function ${fnName}()`);
  assert.ok(at !== -1, `${fnName} 가 없다`);
  const body = html.slice(at, html.indexOf('\n        }', at));
  const m = body.match(/title = (`옵틱글래스 \$\{brand\} \$\{model\}[^`]*`)(\.replace\([^)]*\)\.trim\(\))/);
  assert.ok(m, `${fnName} 의 자동차 문형을 못 찾았다`);
  return new Function('brand', 'model', `return ${m[1]}${m[2]};`);
}

const 국내예시 = [
  ['테슬라', '사이버트럭',         '옵틱글래스 테슬라 사이버트럭 광각 사이드 와이드미러'],
  ['혼다',   '어코드',             '옵틱글래스 혼다 어코드 광각 사이드 와이드미러'],
  ['토요타', 'GR86',               '옵틱글래스 토요타 GR86 광각 사이드 와이드미러'],
  ['테슬라', '모델Y 주니퍼 RWD',   '옵틱글래스 테슬라 모델Y 주니퍼 RWD 광각 사이드 와이드미러'],
];

for (const fn of ['updateTitlePreview', 'updateCoupangTitle']) {
  test(`${fn} 가 운영 중인 상품명과 같은 문형을 만든다`, () => {
    const build = krTitle(fn);
    for (const [brand, model, want] of 국내예시) assert.equal(build(brand, model), want);
  });
}

// 쿠팡 옵션(모델명) — 셸이 만든다. 파일에 들어간 식을 그대로 잘라 평가한다.
function cpOption() {
  const pick = (start, end) => { const i = shellSrc.indexOf(start); assert.ok(i !== -1, start); return shellSrc.slice(i, shellSrc.indexOf(end, i) + end.length); };
  const bare = pick('const bareNo = (() => {', '})();');
  const yr   = pick('const yearUnlessIn = ', ': year;');
  const gy   = pick('const cpGenYear = ', "join('/');");
  const rest = shellSrc.slice(shellSrc.indexOf("setVal('cpOptModel', ") + "setVal('cpOptModel', ".length);
  const expr = rest.slice(0, rest.indexOf(');\n'));
  return new Function('no', 'gen', 'year', 'bsa', `${bare}\n${yr}\n${gy}\nreturn ${expr};`);
}

test('쿠팡 옵션이 운영 중인 표기와 같다 (No.번호번 (세대/연식))', () => {
  assert.equal(cpOption()('H131', '7세대', '21.07-', false), 'No.H131번 (7세대/21.07-)');
});

test('CSV DB 의 상품번호를 그대로 붙여 넣어도 No. 이 겹치지 않는다', () => {
  // DB 표기는 'No.101번' / 'No.H131번(옵)' / 'No.H123-1번 (옵) 각진모양' 이다.
  const opt = cpOption();
  assert.equal(opt('No.5037번', '3세대', '12-현재', false), 'No.5037번 (3세대/12-현재)');
  assert.equal(opt('No.H131번(옵)', '7세대', '21.07-', false), 'No.H131번 (7세대/21.07-)');
  assert.equal(opt('No.H123-1번 (옵) 각진모양', '5세대', '09.11-15.06', false), 'No.H123-1번 (5세대/09.11-15.06)');
});

test('상품번호를 소문자로 쳐도 쿠팡 옵션은 정본 표기(대문자)로 나간다', () => {
  assert.equal(cpOption()('h131', '7세대', '21.07-', false), 'No.H131번 (7세대/21.07-)');
});

test('세대·연식이 비면 괄호를 남기지 않는다', () => {
  assert.equal(cpOption()('101', '', '', false), 'No.101번');
});

test('세대에 연식이 이미 들어 있으면 연식을 또 붙이지 않는다', () => {
  // DB 세대 칸은 '2세대 12.03~19.05' 처럼 연식을 품는다.
  const got = cpOption()('101', '2세대 12.03~19.05', '12.03~19.05', false);
  assert.equal(got, 'No.101번 (2세대 12.03~19.05)');
  assert.equal(got.split('12.03~19.05').length - 1, 1, `연식이 두 번 들어갔다: ${got}`);
});

test('아마존 SKU 는 표의 SKU 를 쓰고, 번호로 지어내지 않는다', () => {
  // SKU 는 아마존이 리스팅을 구분하는 열쇠다. 지어낸 SKU 는 다른 리스팅을 덮어쓴다:
  //   · 차량코드로 — 여러 상품이 같이 쓴다(W211 → 339·340·341번)
  //   · 상품번호로 — No.101 을 BMW 1~7시리즈가 같이 쓰는데 리스팅은 차종마다 따로다
  //                  (1시리즈 OBM0103N101 / 4시리즈 OBM0401N101)
  // 둘 다 한 번씩 이렇게 만들었다가 되돌렸다. 다시 들어오지 않게 막는다.
  // 아마존 SKU 는 좌측 아마존 SKU 칸(아마존에 실제로 있는 SKU)이다 — 이베이 SKU 와 다를 수 있다.
  assert.match(shellSrc, /setVal\('amzSku', amzSku\)/);
  assert.match(shellSrc, /const amzSku\s*=\s*\$\('inp-amz-sku'\)/);
  assert.doesNotMatch(shellSrc, /OPT-\$\{/, '번호로 SKU 를 지어내고 있다');
});

test('SKU 가 좌측 상품번호의 것이 아니면 채우기 전에 경고한다', () => {
  // SKU 끝의 N 뒤가 상품번호다(OBM0103N101 → 101). 사람이 SKU 를 손으로 고쳤거나
  // 차를 바꾼 뒤 남은 SKU 면 여기서 걸린다.
  assert.match(shellSrc, /의 것이 아닙니다/);
  assert.match(shellSrc, /skuNo\.slice\(0, -1\)/, 'BSA 판 SKU(N11021) 의 끝자리 1 을 봐주지 않는다');
});

// ── 영문 세대 표기 ──────────────────────────────────────────────────────
// 실제 상품명은 '2nd gen' 인데 사전은 944개 중 793개가 '2Gen' 이고 6세대·10세대는 아예 없다.
// genEn 이 그 차이를 메운다. 이게 깨지면 아마존·이베이 제목 전부에 '2Gen' 이나 한글이 박힌다.
function genEn() {
  const a = shellSrc.indexOf('const GEN_EN_TOKENS = [');
  const b = shellSrc.indexOf('\n}\n', shellSrc.indexOf('function genEn(')) + 3;
  assert.ok(a !== -1 && b > a, 'genEn 을 못 찾았다');
  return new Function(shellSrc.slice(a, b) + '\nreturn genEn;')();
}

test('영문 세대는 판매 상품명처럼 서수 + 소문자 gen 이다', () => {
  const f = genEn();
  assert.equal(f('2세대', '2Gen'), '2nd gen');       // 사전의 흔한 꼴
  assert.equal(f('2세대', '2nd Gen'), '2nd gen');    // 사전의 드문 꼴
  assert.equal(f('6세대', null), '6th gen');          // 사전에 없는 세대
  assert.equal(f('1세대', '1Gen'), '1st gen');
  assert.equal(f('3세대', '3Gen'), '3rd gen');
});

test('서수 접미사가 11·12·13 과 두 자리 수에서 맞다', () => {
  const f = genEn();
  assert.equal(f('11세대', null), '11th gen');   // 11st 가 아니다
  assert.equal(f('12세대', null), '12th gen');
  assert.equal(f('22세대', null), '22nd gen');
  assert.equal(f('10,11세대', null), '10,11th gen');   // 이베이 예시: Honda Accord-C
  assert.equal(f('9.5세대', null), '9.5th gen');
});

test('세대 뒤 수식어는 사전과 같은 영어 낱말로 옮긴다', () => {
  const f = genEn();
  assert.equal(f('1세대 전기형', null), '1st gen Early');
  assert.equal(f('6세대 파생', null), '6th gen Derivative');
  assert.equal(f('1세대 페이스리프트', null), '1st gen Facelift');   // '페리' 로 먼저 잘리면 안 된다
  assert.equal(f('3세대 12-현재', null), '3rd gen 12-Present');
});

test('번역할 수 없는 한글이 남으면 지어내지 않고 비운다', () => {
  // 빈 값이면 호출부가 경고를 띄운다. 한글 섞인 영문 제목이 올라가는 것보다 낫다.
  assert.equal(genEn()('1세대 국내미출시', null), '');
});

// ── 영문 대소문자 ────────────────────────────────────────────────────────
// 사전 영문 차종은 1058건 중 927건이 전부 대문자다(CIVIC, BRONCO). 판매 상품명은 'Civic'.
function enTitleCase() {
  const a = shellSrc.indexOf('function enTitleCase(');
  const b = shellSrc.indexOf('\n}\n', a) + 3;
  assert.ok(a !== -1, 'enTitleCase 를 못 찾았다');
  return new Function(shellSrc.slice(a, b) + '\nreturn enTitleCase;')();
}

test('전부 대문자인 차종은 첫 글자만 대문자로', () => {
  const f = enTitleCase();
  assert.equal(f('CIVIC'), 'Civic');
  assert.equal(f('BRONCO'), 'Bronco');
  assert.equal(f('TOYOTA SUPRA'), 'Toyota Supra');
  assert.equal(f('ACCORD-C'), 'Accord-C');        // 하이픈 뒤도 따로
});

test('약어·차명 코드는 건드리지 않는다', () => {
  const f = enTitleCase();
  assert.equal(f('BMW'), 'BMW');                  // 세 글자 이하 대문자
  assert.equal(f('GLE CLASS'), 'GLE Class');
  assert.equal(f('GR86'), 'GR86');                // 숫자가 섞인 낱말
  assert.equal(f('EV3'), 'EV3');
  assert.equal(f('MODEL Y'), 'Model Y');
});

test('붙어 있는 1series 는 띄워서 1 Series', () => {
  // 지난번 아마존 예시가 'BMW 1 Series' 였다. 사전은 '1series'.
  assert.equal(enTitleCase()('1series'), '1 Series');
  assert.equal(enTitleCase()('3GT'), '3GT');       // 대문자 붙음은 차명 — 띄우지 않는다
});

test('이미 대소문자가 섞인 낱말은 누가 일부러 적은 것이라 그대로 둔다', () => {
  const f = enTitleCase();
  assert.equal(f('Kia'), 'Kia');
  assert.equal(f('iX'), 'iX');
  assert.equal(f(''), '');
  assert.equal(f(null), '');
});
