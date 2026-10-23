// 쿠팡 옵션 판매가 로컬 캐시 — 상품 일괄 수정 목록에 마지막으로 읽은 판매가를 보여 준다. 네트워크는 쓰지 않는다.
//
// 왜 필요한가 (2026-10-01)
//   쿠팡 상품 목록 API(상품 목록 페이징 조회)는 옵션ID(vendorItemId)·판매가를 주지 않는다(공식 문서). 그래서 목록은
//   상품마다 '조회 필요 · 현재가 조회 전' 이었다. 아마존·eBay 는 목록 동기화로 받은 캐시를 '(목록)' 가격으로 보여 주는데
//   쿠팡에는 한 번에 받을 길이 없어서, 상품 조회·가격 조회·가격 변경이 지나갈 때 알게 된 값을 모아 둔다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CoupangStore } from '../src/platforms/coupang_store.js';
import { Coupang } from '../src/platforms/coupang.js';
import { registerBulkPriceIPC } from '../src/bulk_price_ipc.js';

function tmpDir(t, prefix = 'coupang-cache-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const VENDOR = 'A00099999';
const option = (optionId, itemName, extra = {}) => ({ optionId, itemName, ...extra });

test('캐시: 상품 구성을 저장하고 옵션 판매가를 채운다 · 다시 만든 저장소도 파일에서 읽는다', t => {
  const dir = tmpDir(t);
  const store = new CoupangStore(dir);
  store.saveProduct(VENDOR, 777, { name: '옵틱글래스 EV3', statusName: '승인완료',
    options: [option('5011', 'No.K138번 (2세대) BSA'), option('item-12', '승인 전 옵션', { readonly: true, salePrice: 99000 })] });
  assert.equal(store.updatePrice(VENDOR, '5011', 115000), true);
  store.flush();   // 파일은 모아서 쓴다(앱은 1초 뒤 · 끌 때)
  const fresh = new CoupangStore(dir).products(VENDOR);
  assert.equal(fresh['777'].name, '옵틱글래스 EV3');
  assert.deepEqual(fresh['777'].options.map(o => [o.optionId, o.itemName, o.readonly, o.price]),
    [['5011', 'No.K138번 (2세대) BSA', false, '115000'], ['item-12', '승인 전 옵션', true, '99000']]);
  assert.ok(fresh['777'].options.every(o => o.checkedAt), '판매가를 언제 읽었는지 남긴다');
});

test('캐시: 상품을 다시 조회해도 옵션의 판매가는 이어 가고, 상품 조회 응답의 판매가로 덮지 않는다 · 사라진 옵션은 뺀다', t => {
  const store = new CoupangStore(tmpDir(t));
  store.saveProduct(VENDOR, 777, { options: [option('5011', 'A'), option('5022', 'B')] });
  store.updatePrice(VENDOR, '5011', 115000);
  store.updatePrice(VENDOR, '5022', 99000);
  // 다시 조회: 5022 는 사라지고 5033 이 새로 생겼다. 상품 조회 응답의 판매가(salePrice)는 쓰지 않는다.
  store.saveProduct(VENDOR, 777, { options: [option('5011', 'A2', { salePrice: 1 }), option('5033', 'C', { salePrice: 1 })] });
  assert.deepEqual(store.products(VENDOR)['777'].options.map(o => [o.optionId, o.itemName, o.price]),
    [['5011', 'A2', '115000'], ['5033', 'C', '']]);
});

test('캐시: 모르는 옵션의 판매가는 버리고 파일도 쓰지 않는다', t => {
  const dir = tmpDir(t);
  const store = new CoupangStore(dir);
  assert.equal(store.updatePrice(VENDOR, '9999', 1000), false);
  assert.equal(store.flush(), false, '쓸 변경이 없다');
  assert.equal(fs.existsSync(path.join(dir, 'coupang_prices_cache.json')), false);
});

test('캐시: 다른 판매자(vendorId)의 캐시는 없는 것으로 친다', t => {
  const store = new CoupangStore(tmpDir(t));
  store.saveProduct(VENDOR, 777, { options: [option('5011', 'A')] });
  store.updatePrice(VENDOR, '5011', 115000);
  assert.deepEqual(store.products('A00011111'), {});
  assert.equal(store.updatePrice('A00011111', '5011', 1), false, '다른 판매자 이름으로 값을 바꾸지 않는다');
  assert.equal(store.products(VENDOR)['777'].options[0].price, '115000');
});

test('캐시: 손상된 파일은 없는 것으로 치고 다음 저장이 덮어쓴다', t => {
  const dir = tmpDir(t);
  fs.writeFileSync(path.join(dir, 'coupang_prices_cache.json'), '{ 잘린 파일');
  const store = new CoupangStore(dir);
  assert.deepEqual(store.products(VENDOR), {});
  store.saveProduct(VENDOR, 777, { options: [option('5011', 'A')] });
  store.flush();
  assert.equal(new CoupangStore(dir).products(VENDOR)['777'].options[0].optionId, '5011');
});

test('캐시: 쿠팡 목록에 없는 상품(삭제됨)은 뺀다 · 뺄 것이 없으면 쓰지 않는다', t => {
  const dir = tmpDir(t);
  const store = new CoupangStore(dir);
  store.saveProduct(VENDOR, 777, { options: [option('5011', 'A')] });
  store.saveProduct(VENDOR, 888, { options: [option('6011', 'B')] });
  assert.equal(store.keepOnly(VENDOR, ['777']), true);
  assert.deepEqual(Object.keys(store.products(VENDOR)), ['777']);
  store.flush();
  const before = fs.statSync(path.join(dir, 'coupang_prices_cache.json')).mtimeMs;
  assert.equal(store.keepOnly(VENDOR, ['777', '999']), false);
  assert.equal(store.flush(), false, '뺄 것이 없으면 쓸 것도 없다');
  assert.equal(fs.statSync(path.join(dir, 'coupang_prices_cache.json')).mtimeMs, before);
});

// 판매가 하나 알 때마다 파일을 통째로 쓰면 전체 불러오기 한 번에 7천 번 가까이 썼다(2026-10-01 실측).
test('캐시: 파일은 모아서 쓴다 — 조용해지면 1초 뒤, 계속 바뀌어도 5초마다 한 번 · 읽는 쪽은 바로 새 값을 본다', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const dir = tmpDir(t), file = path.join(dir, 'coupang_prices_cache.json');
  const store = new CoupangStore(dir);
  const writes = t.mock.method(fs, 'writeFileSync');
  store.saveProduct(VENDOR, 777, { options: Array.from({ length: 50 }, (_, i) => option(String(5000 + i), 'O' + i)) });
  for (let i = 0; i < 50; i++) store.updatePrice(VENDOR, String(5000 + i), 1000 + i);
  assert.equal(writes.mock.callCount(), 0, '바뀔 때마다 쓰지 않는다');
  assert.equal(store.products(VENDOR)['777'].options[49].price, '1049', '메모리 값은 바로 바뀐다');
  t.mock.timers.tick(1000);
  assert.equal(writes.mock.callCount(), 1, '조용해지고 1초 뒤에 한 번');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).products['777'].options[49].price, '1049');
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /\n/, '자주 쓰는 파일이라 들여쓰지 않는다');

  // 0.5초마다 계속 바뀌면 조용해지는 순간이 없다 — 그래도 처음 바뀐 뒤 5초 안에 쓴다.
  for (let i = 0; i < 9; i++) { store.updatePrice(VENDOR, '5000', 2000 + i); t.mock.timers.tick(500); }
  assert.equal(writes.mock.callCount(), 1, '아직 5초가 안 됐다');
  store.updatePrice(VENDOR, '5000', 2999);
  t.mock.timers.tick(500);
  assert.equal(writes.mock.callCount(), 2, '5초가 되면 계속 바뀌는 중에도 쓴다');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).products['777'].options[0].price, '2999');
});

