import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveRuntimeProxy } from '../src/utils/runtime_proxy.js';
import { NaverAPI } from '../src/platforms/naver_api.js';
import { Amazon } from '../src/platforms/amazon.js';

const runtime = platform => resolveRuntimeProxy({ platform, baseUrl: 'https://admin.example', token: 'staff', env: {} });
const json = data => new Response(JSON.stringify(data));

test('logged-in Naver sends token and product requests directly with its own bearer token', async () => {
  const calls = [];
  const api = new NaverAPI({ clientId: 'CID', clientSecret: '$2a$04$uSbYAXyKyJjPVDzRl.Ie', type: 'SELF' }, {
    proxy: runtime('naver'), bcrypt: { hashSync: () => 'signed-test' },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return json(url.endsWith('/token') ? { access_token: 'naver-token', expires_in: 10800 } : { contents: [] });
    }
  });
  await api.request('POST', '/v1/products/search', {});
  assert.deepEqual(calls.map(c => c.url), [
    'https://api.commerce.naver.com/external/v1/oauth2/token',
    'https://api.commerce.naver.com/external/v1/products/search'
  ]);
  assert.equal(calls[1].options.headers.Authorization, 'Bearer naver-token');
});

test('Amazon US and JP ignore stale stored relay settings and call SP-API directly', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-routing-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'amazon.json');
  const config = { sellerId: 'A1B2C3D4E5F6G', clientId: 'app', clientSecret: 'secret', refreshToken: 'refresh', marketplaceId: 'ATVPDKIKX0DER', endpoint: 'https://sellingpartnerapi-na.amazon.com', proxyUrl: 'https://stale.example', proxyToken: 'stale-staff' };
  fs.writeFileSync(file, JSON.stringify(config));
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    return json(url.endsWith('/token') ? { access_token: 'amazon-token', expires_in: 3600 } : { items: [] });
  });
  const amazon = new Amazon(file);
  amazon.runtimeProxy = runtime('amazon');
  amazon.loadConfig();
  for (const marketplaceId of ['ATVPDKIKX0DER', 'A1VC38T7YXB528']) {
    const api = amazon.apiForMarketplace(marketplaceId);
    assert.equal(api.proxyUrl, '');
    await api.searchListingsItems({ marketplaceId });
  }
  assert.equal(calls[0].url, 'https://api.amazon.com/auth/o2/token');
  const apiCalls = calls.filter(c => !c.url.endsWith('/token'));
  assert.deepEqual(apiCalls.map(c => new URL(c.url).hostname), ['sellingpartnerapi-na.amazon.com', 'sellingpartnerapi-fe.amazon.com']);
  assert.ok(apiCalls.every(c => c.options.headers['x-amz-access-token'] === 'amazon-token'));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), config);
});
