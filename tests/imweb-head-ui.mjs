// 아임웹 자사몰 탭(imweb-head.js) 단일 상품 수정 — 가짜 IPC 로 폼만 연다. 네트워크 · 실제 저장 없음. `node tests/imweb-head-ui.mjs`
// 지키는 것:
//   1) 좌측 상품번호로 한국 구역 목록을 찾고 이름의 [No.번호] · [No.번호(옵)] 만 남긴다([No.1041] 은 빠진다)
//   2) 불러오기 = 상품 일괄 수정 채널(bulk-price-load-many, 지금 구역, 이미지 포함) — 조합 줄마다 최종가 칸 · 상태
//   3) 바뀐 것이 없으면 IPC 없이 '변경 없음', 바뀐 줄만 bulk-save-batch 로(expectedPrice · expectedName · expectedRevision)
//   4) 구역이 바뀌면 입력은 그대로 두고 저장 · 셸의 수정 대상(editItemOf)만 거부한다. 불러오는 사이 바뀌면 결과를 버린다
//   5) 저장 뒤 확인된 값이 불러온 값이 된다(다시 누르면 '변경 없음'), 일부만 되면 partial
//   6) 좌측 번호를 바꾼 뒤 남은 옛 표에서 고르면 버린다 · 이미지 0장 상품도 가격 저장 · 이름의 [No.번호] 를 지우면 거부
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const browser = await chromium.launch({ headless: true, executablePath: process.env.EBAY_TEST_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe', args: ['--allow-file-access-from-files'] });
try {
  const context = await browser.newContext({ viewport: { width: 1180, height: 960 } });
  await context.route(/^https?:/, route => route.abort());
  await context.addInitScript(() => {
    window.calls = [];
    window.listItems = [
      { id: '11', name: '옵틱글래스 광각미러 [No.104(옵)]', price: '80000' },
      { id: '12', name: '옵틱글래스 기아 K5 광각미러 [No.1041]', price: '80000' },
    ];
    const rows = scope => [
      { id: '11', optionId: '', name: scope === 'imweb-ko' ? '옵틱글래스 광각미러 [No.104(옵)]' : 'Optic-glass Wide View Side Mirror [No.104]',
        price: '80000', variant: '기본 판매가 (조합 가격은 아래 줄)', images: window.noImages ? [] : ['https://img/k1.jpg', 'https://img/k2.jpg'], imageRevision: 'rev-' + scope },
      { id: '11', optionId: 'od1', price: '80000', variant: '조합 · 1set' },
      { id: '11', optionId: 'od2', price: '115000', variant: '조합 · 운전석 · 숨김' },
    ];
    window.saveReply = data => ({ success: true, data: { results: data.jobs.map((job, index) => ({ index, success: true, data: { status: 'VERIFIED', revision: 'rev-new' } })) } });
    window.require = () => ({ ipcRenderer: { on() {}, send() {}, async invoke(channel, data) {
      window.calls.push({ channel, data });
      if (channel === 'veryup-get-mode') return 'edit';
      if (channel === 'bulk-price-list') return { success: true, data: { items: window.listItems } };
      if (channel === 'bulk-price-load-many') {
        if (window.loadGate) await window.loadGate;
        return { success: true, data: { items: [{ id: data.ids[0], rows: rows(data.scope) }], blocked: '' } };
      }
      if (channel === 'bulk-save-batch') return window.saveReply(data);
      if (channel === 'imweb-head-price-preview') return { success: true, plan: { USD: { combos: [data.usd ? Number(data.usd) : 160] }, JPY: { combos: [data.usd ? 14000 : 25000] } } };
      if (channel === 'imweb-head-register') {
        if (window.registerReply?.__reject) throw new Error(window.registerReply.__reject);
        return window.registerReply;
      }
      return { success: false, error: 'Offline stub' };
    } } });
  });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(pathToFileURL(path.resolve('src/ui/index.html')).href + '?mode=edit');
  const callsOf = channel => page.evaluate(ch => calls.filter(c => c.channel === ch).map(c => c.data), channel);
  // 상품번호가 비면(현황판에서 상품을 안 고름) 전체 목록을 그대로 보여 준다
  await page.evaluate(() => { switchTab('imwebHeadTab'); return findImwebHead(); });
  assert.deepEqual(await callsOf('bulk-price-list'), [{ scope: 'imweb-ko', query: '' }]);
  assert.equal(await page.locator('#ihResults tbody tr').count(), 2, '전체 목록은 이름으로 거르지 않는다');
  // 상품 URL 을 넣으면 idx(= 상품번호)의 줄 하나를 [선택] 표로 보이고(1건이라 바로 불러온다), 상품번호 칸보다 먼저다
  await page.evaluate(() => { calls.length = 0; document.getElementById('ihEditNo').value = '104';
    const u = document.getElementById('ihUrl'); u.value = 'https://optic-glass.co.kr/shop_view/?idx=12'; u.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.locator('#ihLoaded').waitFor({ state: 'visible' });
  assert.deepEqual(await callsOf('bulk-price-list'), [{ scope: 'imweb-ko', query: '' }]);
  assert.deepEqual(await page.locator('#ihResults tbody tr .vu-product-select').count(), 1);
  assert.match(await page.locator('#ihResults tbody tr').textContent(), /1041/);
  assert.deepEqual((await callsOf('bulk-price-load-many')).map(d => d.ids), [['12']]);
  await page.evaluate(() => { const u = document.getElementById('ihUrl'); u.value = ''; u.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.evaluate(() => { calls.length = 0; document.getElementById('ihEditNo').value = '104'; return findImwebHead(); });
  assert.deepEqual(await callsOf('bulk-price-list'), [{ scope: 'imweb-ko', query: 'no.104' }]);
  // (옵) 상품 1건만 남아 표가 바로 고른다 → 한국 구역으로 불러온다
  await page.locator('#ihLoaded').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#ihResults tbody tr').count(), 1, '[No.1041] 은 빠진다');
  assert.deepEqual(await callsOf('bulk-price-load-many'), [{ scope: 'imweb-ko', ids: ['11'], includeImages: true }]);
  assert.equal(await page.locator('#ihName').inputValue(), '옵틱글래스 광각미러 [No.104(옵)]');
  assert.equal(await page.locator('#ihBasePrice').inputValue(), '80000');
  assert.deepEqual(await page.locator('#ihCombos label').allTextContents(), ['1set — 최종가 (KRW)', '운전석 · 숨김 — 최종가 (KRW)']);
  assert.equal(await page.locator('#ihImageList img').count(), 2);
  assert.match(await page.locator('#ihUpdateBtn').innerText(), /아임웹 자사몰 옵틱글래스 광각미러 \[No\.104\(옵\)\] 수정하기/);
  assert.match(await page.locator('#ihUnitNote').textContent(), /미국·일본 구역은 그대로/);
  assert.deepEqual(await page.evaluate(() => editItemOf('imwebHeadTab')), { id: '11', name: '옵틱글래스 광각미러 [No.104(옵)]', market: '한국' });

  // 바뀐 것이 없으면 보내지 않는다
  assert.deepEqual(await page.evaluate(() => updateImwebHead()), { ok: true, message: '변경 없음' });
  assert.equal((await callsOf('bulk-save-batch')).length, 0);

  // 바뀐 줄만: 조합 od2 · 상품명 · 이미지(1장 삭제)
  await page.locator('#ihCombo1').fill('116000');
  await page.locator('#ihName').fill('옵틱글래스 기아 K5 광각미러 [No.104(옵)]');
  await page.locator('#ihImageList .vu-image-remove').first().click();
  const saved = await page.evaluate(() => updateImwebHead());
  assert.equal(saved.ok, true, saved.error);
  const [batch] = await callsOf('bulk-save-batch');
  assert.match(batch.jobId, /^[0-9a-f-]{36}$/);
  assert.equal(batch.scope, 'imweb-ko');
  assert.deepEqual(batch.jobs, [
    { type: 'price', id: '11', optionId: 'od2', newPrice: '116000', expectedPrice: '115000' },
    { type: 'name', id: '11', newName: '옵틱글래스 기아 K5 광각미러 [No.104(옵)]', expectedName: '옵틱글래스 광각미러 [No.104(옵)]' },
    { type: 'images', id: '11', urls: ['https://img/k2.jpg'], expectedRevision: 'rev-imweb-ko' },
  ]);
  assert.deepEqual(await page.evaluate(() => updateImwebHead()), { ok: true, message: '변경 없음' }, '확인된 값이 불러온 값이 된다');

  // 구역이 바뀌면(셸이 미국 칸으로) 입력은 남기고 저장 · 수정 대상만 거부한다
  await page.locator('#ihBasePrice').fill('81000');
  await page.evaluate(() => setImwebHeadScope('imweb-en'));
  assert.equal(await page.locator('#ihCountry').textContent(), '미국');
  assert.match(await page.locator('#ihUnitNote').textContent(), /환율 탭 '아임웹 미국·일본' 저장이 가격을 한국가 기준으로 다시 덮습니다/);
  assert.equal(await page.locator('#ihBasePrice').inputValue(), '81000', '구역을 바꿔도 입력은 그대로');
  const refused = await page.evaluate(() => updateImwebHead());
  assert.equal(refused.ok, false);
  assert.match(refused.error, /불러온 상품은 한국 구역인데 지금 칸은 미국 구역입니다/);
  assert.equal(await page.evaluate(() => editItemOf('imwebHeadTab')), null);
  assert.equal((await callsOf('bulk-save-batch')).length, 1, '거부는 IPC 없이');
  await page.evaluate(() => setImwebHeadScope('imweb-ko'));
  // 일부만 되면 partial — 기본가는 불러온 뒤 바뀌어 보내지 않음, 조합은 확인됨
  await page.locator('#ihCombo0').fill('81000');
  await page.evaluate(() => { window.saveReply = () => ({ success: true, data: { results: [
    { index: 0, success: false, stage: 'pre-send', error: '불러온 뒤 판매가가 바뀌었습니다(지금 82000). 현재가를 다시 불러오세요.' },
    { index: 1, success: true, data: { status: 'VERIFIED', price: '81000' } }] } }); });
  const partial = await page.evaluate(() => updateImwebHead());
  assert.deepEqual([partial.ok, partial.partial], [false, true]);
  assert.match(partial.error, /기본 판매가: 불러온 뒤 판매가가 바뀌었습니다/);
  assert.deepEqual((await callsOf('bulk-save-batch')).at(-1).jobs.map(j => [j.optionId, j.newPrice, j.expectedPrice]), [['', '81000', '80000'], ['od1', '81000', '80000']]);

  // 불러오는 사이 구역이 바뀌면 결과를 버린다
  await page.evaluate(() => { window.loadGate = new Promise(r => { window.openGate = r; }); window.pending = loadImwebHead('11'); });
  await page.evaluate(() => { setImwebHeadScope('imweb-jp'); window.openGate(); });
  const dropped = await page.evaluate(() => window.pending);
  assert.equal(dropped.ok, false);
  assert.match(dropped.error, /불러오는 사이 구역이나 상품번호가 바뀌어 결과를 버렸습니다/);
  assert.deepEqual((await callsOf('bulk-price-load-many')).at(-1), { scope: 'imweb-ko', ids: ['11'], includeImages: true });
  assert.equal(await page.locator('#ihCombo0').inputValue(), '81000', '버린 결과로 입력을 덮지 않는다');

  // 남은 옛 검색 표: 좌측 번호를 바꾼 뒤 옛 표에서 골라도 찾은 번호(104)로 불러와 버린다 — 다른 번호 상품에 저장되지 않게
  await page.evaluate(() => {
    window.headLogs = [];
    window.forwardLogToShell = (target, message) => window.headLogs.push(message);
    setImwebHeadScope('imweb-ko');
    window.listItems = [{ id: '11', name: '옵틱글래스 광각미러 [No.104(옵)]', price: '80000' }, { id: '13', name: '옵틱글래스 기아 K5 광각미러 [No.104]', price: '80000' }];
    return findImwebHead();
  });
  assert.equal(await page.locator('#ihResults tbody tr').count(), 2);
  await page.evaluate(() => { document.getElementById('ihEditNo').value = 'K138'; });
  await page.locator('#ihResults .vu-product-select').first().click();
  await page.waitForFunction(() => window.headLogs.some(m => /결과를 버렸습니다/.test(m)));
  assert.equal(await page.locator('#ihLoaded').isHidden(), true);
  assert.equal(await page.evaluate(() => editItemOf('imwebHeadTab')), null);

  // 상세 이미지 0장인 상품도 가격은 고칠 수 있다(1장 이상은 이미지를 바꿀 때만 본다) · [No.번호] 를 지운 이름은 보내지 않는다
  await page.evaluate(() => {
    window.noImages = true;
    window.saveReply = data => ({ success: true, data: { results: data.jobs.map((job, index) => ({ index, success: true, data: { status: 'VERIFIED' } })) } });
    document.getElementById('ihEditNo').value = '104';
    return loadImwebHead('11');
  });
  assert.equal(await page.locator('#ihImageList img').count(), 0);
  await page.locator('#ihBasePrice').fill('82000');
  const noImage = await page.evaluate(() => updateImwebHead());
  assert.equal(noImage.ok, true, noImage.error);
  assert.deepEqual((await callsOf('bulk-save-batch')).at(-1).jobs.map(j => [j.type, j.newPrice]), [['price', '82000']]);
  const saves = (await callsOf('bulk-save-batch')).length;
  await page.locator('#ihName').fill('옵틱글래스 기아 K5 광각미러');
  const untagged = await page.evaluate(() => updateImwebHead());
  assert.equal(untagged.ok, false);
  assert.match(untagged.error, /상품명에 \[No\.104\(옵\)\] 를 남겨 주세요/);
  assert.equal((await callsOf('bulk-save-batch')).length, saves, '거부는 IPC 없이');

  assert.equal(await page.evaluate(() => calls.some(c => /register|update|publish/.test(c.channel))), false);
  assert.deepEqual(errors, []);
  console.log('PASS: 아임웹 자사몰 — [No.번호(옵)] 찾기, 구역별 불러오기, 변경 없음 IPC 없음, 바뀐 줄만 저장(가격·이름·이미지), 구역 불일치 거부·입력 유지, 일부 저장 partial, 늦은 불러오기 버림, 옛 표 선택 버림, 이미지 0장 가격 저장, [No.] 삭제 거부');

  // ── 신규 등록: 미리보기(세 구역 이름 · 템플릿 가격 · 조견표) · 영문 없음 경고 · imweb-head-register 한 번 · { ok } 약속 ──
  const np = await context.newPage();
  np.on('pageerror', error => errors.push(error.message));
  await np.goto(pathToFileURL(path.resolve('src/ui/index.html')).href + '?mode=new');
  await np.evaluate(() => {
    window.headLogs = [];
    window.forwardLogToShell = (target, message, type) => window.headLogs.push({ target, message, type });
    switchTab('imwebHeadTab');
    const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
    for (const [id, v] of [['ihBrand', '현대'], ['ihModel', '싼타페'], ['ihCode', 'No.H152'], ['ihBrandEn', ''], ['ihModelEn', ''],
      ['ihBrandJp', 'ヒュンダイ'], ['ihModelJp', 'サンタフェ (일본)'], ['ihSpecUrl', 'https://img/chart-kr.jpg'], ['ihSpecUrlEn', ''], ['ihUsd', '90']]) set(id, v);
    const bsa = document.getElementById('ihBsa'); bsa.checked = true; bsa.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const vals = ids => np.evaluate(ids => ids.map(id => document.getElementById(id).value), ids);
  assert.deepEqual(await vals(['ihNameKo', 'ihNameEn', 'ihNameJp']), [
    '옵틱글래스 현대 싼타페 광각미러 [No.H152]',
    '옵틱글래스 현대 싼타페 광각미러 [No.H152]',   // 영문이 없으면 한국 이름(막지 않음)
    'Optic-glass ヒュンダイ サンタフェ 広角ドアミラー [No.H152]',   // 한글 괄호는 뺀다(imweb_unit_names 와 같음)
  ]);
  assert.equal(await np.locator('#ihNameKo').getAttribute('readonly'), '', '상품명은 읽기 전용');
  assert.match(await np.locator('#ihNameWarn').textContent(), /⚠ 미국 구역 상품명: 영문 제조사 · 차종이 없어 한국 이름으로 올라갑니다/);
  assert.doesNotMatch(await np.locator('#ihNameWarn').textContent(), /일본 구역/);
  // 판매가 칸: 한국은 템플릿 가격, 미국은 좌측 판매가(USD), 일본은 그 환율 환산(main planUnitPrices — 여기선 stub)
  await np.waitForFunction(() => document.getElementById('ihJpy').value === '14000');
  assert.deepEqual(await vals(['ihKrwSet', 'ihKrwLeft', 'ihKrwRight', 'ihUsd', 'ihJpy']), ['220000', '115000', '105000', '90', '14000']);
  assert.match(await np.locator('#ihPricePlan').textContent(), /^처음 값: 템플릿 2116 \(BSA O\) 가격/);
  assert.deepEqual(await np.evaluate(() => calls.filter(c => c.channel === 'imweb-head-price-preview').at(-1).data),
    { krw: { base: 220000, combos: [220000, 115000, 105000] }, usd: '90' });
  assert.deepEqual(await np.locator('#ihSpecPlan p').allTextContents(), ['조견표 국내용(한국): https://img/chart-kr.jpg', '조견표 해외용(미국 · 일본): 없음 — 국내용을 씁니다']);
  // 사람이 고친 운전석 가격은 BSA 를 바꿔도 지킨다 — 손대지 않은 칸만 새 템플릿 가격으로
  await np.evaluate(() => { const l = document.getElementById('ihKrwLeft'); l.value = '99000'; l.dispatchEvent(new Event('input', { bubbles: true }));
    const b = document.getElementById('ihBsa'); b.checked = false; b.dispatchEvent(new Event('change', { bubbles: true })); });
  assert.deepEqual(await vals(['ihKrwSet', 'ihKrwLeft', 'ihKrwRight']), ['150000', '99000', '70000']);
  assert.match(await np.locator('#ihPricePlan').textContent(), /^처음 값: 템플릿 2153 \(BSA X\) 가격/);
  await np.evaluate(() => { const i = document.getElementById('ihIntro'); i.value = '정품 보증 6개월'; i.dispatchEvent(new Event('input', { bubbles: true })); });

  const headCalls = () => np.evaluate(() => calls.filter(c => c.channel === 'imweb-head-register').map(c => c.data));
  const lastLog = () => np.evaluate(() => window.headLogs.at(-1));
  // 입력 검사 거부: IPC 없이 { ok:false, error } 이고 그 문장이 로그에도 남는다
  await np.evaluate(() => { document.getElementById('ihSpecUrl').value = ''; });
  assert.deepEqual(await np.evaluate(() => registerImwebHead()), { ok: false, error: '국내용 조견표가 없습니다 — 좌측 🇰🇷 KOREA 사진 불러오기로 조견표를 넣어 주세요.' });
  assert.deepEqual(await lastLog(), { target: 'imwebHead', message: '국내용 조견표가 없습니다 — 좌측 🇰🇷 KOREA 사진 불러오기로 조견표를 넣어 주세요.', type: 'error' });
  assert.equal((await headCalls()).length, 0);
  await np.evaluate(() => { document.getElementById('ihSpecUrl').value = 'https://img/chart-kr.jpg'; });

  // 성공: 한 번 보내고(세 구역 = 상품 하나) 상품번호를 로그에 남긴다
  await np.evaluate(() => { window.registerReply = { success: true, result: { ok: true, no: 2405, title: '옵틱글래스 현대 싼타페 광각미러 [No.H152]', warnings: [] }, message: '등록 — 세 구역 확인 뒤 판매중' }; });
  assert.deepEqual(await np.evaluate(() => registerImwebHead()), { ok: true });
  assert.deepEqual(await headCalls(), [{ brand: '현대', model: '싼타페', titleBrand: '현대', titleModel: '싼타페', code: 'H152', bsaO: false, bsaX: true,
    titleBrandEn: '', titleModelEn: '', titleBrandJp: 'ヒュンダイ', titleModelJp: 'サンタフェ (일본)', specImageUrl: 'https://img/chart-kr.jpg', specImageUrlEn: '',
    krwPrices: ['150000', '99000', '70000'], usdPrice: '90', jpyPrice: '14000', intro: '정품 보증 6개월' }]);
  assert.deepEqual(await lastLog(), { target: 'imwebHead', message: '✓ 상품번호 2405 등록 — 세 구역 확인 뒤 판매중', type: 'success' });

  // 만들었지만 확인이 어긋나 숨김: { ok:false, error(상품번호 포함) } / 중복 차단 / invoke 가 던짐 — 모두 던지지 않고 버튼이 풀린다
  for (const [reply, want] of [
    [{ success: false, result: { ok: false, no: 2406 }, error: '일본 조합 \'1set\' 가격 9999 (요청 10000) (상품번호 2406 — 숨김 상태입니다. 아임웹 관리자에서 확인하세요)' }, /상품번호 2406 — 숨김 상태입니다/],
    [{ success: false, duplicate: true, error: '중복 등록 차단: 아임웹 자사몰에 [No.H152] 싼타페 상품이 이미 있습니다' }, /중복 등록 차단/],
    [{ __reject: 'IPC 연결 끊김' }, /IPC 연결 끊김/],
  ]) {
    await np.evaluate(r => { window.registerReply = r; }, reply);
    const r = await np.evaluate(() => registerImwebHead());
    assert.equal(r.ok, false);
    assert.match(r.error, want);
    assert.equal((await lastLog()).type, 'error');
    assert.equal(await np.locator('#ihRegisterBtn').isDisabled(), false);
  }
  assert.deepEqual(errors, []);
  console.log('PASS: 아임웹 자사몰 신규 — 세 구역 이름 미리보기 · 영문 없음 경고 · 템플릿 2116/2153 가격 · 조견표, 거부는 IPC 없이, 성공은 한 번 보내고 상품번호 로그, 실패 셋 { ok:false }');
} finally { await browser.close(); }
