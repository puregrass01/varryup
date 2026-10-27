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
      if (channel === 'imweb-load-post') return { success: true, post: {
        postCode: data.postCode, subject: 'English API post', priceUsd: '88.25',
        images: ['https://example.test/image.jpg'] } };
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
  page.on('dialog', d => d.accept());   // 일괄 등록의 입력 확인 경고 confirm — 여기서는 환율 고정만 본다
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

  // English-only selection exposes the same Excel USD field and transfers it to the board.
  await page.locator('#cell-USA-own').click();
  await page.waitForFunction(price => document.getElementById('form-frame').contentDocument.getElementById('iwBoardPriceUsd').value === price, listing.priceUsd.toFixed(2));
  const boardInput = page.frameLocator('#form-frame').locator('#iwBoardPriceUsd');
  await boardInput.hover();
  assert.equal(await boardInput.getAttribute('title'), expected(listing.priceUsd));

  // A refresh mid-batch cannot change its exchange rate or USD source price.
  await page.evaluate(async () => {
    await window.VUCurrency.lockBatch(window.require('electron').ipcRenderer, '109.32');
    window.fxState = 'changed';
    window.dispatchEvent(new Event('focus'));
  });
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => window.VUCurrency.convert(1, 'USD', 'KRW')), 1350);
  assert.equal(await page.evaluate(() => window.VUCurrency.getBatchPriceUsd()), '109.32');
  await page.evaluate(() => window.VUCurrency.releaseBatch());
  assert.equal(await page.evaluate(() => window.VUCurrency.convert(1, 'USD', 'KRW')), 1400);
  await page.evaluate(() => { window.fxState = 'ok'; window.dispatchEvent(new Event('focus')); });
  await page.waitForFunction(() => window.VUCurrency.convert(1, 'USD', 'KRW') === 1350);
  // Return to the Amazon tab for existing API tests.
  await page.locator('#cell-USA-open1').click();

  // Exercise the actual bulk entry point with mocked platform execution: preflight
  // blocks every write on stale rates, then supplies one immutable snapshot.
  const bulk = await page.evaluate(async () => {
    const savedChecked = JSON.parse(JSON.stringify(checked));
    const win = document.getElementById('form-frame').contentWindow;
    const savedRegister = win.registerImwebBoard;
    const calls = [];
    for (const country of Object.keys(checked)) for (const key of Object.keys(checked[country])) checked[country][key] = false;
    checked.USA.own = true;
    document.getElementById('inp-usd').value = '109.32';
    win.registerImwebBoard = async () => {
      calls.push({ price: window.VUCurrency.getBatchPriceUsd(), krw: window.VUCurrency.getBatchSnapshot().rates.KRW });
      window.fxState = 'changed';
      window.dispatchEvent(new Event('focus'));
      await new Promise(r => setTimeout(r, 50));
      calls.push({ price: window.VUCurrency.getBatchPriceUsd(), krw: window.VUCurrency.getBatchSnapshot().rates.KRW });
      return { ok: true };
    };
    try {
      window.fxState = 'stale';
      await runBulkRegister();
      const blockedCalls = calls.length;
      window.fxState = 'ok';
      await runBulkRegister();
      return { blockedCalls, calls, released: window.VUCurrency.getBatchSnapshot() === null, running: isBulkRunning };
    } finally {
      win.registerImwebBoard = savedRegister;
      for (const country of Object.keys(savedChecked)) Object.assign(checked[country], savedChecked[country]);
      window.fxState = 'ok';
      window.dispatchEvent(new Event('focus'));
    }
  });
  assert.deepEqual(bulk, { blockedCalls: 0, calls: [
    { price: '109.32', krw: 1350 }, { price: '109.32', krw: 1350 } ], released: true, running: false });
  await page.waitForFunction(() => window.VUCurrency.convert(1, 'USD', 'KRW') === 1350);

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
  await frame.locator('[data-eb="load"]').click();
  await frame.locator('#ebEditPrice').hover();
  assert.equal(await frame.locator('#ebEditPrice').getAttribute('title'), expected(59.99));
  assert.equal(await frame.locator('#ebEditPrice').inputValue(), '59.99');

  const boardFrame = page.frames().find(f => f.url().includes('/index.html'));
  await boardFrame.evaluate(() => loadImwebBoardPost('post-test', 'English API post', 'en', 'TEST', '1'));
  assert.equal(await frame.locator('#iwBoardEditPriceUsd').inputValue(), '88.25');
  assert.equal(await frame.locator('#iwBoardEditPriceGroup').getAttribute('hidden'), null);
  await boardFrame.evaluate(() => document.getElementById('iwBoardEditPriceUsd').dispatchEvent(new Event('mouseover', { bubbles: true })));
  assert.equal(await frame.locator('#iwBoardEditPriceUsd').getAttribute('title'), expected(88.25));

  await page.evaluate(() => { window.fxState = 'stale'; window.dispatchEvent(new Event('focus')); });
  await page.waitForFunction(() => window.VUCurrency.convert(1, 'USD', 'KRW') === null);
  await frame.locator('#ebEditPrice').hover();
  assert.match(await frame.locator('#ebEditPrice').getAttribute('title'), /최신 환율/);
  assert.equal(await frame.locator('#ebEditPrice').inputValue(), '59.99');

  assert.match(await page.evaluate(async () => {
    try { await window.VUCurrency.lockBatch(window.require('electron').ipcRenderer, '100'); return ''; }
    catch (e) { return e.message; }
  }), /최신 환율/);
  assert.equal(await page.evaluate(() => window.VUCurrency.getBatchSnapshot()), null);

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
