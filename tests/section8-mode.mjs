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
    assert.equal(await page.locator('#sec8-desc').textContent(), isNew ? '신규등록: 실행 로그' : '단일 상품 수정: 상품 편집');
    assert.equal(await page.locator('#btn-clear-log').getAttribute('title'), isNew ? '로그 지우기' : '선택한 폼 모두 닫기');
    assert.equal(await page.locator('#btn-run').isVisible(), isNew);
    // 로그는 두 모드 모두 보인다(수정 저장 결과·판매자 콘솔·일괄 결과).
    assert.equal(await page.locator('#log-window').evaluate(el => getComputedStyle(el).display), 'flex');
    assert.equal(await page.locator('#card-area').evaluate(el => el.style.display), isNew ? 'none' : 'flex');
  }
  // 헤더 상태줄: addLog 의 마지막 줄(글자만). 경고·오류는 색으로 갈린다.
  async function expectStatus(text, level) {
    const status = page.locator('#shell-status');
    assert.equal(await status.isVisible(), true, '상태줄이 안 보인다');
    assert.equal(await status.textContent(), text);
    assert.equal(await status.getAttribute('data-level'), level);
  }
  await page.goto(`${url}?mode=edit`);
  await expectMode('edit');
  assert.equal(await page.locator('#shell-status').getAttribute('role'), 'status');
  assert.equal(await page.locator('#shell-status').getAttribute('aria-live'), 'polite');
  await page.evaluate(() => addLog('쿠팡 수정 저장 실패', 'error'));
  await expectStatus('쿠팡 수정 저장 실패', 'error');
  assert.equal(await page.locator('#log-window').isVisible(), true, '수정 모드에서도 로그가 보여야 한다');
  assert.equal(await page.locator('#empty-state').isVisible(), false);
  const levelColor = () => page.locator('#shell-status').evaluate(el => getComputedStyle(el).color);
  const errorColor = await levelColor();
  await page.evaluate(() => addLog('저장 완료', 'ok'));
  await expectStatus('저장 완료', 'ok');
  assert.notEqual(await levelColor(), errorColor, '오류 색이 남아 있다');
  // API KEY 화면에서도 상태줄은 보인다(로그창은 숨는다).
  await page.goto(`${url}?mode=edit`);
  await page.evaluate(() => addLog('아마존 일괄 수정 완료', 'warn'));
  await expectStatus('아마존 일괄 수정 완료', 'warn');
  await page.evaluate(() => { document.body.dataset.workspaceView = 'api'; addLog('API KEY 저장됨', 'info'); });
  await expectStatus('API KEY 저장됨', 'info');
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(`${url}?mode=edit`);
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
  assert.equal(await page.locator('#log-window').textContent(), 'old log', '모드를 바꿔도 로그는 남는다');
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
  // 수정 모드의 폼은 6몰 표였다 — 신규 모드엔 표가 없고 켠 몰도 없으니 폼을 닫는다(표가 아직 뜨는 중이면 뜬 뒤 닫는다).
  await page.locator('#form-frame').waitFor({ state: 'hidden' });
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
  // 라쿠텐·쇼피파이는 연동이 없어 꺼진 칸이다 — 켤 수 없으니 일괄 수정의 '상품 없음' 으로 세지 않는다.
  assert.equal(await page.locator('#cell-JAPAN-open2, #cell-ARAB-own').count(), 0);
  assert.equal(await page.locator('tr[data-country="JAPAN"] td.inactive-cell').count(), 2);
  assert.equal(await page.locator('tr[data-country="ARAB"] td.inactive-cell').count(), 4);
  // 아임웹 자사몰 3칸은 탭 하나(imwebHeadTab)를 같이 쓰는 진짜 칸이다 — 칸이 본사몰 구역이다(10-28, Open API).
  assert.equal(await page.locator('#cell-KOREA-own, #cell-USA-own, #cell-JAPAN-own').count(), 3);
  assert.equal(await page.locator('#board-body td.link-cell').count(), 0);
  const frame = page.frameLocator('#form-frame');
  const viewing = () => page.evaluate(() => [...document.querySelectorAll('#board-body td.viewing')].map(td => td.dataset.country + '-' + td.dataset.type));
  const unitIs = async country => {
    for (let i = 0; i < 60 && await frame.locator('#ihCountry').textContent() !== country; i++) await page.waitForTimeout(50);
    assert.equal(await frame.locator('#ihCountry').textContent(), country);
  };
  await page.locator('#cell-USA-own').click();
  await frame.locator('#imwebHeadTab .ih-edit').waitFor({ state: 'visible' });
  assert.equal(await frame.locator('#imwebHeadTab .ih-new').isVisible(), false, '수정 모드에는 신규 등록 칸이 숨는다');
  await unitIs('미국');
  assert.deepEqual(await viewing(), ['USA-own']);
  // 한국 칸을 켜면 그 구역으로 바뀐다. 켜진 미국 칸을 다시 누르면 끄지 않고 미국 구역으로 돌아간다(아마존과 같다).
  await page.locator('#cell-KOREA-own').click();
  await unitIs('한국');
  assert.deepEqual(await viewing(), ['KOREA-own']);
  await page.locator('#cell-USA-own').click();
  await unitIs('미국');
  assert.deepEqual([await page.evaluate(() => checked.USA.own), await viewing()], [true, ['USA-own']]);
  // 로고 타일은 이름(.plat-name) 대신 로고(.plat-logo)다 — 칸 자체를 누른다.
  await page.locator('#cell-KOREA-open1').click();
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
  await frame.locator('#templateIdInput').fill('existing-product-123');
  await page.evaluate(() => window.emitMode('edit'));
  assert.equal(await frame.locator('#templateIdInput').inputValue(), 'existing-product-123');
  assert.equal(await frame.locator('#ssEditPanel').isVisible(), true);
  // The same selected platform stays open when the top mode changes.
  await page.locator('label[for="mode-new"]').click();
  await expectMode('new');
  assert.equal(await page.locator('#cell-KOREA-open1').getAttribute('aria-checked'), 'true');
  assert.equal(await frame.locator('#naverTab').isVisible(), true);
  assert.equal(await frame.locator('#ssEditPanel').isVisible(), false);
  assert.equal(await frame.locator('input[name="workMode"]').inputValue(), 'copy');
  await page.locator('label[for="mode-edit"]').click();
  for (const [cell, panel, name, tab] of [
    ['KOREA-open2', 'cpEditPanel', 'cpWorkMode', 'coupangTab'],
    ['USA-open1', 'amzEditPanel', 'amzWorkMode', 'amazonTab'],
    ['KOREA-b2b', 'iwB2bEditPanel', 'iwB2bWorkMode', 'imwebTab'],
  ]) {
    await page.locator('#cell-' + cell).click();
    await frame.locator('#' + panel).waitFor({ state: 'visible' });
    assert.equal(await frame.locator('#' + tab + ' #' + panel).count(), 1);
    assert.equal(await frame.locator('input[name="' + name + '"]').inputValue(), 'edit');
    assert.equal(await frame.locator('input[type="radio"][name="' + name + '"]').count(), 0);
  }
  await page.locator('#cell-USA-open2').click();
  await frame.locator('#ebEditForm').waitFor({ state: 'visible' });
  assert.equal(await frame.locator('#ebMode').isVisible(), false);
  await page.locator('label[for="mode-new"]').click();
  await frame.locator('#ebNewForm').waitFor({ state: 'visible' });
  // '← 런처로': 일괄 등록·수정 중이면 묻고, 취소하면 창을 닫지 않는다.
  const backSent = () => page.evaluate(() => window.modeMessages.filter(m => m.channel === 'close-app').length);
  const asked = [];
  let answer = false;
  page.on('dialog', d => { asked.push(d.message()); return answer ? d.accept() : d.dismiss(); });
  await page.evaluate(() => { isBulkRunning = true; bulkKind = '일괄 등록'; });
  await page.locator('#btn-back').click();
  assert.match(asked[0], /일괄 등록이 진행 중입니다/);
  assert.equal(await backSent(), 0, '취소했는데 런처로 갔다');
  answer = true;
  await page.locator('#btn-back').click();
  assert.equal(await backSent(), 1);
  await page.evaluate(() => { isBulkRunning = false; });
  await page.locator('#btn-back').click();
  assert.equal(asked.length, 2, '진행 중인 일이 없는데 물었다');
  assert.equal(await backSent(), 2);
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
  console.log('PASS: top mode parameters, platform edit forms, removed radios, edit action routing, preserved selection, IPC and reload, header status line, log kept across modes, inactive Rakuten/Shopify, back confirm during bulk');
} finally {
  await browser.close();
}
