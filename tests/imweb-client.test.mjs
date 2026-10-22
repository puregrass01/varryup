// 아임웹 Open API 클라이언트 — 토큰 발급 · 갱신 · 재발급과 호출 제한 처리. 네트워크는 쓰지 않는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createImwebSession, createImwebClient, jwtExpiryMs } from '../src/platforms/openapi/imweb_client.js';
import { IMWEB_BASE, TOKEN_PATH } from '../src/platforms/openapi/imweb_oauth.js';

const T0 = Date.parse('2026-10-05T09:00:00Z');
const jwt = (expSec, tag = 'x') => [
  Buffer.from('{"alg":"HS256"}').toString('base64url'),
  Buffer.from(JSON.stringify({ exp: expSec, tag })).toString('base64url'),
  'sig'
].join('.');

function response(status, body, headers = {}) {
  return { status, headers: new Headers(headers), text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
}

// 아임웹 흉내: authorize 는 redirectUri 로 코드를 주고, /oauth2/token 은 grantType 에 따라 토큰을 준다.
function fakeImweb({ scope = ['site-info:write', 'product:write'], refreshFails = false, accessTtlSec = 7200 } = {}) {
  const log = [];
  let n = 0;
  const impl = async (url, options = {}) => {
    const u = new URL(url);
    if (u.pathname === '/oauth2/authorize') {
      log.push('authorize');
      return response(302, '', { location: `${u.searchParams.get('redirectUri')}?code=${'c'.repeat(64)}&state=${u.searchParams.get('state')}` });
    }
    if (u.pathname === TOKEN_PATH) {
      const body = new URLSearchParams(options.body);
      log.push(body.get('grantType'));
      if (body.get('grantType') === 'refresh_token' && refreshFails) {
        return response(400, { statusCode: 400, error: { errorCode: '30101', message: '토큰이 유효하지 않습니다.' } });
      }
      n++;
      return response(200, { statusCode: 200, data: { accessToken: jwt(T0 / 1000 + accessTtlSec, 'a' + n), refreshToken: 'r' + n, scope } });
    }
    throw new Error('예상하지 못한 요청 ' + url);
  };
  return { impl, log };
}
const creds = async () => ({ clientId: 'CID', clientSecret: 'SEC' });
const target = { siteCode: 'S1', redirectUri: 'https://shop.example/' };

test('jwtExpiryMs: JWT 의 exp 를 ms 로 읽고, JWT 가 아니면 null', () => {
  assert.equal(jwtExpiryMs(jwt(1700000000)), 1700000000 * 1000);
  assert.equal(jwtExpiryMs('not-a-jwt'), null);
});

test('세션: 처음엔 authorize → 코드 교환, 유효기간 안에서는 같은 토큰을 다시 쓴다', async () => {
  const fake = fakeImweb();
  let now = T0;
  const session = createImwebSession({ credentials: creds, ...target, fetchImpl: fake.impl, now: () => now });
  const a = await session.token();
  now += 60 * 60 * 1000;   // 1시간 뒤 — 아직 유효
  assert.equal(await session.token(), a);
  assert.deepEqual(fake.log, ['authorize', 'authorization_code']);
});

test('세션: 만료 5분 전부터는 리프레시 토큰으로 갱신하고, 갱신이 거부되면 처음부터 다시 발급한다', async () => {
  const fake = fakeImweb();
  let now = T0;
  const session = createImwebSession({ credentials: creds, ...target, fetchImpl: fake.impl, now: () => now });
  const a = await session.token();
  now += (2 * 60 - 4) * 60 * 1000;   // 만료 4분 전
  const b = await session.token();
  assert.notEqual(b, a);
  assert.deepEqual(fake.log, ['authorize', 'authorization_code', 'refresh_token']);

  const failing = fakeImweb({ refreshFails: true });
  const logs = [];
  let t = T0;
  const s2 = createImwebSession({ credentials: creds, ...target, fetchImpl: failing.impl, now: () => t, log: m => logs.push(m) });
  await s2.token();
  s2.invalidate();
  await s2.token();
  assert.deepEqual(failing.log, ['authorize', 'authorization_code', 'refresh_token', 'authorize', 'authorization_code']);
  assert.ok(logs.some(m => m.includes('갱신 실패')));
});

test('세션: 동시에 여러 호출이 와도 발급은 한 번만', async () => {
  const fake = fakeImweb();
  const session = createImwebSession({ credentials: creds, ...target, fetchImpl: fake.impl, now: () => T0 });
  const [a, b, c] = await Promise.all([session.token(), session.token(), session.token()]);
  assert.ok(a === b && b === c);
  assert.equal(fake.log.filter(x => x === 'authorization_code').length, 1);
});

test('세션: 꼭 필요한 scope 를 아임웹이 주지 않으면 토큰을 쓰지 않고 멈춘다', async () => {
  const fake = fakeImweb({ scope: ['site-info:write', 'member-info:read'] });
  const session = createImwebSession({ credentials: creds, ...target, need: ['product:write'], fetchImpl: fake.impl, now: () => T0 });
  await assert.rejects(session.token(), /product:write 권한을 주지 않았습니다/);
});

test('세션: OAuth 값이 없으면 아임웹에 묻지 않고 어디에 넣을지 알려준다', async () => {
  const never = async () => { throw new Error('호출되면 안 된다'); };
  const session = createImwebSession({ credentials: async () => null, ...target, fetchImpl: never });
  await assert.rejects(session.token(), /OAuth Client ID \/ Secret 이 없습니다/);
});

// ── 클라이언트 ──────────────────────────────────────────────────────

function staticSession() {
  let invalidated = 0, n = 0;
  return { token: async () => 'tok' + n, invalidate: () => { invalidated++; n++; }, get invalidated() { return invalidated; } };
}

test('클라이언트: Bearer 로 부르고, 토큰이 거부되면(30102) 한 번 다시 받아 재시도한다', async () => {
  const session = staticSession();
  const seen = [];
  const impl = async (url, options) => {
    seen.push(options.headers.Authorization);
    return seen.length === 1
      ? response(401, { statusCode: 401, error: { errorCode: '30102', message: '토큰이 만료되었습니다.' } })
      : response(200, { statusCode: 200, data: { siteCode: 'S1' } });
  };
  const client = createImwebClient(session, { fetchImpl: impl, sleep: async () => {} });
  assert.deepEqual(await client.siteInfo(), { siteCode: 'S1' });
  assert.deepEqual(seen, ['Bearer tok0', 'Bearer tok1']);
  assert.equal(session.invalidated, 1);
});

test('클라이언트: 두 번째 401 은 그대로 오류로 낸다(무한 재시도 없음)', async () => {
  const impl = async () => response(401, { statusCode: 401, error: { errorCode: '30101', message: '토큰이 유효하지 않습니다.' } });
  const client = createImwebClient(staticSession(), { fetchImpl: impl, sleep: async () => {} });
  await assert.rejects(client.siteInfo(), e => e.errorCode === '30101' && e.status === 401);
});

test('클라이언트: 429 · 10007 은 물러났다가 다시 보낸다(Retry-After 우선), 횟수를 넘으면 오류', async () => {
  const waits = [];
  let i = 0;
  const impl = async () => {
    i++;
    if (i === 1) return response(429, { statusCode: 429, error: { errorCode: '429', message: 'Too Many' } }, { 'retry-after': '3' });
    if (i === 2) return response(400, { statusCode: 400, error: { errorCode: '10007', message: '요청량이 많아 실패했습니다.' } });
    return response(200, { statusCode: 200, data: true });
  };
  const client = createImwebClient(staticSession(), { fetchImpl: impl, sleep: async ms => waits.push(ms) });
  assert.deepEqual(await client.request('PATCH', '/products/3/price', { body: { unitCode: 'u', price: 1 } }), { statusCode: 200, data: true });
  assert.deepEqual(waits, [3000, 2000]);

  const always = async () => response(429, { statusCode: 429 });
  const tired = createImwebClient(staticSession(), { fetchImpl: always, sleep: async () => {}, maxRetries: 2 });
  await assert.rejects(tired.siteInfo(), e => e.status === 429);
});

test('클라이언트: 남은 호출 수가 바닥나기 직전이면 1초 쉰다', async () => {
  const waits = [];
  const impl = async () => response(200, { statusCode: 200, data: {} }, { 'x-ratelimit-remaining': '2' });
  const client = createImwebClient(staticSession(), { fetchImpl: impl, sleep: async ms => waits.push(ms) });
  await client.siteInfo();
  assert.deepEqual(waits, [1000]);
});

test('클라이언트: 쪽 수를 알면 나머지 쪽은 3개씩 동시에 읽고, 늦게 온 쪽이 있어도 순서는 쪽 번호대로', async () => {
  let inFlight = 0, most = 0;
  const impl = async url => {
    const page = Number(new URL(url).searchParams.get('page'));
    inFlight++; most = Math.max(most, inFlight);
    await new Promise(r => setTimeout(r, page === 2 ? 30 : 5));   // 2쪽이 가장 늦게 온다
    inFlight--;
    return response(200, { statusCode: 200, data: { totalPage: 7, list: [{ prodNo: page * 10 }, { prodNo: page * 10 + 1 }] } });
  };
  const client = createImwebClient(staticSession(), { fetchImpl: impl, sleep: async () => {} });
  assert.deepEqual((await client.products('uKR')).map(p => p.prodNo), [10, 11, 20, 21, 30, 31, 40, 41, 50, 51, 60, 61, 70, 71]);
  assert.equal(most, 3, '1쪽 뒤에는 3개씩');
  // 쪽 수가 없으면 예전처럼 한 쪽씩, 덜 찬 쪽에서 멈춘다.
  const seq = createImwebClient(staticSession(), { sleep: async () => {}, fetchImpl: async url => {
    const page = Number(new URL(url).searchParams.get('page'));
    return response(200, { statusCode: 200, data: { list: Array.from({ length: page < 3 ? 100 : 7 }, (_, i) => ({ prodNo: page * 1000 + i })) } });
  } });
  assert.equal((await seq.products('uKR')).length, 207);
});

test('클라이언트: 목록은 totalPage 까지 이어 읽고, 가격 쓰기는 구역 · 값만 보낸다', async () => {
  const urls = [];
  const bodies = [];
  const impl = async (url, options) => {
    urls.push(url);
    if (options.body) bodies.push([options.method, url.replace(IMWEB_BASE, ''), JSON.parse(options.body)]);
    const page = Number(new URL(url).searchParams.get('page'));
    if (url.includes('/option-details?') || url.includes('/products?')) {
      return response(200, { statusCode: 200, data: { totalPage: 2, list: [{ prodNo: page }] } });
    }
    return response(200, { statusCode: 200, data: true });
  };
  const client = createImwebClient(staticSession(), { fetchImpl: impl, sleep: async () => {} });
  assert.deepEqual((await client.products('uKR')).map(p => p.prodNo), [1, 2]);
  assert.ok(urls[0].includes('unitCode=uKR') && urls[0].includes('page=1') && urls[0].includes('limit=100'));
  await client.setPrice(3, 'uUS', 59);
  await client.setOptionPrice(3, 'od2026', 'uJP', 9200);
  assert.deepEqual(bodies, [
    ['PATCH', '/products/3/price', { unitCode: 'uUS', price: 59 }],
    ['PATCH', '/products/3/option-details/od2026', { unitCode: 'uJP', price: 9200 }],
  ]);
});
