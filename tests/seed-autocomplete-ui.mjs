// 베리씨드 AI 이미지 생성 — 차량 자동완성(상품정보 입력과 같은 목록 상자 vu-suggest.js). 가짜 IPC, 네트워크 없음.
// 실행: node tests/seed-autocomplete-ui.mjs   눈으로 볼 때: SHOT=파일.png
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--allow-file-access-from-files'] });
try {
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  await context.route(/^https?:/, r => r.abort());
  await context.addInitScript(() => {
    // No.101 은 BMW 두 차가 같이 쓴다. 벤츠는 괄호 안 영문 브랜드, 캐딜락은 괄호가 없다(미국 탭은 영문 표).
    // 실제 카탈로그처럼: 메모가 든 코드 · 연식, '기타' 브랜드, 영문 차종 자리 'X', 보이는 칸이 모두 같은 두 줄.
    const variants = [
      { brand: 'BMW', model: '1시리즈', modelEn: '1 Series', gen: '2세대', year: '12.03~19.05', code: 'F20/F21', no: '101' },
      { brand: 'BMW', model: '3시리즈', modelEn: '3 Series', gen: '6세대', year: '12.03~19.09', code: 'F30', no: '101' },
      { brand: 'BMW', model: '3시리즈', modelEn: '3 Series', gen: '2세대', year: '82~94', code: '거울분리형', no: '190' },
      { brand: 'BMW', model: 'iX3', modelEn: 'X', gen: '1세대', year: '2025년 예정', code: 'NA5', no: '118' },
      { brand: '벤츠 (BENZ)', model: 'B클래스', modelEn: 'B-Class', gen: '1세대전기형', year: '06.10~09.08', code: 'W245', no: '322', bsa: '' },
      { brand: '벤츠 (BENZ)', model: 'B클래스', modelEn: 'B-Class', gen: '1세대전기형', year: '06.10~09.08', code: 'W245', no: '322', bsa: '사각브라켓' },
      { brand: '캐딜락', model: 'STS', modelEn: 'STS', gen: '1세대', year: '04~11', code: '', no: '5001' },
      { brand: '기타', model: '피아트500', modelEn: 'Fiat 500', gen: '1세대', year: '07~', code: '312', no: '9001' },
    ];
    window.require = () => ({ ipcRenderer: { on() {}, send() {}, async invoke(channel) { return channel === 'vehicle-load-catalog' ? { success: true, catalog: { variants } } : {}; } } });
  });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(pathToFileURL(path.resolve('src/ui/index_seed.html')).href);
  const field = (country, name) => page.locator(`#aiForm_${country} [name="${name}"]`);
  await page.waitForFunction(() => document.querySelector('#aiForm_KOREA [name="brand"]').dataset.vuCombo === '1');
  // 칸을 눌러 목록을 열고 글을 읽는다(목록 상자는 칸 하나에 하나만 열린다)
  const listOf = async (country, name) => { await page.locator('body').click({ position: { x: 5, y: 5 } }); await field(country, name).click(); return page.locator('.vu-combo .vu-combo-item').allTextContents(); };
  const pick = async (country, name, text) => { await listOf(country, name); await page.locator('.vu-combo .vu-combo-item', { hasText: text }).first().click(); };
  const form = country => page.evaluate(c => Object.fromEntries(['brand', 'carClass', 'no', 'gen', 'year', 'code'].map(f => [f, document.getElementById('aiForm_' + c)[f].value])), country);

  // 제조사: 브랜드 이름(한국 탭은 괄호 영문을 뗀다, '기타' 묶음은 빼다). 목록 상자 높이는 240px 상한(네이티브 목록은 화면을 덮었다).
  assert.deepEqual(await listOf('KOREA', 'brand'), ['BMW', '벤츠', '캐딜락']);
  assert.equal(await page.locator('.vu-combo').evaluate(n => getComputedStyle(n).maxHeight), '240px');
  // 상품번호 목록은 차 한 대씩 — 같은 번호(No.101)도 어느 차인지 보이고, 고른 줄의 차로 여섯 칸을 채운다
  const nos = await listOf('KOREA', 'no');
  assert.ok(nos.includes('No.101 · BMW · 1시리즈 · 2세대 · 12.03~19.05 · F20/F21') && nos.includes('No.101 · BMW · 3시리즈 · 6세대 · 12.03~19.09 · F30'), nos.join('\n'));
  assert.equal(nos.filter(t => t.startsWith('No.322')).length, 1, '보이는 칸이 모두 같은 두 줄은 한 줄로');
  await pick('KOREA', 'no', 'No.101 · BMW · 3시리즈 · 6세대');
  assert.deepEqual(await form('KOREA'), { brand: 'BMW', carClass: '3시리즈', no: '101', gen: '6세대', year: '12.03~19.09', code: 'F30' });
  // 손으로 고친 값은 그대로 둔다(다른 칸을 지우거나 되채우지 않는다)
  await field('KOREA', 'gen').fill('6세대 전기형'); await field('KOREA', 'code').fill(''); await page.keyboard.press('Tab');
  assert.deepEqual(await form('KOREA'), { brand: 'BMW', carClass: '3시리즈', no: '101', gen: '6세대 전기형', year: '12.03~19.09', code: '' });
  // 제조사 · 차종을 적어 두면 다른 칸 목록이 그 차들로 좁혀진다
  assert.deepEqual(await listOf('KOREA', 'year'), ['12.03~19.09 · No.101 · BMW · 3시리즈 · 6세대 · F30', '82~94 · No.190 · BMW · 3시리즈 · 2세대']);
  // 메모는 값이 아니다: 코드 '거울분리형' · 연식 '2025년 예정' 은 빈칸으로(목록 글에도 없다)
  await pick('KOREA', 'no', 'No.190');
  assert.deepEqual(await form('KOREA'), { brand: 'BMW', carClass: '3시리즈', no: '190', gen: '2세대', year: '82~94', code: '' });
  await field('KOREA', 'carClass').fill(''); await field('KOREA', 'carClass').dispatchEvent('change');
  await pick('KOREA', 'code', 'NA5');
  assert.deepEqual(await form('KOREA'), { brand: 'BMW', carClass: 'iX3', no: '118', gen: '1세대', year: '', code: 'NA5' });
  // '기타' 브랜드 줄은 제조사를 비운다(브랜드를 지운 뒤라 전체 목록)
  await field('KOREA', 'brand').fill(''); await field('KOREA', 'brand').dispatchEvent('change');
  await pick('KOREA', 'carClass', '피아트500');
  assert.deepEqual(await form('KOREA'), { brand: '', carClass: '피아트500', no: '9001', gen: '1세대', year: '07~', code: '312' });
  // 연식 칸에 상품번호를 쳐서 한 줄로 좁힌 뒤 Tab 이면 그 줄을 고른다(상품정보 입력과 같은 규칙). 차종을 지워 전체 목록에서.
  await field('KOREA', 'carClass').fill(''); await field('KOREA', 'carClass').dispatchEvent('change');
  await field('KOREA', 'year').fill('5001'); await page.keyboard.press('Tab');
  assert.deepEqual(await form('KOREA'), { brand: '캐딜락', carClass: 'STS', no: '5001', gen: '1세대', year: '04~11', code: '' });

  // 미국 탭: 영문 브랜드(괄호 없는 한글 브랜드도 영문으로) · 영문 차종('X' 는 빈칸), 세대 칸은 건드리지 않는다
  await page.locator('.country-tab-btn', { hasText: 'USA' }).click();
  assert.deepEqual(await listOf('USA', 'brand'), ['BMW', 'BENZ', 'Cadillac']);
  await field('USA', 'gen').fill('2nd gen');
  await pick('USA', 'no', 'No.322');
  assert.deepEqual(await form('USA'), { brand: 'BENZ', carClass: 'B-Class', no: '322', gen: '2nd gen', year: '06.10~09.08', code: 'W245' });
  for (const f of ['brand', 'carClass']) { await field('USA', f).fill(''); await field('USA', f).dispatchEvent('change'); }   // 고른 차로 좁혀진 목록을 푼다
  await pick('USA', 'no', 'No.118');
  assert.equal((await form('USA')).carClass, '', "영문 차종 자리 'X' 는 값이 아니다");
  assert.ok((await listOf('USA', 'no')).some(t => t.startsWith('No.118 · BMW · iX3')), '영문 이름이 없으면 목록 글에 한글 차종을 참고로');
  assert.deepEqual(errors, []);
  if (process.env.SHOT) { await page.locator('.country-tab-btn', { hasText: 'KOREA' }).click(); await listOf('KOREA', 'no'); await page.screenshot({ path: process.env.SHOT }); }
  console.log('PASS: 베리씨드 차량 자동완성 — 목록 상자(240px) · 차 한 줄로 여섯 칸 · 같은 번호도 고른 차 · 손 값 유지 · 좁히기 · 메모·기타·X 빈칸 · 미국 탭 영문');
} finally { await browser.close(); }
