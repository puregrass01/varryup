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

const browser = await chromium.launch({
  headless: true,
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  args: ['--allow-file-access-from-files'],
});

async function fresh() {
  const context = await browser.newContext();
  await context.route(/^https?:/, r => r.abort());
  await context.addInitScript(({ names, categories, vehicleCatalog }) => {
    const ipcRenderer = {
      on() {}, send() {}, removeListener() {},
      invoke(ch) {
        if (ch === 'vehicle-load-i18n') return Promise.resolve({ success: true, names });
        if (ch === 'imweb-load-categories') return Promise.resolve({ success: true, categories });
        if (ch === 'vehicle-load-catalog') return Promise.resolve({ success: true, catalog: vehicleCatalog });
        return Promise.resolve({});
      },
    };
    window.require = () => ({ ipcRenderer, shell: {} });
  }, { names, categories, vehicleCatalog });
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
  return { year: v('inp-year'), gen: v('inp-gen'), code: v('inp-code'), no: v('inp-no'),
           sku: v('inp-sku'), usd: v('inp-usd'), cpid: v('inp-cpid') };
});

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
