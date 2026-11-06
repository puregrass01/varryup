(async () => {
  const { imagePolicy, parseImageUrls, sameImages, previewImageUrls } = await import('../utils/bulk_images.js');
  const { productIdentity, identityText } = await import('../utils/product_identity.js');
  const { COUNTRIES, referencePrices, referenceRole, countryPrice, productPageUrl, editionFor } = await import('../utils/country_sync.js');
  const { POLICY_SCOPES, policyPrice, couponGuide } = await import('../utils/price_policy.js');
  const ipc = require('electron').ipcRenderer, root = document.getElementById('bulk-edit-workspace');
  const scopes = [
    ['naver', '네이버', 'KRW', 'logos/naver.png'], ['coupang', '쿠팡', 'KRW', 'logos/coupang.png'], ['imweb-b2b', '아임웹 B2B', 'KRW', 'logos/b2b.png'],
    ['imweb-en', '아임웹 영문', 'USD', 'logos/imweb.png'], ['imweb-ko', '아임웹 본사', 'KRW', 'logos/imweb.png'], ['imweb-jp', '아임웹 일본', 'JPY', 'logos/imweb.png'],
    ['amazon-us', '아마존 미국', 'USD', 'logos/amazon.png'], ['amazon-jp', '아마존 일본', 'JPY', 'logos/amazon.png'], ['ebay', 'eBay', 'USD', 'logos/ebay.png']
  ];
  const states = new Map();
  // 차량 카탈로그(data/vehicle_catalog.json): 나라 화면이 문구에 판(BSA · 일반)이 없는 본사 상품의 판을 상품번호로 정한다.
  let catalog = null;
  const loadCatalog = async () => catalog ||= await ipc.invoke('vehicle-load-catalog').then(r => r?.success ? r.catalog : null).catch(() => null);
  // country: 나라 화면(kr · us · jp)일 때. 그동안 scope 는 그 나라 기준 몰(본사몰 구역)이다 — 필터 · 검색 · 단위가 기준 몰 것.
  let scope = 'naver', country = null, busy = false, cancel = false, page = 0, query = '', lastTab = 'naverTab';
  const size = 25, filters = new Map();
  const $ = id => document.getElementById(id);
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const key = r => r.id + ':' + (r.optionId || '');
  // tried: 이 목록에서 현재가·이미지를 한 번 읽으려 한 상품 ID(자동 불러오기가 같은 상품을 되풀이해 두드리지 않게).
  // absent: 나라 화면이 자리를 만들었다가 그 몰에서 못 읽은 상품 ID(다시 자리를 만들지 않게).
  const state = (sc = scope) => { if (!states.has(sc)) states.set(sc, { rows: [], note: '', filters: {}, query: '', imageList: [], tried: new Set(), absent: new Set() }); return states.get(sc); };
  const rows = (sc = scope) => state(sc).rows;
  const unitOf = sc => scopes.find(s => s[0] === sc)[2];
  // 나라 화면에서 보기만 하는 몰(B2B)의 줄은 고르거나 고칠 수 없다.
  const locked = r => r.readonly || (!!country && COUNTRIES[country].view.includes(r.scope));
  const priceDirty = r => !r.priceReadonly && r.ready && r.newPrice !== '' && Number(r.newPrice) !== Number(r.price === '' ? NaN : r.price);
  const imageDirty = r => r.imagesReady && Array.isArray(r.newImages) && !sameImages(r.newImages, r.images);
  // 정가(newList)는 '가격 정책'만 채운다. 판매가가 그대로여도 정가는 보낸다(지금 정가를 읽지 않으므로 같은지 모른다 — 다시 써도 같다).
  const listDirty = r => !r.priceReadonly && r.ready && !!r.newList;
  const dirty = r => priceDirty(r) || imageDirty(r) || listDirty(r);
  function priceKey(r) {
    const value = r.price;
    return value == null || String(value).trim() === '' || !Number.isFinite(Number(value)) ? 'unknown' : String(Number(value));
  }
  const filterValue = (r, key) => key === 'price' ? priceKey(r) : r.tax[key];
  const match = r => [...filters].every(([k, select]) => !select.value || filterValue(r, k) === select.value) &&
    query.toLowerCase().split(/\s+/).filter(Boolean).every(w => [r.name, r.id, r.variant, identOf(r).search, ...Object.values(r.tax)].join(' ').toLowerCase().includes(w));
  // 나라 화면은 본사몰 상품 묶음 단위로 거르고 넘긴다(묶음의 본사 줄로 거른다). 줄은 묶음 순서대로 편다.
  const shownGroups = () => groups().filter(g => g.own.some(match));
  // 짝 줄 하나를 여러 본사 상품이 함께 가리키면(네이버 615개 중 393개) 묶음마다 보이지만, 선택 · 저장 · 개수는 한 번만 센다.
  const view = () => country ? [...new Set(shownGroups().flatMap(g => [...g.own, ...g.members]))] : rows().filter(match);
  const selected = () => view().filter(r => r.selected && !locked(r));
  const pageGroups = () => shownGroups().slice(page * size, (page + 1) * size);
  const pageRows = () => country ? pageGroups().flatMap(g => [...g.own, ...g.members]) : view().slice(page * size, (page + 1) * size);
  const pages = () => Math.max(1, Math.ceil((country ? shownGroups() : view()).length / size));
  const tell = text => { $('be-status').textContent = text; };
  // 선택·저장은 필터 전체 기준이라, 지금 페이지 밖에 선택된 행이 있으면 개수에 따로 드러낸다.
  function showCount() {
    const picked = selected(), visible = new Set(pageRows());
    const off = picked.filter(r => !visible.has(r)).length;
    $('be-count').textContent = (country ? shownGroups().length + '개 상품(' + view().length + '행) / 전체 ' + groups().length + '개' : view().length + '행 / 전체 ' + rows().length + '행') + ' · 선택 ' + picked.length + '행' +
      (off ? ' (다른 페이지 ' + off + '행 포함)' : '') + ' · 저장할 변경 ' + picked.filter(dirty).length + '행';
  }
  // 머리글 체크박스는 모든 페이지의 필터 결과를 대상으로 한다.
  function syncHeader() {
    const active = view().filter(r => !locked(r)), on = active.filter(r => r.selected).length;
    const box = $('be-th-select-all');
    box.checked = active.length > 0 && on === active.length;
    box.indeterminate = on > 0 && on < active.length;
  }
  // 실패 응답의 kind(오류 종류)·stage(반영 여부)·blocking(다음 행도 실패할 오류)을 Error 에 붙여 넘긴다.
  async function call(channel, data) {
    let result;
    try { result = await ipc.invoke(channel, data); }
    catch (e) {
      if (channel === 'bulk-save-batch' && /No handler registered/i.test(e.message || ''))
        throw Object.assign(new Error('새 일괄 저장 기능을 사용하려면 앱을 완전히 종료한 뒤 다시 실행하세요. 변경 요청은 전송하지 않았습니다.'), { stage: 'pre-send' });
      throw e;
    }
    if (!result?.success) {
      const { error, kind, stage, status, blocking, retryable, proxyError } = result || {};
      throw Object.assign(new Error(error || '요청을 처리하지 못했습니다.'), { kind, stage, status, blocking, retryable, proxyError });
    }
    return result.data;
  }
  let batchJobId = '', batchProgress = null;
  ipc.on('bulk-save-progress', (_, payload) => { if (payload?.jobId === batchJobId) batchProgress?.(payload); });
  // ident 는 몰과 상관없는 표준 표기(No.101 BSA · SKU). 메인이 카탈로그로 채운 identity 가 없으면 행만 보고 읽는다.
  function augment(r) { return { ...r, selected: false, newPrice: r.ready && !r.priceReadonly ? String(r.price) : '', result: r.result || '', tax: window.VUProductTable.normalize(r), ident: identityText(r.identity || productIdentity(r)) }; }
  const identOf = r => r.ident || (r.ident = identityText(r.identity || productIdentity(r)));
  // 판매 페이지 링크에 쓰는 값. 목록에만 오는 값(네이버 채널상품번호 등)은 현재가를 불러와 행을 바꿔 끼울 때 이어 붙인다(loadPrices).
  const LINK_KEYS = ['channelProductNo', 'displayProductId', 'asin', 'listingId'];
  const linkOf = r => ({ scope: r.scope || scope, id: r.id, optionId: r.optionId, name: r.name, ...Object.fromEntries(LINK_KEYS.map(k => [k, r[k]])) });
  const platformId = r => {
    if (/^(?:amazon-|ebay$)/.test(r.scope || scope)) return '';   // 아마존·eBay 는 ID 가 곧 SKU
    return titleOf(r.scope || scope) + ' ID ' + r.id + (r.optionId ? ' · 옵션 ' + r.optionId : '');
  };
  root.innerHTML = '<div class="be-head"><h2>상품 일괄 수정</h2><span>플랫폼별 판매가 · 이미지 관리</span></div>' +
    // 맨 앞은 나라 탭(한국 · 미국 · 일본) — 그 나라 몰들을 본사몰 상품 묶음으로 한 표에 모아 본다. 그 뒤가 몰 탭.
    '<div class="be-platform-row"><div id="be-countries" class="be-countries" role="tablist" aria-label="나라별 가격 통일"></div>' +
    '<div id="be-platforms" class="be-platforms" role="tablist" aria-label="쇼핑몰 플랫폼"></div></div>' +
    // 서버 검색칸은 아마존·eBay 에서만 보인다. 나머지 몰은 전체를 받은 뒤 같은 단어로 걸러 표 안 검색과 같다(draw).
    '<div class="be-tools"><input id="be-api-query" placeholder="상품명·SKU 검색 · 빈칸이면 전체 목록" aria-label="목록 검색어">' +
    '<button id="be-list" type="button">상품 목록 조회</button><button id="be-refresh" type="button" title="몰 API 로 목록과 모든 쪽 상품의 현재가를 다시 읽어 이 PC 의 저장본(쿠팡 판매가 · 아마존 · eBay 목록)을 고칩니다. 상품마다 호출이라 수 분 걸릴 수 있습니다">데이터 갱신</button><button id="be-sync" type="button" hidden>전체 목록 동기화</button></div>' +
    '<p class="be-help">표에 보이는 쪽의 상품은 현재가·이미지를 자동으로 불러옵니다. 상품을 선택하고 가격 적용, 또는 사진 열 목록에 이미지를 끌어 놓고 [↓]로 값을 넣은 뒤 선택 변경 저장을 누르세요. 다른 쪽의 안 읽은 상품은 적용할 때 먼저 불러옵니다. 쿠팡 이미지는 상품 전체 옵션에 적용됩니다.</p>' +
    '<div class="be-actions">' +
    // 선택·해제는 표 머리의 전체선택 체크 하나로 한다. 판매가·이미지 입력은 표 머리 아래 줄, 그 열 바로 밑에 있다.
    // 현재가·이미지는 보이는 쪽을 자동으로 읽는다(autoLoad) — 예전 '선택 상품 현재가·이미지 불러오기' 버튼은 없앴다.
    '<div class="be-group be-group-end"><button id="be-country-apply" type="button" hidden>본사 값으로 맞추기</button>' +
    '<button id="be-country-images" type="button" hidden>본사 상세 이미지 → 네이버 · 쿠팡</button><button id="be-stop" type="button" hidden>중단</button><button id="be-export" type="button">결과 CSV</button><button id="be-save" type="button" class="be-primary">선택 변경 저장</button></div></div>' +
    '<div class="be-state"><div id="be-status" role="status" aria-live="polite"></div><p class="be-help" id="be-count"></p></div>' +
    // 필터는 표 왼쪽 레일에 세로로 쌓는다(표 안 검색이 맨 위). 표는 나머지 폭을 쓴다.
    '<div class="be-body"><div class="be-filters" id="be-filters" role="group" aria-label="표 필터"></div>' +
    '<div class="be-scroll"><table class="be-table"><thead><tr><th class="be-check-column"><label class="be-th-check-label"><input type="checkbox" id="be-th-select-all" aria-label="필터 결과 모든 페이지 전체선택" title="필터에 맞는 모든 페이지의 행을 선택합니다 · 다시 누르면 선택을 모두 해제합니다"> 전체선택</label></th><th class="be-photo-column"><span id="be-photo-label">사진</span><small id="be-image-hint"></small></th><th>상품명 / 옵션</th><th>상품번호 / SKU</th><th>브랜드 / 차종</th><th id="be-price-label">기존 판매가</th><th>판매가 덮어쓰기</th><th>처리 결과</th></tr>' +
    // 열마다 칸 하나씩(합치지 않는다) — 입력이 그 열 머리 바로 밑에 온다. 이미지는 사진 열, 판매가는 판매가 덮어쓰기 열.
    '<tr class="be-th-tools"><td></td><td class="be-photo-column"><div class="be-tool be-image-tool" role="group" aria-label="이미지 입력"><div id="be-image-list"></div>' +
    '<button id="be-image-apply" type="button" title="선택 상품의 이미지를 이 목록으로 바꿉니다" aria-label="선택 상품 이미지를 이 목록으로 교체">↓</button></div></td><td></td><td></td><td></td><td></td>' +
    '<td><div class="be-tool" role="group" aria-label="판매가 덮어쓰기"><input id="be-value" type="number" min="0" placeholder="판매가" aria-label="선택 행에 넣을 판매가">' +
    '<span id="be-currency" class="be-unit"></span><select id="be-price-source" aria-label="판매가 값 출처" title="환율가: 국내 기준가 등급 ÷ 오늘 환율(우대 없음)에서 앞 두 자리만 남긴 값을 행마다 계산합니다(아마존·eBay 전용). 가격 정책: 11-06 정책표의 1set 판매가 100,000 · 정가 140,000(쿠팡·스마트스토어 전용, 저장 때 정가도 보냅니다)">' +
    '<option value="direct">직접 입력</option><option value="fx">환율가</option><option value="policy">가격 정책</option></select><button id="be-apply" type="button">가격 적용</button></div></td><td></td></tr>' +
    '</thead><tbody id="be-body"></tbody></table></div></div>' +
    '<div class="be-pager"><button id="be-prev" type="button">이전</button><span id="be-page"></span><button id="be-next" type="button">다음</button></div>';
  // 일일 환율 자동 변경 패널(fx-auto-price.js)은 모드 바 '환율' 탭의 칸에 붙는다. 일괄 화면 바로 뒤 형제 칸이다.
  const fxRoot = el('section'); fxRoot.id = 'fx-workspace'; fxRoot.hidden = true; fxRoot.setAttribute('aria-label', '환율');
  root.after(fxRoot); window.VUFxAutoPrice?.mount(fxRoot, ipc);
  const viewer = el('dialog', 'be-image-viewer'); viewer.id = 'be-image-viewer';
  viewer.setAttribute('aria-labelledby', 'be-image-viewer-title');
  const viewerBar = el('div', 'be-image-viewer-bar'), viewerTitle = el('strong'); viewerTitle.id = 'be-image-viewer-title';
  const viewerZoom = el('button', '', '원본 크기'), viewerClose = el('button', '', '닫기');
  viewerZoom.type = viewerClose.type = 'button'; viewerClose.setAttribute('aria-label', '이미지 확대 닫기');
  const viewerScroll = el('div', 'be-image-viewer-scroll'), viewerImage = el('img'), viewerError = el('p', '', '이미지를 불러오지 못했습니다.');
  viewerError.hidden = true;
  viewerImage.onerror = () => { viewerError.hidden = false; };
  viewerImage.onload = () => { viewerError.hidden = true; };
  viewerZoom.onclick = () => { const original = viewerScroll.classList.toggle('be-original-size'); viewerZoom.textContent = original ? '화면 너비에 맞추기' : '원본 크기'; };
  viewerClose.onclick = () => viewer.close();
  viewer.addEventListener('click', event => { if (event.target === viewer) { const box = viewer.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) viewer.close(); } });
  viewer.addEventListener('close', () => { viewerImage.removeAttribute('src'); });
  viewerBar.append(viewerTitle, viewerZoom, viewerClose); viewerScroll.append(viewerError, viewerImage); viewer.append(viewerBar, viewerScroll); root.append(viewer);
  function viewImage(url, title) {
    if (!/^https?:\/\//i.test(url)) return;
    viewerTitle.textContent = title; viewerImage.alt = title; viewerError.hidden = true;
    viewerScroll.classList.remove('be-original-size'); viewerZoom.textContent = '원본 크기';
    viewerImage.src = url; viewer.showModal(); viewerScroll.scrollTop = viewerScroll.scrollLeft = 0; viewerClose.focus();
  }
  const defaultHelp = root.querySelector('.be-help').textContent;
  const titleOf = id => scopes.find(s => s[0] === id)[1];
  // 몰 탭 바꾸기. 나라별 가격 통일도 대상 몰 탭을 차례로 띄우며 쓴다(그 몰의 표 · 필터 · 검색어로).
  function switchScope(id) {
    state().query = query;
    state().filters = Object.fromEntries([...filters].map(([k, s]) => [k, s.value]));
    scope = id; page = 0; query = state().query; $('be-search').value = query;
    renderImageList();
    rebuildFilters(); draw(); tell(state().note);
  }
  const logoOf = id => { const [, , , logo] = scopes.find(s => s[0] === id), img = el('img', 'be-platform-logo' + (id === 'ebay' ? ' be-platform-logo-wide' : ''));
    img.src = logo; img.alt = ''; img.width = img.height = 18; return img; };
  for (const [id, title] of scopes) {
    const b = el('button', 'be-platform-btn'); b.type = 'button'; b.dataset.scope = id; b.setAttribute('role', 'tab');
    b.append(logoOf(id), el('span', '', title));
    b.addEventListener('click', () => { if (!busy) { country = null; switchScope(id); } });
    $('be-platforms').append(b);
  }
  for (const [code, c] of Object.entries(COUNTRIES)) {
    const b = el('button', '', c.label); b.type = 'button'; b.dataset.country = code; b.setAttribute('role', 'tab');
    b.title = `${[c.ref, ...c.targets, ...c.view].map(titleOf).join(' · ')} 상품을 본사몰 상품 묶음으로 한 표에 모아 봅니다` + (c.view.length ? ` (${c.view.map(titleOf).join(' · ')}는 보기만)` : '');
    b.addEventListener('click', () => run(() => openCountry(code)));
    $('be-countries').append(b);
  }
  const searchLabel = el('label', '', '표 안에서 검색'), search = el('input');
  search.id = 'be-search'; search.type = 'search'; search.placeholder = '상품명·번호·옵션'; searchLabel.append(search);
  $('be-filters').append(searchLabel);
  search.addEventListener('input', () => { query = search.value.trim(); page = 0; draw(); });
  for (const [k, label] of [['brand', '브랜드'], ['vehicle', '차량·제조사'], ['model', '차종'], ['kind', '상품 종류'], ['price', '가격']]) {
    const field = el('label', '', label), s = el('select'); s.setAttribute('aria-label', label + ' 필터');
    s.addEventListener('change', () => { state().filters[k] = s.value; page = 0; draw(); });
    field.append(s); $('be-filters').append(field); filters.set(k, s);
  }
  function rebuildFilters() {
    for (const [k, select] of filters) {
      select.replaceChildren(new Option('전체', ''));
      // 차량·제조사는 자동차/오토바이 머리글 아래에 제조사 이름만 보인다. 필터 값은 '자동차(기아)' 그대로다.
      const groups = k === 'vehicle' ? { 자동차: el('optgroup'), 오토바이: el('optgroup') } : {};
      const values = [...new Set(rows().map(r => filterValue(r, k)))];
      values.sort((a, b) => k === 'price' ? (a === 'unknown' ? 1 : b === 'unknown' ? -1 : Number(a) - Number(b)) : a.localeCompare(b, 'ko'));
      for (const value of values) {
        if (k === 'price') {
          const unit = scopes.find(s => s[0] === scope)[2];
          const label = value === 'unknown' ? '가격 정보 없음' : Number(value).toLocaleString('ko-KR', { maximumFractionDigits: 2 }) + ' ' + unit;
          select.add(new Option(label, value)); continue;
        }
        const [, type, make] = value.match(/^(자동차|오토바이)\((.+)\)$/) || [];
        if (groups[type]) groups[type].append(new Option(make, value)); else select.add(new Option(value, value));
      }
      for (const [label, group] of Object.entries(groups)) if (group.children.length) { group.label = label; select.append(group); }
      select.value = state().filters[k] || '';
      if (select.selectedIndex < 0) select.value = '';
      state().filters[k] = select.value;
    }
  }
  function tooltip(input, amount, unit) {
    const values = ['USD', 'JPY', 'KRW'].map(c => window.VUCurrency?.convert(Number(amount), unit, c));
    if (amount !== '' && values.every(v => v != null))
      input.title = values.map((v, i) => ['USD', 'JPY', 'KRW'][i] + ' ' + v.toLocaleString('ko-KR', { maximumFractionDigits: 2, minimumFractionDigits: 2 })).join(' · ');
    else input.removeAttribute('title');
  }
  function draw() {
    const filtered = view(), unit = unitOf(scope);
    const policy = imagePolicy(scope);
    // 아임웹 네 범위도 Open API 로 읽고 쓴다(2026-10-05) — 예전의 '카탈로그 참조 · API 연동 전' 잠금은 없앴다.
    $('be-price-label').textContent = '기존 판매가';
    for (const id of ['be-price-source', 'be-apply', 'be-save', 'be-image-apply', 'be-th-select-all', 'be-country-apply', 'be-country-images']) $(id).disabled = busy;
    // 나라 화면은 가격 전용이다 — 표 머리의 이미지 · 가격 입력 줄 대신 [본사 값으로 맞추기] · [본사 상세 이미지 →] 를 쓴다.
    root.querySelector('.be-th-tools').hidden = !!country;
    $('be-country-apply').hidden = !country; $('be-country-images').hidden = !country || !COUNTRIES[country].images;
    // 서버 검색칸·전체 목록 동기화·환율가는 아마존·eBay 만. 환율가는 행마다 계산하므로 고르면 판매가 칸을 잠근다.
    const amazonEbay = /^(?:amazon-|ebay$)/.test(scope), source = $('be-price-source');
    $('be-api-query').hidden = $('be-sync').hidden = !amazonEbay;
    // 나라 화면은 쪽마다 짝 상품의 현재가를 바로 읽는다 — 데이터 갱신은 몰 탭에서.
    $('be-refresh').hidden = !!country;
    // 가격 정책은 쿠팡 · 네이버만. 고를 것이 '직접 입력' 하나뿐인 몰에서는 칸째 숨긴다(표 머리 입력 줄이 한 줄 낮아진다).
    const fxOption = source.querySelector('[value="fx"]'), policyOption = source.querySelector('[value="policy"]');
    fxOption.hidden = fxOption.disabled = !amazonEbay;
    policyOption.hidden = policyOption.disabled = !POLICY_SCOPES.has(scope);
    source.hidden = fxOption.disabled && policyOption.disabled;
    if (source.selectedOptions[0]?.disabled) source.value = 'direct';
    $('be-value').disabled = busy || source.value !== 'direct';
    root.querySelector('.be-help').textContent = country ? COUNTRY_HELP : defaultHelp;
    $('be-photo-label').textContent = country ? '쇼핑몰' : '사진 · ' + policy.label;
    $('be-image-hint').textContent = country ? '' : policy.display === 'images' ? 'HTML 이미지 지원 · 순서대로 미리보기' : '이미지 미리보기 · 저장은 URL 배열';
    page = Math.max(0, Math.min(page, pages() - 1));
    $('be-currency').textContent = unit;
    $('be-value').step = unit === 'USD' ? '.01' : '1';
    showCount();
    $('be-page').textContent = (page + 1) + ' / ' + pages();
    $('be-prev').disabled = busy || page === 0; $('be-next').disabled = busy || page + 1 >= pages();
    document.querySelectorAll('#be-platforms button').forEach(b => b.setAttribute('aria-selected', String(!country && b.dataset.scope === scope)));
    document.querySelectorAll('#be-countries button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.country === country)));
    syncHeader();
    const body = $('be-body'); body.replaceChildren();
    if (country) for (const g of pageGroups()) {
      // 묶음 머리: 본사몰 상품명 · 번호, 시트로 찾은 짝이면 표시, 인덱스에 없으면 그 이유.
      const head = el('tr', 'be-country-head'), td = el('td', '', g.own[0].name);
      td.colSpan = 8;
      td.append(el('small', '', titleOf(scope) + ' 상품 ' + g.id + (g.t.missing ? ' · ' + g.t.missing : g.t.via === 'sheet' ? ' · Vehicles 시트로 찾은 짝' : '') +
        (g.t.missing ? '' : ' · 짝 ' + g.members.length + '줄')));
      head.append(td); body.append(head);
      for (const r of [...g.own, ...g.members]) body.append(rowEl(r));
    }
    else for (const r of pageRows()) body.append(rowEl(r));
    if (!filtered.length) {
      const td = el('td', '', rows().length ? '필터에 맞는 상품이 없습니다.' : '플랫폼을 선택하고 상품 목록을 조회하세요.');
      td.colSpan = 8; const tr = el('tr'); tr.append(td); body.append(tr);
    }
    autoLoad();
  }
  // 표 한 줄. 나라 화면에서는 사진 칸 대신 몰 로고 · 이름을 보이고, 단위는 그 줄의 몰 것이다.
  function rowEl(r) {
      const sc = r.scope || scope, unit = unitOf(sc);
      const tr = el('tr'); tr.classList.toggle('be-dirty', dirty(r));
      const selectCell = el('td', 'be-check-column'), check = el('input'); check.type = 'checkbox'; check.checked = !!r.selected;
      check.setAttribute('aria-label', '선택: ' + r.name); check.disabled = busy || locked(r);
      check.addEventListener('change', () => { r.selected = check.checked; draw(); }); selectCell.append(check); tr.append(selectCell);
      const photo = el('td', 'be-photo-column');
      if (country) {
        const mall = el('span', 'be-mall'); mall.append(logoOf(sc), el('span', '', titleOf(sc) + (locked(r) && !r.readonly ? ' (보기만)' : '')));
        photo.append(mall);
      } else {
      const images = previewImageUrls(r.newImages || r.images || r.image || r.mainImageUrl || r.imageUrl || []);
      {
        const gallery = el('div', 'be-photo-gallery');
        images.forEach((url, index) => {
          if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return;
          const item = el('figure', 'vu-image-tile'), image = el('img'); image.src = url; image.alt = r.name + ' 이미지 ' + (index + 1); image.loading = 'lazy';
          const label = el('figcaption', '', String(index + 1));
          image.onerror = () => { image.hidden = true; label.textContent = (index + 1) + ' · 미리보기 실패'; label.title = url; };
          const open = el('button', 'be-image-open'); open.type = 'button'; open.setAttribute('aria-label', image.alt + ' 확대'); open.title = '클릭하여 전체 이미지 보기';
          open.onclick = () => viewImage(url, image.alt); open.append(image);
          item.append(open);
          // 전체 목록을 모르는 행(imagesReady 아님)에는 ✖를 그리지 않는다 — 아래 '이미지 목록 조회'가 먼저다.
          if (r.imagesReady) {
            const remove = el('button', 'vu-image-remove', '×'); remove.type = 'button';
            remove.setAttribute('aria-label', r.name + ' 이미지 ' + (index + 1) + ' 삭제');
            remove.disabled = busy || r.readonly; remove.title = '이미지 삭제';
            remove.onclick = event => {
              event.preventDefault(); event.stopPropagation();
              if (busy || r.readonly || !r.imagesReady) return;
              const next = [...(Array.isArray(r.newImages) ? r.newImages : r.images)];
              next.splice(index, 1);
              // Images belong to the product, so every Coupang option shares the draft.
              rows().filter(x => x.id === r.id).forEach(x => {
                x.newImages = [...next]; x.imageResult = '이미지 변경 대기';
              });
              r.selected = true;
              draw(); tell(r.name + ' 이미지 삭제 대기 · 선택 변경 저장을 누르면 반영됩니다.');
            };
            item.append(remove);
          }
          item.append(label); gallery.append(item);
        });
        photo.append(gallery);
      }
      if (!images.length) photo.append(el('small', '', '이미지 없음'));
      if (!r.imagesReady) {
        photo.append(el('small', '', '이미지 목록 조회 필요'));
        if (!r.readonly) {
          const load = el('button', '', '이미지 목록 조회'); load.type = 'button'; load.disabled = busy;
          load.onclick = () => run(async () => {
            const snapshot = await call('bulk-images-load', { scope, id: r.id });
            rows().filter(x => x.id === r.id).forEach(x => Object.assign(x, {
              images: snapshot.images, imageRevision: snapshot.revision, imagesReady: true,
              newImages: null, imageResult: '',
            }));
            tell(r.name + ' 이미지 목록을 불러왔습니다. X로 삭제 후 선택 변경 저장을 누르세요.');
          });
          photo.append(load);
        }
      }
      }
      if (imageDirty(r)) photo.append(el('small', 'be-image-pending', '이미지 변경 대기'));
      tr.append(photo);
      const title = el('td', 'be-title', r.name); if (r.variant) title.append(el('small', '', r.variant));
      // 판매 페이지 링크. 주소는 메인이 행의 번호로 다시 만들어 기본 브라우저로 연다(open-product-page).
      const pageUrl = productPageUrl(linkOf(r));
      if (pageUrl) {
        const a = el('a', 'be-page-link', titleOf(sc) + '에서 보기'); a.href = pageUrl; a.title = pageUrl;
        a.onclick = e => { e.preventDefault(); ipc.invoke('open-product-page', linkOf(r)).then(res => { if (!res?.ok) tell(res?.error || '판매 페이지를 열지 못했습니다.'); }, err => tell(err.message)); };
        title.append(a);
      }
      tr.append(title);
      // 상품번호 / SKU: 첫 줄은 표준 상품번호, 그 아래 SKU, 맨 아래 작게 그 몰의 상품 ID(저장에 쓰는 값).
      const id = el('td', 'be-identity'), ident = identOf(r);
      id.append(el('span', ident.main ? 'be-no' : 'be-no be-missing', ident.main || '번호 미확인'));
      if (ident.count > 1) id.title = ident.all;
      if (ident.skus) id.append(el('small', 'be-sku', 'SKU ' + ident.skus));
      const own = platformId(r); if (own) id.append(el('small', 'be-own-id', own));
      tr.append(id);
      const taxonomy = el('td', '', r.tax.brand); taxonomy.append(el('small', '', r.tax.vehicle + ' / ' + r.tax.model)); tr.append(taxonomy);
      const current = el('td', 'be-price', r.ready ? (r.price === '' ? '미등록' : Number(r.price).toLocaleString('ko-KR') + ' ' + unit) : (r.price !== '' ? (Number.isFinite(Number(r.price)) ? Number(r.price).toLocaleString('ko-KR') + ' ' + unit : r.price) + ' (목록)' : '조회 필요'));
      const fx = state(sc).fx, tier = fx?.links?.[r.id];
      if (tier) current.append(el('small', '', (fx.on ? '환율 자동 · ' : '환율 등급 · ') + tier));
      tr.append(current);
      const priceCell = el('td'), input = el('input'); input.type = 'number'; input.step = unit === 'USD' ? '.01' : '1'; input.min = unit === 'USD' ? '.01' : '1';
      input.value = r.newPrice; input.disabled = busy || !r.ready || locked(r) || r.priceReadonly;
      input.setAttribute('aria-label', '판매가: ' + r.name + (r.variant ? ' / ' + r.variant : ''));
      input.addEventListener('input', () => {
        // 손으로 고치면 정책이 넣은 정가는 버린다(다른 판매가에 정가 140,000 이 숨어 따라가지 않게 — 11-06 리뷰).
        r.newPrice = input.value; r.newList = ''; r.selected = true; r.followed = false; check.checked = true; tr.classList.toggle('be-dirty', dirty(r));
        tooltip(input, input.value, unit);
        showCount(); syncHeader();
      });
      // 나라 화면의 본사 줄을 고치면(칸을 떠날 때) 묶음의 다른 몰 줄이 그 값을 따라간다.
      if (country && sc === scope) input.addEventListener('change', () => { follow(groups().filter(g => g.id === r.id), true); draw(); });
      input.addEventListener('mouseover', () => tooltip(input, input.value, unit)); priceCell.append(input); tr.append(priceCell);
      const resultCell = el('td', 'be-result', r.result || (r.priceReadonly ? '이미지만 수정 가능' : r.readonly ? '판매가 없음' : r.ready ? '가격 입력 가능' : '현재가 조회 전'));
      if (r.imageResult) resultCell.append(el('small', '', r.imageResult)); tr.append(resultCell);
      return tr;
  }
  // 작업 중에도 왼쪽 레일(표 안 검색·필터)은 잠그지 않는다 — 자동 불러오기가 도는 동안에도 계속 찾고 거를 수 있게.
  // 표 머리 이미지 목록도 행과 따로라 잠그지 않는다(풀 때 첫 장의 ← 까지 켜지 않게 — 그 칸은 갤러리가 정한다).
  function lock(value) {
    busy = value;
    root.querySelectorAll('button, input, select').forEach(n => { if (!n.closest('#be-filters, #be-image-list')) n.disabled = value; });
    $('be-stop').hidden = !value; $('be-stop').disabled = false;
    draw();
  }
  async function run(work) {
    if (busy) return;
    lock(true); cancel = false;
    try { await work(); } catch (e) { tell(e.message); } finally { rebuildFilters(); lock(false); }
  }
  function unsaved() {
    if (!rows().some(dirty)) return false;
    tell('입력한 변경이 있습니다. 저장하거나 가격을 원래 값으로 되돌린 뒤 목록을 갱신하세요.');
    return true;
  }
  // 목록을 받고 첫 쪽의 현재가·이미지까지 읽는다. '상품 목록 조회'와 '전체 목록 동기화'(끝나면 바로 목록을 다시 받는다)가 같이 쓴다.
  // 돌려주는 값: 목록이 준 줄마다의 가격(데이터 갱신이 현재가와 비교한다). force 는 네이버 · 쿠팡 목록 캐시를 건너뛴다.
  async function listProducts(head = '', force = false) {
    tell(head + '상품 목록을 불러오는 중…');
    // 숨은 검색칸(아마존·eBay 밖)에 남은 글자로 거르지 않는다.
    const result = await call('bulk-price-list', { scope, query: $('be-api-query').hidden ? '' : $('be-api-query').value.trim(), force });
    state().rows = result.items.map(augment); state().note = result.note || ''; state().tried = new Set(); state().targets = null; state().listed = true;
    const listedPrices = new Map(state().rows.map(r => [key(r), r.price]));
    // 아마존·eBay 행의 환율 등급 꼬리표. 못 읽어도 목록은 그대로 쓴다.
    state().fx = /^(?:amazon-|ebay$)/.test(scope) ? await call('fx-auto-price-links', { scope }).catch(() => null) : null;
    if (country) await loadTargets();
    state().filters = {}; query = ''; search.value = ''; page = 0;
    rebuildFilters(); draw();
    const listed = head + (result.note || result.items.length + '개 상품을 불러왔습니다.');
    tell(listed);
    const loaded = await loadVisible();
    if (loaded) tell(listed + ' ' + loaded);
    return listedPrices;
  }
  $('be-list').addEventListener('click', () => run(async () => { if (!unsaved()) await listProducts(); }));
  // 아마존 · eBay 전체 목록을 API 로 다시 받아 이 PC 캐시에 저장한다(전체 목록 동기화 · 데이터 갱신).
  async function syncListCache() {
    tell('전체 목록 동기화 중… 완료까지 수 분 걸릴 수 있습니다.');
    const r = await ipc.invoke(scope === 'ebay' ? 'ebay-refresh-cache' : 'amazon-refresh-cache', { enrichBrand: false, marketplaceId: scope === 'amazon-jp' ? 'A1VC38T7YXB528' : 'ATVPDKIKX0DER' });
    if (!r.success) throw new Error(r.error);
  }
  $('be-sync').addEventListener('click', () => run(async () => {
    if (unsaved()) return;
    await syncListCache();
    await listProducts('목록 동기화 완료. ');
  }));
  // 데이터 갱신: 목록 캐시를 건너뛰어 다시 받고(아마존 · eBay 는 전체 목록 동기화), 보이는 쪽만이 아니라 모든 상품의 현재가를 몰 API 로
  // 읽는다. 읽은 값은 몰의 저장본에 들어간다(쿠팡 판매가 캐시 · 아마존 · eBay 목록 캐시 — 네이버 · 아임웹 목록은 늘 API 에서 바로 읽는다).
  // 목록이 보여 준 값과 현재가가 다른 행 수를 알린다. 상품마다 호출이라 오래 걸릴 수 있고 [중단]으로 멈춘다.
  $('be-refresh').addEventListener('click', () => run(async () => {
    if (unsaved()) return;
    if (/^(?:amazon-|ebay$)/.test(scope)) await syncListCache();
    const listedPrices = await listProducts('', true);
    const rest = rows().filter(r => !r.readonly && !r.ready);
    rest.forEach(r => state().tried.add(r.id));
    const got = rest.length && !cancel ? await loadPrices(rest) : null;
    const fresh = rows().filter(r => r.ready && listedPrices.has(key(r)));
    const changed = fresh.filter(r => String(listedPrices.get(key(r)) ?? '') !== '' && Number(listedPrices.get(key(r))) !== Number(r.price)).length;
    const unreadLeft = rows().filter(r => !r.readonly && !r.ready).length;
    tell('데이터 갱신 ' + (cancel ? '중단' : '완료') + ': 현재가를 읽은 행 ' + rows().filter(r => r.ready).length + '개, 목록 값과 현재가가 달랐던 행 ' + changed + '개' +
      (unreadLeft ? ', 읽지 못한 행 ' + unreadLeft + '개' + (got?.firstError ? '(' + got.firstError + ')' : '') : '') + (got?.blocked ? '. 멈춘 이유: ' + got.blocked : '') + '.');
  }));
  // 머리글 전체선택: 체크하면 필터 결과의 모든 페이지를 고르고, 풀면 (예전 '선택 해제' 버튼처럼) 선택을 모두 지운다.
  const toggleAllSelection = checked => {
    const targets = checked ? view().filter(r => !locked(r)) : country ? countryScopes().flatMap(sc => rows(sc)) : rows();
    targets.forEach(r => { r.selected = checked; });
    const visible = new Set(pageRows());
    const off = targets.filter(r => !visible.has(r)).length;
    draw();
    tell(checked
      ? '필터 결과 ' + targets.length + '행을 모두 선택했습니다' + (off ? ' (다른 페이지 ' + off + '행 포함).' : '.')
      : '선택을 모두 해제했습니다.');
  };
  $('be-th-select-all').addEventListener('change', e => {
    toggleAllSelection(e.target.checked);
  });
  // 현재가는 몰이 한 요청에 허용하는 만큼 묶어 읽는다(메인 bulk-price-load-many: 아마존 20건×2).
  // 묶음 조회가 없는 쿠팡·eBay 는 메인이 상품마다 읽으므로, 진행 표시와 중단이 늦지 않게 작게 나눠 보낸다.
  // 네이버도 이미지까지 읽느라 메인이 상품마다 원상품을 읽는다(목록 조회 결과에는 상세 이미지가 없다) — 같은 이유로 작게.
  const LOAD_CHUNK = { naver: 10, 'amazon-us': 40, 'amazon-jp': 40, ebay: 8, coupang: 4 };
  // 행의 상품마다 현재가·이미지를 읽어 행을 바꿔 끼운다. 자동 불러오기(보이는 쪽)와 '가격 적용'(안 읽은 선택 행)이 같이 쓴다.
  async function loadPrices(work, sc = scope) {
    const products = [...new Map(work.map(r => [r.id, r])).values()];
    let ok = 0, failed = 0, firstError = '', blocked = '', noImages = 0;
    const fail = (r, e) => {
      failed++; firstError = firstError || e.message;
      rows(sc).filter(x => x.id === r.id).forEach(x => { x.result = e.message; x.ready = false; });
    };
    const chunk = LOAD_CHUNK[sc] || 1;
    for (let i = 0; i < products.length && !cancel && !blocked; i += chunk) {
      const part = products.slice(i, i + chunk);
      tell('현재가 조회 ' + (i + part.length) + '/' + products.length);
      let got;
      try {
        got = await call('bulk-price-load-many', { scope: sc, ids: part.map(r => r.id), includeImages: true,
          images: Object.fromEntries(part.map(r => [r.id, r.image])) });
      } catch (e) {
        if (/No handler registered/i.test(e.message || '')) throw new Error('새 현재가 조회 기능을 사용하려면 앱을 완전히 종료한 뒤 다시 실행하세요.');
        part.forEach(r => fail(r, e));
        // 직원 토큰 만료·프록시 장애·인증 실패·429 는 다음 상품도 똑같이 실패한다. 계속 두드리지 않는다.
        if (e.blocking) blocked = e.message;
        draw();
        continue;
      }
      const byId = new Map(part.map(r => [r.id, r]));
      for (const item of got.items) {
        const r = byId.get(item.id);
        if (!r) continue;
        if (!item.rows) { fail(r, new Error(item.error || '현재가를 불러오지 못했습니다.')); continue; }
        const at = rows(sc).findIndex(x => x.id === r.id);
        const other = rows(sc).filter(x => x.id !== r.id);
        // 옵션 줄이 이미 있었으면 그 선택을 이어 쓴다. 상품 한 줄을 처음 펼칠 때는 그 줄이 선택돼 있었을 때만 전부 고른다 —
        // 예전에는 옵션 하나만 골라도 불러온 뒤 모든 옵션이 선택돼 '가격 적용' 이 옵션가를 한 값으로 납작하게 했고,
        // 자동 불러오기는 고르지 않은 행까지 읽으므로 선택을 새로 만들면 안 된다.
        const before = rows(sc).filter(x => x.id === r.id);
        const picked = before.some(x => x.optionId) ? new Map(before.map(x => [x.optionId || '', x.selected])) : null;
        const wasSelected = before.some(x => x.selected);
        // 이미지 변경안([↓]·✖)이 걸린 상품은 변경안과 그때 읽은 revision 을 새 행에 옮긴다. 가격 적용이 안 읽은 행을
        // 불러오며 행을 바꿔 끼울 때 변경안이 조용히 사라지던 것. revision 을 그대로 두어 저장의 expectedRevision 검사가 맞다.
        const draft = before.find(x => x.imagesReady && Array.isArray(x.newImages));
        const links = Object.fromEntries(LINK_KEYS.map(k => [k, before.find(b => b[k])?.[k]]).filter(([, v]) => v));
        // 이미 읽은 행을 다시 읽을 때(나라별 통일이 이미지 때문에) 손으로 넣어 둔 판매가 초안도 옮긴다.
        const typed = new Map(before.filter(priceDirty).map(x => [x.optionId || '', x.newPrice]));
        other.splice(at, 0, ...item.rows.map(x => ({ ...augment({ ...links, ...x }), ...(typed.has(x.optionId || '') && { newPrice: typed.get(x.optionId || '') }),
          ...(draft && { images: draft.images, imageRevision: draft.imageRevision, imagesReady: true, newImages: [...draft.newImages], imageResult: draft.imageResult }),
          selected: !x.readonly && (picked ? !!picked.get(x.optionId || '') : wasSelected) })));
        state(sc).rows = other;
        if (!draft && !item.rows[0]?.imagesReady) noImages++;
        ok++;
      }
      if (got.blocked) blocked = got.blocked;
      draw();
    }
    rebuildFilters();
    return { total: products.length, ok, failed, firstError, blocked, noImages };
  }
  // 보이는 쪽(25행)의 현재가·이미지는 언제나 읽는다. 목록 전체를 읽으면 네이버·쿠팡은 상품마다 호출이라 수천 번(수십 분)이
  // 되므로 지금 쪽만 — 쪽을 넘기거나 거르면 그 쪽을 읽는다. 한 번 읽으려 한 상품은 이 목록에서 다시 두드리지 않는다
  // (실패·인증 오류를 되풀이하지 않게). 다시 읽으려면 상품 목록을 조회한다. 읽은 결과를 알리는 글을 돌려준다(없으면 '').
  // 나라 화면은 그 쪽 묶음의 짝 상품 자리를 먼저 만든다(그 몰 목록을 안 불러왔어도 읽을 수 있게).
  const unread = () => { if (country) place(pageGroups()); return pageRows().filter(r => !r.readonly && (!r.ready || !r.imagesReady) && !state(r.scope || scope).tried.has(r.id)); };
  async function loadVisible() {
    const work = unread();
    if (!work.length) return '';
    work.forEach(r => state(r.scope || scope).tried.add(r.id));
    const sum = { total: 0, ok: 0, failed: 0, firstError: '', blocked: '', noImages: 0 };
    for (const sc of new Set(work.map(r => r.scope || scope))) {
      if (cancel || sum.blocked) break;
      const got = await loadPrices(work.filter(r => (r.scope || scope) === sc), sc);
      for (const k of ['total', 'ok', 'failed', 'noImages']) sum[k] += got[k];
      sum.firstError ||= got.firstError; sum.blocked ||= got.blocked;
    }
    if (country) { settle(work, !sum.blocked && !cancel); follow(pageGroups(), false); }
    const { total, ok, failed, firstError, blocked, noImages } = sum;
    const counts = '성공 ' + ok + ' · 실패 ' + failed + (ok + failed < total ? ' · 남음 ' + (total - ok - failed) : '');
    // 이미지는 현재가와 함께 언제나 읽는다(메인 loadMany). 그래도 목록이 없는 상품은 행의 '이미지 목록 조회'로 다시 읽는다.
    const imageNote = noImages ? ' 이미지 목록이 오지 않은 상품 ' + noImages + '개 — 행의 이미지 목록 조회로 다시 읽으세요.' : '';
    return blocked ? '현재가 조회를 멈췄습니다 (' + counts + '). 나머지 상품도 같은 이유로 실패할 오류입니다: ' + blocked
      : cancel ? '현재가 조회를 중단했습니다 (' + counts + ').'
        : failed ? '현재가 조회 끝 (' + counts + '). 실패한 행은 처리 결과 칸을 확인하세요. 첫 오류: ' + firstError + imageNote
          : '현재가·이미지 ' + ok + '개 상품을 불러왔습니다.' + imageNote;
  }
  // 쪽 넘김·검색·필터·몰 전환 뒤 그리기(draw)마다 부른다. 타자 한 글자마다 읽지 않게 잠깐 기다리고, 작업 중이면 끝난 뒤의 draw 가 다시 부른다.
  // 읽을 행이 없으면 아무것도 하지 않는다(잠금·다시 그리기도 없이 — 그리는 중인 표를 바꿔 끼우지 않게).
  let autoTimer = 0;
  function autoLoad() {
    clearTimeout(autoTimer);
    autoTimer = setTimeout(() => { if (!busy && unread().length) run(async () => { const note = await loadVisible(); if (note) tell(note); }); }, 300);
  }
  // 가격 적용: 값 출처가 '직접 입력'이면 칸의 값을, '환율가'면 행마다 계산한 값을 고른 행에 넣는다. 현재가를 아직 안 읽은
  // 행은 먼저 읽는다(현재가 불러오기와 같은 길). 보내기는 '선택 변경 저장'과 그 확인창에서만 한다.
  // 환율가 = 국내 기준가 등급 ÷ 오늘 환율(우대 없음)을 앞 두 자리만 남긴 값. 판단은 환율 자동 변경과 같다(fx_auto_price.js).
  // 자동 저장이 건너뛰는 10% 초과 변동도 채운다. 환율 변동 1% 미만·이미 같은 가격은 지금 판매가를 그대로 둔다.
  // 가격 정책 = price_policy.js 의 1set 판매가 · 정가(판 구분 없음, 11-06). 정가는 저장 때 판매가와 함께 나간다(newList).
  $('be-apply').addEventListener('click', () => run(async () => {
    const source = $('be-price-source').value, fx = source === 'fx', policy = source === 'policy', value = $('be-value').value;
    if (source === 'direct' && (!value || Number(value) <= 0)) { tell('덮어쓸 판매가를 입력하세요.'); return; }
    // 고른 줄은 불러오기 전에 키로 기억한다. 불러온 가격이 가격 필터에서 빠져도 그 줄을 채우고, 필터가 숨기던 선택 줄은 건드리지 않는다.
    const before = selected(), wanted = new Set(before.map(key)), ids = new Set(before.map(r => r.id));
    if (!before.length) { tell('가격을 넣을 상품을 선택하세요.'); return; }
    const pending = before.filter(r => !r.ready && !r.priceReadonly);
    const loaded = pending.length ? await loadPrices(pending) : null;
    if (cancel) { tell('가격 적용을 중단했습니다. 판매가 칸은 바꾸지 않았습니다.'); return; }
    // 상품 한 줄이 불러온 뒤 옵션 여러 줄로 펼쳐지면 옵션가가 한 값으로 납작해지지 않게 채우지 않는다(옵션을 보고 다시 적용).
    const spread = new Set(), picked = [];
    for (const r of rows()) {
      if (wanted.has(key(r))) picked.push(r);
      // 가격 정책은 줄마다 판 · 구성을 읽어 값을 정하므로 펼쳐진 옵션 줄도 그대로 채운다.
      else if (wanted.has(r.id + ':')) { if (!policy && rows().filter(x => x.id === r.id).length > 1) spread.add(r.id); else picked.push(r); }
    }
    const ready = picked.filter(r => r.ready && !r.readonly && !r.priceReadonly);
    // 고른 상품 안의 읽기 전용 줄(쿠팡 승인 전 옵션·이미지만 고칠 수 있는 줄)은 건너뛰고 개수만 알린다.
    const readonly = rows().filter(r => ids.has(r.id) && !spread.has(r.id) && (r.readonly || r.priceReadonly)).length;
    const unloaded = picked.filter(r => !r.ready && !r.readonly && !r.priceReadonly).length;
    const inView = new Set(view()), hidden = ready.filter(r => !inView.has(r)).length;
    const notes = (readonly ? ' 읽기 전용이라 건너뛴 행 ' + readonly + '개.' : '') +
      (unloaded ? ' 현재가를 불러오지 못해 건너뛴 행 ' + unloaded + '개(처리 결과 칸 확인).' : '') +
      (spread.size ? ' 상품 ' + spread.size + '개가 옵션 ' + rows().filter(r => spread.has(r.id)).length + '행으로 펼쳐져 판매가를 넣지 않았습니다. 옵션별 현재가를 확인한 뒤 다시 가격 적용을 누르세요.' : '') +
      (hidden ? ' 현재가를 불러온 뒤 가격 필터에서 빠진 행 ' + hidden + '개도 채웠습니다(필터를 바꿔야 보이고 저장됩니다).' : '') +
      (loaded?.blocked ? ' 현재가 조회를 멈춘 이유: ' + loaded.blocked : '');
    if (!ready.length) { tell('판매가를 넣을 수 있는 행이 없습니다.' + notes); return; }
    // 다른 값 출처로 덮으면 앞서 정책이 넣은 정가는 버린다(새 판매가가 정가보다 클 수 있다).
    if (!policy) ready.forEach(r => { r.newList = ''; });
    const visible = new Set(pageRows()), off = ready.filter(r => inView.has(r) && !visible.has(r)).length;
    const where = off ? '(다른 페이지 ' + off + '행 포함)' : '';
    if (policy) {
      const skipped = new Map();
      let filled = 0;
      for (const r of ready) {
        const x = policyPrice(scope, r);
        if (x.skip) { r.result = '정책 건너뜀: ' + x.skip; const why = x.skip.replace(/지금 [\d,]+/g, '…'); skipped.set(why, (skipped.get(why) || 0) + 1); continue; }
        r.newPrice = String(x.price); r.newList = String(x.list); r.result = x.result; filled++;
      }
      tell(filled + '행에 정책 판매가 · 정가를 입력했습니다' + where + '.' + (skipped.size ? ' 건너뜀: ' + [...skipped].map(([why, n]) => why + ' ' + n + '행').join(' · ') + '.' : '') + notes +
        ' 선택 변경 저장을 누르면 판매가와 정가를 함께 보냅니다. 쿠폰은 판매자센터에서 따로 만듭니다(' + couponGuide() + ' — docs/coupon-discount.md).');
      return;
    }
    if (!fx) {
      ready.forEach(r => { r.newPrice = value; });
      tell(ready.length + '행에 가격을 입력했습니다' + where + '.' + notes + ' 선택 변경 저장을 누르면 반영됩니다.');
      return;
    }
    const plan = await call('fx-auto-price-plan', { scope, rows: ready.map(r => ({ id: r.id, optionId: r.optionId || '', price: r.price })) });
    const byKey = new Map(plan.rows.map(x => [x.id + ':' + (x.optionId || ''), x]));
    let filled = 0, large = 0, kept = 0, missing = 0;
    for (const r of ready) {
      const x = byKey.get(key(r));
      if (!x?.target) { missing++; r.result = '환율가 없음: ' + (x?.error || '등급 없음'); continue; }
      const tier = '국내 ' + Number(x.tier.krw).toLocaleString('ko-KR') + '원' + (x.tier.label ? ' (' + x.tier.label + ')' : '');
      if (x.action === 'same' || x.action === 'small') {
        kept++; r.newPrice = String(r.price);
        r.result = (x.action === 'same' ? '환율가와 같음' : '환율 변동 1% 미만 — 그대로') + ' · ' + tier; continue;
      }
      r.newPrice = x.target; filled++; if (x.action === 'large') large++;
      r.result = '환율가 ' + x.target + ' (환산 ' + Number(x.raw).toLocaleString('ko-KR', { maximumFractionDigits: 2 }) + ') · ' + tier;
    }
    tell(filled + '행에 환율가를 입력했습니다' + where + (large ? ', 그중 10% 넘게 바뀌는 행 ' + large + '개는 확인 후 저장하세요' : '') + '.' +
      (kept ? ' 환율가와 같거나 변동 1% 미만이라 그대로 둔 행 ' + kept + '개.' : '') + (missing ? ' 등급·현재가가 없는 행 ' + missing + '개.' : '') + notes +
      ' 1 USD = ' + Number(plan.rate.KRW.toFixed(2)).toLocaleString('ko-KR') + '원(' + plan.rate.marketDate + ' 기준). 선택 변경 저장을 누르면 반영됩니다.');
  }));
  $('be-price-source').addEventListener('change', draw);
  // 표 머리 이미지 목록: 끌어 놓은 이미지(ESM 이미지호스팅 · 탐색기 파일은 ESM 에 올려서 · + ESM 상세는 이미지 설정의 선택분).
  // 넣을 때마다 갤러리가 그 몰 기준으로 ESM 확인(bulk-images-import)을 마친 목록만 남긴다. 몰마다 따로 둔다.
  // draw() 마다 다시 그리지 않는다 — 다시 그리면 갤러리가 기다리던 ESM 업로드 결과를 버린다.
  function renderImageList() {
    const sc = scope, list = () => state(sc).imageList;
    const set = urls => { state(sc).imageList = [...urls]; if (sc === scope) renderImageList(); };
    window.VUImageGallery.render($('be-image-list'), list(), {
      scope: sc, onReplace: set,
      onRemove: i => set(list().filter((_, k) => k !== i)),
      onMove: (i, step) => { const l = [...list()]; [l[i], l[i + step]] = [l[i + step], l[i]]; set(l); },
    });
    $('be-image-list').querySelector('.vu-image-save-hint').textContent = '이미지를 끌어 놓고 [↓]로 선택 상품에 넣습니다.';
  }
  // [↓]: 선택 상품의 이미지를 표 머리 목록으로 바꾼다(교체). 저장은 선택 변경 저장이 한다.
  $('be-image-apply').addEventListener('click', () => run(async () => {
    // 목록은 넣을 때 ESM 확인 · 몰별 장수 한도(parseImageUrls)를 이미 거쳤다. 확인 · 업로드 중에는 갤러리가 + ESM 상세를 꺼 둔다 —
    // 그동안 누르면 방금 끌어 놓은 이미지가 빠진 옛 목록이 들어간다.
    if ($('be-image-list').querySelector('.vu-image-add')?.disabled) { tell('이미지 목록에 넣는 중입니다. 끝난 뒤 [↓]를 누르세요.'); return; }
    const picked = selected(), images = [...state().imageList];
    if (!picked.length) { tell('이미지를 넣을 상품을 선택하세요.'); return; }
    if (!images.length) { tell('사진 열 머리의 목록에 이미지를 끌어 놓으세요.'); return; }
    // 변경안을 걸기 전에 상품마다 지금 이미지(revision)를 읽는다('이미지 목록 조회'와 같은 길). 상품 하나가 실패해도 나머지는
    // 그대로 두고, 중단을 누르면 다음 상품부터 멈춘다. 지금 이미지를 모르는 상품에는 변경을 걸지 않는다.
    const ids = new Set(picked.map(r => r.id)), snapshots = new Map(), failed = new Map(), ready = new Set();
    for (const id of ids) {
      if (cancel) break;
      if (rows().filter(r => r.id === id).every(r => r.imagesReady)) { ready.add(id); continue; }
      tell('기존 이미지 확인 중… (' + (ready.size + failed.size + 1) + '/' + ids.size + ')');
      try { snapshots.set(id, await call('bulk-images-load', { scope, id })); ready.add(id); }
      catch (e) { failed.set(id, e.message); if (e.blocking) break; }
    }
    const staged = new Set();
    rows().filter(r => ids.has(r.id)).forEach(r => {
      if (!ready.has(r.id)) { if (failed.has(r.id)) r.imageResult = '기존 이미지 확인 실패 — 변경 안 함: ' + failed.get(r.id); return; }
      const snapshot = snapshots.get(r.id);
      if (snapshot) Object.assign(r, { images: snapshot.images, imageRevision: snapshot.revision, imagesReady: true });
      r.newImages = [...images]; r.imageResult = '이미지 변경 대기'; staged.add(r.id);
    });
    const skipped = ids.size - ready.size - failed.size;
    tell(staged.size + '개 상품에 이미지 ' + images.length + '장으로 교체 대기.' +
      (failed.size ? ' 기존 이미지 확인 실패 ' + failed.size + '개(변경 안 함, 처리 결과 칸 확인).' : '') +
      (skipped ? ' 중단으로 ' + skipped + '개 건너뜀.' : '') + ' 선택 변경 저장을 누르면 반영됩니다.');
  }));
  // ── 나라 화면([한국] [미국] [일본]) ── 본사몰 구역 상품 하나 = 한 묶음, 묶음 안에 같은 나라 몰마다 짝인 줄.
  // 줄은 몰마다의 행 객체 그대로다(몰 탭과 같은 초안 · 선택). 짝은 로컬 인덱스(country-sync-targets — 몰 API 안 부름).
  const COUNTRY_HELP = '본사몰 상품마다 같은 나라 몰의 짝이 한 묶음으로 보입니다. 보이는 쪽은 현재가를 자동으로 읽고 본사와 다른 값을 처리 결과 칸에 알립니다. ' +
    '상품을 선택하고 [본사 값으로 맞추기]를 누르거나 본사 줄의 판매가를 고치면 짝이 따라갑니다(네이버는 운전석가, 나머지는 1set 가). 선택 변경 저장은 그 나라 몰 전부에 차례로 보냅니다.';
  const countryScopes = () => { const c = COUNTRIES[country]; return [c.ref, ...c.targets, ...c.view]; };
  // 인덱스 짝 → 그 몰의 [상품 ID, 옵션 ID?]. 쿠팡은 옵션 단위(한 상품에 여러 차의 옵션이 있다).
  const partners = (sc, t) => sc === 'naver' ? (t.naver || []).map(([origin, channel]) => [origin, null, { channelProductNo: channel }])
    : sc === 'coupang' ? (t.coupang || []).map(([id, option]) => [id, option]) : sc === 'imweb-b2b' ? (t.b2b || []).map(([id]) => [id])
      : (t.skus || []).map(([sku]) => [sku]);
  function groups() {
    const c = COUNTRIES[country], found = state().targets || {}, byId = {};
    for (const sc of [scope, ...c.targets, ...c.view]) {
      const m = byId[sc] = new Map();
      for (const r of rows(sc)) m.set(r.id, [...(m.get(r.id) || []), r]);
    }
    const out = [];
    for (const [id, all] of byId[scope]) {
      // 본사 줄: 조합이 있으면 1set · 운전석 조합만(짝이 따라가는 값), 없으면 기본가 줄.
      const own = all.some(r => r.optionId) ? all.filter(r => referenceRole(r)) : all, t = found[id] || {}, members = new Set();
      for (const sc of [...c.targets, ...c.view]) for (const [pid, option] of partners(sc, t))
        for (const r of byId[sc].get(pid) || []) {
          if (c.view.includes(sc) ? r.optionId : option && String(r.optionId) !== option && (r.ready || r.optionId)) continue;   // B2B 는 기본가 줄만
          members.add(r);
        }
      out.push({ id, own: own.length ? own : all, members: [...members], t });
    }
    return out;
  }
  // 그 쪽 묶음의 짝 상품이 그 몰 표에 없으면 자리를 만든다. 한 번 못 읽은 상품(absent)은 다시 만들지 않는다.
  // 목록을 안 불러온 몰에 자리를 만들면, 그 몰 탭에 짝 상품만 보인다 — 그 탭 안내에 적어 둔다.
  function place(list) {
    const c = COUNTRIES[country];
    for (const g of list) for (const sc of [...c.targets, ...c.view]) for (const [pid, , extra] of partners(sc, g.t))
      if (!state(sc).absent.has(pid) && !rows(sc).some(r => r.id === pid)) {
        rows(sc).push(augment({ id: pid, scope: sc, name: '', price: '', ready: false, placeholder: true, ...extra }));
        if (!state(sc).listed) state(sc).note = '나라 화면에서 불러온 짝 상품만 있습니다 — 전체는 상품 목록 조회를 누르세요.';
      }
  }
  // 읽은 뒤: 그 몰이 '없다' 고 답한 자리(그 몰에 없는 SKU 등)는 빼고 다시 만들지 않는다. 막힘(인증 · 429)이나 중단으로
  // 끝났으면 빼지 않는다 — 몰 탓이 아니다. 요청하지 못한 자리는 다음에 다시 읽게 tried 에서 뺀다.
  // 쿠팡 승인 전 옵션처럼 읽기 전용으로 온 줄은 읽은 것이다.
  function settle(work, finished) {
    for (const r of work) if (r.placeholder && !r.ready && !r.result) state(r.scope).tried.delete(r.id);
    if (!finished) return;
    for (const sc of countryScopes()) {
      const gone = new Set(rows(sc).filter(r => r.placeholder && !r.ready && !r.readonly && r.result).map(r => r.id));
      gone.forEach(id => state(sc).absent.add(id));
      if (gone.size) state(sc).rows = rows(sc).filter(r => !gone.has(r.id));
    }
  }
  // 짝 인덱스와 환율 자동 연결(아마존 · eBay — 연결 상품은 따라가지 않는다)을 읽는다. 연결을 못 읽으면 그 몰은 따라가지 않는다(false).
  // 목록을 다시 받으면 예전에 못 읽은 짝도 다시 읽어 본다.
  async function loadTargets() {
    const c = COUNTRIES[country];
    state().targets = await call('country-sync-targets', { ids: [...new Set(rows().map(r => r.id))] });
    for (const sc of [...c.targets, ...c.view]) {
      state(sc).absent = new Set(); state(sc).tried = new Set();
      if (/^(?:amazon-|ebay$)/.test(sc)) state(sc).fx = await call('fx-auto-price-links', { scope: sc }).catch(() => false);
    }
  }
  async function openCountry(code) {
    country = code; switchScope(COUNTRIES[code].ref);
    await loadCatalog();   // follow 가 본사 상품의 판을 카탈로그로 정한다
    if (!rows().length) await listProducts();
    else {
      if (!state().targets) await loadTargets();
      draw();
      const loaded = await loadVisible();
      if (loaded) tell(loaded);
    }
  }
  // 기준(본사) 줄의 값 — 고쳐 둔 칸이 있으면 그 값 — 으로 묶음의 다른 몰 줄을 맞춘다. apply 가 아니면 처리 결과 칸에 차이만 적는다.
  const fmt = (v, sc) => Number(v).toLocaleString('ko-KR', { maximumFractionDigits: 2 }) + ' ' + unitOf(sc);
  // 짝 줄 하나를 여러 본사 상품이 가리키면 그 모두(다른 쪽 묶음 포함)의 값을 모아, 하나로 같을 때만 넣는다 — 마지막 묶음이
  // 조용히 이기지 않게. 넣을 때(apply)는 안 읽은 본사 상품이 하나라도 있으면 넣지 않는다(pickedGroups 가 먼저 읽는다).
  // 건너뛴 줄에 앞서 따라 넣은 값(followed)이 남아 있으면 지운다 — 손으로 넣은 값은 그대로 둔다.
  function follow(list, apply) {
    const c = COUNTRIES[country], n = { filled: 0, same: 0, skipped: 0 }, wanted = new Set(list.flatMap(g => g.members)), picks = new Map();
    for (const g of groups()) {
      const members = g.members.filter(r => wanted.has(r) && c.targets.includes(r.scope) && r.ready && !r.readonly && !r.priceReadonly);
      if (!members.length) continue;
      const mine = rows().filter(r => r.id === g.id), loaded = mine.length > 0 && mine.every(r => r.ready);
      const nos = mine[0]?.identity?.nos || [];
      // 조합 문구에 판이 없는 본사 상품은 카탈로그로 판을 정한다(가격 정책과 같은 규칙). 모르면 예전처럼 null.
      const edition = mine[0] ? editionFor(mine[0], catalog).bsa : null;
      const ref = loaded && { no: nos.length === 1 ? nos[0] : g.t.no, ...referencePrices(mine.map(r => ({ ...r, price: priceDirty(r) ? r.newPrice : r.price })), edition) };
      for (const r of members) {
        const fx = state(r.scope).fx;
        const hint = r.scope === 'coupang' ? (g.t.coupang || []).find(([id, option]) => id === r.id && option === String(r.optionId))?.[2]
          : (g.t.skus || []).find(([sku]) => sku === r.id)?.[1];
        const got = !loaded ? { unread: true } : ref.error ? { skip: ref.error }
          : /^(?:amazon-|ebay$)/.test(r.scope) && !fx ? { skip: '환율 자동 연결을 확인하지 못함' }
            : fx?.on && fx.links?.[r.id] ? { skip: '환율 자동 연결 상품 — 환율 탭에서 연결을 끈 뒤 다시' } : countryPrice(r.scope, r, ref, { bsa: hint });
        picks.set(r, [...(picks.get(r) || []), got]);
      }
    }
    for (const [r, all] of picks) {
      const known = all.filter(x => !x.unread);
      if (!known.length) continue;
      const skip = known.find(x => x.skip)?.skip || (new Set(known.map(x => Number(x.price))).size > 1 ? '짝인 본사 상품 여럿의 값이 다름'
        : apply && known.length < all.length ? '짝인 다른 본사 상품을 아직 읽지 않음' : '');
      if (skip) {
        if (apply && r.followed) { r.newPrice = String(r.price); r.selected = false; r.followed = false; }
        r.result = '본사와 맞출 수 없음: ' + skip; n.skipped++; continue;
      }
      const { price, basis } = known[0], same = Number(r.price) === Number(price), to = fmt(price, r.scope) + ' (' + basis + ')';
      if (apply) {
        r.newPrice = same ? String(r.price) : String(Number(price));
        if (!same) { r.selected = true; r.followed = true; n.filled++; }
      }
      if (same) n.same++;
      r.result = same ? '본사와 같음 · ' + to : apply ? '본사 값 ' + to + ' → 저장 대기' : '본사와 다름 → ' + to;
    }
    return n;
  }
  // 고른 묶음(어느 줄이든 선택된 묶음)의 짝을 다 읽은 뒤 맞춘다. 다른 쪽의 묶음도 고를 수 있다(전체선택 = 필터 결과 전부, 오래 걸리고 중단 가능).
  // 짝을 함께 가리키는 다른 본사 상품(다른 쪽 묶음)의 본사 줄도 읽는다 — follow 가 그 값과 같은지 본다.
  async function pickedGroups(what) {
    const ids = new Set(shownGroups().filter(g => [...g.own, ...g.members].some(r => r.selected && !locked(r))).map(g => g.id));
    if (!ids.size) { tell(what + ': 묶음의 줄을 하나 이상 선택하세요.'); return null; }
    const read = async rowsToRead => {
      for (const sc of new Set(rowsToRead.map(r => r.scope || scope))) {
        if (cancel) break;
        const part = rowsToRead.filter(r => (r.scope || scope) === sc);
        part.forEach(r => state(sc).tried.add(r.id));
        await loadPrices(part, sc);
      }
    };
    place(groups().filter(g => ids.has(g.id)));
    const work = groups().filter(g => ids.has(g.id)).flatMap(g => [...g.own, ...g.members]).filter(r => !r.readonly && (!r.ready || !r.imagesReady));
    await read(work);
    settle(work, !cancel);
    const partnersOf = new Set(groups().filter(g => ids.has(g.id)).flatMap(g => g.members));
    await read(groups().filter(g => !ids.has(g.id) && g.members.some(r => partnersOf.has(r))).flatMap(g => g.own).filter(r => !r.ready));
    return cancel ? null : groups().filter(g => ids.has(g.id));
  }
  $('be-country-apply').addEventListener('click', () => run(async () => {
    const list = await pickedGroups('본사 값으로 맞추기');
    if (!list) return;
    for (const sc of COUNTRIES[country].targets) if (/^(?:amazon-|ebay$)/.test(sc)) state(sc).fx = await call('fx-auto-price-links', { scope: sc }).catch(() => false);
    const n = follow(list, true);
    draw();
    tell(`본사 값으로 맞추기 · ${list.length}개 상품 — 넣음 ${n.filled}행 · 이미 같음 ${n.same}행` + (n.skipped ? ` · 맞출 수 없음 ${n.skipped}행(처리 결과 칸)` : '') +
      '. 선택 변경 저장을 누르면 그 나라 몰에 차례로 보냅니다.');
  }));
  // 한국: 본사 상세 이미지를 네이버 · 쿠팡 상품에 넣는다(쿠팡은 상품의 모든 옵션 공통). 다른 본사 상품(다른 차)도 가리키는
  // 상품은 한 차의 이미지로 덮으면 나머지 차가 틀리므로 넣지 않는다.
  $('be-country-images').addEventListener('click', () => run(async () => {
    const list = await pickedGroups('본사 상세 이미지');
    if (!list) return;
    let staged = 0, shared = 0;
    for (const g of list) {
      const mine = rows().filter(r => r.id === g.id), images = mine.every(r => r.imagesReady) ? mine[0].images : null;
      if (!images?.length) continue;
      for (const sc of COUNTRIES[country].targets) for (const pid of new Set(g.members.filter(r => r.scope === sc).map(r => r.id))) {
        const all = rows(sc).filter(r => r.id === pid);
        if (!all.length || !all.every(r => r.imagesReady) || sameImages(images, Array.isArray(all[0].newImages) ? all[0].newImages : all[0].images)) continue;
        if ((g.t.shared?.[sc] || []).includes(pid)) { all.forEach(r => { r.imageResult = '이미지 건너뜀: 여러 차가 묶인 상품 — 상세 이미지는 직접'; }); shared++; continue; }
        all.forEach(r => { r.newImages = [...images]; r.imageResult = '이미지 변경 대기 (본사 상세)'; });
        const pick = g.members.find(r => r.id === pid && !r.readonly); if (pick) pick.selected = true;
        staged++;
      }
    }
    draw();
    tell(`본사 상세 이미지 · ${staged}개 상품에 변경 대기` + (shared ? ` · 여러 차가 묶여 건너뛴 상품 ${shared}개` : '') + '. 선택 변경 저장을 누르면 반영됩니다.');
  }));
  // 보이지 않는 행이 섞였거나 기존가 대비 크게 바뀌는 행(오타 의심)이 있으면 보내기 전에 한 번 묻는다.
  const BIG_CHANGE = 0.3;
  // jobs: 판매가 · 이미지 작업 전부. 몰 탭은 예전처럼 판매가만 보고(페이지 밖 · 큰 변화가 있을 때만) 묻고,
  // 나라 화면은 여러 몰로 보내므로 언제나 몰별 건수를 보여 주고 묻는다(이미지만 있어도).
  function confirmSave(jobs) {
    const work = jobs.filter(x => x.type === 'price');
    if (!country && !work.length) return true;
    const visible = new Set(pageRows());
    const off = work.filter(x => !visible.has(x.r)).length;
    // 기존가가 0 인 행(아임웹 추가금 방식 옵션 등)은 몇 %인지 셀 수 없어 큰 변화로 본다 — 예전엔 0% 로 세어 묻지 않았다.
    const changes = work.map(x => ({ x, rate: Number(x.expectedPrice) > 0 ? Number(x.newPrice) / Number(x.expectedPrice) - 1 : Infinity }));
    const big = changes.filter(c => Math.abs(c.rate) >= BIG_CHANGE);
    const malls = [...new Set(jobs.map(x => x.r.scope || scope))], lists = work.filter(x => x.newList);
    // 정가(가격 정책)는 새로 쓰는 값이라 언제나 묻는다.
    if (!country && !off && !big.length && !lists.length) return true;
    const pct = rate => Number.isFinite(rate) ? (rate > 0 ? '+' : '') + Math.round(rate * 100) + '%' : '기존 0에서';
    const money = (v, r) => Number(v).toLocaleString('ko-KR') + ' ' + unitOf(r.scope || scope);
    const rates = changes.map(c => c.rate).filter(Number.isFinite), worst = big.sort((a, b) => Math.abs(b.rate) - Math.abs(a.rate))[0];
    const lines = ['선택 변경 ' + (country ? jobs.length + '건' : work.length + '행') + '을 저장합니다.'];
    const per = (sc, type) => jobs.filter(x => (x.r.scope || scope) === sc && x.type === type).length;
    if (country) lines.push('· ' + malls.map(sc => titleOf(sc) + ' ' + [per(sc, 'price') && '판매가 ' + per(sc, 'price') + '행', per(sc, 'images') && '이미지 ' + per(sc, 'images') + '개 상품'].filter(Boolean).join(' + ')).join(' · ') + ' (몰마다 차례로 보냅니다)');
    if (lists.length) lines.push('· 정가(취소선)도 함께 보내는 행: ' + lists.length + '행 (정가 ' + [...new Set(lists.map(x => money(x.newList, x.r)))].join(' · ') + ')');
    if (off) lines.push('· 지금 보이는 페이지 밖의 행: ' + off + '행');
    if (big.length) lines.push('· 기존가 대비 ' + Math.round(BIG_CHANGE * 100) + '% 이상 바뀌는 행: ' + big.length + '행 (가장 큰 변화: ' + titleOf(worst.x.r.scope || scope) + ' ' +
      worst.x.r.name + (worst.x.r.variant ? ' / ' + worst.x.r.variant : '') + ' ' + money(worst.x.expectedPrice, worst.x.r) + ' → ' + money(worst.x.newPrice, worst.x.r) + ', ' + pct(worst.rate) + ')');
    if (rates.length) lines.push('· 변화 범위: ' + pct(Math.min(...rates)) + ' ~ ' + pct(Math.max(...rates)));
    lines.push('', '계속할까요?');
    return window.confirm(lines.join('\n'));
  }
  // 몰 하나로 bulk-save-batch 한 번. 결과는 행마다 처리 결과 칸에 적고 count 에 더한다. 나라 화면은 몰마다 차례로 부른다.
  async function sendBatch(sc, work, count) {
    const received = new Set();
    const apply = item => {
      if (received.has(item.index) || !work[item.index]) return;
      received.add(item.index);
      const job = work[item.index], r = job.r, imageJob = job.type === 'images';
      const targets = imageJob ? rows(sc).filter(x => x.id === r.id) : [r];
      const report = text => targets.forEach(x => { x[imageJob ? 'imageResult' : 'result'] = text; });
      if (item.success) {
        const result = item.data;
        if (result.status === 'VERIFIED') { report('저장·재조회 완료'); count.verified++; }
        else if (result.status === 'UNCHANGED') { report('변경 없음'); count.unchanged++; }
        else if (result.status === 'ACCEPTED') { report(result.message || '변경 접수 완료'); count.accepted++; }
        else { report('확인 필요: ' + (result.message || '반영 확인 필요')); count.check++; }
        if (['VERIFIED', 'UNCHANGED'].includes(result.status)) {
          if (imageJob) targets.forEach(x => { x.images = result.images; x.imageRevision = result.revision; x.newImages = null; });
          else { r.price = result.price; r.newPrice = String(result.price); r.newList = ''; }
        } else if (imageJob) targets.forEach(x => { x.imagesReady = false; });
        else r.ready = false;
      } else {
        if (imageJob) targets.forEach(x => { x.imagesReady = false; }); else r.ready = false;
        if (item.stage === 'pre-send') { report('전송 안 됨: ' + item.error); count.notSent++; }
        else if (item.stage === 'rejected') { report('거부됨 (반영 안 됨): ' + item.error); count.rejected++; }
        else { report('결과 불명 — 다시 보내기 전에 현재가·이미지 확인: ' + item.error); count.unknown++; }
      }
    };
    batchJobId = crypto.randomUUID();
    let queued = false;
    const head = country ? titleOf(sc) + ' ' : '';
    batchProgress = payload => {
      if (payload.result) apply(payload.result);
      tell(head + (payload.preparing ? '변경 목록 검사 ' + payload.index + '/' + work.length : '일괄 저장 ' + received.size + '/' + work.length));
      if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; draw(); }); }
    };
    try {
      const outcome = await call('bulk-save-batch', { jobId: batchJobId, scope: sc, jobs: work.map(job => ({
        type: job.type, id: job.r.id, optionId: job.r.optionId,
        ...(job.type === 'images' ? { urls: job.urls, expectedRevision: job.expectedRevision }
          : { newPrice: job.newPrice, expectedPrice: job.expectedPrice, ...(job.newList && { newList: job.newList }) }),
      })) });
      outcome.results.forEach(apply);
      return { ...outcome, left: work.length - received.size };
    } catch (error) {
      if (error.stage !== 'pre-send') for (const [index] of work.entries())
        if (!received.has(index)) apply({ index, success: false, stage: 'unknown', error: error.message });
      throw error;
    } finally { batchProgress = null; batchJobId = ''; }
  }
  $('be-save').addEventListener('click', () => run(async () => {
    // 몰마다 보낼 줄(이미지 먼저, 그다음 판매가). 몰 탭에서는 그 몰 하나, 나라 화면에서는 그 나라 몰 전부다.
    const plan = new Map();
    for (const r of selected()) {
      const sc = r.scope || scope;
      if (!plan.has(sc)) plan.set(sc, { price: [], images: new Map() });
      if (priceDirty(r) || listDirty(r)) plan.get(sc).price.push({ r, type: 'price', newPrice: r.newPrice, expectedPrice: r.price, newList: listDirty(r) ? r.newList : '' });
      if (imageDirty(r) && !plan.get(sc).images.has(r.id)) plan.get(sc).images.set(r.id, { r, type: 'images', urls: [...r.newImages], expectedRevision: r.imageRevision });
    }
    const batches = [...plan].map(([sc, p]) => [sc, [...p.images.values(), ...p.price]]).filter(([, work]) => work.length);
    if (!batches.length) { tell('선택 행에 변경된 판매가 또는 이미지가 없습니다.'); return; }
    for (const [sc, work] of batches) {
      const unit = unitOf(sc), format = unit === 'USD' ? /^\d+(\.\d{1,2})?$/ : /^\d+$/, priceWork = work.filter(x => x.type === 'price');
      const invalid = priceWork.find(x => !format.test(x.newPrice) || Number(x.newPrice) <= 0 || Number(x.newPrice) > Number.MAX_SAFE_INTEGER);
      if (invalid) throw new Error(titleOf(sc) + ' ' + unit + ' 판매가 형식을 확인하세요 (' + invalid.r.name + ': ' + invalid.newPrice + '). 요청을 전송하지 않았습니다.');
      const notTen = sc === 'coupang' && priceWork.find(x => Number(x.newPrice) % 10 !== 0);
      if (notTen) throw new Error('쿠팡 판매가는 10원 단위로만 바꿀 수 있습니다 (' + notTen.r.name + ': ' + notTen.newPrice + '). 요청을 전송하지 않았습니다.');
      // 이미지 목록도 묻기 전에 검사한다. 막히면 어느 상품인지 이름을 댄다.
      for (const job of work.filter(x => x.type === 'images')) {
        if (!job.urls.length) throw new Error(job.r.name + ': 이미지가 하나도 남지 않았습니다(빈 항목은 저장할 수 없습니다). 한 장 이상 남기거나 이미지 목록 조회로 되돌리세요. 요청을 전송하지 않았습니다.');
        try { parseImageUrls(job.urls, sc); }
        catch (e) { throw new Error(job.r.name + ': ' + e.message + ' 요청을 전송하지 않았습니다.'); }
      }
    }
    if (!confirmSave(batches.flatMap(([, work]) => work))) { tell('저장을 취소했습니다. 요청을 전송하지 않았습니다.'); return; }
    const count = { verified: 0, unchanged: 0, accepted: 0, check: 0, notSent: 0, rejected: 0, unknown: 0 };
    const notes = [];
    let left = 0, stopped = '', cancelled = false;
    for (const [i, [sc, work]] of batches.entries()) {
      // 앞 몰을 중단했으면 뒤 몰은 보내지 않는다. 앞 몰이 막혀도(인증 · 결과 불명) 다른 몰은 따로라 이어 보낸다.
      if (cancel) { left += batches.slice(i).reduce((n, [, w]) => n + w.length, 0); cancelled = true; break; }
      try {
        const outcome = await sendBatch(sc, work, count);
        left += outcome.left; cancelled ||= outcome.cancelled;
        if (outcome.stopped) { stopped ||= outcome.stopped; if (country) notes.push(titleOf(sc) + ' 저장 멈춤: ' + outcome.stopped); }
      } catch (error) {
        if (!country) throw error;
        notes.push(titleOf(sc) + ': ' + error.message);
      }
    }
    const parts = [['저장 확인', count.verified], ['변경 없음', count.unchanged], ['접수', count.accepted], ['확인 필요', count.check],
      ['전송 안 됨', count.notSent], ['거부', count.rejected], ['결과 불명', count.unknown]].filter(([, n]) => n).map(([l, n]) => l + ' ' + n);
    tell((stopped ? '저장을 멈췄습니다 · ' : cancelled ? '중단 · ' : '완료 · ') + (parts.join(' · ') || '처리 없음') +
      (left ? ' · 남음 ' + left : '') + '. ' + (notes.length ? notes.join(' / ') + '. ' : '') +
      ((!country && stopped) || (count.check + count.unknown + count.accepted ? '접수·결과 불명 행은 다시 보내기 전에 현재가·이미지를 확인하세요.' : '')));
  }));
  $('be-stop').addEventListener('click', () => {
    cancel = true; tell('현재 요청 완료 후 다음 상품부터 중단합니다.');
    if (batchJobId) ipc.invoke('bulk-save-cancel', { jobId: batchJobId }).catch(e => tell('중단 요청 확인 실패: ' + e.message));
  });
  $('be-prev').addEventListener('click', () => { page--; draw(); });
  $('be-next').addEventListener('click', () => { page++; draw(); });
  $('be-export').addEventListener('click', () => {
    const cell = x => '"' + String(x ?? '').replace(/^[=+@\t\r-]/, "'$&").replaceAll('"', '""') + '"';
    // '상품번호'는 표와 같이 표준 번호(No.101 BSA)다. 몰이 주는 ID 는 '몰 상품ID' 로 따로 둔다.
    const csv = [['플랫폼', '몰 상품ID', '옵션ID', '상품명', '옵션', '현재가', '입력가', '통화', '결과', '현재 이미지', '적용 이미지', '이미지 결과', 'SKU', '상품번호'],
      ...(country ? view() : rows()).map(r => [r.scope || scope, r.id, r.optionId, r.name, r.variant, r.price, r.newPrice, r.currency, r.result, (r.images || []).join('|'), (r.newImages || []).join('|'), r.imageResult, identOf(r).skus || r.sku, identOf(r).all])]
      .map(line => line.map(cell).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' }));
    const a = el('a'); a.href = url; a.download = 'bulk-price-' + (country || scope) + '-' + new Date().toISOString().slice(0, 10) + '.csv'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  ipc.on('amazon-cache-progress', (_, progress) => {
    if (busy && scope.startsWith('amazon-')) tell('아마존 목록 동기화 · ' + (progress.message || progress.stage || '') +
      (progress.loaded != null ? ' ' + progress.loaded + '/' + (progress.total || '?') : ''));
  });
  ipc.on('ebay-cache-progress', (_, progress) => {
    if (busy && scope === 'ebay') tell('eBay 목록 동기화 · ' + (progress.loaded || 0) + '/' + (progress.total || '?'));
  });
  // 모드 바: 신규등록 · 단일 상품 수정 · 상품 일괄 수정, 오른쪽 끝에 설정 묶음(환율 · API KEY).
  const nav = $('mode-bar'), settings = el('div', 'mode-settings');
  settings.setAttribute('role', 'group'); settings.setAttribute('aria-label', '설정');
  for (const [value, label] of [['bulk', '상품 일괄 수정'], ['fx', '환율'], ['api', 'API KEY']]) {
    const b = el('button', 'mode-label', label); b.type = 'button'; b.dataset.workspace = value;
    b.addEventListener('click', () => show(value)); (value === 'bulk' ? nav : settings).append(b);
  }
  nav.append(settings);
  let requestedApiPlatform = null;
  const keyPlatform = id => ({
    naverTab: 'naver', coupangTab: 'coupang', amazonTab: 'amazon', ebayTab: 'ebay',
    imwebTab: 'imweb', imwebHeadTab: 'imweb',
    naver: 'naver', coupang: 'coupang', ebay: 'ebay', 'amazon-us': 'amazon', 'amazon-jp': 'amazon',
    'imweb-b2b': 'imweb', 'imweb-en': 'imweb', 'imweb-ko': 'imweb', 'imweb-jp': 'imweb'
  })[id];
  const apiLoading = el('p', 'be-help', 'API 설정을 불러오는 중…');
  apiLoading.id = 'api-key-loading'; apiLoading.hidden = true;
  apiLoading.setAttribute('role', 'status'); $('section8-main').prepend(apiLoading);
  function apiView(loaded = false) {
    if (document.body.dataset.workspaceView !== 'api') return;
    const frame = $('form-frame'), win = frame.contentWindow;
    win?.document.documentElement.classList.add('api-key-view');
    if (win?.VUApiKeys && win.document.getElementById('apiKeysTab')) {
      win.switchTab('apiKeysTab');
      if (requestedApiPlatform) win.VUApiKeys.select(requestedApiPlatform);
      requestedApiPlatform = null;
      win.document.querySelectorAll('.tab-btn').forEach(b => { b.style.display = 'none'; });
      apiLoading.hidden = true;
    } else {
      apiLoading.hidden = false;
      apiLoading.textContent = loaded
        ? 'API 설정 화면을 불러오지 못했습니다. 앱을 완전히 종료한 뒤 다시 실행해주세요.'
        : 'API 설정을 불러오는 중…';
    }
  }
  function show(viewName) {
    if (busy || isBulkRunning) { tell('진행 중인 작업이 끝난 뒤 탭을 변경하세요.'); return; }
    const frame = $('form-frame'), previous = document.body.dataset.workspaceView;
    if (!previous)
      lastTab = frame.contentDocument?.querySelector('.tab-pane[style*="display: block"]')?.id || 'naverTab';
    if (viewName === 'api' && previous !== 'api') {
      requestedApiPlatform = previous === 'bulk' ? keyPlatform(scope) :
        keyPlatform(lastTab) || keyPlatform(document.querySelector('#board-body .platform-cell.viewing')?.dataset.tabId) || 'naver';
    }
    if (viewName) document.body.dataset.workspaceView = viewName;
    else delete document.body.dataset.workspaceView;
    root.hidden = viewName !== 'bulk';
    fxRoot.hidden = viewName !== 'fx';
    if (viewName === 'fx' && previous !== 'fx') window.VUFxAutoPrice?.refresh();
    nav.querySelectorAll('[data-workspace]').forEach(b => b.classList.toggle('is-active', b.dataset.workspace === viewName));
    if (viewName === 'api') {
      frame.contentDocument?.documentElement.classList.add('api-key-view');
      if (!frame.src || !frame.src.includes('index.html')) frame.src = 'index.html?mode=' + currentMode;
      openDetailSidebar(); apiView();
    } else {
      apiLoading.hidden = true;
      frame.contentDocument?.documentElement.classList.remove('api-key-view');
      // 수정 모드의 6몰 표에서 왔으면 표로 돌아간다 — 표는 탭 버튼이 없어 applyFilter 가 첫 몰 탭을 띄운다.
      if (!viewName && lastTab === 'mallGridTab' && typeof showMallGrid === 'function') { showMallGrid(); if (typeof syncFrame === 'function') syncFrame(); }
      else if (!viewName) {
        if (frame.contentWindow?.switchTab) frame.contentWindow.switchTab(lastTab);
        if (typeof applyFilter === 'function') applyFilter(lastTab);
        if (typeof syncFrame === 'function') syncFrame();
      }
    }
  }
  nav.addEventListener('click', e => {
    if (e.target.closest('.mode-label') && (busy || isBulkRunning)) {
      e.preventDefault(); e.stopImmediatePropagation();
      tell('진행 중인 작업이 끝난 뒤 탭을 변경하세요.');
    } else if (e.target.closest('label[for="mode-new"],label[for="mode-edit"]')) show('');
  }, true);
  $('form-frame').addEventListener('load', () => requestAnimationFrame(() => apiView(true)));
  window.addEventListener('vu-api-keys-ready', () => apiView());
  // 일괄 표의 저장 안 한 행과 환율 탭의 저장 안 한 설정(등급표·대상·자동 저장)이 있으면 닫기를 멈춘다.
  window.addEventListener('beforeunload', e => {
    if (busy || [...states.values()].some(s => s.rows.some(dirty)) || window.VUFxAutoPrice?.isDirty()) { e.preventDefault(); e.returnValue = ''; }
  });
  renderImageList(); rebuildFilters(); draw();
})();
