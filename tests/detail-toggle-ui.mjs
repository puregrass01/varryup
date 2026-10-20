// 접기 / 열기 회귀 검사 — `npm run test:detail-toggle`
//
// 기본 화면은 현황판(왼쪽 입력판)뿐이다. '열기' 를 눌러야 신규등록 패널(오른쪽 폼·로그·이미지 목록)이
// 나오고, '접기' 를 누르면 다시 숨는다. 가운데 쇼핑몰 탭은 없앴다(현황판 칸이 그 일을 한다 — 2026-10-16).
// 앱은 main_process 가 ?panels=collapsed 로 띄워 접힌 채로 시작한다.
// 쿼리 없이 열면(다른 UI 테스트들) 예전처럼 다 펼친 화면이다 — 그 테스트들을 깨지 않으려는 것.
// (그 전 설계는 반대로 왼쪽 입력판을 접었다.)
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
    window.resizeCalls = [];
    window.require = () => ({ ipcRenderer: {
      on() {},
      send(channel, payload) { if (channel === 'veryup-resize-window') window.resizeCalls.push(payload); },
      invoke() { return Promise.resolve({}); },
    } });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const url = pathToFileURL(path.resolve('src/ui/index_up.html')).href;
  const toggle = page.locator('#btn-toggle-detail');

  const state = () => page.evaluate(() => {
    const shown = id => !!document.getElementById(id)?.getClientRects().length;
    const t = document.getElementById('btn-toggle-detail').getBoundingClientRect();
    return {
      board: shown('section7'),
      malls: !!document.getElementById('mall-sidebar'),
      form: shown('section8'),
      images: shown('image-library'),
      label: document.getElementById('detail-toggle-label').textContent,
      icon: document.getElementById('detail-toggle-icon').textContent,
      expanded: document.getElementById('btn-toggle-detail').getAttribute('aria-expanded'),
      toggleLeft: Math.round(t.left),
      toggleInView: t.width > 0 && t.left >= 0 && t.right <= innerWidth && t.bottom <= innerHeight,
    };
  });
  const resizes = () => page.evaluate(() => window.resizeCalls.splice(0));

  // ── 쿼리 없이 열면 다 펼친 화면 (다른 UI 테스트들이 기대하는 모습) ──────
  await page.goto(url);
  await toggle.waitFor();
  const plain = await state();
  assert.deepEqual(
    { board: plain.board, malls: plain.malls, form: plain.form, label: plain.label, expanded: plain.expanded },
    { board: true, malls: false, form: true, label: '접기', expanded: 'true' },
    '쿼리 없이 열면 다 펼쳐져 있다');

  // ── 앱이 띄우는 모습: 현황판만 ─────────────────────────────────────────
  await page.goto(url + '?mode=new&panels=collapsed');
  await toggle.waitFor();
  const start = await state();
  assert.equal(start.board, true, '현황판(왼쪽 입력판)은 보인다');
  assert.equal(start.malls, false, '가운데 쇼핑몰 탭은 없다');
  assert.equal(start.form, false, '신규등록 패널은 열기 전에는 안 보인다');
  assert.equal(start.images, false, '이미지 목록은 신규등록 패널 안에 있어 같이 숨는다');
  assert.equal(start.label, '열기');
  assert.equal(start.icon, '▶');
  assert.equal(start.expanded, 'false');
  assert.ok(start.toggleLeft <= 12, `버튼은 왼쪽 끝이다 (x=${start.toggleLeft})`);
  assert.equal(start.toggleInView, true);
  assert.deepEqual(await resizes(), [], '시작할 때는 크기 요청을 안 보낸다 — 창이 이미 접힌 폭으로 만들어져 있다');

  // ── 열기 ────────────────────────────────────────────────────────────
  await toggle.click();
  const opened = await state();
  assert.equal(opened.board, true);
  assert.equal(opened.form, true, '열기를 누르면 신규등록 패널이 나온다');
  assert.equal(opened.images, true);
  assert.equal(opened.label, '접기', '열기를 누르면 버튼이 접기로 바뀐다');
  assert.equal(opened.icon, '◀');
  assert.equal(opened.expanded, 'true');
  assert.ok(opened.toggleLeft <= 12, `펼친 뒤에도 버튼은 왼쪽 끝이다 (x=${opened.toggleLeft})`);
  assert.deepEqual(await resizes(), [{ width: 1200 }], '열면 창을 3열 폭으로 넓힌다');

  // ── 접기 ────────────────────────────────────────────────────────────
  await toggle.click();
  const closed = await state();
  assert.equal(closed.board, true);
  assert.equal(closed.malls, false);
  assert.equal(closed.form, false);
  assert.equal(closed.label, '열기', '접기를 누르면 버튼이 열기로 바뀐다');
  assert.deepEqual(await resizes(), [{ width: 400 }], '접으면 창을 현황판 폭으로 줄인다');

  // ── 접힌 채로 현황판 칸을 눌러도 패널은 숨은 채이고 창도 안 커진다 ─────────
  // (칸 클릭은 폼을 띄우는 openDetailSidebar 를 부른다. 접혀 있을 때 1200 으로 넓히면 빈 창이 된다.)
  await page.locator('#cell-KOREA-open1').click();
  const afterCell = await state();
  assert.equal(afterCell.form, false, '접힌 채로는 칸을 눌러도 패널이 안 나온다 — 열기로만 연다');
  // 현황판 칸은 <input> 이 아니라 role="checkbox" 인 div 다.
  assert.equal(await page.locator('#cell-KOREA-open1').getAttribute('aria-checked'), 'true', '대상 선택은 된다');
  assert.deepEqual(await resizes(), [], '접힌 채로는 창을 넓히지 않는다');

  // 열면 방금 고른 몰의 폼이 이미 떠 있다. 로드된 iframe 은 토글에 살아남는다.
  await toggle.click();
  const frame = page.frameLocator('#form-frame');
  await frame.locator('#naverTab').waitFor({ state: 'visible' });
  await frame.locator('body').evaluate(el => { el.dataset.toggleSentinel = 'retained'; });
  await toggle.click();
  await toggle.click();
  assert.equal(await frame.locator('body').getAttribute('data-toggle-sentinel'), 'retained', 'iframe 이 다시 로드되지 않는다');
  await resizes();

  // ── 접히는 칸 안에 포커스가 있으면 버튼으로 옮긴다 ───────────────────────
  assert.equal((await state()).form, true);
  await page.evaluate(() => {
    document.getElementById('btn-clear-log').focus();
    document.getElementById('btn-toggle-detail').click();
  });
  assert.equal(await page.evaluate(() => document.activeElement.id), 'btn-toggle-detail');
  assert.equal((await state()).form, false);

  // ── 키보드로도 된다 ────────────────────────────────────────────────────
  await toggle.press('Enter');
  assert.equal((await state()).form, true);
  await toggle.press('Enter');
  assert.equal((await state()).form, false);

  // ── 실제 접힌 폭(400px)에서 현황판이 잘리지 않고 버튼도 보인다 ─────────────
  await page.setViewportSize({ width: 400, height: 850 });
  const narrow = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    boardRight: Math.round(document.getElementById('status-board').getBoundingClientRect().right),
    width: document.documentElement.clientWidth,
  }));
  assert.equal(narrow.overflow, false, '400px 에서 가로 스크롤이 생기면 안 된다');
  assert.ok(narrow.boardRight <= narrow.width, `현황판이 창 안에 들어온다 (${narrow.boardRight} ≤ ${narrow.width})`);
  assert.equal((await state()).toggleInView, true);

  assert.deepEqual(errors, []);
  console.log('PASS: 기본은 현황판만 · 열기로 신규등록(폼·이미지 목록) · 접기 ↔ 열기 · 버튼 왼쪽 · 접힌 채 칸 클릭에 창 고정 · iframe 유지');
} finally {
  await browser.close();
}
