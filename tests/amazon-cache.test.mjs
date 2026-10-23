import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { Amazon, parseListingsReport, LISTINGS_REPORT_TYPE } from '../src/platforms/amazon.js';
import { AmazonStore } from '../src/platforms/amazon_store.js';

const MP = 'ATVPDKIKX0DER';
const SELLER = 'A1B2C3D4E5F6G';
const config = {
  sellerId: SELLER, clientId: 'app', clientSecret: 'secret', refreshToken: 'refresh',
  marketplaceId: MP, endpoint: 'https://sellingpartnerapi-na.amazon.com'
};

const TAB = '\t';
const row = (...cells) => cells.join(TAB);

function tmpDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Amazon + AmazonStore 를 실제 파일 위에 올리고 fetch 를 가로챈다. */
function setup(t, handler) {
  const dir = tmpDir(t, 'amazon-cache-');
  const file = path.join(dir, 'amazon.json');
  fs.writeFileSync(file, JSON.stringify(config));
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    if (String(url).includes('api.amazon.com/auth')) {
      return new Response(JSON.stringify({ access_token: 'access', expires_in: 3600 }), { status: 200 });
    }
    const call = { url: String(url), method: options.method || 'GET' };
    calls.push(call);
    return handler(call);
  });
  const store = new AmazonStore(dir);
  // 수정이 남긴 쓰기(1초 뒤)가 지운 임시 폴더를 다시 만들지 않게 타이머까지 거둔다.
  t.after(() => store.clearListingsCache());
  const amazon = new Amazon(file, store);
  amazon.loadConfig();
  return { amazon, store, calls, dir };
}

const ok = body => new Response(JSON.stringify(body), { status: 200 });

test('AmazonStore 는 캐시를 저장·조회·수정·삭제한다', async t => {
  const store = new AmazonStore(tmpDir(t, 'amazon-store-'));
  assert.equal(store.listingsCache(MP), null);

  store.saveListingsCache({
    updatedAt: 'now', sellerId: SELLER, marketplaceId: MP, total: 2,
    items: [
      { id: 'SKU-1', name: 'A', price: '10', stock: '5', description: '', brand: '', asin: 'ASIN-1' },
      { id: 'SKU-2', name: 'B', price: '20', stock: '0', description: '', brand: '', asin: 'ASIN-2' }
    ]
  });
  assert.equal(store.listingsCache(MP).items.length, 2);

  // 숫자를 넘겨도 문자열로 저장한다 — UI 행 형태가 어긋나지 않도록.
  store.updateCachedListing('SKU-1', { price: 99, stock: 3 }, MP);
  const after = store.listingsCache(MP).items.find(i => i.id === 'SKU-1');
  assert.equal(after.price, '99');
  assert.equal(after.stock, '3');
  assert.equal(store.listingsCache(MP).items.find(i => i.id === 'SKU-2').price, '20');

  store.clearListingsCache();
  assert.equal(store.listingsCache(MP), null);
});

test('AmazonStore 는 손상된 캐시 파일을 없는 것으로 취급한다', async t => {
  const dir = tmpDir(t, 'amazon-store-bad-');
  const store = new AmazonStore(dir);
  fs.writeFileSync(path.join(dir, `amazon_listings_cache_${MP}.json`), '{ 잘린 JSON');
  assert.equal(store.listingsCache(MP), null);
});

test('캐시는 마켓마다 따로다 — 일본을 저장해도 미국 캐시가 남는다', async t => {
  const JP = 'A1VC38T7YXB528';
  const store = new AmazonStore(tmpDir(t, 'amazon-store-mp-'));
  store.saveListingsCache({ sellerId: SELLER, marketplaceId: MP, total: 1, items: [{ id: 'US-1', price: '10' }] });
  store.saveListingsCache({ sellerId: SELLER, marketplaceId: JP, total: 1, items: [{ id: 'JP-1', price: '1200' }] });
  assert.equal(store.listingsCache(MP).items[0].id, 'US-1');
  assert.equal(store.listingsCache(JP).items[0].id, 'JP-1');

  store.updateCachedListing('US-1', { price: 99 }, JP);   // 일본 파일에는 없는 SKU — 미국 행을 건드리면 안 된다
  assert.equal(store.listingsCache(MP).items[0].price, '10');

  store.clearListingsCache();
  assert.equal(store.listingsCache(MP), null);
  assert.equal(store.listingsCache(JP), null);
  assert.throws(() => store.saveListingsCache({ marketplaceId: '../x', items: [] }), /마켓플레이스 ID/);
});

