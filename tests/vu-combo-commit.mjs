// 좌측 '상품 정보' 목록 칸의 두 사고를 막는다. 실제 셸(index_up.html)을 띄우고 사람이 하듯 조작한다.
//
// 1) 검색어가 값으로 남는다 — 연식·차량코드·상품번호 목록은 '1세대 · BYD SF · No.1702' 처럼 행 전체
//    글로 걸러져서, 연식 칸에 상품번호 1702 를 쳐서 차를 찾게 된다. 예전에는 Enter·Tab·바깥 클릭이
//    항목을 고르지 않아 연식이 '1702' 가 됐다. 행이 하나로 좁혀졌고 그 글자가 이 칸 값의 일부가
//    아니면(= 검색어면) 그 행을 고른다. 값의 일부('17.09')를 치는 중이면 건드리지 않는다.
// 2) 앞 차의 SKU 가 남는다 — BMW 6GT 에서 SKU 목록으로 고른 OBM2105N181 이 BYD 씨라이언7 로 바꾼
//    뒤에도 남았다. 그대로 올리면 아마존은 SKU 로 덮어써 BMW 리스팅이 BYD 가 된다. 차가 바뀌면
//    SKU·판매가·쿠팡ID 를 버리고, 같은 차에서 BSA 만 바꿀 때는 사람이 고른 값을 지킨다.
//
// 3) 본사몰 상품 찾기 — 상품명을 고르면 브랜드·차종부터 넣고 행(세대·연식·코드·번호·SKU)을 채운다. 다른 상품을
//    고르면 앞 상품의 SKU 를 버린다. 목록(bulk-price-list)은 시작 때가 아니라 그 칸을 처음 누를 때 읽는다(아임웹 잠금).
//
// 버튼은 누르지 않는다 — 폼에 값만 오가고 등록은 일어나지 않는다.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = f => JSON.parse(readFileSync(path.join(ROOT, f), 'utf-8'));
const names = load('data/vehicle_i18n.json');
const categories = load('data/imweb_categories.json');
const vehicleCatalog = load('data/vehicle_catalog.json');
const products = [   // bulk-price-list(imweb-ko) 의 모양 그대로
  { id: '1760', name: '옵틱글래스 현대 아반떼N 광각미러 [No.H131]' },
  { id: '1738', name: '옵틱글래스 현대 넥쏘 광각미러 [No.H119]' },
  { id: '1900', name: '현대 넥쏘 전동 사이드스텝 Pro (기본형/LED)', variant: '숨김(판매 안 함)' },   // [No.] 없음
  { id: '2140', name: '옵틱글래스 벤츠 C클래스 (전기형) 광각미러 [No.340]' },   // 행 못 정함(2세대 전기형·후기형)
  { id: '2141', name: '옵틱글래스 벤츠 C클래스 광각미러 [No.377]' },
];

const browser = await chromium.launch({
  headless: true,
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  args: ['--allow-file-access-from-files'],
});

async function fresh() {
  const context = await browser.newContext();
  await context.route(/^https?:/, r => r.abort());
  await context.addInitScript(({ names, categories, vehicleCatalog, products }) => {
    window.__bulkListCalls = 0;
    const ipcRenderer = {
      on() {}, send() {}, removeListener() {},
      invoke(ch, input) {
        if (ch === 'vehicle-load-i18n') return Promise.resolve({ success: true, names });
        if (ch === 'imweb-load-categories') return Promise.resolve({ success: true, categories });
        if (ch === 'vehicle-load-catalog') return Promise.resolve({ success: true, catalog: vehicleCatalog });
        if (ch === 'bulk-price-list' && input?.scope === 'imweb-ko') {
          window.__bulkListCalls++;
          return Promise.resolve({ success: true, data: { items: products } });
        }
        return Promise.resolve({});
      },
    };
    window.require = () => ({ ipcRenderer, shell: {} });
  }, { names, categories, vehicleCatalog, products });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(pathToFileURL(path.join(ROOT, 'src/ui/index_up.html')).href);
  await page.waitForFunction(() => (window.VUSuggest?.variantsFor?.('BMW', '1시리즈') || []).length > 0, null, { timeout: 15000 });
  return { page, context, errors };
}

const type = (page, id, value) => page.evaluate(([id, value]) => {
  const el = document.getElementById(id);
  el.focus(); el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}, [id, value]);

// 칸에 글자를 쳐서 목록을 거르기만 한다(항목은 누르지 않는다).
const filter = (page, id, text) => page.evaluate(([id, text]) => {
  const el = document.getElementById(id);
  el.focus(); el.value = text;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}, [id, text]);

