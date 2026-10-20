import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { EbayAPI } from '../src/platforms/ebay_api.js';
import { Ebay } from '../src/platforms/ebay.js';
import { EbayStore } from '../src/platforms/ebay_store.js';
import { registerEbayIPC } from '../src/ebay_ipc.js';
import { resolveRuntimeProxy } from '../src/utils/runtime_proxy.js';

const config = { environment: 'sandbox', clientId: 'test-app', clientSecret: 'test-secret', refreshToken: 'test-refresh' };
const proxy = { proxyUrl: 'https://admin.example///', proxyToken: 'staff-token' };
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers });

test('only Coupang uses the runtime relay, even with legacy proxy flags', () => {
  const options = { baseUrl: proxy.proxyUrl, token: proxy.proxyToken, env: {} };
  assert.deepEqual(resolveRuntimeProxy({ ...options, platform: 'coupang' }), proxy);
  for (const platform of ['naver', 'amazon', 'ebay', 'imweb', undefined]) {
    assert.equal(resolveRuntimeProxy({ ...options, platform }), null);
    assert.equal(resolveRuntimeProxy({ ...options, platform, env: { USE_SERVER_PROXY: '1', USE_EBAY_PROXY: '1' } }), null);
  }
  assert.equal(resolveRuntimeProxy({ ...options, platform: 'coupang', env: { USE_SERVER_PROXY: '0' } }), null);
  assert.equal(resolveRuntimeProxy({ ...options, platform: 'coupang', token: null }), null);
});

test('undeployed proxy 404 identifies the admin route without retrying or falling back', async () => {
  const calls = [];
  const api = new EbayAPI(config, { proxy, fetchImpl: async (url, options) => {
    calls.push({ url, options }); return json({ detail: 'Not Found' }, 404);
  } });
  api.accessToken = 'cached'; api.expiresAt = Date.now() + 10000;
  await assert.rejects(api.request('POST', '/sell/inventory/v1/offer', {}), e => e.proxyError && e.status === 404 && /관리자 서버에 \/ebay/.test(e.message));
  assert.equal(calls.length, 1); assert.equal(calls[0].url, 'https://admin.example/ebay');
});

test('a real eBay missing inventory response retains its existing handling', async () => {
  const api = new EbayAPI(config, { proxy, fetchImpl: async () => json({ errors: [{ errorId: 25710 }] }, 404) });
  api.accessToken = 'cached'; api.expiresAt = Date.now() + 10000;
  assert.equal(await api.inventory('missing-sku'), null);
});

for (const environment of ['sandbox', 'production']) {
  test(`${environment}: OAuth stays direct and signed API envelope uses the server`, async () => {
    const calls = [];
    const api = new EbayAPI({ ...config, environment }, { proxy, fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return url.endsWith('/token') ? json({ access_token: 'ebay-token', expires_in: 7200 }) : new Response(null, { status: 204 });
    } });
    const body = { product: { title: '유리' } };
    await api.request('PUT', '/sell/inventory/v1/inventory_item/sku%2F1', body);
    const base = environment === 'sandbox' ? 'https://api.sandbox.ebay.com' : 'https://api.ebay.com';
    assert.equal(calls[0].url, `${base}/identity/v1/oauth2/token`);
    assert.match(calls[0].options.headers.Authorization, /^Basic /);
    assert.equal(calls[1].url, 'https://admin.example/ebay');
    assert.equal(calls[1].options.method, 'POST');
    assert.equal(calls[1].options.redirect, 'error');
    assert.equal(calls[1].options.headers.Authorization, 'Bearer staff-token');
    const envelope = JSON.parse(calls[1].options.body);
    assert.equal(envelope.method, 'PUT');
    assert.equal(envelope.url, `${base}/sell/inventory/v1/inventory_item/sku%2F1`);
    assert.equal(envelope.headers.Authorization, 'Bearer ebay-token');
    assert.equal(envelope.body, JSON.stringify(body));
    for (const secret of ['staff-token', 'test-secret', 'test-refresh']) assert.ok(!calls[1].options.body.includes(secret));
  });
}

test('proxy authentication and gateway failures never refresh OAuth, retry writes, or fall back direct', async () => {
  for (const status of [401, 502, 504]) {
    const calls = [];
    const api = new EbayAPI(config, { proxy, fetchImpl: async (url, options) => {
      calls.push({ url, options }); return json({ proxyError: true, message: 'proxy failure' }, status);
    } });
    api.accessToken = 'cached'; api.expiresAt = Date.now() + 10000;
    await assert.rejects(api.request('POST', '/sell/inventory/v1/offer', {}), e => e.proxyError && e.status === status && /proxy failure/.test(e.message));
    assert.equal(calls.length, 1); assert.equal(calls[0].url, 'https://admin.example/ebay');
  }
});

