#!/usr/bin/env node
// 전체 테스트 한 번에 — `npm test`
//
// 왜 필요한가
//   테스트가 Node 쪽 파일 여러 개와 Python 쪽 unittest 네 벌로 흩어져 있고,
//   package.json 의 "test" 는 `exit 1` 이었다. 회귀를 한 번에 확인할 방법이 없다는 것이
//   배포를 무섭게 만드는 진짜 이유였다(구조 리뷰 #7). 이 스크립트가 그 한 번이다.
//
// 무엇을 돌리나
//   1) Node  : tests/ 안의 *.test.mjs (node:test 러너가 스스로 찾는다)
//   2) Python: 서버 쪽 unittest 네 벌 (server/.venv 우선, 없으면 시스템 python)
//
//   tests/ 의 ebay-ui.mjs · form-injection.mjs 처럼 '*.test.mjs' 가 아닌 파일은
//   눈으로 보는 진단 스크립트라서 일부러 제외한다(개별 npm 스크립트로 남아 있다).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const results = [];

function run(label, command, args, options = {}) {
    process.stdout.write(`\n${'='.repeat(60)}\n  ${label}\n${'='.repeat(60)}\n`);
    const r = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', shell: false, ...options });
    // spawnSync 는 실행 자체가 실패하면 status 가 null 이고 error 가 채워진다.
    // 이걸 성공으로 세면 "테스트가 다 통과했다"는 거짓 보고가 된다.
    const ok = r.error == null && r.status === 0;
    if (r.error) console.error(`  실행 실패: ${r.error.message}`);
    results.push({ label, ok, status: r.status });
    return ok;
}

// ── 1. Node ───────────────────────────────────────────────────
// Electron 을 노드로 쓴다. 시스템 node 가 PATH 에 없는 PC 가 있어서
// (그때마다 "npm test 가 안 돌아요" 가 된다) 저장소 안의 것을 기본으로 삼는다.
const electronExe = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const useElectron = existsSync(electronExe);
run(
    `Node 테스트 (${useElectron ? 'electron as node' : 'system node'})`,
    useElectron ? electronExe : process.execPath,
    ['--test', 'tests/'],
    useElectron ? { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } } : {},
);

// ── 2. Python (서버) ──────────────────────────────────────────
const venvPython = path.join(ROOT, 'server', '.venv', 'Scripts', 'python.exe');
const python = existsSync(venvPython) ? venvPython : 'python';
if (!existsSync(venvPython)) {
    console.warn(
        '\n[주의] server/.venv 가 없어 시스템 python 을 씁니다.\n' +
        '       의존성이 없으면 아래 서버 테스트가 전부 실패합니다. 만들려면:\n' +
        '         py -3 -m venv server/.venv\n' +
        '         server/.venv/Scripts/python.exe -m pip install -r server/requirements.txt\n'
    );
}
for (const suite of ['test_proxy', 'test_credentials', 'test_public', 'test_ebay_notify', 'test_request_log', 'test_currency_rates']) {
    run(`Python 테스트 — ${suite}`, python, ['-m', 'unittest', 'discover', '-s', 'tests', '-p', `${suite}.py`]);
}

// ── 요약 ──────────────────────────────────────────────────────
console.log(`\n${'='.repeat(60)}\n  요약\n${'='.repeat(60)}`);
for (const r of results) {
    console.log(`  ${r.ok ? '통과' : '실패'}  ${r.label}${r.ok ? '' : `  (exit ${r.status})`}`);
}
const failed = results.filter(r => !r.ok);
console.log(`\n  ${results.length - failed.length}/${results.length} 통과\n`);
process.exit(failed.length === 0 ? 0 : 1);
