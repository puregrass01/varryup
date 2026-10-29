import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--allow-file-access-from-files'] });
try {
  const context = await browser.newContext({ viewport: { width: 1450, height: 1050 } });
  await context.route(/^https?:/, r => r.abort());
  await context.addInitScript(() => {
    window.calls = [];
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
    const profiles = ['domestic', 'amazon', 'ebay'].map(id => ({ id, label: id, folder: `${id}/기본 이미지`, seed: id !== 'domestic', errors: [], signature: id,
      items: ['대표.jpg', '1.jpg', '2.jpg'].map((name, i) => ({ name, role: i ? '상세' : '대표', path: `${id}/${name}`, selected: true, previewUrl: png })) }));
    window.require = () => ({ webUtils: { getPathForFile: f => 'C:/사진/' + f.name }, ipcRenderer: { on() {}, send() {}, async invoke(channel, data) {
      window.calls.push({ channel, data });
      if (channel === 'image-library-load') return { success: true, profiles };
      if (channel === 'image-library-host-files') return { success: true, urls: data.files.map(f => 'https://ai.esmplus.com/uploaded/vu_' + f.split('/').pop()) };
      if (channel === 'image-library-prepare') {
        const p = profiles.find(p => p.id === data.id); const urls = p.items.filter(i => i.selected).map((_, i) => `https://ai.esmplus.com/test/${data.id}-${i}.jpg`);
        return { success: true, profile: p, bundle: { signature: p.signature, mainImageUrl: urls[0], imageUrls: urls, subImages: urls.slice(1), detailHtml: '<p>detail</p>' } };
      }
      if (channel === 'image-library-pick') return { success: true, canceled: true };
      if (channel === 'image-library-configure') {
        const p = profiles.find(p => p.id === data.id); p.items.forEach(i => i.selected = !(data.changes.excluded || []).includes(i.path)); p.signature += '-changed';
        return { success: true, profile: p };
      }
      if (channel === 'veryup-load-photo') return { success: true, path: 'C:/ai_output/latest_korea.jpg', name: 'latest_korea.jpg', html: '', dataUrl: png };
      if (channel === 'veryup-get-mode') return 'new';
      if (channel === 'imweb-load-categories') return { success: true, categories: {} };
      return {};
    } } });
  });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message)); page.setDefaultTimeout(10000);
  await page.goto(pathToFileURL(path.resolve('src/ui/index_up.html')).href);
  await page.locator('.vu-image-row').first().waitFor().catch(async e => { console.log('PAGE ERRORS', errors, await page.evaluate(() => ({ state: document.getElementById('image-library')?.innerText, library: !!window.VUImages, calls: window.calls }))); throw e; });
  assert.equal(await page.locator('.vu-image-row').count(), 3);
  assert.equal(await page.locator('.vu-image-row input').first().isDisabled(), true);
  await page.locator('#vu-image-profile').selectOption('amazon');
  await page.locator('#cell-USA-open1').click();
  await page.locator('#vu-image-prepare').click();
  const frame = page.frameLocator('#form-frame');
  await frame.locator('#amzMainImageUrl').waitFor({ state: 'attached' });
  await page.waitForFunction(() => document.getElementById('form-frame').contentDocument.getElementById('amzMainImageUrl')?.value.includes('amazon-0'));
  assert.equal(await frame.locator('#amzSubImages').inputValue(), 'https://ai.esmplus.com/test/amazon-1.jpg\nhttps://ai.esmplus.com/test/amazon-2.jpg');
  // 신규 등록 폼에선 이미지 주소 칸이 숨는다 — 이미지 목록이 정한다(embedded-platform.css .shell-fed).
  assert.equal(await frame.locator('#amzMainImageUrl').isVisible(), false);
  // 손으로 고친 칸을 덮지 않는 규칙(vuManual)은 그대로라 표시만 달아 확인한다.
  await frame.locator('#amzMainImageUrl').evaluate(el => { el.value = 'https://manual.example/main.jpg'; el.dataset.vuManual = '1'; });
  await page.locator('#vu-image-refresh').click();
  assert.equal(await frame.locator('#amzMainImageUrl').inputValue(), 'https://manual.example/main.jpg');
  await page.locator('#vu-image-profile').selectOption('ebay');
  await page.locator('#cell-USA-open2').click();
  await page.locator('#vu-image-prepare').click();
  await page.waitForFunction(() => document.getElementById('form-frame').contentDocument.getElementById('ebImages')?.value.includes('ebay-0'));
  assert.equal((await frame.locator('#ebImages').inputValue()).split('\n').length, 3);
  await page.locator('.vu-image-row input').nth(2).uncheck();
  await page.locator('#vu-image-prepare').click();
  await page.waitForFunction(() => document.getElementById('form-frame').contentDocument.getElementById('ebImages')?.value.split('\n').length === 2);
  await page.locator('#vu-image-pick-main').click();
  assert.match(await page.locator('#vu-image-folder').textContent(), /ebay/);
  // 다른 앱(Edge 페이지)도 dragstart 에서 x-vu-photo 를 실을 수 있다 — 이 창에서 시작한 드래그가 아니면 대표로 받지 않는다(UNC 경로면 Windows 가 그 호스트에 접속).
  const spoof = await context.newCDPSession(page), list = await page.locator('#vu-image-list').boundingBox();
  const photo = { dragOperationsMask: 1 | 2 | 16, items: [{ mimeType: 'application/x-vu-photo', data: '\\\\evil.example@SSL\\share\\x.jpg' }] };
  for (const type of ['dragEnter', 'dragOver', 'drop']) await spoof.send('Input.dispatchDragEvent', { type, x: list.x + 20, y: list.y + 20, data: photo });
  await page.waitForFunction(() => /주소가 아닙니다/.test(document.getElementById('vu-image-status').textContent));
  assert.equal(await page.evaluate(() => calls.some(c => c.data?.changes?.thumbnail)), false);
  // 좌측 베리씨드 미리보기를 이미지 목록에 끌어다 놓으면 그 파일이 지금 목록(eBay)의 대표 이미지가 된다.
  await page.locator('#btn-load-korea').click();
  await page.locator('#photo-preview-img').waitFor();
  await page.evaluate(() => {
    const dt = new DataTransfer(), list = document.getElementById('vu-image-list');
    document.getElementById('photo-preview-img').dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    list.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    list.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  });
  await page.waitForFunction(() => calls.some(c => c.channel === 'image-library-configure' && c.data.changes.thumbnail));
  assert.deepEqual(await page.evaluate(() => calls.findLast(c => c.channel === 'image-library-configure').data),
    { id: 'ebay', changes: { thumbnail: 'C:/ai_output/latest_korea.jpg', seed: false } });
  // ESM 이미지호스팅(Edge)에서 끌어 온 썸네일: 브라우저 쪽 드롭(CDP)으로 넣는다 — 합성 DOM 이벤트가 아니라 Blink 드롭 경로.
  // 썸네일이 <a href="#"> 안이면 uri-list 는 페이지 주소다 → html 의 <img src> 를 쓴다. http 는 https 로 올린다.
  const cdp = await context.newCDPSession(page), box = await page.locator('#vu-image-list').boundingBox();
  const esm = 'https://ai.esmplus.com/yhshma/' + ['기본값', '스마트스토어 상세페이지', '7.jpg'].map(encodeURIComponent).join('/');
  const drag = { dragOperationsMask: 1 | 2 | 16, items: [{ mimeType: 'text/uri-list', data: 'https://im.esmplus.com/IHv2/ImgMain/ImgView#' },
    { mimeType: 'text/html', data: '<a href="#"><img onerror="window.pwned=1" src="' + esm.replace('https:', 'http:') + '"></a>' }, { mimeType: 'text/plain', data: 'https://im.esmplus.com/IHv2/ImgMain/ImgView#' }] };
  for (const type of ['dragEnter', 'dragOver', 'drop']) await cdp.send('Input.dispatchDragEvent', { type, x: box.x + 20, y: box.y + 20, data: drag });
  await page.waitForFunction(() => calls.some(c => c.data?.changes?.addDetails));
  assert.deepEqual(await page.evaluate(() => calls.findLast(c => c.channel === 'image-library-configure').data), { id: 'ebay', changes: { addDetails: [esm] } });
  assert.equal(await page.evaluate(() => window.pwned), undefined, '끌어 온 마크업의 속성은 실행하지 않는다');
  // 끌어 온 주소에는 '|' 가 그대로 남지 않는다(버리거나 %7C) — 일괄 수정 칸(bulk-edit.js)이 '|' 로 이어 나누면 뒤쪽이 남의 이미지가 된다.
  const pipe = { dragOperationsMask: 1 | 2 | 16, items: [{ mimeType: 'text/html', data: '<img src="https://ai.esmplus.com/a.jpg|https://evil.example/x.jpg">' }] };
  await page.waitForFunction(() => !document.getElementById('vu-image-prepare').disabled);   // 앞 드롭 작업 중에는 드롭을 받지 않는다
  const sent = await page.evaluate(() => calls.length);
  for (const type of ['dragEnter', 'dragOver', 'drop']) await cdp.send('Input.dispatchDragEvent', { type, x: box.x + 20, y: box.y + 20, data: pipe });
  await page.waitForFunction(n => calls.length > n || /주소가 아닙니다/.test(document.getElementById('vu-image-status').textContent), sent);
  assert.equal(await page.evaluate(() => calls.some(c => c.data?.changes?.addDetails?.some(u => u.includes('|')))), false);
  // ESM '태그복사' → 목록에서 Ctrl+V. HTML 편집 칸 안의 붙여넣기는 보통 붙여넣기 그대로.
  await page.locator('#vu-image-list').focus();
  await page.evaluate(() => { const dt = new DataTransfer(); dt.setData('text/plain', "<img src='https://ai.esmplus.com/yhshma/a.jpg' /><img src='https://ai.esmplus.com/yhshma/b.jpg' />");
    document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); });
  await page.waitForFunction(() => calls.findLast(c => c.channel === 'image-library-configure').data.changes.addDetails?.length === 2);
  // 탐색기 이미지 파일을 목록에 끌어 놓으면 ESM 에 올린 주소가 상세 끝에 붙는다.
  await page.evaluate(() => { const dt = new DataTransfer(); dt.items.add(new File(['x'], 'local3.jpg', { type: 'image/jpeg' }));
    const list = document.getElementById('vu-image-list');
    list.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    list.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt })); });
  await page.waitForFunction(() => calls.findLast(c => c.channel === 'image-library-configure').data.changes.addDetails?.[0] === 'https://ai.esmplus.com/uploaded/vu_local3.jpg');
  assert.deepEqual(await page.evaluate(() => calls.findLast(c => c.channel === 'image-library-host-files').data.files), ['C:/사진/local3.jpg']);
  await page.locator('#vu-image-html-open').click();
  const before = await page.evaluate(() => calls.length), html = await page.locator('#vu-image-html').inputValue();
  await page.locator('#vu-image-html').evaluate(el => { const dt = new DataTransfer(); dt.setData('text/plain', '<img src="https://ai.esmplus.com/yhshma/c.jpg">'); el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); });
  // 편집기가 열려 있을 때 끌어 놓으면 편집 중인 HTML 끝에 붙는다(목록은 'HTML 저장' 때) — 커서 자리에 끼어 들지 않는다.
  const area = await page.locator('#vu-image-html').boundingBox();
  for (const type of ['dragEnter', 'dragOver', 'drop']) await cdp.send('Input.dispatchDragEvent', { type, x: area.x + 10, y: area.y + 10, data: drag });
  await page.waitForFunction(text => document.getElementById('vu-image-html').value !== text, html);
  assert.equal(await page.locator('#vu-image-html').inputValue(), [html.trim(), '<p><img src="' + esm + '" /></p>'].filter(Boolean).join('\n'));
  assert.equal(await page.evaluate(() => calls.length), before);
  // 같은 이미지를 또 놓으면 건너뛴다. ESM 주소가 아닌 글자는 편집 칸이 그대로 받는다.
  const once = await page.locator('#vu-image-html').inputValue();
  for (const type of ['dragEnter', 'dragOver', 'drop']) await cdp.send('Input.dispatchDragEvent', { type, x: area.x + 10, y: area.y + 10, data: drag });
  await page.waitForFunction(() => /이미 HTML/.test(document.getElementById('vu-image-status').textContent));
  assert.equal(await page.locator('#vu-image-html').inputValue(), once);
  const word = { dragOperationsMask: 1 | 2 | 16, items: [{ mimeType: 'text/plain', data: 'memo' }] };
  for (const type of ['dragEnter', 'dragOver', 'drop']) await cdp.send('Input.dispatchDragEvent', { type, x: area.x + 10, y: area.y + 10, data: word });
  await page.waitForFunction(() => document.getElementById('vu-image-html').value.includes('memo'));
  // 편집 칸 안에서 줄을 끌어 옮기면(실제 마우스) 옮겨질 뿐 끝에 하나 더 붙지 않는다
  const ta = page.locator('#vu-image-html'), a = '<p><img src="https://ai.esmplus.com/yhshma/a.jpg" /></p>', moved = a + '\n' + a.replace('a.jpg', 'b.jpg');
  await ta.evaluate((el, v) => { el.style.cssText = 'width:700px;height:200px;font:14px/20px monospace;padding:0'; el.value = v; el.focus(); el.setSelectionRange(v.indexOf('\n') + 1, v.length); }, moved);
  const tb = await ta.boundingBox();
  await page.mouse.move(tb.x + 40, tb.y + 30); await page.mouse.down();
  await page.mouse.move(tb.x + 30, tb.y + 32, { steps: 6 }); await page.mouse.move(tb.x + 1, tb.y + 4, { steps: 6 }); await page.mouse.up();
  await page.waitForFunction(v => document.getElementById('vu-image-html').value !== v, moved);
  assert.deepEqual((await ta.inputValue()).match(/\w\.jpg/g), ['b.jpg', 'a.jpg']);
  await page.locator('#vu-image-html-cancel').click();
  assert.deepEqual(errors, []);
  assert.equal(await page.evaluate(() => calls.filter(c => /register|save-draft|publish/.test(c.channel)).length), 0);
  fs.mkdirSync('scratch', { recursive: true });
  await page.screenshot({ path: 'scratch/image-library-preview.png' });
  console.log('PASS: defaults, marketplace switch, image order, manual URL preservation, exclusion, canceled representative picker, no listing writes');
} finally { await browser.close(); }
