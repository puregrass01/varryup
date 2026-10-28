// 옛 로그 채널이 현재 화면(veryup-log)에 도달하는가.
//
// 이 번역기가 없으면 업데이트 실패·아임웹·네이버 로그가 **화면에 한 글자도 안 뜬다**
// (창을 제대로 찾아도, 그 화면이 옛 채널을 듣지 않기 때문).
import test from 'node:test';
import assert from 'node:assert/strict';
import { toVeryupLog, VERYUP_LOG_CHANNEL } from '../src/utils/ui_log.js';

test('현재 화면이 듣는 채널 이름이 바뀌지 않았다', () => {
    // index_up.html 의 ipc.on('veryup-log', ...) 와 반드시 같아야 한다.
    assert.equal(VERYUP_LOG_CHANNEL, 'veryup-log');
});

test('업데이트 알림이 번역된다', () => {
    const r = toVeryupLog('log', '[업데이트] 새 버전 2.0.2 발견');
    assert.equal(r.message, '[업데이트] 새 버전 2.0.2 발견');
    assert.equal(r.level, 'info');
});

test('실패 문구는 error 등급으로 올라간다', () => {
    for (const msg of ['[업데이트] 업데이트 오류: 401', '연결 실패', 'HTTP 403', 'Request failed']) {
        assert.equal(toVeryupLog('log', msg).level, 'error', msg);
    }
});

test('플랫폼 접두사가 붙는다', () => {
    assert.equal(toVeryupLog('imweb-log', '상품 등록 중').message, '[아임웹] 상품 등록 중');
    assert.equal(toVeryupLog('naver-log', '로그인 완료').message, '[네이버] 로그인 완료');
});

test('모르는 채널은 번역하지 않는다', () => {
    assert.equal(toVeryupLog('veryup-search-result', { rows: [] }), null);
    assert.equal(toVeryupLog('some-new-channel', 'x'), null);
});

test('이미 새 형식({message, level})이면 등급을 보존한다', () => {
    const r = toVeryupLog('imweb-log', { message: '실패했습니다', level: 'warn' });
    assert.equal(r.message, '[아임웹] 실패했습니다');
    assert.equal(r.level, 'warn', '보낸 쪽이 정한 등급을 덮어쓰면 안 된다');
});

test('문자열도 객체도 아니면 null (화면이 깨지지 않게)', () => {
    for (const bad of [null, undefined, 42, [], { nope: 1 }]) {
        assert.equal(toVeryupLog('log', bad), null);
    }
});

test('main_process 가 죽은 mainWindow 로 직접 보내지 않는다', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('../src/main_process.js', import.meta.url), 'utf8');
    const offenders = src.split('\n')
        .filter((l) => !l.trim().startsWith('//'))
        .filter((l) => /mainWindow\.webContents\.send/.test(l));
    assert.deepEqual(offenders, [],
        'mainWindow 는 대입된 적이 없다 — 직접 보내면 그 로그는 사라진다. sendToUI() 를 써라');
});
