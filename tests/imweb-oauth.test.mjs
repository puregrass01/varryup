// 아임웹 OAuth 단위 테스트. 네트워크를 쓰지 않고 fetch 를 모의한다.
// 응답 모양(오류 코드·리디렉트 방식)은 2026-09-23 실측한 것을 그대로 옮겼다.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  authorizeUrl, readCallback, requestCode, requestApprovedCode, exchangeCode, refreshAccessToken,
  getSiteInfo, completeIntegration, normalizeScopes,
  ImwebOAuthError, REQUIRED_SCOPES, DEFAULT_SCOPES, ERROR_HINTS, IMWEB_BASE, TOKEN_PATH, AUTHORIZE_PATH
} from '../src/platforms/openapi/imweb_oauth.js';

const base = { clientId: 'CID', redirectUri: 'https://shop.example/oauth', siteCode: 'S20260120abc' };

function response(status, { location = null, body = '' } = {}) {
  return {
    status,
    headers: new Headers(location ? { location } : {}),
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
  };
}

// authorize 요청을 받아 그 state 를 되돌려주는 모의 — 실제 아임웹이 하는 일과 같다.
function authorizeReplying(build) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, options });
    const state = new URL(url).searchParams.get('state');
    return build(state);
  };
  return { impl, calls };
}

// ── authorizeUrl ───────────────────────────────────────────────

test('authorizeUrl 은 site-info:write 를 항상 앞에 붙이고 중복을 없앤다', () => {
  const scopeOf = (scopes) => new URL(authorizeUrl({ ...base, state: 's', scopes })).searchParams.get('scope');
  assert.equal(scopeOf(['member-info:read']), 'site-info:write member-info:read');
  assert.equal(scopeOf(['product:write', 'site-info:write']), 'site-info:write product:write');
  assert.equal(scopeOf([]), REQUIRED_SCOPES.join(' '));
  assert.equal(scopeOf('member-info:read,product:write'), 'site-info:write member-info:read product:write');
});

test('authorizeUrl 은 공백을 + 가 아니라 %20 으로, 파라미터는 camelCase 로 보낸다', () => {
  const url = authorizeUrl({ ...base, state: 's', scopes: ['member-info:read'] });
  assert.ok(url.startsWith(`${IMWEB_BASE}${AUTHORIZE_PATH}?`));
  assert.ok(url.includes('scope=site-info%3Awrite%20member-info%3Aread'), url);
  assert.ok(!url.includes('+'), url);
  for (const k of ['responseType=code', 'clientId=', 'redirectUri=', 'siteCode=', 'state=']) assert.ok(url.includes(k), k);
  assert.ok(!/client_id|redirect_uri|response_type/.test(url), 'snake_case 가 섞이면 아임웹이 거부한다');
});

// ── requestCode ────────────────────────────────────────────────

test('requestCode: 설치된 사이트는 redirectUri 로 바로 302 — 리디렉트를 따라가지 않고 code 를 꺼낸다', async () => {
  const { impl, calls } = authorizeReplying((state) =>
    response(302, { location: `${base.redirectUri}?code=${'c'.repeat(64)}&state=${state}` }));
  const { code } = await requestCode({ ...base, scopes: [] }, { fetchImpl: impl });
  assert.equal(code.length, 64);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.redirect, 'manual');
});

test('requestCode: 서비스 URL 의 errorCode 를 코드·안내와 함께 알린다', async () => {
  for (const [errorCode, message, hintWord] of [
    ['30099', '요청한 scope가 올바르지 않습니다.', 'API 설정'],
    ['30132', '연동되지 않은 사이트입니다.', 'siteCode'],
    ['30156', '인가 코드 발급 시 scope에 site-info:write 권한이 필수로 제공되어야 합니다.', 'site-info:write']
  ]) {
    const { impl } = authorizeReplying(() => response(302, {
      location: `https://shop.example/?errorCode=${errorCode}&message=${encodeURIComponent(message)}`
    }));
    await assert.rejects(requestCode({ ...base }, { fetchImpl: impl }), (e) => {
      assert.ok(e instanceof ImwebOAuthError);
      assert.equal(e.errorCode, errorCode);
      assert.ok(e.message.includes(message), e.message);
      assert.ok(e.message.includes(hintWord), e.message);
      return true;
    });
  }
});

