(() => {
  const profiles = new Map(), bundles = new Map();
  let ipc, root, selected = 'domestic', busy = false, dragging = 0, afterChange = () => {};
  const $ = id => root.querySelector(`#${id}`);
  const node = (tag, text, cls) => { const el = document.createElement(tag); if (text) el.textContent = text; if (cls) el.className = cls; return el; };
  const status = text => { $('vu-image-status').textContent = text; };
  async function request(channel, data) {
    const r = await ipc.invoke(channel, data);
    if (!r?.success) throw new Error(r?.error || '이미지 목록을 읽지 못했습니다.');
    return r;
  }
  function draw() {
    const p = profiles.get(selected); if (!p) return;
    $('vu-image-folder').textContent = p.detailSource === 'esm' ? 'ESM 상세 이미지 · HTML 기본 목록' : p.folder;
    $('vu-image-seed').hidden = selected === 'domestic';
    const list = $('vu-image-list'); list.replaceChildren();
    p.items.forEach((item, i) => {
      const row = node('div', '', 'vu-image-row'), label = node('label');
      const check = node('input'); check.type = 'checkbox'; check.checked = item.selected; check.disabled = busy || i === 0;
      check.setAttribute('aria-label', `${item.name} 포함`);
      check.addEventListener('change', () => change({ excluded: p.items.filter(v => v.role !== '대표' && (v.path === item.path ? !check.checked : !v.selected)).map(v => v.path) }));
      const img = node('img'); img.alt = `${item.role} ${item.name}`; img.draggable = false; if (item.previewUrl) img.src = item.previewUrl;
      const text = node('span', `${item.role} · ${item.name}`);
      text.append(node('small', item.error || (item.source === 'esm' ? 'ESM 이미지' : item.url ? '호스팅 저장됨' : (i === 0 && p.seed ? 'VerySeed GLOBAL 최신 사진' : '적용 시 주소 확인'))));
      if (i === 0 && item.modified) text.append(node('small', new Date(item.modified).toLocaleString('ko-KR')));
      label.append(check, img, text); row.append(label);
      // 상세 줄은 끌어다 놓아 순서를 바꾼다(대표는 늘 첫 줄이라 끌 수도, 그 위에 놓을 수도 없다).
      if (i > 0) {
        row.draggable = !busy; row.title = '끌어서 순서 바꾸기';
        row.addEventListener('dragstart', e => { dragging = i; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('application/x-vu-row', String(i)); });
        row.addEventListener('dragend', () => { dragging = 0; });
        row.addEventListener('dragover', e => { if (dragging) e.preventDefault(); });
        row.addEventListener('drop', e => {
          if (!dragging) return;
          e.preventDefault(); e.stopPropagation();
          const from = dragging; dragging = 0;
          if (from === i || busy) return;
          const order = p.items.slice(1).map(v => v.path);
          order.splice(i - 1, 0, ...order.splice(from - 1, 1));
          change({ order });
        });
      }
      list.append(row);
    });
    if (p.errors.length) status(p.errors.join(' '));
    else status(`${p.items.filter(i => i.selected).length}장 선택 · 대표 이미지가 항상 첫 번째입니다.`);
    root.querySelectorAll('button, select, textarea').forEach(el => el.disabled = busy);
  }
  async function run(fn) {
    if (busy) return;
    busy = true; draw();
    try { await fn(); return true; } catch (e) { status(e.message); return false; }
    finally { busy = false; root.querySelectorAll('button, select, input, textarea').forEach(el => el.disabled = false); const first = root.querySelector('input[type=checkbox]'); if (first) first.disabled = true; }
  }
  async function change(changes) {
    return run(async () => {
      bundles.delete(selected);
      const r = await request('image-library-configure', { id: selected, changes });
      profiles.set(selected, r.profile); draw(); afterChange();
    });
  }
  async function refresh() {
    const r = await request('image-library-load');
    for (const p of r.profiles) {
      if (bundles.get(p.id)?.signature !== p.signature) bundles.delete(p.id);
      profiles.set(p.id, p);
    }
    draw(); afterChange();
  }
  async function prepare(id) {
    bundles.delete(id);
    const r = await request('image-library-prepare', { id });
    profiles.set(id, r.profile); bundles.set(id, r.bundle);
    draw(); afterChange(); status(`${r.profile.label} · ${r.bundle.imageUrls.length}장 적용 완료`);
    return r.bundle;
  }
  function assign(doc, id, value) {
    const el = doc.getElementById(id); if (!el) return;
    const previous = el.dataset.vuImageWant; el.dataset.vuImageWant = value;
    if (el.dataset.vuManual === '1') {
      if (previous === value && el.value.trim()) return;
      delete el.dataset.vuManual;
    }
    if (el.value !== value) { el.value = value; el.dataset.vuImageAuto = value; el.dispatchEvent(new doc.defaultView.Event('input', { bubbles: true })); }
  }
  // ESM 이미지호스팅(Edge)에서 끌어 온 데이터나 붙여 넣은 '주소복사'·'HTML 태그복사'에서 ai.esmplus.com 이미지 주소만 꺼낸다.
  // 썸네일이 <a href="#"> 안에 있으면 uri-list 는 페이지 주소라 html 의 <img src> 를 먼저 본다.
  // 남의 페이지 마크업이다 — DOMParser 문서에서 src 문자열만 읽고 노드는 옮기지 않는다(옮기면 onerror 가 require 를 쥔다).
  function esmUrls(html, text) {
    const markup = /<img\b/i.test(html) ? html : /<img\b/i.test(text) ? text : '';
    const list = markup ? [...new DOMParser().parseFromString(markup, 'text/html').querySelectorAll('img[src]')].map(img => img.getAttribute('src'))
      : String(text || '').split(/[|\r\n]+|[\s,]+(?=https?:\/\/)/);   // 한글·공백 그대로인 주소는 공백에서 자르지 않는다
    return [...new Set(list.map(src => {
      try {
        const u = new URL(String(src).trim());
        if (!/^https?:$/.test(u.protocol) || u.hostname !== 'ai.esmplus.com' || u.username || u.password || u.port) return '';
        u.protocol = 'https:'; u.search = ''; u.hash = '';   // http 는 ESM 이 https 로 보낸다. ESM 파일 이름에는 ?·# 가 없다
        // 지금 Chromium 은 경로의 '|' 를 %7C 로 바꾸지만 URL 표준(Node)은 그대로 둔다 — 남으면 일괄 수정 칸이 '|' 로 나눠 뒤쪽이 남의 이미지가 된다
        return u.href.includes('|') ? '' : u.href;
      } catch { return ''; }
    }).filter(Boolean))];
  }
  const line = u => `<p><img src="${u.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}" /></p>`;
  window.VUImages = {
    esmUrls,   // 일괄 수정 이미지 주소 칸도 같은 해석을 쓴다
    async init(options) {
      ipc = options.ipc; afterChange = options.onChange; root = document.getElementById('image-library');
      root.innerHTML = `<summary>[img] 이미지</summary>
        <select id="vu-image-profile" aria-label="이미지 쇼핑몰"><option value="domestic">국내 공통</option><option value="amazon">Amazon</option><option value="ebay">eBay</option></select>
        <div id="vu-image-folder" class="vu-image-path"></div>
        <div class="vu-image-actions"><button type="button" id="vu-image-html-open" title="ESM 상세 이미지 HTML 편집">HTML</button><button type="button" id="vu-image-defaults" title="ESM 기본 상세 이미지로 복원">기본값</button><button type="button" id="vu-image-pick-main" title="대표 이미지 선택">대표</button><button type="button" id="vu-image-seed">VerySeed 최신</button><button type="button" id="vu-image-refresh">새로고침</button><button type="button" id="vu-image-esm" title="ESM Plus — 로그인 후 이미지 호스팅(여기서 이미지를 끌어다 목록에 놓으세요)">ESM</button></div>
        <div id="vu-image-html-editor" hidden><label for="vu-image-html">ESM 상세 이미지 HTML</label><textarea id="vu-image-html" rows="5" placeholder='<img src="https://ai.esmplus.com/…">'></textarea><button type="button" id="vu-image-html-save">HTML 저장</button><button type="button" id="vu-image-html-cancel">취소</button></div>
        <div id="vu-image-list" class="vu-image-list"></div><div id="vu-image-status" class="vu-image-status" role="status"></div>
        <button type="button" id="vu-image-prepare" class="vu-image-prepare">일괄 적용</button>
        <small>기본 상세 이미지는 로컬 폴더 없이 표시됩니다. 기존 상품 수정에는 자동 적용하지 않습니다.</small>`;
      $('vu-image-profile').onchange = e => { selected = e.target.value; $('vu-image-html-editor').hidden = true; draw(); };
      // 편집기는 목록에 보이는 순서(끌어 옮긴 순서, 체크 끈 것 포함)로 연다 — 저장하면 이 줄 순서가 곧 목록 순서다.
      $('vu-image-html-open').onclick = () => { const p = profiles.get(selected);
        $('vu-image-html').value = p?.detailSource === 'esm' && !p.errors.length ? p.items.slice(1).map(i => line(i.path)).join('\n') : p?.detailHtml || '';
        $('vu-image-html-editor').hidden = false; };
      $('vu-image-html-cancel').onclick = () => { $('vu-image-html-editor').hidden = true; };
      $('vu-image-html-save').onclick = async () => { if (await change({ detailHtml: $('vu-image-html').value })) $('vu-image-html-editor').hidden = true; };
      $('vu-image-defaults').onclick = async () => { if (await change({ resetDetails: true })) $('vu-image-html-editor').hidden = true; };
      for (const [button, kind] of [['vu-image-pick-main', 'thumbnail']]) {
        $(button).onclick = () => run(async () => {
          const r = await request('image-library-pick', { id: selected, kind });
          if (r.canceled) return;
          bundles.delete(selected); profiles.set(selected, r.profile); draw(); afterChange();
        });
      }
      $('vu-image-seed').onclick = () => change({ seed: true });
      // 좌측 베리씨드 사진 미리보기를 끌어다 놓으면 대표 이미지가 된다 — '대표' 버튼과 같은 설정(index_up.html 이 경로를 싣는다).
      // ESM 이미지호스팅의 썸네일을 끌어 놓거나 목록에 주소를 붙여 넣으면 지금 목록 끝에 상세로 붙는다(대표 행에 놓아도 상세).
      // HTML 편집기가 열려 있으면 편집 중인 HTML 끝에 넣는다 — 목록에 바로 넣으면 열린 편집기의 옛 HTML 저장이 덮어쓴다.
      const add = async urls => {
        if (busy) return status('이미지 작업이 끝난 뒤 다시 넣어주세요.');
        if (!urls.length) return status('ESM 이미지(https://ai.esmplus.com/…) 주소가 아닙니다. ESM 이미지호스팅의 이미지를 끌어 놓거나 주소를 붙여 넣으세요.');
        // 체크를 꺼 둔 이미지를 다시 넣으면 다시 고른다(제외만 바꾸므로 열린 편집기의 HTML 과 부딪치지 않는다)
        const items = profiles.get(selected)?.items || [], off = items.filter(i => i.role !== '대표' && !i.selected);
        const back = off.filter(i => urls.includes(i.path)).length, again = back ? ` 체크를 꺼 둔 ${back}장은 다시 골랐습니다.` : '';
        if (!$('vu-image-html-editor').hidden) {
          const editor = $('vu-image-html'), have = esmUrls(editor.value, ''), fresh = urls.filter(u => !have.includes(u));
          editor.value = [editor.value.trim(), ...fresh.map(line)].filter(Boolean).join('\n');
          if (back && !await change({ excluded: off.filter(i => !urls.includes(i.path)).map(i => i.path) })) return;
          return status((fresh.length ? `${fresh.length}장을 HTML 편집기 끝에 넣었습니다. 'HTML 저장'을 누르면 목록에 반영됩니다.` : '이미 HTML에 있는 이미지입니다.') + again);
        }
        if (await change({ addDetails: urls })) {
          const added = (profiles.get(selected)?.items.length || 0) - items.length;
          status((added ? `ESM 이미지 ${added}장을 목록 끝에 추가했습니다. 끌어서 순서를 바꿀 수 있습니다.` : '이미 목록에 있는 이미지입니다.') + again);
        }
      };
      // 패널 안에서 시작한 드래그(편집 칸 줄 옮기기)와 편집 칸 위의 드래그는 브라우저가 처리한다 — dragover 를 막으면 편집 칸이 글자를 받지 않는다.
      let inner = false;
      root.addEventListener('dragstart', () => { inner = true; });
      root.addEventListener('dragend', () => { inner = false; });
      const offered = types => ['application/x-vu-photo', 'text/uri-list', 'text/html', 'text/plain'].some(t => types.includes(t));
      for (const type of ['dragenter', 'dragover']) root.addEventListener(type, e => { if (!busy && !inner && !e.target.closest?.('textarea') && offered(e.dataTransfer.types)) e.preventDefault(); });
      root.addEventListener('drop', e => {
        const dt = e.dataTransfer, file = dt.getData('application/x-vu-photo');
        // 다른 앱(Edge 페이지)도 이 형식을 실을 수 있다 — 이 창 미리보기에서 시작한 드래그의 경로만 받는다(UNC 경로면 Windows 가 그 호스트에 접속).
        if (file && file === window.vuPhotoDrag) { e.preventDefault(); change({ thumbnail: file, seed: false }); return; }
        if (inner) return;
        const urls = esmUrls(dt.getData('text/html'), dt.getData('text/uri-list') || dt.getData('text/plain'));
        if (!urls.length && e.target.closest?.('textarea')) return;   // ESM 주소가 아닌 글자는 편집 칸에 그대로 들어간다
        e.preventDefault();   // 편집 칸 커서 자리에 끼어 들어가 기존 <img src> 를 깨뜨리지 않게 한다
        add(urls);
      });
      root.addEventListener('paste', e => {
        if (e.target.closest?.('textarea')) return;   // HTML 편집 칸은 보통 붙여넣기
        e.preventDefault();
        add(esmUrls(e.clipboardData.getData('text/html'), e.clipboardData.getData('text/plain')));
      });
      $('vu-image-list').tabIndex = 0;   // 목록 빈자리를 눌러 포커스한 뒤 Ctrl+V
      $('vu-image-refresh').onclick = () => run(refresh);
      $('vu-image-esm').onclick = () => window.openSellerSite?.('esm');
      $('vu-image-prepare').onclick = () => run(() => prepare(selected));
      ipc.on('image-library-progress', (_, { message }) => status(message));
      await run(refresh);
    },
    async ensure(id) {
      if (busy) throw new Error('이미지 호스팅이 진행 중입니다. 완료 후 등록해주세요.');
      busy = true; draw();
      try { await refresh(); return bundles.get(id) || await prepare(id); }
      finally { busy = false; draw(); }
    },
    fill(doc, win) {
      const domestic = bundles.get('domestic'), amazon = bundles.get('amazon'), ebay = bundles.get('ebay');
      if (domestic) assign(doc, 'iwMainImageUrl', domestic.mainImageUrl);
      if (amazon) assign(doc, 'amzMainImageUrl', amazon.mainImageUrl);
      // Default detail URLs are available immediately, even before ESM prepare.
      const amazonProfile = profiles.get('amazon');
      const amazonExtras = amazon?.subImages || (amazonProfile?.detailSource === 'esm'
        ? amazonProfile.items.filter(i => i.role !== '대표' && i.selected).map(i => i.url) : null);
      if (amazonExtras) assign(doc, 'amzSubImages', amazonExtras.join('\n'));
      if (ebay && !win.ebayBusy?.()) {
        assign(doc, 'ebImages', ebay.imageUrls.join('\n'));
      }
    },
  };
})();
