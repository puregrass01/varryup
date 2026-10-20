import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', args: ['--allow-file-access-from-files'] });
try {
  const context = await browser.newContext();
  await context.route(/^https?:/, route => route.abort());
  await context.addInitScript(() => {
    window.calls = []; window.urls = ['https://images.example/a.jpg', 'https://images.example/b.jpg', 'https://images.example/c.jpg'];
    window.require = () => ({ ipcRenderer: {
      on() {}, send() {},
      async invoke(channel, data) {
        calls.push({ channel, data });
        if (channel === 'bulk-images-import') return { success: true, data: { images: data.input.split('|'), verified: 0 } };
        if (channel === 'image-library-load') return { success: true, profiles: [{ id: 'amazon', items: [
          { role: '대표', selected: true, url: '' },
          { role: '상세', source: 'esm', selected: true, url: 'https://ai.esmplus.com/yhshma/new.jpg' },
          { role: '상세', source: 'esm', selected: true, url: urls[1] },
          { role: '상세', source: 'esm', selected: false, url: 'https://ai.esmplus.com/yhshma/off.jpg' }] }] };
        if (channel === 'smartstore-update-product') return { success: true, product: { ...data, groups: [], options: [] } };
        if (channel === 'coupang-update') return { success: true, product: { ...data, options: [] } };
        if (channel === 'amazon-load-product') return { success: true, product: { title: 'Mirror', stock: 3, price: 30, mainImageUrl: urls[0],
          raw: { attributes: { other_product_image_locator_1: [{ marketplace_id: data.marketplaceId, media_location: urls[1] }],
            other_product_image_locator_2: [{ marketplace_id: data.marketplaceId, media_location: urls[2] }] } } } };
        if (channel === 'amazon-update' || channel === 'imweb-update-group' || channel === 'imweb-update-post') return { success: true };
        if (channel === 'ebay-load-config') return { success: true, data: { environment: 'sandbox' } };
        if (channel === 'ebay-load-product') return { success: true, data: {
          sku: data, offer: { status: 'PUBLISHED', pricingSummary: { price: { value: '30' } }, availableQuantity: 3 },
          inventory: { product: { title: 'Mirror', imageUrls: [...urls] } },
        } };
        if (channel === 'ebay-update') return { success: true, data: {} };
        if (channel === 'ebay-update-images') {
          if (window.failImages) return { success: false, error: 'test timeout' };
          window.urls = [...data.images]; return { success: true, data: { status: 'UPDATED' } };
        }
        return {};
      },
    } });
  });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(pathToFileURL(path.resolve('src/ui/index.html')).href);
  await page.waitForFunction(() => !!window.ebayUpdate && !!window.VUImageGallery);
  // Existing native state objects remain the source of truth for their save buttons.
  await page.evaluate(() => {
    ssEditState = { originNo: '1', revision: 'rev', groups: [], options: [], detailImages: urls.map(url => ({ url })) };
    cpEditState = { productId: '2', options: [], detailImages: urls.map(url => ({ url, raw: url, blockType: 'HTML' })) };
    iwB2bEditState = { products: [{ prodNo: '3' }], sharedGroups: [], combos: [], detailImages: [...urls] };
    iwBoardEditState = { postCode: '4', lang: 'en', detailImages: [...urls] };
    document.getElementById('cpProductIdInput').value = '2';
    document.getElementById('ssEditTitle').value = 'Naver';
    document.getElementById('cpEditTitle').value = 'Coupang';
    document.getElementById('iwB2bEditTitle').value = 'B2B';
    document.getElementById('iwBoardEditTitle').value = 'Board';
    renderSmartstoreImages(); renderCoupangImages(); renderImwebB2bImages(); renderImwebBoardImages();
  });
  const remove = async id => page.evaluate(id => document.querySelector('#' + id + ' .vu-image-remove').click(), id);
  for (const id of ['ssImageList', 'cpImageList', 'iwB2bImageList', 'iwBoardImageList']) {
    await remove(id);
    assert.equal(await page.locator('#' + id + ' .vu-image-tile').count(), 2);
  }
  assert.equal(await page.evaluate(() => calls.filter(c => /update/.test(c.channel)).length), 0);
  await page.evaluate(async () => { await saveSmartstoreEdit(); await saveCoupangEdit(); await updateImwebB2bProduct(); await updateImwebBoardPost(); });
  const payloads = await page.evaluate(() => calls);
  for (const channel of ['smartstore-update-product', 'coupang-update', 'imweb-update-group', 'imweb-update-post']) {
    const data = payloads.find(c => c.channel === channel)?.data;
    assert.ok(data, channel + ' submitted');
    assert.deepEqual((data.detailImages || data.images).map(x => x.url || x), ['https://images.example/b.jpg', 'https://images.example/c.jpg']);
  }
  // Array replacement uses the selected form's marketplace and does not change the other forms.
  await page.evaluate(() => {
    const box = document.querySelector('#iwBoardImageList textarea'); box.value = 'https://images.example/new.jpg|https://images.example/next.jpg';
    document.querySelector('#iwBoardImageList .vu-image-import button').click();
  });
  await page.waitForFunction(() => iwBoardEditState.detailImages[0] === 'https://images.example/new.jpg');
  assert.equal(await page.evaluate(() => calls.filter(c => c.channel === 'bulk-images-import').at(-1).data.scope), 'imweb-en');
  assert.equal(await page.evaluate(() => ssEditState.detailImages[0].url), 'https://images.example/b.jpg');

  for (const marketplaceId of ['ATVPDKIKX0DER', 'A1VC38T7YXB528']) {
    await page.evaluate(async marketplaceId => {
      document.querySelector('input[name="amzWorkMode"]').value = 'edit';
      document.getElementById('amzMarketplaceId').value = marketplaceId;
      document.getElementById('amzSku').value = 'SKU-' + marketplaceId;
      await loadAmazonProduct();
    }, marketplaceId);
    await remove('amzEditImageList');
    await page.evaluate(() => registerAmazon());
    const data = await page.evaluate(() => calls.filter(c => c.channel === 'amazon-update').at(-1).data);
    assert.equal(data.marketplaceId, marketplaceId);
    assert.deepEqual(data.replaceImageUrls, ['https://images.example/b.jpg', 'https://images.example/c.jpg']);
    assert.deepEqual(data.expectedImageUrls, ['https://images.example/a.jpg', 'https://images.example/b.jpg', 'https://images.example/c.jpg']);
    const writes = await page.evaluate(() => calls.filter(c => c.channel === 'amazon-update').length);
    assert.equal((await page.evaluate(() => registerAmazon())).ok, false, 'accepted image change requires reload');
    assert.equal(await page.evaluate(() => calls.filter(c => c.channel === 'amazon-update').length), writes);
  }
  // Product image APIs require a remaining image: an empty draft must never silently restore old URLs.
  await page.evaluate(() => loadAmazonProduct());
  await remove('amzEditImageList'); await remove('amzEditImageList'); await remove('amzEditImageList');
  const beforeEmpty = await page.evaluate(() => calls.filter(c => c.channel === 'amazon-update').length);
  const empty = await page.evaluate(() => registerAmazon());
  assert.equal(empty.ok, false);
  assert.equal(await page.evaluate(() => calls.filter(c => c.channel === 'amazon-update').length), beforeEmpty);

  // ESM 상세 이미지 추가: 로컬 파일 없이 이미지 설정의 선택된 ESM 상세만 끝에 붙고(중복·미선택 제외),
  // 순서 이동으로 대표 자리에 놓은 뒤 기존 저장으로 나간다.
  await page.evaluate(() => loadAmazonProduct());
  await page.evaluate(() => document.querySelector('#amzEditImageList .vu-image-add').click());
  await page.waitForFunction(() => document.querySelectorAll('#amzEditImageList .vu-image-tile').length === 4);
  assert.equal(await page.evaluate(() => calls.filter(c => c.channel === 'bulk-images-import').at(-1).data.scope), 'amazon-jp');
  for (const index of [3, 2, 1]) await page.evaluate(i => document.querySelectorAll('#amzEditImageList .vu-image-tile')[i].querySelector('.vu-image-moves button').click(), index);
  await page.evaluate(() => registerAmazon());
  assert.deepEqual((await page.evaluate(() => calls.filter(c => c.channel === 'amazon-update').at(-1).data)).replaceImageUrls,
    ['https://ai.esmplus.com/yhshma/new.jpg', 'https://images.example/a.jpg', 'https://images.example/b.jpg', 'https://images.example/c.jpg']);

  await page.evaluate(() => {
    switchTab('ebayTab');
    document.getElementById('ebMode').value = 'edit'; document.getElementById('ebMode').dispatchEvent(new Event('change'));
    document.getElementById('ebEditSku').value = 'EBAY-SKU';
    document.querySelector('[data-eb="load"]').click();
  });
  await page.waitForFunction(() => !document.getElementById('ebUpdate').disabled);
  await remove('ebEditImageList');
  assert.equal(await page.locator('#ebEditImageList .vu-image-tile').count(), 2);
  const saved = await page.evaluate(() => ebayUpdate()); assert.equal(saved.ok, true);
  const ebay = await page.evaluate(() => calls.find(c => c.channel === 'ebay-update-images').data);
  assert.deepEqual(ebay.images, ['https://images.example/b.jpg', 'https://images.example/c.jpg']);
  assert.deepEqual(ebay.expectedImages, ['https://images.example/a.jpg', 'https://images.example/b.jpg', 'https://images.example/c.jpg']);
  assert.equal(await page.evaluate(() => calls.filter(c => c.channel === 'ebay-update').length), 0,
    'image-only edit does not resend price/quantity (would restore units sold since loading)');
  await remove('ebEditImageList');
  await page.evaluate(() => { window.failImages = true; document.getElementById('ebEditPrice').value = '31'; });
  const failed = await page.evaluate(() => ebayUpdate());
  assert.equal(failed.ok, false); assert.match(failed.error, /가격은 저장됐지만/);
  assert.equal(await page.evaluate(() => calls.filter(c => c.channel === 'ebay-update').length), 1, 'a changed price is still sent with the images');
  assert.deepEqual(await page.evaluate(() => calls.find(c => c.channel === 'ebay-update').data),
    { sku: 'EBAY-SKU', price: '31', priceOnly: true, expectedPrice: '30' }, 'quantity untouched → price only (units sold since loading stay sold)');
  const count = await page.evaluate(() => calls.length);
  const retry = await page.evaluate(() => ebayUpdate()); assert.equal(retry.ok, false);
  assert.equal(await page.evaluate(() => calls.length), count, 'uncertain image result requires reload before another write');

  const parent = await context.newPage();
  await parent.goto(pathToFileURL(path.resolve('src/ui/index_up.html')).href + '?mode=edit');
  assert.equal(await parent.locator('#image-library').isVisible(), false, 'no new-listing dropdown in single-edit mode');
  await parent.evaluate(() => setSection8Mode('new'));
  assert.equal(await parent.locator('#image-library').isVisible(), true, 'new registration retains its defaults');
  assert.deepEqual(errors, []);
  console.log('PASS: per-mall single-item arrays, native saves, array import isolation, Amazon US/JP replacement, empty draft, ESM detail add + move to main, eBay image save/partial failure/retry block, edit-mode dropdown removed.');
} finally { await browser.close(); }
