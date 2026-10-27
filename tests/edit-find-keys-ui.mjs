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

  // ── 아임웹 B2B·게시판 수정 — 폼만 따로 연다(셸이 브랜드 칸을 건드리지 않게) ─────────────
  //   6) B2B 제조사·모델 첫 칸은 '-- 전체 --' 이고 골라져 있다 — 상품 코드만으로 찾는다
  //   7) URL 칸을 비우면 숨은 idx 도 비운다
  //   8) 검색 전에 옛 결과·편집 상태를 지운다 — 실패해도 옛 상품이 남아 저장되지 않는다(게시판도)
  //   9) 동작하지 않는 칸·버튼(+ 옵션 추가, 판매가 (수정 가능), 옵션 값 + 추가)은 없다
  const formCtx = await browser.newContext({ viewport: { width: 1200, height: 850 } });
  await formCtx.route(/^https?:/, route => route.abort());
  await formCtx.addInitScript(() => {
    window.searches = [];
    window.require = () => ({ ipcRenderer: {
      on() {}, send() {},
      invoke(channel, payload) {
        if (channel === 'imweb-load-categories') {
          return Promise.resolve({ success: true, categories: { 국산차: { EVION: ['SW40', 'SW50'], 현대: ['싼타페'] }, 수입차: { BMW: ['X5'] } } });
        }
        if (channel === 'imweb-search-products' || channel === 'imweb-search-posts') {
          window.searches.push({ channel, payload });
          return Promise.resolve(window.__searchRes || { success: false, error: '상품을 찾지 못했습니다' });
        }
        return Promise.resolve({});
      },
    } });
  });
  const form = await formCtx.newPage();
  form.on('pageerror', error => errors.push(error.message));
  await form.goto(pathToFileURL(path.resolve('src/ui/index.html')).href);
  await form.evaluate(() => {
    switchTab('imwebTab');
    document.querySelector('input[name="iwB2bWorkMode"]').value = 'edit'; updateImwebB2bModeUI();
  });
  await form.locator('#iwB2bEditPanel').waitFor({ state: 'visible' });
  await form.waitForFunction(() => [...document.getElementById('iwB2bEditBrand').options].some(o => o.value === 'EVION'));
  const firstOption = id => form.evaluate(id => { const s = document.getElementById(id); return [s.value, s.options[0].text, s.options[0].value]; }, id);
  assert.deepEqual(await firstOption('iwB2bEditBrand'), ['', '-- 전체 --', ''], '제조사 첫 칸은 -- 전체 -- 이고 골라져 있다(예전엔 EVION)');
  assert.deepEqual(await firstOption('iwB2bEditModel'), ['', '-- 전체 --', ''], '모델 첫 칸도 -- 전체 --(예전엔 SW40)');
  await form.locator('#iwB2bEditBrand').selectOption('EVION');
  assert.deepEqual(await form.evaluate(() => [...document.getElementById('iwB2bEditModel').options].map(o => o.value)), ['', 'SW40', 'SW50']);
  await form.locator('#iwB2bEditBrand').selectOption('');

  await form.locator('#iwB2bEditCodeInput').fill('612');
  await form.evaluate(() => { window.__searchRes = { success: true, groups: [{ baseKey: '옵틱글래스 EVION SW40', items: [
    { name: '옵틱글래스 EVION SW40 미러 1셋 [612]', prodNo: 701, type: 'set', price: 100 }] }] }; });
  await form.locator('#iwB2bLoadBtn').click();
  await form.locator('#iwB2bResultList tbody tr').first().waitFor();
  assert.deepEqual(await form.evaluate(() => window.searches.at(-1).payload), { brand: '', model: '', code: '612', idx: '' },
    '상품 코드만으로 찾는다 — 제조사·모델로 거르지 않는다');

  await form.locator('#iwB2bEditUrlInput').fill('https://bb-store.co.kr/shop_view?idx=927');
  assert.equal(await form.locator('#iwB2bEditIdxInput').inputValue(), '927');
  await form.locator('#iwB2bEditUrlInput').fill('');
  assert.equal(await form.locator('#iwB2bEditIdxInput').inputValue(), '', 'URL 칸을 비우면 숨은 idx 도 비운다');

  await form.evaluate(() => {
    iwB2bEditState = { baseKey: '옛 상품', products: [{ prodNo: 701 }], sharedGroups: [], detailImages: ['https://x/1.jpg'] };
    document.getElementById('iwB2bEditLoaded').style.display = '';
    window.__searchRes = { success: false, error: '상품을 찾지 못했습니다' };
  });
  await form.locator('#iwB2bLoadBtn').click();
  await form.waitForFunction(() => window.searches.length === 2 && !document.getElementById('iwB2bLoadBtn').disabled);
  assert.deepEqual(await form.evaluate(() => [iwB2bEditState, document.getElementById('iwB2bEditLoaded').style.display,
    document.getElementById('iwB2bSearchResult').style.display, document.getElementById('iwB2bResultList').childElementCount]),
  [null, 'none', 'none', 0], '검색이 실패해도 옛 결과·편집 상태가 남지 않는다');

  assert.equal(await form.locator('#iwB2bEditPanel button', { hasText: '옵션 추가' }).count(), 0, '정의 없는 + 옵션 추가 버튼이 없다');
  assert.equal(await form.locator('#iwB2bEditPrice').count(), 0, '아무도 읽지 않는 판매가 (수정 가능) 칸이 없다');
  await form.evaluate(() => {
    iwB2bEditState = { baseKey: 'K', sharedGroups: [{ name: '연식', values: ['A'] }], detailImages: [],
      products: [{ prodNo: 1, suffix: '', type: 'set', price: 1, optionGroups: [{ name: '연식', values: [{ valueName: 'A' }] }], combos: [] }] };
    renderImwebB2bOptions();
  });
  assert.equal(await form.locator('#iwB2bOptionList button', { hasText: '추가' }).count(), 0, '옵션 값 + 추가 줄이 없다(Open API 불가)');
  assert.equal(await form.locator('#iwB2bOptionList button', { hasText: '삭제' }).count(), 1);

  await form.evaluate(() => {
    switchTab('imwebBoardTab');
    document.querySelector('input[name="iwBoardWorkMode"]').value = 'edit'; updateImwebBoardModeUI();
  });
  await form.locator('#iwBoardEditPanel').waitFor({ state: 'visible' });
  assert.deepEqual(await firstOption('iwBoardEditBrand'), ['', '-- 브랜드 선택 --', ''], '게시판 브랜드도 첫 브랜드가 미리 골라져 있지 않다');
  await form.locator('#iwBoardEditCodeInput').fill('612');
  await form.locator('#iwBoardLoadBtn').click();
  assert.equal(await form.evaluate(() => window.searches.filter(s => s.channel === 'imweb-search-posts').length), 0,
    '브랜드를 안 고르면 엉뚱한 게시판을 뒤지지 않는다');
  await form.locator('#iwBoardEditBrand').selectOption('EVION');
  await form.evaluate(() => {
    iwBoardEditState = { code: '612', lang: 'ko', brand: 'EVION', postCode: 'p1', title: '옛 글', detailImages: [] };
    document.getElementById('iwBoardEditLoaded').style.display = '';
  });
  await form.locator('#iwBoardLoadBtn').click();
  await form.waitForFunction(() => window.searches.some(s => s.channel === 'imweb-search-posts') && !document.getElementById('iwBoardLoadBtn').disabled);
  assert.deepEqual(await form.evaluate(() => [iwBoardEditState, document.getElementById('iwBoardEditLoaded').style.display,
    document.getElementById('iwBoardSearchResult').style.display]), [null, 'none', 'none'], '게시판 검색 실패도 옛 게시글을 남기지 않는다');
  await formCtx.close();

  assert.deepEqual(errors, []);
  console.log('PASS: 네이버·쿠팡 찾기 칸에 좌측 브랜드·차종명, 자동 조회 없음, 내부 상품번호 안 넘김, 탭 수정 존중, 결과 1건 자동 채움, '
    + 'B2B 코드만 검색(-- 전체 --), idx 비움, 검색 전 옛 상태 지움(B2B·게시판), 죽은 버튼 없음');
} finally {
  await browser.close();
}
