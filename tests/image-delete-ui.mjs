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
    // 탐색기 파일은 경로가 있고, 페이지에서 끌어 온 그림(가상 파일)은 경로가 없다.
    window.require = () => ({ webUtils: { getPathForFile: f => f.name.startsWith('virtual') ? '' : 'C:/사진/' + f.name }, ipcRenderer: {
      on() {}, send() {},
      async invoke(channel, data) {
        calls.push({ channel, data });
        if (channel === 'bulk-images-import') return { success: true, data: { images: data.input.split('|'), verified: 0 } };
        if (channel === 'image-library-host-files') return { success: true, urls: data.files.map(f => 'https://ai.esmplus.com/uploaded/vu_' + f.split('/').pop()) };
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
        if (channel === 'amazon-update' || channel === 'imweb-update-group') return { success: true };
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
  // 국내몰 갤러리는 불러온 영역 맨 위에 있고, 한 장씩 추가하던 URL 줄은 없다(갤러리의 배열 적용·ESM 상세가 대신한다).
  assert.deepEqual(await page.evaluate(() => ['ssEditLoaded', 'cpEditLoaded', 'iwB2bEditLoaded'].map(id => {
    const top = document.getElementById(id).firstElementChild;
    return [top.textContent, top.nextElementSibling.id];
  })), [['사진 · 상품 이미지', 'ssImageList'], ['사진 · 상품 이미지', 'cpImageList'], ['사진 · 상품 이미지', 'iwB2bImageList']]);
  assert.equal(await page.locator('#ssNewImageUrl, #cpNewImageUrl, #iwB2bNewImageUrl').count(), 0);
  // Existing native state objects remain the source of truth for their save buttons.
  await page.evaluate(() => {
    ssEditState = { originNo: '1', revision: 'rev', groups: [], options: [], detailImages: urls.map(url => ({ url })) };
    cpEditState = { productId: '2', options: [], detailImages: urls.map(url => ({ url, raw: url, blockType: 'HTML' })) };
    iwB2bEditState = { products: [{ prodNo: '3' }], sharedGroups: [], combos: [], detailImages: [...urls] };
    document.getElementById('cpProductIdInput').value = '2';
    document.getElementById('ssEditTitle').value = 'Naver';
    document.getElementById('cpEditTitle').value = 'Coupang';
    document.getElementById('iwB2bEditTitle').value = 'B2B';
    renderSmartstoreImages(); renderCoupangImages(); renderImwebB2bImages();
  });
  const remove = async id => page.evaluate(id => document.querySelector('#' + id + ' .vu-image-remove').click(), id);
  for (const id of ['ssImageList', 'cpImageList', 'iwB2bImageList']) {
    await remove(id);
    assert.equal(await page.locator('#' + id + ' .vu-image-tile').count(), 2);
  }
  assert.equal(await page.evaluate(() => calls.filter(c => /update/.test(c.channel)).length), 0);
  await page.evaluate(async () => { await saveSmartstoreEdit(); await saveCoupangEdit(); await updateImwebB2bProduct(); });
  const payloads = await page.evaluate(() => calls);
  for (const channel of ['smartstore-update-product', 'coupang-update', 'imweb-update-group']) {
    const data = payloads.find(c => c.channel === channel)?.data;
    assert.ok(data, channel + ' submitted');
    assert.deepEqual((data.detailImages || data.images).map(x => x.url || x), ['https://images.example/b.jpg', 'https://images.example/c.jpg']);
  }
  // Array replacement uses the selected form's marketplace and does not change the other forms.
  await page.evaluate(() => {
    const box = document.querySelector('#iwB2bImageList textarea'); box.value = 'https://images.example/new.jpg|https://images.example/next.jpg';
    document.querySelector('#iwB2bImageList .vu-image-import button').click();
  });
  await page.waitForFunction(() => iwB2bEditState.detailImages[0] === 'https://images.example/new.jpg');
  assert.equal(await page.evaluate(() => calls.filter(c => c.channel === 'bulk-images-import').at(-1).data.scope), 'imweb-b2b');
  assert.equal(await page.evaluate(() => ssEditState.detailImages[0].url), 'https://images.example/b.jpg');
  // 끝에 붙이기만 하면 기존 항목(네이버 블록 id · 쿠팡 원래 블록 형식·경로)은 그대로 두고 새 것만 '새 이미지'다.
  await page.evaluate(() => {
    ssEditState.detailImages = [{ id: 'naver-image-0', url: urls[0], isNew: false }];
    cpEditState.detailImages = [{ url: urls[0], raw: '/vendor/a.jpg', blockType: 'IMAGE_NO_SPACE', isNew: false }];
    renderSmartstoreImages(); renderCoupangImages();
    for (const id of ['ssImageList', 'cpImageList']) {
      document.querySelector('#' + id + ' textarea').value = urls[0] + '|https://ai.esmplus.com/yhshma/add.jpg';
      document.querySelector('#' + id + ' .vu-image-import button').click();
    }
  });
  await page.waitForFunction(() => ssEditState.detailImages.length === 2 && cpEditState.detailImages.length === 2);
  assert.deepEqual(await page.evaluate(() => ssEditState.detailImages), [{ id: 'naver-image-0', url: 'https://images.example/a.jpg', isNew: false }, { url: 'https://ai.esmplus.com/yhshma/add.jpg', isNew: true }]);
  assert.deepEqual(await page.evaluate(() => cpEditState.detailImages[0]), { url: 'https://images.example/a.jpg', raw: '/vendor/a.jpg', blockType: 'IMAGE_NO_SPACE', isNew: false });

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

  // 탐색기 이미지 파일을 갤러리에 끌어 놓으면 ESM 에 올린 주소가 목록 끝에 붙는다(저장은 기존 저장 버튼).
  await page.evaluate(() => loadAmazonProduct());
  await page.waitForFunction(() => document.querySelectorAll('#amzEditImageList .vu-image-tile').length === 3);
  const drag = (type, names) => page.evaluate(([type, names]) => {
    const dt = new DataTransfer();
    for (const name of names) dt.items.add(new File(['x'], name, { type: 'image/jpeg' }));
    const event = new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true });
    document.querySelector('#amzEditImageList .vu-image-tile img').dispatchEvent(event);
    return event.defaultPrevented;
  }, [type, names]);
  assert.equal(await drag('dragover', ['a.jpg']), true, '파일 드래그는 갤러리가 받는다');
  assert.equal(await page.locator('#amzEditImageList .vu-image-gallery.vu-image-dropping').count(), 1);
  const hostsBefore = await page.evaluate(() => calls.filter(c => c.channel === 'image-library-host-files').length);
  await drag('drop', ['virtual-thumb.jpg']);
  assert.match(await page.locator('#amzEditImageList .vu-image-save-hint').textContent(), /탐색기의 이미지 파일/);
  assert.equal(await page.evaluate(() => calls.filter(c => c.channel === 'image-library-host-files').length), hostsBefore, '경로 없는 파일은 올리지 않는다');
  await drag('drop', ['local1.jpg', 'local2.png']);
  await page.waitForFunction(() => document.querySelectorAll('#amzEditImageList .vu-image-tile').length === 5);
  assert.deepEqual(await page.evaluate(() => calls.filter(c => c.channel === 'image-library-host-files').at(-1).data.files), ['C:/사진/local1.jpg', 'C:/사진/local2.png']);
  assert.equal(await page.locator('#amzEditImageList .vu-image-dropping').count(), 0);
  await page.evaluate(() => registerAmazon());
  assert.deepEqual((await page.evaluate(() => calls.filter(c => c.channel === 'amazon-update').at(-1).data)).replaceImageUrls,
    ['https://images.example/a.jpg', 'https://images.example/b.jpg', 'https://images.example/c.jpg',
      'https://ai.esmplus.com/uploaded/vu_local1.jpg', 'https://ai.esmplus.com/uploaded/vu_local2.png']);

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
  assert.equal(await parent.locator('#image-library').isVisible(), true, 'single-edit mode keeps the library visible (drag rows onto the 6-mall cards)');
  await parent.evaluate(() => setSection8Mode('new'));
  assert.equal(await parent.locator('#image-library').isVisible(), true, 'new registration retains its defaults');
  assert.deepEqual(errors, []);
  console.log('PASS: domestic galleries on top (no single-URL rows), per-mall single-item arrays, native saves, array import isolation, Amazon US/JP replacement, empty draft, ESM detail add + move to main, local file drop → ESM upload → append, eBay image save/partial failure/retry block, library visible in edit mode.');
} finally { await browser.close(); }
