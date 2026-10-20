// Offline integration: real marketplace renderers and selection callbacks, no API writes.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const browser = await chromium.launch({ headless: true, executablePath: process.env.EBAY_TEST_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe', args: ['--allow-file-access-from-files'] });
try {
  const context = await browser.newContext({ viewport: { width: 1180, height: 960 } });
  await context.route(/^https?:/, route => route.abort());
  await context.addInitScript(() => {
    window.calls = [];
    const names = ['옵틱글래스 현대 그랜저 IG 광각 사이드 와이드미러', '퓨어글래스 현대 싼타페 TM 와이드미러', '스타포쉬 현대 아이오닉 9 전동사이드스텝', '옵틱글래스 현대 베라크루스 와이드미러'];
    window.testProducts = Array.from({ length: 61 }, (_, i) => ({ id: String(10921625000 + i), name: names[i % 4], price: 0, stock: 0 }));
    window.testProducts[60] = { id: "last/'<sku>", name: '<img src=x onerror=alert(1)> Unclassified', price: 0, stock: 0 };
    window.require = () => ({ ipcRenderer: { on() {}, send() {}, async invoke(channel, data) {
      window.calls.push({ channel, data });
      if (channel === 'veryup-get-mode') return 'edit';
      if (channel === 'imweb-load-categories') return { success: true, categories: { 국산차: { 현대: ['그랜저', '싼타페', '베라크루스', '아이오닉9'] }, 수입차: {} } };
      if (channel === 'ebay-load-config') return { success: true, data: { environment: 'sandbox' } };
      if (channel === 'smartstore-find-id' || channel === 'coupang-find-id') return { success: true, rows: window.testProducts, source: 'api' };
      if (channel === 'amazon-search-products') return { success: true, items: [window.testProducts[60]] };
      if (channel === 'ebay-search-products') return { success: true, data: [window.testProducts[60]] };
      if (channel === 'amazon-load-product') return { success: true, product: { title: 'Amazon loaded', price: 0, stock: 0, description: '', bulletPoints: [] } };
      if (channel === 'ebay-load-product') return { success: true, data: { sku: data, inventory: { product: { title: 'eBay loaded' } }, offer: { offerId: 'offer', status: 'PUBLISHED', availableQuantity: 0, pricingSummary: { price: { value: '1' } } } } };
      if (channel === 'imweb-search-products') return { success: true, groups: [{ baseKey: names[0], items: [{ name: names[0], prodNo: 501, type: 'set', price: 100 }, { name: names[0], prodNo: 502, type: 'indiv', price: 50 }] }] };
      if (channel === 'imweb-search-posts') return { success: true, rows: [{ postCode: "post/'1", subject: "옵틱글래스 현대 그랜저 '20~23' 와이드미러" }] };
      if (channel === 'veryup-search-product') return { items: window.testProducts };
      return { success: false, error: 'Offline stub' };
    } } });
  });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(pathToFileURL(path.resolve('src/ui/index.html')).href + '?mode=edit');
  await page.evaluate(() => { setSection8Mode('edit', true); switchTab('naverTab'); document.getElementById('ssFindBrand').value = '현대'; return findSmartstoreId(); });
  const naver = page.locator('#ssFindResult');
  assert.deepEqual(await naver.locator('th').allTextContents(), ['브랜드', '차량·제조사', '차종', '상품 종류', '상품번호 / SKU', '선택']);
  assert.equal(await naver.locator('tbody tr').count(), 25);
  await naver.getByRole('button', { name: '다음', exact: true }).click();
  await naver.getByRole('button', { name: '다음', exact: true }).click();
  assert.equal(await naver.locator('tbody tr').count(), 11);
  await naver.locator('.vu-product-select').last().click();
  assert.equal(await page.locator('#templateIdInput').inputValue(), "last/'<sku>");
  assert.equal(await naver.locator('img').count(), 0);
  await naver.getByLabel('브랜드 필터', { exact: true }).selectOption('퓨어글래스');
  assert.equal(await naver.locator('tbody tr').count(), 15);
  await naver.getByLabel('표 안에서 검색', { exact: true }).fill('퓨어글래스 싼타페');
  assert.equal(await naver.locator('tbody tr').count(), 15);
  await naver.getByLabel('차종 필터', { exact: true }).selectOption('그랜저');
  assert.match(await naver.textContent(), /선택한 조건의 상품이 없습니다/);
  await naver.getByLabel('브랜드 필터', { exact: true }).selectOption('');
  await naver.getByLabel('차종 필터', { exact: true }).selectOption('');
  await naver.getByLabel('표 안에서 검색', { exact: true }).fill('');
  await naver.locator('summary').first().click();
  assert.match(await naver.locator('details[open]').textContent(), /그랜저 IG/);
  await naver.locator('summary').first().click();
  fs.mkdirSync('scratch', { recursive: true });
  await naver.screenshot({ path: 'scratch/product-table-preview.png' });

  await page.evaluate(() => { switchTab('coupangTab'); document.getElementById('cpFindBrand').value = '현대'; return findCoupangIdFromSheet(); });
  const coupang = page.locator('#cpFindResult');
  await coupang.getByLabel('표 안에서 검색', { exact: true }).fill("last/'<sku>");
  await coupang.locator('.vu-product-select').click();
  assert.equal(await page.locator('#cpProductIdInput').inputValue(), "last/'<sku>");

  await page.evaluate(() => { switchTab('amazonTab'); return searchAmazonProducts(); });
  await page.locator('#amzSearchResults .vu-product-select').click();
  assert.equal(await page.locator('#amzSku').inputValue(), "last/'<sku>");
  assert.equal(await page.locator('#amzTitle').inputValue(), 'Amazon loaded');
  assert.match(await page.locator('#amzSearchResults .vu-product-id').textContent(), /가격 0 USD · 재고 0/);
  await page.evaluate(() => switchTab('ebayTab'));
  await page.locator('[data-eb="search"]').click();
  await page.locator('#ebSearchResults .vu-product-select').click();
  assert.equal(await page.locator('#ebEditSku').inputValue(), "last/'<sku>");
  assert.match(await page.locator('#ebLoaded').textContent(), /eBay loaded/);

  await page.evaluate(() => { switchTab('imwebTab'); document.getElementById('iwB2bEditIdxInput').value = '501'; return searchImwebB2bProducts(); });
  assert.equal(await page.locator('#iwB2bResultList tbody tr').count(), 2);
  await page.locator('#iwB2bResultList .vu-product-select').first().click();
  assert.deepEqual(await page.evaluate(() => calls.find(c => c.channel === 'imweb-load-group').data), { prodNos: [501, 502] });
  await page.evaluate(() => {
    switchTab('imwebBoardTab');
    document.getElementById('iwBoardEditCodeInput').value = '123';
    const select = document.getElementById('iwBoardEditBrand'); select.replaceChildren(new Option('옵틱글래스', '옵틱글래스')); select.value = '옵틱글래스';
    return searchImwebBoardPosts();
  });
  await page.locator('#iwBoardResultList .vu-product-select').click();
  assert.equal(await page.evaluate(() => calls.find(c => c.channel === 'imweb-load-post').data.postCode), "post/'1");
  assert.equal(await page.evaluate(() => calls.some(c => /update|register|publish/.test(c.channel))), false);

  // The shared shell card also uses the same table without changing its edit payload.
  await page.goto(pathToFileURL(path.resolve('src/ui/index_up.html')).href);
  await page.evaluate(() => { setSection8Mode('edit', true); return searchProduct('KOREA', 'open1'); });
  const shell = page.locator('#card-KOREA-open1');
  await shell.locator('.vu-product-select').first().click();
  assert.equal(await shell.locator('input[id$="-edit-name"]').inputValue(), '옵틱글래스 현대 그랜저 IG 광각 사이드 와이드미러');
  await shell.locator('button[id$="-btn-cancel"]').click();
  assert.equal(await shell.locator('tr.is-selected').count(), 0);
  assert.deepEqual(errors, []);
  console.log('Product tables: all marketplace selection paths, filters, pagination, original titles and no writes passed.');
} finally { await browser.close(); }
