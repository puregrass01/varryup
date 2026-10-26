import path from 'node:path';
import { fileURLToPath } from 'node:url';

// file:// URL → 비교용 파일 경로(소문자). URL 문자열끼리 비교하면 안 된다 — 드라이브 문자(c: · C:)와 ^ 같은 글자의
// 인코딩이 Node(pathToFileURL)와 Chromium 이 달라, 같은 파일인데도 다르다고 나와 앱 안 이동까지 막혔다.
// ?query · #hash 는 경로에서 빠진다. file:// 이 아니거나 깨진 URL 이면 null.
export function localPathKey(url) {
  try { return String(url).startsWith('file:') ? path.normalize(fileURLToPath(url)).toLowerCase() : null; }
  catch { return null; }
}
