// 네이버 커머스API 어댑터 단위 테스트. 네트워크를 쓰지 않고 fetch 를 모의한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { NaverAPI, NaverAPIError, TOKEN_PATH, API_PREFIX } from '../src/platforms/naver_api.js';
import { NaverStore } from '../src/platforms/naver_store.js';

const bcryptStub = { hashSync: (value, salt) => `hashed(${value}|${salt})` };
// 네이버 client_secret 은 그 자체가 bcrypt salt 다. 더미도 같은 형식이어야 sign() 가드를 지난다.
const SALT = '$2a$04$uSbYAXyKyJjPVDzRl.Ie';
const baseConfig = { clientId: 'CID', clientSecret: SALT, accountId: 'ncp_acc', type: 'SELLER' };

function jsonResponse(status, body, { text = null } = {}) {
  return {
    status,
    text: async () => (text !== null ? text : JSON.stringify(body))
  };
}

// 호출 기록을 남기는 fetch 모의. handlers 는 순서대로 소비된다.
function mockFetch(handlers) {
  const calls = [];
  const queue = [...handlers];
  const impl = async (url, options) => {
    calls.push({ url, options });
    const next = queue.shift();
    if (!next) throw new Error(`예상하지 못한 추가 요청: ${url}`);
    return typeof next === 'function' ? next(url, options) : next;
  };
  impl.calls = calls;
  return impl;
}

const tokenOk = () => jsonResponse(200, { access_token: 'AT', expires_in: 10800 });

test('토큰 요청은 문서가 요구하는 폼 필드를 모두 담는다', async () => {
  const fetchImpl = mockFetch([tokenOk()]);
  const api = new NaverAPI(baseConfig, { fetchImpl, bcrypt: bcryptStub });
  await api.token();

  const { url, options } = fetchImpl.calls[0];
  assert.ok(url.endsWith(TOKEN_PATH), `토큰 경로가 ${TOKEN_PATH} 여야 한다`);
  assert.equal(options.headers['Content-Type'], 'application/x-www-form-urlencoded');
  const sent = new URLSearchParams(options.body);
  assert.equal(sent.get('client_id'), 'CID');
  assert.equal(sent.get('grant_type'), 'client_credentials');
  assert.equal(sent.get('type'), 'SELLER');
  assert.equal(sent.get('account_id'), 'ncp_acc');
  assert.ok(sent.get('timestamp'), 'timestamp 가 있어야 한다');
  // 서명은 clientId_timestamp 를 clientSecret 을 salt 로 해싱한 뒤 base64.
  const expected = Buffer.from(`hashed(CID_${sent.get('timestamp')}|${SALT})`, 'utf-8').toString('base64');
  assert.equal(sent.get('client_secret_sign'), expected);
});

test('$ 가 소실된 Client Secret 은 전송 전에 잡아 원인을 알려준다', async () => {
  const fetchImpl = mockFetch([]);
  // PowerShell 큰따옴표가 $2a$04$ 를 먹으면 이런 값이 남는다.
  const api = new NaverAPI({ ...baseConfig, clientSecret: '04uSbYAXyKyJjPVDzRl.Ie' }, { fetchImpl, bcrypt: bcryptStub });
  await assert.rejects(() => api.token(), err => {
    assert.match(err.message, /bcrypt salt 형식이 아닙니다/);
    assert.match(err.message, /작은따옴표/);
    return true;
  });
  assert.equal(fetchImpl.calls.length, 0, '망가진 키로 네트워크를 쓰지 않는다');
});

test('timestamp 는 발급마다 새로 만든다 (5분 만료)', async () => {
  const fetchImpl = mockFetch([tokenOk(), tokenOk()]);
  const api = new NaverAPI(baseConfig, { fetchImpl, bcrypt: bcryptStub });
  await api.tokenRequest();
  const first = new URLSearchParams(fetchImpl.calls[0].options.body).get('timestamp');
  await new Promise(r => setTimeout(r, 2));
  await api.tokenRequest();
  const second = new URLSearchParams(fetchImpl.calls[1].options.body).get('timestamp');
  assert.notEqual(first, second, 'timestamp 를 캐시하면 안 된다');
});

