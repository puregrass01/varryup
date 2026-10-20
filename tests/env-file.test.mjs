// veryup.env 로더 — 설치본에서 UPDATE_TOKEN 을 넣을 수 있는 유일한 경로이므로
// "조용히 안 먹는" 경우가 없어야 한다. 특히 BOM·CRLF·따옴표는 메모장으로 저장한
// 파일에서 실제로 나오는 형태다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadEnvFile, loadUserEnv, undistributableKeys, DISTRIBUTABLE_ENV_KEYS } from '../src/utils/env_file.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'veryup-env-'));
let n = 0;
function writeEnv(content) {
    const p = path.join(TMP, `t${++n}.env`);
    fs.writeFileSync(p, content, 'utf-8');
    return p;
}
/** process.env 를 건드리는 테스트이므로 끝나면 반드시 되돌린다. */
function withClean(keys, fn) {
    const saved = {};
    for (const k of keys) { saved[k] = process.env[k]; delete process.env[k]; }
    try { return fn(); }
    finally {
        for (const k of keys) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
    }
}

test('기본 키=값 을 읽어 process.env 에 올린다', () => {
    withClean(['UPDATE_TOKEN', 'ADMIN_SERVER_URL'], () => {
        const p = writeEnv('UPDATE_TOKEN=abc123\nADMIN_SERVER_URL=https://admin.example.com\n');
        const r = loadEnvFile(p);
        assert.equal(r.loaded, true);
        assert.equal(process.env.UPDATE_TOKEN, 'abc123');
        assert.equal(process.env.ADMIN_SERVER_URL, 'https://admin.example.com');
    });
});

test('진짜 환경변수가 파일보다 우선한다', () => {
    withClean(['UPDATE_TOKEN'], () => {
        process.env.UPDATE_TOKEN = 'from-shell';
        const p = writeEnv('UPDATE_TOKEN=from-file\n');
        const r = loadEnvFile(p);
        assert.equal(process.env.UPDATE_TOKEN, 'from-shell');
        assert.deepEqual(r.skipped, ['UPDATE_TOKEN']);
        assert.deepEqual(r.applied, []);
    });
});

test('BOM 이 붙은 파일의 첫 키도 먹는다(메모장 저장)', () => {
    withClean(['UPDATE_TOKEN'], () => {
        const p = writeEnv('﻿UPDATE_TOKEN=bom-ok\n');
        loadEnvFile(p);
        assert.equal(process.env.UPDATE_TOKEN, 'bom-ok');
    });
});

test('CRLF 줄바꿈에서 값 끝에 \\r 가 붙지 않는다', () => {
    withClean(['UPDATE_TOKEN'], () => {
        const p = writeEnv('UPDATE_TOKEN=crlf-ok\r\nADMIN_SERVER_URL=x\r\n');
        loadEnvFile(p);
        assert.equal(process.env.UPDATE_TOKEN, 'crlf-ok');
    });
});

test('따옴표를 벗기고, 값 안의 # 는 주석으로 보지 않는다', () => {
    withClean(['A', 'B'], () => {
        const p = writeEnv('A="pass#word"\nB=plain # 뒤는 주석\n');
        loadEnvFile(p);
        assert.equal(process.env.A, 'pass#word');
        assert.equal(process.env.B, 'plain');
    });
});

test('주석·빈 줄·키 없는 줄은 건너뛴다', () => {
    withClean(['GOOD', 'EXPORTED'], () => {
        const p = writeEnv('# 주석\n\n  \n=값만있음\nGOOD=y\nexport EXPORTED=w\n');
        const r = loadEnvFile(p);
        // dotenv 규칙: 주석·빈 줄·'=' 앞이 비어 있는 줄은 버리고, 'export ' 접두사는 허용한다.
        assert.deepEqual(r.applied.sort(), ['EXPORTED', 'GOOD']);
        assert.equal(process.env.EXPORTED, 'w');
    });
});

test('키 이름 규칙은 dotenv 를 따른다(셸 변수명보다 느슨하다)', () => {
    withClean(['1BAD'], () => {
        // 직접 만든 파서는 1BAD 를 버렸지만 dotenv 는 받는다. 표준 .env 규칙에 맡기기로 한
        // 이상 여기서 갈라지면 안 되므로, 실제 동작을 테스트로 고정해 둔다.
        // (오타가 조용히 먹힐 수 있다는 뜻이다 → 기동 로그의 '적용된 항목' 줄로 확인한다)
        const p = writeEnv('1BAD=x\n');
        const r = loadEnvFile(p);
        assert.deepEqual(r.applied, ['1BAD']);
    });
});

test('파일이 없으면 오류가 아니라 loaded:false', () => {
    const r = loadEnvFile(path.join(TMP, 'nope.env'));
    assert.equal(r.loaded, false);
    assert.equal(r.error, undefined);
});

