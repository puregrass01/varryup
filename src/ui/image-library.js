(() => {
  const profiles = new Map(), bundles = new Map();
  let ipc, root, selected = 'domestic', busy = false, afterChange = () => {};
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
      const img = node('img'); img.alt = `${item.role} ${item.name}`; if (item.previewUrl) img.src = item.previewUrl;
      const text = node('span', `${item.role} · ${item.name}`);
      text.append(node('small', item.error || (item.source === 'esm' ? 'ESM 이미지' : item.url ? '호스팅 저장됨' : (i === 0 && p.seed ? 'VerySeed GLOBAL 최신 사진' : '적용 시 주소 확인'))));
      if (i === 0 && item.modified) text.append(node('small', new Date(item.modified).toLocaleString('ko-KR')));
      label.append(check, img, text); row.append(label);
      if (i > 1) {
        const up = node('button', '↑'); up.type = 'button'; up.title = `${item.name} 앞으로`; up.disabled = busy;
        up.onclick = () => { const order = p.items.slice(1).map(v => v.path); [order[i - 1], order[i - 2]] = [order[i - 2], order[i - 1]]; change({ order }); };
        row.append(up);
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
  window.VUImages = {
    async init(options) {
      ipc = options.ipc; afterChange = options.onChange; root = document.getElementById('image-library');
      root.innerHTML = `<summary>[img] 이미지</summary>
        <select id="vu-image-profile" aria-label="이미지 쇼핑몰"><option value="domestic">국내 공통</option><option value="amazon">Amazon</option><option value="ebay">eBay</option></select>
        <div id="vu-image-folder" class="vu-image-path"></div>
        <div class="vu-image-actions"><button type="button" id="vu-image-html-open" title="ESM 상세 이미지 HTML 편집">HTML</button><button type="button" id="vu-image-defaults" title="ESM 기본 상세 이미지로 복원">기본값</button><button type="button" id="vu-image-pick-main" title="대표 이미지 선택">대표</button><button type="button" id="vu-image-seed">VerySeed 최신</button><button type="button" id="vu-image-refresh">새로고침</button></div>
        <div id="vu-image-html-editor" hidden><label for="vu-image-html">ESM 상세 이미지 HTML</label><textarea id="vu-image-html" rows="5" placeholder='<img src="https://ai.esmplus.com/…">'></textarea><button type="button" id="vu-image-html-save">HTML 저장</button><button type="button" id="vu-image-html-cancel">취소</button></div>
        <div id="vu-image-list" class="vu-image-list"></div><div id="vu-image-status" class="vu-image-status" role="status"></div>
        <button type="button" id="vu-image-prepare" class="vu-image-prepare">일괄 적용</button>
        <small>기본 상세 이미지는 로컬 폴더 없이 표시됩니다. 기존 상품 수정에는 자동 적용하지 않습니다.</small>`;
      $('vu-image-profile').onchange = e => { selected = e.target.value; $('vu-image-html-editor').hidden = true; draw(); };
      $('vu-image-html-open').onclick = () => { $('vu-image-html').value = profiles.get(selected)?.detailHtml || ''; $('vu-image-html-editor').hidden = false; };
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
      root.addEventListener('dragover', e => { if (e.dataTransfer.types.includes('application/x-vu-photo')) e.preventDefault(); });
      root.addEventListener('drop', e => {
        const file = e.dataTransfer.getData('application/x-vu-photo');
        if (file) { e.preventDefault(); change({ thumbnail: file, seed: false }); }
      });
      $('vu-image-refresh').onclick = () => run(refresh);
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
