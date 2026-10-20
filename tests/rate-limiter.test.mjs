// 플랫폼 API 호출 간격 조절(src/utils/rate_limiter.js). 네트워크는 쓰지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apiTemplate, coolDown, paceCall, resetPacing } from '../src/utils/rate_limiter.js';
import { errorKind } from '../src/utils/api_error.js';
import { Coupang } from '../src/platforms/coupang.js';
import { NaverAPI } from '../src/platforms/naver_api.js';

test('경로의 번호·ID 를 지워 같은 API 끼리 묶는다', () => {
  assert.equal(apiTemplate('/external/v2/products/origin-products/123'), '/external/v2/products/origin-products/{id}');
  assert.equal(apiTemplate('https://sellingpartnerapi-na.amazon.com/listings/2021-08-01/items/A1B2C3D4E5F6G7/SKU-1?x=1'),
    '/listings/2021-08-01/items/{id}/SKU-1');
  assert.equal(apiTemplate('/external/v1/products/search'), '/external/v1/products/search');
});

test('같은 key 는 예약 순서대로 간격을 두고, 다른 key 는 기다리지 않는다', async () => {
  resetPacing();
  let clock = 1000;
  const waits = [];
  const opts = { now: () => clock, sleep: async ms => { waits.push(ms); } };
  await paceCall('k', 500, opts);
  await paceCall('k', 500, opts);
  await paceCall('k', 500, opts);
  await paceCall('other', 500, opts);
  assert.deepEqual(waits, [500, 1000], '동시에 불러도 두 번째는 500ms, 세 번째는 1000ms 뒤');
  clock += 5000;
  await paceCall('k', 500, opts);
  assert.equal(waits.length, 2, '간격이 이미 지났으면 기다리지 않는다');
});

test('429 로 쉬는 동안에는 기다리지 않고 바로 호출 한도 오류로 알린다', async () => {
  resetPacing();
  let clock = 0;
  coolDown('coupang:V', 60000, { now: () => clock });
  clock = 10000;
  await assert.rejects(paceCall('coupang:V', 250, { now: () => clock, label: '쿠팡' }), e => {
    assert.match(e.message, /쿠팡 호출 한도.*50초 뒤/);
    assert.equal(errorKind(e), 'RATE_LIMIT');
    return true;
  });
  clock = 61000;
  await paceCall('coupang:V', 250, { now: () => clock });
});

test('쿠팡이 429 를 주면 그 판매자로는 1분간 보내지 않는다', async t => {
  resetPacing();
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rate-coupang-')), 'coupang_config.json');
  t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));
  fs.writeFileSync(file, JSON.stringify({ vendorId: 'A00077777', accessKey: 'ak', secretKey: 'sk' }));
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response(JSON.stringify({ code: 'ERROR', message: 'too many' }), { status: 429 }); });
  const coupang = new Coupang(file); coupang.loadConfig();
  await assert.rejects(coupang.api.getItemInventory('555'), e => { assert.equal(errorKind(e), 'RATE_LIMIT'); return true; });
  await assert.rejects(coupang.api.getItemInventory('556'), /잠시 멈춘 상태/);
  assert.equal(calls, 1, '쉬는 동안에는 쿠팡에 다시 보내지 않는다');
  resetPacing();
});

test('네이버는 같은 API 호출 사이에 간격을 둔다(토큰 발급은 따로 센다)', async () => {
  resetPacing();
  const waits = [];
  const replies = [{ access_token: 'AT', expires_in: 10800 }, { originProduct: {} }, { originProduct: {} }];
  const fetchImpl = async () => ({ status: 200, text: async () => JSON.stringify(replies.shift()) });
  const api = new NaverAPI({ clientId: 'CID', clientSecret: '$2a$04$uSbYAXyKyJjPVDzRl.Ie', type: 'SELF' },
    { fetchImpl, bcrypt: { hashSync: (v, s) => `h(${v}|${s})` }, sleep: async ms => { waits.push(ms); } });
  await api.originProduct(1);
  await api.originProduct(2);
  assert.equal(waits.length, 1, '토큰 발급과 첫 조회는 다른 API 라 기다리지 않고, 두 번째 조회만 기다린다');
  assert.ok(waits[0] > 400 && waits[0] <= 550, String(waits[0]));
});