test('requestCode: 리디렉트 없는 400 JSON 은 중첩 error 를 풀어서 알린다([object Object] 금지)', async () => {
  const { impl } = authorizeReplying(() => response(400, {
    body: { statusCode: 400, error: { errorCode: '30098', message: '클라이언트 정보가 올바르지 않습니다.', innerMessage: 'Invalid redirect uri' } }
  }));
  await assert.rejects(requestCode({ ...base }, { fetchImpl: impl }), (e) => {
    assert.ok(!e.message.includes('[object Object]'), e.message);
    assert.ok(e.message.includes('30098') && e.message.includes('Invalid redirect uri'), e.message);
    assert.equal(e.status, 400);
    return true;
  });
});

test('requestCode: 로그인 화면으로 보내면(미설치 사이트) 브라우저 방식을 안내한다', async () => {
  const { impl } = authorizeReplying(() => response(302, { location: 'https://imweb.me/login?back=x' }));
  await assert.rejects(requestCode({ ...base }, { fetchImpl: impl }), /브라우저/);

  const { impl: html } = authorizeReplying(() => response(200, { body: '<html>로그인</html>' }));
  await assert.rejects(requestCode({ ...base }, { fetchImpl: html }), /브라우저/);
});

test('requestCode: state 가 다르면 거부한다', async () => {
  const { impl } = authorizeReplying(() => response(302, { location: `${base.redirectUri}?code=abc&state=someone-else` }));
  await assert.rejects(requestCode({ ...base }, { fetchImpl: impl }), /state/);
});

// ── readCallback ───────────────────────────────────────────────

test('readCallback: 붙여넣은 주소가 errorCode 오류면 코드를 살려서 던진다', () => {
  assert.throws(
    () => readCallback('https://shop.example/?errorCode=30132&message=x', null),
    (e) => e instanceof ImwebOAuthError && e.errorCode === '30132'
  );
});

// ── exchangeCode ───────────────────────────────────────────────

test('exchangeCode: /oauth2/token 에 form 본문, camelCase 필드로 보내고 data.accessToken 을 읽는다', async () => {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, options });
    return response(200, { body: { statusCode: 200, data: { accessToken: 'AT'.repeat(20), refreshToken: 'RT'.repeat(20) } } });
  };
  const token = await exchangeCode({ clientId: 'CID', clientSecret: 'SEC', code: 'CODE', redirectUri: base.redirectUri }, { fetchImpl: impl });
  assert.equal(calls[0].url, `${IMWEB_BASE}${TOKEN_PATH}`);
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers['Content-Type'], 'application/x-www-form-urlencoded');
  const sent = new URLSearchParams(calls[0].options.body);
  assert.deepEqual(Object.fromEntries(sent), {
    clientId: 'CID', clientSecret: 'SEC', code: 'CODE', grantType: 'authorization_code', redirectUri: base.redirectUri
  });
  assert.equal(token.accessToken, 'AT'.repeat(20));
  assert.equal(token.refreshToken, 'RT'.repeat(20));
});

test('exchangeCode: 400 중첩 오류를 코드·메시지·안내로 알리고 secret 은 메시지에 싣지 않는다', async () => {
  const impl = async () => response(400, {
    body: { statusCode: 400, error: { errorCode: '30098', message: '클라이언트 정보가 올바르지 않습니다.' } }
  });
  await assert.rejects(
    exchangeCode({ clientId: 'CID', clientSecret: 'TOP-SECRET-VALUE', code: 'C', redirectUri: base.redirectUri }, { fetchImpl: impl }),
    (e) => {
      assert.equal(e.errorCode, '30098');
      assert.ok(e.message.includes('클라이언트 정보가 올바르지 않습니다.'), e.message);
      assert.ok(e.message.includes('clientSecret'), '30098 안내가 붙어야 한다');
      assert.ok(!e.message.includes('TOP-SECRET-VALUE'));
      return true;
    }
  );
});

