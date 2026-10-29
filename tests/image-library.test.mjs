import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { ImageLibrary, imageDefaults, inspectHostedImage, imageHtml } from '../src/utils/image_library.js';
import { DEFAULT_IMAGE_HTML, esmImagesFromHtml } from '../src/utils/image_defaults.js';
import { Amazon } from '../src/platforms/amazon.js';
import { Coupang } from '../src/platforms/coupang.js';
import { buildContentFromTemplate } from '../src/platforms/openapi/build_payload.js';

function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vu-images-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const output = path.join(dir, 'output'), folder = path.join(dir, 'photos');
  fs.mkdirSync(output); fs.mkdirSync(folder);
  fs.writeFileSync(path.join(output, 'latest_global.jpg'), 'main');
  for (const name of ['10.jpg', '2.jpg', '1.jpg']) fs.writeFileSync(path.join(folder, name), name);
  fs.writeFileSync(path.join(folder, 'ignore.txt'), 'text');
  const uploads = [];
  const lib = new ImageLibrary({ userData: dir, downloads: dir, output,
    inspect: async (url, expected) => !expected && url.includes('/uploaded/'),
    upload: async file => { uploads.push(file); return `https://ai.esmplus.com/uploaded/${path.basename(file)}`; }, ...options });
  lib.configure('amazon', { folder });
  return { dir, folder, output, lib, uploads };
}