test('예전 한 파일짜리 캐시는 그 안의 마켓 파일로 옮긴다', async t => {
  const dir = tmpDir(t, 'amazon-store-legacy-');
  const legacy = path.join(dir, 'amazon_listings_cache.json');
  fs.writeFileSync(legacy, JSON.stringify({ sellerId: SELLER, marketplaceId: MP, total: 1, items: [{ id: 'OLD' }] }));
  const store = new AmazonStore(dir);
  assert.equal(store.listingsCache(MP).items[0].id, 'OLD');
  assert.equal(fs.existsSync(legacy), false);
});

test('parseListingsReport 는 헤더 이름으로 열을 찾고 brand 열이 없어도 동작한다', () => {
  const text = [
    row('item-name', 'item-description', 'listing-id', 'seller-sku', 'price', 'quantity', 'asin1'),
    row('Mirror Glass', '설명입니다', '0123', 'OGBM22', '39.99', '7', 'B00AAA'),
    row('Other Glass', '', '0124', 'OBM2210N121', '12.50', '0', 'B00BBB'),
    ''                                   // 리포트 끝의 빈 줄
  ].join('\n');

  const rows = parseListingsReport(text);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    id: 'OGBM22', name: 'Mirror Glass', price: '39.99', stock: '7',
    description: '설명입니다', brand: '', asin: 'B00AAA'
  });
  // 재고 0 은 빈 값이 아니라 '0' 으로 남아야 한다.
  assert.equal(rows[1].stock, '0');
});

test('parseListingsReport 는 열 순서가 달라도 같은 결과를 낸다', () => {
  const text = [
    row('quantity', 'seller-sku', 'asin1', 'item-name', 'price'),
    row('4', 'SKU-Z', 'B00ZZZ', 'Zed', '1.00')
  ].join('\r\n');   // CRLF 리포트
  assert.deepEqual(parseListingsReport(text)[0], {
    id: 'SKU-Z', name: 'Zed', price: '1.00', stock: '4',
    description: '', brand: '', asin: 'B00ZZZ'
  });
});

test('parseListingsReport 는 seller-sku 열이 없으면 조용히 빈 결과를 내지 않고 실패한다', () => {
  assert.throws(() => parseListingsReport(row('item-name', 'price')), /seller-sku/);
  assert.deepEqual(parseListingsReport(''), []);
});

test('캐시가 있으면 searchProducts 는 아마존을 전혀 호출하지 않는다', async t => {
  const { amazon, store, calls } = setup(t, () => { throw new Error('네트워크를 쓰면 안 된다'); });
  store.saveListingsCache({
    updatedAt: '2026-09-18T11:00:00.000Z', sellerId: SELLER, marketplaceId: MP, total: 3,
    items: [
      { id: 'OGBM22', name: 'Hyundai Mirror', price: '10', stock: '1', description: '', brand: 'Optic', asin: 'A1' },
      { id: 'OBM2210N121', name: 'Ford Glass', price: '20', stock: '2', description: '', brand: 'Optic', asin: 'A2' },
      { id: 'X-1', name: 'Unrelated', price: '30', stock: '3', description: '', brand: 'Other', asin: 'A3' }
    ]
  });

  const stats = {};
  const all = await amazon.searchProducts({}, stats);
  assert.equal(all.length, 3);
  assert.equal(stats.source, 'cache');
  assert.equal(stats.scanned, 3);
  assert.equal(stats.updatedAt, '2026-09-18T11:00:00.000Z');

  const hits = await amazon.searchProducts({ searchText: 'hyundai mirror' });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, 'OGBM22');

  // 라이브 경로와 같은 7개 필드여야 한다.
  assert.deepEqual(Object.keys(hits[0]).sort(),
    ['asin', 'brand', 'description', 'id', 'name', 'price', 'stock']);

  assert.equal(calls.length, 0, '캐시 적중 시 API 호출은 0건');
});

test('판매자나 마켓플레이스가 다른 캐시는 무시하고 API 로 간다', async t => {
  const { amazon, store, calls } = setup(t, () => ok({ items: [], numberOfResults: 0 }));

  store.saveListingsCache({
    updatedAt: 'now', sellerId: 'A9OTHERSELLER', marketplaceId: MP, total: 1,
    items: [{ id: 'FOREIGN', name: '남의 계정', price: '', stock: '', description: '', brand: '', asin: '' }]
  });
  assert.equal((await amazon.searchProducts({})).length, 0);
  assert.ok(calls.length > 0, '판매자가 다르면 캐시를 쓰지 않는다');

  calls.length = 0;
  store.saveListingsCache({
    updatedAt: 'now', sellerId: SELLER, marketplaceId: 'A1VC38T7YXB528', total: 1,
    items: [{ id: 'JP-1', name: '일본 마켓', price: '', stock: '', description: '', brand: '', asin: '' }]
  });
  assert.equal((await amazon.searchProducts({})).length, 0);
  assert.ok(calls.length > 0, '마켓플레이스가 다르면 캐시를 쓰지 않는다');
});

