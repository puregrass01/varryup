import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const browser = await chromium.launch({
  headless: true,
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe'
});

try {
  const context = await browser.newContext();
  await context.route(/^https?:/, route => route.abort());
  await context.addInitScript(() => {
    const listeners = {};
    window.require = () => ({
      ipcRenderer: {
        on(channel, listener) { listeners[channel] = listener; },
        send() {},
        invoke() { return Promise.resolve({}); }
      }
    });
  });

  const page = await context.newPage();
  const fileUrl = pathToFileURL(path.resolve('src/ui/index_up.html')).href;
  await page.goto(fileUrl);
  await page.waitForSelector('#status-board');

  // 기본은 밝은 화면이다. 어두운 배경용 색이 남아 있으면 글자가 안 보인다.
  const theme = await page.evaluate(() => document.documentElement.dataset.theme);
  assert.equal(theme, 'light', '기본 테마가 밝은 화면이 아니다');
  const lum = await page.evaluate(() => {
    const m = getComputedStyle(document.body).backgroundColor.match(/\d+/g).map(Number);
    return 0.299 * m[0] + 0.587 * m[1] + 0.114 * m[2];
  });
  console.log('body 배경 밝기:', Math.round(lum));
  assert(lum > 180, `밝은 테마인데 배경이 어둡다 (밝기 ${Math.round(lum)})`);

  // 로그 글자가 배경과 충분히 갈리는지 — 파스텔이 그대로 남아 있으면 여기서 걸린다.
  const logContrast = await page.evaluate(() => {
    const out = {};
    for (const level of ['ok', 'warn', 'error']) {
      const el = document.createElement('div');
      el.className = 'log-entry ' + level;
      document.getElementById('log-window').appendChild(el);
      const m = getComputedStyle(el).color.match(/\d+/g).map(Number);
      out[level] = Math.round(0.299 * m[0] + 0.587 * m[1] + 0.114 * m[2]);
      el.remove();
    }
    return out;
  });
  console.log('로그 글자 밝기:', logContrast);
  for (const [level, l] of Object.entries(logContrast)) {
    assert(l < 140, `밝은 배경에 ${level} 로그 글자가 너무 밝다 (밝기 ${l})`);
  }

  const rows = await page.locator('#status-board tbody tr').all();
  console.log('Found rows:', rows.length);
  assert.equal(rows.length, 4);

  // 현황판에서 글자를 빼고 국기·로고만 남겼다. 나라 이름은 셀의 title 로만 남아 있으므로
  // '어느 줄이 어느 나라인지 알 수 있는가' 를 그 title 로 확인한다.
  for (const row of rows) {
    const cell = row.locator('.country-cell');
    const country = await cell.getAttribute('title');
    console.log('Country:', country);
    assert(country && country.length > 0, '나라 셀에 title 이 있어야 한다');
    assert.equal(await row.locator('.country-name').count(), 0, '나라 이름 글자는 없어야 한다');

    const flag = row.locator('.country-flag');
    assert.equal(await flag.count(), 1);
    const box = await flag.boundingBox();
    console.log(country, 'flag bounding box:', box);
    assert(box.height <= 18, '국기가 줄 높이를 밀어낼 만큼 커지면 안 된다 (<= 18px)');

    // 쇼핑몰도 이름 대신 로고다. 다만 로고 PNG 가 아직 없는 몰(B2B몰·라쿠텐·쇼피파이)은
    // 이름으로 되돌아온다. 지켜야 할 것은 '로고가 있다' 가 아니라
    // **빈 칸이 생기지 않는다** 는 쪽이다 — 로고를 넣다가 칸이 통째로 비면 못 알아본다.
    for (const cell of await row.locator('.platform-cell').all()) {
      const hasLogo = await cell.locator('.plat-logo').count();
      const hasName = await cell.locator('.plat-name').count();
      const title = await cell.getAttribute('title');
      assert(hasLogo || hasName, `${title}: 로고도 이름도 없는 빈 칸`);
      assert(title && title.trim().length > 0, `${country} 줄에 title 없는 셀이 있다`);
    }
  }

  // 체크박스는 없앴다. 이제 로고 타일 자체가 토글이고, 눌린 상태는 .checked 로 드러난다.
  assert.equal(await page.locator('#status-board input[type="checkbox"]').count(), 0,
               '현황판에 체크박스가 남아 있으면 안 된다');

  const firstCell = rows[0].locator('.platform-cell .cell-inner').first();
  assert.equal(await firstCell.getAttribute('role'), 'checkbox', '보조기술에는 체크박스로 남아야 한다');
  await firstCell.click();
  assert.equal(await firstCell.getAttribute('aria-checked'), 'true');
  assert.equal(await firstCell.evaluate(el => el.classList.contains('checked')), true,
               '누른 타일에 눌린 표시가 없다');

  const hasRowChecked = await rows[0].evaluate(el => el.classList.contains('row-checked'));
  console.log('Row highlight toggle:', hasRowChecked);
  assert.equal(hasRowChecked, true);

  // 키보드로도 꺼져야 한다 — 체크박스를 없앴으니 이건 우리 코드가 책임진다. Space 가 켜고 끈다
  // (Enter 는 마우스 클릭처럼 켜진 몰의 폼을 연다 — 가운데 쇼핑몰 탭을 현황판으로 합친 뒤, 2026-10-16).
  await firstCell.press('Space');
  assert.equal(await firstCell.getAttribute('aria-checked'), 'false', 'Space 로 해제되지 않는다');

  // ── 아임웹 카테고리 칸: 평소엔 숨기고, 좌측 브랜드로 못 정할 때만 드러낸다 ──
  // 숨겨만 두면 아임웹이 "제조사를 선택해주세요" 로 막는데 고를 칸이 없어 거기서 끝난다.
  // fillIframe 의 revealCategoryPicker 가 기대는 두 가지를 여기서 못박는다:
  //   (1) 그 select 가 .redundant-field 안에 있을 것  (2) needs-pick 을 붙이면 드러날 것
  const formPage = await context.newPage();
  await formPage.goto(pathToFileURL(path.resolve('src/ui/index.html')).href);
  await formPage.waitForSelector('#iwBrand', { state: 'attached' });   // 숨겨져 있는 게 정상이다
  await formPage.evaluate(() => {
    document.documentElement.classList.add('embedded-platform');
    document.querySelectorAll('.tab-pane').forEach(p => (p.style.display = 'block'));
  });

  for (const id of ['iwBrand']) {
    const r = await formPage.evaluate((elId) => {
      const el = document.getElementById(elId);
      const group = el && el.closest('.redundant-field');
      if (!group) return { 그룹없음: true };
      const shown = () => getComputedStyle(group).display !== 'none';
      const before = shown();
      group.classList.add('needs-pick');
      const after = shown();
      group.classList.remove('needs-pick');
      return { 그룹없음: false, 평소: before, 드러냄: after };
    }, id);
    console.log(id, r);
    assert.equal(r.그룹없음, false, `${id} 가 .redundant-field 안에 없다 — revealCategoryPicker 가 못 찾는다`);
    assert.equal(r.평소, false, `${id} 는 평소에 숨어 있어야 한다`);
    assert.equal(r.드러냄, true, `${id} 에 needs-pick 을 붙였는데 안 드러난다`);
  }
  await formPage.close();

  // Take screenshot of the board area
  const boardEl = page.locator('#section7');
  await boardEl.screenshot({ path: 'C:/Users/bssho/.gemini/antigravity/brain/1820f54d-848f-4c66-b683-75dba541f123/actual_status_board.png' });
  console.log('Actual status board screenshot saved!');
} finally {
  await browser.close();
}
