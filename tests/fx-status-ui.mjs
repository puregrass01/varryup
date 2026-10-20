import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import path from 'node:path';

const browser = await chromium.launch({ headless: true,
  executablePath: process.env.EBAY_TEST_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
try {
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setContent('<div id="root"><div class="be-head"></div></div>');
  await page.addScriptTag({ path: path.resolve('src/ui/fx-auto-price.js') });
  await page.evaluate(() => {
    window.calls = [];
    window.savedRate = { KRW: 1354.92, JPY: 157.115, marketDate: '2026-09-30', fetchedAt: new Date().toISOString(), source: 'Yahoo Finance (앱 직접 조회)' };
    window.mockState = { enabled: false, scopes: {}, tiers: [], channels: [], rate: savedRate, rateError: '', running: null,
      lastRun: { startedAt: '2026-09-30T11:01:56Z', finishedAt: '2026-09-30T11:02:00Z', trigger: 'manual',
        error: '환율 서버 응답 오류 (HTTP 404)', scopes: {} } };
    window.VUFxAutoPrice.mount(document.getElementById('root'), {
      on(channel, handler) { if (channel === 'fx-auto-price-progress') window.notifyProgress = handler; },
      async invoke(channel) { calls.push(channel); if (channel !== 'fx-auto-price-get') throw new Error('Unexpected mutation ' + channel);
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
  assert.deepEqual(await page.evaluate(() => [...new Set(calls)]), ['fx-auto-price-get']);
  assert.deepEqual(errors, []);
  console.log('PASS: recovered FX with preserved 404 history, active FX errors, unrelated failures, no price writes.');
} finally { await browser.close(); }