test('캐시: flush() 는 남은 변경을 바로 쓰고(앱을 끌 때), 쓰기가 실패하면 다음에 다시 쓴다', t => {
  const dir = tmpDir(t);
  const store = new CoupangStore(dir);
  store.saveProduct(VENDOR, 777, { options: [option('5011', 'A')] });
  store.updatePrice(VENDOR, '5011', 115000);
  t.mock.method(console, 'warn', () => {});
  const failing = t.mock.method(fs, 'renameSync', () => { throw new Error('EBUSY'); });
  assert.equal(store.flush(), false);
  failing.mock.restore();
  assert.equal(store.flush(), true, '실패한 변경을 버리지 않는다');
  assert.equal(new CoupangStore(dir).products(VENDOR)['777'].options[0].price, '115000');
});

test('캐시: products() 는 복사본이라 읽는 쪽이 고쳐도 캐시가 바뀌지 않는다', t => {
  const store = new CoupangStore(tmpDir(t));
  store.saveProduct(VENDOR, 777, { options: [option('5011', 'A')] });
  store.products(VENDOR)['777'].options[0].price = 'tampered';
  assert.equal(store.products(VENDOR)['777'].options[0].price, '');
});

// ── 실제 Coupang 클래스 (fetch 모의) ─────────────────────────────────────
// 쿠팡 쪽: 상품 목록 3개(777·888·999), 777 은 승인완료 옵션 하나(5011)와 승인 전 옵션 하나(옵션ID 없음).
// 가격 변경은 옵션 가격 조회에 바로 반영된다.
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const item = (sellerProductItemId, vendorItemId, itemName, salePrice) => ({
  sellerProductItemId, vendorItemId, itemName, salePrice, originalPrice: salePrice, maximumBuyCount: 5,
  attributes: [{ attributeTypeName: '차종', attributeValueName: itemName, exposed: 'EXPOSED' }], images: [], contents: [],
});

