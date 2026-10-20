// 쇼핑몰 폼(index.html)의 등록·저장 함수가 셸에 돌려주는 결과를 확인한다.
//
// 셸의 일괄 등록은 registerNaver·registerCoupang·registerImwebB2b·registerImwebBoard·registerAmazon 을
// 차례로 부르고 그 결과로 성공·실패를 센다. 예전에는 이 함수들이 아무것도 돌려주지 않아서, 입력 누락으로
// 멈춘 몰도 마켓이 거부한 몰도 '처리 완료' 로 셌다. 약속(C2)은 이렇다:
//   · { ok, error?, partial? } 를 돌려주고 절대 던지지 않는다.
//   · ok 는 IPC 결과가 success === true 일 때만 참.
//   · 입력 검사로 막으면 { ok:false, error: 로그에 쓴 그 문장 }.
//   · invoke 가 던져도 잡아서 로그로 남기고 버튼을 다시 풀고 { ok:false, error }.
// 아울러 이번에 고친 세 가지를 본다:
//   · 네이버: 수정 모드에서 신규(복사등록)로 돌아오면 템플릿 칸에 수정하던 실제 상품번호가 남았다.
//   · 아임웹: 여러 곳 중 일부만 올라간 결과(partial)를 몰마다 한 줄씩 보이고, 전체를 ✓ 로 쓰지 않는다.
//   · 쿠팡: 저장 뒤 화면 상태를 쿠팡이 돌려준 상품으로 새로 그린다(신규 옵션이 두 번 만들어지지 않게).
//
// 폼을 셸 없이 단독으로 연다(window.parent === window). IPC 는 채널마다 테스트가 정한 값을 돌려주는
// 가짜다 — 실제 등록은 일어나지 않는다.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.EBAY_TEST_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  args: ['--allow-file-access-from-files'],
});

const 틀림 = [];
let 전체 = 0;
function 확인(이름, fn) {
  전체 += 1;
  try { fn(); console.log(`  OK  ${이름}`); }
  catch (e) { 틀림.push(`${이름}: ${e.message}`); console.log(`  XX  ${이름}\n      ${e.message.split('\n').join('\n      ')}`); }
}

