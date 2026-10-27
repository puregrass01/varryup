// 탐색 가드(main_process web-contents-created)와 eBay IPC 출처 확인이 쓰는 file:// 비교.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { localPathKey } from '../src/utils/file_url.js';

test('Node 와 Chromium 이 다르게 쓰는 같은 파일을 같다고 본다(드라이브 문자 · ^ 인코딩 · ?query · #hash)', () => {
  const dir = path.join('c:\\Users\\x\\베리 업 {v3}^[1]', 'src', 'ui');
  const node = pathToFileURL(path.join(dir, 'index.html')).href;   // Node: 소문자 c:, ^ 는 그대로
  const chromium = 'file:///C:/Users/x/%EB%B2%A0%EB%A6%AC%20%EC%97%85%20%7Bv3%7D%5E%5B1%5D/src/ui/index.html?mode=edit#top';
  assert.equal(localPathKey(chromium), localPathKey(node));
  assert.ok(localPathKey(chromium).startsWith(path.normalize(dir + path.sep).toLowerCase()));
});

test('file:// 이 아니거나 깨진 값은 null — 앱 밖으로 본다', () => {
  for (const url of ['https://example.com/index.html', 'about:blank', '', undefined, null, 'file://%']) {
    assert.equal(localPathKey(url), null, String(url));
  }
});

test('src/ui 밖(상위 폴더로 나가는 경로)은 ui 폴더로 시작하지 않는다', () => {
  const dir = path.join('C:\\app', 'src', 'ui');
  const outside = pathToFileURL(path.join(dir, '..', 'other.html')).href;
  assert.equal(localPathKey(outside).startsWith(path.normalize(dir + path.sep).toLowerCase()), false);
});
