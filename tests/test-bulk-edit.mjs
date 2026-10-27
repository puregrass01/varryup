// 단일 상품 수정 모드의 '일괄 수정' 버튼.
//
// 셸(index_up.html)을 띄우고 현황판에서 몰을 켠 뒤, 몇 몰에만 상품을 불러 두고 일괄 수정을 누른다.
//   · 불러온 몰(쿠팡·아마존·이베이)은 그 탭의 수정 저장이 나간다
//   · 불러온 상품이 없는 몰(네이버, 검색 결과가 없는 라쿠텐 카드)은 저장 함수를 부르지 않고
//     EditItemMissingError 로 '상품 없음' 실패가 된다
//   · 아임웹 B2B 는 Open API 저장이라 같이 돈다(불러온 상품이 없으면 '상품 없음'). 자사몰 게시판은 저장할 때
//     브라우저를 띄우므로 건너뛴다
//   · 탭의 저장 실패는 실패로 센다(카드 몰은 고를 상품이 없어 늘 '상품 없음' — 카드 수정 길은 10-23 지웠다)
//   · 도는 중 모드 전환은 거절, 신규 모드에서는 일괄 수정을 거절
// IPC 는 가짜다 — 채널마다 정해 둔 답을 주고 무엇이 나갔는지 적어 둔다. 실제 수정은 없다.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKU = 'KI1501NK138';
const CPID = '15628106868';