test('type=SELLER 인데 account_id 가 없으면 전송 전에 막는다', async () => {
  const fetchImpl = mockFetch([]);
  const api = new NaverAPI({ ...baseConfig, accountId: '' }, { fetchImpl, bcrypt: bcryptStub });
  await assert.rejects(() => api.token(), /판매자 ID\(account_id\)가 필요합니다/);
  assert.equal(fetchImpl.calls.length, 0);
});

test('type=SELF 는 account_id 없이도 발급을 시도한다', async () => {
  const fetchImpl = mockFetch([tokenOk()]);
  const api = new NaverAPI({ ...baseConfig, type: 'SELF', accountId: '' }, { fetchImpl, bcrypt: bcryptStub });
  await api.token();
  const sent = new URLSearchParams(fetchImpl.calls[0].options.body);
  assert.equal(sent.get('type'), 'SELF');
  assert.equal(sent.get('account_id'), null);
});

test('동시 호출은 토큰을 한 번만 발급받는다', async () => {
  let issued = 0;
  const fetchImpl = mockFetch([async () => { issued++; return tokenOk(); }]);
  const api = new NaverAPI(baseConfig, { fetchImpl, bcrypt: bcryptStub });
  await Promise.all([api.token(), api.token(), api.token()]);
  assert.equal(issued, 1);
});

test('유효기간 안에서는 저장된 토큰을 재사용한다', async () => {
  const fetchImpl = mockFetch([tokenOk()]);
  const api = new NaverAPI(baseConfig, { fetchImpl, bcrypt: bcryptStub });
  assert.equal(await api.token(), 'AT');
  assert.equal(await api.token(), 'AT');
  assert.equal(fetchImpl.calls.length, 1);
});

test('access_token 이 없으면 본문을 노출하지 않고 오류 필드만 알린다', async () => {
  const fetchImpl = mockFetch([jsonResponse(400, { code: 'GW.AUTHENTICATION_FAILURE', message: '서명 불일치' })]);
  const api = new NaverAPI(baseConfig, { fetchImpl, bcrypt: bcryptStub });
  await assert.rejects(() => api.token(), err => {
    assert.match(err.message, /HTTP 400/);
    assert.match(err.message, /GW\.AUTHENTICATION_FAILURE/);
    assert.match(err.message, /서명 불일치/);
    return true;
  });
});

test('프록시가 있으면 토큰 발급도 프록시를 거친다 (네이버 IP 허용목록)', async () => {
  const fetchImpl = mockFetch([tokenOk()]);
  const api = new NaverAPI(baseConfig, {
    fetchImpl, bcrypt: bcryptStub,
    proxy: { proxyUrl: 'https://admin.example.test/', proxyToken: 'STAFF' }
  });
  await api.token();

  const { url, options } = fetchImpl.calls[0];
  assert.equal(url, 'https://admin.example.test/naver');
  assert.equal(options.headers.Authorization, 'Bearer STAFF');
  const envelope = JSON.parse(options.body);
  assert.equal(envelope.method, 'POST');
  assert.equal(envelope.path, TOKEN_PATH, 'proxy.py 의 naver 항목은 path 형식을 받는다');
  // 직원 토큰은 상단으로 넘어가면 안 된다.
  assert.notEqual(envelope.headers?.Authorization, 'Bearer STAFF');
});

test('프록시 토큰이 없으면 요청 자체를 만들지 않는다', async () => {
  const fetchImpl = mockFetch([]);
  const api = new NaverAPI(baseConfig, { fetchImpl, bcrypt: bcryptStub, proxy: { proxyUrl: 'https://admin.example.test' } });
  await assert.rejects(() => api.token(), /직원 계정으로 다시 로그인/);
  assert.equal(fetchImpl.calls.length, 0);
});

test('API 경로에는 /external 접두사가 붙는다', async () => {
  const fetchImpl = mockFetch([tokenOk(), jsonResponse(200, { contents: [] })]);
  const api = new NaverAPI(baseConfig, { fetchImpl, bcrypt: bcryptStub });
  await api.searchProducts({ page: 1 });
  assert.ok(fetchImpl.calls[1].url.endsWith(`${API_PREFIX}/v1/products/search`), fetchImpl.calls[1].url);
  assert.equal(fetchImpl.calls[1].options.headers.Authorization, 'Bearer AT');
});