test('페이징이 1000건에서 잘리면 stats.truncated 로 알린다', async t => {
  // 아마존이 numberOfResults 로 1386 을 보고하면서 nextToken 을 조용히 끊는 상황을 재현한다.
  let page = 0;
  const { amazon } = setup(t, () => {
    page++;
    const items = [{ sku: `SKU-${page}`, summaries: [{ marketplaceId: MP, itemName: `상품 ${page}` }], attributes: {} }];
    return ok({ numberOfResults: 1386, items, pagination: page < 3 ? { nextToken: `t${page}` } : undefined });
  });

  const stats = {};
  await amazon.searchProducts({}, stats);
  assert.equal(stats.source, 'api');
  assert.equal(stats.total, 1386);
  assert.equal(stats.scanned, 3);
  assert.equal(stats.truncated, true);
});

test('refreshListingsCache 는 리포트를 생성·폴링·내려받아 캐시에 저장한다', async t => {
  const tsv = [
    row('item-name', 'item-description', 'seller-sku', 'price', 'quantity', 'asin1'),
    row('Mirror A', 'desc A', 'OGBM22', '39.99', '7', 'B00AAA'),
    row('Mirror B', 'desc B', 'OBM2210N121', '12.50', '0', 'B00BBB')
  ].join('\n');

  let polls = 0;
  const { amazon, store, calls } = setup(t, call => {
    if (call.method === 'POST' && call.url.includes('/reports/2021-06-30/reports')) {
      return ok({ reportId: 'R1' });
    }
    if (call.url.includes('/reports/2021-06-30/reports/R1')) {
      polls++;
      return polls < 2 ? ok({ processingStatus: 'IN_PROGRESS' })
                       : ok({ processingStatus: 'DONE', reportDocumentId: 'D1' });
    }
    if (call.url.includes('/reports/2021-06-30/documents/D1')) {
      return ok({ url: 'https://s3.example.com/report.gz', compressionAlgorithm: 'GZIP' });
    }
    if (call.url.startsWith('https://s3.example.com/')) {
      return new Response(gzipSync(Buffer.from(tsv, 'utf8')), { status: 200 });
    }
    throw new Error('예상 밖 호출: ' + call.url);
  });

  const progress = [];
  const result = await amazon.refreshListingsCache({
    pollIntervalMs: 1, onProgress: p => progress.push(p.stage)
  });

  assert.equal(result.total, 2);
  assert.ok(result.updatedAt);
  assert.ok(progress.includes('create') && progress.includes('wait') && progress.includes('done'));

  const cache = store.listingsCache(MP);
  assert.equal(cache.sellerId, SELLER);
  assert.equal(cache.marketplaceId, MP);
  assert.equal(cache.items.length, 2);
  assert.equal(cache.items[0].id, 'OGBM22');

  // 요청한 리포트 종류가 맞는지 — 다른 리포트면 열 구성이 달라진다.
  const created = calls.find(c => c.method === 'POST');
  assert.ok(created, '리포트 생성 호출이 있어야 한다');
  assert.equal(LISTINGS_REPORT_TYPE, 'GET_MERCHANT_LISTINGS_ALL_DATA');

  // 저장 직후에는 캐시로 응답한다.
  calls.length = 0;
  assert.equal((await amazon.searchProducts({})).length, 2);
  assert.equal(calls.length, 0);
});

// 리포트 흐름을 흉내내는 공통 핸들러. listings 호출은 caller 가 처리한다.
function reportHandler(tsv, onListings) {
  return call => {
    if (call.method === 'POST' && call.url.includes('/reports/2021-06-30/reports')) return ok({ reportId: 'R1' });
    if (call.url.includes('/reports/2021-06-30/reports/R1')) return ok({ processingStatus: 'DONE', reportDocumentId: 'D1' });
    if (call.url.includes('/reports/2021-06-30/documents/D1')) return ok({ url: 'https://s3.example.com/r.gz', compressionAlgorithm: 'GZIP' });
    if (call.url.startsWith('https://s3.example.com/')) return new Response(gzipSync(Buffer.from(tsv, 'utf8')), { status: 200 });
    if (call.url.includes('/listings/2021-08-01/items/')) return onListings(call);
    throw new Error('예상 밖 호출: ' + call.url);
  };
}

