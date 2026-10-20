// Offline regression check for runRegister() 주입 정합성 (Phase 0).
//
// 과거 결함:
//   - #inp-bsa 가 마크업에 없어 BSA 가 항상 false → 전 플랫폼 BSA X + B2B 가격 하락
//   - iwBrand/iwModel/iwBoardBrand 를 건드리지 않아 카테고리·게시판이 기본값으로 등록
//   - setVal 이 input/change 를 발사하지 않아 titlePreview 가 비어 네이버 차단 / 쿠팡 무제목
//   - 국내용·해외용 조견표에 같은 URL 을 복사
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const CATEGORIES = {
  국산차: { 현대: ['아반떼', '싼타페'], 기아: ['K5'] },
  수입차: { 벤츠: ['E클래스', 'C클래스'], BMW: ['3시리즈'] },
};

const browser = await chromium.launch({
  headless: true,
  args: ['--allow-file-access-from-files'],
  executablePath: process.env.EBAY_TEST_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
});
try {
  const context = await browser.newContext();
  await context.route(/^https?:/, route => route.abort());
  await context.addInitScript(cats => {
    const listeners = {};
    window.require = () => ({ ipcRenderer: {
      on(channel, listener) { listeners[channel] = listener; },
      send() {},
      invoke(channel) {
        if (channel === 'imweb-load-categories') return Promise.resolve({ success: true, categories: cats });
        if (channel === 'veryup-load-photo') {
          return Promise.resolve({ success: true, path: 'x', name: 'x.jpg', dataUrl: '',
            html: `<img src="https://cdn.example/${window.__region || 'korea'}.jpg">` });
        }
        return Promise.resolve({});
      },
    } });
  }, CATEGORIES);

  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(pathToFileURL(path.resolve('src/ui/index_up.html')).href);
  await page.waitForTimeout(400);

  // ── 1. 차량 종류 라디오가 추가되었는가 ──
  assert.equal(await page.locator('#inp-kind-car').count(), 1, '자동차 라디오 없음');
  assert.equal(await page.locator('#inp-kind-bike').count(), 1, '오토바이 라디오 없음');
  assert.ok(await page.locator('#inp-kind-car').isChecked(), '기본값이 자동차가 아님');

  // ── 2. BSA 라디오는 기본 O 유지 (사용자 결정) ──
  assert.ok(await page.locator('input[name="bsa"][value="o"]').isChecked(), 'BSA 기본 O가 아님');

  // ── 3. 브랜드 → 국적 역인덱스가 로드되었는가 ──
  const nat = await page.evaluate(() => ({
    벤츠: vuNationalityOf('벤츠'), 현대: vuNationalityOf('현대'), 없음: vuNationalityOf('토레스'),
  }));
  assert.equal(nat.벤츠, '수입차', '벤츠 국적 역추론 실패');
  assert.equal(nat.현대, '국산차', '현대 국적 역추론 실패');
  assert.equal(nat.없음, null, '없는 브랜드가 null이 아님');

  // ── 4. 이륜차 브랜드 판정 ──
  const bike = await page.evaluate(() => [isBikeBrand('야마하'), isBikeBrand('벤츠')]);
  assert.deepEqual(bike, [true, false], '이륜차 브랜드 판정 실패');

  // ── 5. 조견표가 지역별로 따로 보관되는가 ──
  await page.evaluate(() => { window.__region = 'korea'; });
  await page.click('#btn-load-korea');
  await page.waitForTimeout(250);
  await page.evaluate(() => { window.__region = 'global'; });
  await page.click('#btn-load-global');
  await page.waitForTimeout(250);
  const charts = await page.evaluate(() => ({ ...chartHtmlByRegion }));
  assert.ok(charts.korea.includes('korea.jpg'), '국내용 조견표 미보관: ' + charts.korea);
  assert.ok(charts.global.includes('global.jpg'), '해외용 조견표 미보관: ' + charts.global);
  assert.notEqual(charts.korea, charts.global, '국내용과 해외용이 같은 값');

  // ── 6. datalist 가 붙고 목록이 채워졌는가 ──
  const lists = await page.evaluate(() => {
    const get = id => {
      const el = document.getElementById(id);
      const lid = el && el.getAttribute('list');
      const dl = lid && document.getElementById(lid);
      return { list: lid, count: dl ? dl.options.length : -1 };
    };
    return { brand: get('inp-brand'), model: get('inp-carmodel'), gen: get('inp-gen') };
  });
  assert.equal(lists.brand.list, 'vu-brand', '브랜드 datalist 미부착');
  // 카탈로그 4브랜드 + 이륜차 17종
  assert.equal(lists.brand.count, 21, '브랜드 옵션 수 불일치: ' + lists.brand.count);
  assert.equal(lists.gen.list, 'vu-gen', '세대 datalist 미부착');
  assert.equal(lists.gen.count, 24, '세대 프리셋 수 불일치: ' + lists.gen.count);

  // ── 7. 브랜드 → 차종 캐스케이딩 ──
  await page.fill('#inp-brand', '벤츠');
  await page.waitForTimeout(120);
  let models = await page.evaluate(() =>
    [...document.getElementById('vu-carmodel').options].map(o => o.value));
  assert.deepEqual(models, ['E클래스', 'C클래스'], '벤츠 차종 목록 불일치: ' + models);

  await page.fill('#inp-brand', '현대');
  await page.waitForTimeout(120);
  models = await page.evaluate(() =>
    [...document.getElementById('vu-carmodel').options].map(o => o.value));
  assert.deepEqual(models, ['아반떼', '싼타페'], '현대 차종 목록 불일치: ' + models);

  // ── 8. 이륜차 브랜드를 고르면 차량 종류가 오토바이로 전환 ──
  await page.fill('#inp-brand', '야마하');
  await page.waitForTimeout(120);
  assert.ok(await page.locator('#inp-kind-bike').isChecked(), '이륜차 브랜드인데 오토바이로 전환 안 됨');
  await page.fill('#inp-brand', '기아');
  await page.waitForTimeout(120);
  assert.ok(await page.locator('#inp-kind-car').isChecked(), '자동차 브랜드인데 자동차로 복귀 안 됨');

  // ── 9. 바인딩은 멱등이어야 한다(플랫폼 클릭마다 재실행됨) ──
  const dup = await page.evaluate(() => {
    window.VUSuggest.bindShell(document);
    window.VUSuggest.bindShell(document);
    return document.querySelectorAll('#vu-brand').length;
  });
  assert.equal(dup, 1, 'datalist 가 중복 생성됨: ' + dup);

  assert.deepEqual(errors, [], 'pageerror 발생: ' + errors.join(' | '));
  console.log('PASS: 차량 종류 라디오, BSA 기본값, 국적 역인덱스, 이륜차 판정, 조견표 2벌 분리,');
  console.log('      datalist 부착, 브랜드→차종 캐스케이딩, 오토바이 자동 전환, 멱등 바인딩');
} finally {
  await browser.close();
}