// 목록을 열고 보이는 글로 항목을 찾아 누른다.
const pick = async (page, id, text) => {
  const missing = await page.evaluate(([id, text]) => {
    const el = document.getElementById(id);
    el.focus(); el.value = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    const rows = [...document.querySelectorAll('.vu-combo-item')];
    const row = rows.find(r => r.textContent.includes(text));
    if (!row) return rows.map(r => r.textContent).slice(0, 6);
    row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    el.blur();
    return null;
  }, [id, text]);
  if (missing) throw new Error(`${id} 목록에 "${text}" 가 없다. 보이는 것: ${JSON.stringify(missing)}`);
};

const read = page => page.evaluate(() => {
  const v = id => document.getElementById(id).value;
  return { brand: v('inp-brand'), carmodel: v('inp-carmodel'),
           year: v('inp-year'), gen: v('inp-gen'), code: v('inp-code'), no: v('inp-no'),
           sku: v('inp-sku'), usd: v('inp-usd'), cpid: v('inp-cpid') };
});

// 본사몰 상품 찾기 칸을 눌러 목록이 도착할 때까지 기다린다(처음 누를 때 읽는다).
const openDb = async page => {
  await page.focus('#inp-db-search');
  await page.waitForFunction(() => document.querySelectorAll('.vu-combo-item').length >= 2, null, { timeout: 5000 });
};
const shownRows = page => page.evaluate(() => [...document.querySelectorAll('.vu-combo-item')].map(r => r.textContent));
// 카탈로그(data/vehicle_catalog.json): 넥쏘 1세대 · 18~ · FE · No.H119 → 이베이 표 HY1001NH119(BSA, 160.34) · 쿠팡 13705865676
const NEXO = { brand: '현대', carmodel: '넥쏘', gen: '1세대', year: '18~', code: 'FE', no: 'H119',
               sku: 'HY1001NH119', usd: '160.34', cpid: '13705865676' };

const BYD_ROW = { year: '', gen: '1세대', code: 'BYD SF', no: '1702', sku: '', usd: '' };   // 카탈로그: 연식 빈 칸, SKU 없음

