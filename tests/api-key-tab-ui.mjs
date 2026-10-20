import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const browser = await chromium.launch({ headless: true,
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  args: ['--allow-file-access-from-files'] });
try {
  const context = await browser.newContext({ viewport: { width: 1200, height: 850 } });
  await context.route(/^https?:/, route => route.abort());
  await context.addInitScript(() => {
    // Production iframe may lack require. The old all-frame mock hid this bug.
    if (window.parent !== window) return;
    window.calls = [];
    window.require = () => ({ ipcRenderer: { on() {}, send() {}, async invoke(channel, data) {
      window.calls.push(channel);
      if (channel === 'veryup-get-mode') return 'new';
      if (channel === 'naver-key-connection-check') return { success: false,
        error: 'GW.IP_NOT_ALLOWED: 프록시 서버의 외부 IPv4를 등록해주세요.',
        connection: { label: '서버 프록시 경유', ipGuidance: '프록시 서버의 외부 IPv4를 등록해주세요.', outboundIp: '203.0.113.7' } };
      if (channel === 'naver-key-config-get') return { success: true, configured: true,
        config: { clientId: 'fixture-naver', type: 'SELF', hasClientSecret: true } };
      if (channel === 'coupang-load-config') {
        await new Promise(r => setTimeout(r, 150));
        return { success: true, config: { vendorId: 'fixture-coupang', accessKey: 'fixture-access', secretKey: 'fixture-secret' } };
      }
      if (channel === 'amazon-load-config') return { success: true, config: {
        sellerId: 'fixture-amazon', clientId: 'fixture-client', clientSecret: 'fixture-secret', refreshToken: 'fixture-refresh' } };
      if (channel === 'imweb-load-openapi-config') return { success: true, configured: true, config: { clientId: 'fixture-imweb' } };
      if (channel === 'ebay-load-config') return { success: true, data: {
        environment: 'sandbox', clientId: 'fixture-ebay', hasClientSecret: true, hasRefreshToken: true } };
      return { success: false };
    } } });
  });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(pathToFileURL(path.resolve('src/ui/index_up.html')).href);
  await page.locator('[data-workspace="api"]').click();
  const frame = page.frameLocator('#form-frame');
  await frame.locator('#apiKeysTab').waitFor({ state: 'visible' });
  assert.equal(await frame.locator('#aiGenTab').isVisible(), false);
  assert.equal(await frame.locator('#nvKeyId').inputValue(), 'fixture-naver');
  assert.match(await frame.locator('#nvKeySecret').getAttribute('placeholder'), /저장된 Secret/);
  assert.equal(await frame.locator('#nvKeySecret').inputValue(), '');
  await frame.locator('#nvKeyCheck').click();
  await frame.locator('#nvKeyStatus').filter({ hasText: 'GW.IP_NOT_ALLOWED' }).waitFor();
  assert.match(await frame.locator('#nvKeyConnection').textContent(), /서버 프록시 경유.*203\.0\.113\.7/);
  assert.equal(await frame.locator('#nvKeyId').inputValue(), 'fixture-naver');
  assert.equal(await frame.locator('#nvKeyCheck').isEnabled(), true);
  assert.equal(await frame.locator('#nvKeySave').isEnabled(), true);


  // 몰 폼은 현황판 칸으로 연다(가운데 쇼핑몰 탭은 없앴다). 칸마다 한 번씩 켜므로 누르면 그 몰 폼이 열린다.
  for (const [tab, platform, field, value, cell] of [
    ['coupangTab', 'coupang', 'cpVendorId', 'fixture-coupang', 'KOREA-open2'],
    ['amazonTab', 'amazon', 'amzSellerId', 'fixture-amazon', 'USA-open1'],
    ['imwebTab', 'imweb', 'iwClientId', 'fixture-imweb', 'KOREA-b2b'],
    ['ebayTab', 'ebay', 'ebClientId', 'fixture-ebay', 'USA-open2'],
    ['naverTab', 'naver', 'nvKeyId', 'fixture-naver', 'KOREA-open1'],
  ]) {
    await page.locator('label[for="mode-edit"]').click();
    await page.locator('#cell-' + cell).click();
    await frame.locator('#' + tab).waitFor({ state: 'visible' });
    await page.locator('[data-workspace="api"]').click();
    await frame.locator('#api-key-panel-' + platform).waitFor({ state: 'visible' });
    assert.equal(await frame.locator('#' + field).inputValue(), value);
    assert.equal(await frame.locator('#aiGenTab').isVisible(), false);
    assert.equal(await frame.locator('[data-key-platform="' + platform + '"]').getAttribute('aria-selected'), 'true');
  }
  // A late platform filter/hash callback must not expose the default AI pane.
  await page.evaluate(() => {
    applyFilter('aiGenTab');
    const w = document.getElementById('form-frame').contentWindow;
    w.switchTab('aiGenTab');
    w.location.hash = 'aiGenTab&embed';
  });
  assert.equal(await frame.locator('#apiKeysTab').isVisible(), true);
  assert.equal(await frame.locator('#aiGenTab').isVisible(), false);
  // API input edits survive re-entry and only the chosen marketplace card is shown.
  await frame.locator('#nvKeyId').fill('fixture-unsaved');
  await page.locator('[data-workspace="api"]').click();
  assert.equal(await frame.locator('#nvKeyId').inputValue(), 'fixture-unsaved');
  // A bulk platform also supplies the current marketplace.
  await page.locator('[data-workspace="bulk"]').click();
  await page.locator('#be-platforms [data-scope="amazon-jp"]').click();
  await page.locator('[data-workspace="api"]').click();
  await frame.locator('#api-key-panel-amazon').waitFor({ state: 'visible' });
  assert.equal(await frame.locator('#amzClientSecret').getAttribute('type'), 'password');
  await page.waitForTimeout(600); // Let the existing sidebar view transition finish before visual capture.
  await page.screenshot({ path: 'scratch/api-key-fixed.png' });
  assert.deepEqual(errors, []);
  assert.equal(await page.evaluate(() => window.calls.some(c => /save|register|update|publish/.test(c))), false);
  console.log('API KEY regression passed: parent-only IPC, first load, all five saved configs, selected mall, bulk mall, delayed pane callbacks, unsaved values, no writes.');
} finally { await browser.close(); }
