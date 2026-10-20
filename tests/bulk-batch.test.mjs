import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBulkBatch } from '../src/bulk_batch.js';
import { updateEbayPricesBatch } from '../src/platforms/ebay_bulk_prices.js';
import { registerBulkPriceIPC } from '../src/bulk_price_ipc.js';
import { createBulkImageService, productImageState } from '../src/bulk_image_service.js';
import { Amazon, JP_MARKETPLACE_ID as JP } from '../src/platforms/amazon.js';
import { apiError, markPreSend } from '../src/utils/api_error.js';
const job = id => ({ type: 'price', id: String(id), newPrice: '110', expectedPrice: '100' });
const input = (jobs, scope = 'naver', jobId = 'batch-test-001') => ({ jobId, scope, jobs });
const accepted = j => ({ success: true, data: { status: 'ACCEPTED', price: j.newPrice } });
function temp(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bulk-batch-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }

test('all input is validated before any write; normalized duplicate identities fail before sending', async () => {
  let writes = 0;
  const batch = createBulkBatch({ validate: j => { if (j.id === 'bad') throw new Error('invalid'); }, save: () => { writes++; } });
  await assert.rejects(batch.run(input([job(1), job('bad')])), /invalid/);
  await assert.rejects(batch.run(input([job(1), job(' 1 ')])), /중복/);
  assert.equal(writes, 0);
});
test('51 eBay prices use 25/25/1 requests and replay after restart cannot write twice', async t => {
  const directory = temp(t), groups = [], events = [];
  const options = { directory, validate() {}, save: () => assert.fail('native batch required'),
    savePrices: jobs => { groups.push(jobs.length); return jobs.map(accepted); } };
  const batch = createBulkBatch(options), request = input(Array.from({ length: 51 }, (_, i) => job(i)), 'ebay');
  const first = await batch.run(request, event => events.push(event));
  assert.deepEqual(groups, [25, 25, 1]); assert.equal(first.results.length, 51);
  assert.equal(events.filter(e => e.result).length, 51);
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'bulk_changes', request.jobId + '.json'))).status, 'DONE');
  const resumed = await createBulkBatch(options).run(request);
  assert.equal(resumed.results.length, 51); assert.deepEqual(groups, [25, 25, 1]);
  await assert.rejects(batch.run({ ...request, jobs: [job('different')] }), /다른 변경/);
});
test('unknown writes stop the rest; definite pre-send price failures can continue', async () => {
  const seen = [];
  const batch = createBulkBatch({ validate() {}, save: async j => {
    seen.push(j.id);
    if (j.id === '1') throw markPreSend(new Error('changed'));
    if (j.id === '2') throw Object.assign(new Error('timeout'), { sent: true });
    assert.fail('must not send after unknown');
  } });
  const result = await batch.run(input([job(1), job(2), job(3)]));
  assert.deepEqual(seen, ['1', '2']); assert.ok(result.stopped);
  assert.deepEqual(result.results.map(r => r.stage), ['pre-send', 'unknown']);
});
test('cancellation finishes only the in-flight operation; preparation cancellation sends nothing', async () => {
  let batch, sent = 0;
  batch = createBulkBatch({ validate() {}, save: j => { sent++; batch.cancel('batch-test-001'); return accepted(j).data; } });
  assert.equal((await batch.run(input([job(1), job(2)]))).cancelled, true); assert.equal(sent, 1);
  batch = createBulkBatch({ validate() { batch.cancel('batch-test-001'); }, save() { assert.fail('cancelled'); } });
  assert.equal((await batch.run(input([job(1)]))).results.length, 0);
});
test('running job journal blocks resubmission after an interrupted process', async t => {
  const directory = temp(t);
  const batch = createBulkBatch({ directory, validate() {}, save: j => accepted(j).data });
  const request = input([job(1)]); await batch.run(request);
  const file = path.join(directory, 'bulk_changes', request.jobId + '.json');
  const saved = JSON.parse(fs.readFileSync(file)); saved.status = 'RUNNING'; fs.writeFileSync(file, JSON.stringify(saved));
  const restarted = createBulkBatch({ directory, validate() {}, save() { assert.fail('must not retry'); } });
  await assert.rejects(restarted.run(request), /이미 전송/);
});

