// 일본어 정규화 매핑 회귀 테스트 — `npm test` 에 자동으로 포함된다.
//
// 지키려는 것
//   일본몰·아마존 JP 는 오랫동안 "ko 가 아니면 영문" 2분기여서 영문이 그대로 발행됐다.
//   사전(data/vehicle_i18n.json)과 폴백 규칙이 깨지면 그 상태로 조용히 되돌아가므로,
//   되돌아갔는지를 여기서 잡는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf-8');

const dict = JSON.parse(read('data/vehicle_i18n.json'));

/** vu-suggest.js 는 브라우저 IIFE 라 최소 window/document 스텁으로 평가한다. */
function loadSuggest() {
    const win = {};
    win.parent = win;                 // 셸 문맥 → iframe 자동 IPC 로드 경로를 타지 않는다
    const doc = { addEventListener() {}, body: null, getElementById: () => null };
    new Function('window', 'document', read('src/ui/vu-suggest.js'))(win, doc);
    return win.VUSuggest;
}

test('사전 파일이 필요한 키를 모두 갖는다', () => {
    for (const k of ['aliases', 'generationTokens', 'brands', 'models', 'generations']) {
        assert.ok(dict[k], `vehicle_i18n.json 에 ${k} 가 없다`);
    }
    assert.ok(Object.keys(dict.brands).length > 40, '브랜드 수가 갑자기 줄었다');
    assert.ok(Object.keys(dict.generations).length > 800, '세대 수가 갑자기 줄었다');
});

test('브랜드 조회 — 별칭과 표기 흔들림을 흡수한다', () => {
    const vu = loadSuggest();
    assert.equal(vu.setNames(dict), true);

    assert.equal(vu.brandJa('현대'), 'ヒョンデ');
    assert.equal(vu.brandJa('기아'), 'キア');
    // imweb_categories.json / imweb_boards.json 은 구 사명·다른 띄어쓰기를 쓴다.
    assert.equal(vu.brandJa('르노삼성'), vu.brandJa('르노 코리아'));
    assert.equal(vu.brandJa('쌍용'), vu.brandJa('쌍용 (KGM)'));
    assert.equal(vu.brandJa('DNA 모터스'), vu.brandJa('DNA모터스'));
    // 승용 '혼다' 와 바이크 '혼다 바이크' 가 섞이면 안 된다.
    assert.notEqual(vu.brandJa('혼다'), vu.brandJa('혼다 모터스'));
    assert.equal(vu.brandJa('없는브랜드'), null, '없으면 빈 문자열이 아니라 null 이어야 한다');
});

test('차종 조회 — 브랜드를 넘나드는 동명 차종을 섞지 않는다', () => {
    const vu = loadSuggest();
    vu.setNames(dict);

    assert.equal(vu.modelJa('현대', '그랜저'), 'グレンジャー');
    // 한국어 차종명은 브랜드를 넘나든다(렉스턴·컨티넨탈·MKZ 등). 평면 조회면 여기서 값이 샌다.
    assert.equal(vu.modelJa('기아', '그랜저'), null);
});

test('CSV 오역이 사전에 흘러들지 않는다', () => {
    const vu = loadSuggest();
    vu.setNames(dict);

    // 원본 CSV 가 다른 차 이름을 담고 있던 행들. 근거는 scratch/build_vehicle_i18n.mjs 참고.
    assert.equal(vu.modelJa('제네시스', '쿠페'), 'クーペ');        // クーパー(=Cooper) 아님
    assert.equal(vu.modelJa('현대', '에쿠스'), 'エクウス');         // ベロスター(=Veloster) 아님
    assert.equal(vu.modelJa('링컨', 'MKX'), 'MKX');               // MKZ 아님
    assert.equal(vu.modelJa('포르쉐', '718 카이맨(Cayman)'), '718 ケイマン(Cayman)'); // '3世代' 누출 없음
});

