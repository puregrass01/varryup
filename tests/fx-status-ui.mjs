import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import path from 'node:path';

const browser = await chromium.launch({ headless: true,
  executablePath: process.env.EBAY_TEST_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
try {
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setContent('<section id="fx-workspace"></section>');
  await page.addScriptTag({ path: path.resolve('src/ui/fx-auto-price.js') });
  await page.evaluate(() => {
    window.calls = [];
    window.savedRate = { KRW: 1354.92, JPY: 157.115, marketDate: '2026-09-30', fetchedAt: new Date().toISOString(), source: 'Yahoo Finance (앱 직접 조회)' };
    window.mockState = { enabled: false, scopes: {}, tiers: [], channels: [], rate: savedRate, rateError: '', running: null,
      lastRun: { startedAt: '2026-09-30T11:01:56Z', finishedAt: '2026-09-30T11:02:00Z', trigger: 'manual',
        error: '환율 서버 응답 오류 (HTTP 404)', scopes: {} } };
    window.VUFxAutoPrice.mount(document.getElementById('fx-workspace'), {
      on(channel, handler) { if (channel === 'fx-auto-price-progress') window.notifyProgress = handler; },
      async invoke(channel, data) { calls.push(channel); window.lastData = data; if (channel !== 'fx-auto-price-get') throw new Error('Unexpected mutation ' + channel);
        return { success: true, data: structuredClone(mockState) }; }
    });
  });
  await page.waitForFunction(() => document.getElementById('fx-brief').textContent.includes('현재 환율 정상'));
  assert.match(await page.locator('#fx-last').textContent(), /이전 실행 오류: 환율 서버 응답 오류/);
  assert.match(await page.locator('#fx-last').textContent(), /다시 실행된 것은 아닙니다/);
  assert.equal(await page.locator('#fx-last .fx-warn').count(), 0);
  assert.match(await page.locator('#fx-rate').textContent(), /앱 직접 조회/);

  // A current failure must stay visible, even when it resembles the history entry.
  await page.evaluate(() => { mockState.rate = null; mockState.rateError = '최신 환율을 조회하지 못했습니다'; notifyProgress(null, { running: null }); });
  await page.waitForFunction(() => document.getElementById('fx-rate').textContent.includes('환율을 쓸 수 없습니다'));
  assert.ok(!(await page.locator('#fx-brief').textContent()).includes('현재 환율 정상'));
  assert.equal(await page.locator('#fx-last .fx-warn').count(), 1);

  // A fresh quote does not resolve unrelated marketplace failures.
  await page.evaluate(() => { mockState.rate = savedRate; mockState.rateError = ''; mockState.lastRun.error = '상품 가격 저장 실패'; notifyProgress(null, { running: null }); });
  await page.waitForFunction(() => document.getElementById('fx-last').textContent.includes('상품 가격 저장 실패'));
  assert.equal(await page.locator('#fx-last .fx-warn').count(), 1);
  assert.ok(!(await page.locator('#fx-brief').textContent()).includes('현재 환율 정상'));

  // '환율' 탭에서는 늘 펼쳐 둔다(접힘 요약줄 없음). 탭을 열 때 refresh 로 다시 읽되, 고치던 등급표는 덮지 않는다(isDirty).
  assert.equal(await page.locator('#fx-workspace > #fx-panel').count(), 1);
  assert.equal(await page.locator('details, summary').count(), 0);
  assert.equal(await page.locator('#fx-rate').isVisible(), true);
  let seen = await page.evaluate(() => calls.length);
  await page.evaluate(() => VUFxAutoPrice.refresh());
  await page.waitForFunction(n => calls.length > n, seen);
  assert.equal(await page.evaluate(() => VUFxAutoPrice.isDirty()), false);
  await page.click('#fx-tier-add');
  assert.equal(await page.evaluate(() => VUFxAutoPrice.isDirty()), true);
  seen = await page.evaluate(() => calls.length);
  await page.evaluate(() => VUFxAutoPrice.refresh());
  assert.equal(await page.evaluate(() => calls.length), seen, 'dirty refresh skipped');
  assert.equal(await page.locator('#fx-tier-body tr').count(), 1);
  assert.deepEqual(await page.evaluate(() => [...new Set(calls)]), ['fx-auto-price-get']);

  // 10% 초과 검토: 마지막 실행이 건너뛴 상품을 골라 저장하면 그 키로만 approve 를 부른다.
  await page.evaluate(() => { mockState.lastRun.review = [{ scope: 'ebay', id: 'E1', name: '미러', current: '90', target: '110', change: 0.222, tier: '일반 미러' },
    { scope: 'ebay', id: 'E2', name: '미러 2', current: '90', target: '110', change: 0.222, tier: '일반 미러' }]; notifyProgress(null, { running: null }); });
  await page.waitForSelector('#fx-last details.fx-review');
  assert.match(await page.locator('#fx-last summary').textContent(), /10% 초과 2건 검토/);
  await page.click('#fx-last summary');
  await page.check('#fx-last .fx-review input[value="ebay:E1"]');
  page.once('dialog', d => d.accept());
  await page.click('#fx-review-save');
  await page.waitForFunction(() => calls.includes('fx-auto-price-approve'));
  assert.deepEqual(await page.evaluate(() => lastData), { keys: ['ebay:E1'] });
  assert.deepEqual(errors, []);
  console.log('PASS: recovered FX with preserved 404 history, active FX errors, unrelated failures, no price writes, 10% review approve.');
} finally { await browser.close(); }