test('default details use bundled ESM HTML and preserve representative choices', () => {
  const d = imageDefaults('downloads', 'output');
  assert.equal(d.amazon.folder, undefined); assert.equal(d.ebay.detailSource, 'esm');
  assert.equal(esmImagesFromHtml(d.amazon.detailHtml).length, 6); assert.equal(esmImagesFromHtml(d.ebay.detailHtml).length, 7);
  assert.equal(d.domestic.detailHtml, DEFAULT_IMAGE_HTML.domestic);
  assert.ok(d.domestic.thumbnail.endsWith('썸네일.jpg')); assert.equal(d.ebay.seed, true);
});
test('scan uses natural order, representative first, no non-images or subfolders', t => {
  const { lib, folder } = fixture(t); fs.mkdirSync(path.join(folder, 'sub')); fs.writeFileSync(path.join(folder, 'sub', 'nested.jpg'), 'nested');
  assert.deepEqual(lib.scan('amazon').items.map(i => i.name), ['latest_global.jpg', '1.jpg', '2.jpg', '10.jpg']);
});
test('selected folder, excluded items and ordering survive restart', t => {
  const { lib, folder, dir, output } = fixture(t);
  lib.configure('amazon', { excluded: [path.join(folder, '2.jpg')], order: [path.join(folder, '10.jpg')] });
  const loaded = new ImageLibrary({ userData: dir, downloads: dir, output });
  assert.equal(loaded.scan('amazon').items[1].name, '10.jpg');
  assert.equal(loaded.scan('amazon').items.find(i => i.name === '2.jpg').selected, false);
});
test('dropped ESM URLs append to the detail list; HTML saves keep order and exclusions of images that remain', t => {
  const { lib } = fixture(t);
  const url = name => `https://ai.esmplus.com/yhshma/${['기본값', '스마트스토어 상세페이지', name].map(encodeURIComponent).join('/')}`;
  const details = () => lib.scan('domestic').items.slice(1).map(i => i.name + (i.selected ? '' : '(x)'));
  lib.configure('domestic', { excluded: [url('1.jpg'), url('2.jpg')], order: [url('3.jpg'), url('0.jpg')] });
  // 새 이미지는 끝에, 한글·공백 그대로인 0.jpg 는 이미 있는 것, 제외해 둔 2.jpg 는 다시 고른다
  lib.configure('domestic', { addDetails: [url('new.jpg'), 'https://ai.esmplus.com/yhshma/기본값/스마트스토어 상세페이지/0.jpg', url('2.jpg')] });
  assert.deepEqual(details(), ['3.jpg', '0.jpg', '1.jpg(x)', '2.jpg', '4.jpg', '5.jpg', 'new.jpg']);
  assert.throws(() => lib.configure('domestic', { addDetails: ['https://im.esmplus.com/a.jpg'] }), /ai\.esmplus\.com/);
  // HTML 편집기는 목록 순서(↑ 반영, 체크 끈 것 포함)로 열린다. 저장하면 그 줄 순서가 목록 순서, 제외는 남은 이미지 것만 남는다.
  const editor = () => imageHtml(lib.scan('domestic').items.slice(1).map(i => i.path)).split('\n');
  lib.configure('domestic', { detailHtml: editor().filter(line => !line.includes('3.jpg')).join('\n') });
  assert.deepEqual(details(), ['0.jpg', '1.jpg(x)', '2.jpg', '4.jpg', '5.jpg', 'new.jpg']);
  assert.deepEqual(lib.profile('domestic').order, []);
  lib.configure('domestic', { order: [url('2.jpg'), url('0.jpg')] });   // ↑ 뒤 편집기에서 줄을 뒤집어 저장하면 뒤집힌 순서
  lib.configure('domestic', { detailHtml: editor().reverse().join('\n') });
  assert.deepEqual(details(), ['new.jpg', '5.jpg', '4.jpg', '1.jpg(x)', '0.jpg', '2.jpg']);
  lib.configure('domestic', { resetDetails: true });
  assert.deepEqual(details(), ['0.jpg', '1.jpg', '2.jpg', '3.jpg', '4.jpg', '5.jpg']);
});
test('prepare uploads once, assigns main and extras separately, reuses verified hashes', async t => {
  const { lib, uploads } = fixture(t);
  const { bundle } = await lib.prepare('amazon');
  assert.equal(uploads.length, 4); assert.equal(bundle.imageUrls[0], bundle.mainImageUrl);
  assert.equal(bundle.subImages.length, 3); assert.ok(!bundle.detailHtml.includes(bundle.mainImageUrl));
  await lib.prepare('amazon'); assert.equal(uploads.length, 4);
});
test('hostFiles: 끌어 놓은 로컬 파일을 ESM 에 올리고 같은 내용은 다시 올리지 않으며, 이미지가 아닌 파일이 섞이면 하나도 올리지 않는다', async t => {
  const { dir, folder, lib, uploads } = fixture(t);
  const one = path.join(folder, '1.jpg'), copy = path.join(dir, '복사본 1.jpg');
  fs.copyFileSync(one, copy);
  const { urls } = await lib.hostFiles([one, copy, path.join(folder, '2.jpg')]);
  assert.equal(uploads.length, 2, '같은 내용 두 장은 한 번만 올린다');
  assert.equal(urls.length, 2);
  assert.ok(urls.every(u => /^https:\/\/ai\.esmplus\.com\/uploaded\/vu_[0-9a-f]{64}\.jpg$/.test(u)), '이름이 겹치지 않게 내용 해시 이름으로 올린다');
  assert.deepEqual((await lib.hostFiles([copy])).urls, [urls[0]]);
  assert.equal(uploads.length, 2, '올린 적 있는 내용은 저장된 주소를 쓴다');
  await assert.rejects(lib.hostFiles([path.join(folder, '10.jpg'), path.join(folder, 'ignore.txt')]), /ignore\.txt: 지원 형식/);
  await assert.rejects(lib.hostFiles([path.join(dir, 'missing.png')]), /missing\.png: 파일을 찾을 수 없습니다/);
  await assert.rejects(lib.hostFiles([]), /올릴 이미지 파일이 없습니다/);
  assert.equal(uploads.length, 2);
  assert.equal(lib.busy, false);
});
test('same filename with new VerySeed content gets a new URL without overwriting old uploads', async t => {
  const { lib, uploads, output } = fixture(t);
  const first = await lib.prepare('amazon');
  fs.writeFileSync(path.join(output, 'latest_global.jpg'), 'new-main');
  const second = await lib.prepare('amazon');
  assert.notEqual(first.bundle.mainImageUrl, second.bundle.mainImageUrl); assert.equal(uploads.length, 5);
  assert.equal(fs.readFileSync(uploads[0], 'utf8'), 'main');
});
test('existing matching hosted file is reused without upload', async t => {
  const { lib, uploads } = fixture(t, { inspect: async () => true });
  await lib.prepare('amazon'); assert.equal(uploads.length, 0);
});
test('a hosted URL over 200 chars (Korean folder path) is not reused — a short vu_ copy is uploaded for Coupang', async t => {
  const { lib, uploads, folder } = fixture(t, { inspect: async () => true });
  const thumb = path.join(folder, '썸네일.jpg'); fs.writeFileSync(thumb, 'thumb');
  lib.configure('domestic', { thumbnail: thumb, seed: false });
  const sha = lib.scan('domestic').items[0].hash;
  lib.state.hosted[sha] = { url: 'https://ai.esmplus.com/yhshma/' + encodeURIComponent('옵틱글래스 상세페이지/썸네일/이베이 썸네일/썸네일.jpg') };
  const { bundle } = await lib.prepare('domestic');
  assert.equal(uploads.length, 1);
  assert.match(bundle.mainImageUrl, /\/uploaded\/vu_[0-9a-f]{64}\.jpg$/);
  assert.ok(bundle.mainImageUrl.length <= 200);
});
test('404/non-image upload does not produce a ready bundle or success cache', async t => {
  const { lib } = fixture(t, { inspect: async () => false });
  await assert.rejects(lib.prepare('amazon'), /호스팅 이미지 응답/);
  assert.equal(Object.keys(lib.state.hosted).length, 0); assert.equal(lib.busy, false);
});
test('missing thumbnail and too many Amazon images fail before any upload', async t => {
  const { lib, output, folder, uploads } = fixture(t);
  fs.unlinkSync(path.join(output, 'latest_global.jpg')); await assert.rejects(lib.prepare('amazon'), /대표 이미지가 없습니다/);
  fs.writeFileSync(path.join(output, 'latest_global.jpg'), 'main');
  for (let i = 20; i < 27; i++) fs.writeFileSync(path.join(folder, `${i}.jpg`), 'extra');
  await assert.rejects(lib.prepare('amazon'), /최대 8장/); assert.equal(uploads.length, 0);
});
test('changing a folder resets selection but keeps explicit thumbnail', t => {
  const { lib, folder } = fixture(t); const chosen = path.join(folder, '2.jpg');
  lib.configure('amazon', { thumbnail: chosen, seed: false, excluded: [path.join(folder, '1.jpg')] });
  const p = lib.configure('amazon', { folder });
  assert.equal(p.items[0].path, chosen); assert.equal(p.items.filter(i => i.path === chosen).length, 1); assert.deepEqual(p.excluded, []);
});
test('host verifier checks HTTPS origin, response type, and matching bytes', async () => {
  let calls = 0;
  const fetcher = async () => { calls++; return new Response('picture', { headers: { 'content-type': 'image/jpeg' } }); };
  assert.equal(await inspectHostedImage('https://localhost/a.jpg', null, fetcher), false); assert.equal(calls, 0);
  const sha = createHash('sha256').update('picture').digest('hex');
  assert.equal(await inspectHostedImage('https://ai.esmplus.com/a.jpg', sha, fetcher), true);
  assert.equal(await inspectHostedImage('https://ai.esmplus.com/a.jpg', 'wrong', fetcher), false);
  assert.equal(await inspectHostedImage('https://ai.esmplus.com/a.jpg', null, async () => new Response('not image')), false);
});
test('Amazon payload has main locator and each additional image, with no HTML as an image URL', () => {
  const amazon = Object.create(Amazon.prototype); amazon.config = {};
  const p = amazon._buildProductPayload({ titleEn: 'Mirror', price: '10', mainImageUrl: 'https://img.example/main.jpg', subImages: ['https://img.example/1.jpg', 'https://img.example/2.jpg'] });
  assert.equal(p.attributes.main_product_image_locator[0].media_location, 'https://img.example/main.jpg');
  assert.equal(p.attributes.other_product_image_locator_2[0].media_location, 'https://img.example/2.jpg');
});
test('Coupang and Imweb full image list replaces template detail images', () => {
  const html = imageHtml(['https://img.example/1.jpg', 'https://img.example/2.jpg']);
  const cp = Object.create(Coupang.prototype);
  const item = cp._cloneTemplateItem({ attributes: [], contents: [{ contentsType: 'HTML', contentDetails: [{ content: '<img src="old.jpg">' }] }] }, { itemName: 'Mirror', carModel: 'Car', price: 100, stock: 1, detailHtml: html, mainImageUrl: 'https://img.example/main.jpg' });
  assert.equal(item.contents[0].contentDetails[0].content, html); assert.equal(item.images[0].vendorPath, 'https://img.example/main.jpg');
  const iw = buildContentFromTemplate('<img src="old.jpg">', { detailHtml: html, specImageUrl: 'https://img.example/chart.jpg' });
  assert.ok(iw.includes('chart.jpg')); assert.ok(iw.includes('2.jpg')); assert.ok(!iw.includes('old.jpg'));
});
test('image IPC integration enriches new registrations and leaves edit payloads untouched', async () => {
  const calls = [], input = { title: 'Mirror' }; let ensures = 0;
  const bundle = { mainImageUrl: 'https://img.example/main.jpg', subImages: ['https://img.example/1.jpg'], imageUrls: ['https://img.example/main.jpg','https://img.example/1.jpg'], detailHtml: '<img src="detail">' };
  const mode = { checked: true };
  const win = { parent: { document: { getElementById: () => mode }, VUImages: { ensure: async () => { ensures++; return bundle; } } } };
  const context = vm.createContext({ window: win, document: { getElementById: () => null } });
  vm.runInContext(fs.readFileSync(new URL('../src/ui/image-payload.js', import.meta.url), 'utf8'), context);
  const ipc = { invoke: async (channel, data) => { calls.push({ channel, data }); return { success: true }; } };
  await win.invokeWithImages(ipc, 'amazon-register', input); assert.equal(calls[0].data.subImages.length, 1);
  await win.invokeWithImages(ipc, 'amazon-update', input); assert.equal(calls[1].data, input);
  mode.checked = false; await win.invokeWithImages(ipc, 'ebay-save-draft', input); assert.equal(calls[2].data, input); assert.equal(ensures, 1);
});
