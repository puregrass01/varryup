import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ImageLibrary } from '../src/utils/image_library.js';
import { DEFAULT_IMAGE_HTML, esmImagesFromHtml } from '../src/utils/image_defaults.js';
import { Amazon } from '../src/platforms/amazon.js';
import { AmazonAPI } from '../src/platforms/amazon_api.js';

function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'esm-defaults-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const output = path.join(dir, 'output'); fs.mkdirSync(output);
  fs.writeFileSync(path.join(output, 'latest_global.jpg'), 'representative');
  const uploads = [], inspections = [];
  const args = { userData: dir, output, downloads: path.join(dir, 'missing-downloads'),
    upload: async file => { uploads.push(file); return 'https://ai.esmplus.com/test/representative.jpg'; },
    inspect: async url => { inspections.push(url); return true; }, ...options };
  return { dir, output, uploads, inspections, args, lib: new ImageLibrary(args) };
}

test('all default details appear without folders, network or an ESM login', t => {
  const { lib, output, uploads, inspections } = fixture(t);
  fs.unlinkSync(path.join(output, 'latest_global.jpg'));
  for (const [id, count] of [['domestic', 6], ['amazon', 6], ['ebay', 7]]) {
    const profile = lib.scan(id);
    assert.equal(profile.items.length, count + 1);
    assert.deepEqual(profile.errors, []);
    assert.ok(profile.items.slice(1).every(i => i.source === 'esm' && i.selected && i.previewUrl === i.url));
  }
  assert.deepEqual(uploads, []); assert.deepEqual(inspections, []);
});

test('legacy saved local folders cannot hide the bundled default details', t => {
  const { lib, args } = fixture(t);
  lib.state.profiles.amazon = { folder: 'Z:/old-machine/images', order: ['old.jpg'], excluded: ['old.jpg'], seed: true };
  lib.persist();
  const profile = new ImageLibrary(args).scan('amazon');
  assert.equal(profile.detailSource, 'esm');
  assert.deepEqual(profile.items.slice(1).map(i => i.url), esmImagesFromHtml(DEFAULT_IMAGE_HTML.amazon));
  assert.deepEqual(profile.errors, []);
});

test('ESM HTML is parsed as data, preserves order, decodes entities and deduplicates', () => {
  const a = 'https://ai.esmplus.com/test/a.jpg?x=1&y=2', b = 'https://ai.esmplus.com/test/b.jpg';
  assert.deepEqual(esmImagesFromHtml(`<script>bad()</script><IMG SRC='${b}' onerror='bad()'><img src="${a.replace('&', '&amp;')}"><img src=${b}>`), [b, a]);
  for (const src of ['file:///C:/a.jpg', 'javascript:bad()', 'https://example.com/a.jpg', 'https://ai.esmplus.com.evil/a.jpg']) {
    assert.throws(() => esmImagesFromHtml(`<img src="${src}">`));
  }
  // 일괄 수정은 주소를 '|' 로 이었다 다시 나눈다 — URL 이 남긴 '|' 뒤쪽은 ESM 확인 없이 저장되는 남의 이미지가 된다
  for (const src of ['https://ai.esmplus.com/a.jpg|https://evil.example/x.jpg', 'https://ai.esmplus.com/a.jpg?x=|https://evil.example/x.jpg']) {
    assert.throws(() => esmImagesFromHtml(`<img src="${src}">`), /\|/);
  }
  assert.throws(() => esmImagesFromHtml('<p>No images</p>'));
});

test('HTML choices, exclusion and order persist; defaults restore the full list', t => {
  const { lib, args } = fixture(t);
  const urls = esmImagesFromHtml(DEFAULT_IMAGE_HTML.amazon);
  lib.configure('amazon', { detailHtml: `<img src="${urls[1]}"><img src="${urls[0]}"><img src="${urls[2]}">` });
  lib.configure('amazon', { excluded: [urls[0]], order: [urls[2], urls[1], urls[0]] });
  const restored = new ImageLibrary(args);
  assert.deepEqual(restored.scan('amazon').items.slice(1).filter(i => i.selected).map(i => i.url), [urls[2], urls[1]]);
  assert.throws(() => restored.configure('amazon', { detailHtml: '<p>bad</p>' }));
  const p = restored.configure('amazon', { resetDetails: true });
  assert.deepEqual(p.items.slice(1).map(i => i.url), urls);
  assert.ok(p.items.every(i => i.selected));
});

test('preparing defaults uploads only the representative and sends all six ESM URLs to Amazon direct/proxy requests', async t => {
  const { lib, uploads } = fixture(t);
  const urls = esmImagesFromHtml(DEFAULT_IMAGE_HTML.amazon);
  const { bundle } = await lib.prepare('amazon');
  assert.equal(uploads.length, 1);
  assert.deepEqual(bundle.subImages, urls);
  const amazon = Object.create(Amazon.prototype); amazon.config = {};
  const payload = amazon._buildProductPayload({ titleEn: 'Test', price: '10', ...bundle });
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options }); return new Response(JSON.stringify({ status: 'ACCEPTED' }));
  });
  for (const proxyUrl of ['', 'https://proxy.example.test']) {
    const api = new AmazonAPI({ sellerId: 'A1B2C3D4E5F6G', proxy: { proxyUrl, proxyToken: 'test' } });
    api.getAccessToken = async () => 'test';
    await api.putListingItem('TEST', payload);
    const sent = JSON.parse(calls.at(-1).options.body);
    const attrs = (proxyUrl ? JSON.parse(sent.body) : sent).attributes;
    assert.equal(attrs.main_product_image_locator[0].media_location, bundle.mainImageUrl);
    assert.deepEqual(urls.map((_, i) => attrs[`other_product_image_locator_${i + 1}`][0].media_location), urls);
  }
  await lib.prepare('amazon'); assert.equal(uploads.length, 1);
});

test('unavailable ESM detail keeps the default list visible and never uploads a replacement', async t => {
  const { lib, uploads } = fixture(t, { inspect: async url => url.includes('/test/') });
  await assert.rejects(lib.prepare('amazon'), /ESM 이미지에 연결하지 못했습니다/);
  assert.equal(uploads.length, 1); // Only the newly generated representative.
  assert.equal(lib.scan('amazon').items.length, 7);
  assert.equal(lib.busy, false);
});