const REPORT_TSV = [
  row('item-name', 'seller-sku', 'price', 'quantity', 'asin1'),
  row('Mirror A', 'SKU-A', '39.99', '7', 'B00AAA'),
  row('Mirror B', 'SKU-B', '12.50', '0', 'B00BBB')
].join('\n');

test('enrichBrand 는 리포트에 없는 브랜드를 identifiers 묶음으로 채운다', async t => {
  const { amazon, store, calls } = setup(t, reportHandler(REPORT_TSV, call => {
    const ids = new URL(call.url).searchParams.get('identifiers').split(',');
    return ok({ items: ids.map(sku => ({
      sku,
      summaries: [{ marketplaceId: MP, itemName: `이름 ${sku}` }],
      attributes: { brand: [{ value: 'Optic Glass', marketplace_id: MP }] }
    })) });
  }));

  const stages = [];
  const result = await amazon.refreshListingsCache({
    pollIntervalMs: 1, onProgress: p => stages.push(p.stage)
  });

  assert.equal(result.total, 2);
  assert.equal(result.enriched, 2);
  assert.equal(result.enrichError, null);
  assert.ok(stages.includes('enrich'), '보강 단계를 진행상황으로 알린다');

  const items = store.listingsCache(MP).items;
  assert.equal(items.find(i => i.id === 'SKU-A').brand, 'Optic Glass');
  // 리포트에서 온 값은 덮어쓰지 않는다.
  assert.equal(items.find(i => i.id === 'SKU-A').price, '39.99');
  assert.equal(items.find(i => i.id === 'SKU-B').stock, '0');

  const idCalls = calls.filter(c => c.url.includes('identifiers='));
  assert.equal(idCalls.length, 1, '2건이면 한 묶음으로 끝난다');
  assert.equal(new URL(idCalls[0].url).searchParams.get('identifiersType'), 'SKU');
});

test('enrichBrand:false 면 추가 호출 없이 리포트 결과만 저장한다', async t => {
  const { amazon, store, calls } = setup(t, reportHandler(REPORT_TSV, () => {
    throw new Error('보강을 끄면 listings 를 부르면 안 된다');
  }));
  const result = await amazon.refreshListingsCache({ pollIntervalMs: 1, enrichBrand: false });
  assert.equal(result.total, 2);
  assert.equal(result.enriched, 0);
  assert.equal(store.listingsCache(MP).items[0].brand, '');
  assert.equal(calls.filter(c => c.url.includes('identifiers=')).length, 0);
});

test('보강이 실패해도 리포트 스냅샷은 저장한다', async t => {
  const { amazon, store } = setup(t, reportHandler(REPORT_TSV, () => {
    return new Response(JSON.stringify({ errors: [{ code: 'QuotaExceeded', message: '너무 잦은 요청' }] }), { status: 429 });
  }));

  const stages = [];
  const result = await amazon.refreshListingsCache({
    pollIntervalMs: 1, onProgress: p => stages.push(p.stage)
  });

  // 수십 초 걸린 리포트 결과를 보강 실패 때문에 통째로 버리면 안 된다.
  assert.equal(result.total, 2);
  assert.equal(result.enriched, 0);
  assert.match(result.enrichError, /QuotaExceeded|429|너무 잦은/);
  assert.ok(stages.includes('enrich-failed'));
  assert.equal(store.listingsCache(MP).items.length, 2);
  assert.equal(store.listingsCache(MP).items[0].name, 'Mirror A');
});

test('refreshListingsCache 는 아마존이 리포트를 실패시키면 그대로 알린다', async t => {
  const { amazon, store } = setup(t, call => {
    if (call.method === 'POST') return ok({ reportId: 'R1' });
    return ok({ processingStatus: 'FATAL' });
  });
  await assert.rejects(() => amazon.refreshListingsCache({ pollIntervalMs: 1 }), /FATAL/);
  assert.equal(store.listingsCache(MP), null, '실패 시 캐시를 쓰지 않는다');
});