function coupangWithStore(t, { store = 'real', listed = [777, 888, 999] } = {}) {
  const dir = tmpDir(t, 'coupang-adapter-');
  const file = path.join(dir, 'coupang_config.json');
  fs.writeFileSync(file, JSON.stringify({ vendorId: VENDOR, accessKey: 'ak', secretKey: 'sk' }));
  const prices = { 5011: 115000 }, calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const u = String(url), method = options.method || 'GET';
    calls.push(`${method} ${u.replace(/^.*\/marketplace/, '')}`);
    const inv = u.match(/vendor-items\/(\d+)\/(?:inventories|prices\/(\d+))/);
    if (inv && method === 'GET') return json({ code: 'SUCCESS', data: { salePrice: prices[inv[1]], amountInStock: 5, onSale: true } });
    if (inv && method === 'PUT') { prices[inv[1]] = Number(inv[2]); return json({ code: 'SUCCESS', message: '가격 변경을 완료했습니다.', data: null }); }
    if (/\/seller-products\?/.test(u)) return json({ code: 'SUCCESS', nextToken: '', data: listed.map(id => ({ sellerProductId: id, sellerProductName: '상품 ' + id })) });
    if (/\/seller-products\/777$/.test(u)) return json({ code: 'SUCCESS', data: { sellerProductId: 777, sellerProductName: '옵틱글래스 야마하 트레이서9 오토바이 광각 사이드 와이드미러',
      statusName: '승인완료', items: [item(11, 5011, 'No.Y101번 (1세대/21-) BSA', 9000), item(12, null, 'No.Y102번 (1세대)', 8000)] } });
    throw new Error('모의에 없는 요청: ' + method + ' ' + u);
  });
  const cache = store === 'real' ? new CoupangStore(dir) : store;
  const coupang = new Coupang(file, cache || undefined);
  coupang.loadConfig();
  return { coupang, store: cache, dir, prices, calls };
}

test('쿠팡: 상품 조회가 옵션 구성을, 가격 조회가 판매가를 캐시에 적는다(상품 조회 응답의 판매가는 쓰지 않는다)', async t => {
  const { coupang, store } = coupangWithStore(t);
  await coupang.loadProductForEdit(777);
  let options = store.products(VENDOR)['777'].options;
  assert.deepEqual(options.map(o => [o.optionId, o.readonly, o.price]), [['5011', false, ''], ['item-12', true, '8000']],
    '승인완료 옵션의 판매가는 가격 조회 전까지 비워 둔다 — 상품 조회 응답(9000)은 가격 변경 API 값을 바로 보여 주는지 모른다');
  await coupang.api.getItemInventory(5011);
  options = store.products(VENDOR)['777'].options;
  assert.equal(options[0].price, '115000');
});

test('쿠팡: 가격 변경(일괄 수정 저장 · 상품 수정 탭)이 바꾼 판매가를 캐시에 적는다', async t => {
  const { coupang, store } = coupangWithStore(t);
  await coupang.loadProductForEdit(777);
  await coupang.changeItemPrice({ vendorItemId: '5011', salePrice: '120000', expectedPrice: '115000' });
  assert.equal(store.products(VENDOR)['777'].options[0].price, '120000');
  // 상품 수정 탭의 판매가만 바꾼 저장도 같은 가격 변경 API 를 지나간다.
  await coupang.updateExistingProduct({ productId: 777, options: [
    { sellerProductItemId: 11, isNew: false, attrs: [{ index: 0, typeName: '차종', value: 'No.Y101번 (1세대/21-) BSA' }], salePrice: 130000 },
    { sellerProductItemId: 12, isNew: false, attrs: [{ index: 0, typeName: '차종', value: 'No.Y102번 (1세대)' }], salePrice: 8000 },
  ] });
  assert.equal(store.products(VENDOR)['777'].options[0].price, '130000');
});