// ── 지금 요청하는 범위 ──────────────────────────────────────────

test('DEFAULT_SCOPES 는 지금 신청한 범위이고 필수 scope 를 포함한다', () => {
  assert.deepEqual(DEFAULT_SCOPES, ['site-info:write', 'member-info:read', 'product:write', 'order:write']);
  for (const s of REQUIRED_SCOPES) assert.ok(DEFAULT_SCOPES.includes(s));
  const url = authorizeUrl({ ...base, state: 's' });
  assert.equal(new URL(url).searchParams.get('scope'), 'site-info:write member-info:read product:write order:write');
});

test('normalizeScopes: 배열·공백·쉼표 입력을 중복 없이 맞춘다', () => {
  assert.deepEqual(normalizeScopes('a:read, b:write  a:read'), ['a:read', 'b:write']);
  assert.deepEqual(normalizeScopes([' a:read ', '', 'a:read']), ['a:read']);
  assert.deepEqual(normalizeScopes(undefined), []);
});

// ── requestApprovedCode: 거부되는 scope 가 섞여 있어도 받아주는 것만으로 진행한다 ─────────

// 승인된 scope 집합을 가진 authorize 모의. 요청에 승인 안 된 scope 가 하나라도 섞이면 30099 로 거부한다.
// 아임웹은 어느 scope 가 문제인지 알려주지 않으므로 모의도 알려주지 않는다.
function authorizeApproving(approved, { siteLinked = true } = {}) {
  const asked = [];
  const impl = async (url) => {
    const q = new URL(url).searchParams;
    const scopes = q.get('scope').split(' ');
    asked.push(scopes);
    const fail = (errorCode, message) => response(302, {
      location: `https://shop.example/?errorCode=${errorCode}&message=${encodeURIComponent(message)}`
    });
    if (!siteLinked) return fail('30132', '연동되지 않은 사이트입니다.');
    if (!scopes.includes('site-info:write')) return fail('30156', 'site-info:write 필수');
    if (scopes.some(s => !approved.includes(s))) return fail('30099', '요청한 scope가 올바르지 않습니다.');
    return response(302, { location: `${base.redirectUri}?code=${'c'.repeat(64)}&state=${q.get('state')}` });
  };
  return { impl, asked };
}

test('requestApprovedCode: 전부 승인되면 한 번만 묻고 그대로 진행한다', async () => {
  const { impl, asked } = authorizeApproving(['site-info:write', 'member-info:read', 'product:write', 'order:write']);
  const got = await requestApprovedCode({ ...base }, { fetchImpl: impl });
  assert.equal(asked.length, 1);
  assert.deepEqual(got.scopes, ['member-info:read', 'product:write', 'order:write']);
  assert.deepEqual(got.rejected, []);
  assert.equal(got.code.length, 64);
});

test('requestApprovedCode: product·order 가 거부되면 하나씩 물어 받아주는 것만 요청하고 거부된 것을 알려준다', async () => {
  const { impl, asked } = authorizeApproving(['site-info:write', 'site-info:read', 'member-info:read']);
  const got = await requestApprovedCode({ ...base }, { fetchImpl: impl });
  assert.deepEqual(got.scopes, ['member-info:read']);
  assert.deepEqual(got.rejected, ['product:write', 'order:write']);
  // 전체 1 + 하나씩 3 + 받아주는 것만 다시 1. 마지막 요청에 거부된 scope 가 섞이면 다시 30099 가 난다.
  assert.equal(asked.length, 5);
  assert.deepEqual(asked.at(-1), ['site-info:write', 'member-info:read']);
  assert.equal(got.code.length, 64);
});

test('requestApprovedCode: scope 와 무관한 오류(사이트 미연동)는 하나씩 묻지 않고 바로 던진다', async () => {
  const { impl, asked } = authorizeApproving([], { siteLinked: false });
  await assert.rejects(requestApprovedCode({ ...base }, { fetchImpl: impl }), (e) => e.errorCode === '30132');
  assert.equal(asked.length, 1);
});

