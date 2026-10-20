import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ImageLibrary } from '../src/utils/image_library.js';
import { DEFAULT_IMAGE_HTML, esmImagesFromHtml } from '../src/utils/image_defaults.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'esm-defaults-ui-'));
const output = path.join(dir, 'output'); fs.mkdirSync(output);
fs.copyFileSync('src/ui/logos/amazon.png', path.join(output, 'latest_global.jpg'));
const calls = [], uploads = [];
let offline = false;
const lib = new ImageLibrary({ userData: dir, downloads: path.join(dir, 'missing-downloads'), output,
  inspect: async url => !offline || url.includes('/test/'),
  upload: async file => { uploads.push(file); return 'https://ai.esmplus.com/test/main.jpg'; },
});
const urls = esmImagesFromHtml(DEFAULT_IMAGE_HTML.amazon);
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--allow-file-access-from-files'] });
try {
  const context = await browser.newContext({ viewport: { width: 1450, height: 1050 } });
  // All remote traffic is intercepted: rendering tests never touch production.
  await context.route(/^https?:/, route => route.abort());
  await context.exposeFunction('imageTestIPC', async (channel, data) => {
    calls.push({ channel, data });
    try {
      if (channel === 'image-library-load') return { success: true, profiles: ['domestic', 'amazon', 'ebay'].map(id => lib.scan(id)) };
      if (channel === 'image-library-configure') return { success: true, profile: lib.configure(data.id, data.changes) };
      if (channel === 'image-library-prepare') return { success: true, ...await lib.prepare(data.id) };
      if (channel === 'image-library-pick') return { success: true, canceled: true };
      if (channel === 'veryup-get-mode') return 'new';
      if (channel === 'imweb-load-categories') return { success: true, categories: {} };
      if (channel === 'amazon-register') return { success: true };
      return {};
    } catch (e) { return { success: false, error: e.message }; }
  });
  await context.addInitScript(() => {
    window.require = () => ({ ipcRenderer: { on() {}, send() {}, invoke: (channel, data) => window.imageTestIPC(channel, data) } });
  });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message)); page.setDefaultTimeout(10000);
  await page.goto(pathToFileURL(path.resolve('src/ui/index_up.html')).href);
  await page.locator('.vu-image-row').first().waitFor();
  await page.locator('#vu-image-profile').selectOption('amazon');
  await page.locator('#cell-USA-open1').click();
  const frame = page.frameLocator('#form-frame');
  await frame.locator('#amzSubImages').waitFor({ state: 'attached' });   // 신규 폼에선 숨은 칸(이미지 목록이 채운다)
  await page.waitForFunction(() => document.getElementById('form-frame').contentDocument.getElementById('amzSubImages')?.value.split('\n').length === 6);
  assert.equal(await page.locator('.vu-image-row').count(), 7);
  assert.equal(await frame.locator('#amzSubImages').inputValue(), urls.join('\n'));
  assert.equal(calls.filter(c => c.channel === 'image-library-prepare').length, 0);
  assert.equal(uploads.length, 0);
  assert.match(await page.locator('#vu-image-folder').textContent(), /ESM/);
  assert.equal(await page.locator('#vu-image-pick-folder').count(), 0);

  await page.locator('#vu-image-html-open').click();
  await page.locator('#vu-image-html').fill('<p>no image</p>');
  await page.locator('#vu-image-html-save').click();
  await page.waitForFunction(() => document.getElementById('vu-image-status').textContent.includes('<img'));
  assert.equal(await page.locator('#vu-image-html-editor').isVisible(), true);
  assert.equal(await page.locator('.vu-image-row').count(), 7);
  await page.locator('#vu-image-html').fill(`<img src="${urls[1]}"><img src="${urls[0]}" onerror="window.injected=true">`);
  await page.locator('#vu-image-html-save').click();
  await page.locator('#vu-image-html-editor').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.vu-image-row').count(), 3);
  assert.equal(await page.evaluate(() => window.injected), undefined);
  await page.locator('#vu-image-defaults').click();
  await page.waitForFunction(() => document.querySelectorAll('.vu-image-row').length === 7);

  offline = true;
  await page.locator('#vu-image-prepare').click();
  await page.waitForFunction(() => document.getElementById('vu-image-status').textContent.includes('기본 목록은 유지'));
  assert.equal(await page.locator('.vu-image-row').count(), 7);
  offline = false;
  await page.locator('#vu-image-prepare').click();
  await page.waitForFunction(() => document.getElementById('vu-image-status').textContent.includes('적용 완료'));
  assert.equal(uploads.length, 1);
  await page.waitForFunction(() => document.getElementById('form-frame').contentDocument.getElementById('amzMainImageUrl')?.value === 'https://ai.esmplus.com/test/main.jpg');
  assert.equal(await frame.locator('#amzMainImageUrl').inputValue(), 'https://ai.esmplus.com/test/main.jpg');
  assert.equal(await frame.locator('#amzSubImages').inputValue(), urls.join('\n'));
  const result = await frame.locator('body').evaluate(async () => window.invokeWithImages(window.require().ipcRenderer, 'amazon-register', { titleEn: 'Test' }));
  assert.equal(result.success, true);
  assert.deepEqual(calls.find(c => c.channel === 'amazon-register').data.subImages, urls);
  assert.deepEqual(errors, []);
  console.log('PASS: defaults before ESM calls, missing local directory, HTML validation/edit/reset, offline list retention, API image URL handoff.');
} finally {
  await browser.close(); fs.rmSync(dir, { recursive: true, force: true });
}