test('쿠팡: 캐시 저장이 실패해도 쿠팡 호출 결과는 그대로 돌려준다 · 저장소가 없으면 아무것도 쓰지 않는다', async t => {
  const broken = { saveProduct() { throw new Error('disk full'); }, updatePrice() { throw new Error('disk full'); }, products: () => ({}), keepOnly() {} };
  t.mock.method(console, 'warn', () => {});
  const { coupang } = coupangWithStore(t, { store: broken });
  assert.equal((await coupang.loadProductForEdit(777)).options.length, 2);
  assert.equal((await coupang.api.getItemInventory(5011)).salePrice, 115000);
  t.mock.restoreAll();

  const bare = coupangWithStore(t, { store: null });
  await bare.coupang.loadProductForEdit(777);
  await bare.coupang.api.getItemInventory(5011);
  assert.deepEqual(fs.readdirSync(bare.dir), ['coupang_config.json'], '저장소 없이 만들면 설정 파일 말고는 쓰지 않는다');
});

test('쿠팡 목록: 불러온 적 있는 상품은 옵션 행으로 펼치고 판매가·읽은 시각을 보여 준다 · 처음 보는 상품은 한 줄 · 삭제된 상품은 캐시에서 뺀다', async t => {
  const { coupang, store } = coupangWithStore(t);
  store.saveProduct(VENDOR, 555, { options: [option('9011', 'X')] });   // 쿠팡 목록에 없는 상품(삭제됨)
  await coupang.loadProductForEdit(777);
  await coupang.api.getItemInventory(5011);
  const { items, cached } = await coupang.listForPriceEdit();
  assert.equal(cached, 1);
  assert.deepEqual(items.map(r => [r.id, r.optionId ?? '', r.price ?? '', !!r.readonly]),
    [['777', '5011', '115000', false], ['777', 'item-12', '8000', true], ['888', '', '', false], ['999', '', '', false]]);
  assert.equal(items[0].variant, 'No.Y101번 (1세대/21-) BSA');
  assert.match(items[0].result, /^현재가 조회 전 · .+ 에 읽은 판매가$/);
  assert.match(items[1].result, /승인완료 전 옵션/);
  assert.deepEqual(Object.keys(store.products(VENDOR)).sort(), ['777'], '삭제된 상품(555)은 캐시에서 뺀다');
});

// ── 상품 일괄 수정 IPC (bulk-price-list → load-many → save-batch) ──────────────────────
test('일괄 수정: 쿠팡 목록이 마지막으로 읽은 판매가를 (목록) 행으로 보이고, 불러오기·저장이 그 값을 새로 고친다', async t => {
  const { coupang } = coupangWithStore(t);
  const handlers = {};
  registerBulkPriceIPC({
    ipcMain: { handle: (channel, fn) => { handlers[channel] = fn; } },
    coupang: () => coupang, naverAPI: () => null, naverProducts: () => null, amazon: () => null, ebay: () => null,
    imweb: async () => null, board: async () => null, rates: async () => ({ data: {} }),
    log: { error: () => {} }, sleep: async () => {}, readCatalog: async () => ({}),
  });
  const invoke = (channel, input) => handlers[channel](null, input);

  // 처음: 캐시가 비어 있으면 상품 한 줄씩이고, 왜 판매가가 없는지 알린다.
  let listed = await invoke('bulk-price-list', { scope: 'coupang' });
  assert.equal(listed.success, true);
  assert.deepEqual(listed.data.items.map(r => [r.id, r.price, r.ready]), [['777', '', false], ['888', '', false], ['999', '', false]]);
  assert.match(listed.data.note, /쿠팡 목록에는 옵션·판매가가 없습니다/);

  // 현재가 불러오기 → 다음 목록부터 옵션 행에 그 판매가가 '(목록)' 으로 보인다. 상품번호도 옵션 문구에서 읽힌다.
  const loaded = await invoke('bulk-price-load-many', { scope: 'coupang', ids: ['777'] });
  assert.equal(loaded.success, true);
  listed = await invoke('bulk-price-list', { scope: 'coupang' });
  const [first, second] = listed.data.items;
  assert.deepEqual([first.id, first.optionId, first.price, first.ready], ['777', '5011', '115000', false],
    '목록 값은 보여 주기만 한다 — 고치려면 현재가를 다시 불러와야 한다(ready:false)');
  assert.deepEqual([second.optionId, second.readonly], ['item-12', true]);
  assert.deepEqual(first.identity.nos, ['Y101'], '처음 보는 상품의 상품번호도 옵션 문구로 읽힌다');
  assert.match(listed.data.note, /불러온 적 있는 상품 1개/);

  // 저장하면 캐시도 새 판매가다.
  const saved = await invoke('bulk-save-batch', { jobId: 'coupang-cache-1', scope: 'coupang',
    jobs: [{ type: 'price', id: '777', optionId: '5011', newPrice: '120000', expectedPrice: '115000' }] });
  assert.equal(saved.data.results[0].data.status, 'VERIFIED');
  listed = await invoke('bulk-price-list', { scope: 'coupang' });
  assert.equal(listed.data.items[0].price, '120000');
});
