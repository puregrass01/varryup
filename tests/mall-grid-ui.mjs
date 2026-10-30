// 단일 상품 수정 — 6몰 표(mall-grid.js) — 가짜 IPC 로 셸(index_up.html) + 폼을 연다. 네트워크 · 실제 저장 없음. `node tests/mall-grid-ui.mjs`
// 지키는 것:
//   1) 수정 모드의 기본 화면은 카드 6장(자사몰 · B2B · 네이버 · 쿠팡 · 아마존 · 이베이), 신규 모드에는 표가 없다
//   2) 본사몰 상품 찾기에서 고르면 여섯 몰을 한꺼번에 불러온다 — 없는 몰은 '이 몰에 없음'
//   3) 칸을 고치면 '바뀜', 저장 전에 '몰 / 칸 / 이전 → 새' 를 묻고(취소하면 아무것도 안 감) 바뀐 칸만 보낸다
//   4) 쿠팡 상품명을 바꾸면 '저장 시 쿠팡 재승인' · 아마존 이미지는 미국 · 일본이 같으면 둘 다 · 타일 끌어 옮기기
//   5) 좌측 변경 판매가(USD)가 이베이 · 아마존 미국 칸에 들어간다 · 자사몰 [No.번호] 막기 · 결과는 카드마다 한 줄
//   6) 현황판 칸 · 카드 머리 → 그 몰 전체 탭, [← 6몰 표] 로 돌아온다
//   7) 셸 이미지 목록의 줄을 카드 갤러리(iframe)에 끌어 놓으면 그 주소가 끝에 붙는다
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const browser = await chromium.launch({ headless: true, executablePath: process.env.EBAY_TEST_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe', args: ['--allow-file-access-from-files'] });
try {
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  await context.route(/^https?:/, route => route.abort());
  await context.addInitScript(() => {
    window.calls = [];
    const IMG = n => `https://ai.esmplus.com/test/${n}.jpg`;
    const ownName = { 'imweb-ko': '옵틱글래스 기아 K5 광각미러 [No.612]', 'imweb-en': 'Optic-glass KIA K5 Wide View Side Mirror [No.612]', 'imweb-jp': 'Optic-glass KIA K5 広角ドアミラー [No.612]' };
    const ownSet = { 'imweb-ko': '150000', 'imweb-en': '110', 'imweb-jp': '16000' };
    const rows = (scope, id) => {
      if (ownName[scope]) return [
        { id: '11', optionId: '', name: ownName[scope], price: '80000', variant: '기본 판매가 (조합 가격은 아래 줄)', images: [IMG('k1')], imageRevision: 'rev-' + scope },
        { id: '11', optionId: 'od1', price: ownSet[scope], variant: scope === 'imweb-jp' ? '조합 · 1セット(左右)' : '조합 · 1set' },
        { id: '11', optionId: 'od2', price: '80000', variant: '조합 · 운전석' }];
      if (scope === 'ebay') return [{ id, price: '59.99', images: [IMG('e1'), IMG('e2')], imageRevision: 'er' }];
      return [{ id, name: scope === 'amazon-us' ? 'Optic Glass KIA K5 mirror' : 'オプティック K5 ミラー', price: scope === 'amazon-us' ? '109.99' : '16800',
        images: [IMG('a1'), IMG('a2')], imageRevision: 'ar-' + scope }];
    };
    const naver = () => ({ originNo: '13427230028', revision: 'r1', title: '옵틱글래스 기아 K5 광각 사이드 와이드미러', salePrice: 115000, groups: ['모델명', '상품선택', '좌석'],
      options: [{ names: ['기아 K5', '2020[No.612]', '운전석'], price: 0, stockQuantity: 10, usable: true },
        { names: ['기아 K5', '2020[No.612]', '조수석'], price: -10000, stockQuantity: 10, usable: true }],
      detailImages: [{ url: IMG('n1') }, { url: IMG('n2') }] });
    const coupang = () => ({ productId: '9876', title: '옵틱글래스 기아 K5 와이드미러',
      options: [{ sellerProductItemId: 1, vendorItemId: 101, itemName: 'No.612번 (3세대)', attrs: [], salePrice: 115000, stock: 10, imageUrl: '' }],
      detailImages: [{ url: IMG('c1') }] });
    window.require = () => ({ ipcRenderer: { on() {}, send() {}, async invoke(channel, data) {
      window.calls.push({ channel, data: JSON.parse(JSON.stringify(data ?? null)) });
      switch (channel) {
        // 아마존 · 이베이 목록: 'N612' 로 끝나는 SKU 하나 + 부분 일치 미끼(N6120)
        case 'bulk-price-list': if (/^(amazon|ebay)/.test(data.scope)) return { success: true, data: { items: [{ id: 'OBM0501N6120', sku: 'OBM0501N6120', name: 'decoy' },
          { id: 'OBM0501N612', sku: 'OBM0501N612', name: 'Optic Glass KIA K5 mirror' }] } };
          return { success: true, data: { items: [{ id: '11', name: ownName['imweb-ko'] }, { id: '12', name: '옵틱글래스 광각미러 [No.6120]' }] } };
        case 'bulk-price-load-many': return { success: true, data: { items: [{ id: data.ids[0], rows: rows(data.scope, data.ids[0]) }], blocked: '' } };
        case 'bulk-save-batch': if (data.scope === window.failScope) return { success: false, error: '수정 실패(테스트)' };
          return { success: true, data: { results: data.jobs.map((job, index) => ({ index, success: true, data: { status: 'VERIFIED', revision: 'rev-new' } })) } };
        case 'imweb-search-products': return { success: false, error: '상품을 찾지 못했습니다 ( / 612).' };
        case 'imweb-load-categories': return { success: true, categories: { 국산차: { 기아: ['K5'] }, 수입차: {} } };
        case 'smartstore-find-id': return data.brand === 'SLOW'   // 무거운 찾기가 늦게 끝난다
          ? new Promise(r => setTimeout(() => r({ success: true, rows: [{ id: '99999', name: '늦은 상품' }] }), 400))
          : { success: true, rows: [{ id: '13427230028', name: '옵틱글래스 기아 K5' }] };
        case 'smartstore-load-product': return { success: true, product: { ...naver(), originNo: String(data) } };
        case 'bulk-images-import': return { success: true, data: { images: String(data.input).split('|') } };
        case 'smartstore-update-product': return { success: true, product: { ...naver(), title: data.title, options: data.options }, message: '수정됨' };
        case 'coupang-load-product': return { success: true, product: coupang() };
        case 'coupang-update': return { success: true, approval: true, product: { ...coupang(), title: data.title }, message: '수정됨' };
        case 'ebay-load-product': return { success: true, data: { sku: data, inventory: { product: { title: 'Optic-glass Mirror for KIA K5', imageUrls: [IMG('e1'), IMG('e2')] } },
          offer: { offerId: 'o1', status: 'PUBLISHED', availableQuantity: 5, pricingSummary: { price: { value: '59.99', currency: 'USD' } } } } };
        case 'ebay-update': return { success: true, data: { status: 'UPDATED' } };
        // 셸 이미지 목록(수정 모드에도 보인다) — 상세 한 장이 ESM 주소
        case 'image-library-load': return { success: true, profiles: [{ id: 'domestic', label: '국내', folder: '', detailSource: 'esm', seed: false, errors: [], signature: 's',
          items: [{ name: '대표.jpg', role: '대표', path: 'C:/x/대표.jpg', url: '', selected: true }, { name: 'lib7.jpg', role: '상세', path: IMG('lib7'), url: IMG('lib7'), source: 'esm', selected: true }] }] };
        default: return {};
      }
    } } });
  });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(pathToFileURL(path.resolve('src/ui/index_up.html')).href + '?mode=edit');
  const frame = page.frameLocator('#form-frame');
  const child = () => page.frames().find(f => f.url().includes('/index.html'));
  const card = id => frame.locator(`.mg-card[data-mall="${id}"]`);
  const callsOf = channel => child().evaluate(ch => calls.filter(c => c.channel === ch).map(c => c.data), channel);
  const confirmNext = accept => new Promise(resolve => page.once('dialog', async d => { const text = d.message(); await (accept ? d.accept() : d.dismiss()); resolve(text); }));

  // 1) 수정 모드 기본 화면 = 카드 6장
  await frame.locator('#mallGridTab').waitFor({ state: 'visible' });
  assert.equal(await frame.locator('.mg-card').count(), 6);
  assert.equal(await page.locator('#btn-grid-back').isVisible(), false);

  // 2) 고르기(본사몰 상품 찾기 목록 선택 = change + vuChoosing) → 여섯 몰을 한꺼번에
  await page.evaluate(() => {
    const set = (id, v) => { document.getElementById(id).value = v; };
    set('inp-no', '612'); set('inp-brand', '기아'); set('inp-carmodel', 'K5');
    set('inp-sku', 'OBM0501N612'); set('inp-amz-sku', 'OBM0501N612'); set('inp-cpid', '9876');
    const db = document.getElementById('inp-db-search');
    db.dataset.vuChoosing = '1'; db.dispatchEvent(new Event('change', { bubbles: true })); delete db.dataset.vuChoosing;
  });
  await child().waitForFunction(() => /불러옴 5/.test(document.getElementById('mgStatus').textContent), null, { timeout: 15000 });
  assert.match(await card('b2b').innerText(), /이 몰에 없음/);
  assert.deepEqual((await callsOf('bulk-price-load-many')).map(d => d.scope).sort(), ['amazon-jp', 'amazon-us', 'ebay', 'imweb-en', 'imweb-jp', 'imweb-ko']);
  assert.equal((await callsOf('smartstore-find-id')).length, 1);
  assert.deepEqual(await card('own').locator('.mg-field span').allTextContents(),
    ['한국 상품명', '한국 1set (KRW)', '미국 상품명', '미국 1set (USD)', '일본 상품명', '일본 1set (JPY)']);
  assert.equal(await card('own').locator('input[data-key="imweb-ko:set"]').inputValue(), '150000', '1set 은 조합 줄 가격이다');
  assert.doesNotMatch(await card('amazon').innerText(), /리스팅의 열쇠/, '이유는 툴팁으로');
  assert.equal(await card('amazon').locator('.mg-tip', { hasText: 'SKU OBM0501N612' }).getAttribute('title'), '아마존 리스팅의 열쇠라 바꿀 수 없음');
  assert.match(await card('amazon').innerText(), /상품 이미지 \(첫 장 = 대표\) · 미국 · 일본 같은 목록/);
  assert.match(await card('naver').innerText(), /상세 이미지/);
  assert.equal(await card('naver').locator('.mg-opt-table tr').count(), 3, '옵션 표: 머리 + 옵션 2줄');
  assert.equal(await card('ebay').locator('input[data-key="title"]').inputValue(), 'Optic-glass Mirror for KIA K5');
  assert.equal(await card('own').locator('input[data-key="imweb-jp:set"]').inputValue(), '16000', '일본 구역은 1セット(左右) 줄이다');
  assert.equal(await frame.locator('#mgSaveAll').isDisabled(), true, '바뀐 것이 없으면 모두 저장은 꺼져 있다');

  // 무거운 네이버 찾기가 끝나기 전에 다른 상품을 고르면, 늦게 끝난 앞 상품이 탭 상태(저장 대상)를 덮지 않는다
  await child().evaluate(async () => {
    const keys = { no: '612', brand: '기아', model: 'K5', amzSku: 'OBM0501N612', cpid: '9876' };
    VUMallGrid.load({ ...keys, brand: 'SLOW' });
    await VUMallGrid.load({ ...keys, sku: 'OBM0501N612' });
    await new Promise(r => setTimeout(r, 600));
  });
  assert.equal(await child().evaluate(() => ssEditState.originNo), '13427230028');
  assert.equal((await callsOf('smartstore-load-product')).includes('99999'), false, '앞 상품은 불러오지도 않는다');

  // 좌측 SKU 없이 차량 행만 골라도 아마존 · 이베이는 상품번호로 몰 목록을 찾아 불러온다(N6120 미끼는 버린다)
  await child().evaluate(() => VUMallGrid.load({ no: '612', brand: '기아', model: 'K5', cpid: '9876' }));
  assert.match(await card('amazon').innerText(), /SKU OBM0501N612/);
  assert.equal(await card('ebay').locator('input[data-key="title"]').inputValue(), 'Optic-glass Mirror for KIA K5');
  assert.equal((await callsOf('ebay-load-product')).at(-1), 'OBM0501N612');

  // 3) 고치면 바뀜 · 쿠팡 상품명은 재승인 경고
  await card('amazon').locator('input[data-key="amazon-us:price"]').fill('99.99');
  await card('naver').locator('input[data-key="title"]').fill('옵틱글래스 기아 K5 새 제목');
  await card('naver').locator('.mg-opt-table tr').nth(2).locator('input').nth(3).fill('-5000');
  await card('coupang').locator('input[data-key="title"]').fill('옵틱글래스 기아 K5 와이드미러 새');
  assert.match(await card('coupang').locator('.mg-warn').textContent(), /저장 시 쿠팡 재승인/);
  assert.equal(await card('amazon').evaluate(el => el.classList.contains('mg-changed')), true);
  assert.equal(await frame.locator('#mgSaveAll').textContent(), '바뀐 몰 모두 저장 (3)');

  // 취소하면 아무것도 안 간다
  let asked = confirmNext(false);
  await frame.locator('#mgSaveAll').click();
  const text = await asked;
  assert.match(text, /몰 \/ 칸 \/ 이전 → 새/);
  assert.match(text, /아마존 \/ 미국 판매가 \(USD\) \/ 109\.99 → 99\.99/);
  assert.match(text, /네이버 \/ 상품명 \/ 옵틱글래스 기아 K5 광각 사이드 와이드미러 → 옵틱글래스 기아 K5 새 제목/);
  assert.match(text, /네이버 \/ 옵션 기아 K5 \/ 2020\[No\.612\] \/ 조수석 가격 차이 \/ -10000 → -5000/);
  assert.match(text, /쿠팡 재승인/);
  assert.doesNotMatch(text, /일본|이베이|자사몰/, '안 고친 칸은 묻지도 않는다');
  for (const ch of ['bulk-save-batch', 'smartstore-update-product', 'coupang-update']) assert.equal((await callsOf(ch)).length, 0, `${ch} 를 보내지 않는다`);

  // 확인하면 바뀐 칸만
  asked = confirmNext(true);
  await frame.locator('#mgSaveAll').click();
  await asked;
  await child().waitForFunction(() => ['amazon', 'naver', 'coupang'].every(id => /✅/.test(document.querySelector(`.mg-card[data-mall="${id}"] .mg-result`).textContent)));
  assert.deepEqual(await callsOf('bulk-save-batch').then(list => list.map(d => [d.scope, d.jobs])),
    [['amazon-us', [{ type: 'price', id: 'OBM0501N612', newPrice: '99.99', expectedPrice: '109.99' }]]], '아마존은 미국 판매가 한 줄만');
  const ss = (await callsOf('smartstore-update-product'))[0];
  assert.equal(ss.title, '옵틱글래스 기아 K5 새 제목');
  assert.deepEqual(ss.options.map(o => String(o.price)), ['0', '-5000']);
  assert.equal((await callsOf('coupang-update'))[0].title, '옵틱글래스 기아 K5 와이드미러 새');
  assert.equal(await frame.locator('#mgSaveAll').isDisabled(), true, '저장된 값이 새 불러온 값이 된다');
  assert.match(await card('amazon').locator('.mg-result').textContent(), /✅ 저장 완료 — 미국 판매가/);

  // 4) 아마존 이미지: 타일 끌어 옮기기 → 미국 · 일본 둘 다(같은 목록)
  await child().evaluate(() => {
    const tiles = document.querySelectorAll('.mg-card[data-mall="amazon"] .vu-image-tile'), dt = new DataTransfer();
    tiles[0].dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    tiles[1].dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    tiles[1].dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    calls.length = 0; window.failScope = 'amazon-jp';
  });
  asked = confirmNext(true);
  await card('amazon').locator('.mg-save').click();
  assert.match(await asked, /아마존 \/ 상품 이미지 \(첫 장 = 대표\) · 미국 · 일본 같은 목록 \/ 2장 → 2장 \(순서만\)/);
  await child().waitForFunction(() => /❌ 일부만 저장/.test(document.querySelector('.mg-card[data-mall="amazon"] .mg-result').textContent));
  assert.deepEqual((await callsOf('bulk-save-batch')).map(d => [d.scope, d.jobs[0].urls.map(u => u.slice(-6)), d.jobs[0].expectedRevision]),
    [['amazon-us', ['a2.jpg', 'a1.jpg'], 'ar-amazon-us'], ['amazon-jp', ['a2.jpg', 'a1.jpg'], 'ar-amazon-jp']]);
  // 미국만 되고 일본이 실패했으면 이미지는 '바뀜' 으로 남는다 — 다시 누르면 일본도 다시 간다
  assert.equal(await card('amazon').evaluate(el => el.classList.contains('mg-changed')), true, '일본 실패 뒤에도 이미지는 바뀜');
  await child().evaluate(() => { calls.length = 0; window.failScope = ''; });
  asked = confirmNext(true);
  await card('amazon').locator('.mg-save').click();
  await asked;
  await child().waitForFunction(() => /✅/.test(document.querySelector('.mg-card[data-mall="amazon"] .mg-result').textContent));
  assert.deepEqual((await callsOf('bulk-save-batch')).map(d => [d.scope, d.jobs[0].expectedRevision]), [['amazon-us', 'rev-new'], ['amazon-jp', 'ar-amazon-jp']]);

  // 5) 좌측 변경 판매가(USD) → 이베이 · 아마존 미국 칸. 이베이 카드만 저장 → 탭의 가격 저장(가격만)
  await page.evaluate(() => { const el = document.getElementById('inp-edit-usd'); el.value = '120'; el.dispatchEvent(new Event('change', { bubbles: true })); });
  assert.equal(await card('ebay').locator('input[data-key="price"]').inputValue(), '120');
  assert.equal(await card('amazon').locator('input[data-key="amazon-us:price"]').inputValue(), '120');
  await child().evaluate(() => { calls.length = 0; });
  asked = confirmNext(true);
  await card('ebay').locator('.mg-save').click();
  assert.match(await asked, /eBay 미국 \/ 판매가 \(USD\) \/ 59\.99 → 120/);
  await child().waitForFunction(() => /✅/.test(document.querySelector('.mg-card[data-mall="ebay"] .mg-result').textContent));
  assert.deepEqual((await callsOf('ebay-update'))[0], { sku: 'OBM0501N612', price: '120', priceOnly: true, expectedPrice: '59.99' });
  assert.equal((await callsOf('bulk-save-batch')).length, 0, '이베이 이미지를 안 바꿨으면 이미지 요청은 없다');
  // 원화: 네이버 기본 판매가 · 쿠팡은 좌측 상품번호(612)의 옵션. 10원 단위가 아니면 쿠팡 카드에 알리고 칸은 그대로
  await page.evaluate(() => { const el = document.getElementById('inp-edit-krw'); el.value = '120000'; el.dispatchEvent(new Event('change', { bubbles: true })); });
  assert.equal(await card('naver').locator('input[data-key="price"]').inputValue(), '120000');
  assert.equal(await card('coupang').locator('input[data-key="opt1:price"]').inputValue(), '120000');
  await page.evaluate(() => { const el = document.getElementById('inp-edit-krw'); el.value = '120005'; el.dispatchEvent(new Event('change', { bubbles: true })); });
  assert.match(await card('coupang').locator('.mg-result').textContent(), /10원 단위/);
  assert.equal(await card('coupang').locator('input[data-key="opt1:price"]').inputValue(), '120000');

  // 자사몰: [No.번호] 를 지우면 막는다(아무것도 안 감)
  await card('own').locator('input[data-key="imweb-en:name"]').fill('Optic-glass KIA K5 mirror');
  asked = confirmNext(true);
  await card('own').locator('.mg-save').click();
  await asked;
  await child().waitForFunction(() => /❌/.test(document.querySelector('.mg-card[data-mall="own"] .mg-result').textContent));
  assert.match(await card('own').locator('.mg-result').textContent(), /\[No\.612\] 를 남겨 주세요/);
  assert.equal((await callsOf('bulk-save-batch')).length, 0);

  // 쿠팡: 전체 탭에서 옵션 이름을 바꿨으면 확인 목록 · 재승인 경고에 나온다(탭의 저장이 옵션을 통째로 보낸다)
  await child().evaluate(() => { cpEditState.options[0].itemName = 'No.612번 (4세대)'; window.showMallGrid(); });
  asked = confirmNext(false);
  await card('coupang').locator('.mg-save').click();
  const cpText = await asked;
  assert.match(cpText, /쿠팡 \/ 옵션 이름 · 추가 · 삭제 · 옵션 이미지 \(전체 탭에서 고침\)/);
  assert.match(cpText, /쿠팡 재승인/);
  // 이미지를 지웠다 같은 주소로 다시 넣으면 이미지는 그대로 — 판매가만 바꾼 저장에 detailImages(상품 수정 = 재승인)를 싣지 않는다
  await child().evaluate(() => { cpEditState.options[0].itemName = 'No.612번 (3세대)'; window.showMallGrid(); calls.length = 0; });
  await card('coupang').locator('.vu-image-remove').click();
  await card('coupang').locator('.vu-image-import textarea').fill('https://ai.esmplus.com/test/c1.jpg');
  await card('coupang').locator('.vu-image-import button').click();
  await card('coupang').locator('.vu-image-tile').waitFor();
  asked = confirmNext(true);
  await card('coupang').locator('.mg-save').click();
  assert.doesNotMatch(await asked, /재승인|상세 이미지/);
  await child().waitForFunction(() => /✅|❌/.test(document.querySelector('.mg-card[data-mall="coupang"] .mg-result').textContent));
  const cu = (await callsOf('coupang-update'))[0];
  assert.equal(cu.detailImages, undefined, '이미지는 보내지 않는다');
  assert.equal(String(cu.options[0].salePrice), '120000');

  // 셸 이미지 목록의 줄(부모 문서)을 이베이 카드 갤러리(iframe)에 끌어 놓으면 그 주소가 끝에 붙는다 — 실제 마우스 드래그(문서 넘기)
  assert.equal(await page.locator('#image-library').isVisible(), true, '수정 모드에도 이미지 목록이 보인다');
  const libRow = page.locator('.vu-image-row[draggable="true"]').filter({ hasText: 'lib7.jpg' });
  await libRow.waitFor();
  const ebayTiles = () => card('ebay').locator('.vu-image-tile img').evaluateAll(list => list.map(img => img.getAttribute('src')));
  assert.equal((await ebayTiles()).length, 2);
  await card('ebay').locator('.vu-image-add').scrollIntoViewIfNeeded();
  const from = await libRow.boundingBox(), to = await card('ebay').locator('.vu-image-add').boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2); await page.mouse.down();
  await page.mouse.move(from.x + 10, from.y + 10, { steps: 4 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 }); await page.mouse.up();
  await child().waitForFunction(() => document.querySelectorAll('.mg-card[data-mall="ebay"] .vu-image-tile').length === 3);
  assert.deepEqual(await ebayTiles(), ['https://ai.esmplus.com/test/e1.jpg', 'https://ai.esmplus.com/test/e2.jpg', 'https://ai.esmplus.com/test/lib7.jpg']);
  assert.equal(await card('ebay').evaluate(el => el.classList.contains('mg-changed')), true, '붙인 이미지는 바뀜(저장 전)');

  // 6) 현황판 칸 → 그 몰 전체 탭, [← 6몰 표] 로 돌아온다 · 카드 머리도 전체 탭
  await page.locator('#cell-KOREA-open2').click();
  await frame.locator('#coupangTab').waitFor({ state: 'visible' });
  assert.equal(await frame.locator('#mallGridTab').isVisible(), false);
  assert.equal(await page.locator('#btn-grid-back').isVisible(), true);
  await page.locator('#btn-grid-back').click();
  await frame.locator('#mallGridTab').waitFor({ state: 'visible' });
  assert.match(await card('naver').locator('.mg-result').textContent(), /✅/, '돌아와도 카드 결과가 남는다');
  await card('naver').locator('.mg-head').click();
  await frame.locator('#naverTab').waitFor({ state: 'visible' });
  assert.equal(await frame.locator('#ssEditTitle').inputValue(), '옵틱글래스 기아 K5 새 제목', '카드와 탭은 같은 상태다');

  // 신규 모드에는 표가 없다
  await page.locator('label[for="mode-new"]').click();
  await page.waitForTimeout(200);
  assert.equal(await frame.locator('#mallGridTab').isVisible(), false);
  assert.equal(await page.locator('#btn-grid-back').isVisible(), false);

  assert.deepEqual(errors, []);
  console.log('PASS: 6몰 표 — 카드 6장 · 한꺼번에 불러오기 · 이 몰에 없음 · 바뀐 칸만(묻고 보냄) · 쿠팡 재승인 경고 · 아마존 이미지 둘 다 · 타일 끌기 · 좌측 변경 판매가 · [No.번호] 막기 · 탭 오가기 · 신규 모드엔 없음');
} finally {
  await browser.close();
}
