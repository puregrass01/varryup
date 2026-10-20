// 환율 자동 변경 패널의 '아임웹 미국·일본 상품명' 블록(가짜 IPC): 미리보기 → 저장 → 결과 CSV. 실행: node tests/imweb-names-ui.mjs
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import path from 'node:path';
const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
try {
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept());
  await page.setContent('<div id="root"><div class="be-head"></div></div>');
  await page.addScriptTag({ path: path.resolve('src/ui/fx-auto-price.js') });
  await page.evaluate(() => {
    window.calls = []; window.handlers = {};
    const data = {
      'fx-auto-price-get': { enabled: false, scopes: {}, tiers: [], channels: [], rate: null, rateError: '', running: null, lastRun: null },
      'imweb-unit-names-preview': { products: 1644, translated: 68, changes: 1513, skipped: 63, lines: ['옵틱글래스 재규어 XJ 광각미러 [No.960] → Optic-glass Jaguar XJ Wide View Side Mirror [No.960] · Optic-glass ジャガー XJ 広角ドアミラー [No.960]'] },
      'imweb-unit-names-save': { count: { saved: 1512, changedSince: 0, failed: 1 }, stopped: '', results: [{ name: 'X', result: '확인 실패(지금 미국 Y)' }] },
      'imweb-unit-names-rows': [{ prodNo: '2152', kr: '=옵틱', usNow: 'a', usNext: 'b', jpNow: 'c', jpNext: 'd', options: '미국 구성 선택→Select Option', note: '', result: '저장 완료' }],
    };
    window.VUFxAutoPrice.mount(document.getElementById('root'), {
      on(channel, handler) { handlers[channel] = handler; },
      async invoke(channel) { calls.push(channel); return { success: true, data: structuredClone(data[channel]) }; },
    });
  });
  await page.evaluate(() => { document.getElementById('fx-panel').open = true; });
  assert.equal(await page.locator('#fx-in-save').isDisabled(), true, 'save disabled before preview');
  await page.click('#fx-in-preview');
  await page.waitForFunction(() => document.getElementById('fx-in-result').textContent.includes('바꿀 상품 1,513개'));
  assert.match(await page.locator('#fx-in-result').textContent(), /Optic-glass Jaguar XJ/);
  await page.evaluate(() => handlers['imweb-unit-names-progress'](null, { running: { step: 'save', index: 3, total: 1513, message: 'XJ' } }));
  assert.match(await page.locator('#fx-in-status').textContent(), /저장 3\/1,513 · XJ/);
  await page.click('#fx-in-save');
  await page.waitForFunction(() => document.getElementById('fx-in-result').textContent.includes('완료 1,512개'));
  assert.equal(await page.locator('#fx-in-save').isDisabled(), true, 'save disabled after save');
  const dl = page.waitForEvent('download');
  await page.click('#fx-in-export');
  const file = await (await dl).path();
  const text = (await import('node:fs')).readFileSync(file, 'utf8');
  assert.match(text, /상품번호.*미국 새 이름/);
  assert.match(text, /"'=옵틱"/, 'formula guard');
  // 기존 판매가 블록도 그대로 뜬다
  assert.equal(await page.locator('#fx-iw-preview').count(), 1);
  assert.deepEqual(errors, []);
  console.log('names UI ok', await page.locator('#fx-in-status').textContent());
} finally { await browser.close(); }
