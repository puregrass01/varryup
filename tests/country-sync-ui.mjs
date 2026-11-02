// 나라 화면 [한국] 확인(모의 IPC). 실행: node tests/country-sync-ui.mjs   눈으로 볼 때: SHOT=파일.png
// [한국] 하나로 본사 · 네이버 · 쿠팡 · B2B 줄이 본사몰 상품 묶음으로 한 표에 나오고(몰 로고 · 이름), 처음엔 차이만 알리며,
// [본사 값으로 맞추기] 뒤 [선택 변경 저장] 한 번이 네이버 · 쿠팡에 차례로 보내는지(B2B 는 보기만, 다른 차 쿠팡 옵션은 그대로) 본다.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/src/ui/theme.css"><link rel="stylesheet" href="/src/ui/bulk-edit.css">
<style>body{margin:0;height:100vh;display:flex;flex-direction:column;font-family:Arial,sans-serif}#mode-bar{padding:8px}iframe{display:none}</style>
<div id="mode-bar"></div><div id="section8-body"><div id="section8-main"></div></div><iframe id="form-frame"></iframe><section id="bulk-edit-workspace"></section>
<script>var isBulkRunning=false,currentMode='edit';window.VUProductTable={normalize:r=>({brand:'옵틱글래스',vehicle:'BMW',model:'X5',kind:'광각미러'})};</script>
<script src="/src/ui/bulk-edit.js"></script>`;
const server = http.createServer((req, res) => {
  if (req.url === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(html); }
  const file = path.resolve(root, '.' + decodeURI(req.url.split('?')[0]));
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.statusCode = 404; return res.end(); }
  res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'image/png');
  fs.createReadStream(file).pipe(res);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
  const errors = [], dialogs = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => { dialogs.push(d.message()); d.accept(); });
  const mockIpc = () => {
    window.calls = [];
    const id = (no, bsa) => ({ nos: [no], bsa, skus: [], options: [{ no, bsa }] });
    const rowsOf = (scope, pid) => {
      if (scope === 'imweb-ko') return [
        { optionId: '', variant: '기본 판매가 (조합 가격은 아래 줄)', price: 150000 },
        { optionId: 'a', variant: '조합 · BSA 없음 / 1set', price: 110000 },
        { optionId: 'b', variant: '조합 · BSA 없음 / 운전석', price: pid === '2098' ? 70000 : 60000 },
        { optionId: 'd', variant: '조합 · BSA 없음 / 조수석', price: 50000 },
        { optionId: 'c', variant: '조합 · BSA 있음 / 1set', price: 160000 },
      ].map(r => ({ ...r, id: pid, scope, name: '옵틱글래스 BMW X5 광각미러 [No.101]', identity: { nos: ['101'], bsa: false, skus: [], options: [{ no: '101', bsa: false }] } }));
      if (scope === 'naver') return [{ id: pid, scope, name: 'BMW X5', variant: '기본 판매가 · 옵션 추가금 유지', price: 99000, identity: id('101', false) }];
      if (scope === 'imweb-b2b') return [{ id: pid, scope, optionId: '', name: '옵틱글래스 광각미러 1세트 [No.101]', variant: '기본 판매가', price: 120000, identity: id('101', false) },
        { id: pid, scope, optionId: 'x', name: '옵틱글래스 광각미러 1세트 [No.101]', variant: '조합 · BSA X', price: 120000, identity: id('101', false) }];
      if (scope === 'coupang') return [
        { optionId: '41', variant: '1개 No.101 BSA', price: 150000, identity: id('101', true) },
        { optionId: '40', variant: '1개 No.101', price: 110000, identity: id('101', false) },
        { optionId: '99', variant: '1개 No.105 (다른 차)', price: 90000, identity: id('105', false) },
      ].map(r => ({ ...r, id: pid, scope, name: '옵틱글래스 BMW X5', displayProductId: '9768389140' }));
    };
    window.require = () => ({ ipcRenderer: { on(channel, fn) { if (channel === 'bulk-save-progress') window.progress = fn; }, async invoke(channel, data) {
      calls.push({ channel, data });
      if (channel === 'bulk-price-list') return { success: true, data: { items: (window.shared ? ['2097', '2098'] : ['2097']).map(id => ({ id, scope: data.scope, name: '옵틱글래스 BMW X5 광각미러 [No.101]', price: '150000', ready: false })), note: '' } };
      if (channel === 'bulk-price-load-many') return { success: true, data: { blocked: '', items: data.ids.map(pid => ({ id: pid, rows: rowsOf(data.scope, pid).map(r => ({ ...r, price: String(r.price), currency: 'KRW', ready: true, images: ['https://ai.esmplus.com/x/' + data.scope + '.jpg'], imagesReady: true })) })) } };
      if (channel === 'country-sync-targets') return { success: true, data: { 2097: { via: 'index', no: '101', naver: [['13733473928', '13794583522']],
        coupang: [['16406378846', '40', false], ['16406378846', '41', true]], skus: [], b2b: [['3155']], shared: { naver: [], coupang: [] } },
        // shared: 2098(같은 차의 다른 본사 상품)이 네이버 원상품과 쿠팡 BSA 옵션을 함께 가리킨다. 운전석가만 다르다(70000).
        ...(window.shared && { 2098: { via: 'index', no: '101', naver: [['13733473928', '13794583522']], coupang: [['16406378846', '41', true]], skus: [], b2b: [], shared: { naver: ['13733473928'], coupang: ['16406378846'] } } }) } };
      if (channel === 'bulk-save-batch') return { success: true, data: { stopped: '', cancelled: false, results: data.jobs.map((job, index) => ({ index, success: true, data: { status: 'VERIFIED', price: job.newPrice } })) } };
      if (channel === 'open-product-page') return { ok: true };
      return { success: true, data: {} };
    } } });
  };
  await page.addInitScript(mockIpc);
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForSelector('[data-country="kr"]');
  // 나라 탭이 몰 탭보다 앞이다.
  assert.deepEqual(await page.$$eval('.be-platform-row [role=tablist]', ls => ls.map(l => l.id)), ['be-countries', 'be-platforms']);
  await page.click('[data-country="kr"]');
  await page.waitForFunction(() => /본사와 다름/.test(document.getElementById('be-body').textContent) && !document.getElementById('be-stop').checkVisibility(), null, { timeout: 8000 });
  assert.equal(await page.getAttribute('[data-country="kr"]', 'aria-selected'), 'true');
  assert.equal(await page.locator('#be-platforms [aria-selected="true"]').count(), 0);
  const table = () => page.$$eval('#be-body tr', trs => trs.map(tr => tr.classList.contains('be-country-head') ? ['묶음', tr.textContent]
    : [tr.querySelector('.be-mall')?.textContent, tr.querySelector('.be-mall img')?.getAttribute('src'), tr.querySelector('.be-title small')?.textContent,
      tr.querySelector('input[type=number]')?.value, tr.querySelector('input[type=number]')?.disabled, tr.querySelector('.be-result')?.textContent]));
  let t = await table();
  assert.match(t[0][1], /옵틱글래스 BMW X5 광각미러 \[No\.101\].*상품 2097/);
  // 본사 줄은 1set · 운전석만(조수석 · 기본가 없음). 몰마다 로고 + 이름. B2B 는 기본가 줄 하나, 보기만.
  assert.deepEqual(t.slice(1).map(r => [r[0], r[1]]), [
    ['아임웹 본사', 'logos/imweb.png'], ['아임웹 본사', 'logos/imweb.png'], ['아임웹 본사', 'logos/imweb.png'],
    ['네이버', 'logos/naver.png'], ['쿠팡', 'logos/coupang.png'], ['쿠팡', 'logos/coupang.png'], ['아임웹 B2B (보기만)', 'logos/b2b.png']]);
  const pick = (rs, re) => rs.find(r => re.test((r[0] || '') + ' ' + (r[2] || '')));
  const naver = pick(t, /네이버/), bsaCp = pick(t, /쿠팡 .*BSA/), plainCp = pick(t, /쿠팡 1개 No.101$/), b2b = pick(t, /B2B/);
  assert.match(naver[5], /본사와 다름 → 60,000 KRW \(운전석\)/, '처음엔 값을 넣지 않고 차이만 알린다');
  assert.equal(naver[3], '99000');
  assert.match(bsaCp[5], /본사와 다름 → 160,000 KRW \(1set\)/);
  assert.match(plainCp[5], /본사와 같음/);
  assert.equal(b2b[4], true, 'B2B 는 판매가 칸을 고칠 수 없다');
  assert.ok(!t.some(r => /No\.105/.test(r[2] || '')), '다른 차의 쿠팡 옵션은 이 묶음에 없다');

  // 본사 줄 하나를 골라 [본사 값으로 맞추기] → 짝이 본사 값을 따라간다(저장 요청은 아직 없음).
  await page.locator('#be-body input[type=checkbox]').first().check();
  await page.click('#be-country-apply');
  await page.waitForFunction(() => /본사 값으로 맞추기 ·/.test(document.getElementById('be-status').textContent));
  assert.match(await page.textContent('#be-status'), /넣음 2행 · 이미 같음 1행/);
  t = await table();
  assert.equal(pick(t, /네이버/)[3], '60000'); assert.equal(pick(t, /쿠팡 .*BSA/)[3], '160000'); assert.equal(pick(t, /쿠팡 1개 No.101$/)[3], '110000');
  assert.ok(!(await page.evaluate(() => calls)).some(c => c.channel === 'bulk-save-batch'));
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });

  // [선택 변경 저장] 한 번 → 확인창 하나(몰별 행 수) → 네이버 · 쿠팡에 차례로. B2B · 본사는 바뀐 값이 없어 보내지 않는다.
  await page.click('#be-save');
  await page.waitForFunction(() => /^완료 ·/.test(document.getElementById('be-status').textContent));
  assert.equal(dialogs.length, 1);
  assert.match(dialogs[0], /네이버 판매가 1행 · 쿠팡 판매가 1행/);
  const saves = (await page.evaluate(() => calls)).filter(c => c.channel === 'bulk-save-batch').map(c => [c.data.scope, c.data.jobs.map(j => j.id + ':' + (j.optionId || '') + '=' + j.newPrice)]);
  assert.deepEqual(saves, [['naver', ['13733473928:=60000']], ['coupang', ['16406378846:41=160000']]]);
  assert.match(await page.textContent('#be-status'), /저장 확인 2/);

  // 링크: 네이버는 인덱스의 채널상품번호, 렌더러는 URL 을 넘기지 않는다.
  const link = page.locator('#be-body tr', { hasText: '네이버' }).locator('a.be-page-link');
  assert.equal(await link.getAttribute('href'), 'https://smartstore.naver.com/b-store/products/13794583522');
  await link.click();
  const opened = (await page.evaluate(() => calls)).find(c => c.channel === 'open-product-page');
  assert.ok(opened && !('url' in opened.data));

  // 몰 탭으로 돌아가면 나라 표시가 꺼지고, 그 몰 표에 같은 행(저장된 값)이 있다.
  await page.click('[data-scope="coupang"]');
  assert.equal(await page.locator('#be-countries [aria-selected="true"]').count(), 0);
  assert.match(await page.textContent('#be-body'), /저장·재조회 완료/);
  assert.deepEqual(errors, []);

  // 두 본사 상품이 같은 짝을 가리킬 때: 값이 다르면(네이버 운전석 60000 · 70000) 넣지 않고, 같은 짝(쿠팡 BSA 옵션)은 한 번만 저장한다.
  const page2 = await browser.newPage({ viewport: { width: 1600, height: 1400 } });
  page2.on('pageerror', e => errors.push(e.message));
  const dialogs2 = []; page2.on('dialog', d => { dialogs2.push(d.message()); d.accept(); });
  await page2.addInitScript(() => { window.shared = true; });
  await page2.addInitScript(mockIpc);
  await page2.goto(`http://127.0.0.1:${server.address().port}/`);
  await page2.waitForSelector('[data-country="kr"]');
  await page2.click('[data-country="kr"]');
  await page2.waitForFunction(() => document.querySelectorAll('#be-body tr.be-country-head').length === 2 && /본사와 다름/.test(document.getElementById('be-body').textContent) && !document.getElementById('be-stop').checkVisibility(), null, { timeout: 8000 });
  await page2.locator('#be-body input[type=checkbox]').first().check();
  await page2.click('#be-country-apply');
  await page2.waitForFunction(() => /본사 값으로 맞추기 ·/.test(document.getElementById('be-status').textContent));
  assert.match(await page2.textContent('#be-status'), /넣음 1행 · 이미 같음 1행 · 맞출 수 없음 1행/);
  assert.match(await page2.textContent('#be-body'), /본사와 맞출 수 없음: 짝인 본사 상품 여럿의 값이 다름/);
  await page2.click('#be-save');
  await page2.waitForFunction(() => /^완료 ·/.test(document.getElementById('be-status').textContent));
  assert.match(dialogs2[0], /쿠팡 판매가 1행/);
  const saves2 = (await page2.evaluate(() => calls)).filter(c => c.channel === 'bulk-save-batch').map(c => [c.data.scope, c.data.jobs.map(j => j.id + ':' + (j.optionId || '') + '=' + j.newPrice)]);
  assert.deepEqual(saves2, [['coupang', ['16406378846:41=160000']]], '두 묶음에 보이는 같은 줄은 한 번만 보낸다');
  assert.deepEqual(errors, []);
  console.log('country-sync-ui: OK');
} finally {
  await browser?.close(); server.close();
}