test('세대 조회 — exact 맵 먼저, 없으면 토큰 치환', () => {
    const vu = loadSuggest();
    vu.setNames(dict);

    assert.equal(vu.genJa('1세대 전기형'), '1世代 前期型');
    assert.equal(vu.genJa('3세대 페리'), '3世代 フェイスリフト');
    // 긴 토큰을 먼저 치환해야 '派生형' 같은 반쪽짜리가 안 나온다.
    assert.equal(vu.genJa('2세대 파생형'), '2世代 派生型');
    // 번역할 수 없으면 지어내지 말고 없음으로 — 한글이 남으면 null.
    assert.equal(vu.genJa('1세대 버젼'), null);
    assert.equal(vu.genJa(''), null);
});

test('사전이 없어도 조회는 예외 없이 null 을 돌려준다', () => {
    const vu = loadSuggest();     // setNames 하지 않은 상태
    assert.equal(vu.namesReady(), false);
    assert.equal(vu.brandJa('현대'), null);
    assert.equal(vu.modelJa('현대', '그랜저'), null);
    assert.equal(vu.genJa('1세대 전기형'), null);
});

/* ── 아임웹: 언어별 표기 선택과 배너 ───────────────────────────────── */

/** Imweb 을 통째로 import 하면 electron/playwright 가 딸려오므로 메서드만 떼어 검사한다. */
function imwebHelpers() {
    const src = read('src/platforms/imweb.js');
    const grab = name => {
        const i = src.indexOf(`    ${name}(`);
        assert.notEqual(i, -1, `${name} 을 찾지 못했다 — 헬퍼가 사라졌거나 이름이 바뀌었다`);
        // 메서드 블록을 중괄호 균형으로 잘라낸다.
        let depth = 0, end = -1;
        for (let j = src.indexOf('{', i); j < src.length; j++) {
            if (src[j] === '{') depth++;
            else if (src[j] === '}') { depth--; if (!depth) { end = j + 1; break; } }
        }
        return src.slice(i, end).trim();
    };
    const logs = [];
    const obj = new Function(`return { log(m){ this._logs.push(m); }, _logs: [], ${grab('nameForLang')}, ${grab('bannerFor')} };`)();
    obj._logs = logs;
    return obj;
}

const DATA = {
    titleBrand: '인피니티', titleModel: 'G25',
    titleBrandEn: 'INFINITI', titleModelEn: 'G25',
    titleBrandJp: 'インフィニティ', titleModelJp: 'G25',
    generation: '4th gen', generationJp: '4世代', code: '612',
};

test('nameForLang — 언어별 표기를 고르고, jp 는 없으면 영문→한글로 폴백한다', () => {
    const im = imwebHelpers();

    assert.equal(im.nameForLang(DATA, 'titleBrand', 'ko'), '인피니티');
    assert.equal(im.nameForLang(DATA, 'titleBrand', 'en'), 'INFINITI');
    assert.equal(im.nameForLang(DATA, 'titleBrand', 'jp'), 'インフィニティ');

    // 일본어가 비면 영문으로, 영문도 없으면 한글로. 폴백은 반드시 로그를 남긴다.
    const noJp = { ...DATA, titleBrandJp: '' };
    assert.equal(im.nameForLang(noJp, 'titleBrand', 'jp'), 'INFINITI');
    assert.ok(im._logs.some(m => m.includes('일본어 표기가 없어')), '폴백이 조용히 일어났다');

    const bare = { titleBrand: '인피니티' };
    assert.equal(im.nameForLang(bare, 'titleBrand', 'jp'), '인피니티');

    // en 회귀 방지: 영문 동작은 예전 그대로여야 한다.
    assert.equal(im.nameForLang(bare, 'titleBrand', 'en'), '인피니티');
});

