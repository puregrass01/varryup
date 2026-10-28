// Offline full-shell regression: top edit radio -> platform -> list -> load editor.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const browser = await chromium.launch({ headless: true,
  executablePath: process.env.EBAY_TEST_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  args: ['--allow-file-access-from-files'] });
try {
  const context = await browser.newContext();
  await context.route(/^https?:/, route => route.abort());
  await context.addInitScript(() => {
    window.calls = [];
    window.require = () => ({ ipcRenderer: { on() {}, send() {}, async invoke(channel, data) {
      window.calls.push({ channel, data });
      if (channel === 'veryup-get-mode') return 'new';
      if (channel === 'ebay-load-config') return { success: true, data: { environment: 'sandbox' } };
      if (channel.endsWith('-search-products')) {
        if (data.searchText === 'error') return { success: false, error: 'Access denied' };
        const items = data.searchText === 'missing' ? [] : [{ id: 'custom/<sku>', name: '<img src=x onerror=alert(1)> Mirror', price: '10', stock: '0', status: 'PUBLISHED' }];
        const stats = data.searchText === 'stale' ? { source: 'cache', scanned: 1, updatedAt: '2000-01-01T00:00:00Z' } : undefined;
        return { success: true, items, data: items, stats };
      }
      // 동기화가 성공해도 불러온 상품이 있으면 목록을 다시 조회하지 않는다(다시 조회하면 아래 'stale' 조회 횟수가 어긋난다).
      if (channel === 'amazon-refresh-cache') return { success: true, total: 1 };
      if (channel === 'amazon-load-product') return { success: true, product: { title: 'Loaded Amazon', price: 0, stock: 0, description: '', bulletPoints: [] } };
      if (channel === 'ebay-load-product') return { success: true, data: { sku: data,
        inventory: { product: { title: 'Loaded eBay' } },
        offer: { offerId: 'one', status: 'PUBLISHED', availableQuantity: 0, pricingSummary: { price: { value: '10' } } } } };
      return { success: false, error: 'Offline stub' };
    } } });
  });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(pathToFileURL(path.resolve('src/ui/index_up.html')).href);
  await page.locator('label[for="mode-edit"]').click();
  // 로고 타일에는 .plat-name 이 없다(로고 파일이 없을 때만 이름) — 칸 자체를 누른다.
  await page.locator('#cell-USA-open1').click();
  const frame = page.frameLocator('#form-frame');
  await frame.locator('#amzSearchBtn').click();
  await frame.locator('#amzSearchResults .vu-product-select').waitFor();
  assert.equal(await frame.locator('#amzSearchResults img').count(), 0);
  await frame.locator('#amzSearchResults .vu-product-select').click();
  assert.equal(await frame.locator('#amzSku').inputValue(), 'custom/<sku>');
  assert.equal(await frame.locator('#amzTitle').inputValue(), 'Loaded Amazon');
  assert.equal(await frame.locator('#amzStock').inputValue(), '0');
  assert.equal(await frame.locator('#amzPrice').inputValue(), '0');
  const child = page.frames().find(f => f.url().includes('/index.html'));
  assert.deepEqual(await child.evaluate(() => window.calls.find(c => c.channel === 'amazon-load-product').data),
    { sku: 'custom/<sku>', marketplaceId: 'ATVPDKIKX0DER' });
  for (const [query, message] of [['missing', '검색 결과가 없습니다.'], ['error', '목록 조회 실패: Access denied']]) {
    await frame.locator('#amzSearchText').fill(query);
    await frame.locator('#amzSearchBtn').click();
    await frame.locator('#amzSearchResults').getByText(message, { exact: true }).waitFor();
    assert.equal(await frame.locator('#amzSearchBtn').isEnabled(), true);
  }
  // 캐시가 24시간 지났으면 조회가 뒤에서 전체 목록 동기화를 시작한다. 두 번 조회해도 마켓당 한 번만.
  for (let i = 1; i <= 2; i++) {
    await frame.locator('#amzSearchText').fill('stale');
    await frame.locator('#amzSearchBtn').click();
    await child.waitForFunction(n => window.calls.filter(c => c.channel === 'amazon-search-products' && c.data.searchText === 'stale').length === n
      && !document.getElementById('amzSearchBtn').disabled, i);
  }
  await frame.locator('#amzCacheStatus').getByText(/^로컬 캐시 1건 \(미국/).waitFor();
  assert.deepEqual(await child.evaluate(() => window.calls.filter(c => c.channel === 'amazon-refresh-cache').map(c => c.data)),
    [{ marketplaceId: 'ATVPDKIKX0DER' }]);
  await page.locator('#cell-JAPAN-open1').click();
  assert.equal(await frame.locator('#amzMarketplaceId').inputValue(), 'A1VC38T7YXB528');
  await frame.locator('#amzSearchText').fill('');
  await frame.locator('#amzSearchBtn').click();
  await frame.locator('#amzSearchResults .vu-product-select').click();
  assert.deepEqual(await child.evaluate(() => window.calls.filter(c => c.channel === 'amazon-load-product').at(-1).data),
    { sku: 'custom/<sku>', marketplaceId: 'A1VC38T7YXB528' });
  await page.locator('#cell-USA-open2').click();
  await frame.locator('[data-eb="search"]').click();
  await frame.locator('#ebSearchResults .vu-product-select').waitFor();
  assert.equal(await frame.locator('#ebSearchResults img').count(), 0);
  await frame.locator('#ebSearchResults .vu-product-select').click();
  await frame.locator('#ebLoaded').getByText(/Loaded eBay/).waitFor();
  assert.equal(await frame.locator('#ebEditSku').inputValue(), 'custom/<sku>');
  assert.equal(await frame.locator('#ebEditQuantity').inputValue(), '0');
  assert.equal(await frame.locator('#ebUpdate').isEnabled(), true);
  for (const [query, message] of [['missing', '검색 결과가 없습니다.'], ['error', '목록 조회 실패: Access denied']]) {
    await frame.locator('#ebSearchText').fill(query);
    await frame.locator('[data-eb="search"]').click();
    await frame.locator('#ebSearchResults').getByText(message, { exact: true }).waitFor();
    assert.equal(await frame.locator('[data-eb="search"]').isEnabled(), true);
  }
  assert.equal(await child.evaluate(() => window.calls.some(c => c.channel === 'amazon-update' || c.channel === 'ebay-update')), false);
  await page.locator('label[for="mode-new"]').click();
  assert.equal(await frame.locator('#ebEditForm').isVisible(), false);
  assert.deepEqual(errors, []);
  console.log('Marketplace list/edit UI: passed');
} finally { await browser.close(); }