test('401 이면 토큰을 한 번 다시 받고 재시도한다', async () => {
  const fetchImpl = mockFetch([
    tokenOk(),
    jsonResponse(401, { code: 'EXPIRED' }),
    jsonResponse(200, { access_token: 'AT2', expires_in: 10800 }),
    jsonResponse(200, { originProductNo: 5 })
  ]);
  const api = new NaverAPI(baseConfig, { fetchImpl, bcrypt: bcryptStub });
  assert.deepEqual(await api.originProduct(5), { originProductNo: 5 });
  assert.equal(fetchImpl.calls.length, 4);
});

test('조회는 5xx 를 재시도하지만 변경 요청은 재시도하지 않는다', async () => {
  const search = mockFetch([tokenOk(), jsonResponse(503, {}), jsonResponse(200, { contents: [1] })]);
  const api = new NaverAPI(baseConfig, { fetchImpl: search, bcrypt: bcryptStub, sleep: async () => {} });
  assert.deepEqual(await api.searchProducts(), { contents: [1] });

  const write = mockFetch([tokenOk(), jsonResponse(503, { code: 'X', message: '일시 오류' })]);
  const api2 = new NaverAPI(baseConfig, { fetchImpl: write, bcrypt: bcryptStub, sleep: async () => {} });
  await assert.rejects(() => api2.request('PUT', '/v2/products/origin-products/9', { a: 1 }), NaverAPIError);
  assert.equal(write.calls.length, 2, '변경 요청은 한 번만 나가야 한다');
});

test('프록시 자신의 오류는 마켓플레이스 오류와 구분된다', async () => {
  const fetchImpl = mockFetch([jsonResponse(401, { proxyError: true, message: '인증 필요(토큰 없음/만료)' })]);
  const api = new NaverAPI(baseConfig, {
    fetchImpl, bcrypt: bcryptStub,
    proxy: { proxyUrl: 'https://admin.example.test', proxyToken: 'STAFF' }
  });
  await assert.rejects(() => api.token(), err => {
    assert.equal(err.proxyError, true);
    assert.match(err.message, /서버 프록시 오류/);
    return true;
  });
});

test('/naver 경로가 미배포면 그렇게 안내한다', async () => {
  const fetchImpl = mockFetch([jsonResponse(404, { detail: 'Not Found' })]);
  const api = new NaverAPI(baseConfig, {
    fetchImpl, bcrypt: bcryptStub,
    proxy: { proxyUrl: 'https://admin.example.test', proxyToken: 'STAFF' }
  });
  await assert.rejects(() => api.token(), /\/naver 프록시 경로가 없습니다/);
});

test('NaverAPIError 는 invalidInputs 까지 사람이 읽을 수 있게 편다', () => {
  const err = new NaverAPIError(400, {
    code: 'PRODUCT.INVALID', message: '상품 정보 오류',
    invalidInputs: [{ name: 'originProduct.name', message: '필수값입니다' }]
  });
  assert.match(err.message, /PRODUCT\.INVALID/);
  assert.match(err.message, /originProduct\.name/);
  assert.match(err.message, /필수값입니다/);
  assert.equal(err.status, 400);
});

test('JSON 이 아닌 응답은 상태코드를 잃지 않는다', async () => {
  const fetchImpl = mockFetch([jsonResponse(502, null, { text: '<html>gateway</html>' })]);
  const api = new NaverAPI(baseConfig, { fetchImpl, bcrypt: bcryptStub });
  await assert.rejects(() => api.token(), /HTTP 502/);
});

test('잘못된 API 경로는 전송 전에 막는다', async () => {
  const fetchImpl = mockFetch([]);
  const api = new NaverAPI(baseConfig, { fetchImpl, bcrypt: bcryptStub });
  await assert.rejects(() => api.request('GET', '//evil.example'), /잘못된 API 경로/);
  await assert.rejects(() => api.request('GET', 'v1/x'), /잘못된 API 경로/);
  assert.equal(fetchImpl.calls.length, 0);
});


