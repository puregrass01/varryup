import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const catalog = JSON.parse(fs.readFileSync('data/vehicle_catalog.json', 'utf8'));
const listing = catalog.listings.find(l => l.no && l.priceUsd > 0);
assert.ok(listing, 'Excel catalog must contain a priced listing');
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.EBAY_TEST_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  args: ['--allow-file-access-from-files'] });
const expected = (amount, currency = 'USD') => {
  const rates = { USD: 1, JPY: 150, KRW: 1350 };
  return ['USD', 'JPY', 'KRW'].map(c => c + ' ' + (amount / rates[currency] * rates[c]).toLocaleString('ko-KR',
    { minimumFractionDigits: 2, maximumFractionDigits: 2 })).join(' · ');
};
try {
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  await context.route(/^https?:/, route => route.abort());
  await context.addInitScript(({ catalog }) => {
    window.fxState = 'ok';
    window.calls = [];
    window.require = () => ({ ipcRenderer: { on() {}, send() {}, async invoke(channel, data) {
      window.calls.push(channel);
      if (channel === 'currency-rates-get') {
        if (window.fxState === 'missing') throw new Error("Error invoking remote method 'currency-rates-get': Error: No handler registered for 'currency-rates-get'");
        return { success: true, data: { base: 'USD', rates: { USD: 1, JPY: 150, KRW: window.fxState === 'changed' ? 1400 : 1350 },
          marketDate: '2026-09-28', fetchedAt: new Date().toISOString(), stale: window.fxState === 'stale' } };
      }
      if (channel === 'vehicle-load-catalog') return { success: true, catalog };
      if (channel === 'veryup-get-mode') return new URLSearchParams(location.search).get('mode') || 'new';
      if (channel === 'amazon-load-product') return { success: true, product: {
        title: 'API current price', price: data.marketplaceId === 'A1VC38T7YXB528' ? 3000 : 49.99, stock: 5, sku: data.sku,
      } };
      if (channel === 'ebay-load-config') return { success: true, data: { environment: 'sandbox' } };
      if (channel === 'ebay-load-product') return { success: true, data: {
        sku: data, inventory: { product: { title: 'eBay API item' } },
        offer: { offerId: 'test', status: 'PUBLISHED', availableQuantity: 1, pricingSummary: { price: { value: '59.99', currency: 'USD' } } },
      } };
      return { success: false };
    } } });
  }, { catalog });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const url = pathToFileURL(path.resolve('src/ui/index_up.html')).href;
  await page.goto(url);
  await page.waitForFunction(() => window.VUCurrency?.convert(1, 'USD', 'KRW') === 1350);
  assert.equal(await page.locator('#currency-rates, #fx-apply, #fx-amount').count(), 0);
  assert.equal(await page.getByText('환율 · 가격 환산표', { exact: true }).count(), 0);

  // Choose the real Excel-derived SKU from the existing price catalog.
  await page.locator('#cell-USA-open1').click();
  await page.locator('#inp-no').fill(listing.no);
  await page.locator('#inp-amz-sku').fill(listing.sku);   // 아마존만 켰다 — SKU 칸은 아마존 칸이다
  await page.locator('.vu-combo-item').filter({ hasText: listing.sku }).first().click();
  assert.equal(await page.locator('#inp-usd').inputValue(), listing.priceUsd.toFixed(2));
  await page.locator('label[for="inp-usd"]').hover();
  assert.equal(await page.locator('label[for="inp-usd"]').getAttribute('title'), expected(listing.priceUsd));
  assert.equal(await page.locator('#inp-usd').getAttribute('title'), expected(listing.priceUsd));

  await page.evaluate(() => openPlatformTab('amazonTab', 'USA'));

  // Manual edits and invalid/empty values cannot leave an old tooltip behind.
  await page.locator('#inp-usd').fill('100');
  assert.equal(await page.locator('#inp-usd').getAttribute('title'), expected(100));
  await page.locator('#inp-usd').fill('');
  assert.equal(await page.locator('#inp-usd').getAttribute('title'), null);
  await page.locator('#inp-usd').fill('12oops');
  assert.equal(await page.locator('#inp-usd').getAttribute('title'), null);

  // API-loaded edit prices take precedence over the unrelated catalog price.
  await page.locator('label[for="mode-edit"]').click();
  const frame = page.frameLocator('#form-frame');
  await page.waitForFunction(() => !!document.getElementById('form-frame').contentDocument.getElementById('amzSku').value);
  await frame.locator('#amzLoadBtn').click();
  await frame.locator('#amzPrice').hover();
  assert.equal(await frame.locator('#amzPrice').inputValue(), '49.99');
  assert.equal(await frame.locator('#amzPrice').getAttribute('title'), expected(49.99));
  await page.locator('#cell-JAPAN-open1').click();
  await page.waitForFunction(() => !!document.getElementById('form-frame').contentDocument.getElementById('amzSku').value);
  await frame.locator('#amzLoadBtn').click();
  await frame.locator('#amzPrice').hover();
  assert.equal(await frame.locator('#amzPrice').getAttribute('title'), expected(3000, 'JPY'));
  await page.locator('#cell-USA-open2').click();
  // 이베이 조회 SKU 칸은 숨었고 좌측 이베이 SKU 가 넣는다 — 빈 SKU 로는 불러오지 않는다.
  await page.locator('#inp-sku').fill('EB-1');
  await page.waitForFunction(() => document.getElementById('form-frame').contentDocument.getElementById('ebEditSku').value === 'EB-1');
  await frame.locator('[data-eb="load"]').click();
  await frame.locator('#ebEditPrice').hover();
  assert.equal(await frame.locator('#ebEditPrice').getAttribute('title'), expected(59.99));
  assert.equal(await frame.locator('#ebEditPrice').inputValue(), '59.99');

  await page.evaluate(() => { window.fxState = 'stale'; window.dispatchEvent(new Event('focus')); });
  await page.waitForFunction(() => window.VUCurrency.convert(1, 'USD', 'KRW') === null);
  await frame.locator('#ebEditPrice').hover();
  assert.match(await frame.locator('#ebEditPrice').getAttribute('title'), /최신 환율/);
  assert.equal(await frame.locator('#ebEditPrice').inputValue(), '59.99');

  // Old main process: friendly tooltip, no raw remote-method error in the screen.
  await page.evaluate(() => { window.fxState = 'missing'; window.dispatchEvent(new Event('focus')); });
  await page.waitForFunction(() => document.getElementById('form-frame').contentDocument.getElementById('ebEditPrice').title.includes('다시 실행'));
  assert.ok(!(await page.locator('body').innerText()).includes('No handler registered'));
  assert.ok(!(await frame.locator('#ebEditPrice').getAttribute('title')).includes('currency-rates-get'));
  const child = page.frames().find(f => f.url().includes('/index.html'));
  assert.deepEqual(await child.evaluate(() => window.calls.filter(c => /register|update-product|create-draft|publish/.test(c))), []);
  fs.mkdirSync('scratch', { recursive: true });
  await page.screenshot({ path: 'scratch/currency-tooltip-layout.png' });
  assert.deepEqual(errors, []);
  console.log('Tooltip UI passed: Excel catalog, API prices, USD/JPY conversion, edits, stale/missing IPC, no writes.');
} finally {
  await browser.close();
}
