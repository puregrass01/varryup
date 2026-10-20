// Offline regression check: launch parameters, main-process IPC and top radios.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const browser = await chromium.launch({
  headless: true,
  args: ['--allow-file-access-from-files'],
  executablePath: process.env.EBAY_TEST_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
});
try {
  const context = await browser.newContext();
  await context.route(/^https?:/, route => route.abort());
  await context.addInitScript(() => {
    const listeners = {};
    window.modeMessages = [];
    window.emitMode = mode => listeners['veryup-set-mode']({}, mode);
    window.require = () => ({ ipcRenderer: {
      on(channel, listener) { listeners[channel] = listener; },
      send(channel, mode) {
        window.modeMessages.push({ channel, mode });
        if (channel === 'veryup-set-mode') window.emitMode(mode);
      },
      invoke(channel) {
        window.modeMessages.push({ channel });
        if (channel === 'veryup-get-mode') return new Promise(resolve => { window.resolveMode = resolve; });
        return Promise.resolve({});
      },
    } });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const url = pathToFileURL(path.resolve('src/ui/index_up.html')).href;
  async function expectMode(mode) {
    const isNew = mode === 'new';
    assert.equal(await page.locator(`#mode-${mode}`).isChecked(), true);
    assert.equal(await page.locator('#sec8-desc').textContent(), isNew ? '신규등록 — 실행 로그' : '상품수정 — 상품 편집');
    assert.equal(await page.locator('#btn-clear-log').getAttribute('title'), isNew ? '로그 지우기' : '선택한 폼 모두 닫기');
    assert.equal(await page.locator('#btn-run').isVisible(), isNew);
    assert.equal(await page.locator('#log-window').evaluate(el => el.style.display), isNew ? '' : 'none');
    assert.equal(await page.locator('#card-area').evaluate(el => el.style.display), isNew ? 'none' : 'flex');
  }
  await page.goto(`${url}?mode=edit`);
  await expectMode('edit');
  await page.locator('label[for="mode-new"]').click();
  await expectMode('new');
  // A stale startup response must not undo the user's top-selector choice.
  await page.evaluate(() => window.resolveMode('edit'));
  await expectMode('new');
  await page.evaluate(() => {
    document.getElementById('log-window').textContent = 'old log';
    document.getElementById('form-frame').style.display = 'block';
    window.emitMode('edit');
  });
  await expectMode('edit');
  assert.equal(await page.locator('#log-window').textContent(), '');
  assert.equal(await page.locator('#form-frame').isVisible(), true);
  await page.evaluate(() => {
    document.getElementById('card-area').innerHTML = '<div>Existing result</div>';
    document.getElementById('form-frame').style.display = 'block';
    window.emitMode('edit');
  });
  assert.equal(await page.locator('#card-area').textContent(), 'Existing result');
  assert.equal(await page.locator('#form-frame').isVisible(), true);
  assert.equal(await page.locator('#empty-state').isVisible(), false);
  await page.locator('label[for="mode-new"]').click();
  await expectMode('new');
  assert.equal(await page.locator('#card-area').textContent(), '');
  assert.equal(await page.locator('#form-frame').isVisible(), true);
  await page.locator('label[for="mode-edit"]').click();
  await expectMode('edit');
  assert.equal(await page.evaluate(() => window.modeMessages.at(-1).mode), 'edit');
  // Reloading an old launch URL must restore the latest main-process mode.
  await page.goto(`${url}?mode=new`);
  await expectMode('new');
  await page.evaluate(() => window.resolveMode('edit'));
  await expectMode('edit');
  await page.goto(`${url}?mode=invalid`);
  await expectMode('new');
  // Top edit mode opens the existing platform editor, with no inner radios.
  await page.locator('label[for="mode-edit"]').click();
  await page.locator('#cell-KOREA-open1 .plat-name').click();
  const frame = page.frameLocator('#form-frame');
  await frame.locator('#ssEditPanel').waitFor({ state: 'visible' });
  assert.equal(await frame.locator('#naverTab #ssEditPanel').count(), 1);
  assert.equal(await frame.locator('input[type="radio"][name="workMode"]').count(), 0);
  assert.equal(await frame.getByText('기존 상품 수정', { exact: true }).count(), 0);
  assert.equal(await frame.locator('input[name="workMode"]').inputValue(), 'edit');
  // 상품을 아직 안 불러온 수정 모드 라벨. 불러온 뒤 상품명이 들어가는 건 tests/edit-label.mjs 가 본다.
  assert.match(await frame.locator('#registerBtn').innerText(), /스마트스토어 상품 수정하기/);
  const child = page.frames().find(f => f.url().includes('/index.html'));
  await child.evaluate(() => {
    window.saveSmartstoreEdit = async () => { window.savedThroughEdit = true; };
  });
  await frame.locator('#registerBtn').click();
  assert.equal(await child.evaluate(() => window.savedThroughEdit), true);
  assert.equal(await page.evaluate(() => window.modeMessages.some(m => m.channel === 'veryup-search-product')), false);
  await frame.locator('#templateIdInput').fill('existing-product-123');
  await page.evaluate(() => window.emitMode('edit'));
  assert.equal(await frame.locator('#templateIdInput').inputValue(), 'existing-product-123');
  assert.equal(await frame.locator('#ssEditPanel').isVisible(), true);
  // The same selected platform stays open when the top mode changes.
  await page.locator('label[for="mode-new"]').click();
  await expectMode('new');
  assert.equal(await page.locator('#cell-KOREA-open1 input').isChecked(), true);
  assert.equal(await frame.locator('#naverTab').isVisible(), true);
  assert.equal(await frame.locator('#ssEditPanel').isVisible(), false);
  assert.equal(await frame.locator('input[name="workMode"]').inputValue(), 'copy');
  await page.locator('label[for="mode-edit"]').click();
  for (const [cell, panel, name, tab] of [
    ['KOREA-open2', 'cpEditPanel', 'cpWorkMode', 'coupangTab'],
    ['USA-open1', 'amzEditPanel', 'amzWorkMode', 'amazonTab'],
    ['KOREA-b2b', 'iwB2bEditPanel', 'iwB2bWorkMode', 'imwebTab'],
    ['KOREA-own', 'iwBoardEditPanel', 'iwBoardWorkMode', 'imwebBoardTab'],
  ]) {
    await page.locator('#cell-' + cell + ' .plat-name').click();
    await frame.locator('#' + panel).waitFor({ state: 'visible' });
    assert.equal(await frame.locator('#' + tab + ' #' + panel).count(), 1);
    assert.equal(await frame.locator('input[name="' + name + '"]').inputValue(), 'edit');
    assert.equal(await frame.locator('input[type="radio"][name="' + name + '"]').count(), 0);
  }
  await page.locator('#cell-USA-open2 .plat-name').click();
  await frame.locator('#ebEditForm').waitFor({ state: 'visible' });
  assert.equal(await frame.locator('#ebMode').isVisible(), false);
  await page.locator('label[for="mode-new"]').click();
  await frame.locator('#ebNewForm').waitFor({ state: 'visible' });
  // The shared controller also initializes standalone platform pages.
  const standaloneUrl = pathToFileURL(path.resolve('src/ui/index.html')).href;
  for (const mode of ['new', 'edit']) {
    await page.goto(`${standaloneUrl}?mode=${mode}`);
    await page.locator('.tab-btn[onclick*="naverTab"]').click();
    assert.equal(await page.locator('#ssEditPanel').isVisible(), mode === 'edit');
    assert.equal(await page.locator('input[name="workMode"]').inputValue(), mode === 'edit' ? 'edit' : 'copy');
    assert.equal(await page.locator('#ebMode').inputValue(), mode);
  }
  assert.deepEqual(errors, []);
  console.log('PASS: top mode parameters, platform edit forms, removed radios, edit action routing, preserved selection, IPC and reload');
} finally {
  await browser.close();
}
