// 아임웹 자사몰(본사몰 optic-glass.co.kr) 탭 — 아임웹 Open API 만 쓴다(브라우저 · 관리자 세션 · 쇼핑몰 화면 요청 없음).
// 현황판 KOREA · USA · JAPAN 자사몰 칸 셋이 이 탭 하나를 같이 쓴다. 칸은 본사몰 한 사이트의 구역(KR · US · JP)이고,
// 셸이 보던 칸의 구역을 setImwebHeadScope 로 넘긴다(아마존 미국 · 일본과 같은 방식).
// 단일 상품 수정은 상품 일괄 수정의 채널을 그대로 탄다: bulk-price-list(찾기) · bulk-price-load-many(가격 줄 + 상세 이미지)
// · bulk-save-batch(저장). 그래서 저장은 일괄 수정 · 환율 자동 변경과 한 줄로 서고(BUSY) 아임웹 잠금 · 토큰도 같다.
// 신규 등록(.ih-new)은 상품 하나에 세 구역을 만든다(main imweb-head-register → imweb_head_create.js). 칸은 셸 좌측이 채우고
// (.shell-fed, index_up.html fillFrame), 탭은 생성될 상품명 · 판매가 칸 · 상세설명 · 조견표를 보인다. 모드별 보이기는 embedded-platform.css(.ih-new / .ih-edit).
(() => {
  const ipc = (typeof require !== 'undefined' ? require : window.parent.require)('electron').ipcRenderer;
  const UNITS = { 'imweb-ko': ['한국', 'KRW'], 'imweb-en': ['미국', 'USD'], 'imweb-jp': ['일본', 'JPY'] };
  const tab = document.createElement('button');
  tab.className = 'tab-btn';
  tab.setAttribute('onclick', "switchTab('imwebHeadTab')");
  // 상대경로는 이 스크립트가 아니라 문서(index.html) 기준으로 풀린다 → src/ui/logos/.
  tab.innerHTML = `
    <img class="tab-logo" src="logos/imweb.png" width="22" height="22" alt="">
    <div class="tab-text-wrap">
      <span class="tab-country" id="ihCountry">한국</span>
      <span class="tab-title">아임웹 자사몰</span>
    </div>
  `;
  document.querySelector('.app-tabs').append(tab);
  const panel = document.createElement('section');
  panel.id = 'imwebHeadTab'; panel.className = 'panel glass-panel tab-pane'; panel.style.display = 'none';
  panel.innerHTML = `
    <div class="panel-header"><h2>아임웹 자사몰 (본사몰 · Open API)</h2></div>
    <div class="ih-new">
      <div class="shell-fed">
        <div class="form-group row dual-input"><div class="input-col"><label class="form-label" for="ihBrand">제조사</label><input id="ihBrand" class="form-input" autocomplete="off"></div><div class="input-col"><label class="form-label" for="ihModel">차종</label><input id="ihModel" class="form-input" autocomplete="off"></div></div>
        <div class="form-group row dual-input"><div class="input-col"><label class="form-label" for="ihCode">상품번호</label><input id="ihCode" class="form-input" autocomplete="off"></div><div class="input-col"><label class="checkbox-btn"><input type="checkbox" id="ihBsa"><span>BSA O</span></label></div></div>
        <div class="form-group row dual-input"><div class="input-col"><label class="form-label" for="ihBrandEn">영문 제조사</label><input id="ihBrandEn" class="form-input" autocomplete="off"></div><div class="input-col"><label class="form-label" for="ihModelEn">영문 차종</label><input id="ihModelEn" class="form-input" autocomplete="off"></div></div>
        <div class="form-group row dual-input"><div class="input-col"><label class="form-label" for="ihBrandJp">일문 제조사</label><input id="ihBrandJp" class="form-input" autocomplete="off"></div><div class="input-col"><label class="form-label" for="ihModelJp">일문 차종</label><input id="ihModelJp" class="form-input" autocomplete="off"></div></div>
        <div class="form-group row dual-input"><div class="input-col"><label class="form-label" for="ihSpecUrl">조견표 URL (국내용)</label><input id="ihSpecUrl" class="form-input" autocomplete="off"></div><div class="input-col"><label class="form-label" for="ihSpecUrlEn">조견표 URL (해외용)</label><input id="ihSpecUrlEn" class="form-input" autocomplete="off"></div></div>
      </div>
      <div class="step-indicator"><div class="step-number">1</div><span>생성될 상품명 (한국 · 미국 · 일본 구역)</span></div>
      ${['Ko:한국', 'En:미국', 'Jp:일본'].map(x => x.split(':')).map(([k, c]) => `<div class="form-group"><label class="form-label" for="ihName${k}">${c}</label><input type="text" id="ihName${k}" class="form-input" readonly></div>`).join('')}
      <p class="help-text" id="ihNameWarn" style="color:var(--accent-warn)"></p>
      <div class="step-indicator"><div class="step-number">2</div><span>판매가</span></div>
      <div class="form-group row dual-input ih-row"><div class="input-col"><label class="form-label" for="ihKrwSet">한국 1set (원)</label><input type="number" min="0" id="ihKrwSet" class="form-input"></div><div class="input-col"><label class="form-label" for="ihKrwLeft">운전석 (원)</label><input type="number" min="0" id="ihKrwLeft" class="form-input"></div><div class="input-col"><label class="form-label" for="ihKrwRight">조수석 (원)</label><input type="number" min="0" id="ihKrwRight" class="form-input"></div></div>
      <div class="form-group row dual-input"><div class="input-col"><label class="form-label" for="ihUsd">미국 1set (USD)</label><input id="ihUsd" class="form-input" inputmode="decimal" autocomplete="off"></div><div class="input-col"><label class="form-label" for="ihJpy">일본 1set (JPY)</label><input id="ihJpy" class="form-input" inputmode="numeric" autocomplete="off"></div></div>
      <p class="help-text" id="ihPricePlan"></p>
      <p class="help-text">재고 수량: 아임웹 API는 옵션 상품 재고를 받지 않습니다.</p>
      <div class="step-indicator"><div class="step-number">3</div><span>상세설명</span></div>
      <div class="form-group"><label class="form-label" for="ihIntro">본문 맨 위에 덧붙일 글 (세 구역 공통 · 비우면 템플릿 본문 그대로)</label><textarea id="ihIntro" class="form-input" rows="3"></textarea></div>
      <div class="step-indicator"><div class="step-number">4</div><span>조견표</span></div>
      <div id="ihSpecPlan"></div>
      <p class="help-text">본문은 템플릿 상품 본문에서 조견표와 상세 이미지(이미지 목록)만 바꿉니다. 숨김으로 만들고 세 구역을 다시 읽어 모두 맞을 때만 판매중으로 바꿉니다 — 어긋나면 숨김으로 두고 상품번호를 알립니다(Open API 로는 지울 수 없습니다).</p>
      <div class="submit-section"><button type="button" class="btn btn-gradient w-full vu-key vu-key-accent" id="ihRegisterBtn">아임웹 자사몰 상품 등록 (한국 · 미국 · 일본)</button></div>
    </div>
    <div class="ih-edit">
      <p class="help-text" id="ihUnit"></p>
      <div class="form-group shell-owned"><label class="form-label" for="ihEditNo">상품번호</label><input id="ihEditNo" class="form-input" placeholder="예: 445, K123" autocomplete="off"></div>
      <div class="form-group"><label class="form-label" for="ihUrl">본사몰 상품 URL (넣으면 그 상품을 찾음)</label><input id="ihUrl" class="form-input" placeholder="예: https://optic-glass.co.kr/shop_view/?idx=1096" autocomplete="off"></div>
      <div class="submit-section"><button type="button" class="btn btn-outline w-full vu-key" id="ihFindBtn">상품 불러오기</button></div>
      <div id="ihResults" style="margin:6px 0"></div>
      <div id="ihLoaded" hidden>
        <h3 style="margin:2px 0;font-size:0.85rem">사진 · 상품 이미지</h3><div id="ihImageList"></div>
        <div class="form-group"><label class="form-label" for="ihName">상품명</label><input id="ihName" class="form-input" autocomplete="off"></div>
        <div class="form-group"><label class="form-label" for="ihBasePrice" id="ihBaseLabel">기본 판매가</label><input id="ihBasePrice" class="form-input" type="number" min="0"></div>
        <div id="ihCombos"></div>
        <p class="help-text">조합 가격은 추가금이 아니라 그 조합의 최종가입니다 — 기본 판매가만 바꾸면 조합 가격은 그대로입니다.</p>
        <p class="help-text" id="ihUnitNote"></p>
        <div class="submit-section"><button type="button" class="btn btn-gradient w-full vu-key vu-key-accent" id="ihUpdateBtn">아임웹 자사몰 상품 수정하기</button></div>
      </div>
    </div>`;
  document.querySelector('.tab-content-area').append(panel);
  const $ = id => document.getElementById(id);
  const key = () => $('ihEditNo').value.trim();
  const urlIdx = () => $('ihUrl').value.match(/[?&]idx=(\d+)/)?.[1] || '';
  // #ihLog 는 없다 — 줄마다 셸 로그로 넘긴다('[아임웹 자사몰] ' 머리말).
  const log = (message, type = 'info') => window.forwardLogToShell?.('imwebHead', message, type);
  // scope: 지금 칸의 구역. loaded: 불러온 상품 { scope, key, id, name, base, combos:[{optionId, label, price}], images, imageRevision }.
  // 구역이 바뀌어도 loaded · 입력은 지우지 않는다 — 저장만 거부한다(불러온 구역과 지금 구역이 같아야 저장).
  let scope = 'imweb-ko', loaded = null, images = [], busy = false, priceAsk = 0;

  function render() {
    const [country, currency] = UNITS[scope];
    $('ihCountry').textContent = country;
    $('ihUnit').textContent = `본사몰 ${country} 구역(${currency}) — 현황판 자사몰 칸을 누르면 구역이 바뀝니다.`
      + (loaded && loaded.scope !== scope ? ` 불러온 상품은 ${UNITS[loaded.scope][0]} 구역입니다 — 저장하려면 현황판 ${UNITS[loaded.scope][0]} 자사몰 칸을 다시 누르세요(입력 유지).` : '');
    $('ihUnitNote').textContent = scope === 'imweb-ko' ? '미국·일본 구역은 그대로입니다.'
      : "환율 탭 '아임웹 미국·일본' 저장이 가격을 한국가 기준으로 다시 덮습니다.";
    $('ihFindBtn').disabled = $('ihUpdateBtn').disabled = $('ihRegisterBtn').disabled = busy;
    renderImages();
  }
  function renderImages() {
    window.VUImageGallery.render($('ihImageList'), images, {
      scope: loaded?.scope || scope, isBusy: () => busy || !loaded,
      onReplace: urls => { images = [...urls]; renderImages(); },
      onRemove: index => { images.splice(index, 1); renderImages(); },
    });
  }
  // 버튼과 셸이 같은 길을 탄다. 바쁘면 거절하고, 던지지 않고 { ok, error? } 를 돌려준다(셸과의 약속).
  async function run(task) {
    if (busy) {
      const error = '아임웹 자사몰 탭이 다른 요청을 처리 중입니다. 끝난 뒤 다시 해주세요.';
      log(error, 'error'); return { ok: false, error };
    }
    busy = true; render();
    try { return await task(); } catch (e) { log(e.message, 'error'); return { ok: false, error: e.message }; } finally { busy = false; render(); }
  }

  // [상품 불러오기]: 좌측 상품번호로 한국 구역 목록에서 찾는다(상품번호 prodNo 는 세 구역이 같다).
  // 표에서 고른 상품은 상품번호 칸이 빈 채로 불러온다 — 저장 확인(key() === loaded.key)도 빈 값끼리 맞는다.
  // 목록 검색은 부분 일치라 '[No.104]' 가 '[No.1041]' 에도 걸린다 — 이름의 '[No.번호]' · '[No.번호(옵)]' 만 남긴다.
  // 상품번호가 비어 있으면(현황판에서 상품을 고르지 않음) 본사몰 전체 목록을 보여 준다.
  async function search() {
    const code = key();
    loaded = null; images = []; $('ihLoaded').hidden = true; $('ihResults').textContent = code ? '찾는 중...' : '전체 목록 읽는 중...';
    const res = await ipc.invoke('bulk-price-list', { scope: 'imweb-ko', query: code && !urlIdx() ? 'no.' + code : '' });
    $('ihResults').replaceChildren();
    if (!res?.success) throw new Error('찾기 실패: ' + (res?.error || '알 수 없는 오류'));
    if (key() !== code) throw new Error('찾는 사이 상품번호가 바뀌어 결과를 버렸습니다. 다시 불러오세요.');
    // 상품 URL 칸(…/shop_view/?idx=1096)이 있으면 상품번호 칸보다 먼저 — idx 가 곧 prodNo 다(세 구역 같음).
    const idx = urlIdx();
    if (idx) {
      const items = (res.data?.items || []).filter(p => String(p.id) === idx);
      if (!items.length) $('ihResults').textContent = `본사몰에 상품 ${idx}(URL idx) 이 없습니다.`;
      log(`본사몰 상품 URL idx=${idx} ${items.length}건`, items.length ? 'success' : 'error');
      return { items, code };
    }
    if (!code) {
      const items = res.data?.items || [];
      log(`본사몰 전체 ${items.length}건 — 수정할 상품을 고르세요.`, items.length ? 'success' : 'error');
      return { items, code };
    }
    const exact = new RegExp('\\[No\\.' + code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:\\(옵\\))?\\]', 'i');
    const items = (res.data?.items || []).filter(p => exact.test(p.name));
    if (!items.length) $('ihResults').textContent = `본사몰에 [No.${code}] 상품이 없습니다.`;
    log(`본사몰 [No.${code}] ${items.length}건${items.length > 1 ? ' — 수정할 상품을 고르세요.' : ''}`, items.length ? 'success' : 'error');
    return { items, code };
  }
  window.findImwebHead = async () => {
    const r = await run(search);
    // 표는 바쁨이 풀린 뒤 그린다 — 1건이면 표가 바로 고르는데(onSelect), 바쁜 중이면 불러오기가 거절된다.
    // 표는 찾은 상품번호(r.code)로 불러온다 — 좌측 번호를 바꾼 뒤 남은 옛 표에서 고르면 아래 확인이 버린다.
    if (r?.items?.length) window.VUProductTable.render($('ihResults'), r.items, {
      caption: '아임웹 자사몰 검색 결과', currency: 'KRW', onSelect: item => window.loadImwebHead(item.id, r.code),
    });
  };

  // 한 구역의 가격 줄(기본가 + 조합 최종가) · 상세 이미지 · 상품명. 기다리는 사이 구역 · 상품번호가 바뀌면 버린다.
  window.loadImwebHead = (prodNo, code = key()) => run(async () => {
    const at = { scope, key: code };
    log(`본사몰 ${UNITS[at.scope][0]} 구역 상품 ${prodNo} 불러오는 중...`, 'process');
    const res = await ipc.invoke('bulk-price-load-many', { scope: at.scope, ids: [String(prodNo)], includeImages: true });
    if (!res?.success) throw new Error('불러오기 실패: ' + (res?.error || '알 수 없는 오류'));
    const rows = res.data?.items?.[0]?.rows;
    if (!rows) throw new Error('불러오기 실패: ' + (res.data?.items?.[0]?.error || res.data?.blocked || '결과가 비어 있습니다'));
    if (scope !== at.scope || key() !== at.key) throw new Error('불러오는 사이 구역이나 상품번호가 바뀌어 결과를 버렸습니다. 다시 불러오세요.');
    const base = rows.find(r => !r.optionId) || rows[0], currency = UNITS[at.scope][1];
    loaded = { ...at, id: base.id, name: base.name, base: base.price, images: base.images || [], imageRevision: base.imageRevision,
      combos: rows.filter(r => r.optionId).map(r => ({ optionId: r.optionId, label: r.variant.replace(/^조합 · /, ''), price: r.price })) };
    images = [...loaded.images];
    $('ihName').value = loaded.name;
    $('ihBaseLabel').textContent = base.variant.replace('기본 판매가', `기본 판매가 (${currency})`);
    $('ihBasePrice').value = loaded.base; $('ihBasePrice').step = currency === 'USD' ? '0.01' : '1';
    $('ihCombos').replaceChildren(...loaded.combos.map((c, i) => {
      const group = document.createElement('div'), label = document.createElement('label'), input = document.createElement('input');
      group.className = 'form-group'; label.className = 'form-label'; input.className = 'form-input';
      label.htmlFor = input.id = 'ihCombo' + i; input.type = 'number'; input.min = '0'; input.step = $('ihBasePrice').step;
      label.textContent = `${c.label} — 최종가 (${currency})`; input.value = c.price;
      group.append(label, input); return group;
    }));
    $('ihLoaded').hidden = false;
    window.setEditButtonLabel('ihUpdateBtn', '아임웹 자사몰', 'ihName');
    log(`✓ ${loaded.name} (${UNITS[at.scope][0]} 구역 · 조합 ${loaded.combos.length}개) 불러오기 완료`, 'success');
    return { ok: true };
  });

  // 바뀐 줄만 보낸다: 가격(불러온 값 expectedPrice) · 상품명(expectedName) · 상세 이미지(expectedRevision).
  // 서버는 보내기 전에 다시 읽어 불러온 값과 다르면 보내지 않고, 보낸 뒤 다시 읽어 확인한다(VERIFIED / CHECK).
  async function save() {
    if (!loaded) throw new Error('먼저 상품을 불러와주세요.');
    if (loaded.scope !== scope) throw new Error(`불러온 상품은 ${UNITS[loaded.scope][0]} 구역인데 지금 칸은 ${UNITS[scope][0]} 구역입니다 — 현황판 ${UNITS[loaded.scope][0]} 자사몰 칸을 다시 누르면 입력을 그대로 두고 저장할 수 있습니다.`);
    if (key() !== loaded.key) throw new Error(`불러온 상품번호(${loaded.key})와 지금 상품번호(${key() || '빈칸'})가 다릅니다 — 상품 불러오기를 다시 눌러주세요.`);
    const name = $('ihName').value.trim();
    if (!name) throw new Error('상품명을 입력해주세요.');
    // [No.번호] 를 지우면 탭 찾기 · 신규 등록 중복 검사(findExisting)에서 빠져 같은 차가 또 만들어진다(API 로 지울 수 없음).
    const tag = loaded.name.match(/\[No\.[^\]]+\]/i)?.[0];
    if (tag && !name.includes(tag)) throw new Error(`상품명에 ${tag} 를 남겨 주세요 — 찾기 · 중복 검사가 이 표시로 상품을 찾습니다.`);
    const jobs = [], labels = [], { id } = loaded;
    const price = (optionId, before, value, label) => {
      value = value.trim();
      if (value === '' || Number(value) !== Number(before)) { jobs.push({ type: 'price', id, optionId, newPrice: value, expectedPrice: before }); labels.push(label); }
    };
    price('', loaded.base, $('ihBasePrice').value, '기본 판매가');
    loaded.combos.forEach((c, i) => price(c.optionId, c.price, $('ihCombo' + i).value, '조합 ' + c.label));
    if (name !== loaded.name.trim()) { jobs.push({ type: 'name', id, newName: name, expectedName: loaded.name }); labels.push('상품명'); }
    if (images.join('\n') !== loaded.images.join('\n')) {
      // 이미지를 바꿀 때만 본다 — 원래 0장인 상품도 가격 · 이름은 고칠 수 있어야 한다.
      if (!images.length) throw new Error('상세 이미지는 최소 1장 필요합니다.');
      jobs.push({ type: 'images', id, urls: images, expectedRevision: loaded.imageRevision }); labels.push('상세 이미지');
    }
    if (!jobs.length) { log('바뀐 값이 없어 보내지 않았습니다.', 'info'); return { ok: true, message: '변경 없음' }; }
    const at = loaded;
    log(`본사몰 ${UNITS[at.scope][0]} 구역 상품 ${id} — ${labels.join(', ')} 저장 중...`, 'process');
    let res;
    try { res = await ipc.invoke('bulk-save-batch', { jobId: crypto.randomUUID(), scope: at.scope, jobs }); }
    catch (e) { res = { success: false, error: e?.message || String(e) }; }
    if (!res?.success) throw new Error('저장 실패: ' + (res?.error || '알 수 없는 오류'));
    const failed = [];
    jobs.forEach((job, i) => {
      const r = (res.data?.results || []).find(x => x.index === i);
      if (r?.success && ['VERIFIED', 'UNCHANGED'].includes(r.data?.status)) {
        // 확인된 값을 불러온 값으로 삼는다 — 다음 저장이 같은 줄을 또 보내거나 '불러온 뒤 바뀌었다' 로 막히지 않게.
        if (job.type === 'name') at.name = name;
        else if (job.type === 'images') { at.images = [...job.urls]; at.imageRevision = r.data.revision || at.imageRevision; }
        else if (job.optionId) at.combos.find(c => c.optionId === job.optionId).price = job.newPrice;
        else at.base = job.newPrice;
        log(`✓ ${labels[i]}${r.data.status === 'UNCHANGED' ? ' (이미 같은 값)' : ''}`, 'success');
      } else {
        failed.push(`${labels[i]}: ${r ? r.error || r.data?.message || r.data?.status : '보내지 않음(' + (res.data?.stopped || '앞 줄에서 멈춤') + ')'}`);
        log(`✗ ${failed.at(-1)}`, 'error');
      }
    });
    if (!failed.length) return { ok: true, message: `${labels.join(', ')} 저장` };
    const error = failed.join(' · ');
    return failed.length < jobs.length ? { ok: false, partial: true, error } : { ok: false, error };
  }
  window.updateImwebHead = () => run(save);
  // 셸의 일괄 수정이 묻는다: 불러온 상품이 있나(index.html editItemOf). 구역이 다르면 없는 것으로 친다.
  window.imwebHeadEditItem = () => (loaded && loaded.scope === scope
    ? { id: loaded.id, name: $('ihName').value.trim() || loaded.name, market: UNITS[scope][0] } : null);
  // 셸이 보던 칸의 구역을 넘긴다. 표시만 바꾼다 — 입력 · 불러온 상품은 그대로 두고 저장 때 거부한다.
  window.setImwebHeadScope = next => {
    if (!UNITS[next] || next === scope) return;
    scope = next; render();
  };
  // ── 신규 등록 ──
  // 상품명 형식은 main(imweb_head_create.js)과 같다. 가격 칸의 처음 값은 템플릿 가격 · 환율 환산이고, 등록은 칸 값으로 한다.
  const TEMPLATE = { X: ['2153', [150000, 80000, 70000]], O: ['2116', [220000, 115000, 105000]] };
  const UNIT_NAME = { en: ['미국', '영문', 'Wide View Side Mirror'], jp: ['일본', '일문', '広角ドアミラー'] };
  const KRW_IDS = ['ihKrwSet', 'ihKrwLeft', 'ihKrwRight'];
  // 자동 값은 칸이 비었거나 지난번 자동 값 그대로일 때만 넣는다 — 사람이 고친 값은 둔다.
  const autoFill = (id, value) => {
    const el = $(id), v = String(value ?? '');
    if (el.value === '' || el.value === el.dataset.auto) el.value = v;
    el.dataset.auto = v;
  };
  function newData() {
    const v = id => $(id).value.trim(), bsa = $('ihBsa').checked;
    return { brand: v('ihBrand'), model: v('ihModel'), titleBrand: v('ihBrand'), titleModel: v('ihModel'),
      code: v('ihCode').replace(/^No\.\s*/i, ''), bsaO: bsa, bsaX: !bsa,
      titleBrandEn: v('ihBrandEn'), titleModelEn: v('ihModelEn'), titleBrandJp: v('ihBrandJp'), titleModelJp: v('ihModelJp'),
      specImageUrl: v('ihSpecUrl'), specImageUrlEn: v('ihSpecUrlEn'),
      krwPrices: KRW_IDS.map(v), usdPrice: v('ihUsd'), jpyPrice: v('ihJpy'), intro: $('ihIntro').value };
  }
  function renderNew() {
    const d = newData(), kr = `옵틱글래스 ${d.brand} ${d.model} 광각미러 [No.${d.code}]`, warns = [];
    const unit = (lang, b, m) => {
      const [country, field, mirror] = UNIT_NAME[lang];
      const name = ['Optic-glass', b, m, mirror, `[No.${d.code}]`].join(' ').replace(/\s*\([^)]*[가-힣][^)]*\)/g, '');
      if (b && m && !/[가-힣]/.test(name)) return name;
      warns.push(`${country} 구역 상품명: ${field} 제조사 · 차종이 없어 한국 이름으로 올라갑니다 — 좌측 ${field} 칸을 채우거나, 등록 뒤 환율 탭 '이름 번역'으로 고치세요.`);
      return kr;
    };
    const names = [['한국', kr], ['미국', unit('en', d.titleBrandEn, d.titleModelEn)], ['일본', unit('jp', d.titleBrandJp, d.titleModelJp)]];
    names.forEach(([c, n], i) => { $('ihName' + ['Ko', 'En', 'Jp'][i]).value = n; });
    $('ihNameWarn').textContent = warns.map(w => '⚠ ' + w).join(' ');
    const [no, tpl] = TEMPLATE[d.bsaO ? 'O' : 'X'];
    KRW_IDS.forEach((id, i) => autoFill(id, tpl[i]));
    const krw = KRW_IDS.map(id => Number($(id).value) || 0);
    d.krwPrices = KRW_IDS.map(id => $(id).value.trim());
    const head = `처음 값: 템플릿 ${no} (BSA ${d.bsaO ? 'O' : 'X'}) 가격. 미국 1set = 좌측 판매가(USD), 일본 1set = 그 환율 환산. 미국 · 일본 운전석 · 조수석은 한국가를 환율 환산합니다.`;
    $('ihPricePlan').textContent = head;
    // 일본 1set 처음 값 · 미국이 비었을 때의 환산값은 main 이 등록과 같은 계산(planUnitPrices)으로 낸다. 늦게 온 옛 답은 버린다.
    const ask = ++priceAsk;
    if (krw.every(v => v > 0)) ipc.invoke('imweb-head-price-preview', { krw: { base: krw[0], combos: krw }, usd: d.usdPrice }).then(r => {
      if (ask !== priceAsk) return;
      if (!r?.success) { $('ihPricePlan').textContent = `${head} 미국 · 일본 가격을 계산하지 못했습니다: ${r?.error || '알 수 없는 오류'}`; return; }
      autoFill('ihJpy', r.plan.JPY.combos[0]);
      $('ihUsd').placeholder = `비우면 ${r.plan.USD.combos[0]} (한국가 환산)`;
    }, () => {});
    $('ihSpecPlan').replaceChildren(...[['국내용(한국)', d.specImageUrl || '없음 — 등록할 수 없습니다'], ['해외용(미국 · 일본)', d.specImageUrlEn || '없음 — 국내용을 씁니다']]
      .map(([k, u]) => Object.assign(document.createElement('p'), { className: 'help-text', textContent: `조견표 ${k}: ${u}` })));
    return { d, kr };
  }
  // 셸 일괄 등록과 버튼이 같은 길. 던지지 않고 { ok, error? } (셸과의 약속) — 거절 이유 · 결과는 셸 로그로.
  window.registerImwebHead = () => run(async () => {
    const { d, kr } = renderNew();
    if (!d.brand || !d.model || !d.code) throw new Error('제조사 · 차종 · 상품번호를 모두 입력해 주세요.');
    if (!d.specImageUrl) throw new Error('국내용 조견표가 없습니다 — 좌측 Korea 사진 불러오기로 조견표를 넣어 주세요.');
    log(`본사몰 신규 등록(한국 · 미국 · 일본): ${kr}`, 'process');
    const res = await window.invokeForm(() => window.invokeWithImages(ipc, 'imweb-head-register', d));
    if (!res.success) throw new Error(res.error || '알 수 없는 오류');
    log(`✓ 상품번호 ${res.result?.no} ${res.message || '등록 완료'}`, 'success');
    return { ok: true };
  });
  panel.querySelector('.ih-new').addEventListener('input', renderNew);
  panel.querySelector('.ih-new').addEventListener('change', renderNew);
  $('ihRegisterBtn').addEventListener('click', () => window.registerImwebHead());
  renderNew();
  $('ihFindBtn').addEventListener('click', () => window.findImwebHead());
  // URL 을 붙여 넣으면(idx 가 바뀌면) 바로 찾아 그 상품 줄을 [선택] 표로 보인다.
  let lastIdx = '';
  $('ihUrl').addEventListener('input', () => { const idx = urlIdx(); if (idx && idx !== lastIdx) { lastIdx = idx; window.findImwebHead(); } else if (!idx) lastIdx = ''; });
  $('ihUpdateBtn').addEventListener('click', () => window.updateImwebHead());
  render();
})();
