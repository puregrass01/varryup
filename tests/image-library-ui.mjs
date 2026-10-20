import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { uploadRepresentative } from '../src/platforms/naver_managed_images.js';

const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--allow-file-access-from-files'] });
try {
  const context = await browser.newContext({ viewport: { width: 1450, height: 1050 } });
  await context.route(/^https?:/, r => r.abort());
  await context.addInitScript(() => {
    window.calls = [];
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
    const profiles = ['domestic', 'amazon', 'ebay'].map(id => ({ id, label: id, folder: `${id}/기본 이미지`, seed: id !== 'domestic', errors: [], signature: id,
      items: ['대표.jpg', '1.jpg', '2.jpg'].map((name, i) => ({ name, role: i ? '상세' : '대표', path: `${id}/${name}`, selected: true, previewUrl: png })) }));
    window.require = () => ({ ipcRenderer: { on() {}, send() {}, async invoke(channel, data) {
      window.calls.push({ channel, data });
      if (channel === 'image-library-load') return { success: true, profiles };
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
  assert.deepEqual(errors, []);
  assert.equal(await page.evaluate(() => calls.filter(c => /register|save-draft|publish/.test(c.channel)).length), 0);
  fs.mkdirSync('scratch', { recursive: true });
  await page.screenshot({ path: 'scratch/image-library-preview.png' });

  // Native Naver uploads must stay within the representative-image control;
  // absent/changed controls must stop without saving the product.
  const naver = await context.newPage();
  await naver.setContent('<input type="file" id="unrelated"><div data-field="representativeImage"><input type="file" id="main"><img></div>');
  await naver.evaluate(() => document.getElementById('main').onchange = e => {
    const image = e.target.parentElement.querySelector('img'); image.src = URL.createObjectURL(e.target.files[0]);
  });
  await uploadRepresentative(naver, path.resolve('src/ui/logos/naver.png'));
  assert.equal(await naver.locator('#unrelated').evaluate(el => el.files.length), 0);
  await naver.setContent('<button id="save">저장</button>');
  await assert.rejects(uploadRepresentative(naver, path.resolve('src/ui/logos/naver.png')), /상품은 저장하지 않았습니다/);
  console.log('PASS: defaults, marketplace switch, image order, manual URL preservation, exclusion, canceled representative picker, no listing writes, scoped Naver upload');
} finally { await browser.close(); }
