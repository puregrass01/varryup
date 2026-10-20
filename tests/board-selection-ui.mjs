// 현황판 선택 저장 · 복원 · 빠른 선택 회귀 검사 — `npm run test:board-selection`
//
// 예전에는 앱을 켤 때마다 현황판이 전부 꺼진 채로 떠서, 같은 몰에 올리는 날에도 칸을 열 번씩 다시 눌렀다.
// 지키는 것:
//   1) 빠른 선택 칩은 그 조합으로 '바꾼다' (전체·국내·미국·일본·해제)
//   2) 지금 선택과 같은 칩만 눌린 상태로 보인다 — 칸을 직접 바꾸면 칩도 따라 꺼진다
//   3) 칩 하나로 여러 칸을 바꿔도 폼 탭은 한 번만 옮긴다 (칸마다 옮기면 열 번 바뀐다)
//   4) 선택은 다시 켜도 남는다 — 접힌 채로 떠도 복원되고, 창 크기는 안 바꾼다
//   5) 깨진 값 · 없는 칸 · 비활성 칸은 무시하고 에러 없이 뜬다
//   6) 수정 모드의 '비우기' 로 전부 끈 것도 저장된다
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const KEY = 'veryup.board.selection.v1';
const CELLS = {
  KOREA: ['own', 'b2b', 'open1', 'open2'],
  USA: ['own', 'open1', 'open2'],
  JAPAN: ['own', 'open1', 'open2'],
  ARAB: ['own'],
};
const ALL = Object.entries(CELLS).flatMap(([c, ts]) => ts.map(t => `${c}-${t}`));
const rowOf = (...countries) => countries.flatMap(c => CELLS[c].map(t => `${c}-${t}`)).sort();

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

  const open = async (query = '') => {
    await page.goto(url + query);
    await page.locator('#cell-KOREA-open1').waitFor();
  };
  const selected = () => page.evaluate(() =>
    [...document.querySelectorAll('#status-board [role="checkbox"][aria-checked="true"]')]
      .map(el => el.id.replace(/^cell-/, '')).sort());
  const pressed = () => page.evaluate(() =>
    [...document.querySelectorAll('.board-preset[aria-pressed="true"]')].map(b => b.dataset.preset));
  const preset = name => page.locator(`.board-preset[data-preset="${name}"]`).click();
  // 폼 탭을 몇 번 옮겼는지 센다 — 전역 함수 선언이라 window 의 것을 바꾸면 안쪽 호출도 이걸 탄다.
  const countTabSwitches = () => page.evaluate(() => {
    window.tabSwitches = 0;
    const real = window.openPlatformTab;
    window.openPlatformTab = (...args) => { window.tabSwitches += 1; return real(...args); };
  });

  // ── 처음: 저장된 것이 없으면 전부 꺼져 있고 칩도 안 눌려 있다 ───────────────
  await open();
  assert.deepEqual(await selected(), []);
  assert.deepEqual(await pressed(), []);
  assert.equal(await page.locator('.board-preset').count(), 5, '칩은 전체·국내·미국·일본·해제');

  // ── 칩은 그 조합으로 바꾼다 ───────────────────────────────────────────────
  await preset('korea');
  assert.deepEqual(await selected(), rowOf('KOREA'), '국내 = 한국 줄 네 칸');
  assert.deepEqual(await pressed(), ['korea']);

  await preset('usa');
  assert.deepEqual(await selected(), rowOf('USA'), '미국을 누르면 한국은 꺼진다 — 더하지 않고 바꾼다');
  assert.deepEqual(await pressed(), ['usa']);

  await preset('japan');
  assert.deepEqual(await selected(), rowOf('JAPAN'));
  assert.deepEqual(await pressed(), ['japan']);

  await countTabSwitches();
  await preset('all');
  assert.deepEqual(await selected(), [...ALL].sort(), '전체 = 켤 수 있는 열한 칸');
  assert.deepEqual(await pressed(), ['all']);
  assert.ok(await page.evaluate(() => window.tabSwitches) <= 1,
    `칸 여러 개를 바꿔도 폼 탭은 한 번만 옮긴다 (${await page.evaluate(() => window.tabSwitches)}번)`);

  await preset('none');
  assert.deepEqual(await selected(), []);
  assert.deepEqual(await pressed(), [], '해제 뒤에는 눌린 칩이 없다');

  // ── 칸을 직접 바꾸면 칩도 따라간다 ─────────────────────────────────────────
  // 켜진 칸을 마우스로 누르면, 그 몰 폼을 안 보고 있을 땐 끄지 않고 그 폼으로 간다(기존 편의 동작).
  // 바로 켜고 끄는 길은 Space 다 — role="checkbox" 가 약속하는 동작.
  await preset('korea');
  await page.locator('#cell-KOREA-open2').press(' ');       // 쿠팡 끄기
  assert.deepEqual(await selected(), rowOf('KOREA').filter(c => c !== 'KOREA-open2'));
  assert.deepEqual(await pressed(), [], '국내에서 한 칸 빠지면 국내 칩은 꺼진다');
  await page.locator('#cell-KOREA-open2').press(' ');       // 다시 켜면 국내와 같아진다
  assert.deepEqual(await pressed(), ['korea'], '다시 국내와 같아지면 칩이 켜진다');

  // ── 다시 켜도 남는다 ─────────────────────────────────────────────────────
  await preset('usa');
  await page.locator('#cell-KOREA-open1').click();          // 미국 + 네이버
  const before = await selected();
  await open();
  assert.deepEqual(await selected(), before, '다시 열면 지난번 선택 그대로다');
  assert.deepEqual(await pressed(), [], '어느 칩과도 같지 않으면 눌린 칩이 없다');

  // 앱처럼 접힌 채로 떠도 복원된다. 폼은 숨은 채로 미리 떠 있고, 창 크기는 안 바꾼다.
  await page.evaluate(() => { window.resizeCalls.length = 0; });
  await open('?mode=new&panels=collapsed');
  assert.deepEqual(await selected(), before, '접힌 채로 떠도 복원된다');
  assert.equal(await page.locator('#section8').isVisible(), false, '복원했다고 패널이 열리지는 않는다');
  assert.deepEqual(await page.evaluate(() => window.resizeCalls), [], '복원은 창 크기를 안 바꾼다');
  assert.ok((await page.locator('#form-frame').getAttribute('src') || '').includes('index.html'),
    '켜진 몰의 폼이 숨은 채로 미리 떠 있다 — 열기를 누르면 바로 보인다');
  await page.locator('#btn-toggle-detail').click();
  assert.equal(await page.locator('#form-frame').isVisible(), true, '열면 폼이 바로 보인다');

  // ── 깨진 값 · 없는 칸 · 비활성 칸은 무시한다 ──────────────────────────────
  await page.evaluate(k => localStorage.setItem(k, '{not json'), KEY);
  await open();
  assert.deepEqual(await selected(), [], '깨진 값이면 빈 현황판으로 뜬다');

  await page.evaluate(k => localStorage.setItem(k, JSON.stringify({
    KOREA: { open1: true, bogus: true },   // 없는 칸
    USA: { b2b: true },                    // 비활성 칸 (미국엔 B2B 가 없다)
    MARS: { own: true },                   // 없는 나라
  })), KEY);
  await open();
  assert.deepEqual(await selected(), ['KOREA-open1'], '켤 수 있는 칸만 되살린다');

  await page.evaluate(k => localStorage.setItem(k, '[true,true]'), KEY);
  await open();
  assert.deepEqual(await selected(), [], '배열 같은 엉뚱한 모양도 무시한다');

  // ── 수정 모드의 '비우기' 로 전부 끈 것도 저장된다 ─────────────────────────
  await preset('korea');
  await page.locator('label[for="mode-edit"]').click();
  await page.locator('#btn-clear-log').click();             // 수정 모드에선 '선택한 폼 모두 닫기'
  assert.deepEqual(await selected(), []);
  await open();
  assert.deepEqual(await selected(), [], '비우기로 끈 것이 다음에 되살아나면 안 된다');

  assert.deepEqual(errors, []);
  console.log('PASS: 빠른 선택(바꾸기·눌림 표시·탭 1회), 저장·복원(접힘 포함·창 크기 고정·폼 미리 띄움), 깨진 값 무시, 비우기 저장');
} finally {
  await browser.close();
}