test('applied/skipped 에 값이 새지 않는다(키 이름만)', () => {
    withClean(['UPDATE_TOKEN'], () => {
        const p = writeEnv('UPDATE_TOKEN=super-secret-value\n');
        const r = loadEnvFile(p);
        const dump = JSON.stringify(r);
        assert.ok(!dump.includes('super-secret-value'),
            '결과 객체에 토큰 값이 들어 있으면 로그로 샌다');
    });
});

// ── 배포본(앱 폴더) veryup.env ──────────────────────────────
// 앱 폴더째 압축해 배포하는 운영 방식이라, 앱 폴더의 기본값과 PC 별 덮어쓰기가
// 둘 다 필요하다. 우선순위가 뒤집히면 한 PC 만 바꾸려던 값이 전 직원에게 먹는다.

function envDir(files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "veryup-envdir-"));
    for (const [name, body] of Object.entries(files)) {
        fs.writeFileSync(path.join(dir, name), body, "utf-8");
    }
    return dir;
}

test('앱 폴더 veryup.env 를 배포본 기본값으로 읽는다', () => {
    withClean(['UPDATE_TOKEN', 'VERYUP_ENV_FILE'], () => {
        const userDir = envDir({});                                   // userData 에는 없음
        const appDir = envDir({ 'veryup.env': 'UPDATE_TOKEN=shipped\n' });
        loadUserEnv(userDir, appDir);
        assert.equal(process.env.UPDATE_TOKEN, 'shipped');
    });
});

test('userData 값이 앱 폴더 기본값을 이긴다', () => {
    withClean(['UPDATE_TOKEN', 'ADMIN_SERVER_URL', 'VERYUP_ENV_FILE'], () => {
        const userDir = envDir({ 'veryup.env': 'UPDATE_TOKEN=local\n' });
        const appDir = envDir({ 'veryup.env': 'UPDATE_TOKEN=shipped\nADMIN_SERVER_URL=https://a.example.com\n' });
        loadUserEnv(userDir, appDir);
        assert.equal(process.env.UPDATE_TOKEN, 'local', 'PC 별 덮어쓰기가 우선이어야 한다');
        assert.equal(process.env.ADMIN_SERVER_URL, 'https://a.example.com', '없는 키는 배포본이 채운다');
    });
});

test('VERYUP_ENV_FILE 을 지정하면 그 파일만 쓴다', () => {
    withClean(['UPDATE_TOKEN'], () => {
        const only = writeEnv('UPDATE_TOKEN=explicit\n');
        const userDir = envDir({ 'veryup.env': 'UPDATE_TOKEN=local\n' });
        const appDir = envDir({ 'veryup.env': 'UPDATE_TOKEN=shipped\n' });
        process.env.VERYUP_ENV_FILE = only;
        try {
            loadUserEnv(userDir, appDir);
            assert.equal(process.env.UPDATE_TOKEN, 'explicit');
        } finally { delete process.env.VERYUP_ENV_FILE; }
    });
});

test('배포해도 되는 키와 안 되는 키를 가른다', () => {
    // 배포본에 실려 나가면 안 되는 것들 — 이 목록이 느슨해지면 압축 한 번에 전부 샌다.
    assert.deepEqual(undistributableKeys(['UPDATE_TOKEN', 'ADMIN_SERVER_URL']), []);
    assert.deepEqual(undistributableKeys(['NAVER_CLIENT_SECRET']), ['NAVER_CLIENT_SECRET']);
    assert.deepEqual(
        undistributableKeys(['UPDATE_TOKEN', 'NAVER_CLIENT_ID', 'NAVER_CLIENT_SECRET']),
        ['NAVER_CLIENT_ID', 'NAVER_CLIENT_SECRET']
    );
    for (const key of ['NAVER_CLIENT_SECRET', 'EBAY_CLIENT_SECRET', 'AMAZON_REFRESH_TOKEN']) {
        assert.equal(DISTRIBUTABLE_ENV_KEYS.has(key), false, key + ' 는 배포 허용 목록에 들어가면 안 된다');
    }
});

test('실제 배포본 veryup.env 에는 허용된 키만 있다', () => {
    // 이 저장소를 압축해 배포하므로, 루트 veryup.env 가 새는 경로 그 자체다.
    const root = path.join(path.dirname(new URL(import.meta.url).pathname.slice(1)), '..');
    const shipped = path.join(root, 'veryup.env');
    if (!fs.existsSync(shipped)) return;   // 없는 배포도 정상이다
    const keys = Object.keys(dotenvParse(fs.readFileSync(shipped, "utf-8")));
    assert.deepEqual(undistributableKeys(keys), [],
        '배포본 veryup.env 에 계정별 비밀값이 들어갔다');
});

/** dotenv 를 직접 붙이지 않고 최소 파싱만 한다 — 테스트가 의존성 하나를 덜 탄다. */
function dotenvParse(text) {
    const out = {};
    for (const line of String(text).split(/\r?\n/)) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        const i = t.indexOf('=');
        if (i > 0) out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    }
    return out;
}
