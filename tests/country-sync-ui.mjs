// 나라별 가격 통일 [한국] 버튼 + 판매 페이지 링크 화면 확인(모의 IPC). 실행: node tests/country-sync-ui.mjs
// 본사몰(imweb-ko) 상품 하나를 골라 [한국] → 네이버 · 쿠팡 표의 판매가 칸만 채워지고(저장 요청 없음), 짝이 아닌 쿠팡 옵션은 그대로인지 본다.
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
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => {
    window.calls = [];
    const img = n => ['https://ai.esmplus.com/x/' + n + '.jpg'];
    const id = (no, bsa) => ({ nos: [no], bsa, skus: [], options: [{ no, bsa }] });
    const rowsOf = (scope, pid) => {
      if (scope === 'imweb-ko') return [
        { optionId: '', variant: '기본 판매가 (조합 가격은 아래 줄)', price: 150000 },
        { optionId: 'a', variant: '조합 · BSA 여부=BSA 없음 / 구성 선택=1set', price: 110000 },
        { optionId: 'b', variant: '조합 · BSA 여부=BSA 없음 / 구성 선택=운전석', price: 60000 },
        { optionId: 'c', variant: '조합 · BSA 여부=BSA 있음 / 구성 선택=1set', price: 160000 },
      ].map(r => ({ ...r, id: pid, scope, name: '옵틱글래스 BMW X5 광각미러 [No.101]', identity: { nos: ['101'], bsa: false, skus: [], options: [{ no: '101', bsa: false }] }, images: img('ko'), imagesReady: true }));
      if (scope === 'naver') return [{ id: pid, scope, optionId: undefined, name: 'BMW X5', variant: '기본 판매가 · 옵션 추가금 유지', price: 99000, identity: id('101', false), images: img('nv'), imagesReady: true }];
      if (scope === 'coupang') return [
        { optionId: '41', variant: '1개 No.101 BSA', price: 150000, identity: id('101', true) },
        { optionId: '40', variant: '1개 No.101', price: 110000, identity: id('101', false) },
        { optionId: '99', variant: '1개 No.105 (다른 차)', price: 90000, identity: id('105', false) },
      ].map(r => ({ ...r, id: pid, scope, name: '옵틱글래스 BMW X5', displayProductId: '9768389140', images: img('cp'), imagesReady: true }));
    };
    window.require = () => ({ ipcRenderer: { on() {}, async invoke(channel, data) {
      calls.push({ channel, data });
      if (channel === 'bulk-price-list') return { success: true, data: { items: [{ id: '2097', scope: data.scope, name: '옵틱글래스 BMW X5 광각미러 [No.101]', price: '150000', ready: false }], note: '' } };
      if (channel === 'bulk-price-load-many') return { success: true, data: { blocked: '', items: data.ids.map(pid => ({ id: pid, rows: rowsOf(data.scope, pid).map(r => ({ ...r, price: String(r.price), currency: 'KRW', ready: true })) })) } };
      if (channel === 'country-sync-targets') return { success: true, data: { 2097: { via: 'index', no: '101', naver: [['13733473928', '13794583522']], coupang: [['16406378846', '40', false], ['16406378846', '41', true]], skus: [] } } };
      if (channel === 'open-product-page') return { ok: true };
      return { success: true, data: {} };
    } } });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.click('[data-scope="imweb-ko"]');
  await page.click('#be-list');
  await page.waitForFunction(() => document.getElementById('be-body').textContent.includes('1set') && !document.getElementById('be-stop').checkVisibility());
  // 기준 상품(상품의 줄 하나)을 고르고 [한국]
  await page.locator('#be-body input[type=checkbox]').first().check();
  await page.click('[data-country="kr"]');
  await page.waitForFunction(() => /한국 통일 · 기준/.test(document.getElementById('be-status').textContent), null, { timeout: 8000 });
  const status = await page.textContent('#be-status');
  assert.match(status, /네이버 넣음 1 · 이미지 1개 상품/);
  assert.match(status, /쿠팡 넣음 1 · 이미지 1개 상품 · 이미 같음 1/);
  assert.equal(await page.getAttribute('[data-scope="imweb-ko"]', 'aria-selected'), 'true', '끝나면 기준 탭으로 돌아온다');
  assert.ok(!(await calls()).some(c => c.channel === 'bulk-save-batch'), '저장 요청은 보내지 않는다');

  await page.click('[data-scope="naver"]');
  assert.equal(await page.inputValue('#be-body input[type=number]'), '60000', '네이버 기본 판매가는 운전석 한쪽 가격이다');
  const link = page.locator('#be-body a.be-page-link');
  assert.equal(await link.getAttribute('href'), 'https://smartstore.naver.com/b-store/products/13794583522', '목록에만 있던 채널상품번호를 링크에 쓴다');
  await link.click();
  const opened = (await page.evaluate(() => window.calls)).find(c => c.channel === 'open-product-page');
  assert.equal(opened.data.channelProductNo, '13794583522');
  assert.ok(!('url' in opened.data), '렌더러는 URL 을 넘기지 않는다');

  await page.click('[data-scope="coupang"]');
  const coupang = await page.$$eval('#be-body tr', trs => trs.map(tr => [tr.querySelector('.be-title small')?.textContent, tr.querySelector('input[type=number]')?.value, tr.querySelector('.be-result')?.textContent]));
  assert.deepEqual(coupang.map(r => r[1]), ['160000', '110000', '90000'], 'BSA 옵션은 160000, 일반은 그대로 110000, 다른 차 옵션은 손대지 않는다');
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });   // 눈으로 볼 때: SHOT=파일.png
  assert.deepEqual(await page.$$eval('#be-platforms [aria-selected="true"]', bs => bs.map(b => b.dataset.scope)), ['coupang']);
  assert.match(coupang[0][2], /한국 통일: .*1set 160,000/);
  assert.match(coupang[1][2], /이미 같음/);
  assert.doesNotMatch(coupang[2][2], /한국 통일:/, '다른 차 옵션의 판매가는 건드리지 않는다(이미지는 쿠팡 상품 공통이라 대기로 보인다)');
  assert.match(await page.locator('#be-body a.be-page-link').first().getAttribute('href'), /^https:\/\/www\.coupang\.com\/vp\/products\/9768389140\?vendorItemId=41&q=.+&sourceType=search/);
  assert.deepEqual(errors, []);
  console.log('country-sync-ui: OK');
  async function calls() { return page.evaluate(() => window.calls); }
} finally {
  await browser?.close(); server.close();
}