// ── 상품 조회 매핑 (실계정 응답 구조 기준) ──────────────────────────
const channel = (over = {}) => ({
  originProductNo: 8678532454, channelProductNo: 8719674340, channelServiceType: 'STOREFARM',
  categoryId: '50007071', name: '네오키위 이젤 디자인 스마트 사이니지 장기렌탈', statusType: 'SALE',
  salePrice: 400000, stockQuantity: 99, brandName: '키위KIWI', modelName: '이젤 디자인 디지털 사이니지',
  representativeImage: { url: 'https://x/y.jpg' }, ...over
});
const searchPage = (items, over = {}) => ({
  contents: items, page: 1, size: 100, totalElements: items.length, totalPages: 1,
  first: true, last: true, ...over
});

test('상품 목록을 기존 계약(id·name)으로 변환한다', async () => {
  const fetchImpl = mockFetch([tokenOk(), jsonResponse(200, searchPage([
    { originProductNo: 8678532454, channelProducts: [channel()] }
  ]))]);
  const api = new NaverAPI(baseConfig, { fetchImpl, bcrypt: bcryptStub });
  const rows = await api.allProducts();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, '8678532454', 'id 는 원상품번호 문자열');
  assert.equal(rows[0].name, '네오키위 이젤 디자인 스마트 사이니지 장기렌탈');
  assert.equal(rows[0].channelProductNo, 8719674340);
  assert.equal(rows[0].salePrice, 400000);
  assert.equal(rows[0].stockQuantity, 99);
});

test('여러 페이지를 끝까지 모으고 원상품번호로 중복을 없앤다', async () => {
  const fetchImpl = mockFetch([
    tokenOk(),
    jsonResponse(200, searchPage([{ originProductNo: 1, channelProducts: [channel({ originProductNo: 1, name: 'A' })] }],
      { page: 1, totalPages: 2, last: false })),
    // 2페이지에 1번이 다시 나와도 한 번만 남아야 한다.
    jsonResponse(200, searchPage([
      { originProductNo: 1, channelProducts: [channel({ originProductNo: 1, name: 'A' })] },
      { originProductNo: 2, channelProducts: [channel({ originProductNo: 2, name: 'B' })] }
    ], { page: 2, totalPages: 2, last: true }))
  ]);
  const api = new NaverAPI(baseConfig, { fetchImpl, bcrypt: bcryptStub });
  const rows = await api.allProducts();
  assert.deepEqual(rows.map(r => r.name), ['A', 'B']);
});

test('제조사·차종 필터는 공백을 무시하고 둘 다 포함해야 통과한다', async () => {
  const page = searchPage([
    { originProductNo: 1, channelProducts: [channel({ originProductNo: 1, name: '벤츠 E클래스 브레이크 패드' })] },
    { originProductNo: 2, channelProducts: [channel({ originProductNo: 2, name: '벤츠 C클래스 브레이크 패드' })] },
    { originProductNo: 3, channelProducts: [channel({ originProductNo: 3, name: 'BMW E클래스 호환' })] }
  ]);
  const run = async (brand, model) => {
    const fetchImpl = mockFetch([tokenOk(), jsonResponse(200, page)]);
    const api = new NaverAPI(baseConfig, { fetchImpl, bcrypt: bcryptStub });
    return (await api.searchProductsByName(brand, model)).map(r => r.id);
  };
  assert.deepEqual(await run('벤츠', 'E클래스'), ['1']);
  assert.deepEqual(await run('벤 츠', 'E 클래스'), ['1'], '공백은 무시한다');
  assert.deepEqual(await run('벤츠', ''), ['1', '2'], '한쪽만 주면 그것만 본다');
  assert.deepEqual(await run('', '클래스'), ['1', '2', '3']);
});

test('제조사와 차종이 모두 비면 조회하지 않고 막는다', async () => {
  const fetchImpl = mockFetch([]);
  const api = new NaverAPI(baseConfig, { fetchImpl, bcrypt: bcryptStub });
  await assert.rejects(() => api.searchProductsByName('', '  '), /제조사 또는 차종/);
  assert.equal(fetchImpl.calls.length, 0);
});

