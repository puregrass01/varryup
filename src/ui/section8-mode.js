// One mode controller for the VERY UP shell and its platform forms.
// The shell supplies currentMode/modeRevision, DOM refs and updateEmptyState.
function setSection8Mode(mode, force = false) {
  mode = mode === 'edit' ? 'edit' : 'new';
  const section = document.getElementById('section8');
  if (section) {
    modeRevision += 1;
    const changed = currentMode !== mode;
    currentMode = mode;
    const radio = document.querySelector(`.mode-radio[value="${mode}"]`);
    if (radio) radio.checked = true;
    btnRun.style.display = mode === 'new' ? '' : 'none';
    const btnBulk = document.getElementById('btn-bulk-register');
    if (btnBulk) btnBulk.style.display = mode === 'new' ? '' : 'none';
    const btnBulkEdit = document.getElementById('btn-bulk-edit');
    if (btnBulkEdit) btnBulkEdit.style.display = mode === 'edit' ? '' : 'none';
    // 세대·연식·BSA·차량종류·조견표 HTML 은 신규 모드 채우기(fillFrame)만 읽는다. 수정 모드에서는
    // 입력해도 아무 데도 안 쓰여서 '왜 반영이 안 되지' 를 만든다 → 확인 버튼과 같이 숨긴다.
    // 브랜드·차종명·상품코드·상품번호는 남긴다 — fillFrame 이 수정 폼의 찾기 칸(SKU·상품번호)에 넘긴다.
    for (const el of document.querySelectorAll('.new-only')) {
      el.style.display = mode === 'new' ? '' : 'none';
    }
    // 변경 판매가는 거꾸로 수정 모드에서만 — 일괄 수정만 읽는다(신규 등록 채우기는 판매가 USD 칸을 쓴다).
    for (const el of document.querySelectorAll('.edit-only')) {
      el.style.display = mode === 'edit' ? '' : 'none';
    }
    // Existing-product images are edited in their marketplace tab.
    const library = document.getElementById('image-library');
    if (library) library.hidden = mode === 'edit';
    const infoTitle = document.getElementById('product-info-title');
    if (infoTitle) infoTitle.textContent = mode === 'new' ? '상품 정보' : '상품 정보 (검색 조건)';
    // 로그(#log-window)는 두 모드 모두 보이고 모드를 바꿔도 지우지 않는다 — 수정 저장·콘솔·일괄 결과가 여기 남는다.
    if (changed) cardArea.innerHTML = '';
    if (mode === 'new') {
      cardArea.style.display = 'none';
      if (sec8Desc) sec8Desc.textContent = '신규등록 — 실행 로그';
      if (btnClear) btnClear.title = '로그 지우기';
      const emptyText = $('empty-state-text');
      if (emptyText) emptyText.textContent = '현황판에서 플랫폼을 클릭하면 등록 폼이 열립니다.';
    } else {
      cardArea.style.display = 'flex';
      if (sec8Desc) sec8Desc.textContent = '단일 상품 수정 — 상품 편집';
      if (btnClear) btnClear.title = '선택한 폼 모두 닫기';
      const emptyText = $('empty-state-text');
      if (emptyText) emptyText.textContent = '현황판에서 플랫폼을 클릭하면 상품 수정 폼이 열립니다.';
    }
    updateEmptyState();
  }

  const platformWindow = section
    ? document.getElementById('form-frame')?.contentWindow
    : window;
  const platformDocument = platformWindow?.document;
  // The iframe load handler retries with the latest mode after scripts finish.
  if (!platformDocument || (section && platformDocument.readyState !== 'complete')) return;
  // 신규 등록 폼에서는 좌측 상품 정보·현황판·이미지 목록이 채우는 칸(.shell-fed)을 숨긴다 — embedded-platform.css.
  platformDocument.documentElement.classList.toggle('vu-new', mode === 'new');

  const fields = [
    ['workMode', 'copy', 'updateModeUI'],
    ['cpWorkMode', 'copy', 'updateCoupangModeUI'],
    ['amzWorkMode', 'register', 'updateAmazonModeUI'],
    ['iwB2bWorkMode', 'copy', 'updateImwebB2bModeUI'],
    ['iwBoardWorkMode', 'copy', 'updateImwebBoardModeUI'],
  ];
  let modeUiRan = false;
  for (const [name, newValue, updateUI] of fields) {
    const input = platformDocument.querySelector('input[name="' + name + '"]');
    const value = mode === 'edit' ? 'edit' : newValue;
    if (input && (force || input.value !== value)) {
      input.value = value;
      platformWindow[updateUI]();
      modeUiRan = true;
    }
  }
  const ebayMode = platformDocument.getElementById('ebMode');
  if (ebayMode) {
    ebayMode.closest('.form-group').hidden = platformWindow.parent !== platformWindow;
    if (force || ebayMode.value !== mode) {
      ebayMode.value = mode;
      ebayMode.dispatchEvent(new platformWindow.Event('change'));
      modeUiRan = true;
    }
  }
  // 탭의 모드 화면이 다시 그려지면 '찾는 열쇠' 칸(수정할 상품 ID 등)도 탭이 스스로 고쳐 쓴다
  // (쿠팡: 템플릿 ID ↔ 빈칸). 셸은 '좌측이 그대로라 안 넣는다' 고 기억해 두므로(index_up.html
  // fillFrame 의 pushKey), 그 기억을 지워 다음 채우기에서 좌측 값을 다시 넣게 한다.
  if (modeUiRan) {
    platformDocument.querySelectorAll('[data-vu-key]').forEach(el => { delete el.dataset.vuKey; });
  }
}
