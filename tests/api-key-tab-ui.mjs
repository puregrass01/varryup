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
      // 일괄 화면 폭 검사용 목록: 긴 상품명·SKU, 사진 6장(아직 이미지 목록을 안 읽은 행).
      if (channel === 'bulk-price-list') return { success: true, data: { note: '', items: Array.from({ length: 6 }, (_, i) => ({
        scope: data.scope, id: 'OGWM-9X-00MM-L1IN-' + i, price: '110', ready: false,
        name: 'Optic-Glass Heated Mirror Glass Replacement Wide Angle View Car Mirror, Exterior Side View Accessories Left Right Side ' + i,
        images: ['a', 'b', 'c', 'd', 'e', 'f'].map(x => 'https://images.example/' + x + '.jpg') })) } };
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

  {
    const shell = await context.newPage();
    shell.on('pageerror', e => errors.push(e.message));
    await shell.setViewportSize({ width: 1200, height: 800 });
    await shell.route('https://images.example/**', route => route.fulfill({ contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300" fill="#cbd5e1"/></svg>' }));
    await shell.goto(pathToFileURL(path.resolve('src/ui/index_up.html')).href);
    await shell.locator('[data-workspace="api"]').click();
    await shell.frameLocator('#form-frame').locator('#apiKeysTab').waitFor({ state: 'visible' });
    assert.equal(await shell.locator('#section8').isVisible(), true);
    await shell.locator('[data-workspace="bulk"]').click();
    assert.equal(await shell.locator('#bulk-edit-workspace').isVisible(), true);

    // 1200x800: 필터 레일(약 180px) + 표. 페이지 가로 스크롤이 없어야 하고 표도 칸 안에 들어가야 한다.
    await shell.locator('#be-platforms [data-scope="amazon-us"]').click();
    await shell.locator('#be-list').click();
    await shell.locator('#be-body tr').nth(5).waitFor();
    await shell.waitForFunction(() => [...document.querySelectorAll('#be-body img')].every(i => i.complete));
    const widths = await shell.evaluate(() => {
      const w = sel => Math.round(document.querySelector(sel).getBoundingClientRect().width);
      const scroll = document.querySelector('.be-scroll'), doc = document.documentElement, table = document.querySelector('.be-table');
      // 표가 줄어들 수 있는 최소 폭. 테스트 Chrome 은 스크롤바를 숨기므로, 실제 창의 세로 스크롤바(17px)는 따로 뺀다.
      table.style.width = '1px'; table.style.minWidth = '0';
      const minTable = Math.round(table.getBoundingClientRect().width);
      table.style.width = table.style.minWidth = '';
      return { pageScroll: doc.scrollWidth, pageClient: doc.clientWidth, workspace: w('#bulk-edit-workspace'), rail: w('#be-filters'),
        tableBox: scroll.clientWidth, table: w('.be-table'), minTable, photo: w('th.be-photo-column'),
        columns: [...document.querySelectorAll('.be-table thead th')].map(th => Math.round(th.getBoundingClientRect().width)),
        railStack: [...document.querySelectorAll('#be-filters > label')].map(l => l.firstChild.textContent.trim()),
        railTop: document.querySelector('#be-filters > label input')?.id,
        railOverflow: document.querySelector('#be-filters').scrollHeight - document.querySelector('#be-filters').clientHeight };
    });
    console.log('1200x800 일괄 화면 폭:', JSON.stringify(widths));
    await shell.screenshot({ path: 'scratch/bulk-rail-1200x800.png' });
    assert.ok(widths.pageScroll <= widths.pageClient, '페이지 가로 스크롤 없음');
    assert.ok(widths.table <= widths.tableBox, '표가 칸 안에 들어간다');
    assert.ok(widths.minTable <= widths.tableBox - 17, '세로 스크롤바가 있어도 표가 칸 안에 들어간다');
    assert.ok(widths.rail >= 170 && widths.rail <= 190, '레일 약 180px');
    assert.ok(widths.photo >= 190 && widths.photo <= 210, '사진 열 약 200px');
    assert.ok(widths.columns[7] >= 80, '처리 결과 열이 낱말 중간에서 끊길 만큼 좁지 않다');
    assert.ok(widths.railOverflow <= 0, '800px 높이에서 레일의 여섯 칸이 스크롤 없이 보인다');
    assert.equal(widths.railTop, 'be-search', '표 안 검색이 레일 맨 위');
    assert.deepEqual(widths.railStack, ['표 안에서 검색', '브랜드', '차량·제조사', '차종', '상품 종류', '가격']);

    // 환율 탭: 모드 바는 신규등록 · 단일 상품 수정 · 상품 일괄 수정, 오른쪽 끝 설정 묶음(환율 · API KEY).
    assert.deepEqual(await shell.evaluate(() => [...document.querySelectorAll('#mode-bar .mode-label')].map(n => n.textContent.trim())),
      ['신규등록', '단일 상품 수정', '상품 일괄 수정', '환율', 'API KEY']);
    assert.deepEqual(await shell.evaluate(() => [...document.querySelectorAll('#mode-bar .mode-settings [data-workspace]')].map(b => b.dataset.workspace)), ['fx', 'api']);
    const bar = await shell.evaluate(() => {
      const box = sel => document.querySelector(sel).getBoundingClientRect();
      return { right: box('#mode-bar').right - box('[data-workspace="api"]').right, split: box('[data-workspace="fx"]').left - box('[data-workspace="bulk"]').right };
    });
    assert.ok(bar.right <= 20 && bar.split > 200, '설정 묶음은 모드 바 오른쪽 끝: ' + JSON.stringify(bar));
    // 일괄 화면에는 환율 패널이 없다. 환율은 왼쪽 입력판 없이 폭 전체에 늘 펼친다.
    assert.equal(await shell.locator('#bulk-edit-workspace .fx-panel').count(), 0, '일괄 화면에 환율 패널 없음');
    await shell.locator('[data-workspace="fx"]').click();
    assert.equal(await shell.locator('[data-workspace="fx"]').getAttribute('class'), 'mode-label is-active');
    assert.equal(await shell.locator('#bulk-edit-workspace').isVisible(), false);
    assert.equal(await shell.locator('#main').isVisible(), false, '왼쪽 입력판은 숨는다');
    assert.equal(await shell.locator('#fx-workspace > #fx-panel').isVisible(), true);
    assert.equal(await shell.locator('#fx-workspace #fx-in-preview').isVisible(), true, '아임웹 상품명 블록도 같이 옮겨 왔다');
    const fx = await shell.evaluate(() => {
      const box = sel => document.querySelector(sel).getBoundingClientRect(), css = sel => getComputedStyle(document.querySelector(sel));
      return { width: Math.round(box('#fx-workspace').width), bodyMax: css('.fx-body').maxHeight, save: Math.round(box('#fx-save').height),
        saveBg: css('#fx-save').backgroundColor, runBg: css('#fx-run').backgroundColor, cancel: css('#fx-cancel').display,
        tierAdd: Math.round(box('#fx-tier-add').height), overflow: css('#fx-workspace').overflowY };
    });
    console.log('환율 탭:', JSON.stringify(fx));
    await shell.waitForTimeout(600); // 모드 바 색 전환(transition)이 끝난 뒤 찍는다.
    await shell.screenshot({ path: 'scratch/fx-tab-1200x800.png' });
    assert.ok(fx.width >= 1180, '폭 전체');
    assert.equal(fx.bodyMax, 'none', '46vh 제한 없음');
    assert.equal(fx.overflow, 'auto', '길면 탭 칸이 스크롤');
    assert.deepEqual([fx.save, fx.tierAdd], [32, 32], '탭 안 버튼도 일괄 화면과 같은 32px');
    assert.notEqual(fx.saveBg, fx.runBg, '설정 저장은 강조 버튼');
    assert.equal(fx.cancel, 'none', 'hidden 버튼은 숨는다');
    // 저장 안 한 환율 설정(등급표)이 있으면 창 닫기를 멈춘다.
    const blocksUnload = () => shell.evaluate(() => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; });
    assert.equal(await blocksUnload(), false);
    await shell.locator('#fx-tier-add').click();
    assert.equal(await blocksUnload(), true, '환율 설정 미저장 시 beforeunload');
    await shell.locator('[data-workspace="bulk"]').click();
    assert.equal(await shell.locator('#fx-workspace').isVisible(), false);
    assert.equal(await shell.locator('#bulk-edit-workspace').isVisible(), true);
    await shell.close();
  }
  assert.deepEqual(errors, []);
  assert.equal(await page.evaluate(() => window.calls.some(c => /save|register|update|publish/.test(c))), false);
  console.log('API KEY regression passed: parent-only IPC, first load, all five saved configs, selected mall, bulk mall, delayed pane callbacks, unsaved values, no writes.');
} finally { await browser.close(); }
