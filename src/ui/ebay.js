// Reuse the existing VERY UP forms, tabs and logs. Credentials are never read back.
(() => {
  const ipc = (typeof require !== 'undefined' ? require : window.parent.require)('electron').ipcRenderer;
  const tab = document.createElement('button');
  tab.className = 'tab-btn';
  tab.setAttribute('onclick', "switchTab('ebayTab')");
  // 상대경로는 이 스크립트가 아니라 문서(index.html) 기준으로 풀린다 → src/ui/logos/.
  tab.innerHTML = `
    <img class="tab-logo tab-logo-wide" src="logos/ebay.png" height="22" alt="">
    <div class="tab-text-wrap">
      <span class="tab-country">미국</span>
      <span class="tab-title">eBay 미국</span>
    </div>
  `;
  document.querySelector('.app-tabs').append(tab);
  const panel = document.createElement('section');
  panel.id = 'ebayTab'; panel.className = 'panel glass-panel tab-pane'; panel.style.display = 'none';
  const input = (id, label, placeholder = '', type = 'text', cls = '') => `<div class="form-group${cls ? ' ' + cls : ''}"><label class="form-label" for="${id}">${label}</label><input id="${id}" class="form-input" type="${type}" placeholder="${placeholder}" autocomplete="off"></div>`;
  const button = (action, text, id = '') => `<button type="button" class="btn btn-outline btn-sm" data-eb="${action}" ${id ? `id="${id}"` : ''}>${text}</button>`;
  panel.innerHTML = `
    <div class="panel-header" style="display:flex;justify-content:space-between"><h2>eBay 미국 상품 등록 (USD)</h2><span class="status-badge" id="ebStatus">설정 확인 중</span></div>
    <details id="ebApiAccordion" class="api-accordion"><summary class="api-accordion-summary"><span>eBay API 설정 · 판매자 연결</span></summary>
      <div class="api-accordion-content">
        <div class="form-group"><label class="form-label" for="ebEnvironment">환경</label><select id="ebEnvironment" class="form-input"><option value="sandbox">Sandbox · 테스트</option><option value="production">Production · 실제 판매</option></select></div>
        <p class="help-text">환경별 eBay 개발자 키와 판매자 동의가 필요합니다. 미국 고정가·새 상품·단일 SKU를 지원합니다.</p>
        ${input('ebClientId', 'Client ID (App ID)')}
        ${input('ebClientSecret', 'Client Secret (Cert ID)', '빈칸이면 기존 값 유지', 'password')}
        ${input('ebRuName', 'RuName', '개발자 포털의 Redirect URL name')}
        ${input('ebRefreshToken', 'Refresh Token (직접 입력 시)', '판매자 연결 버튼으로 발급 가능', 'password')}
        <div class="btn-row">${button('saveConfig', '설정 저장')}${button('connect', '판매자 연결')}${button('disconnect', '연결 해제')}</div>
        <p class="help-text">RuName의 동의 완료 URL을 개발자 포털에 등록하세요. 판매자 연결 후 이동한 페이지의 전체 주소를 아래에 붙여넣으세요.</p>
        ${input('ebCallback', '동의 완료 페이지 URL', 'code와 state를 포함한 전체 주소', 'password')}${button('completeAuth', '연결 완료')}
        <div class="btn-row" style="margin-top:10px">${button('settings', '연결 테스트 · 정책/출고지 조회')}</div>
        <p class="help-text">판매자 계정에 미국 배송·결제·반품 정책과 Inventory 출고지를 준비하세요. 조회 후 항목을 선택하고 저장하세요.</p>
        ${input('ebLocation', '출고지 키 (merchantLocationKey)')}${input('ebFulfillment', '배송 정책 ID')}${input('ebPayment', '결제 정책 ID')}${input('ebReturn', '반품 정책 ID')}
        ${button('saveConfig', '정책 설정 저장')}
      </div>
    </details>
    <details style="margin-top:6px;margin-bottom:6px">
      <summary style="cursor:pointer;margin-bottom:6px;font-weight:500">새 출고지 직접 생성 (출고지가 없을 때만 열기)</summary>
      <p class="help-text">출고지가 0건이면 아래에서 새로 만드세요. 만든 뒤 위 출고지 키 칸에 자동으로 채워집니다.</p>
      ${input('ebLocKey', '새 출고지 키', '예: MAIN-WH · 영숫자/하이픈 36자 이내')}${input('ebLocName', '출고지 이름', '예: Main Warehouse')}
      ${input('ebLocLine1', '주소', '영문 표기 권장')}${input('ebLocCity', '도시')}
      ${input('ebLocState', '주 · 도 (선택)')}${input('ebLocPostal', '우편번호')}${input('ebLocCountry', '국가 코드', '예: KR')}
      ${button('createLocation', '출고지 생성')}
    </details>
    <div class="step-indicator"><div class="step-number">2</div><span>상품 정보</span></div>
    <div class="form-group"><label class="form-label" for="ebMode">작업 모드</label><select id="ebMode" class="form-input"><option value="new">신규 등록</option><option value="edit">기존 상품 관리 · SKU 조회</option></select></div>
    <div id="ebNewForm">
      ${input('ebSku', '고유 SKU', '예: OG-123-L-BSA · 좌우/옵션마다 다르게 입력', 'text', 'shell-owned')}
      ${input('ebTitle', '영문 상품명 (최대 80자)', '상품 브랜드와 호환 차량을 구분해주세요')}
      <div class="form-group row dual-input quad-input"><div class="input-col">${input('ebBrand', '상품 브랜드', '예: OpticGlass')}</div><div class="input-col">${input('ebMpn', '제조사 부품번호 (MPN)', '실제 부품번호')}</div><div class="input-col">${input('ebPrice', '판매가 (USD)', '예: 59.99', 'number')}</div><div class="input-col">${input('ebQuantity', '전체 재고 / 미국 판매 수량', '예: 10', 'number')}</div></div>
      <details><summary>포장 무게·크기 (계산 배송비 정책 사용 시 입력)</summary>
        ${input('ebWeight', '포장 무게 (kg)', '예: 0.5', 'number')}
        <div class="form-group row dual-input"><div class="input-col">${input('ebLength', '가로 (cm)', '', 'number')}</div><div class="input-col">${input('ebWidth', '세로 (cm)', '', 'number')}</div><div class="input-col">${input('ebHeight', '높이 (cm)', '', 'number')}</div></div>
      </details>
      ${input('ebCategoryQuery', '카테고리 검색어 (영문)', '예: mirror glass')}${button('categories', '카테고리 검색')}
      <div id="ebCategories" class="btn-row" style="flex-wrap:wrap;margin-top:8px"></div>
      ${input('ebCategoryId', '미국 최하위 카테고리 ID', '검색 결과에서 선택 또는 직접 입력')}${button('aspects', '필수 상품 속성 조회')}
      <div id="ebAspectFields" style="margin-top:12px"></div>
      <div class="form-group"><label class="form-label" for="ebAspects">추가 상품 속성 (JSON)</label><textarea id="ebAspects" class="form-input" rows="4" spellcheck="false">{}</textarea><p class="help-text">예: {"Placement on Vehicle":["Left"]}. 구조화된 차량 호환표와 다중 옵션은 이번 버전에 포함되지 않습니다.</p></div>
      <div class="form-group"><label class="form-label" for="ebDescription">영문 상세설명 (일반 텍스트)</label><textarea id="ebDescription" class="form-input" rows="6"></textarea></div>
      <div class="shell-fed"><div class="form-group"><label class="form-label" for="ebImages">상품 이미지 HTTPS URL (한 줄에 하나)</label><textarea id="ebImages" class="form-input" rows="4" placeholder="실제 상품 사진을 첫 번째로 배치해주세요."></textarea></div>
      ${button('importEsm', 'ESM 이미지 가져오기')}
      <p class="help-text">공통 입력은 설명과 ESM 이미지를 채웁니다. 영문 상품명, SKU, USD 가격과 실제 상품 사진을 확인해주세요.</p></div>
      <div class="btn-row">${button('preview', '검증 · 미리보기')}${button('draft', '초안 저장')}${button('publish', '초안 게시', 'ebPublish')}</div>
      <p class="help-text">같은 입력으로 재실행하면 저장된 초안을 복구합니다. 저장 이후 상품 정보를 변경하려면 새 SKU를 사용하세요.</p>
      <pre id="ebPreview" style="white-space:pre-wrap;overflow-wrap:anywhere;max-height:280px;overflow:auto"></pre>
    </div>
    <div id="ebEditForm" hidden>
      <div id="ebMigrationCard" style="background:var(--paper-2);border:1px solid var(--rule);border-radius:var(--radius);padding:8px 10px;margin-bottom:8px">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
          <div>
            <strong>기존 eBay 활성 리스팅 동기화 (로컬 캐시 + 즉시 이관)</strong>
            <p class="help-text" style="margin:4px 0 0" id="ebActiveStatus">웹(Seller Hub)으로 등록한 리스팅을 로컬에 빠르게 동기화하고, 수정할 상품만 즉시 이관합니다.</p>
          </div>
          <div class="btn-row" style="margin:0">
            ${button('refreshCache', '활성 리스팅 목록 동기화')}${button('checkActive', '동기화 상태 확인')}
          </div>
        </div>
        <div id="ebMigrateProgress" style="display:none;margin-top:10px">
          <div style="font-size:12px;margin-bottom:4px" id="ebMigrateProgressText">동기화 진행 중...</div>
          <div style="width:100%;height:6px;background:var(--paper-3);border-radius:3px;overflow:hidden">
            <div id="ebMigrateProgressBar" style="width:0%;height:100%;background:var(--accent)"></div>
          </div>
        </div>
      </div>
      <div class="inline-field">${input('ebSearchText', '기존 상품 검색 (SKU / 상품명 / 브랜드)', '빈칸이면 전체 목록 조회')}${button('search', '기존 상품 목록 조회')}</div>
      <p class="help-text">Inventory API로 관리하는 미국 고정가 상품과 초안을 조회합니다. 상품을 선택하면 수정 정보를 불러옵니다.</p>
      <div id="ebSearchResults" aria-live="polite" style="margin:6px 0"></div>
      <div class="inline-field">${input('ebEditSku', '조회할 SKU 또는 Listing ID', 'SKU 또는 12자리 Listing ID', 'text', 'shell-owned')}${button('load', '상품 불러오기')}</div>
      <p id="ebLoaded" style="white-space:pre-wrap;overflow-wrap:anywhere;margin:4px 0">상품을 먼저 조회해주세요.</p>
      ${input('ebEditTitle', '영문 상품명 (최대 80자)', '바꿀 때만 고치세요 — 상품 이미지와 같은 요청으로 저장됩니다')}
      <h3 style="margin:2px 0;font-size:0.85rem">사진 · 상품 이미지</h3><div id="ebEditImageList"></div>
      <div class="form-group row dual-input"><div class="input-col">${input('ebEditPrice', '변경 판매가 (USD)', '', 'number')}</div><div class="input-col">${input('ebEditQuantity', '변경 미국 판매 수량', '', 'number')}</div></div>
      <p class="help-text">전체 재고와 타 국가 판매 수량은 변경하지 않습니다. 미국 판매 수량은 조회된 전체 재고 이하로 입력하세요.</p>
      <div class="btn-row">${button('update', '상품 변경 저장', 'ebUpdate')}${button('publishLoaded', '저장된 초안 게시', 'ebPublishLoaded')}${button('withdraw', '판매 중단', 'ebWithdraw')}</div>
    </div>
    <div class="step-indicator"><div class="step-number">3</div><span>실행 로그</span></div>
    <div class="log-container mt-lg"><div class="log-header"><h3>eBay 작업 로그</h3></div><div class="log-window" id="ebLog" aria-live="polite"></div></div>`;
  document.querySelector('.tab-content-area').append(panel);
  const $ = id => document.getElementById(id);
  const value = id => $(id).value.trim();
  let savedDraft = null, loaded = null, aspectCategory = '', busy = false, configDirty = false;
  let editImages = null, imageSaveUncertain = false;
  // loadedKey: 불러올 때 조회 칸에 있던 값(SKU 또는 Listing ID). loaded.sku 는 서버가 풀어 준 SKU 라,
  // Listing ID 로 불러왔거나 SKU 를 다른 대소문자로 쳤으면 칸과 영영 같지 않아 수정 버튼이 막혔다.
  // 칸과 비교는 이 값으로(앞뒤 공백·대소문자 무시), eBay 요청은 loaded.sku 로 한다.
  let loadedKey = '';
  // 셸이 넣어 준 조견표 이미지 주소(지난번 것)와 그때 받은 주소 묶음. 차가 바뀌어 조견표가 바뀌면 이것만
  // 빼고 새 것을 그 자리에 넣는다 — 예전에는 더하기만 해서 앞 차의 조견표가 다음 차 초안의 첫 이미지로
  // 남았다. 사람이 적었거나 'ESM 이미지 가져오기' 로 넣은 주소는 셸 것이 아니므로 그대로 둔다.
  let shellImages = [], shellImageSet = '';
  const configMap = { environment: 'ebEnvironment', clientId: 'ebClientId', ruName: 'ebRuName', merchantLocationKey: 'ebLocation', fulfillmentPolicyId: 'ebFulfillment', paymentPolicyId: 'ebPayment', returnPolicyId: 'ebReturn' };
  const log = (message, type = 'system') => {
    const entry = document.createElement('div'); entry.className = `log-entry ${type}`; entry.textContent = `[${new Date().toLocaleTimeString('ko-KR')}] ${message}`;
    $('ebLog').append(entry); $('ebLog').scrollTop = $('ebLog').scrollHeight;
    // #ebLog 는 셸에서 숨는다 — 줄마다 셸 로그로도 넘긴다('[eBay] ' 머리말, 단계 유지).
    window.forwardLogToShell?.('ebay', message, type);
  };
  const call = async (channel, data) => {
    const result = await window.invokeWithImages(ipc, `ebay-${channel}`, data);
    if (!result?.success) throw new Error(result?.error || 'eBay 요청에 실패했습니다.');
    return result.data;
  };
  ipc.on('ebay-cache-progress', (_, p) => {
    const wrap = $('ebMigrateProgress');
    const bar = $('ebMigrateProgressBar');
    const text = $('ebMigrateProgressText');
    if (!wrap || !bar || !text) return;
    wrap.style.display = 'block';
    const pct = p.total ? Math.round((p.loaded / p.total) * 100) : 0;
    bar.style.width = `${pct}%`;
    text.textContent = `목록 동기화 중: ${p.loaded || 0} / ${p.total || '?'}건 (${pct}%)...`;
  });
  ipc.on('ebay-migrate-progress', (_, p) => {
    const wrap = $('ebMigrateProgress');
    const bar = $('ebMigrateProgressBar');
    const text = $('ebMigrateProgressText');
    if (!wrap || !bar || !text) return;
    wrap.style.display = 'block';
    if (p.stage === 'fetch') {
      text.textContent = `기존 리스팅 목록 조회 중: ${p.loaded || 0} / ${p.total || '?'}건...`;
    } else {
      const pct = p.total ? Math.round((p.processed / p.total) * 100) : 0;
      bar.style.width = `${pct}%`;
      text.textContent = `이관 진행 중: ${p.processed || 0} / ${p.total || 0}건 (${pct}%) · 성공 ${p.successful || 0}건, 실패 ${p.failed || 0}건`;
    }
  });
  const sameKey = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
  // 불러온 상품이 지금 조회 칸의 상품일 때만 그 상품을 돌려준다(수정·게시·판매 중단이 쓴다).
  const loadedForField = () => (loaded && sameKey(loadedKey, value('ebEditSku')) ? loaded : null);
  function requireLoaded() {
    if (!loaded) throw new Error('상품을 먼저 조회해주세요.');
    // 불러온 뒤 조회 칸이 이벤트 없이 바뀌었으면(탭 스크립트·셸) 칸의 상품과 불러온 상품이 다르다.
    // 그대로 하면 칸은 B 인데 수정·판매 중단은 A 에 한다.
    if (!loadedForField()) throw new Error(`불러온 상품(${loadedKey})과 지금 조회 칸(${value('ebEditSku') || '빈칸'})이 다릅니다 — 상품 불러오기를 다시 눌러주세요.`);
    return loaded;
  }
  function renderEditImages() {
    const product = loaded;
    window.VUImageGallery.render($('ebEditImageList'), product ? (editImages ?? product.inventory?.product?.imageUrls ?? []) : [], {
      isBusy: () => busy || !loadedForField() || imageSaveUncertain,
      scope: 'ebay', onReplace: urls => {
        if (loaded !== product || !product) return;
        editImages = [...urls]; renderEditImages();
      },
      onRemove: index => {
        if (product !== loaded) return;
        editImages = [...(editImages ?? product.inventory.product.imageUrls)];
        editImages.splice(index, 1); renderEditImages();
      },
    });
  }
  function refreshButtons() {
    renderEditImages();
    for (const group of [panel, document.getElementById('ebApiAccordion')].filter(Boolean))
      group.querySelectorAll('button[data-eb],input,textarea,select').forEach(el => { el.disabled = busy; });
    const live = loadedForField();
    $('ebPublish').disabled = busy || !savedDraft; $('ebUpdate').disabled = busy || live?.offer.status !== 'PUBLISHED';
    $('ebWithdraw').disabled = busy || live?.offer.status !== 'PUBLISHED'; $('ebPublishLoaded').disabled = busy || !live || live.offer.status === 'PUBLISHED';
  }
  const invalidate = () => { savedDraft = null; loaded = null; $('ebSearchResults').replaceChildren(); refreshButtons(); };
  function fillConfig(config) {
    for (const [key, id] of Object.entries(configMap)) $(id).value = config[key] || (key === 'environment' ? 'sandbox' : '');
    $('ebClientSecret').value = ''; $('ebRefreshToken').value = '';
    $('ebClientSecret').placeholder = config.hasClientSecret ? '암호화 저장됨 · 빈칸이면 유지' : 'Client Secret';
    $('ebRefreshToken').placeholder = config.hasRefreshToken ? '암호화 저장됨 · 빈칸이면 유지' : '판매자 연결 또는 직접 입력';
    $('ebStatus').textContent = `${config.environment === 'production' ? '실제 판매' : 'Sandbox 테스트'} · ${config.hasRefreshToken ? '인증 저장됨' : '미연결'}`;
    configDirty = false;
  }
  function product() {
    const aspects = JSON.parse(value('ebAspects') || '{}');
    if (!aspects || Array.isArray(aspects) || typeof aspects !== 'object') throw new Error('상품 속성은 JSON 객체로 입력해주세요.');
    if (aspectCategory === value('ebCategoryId')) $('ebAspectFields').querySelectorAll('[data-aspect]').forEach(el => { if (el.value.trim()) aspects[el.dataset.aspect] = [el.value.trim()]; });
    return { sku: value('ebSku'), title: value('ebTitle'), brand: value('ebBrand'), mpn: value('ebMpn'), price: value('ebPrice'), quantity: value('ebQuantity'), categoryId: value('ebCategoryId'), aspects, description: value('ebDescription'), imageUrls: value('ebImages'), weightKg: value('ebWeight'), lengthCm: value('ebLength'), widthCm: value('ebWidth'), heightCm: value('ebHeight') };
  }
  const urlsIn = source => [...String(source || '').matchAll(/https:\/\/[^\s<>"']+/g)].map(m => m[0].replace(/&amp;/g, '&'));
  const imageLines = () => value('ebImages').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  function setImages(list) {
    const next = [...new Set(list)].join('\n');
    // 셸은 좌측 칸이 바뀔 때마다 부른다. 이미지가 그대로인데 초안을 버리면 저장한 초안이 괜히 사라진다.
    if (next !== $('ebImages').value) { $('ebImages').value = next; savedDraft = null; }
  }
  // 사람 쪽('ESM 이미지 가져오기'): 더하기만 한다. 셸이 넣은 주소와 같은 주소면 이제 사람 것으로 본다 —
  // 다음 차에서 셸이 제 것을 뺄 때 같이 빠지지 않게.
  function addImages(source) {
    const urls = urlsIn(source);
    shellImages = shellImages.filter(u => !urls.includes(u));
    setImages([...imageLines(), ...urls]);
  }
  // 셸 쪽: 지난번에 넣은 주소를 이번 것으로 바꿔 끼운다. 자리는 그대로다 — 조견표가 첫 이미지(eBay 대표
  // 사진)였으면 새 차의 조견표가 계속 첫 이미지다. 받은 묶음이 그대로면 손대지 않는다 — 사람이 지운 주소를
  // 좌측 한 글자 칠 때마다 되살리지 않는다.
  function replaceShellImages(source) {
    const urls = [...new Set(urlsIn(source))];
    if (urls.join('\n') === shellImageSet) return;
    shellImageSet = urls.join('\n');
    const current = imageLines();
    const at = current.findIndex(u => shellImages.includes(u));
    const kept = current.filter(u => !shellImages.includes(u));
    const added = urls.filter(u => !kept.includes(u));   // 사람이 이미 넣은 주소는 사람 것으로 남긴다
    kept.splice(at < 0 ? kept.length : at, 0, ...added);
    shellImages = added;
    setImages(kept);
  }
  function options(id, entries, key) {
    let list = $(`${id}Options`);
    if (!list) { list = document.createElement('datalist'); list.id = `${id}Options`; panel.append(list); $(id).setAttribute('list', list.id); }
    list.replaceChildren(); entries.forEach(entry => { const option = document.createElement('option'); option.value = entry[key]; option.label = entry.name || entry[key]; list.append(option); });
  }
  const showWarnings = result => (result.warnings || []).forEach(w => log(w.longMessage || w.message || 'eBay 경고', 'error'));
  async function loadProduct() {
    const sku = value('ebEditSku');
    if (!sku) throw new Error('좌측 이베이 SKU 를 넣거나 목록에서 상품을 선택하세요.');
    loaded = null; loadedKey = ''; editImages = null; imageSaveUncertain = false;
    const result = await call('load-product', sku);
    // 불러오는 사이 SKU 칸이 바뀌었으면(셸이 좌측 차의 SKU 로 다시 썼거나 사람이 고쳤으면) 버린다.
    // 그대로 두면 칸은 B 인데 '판매 중단'·'게시' 는 A 에 한다.
    if (value('ebEditSku') !== sku) {
      log(`불러오는 사이 SKU 칸이 바뀌어(${sku} → ${value('ebEditSku')}) 결과를 버렸습니다. 다시 조회해주세요.`, 'error');
      return;
    }
    loaded = result; loadedKey = sku;
    $('ebEditPrice').value = loaded.offer.pricingSummary?.price?.value || ''; $('ebEditQuantity').value = loaded.offer.availableQuantity ?? '';
    $('ebEditTitle').value = loaded.inventory.product?.title || '';
    $('ebLoaded').textContent = `${loaded.inventory.product?.title || loaded.sku}\n상태: ${loaded.offer.status} · Offer: ${loaded.offer.offerId}\nListing: ${loaded.offer.listing?.listingId || '-'} · 전체 재고: ${loaded.inventory.availability?.shipToLocationAvailability?.quantity ?? '-'}`;
    log('상품 상태를 조회했습니다.', 'success');
  }
  const actions = {
    async search() {
      const results = $('ebSearchResults');
      results.textContent = '상품 목록 조회 중...';
      try {
        // 예전 형태(배열)와 {items, stats} 를 모두 받는다.
        const payload = await call('search-products', { searchText: value('ebSearchText') });
        const items = Array.isArray(payload) ? payload : (payload?.items || []);
        const stats = Array.isArray(payload) ? null : payload?.stats;
        results.replaceChildren();
        if (!items.length) results.textContent = stats?.reason || '검색 결과가 없습니다.';
        if (items.length) VUProductTable.render(results, items, {
          caption: 'eBay 상품 검색 결과', currency: 'USD',
          configureAction: (button, item) => { button.dataset.eb = 'selectProduct'; button.dataset.sku = item.id; }
        });
        const tallied = stats ? ` (재고 ${stats.scanned}${stats.total === null ? '' : `/${stats.total}`}건 · 검색어 일치 ${stats.matched} · Offer 없음 ${stats.noOffer} · Offer 중복 ${stats.multiOffer})` : '';
        log(`eBay API 정상 응답: ${items.length}건 검색됨${tallied}${items.length ? ' — 수정할 상품을 선택하세요.' : ''}`);
        if (stats?.reason) log(stats.reason, 'system');
        // 1건이면 바로 불러온다(읽기만). 표의 자동 선택은 검색 중(busy)이라 위임 클릭이 무시된다.
        if (items.length === 1) { $('ebEditSku').value = items[0].id; await loadProduct(); }
        if (stats?.activeCount) {
          $('ebActiveStatus').textContent = `eBay 활성 리스팅 총 ${stats.activeCount}건이 발견되었습니다. [기존 리스팅 전체 이관] 버튼을 눌러 가져오세요.`;
        }
      } catch (error) { results.textContent = `목록 조회 실패: ${error.message}`; throw error; }
    },
    async refreshCache() {
      $('ebMigrateProgress').style.display = 'block';
      $('ebMigrateProgressBar').style.width = '0%';
      $('ebMigrateProgressText').textContent = 'eBay 활성 리스팅 목록을 가져오는 중...';
      log('eBay 활성 리스팅 목록 동기화를 시작합니다 (약 2~3초 소요)...');
      try {
        const result = await call('refresh-cache');
        $('ebMigrateProgressBar').style.width = '100%';
        $('ebMigrateProgressText').textContent = `동기화 완료: 총 ${result.total}건 로컬 저장됨`;
        $('ebActiveStatus').textContent = `eBay 활성 리스팅 총 ${result.total}건이 로컬에 저장되었습니다. (최근 갱신: ${new Date(result.updatedAt).toLocaleTimeString('ko-KR')})`;
        log(`활성 리스팅 동기화 완료: 총 ${result.total}건 로컬 저장됨. 상품 목록을 불러옵니다.`, 'success');
        await actions.search();
      } catch (err) {
        $('ebMigrateProgressText').textContent = `동기화 실패: ${err.message}`;
        throw err;
      }
    },
    async checkActive() {
      $('ebActiveStatus').textContent = '활성 리스팅 및 로컬 캐시 상태 확인 중...';
      const [cacheSum, activeSum] = await Promise.all([
        call('cache-summary').catch(() => null),
        call('active-summary').catch(() => null)
      ]);
      const cacheCount = cacheSum?.total || 0;
      const remoteCount = activeSum?.total !== undefined ? `${activeSum.total}건` : '확인 불가';
      const dateStr = cacheSum?.updatedAt ? ` (최근 동기화: ${new Date(cacheSum.updatedAt).toLocaleTimeString('ko-KR')})` : ' (동기화 기록 없음)';
      $('ebActiveStatus').textContent = `로컬 캐시: ${cacheCount}건 / eBay 활성 리스팅: ${remoteCount}${dateStr}`;
      log(`상태 확인: 로컬 저장 ${cacheCount}건 / eBay 활성 ${remoteCount}${dateStr}`, 'success');
    },
    async migrateAll() {
      if (!window.confirm('기존 활성 리스팅을 Inventory API로 이관하시겠습니까?\n\n[안내] 이관된 리스팅은 기존 판매 번호와 링크가 그대로 유지되지만, eBay Seller Hub 웹 화면에서의 수동 수정이 제한되며 API를 통해 수정해야 합니다.')) return;
      $('ebMigrateProgress').style.display = 'block';
      $('ebMigrateProgressBar').style.width = '0%';
      $('ebMigrateProgressText').textContent = '활성 리스팅 목록을 조회하여 이관을 준비하는 중...';
      log('기존 활성 리스팅 일괄 이관을 시작합니다...');
      try {
        const result = await call('migrate-all');
        $('ebMigrateProgressBar').style.width = '100%';
        $('ebMigrateProgressText').textContent = `이관 완료: 성공 ${result.successful.length}건, 실패 ${result.failed.length}건`;
        log(`이관 완료: 성공 ${result.successful.length}건, 실패 ${result.failed.length}건`, result.successful.length ? 'success' : 'error');
        if (result.failed.length) {
          result.failed.slice(0, 5).forEach(f => log(`이관 실패 (ID: ${f.listingId}): ${f.errors?.map(e => e.message).join('; ') || '오류'}`, 'error'));
        }
        await actions.search();
      } catch (err) {
        $('ebMigrateProgressText').textContent = `이관 실패: ${err.message}`;
        throw err;
      }
    },
    async selectProduct(button) { $('ebEditSku').value = button.dataset.sku; await loadProduct(); },
    async saveConfig() {
      const config = Object.fromEntries(Object.entries(configMap).map(([key, id]) => [key, value(id)])); config.clientSecret = value('ebClientSecret'); config.refreshToken = value('ebRefreshToken');
      fillConfig(await call('save-config', config)); invalidate(); log('설정을 저장했습니다.', 'success');
    },
    async connect() { await actions.saveConfig(); await call('connect'); log('브라우저에서 동의한 뒤 완료 페이지 URL을 붙여넣어주세요.'); },
    async completeAuth() { fillConfig(await call('complete-auth', value('ebCallback'))); $('ebCallback').value = ''; invalidate(); log('판매자 연결이 완료되었습니다.', 'success'); },
    async disconnect() { fillConfig(await call('save-config', { disconnect: true })); invalidate(); log('저장된 판매자 토큰을 삭제했습니다. eBay 측 동의 철회는 계정 설정에서 진행하세요.'); },
    async createLocation() {
      const created = await call('create-location', {
        merchantLocationKey: value('ebLocKey'), name: value('ebLocName'), addressLine1: value('ebLocLine1'),
        city: value('ebLocCity'), stateOrProvince: value('ebLocState'), postalCode: value('ebLocPostal'),
        country: value('ebLocCountry').trim().toUpperCase()
      });
      await actions.settings();
      // 목록을 새로 읽은 뒤에 채워야 datalist 에 실제로 있는 값이 선택된다.
      $('ebLocation').value = created.merchantLocationKey; configDirty = true;
      log(`출고지 ${created.merchantLocationKey}를 만들었습니다. 정책 4개를 확인하고 정책 설정 저장을 눌러주세요.`, 'success');
    },
    async settings() {
      const data = await call('settings');
      options('ebLocation', data.locations.filter(l => l.merchantLocationStatus === 'ENABLED'), 'merchantLocationKey');
      options('ebFulfillment', data.fulfillmentPolicies, 'fulfillmentPolicyId'); options('ebPayment', data.paymentPolicies, 'paymentPolicyId'); options('ebReturn', data.returnPolicies, 'returnPolicyId');
      $('ebStatus').textContent = `${value('ebEnvironment') === 'production' ? '실제 판매' : 'Sandbox 테스트'} · 연결 확인`;
      log(`연결 성공 · 출고지 ${data.locations.length}, 배송 ${data.fulfillmentPolicies.length}, 결제 ${data.paymentPolicies.length}, 반품 ${data.returnPolicies.length}건. 입력란에서 항목을 선택하고 저장하세요.`, 'success');
    },
    async categories() {
      const data = await call('categories', value('ebCategoryQuery')); $('ebCategories').replaceChildren();
      (data.categorySuggestions || []).forEach(item => {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'btn btn-outline btn-sm'; b.textContent = `${item.category.categoryName} (${item.category.categoryId})`;
        b.onclick = () => { if (busy) return; $('ebCategoryId').value = item.category.categoryId; $('ebAspectFields').replaceChildren(); aspectCategory = ''; savedDraft = null; refreshButtons(); }; $('ebCategories').append(b);
      });
      log(`${(data.categorySuggestions || []).length}개 카테고리. Sandbox 검색이 지원되지 않으면 카테고리 ID를 직접 입력하세요.`);
    },
    async aspects() {
      const category = value('ebCategoryId'), metadata = await call('aspects', category); $('ebAspectFields').replaceChildren(); aspectCategory = category; savedDraft = null;
      (metadata.aspects || []).filter(a => a.aspectConstraint?.aspectRequired).forEach((aspect, i) => {
        const group = document.createElement('div'); group.className = 'form-group';
        const label = document.createElement('label'); label.className = 'form-label'; label.textContent = `${aspect.localizedAspectName} (필수)`;
        const el = document.createElement('input'); el.className = 'form-input'; el.dataset.aspect = aspect.localizedAspectName; el.id = `ebRequired${i}`; label.htmlFor = el.id;
        if (aspect.localizedAspectName === 'Brand') el.value = value('ebBrand'); if (aspect.localizedAspectName === 'MPN') el.value = value('ebMpn');
        const list = document.createElement('datalist'); list.id = `ebAspectOptions${i}`; el.setAttribute('list', list.id);
        (aspect.aspectValues || []).forEach(v => { const option = document.createElement('option'); option.value = v.localizedValue; list.append(option); });
        group.append(label, el, list); $('ebAspectFields').append(group);
      }); log('필수 속성을 불러왔습니다. 추가·복수 값은 JSON 입력란에서 설정하세요.');
    },
    async importEsm() { addImages(typeof lastEsmUrl !== 'undefined' && lastEsmUrl ? lastEsmUrl : document.getElementById('cpEsmHtml')?.value); log('ESM 이미지 주소를 가져왔습니다. 첫 이미지가 실제 상품 사진인지 확인하세요.'); },
    async preview() { $('ebPreview').textContent = JSON.stringify(await call('preview', product()), null, 2); log('입력·카테고리 검증 완료. 최종 판매 가능 여부는 게시 응답에서 확인합니다.', 'success'); },
    async draft() { savedDraft = null; savedDraft = await call('save-draft', product()); showWarnings(savedDraft); log(`초안 저장 완료 · SKU ${savedDraft.sku} · Offer ${savedDraft.offerId}`, 'success'); },
    async publish() { if (!savedDraft) throw new Error('초안을 먼저 저장해주세요.'); const result = await call('publish', savedDraft.sku); showWarnings(result); log(`게시 완료 · Listing ${result.listingId}`, 'success'); savedDraft = null; },
    // SKU 가 비면(현황판에서 상품을 고르지 않음) 상품 목록 조회와 같다 — 검색어도 비면 전체 목록.
    load: () => (value('ebEditSku') ? loadProduct() : actions.search()),
    async update() {
      const product = requireLoaded(), { sku } = product;
      if (imageSaveUncertain) throw new Error('이전 이미지 요청 결과를 확인하려면 상품을 다시 불러오세요.');
      if (editImages?.length === 0) throw new Error('상품 이미지는 최소 1장 필요합니다. 상품을 다시 불러오세요.');
      const images = editImages ? [...editImages] : null;
      // 제목은 이미지와 같은 inventory_item PUT 으로 간다. 안 고쳤으면 보내지 않는다(앞뒤 공백 차이는 고친 게 아니다).
      const loadedTitle = product.inventory.product?.title || '';
      const title = value('ebEditTitle'), titleChanged = title !== loadedTitle.trim();
      if (titleChanged && (!title || title.length > 80)) throw new Error(`영문 상품명은 1~80자로 입력해주세요(지금 ${title.length}자). 아무것도 보내지 않았습니다.`);
      const inventoryWhat = [images && '이미지', titleChanged && '제목'].filter(Boolean).join('·');
      // 이미지·제목만 바꿨으면 가격·수량 수정을 보내지 않는다. 수량 칸(불러온 시점 값)으로 덮으면 그 뒤 팔린 수량이 되살아난다.
      const unchanged = (id, was) => value(id) !== '' && Number(value(id)) === Number(was);
      const loadedPrice = product.offer.pricingSummary?.price?.value;
      const quantityChanged = !unchanged('ebEditQuantity', product.offer.availableQuantity);
      const sendOffer = !inventoryWhat || !unchanged('ebEditPrice', loadedPrice) || quantityChanged;
      // 수량을 안 고쳤으면 가격만 보낸다(메인이 불러온 가격과 다시 비교). 예전에는 가격만 바꿔도 불러올 때의 수량을
      // 같이 보내서, 그 사이 팔린 수량이 되살아났다 — 셸의 일괄 수정도 이 길을 탄다.
      if (sendOffer) showWarnings(await call('update', quantityChanged
        ? { sku, price: value('ebEditPrice'), quantity: value('ebEditQuantity') }
        : { sku, price: value('ebEditPrice'), priceOnly: true, expectedPrice: loadedPrice }));
      if (inventoryWhat) {
        try {
          await call('update-images', { sku,
            ...(images ? { images, expectedImages: product.inventory.product?.imageUrls || [] } : {}),
            ...(titleChanged ? { title, expectedTitle: loadedTitle } : {}) });
          editImages = null;
        } catch (e) {
          imageSaveUncertain = true;
          throw new Error((sendOffer ? (quantityChanged ? '가격·수량은' : '가격은') + ' 저장됐지만 ' : '') + `${inventoryWhat} 저장은 확인이 필요합니다. 상품을 다시 불러오세요: ` + e.message);
        }
      }
      const what = quantityChanged ? '가격·미국 판매 수량' : '가격';
      const eul = s => s + (s.endsWith('이미지') ? '를' : '을');
      log(!inventoryWhat ? `${eul(what)} 수정했습니다.` : sendOffer ? `${eul(`${what}·${inventoryWhat}`)} 수정했습니다.`
        : `${eul(inventoryWhat)} 수정했습니다. 가격·수량은 그대로라 보내지 않았습니다.`, 'success');
      await loadProduct();
      // 이미지처럼 다시 읽어 확인한다 — eBay 가 받은 뒤에도 다른 제목이면 실패로 알린다.
      if (titleChanged && loaded && (loaded.inventory.product?.title || '').trim() !== title)
        throw new Error(`제목을 보냈지만 다시 읽은 제목이 다릅니다: ${loaded.inventory.product?.title || '빈칸'}`);
    },
    async publishLoaded() { const { sku } = requireLoaded(); const result = await call('publish', sku); showWarnings(result); log(`게시 완료 · Listing ${result.listingId}`, 'success'); await loadProduct(); },
    async withdraw() { const { sku } = requireLoaded(); if (!window.confirm(`${sku} 상품의 미국 판매를 중단하시겠습니까?`)) return; await call('withdraw', sku); log('판매 중단 요청이 완료되었습니다.', 'success'); await loadProduct(); }
  };
  // 버튼 하나의 일을 한다. 버튼과 셸의 일괄 등록(ebayDraft)이 같은 길을 탄다 — 바쁨·설정 미저장 규칙도 같다.
  // 결과는 { ok, error } 로 돌려주고 던지지 않는다(셸과의 약속).
  async function runAction(name, b) {
    if (busy) return { ok: false, error: 'eBay 탭이 다른 요청을 처리 중입니다. 끝난 뒤 다시 해주세요.' };
    if (configDirty && !['saveConfig', 'connect', 'disconnect', 'importEsm'].includes(name)) {
      const error = '변경한 연결 설정을 먼저 저장해주세요.';
      log(error, 'error'); return { ok: false, error };
    }
    busy = true; refreshButtons();
    try { await actions[name](b); return { ok: true }; } catch (error) { log(error.message, 'error'); return { ok: false, error: error.message }; } finally {
      busy = false; refreshButtons();
      // 요청 중에는 셸이 칸을 바꾸지 않고 기다렸다(ebayBusy). 그 사이 좌측이 바뀌었을 수 있다.
      try { if (window.parent !== window && typeof window.parent.scheduleFrameSync === 'function') window.parent.scheduleFrameSync(); } catch (e) { /* 셸이 아니다 */ }
    }
  }
  document.addEventListener('click', event => {
    const b = event.target.closest('[data-eb]'); if (!b || busy) return;
    runAction(b.dataset.eb, b);
  });
  // 셸의 일괄 등록이 부른다: '초안 저장' 버튼과 같은 일을 하고, 요청이 끝난 뒤 결과를 돌려준다.
  // 예전에는 셸이 버튼을 click() 만 하고 바로 '처리 요청됨' 으로 성공을 셌다 — 거부돼도 성공이었다.
  window.ebayDraft = () => {
    if (value('ebMode') !== 'new') {
      const error = 'eBay 탭이 기존 상품 관리 모드라 초안을 저장하지 않았습니다 — 신규 등록 모드에서 다시 해주세요.';
      log(error, 'error'); return Promise.resolve({ ok: false, error });
    }
    return runAction('draft');
  };
  // 셸의 일괄 수정이 부른다: '가격·판매 수량 수정' 버튼과 같은 일을 하고 결과를 돌려준다. 버튼처럼 게시된
  // 상품만 고친다. 불러온 상품이 없거나 조회 칸과 다르면 update 의 requireLoaded 가 거부한다.
  window.ebayUpdate = () => {
    let error = '';
    const live = loadedForField();
    if (value('ebMode') !== 'edit') error = 'eBay 탭이 신규 등록 모드라 수정하지 않았습니다 — 기존 상품 관리 모드에서 다시 해주세요.';
    else if (live && live.offer.status !== 'PUBLISHED') error = `게시되지 않은 상품(상태: ${live.offer.status})이라 가격·판매 수량을 수정하지 않았습니다 — 먼저 게시해주세요.`;
    if (error) { log(error, 'error'); return Promise.resolve({ ok: false, error }); }
    return runAction('update');
  };
  // 셸의 일괄 수정이 묻는다: 불러온 상품이 있나(index.html editItemOf). 6몰 표(mall-grid.js)는 상태 · 불러온 수량 · 이미지 초안도 본다.
  window.ebayEditItem = () => (loaded ? { id: loaded.sku, name: loaded.inventory?.product?.title || loaded.sku,
    status: loaded.offer?.status, quantity: loaded.offer?.availableQuantity, imageDraft: !!editImages } : null);
  $('ebNewForm').addEventListener('input', () => { savedDraft = null; refreshButtons(); });
  $('ebEditSku').addEventListener('input', () => { loaded = null; refreshButtons(); });
  [...Object.values(configMap), 'ebClientSecret', 'ebRefreshToken'].forEach(id => $(id).addEventListener('input', () => { configDirty = true; invalidate(); $('ebStatus').textContent = '설정 변경됨 · 저장 후 진행하세요'; }));
  ['ebEnvironment', 'ebClientId'].forEach(id => $(id).addEventListener('change', () => {
    ['ebClientSecret', 'ebRefreshToken', 'ebRuName', 'ebCallback', 'ebLocation', 'ebFulfillment', 'ebPayment', 'ebReturn'].forEach(field => { $(field).value = ''; });
    panel.querySelectorAll('datalist').forEach(list => list.replaceChildren());
  }));
  $('ebCategoryId').addEventListener('input', () => { $('ebAspectFields').replaceChildren(); aspectCategory = ''; });
  $('ebMode').addEventListener('change', () => { $('ebNewForm').hidden = value('ebMode') !== 'new'; $('ebEditForm').hidden = value('ebMode') !== 'edit'; });
  $('ebPrice').step = $('ebEditPrice').step = '0.01'; $('ebPrice').min = $('ebEditPrice').min = '0.01'; $('ebQuantity').step = $('ebEditQuantity').step = '1'; $('ebQuantity').min = '1'; $('ebEditQuantity').min = '0';
  $('ebTitle').maxLength = $('ebEditTitle').maxLength = 80; $('ebSku').maxLength = $('ebEditSku').maxLength = 50;
  ['ebWeight', 'ebLength', 'ebWidth', 'ebHeight'].forEach(id => { $(id).step = 'any'; $(id).min = '0.001'; });
  ['draft', 'publish', 'publishLoaded', 'update'].forEach(action => { const b = panel.querySelector(`[data-eb="${action}"]`); b.classList.remove('btn-outline'); b.classList.add('btn-gradient', 'vu-key', 'vu-key-accent'); });
  panel.querySelector('[data-eb="load"]').classList.add('vu-key');
  // eBay 제목은 80자다(아마존은 200자). 넘쳐도 잘라내지 않고 알려만 준다 — 어디를 줄일지는
  // 사람이 정해야 하고, 말없이 자르면 연식 같은 검색 키워드가 먼저 날아간다.
  //
  // 문형은 실제 판매 중인 리스팅 그대로다:
  //   Optic-glass Wide Angle View Car Mirror for FORD Bronco 6th gen 22.03- BSA
  //   Optic-glass Wide Angle View Car Mirror for Toyota GR86 2nd gen 24-
  // 아마존과 달리 차량코드와 좌우 표기가 없고, 끝에 BSA 여부만 붙는다.
  const EB_TITLE_MAX = 80;
  const ebTitleFor = d => ['Optic-glass Wide Angle View Car Mirror for',
                           d.brand, d.model, d.generation, d.year, d.bsa ? 'BSA' : '']
                          .map(x => String(x || '').trim()).filter(Boolean).join(' ');

  const showEbTitleLength = () => {
    const el = $('ebTitle'); const label = document.querySelector('label[for="ebTitle"]');
    if (!el || !label) return;
    const n = el.value.trim().length;
    const over = n > EB_TITLE_MAX;
    label.textContent = `영문 상품명 — ${n}자 / ${EB_TITLE_MAX}자`
      + (over ? ' · 넘어서 등록이 거부됩니다' : '');
    label.style.color = over ? 'var(--danger)' : '';
  };

  const ebDescriptionFor = d => `Compatible vehicle: ${d.brand} ${d.model}\nYear / generation: ${d.year} ${d.generation}\nProduct code: ${d.code}\nBSA: ${d.bsa ? 'Yes' : 'No'}`;

  // 셸(베리업)이 좌측 상품 정보로 이 탭 칸을 직접 채운다 — 다른 몰 탭과 같은 방식이라, 탭에서
  // 사람이 고친 칸을 셸이 알아보고 덮지 않을 수 있다. 문형(제목·설명)은 여전히 이 파일이 정한다.
  window.ebayTitleFor = ebTitleFor;
  window.ebayTitleMax = EB_TITLE_MAX;
  window.ebayDescriptionFor = ebDescriptionFor;
  window.ebayBusy = () => busy;
  // 셸이 칸을 채운 뒤 부른다: 지금 차의 조견표 이미지로 바꿔 끼우고 제목 길이·버튼 상태를 다시 잰다.
  // chartHtml 은 셸이 지금 관리하는 조견표 전부다 — 비어 오면 셸이 넣었던 것도 뺀다.
  window.ebayAfterFill = ({ chartHtml, quiet } = {}) => {
    if (busy) return;
    replaceShellImages(chartHtml); showEbTitleLength(); refreshButtons();
    if (!quiet) log('공통 상품 정보를 가져왔습니다. 제목·SKU·USD 가격을 확인해주세요.');
  };

  // 셸 없이 이 탭만 쓸 때의 가져오기(예전 경로).
  window.ebayImportCommon = data => {
    if (busy) return; $('ebDescription').value = ebDescriptionFor(data);
    // 예전에는 설명만 채우고 제목은 빈 칸으로 뒀다 — 같은 값을 손으로 또 옮겨 적어야 했다.
    if (data.model) $('ebTitle').value = ebTitleFor(data);
    // SKU·판매가는 셸이 이베이 상품등록 표에서 찾아 준 값이다. 비어 오면 기존 값을 지우지 않는다 —
    // 표에 없는 차는 사람이 이 탭에서 직접 넣기 때문이다.
    if (data.sku) $('ebSku').value = data.sku;
    if (data.priceUsd) $('ebPrice').value = data.priceUsd;
    showEbTitleLength();
    // 공통 입력의 조견표도 셸 것처럼 다룬다 — 차를 바꿔 다시 가져오면 앞 차의 조견표를 바꿔 끼운다.
    replaceShellImages(data.chartHtml); refreshButtons(); log('공통 상품 정보를 가져왔습니다. 제목을 확인하고 SKU·USD 가격을 입력해주세요.');
  };
  $('ebTitle')?.addEventListener('input', showEbTitleLength);
  fillConfig({ environment: 'sandbox' }); refreshButtons();
  call('load-config').then(cfg => {
    fillConfig(cfg);
    call('cache-summary').then(sum => {
      if (sum?.total) {
        $('ebActiveStatus').textContent = `eBay 활성 리스팅 총 ${sum.total}건이 로컬에 저장되어 있습니다. (최근 갱신: ${new Date(sum.updatedAt).toLocaleTimeString('ko-KR')})`;
      }
    }).catch(() => {});
  }).catch(e => log(e.message, 'error'));
})();