test('requestApprovedCode: 필수 scope 조차 승인되지 않았으면 30099 를 그대로 올린다', async () => {
  const { impl, asked } = authorizeApproving([]);
  await assert.rejects(requestApprovedCode({ ...base, scopes: [] }, { fetchImpl: impl }), (e) => e.errorCode === '30099');
  assert.equal(asked.length, 1, '물어볼 대상이 없으면 더 묻지 않는다');
  await assert.rejects(requestApprovedCode({ ...base }, { fetchImpl: impl }), (e) => e.errorCode === '30099');
});

// ── 토큰 ───────────────────────────────────────────────────────

function respondingWith(status, body) {
  const calls = [];
  const impl = async (url, options) => { calls.push({ url, options }); return response(status, { body }); };
  return { impl, calls };
}
const codeArgs = { clientId: 'C', clientSecret: 'S', code: 'X', redirectUri: base.redirectUri };

test('exchangeCode: 문서 필드(accessToken · refreshToken · scope 배열)를 그대로 읽는다', async () => {
  const { impl } = respondingWith(200, { accessToken: 'AT', refreshToken: 'RT', scope: ['site-info:write', 'member-info:read'] });
  const t = await exchangeCode(codeArgs, { fetchImpl: impl });
  assert.deepEqual([t.accessToken, t.refreshToken], ['AT', 'RT']);
  assert.deepEqual(t.scope, ['site-info:write', 'member-info:read']);
});

test('exchangeCode: data 로 감싼 응답과 공백으로 이은 scope 문자열도 받는다', async () => {
  const { impl } = respondingWith(200, { statusCode: 200, data: { accessToken: 'AT', refreshToken: 'RT', scope: 'a:read b:write' } });
  const t = await exchangeCode(codeArgs, { fetchImpl: impl });
  assert.equal(t.accessToken, 'AT');
  assert.deepEqual(t.scope, ['a:read', 'b:write']);
});

test('exchangeCode: 토큰이 없는 200 응답은 성공으로 치지 않는다', async () => {
  const { impl } = respondingWith(200, { statusCode: 200, data: {} });
  await assert.rejects(exchangeCode(codeArgs, { fetchImpl: impl }), ImwebOAuthError);
});

test('refreshAccessToken: grantType=refresh_token 으로 보내고 새 refreshToken 도 돌려준다', async () => {
  const { impl, calls } = respondingWith(200, { accessToken: 'NEW_AT', refreshToken: 'NEW_RT', scope: ['site-info:write'] });
  const t = await refreshAccessToken({ clientId: 'C', clientSecret: 'S', refreshToken: 'OLD_RT' }, { fetchImpl: impl });
  assert.equal(calls[0].url, `${IMWEB_BASE}${TOKEN_PATH}`);
  assert.equal(calls[0].options.method, 'POST');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(calls[0].options.body)), {
    grantType: 'refresh_token', clientId: 'C', clientSecret: 'S', refreshToken: 'OLD_RT'
  });
  assert.equal(t.accessToken, 'NEW_AT');
  assert.equal(t.refreshToken, 'NEW_RT', '새 refreshToken 으로 바꿔 저장해야 하므로 반드시 돌려준다');
});

test('refreshAccessToken: refreshToken 이 없으면 요청 전에 막는다', async () => {
  const never = async () => { throw new Error('호출되면 안 된다'); };
  await assert.rejects(refreshAccessToken({ clientId: 'C', clientSecret: 'S', refreshToken: '' }, { fetchImpl: never }), /refreshToken/);
});

// ── 액세스 토큰으로 부르는 API ──────────────────────────────────────