try {
  const context = await browser.newContext();
  await context.route(/^https?:/, route => route.abort());
  // electron 흉내. window.__script[채널] 이 돌려줄 값을 정한다:
  //   객체 → 그대로 resolve / { __reject: '글' } → 그 글로 reject / 배열 → 부를 때마다 앞에서 하나씩
  // 정하지 않은 채널은 {} 를 돌려준다(설정 불러오기 등).
  await context.addInitScript(() => {
    window.__calls = [];
    window.__script = {};
    const categories = { 국산차: { 현대: ['아반떼'] }, 수입차: {} };
    const ipcRenderer = {
      on() {}, send() {}, removeListener() {},
      invoke(channel, arg) {
        window.__calls.push({ channel, arg: arg === undefined ? null : JSON.parse(JSON.stringify(arg)) });
        if (channel === 'imweb-load-categories') return Promise.resolve({ success: true, categories });
        let spec = window.__script[channel];
        if (Array.isArray(spec)) spec = spec.length > 1 ? spec.shift() : spec[0];
        if (spec && spec.__reject) return Promise.reject(new Error(spec.__reject));
        return Promise.resolve(spec === undefined ? {} : JSON.parse(JSON.stringify(spec)));
      },
    };
    window.require = () => ({ ipcRenderer, shell: {} });
  });

  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  await page.goto(pathToFileURL(path.join(ROOT, 'src/ui/index.html')).href);
  await page.waitForFunction(() => document.readyState === 'complete'
    && typeof window.registerNaver === 'function' && typeof window.invokeWithImages === 'function'
    && document.getElementById('iwBrand').value === '현대'
    && document.getElementById('iwBoardBrand').value === '현대', null, { timeout: 15000 });

  const 부르기 = (fn, channel) => page.evaluate(async ([fn, channel]) => {
    const before = window.__calls.filter(c => c.channel === channel).length;
    let result, threw = null;
    try { result = await window[fn](); } catch (e) { threw = e.message; }
    return { result, threw, sent: window.__calls.filter(c => c.channel === channel).length - before };
  }, [fn, channel]);
  const 정하기 = (channel, spec) => page.evaluate(([c, s]) => { window.__script[c] = s; }, [channel, spec]);
  const 버튼 = id => page.evaluate(id => {
    const b = document.getElementById(id);
    return { disabled: b.disabled, loading: /loader/.test(b.innerHTML) };
  }, id);
  const 로그 = id => page.evaluate(id => [...document.getElementById(id).querySelectorAll('.log-entry')]
    .map(e => ({ type: e.className.replace('log-entry', '').trim(), text: e.innerText.replace(/^\[[^\]]*\]\s*/, '') })), id);
  const 로그비우기 = id => page.evaluate(id => { document.getElementById(id).innerHTML = ''; }, id);

  // ── 공통 4가지: 입력 검사 거부 / 마켓 거부 / invoke 가 던짐 / 성공 ─────────────────────
  async function 네가지(이름, { fn, channel, btn, logId, fill, refuse, refuseMsg }) {
    console.log(`\n════ ${이름} (${fn} → ${channel})`);
    await page.evaluate(fill);
    await page.evaluate(refuse);
    let r = await 부르기(fn, channel);
    확인(`${이름} · 입력 검사 거부 → { ok:false, error: 로그의 그 문장 }`, () => {
      assert.equal(r.threw, null);
      assert.deepEqual(r.result, { ok: false, error: refuseMsg });
      assert.equal(r.sent, 0, '요청이 나가면 안 된다');
    });
    const logs = await 로그(logId);
    확인(`${이름} · 거부 이유는 로그에도 남는다`, () => {
      assert.ok(logs.some(l => l.type === 'error' && l.text === refuseMsg), JSON.stringify(logs.slice(-3)));
    });

    await page.evaluate(fill);
    await 정하기(channel, { success: false, error: '마켓이 거부했습니다' });
    r = await 부르기(fn, channel);
    확인(`${이름} · success:false → { ok:false, error }`, () => {
      assert.equal(r.threw, null);
      assert.equal(r.sent, 1);
      assert.equal(r.result.ok, false);
      assert.equal(r.result.error, '마켓이 거부했습니다');
    });

    await 정하기(channel, { __reject: 'IPC 연결 끊김' });
    r = await 부르기(fn, channel);
    const b = await 버튼(btn);
    const logs2 = await 로그(logId);
    확인(`${이름} · invoke 가 던짐 → 던지지 않고 { ok:false }, 버튼 풀림, 로그에 남음`, () => {
      assert.equal(r.threw, null, '함수가 던졌다');
      assert.equal(r.result.ok, false);
      assert.equal(r.result.error, 'IPC 연결 끊김');
      assert.deepEqual(b, { disabled: false, loading: false });
      assert.ok(logs2.some(l => l.type === 'error' && l.text.includes('IPC 연결 끊김')), JSON.stringify(logs2.slice(-3)));
    });

    await 정하기(channel, { success: true, message: '완료되었습니다', url: 'https://example.com/p/1' });
    r = await 부르기(fn, channel);
    확인(`${이름} · success:true → { ok:true }`, () => {
      assert.equal(r.threw, null);
      assert.deepEqual(r.result, { ok: true });
    });
  }

  // ═════════ 신규(복사등록) 모드 ═════════
  await 네가지('네이버 복사등록', {
    fn: 'registerNaver', channel: 'naver-register', btn: 'registerBtn', logId: 'naverLogWindow',
    fill: `(() => {
      for (const [id, v] of [['brand','현대'],['model','아반떼'],['optionModel','현대 아반떼'],['optionProduct','18~23[No.1]'],['naverEsmHtml','<img src="x">']])
        document.getElementById(id).value = v;
      updateTitlePreview();
    })()`,
    refuse: `document.getElementById('optionProduct').value = ''`,
    refuseMsg: '옵션 > 상품선택을 입력해주세요.',
  });
  await 네가지('쿠팡 복사등록', {
    fn: 'registerCoupang', channel: 'coupang-register', btn: 'coupangRegisterBtn', logId: 'coupangLogWindow',
    fill: `(() => {
      for (const [id, v] of [['cpBrand','현대'],['cpModel','아반떼'],['cpEsmHtml','<img src="x">']]) document.getElementById(id).value = v;
      updateCoupangTitle();
    })()`,
    refuse: `document.getElementById('cpBrand').value = ''`,
    refuseMsg: '제조사명과 모델명을 입력해주세요.',
  });
  await 네가지('아마존 신규 등록', {
    fn: 'registerAmazon', channel: 'amazon-register', btn: 'amazonRegisterBtn', logId: 'amazonLogWindow',
    fill: `(() => { document.getElementById('amzSku').value = 'SKU-1'; document.getElementById('amzTitle').value = 'Mirror'; })()`,
    refuse: `document.getElementById('amzTitle').value = ''`,
    refuseMsg: '아마존 영문 상품명을 입력해주세요.',
  });
  await 네가지('아임웹 B2B 등록', {
    fn: 'registerImwebB2b', channel: 'imweb-register', btn: 'imwebRegisterBtn', logId: 'imwebLogWindow',
    fill: `(() => {
      for (const [id, v] of [['iwYear','18~23'],['iwCode','1234'],['iwMainImageUrl','https://x/main.jpg'],['iwSpecImageUrl','https://x/spec.jpg']])
        document.getElementById(id).value = v;
    })()`,
    refuse: `document.getElementById('iwSpecImageUrl').value = ''`,
    refuseMsg: '조견표 이미지 URL(국내용)을 입력해주세요.',
  });
  await 네가지('아임웹 게시판 포스팅', {
    fn: 'registerImwebBoard', channel: 'imweb-register', btn: 'imwebBoardRegisterBtn', logId: 'imwebBoardLogWindow',
    fill: `(() => {
      document.getElementById('iwTargetHead').checked = true;
      for (const [id, v] of [['iwBoardCode','612'],['iwBoardSpecImageUrl','https://x/spec.jpg']]) document.getElementById(id).value = v;
    })()`,
    refuse: `document.getElementById('iwBoardCode').value = ''`,
    refuseMsg: '제조사, 상품 코드를 입력해주세요.',
  });

  // ── 아임웹: 일부만 올라감 ─────────────────────────────────────────────
  console.log('\n════ 아임웹 게시판 — 본사몰은 됐고 해외몰은 거부됨 (partial)');
  await 로그비우기('imwebBoardLogWindow');
  await 정하기('imweb-register', {
    success: false, partial: true, error: '해외몰 게시판 등록 실패',
    results: [{ target: '본사몰', ok: true }, { target: '해외몰', ok: false, error: '권한이 없습니다' }],
  });
  let r = await 부르기('registerImwebBoard', 'imweb-register');
  let logs = await 로그('imwebBoardLogWindow');
  확인('아임웹 partial · { ok:false, partial:true, error }', () => {
    assert.equal(r.threw, null);
    assert.deepEqual(r.result, { ok: false, partial: true, error: '해외몰 게시판 등록 실패' });
  });
  확인('아임웹 partial · 된 곳은 성공 줄, 안 된 곳은 오류 줄', () => {
    assert.ok(logs.some(l => l.type === 'success' && l.text.includes('본사몰')), JSON.stringify(logs));
    assert.ok(logs.some(l => l.type === 'error' && l.text.includes('해외몰') && l.text.includes('권한이 없습니다')), JSON.stringify(logs));
  });
  확인('아임웹 partial · 전체 줄은 초록 ✓ 가 아니다', () => {
    const last = logs.at(-1);
    assert.equal(last.type, 'error', JSON.stringify(last));
    assert.ok(!last.text.startsWith('✓'), JSON.stringify(last));
    assert.ok(last.text.includes('해외몰 게시판 등록 실패'), JSON.stringify(last));
  });

  console.log('\n════ 아임웹 B2B — success:true 인데 결과 한 줄이 실패 (약속 위반도 성공으로 세지 않는다)');
  await 로그비우기('imwebLogWindow');
  await 정하기('imweb-register', {
    success: true, message: '등록 완료',
    results: [{ target: '개별 BSA O', ok: true }, { target: '세트 BSA O', ok: false, error: '옵션 오류' }],
  });
  r = await 부르기('registerImwebB2b', 'imweb-register');
  logs = await 로그('imwebLogWindow');
  확인('아임웹 B2B · 실패한 줄이 있으면 ok:false, partial:true', () => {
    assert.equal(r.result.ok, false);
    assert.equal(r.result.partial, true);
    assert.ok(!logs.some(l => l.type === 'success' && l.text === '✓ 등록 완료'), JSON.stringify(logs));
    assert.ok(logs.some(l => l.type === 'error' && l.text.includes('세트 BSA O')), JSON.stringify(logs));
  });

  console.log('\n════ 아임웹 B2B — 다 됐을 때는 전처럼 요약 한 줄');
  await 로그비우기('imwebLogWindow');
  await 정하기('imweb-register', {
    success: true, message: '2개 상품 등록 완료',
    results: [{ target: '개별 BSA O', ok: true }, { target: '세트 BSA O', ok: true }],
  });
  r = await 부르기('registerImwebB2b', 'imweb-register');
  logs = await 로그('imwebLogWindow');
  확인('아임웹 B2B 전부 성공 · { ok:true }, ✓ 요약 한 줄', () => {
    assert.deepEqual(r.result, { ok: true });
    const done = logs.filter(l => l.type === 'success');
    assert.deepEqual(done.map(l => l.text), ['✓ 2개 상품 등록 완료']);
  });

  // ═════════ 네이버 템플릿 ID: 수정 → 신규 ═════════
  console.log('\n════ 네이버 템플릿 ID — 수정 모드를 다녀와도 템플릿으로 돌아온다');
  const 템플릿 = await page.evaluate(() => ({ car: TEMPLATE_ID_CAR, moto: TEMPLATE_ID_MOTO }));
  const 모드 = m => page.evaluate(m => setSection8Mode(m), m);
  const 템플릿칸 = () => page.locator('#templateIdInput').inputValue();
  const 칸에 = v => page.evaluate(v => { document.getElementById('templateIdInput').value = v; }, v);

  const 처음 = await 템플릿칸();
  확인('처음(신규) · 자동차 템플릿', () => assert.equal(처음, 템플릿.car));
  await 모드('edit');
  const 수정진입 = await 템플릿칸();
  await 칸에('12999888777');                     // 수정할 실제 상품번호
  await page.evaluate(() => updateModeUI());      // 저장 뒤 라벨 복원처럼 수정 모드 안에서 다시 불림
  const 수정중 = await 템플릿칸();
  await 모드('new');
  const 돌아옴 = await 템플릿칸();
  확인('수정 진입 · 기본 템플릿은 비운다(전과 같음)', () => assert.equal(수정진입, ''));
  확인('수정 중 다시 그려도 수정할 상품번호는 그대로', () => assert.equal(수정중, '12999888777'));
  확인('신규로 돌아옴 · 수정하던 상품번호가 아니라 자동차 템플릿', () => assert.equal(돌아옴, 템플릿.car));

  await 칸에('55501234');                          // 사람이 신규 모드에서 고른 다른 템플릿
  await 모드('edit');
  await 칸에('12999888777');
  await page.evaluate(() => updateModeUI());
  await 모드('new');
  const 사용자템플릿 = await 템플릿칸();
  확인('신규에서 직접 넣은 템플릿은 수정 모드를 다녀와도 그대로 돌아온다', () => assert.equal(사용자템플릿, '55501234'));

  await 칸에(템플릿.car);
  await 모드('edit');
  await 칸에('12999888777');
  await page.evaluate(() => {                      // 수정 중에 카테고리가 오토바이로 바뀜
    document.querySelector('input[name="category"][value="오토바이"]').checked = true;
    updateForm();
  });
  await 모드('new');
  const 오토바이 = await 템플릿칸();
  확인('기본 템플릿이었으면 지금 카테고리의 기본 템플릿(오토바이)으로', () => assert.equal(오토바이, 템플릿.moto));
  await page.evaluate(() => {
    document.querySelector('input[name="category"][value="자동차"]').checked = true;
    updateForm();
  });

  // ═════════ 수정 모드 저장 경로 ═════════
  await 모드('edit');

  // ── 네이버 수정(saveSmartstoreEdit) ──
  const ssProduct = {
    originNo: 111, revision: 1, title: '네이버 상품', groups: ['모델', '상품선택', '좌석'],
    options: [{ names: ['아반떼', '18~23', '운전석'], price: 0, stockQuantity: 5 }],
    detailImages: [{ url: 'https://x/1.jpg' }],
  };
  await 정하기('smartstore-load-product', { success: true, product: ssProduct });
  await page.evaluate(async () => { document.getElementById('templateIdInput').value = '111'; await loadSmartstoreProduct(); });
  await 네가지('네이버 수정 저장', {
    fn: 'registerNaver', channel: 'smartstore-update-product', btn: 'registerBtn', logId: 'naverLogWindow',
    fill: `(() => { ssEditState.options[0].names[0] = '아반떼'; })()`,
    refuse: `(() => { ssEditState.options[0].names[0] = ''; })()`,
    refuseMsg: '1번 옵션의 "모델" 값이 비어 있습니다.',
  });

  // ── 아마존 수정(registerAmazon, amazon-update) ──
  await 정하기('amazon-load-product', { success: true, product: { title: 'Loaded Mirror', price: '10', stock: '3', brand: 'B',
    mainImageUrl: '', description: '', bulletPoints: [], asin: 'A1', status: 'BUYABLE' } });
  await page.evaluate(async () => { document.getElementById('amzSku').value = 'SKU-EDIT'; await loadAmazonProduct(); });
  await 네가지('아마존 수정 저장', {
    fn: 'registerAmazon', channel: 'amazon-update', btn: 'amazonRegisterBtn', logId: 'amazonLogWindow',
    fill: `document.getElementById('amzSku').value = 'SKU-EDIT'`,
    refuse: `document.getElementById('amzSku').value = 'SKU-OTHER'`,
    refuseMsg: '불러온 상품(SKU SKU-EDIT)과 지금 SKU 칸(SKU-OTHER)이 다릅니다 — 저장하지 않았습니다. SKU-OTHER 를 고치려면 먼저 "기존 아마존 상품 불러오기"를 누르세요.',
  });

  // ── 쿠팡 수정(saveCoupangEdit) ──
  const cpOpt = (i, value, extra = {}) => ({ index: i, sellerProductItemId: 100 + i, vendorItemId: 200 + i, itemName: value,
    attrs: [{ index: 0, typeName: '차종', value }], salePrice: 50000, stock: 9, imageUrl: '', imageInherited: false, isNew: false, ...extra });
  const cpProduct = (title, values) => ({ productId: 777, title, statusName: '승인완료',
    options: values.map((v, i) => cpOpt(i, v)), detailImages: [{ raw: 'a.jpg', url: 'https://x/a.jpg', blockType: 'IMAGE' }] });
  await 정하기('coupang-load-product', { success: true, product: cpProduct('쿠팡 상품', ['A']) });
  await page.evaluate(async () => { document.getElementById('cpProductIdInput').value = '777'; await loadCoupangProduct(); });
  await 네가지('쿠팡 수정 저장', {
    fn: 'registerCoupang', channel: 'coupang-update', btn: 'coupangRegisterBtn', logId: 'coupangLogWindow',
    fill: `document.getElementById('cpProductIdInput').value = '777'`,
    refuse: `document.getElementById('cpProductIdInput').value = '888'`,
    refuseMsg: '불러온 상품(ID 777)과 입력칸의 ID(888)가 다릅니다 — 저장하지 않았습니다. 888 를 고치려면 먼저 "상품 불러오기"를 누르세요.',
  });

  console.log('\n════ 쿠팡 두 번째 저장 — 저장 뒤 화면 상태를 쿠팡이 돌려준 상품으로');
  await 정하기('coupang-load-product', { success: true, product: cpProduct('쿠팡 상품', ['A']) });
  await page.evaluate(async () => { await loadCoupangProduct(); addCoupangOption(); cpEditState.options[1].attrs[0].value = 'B'; });
  await 정하기('coupang-update', { success: true, message: '상품이 수정되었습니다.', product: cpProduct('쿠팡 상품 (쿠팡이 돌려준 제목)', ['A', 'B']) });
  r = await 부르기('registerCoupang', 'coupang-update');
  let st = await page.evaluate(() => ({
    sent: window.__calls.filter(c => c.channel === 'coupang-update').at(-1).arg.options.map(o => !!o.isNew),
    isNew: cpEditState.options.map(o => !!o.isNew),
    ids: cpEditState.options.map(o => o.sellerProductItemId),
    title: document.getElementById('cpEditTitle').value,
    listText: document.getElementById('cpOptionList').innerText,
    btn: document.getElementById('coupangRegisterBtn').textContent.trim(),
    reloads: window.__calls.filter(c => c.channel === 'coupang-load-product').length,
  }));
  확인('첫 저장 · 추가한 옵션은 신규로 나간다', () => assert.deepEqual(st.sent, [false, true]));
  확인('첫 저장 · { ok:true }', () => assert.deepEqual(r.result, { ok: true }));
  확인('저장 뒤 · 어느 옵션도 신규가 아니다(쿠팡이 매긴 옵션 번호를 받음)', () => {
    assert.deepEqual(st.isNew, [false, false]);
    assert.deepEqual(st.ids, [100, 101]);
    assert.ok(!st.listText.includes('신규 옵션'), st.listText);
  });
  확인('저장 뒤 · 제목·버튼도 돌려받은 상품으로', () => {
    assert.equal(st.title, '쿠팡 상품 (쿠팡이 돌려준 제목)');
    assert.ok(st.btn.includes('쿠팡 상품 (쿠팡이 돌려준 제목) 수정하기'), st.btn);
  });

  const reloadsBefore = st.reloads;
  await 정하기('coupang-update', { success: true, message: '상품이 수정되었습니다.' });   // product 없음
  await 정하기('coupang-load-product', { success: true, product: cpProduct('다시 불러온 제목', ['A', 'B']) });
  await page.evaluate(() => { document.getElementById('cpProductIdInput').value = '777'; });
  r = await 부르기('registerCoupang', 'coupang-update');
  st = await page.evaluate(() => ({
    sent: window.__calls.filter(c => c.channel === 'coupang-update').at(-1).arg.options.map(o => !!o.isNew),
    reload: window.__calls.filter(c => c.channel === 'coupang-load-product').map(c => c.arg),
    title: document.getElementById('cpEditTitle').value,
  }));
  확인('두 번째 저장 · 같은 옵션을 또 신규로 보내지 않는다', () => assert.deepEqual(st.sent, [false, false]));
  확인('product 가 없으면 같은 ID 를 다시 불러온다', () => {
    assert.deepEqual(r.result, { ok: true });
    assert.equal(st.reload.length, reloadsBefore + 1);
    assert.equal(String(st.reload.at(-1)), '777');
    assert.equal(st.title, '다시 불러온 제목');
  });

  await page.evaluate(() => { addCoupangOption(); cpEditState.options.at(-1).attrs[0].value = 'C'; });
  await 정하기('coupang-update', { success: true, message: '상품이 수정되었습니다.' });
  await 정하기('coupang-load-product', { success: false, error: '조회 실패' });
  r = await 부르기('registerCoupang', 'coupang-update');
  const 남은상태 = await page.evaluate(() => cpEditState);
  확인('다시 불러오지 못하면 남은 상태를 버린다(신규 옵션을 또 만들지 않게)', () => {
    assert.deepEqual(r.result, { ok: true });   // 저장 자체는 됐다
    assert.equal(남은상태, null);
  });
  r = await 부르기('registerCoupang', 'coupang-update');
  확인('└ 그 뒤 저장은 "상품 불러오기" 를 먼저 하라고 막는다', () => {
    assert.deepEqual(r.result, { ok: false, error: '먼저 "상품 불러오기"를 눌러주세요.' });
    assert.equal(r.sent, 0);
  });

  // ── 아임웹 수정 버튼(탭의 별도 저장 버튼) ──
  console.log('\n════ 아임웹 수정 저장 버튼 — 불러오기 전');
  r = await 부르기('updateImwebB2bProduct', 'imweb-update-group');
  확인('B2B 수정 · 불러오기 전 → { ok:false }', () => assert.deepEqual(r.result, { ok: false, error: '먼저 상품을 불러와주세요.' }));
  r = await 부르기('updateImwebBoardPost', 'imweb-update-post');
  확인('게시판 수정 · 불러오기 전 → { ok:false } (예전엔 말없이 돌아감)', () => assert.deepEqual(r.result, { ok: false, error: '먼저 게시글을 불러와주세요.' }));

  확인('페이지 오류 없음', () => assert.deepEqual(pageErrors, []));
  console.log(`\n${전체 - 틀림.length}/${전체} 통과`);
  assert.equal(틀림.length, 0, `폼 결과 ${틀림.length}건 어긋남:\n  ` + 틀림.join('\n  '));
} finally {
  await browser.close();
}