test('bannerFor — 언어별 배너 형식', () => {
    const im = imwebHelpers();

    assert.equal(im.bannerFor(DATA, '인피니티', 'G25', 'ko'), '※ 인피니티 G25 조견표 ※');
    // 영문 형식은 기존 게시글과 같아야 한다(바꾸면 게시판 표기가 갈린다).
    assert.equal(im.bannerFor(DATA, 'INFINITI', 'G25', 'en'),
        '※ INFINITI G25 Fitment Guide ※<br>4th gen [No.612]');
    assert.equal(im.bannerFor(DATA, 'インフィニティ', 'G25', 'jp'),
        '※ インフィニティ G25 適合表 ※<br>4世代 [No.612]');
    // 일본어 세대가 없으면 영문 세대로 떨어진다(배너 자체는 나가야 한다).
    assert.equal(im.bannerFor({ ...DATA, generationJp: '' }, 'インフィニティ', 'G25', 'jp'),
        '※ インフィニティ G25 適合表 ※<br>4th gen [No.612]');
});

test('포스팅 경로가 같은 헬퍼를 쓴다 (복붙 재발 방지)', () => {
    // 예전엔 신규 · 수정 경로가 각자 문자열을 조립했다 — 다시 복붙되면 표기가 갈린다.
    const imweb = read('src/platforms/imweb.js');
    const edit = read('src/platforms/imweb_edit.js');

    for (const [name, src] of [['imweb.js', imweb], ['imweb_edit.js', edit]]) {
        assert.ok(!/const nameBrand = \(lang === 'ko'\)/.test(src),
            `${name} 에 옛 2분기 표기 선택이 되살아났다`);
    }
    // 'Fitment Guide' 배너는 bannerFor 안에만 있어야 한다.
    // 설명 주석(// 또는 * 로 시작하는 줄)에도 예시로 적혀 있으므로 코드 줄만 센다.
    const codeBanners = src => src.split('\n')
        .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .filter(l => l.includes('Fitment Guide ※')).length;
    assert.equal(codeBanners(imweb) + codeBanners(edit), 1,
        '배너 문자열이 다시 여러 곳으로 복사됐다');
});

/* ── 아마존: 마켓플레이스 프로파일 ─────────────────────────────────── */

test('아마존 마켓 상수가 UI 와 플랫폼에서 일치한다', async () => {
    const amazon = read('src/platforms/amazon.js');
    const ui = read('src/ui/index.html');

    // 엔드포인트가 어긋나면 서명이 깨지고, 통화가 어긋나면 엉뚱한 가격이 등록된다.
    for (const s of ['A1VC38T7YXB528', 'sellingpartnerapi-fe.amazon.com', 'JPY']) {
        assert.ok(amazon.includes(s), `amazon.js 에 ${s} 가 없다`);
        assert.ok(ui.includes(s), `index.html 에 ${s} 가 없다`);
    }
    // 일본은 영문/기본값으로 때우지 않고 막는다 — 조용한 오등록 방지.
    assert.ok(/JP_MARKETPLACE_ID\) \{\s*\n\s*throw new Error/.test(amazon)
           || (amazon.match(/marketplaceId === JP_MARKETPLACE_ID/g) || []).length >= 3,
        '일본 마켓 가드(설명·불릿·가격)가 줄었다');
    // 통화는 config(단일 마켓 값)보다 마켓 기본값이 앞서야 한다.
    assert.ok(amazon.includes('MARKETPLACE_CURRENCY[marketplaceId] || this.config?.currency'),
        '통화 폴백 순서가 바뀌었다 — JP 에 USD 가 나갈 수 있다');
});

test('셸이 통화를 실제로 아마존 페이로드에 싣는다', () => {
    // amzCurrency 를 화면에 쓰기만 하고 읽는 코드가 없어서 JP 를 골라도 USD 로 나갔었다.
    const ui = read('src/ui/index.html');
    assert.ok(/const currency = document\.getElementById\('amzCurrency'\)/.test(ui),
        'registerAmazon 이 amzCurrency 를 읽지 않는다');
    assert.ok(/marketplaceId, currency(?:,|\s*\n\s*\};)/.test(ui),
        'IPC 페이로드에 currency 가 빠졌다');
});