test('채널상품이 없는 원상품은 이름 없이도 건너뛰지 않는다', async () => {
  const fetchImpl = mockFetch([tokenOk(), jsonResponse(200, searchPage([
    { originProductNo: 777, channelProducts: [] }
  ]))]);
  const api = new NaverAPI(baseConfig, { fetchImpl, bcrypt: bcryptStub });
  const rows = await api.allProducts();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, '777');
  assert.equal(rows[0].name, '');
});

test('목록은 5분간 캐시되어 왕복이 늘지 않는다', async () => {
  const page = searchPage([{ originProductNo: 1, channelProducts: [channel({ originProductNo: 1 })] }]);
  const fetchImpl = mockFetch([tokenOk(), jsonResponse(200, page)]);
  const api = new NaverAPI(baseConfig, { fetchImpl, bcrypt: bcryptStub });
  await api.allProducts();
  await api.allProducts();
  await api.searchProductsByName('네오키위', '');
  assert.equal(fetchImpl.calls.length, 2, '토큰 1회 + 목록 1회만 나가야 한다');
});

test('force 또는 무효화 후에는 다시 읽는다', async () => {
  const page = searchPage([{ originProductNo: 1, channelProducts: [channel({ originProductNo: 1 })] }]);
  const fetchImpl = mockFetch([tokenOk(), jsonResponse(200, page), jsonResponse(200, page)]);
  const api = new NaverAPI(baseConfig, { fetchImpl, bcrypt: bcryptStub });
  await api.allProducts();
  api.invalidateProducts();
  await api.allProducts();
  assert.equal(fetchImpl.calls.length, 3);
});

test('상한에 걸려 일부만 읽으면 조용히 넘기지 않고 실패시킨다', async () => {
  // last:false 가 계속 오는 상황 — 실제로는 페이지가 계속 남아 있다는 뜻.
  const endless = () => jsonResponse(200, searchPage(
    [{ originProductNo: Math.random(), channelProducts: [channel()] }],
    { totalPages: 999, last: false }
  ));
  const fetchImpl = mockFetch([tokenOk(), endless(), endless()]);
  const api = new NaverAPI(baseConfig, { fetchImpl, bcrypt: bcryptStub });
  await assert.rejects(() => api.allProducts({ pageSize: 1, maxPages: 2 }), /전부 읽지 못했습니다/);
});

test('진행 콜백으로 수집 건수를 알린다', async () => {
  const fetchImpl = mockFetch([tokenOk(), jsonResponse(200, searchPage(
    [{ originProductNo: 1, channelProducts: [channel({ originProductNo: 1 })] }], { totalElements: 1826 }))]);
  const api = new NaverAPI(baseConfig, { fetchImpl, bcrypt: bcryptStub });
  const seen = [];
  await api.allProducts({ onProgress: (n, total) => seen.push([n, total]) });
  assert.deepEqual(seen, [[1, 1826]]);
});

// ── 자격증명 저장 ────────────────────────────────────────────────
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: s => Buffer.from(`enc:${s}`),
  decryptString: b => b.toString().replace(/^enc:/, '')
};
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'naver-store-'));

test('Client Secret 은 암호화되어 저장되고 평문으로 파일에 남지 않는다', () => {
  const dir = tempDir();
  const store = new NaverStore(dir, safeStorage);
  const shown = store.save({ clientId: 'CID', clientSecret: 'SECRET', accountId: 'acc' });
  assert.equal(shown.hasClientSecret, true);
  assert.equal(shown.clientSecret, undefined, 'UI 로 비밀값을 돌려주면 안 된다');

  const raw = fs.readFileSync(path.join(dir, 'naver_config.json'), 'utf8');
  assert.ok(!raw.includes('SECRET'), '평문 비밀값이 파일에 있으면 안 된다');
  assert.equal(store.config().clientSecret, 'SECRET');
});

test('빈 입력은 저장된 비밀값을 지우지 않는다', () => {
  const store = new NaverStore(tempDir(), safeStorage);
  store.save({ clientId: 'CID', clientSecret: 'SECRET' });
  store.save({ clientId: 'CID', clientSecret: '   ' });
  assert.equal(store.config().clientSecret, 'SECRET');
});

test('Client ID 가 바뀌면 이전 Secret 을 버린다', () => {
  const store = new NaverStore(tempDir(), safeStorage);
  store.save({ clientId: 'CID', clientSecret: 'SECRET' });
  const after = store.save({ clientId: 'OTHER' });
  assert.equal(after.hasClientSecret, false);
});