function ebayFixture({ current = {}, reply, fail } = {}) {
  const calls = [], updates = [];
  const api = {
    async offers(sku) { calls.push(['offers', sku]); if (fail) throw fail;
      return [{ offerId: 'offer-' + sku, marketplaceId: 'EBAY_US', status: 'PUBLISHED', pricingSummary: { price: { currency: 'USD', value: current[sku] ?? '100' } } }]; },
    async request(method, route, body) { calls.push(['write', method, route, body]);
      return reply ? reply(body) : { responses: body.requests.map(r => ({ sku: r.sku, offerId: r.offers[0].offerId, statusCode: 200 })).reverse() }; },
  };
  return { api, store: { updateCachedListing: (...args) => updates.push(args) }, calls, updates };
}
test('native eBay: one request for 25 prices; no inventory read, quantity, or response-order assumption', async () => {
  const f = ebayFixture(), jobs = Array.from({ length: 25 }, (_, i) => job(i));
  const results = await updateEbayPricesBatch(f, jobs);
  assert.equal(f.calls.filter(c => c[0] === 'offers').length, 25);
  assert.equal(f.calls.filter(c => c[0] === 'write').length, 1);
  const body = f.calls.find(c => c[0] === 'write')[3];
  assert.equal(body.requests.length, 25); assert.ok(!JSON.stringify(body).includes('quantity'));
  assert.equal(results.filter(r => r.success).length, 25); assert.equal(f.updates.length, 25);
});
test('eBay detects changed prices before sending; partial rejection and missing results remain distinct', async () => {
  const f = ebayFixture({ current: { '1': '101' }, reply: body => ({ responses: [
    { sku: '2', offerId: 'offer-2', statusCode: 422, errors: [{ message: 'rejected' }] },
    { sku: '4', offerId: 'offer-4', statusCode: 200 },
  ] }) });
  const r = await updateEbayPricesBatch(f, [job(1), job(2), job(3), job(4)]);
  assert.equal(r[0].stage, 'pre-send'); assert.equal(r[1].stage, 'rejected'); assert.equal(r[2].stage, 'unknown'); assert.equal(r[3].success, true);
  assert.deepEqual(f.calls.find(c => c[0] === 'write')[3].requests.map(r => r.sku), ['2', '3', '4']);
  assert.deepEqual(f.updates.map(x => x[0]), ['4']);
});
test('eBay authentication failure never reaches upload; malformed result is unknown', async () => {
  const f = ebayFixture({ fail: apiError('unauthorized', { status: 401 }) });
  await assert.rejects(updateEbayPricesBatch(f, [job(1)]), /unauthorized/);
  assert.equal(f.calls.some(c => c[0] === 'write'), false);
  const bad = ebayFixture({ reply: () => ({ responses: [{ sku: '1', offerId: 'offer-1', statusCode: null }] }) });
  assert.equal((await updateEbayPricesBatch(bad, [job(1)]))[0].stage, 'unknown');
  const malformed = ebayFixture({ reply: () => ({ responses: {} }) });
  assert.equal((await updateEbayPricesBatch(malformed, [job(1)]))[0].stage, 'unknown');
});
test('shared ESM URLs are inspected once per batch, but checked again in the next batch', async () => {
  let inspections = 0;
  const images = createBulkImageService({ inspect: async () => { inspections++; return true; } });
  const batch = createBulkBatch({ validate: (j, options) => images.validate(j, options), save: async (j, options) => {
    await images.validate(j, options); return { status: 'VERIFIED' };
  } });
  const jobs = [1, 2, 3].map(id => ({ type: 'images', id: String(id), urls: ['https://ai.esmplus.com/shared.jpg'] }));
  await batch.run(input(jobs)); assert.equal(inspections, 1);
  await batch.run(input(jobs, 'naver', 'batch-test-002')); assert.equal(inspections, 2);
});

