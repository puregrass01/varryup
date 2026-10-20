// 단일 상품 수정 — 네이버·쿠팡 '제조사·차종으로 번호 찾기' 회귀 검사 — `npm run test:edit-find-keys`
//
// 예전에는 좌측 '상품 정보 (검색 조건)' 에 브랜드·차종명을 쳐 놓고 네이버 탭의 찾기 칸에 또 쳤다.
// (수정 모드에서 셸이 아마존·이베이·쿠팡·아임웹에는 열쇠를 넘기는데 네이버에만 아무것도 안 넘겼다.)
// 지키는 것:
//   1) 좌측 브랜드·차종명이 네이버·쿠팡 찾기 칸에 들어간다
//   2) 찾기는 저절로 돌지 않는다 — 네이버 찾기는 상품 목록 전체를 훑는 무거운 조회다
//   3) 좌측 '상품번호'(내부 번호)는 네이버 '수정할 상품번호'(스마트스토어 번호)에 들어가지 않는다
//   4) 탭에서 직접 고친 검색어는 좌측이 그대로인 동안 덮지 않고, 좌측을 비워도 지우지 않는다
//   5) 찾기 결과가 하나뿐이면 표를 또 누를 것 없이 번호가 채워진다 (여럿이면 사람이 고른다)
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
  // 셸과 등록 폼(iframe) 둘 다 이 가짜 IPC 를 쓴다. 찾기 결과는 각 창의 __findRows 로 정한다.
  await context.addInitScript(() => {
    window.invokes = [];
    window.require = () => ({ ipcRenderer: {
      on() {}, send() {},
      invoke(channel, payload) {
        window.invokes.push(channel);
        if (channel === 'smartstore-find-id' || channel === 'coupang-find-id') {
          return Promise.resolve({ success: true, source: 'api', rows: window.__findRows || [] });
        }
        return Promise.resolve({});
      },
    } });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(pathToFileURL(path.resolve('src/ui/index_up.html')).href);
  await page.locator('#cell-KOREA-open1').waitFor();

  const frame = page.frameLocator('#form-frame');
  const child = () => page.frames().find(f => f.url().includes('/index.html'));
  const tabValue = id => frame.locator('#' + id).inputValue();
  // 좌측 칸은 잠깐 모았다가 한 번에 넣는다(scheduleFrameSync). 들어갈 때까지 기다린다.
  async function waitTab(id, want) {
    for (let i = 0; i < 60; i++) {
      if (await tabValue(id) === want) return;
      await page.waitForTimeout(50);
    }
    assert.equal(await tabValue(id), want, `#${id} 에 "${want}" 가 들어가야 한다`);
  }

  // ── 단일 상품 수정 + 네이버 ─────────────────────────────────────────────
  await page.locator('label[for="mode-edit"]').click();
  await page.locator('#cell-KOREA-open1').click();
  await frame.locator('#ssEditPanel').waitFor({ state: 'visible' });

  await page.locator('#inp-brand').fill('현대');
  await page.locator('#inp-carmodel').fill('싼타페');
  await page.locator('#inp-no').fill('612');
  await waitTab('ssFindBrand', '현대');
  await waitTab('ssFindModel', '싼타페');
  assert.equal(await tabValue('templateIdInput'), '',
    "좌측 상품번호(612)는 네이버 '수정할 상품번호'(스마트스토어 번호)에 넣지 않는다");

  // 찾기는 저절로 돌지 않는다.
  await page.waitForTimeout(400);
  assert.equal((await child().evaluate(() => window.invokes)).includes('smartstore-find-id'), false,
    '좌측 칸이 바뀌었다고 네이버 찾기(목록 전체 조회)를 돌리면 안 된다');

  // 탭에서 직접 고친 검색어는 좌측이 그대로인 동안 덮지 않는다.
  await frame.locator('#ssFindModel').fill('싼타페 TM');
  await page.locator('#inp-code').fill('TM');               // 좌측의 다른 칸을 바꿔 채우기를 다시 돌린다
  await page.waitForTimeout(500);
  assert.equal(await tabValue('ssFindModel'), '싼타페 TM', '좌측 차종명이 그대로면 탭에서 고친 검색어를 지키다');

  // 좌측을 비워도 탭 검색어를 지우지 않는다.
  await page.locator('#inp-brand').fill('');
  await page.waitForTimeout(500);
  assert.equal(await tabValue('ssFindBrand'), '현대', '좌측이 비었다고 탭 검색어를 지우지 않는다');

  // 좌측 값이 바뀌면 다시 들어간다.
  await page.locator('#inp-brand').fill('기아');
  await waitTab('ssFindBrand', '기아');

  // ── 찾기 결과가 하나면 번호가 바로 채워진다, 여럿이면 사람이 고른다 ─────────
  await child().evaluate(() => { window.__findRows = [
    { id: '11111111111', name: '옵틱글래스 싼타페 A' }, { id: '22222222222', name: '옵틱글래스 싼타페 B' }] });
  await frame.locator('button[onclick="findSmartstoreId()"]').click();
  await frame.locator('#ssFindResult table, #ssFindResult .vu-pt').first().waitFor();
  assert.equal(await tabValue('templateIdInput'), '', '결과가 여럿이면 저절로 고르지 않는다');

  await child().evaluate(() => { window.__findRows = [{ id: '13427230028', name: '옵틱글래스 싼타페 TM' }] });
  await frame.locator('button[onclick="findSmartstoreId()"]').click();
  await waitTab('templateIdInput', '13427230028');

  // ── 쿠팡도 같은 찾기 칸을 받는다 ─────────────────────────────────────────
  await page.locator('#cell-KOREA-open2').click();
  await frame.locator('#cpEditPanel').waitFor({ state: 'visible' });
  await page.locator('#inp-carmodel').fill('쏘렌토');
  await waitTab('cpFindBrand', '기아');
  await waitTab('cpFindModel', '쏘렌토');

  await child().evaluate(() => { window.__findRows = [{ id: '9876543210', name: '옵틱글래스 쏘렌토' }] });
  await frame.locator('button[onclick="findCoupangIdFromSheet()"]').click();
  await waitTab('cpProductIdInput', '9876543210');

  assert.deepEqual(errors, []);
  console.log('PASS: 네이버·쿠팡 찾기 칸에 좌측 브랜드·차종명, 자동 조회 없음, 내부 상품번호 안 넘김, 탭 수정 존중, 결과 1건 자동 채움');
} finally {
  await browser.close();
}
