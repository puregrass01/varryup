// 아마존 · eBay 목록 캐시는 메모리에 두고 모아서 쓴다(src/utils/json_file.js JsonCache). 네트워크는 쓰지 않는다.
//
// 왜 (2026-10-23)
//   상품 수정마다 캐시 파일을 통째로 다시 썼다 — refreshListings 는 SKU 마다, 일괄 가격 수정은 행마다.
//   쿠팡 판매가 캐시(coupang-price-cache.test.mjs)와 같은 방식으로 바꿨고, 앱을 끌 때(before-quit) flush() 로
//   남은 것을 쓴다. 여기서는 그 남은 쓰기가 flush 로 디스크에 닿는지, 계정이 바뀌어 지우면 취소되는지 본다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AmazonStore } from '../src/platforms/amazon_store.js';
import { EbayStore } from '../src/platforms/ebay_store.js';

const MP = 'ATVPDKIKX0DER';

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'listings-cache-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const onDisk = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const row = (id, price) => ({ id, sku: id, listingId: 'L-' + id, name: id, price, stock: '1' });

test('AmazonStore: 수정은 메모리에 바로 · 파일은 flush() 때 쓴다', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const store = new AmazonStore(tmpDir(t));
  const file = store.listingsPath(MP);
  store.saveListingsCache({ sellerId: 'S', marketplaceId: MP, total: 1, items: [row('SKU-1', '10')] });
  assert.equal(onDisk(file).items[0].price, '10', '전체 동기화 결과는 바로 쓴다');

  store.updateCachedListing('SKU-1', { price: 99 }, MP);
  assert.equal(store.listingsCache(MP).items[0].price, '99', '읽는 쪽은 바로 새 값');
  assert.equal(onDisk(file).items[0].price, '10', '파일은 아직');
  store.flush();
  assert.equal(onDisk(file).items[0].price, '99');

  const writes = t.mock.method(fs, 'writeFileSync');
  store.updateCachedListing('SKU-1', { price: '99' }, MP);   // 같은 값
  t.mock.timers.tick(5000);
  assert.equal(writes.mock.callCount(), 0, '바뀐 것이 없으면 쓰지 않는다');
});

test('AmazonStore: 계정이 바뀌어 지우면 남은 쓰기도 취소된다 · 읽지 않은 마켓 파일도 지운다', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const dir = tmpDir(t), store = new AmazonStore(dir);
  const file = store.listingsPath(MP), jp = path.join(dir, 'amazon_listings_cache_A1VC38T7YXB528.json');
  store.saveListingsCache({ sellerId: 'S', marketplaceId: MP, total: 1, items: [row('SKU-1', '10')] });
  fs.writeFileSync(jp, '{}');   // 이 실행에서 한 번도 읽지 않은 일본 캐시
  store.updateCachedListing('SKU-1', { price: 99 }, MP);
  store.clearListingsCache();
  t.mock.timers.tick(5000);
  assert.equal(fs.existsSync(file), false, '지운 뒤 타이머가 옛 계정 목록을 되살리지 않는다');
  assert.equal(fs.existsSync(jp), false);
  assert.equal(store.listingsCache(MP), null);
});

const mockEncryption = { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s), decryptString: b => b.toString() };

test('EbayStore: 가격 수정은 flush() 때 쓰고, 이미지만 바뀐 호출은 파일을 건드리지 않는다', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const store = new EbayStore(tmpDir(t), mockEncryption);
  store.saveListingsCache({ environment: 'sandbox', total: 1, items: [row('SKU-1', '10.00')] });
  const before = fs.readFileSync(store.listingsPath, 'utf8');

  const writes = t.mock.method(fs, 'writeFileSync');
  store.updateCachedListing('SKU-1', { image: 'https://i.ebayimg.com/x.jpg' });
  t.mock.timers.tick(5000);
  assert.equal(store.flush(), false, '쓸 것이 없다');
  assert.equal(writes.mock.callCount(), 0);
  assert.equal(fs.readFileSync(store.listingsPath, 'utf8'), before);

  store.updateCachedListing('SKU-1', { price: '15.50' });
  assert.equal(store.listingsCache().items[0].price, '15.50');
  assert.equal(onDisk(store.listingsPath).items[0].price, '10.00', '파일은 아직');
  assert.equal(store.flush(), true);
  assert.equal(onDisk(store.listingsPath).items[0].price, '15.50');
});

// 지운 뒤 메모리가 '없음' 을 기억하면 그 뒤 생긴 파일을 못 본다 — duplicate-guard 의 '캐시가 깨져도 진행한다' 가
// 깨진 파일 대신 '캐시 없음' 경로만 지나가게 된다.
test('EbayStore: 지운 뒤 생긴 파일(깨진 것 포함)은 다시 읽는다', t => {
  const store = new EbayStore(tmpDir(t), mockEncryption);
  store.saveListingsCache({ environment: 'sandbox', total: 1, items: [row('SKU-1', '10.00')] });
  store.clearListingsCache();
  fs.writeFileSync(store.listingsPath, '{ broken');
  assert.throws(() => store.listingsCache(), SyntaxError);
});

// 전체 동기화 결과를 못 쓰면 던진다(2026-10-23 전과 같다) — 조용히 경고만 하면 화면은 '동기화 완료' 인데 파일은 옛 목록이고,
// 다시 켜면 옛 목록(중복 검사 근거 포함)으로 돌아간다. 메모리도 옛 값 그대로 — 파일과 어긋나지 않는다.
test('목록 캐시: 전체 동기화 결과를 쓰지 못하면 던지고 메모리도 그대로다', t => {
  const amazon = new AmazonStore(tmpDir(t)), ebay = new EbayStore(tmpDir(t), mockEncryption);
  amazon.saveListingsCache({ sellerId: 'S', marketplaceId: MP, total: 1, items: [row('SKU-1', '10')] });
  ebay.saveListingsCache({ environment: 'sandbox', total: 1, items: [row('SKU-1', '10.00')] });
  t.mock.method(fs, 'renameSync', () => { throw new Error('EPERM'); });
  assert.throws(() => amazon.saveListingsCache({ sellerId: 'S', marketplaceId: MP, total: 1, items: [row('SKU-1', '20')] }), /EPERM/);
  assert.throws(() => ebay.saveListingsCache({ environment: 'sandbox', total: 1, items: [row('SKU-1', '20.00')] }), /EPERM/);
  assert.equal(amazon.listingsCache(MP).items[0].price, '10');
  assert.equal(ebay.listingsCache().items[0].price, '10.00');
  assert.equal(ebay.flush(), false, '남은 쓰기도 없다');
});