test('missing staff token fails before network access', async () => {
  const api = new EbayAPI(config, { proxy: { proxyUrl: proxy.proxyUrl }, fetchImpl: () => assert.fail('must not call network') });
  await assert.rejects(api.request('GET', '/sell/inventory/v1/offer'), /다시 로그인/);
});

test('upstream eBay 401 refreshes OAuth once through the proxied flow', async () => {
  let tokens = 0, reads = 0;
  const api = new EbayAPI(config, { proxy, fetchImpl: async url => {
    if (url.endsWith('/token')) return json({ access_token: `ebay-${++tokens}`, expires_in: 7200 });
    return ++reads === 1 ? json({ errors: [] }, 401) : json({ ok: true });
  } });
  assert.deepEqual(await api.request('GET', '/sell/inventory/v1/offer'), { ok: true });
  assert.equal(tokens, 2); assert.equal(reads, 2);
});

test('proxied GET throttling retries but a write failure is sent once', async () => {
  let reads = 0, writes = 0, sleeps = 0;
  const api = new EbayAPI(config, { proxy, sleep: async () => { sleeps++; }, fetchImpl: async (url, options) => {
    if (url.endsWith('/token')) return json({ access_token: 'token', expires_in: 7200 });
    const request = JSON.parse(options.body);
    if (request.method === 'GET') return ++reads < 3 ? json({}, 429, { 'retry-after': '1' }) : json({ ok: true });
    writes++; return json({ errors: [{ errorId: 1, message: 'Unavailable' }] }, 503);
  } });
  await api.request('GET', '/sell/inventory/v1/offer');
  await assert.rejects(api.request('POST', '/sell/inventory/v1/offer', {}), /Unavailable/);
  assert.equal(reads, 3); assert.equal(sleeps, 2); assert.equal(writes, 1);
});

test('service refreshes the API when the runtime staff session changes without changing stored config', () => {
  const stored = structuredClone(config);
  const service = new Ebay({ config: () => stored });
  const direct = service.client().api;
  service.runtimeProxy = proxy;
  const first = service.client().api;
  assert.notEqual(first, direct); assert.equal(first.proxyToken, proxy.proxyToken);
  assert.equal(service.client().api, first);
  service.runtimeProxy = { ...proxy, proxyToken: 'new-staff' };
  assert.equal(service.client().api.proxyToken, 'new-staff');
  service.runtimeProxy = null;
  assert.equal(service.client().api.proxyUrl, '');
  assert.deepEqual(stored, config);
});

test('logged-in IPC keeps eBay direct across legacy flags and staff token renewal', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'veryup-ebay-proxy-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const safeStorage = { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s), decryptString: b => b.toString() };
  const store = new EbayStore(directory, safeStorage); store.save(config);
  const savedConfig = fs.readFileSync(store.configPath, 'utf8');
  let runtime = proxy;
  const env = {};
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.endsWith('/token')) return json({ access_token: 'token', expires_in: 7200 });
    requests.push({ url, options }); return json({ inventoryItems: [], locations: [] });
  });
  const handlers = {}, uiDirectory = path.resolve('src/ui');
  registerEbayIPC({ app: { getPath: () => directory }, ipcMain: { handle: (name, fn) => { handlers[name] = fn; } }, safeStorage, shell: {}, uiDirectory,
    getRuntimeProxy: () => resolveRuntimeProxy({ platform: 'ebay', baseUrl: runtime.proxyUrl, token: runtime.proxyToken, env }) });
  const event = { senderFrame: { url: pathToFileURL(path.join(uiDirectory, 'index.html')).href } };
  // Reproduce the user's policy/location lookup with a stored Refresh Token.
  assert.equal((await handlers['ebay-settings'](event)).success, true);
  assert.equal(requests.length, 4);
  assert.ok(requests.every(r => r.url.startsWith('https://api.sandbox.ebay.com/') && r.options.headers.Authorization === 'Bearer token'));
  requests.length = 0;
  env.USE_EBAY_PROXY = '1';
  assert.equal((await handlers['ebay-search-products'](event, {})).success, true);
  runtime = { ...proxy, proxyToken: 'renewed-staff' };
  assert.equal((await handlers['ebay-search-products'](event, {})).success, true);
  assert.deepEqual(requests.map(r => r.options.headers.Authorization), ['Bearer token', 'Bearer token']);
  assert.ok(requests.every(r => r.url.startsWith('https://api.sandbox.ebay.com/')));
  assert.equal(fs.readFileSync(store.configPath, 'utf8'), savedConfig);
  assert.ok(!fs.readFileSync(store.configPath, 'utf8').includes('staff'));
});