const cases = [
  ['연식 칸에 상품번호를 쳐서 찾고 Enter → 그 행을 고른다', async p => {
    await type(p, 'inp-brand', 'BYD'); await type(p, 'inp-carmodel', '씨라이언7');
    await filter(p, 'inp-year', '1702'); await p.keyboard.press('Enter');
  }, BYD_ROW],
  ['연식 칸에 상품번호를 쳐서 찾고 Tab → 그 행을 고른다', async p => {
    await type(p, 'inp-brand', 'BYD'); await type(p, 'inp-carmodel', '씨라이언7');
    await filter(p, 'inp-year', '1702'); await p.keyboard.press('Tab');
  }, BYD_ROW],
  ['연식 칸에 상품번호를 쳐서 찾고 다른 칸 클릭 → 그 행을 고른다', async p => {
    await type(p, 'inp-brand', 'BYD'); await type(p, 'inp-carmodel', '씨라이언7');
    await filter(p, 'inp-year', '1702'); await p.click('#inp-code');
  }, BYD_ROW],
  ['연식 값의 일부를 치고 Tab → 사람이 적는 중이므로 그대로 둔다', async p => {
    await type(p, 'inp-brand', 'BMW'); await type(p, 'inp-carmodel', '6GT');
    await filter(p, 'inp-year', '17.09'); await p.keyboard.press('Tab');
  }, { year: '17.09', no: '' }],
  ['BMW 6GT 에서 SKU 를 목록으로 고른 뒤 BYD 로 바꾸면 앞 차 SKU·판매가를 버린다', async p => {
    await type(p, 'inp-brand', 'BMW'); await type(p, 'inp-carmodel', '6GT');
    await pick(p, 'inp-year', 'No.181');
    await pick(p, 'inp-sku', 'OBM2105N181');
    assert.equal((await read(p)).sku, 'OBM2105N181', '전제: SKU 를 골랐다');
    await type(p, 'inp-brand', 'BYD'); await type(p, 'inp-carmodel', '씨라이언7');
    await pick(p, 'inp-year', 'No.1702');
  }, { ...BYD_ROW, cpid: '16263476855' }],
  ['같은 차에서 SKU 를 고른 뒤 BSA 만 바꾸면 고른 SKU 를 지킨다', async p => {
    await type(p, 'inp-brand', 'BMW'); await type(p, 'inp-carmodel', '6GT');
    await pick(p, 'inp-year', 'No.181');
    await pick(p, 'inp-sku', 'OBM2105N181');
    await p.evaluate(() => document.querySelector('input[name="bsa"][value="x"]').click());
  }, { no: '181', sku: 'OBM2105N181', usd: '160.34' }],
  ['상품번호를 손으로 바꾸면 사람이 고른 SKU 도 버린다', async p => {
    await type(p, 'inp-brand', 'BMW'); await type(p, 'inp-carmodel', '6GT');
    await pick(p, 'inp-year', 'No.181');
    await pick(p, 'inp-sku', 'OBM2105N181');
    await type(p, 'inp-no', '182');
  }, { no: '182', sku: '', usd: '' }],
  ['본사몰 상품 목록은 시작 때 읽지 않고, 칸을 처음 누를 때 한 번 읽는다', async p => {
    assert.equal(await p.evaluate(() => window.__bulkListCalls), 0, '시작 때 읽었다');
    await openDb(p);
    await p.evaluate(() => document.getElementById('inp-db-search').blur());
    await openDb(p);
    assert.equal(await p.evaluate(() => window.__bulkListCalls), 1, '10분 안에 다시 읽었다');
  }, {}],
  ['본사몰 상품 찾기에 현대 를 치면 두 상품이 다 보인다', async p => {
    await openDb(p);
    await filter(p, 'inp-db-search', '현대');
    const rows = await shownRows(p);
    for (const x of products.slice(0, 2)) assert.ok(rows.includes(x.name), `${x.name} 이 없다: ${JSON.stringify(rows)}`);
    assert.ok(rows.includes(products[2].name + ' · 숨김(판매 안 함)'), '판매상태를 이름 뒤에 적는다');
  }, {}],
  ['본사몰 상품 찾기에서 넥쏘를 고르면(신규) 브랜드·차종·세대·연식·코드·번호·SKU 가 채워진다', async p => {
    await openDb(p);
    await pick(p, 'inp-db-search', '넥쏘 광각미러');
    assert.equal(await p.evaluate(() => document.querySelectorAll('.vu-combo').length), 0, '채운 칸의 목록이 열렸다');
  }, NEXO],
  ['아반떼N 을 고르고 SKU 를 목록으로 고른 뒤 넥쏘를 고르면 앞 차의 SKU 를 버린다', async p => {
    await openDb(p);
    await pick(p, 'inp-db-search', '아반떼N');
    const avante = await read(p);
    assert.deepEqual([avante.carmodel, avante.code, avante.no], ['아반떼', 'CN7 N', 'H131'], '전제: 아반떼N 행');
    await pick(p, 'inp-sku', 'HY0107NH131');   // 사람이 고른 값 — 차가 바뀌어도 자동으로는 안 바뀌는 값이다
    assert.equal((await read(p)).sku, 'HY0107NH131', '전제: SKU 를 골랐다');
    await openDb(p);
    await pick(p, 'inp-db-search', '넥쏘 광각미러');
  }, NEXO],
  ['넥쏘 미러 다음에 번호 없는 넥쏘 사이드스텝을 고르면 — 차종이 같아도 앞 상품의 행·SKU 를 버린다', async p => {
    await openDb(p);
    await pick(p, 'inp-db-search', '넥쏘 광각미러');
    assert.equal((await read(p)).sku, 'HY1001NH119', '전제: 미러의 SKU');
    await openDb(p);
    await pick(p, 'inp-db-search', '사이드스텝');
  }, { brand: '현대', carmodel: '넥쏘', gen: '', year: '', code: '', no: '', sku: '', usd: '', cpid: '' }],
  ['행을 못 정한 C클래스 No.340 에서 SKU 를 목록으로 고른 뒤 같은 차종의 No.377 을 고르면 앞 SKU 를 버린다', async p => {
    await openDb(p);
    await pick(p, 'inp-db-search', '(전기형)');
    await pick(p, 'inp-sku', 'MB0301N340');
    assert.equal((await read(p)).sku, 'MB0301N340', '전제: SKU 를 골랐다');
    await openDb(p);
    await pick(p, 'inp-db-search', '[No.377]');
    // MB0301N340 을 고를 때 BSA 가 X 로 넘어갔고, No.377 C클래스에는 BSA X 리스팅이 없다 → 비워 두고 사람이 고른다
  }, { brand: '벤츠', carmodel: 'C클래스', gen: '4세대', no: '377', sku: '', usd: '' }],
  ['수정 모드에서도 넥쏘를 고르면 찾는 열쇠(번호·SKU)가 채워진다', async p => {
    await p.locator('label[for="mode-edit"]').click();
    await openDb(p);
    await pick(p, 'inp-db-search', '넥쏘 광각미러');
  }, { brand: '현대', carmodel: '넥쏘', no: 'H119', sku: 'HY1001NH119', cpid: '13705865676' }],
];

let failed = 0;
try {
  for (const [name, run, expected] of cases) {
    const { page, context, errors } = await fresh();
    try {
      await run(page);
      const got = await read(page);
      for (const [k, v] of Object.entries(expected)) assert.equal(got[k], v, `${k}: ${JSON.stringify(got)}`);
      assert.deepEqual(errors, [], 'pageerror');
      console.log(`  OK  ${name}`);
    } catch (e) {
      failed++;
      console.log(`  NG  ${name}\n      ${e.message.split('\n')[0]}`);
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
}
console.log(`\n${cases.length - failed}/${cases.length} 통과`);
if (failed) process.exit(1);
