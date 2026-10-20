// 환율 — 앱이 Yahoo Finance 에서 직접 받고(2026-09-30), 안 되면 관리 서버, 그래도 안 되면 저장해 둔 값.
// 운영 관리 서버에는 /api/currency-rates 가 배포되지 않아 404 였다. 네트워크는 쓰지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CurrencyRatesClient, DAY, REFRESH, RETRY, dailyCloses, fetchYahooRates } from '../src/utils/currency_rates.js';

const now = Date.parse('2026-09-29T00:00:00Z');
const snapshot = () => ({ ok: true, base: 'USD', rates: { USD: 1, JPY: 150, KRW: 1350 },
  marketDate: '2026-09-28', fetchedAt: new Date(now).toISOString(), stale: false });
const yahooDown = async () => { throw new Error('yahoo blocked'); };
function setup(t, fetchImpl, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'currency-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { cachePath: path.join(dir, 'cache.json'), baseUrl: 'https://example.test/',
    getToken: () => 'test-token', fetchImpl, clock: () => now, ...extra };
}

// 2026-09-30 실제 응답 모양: 런던 자정 일봉 + 오늘 일봉은 null + 마지막에 실시간 값.
const at = iso => Date.parse(iso) / 1000;
const chart = (symbol, points) => ({ chart: { error: null, result: [{ meta: { symbol, gmtoffset: 3600, exchangeTimezoneName: 'Europe/London' },
  timestamp: points.map(p => at(p[0])), indicators: { quote: [{ close: points.map(p => p[1]) }] } }] } });
const KRW = chart('KRW=X', [['2026-09-28T00:00+01:00', 1350.2], ['2026-09-29T00:00+01:00', 1356.09], ['2026-09-30T00:00+01:00', null], ['2026-09-30T11:55+01:00', 1360.5]]);
const JPY = chart('JPY=X', [['2026-09-28T00:00+01:00', 157.46], ['2026-09-29T00:00+01:00', 157.36], ['2026-09-30T00:00+01:00', null], ['2026-09-30T11:55+01:00', 157.03]]);
const yahoo = (bodies = { 'KRW=X': KRW, 'JPY=X': JPY }, calls = []) => async (url, init) => {
  calls.push({ url, init });
  const symbol = decodeURIComponent(url.match(/chart\/([^?]+)/)[1]);
  return { ok: true, status: 200, json: async () => bodies[symbol] };
};

test('Yahoo 차트: 오늘 실시간 값이 비어 있는 오늘 일봉을 대신하고, 날짜는 거래소 기준이다', () => {
  assert.deepEqual([...dailyCloses(KRW)], [['2026-09-28', 1350.2], ['2026-09-29', 1356.09], ['2026-09-30', 1360.5]]);
  assert.equal(dailyCloses({ chart: { result: null } }).size, 0);
});

test('앱이 직접 받는다: 두 통화에 모두 있는 가장 최근 날짜 · 앱 이름 User-Agent', async () => {
  const calls = [];
  const data = await fetchYahooRates({ fetchImpl: yahoo(undefined, calls), clock: () => now });
  assert.deepEqual([data.marketDate, data.rates], ['2026-09-30', { USD: 1, JPY: 157.03, KRW: 1360.5 }]);
  assert.equal(data.base, 'USD');
  assert.match(data.source, /앱 직접/);
  assert.equal(calls[0].init.headers['User-Agent'], 'VERYUP/3.0 (+currency-rates)');
  // 엔화에 오늘 값이 아직 없으면 두 통화가 같은 날짜(어제)로 맞춘다. 다른 날 값을 섞지 않는다.
  const jpyYesterday = chart('JPY=X', [['2026-09-28T00:00+01:00', 157.46], ['2026-09-29T00:00+01:00', 157.36]]);
  const older = await fetchYahooRates({ fetchImpl: yahoo({ 'KRW=X': KRW, 'JPY=X': jpyYesterday }), clock: () => now });
  assert.deepEqual([older.marketDate, older.rates.KRW, older.rates.JPY], ['2026-09-29', 1356.09, 157.36]);
});

