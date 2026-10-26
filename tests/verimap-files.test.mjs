// 베리맵 파일 읽기·쓰기 — 손으로 확인한 링크(manual_links.json)를 잃지 않는지, CSV 를 열이 밀리지 않게 읽는지.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readCsv } from '../scripts/verimap_csv.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verimap-files-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// index_verimap.html 은 렌더러 인라인 스크립트라 import 할 수 없다 — 수동 확인 부분만 잘라 실행한다.
function manualModule(DIR) {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'index_verimap.html'), 'utf8');
  const start = html.indexOf('const MANUAL_F');
  const end = html.indexOf('// 열쇠를 행 번호로', start);
  assert.ok(start > 0 && end > start, 'index_verimap.html 에서 수동 확인 코드를 찾지 못했습니다');
  const logs = [];
  const log = (msg, cls) => logs.push({ msg, cls });
  const m = new Function('fs', 'path', 'DIR', 'log', html.slice(start, end)
    + '\nreturn { loadManual, saveManual, get: () => MANUAL, broken: () => MANUAL_BROKEN };')(fs, path, DIR, log);
  return { ...m, logs, file: path.join(DIR, 'manual_links.json') };
}

test('수동 확인: 파일이 없으면 빈 목록, 저장은 tmp 를 거쳐 바꿔 끼운다', t => {
  const dir = path.join(temp(t), 'verimap');
  const m = manualModule(dir);
  m.loadManual();
  assert.deepEqual(m.get(), {});
  assert.equal(m.broken(), false);
  m.get()['k|ch'] = { s: 'ok', v: 'https://example.com/1' };
  m.saveManual();
  assert.deepEqual(JSON.parse(fs.readFileSync(m.file, 'utf8')), { 'k|ch': { s: 'ok', v: 'https://example.com/1' } });
  assert.deepEqual(fs.readdirSync(dir), ['manual_links.json'], 'tmp 가 남지 않는다');
  assert.equal(m.logs.length, 0);
});

test('수동 확인: 예전 문자열 값은 지금 형식으로 읽는다', t => {
  const dir = temp(t);
  fs.writeFileSync(path.join(dir, 'manual_links.json'), JSON.stringify({ a: 'https://x', b: { s: 'no', v: '' } }));
  const m = manualModule(dir);
  m.loadManual();
  assert.deepEqual(m.get(), { a: { s: 'ok', v: 'https://x' }, b: { s: 'no', v: '' } });
  assert.equal(m.broken(), false);
});

for (const [name, body] of [['깨진 JSON', '{"a": {"s": "ok", "v": "https://x"'], ['객체가 아닌 JSON', 'null']]) {
  test(`수동 확인: ${name} 이면 옆으로 옮겨 보존하고, 빈 목록으로 덮어쓰지 않는다`, t => {
    const dir = temp(t);
    const m = manualModule(dir);
    fs.writeFileSync(m.file, body);
    m.loadManual();
    assert.deepEqual(m.get(), {});
    assert.equal(m.broken(), true);
    const moved = fs.readdirSync(dir).filter(f => /^manual_links\.json\.corrupt-\d+$/.test(f));
    assert.equal(moved.length, 1, '깨진 파일을 .corrupt-시각 으로 옮긴다');
    assert.equal(fs.readFileSync(path.join(dir, moved[0]), 'utf8'), body, '내용은 그대로');
    assert.match(m.logs[0].msg, /^✖ .*manual_links\.json.*저장을 막습니다/);
    assert.equal(m.logs[0].cls, 'err');

    m.get().x = { s: 'ok', v: '' };
    m.saveManual();
    assert.equal(fs.existsSync(m.file), false, '저장을 거부한다');
    assert.match(m.logs.at(-1).msg, /^✖ .*저장하지 않았습니다/);

    // 되돌리지 않은 채 다시 불러와도(대조가 끝나면 자동으로 다시 부른다) 옮겨 둔 사본이 남아 있으면 계속 막는다
    m.loadManual();
    assert.equal(m.broken(), true);
    assert.match(m.logs.at(-1).msg, /^✖ 깨져서 옮겨 둔 수동 확인 목록이 남아 있습니다/);
    m.saveManual();
    assert.equal(fs.existsSync(m.file), false, '새 파일을 만들지 않는다 — 나중에 되돌린 사본이 덮어쓴다');

    // 고쳐서 되돌리고 다시 불러오면 정상으로 돌아온다
    fs.renameSync(path.join(dir, moved[0]), m.file);
    fs.writeFileSync(m.file, JSON.stringify({ a: { s: 'ok', v: 'https://x' } }));
    m.loadManual();
    assert.equal(m.broken(), false);
    m.saveManual();
    assert.deepEqual(JSON.parse(fs.readFileSync(m.file, 'utf8')), { a: { s: 'ok', v: 'https://x' } });
  });
}

test('수동 확인: 옮기지 못하면 원본을 그대로 두고 저장도 막는다', t => {
  const dir = temp(t);
  const m = manualModule(dir);
  fs.writeFileSync(m.file, '{broken');
  const rename = t.mock.method(fs, 'renameSync', () => { throw new Error('EBUSY'); });
  m.loadManual();
  m.saveManual();
  rename.mock.restore();
  assert.equal(fs.readFileSync(m.file, 'utf8'), '{broken');
  assert.match(m.logs[0].msg, /옮기지도 못해 그대로 둡니다\(EBUSY\)/);
  assert.equal(m.broken(), true);
});

test('readCsv: BOM · CRLF · 따옴표 안 쉼표 · 줄바꿈 · "" · 빈 줄', t => {
  const file = path.join(temp(t), 'a.csv');
  fs.writeFileSync(file, '﻿채널,상품ID,상품명\r\n쿠팡,"14","미러, 광각"\r\n본사몰,1850,"두 줄\r\n이름 ""인용"""\r\n\r\n , , \r\n');
  assert.deepEqual(readCsv(file), [
    { 채널: '쿠팡', 상품ID: '14', 상품명: '미러, 광각' },
    { 채널: '본사몰', 상품ID: '1850', 상품명: '두 줄\r\n이름 "인용"' },
  ]);
});