test('연결 해제는 Secret 만 지운다', () => {
  const store = new NaverStore(tempDir(), safeStorage);
  store.save({ clientId: 'CID', clientSecret: 'SECRET', accountId: 'acc' });
  const after = store.save({ disconnect: true });
  assert.equal(after.hasClientSecret, false);
  assert.equal(after.clientId, 'CID');
  assert.equal(after.accountId, 'acc');
});

test('암호화 저장소를 못 쓰면 저장하지 않고 실패한다', () => {
  const store = new NaverStore(tempDir(), { ...safeStorage, isEncryptionAvailable: () => false });
  assert.throws(() => store.save({ clientId: 'CID', clientSecret: 'SECRET' }), /암호화 저장소/);
});

for (const server of [false, true]) {
  test('IP 차단은 호출 경로를 안내하고 재시도하지 않는다: ' + (server ? '서버' : 'PC'), async () => {
    for (const phase of ['token', 'product']) {
      const blocked = jsonResponse(403, {
        code: 'GW.IP_NOT_ALLOWED', message: '호출이 허용되지 않은 IP입니다.',
        access_token: 'DO_NOT_EXPOSE'
      });
      blocked.headers = { get: () => 'trace-fixture' };
      const fetchImpl = mockFetch(phase === 'token' ? [blocked] : [tokenOk(), blocked]);
      const api = new NaverAPI(baseConfig, { fetchImpl, bcrypt: bcryptStub,
        proxy: server ? { proxyUrl: 'https://proxy.example.test', proxyToken: 'STAFF' } : {} });
      await assert.rejects(() => phase === 'token' ? api.token() : api.searchProducts(), e => {
        assert.ok(e instanceof NaverAPIError);
        assert.equal(e.status, 403);
        assert.equal(e.code, 'GW.IP_NOT_ALLOWED');
        assert.equal(e.traceId, 'trace-fixture');
        assert.match(e.message, server ? /프록시 서버의 외부 IPv4/ : /이 PC의 외부 IPv4/);
        assert.doesNotMatch(e.message, /전자서명|DO_NOT_EXPOSE|STAFF/);
        return true;
      });
      assert.equal(fetchImpl.calls.length, phase === 'token' ? 1 : 2);
    }
  });
  test('외부 IP 조회는 해당 경로를 사용하며 네이버 키를 전송하지 않는다: ' + server, async () => {
    const fetchImpl = mockFetch([server
      ? jsonResponse(200, { outboundIp: '203.0.113.7' })
      : jsonResponse(200, null, { text: '203.0.113.7\n' })]);
    const api = new NaverAPI(baseConfig, { fetchImpl,
      proxy: server ? { proxyUrl: 'https://proxy.example.test/', proxyToken: 'STAFF' } : {} });
    const info = await api.connectionDiagnostics();
    assert.equal(info.outboundIp, '203.0.113.7');
    assert.equal(info.mode, server ? 'proxy' : 'direct');
    assert.equal(fetchImpl.calls[0].url, server ? 'https://proxy.example.test/proxy/health' : 'https://api.ipify.org');
    assert.equal(fetchImpl.calls[0].options.body, undefined);
    assert.equal(fetchImpl.calls[0].options.headers?.Authorization, server ? 'Bearer STAFF' : undefined);
    assert.ok(!JSON.stringify(fetchImpl.calls).includes(SALT));
    assert.ok(!JSON.stringify(info).includes('STAFF'));
  });
}

test('외부 IP 확인 실패나 잘못된 IPv4가 인증 진단을 막지 않는다', async () => {
  for (const response of [
    jsonResponse(200, null, { text: '999.0.0.1' }),
    jsonResponse(200, null, { text: '<html>error</html>' }),
    jsonResponse(503, {}),
    () => { throw new TypeError('offline'); }
  ]) {
    const api = new NaverAPI(baseConfig, { fetchImpl: mockFetch([response, tokenOk()]), bcrypt: bcryptStub });
    assert.equal((await api.connectionDiagnostics()).outboundIp, undefined);
    await api.tokenRequest();
  }
});
