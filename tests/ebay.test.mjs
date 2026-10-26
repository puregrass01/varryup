import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { EbayAPI, EbayAPIError } from '../src/platforms/ebay_api.js';
import { buildEbayPayload, validateAspects, priceQuantity } from '../src/platforms/ebay_payload.js';
import { EbayStore } from '../src/platforms/ebay_store.js';
import { Ebay } from '../src/platforms/ebay.js';
import { registerEbayIPC } from '../src/ebay_ipc.js';

const config = { environment: 'sandbox', clientId: 'app', clientSecret: 'test-secret', refreshToken: 'test-refresh', ruName: 'test-runame', merchantLocationKey: 'warehouse', fulfillmentPolicyId: 'shipping', paymentPolicyId: 'payment', returnPolicyId: 'returns' };
const product = { sku: 'OG-1-L', title: 'OpticGlass Left Mirror Glass', brand: 'OpticGlass', mpn: 'OG-1', price: '59.99', quantity: '5', categoryId: '123', description: 'Mirror glass\n<script>no</script>', imageUrls: 'https://images.example.com/glass.jpg', aspects: {} };
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers });
const mockEncryption = { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(`encrypted:${s}`), decryptString: b => b.toString().slice(10) };

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'veryup-ebay-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new EbayStore(directory, mockEncryption); store.save(config);
  const remote = { inventory: null, offers: [], calls: [], behavior: null };
  const api = {
    inventory: async () => structuredClone(remote.inventory), offers: async () => structuredClone(remote.offers), aspects: async () => ({ aspects: [] }),
    async request(method, url, body) {
      remote.calls.push({ method, url, body });
      if (remote.behavior) { const intercepted = await remote.behavior(method, url, body); if (intercepted !== undefined) return intercepted; }
      if (method === 'PUT' && url.includes('inventory_item')) { remote.inventory = structuredClone(body); return {}; }
      if (method === 'POST' && url.endsWith('/offer')) { remote.offers = [{ ...structuredClone(body), offerId: 'offer-1', status: 'UNPUBLISHED' }]; return { offerId: 'offer-1' }; }
      if (url.endsWith('/publish')) { remote.offers[0].status = 'PUBLISHED'; remote.offers[0].listing = { listingId: 'listing-1' }; return { listingId: 'listing-1' }; }
      if (url.endsWith('/withdraw')) { remote.offers[0].status = 'UNPUBLISHED'; return { listingId: 'listing-1' }; }
      if (url.endsWith('bulk_update_price_quantity')) return { responses: [{ statusCode: 200 }] };
      throw new Error(`Unexpected request ${url}`);
    }
  };
  return { store, remote, api, service: new Ebay(store, () => api) };
}

