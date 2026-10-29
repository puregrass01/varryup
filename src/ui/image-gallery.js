// Ordered image editor shared by the individual marketplace forms.
// Removing a tile changes only the form draft. The existing save button submits it.
(() => {
  const node = (tag, cls, text) => {
    const el = document.createElement(tag); el.className = cls || '';
    if (text != null) el.textContent = text;
    return el;
  };
  const electron = () => (typeof require !== 'undefined' ? require : window.parent.require)('electron');
  const ipc = () => electron().ipcRenderer;
  // ESM 업로드(느림)가 도는 갤러리. 다시 그려져도 남아서 그동안 ×·화살표·다른 드롭을 막는다.
  const uploading = new WeakSet();
  window.VUImageGallery = {
    // 새 URL 목록을 폼의 이미지 항목으로: 원래 있던 이미지는 그 항목(원래 블록·경로)을 그대로 쓰고, 처음 보는 URL 만 make 로 만든다.
    // 붙이기만 했는데 기존 이미지까지 '새 이미지'로 다시 만들어 원래 상세 블록(링크·형식)을 잃던 것을 막는다.
    keep(entries, urls, make) {
      const pool = [...(entries || [])];
      return urls.map(url => {
        const i = pool.findIndex(x => !x?.isNew && String(x?.url ?? '') === url);
        return i >= 0 ? pool.splice(i, 1)[0] : make(url);
      });
    },
    render(container, images, { onRemove, onMove, onReplace, scope, isBusy: formBusy = () => false, onChange = () => {} } = {}) {
      const isBusy = () => uploading.has(container) || formBusy();
      // 순서 이동이 따로 없는 폼(아마존·eBay)은 목록 교체로 옮긴다. 첫 장 = 대표.
      onMove ||= onReplace && ((index, step) => {
        const list = images.map(x => String(x?.url ?? x ?? ''));
        [list[index], list[index + step]] = [list[index + step], list[index]];
        onReplace(list);
      });
      container.replaceChildren();
      const gallery = node('div', 'vu-image-gallery');
      images.forEach((entry, index) => {
        const url = String(entry?.url ?? entry ?? '');
        const tile = node('figure', 'vu-image-tile');
        const image = node('img'); image.src = url; image.alt = '이미지 ' + (index + 1); image.loading = 'lazy';
        image.onerror = () => { image.alt = '미리보기 실패'; };
        const open = node('button', 'vu-image-open'); open.type = 'button'; open.title = '전체 이미지 보기';
        open.setAttribute('aria-label', image.alt + ' 확대');
        open.append(image);
        open.onclick = () => {
          const dialog = node('dialog', 'vu-image-dialog');
          const close = node('button', '', '닫기'); close.type = 'button'; close.onclick = () => dialog.close();
          const full = node('img'); full.src = url; full.alt = image.alt;
          dialog.append(close, full); document.body.append(dialog);
          dialog.addEventListener('close', () => dialog.remove(), { once: true });
          dialog.showModal(); close.focus();
        };
        const remove = node('button', 'vu-image-remove', '×'); remove.type = 'button';
        remove.title = '이미지 삭제'; remove.setAttribute('aria-label', '이미지 ' + (index + 1) + ' 삭제');
        remove.disabled = !onRemove || formBusy();
        remove.onclick = event => {
          event.preventDefault(); event.stopPropagation();
          if (isBusy()) return wait();
          onRemove(index); onChange();
        };
        tile.append(open, remove, node('figcaption', '', String(index + 1)));
        if (onMove) {
          const moves = node('div', 'vu-image-moves');
          for (const [step, label] of [[-1, '앞으로'], [1, '뒤로']]) {
            const move = node('button', '', step < 0 ? '←' : '→'); move.type = 'button';
            move.setAttribute('aria-label', '이미지 ' + (index + 1) + ' ' + label);
            move.disabled = formBusy() || index + step < 0 || index + step >= images.length;
            move.onclick = () => { if (isBusy()) return wait(); onMove(index, step); onChange(); };
            moves.append(move);
          }
          tile.append(moves);
        }
        gallery.append(tile);
      });
      if (!images.length) gallery.append(node('p', 'vu-image-empty', '이미지가 없습니다. 저장 전에 이미지 목록을 확인하세요.'));
      container.append(gallery);
      const hint = node('p', 'vu-image-save-hint', 'X로 삭제한 목록은 이 쇼핑몰의 수정 저장 버튼을 누르면 반영됩니다.');
      hint.setAttribute('role', 'status'); container.append(hint);
      // 지금 붙어 있는 안내 줄에 쓴다 — 업로드 중에 다시 그려졌으면 새 줄에.
      // 그리는 시점이 아니라 누르는 시점에 업로드 중인지 본다 — 업로드 중에 다시 그려진 칸이 끝난 뒤에도 잠겨 있지 않게.
      const wait = () => uploading.has(container) && say('ESM 업로드가 끝난 뒤 다시 눌러주세요.');
      const say = text => { const live = container.querySelector('.vu-image-save-hint'); if (live) live.textContent = text; };
      if (onReplace && scope) {
        const tools = node('div', 'vu-image-import');
        const input = node('textarea'); input.rows = 1;
        input.placeholder = '이미지 URL 배열 · 줄바꿈 또는 | 구분 · <img> HTML';
        input.setAttribute('aria-label', '적용할 이미지 배열');
        const apply = node('button', '', '이미지 배열 적용'); apply.type = 'button';
        const esm = node('button', 'vu-image-add', '+ ESM 상세'); esm.type = 'button';
        esm.title = '이미지 설정에서 선택한 ESM 호스팅 상세 이미지를 목록 끝에 붙입니다 (이미 있는 것은 제외).\n탐색기에서 이미지 파일을 이 칸에 끌어 놓으면 ESM에 올려 끝에 붙입니다.';
        apply.disabled = esm.disabled = formBusy();
        // 메인 프로세스가 검증한 목록만 폼 초안에 넣는다. 저장은 폼의 기존 저장 버튼이 한다.
        const replace = async value => {
          const result = await ipc().invoke('bulk-images-import', { scope, input: value });
          if (!result?.success) throw new Error(result?.error || '이미지 목록을 확인하지 못했습니다.');
          // 기다리는 사이 목록이 다시 그려졌으면(다른 상품을 불러옴 등) 옛 목록에 붙이지 않는다 — 대신 말해 준다.
          if (!container.contains(apply)) return say('그 사이 이미지 목록이 바뀌어 붙이지 않았습니다. 다시 끌어 놓으면 이미 올린 이미지는 바로 붙습니다.');
          if (formBusy()) return;
          onReplace(result.data.images); onChange();
        };
        const run = async (button, task) => {
          if (button.disabled) return;
          if (isBusy()) return wait();
          apply.disabled = esm.disabled = true;
          try { await task(); } catch (e) { say(e.message); }
          finally { apply.disabled = esm.disabled = isBusy(); }
        };
        apply.onclick = () => run(apply, () => replace(input.value.trim()));
        // 로컬 폴더 없이, 일괄 수정과 같은 '이미지 설정의 선택된 ESM 상세 이미지'를 쓴다.
        esm.onclick = () => run(esm, async () => {
          const library = await ipc().invoke('image-library-load');
          if (!library?.success) throw new Error(library?.error || '이미지 설정을 불러오지 못했습니다.');
          const profileId = scope.startsWith('amazon-') ? 'amazon' : scope === 'ebay' ? 'ebay' : 'domestic';
          const hosted = library.profiles?.find(p => p.id === profileId)?.items
            ?.filter(item => item.selected && item.role === '상세' && item.source === 'esm').map(item => item.url) || [];
          if (!hosted.length) throw new Error('이미지 설정에 선택된 ESM 상세 이미지가 없습니다.');
          const current = images.map(x => String(x?.url ?? x ?? ''));
          if (hosted.every(url => current.includes(url))) { hint.textContent = 'ESM 상세 이미지가 이미 모두 목록에 있습니다.'; return; }
          hint.textContent = 'ESM 호스팅 이미지 확인 중…';
          await replace([...new Set([...current, ...hosted])].join('|'));
        });
        // 끌어 놓기: ESM 이미지호스팅의 이미지는 그 주소를 그대로, 탐색기(로컬 폴더)의 이미지 파일은 ESM 에 올려(같은 내용은
        // 기존 주소 재사용) 목록 끝에 붙인다. ESM 페이지의 그림도 가상 파일을 같이 실으니 주소를 먼저 본다(다시 올리지 않게).
        const dropped = dt => [...(dt?.files || [])].map(file => electron().webUtils.getPathForFile(file)).filter(Boolean);
        const offered = e => ['Files', 'text/uri-list', 'text/html'].some(t => e.dataTransfer?.types.includes(t));
        for (const type of ['dragenter', 'dragover']) gallery.addEventListener(type, e => {
          if (offered(e)) { e.preventDefault(); gallery.classList.add('vu-image-dropping'); }
        });
        gallery.addEventListener('dragleave', e => { if (!gallery.contains(e.relatedTarget)) gallery.classList.remove('vu-image-dropping'); });
        gallery.addEventListener('drop', e => {
          gallery.classList.remove('vu-image-dropping');
          if (!offered(e)) return;
          e.preventDefault();
          if (isBusy() || esm.disabled) return say('이미지 작업이 끝난 뒤 다시 넣어주세요.');
          const dt = e.dataTransfer, library = window.VUImages || window.parent?.VUImages;
          const urls = library?.esmUrls?.(dt.getData('text/html'), dt.getData('text/uri-list') || dt.getData('text/plain')) || [];
          const files = urls.length ? [] : dropped(dt);
          if (!urls.length && !files.length) return say('탐색기의 이미지 파일이나 ESM 이미지호스팅의 이미지를 끌어 놓아주세요.');
          run(esm, async () => {
            let add = urls;
            if (files.length) {
              say(`ESM에 이미지 ${files.length}장 올리는 중… (ESM 로그인이 필요하면 창이 뜹니다)`);
              uploading.add(container);
              try {
                const hosted = await ipc().invoke('image-library-host-files', { files });
                if (!hosted?.success) throw new Error(hosted?.error || 'ESM에 이미지를 올리지 못했습니다.');
                add = hosted.urls;
              } finally { uploading.delete(container); }
            }
            const current = images.map(x => String(x?.url ?? x ?? ''));
            if (add.every(url => current.includes(url))) return say('이미 목록에 있는 이미지입니다.');
            await replace([...new Set([...current, ...add])].join('|'));
          });
        });
        gallery.append(esm);   // 타일 끝 빈자리 = 추가될 위치
        tools.append(input, apply); container.append(tools);
      }
    },
  };
})();
