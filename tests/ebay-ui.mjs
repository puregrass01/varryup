// Offline UI smoke test against the existing full desktop HTML and iframe.
// No eBay requests or real credentials. Set EBAY_TEST_BROWSER for another Chromium executable.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const executablePath = process.env.EBAY_TEST_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const browser = await chromium.launch({ headless: true, executablePath, args: ['--allow-file-access-from-files'] });
try {
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  await context.route(/^https?:/, route => route.abort());
  await context.addInitScript(() => {
    window.__ebCalls = [];
    let config = { environment: 'sandbox', clientId: 'test-app', merchantLocationKey: 'warehouse', fulfillmentPolicyId: 'ship', paymentPolicyId: 'pay', returnPolicyId: 'return', hasClientSecret: true, hasRefreshToken: true };
    window.require = name => {
      if (name !== 'electron') throw new Error('Unexpected module');
      return { ipcRenderer: { on() {}, send() {}, async invoke(channel, data) {
        window.__ebCalls.push({ channel, data });
        if (channel === 'ebay-load-config') return { success: true, data: config };
        if (channel === 'ebay-save-config') { config = { ...config, ...data }; delete config.clientSecret; delete config.refreshToken; return { success: true, data: config }; }
        if (channel === 'ebay-categories') return { success: true, data: { categorySuggestions: [{ category: { categoryId: '123', categoryName: 'Mirror Glass' } }] } };
        if (channel === 'ebay-aspects') return { success: true, data: { aspects: [{ localizedAspectName: 'Color', aspectConstraint: { aspectRequired: true }, aspectValues: [{ localizedValue: 'Black' }] }] } };
        if (channel === 'ebay-preview') return { success: true, data: { sku: data.sku, offer: { marketplaceId: 'EBAY_US', title: data.title } } };
        if (channel === 'ebay-save-draft') return { success: true, data: { sku: data.sku, offerId: 'offer-1', status: 'DRAFT' } };
        if (channel === 'ebay-publish') return { success: true, data: { listingId: 'listing-1' } };
        if (channel === 'ebay-load-product') return { success: true, data: { sku: data, inventory: { product: { title: 'Existing mirror' }, availability: { shipToLocationAvailability: { quantity: 5 } } }, offer: { offerId: 'offer-1', status: 'PUBLISHED', availableQuantity: 5, pricingSummary: { price: { value: '59.99', currency: 'USD' } } } } };
        if (channel === 'ebay-update') return { success: true, data: { status: 'UPDATED' } };
        return { success: false, error: 'Offline test stub' };
      } } };
    };
  });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(pathToFileURL(path.resolve('src/ui/index.html')).href);
  await page.locator('.tab-btn[onclick*="ebayTab"]').click();
  await page.waitForSelector('#ebayTab:visible');
  assert.match(await page.locator('#ebStatus').innerText(), /Sandbox/);
  assert.equal(await page.locator('#ebPublish').isDisabled(), true);
  await page.locator('#ebSku').fill('OG-123-L'); await page.locator('#ebTitle').fill('OpticGlass Left Mirror');
  await page.locator('#ebPrice').fill('59.99'); await page.locator('#ebQuantity').fill('5');
  await page.locator('#ebCategoryQuery').fill('mirror'); await page.locator('[data-eb="categories"]').click();
  await page.getByRole('button', { name: 'Mirror Glass (123)', exact: true }).click();
  await page.locator('[data-eb="aspects"]').click(); await page.locator('#ebRequired0').fill('Black');
  await page.evaluate(() => window.ebayImportCommon({ brand: 'Hyundai', model: 'Sonata', year: '2020', generation: 'DN8', code: '123', bsa: true, chartHtml: '<img src="https://images.example.com/chart.jpg">' }));
  assert.equal(await page.locator('#ebImages').inputValue(), 'https://images.example.com/chart.jpg');
  await page.locator('[data-eb="preview"]').click(); await page.waitForFunction(() => document.getElementById('ebPreview').textContent.includes('EBAY_US'));
  await page.locator('[data-eb="draft"]').click(); await page.waitForFunction(() => !document.getElementById('ebPublish').disabled);
  const submitted = await page.evaluate(() => window.__ebCalls.find(c => c.channel === 'ebay-save-draft').data);
  assert.equal(submitted.aspects.Color[0], 'Black'); assert.equal(submitted.price, '59.99');
  await page.locator('#ebTitle').fill('Changed title'); assert.equal(await page.locator('#ebPublish').isDisabled(), true);
  await page.locator('[data-eb="draft"]').click(); await page.locator('#ebPublish').click();
  await page.waitForFunction(() => document.getElementById('ebLog').textContent.includes('Listing listing-1'));
  await page.locator('#ebMode').selectOption('edit'); await page.locator('#ebEditSku').fill('OG-123-L'); await page.locator('[data-eb="load"]').click();
  await page.waitForFunction(() => !document.getElementById('ebUpdate').disabled);
  await page.locator('#ebEditPrice').fill('60.00'); await page.locator('#ebEditQuantity').fill('3'); await page.locator('#ebUpdate').click();
  await page.waitForFunction(() => window.__ebCalls.some(c => c.channel === 'ebay-update'));
  assert.deepEqual(await page.evaluate(() => window.__ebCalls.find(c => c.channel === 'ebay-update').data), { sku: 'OG-123-L', price: '60.00', quantity: '3' });
  await page.locator('#ebEditSku').fill('different'); assert.equal(await page.locator('#ebUpdate').isDisabled(), true);
  await page.locator('#ebMode').selectOption('new'); await page.locator('#ebayTab').scrollIntoViewIfNeeded();
  const output = path.resolve('scratch/ebay-ui'); fs.mkdirSync(output, { recursive: true });
  await page.evaluate(() => { document.querySelector('.tab-content-area').scrollTop = 0; });
  await page.screenshot({ path: path.join(output, 'ebay-form.png'), fullPage: true, animations: 'disabled' });

  const parent = await context.newPage(); parent.on('pageerror', error => errors.push(error.message));
  await parent.goto(pathToFileURL(path.resolve('src/ui/index_up.html')).href);
  assert.equal(await parent.locator('#btn-confirm-platform').count(), 0);
  assert.equal(await parent.locator('#section8-header').count(), 1);
  // 1-클릭: 테이블 클릭만으로 확인 버튼 없이 바로 폼과 해당 탭이 열림
  // 로고가 있는 타일에는 .plat-name 이 없다(로고가 깨질 때만 생긴다) — 타일 자체를 누른다.
  await parent.locator('#cell-USA-open2').click();
  const frame = parent.frameLocator('#form-frame'); await frame.locator('#ebayTab').waitFor({ state: 'visible' });
  assert.equal(await frame.locator('#ebayTab').isVisible(), true);
  assert.equal(await frame.locator('#coupangTab').isVisible(), false);
  assert.equal(await frame.locator('.app-header').isVisible(), false);
  assert.equal(await frame.locator('.app-tabs').isVisible(), false, '가운데 몰 탭 줄은 10-16 에 뺐다 — 현황판 타일이 탭을 고른다');
  assert.equal(await frame.locator('#ebStatus').isVisible(), true);
  // eBay 탭 로그(#ebLog)는 셸에서 숨는다 — 줄마다 셸 로그로 '[eBay] ' 를 붙여 단계 그대로 넘어가야 한다.
  const ebFrame = parent.frames().find(f => f.url().includes('/index.html'));
  await ebFrame.evaluate(() => { document.getElementById('ebCategoryQuery').value = 'mirror'; document.querySelector('[data-eb="categories"]').click(); });
  await parent.waitForFunction(() => document.getElementById('log-window').textContent.includes('[eBay] 1개 카테고리'));
  await ebFrame.evaluate(() => document.querySelector('[data-eb="settings"]').click());   // 가짜 IPC 에 없는 채널 → 오류 줄
  await parent.waitForFunction(() => [...document.querySelectorAll('#log-window .log-entry.error')].some(e => e.textContent.includes('[eBay] Offline test stub')));
  assert.equal(await parent.locator('#log-window .log-entry.info', { hasText: '[eBay] 1개 카테고리' }).count(), 1, '기본(system) 줄은 info 로');
  // SKU 칸은 셸이 채우는 칸이라(shell-owned) 숨는다 — 사람이 치는 카테고리 검색어로 탭 전환 뒤 보존을 본다.
  await frame.locator('#ebCategoryQuery').fill('PRESERVE-QUERY');
  // 1-클릭: 현황판에서 아마존 미국 클릭 시 바로 아마존 탭으로 전환됨
  await parent.locator('#cell-USA-open1').click();
  await frame.locator('#amazonTab').waitFor({ state: 'visible' });
  await parent.locator('#cell-USA-open2').click();   // 이미 켠 eBay 타일을 다시 누르면 그 탭으로 돌아간다
  await frame.locator('#ebayTab').waitFor({ state: 'visible' });
  assert.equal(await frame.locator('#ebCategoryQuery').inputValue(), 'PRESERVE-QUERY');
  assert.equal(await parent.locator('#cell-USA-open2').getAttribute('aria-checked'), 'true');
  await parent.screenshot({ path: path.join(output, 'ebay-parent.png'), fullPage: true, animations: 'disabled' });

  // 1-클릭: 네이버 클릭 시 폼에서 네이버 탭 활성화
  await parent.locator('#cell-KOREA-open1').click();
  await frame.locator('#naverTab').waitFor({ state: 'visible' });
  assert.equal(await frame.locator('#naverTab').isVisible(), true);
  assert.equal(await frame.locator('#ebayTab').isVisible(), false);

  // 1-클릭: 쿠팡 클릭 시 쿠팡 탭 활성화
  await parent.locator('#cell-KOREA-open2').click();
  await frame.locator('#coupangTab').waitFor({ state: 'visible' });
  assert.equal(await frame.locator('#coupangTab').isVisible(), true);

  // 1-클릭: 이미 체크된 네이버 다시 클릭 시 네이버로 뷰 전환
  await parent.locator('#cell-KOREA-open1').click();
  await frame.locator('#naverTab').waitFor({ state: 'visible' });
  assert.equal(await frame.locator('#naverTab').isVisible(), true);

  // Existing edit-mode selection must use the eBay form, not the unrelated generic search IPC.
  await parent.locator('label[for="mode-edit"]').click();
  await parent.locator('#cell-USA-open2').click();
  await frame.locator('#ebEditForm').waitFor({ state: 'visible' });
  assert.equal(await frame.locator('#ebMode').inputValue(), 'edit');
  await parent.evaluate(() => { uncheckAllAndClearCards(); updateEmptyState(); });
  assert.equal(await parent.locator('#form-frame').isVisible(), false);
  const ebayErrors = errors.filter(error => /ebay|eb[A-Z]/i.test(error));
  assert.deepEqual(ebayErrors, []);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'PASS', checks: 'form, metadata, common import, draft, publish, edit, stale state, parent iframe, shell log forward, edit routing', pageErrors: errors, screenshots: output }, null, 2));
} finally { await browser.close(); }
