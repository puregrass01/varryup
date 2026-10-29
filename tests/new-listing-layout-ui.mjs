// 신규 등록 화면 배치 회귀 검사 — `npm run test:new-listing-ui` (2026-10-16 요청)
//
//  · 가운데 쇼핑몰 탭은 없다. 현황판 칸이 켜고 끄기와 '지금 열린 폼' 표시(.viewing)를 같이 한다.
//  · 이미지 목록은 오른쪽 신규등록 패널, 폼 오른쪽에 있다(수정 모드에선 숨는다).
//  · 신규 등록 몰 폼에는 판매가·재고·판매설정·상품명·상세설명만 보인다 — 나머지는 좌측이 채운다.
//    아임웹 카테고리는 좌측 브랜드가 표에 없을 때(needs-pick)만 국산/수입·동기화와 함께 드러난다.
//  · 짝 입력칸은 폼 폭의 25%(예전 50%). 수정 모드의 한 줄 칸·버튼은 50%(예전 100%, 2026-10-27).
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
  const context = await browser.newContext({ viewport: { width: 1200, height: 850 } });
  await context.route(/^https?:/, route => route.abort());
  await context.addInitScript(() => {
    window.require = () => ({ ipcRenderer: { on() {}, send() {}, invoke: async ch => (ch === 'veryup-get-mode' ? 'new'
      : ch === 'imweb-load-categories' ? { success: true, categories: { 국산차: { 현대: ['싼타페'] }, 수입차: {} } }
      : {}) } });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(pathToFileURL(path.resolve('src/ui/index_up.html')).href);
  const frame = page.frameLocator('#form-frame');

  // ── 셸 배치 ───────────────────────────────────────────────────────
  const layout = await page.evaluate(() => {
    const lib = document.getElementById('image-library');
    const main = document.getElementById('section8-main').getBoundingClientRect();
    return {
      sidebar: !!document.getElementById('mall-sidebar') || !!document.querySelector('.mall-vtab'),
      inSection8: !!lib.closest('#section8-body'),
      rightOfForm: lib.getBoundingClientRect().left >= main.right - 1,
    };
  });
  assert.deepEqual(layout, { sidebar: false, inSection8: true, rightOfForm: true }, '가운데 탭 없음 · 이미지 목록은 폼 오른쪽');
  // 이미지 목록을 접으면 그 폭을 폼에 돌려준다.
  const mainWidth = () => page.evaluate(() => document.getElementById('section8-main').getBoundingClientRect().width);
  const before = await mainWidth();
  await page.locator('#image-library > summary').click();
  assert.ok(await mainWidth() > before + 100, '접은 이미지 목록이 폭을 잡고 있으면 안 된다');
  await page.locator('#image-library > summary').click();

  const viewing = () => page.evaluate(() => [...document.querySelectorAll('#board-body .platform-cell.viewing')]
    .map(td => `${td.dataset.country}-${td.dataset.type}`).join(','));
  const shown = (ids) => Promise.all(ids.map(async id => [id, await frame.locator('#' + id).isVisible()]));
  const expectFields = async (label, visible, hidden) => {
    for (const [id, v] of await shown(visible)) assert.equal(v, true, `${label}: ${id} 보여야 한다`);
    for (const [id, v] of await shown(hidden)) assert.equal(v, false, `${label}: ${id} 숨어야 한다`);
  };
  const open = async (cell, tab) => {
    await page.locator('#cell-' + cell).click();
    await frame.locator('#' + tab).waitFor({ state: 'visible' });
  };

  // ── 쿠팡: 현황판 칸이 폼을 열고 '열림' 표시 ─────────────────────────────
  await open('KOREA-open2', 'coupangTab');
  assert.equal(await page.locator('#cell-KOREA-open2').getAttribute('aria-checked'), 'true');
  assert.equal(await viewing(), 'KOREA-open2', '열린 몰 칸만 표시');
  await expectFields('쿠팡', ['cpTitlePreview', 'cpPrice', 'cpStock', 'cpEsmHtml', 'coupangRegisterBtn'],
    ['cpBrand', 'cpModel', 'cpProductIdInput', 'cpOptModel', 'cpOptProduct']);
  assert.equal(await frame.locator('#coupangTab input[name="cpCategory"]').first().locator('xpath=ancestor::div[contains(@class,"form-group")]').isVisible(), false, '쿠팡: 상품 구분 숨김');
  // 짝 칸 하나 = 폼 폭의 약 25%
  const ratio = await frame.locator('#coupangTab').evaluate(tab => {
    const pane = tab.getBoundingClientRect(), cs = getComputedStyle(tab);
    const inner = pane.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    return tab.querySelector('#cpPrice').getBoundingClientRect().width / inner;
  });
  assert.ok(ratio > 0.2 && ratio <= 0.26, `쿠팡 판매가 칸 폭 ${(ratio * 100).toFixed(1)}% — 25% 근처여야 한다`);
  // 숨긴 단계를 빼고 번호를 다시 센다: 보이는 단계 = 상품 정보, 상세설명
  const steps = await frame.locator('#coupangTab .step-indicator:visible span').allTextContents();
  assert.deepEqual(steps.map(s => s.trim()), ['상품 정보', '상세설명 (ESM HTML)']);

  // ── 네이버 ──
  await open('KOREA-open1', 'naverTab');
  assert.equal(await viewing(), 'KOREA-open1');
  await expectFields('네이버', ['price', 'stock', 'titlePreview', 'naverEsmHtml', 'registerBtn'],
    ['brand', 'model', 'templateIdInput', 'optionModel', 'optionSeat']);

  // ── 아마존: 통화·이미지 주소 숨김, 불릿·설명은 넓게 ──
  await open('USA-open1', 'amazonTab');
  assert.equal(await viewing(), 'USA-open1');
  await expectFields('아마존', ['amzTitle', 'amzPrice', 'amzStock', 'amzBulletPoints', 'amzDescription'],
    ['amzCurrency', 'amzMainImageUrl', 'amzSubImages', 'amzProductType']);
  const bulletRatio = await frame.locator('#amazonTab').evaluate(tab =>
    tab.querySelector('#amzBulletPoints').getBoundingClientRect().width / tab.getBoundingClientRect().width);
  assert.ok(bulletRatio > 0.35, `아마존 불릿 칸은 25% 로 줄이지 않는다 (${(bulletRatio * 100).toFixed(1)}%)`);

  // ── 이베이: 이미지 주소는 이미지 목록이 정한다. 브랜드·MPN·카테고리는 좌측이 안 채워서 남긴다 ──
  await open('USA-open2', 'ebayTab');
  await expectFields('이베이', ['ebTitle', 'ebPrice', 'ebQuantity', 'ebDescription', 'ebBrand', 'ebMpn', 'ebCategoryId'],
    ['ebImages', 'ebSku']);
  const [pb, qb] = await Promise.all(['ebPrice', 'ebQuantity'].map(id => frame.locator('#' + id).evaluate(el => el.getBoundingClientRect().bottom)));
  assert.ok(Math.abs(pb - qb) < 1, `이베이 판매가·수량 칸 높이가 맞아야 한다 (${pb} vs ${qb})`);

  // ── 아임웹 B2B: 판매설정(개별/세트)·조견표만. 카테고리 칸은 표에 없는 브랜드일 때만 ──
  await open('KOREA-b2b', 'imwebTab');
  await expectFields('B2B', ['iwSpecImageUrl', 'imwebRegisterBtn'],
    ['iwMainImageUrl', 'btnSyncCategories', 'iwBrand']);
  for (const id of ['iwRegisterIndiv', 'iwRegisterSet']) {
    assert.equal(await frame.locator(`label:has(#${id})`).isVisible(), true, `B2B: ${id} 판매설정 보임`);
  }
  assert.equal(await frame.locator('label:has(#iwBsaO)').isVisible(), false, 'B2B: BSA 는 좌측이 정한다');
  // 표에 있는 브랜드·차종 → 숨은 채. 차종만 목록에 없으면(아임웹에 새로 생긴 차종) 동기화 버튼이 드러난다.
  await page.locator('#inp-brand').fill('현대');
  await page.locator('#inp-carmodel').fill('싼타페');
  await page.waitForFunction(() => frameSyncTimer === null);
  assert.equal(await frame.locator('#iwModel').inputValue(), '싼타페');
  assert.equal(await frame.locator('#btnSyncCategories').isVisible(), false);
  await page.locator('#inp-carmodel').fill('새차종');
  await frame.locator('#btnSyncCategories').waitFor({ state: 'visible' });
  await page.locator('#inp-carmodel').fill('싼타페');
  await frame.locator('#btnSyncCategories').waitFor({ state: 'hidden' });
  await page.locator('#inp-brand').fill('없는브랜드');
  await frame.locator('#btnSyncCategories').waitFor({ state: 'visible' });
  assert.equal(await frame.locator('#iwBrand').isVisible(), true, '표에 없는 브랜드 → 카테고리 칸·동기화가 드러난다');

  // 키보드: Enter 는 켜진 몰의 폼을 연다(끄지 않는다). Space 는 켜고 끈다.
  await page.locator('#cell-KOREA-open1').press('Enter');
  await frame.locator('#naverTab').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#cell-KOREA-open1').getAttribute('aria-checked'), 'true', 'Enter 로 열어도 켜진 채');
  assert.equal(await viewing(), 'KOREA-open1');

  // ── 수정 모드: 상품ID 는 좌측이 넣어 숨김, 한 줄 칸·버튼은 폼의 50%, 이미지 목록 숨김 ──
  await page.locator('label[for="mode-edit"]').click();
  await open('KOREA-open2', 'coupangTab');   // 켜져 있고 다른 폼을 보는 중 → 끄지 않고 연다
  await frame.locator('#cpEditPanel').waitFor({ state: 'visible' });
  assert.equal(await frame.locator('#cpProductIdInput').isVisible(), false, '수정 모드: 쿠팡 상품ID 는 좌측이 넣는다');
  const editRatio = await frame.locator('#coupangTab').evaluate(tab => {
    const pane = tab.getBoundingClientRect(), cs = getComputedStyle(tab);
    const inner = pane.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    return tab.querySelector('#coupangRegisterBtn').getBoundingClientRect().width / inner;
  });
  assert.ok(editRatio > 0.45 && editRatio <= 0.51, `수정 모드 쿠팡 저장 버튼 폭 ${(editRatio * 100).toFixed(1)}% — 50% 근처여야 한다`);
  assert.equal(await page.locator('#image-library').isVisible(), true, '수정 모드에도 이미지 목록이 보인다(6몰 카드에 끌어 놓기)');

  assert.deepEqual(errors, []);
  console.log('PASS: 가운데 탭 없음 · 현황판 칸 열림 표시 · 이미지 목록 폼 오른쪽 · 신규 폼 칸 정리 · 짝 칸 25% · 이미지 목록 접으면 폭 반환 · 이베이 칸 줄 맞춤 · 카테고리(브랜드·차종 없음) 드러남 · Enter 로 폼 열기 · 수정 모드 상품ID 숨김 · 수정 모드 한 줄 칸 50%');
} finally {
  await browser.close();
}
