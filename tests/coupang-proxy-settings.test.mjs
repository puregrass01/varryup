// 쿠팡 고정 IP 프록시가 **설정 저장 뒤에도** 유지되는가.
//
// 왜 이 테스트가 있나
//   쿠팡은 IP 허용목록을 쓴다. 직원 PC 의 IP 는 목록에 없으므로 직접 호출하면
//   403 "Your ip address ... is not allowed" 가 난다. 그래서 모든 호출은 고정 IP 를
//   가진 관리자 서버 릴레이를 타야 한다 — 선택이 아니라 필수다.
//
//   그런데 saveConfig() 가 CoupangAPI 를 **인자 4개**로 다시 만들면서 5번째인 proxy 를
//   조용히 떨어뜨렸다. 결과: 직원이 쿠팡 설정을 저장하는 순간부터 앱을 다시 켤 때까지
//   모든 호출이 PC IP 로 나가 403. 화면에는 쿠팡 원문만 떠서 원인을 짚기 어려웠다.
//   (아마존은 같은 자리를 이미 고쳤는데 쿠팡에는 적용되지 않았다)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Coupang } from '../src/platforms/coupang.js';

const BASE = { vendorId: 'A00012345', accessKey: 'ak-live', secretKey: 'sk-live' };

function fixture(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coupang-proxy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'coupang_config.json');
  fs.writeFileSync(file, JSON.stringify({ ...BASE, ...extra }));
  return new Coupang(file);
}

test('로그인으로 주입된 runtimeProxy 가 loadConfig 에서 API 에 전달된다', t => {
  const c = fixture(t);
  c.runtimeProxy = { proxyUrl: 'https://admin.example', proxyToken: 'staff-token' };
  c.loadConfig();
  assert.equal(c.api.proxyUrl, 'https://admin.example');
  assert.equal(c.api.proxyToken, 'staff-token');
});

test('설정을 저장해도 프록시가 유지된다 (회귀: 인자 4개로 재생성해 proxy 가 빠졌었다)', t => {
  const c = fixture(t);
  c.runtimeProxy = { proxyUrl: 'https://admin.example', proxyToken: 'staff-token' };
  c.loadConfig();

  c.saveConfig({ vendorId: 'A00099999' });   // 직원이 화면에서 설정을 바꿔 저장

  assert.equal(c.api.proxyUrl, 'https://admin.example',
    '저장 후 프록시가 비면 이때부터 쿠팡 호출이 PC IP 로 직접 나가 403 이 된다');
  assert.equal(c.api.proxyToken, 'staff-token');
  assert.equal(c.api.vendorId, 'A00099999', '바뀐 설정도 반영돼야 한다');
});

test('runtimeProxy 가 설정 파일 값보다 우선한다', t => {
  const c = fixture(t, { proxyUrl: 'https://stale-from-disk', proxyToken: 'stale' });
  c.runtimeProxy = { proxyUrl: 'https://admin.example', proxyToken: 'fresh' };
  c.loadConfig();
  assert.equal(c.api.proxyUrl, 'https://admin.example');
  c.saveConfig({});
  assert.equal(c.api.proxyUrl, 'https://admin.example', '저장 뒤에도 우선순위가 같아야 한다');
});

test('로그인 전(runtimeProxy 없음)에는 설정 파일 값으로 떨어진다', t => {
  const c = fixture(t, { proxyUrl: 'https://from-disk', proxyToken: 'disk-token' });
  c.loadConfig();
  assert.equal(c.api.proxyUrl, 'https://from-disk');
  c.saveConfig({});
  assert.equal(c.api.proxyUrl, 'https://from-disk');
});

test('프록시가 아예 없으면 빈 문자열 — 직접 호출로 떨어진다', t => {
  const c = fixture(t);
  c.loadConfig();
  assert.equal(c.api.proxyUrl, '');
  c.saveConfig({});
  assert.equal(c.api.proxyUrl, '', '없는 것과 잃어버린 것을 구분할 수 있어야 한다');
});

test('직원 토큰이 설정 파일로 새지 않는다', t => {
  const c = fixture(t);
  c.runtimeProxy = { proxyUrl: 'https://admin.example', proxyToken: 'staff-token-secret' };
  c.loadConfig();
  c.saveConfig({ vendorId: 'A00099999' });

  const onDisk = fs.readFileSync(c.configPath, 'utf8');
  assert.ok(!onDisk.includes('staff-token-secret'),
    '로그인 토큰은 메모리에만 있어야 한다 — 디스크에 남으면 설치본 유출 시 같이 샌다');
});