test('query1 이 막히면 query2 로 받고, 둘 다 안 되거나 값이 비정상이면 던진다', async () => {
  const hosts = [];
  const flaky = async (url, init) => {
    hosts.push(new URL(url).host);
    if (url.includes('query1')) return { ok: false, status: 429, json: async () => ({}) };
    return yahoo()(url, init);
  };
  assert.equal((await fetchYahooRates({ fetchImpl: flaky })).rates.KRW, 1360.5);
  assert.deepEqual(hosts.slice(0, 2), ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']);
  await assert.rejects(fetchYahooRates({ fetchImpl: async () => ({ ok: false, status: 429 }) }), /HTTP 429/);
  const broken = chart('KRW=X', [['2026-09-30T11:55+01:00', 13605]]);
  await assert.rejects(fetchYahooRates({ fetchImpl: yahoo({ 'KRW=X': broken, 'JPY=X': JPY }) }), /비정상/);
});

test('로그인하지 않아도 앱이 직접 받아 저장하고, 1시간 안에는 다시 받지 않는다', async t => {
  let clock = now; const calls = [];
  const options = setup(t, yahoo(undefined, calls), { getToken: () => null, clock: () => clock });
  const client = new CurrencyRatesClient(options);
  const first = await client.get();
  assert.equal(first.success, true);
  assert.equal(first.data.rates.KRW, 1360.5);
  assert.equal(JSON.parse(fs.readFileSync(options.cachePath)).source, 'Yahoo Finance (앱 직접 조회)');
  const count = calls.length;
  clock = now + REFRESH - 1000;
  await client.get();
  assert.equal(calls.length, count, '1시간 안에는 네트워크를 쓰지 않는다');
  clock = now + REFRESH;
  await client.get();
  assert.ok(calls.length > count, '1시간이 지나면 다시 받는다');
  // 앱을 다시 켜도 저장해 둔 값이 1시간 안이면 바로 다시 받지 않는다.
  const restarted = new CurrencyRatesClient({ ...options, clock: () => now + REFRESH + 1000 });
  const before = calls.length;
  assert.equal((await restarted.get()).success, true);
  assert.equal(calls.length, before);
});

test('직접 못 받으면 관리 서버를 부르고, 동시 요청은 한 번만 보낸다', async t => {
  let calls = 0;
  const options = setup(t, async (url, init) => {
    calls++;
    assert.equal(url, 'https://example.test/api/currency-rates');
    assert.equal(init.headers.Authorization, 'Bearer test-token');
    await new Promise(resolve => setTimeout(resolve, 5));
    return { ok: true, json: async () => snapshot() };
  }, { direct: yahooDown });
  const client = new CurrencyRatesClient(options);
  const results = await Promise.all([client.get(), client.get()]);
  assert.equal(calls, 1);
  assert.ok(results.every(r => r.success && !r.data.stale));
  assert.equal(JSON.parse(fs.readFileSync(options.cachePath)).rates.JPY, 150);
});

test('둘 다 안 되면 저장해 둔 값을 쓰고, 15분 동안은 다시 두드리지 않는다', async t => {
  let clock = now + DAY, calls = 0;
  const options = setup(t, async () => { calls++; throw new Error('offline'); }, { clock: () => clock });
  fs.writeFileSync(options.cachePath, JSON.stringify(snapshot()));
  const client = new CurrencyRatesClient(options);
  const result = await client.get();
  assert.equal(result.data.rates.KRW, 1350);
  assert.equal(result.data.offline, true);
  assert.equal(result.data.stale, true, '24시간 지난 값은 stale');
  assert.match(result.data.warning, /새로 받지 못했습니다: offline · 관리 서버: offline/);
  const tried = calls;
  clock += RETRY - 1000;
  assert.equal((await client.get()).data.offline, true);
  assert.equal(calls, tried, '15분 안에는 다시 시도하지 않는다');
  clock += 1000;
  await client.get();
  assert.ok(calls > tried);
});

test('틀린 응답은 저장해 둔 값을 덮어쓰지 않는다', async t => {
  const options = setup(t, async () => ({ ok: true, json: async () => ({ ...snapshot(), rates: { USD: 1, JPY: 0, KRW: 1350 } }) }),
    { direct: async () => ({ ...snapshot(), rates: { USD: 1, JPY: -1, KRW: 1350 } }), clock: () => now + 2 * REFRESH });
  fs.writeFileSync(options.cachePath, JSON.stringify(snapshot()));
  const result = await new CurrencyRatesClient(options).get();
  assert.equal(result.data.rates.JPY, 150);
  assert.equal(JSON.parse(fs.readFileSync(options.cachePath)).rates.JPY, 150);
});

test('저장해 둔 값도 없고 둘 다 안 되면 이유를 알린다', async t => {
  const options = setup(t, async () => { throw new Error('offline'); }, { getToken: () => null });
  const result = await new CurrencyRatesClient(options).get();
  assert.equal(result.success, false);
  assert.match(result.error, /새로 받지 못했습니다: offline/);
});

test('handler registers before lazy initialization and catches initialization errors', async () => {
  const { registerCurrencyRatesIPC } = await import('../src/currency_rates_ipc.js');
  let handler, attempts = 0;
  registerCurrencyRatesIPC({
    app: { getPath: () => '/temporary-user-data' },
    ipcMain: { handle(channel, fn) { assert.equal(channel, 'currency-rates-get'); handler = fn; } },
    baseUrl: 'https://example.test', getToken: () => null,
    createClient: () => { attempts++; throw new Error('setup failed'); },
  });
  assert.equal(attempts, 0);
  assert.equal((await handler()).success, false);
  assert.equal(attempts, 1);
  assert.equal((await handler()).success, false);
  assert.equal(attempts, 2);
});
