// src/main_process.js 의 종료·브라우저 정리 경로.
//
// 메인 프로세스는 Electron 없이는 띄울 수 없어서, 여기서는 '다시 깨지면 앱이 안 꺼지는' 두 가지를
// 소스에서 직접 본다.
//
// 있었던 일: 창을 다 닫을 때와 자동화 Edge 가 끊겼을 때 부르는 정리 코드가, 선언된 적 없는
// naverEditInstance 에 null 을 넣고 있었다(옛 코드는 archive/ 에만 남아 있다). 이 파일은 ES
// 모듈이라 엄격 모드이고, 그 대입은 ReferenceError 를 던진다. 그 결과
//   · 창을 다 닫아도 stopAiServers()·app.quit() 에 닿지 못해 프로세스와 AI 서버가 남았고
//     (자동 업데이트 설치 autoInstallOnAppQuit 도 그래서 돌지 않았다),
//   · Edge 창을 손으로 닫은 뒤의 첫 작업이 실패하고 imwebInstance 는 죽은 브라우저를 붙들었다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(path.join(ROOT, 'src/main_process.js'), 'utf-8');

test('main_process.js 는 ES 모듈이다 — 선언 안 된 변수 대입이 곧 ReferenceError 다', () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
  assert.equal(pkg.type, 'module');
});

// 선언 안 된 이름을 쓰는 곳을 TypeScript 검사기로 찾는다(정규식으로는 같은 줄 두 번째 대입,
// 다른 이름, 주석 속 'let x' 같은 경우를 놓친다). 메인 프로세스와 플랫폼·유틸 모듈 전부가 ES 모듈이라
// 어디서든 같은 ReferenceError 가 난다.
const require = createRequire(import.meta.url);
let ts = null;
try { ts = require('typescript'); } catch { /* 아래에서 알린다 */ }

// 검사기가 모르는 '있는 이름'. @types/node 없이 돌리므로 Node 전역은 여기 적는다.
const NODE_GLOBALS = new Set(['process', 'Buffer', 'setImmediate', 'clearImmediate', 'global']);
// page.evaluate(...) 안의 코드는 쇼핑몰 페이지에서 돈다 — 그 페이지의 전역이다.
const PAGE_GLOBALS = {};

test('메인 프로세스·플랫폼·유틸 모듈에 선언 안 된 이름이 없다', { skip: !ts && 'typescript 모듈이 없어 검사하지 못했다' }, () => {
  const rel = [
    'src/main_process.js',
    ...['src/platforms', 'src/platforms/openapi', 'src/utils']
      .flatMap(dir => readdirSync(path.join(ROOT, dir)).filter(f => f.endsWith('.js')).map(f => `${dir}/${f}`)),
  ];
  const files = rel.map(f => path.join(ROOT, f));
  const program = ts.createProgram(files, {
    allowJs: true, checkJs: true, noEmit: true, noResolve: true, skipLibCheck: true, types: [],
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
  });
  // 2304 Cannot find name · 2552 …Did you mean · 2580/2582/2591 …install type definitions
  const CODES = new Set([2304, 2552, 2580, 2582, 2591]);
  const bad = [];
  rel.forEach((r, i) => {
    for (const d of program.getSemanticDiagnostics(program.getSourceFile(files[i]))) {
      if (!CODES.has(d.code)) continue;
      const name = (ts.flattenDiagnosticMessageText(d.messageText, ' ').match(/'([^']+)'/) || [])[1];
      if (NODE_GLOBALS.has(name) || PAGE_GLOBALS[r]?.has(name)) continue;
      const { line } = d.file.getLineAndCharacterOfPosition(d.start);
      bad.push(`${r}:${line + 1} ${name}`);
    }
  });
  assert.deepEqual(bad, [], `선언 안 된 이름:\n  ${bad.join('\n  ')}`);
});

// ✕ 로 VERY UP·SEED 를 닫으면 남는 건 숨은 런처뿐인데, Electron 은 숨은 창도 열린 창으로 쳐서
// window-all-closed 를 보내지 않았다(Electron 30 으로 재현). 앱 창이 닫힐 때 숨은 런처도 닫아야 한다.
test('VERY UP·SEED 창이 닫히면 숨은 런처만 남는지 보고 닫는다', () => {
  assert.match(src, /function closeHiddenLauncherIfLast\(\)/);
  for (const fn of ['createUpWindow', 'createSeedWindow']) {
    const at = src.indexOf(`function ${fn}(`);
    assert.ok(at !== -1, `${fn} 이 없다`);
    const body = src.slice(at, src.indexOf('\n}\n', at));
    assert.match(body, /on\('closed',[^\n]*closeHiddenLauncherIfLast\(\)/, `${fn}: 닫힐 때 숨은 런처를 확인하지 않는다`);
  }
  // '← 런처로' 는 닫힌(destroyed) 런처에 show() 를 부르면 안 된다.
  const back = src.slice(src.indexOf("ipcMain.on('close-app'"), src.indexOf("ipcMain.on('close-app'") + 300);
  assert.match(back, /isDestroyed\(\)/);
});

test('창을 다 닫으면 정리가 실패해도 AI 서버를 끄고 앱을 끝낸다', () => {
  const at = src.indexOf("app.on('window-all-closed'");
  assert.ok(at !== -1, 'window-all-closed 핸들러가 없다');
  const body = src.slice(at, src.indexOf('\n});\n', at));
  const fin = body.indexOf('finally');
  assert.ok(fin !== -1, '정리가 try/finally 로 감싸여 있지 않다');
  const tail = body.slice(fin);
  assert.ok(tail.includes('stopAiServers()'), 'finally 에서 AI 서버를 끄지 않는다');
  assert.ok(tail.includes('app.quit()'), 'finally 에서 app.quit() 을 부르지 않는다');
});
