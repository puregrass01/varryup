import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { cleanAmazonConfig } from '../src/platforms/amazon.js';
import { Ebay } from '../src/platforms/ebay.js';
import { EbayStore } from '../src/platforms/ebay_store.js';
import { fetchCredentials } from '../src/utils/server_keys.js';

// Exercise the actual Electron login-sync helpers without starting Electron.
const mainSource = fs.readFileSync(new URL('../src/main_process.js', import.meta.url), 'utf8');
const start = mainSource.indexOf('function mergeIntoConfig(');
const end = mainSource.indexOf("ipcMain.handle('server-login'", start);
assert.ok(start >= 0 && end > start, 'The credential-sync helper block must exist');
const syncSource = mainSource.slice(start, end);
const mockEncryption = {
  isEncryptionAvailable: () => true,
  encryptString: value => Buffer.from(`encrypted:${value}`),
  decryptString: value => value.toString().slice(10),
};

function fixture(t, credentials) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'veryup-server-credentials-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new EbayStore(directory, mockEncryption);
  const ebay = new Ebay(store);
  const requests = [];
  const warnings = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify({ credentials }), { status: 200 });
  });
  const context = vm.createContext({
    app: { getPath: name => { assert.equal(name, 'userData'); return directory; } },
    fs, path, cleanAmazonConfig, fetchCredentials,
    getEbay: () => ebay,
    ADMIN_SERVER_URL: 'https://admin.example',
    serverAuth: { token: 'test-staff-token' },
    serverCreds: {},
    console: { log() {}, warn: (...args) => warnings.push(args) },
  });
  vm.runInContext(syncSource, context);
  return { directory, store, requests, warnings, context, sync: () => context.syncCredentialsFromServer() };
}

test('staff credential sync stores Amazon LWA keys, preserves settings, and removes legacy IAM keys', async t => {
  const { directory, requests, warnings, sync } = fixture(t, [{
    platform: 'amazon',
    data: { sellerId: 'new-seller', clientId: 'new-app', clientSecret: 'new-secret', refreshToken: 'new-refresh', awsAccessKeyId: 'retired-server-key' },
  }]);
  const file = path.join(directory, 'amazon_config.json');
  fs.writeFileSync(file, JSON.stringify({
    sellerId: 'old-seller', clientSecret: 'old-secret',
    marketplaceId: 'A1VC38T7YXB528', endpoint: 'https://sellingpartnerapi-fe.amazon.com', brand: 'Saved brand',
    awsAccessKeyId: 'retired-key', awsSecretAccessKey: 'retired-secret', region: 'us-east-1',
  }));

  await sync();

  // 서버 분리(2026-09-16) 이후 /api/credentials 는 platform 파라미터를 요구한다.
  // 그래서 한 번의 벌크 조회가 아니라 SYNC_PLATFORMS 만큼 개별 조회가 나간다.
  const asked = requests.map(r => new URL(r.url).searchParams.get('platform')).sort();
  assert.deepEqual(asked, ['amazon', 'coupang', 'ebay', 'esm', 'imweb', 'naver', 'papago']);
  assert.ok(requests.every(r => r.options.headers.Authorization === 'Bearer test-staff-token'));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
    sellerId: 'new-seller', clientId: 'new-app', clientSecret: 'new-secret', refreshToken: 'new-refresh',
    marketplaceId: 'A1VC38T7YXB528', endpoint: 'https://sellingpartnerapi-fe.amazon.com', brand: 'Saved brand',
  });
  assert.ok(!fs.readFileSync(file, 'utf8').includes('test-staff-token'));
  assert.equal(warnings.length, 0);
});

test('staff credential sync routes eBay keys through encrypted storage while preserving omitted settings', async t => {
  const { store, warnings, sync } = fixture(t, [{
    platform: 'ebay',
    data: {
      environment: 'production', clientId: 'ebay-app', clientSecret: 'new-ebay-secret', refreshToken: 'new-ebay-refresh',
      ruName: 'new-runame', merchantLocationKey: 'new-warehouse',
      proxyToken: 'must-not-be-stored', unrecognized: 'must-not-be-stored',
    },
  }]);
  store.save({
    environment: 'production', clientId: 'ebay-app', clientSecret: 'old-secret', refreshToken: 'old-refresh',
    ruName: 'old-runame', merchantLocationKey: 'old-warehouse',
    fulfillmentPolicyId: 'saved-shipping', paymentPolicyId: 'saved-payment', returnPolicyId: 'saved-returns',
  });

  await sync();

  assert.deepEqual(store.config(), {
    environment: 'production', clientId: 'ebay-app', clientSecret: 'new-ebay-secret', refreshToken: 'new-ebay-refresh',
    ruName: 'new-runame', merchantLocationKey: 'new-warehouse',
    fulfillmentPolicyId: 'saved-shipping', paymentPolicyId: 'saved-payment', returnPolicyId: 'saved-returns',
  });
  const raw = fs.readFileSync(store.configPath, 'utf8');
  const saved = JSON.parse(raw);
  assert.ok(saved.clientSecretEncrypted && saved.refreshTokenEncrypted);
  assert.equal(saved.clientSecret, undefined);
  assert.equal(saved.refreshToken, undefined);
  for (const value of ['new-ebay-secret', 'new-ebay-refresh', 'test-staff-token', 'must-not-be-stored']) assert.ok(!raw.includes(value));
  assert.equal(warnings.length, 0);
});

test('mixed credential responses keep browser logins in memory and skip unavailable or unknown keys', async t => {
  const login = { loginId: 'example-login', loginPw: 'example-password' };
  const { directory, context, warnings, sync } = fixture(t, [
    { platform: 'naver', data: login },
    { platform: 'amazon', data: null },
    { platform: 'ebay', data: null },
    { platform: 'unknown', data: { clientSecret: 'ignored-secret' } },
  ]);

  await sync();

  assert.deepEqual(context.serverCreds.naver, login);
  assert.deepEqual(fs.readdirSync(directory), []);
  assert.equal(warnings.length, 0);
});

test('credential fetch failures preserve local Amazon and encrypted eBay configurations', async t => {
  const { directory, store, warnings, sync } = fixture(t, []);
  const amazonFile = path.join(directory, 'amazon_config.json');
  const originalAmazon = JSON.stringify({ sellerId: 'saved-seller', refreshToken: 'saved-amazon-refresh' });
  fs.writeFileSync(amazonFile, originalAmazon);
  store.save({ environment: 'production', clientId: 'saved-ebay-app', clientSecret: 'saved-secret', refreshToken: 'saved-ebay-refresh' });
  const originalEbay = fs.readFileSync(store.configPath, 'utf8');
  t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 503 }));

  await sync();

  assert.equal(fs.readFileSync(amazonFile, 'utf8'), originalAmazon);
  assert.equal(fs.readFileSync(store.configPath, 'utf8'), originalEbay);
  // 플랫폼마다 따로 조회하므로 503 하나가 플랫폼 수만큼의 경고가 된다.
  // 중요한 것은 개수가 아니라 '하나도 삼키지 않는다'는 것이다.
  assert.equal(warnings.length, 7);
  for (const w of warnings) assert.match(w.join(' '), /HTTP 503/);
});
