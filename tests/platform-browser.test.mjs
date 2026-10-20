// 브라우저 주입 방식 통일(리뷰 #4)과 아임웹 인스턴스 병합(리뷰 #5)을 고정한다.
//
// 예전 구조: 인스턴스가 Browser 객체를 필드로 들고 있어서, main_process 가 브라우저를
// 닫고 다시 띄우면 인스턴스는 죽은 객체를 붙들고 있었다. 그래서 핸들러마다
// `instance.browser = browser` 를 손으로 다시 꽂았고(8군데), 한 줄만 빠뜨리면
// 'Target closed' 로 조용히 죽었다. 이제 '가져오는 함수'를 들고 매번 현재 값을 읽는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { BasePlatform } from '../src/platforms/base_platform.js';

/** newContext/contexts 만 흉내 내는 최소 가짜 브라우저. */
function fakeBrowser(tag) {
    const contexts = [];
    return {
        tag,
        contexts: () => contexts,
        newContext: async () => {
            const ctx = { tag, pages: () => [], newPage: async () => ({ tag }), close: async () => {} };
            contexts.push(ctx);
            return ctx;
        },
    };
}

test('게터 함수를 넘기면 매 접근마다 현재 브라우저를 읽는다', () => {
    let current = fakeBrowser('first');
    const p = new BasePlatform(() => current, null);
    assert.equal(p.browser.tag, 'first');

    // main_process 가 브라우저를 닫고 새로 띄운 상황
    current = fakeBrowser('second');
    assert.equal(p.browser.tag, 'second', '인스턴스가 옛 브라우저를 붙들면 안 된다');

    current = null;
    assert.equal(p.browser, null);
});

test('Browser 객체를 그대로 넘기는 예전 방식도 계속 동작한다', () => {
    const b = fakeBrowser('direct');
    const p = new BasePlatform(b, null);
    assert.equal(p.browser.tag, 'direct');
});

test('브라우저가 없으면 init() 이 원인을 말하는 오류를 던진다', async () => {
    const p = new BasePlatform(() => null, null);
    await assert.rejects(() => p.init(false), (e) => {
        // 예전에는 "Cannot read properties of null (reading 'contexts')" 가 떠서
        // 어느 단계가 문제인지 알 수 없었다.
        assert.match(e.message, /브라우저가 실행 중이 아닙니다/);
        assert.ok(!/reading 'contexts'/.test(e.message));
        return true;
    });
});

test('같은 플랫폼명의 컨텍스트는 재사용한다(창 중복 방지)', async () => {
    const b = fakeBrowser('reuse');
    const p1 = new BasePlatform(() => b, null);
    await p1.init(false);
    assert.equal(b.contexts().length, 1);

    const p2 = new BasePlatform(() => b, null);   // 같은 platformName
    await p2.init(false);
    assert.equal(b.contexts().length, 1, '두 번째 인스턴스가 창을 또 열면 안 된다');
    assert.equal(p2.context, p1.context);
});

// ── 리뷰 #5: 아임웹 인스턴스는 하나여야 한다 ──────────────────
// main_process.js 는 electron 을 import 하므로 여기서 실행할 수 없다.
// 대신 '두 번째 인스턴스를 만드는 코드가 다시 생기지 않는지'를 소스에서 확인한다.
test('main_process 에 ImwebEdit 인스턴스 생성이 한 곳뿐이다', () => {
    const src = fs.readFileSync(new URL('../src/main_process.js', import.meta.url), 'utf8');
    const creations = src.match(/new ImwebEdit\(/g) || [];
    assert.equal(creations.length, 1,
        'ImwebEdit 를 두 번 만들면 같은 브라우저 컨텍스트를 두 인스턴스가 나눠 쓰게 된다');
    assert.ok(!/imwebEditInstance\s*=/.test(src),
        '두 번째 싱글턴 변수(imwebEditInstance)가 되살아났다');
});

test('main_process 에 수동 browser 재주입이 남아 있지 않다', () => {
    const src = fs.readFileSync(new URL('../src/main_process.js', import.meta.url), 'utf8');
    // 주석은 제외하고 실제 코드 줄만 본다.
    const offenders = src.split('\n')
        .filter(l => !l.trim().startsWith('//'))
        .filter(l => /\.browser\s*=\s*(browser|getBrowserSync\(\))\s*;/.test(l));
    assert.deepEqual(offenders, [],
        '게터로 통일했으므로 핸들러에서 browser 를 다시 꽂을 필요가 없다');
});

// ── 브라우저가 죽은 뒤의 동작 (2026-09-22 "등록 실패: Target page, context or
//    browser has been closed" 재발 방지) ─────────────────────────────
// 사람이 자동화 Edge 창을 직접 닫으면 Browser 객체는 남고 연결만 끊긴다.
// 그 상태를 걸러내지 않으면 다음 작업이 위 메시지로 죽는데, 그 문구만으로는
// 원인이 사용자 행동이라는 것을 알 수 없다.

/** isConnected() 를 흉내 내는 가짜 브라우저. */
function fakeBrowser2(tag, { connected = true } = {}) {
    const contexts = [];
    return {
        tag,
        isConnected: () => connected,
        setConnected(v) { connected = v; },
        contexts: () => contexts,
        newContext: async () => {
            if (!connected) throw new Error('Target page, context or browser has been closed');
            const ctx = {
                tag, _pages: [],
                pages() { return this._pages; },
                newPage: async function () { const p = { tag, isClosed: () => false }; this._pages.push(p); return p; },
                close: async () => {},
            };
            contexts.push(ctx);
            return ctx;
        },
    };
}

test('연결이 끊긴 브라우저면 원인을 말하는 오류를 던진다', async () => {
    const b = fakeBrowser2('dead');
    b.setConnected(false);
    const p = new BasePlatform(() => b, null);
    await assert.rejects(() => p.init(false), (e) => {
        assert.match(e.message, /브라우저 연결이 끊어졌습니다/);
        assert.match(e.message, /다시 실행/, '사용자가 무엇을 하면 되는지 알려 줘야 한다');
        return true;
    });
});

test('컨텍스트는 살아 있고 탭만 닫혔으면 새 탭을 연다', async () => {
    const b = fakeBrowser2('reuse');
    const p1 = new BasePlatform(() => b, null);
    await p1.init(false);

    // 사용자가 탭만 닫은 상황
    p1.context._pages[0].isClosed = () => true;

    const p2 = new BasePlatform(() => b, null);
    await p2.init(false);
    assert.equal(b.contexts().length, 1, '컨텍스트는 재사용해야 한다');
    assert.ok(!p2.page.isClosed(), '닫힌 탭을 그대로 물려주면 다음 goto 에서 죽는다');
});

test('main_process 가 죽은 브라우저를 그대로 돌려주지 않는다', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('../src/main_process.js', import.meta.url), 'utf8');
    assert.match(src, /browser\.isConnected/,
        'getBrowser() 가 isConnected() 를 확인해야 한다');
    assert.match(src, /on\('disconnected'/,
        "끊김을 즉시 알도록 'disconnected' 이벤트를 달아야 한다");
});
