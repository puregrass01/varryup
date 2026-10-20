import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const read = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const browser = await chromium.launch({ headless: true, executablePath: process.env.EBAY_TEST_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe', args: ['--allow-file-access-from-files'] });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
  await context.route(/^https?:/, route => route.abort());
  await context.addInitScript(({ names, catalog, categories }) => {
    window.calls = [];
    window.require = () => ({ ipcRenderer: { on() {}, send() {}, async invoke(channel, data) {
      calls.push({ channel, data });
      if (channel === 'vehicle-load-i18n') return { success: true, names };
      if (channel === 'vehicle-load-catalog') return { success: true, catalog };
      if (channel === 'imweb-load-categories') return { success: true, categories };
      if (channel === 'veryup-get-mode') return 'new';
      return {};
    } } });
  }, { names: read('data/vehicle_i18n.json'), catalog: { ...read('data/vehicle_catalog.json'), japan: read('data/japan_vehicle_catalog.json') }, categories: read('data/imweb_categories.json') });
  const page = await context.newPage(), errors = [];
  page.setDefaultTimeout(8000);
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(pathToFileURL(path.resolve('src/ui/index_up.html')).href);
  await page.waitForFunction(() => VUSuggest.namesReady() && VUSuggest.variantsFor('도요타', '시에나').length);
  await page.locator('#cell-JAPAN-own').click();
  assert.equal(await page.evaluate(() => VUSuggest.japanMode()), true);
  await page.locator('#inp-brand').fill('도요타');
  await page.locator('#inp-carmodel').fill('시엔타');
  await page.locator('#inp-gen').fill('3세대');
  const choice = page.getByRole('option').filter({ hasText: 'XP210' });
  await choice.waitFor(); await choice.click();
  assert.equal(await page.locator('#inp-carmodel-ja').inputValue(), 'シエンタ');
  assert.equal(await page.locator('#inp-gen-ja').inputValue(), '3世代');
  assert.equal(await page.locator('#inp-year').inputValue(), '2022 ~ 현재');
  assert.equal(await page.locator('#inp-code').inputValue(), 'XP210');
  assert.equal(await page.locator('#inp-no').inputValue(), '');
  assert.equal(await page.locator('#inp-sku').inputValue(), '');

  await page.locator('#inp-carmodel').fill('라이즈');
  await page.locator('#inp-gen').fill('후기');
  await page.getByRole('option').filter({ hasText: 'A201A / A202A' }).click();
  assert.equal(await page.locator('#inp-gen').inputValue(), '1세대 후기형');
  assert.equal(await page.locator('#inp-gen-ja').inputValue(), '1世代 後期型');

  await page.locator('#inp-brand').fill('스즈키');
  await page.locator('#inp-carmodel').fill('스페이시아');
  assert.equal(await page.locator('#inp-kind-car').isChecked(), true);
  // 차를 바꾸면 앞 차(라이즈)에서 고른 세대·연식·차량코드가 남지 않는다.
  assert.deepEqual(await page.evaluate(() => ['inp-gen', 'inp-year', 'inp-code'].map(id => document.getElementById(id).value)), ['', '', '']);
  await page.locator('#inp-gen').fill('');
  await page.getByRole('option').last().click();
  assert.equal(await page.locator('#inp-carmodel-ja').inputValue(), 'スペーシア');

  // A manually entered Japanese spelling must survive dictionary refreshes.
  await page.locator('#inp-carmodel-ja').fill('確認済み表記');
  await page.evaluate(() => autoFillLang());
  assert.equal(await page.locator('#inp-carmodel-ja').inputValue(), '確認済み表記');
  await page.locator('#inp-carmodel-ja').fill('');
  await page.evaluate(() => autoFillLang());
  await page.locator('#inp-brand').fill('혼다');
  await page.locator('#inp-carmodel').fill('N-BOX');
  await page.locator('#inp-gen').fill('JF5');
  await page.locator('#inp-gen').press('Tab');
  assert.equal(await page.locator('#inp-code').inputValue(), 'JF5 / JF6');
  assert.equal(await page.locator('#inp-carmodel-ja').inputValue(), 'Nボックス');
  fs.mkdirSync('scratch', { recursive: true });
  await page.locator('#inp-brand').evaluate(el => el.closest('.section-box')?.scrollIntoView());
  await page.screenshot({ path: 'scratch/japan-catalog-preview.png' });
  assert.equal(await page.evaluate(() => calls.some(c => /register|publish|update-product/.test(c.channel))), false);
  await page.locator('#cell-JAPAN-own').click();
  assert.equal(await page.evaluate(() => VUSuggest.japanMode()), false);
  assert.deepEqual(errors, []);
  console.log('Japan catalog UI passed: native names, coordinated generation/year/series, manual overrides, no SKU guesses and no writes.');
} finally { await browser.close(); }