test('getSiteInfo: Bearer 로 GET /site-info 를 부르고 data 를 풀어준다', async () => {
  const { impl, calls } = respondingWith(200, {
    statusCode: 200,
    data: { siteCode: 'S1', unitList: [{ unitCode: 'u1', name: '본점', currency: 'KRW' }] }
  });
  const info = await getSiteInfo('TOKEN', { fetchImpl: impl });
  assert.equal(calls[0].url, `${IMWEB_BASE}/site-info`);
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer TOKEN');
  assert.equal(info.siteCode, 'S1');
  assert.equal(info.unitList[0].currency, 'KRW');
});

test('completeIntegration: 본문 없이 PATCH /site-info/integration-complete 를 부른다', async () => {
  const { impl, calls } = respondingWith(200, { statusCode: 200 });
  await completeIntegration('TOKEN', { fetchImpl: impl });
  assert.equal(calls[0].url, `${IMWEB_BASE}/site-info/integration-complete`);
  assert.equal(calls[0].options.method, 'PATCH');
  assert.equal(calls[0].options.body, undefined);
  assert.equal(calls[0].options.headers['Content-Type'], undefined, '본문이 없으면 Content-Type 도 싣지 않는다');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer TOKEN');
});

test('completeIntegration: 연동중이 아니면 30128 과 안내가 오고 코드로 가려낼 수 있다', async () => {
  const { impl } = respondingWith(404, {
    statusCode: 404, error: { errorCode: '30128', message: '연동 상태가 연동중 상태인 앱만 연동완료 처리가 가능합니다.' }
  });
  await assert.rejects(completeIntegration('TOKEN', { fetchImpl: impl }), (e) => {
    assert.equal(e.errorCode, '30128');
    assert.equal(e.status, 404);
    assert.ok(e.message.includes('이미 연동완료'), e.message);
    return true;
  });
});

test('API 호출: 토큰이 없으면 요청 전에 막고, 만료 오류에는 갱신 안내가 붙는다', async () => {
  const never = () => { throw new Error('호출되면 안 된다'); };
  await assert.rejects(getSiteInfo('', { fetchImpl: never }), /액세스 토큰/);

  const { impl } = respondingWith(401, { statusCode: 401, error: { errorCode: '30102', message: '토큰이 만료되었습니다.' } });
  await assert.rejects(getSiteInfo('T', { fetchImpl: impl }), (e) => e.errorCode === '30102' && e.message.includes('refreshToken'));
});

test('ERROR_HINTS: 인증·연동 단계에서 만나는 문서상 오류 코드마다 안내가 있다', () => {
  for (const code of ['10007', '30098', '30099', '30100', '30101', '30102', '30103', '30105',
    '30122', '30123', '30124', '30125', '30128', '30132', '30156']) {
    assert.ok(ERROR_HINTS[code], `${code} 안내 없음`);
  }
});

// ── VERY UP 설정에서 OAuth 값 꺼내기 ─────────────────────────────

test('oauthCredentialsFromConfig: 전용 칸 → UUID 인 apiKey 칸 → 없음 순서로 본다', async () => {
  const { oauthCredentialsFromConfig } = await import('../src/platforms/openapi/imweb_oauth.js');
  const id = '0a1b2c3d-1111-2222-3333-444455556666';
  const sec = '9f8e7d6c-aaaa-bbbb-cccc-ddddeeeeffff';

  assert.deepEqual(oauthCredentialsFromConfig({ clientId: id, clientSecret: sec, apiKey: 'v2key', apiSecret: 'v2sec' }),
    { clientId: id, clientSecret: sec, from: 'clientId' });
  assert.deepEqual(oauthCredentialsFromConfig({ apiKey: ` ${id} `, apiSecret: sec }),
    { clientId: id, clientSecret: sec, from: 'apiKey' }, '앱 입력칸에 OAuth 값을 넣은 경우');
  // 구 v2 키(42자·22자)는 OAuth 값으로 오인하지 않는다.
  assert.equal(oauthCredentialsFromConfig({ apiKey: 'a'.repeat(42), apiSecret: 'b'.repeat(22) }), null);
  assert.equal(oauthCredentialsFromConfig({}), null);
  assert.equal(oauthCredentialsFromConfig(null), null);
});
