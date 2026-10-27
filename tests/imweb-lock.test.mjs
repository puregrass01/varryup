// 아임웹 공용 잠금 — 베리업과 베리맵 수집기가 같은 앱 토큰을 동시에 받지 않게 한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { createImwebLock } from '../src/utils/imweb_lock.js';

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imweb-lock-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'imweb_api.lock');
}

test('잡으면 pid 를 적고, 다른 살아 있는 프로세스가 쥐고 있으면 거절, 주인이 죽었으면 가져간다', async t => {
  const file = temp(t);
  const lock = createImwebLock(file);
  lock.acquire();
  assert.equal(fs.readFileSync(file, 'utf8'), String(process.pid));
  lock.acquire();   // 이미 쥐고 있으면 그대로
  lock.release();
  assert.equal(fs.existsSync(file), false);

  fs.writeFileSync(file, String(process.ppid));   // 살아 있는 남의 프로세스
  assert.throws(() => lock.acquire(), /아임웹을 쓰는 중/);
  assert.equal(fs.readFileSync(file, 'utf8'), String(process.ppid), '남의 잠금은 건드리지 않는다');
  lock.release();
  assert.equal(fs.existsSync(file), true, '쥐지 않은 잠금은 풀지 않는다');

  const dead = spawnSync(process.execPath, ['-e', '']).pid;   // 이미 끝난 프로세스
  fs.writeFileSync(file, String(dead));
  lock.acquire();
  assert.equal(fs.readFileSync(file, 'utf8'), String(process.pid));
  lock.release();
});

test('pid 가 살아 있어도 파일 시각이 2분 넘게 멈췄으면 남겨진 잠금으로 보고 가져간다(재부팅 뒤 pid 재사용)', async t => {
  const file = temp(t);
  const lock = createImwebLock(file);
  fs.writeFileSync(file, String(process.ppid));   // 살아 있는 남의 pid
  assert.throws(() => lock.acquire(), e => e.message.includes(file), '막힐 때는 지울 파일을 알려 준다');
  const old = new Date(Date.now() - 3 * 60 * 1000);
  fs.utimesSync(file, old, old);
  lock.acquire();
  assert.equal(fs.readFileSync(file, 'utf8'), String(process.pid));
  lock.release();
});

test('쥐고 있던 잠금을 남이 가져갔으면 다음 acquire 가 계속 쓰지 않고 거절한다(둘이 같이 쓰지 않게)', async t => {
  const file = temp(t);
  const lock = createImwebLock(file);
  lock.acquire();
  fs.writeFileSync(file, String(process.ppid));   // 남겨진 잠금으로 오해한 다른 프로세스가 가져간 상태
  assert.throws(() => lock.acquire(), /아임웹을 쓰는 중/);
  assert.equal(lock.held, false);
  assert.equal(fs.readFileSync(file, 'utf8'), String(process.ppid), '남의 잠금은 지우지 않는다');
});

test('idleMs 동안 조용하면 스스로 놓는다(베리업 쪽)', async t => {
  const file = temp(t);
  const lock = createImwebLock(file, { idleMs: 20 });
  lock.acquire();
  await new Promise(r => setTimeout(r, 60));
  assert.equal(lock.held, false);
  assert.equal(fs.existsSync(file), false);
});