function ipcFixture(services = {}) {
  const handlers = {};
  registerBulkPriceIPC({ ipcMain: { handle: (c, f) => { handlers[c] = f; } },
    amazon: () => services.amazon, naverProducts: () => services.naver, coupang: () => services.coupang, ebay: () => services.ebay,
    imwebBulk: services.imwebBulk, readCatalog: async () => ({}), log: { error() {} }, sleep: async () => {} });
  return (c, args) => handlers[c](null, args);
}
test('combined product load returns image revision without a second product lookup on each supported mall', async () => {
  for (const scope of ['naver', 'amazon-us', 'amazon-jp', 'ebay', 'coupang']) {
    let lookups = 0;
    const image = 'https://example.test/image.jpg';
    const product = { title: 'item', salePrice: 100, originNo: '1', price: 100, mainImageUrl: image,
      detailImages: [{ url: image }], imageContents: [[1, []]], options: [{ vendorItemId: 1 }],
      inventory: { product: { title: 'item', imageUrls: [image] } },
      offer: { status: 'PUBLISHED', pricingSummary: { price: { currency: 'USD', value: '100' } } } };
    const service = { loadConfig() {}, loadProductForEdit: async () => { lookups++; return product; },
      load: async () => { lookups++; return product; }, api: { getItemInventory: async () => ({ salePrice: 100 }) } };
    const invoke = ipcFixture({ naver: service, amazon: service, ebay: service, coupang: service });
    const result = await invoke('bulk-price-load', { scope, id: '1', includeImages: true });
    assert.equal(result.success, true, scope); assert.equal(lookups, 1, scope);
    assert.equal(result.data[0].imagesReady, true, scope);
    assert.equal(result.data[0].imageRevision, productImageState(scope, product).imageRevision, scope);
  }
});
test('batch IPC saves Imweb prices through the Open API adapter (no longer catalog-only)', async () => {
  for (const scope of ['imweb-en', 'imweb-ko', 'imweb-jp', 'imweb-b2b']) {
    let price = 100;
    const writes = [];
    const imwebBulk = {
      writePrice: async ({ scope: s, id, optionId, price: next, expected }) => { writes.push([s, id, optionId, next, expected]); price = Number(next); return {}; },
      currentPrice: async () => price,
    };
    const invoke = ipcFixture({ imwebBulk });
    const result = await invoke('bulk-save-batch', input([job(1)], scope));
    assert.equal(result.success, true, scope + ' ' + result.error);
    assert.equal(writes.length, 1, scope);
    assert.equal(writes[0][0], scope);
  }
});
test('Amazon price update does one latest GET + PATCH, and rejects a conflicting expected price', async () => {
  let reads = 0, writes = 0;
  const service = new Amazon('unused'); service.config = { marketplaceId: JP }; service.api = {};
  service._writeDebug = () => {};
  service.apiForMarketplace = () => ({
    getListingItem: async () => { reads++; return { attributes: { purchasable_offer: [{ marketplace_id: JP, currency: 'JPY', our_price: [{ schedule: [{ value_with_tax: 10000 }] }] }] }, summaries: [{ marketplaceId: JP, productType: 'AUTO_PART' }] }; },
    patchListingItem: async () => { writes++; return { status: 'ACCEPTED' }; },
  });
  const result = await service.updateExistingProduct({ sku: 'SKU', marketplaceId: JP, price: '11000', expectedPrice: '10000' });
  assert.equal(result.status, 'ACCEPTED'); assert.deepEqual([reads, writes], [1, 1]);
  await assert.rejects(service.updateExistingProduct({ sku: 'SKU', marketplaceId: JP, price: '11000', expectedPrice: '9000' }), /변경/);
  assert.equal(writes, 1);
  await service.updateExistingProduct({ sku: 'SKU', marketplaceId: JP, price: '10000', expectedPrice: '10000', title: 'new title' });
  assert.equal(writes, 2, 'same price must not suppress another requested field');
});