test('payload is a US USD single-SKU listing and escapes description HTML', () => {
  const payload = buildEbayPayload(product, config);
  assert.equal(payload.offer.marketplaceId, 'EBAY_US'); assert.equal(payload.offer.pricingSummary.price.currency, 'USD');
  assert.equal(payload.inventory.availability.shipToLocationAvailability.quantity, 5);
  assert.equal(payload.offer.listingPolicies.fulfillmentPolicyId, 'shipping');
  assert.match(payload.offer.listingDescription, /&lt;script&gt;/); assert.deepEqual(payload.inventory.product.aspects.Brand, ['OpticGlass']);
});
test('invalid price, quantity, image, title and policy fail before any request', () => {
  for (const price of ['', '-1', '0', 'Infinity', '1.234', '1e3']) assert.throws(() => priceQuantity({ price, quantity: 1 }));
  for (const quantity of ['', '-1', '1.5', '1000000']) assert.throws(() => priceQuantity({ price: '1', quantity }));
  for (const override of [{ sku: '' }, { title: 'x'.repeat(81) }, { quantity: 0 }, { imageUrls: 'file:///secret.png' }, { imageUrls: 'http://images.example.com/a' }, { aspects: '{' }]) assert.throws(() => buildEbayPayload({ ...product, ...override }, config));
  assert.throws(() => buildEbayPayload(product, { ...config, paymentPolicyId: '' }));
});
test('brand, MPN and package measurements map to documented inventory fields', () => {
  const { inventory } = buildEbayPayload({ ...product, weightKg: '0.5', lengthCm: '20', widthCm: '15', heightCm: '5' }, config);
  assert.equal(inventory.product.brand, 'OpticGlass'); assert.equal(inventory.product.mpn, 'OG-1');
  assert.deepEqual(inventory.packageWeightAndSize.weight, { value: 0.5, unit: 'KILOGRAM' });
  assert.deepEqual(inventory.packageWeightAndSize.dimensions, { length: 20, width: 15, height: 5, unit: 'CENTIMETER' });
  assert.throws(() => buildEbayPayload({ ...product, lengthCm: '20' }, config));
  assert.throws(() => buildEbayPayload({ ...product, weightKg: '-1' }, config));
});
test('category required, cardinality and selection constraints are enforced', () => {
  const metadata = { aspects: [{ localizedAspectName: 'Color', aspectConstraint: { aspectRequired: true, aspectMode: 'SELECTION_ONLY', itemToAspectCardinality: 'SINGLE' }, aspectValues: [{ localizedValue: 'Black' }] }] };
  assert.throws(() => validateAspects({}, metadata)); assert.throws(() => validateAspects({ Color: ['Red'] }, metadata));
  assert.throws(() => validateAspects({ Color: ['Black', 'Black'] }, metadata)); validateAspects({ Color: ['Black'] }, metadata);
  assert.throws(() => validateAspects({}, {}));
});
test('secrets are encrypted, redacted, retained on blank and isolated on environment switch', t => {
  const { store } = fixture(t);
  const raw = fs.readFileSync(store.configPath, 'utf8');
  assert.ok(!raw.includes('test-secret') && !raw.includes('test-refresh'));
  assert.equal(store.publicConfig().clientSecret, undefined); assert.equal(store.publicConfig().hasRefreshToken, true);
  store.save({ clientSecret: '', refreshToken: '', merchantLocationKey: 'second' }); assert.equal(store.config().refreshToken, config.refreshToken);
  store.save({ environment: 'production' }); assert.equal(store.config().refreshToken, ''); assert.equal(store.config().clientSecret, '');
});
test('unavailable secure storage fails closed and does not rewrite credentials', t => {
  const { store } = fixture(t), original = fs.readFileSync(store.configPath, 'utf8');
  store.safeStorage = { ...mockEncryption, isEncryptionAvailable: () => false };
  assert.throws(() => store.save({ clientSecret: 'replacement' })); assert.equal(fs.readFileSync(store.configPath, 'utf8'), original);
});
test('access tokens refresh once for concurrent calls and use correct sandbox host', async () => {
  const calls = [];
  const api = new EbayAPI(config, { fetchImpl: async (url, options) => { calls.push({ url, options }); return url.includes('/token') ? json({ access_token: 'access', expires_in: 7200 }) : json({ ok: true }); } });
  await Promise.all([api.request('GET', '/first'), api.request('GET', '/second')]);
  assert.equal(calls.filter(c => c.url.includes('/token')).length, 1);
  assert.ok(calls.every(c => c.url.startsWith('https://api.sandbox.ebay.com/')));
  assert.equal(calls.find(c => c.url.endsWith('/first')).options.headers['Content-Language'], 'en-US');
});
test('401 refreshes credentials once and retries the rejected request', async () => {
  let tokens = 0, reads = 0;
  const api = new EbayAPI(config, { fetchImpl: async url => url.includes('/token') ? json({ access_token: `token-${++tokens}`, expires_in: 7200 }) : (++reads === 1 ? json({ errors: [] }, 401) : json({ ok: true })) });
  assert.deepEqual(await api.request('GET', '/test'), { ok: true }); assert.equal(tokens, 2); assert.equal(reads, 2);
});
test('read throttling retries, mutating failures do not', async () => {
  let reads = 0, writes = 0, sleeps = 0;
  const api = new EbayAPI(config, { sleep: async () => { sleeps++; }, fetchImpl: async (url, options) => {
    if (url.includes('/token')) return json({ access_token: 'access', expires_in: 7200 });
    if (options.method === 'GET') return ++reads < 3 ? json({}, 429) : json({ ok: true });
    writes++; return json({ errors: [{ errorId: 1, message: 'Unavailable' }] }, 503);
  } });
  await api.request('GET', '/test'); assert.equal(reads, 3); assert.equal(sleeps, 2);
  await assert.rejects(api.request('POST', '/test', {}), /Unavailable/); assert.equal(writes, 1);
});
test('only documented missing-resource errors are treated as absence, including HTTP 400', async () => {
  const api = new EbayAPI(config); api.request = async () => { throw new EbayAPIError(400, { errors: [{ errorId: 25710 }] }); };
  assert.equal(await api.inventory('sku'), null);
  api.request = async () => { throw new EbayAPIError(400, { errors: [{ errorId: 25713 }] }); }; assert.deepEqual(await api.offers('sku'), []);
  api.request = async () => { throw new EbayAPIError(403, { errors: [{ errorId: 7 }] }); }; await assert.rejects(api.inventory('sku')); await assert.rejects(api.offers('sku'));
});
test('create draft, recover after restart, publish and withdraw without duplicate creation', async t => {
  const { service, store, api, remote } = fixture(t);
  const draft = await service.saveDraft(product); assert.equal(draft.status, 'DRAFT');
  const restarted = new Ebay(store, () => api); await restarted.saveDraft(product);
  assert.equal(remote.calls.filter(c => c.method === 'POST' && c.url.endsWith('/offer')).length, 1);
  const published = await restarted.publish(product.sku); assert.equal(published.listingId, 'listing-1');
  await restarted.publish(product.sku); assert.equal(remote.calls.filter(c => c.url.endsWith('/publish')).length, 1);
  await restarted.withdraw(product.sku); assert.equal(remote.offers[0].status, 'UNPUBLISHED');
});
test('unknown existing inventory and published listings cannot be overwritten by new registration', async t => {
  const { service, remote } = fixture(t); remote.inventory = { product: { title: 'Existing' } };
  await assert.rejects(service.saveDraft(product), /사용 중인 SKU/); assert.equal(remote.calls.length, 0);
  remote.offers = [{ offerId: 'other', status: 'PUBLISHED' }]; await assert.rejects(service.saveDraft(product), /이미 게시된/); assert.equal(remote.calls.length, 0);
});
test('changed payload under an existing job cannot overwrite the saved draft', async t => {
  const { service, remote } = fixture(t); await service.saveDraft(product); const count = remote.calls.length;
  await assert.rejects(service.saveDraft({ ...product, price: '10' }), /SKU/); assert.equal(remote.calls.length, count);
});
test('unknown create timeout is journaled and never automatically repeated', async t => {
  const { service, remote } = fixture(t);
  remote.behavior = async (method, url) => { if (method === 'POST' && url.endsWith('/offer')) throw new Error('timeout'); };
  await assert.rejects(service.saveDraft(product), /timeout/); await assert.rejects(service.saveDraft(product), /중복 생성/);
  assert.equal(remote.calls.filter(c => c.method === 'POST').length, 1);
});
test('create timeout that succeeded remotely is recovered by SKU', async t => {
  const { service, remote } = fixture(t);
  remote.behavior = async (method, url, body) => { if (method === 'POST' && url.endsWith('/offer')) { remote.offers = [{ ...body, offerId: 'recovered', status: 'UNPUBLISHED' }]; throw new Error('timeout'); } };
  await assert.rejects(service.saveDraft(product)); assert.equal((await service.saveDraft(product)).offerId, 'recovered');
  assert.equal(remote.calls.filter(c => c.method === 'POST').length, 1);
});
test('known create rejection can be retried after resolving external configuration', async t => {
  const { service, remote } = fixture(t);
  remote.behavior = async (method, url) => { if (method === 'POST' && url.endsWith('/offer')) throw new EbayAPIError(400, { errors: [{ message: 'Invalid policy' }] }); };
  await assert.rejects(service.saveDraft(product), /Invalid policy/); remote.behavior = null;
  assert.equal((await service.saveDraft(product)).status, 'DRAFT');
});
test('unknown publish timeout cannot cause another publication request', async t => {
  const { service, remote } = fixture(t); await service.saveDraft(product);
  remote.behavior = async (method, url) => { if (url.endsWith('/publish')) throw new Error('timeout'); };
  await assert.rejects(service.publish(product.sku), /timeout/); await assert.rejects(service.publish(product.sku), /아직 확정/);
  await assert.rejects(service.saveDraft(product), /아직 확정/);
  assert.equal(remote.calls.filter(c => c.url.endsWith('/publish')).length, 1);
});
test('price update changes only the US offer and checks item-level failures', async t => {
  const { service, remote } = fixture(t); await service.saveDraft(product); await service.publish(product.sku);
  await service.updatePriceQuantity({ sku: product.sku, price: '60.00', quantity: 3 });
  const body = remote.calls.at(-1).body; assert.equal(body.requests[0].shipToLocationAvailability, undefined); assert.equal(body.requests[0].offers[0].availableQuantity, 3);
  await assert.rejects(service.updatePriceQuantity({ sku: product.sku, price: 60, quantity: 6 }), /전체 재고/);
  remote.behavior = async (m, url) => url.endsWith('bulk_update_price_quantity') ? { responses: [{ statusCode: 400, errors: [{ message: 'Price rejected' }] }] } : undefined;
  await assert.rejects(service.updatePriceQuantity({ sku: product.sku, price: 60, quantity: 3 }), /Price rejected/);
});
test('price update that eBay accepted is not reported as failed when the local cache update throws', async t => {
  const { service, store } = fixture(t); await service.saveDraft(product); await service.publish(product.sku);
  store.updateCachedListing = () => { throw new SyntaxError('broken listings cache'); };
  assert.equal((await service.updatePriceQuantity({ sku: product.sku, price: '60.00', quantity: 3 })).status, 'UPDATED');
});
test('concurrent mutations and config changes are rejected while a job is active', async t => {
  const { service, api } = fixture(t); let release; api.aspects = () => new Promise(resolve => { release = resolve; });
  const pending = service.saveDraft(product); await assert.rejects(service.saveDraft(product), /진행 중/); assert.throws(() => service.saveConfig({}), /작업 중/);
  release({ aspects: [] }); await pending;
});
test('OAuth state, expiry and account changes are validated; callback code is decoded once', async t => {
  const { service, store, api } = fixture(t); let posted;
  api.tokenRequest = async body => { posted = body; return { refresh_token: 'new-refresh' }; };
  const url = new URL(service.authorizationUrl()), state = url.searchParams.get('state');
  assert.equal(url.origin, 'https://auth.sandbox.ebay.com');
  await assert.rejects(service.completeAuthorization('https://callback.example.com?code=a&state=wrong'), /일치/);
  await service.completeAuthorization(`https://callback.example.com?code=a%2Bb&state=${state}`);
  assert.equal(posted.code, 'a+b'); assert.equal(store.config().refreshToken, 'new-refresh');
  await assert.rejects(service.completeAuthorization(`https://callback.example.com?code=a&state=${state}`));
});
test('IPC rejects non-app frames before accessing credentials', async () => {
  const handlers = {}, uiDirectory = path.resolve('src/ui');
  registerEbayIPC({ app: { getPath: () => { throw new Error('must not read'); } }, ipcMain: { handle: (name, fn) => { handlers[name] = fn; } }, safeStorage: {}, shell: {}, uiDirectory });
  const result = await handlers['ebay-load-config']({ senderFrame: { url: 'https://example.com/index.html' } });
  assert.equal(result.success, false); assert.match(result.error, /허용되지/);
  const trusted = await handlers['ebay-load-config']({ senderFrame: { url: pathToFileURL(path.join(uiDirectory, 'index.html')).href } });
  assert.equal(trusted.error, 'must not read');
  const parent = await handlers['ebay-load-config']({ senderFrame: { url: pathToFileURL(path.join(uiDirectory, 'index_up.html')).href } });
  assert.equal(parent.error, 'must not read');
});
