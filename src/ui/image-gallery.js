// Ordered image editor shared by the individual marketplace forms.
// Removing a tile changes only the form draft. The existing save button submits it.
(() => {
  const node = (tag, cls, text) => {
    const el = document.createElement(tag); el.className = cls || '';
    if (text != null) el.textContent = text;
    return el;
  };
  const ipc = () => (typeof require !== 'undefined' ? require : window.parent.require)('electron').ipcRenderer;
  window.VUImageGallery = {
    render(container, images, { onRemove, onMove, onReplace, scope, isBusy = () => false, onChange = () => {} } = {}) {
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
        remove.disabled = !onRemove || isBusy();
        remove.onclick = event => {
          event.preventDefault(); event.stopPropagation();
          if (isBusy()) return;
          onRemove(index); onChange();
        };
        tile.append(open, remove, node('figcaption', '', String(index + 1)));
        if (onMove) {
          const moves = node('div', 'vu-image-moves');
          for (const [step, label] of [[-1, '앞으로'], [1, '뒤로']]) {
            const move = node('button', '', step < 0 ? '←' : '→'); move.type = 'button';
            move.setAttribute('aria-label', '이미지 ' + (index + 1) + ' ' + label);
            move.disabled = isBusy() || index + step < 0 || index + step >= images.length;
            move.onclick = () => { if (!isBusy()) { onMove(index, step); onChange(); } };
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
      if (onReplace && scope) {
        const tools = node('div', 'vu-image-import');
        const input = node('textarea'); input.rows = 1;
        input.placeholder = '이미지 URL 배열 · 줄바꿈 또는 | 구분 · <img> HTML';
        input.setAttribute('aria-label', '적용할 이미지 배열');
        const apply = node('button', '', '이미지 배열 적용'); apply.type = 'button';
        const esm = node('button', 'vu-image-add', '+ ESM 상세'); esm.type = 'button';
        esm.title = '이미지 설정에서 선택한 ESM 호스팅 상세 이미지를 목록 끝에 붙입니다 (이미 있는 것은 제외).';
        apply.disabled = esm.disabled = isBusy();
        // 메인 프로세스가 검증한 목록만 폼 초안에 넣는다. 저장은 폼의 기존 저장 버튼이 한다.
        const replace = async value => {
          const result = await ipc().invoke('bulk-images-import', { scope, input: value });
          if (!result?.success) throw new Error(result?.error || '이미지 목록을 확인하지 못했습니다.');
          if (!container.contains(apply) || isBusy()) return;
          onReplace(result.data.images); onChange();
        };
        const run = async (button, task) => {
          if (isBusy() || button.disabled) return;
          apply.disabled = esm.disabled = true;
          try { await task(); } catch (e) { hint.textContent = e.message; }
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
        gallery.append(esm);   // 타일 끝 빈자리 = 추가될 위치
        tools.append(input, apply); container.append(tools);
      }
    },
  };
})();
