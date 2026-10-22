(async () => {
  const { imagePolicy, parseImageUrls, sameImages, previewImageUrls } = await import('../utils/bulk_images.js');
  const { productIdentity, identityText } = await import('../utils/product_identity.js');
  const ipc = require('electron').ipcRenderer, root = document.getElementById('bulk-edit-workspace');
  const scopes = [
    ['naver', '네이버', 'KRW', 'logos/naver.png'], ['coupang', '쿠팡', 'KRW', 'logos/coupang.png'], ['imweb-b2b', '아임웹 B2B', 'KRW', 'logos/b2b.png'],
    ['imweb-en', '아임웹 영문', 'USD', 'logos/imweb.png'], ['imweb-ko', '아임웹 본사', 'KRW', 'logos/imweb.png'], ['imweb-jp', '아임웹 일본', 'JPY', 'logos/imweb.png'],
    ['amazon-us', '아마존 미국', 'USD', 'logos/amazon.png'], ['amazon-jp', '아마존 일본', 'JPY', 'logos/amazon.png'], ['ebay', 'eBay', 'USD', 'logos/ebay.png']
  ];
  const states = new Map();
  let scope = 'naver', busy = false, cancel = false, page = 0, query = '', lastTab = 'naverTab';
  const size = 25, filters = new Map();
  const $ = id => document.getElementById(id);
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const key = r => r.id + ':' + (r.optionId || '');
  const state = () => { if (!states.has(scope)) states.set(scope, { rows: [], note: '', filters: {}, query: '', imageInput: '' }); return states.get(scope); };
  const rows = () => state().rows;
  const priceDirty = r => !r.priceReadonly && r.ready && r.newPrice !== '' && Number(r.newPrice) !== Number(r.price === '' ? NaN : r.price);
  const imageDirty = r => r.imagesReady && Array.isArray(r.newImages) && !sameImages(r.newImages, r.images);
  const dirty = r => priceDirty(r) || imageDirty(r);
  function priceKey(r) {
    const value = r.price;
    return value == null || String(value).trim() === '' || !Number.isFinite(Number(value)) ? 'unknown' : String(Number(value));
  }
  const filterValue = (r, key) => key === 'price' ? priceKey(r) : r.tax[key];
  const view = () => rows().filter(r => [...filters].every(([k, select]) => !select.value || filterValue(r, k) === select.value) &&
    query.toLowerCase().split(/\s+/).filter(Boolean).every(w => [r.name, r.id, r.variant, identOf(r).search, ...Object.values(r.tax)].join(' ').toLowerCase().includes(w)));
  const selected = () => view().filter(r => r.selected && !r.readonly);
  const pageRows = () => view().slice(page * size, (page + 1) * size);
  const tell = text => { $('be-status').textContent = text; };
  // 선택·저장은 필터 전체 기준이라, 지금 페이지 밖에 선택된 행이 있으면 개수에 따로 드러낸다.
  function showCount() {
    const picked = selected(), visible = new Set(pageRows());
    const off = picked.filter(r => !visible.has(r)).length;
    $('be-count').textContent = view().length + '행 / 전체 ' + rows().length + '행 · 선택 ' + picked.length + '행' +
      (off ? ' (다른 페이지 ' + off + '행 포함)' : '') + ' · 저장할 변경 ' + picked.filter(dirty).length + '행';
  }
  // 머리글 체크박스는 모든 페이지의 필터 결과를 대상으로 한다.
  function syncHeader() {
    const active = view().filter(r => !r.readonly), on = active.filter(r => r.selected).length;
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
  const platformId = r => {
    if (/^(?:amazon-|ebay$)/.test(r.scope || scope)) return '';   // 아마존·eBay 는 ID 가 곧 SKU
    return scopes.find(s => s[0] === scope)[1] + ' ID ' + r.id + (r.optionId ? ' · 옵션 ' + r.optionId : '');
  };
  root.innerHTML = '<div class="be-head"><h2>상품 일괄 수정</h2><span>플랫폼별 판매가 · 이미지 관리</span></div>' +
    '<div id="be-platforms" class="be-platforms" role="tablist" aria-label="쇼핑몰 플랫폼"></div>' +
    '<div class="be-tools"><input id="be-api-query" placeholder="상품명·SKU 검색 · 빈칸이면 전체 목록" aria-label="목록 검색어">' +
    '<button id="be-list" type="button">상품 목록 조회</button><button id="be-sync" type="button" hidden>전체 목록 동기화</button></div>' +
    '<div class="be-filters" id="be-filters"></div>' +
    '<p class="be-help">상품을 선택하고 현재가·이미지를 불러오세요. 이미지 칸에 ESM URL 또는 HTML 입력 후 이미지 불러오기 → 선택 변경 저장 순서로 반영합니다. 상세 이미지 또는 상품 이미지 목록 전체를 입력 순서대로 교체합니다. 쿠팡 이미지는 상품 전체 옵션에 적용됩니다.</p>' +
    '<div class="be-actions">' +
    // 선택·해제는 표 머리의 전체선택 체크 하나로 한다. 판매가 입력칸은 그 값이 들어갈 '판매가 덮어쓰기' 열 머리에 둔다.
    '<div class="be-group" role="group" aria-label="선택"><button id="be-load" type="button">선택 상품 현재가·이미지 불러오기</button></div>' +
    '<div class="be-group" role="group" aria-label="이미지 입력"><span class="be-group-label">이미지</span><input id="be-image-value" type="text" placeholder="ESM URL 또는 &lt;img&gt; HTML" title="빈칸이면 이미지 설정의 ESM 상세 목록을 불러옵니다" aria-label="선택 상품에 적용할 이미지 URL 목록">' +
    '<button id="be-image-apply" type="button">이미지 불러오기</button></div>' +
    '<div class="be-group be-group-end"><button id="be-stop" type="button" hidden>중단</button><button id="be-export" type="button">결과 CSV</button><button id="be-save" type="button" class="be-primary">선택 변경 저장</button></div></div>' +
    '<div class="be-state"><div id="be-status" role="status" aria-live="polite"></div><p class="be-help" id="be-count"></p></div>' +
    '<div class="be-scroll"><table class="be-table"><thead><tr><th class="be-check-column"><label class="be-th-check-label"><input type="checkbox" id="be-th-select-all" aria-label="필터 결과 모든 페이지 전체선택" title="필터에 맞는 모든 페이지의 행을 선택합니다 · 다시 누르면 선택을 모두 해제합니다"> 전체선택</label></th><th class="be-photo-column"><span id="be-photo-label">사진</span><small id="be-image-hint"></small></th><th>상품명 / 옵션</th><th>상품번호 / SKU</th><th>브랜드 / 차종</th><th id="be-price-label">기존 판매가</th><th>판매가 덮어쓰기' +
    '<div class="be-th-tools" role="group" aria-label="판매가 입력"><input id="be-value" type="number" min="0" placeholder="덮어쓸 판매가" aria-label="선택 행에 넣을 판매가">' +
    '<span id="be-currency" class="be-unit"></span><button id="be-apply" type="button">가격 입력</button>' +
    '<button id="be-fx-apply" type="button" title="국내 기준가 등급 ÷ 오늘 환율(우대 없음)에서 앞 두 자리만 남겨 선택 행의 판매가를 채웁니다. 아마존·eBay 전용">환율가 입력</button></div></th><th>처리 결과</th></tr></thead><tbody id="be-body"></tbody></table></div>' +
    '<div class="be-pager"><button id="be-prev" type="button">이전</button><span id="be-page"></span><button id="be-next" type="button">다음</button></div>';
  window.VUFxAutoPrice?.mount(root, ipc);   // 일일 환율 자동 변경 패널(fx-auto-price.js)
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
  for (const [id, title, , logo] of scopes) {
    const b = el('button', 'be-platform-btn'); b.type = 'button'; b.dataset.scope = id; b.setAttribute('role', 'tab');
    b.innerHTML = `<img src="${logo}" class="be-platform-logo${id === 'ebay' ? ' be-platform-logo-wide' : ''}" alt="" width="18" height="18"><span>${title}</span>`;
    b.addEventListener('click', () => {
      if (busy) return;
      state().query = query;
      state().filters = Object.fromEntries([...filters].map(([k, s]) => [k, s.value]));
      scope = id; page = 0; query = state().query; $('be-search').value = query;
      $('be-image-value').value = state().imageInput;
      rebuildFilters(); draw(); tell(state().note);
    });
    $('be-platforms').append(b);
  }
  for (const [k, label] of [['brand', '브랜드'], ['vehicle', '차량·제조사'], ['model', '차종'], ['kind', '상품 종류'], ['price', '가격']]) {
    const field = el('label', '', label), s = el('select'); s.setAttribute('aria-label', label + ' 필터');
    s.addEventListener('change', () => { state().filters[k] = s.value; page = 0; draw(); });
    field.append(s); $('be-filters').append(field); filters.set(k, s);
  }
  const searchLabel = el('label', '', '표 안에서 검색'), search = el('input');
  search.id = 'be-search'; search.type = 'search'; search.placeholder = '상품명·번호·옵션'; searchLabel.append(search);
  $('be-filters').append(searchLabel);
  search.addEventListener('input', () => { query = search.value.trim(); page = 0; draw(); });
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
    const filtered = view(), unit = scopes.find(s => s[0] === scope)[2];
    const policy = imagePolicy(scope);
    // 아임웹 네 범위도 Open API 로 읽고 쓴다(2026-10-05) — 예전의 '카탈로그 참조 · API 연동 전' 잠금은 없앴다.
    $('be-price-label').textContent = '기존 판매가';
    for (const id of ['be-load', 'be-value', 'be-apply', 'be-save', 'be-image-value', 'be-image-apply', 'be-th-select-all']) $(id).disabled = busy;
    $('be-fx-apply').disabled = busy || !['amazon-us', 'amazon-jp', 'ebay'].includes(scope);
    root.querySelector('.be-help').textContent = defaultHelp;
    $('be-photo-label').textContent = '사진 · ' + policy.label;
    $('be-image-hint').textContent = policy.display === 'images' ? 'HTML 이미지 지원 · 순서대로 미리보기' : '이미지 미리보기 · 저장은 URL 배열';
    page = Math.max(0, Math.min(page, Math.max(0, Math.ceil(filtered.length / size) - 1)));
    $('be-currency').textContent = unit;
    $('be-value').step = unit === 'USD' ? '.01' : '1';
    showCount();
    $('be-page').textContent = (page + 1) + ' / ' + Math.max(1, Math.ceil(filtered.length / size));
    $('be-prev').disabled = busy || page === 0; $('be-next').disabled = busy || (page + 1) * size >= filtered.length;
    document.querySelectorAll('#be-platforms button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.scope === scope)));
    syncHeader();
    const body = $('be-body'); body.replaceChildren();
    for (const r of pageRows()) {
      const tr = el('tr'); tr.classList.toggle('be-dirty', dirty(r));
      const selectCell = el('td', 'be-check-column'), check = el('input'); check.type = 'checkbox'; check.checked = !!r.selected;
      check.setAttribute('aria-label', '선택: ' + r.name); check.disabled = busy || r.readonly;
      check.addEventListener('change', () => { r.selected = check.checked; draw(); }); selectCell.append(check); tr.append(selectCell);
      const photo = el('td', 'be-photo-column');
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
          const remove = el('button', 'vu-image-remove', '×'); remove.type = 'button';
          remove.setAttribute('aria-label', r.name + ' 이미지 ' + (index + 1) + ' 삭제');
          remove.disabled = busy || r.readonly || !r.imagesReady;
          remove.title = r.imagesReady ? '이미지 삭제' : '전체 이미지 목록을 먼저 불러오세요';
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
          item.append(open, remove, label); gallery.append(item);
        });
        photo.append(gallery);
      }
      if (policy.display === 'urls') {
        const links = el('div', 'be-photo-urls');
        images.forEach((url, index) => {
          if (index) links.append(document.createTextNode('|'));
          if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return;
          const link = el('a', '', url); link.href = url; link.title = '전체 이미지 보기';
          link.onclick = event => { event.preventDefault(); viewImage(url, r.name + ' 이미지 ' + (index + 1)); }; links.append(link);
        });
        if (!images.length) links.textContent = '—'; photo.append(links);
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
      if (imageDirty(r)) photo.append(el('small', 'be-image-pending', '이미지 변경 대기'));
      tr.append(photo);
      const title = el('td', 'be-title', r.name); if (r.variant) title.append(el('small', '', r.variant)); tr.append(title);
      // 상품번호 / SKU: 첫 줄은 표준 상품번호, 그 아래 SKU, 맨 아래 작게 그 몰의 상품 ID(저장에 쓰는 값).
      const id = el('td', 'be-identity'), ident = identOf(r);
      id.append(el('span', ident.main ? 'be-no' : 'be-no be-missing', ident.main || '번호 미확인'));
      if (ident.count > 1) id.title = ident.all;
      if (ident.skus) id.append(el('small', 'be-sku', 'SKU ' + ident.skus));
      const own = platformId(r); if (own) id.append(el('small', 'be-own-id', own));
      tr.append(id);
      const taxonomy = el('td', '', r.tax.brand); taxonomy.append(el('small', '', r.tax.vehicle + ' / ' + r.tax.model)); tr.append(taxonomy);
      tr.append(el('td', 'be-price', r.ready ? (r.price === '' ? '미등록' : Number(r.price).toLocaleString('ko-KR') + ' ' + unit) : (r.price !== '' ? (Number.isFinite(Number(r.price)) ? Number(r.price).toLocaleString('ko-KR') + ' ' + unit : r.price) + ' (목록)' : '조회 필요')));
      const priceCell = el('td'), input = el('input'); input.type = 'number'; input.step = unit === 'USD' ? '.01' : '1'; input.min = unit === 'USD' ? '.01' : '1';
      input.value = r.newPrice; input.disabled = busy || !r.ready || r.readonly || r.priceReadonly;
      input.setAttribute('aria-label', '판매가: ' + r.name + (r.variant ? ' / ' + r.variant : ''));
      input.addEventListener('input', () => {
        r.newPrice = input.value; r.selected = true; check.checked = true; tr.classList.toggle('be-dirty', dirty(r));
        tooltip(input, input.value, unit);
        showCount(); syncHeader();
      });
      input.addEventListener('mouseover', () => tooltip(input, input.value, unit)); priceCell.append(input); tr.append(priceCell);
      const resultCell = el('td', 'be-result', r.result || (r.priceReadonly ? '이미지만 수정 가능' : r.readonly ? '판매가 없음' : r.ready ? '가격 입력 가능' : '현재가 조회 전'));
      if (r.imageResult) resultCell.append(el('small', '', r.imageResult)); tr.append(resultCell);
      body.append(tr);
    }
    if (!filtered.length) {
      const td = el('td', '', rows().length ? '필터에 맞는 상품이 없습니다.' : '플랫폼을 선택하고 상품 목록을 조회하세요.');
      td.colSpan = 8; const tr = el('tr'); tr.append(td); body.append(tr);
    }
  }
  function lock(value) {
    busy = value;
    // 환율 자동 변경 패널은 자기 상태로 잠근다(실행은 메인 프로세스에서 따로 돈다).
    root.querySelectorAll('button, input, select').forEach(n => { if (!n.closest('.fx-panel')) n.disabled = value; });
    $('be-stop').hidden = !value; $('be-stop').disabled = false;
    draw();
  }
  async function run(work) {
    if (busy) return;
    lock(true); cancel = false;
    try { await work(); } catch (e) { tell(e.message); } finally { rebuildFilters(); lock(false); }
  }
  $('be-list').addEventListener('click', () => run(async () => {
    if (rows().some(dirty)) { tell('입력한 변경이 있습니다. 저장하거나 가격을 원래 값으로 되돌린 뒤 목록을 갱신하세요.'); return; }
    tell('상품 목록을 불러오는 중…');
    const result = await call('bulk-price-list', { scope, query: $('be-api-query').value.trim() });
    state().rows = result.items.map(augment); state().note = result.note || '';
    state().filters = {}; query = ''; search.value = ''; page = 0;
    rebuildFilters(); tell(result.note || result.items.length + '개 상품을 불러왔습니다.');
  }));
  $('be-sync').addEventListener('click', () => run(async () => {
    tell('전체 목록 동기화 중… 완료까지 수 분 걸릴 수 있습니다.');
    const r = await ipc.invoke(scope === 'ebay' ? 'ebay-refresh-cache' : 'amazon-refresh-cache', { enrichBrand: false, marketplaceId: scope === 'amazon-jp' ? 'A1VC38T7YXB528' : 'ATVPDKIKX0DER' });
    if (!r.success) throw new Error(r.error);
    tell('목록 동기화 완료. 상품 목록 조회를 눌러 갱신하세요.');
  }));
  // 머리글 전체선택: 체크하면 필터 결과의 모든 페이지를 고르고, 풀면 (예전 '선택 해제' 버튼처럼) 선택을 모두 지운다.
  const toggleAllSelection = checked => {
    const targets = checked ? view().filter(r => !r.readonly) : rows();
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
  // 현재가는 몰이 한 요청에 허용하는 만큼 묶어 읽는다(메인 bulk-price-load-many: 네이버 목록 조회 100건, 아마존 20건×2).
  // 묶음 조회가 없는 쿠팡·eBay 는 메인이 상품마다 읽으므로, 진행 표시와 중단이 늦지 않게 작게 나눠 보낸다.
  const LOAD_CHUNK = { naver: 100, 'amazon-us': 40, 'amazon-jp': 40, ebay: 8, coupang: 4 };
  $('be-load').addEventListener('click', () => run(async () => {
    const work = selected(), products = [...new Map(work.map(r => [r.id, r])).values()];
    if (!products.length) { tell('현재가를 불러올 상품을 선택하세요.'); return; }
    let ok = 0, failed = 0, firstError = '', blocked = '', noImages = 0;
    const fail = (r, e) => {
      failed++; firstError = firstError || e.message;
      rows().filter(x => x.id === r.id).forEach(x => { x.result = e.message; x.ready = false; });
    };
    const chunk = LOAD_CHUNK[scope] || 1;
    for (let i = 0; i < products.length && !cancel && !blocked; i += chunk) {
      const part = products.slice(i, i + chunk);
      tell('현재가 조회 ' + (i + part.length) + '/' + products.length);
      let got;
      try {
        got = await call('bulk-price-load-many', { scope, ids: part.map(r => r.id), includeImages: true,
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
        const at = rows().findIndex(x => x.id === r.id);
        const other = rows().filter(x => x.id !== r.id);
        // 옵션 줄이 이미 있었으면 그 선택을 이어 쓴다. 상품 한 줄을 처음 펼칠 때만 전부 고른다 — 예전에는 옵션 하나만
        // 골라도 불러온 뒤 모든 옵션이 선택돼, 이어서 '가격 입력' 을 누르면 옵션가가 한 값으로 납작해졌다.
        const before = rows().filter(x => x.id === r.id);
        const picked = before.some(x => x.optionId) ? new Map(before.map(x => [x.optionId || '', x.selected])) : null;
        other.splice(at, 0, ...item.rows.map(x => ({ ...augment(x), selected: !x.readonly && (!picked || !!picked.get(x.optionId || '')) })));
        state().rows = other;
        if (!item.rows[0]?.imagesReady) noImages++;
        ok++;
      }
      if (got.blocked) blocked = got.blocked;
      draw();
    }
    rebuildFilters();
    const counts = '성공 ' + ok + ' · 실패 ' + failed + (ok + failed < products.length ? ' · 남음 ' + (products.length - ok - failed) : '');
    // 네이버 묶음 조회에는 상세 이미지가 없다. 이미지 불러오기를 누르면 그 상품만 조회한다.
    const imageNote = noImages ? ' 이미지 목록은 이미지 불러오기 때 상품별로 조회합니다(' + noImages + '개).' : '';
    tell(blocked ? '현재가 조회를 멈췄습니다 (' + counts + '). 나머지 상품도 같은 이유로 실패할 오류입니다: ' + blocked
      : cancel ? '현재가 조회를 중단했습니다 (' + counts + ').'
        : failed ? '현재가 조회 끝 (' + counts + '). 실패한 행은 처리 결과 칸을 확인하세요. 첫 오류: ' + firstError + imageNote
          : '현재가 조회 완료. 판매가 입력 후 저장하세요.' + imageNote);
  }));
  $('be-apply').addEventListener('click', () => {
    const value = $('be-value').value, ready = selected().filter(r => r.ready && !r.priceReadonly);
    if (!value || Number(value) <= 0) { tell('덮어쓸 판매가를 입력하세요.'); return; }
    if (!ready.length) { tell('선택 상품의 현재가를 먼저 불러오세요.'); return; }
    ready.forEach(r => { r.newPrice = value; });
    const visible = new Set(pageRows()), off = ready.filter(r => !visible.has(r)).length;
    tell(ready.length + '행에 가격을 입력했습니다' + (off ? ' (다른 페이지 ' + off + '행 포함)' : '') + '. 선택 변경 저장을 누르면 반영됩니다.'); draw();
  });
  // 국내 기준가 등급 ÷ 오늘 환율(우대 없음)을 앞 두 자리만 남겨 판매가를 채운다. 판단은 환율 자동 변경과 같다(fx_auto_price.js).
  // 자동 저장이 건너뛰는 10% 초과 변동도 채운다 — 사람이 보고 '선택 변경 저장'으로 반영한다.
  // 환율 변동 1% 미만(두 자리 가격 경계에서 오가지 않게)·이미 같은 가격은 지금 판매가를 그대로 둔다.
  $('be-fx-apply').addEventListener('click', () => run(async () => {
    const ready = selected().filter(r => r.ready && !r.priceReadonly);
    if (!ready.length) { tell('선택 상품의 현재가를 먼저 불러오세요.'); return; }
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
    tell(filled + '행에 환율가를 입력했습니다' + (large ? ' (10% 넘게 바뀌는 ' + large + '행 포함 — 확인 후 저장)' : '') + (kept ? ' · 그대로 ' + kept + '행' : '') +
      (missing ? ' · 등급·현재가 없음 ' + missing + '행' : '') +
      ' · 1 USD = ' + Number(plan.rate.KRW.toFixed(2)).toLocaleString('ko-KR') + '원 (' + plan.rate.marketDate + ' 기준). 선택 변경 저장을 누르면 반영됩니다.');
  }));
  $('be-image-value').addEventListener('input', e => { state().imageInput = e.target.value; });
  $('be-image-apply').addEventListener('click', () => run(async () => {
    const picked = selected();
    if (!picked.length) { tell('이미지를 적용할 상품을 선택하세요.'); return; }
    let input = $('be-image-value').value.trim();
    if (!input) {
      tell('ESM 상세 이미지 목록을 불러오는 중…');
      const library = await ipc.invoke('image-library-load');
      if (!library?.success) throw new Error(library?.error || '이미지 설정을 불러오지 못했습니다.');
      const profileId = scope.startsWith('amazon-') ? 'amazon' : scope === 'ebay' ? 'ebay' : 'domestic';
      const profile = library.profiles?.find(p => p.id === profileId);
      const hosted = profile?.items?.filter(item => item.selected && item.role === '상세' && item.source === 'esm').map(item => item.url || item.path) || [];
      if (!hosted.length) throw new Error('저장된 ESM 상세 이미지가 없습니다. ESM URL 또는 <img> HTML을 입력하세요.');
      input = hosted.join('|');
    }
    tell('ESM 호스팅 이미지 확인 중…');
    const checked = await call('bulk-images-import', { scope, input });
    // 교체를 걸기 전에 상품마다 지금 이미지(revision)를 읽는다. 상품 하나가 실패해도 나머지는 그대로 두고,
    // 중단을 누르면 다음 상품부터 멈춘다. 지금 이미지를 모르는 상품에는 교체를 걸지 않는다.
    const ids = new Set(picked.map(r => r.id)), snapshots = new Map(), failed = new Map(), ready = new Set();
    for (const id of ids) {
      if (cancel) break;
      if (rows().filter(r => r.id === id).every(r => r.imagesReady)) { ready.add(id); continue; }
      tell('기존 이미지 확인 중… (' + (ready.size + failed.size + 1) + '/' + ids.size + ')');
      try { snapshots.set(id, await call('bulk-images-load', { scope, id })); ready.add(id); }
      catch (e) { failed.set(id, e.message); if (e.blocking) break; }
    }
    rows().filter(r => ids.has(r.id)).forEach(r => {
      if (!ready.has(r.id)) { if (failed.has(r.id)) r.imageResult = '기존 이미지 확인 실패 — 교체 안 함: ' + failed.get(r.id); return; }
      const snapshot = snapshots.get(r.id);
      if (snapshot) Object.assign(r, { images: snapshot.images, imageRevision: snapshot.revision, imagesReady: true });
      r.newImages = [...checked.images]; r.imageResult = '이미지 변경 대기';
    });
    state().imageInput = checked.images.join('|'); $('be-image-value').value = state().imageInput;
    const skipped = ids.size - ready.size - failed.size;
    tell(ready.size + '개 상품의 이미지 ' + checked.images.length + '장 불러오기 완료 · ESM ' + checked.verified + '장 확인' +
      (failed.size ? ' · 기존 이미지 확인 실패 ' + failed.size + '개(교체 안 함, 처리 결과 칸 확인)' : '') +
      (skipped ? ' · 중단으로 ' + skipped + '개 건너뜀' : '') + '. 선택 변경 저장을 누르면 반영됩니다.');
  }));
  // 보이지 않는 행이 섞였거나 기존가 대비 크게 바뀌는 행(오타 의심)이 있으면 보내기 전에 한 번 묻는다.
  const BIG_CHANGE = 0.3;
  function confirmSave(work) {
    if (!work.length) return true;
    const visible = new Set(pageRows()), unit = scopes.find(s => s[0] === scope)[2];
    const off = work.filter(x => !visible.has(x.r)).length;
    // 기존가가 0 인 행(아임웹 추가금 방식 옵션 등)은 몇 %인지 셀 수 없어 큰 변화로 본다 — 예전엔 0% 로 세어 묻지 않았다.
    const changes = work.map(x => ({ x, rate: Number(x.expectedPrice) > 0 ? Number(x.newPrice) / Number(x.expectedPrice) - 1 : Infinity }));
    const big = changes.filter(c => Math.abs(c.rate) >= BIG_CHANGE);
    if (!off && !big.length) return true;
    const pct = rate => Number.isFinite(rate) ? (rate > 0 ? '+' : '') + Math.round(rate * 100) + '%' : '기존 0에서';
    const money = v => Number(v).toLocaleString('ko-KR') + ' ' + unit;
    const rates = changes.map(c => c.rate).filter(Number.isFinite), worst = big.sort((a, b) => Math.abs(b.rate) - Math.abs(a.rate))[0];
    const lines = ['선택 변경 ' + work.length + '행을 저장합니다.'];
    if (off) lines.push('· 지금 보이는 페이지 밖의 행: ' + off + '행');
    if (big.length) lines.push('· 기존가 대비 ' + Math.round(BIG_CHANGE * 100) + '% 이상 바뀌는 행: ' + big.length + '행 (가장 큰 변화: ' +
      worst.x.r.name + (worst.x.r.variant ? ' / ' + worst.x.r.variant : '') + ' ' + money(worst.x.expectedPrice) + ' → ' + money(worst.x.newPrice) + ', ' + pct(worst.rate) + ')');
    if (rates.length) lines.push('· 변화 범위: ' + pct(Math.min(...rates)) + ' ~ ' + pct(Math.max(...rates)));
    lines.push('', '계속할까요?');
    return window.confirm(lines.join('\n'));
  }
  $('be-save').addEventListener('click', () => run(async () => {
    const priceWork = selected().filter(priceDirty).map(r => ({ r, type: 'price', newPrice: r.newPrice, expectedPrice: r.price }));
    const imageWork = [...new Map(selected().filter(imageDirty).map(r => [r.id, { r, type: 'images', urls: [...r.newImages], expectedRevision: r.imageRevision }])).values()];
    const work = [...imageWork, ...priceWork];
    if (!work.length) { tell('선택 행에 변경된 판매가 또는 이미지가 없습니다.'); return; }
    const unit = scopes.find(s => s[0] === scope)[2], format = unit === 'USD' ? /^\d+(\.\d{1,2})?$/ : /^\d+$/;
    const invalid = priceWork.find(x => !format.test(x.newPrice) || Number(x.newPrice) <= 0 || Number(x.newPrice) > Number.MAX_SAFE_INTEGER);
    if (invalid) throw new Error(unit + ' 판매가 형식을 확인하세요 (' + invalid.r.name + ': ' + invalid.newPrice + '). 요청을 전송하지 않았습니다.');
    const notTen = scope === 'coupang' && priceWork.find(x => Number(x.newPrice) % 10 !== 0);
    if (notTen) throw new Error('쿠팡 판매가는 10원 단위로만 바꿀 수 있습니다 (' + notTen.r.name + ': ' + notTen.newPrice + '). 요청을 전송하지 않았습니다.');
    if (!confirmSave(priceWork)) { tell('저장을 취소했습니다. 요청을 전송하지 않았습니다.'); return; }
    for (const job of imageWork) parseImageUrls(job.urls, scope);
    const count = { verified: 0, unchanged: 0, accepted: 0, check: 0, notSent: 0, rejected: 0, unknown: 0 };
    const received = new Set();
    const apply = item => {
      if (received.has(item.index) || !work[item.index]) return;
      received.add(item.index);
      const job = work[item.index], r = job.r, imageJob = job.type === 'images';
      const targets = imageJob ? rows().filter(x => x.id === r.id) : [r];
      const report = text => targets.forEach(x => { x[imageJob ? 'imageResult' : 'result'] = text; });
      if (item.success) {
        const result = item.data;
        if (result.status === 'VERIFIED') { report('저장·재조회 완료'); count.verified++; }
        else if (result.status === 'UNCHANGED') { report('변경 없음'); count.unchanged++; }
        else if (result.status === 'ACCEPTED') { report(result.message || '변경 접수 완료'); count.accepted++; }
        else { report('확인 필요: ' + (result.message || '반영 확인 필요')); count.check++; }
        if (['VERIFIED', 'UNCHANGED'].includes(result.status)) {
          if (imageJob) targets.forEach(x => { x.images = result.images; x.imageRevision = result.revision; x.newImages = null; });
          else { r.price = result.price; r.newPrice = String(result.price); }
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
    batchProgress = payload => {
      if (payload.result) apply(payload.result);
      tell(payload.preparing ? '변경 목록 검사 ' + payload.index + '/' + work.length : '일괄 저장 ' + received.size + '/' + work.length);
      if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; draw(); }); }
    };
    try {
      const outcome = await call('bulk-save-batch', { jobId: batchJobId, scope, jobs: work.map(job => ({
        type: job.type, id: job.r.id, optionId: job.r.optionId,
        ...(job.type === 'images' ? { urls: job.urls, expectedRevision: job.expectedRevision }
          : { newPrice: job.newPrice, expectedPrice: job.expectedPrice }),
      })) });
      outcome.results.forEach(apply);
      const parts = [['저장 확인', count.verified], ['변경 없음', count.unchanged], ['접수', count.accepted], ['확인 필요', count.check],
        ['전송 안 됨', count.notSent], ['거부', count.rejected], ['결과 불명', count.unknown]].filter(([, n]) => n).map(([l, n]) => l + ' ' + n);
      tell((outcome.stopped ? '저장을 멈췄습니다 · ' : outcome.cancelled ? '중단 · ' : '완료 · ') + (parts.join(' · ') || '처리 없음') +
        (received.size < work.length ? ' · 남음 ' + (work.length - received.size) : '') + '. ' +
        (outcome.stopped || (count.check + count.unknown + count.accepted ? '접수·결과 불명 행은 다시 보내기 전에 현재가·이미지를 확인하세요.' : '')));
    } catch (error) {
      if (error.stage !== 'pre-send') for (const [index] of work.entries())
        if (!received.has(index)) apply({ index, success: false, stage: 'unknown', error: error.message });
      throw error;
    } finally { batchProgress = null; batchJobId = ''; }
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
      ...rows().map(r => [scope, r.id, r.optionId, r.name, r.variant, r.price, r.newPrice, r.currency, r.result, (r.images || []).join('|'), (r.newImages || []).join('|'), r.imageResult, identOf(r).skus || r.sku, identOf(r).all])]
      .map(line => line.map(cell).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' }));
    const a = el('a'); a.href = url; a.download = 'bulk-price-' + scope + '-' + new Date().toISOString().slice(0, 10) + '.csv'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  ipc.on('amazon-cache-progress', (_, progress) => {
    if (busy && scope.startsWith('amazon-')) tell('아마존 목록 동기화 · ' + (progress.message || progress.stage || '') +
      (progress.loaded != null ? ' ' + progress.loaded + '/' + (progress.total || '?') : ''));
  });
  ipc.on('ebay-cache-progress', (_, progress) => {
    if (busy && scope === 'ebay') tell('eBay 목록 동기화 · ' + (progress.loaded || 0) + '/' + (progress.total || '?'));
  });
  const nav = $('mode-bar');
  for (const [value, label] of [['bulk', '상품 일괄 수정'], ['api', 'API KEY']]) {
    const b = el('button', 'mode-label', label); b.type = 'button'; b.dataset.workspace = value;
    b.addEventListener('click', () => show(value)); nav.append(b);
  }
  let requestedApiPlatform = null;
  const keyPlatform = id => ({
    naverTab: 'naver', coupangTab: 'coupang', amazonTab: 'amazon', ebayTab: 'ebay',
    imwebTab: 'imweb', imwebBoardTab: 'imweb',
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
    nav.querySelectorAll('[data-workspace]').forEach(b => b.classList.toggle('is-active', b.dataset.workspace === viewName));
    if (viewName === 'api') {
      frame.contentDocument?.documentElement.classList.add('api-key-view');
      if (!frame.src || !frame.src.includes('index.html')) frame.src = 'index.html?mode=' + currentMode;
      openDetailSidebar(); apiView();
    } else {
      apiLoading.hidden = true;
      frame.contentDocument?.documentElement.classList.remove('api-key-view');
      if (!viewName) {
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
  window.addEventListener('beforeunload', e => { if (busy || [...states.values()].some(s => s.rows.some(dirty))) { e.preventDefault(); e.returnValue = ''; } });
  rebuildFilters(); draw();
})();