// searchProducts 가 캐시를 먼저 보기 때문에, 수정 후 캐시를 안 고치면
// 목록에 계속 옛 값이 보인다. 전체 동기화는 수 분이 걸려 매번 돌릴 수 없다.
test('상품을 수정하면 캐시 행도 같이 고쳐진다', async t => {
  const { amazon, store } = setup(t, call => {
    if (call.method === 'GET') {
      return ok({ sku: 'SKU-A', summaries: [{ marketplaceId: MP, itemName: '옛 이름', productType: 'AUTO_PART' }],
                  attributes: { item_name: [{ value: '옛 이름', marketplace_id: MP }] } });
    }
    return ok({ sku: 'SKU-A', status: 'ACCEPTED' });
  });
  store.saveListingsCache({
    updatedAt: 'now', sellerId: SELLER, marketplaceId: MP, total: 1,
    items: [{ id: 'SKU-A', name: '옛 이름', price: '10', stock: '1', description: '', brand: '', asin: 'A1' }]
  });

  await amazon.updateExistingProduct({ sku: 'SKU-A', title: '새 이름', price: '99', stock: '7' });

  const row = store.listingsCache(MP).items.find(i => i.id === 'SKU-A');
  assert.equal(row.name, '새 이름');
  assert.equal(row.price, '99');
  assert.equal(row.stock, '7');
  assert.equal(row.asin, 'A1', '건드리지 않은 필드는 그대로');
});

test('다른 계정의 캐시는 수정 후에도 건드리지 않는다', async t => {
  const { amazon, store } = setup(t, call =>
    call.method === 'GET'
      ? ok({ sku: 'SKU-A', summaries: [{ marketplaceId: MP, itemName: '옛 이름' }], attributes: {} })
      : ok({ sku: 'SKU-A', status: 'ACCEPTED' }));
  store.saveListingsCache({
    updatedAt: 'now', sellerId: 'A9OTHERSELLER', marketplaceId: MP, total: 1,
    items: [{ id: 'SKU-A', name: '남의 계정', price: '1', stock: '1', description: '', brand: '', asin: '' }]
  });

  await amazon.updateExistingProduct({ sku: 'SKU-A', title: '새 이름', price: '99' });

  assert.equal(store.listingsCache(MP).items[0].name, '남의 계정',
    '판매자가 다른 캐시는 손대면 안 된다');
});

test('refreshListings 는 SKU 를 20개씩 묶어 identifiers 로 보낸다', async t => {
  const skus = Array.from({ length: 45 }, (_, i) => `SKU-${i}`);
  const { amazon, store, calls } = setup(t, call => {
    const ids = new URL(call.url).searchParams.get('identifiers').split(',');
    return ok({ items: ids.map(sku => ({ sku, summaries: [{ marketplaceId: MP, itemName: `이름 ${sku}` }], attributes: {} })) });
  });
  store.saveListingsCache({
    updatedAt: 'now', sellerId: SELLER, marketplaceId: MP, total: 1,
    items: [{ id: 'SKU-0', name: '옛 이름', price: '', stock: '', description: '', brand: '', asin: '' }]
  });

  const rows = await amazon.refreshListings(skus);
  assert.equal(rows.length, 45);
  assert.equal(calls.length, 3, '45건이면 20+20+5 로 3회');

  const sizes = calls.map(c => new URL(c.url).searchParams.get('identifiers').split(',').length);
  assert.deepEqual(sizes.sort((a, b) => b - a), [20, 20, 5]);
  for (const call of calls) {
    assert.equal(new URL(call.url).searchParams.get('identifiersType'), 'SKU');
  }

  // 받아온 값이 캐시에 반영된다.
  assert.equal(store.listingsCache(MP).items.find(i => i.id === 'SKU-0').name, '이름 SKU-0');
});

test('searchListingsItems 는 identifiers 가 20건을 넘으면 보내기 전에 막는다', async t => {
  const { amazon } = setup(t, () => { throw new Error('호출되면 안 된다'); });
  await assert.rejects(
    () => amazon.api.searchListingsItems({ identifiers: Array.from({ length: 21 }, (_, i) => `S${i}`) }),
    /최대 20건/
  );
});

test('저장소가 없으면 캐시 기능만 꺼지고 검색은 그대로 동작한다', async t => {
  const dir = tmpDir(t, 'amazon-nostore-');
  const file = path.join(dir, 'amazon.json');
  fs.writeFileSync(file, JSON.stringify(config));
  t.mock.method(globalThis, 'fetch', async url => {
    if (String(url).includes('api.amazon.com/auth')) {
      return new Response(JSON.stringify({ access_token: 'a', expires_in: 3600 }), { status: 200 });
    }
    return ok({ numberOfResults: 1, items: [{ sku: 'S1', summaries: [{ marketplaceId: MP, itemName: 'T' }], attributes: {} }] });
  });

  const amazon = new Amazon(file);   // store 없이
  amazon.loadConfig();
  assert.equal(amazon.getCachedListings(MP), null);
  assert.equal((await amazon.searchProducts({})).length, 1);
  await assert.rejects(() => amazon.refreshListingsCache(), /캐시 저장소가 없습니다/);
});