const browser = await chromium.launch({
  headless: true,
  args: ['--allow-file-access-from-files'],
  executablePath: process.env.EBAY_TEST_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
});
try {
  const context = await browser.newContext();
  await context.route(/^https?:/, route => route.abort());
  // addInitScript 는 iframe(쇼핑몰 폼)에도 들어간다. 셸·폼이 각자 자기 창의 __script·__callArgs 를 쓴다.
  await context.addInitScript(() => {
    const listeners = window.__listeners = {};
    window.require = () => ({ shell: {}, ipcRenderer: {
      on(channel, fn) { (listeners[channel] = listeners[channel] || []).push(fn); },
      send(channel, arg) { (window.__sent = window.__sent || []).push([channel, arg]); },
      removeListener() {},
      invoke(channel, arg) {
        (window.__callArgs = window.__callArgs || []).push([channel, arg]);
        const scripted = window.__script && window.__script[channel];
        if (scripted !== undefined) return Promise.resolve(typeof scripted === 'function' ? scripted(arg) : scripted);
        return Promise.resolve({});
      },
    } });
  });

  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${pathToFileURL(path.join(ROOT, 'src/ui/index_up.html')).href}?mode=edit`);

  // ── 버튼은 수정 모드에만 ──
  const buttons = () => page.evaluate(() => ({
    edit: getComputedStyle(document.getElementById('btn-bulk-edit')).display !== 'none',
    register: getComputedStyle(document.getElementById('btn-bulk-register')).display !== 'none',
  }));
  assert.deepEqual(await buttons(), { edit: true, register: false }, '수정 모드: 일괄 수정만 보인다');
  await page.locator('label[for="mode-new"]').click();
  assert.deepEqual(await buttons(), { edit: false, register: true }, '신규 모드: 일괄 등록만 보인다');
  await page.evaluate(() => { document.getElementById('log-window').innerHTML = ''; return runBulkEdit(); });
  assert.match(await page.locator('#log-window').textContent(), /일괄 수정은 단일 상품 수정 모드에서만 할 수 있습니다/);
  await page.locator('label[for="mode-edit"]').click();
  assert.deepEqual(await buttons(), { edit: true, register: false });

  // ── 대상이 없으면 카드에 알린다(수정 모드에서는 로그창이 숨어 있다) ──
  await page.locator('#btn-bulk-edit').click();
  assert.match(await page.locator('#bulk-edit-result').textContent(), /현황판에서 수정할 플랫폼을 먼저 선택하세요/);

  // ── 몰을 켠다. 라쿠텐·쇼피파이 칸은 셸에서 꺼 두어(비활성) 고르지 않는다 ──
  await page.evaluate(([sku]) => {
    window.__script = {};
    // 이베이·아마존 SKU 칸이 따로다 — 이 차는 두 몰이 같은 SKU 를 쓴다.
    for (const id of ['inp-sku', 'inp-amz-sku']) {
      const el = document.getElementById(id);
      el.value = sku;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    for (const [c, t] of [['KOREA', 'open1'], ['KOREA', 'open2'], ['KOREA', 'b2b'], ['KOREA', 'own'],
                          ['USA', 'open1'], ['USA', 'open2']]) handleCheck(c, t, true);
  }, [SKU]);
  await page.waitForFunction(() => {
    const w = document.getElementById('form-frame').contentWindow;
    return w?.document.readyState === 'complete' && typeof w.ebayEditItem === 'function' && typeof w.editItemOf === 'function';
  }, null, { timeout: 20000 });
  await page.waitForFunction(() => frameSyncTimer === null);
  const form = page.frames().find(f => f.url().includes('/index.html'));

  // ── 쿠팡·아마존·이베이에만 상품을 불러 둔다(탭의 불러오기 함수 그대로). 네이버는 안 불러온다 ──
  await form.evaluate(async ([sku, cpid]) => {
    window.__script = {
      'coupang-load-product': id => ({ success: true, product: { productId: Number(id), title: '쿠팡 EV3', options: [], detailImages: [] } }),
      'amazon-load-product': a => ({ success: true, product: { title: `Amazon ${a.sku}`, price: '30', stock: '5', brand: 'OGWM',
        mainImageUrl: '', description: '', bulletPoints: [], asin: 'B0TEST', status: 'BUYABLE' } }),
      'ebay-load-product': s => ({ success: true, data: { sku: s,
        offer: { status: 'PUBLISHED', offerId: 'O1', pricingSummary: { price: { value: '30' } }, availableQuantity: 3, listing: { listingId: 'L1' } },
        inventory: { product: { title: `eBay ${s}` }, availability: {} } } }),
      'coupang-update': a => ({ success: true, message: '쿠팡 저장됨', product: { productId: Number(a.productId), title: a.title, options: [], detailImages: [] } }),
      'amazon-update': { success: true, message: '아마존 접수됨' },
      'ebay-update': { success: true, data: {} },
    };
    document.getElementById('cpProductIdInput').value = cpid;
    await loadCoupangProduct();
    await loadAmazonProduct();
    document.querySelector('[data-eb="load"]').click();
  }, [SKU, CPID]);
  await form.waitForFunction(() => !window.ebayBusy() && window.ebayEditItem());

  // 수정할 상품이 없으면 던진다 — 그냥 거부 결과가 아니라 예외다.
  const thrown = await page.evaluate(() => {
    const win = document.getElementById('form-frame').contentWindow;
    try { requireEditItem({ name: '네이버', tabId: 'naverTab' }, win); return null; }
    catch (e) { return { name: e.name, typed: e instanceof EditItemMissingError, message: e.message }; }
  });
  assert.deepEqual(thrown, { name: 'EditItemMissingError', typed: true, message: '수정할 상품이 없습니다 — 네이버 탭에서 상품을 먼저 불러오세요' });

  const bulk = async () => {
    await form.evaluate(() => { window.__callArgs = []; });
    await page.evaluate(() => { window.__callArgs = []; bulkTiming.pauseMs = 0; return runBulkEdit(); });
    return {
      card: await page.locator('#bulk-edit-rows').innerText(),
      formCalls: await form.evaluate(() => window.__callArgs.map(([c]) => c)),
      shellCalls: await page.evaluate(() => window.__callArgs),
    };
  };

  {
    const { card, formCalls } = await bulk();
    const has = text => assert.ok(card.includes(text), `결과 카드에 "${text}" 가 없다:\n${card}`);
    has(`[네이버] 상품 없음: 수정할 상품이 없습니다 — 네이버 탭에서 상품을 먼저 불러오세요`);
    has(`[쿠팡 ${CPID}] 수정 완료`);
    has('[아임웹 B2B몰] 상품 없음: 수정할 상품이 없습니다 — 아임웹 B2B몰 탭에서 상품을 먼저 불러오세요');
    has('[아임웹 자사몰/게시판] 게시판 글은 Open API 가 없어(저장할 때 브라우저를 띄움) 일괄 수정에서 뺍니다 — 그 탭의 저장 버튼으로 수정하세요');
    has(`[아마존 ${SKU} · 미국] 수정 완료`);
    has(`[eBay 미국 ${SKU}] 수정 완료`);
    has('일괄 수정 완료 (성공: 3건, 실패: 2건 · 그중 상품 없음 2건, 건너뜀: 1건)');
    has('수정할 상품이 없는 몰: 네이버, 아임웹 B2B몰');
    // 상품이 없는 몰·건너뛴 몰은 저장 요청이 안 나간다.
    for (const ch of ['smartstore-update-product', 'imweb-update-group', 'imweb-update-post']) {
      assert.equal(formCalls.filter(c => c === ch).length, 0, `${ch} 가 나갔다`);
    }
    for (const ch of ['coupang-update', 'amazon-update', 'ebay-update']) {
      assert.equal(formCalls.filter(c => c === ch).length, 1, `${ch} 가 한 번 나가야 한다`);
    }
    assert.equal(await page.locator('#bulk-edit-status').textContent(), '실패 2건');
    assert.deepEqual(await page.evaluate(() => ({ running: isBulkRunning, disabled: document.getElementById('btn-bulk-edit').disabled })),
      { running: false, disabled: false });
  }

  // ── 탭의 저장 실패는 실패로 센다 ──
  {
    await form.evaluate(() => { window.__script['coupang-update'] = { success: false, error: '쿠팡 거부: 옵션 형식 오류' }; });
    const { card } = await bulk();
    assert.ok(card.includes(`[쿠팡 ${CPID}] 수정 실패: 쿠팡 거부: 옵션 형식 오류`), card);
    assert.ok(card.includes('다시 확인할 몰: 쿠팡'), card);
    assert.ok(card.includes('일괄 수정 완료 (성공: 2건, 실패: 3건 · 그중 상품 없음 2건, 건너뜀: 1건)'), card);
  }

  // ── 도는 중 모드 전환은 거절한다 ──
  {
    await form.evaluate(() => {
      window.__script['coupang-update'] = { success: true, message: 'ok' };
      window.__script['amazon-update'] = () => new Promise(r => { window.__release = () => r({ success: true, message: 'ok' }); });
      window.__release = null;
    });
    const run = page.evaluate(() => runBulkEdit());
    await form.waitForFunction(() => typeof window.__release === 'function', null, { timeout: 10000 });
    await page.evaluate(() => {
      const r = document.getElementById('mode-new');
      r.checked = true;
      r.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const during = await page.evaluate(() => ({ mode: currentMode, editChecked: document.getElementById('mode-edit').checked,
      card: document.getElementById('bulk-edit-rows').innerText }));
    await form.evaluate(() => window.__release());
    await run;
    assert.equal(during.mode, 'edit');
    assert.equal(during.editChecked, true);
    assert.match(during.card, /일괄 수정 중에는 모드를 바꿀 수 없습니다 — 끝난 뒤 바꾸세요\. 도중에 바꾸면 남은 몰이 신규 등록으로 넘어갑니다/);
    assert.match(await page.locator('#bulk-edit-rows').innerText(), /일괄 수정 완료 \(성공: 3건, 실패: 2건 · 그중 상품 없음 2건, 건너뜀: 1건\)/);
  }

  // ── 아임웹 B2B: 탭에 불러온 세트·개별 묶음을 탭의 저장(Open API imweb-update-group)으로 보낸다 ──
  {
    await form.evaluate(async () => {
      const choice = (name, values) => ({ name, values: values.map(valueName => ({ valueName })) });
      window.__script['imweb-load-group'] = { success: true, group: { baseKey: '옵틱글래스 기아 EV3 광각미러', sharedGroups: [{ name: '차종', values: ['EV3'] }],
        products: [
          { prodNo: 3240, type: 'set', suffix: '세트', price: 150000, detailImages: ['https://ai.esmplus.com/test/b2b.jpg'],
            optionGroups: [choice('차종', ['EV3'])], combos: [{ optionDetailCode: 'od1', displayText: 'EV3', price: 150000, stock: 5 }] },
          { prodNo: 3241, type: 'indiv', suffix: '개별', price: 80000, detailImages: [],
            optionGroups: [choice('차종', ['EV3']), choice('구성', ['운전석만', '조수석만'])],
            combos: [{ optionDetailCode: 'od2', displayText: 'EV3 / 운전석만', price: 80000, stock: 5 },
                     { optionDetailCode: 'od3', displayText: 'EV3 / 조수석만', price: 75000, stock: 5 }] },
        ] } };
      window.__script['imweb-update-group'] = { success: true, message: 'B2B 저장됨' };
      window.__script['amazon-update'] = { success: true, message: '아마존 접수됨' };   // 위 블록의 멈춰 세우는 답을 되돌린다
      await loadImwebB2bGroup(['3240', '3241']);
    });
    // 원화 변경 판매가를 적어 둬도 B2B 에는 넣지 않는다(B2B 가는 세트·개별·조합마다 다르다).
    await page.locator('#inp-edit-krw').fill('160000');
    await page.waitForFunction(() => frameSyncTimer === null);
    const { card, formCalls } = await bulk();
    await page.locator('#inp-edit-krw').fill('');
    await page.waitForFunction(() => frameSyncTimer === null);
    assert.ok(card.includes('[아임웹 B2B몰 3240+3241] 수정 완료\n'), card);
    assert.equal(formCalls.filter(c => c === 'imweb-update-group').length, 1, card);
    const sent = await form.evaluate(() => window.__callArgs.find(([c]) => c === 'imweb-update-group')[1]);
    assert.deepEqual(sent.products.map(p => [p.prodNo, Number(p.price), p.combos.map(c => Number(c.price))]),
      [[3240, 150000, [150000]], [3241, 80000, [80000, 75000]]], 'B2B 가격은 탭 값 그대로 — 좌측 변경 판매가를 넣지 않는다');
    assert.ok(card.includes('변경 판매가 (원) 160,000원: 넣은 몰이 없습니다'), card);
    // 쿠팡은 상품번호가 없어 판매가를 못 넣고 실패, 네이버는 상품 없음.
    assert.ok(card.includes('일괄 수정 완료 (성공: 3건, 실패: 2건 · 그중 상품 없음 1건, 건너뜀: 1건)'), card);
  }

  // ════ 변경 판매가 (원 · USD · 엔) ════
  // 칸은 수정 모드에서만, 그 통화의 몰을 켰을 때만 보인다. 목록은 국내 기준가 등급·환율가·이베이 표 판매가.
  const shown = id => page.evaluate(id => {
    const el = document.getElementById(id), box = el.closest('.mall-field');
    return getComputedStyle(box).display !== 'none' && !box.hidden;
  }, id);
  {
    assert.equal(await shown('inp-edit-krw'), true, '네이버·쿠팡을 켰으니 원화 칸이 보인다');
    assert.equal(await shown('inp-edit-usd'), true, '아마존 미국·이베이를 켰으니 USD 칸이 보인다');
    assert.equal(await shown('inp-edit-jpy'), false, '아마존 일본을 안 켰으니 엔화 칸은 숨는다');
    assert.equal(await page.locator('label[for="inp-edit-krw"]').innerText(), '변경 판매가 (원) · 네이버 · 쿠팡');
    await page.locator('label[for="mode-new"]').click();
    assert.equal(await shown('inp-edit-krw'), false, '신규 모드에는 변경 판매가가 없다');
    assert.equal(await shown('inp-edit-usd'), false);
    await page.locator('label[for="mode-edit"]').click();
    await page.waitForFunction(() => document.getElementById('form-frame').contentWindow.document
      .querySelector('input[name="cpWorkMode"]')?.value === 'edit');
  }
  {
    await page.evaluate(() => {
      window.__script['fx-auto-price-get'] = { success: true, data: { tiers: [
        { id: 'tier-2', label: 'BSA 미러', krw: 220000, preview: { USD: '160', JPY: '25000' } },
        { id: 'tier-1', label: '일반 미러', krw: 150000, preview: { USD: '110', JPY: '17000' } },
      ] } };
      return loadPriceTiers({ force: true });
    });
    const listOf = async id => {
      await page.locator('#' + id).focus();
      const items = await page.locator('.vu-combo-item').allInnerTexts();
      await page.locator('#' + id).blur();
      return items;
    };
    assert.deepEqual(await listOf('inp-edit-krw'), ['150,000원 · 일반 미러 (국내 기준가)', '220,000원 · BSA 미러 (국내 기준가)']);
    assert.deepEqual(await listOf('inp-edit-usd'), ['110 USD · 일반 미러 환율가 (국내 150,000원)', '160 USD · BSA 미러 환율가 (국내 220,000원)',
      '109.32 USD · BSA 없음 (이베이 표)', '160.34 USD · BSA (이베이 표)']);
    // 고르면 칸에는 숫자만 들어간다.
    await page.locator('#inp-edit-krw').focus();
    await page.locator('.vu-combo-item', { hasText: '150,000원' }).dispatchEvent('mousedown');
    assert.equal(await page.locator('#inp-edit-krw').inputValue(), '150000');
    assert.match(await page.locator('#inp-edit-krw').getAttribute('placeholder'), /비우면 지금 가격 그대로 \(목록에서 선택\)/);
  }

  // 네이버도 불러 두고, 쿠팡은 옵션이 둘인 상품을 불러 둔다. 위에서 신규 모드를 다녀와서 아마존 수정 폼이
  // 비워졌으므로(신규 모드는 그 칸을 신규 등록 값으로 쓴다) 아마존·이베이도 다시 불러온다.
  const loadPriced = async coupangOptions => {
    await form.evaluate(async ([options, cpid]) => {
      Object.assign(window.__script, {
        'smartstore-load-product': no => ({ success: true, product: { inputNo: no, originNo: no, revision: 'r1', title: '네이버 EV3',
          salePrice: 115000, groups: ['모델명', '상품선택'], detailImages: [],
          options: [{ index: 0, id: 1, isNew: false, names: ['기아 EV3', '24.10~[No.K138]BSA'], stockQuantity: 999, price: 0, usable: true }] } }),
        'smartstore-update-product': a => ({ success: true, message: '네이버 저장됨',
          product: { originNo: a.originNo, revision: 'r2', title: a.title, salePrice: a.salePrice ?? 115000, groups: ['모델명', '상품선택'],
            options: a.options, detailImages: a.detailImages } }),
        'coupang-load-product': id => ({ success: true, product: { productId: Number(id), title: '쿠팡 EV3', detailImages: [],
          options: options.map((o, index) => ({ index, sellerProductItemId: 10 + index, vendorItemId: 20 + index, attrs: [],
            stock: 10, imageUrl: '', isNew: false, ...o })) } }),
        'coupang-update': a => ({ success: true, message: '쿠팡 저장됨',
          // 메인처럼 다시 읽은 상품을 돌려준다 — 상세 이미지는 바꿨을 때만 요청에 실린다(안 바꾸면 불러온 그대로).
          product: { productId: Number(a.productId), title: a.title, options: a.options, detailImages: a.detailImages ?? [] } }),
        'amazon-update': { success: true, message: '아마존 접수됨' },
        'ebay-update': { success: true, data: {} },
      });
      // 모드를 오가면 탭이 찾는 칸을 스스로 고쳐 쓴다(쿠팡: 템플릿 ID ↔ 빈칸) — 다시 넣는다.
      document.getElementById('templateIdInput').value = '777';
      document.getElementById('cpProductIdInput').value = cpid;
      await loadSmartstoreProduct();
      if (!(await loadCoupangProduct())) throw new Error('쿠팡 상품을 불러오지 못했다');
      await loadAmazonProduct();
      document.querySelector('[data-eb="load"]').click();
    }, [coupangOptions, CPID]);
    await form.waitForFunction(() => !window.ebayBusy() && window.ebayEditItem() && window.editItemOf('amazonTab'));
  };
  const setPrices = async values => {
    for (const [id, value] of Object.entries(values)) await page.locator('#' + id).fill(value);
    await page.waitForFunction(() => frameSyncTimer === null);
  };
  const sentArgs = (calls, channel) => calls.filter(([c]) => c === channel).map(([, a]) => a);
  const bulkWithArgs = async () => {
    await form.evaluate(() => { window.__callArgs = []; });
    await page.evaluate(() => { window.__callArgs = []; return runBulkEdit(); });
    return { card: await page.locator('#bulk-edit-rows').innerText(),
      form: await form.evaluate(() => window.__callArgs), shell: await page.evaluate(() => window.__callArgs) };
  };
  // 상품번호는 이벤트 없이 넣는다 — 손으로 치면(input) 차가 바뀐 것으로 보고 SKU·판매가를 비운다(아래에서 따로 본다).
  await page.evaluate(() => { document.getElementById('inp-no').value = 'No.K138번'; });

  {
    await loadPriced([{ itemName: 'No.K138번 (2세대 전기형/24.10~) BSA', salePrice: 115000 }, { itemName: 'No.K140번 (2세대/24.10~)', salePrice: 99000 }]);
    await setPrices({ 'inp-edit-krw': '160,000', 'inp-edit-usd': '110' });
    const { card, form: calls } = await bulkWithArgs();
    const has = text => assert.ok(card.includes(text), `결과 카드에 "${text}" 가 없다:\n${card}`);
    has('일괄 수정 시작 (총 6개 플랫폼 · 변경 판매가 160,000원 · 110 USD)');
    has('[네이버 777] 수정 완료 · 판매가 115,000원 → 160,000원 (기본 판매가 · 옵션가 차액 유지)');
    has(`[쿠팡 ${CPID}] 수정 완료 · 판매가 115,000원 → 160,000원 (No.K138 BSA 옵션 1개)`);
    has(`[아마존 ${SKU} · 미국] 수정 완료 · 판매가 30 USD → 110 USD`);
    has(`[eBay 미국 ${SKU}] 수정 완료 · 판매가 30 USD → 110 USD`);
    assert.equal(sentArgs(calls, 'smartstore-update-product')[0]?.salePrice, 160000, '네이버 기본 판매가');
    const cp = sentArgs(calls, 'coupang-update')[0];
    assert.deepEqual(cp.options.map(o => [o.itemName, Number(o.salePrice)]),
      [['No.K138번 (2세대 전기형/24.10~) BSA', 160000], ['No.K140번 (2세대/24.10~)', 99000]], '쿠팡은 상품번호의 옵션만 바꾼다');
    assert.equal(sentArgs(calls, 'amazon-update')[0]?.price, '110');
    assert.equal(sentArgs(calls, 'amazon-update')[0]?.currency, 'USD');
    assert.equal(sentArgs(calls, 'ebay-update')[0]?.price, '110');
    // 네이버 탭 칸에도 들어가 있다(저장 뒤 네이버가 돌려준 값).
    assert.equal(await form.evaluate(() => document.getElementById('ssEditSalePrice').value), '160000');
  }

  // 같은 상품번호에 BSA·일반 옵션이 같이 있으면: SKU 로 모르면 그 몰만 멈추고, 알면 그쪽 옵션만 바꾼다.
  {
    await loadPriced([{ itemName: 'No.K138번 (2세대/24.10~)', salePrice: 115000 }, { itemName: 'No.K138번 (2세대/24.10~) BSA', salePrice: 165000 }]);
    const unknown = await bulkWithArgs();
    assert.ok(unknown.card.includes(`[쿠팡 ${CPID}] 수정 실패: 쿠팡 No.K138 옵션이 BSA·일반 두 가지라 어느 쪽 판매가인지 정할 수 없습니다`), unknown.card);
    assert.equal(sentArgs(unknown.form, 'coupang-update').length, 0, '못 정하면 쿠팡은 저장하지 않는다');
    assert.equal(sentArgs(unknown.form, 'smartstore-update-product').length, 1, '다른 몰은 그대로 간다');
    await page.evaluate(() => { window.__listing = window.VUSuggest.listing; window.VUSuggest.listing = sku => ({ sku, bsa: true }); });
    await loadPriced([{ itemName: 'No.K138번 (2세대/24.10~)', salePrice: 115000 }, { itemName: 'No.K138번 (2세대/24.10~) BSA', salePrice: 165000 }]);
    const known = await bulkWithArgs();
    assert.ok(known.card.includes(`[쿠팡 ${CPID}] 수정 완료 · 판매가 165,000원 → 160,000원 (No.K138 BSA 옵션 1개)`), known.card);
    assert.deepEqual(sentArgs(known.form, 'coupang-update')[0].options.map(o => Number(o.salePrice)), [115000, 160000]);
    // 바꾼 판매가를 넣었는데 저장이 거부되면 그 값이 탭에만 있다고 알린다. 이미 같던 값이면 그 말은 붙이지 않는다.
    await form.evaluate(() => { window.__script['coupang-update'] = { success: false, error: '쿠팡 거부: 판매가 변경폭 초과' }; });
    const same = await bulkWithArgs();
    assert.ok(same.card.includes(`[쿠팡 ${CPID}] 수정 실패: 쿠팡 거부: 판매가 변경폭 초과\n`), same.card);
    await setPrices({ 'inp-edit-krw': '170000' });
    const refused = await bulkWithArgs();
    await page.evaluate(() => { window.VUSuggest.listing = window.__listing; });
    assert.ok(refused.card.includes(`[쿠팡 ${CPID}] 수정 실패: 쿠팡 거부: 판매가 변경폭 초과 (판매가 170,000원: 탭에만 들어가 있고 저장되지 않았습니다)`), refused.card);
    await setPrices({ 'inp-edit-krw': '160000' });
  }

  // 틀린 판매가는 아무 몰에도 보내지 않는다. 숨은 칸(엔화 — 아마존 일본을 안 켬)의 값은 읽지 않는다.
  {
    await setPrices({ 'inp-edit-krw': '160005', 'inp-edit-usd': '110' });
    const bad = await bulkWithArgs();
    assert.ok(bad.card.includes('변경 판매가 (원) "160005" — 쿠팡 판매가는 10원 단위여야 합니다. 아무 몰도 저장하지 않았습니다.'), bad.card);
    assert.equal(bad.form.filter(([c]) => /update/.test(c)).length, 0, '아무 저장도 나가지 않는다');
    assert.equal(await page.locator('#bulk-edit-status').textContent(), '중단');
    await setPrices({ 'inp-edit-krw': '', 'inp-edit-usd': '1.234' });
    assert.match(await (await bulkWithArgs()).card, /변경 판매가 \(USD\) "1\.234" — 0보다 큰 소수 둘째 자리까지의 수로 입력하세요/);
    await setPrices({ 'inp-edit-usd': '' });
    await page.evaluate(() => { document.getElementById('inp-edit-jpy').value = '9999'; });
    const hidden = await bulkWithArgs();
    assert.ok(hidden.card.includes('일괄 수정 시작 (총 6개 플랫폼)'), hidden.card);
    assert.equal(sentArgs(hidden.form, 'amazon-update')[0]?.price, '110', '판매가를 비우면 탭의 가격 그대로 저장한다');
  }

  // 차를 바꾸면 변경 판매가를 비운다 — 앞 차에 매긴 가격이 다음 차에 저장되면 안 된다.
  {
    const brand = async value => {
      await page.evaluate(value => {
        const el = document.getElementById('inp-brand');
        el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }, value);
    };
    await brand('기아');
    await setPrices({ 'inp-edit-krw': '150000', 'inp-edit-usd': '110' });
    await brand('현대');
    assert.deepEqual(await page.evaluate(() => ['inp-edit-krw', 'inp-edit-usd', 'inp-edit-jpy'].map(id => document.getElementById(id).value)), ['', '', '']);
  }

  assert.deepEqual(errors, []);
  console.log('PASS: 일괄 수정 — 수정 모드 전용 버튼, 상품 없는 몰은 EditItemMissingError, 아임웹 B2B(Open API)·게시판 건너뜀, 카드 몰은 상품 없음, 실패 세기, 도중 모드 전환 거절, 변경 판매가(목록·몰별 적용·쿠팡 옵션·BSA·사전 검사·숨은 칸·차 바꾸면 비움)');
} finally {
  await browser.close();
}
