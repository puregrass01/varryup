(() => {
  const ipc = (typeof require !== 'undefined' ? require : window.parent.require)('electron').ipcRenderer;
  const pane = document.createElement('section');
  pane.id = 'apiKeysTab'; pane.className = 'panel glass-panel tab-pane'; pane.style.display = 'none';
  pane.innerHTML = '<h2>API KEY</h2><p class="help-text">쇼핑몰별 인증정보와 판매자 연결을 관리합니다.</p><div id="key-platform-tabs" role="tablist" aria-label="API 플랫폼"></div><div id="key-platform-content"></div>';
  document.getElementById('naverTab').parentElement.append(pane);
  const tab = document.createElement('button'); tab.className = 'tab-btn';
  tab.textContent = 'API KEY'; tab.setAttribute('onclick', "switchTab('apiKeysTab')");
  document.querySelector('.app-tabs').append(tab);
  const nav = pane.querySelector('#key-platform-tabs'), content = pane.querySelector('#key-platform-content');
  nav.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;margin:16px 0';
  const naver = document.createElement('div');
  naver.innerHTML = '<div class="form-group"><label class="form-label" for="nvKeyId">Client ID</label><input class="form-input" id="nvKeyId" autocomplete="off"></div>' +
    '<div class="form-group"><label class="form-label" for="nvKeySecret">Client Secret</label><input class="form-input" type="password" id="nvKeySecret" autocomplete="new-password" placeholder="빈칸이면 기존 값 유지"></div>' +
    '<div class="form-group"><label class="form-label" for="nvKeyType">인증 유형</label><select class="form-input" id="nvKeyType"><option value="SELF">SELF · 자사 스토어</option><option value="SELLER">SELLER · 판매자 계정</option></select></div>' +
    '<div class="form-group"><label class="form-label" for="nvKeyAccount">Account ID (SELLER)</label><input class="form-input" id="nvKeyAccount"></div>' +
    '<p class="help-text" id="nvKeyConnection"></p><p class="help-text">커머스API센터 → 내 스토어 애플리케이션 → 해당 앱 → 수정 → API 호출 IP에서 허용 IP를 관리합니다.</p>' +
    '<button type="button" class="btn btn-outline" id="nvKeySave">설정 저장</button> ' +
    '<button type="button" class="btn btn-outline" id="nvKeyCheck">저장된 설정으로 연결 확인</button><p id="nvKeyStatus" role="status"></p>';
  const groups = [
    ['naver', '네이버', naver, null, 'logos/naver.png'],
    ['coupang', '쿠팡', document.getElementById('cpApiAccordion'), 'coupangLogWindow', 'logos/coupang.png'],
    ['amazon', '아마존', document.getElementById('amzApiAccordion'), 'amazonLogWindow', 'logos/amazon.png'],
    ['imweb', '아임웹', document.getElementById('iwApiKeyBox'), null, 'logos/imweb.png'],
    ['ebay', 'eBay', document.querySelector('#ebayTab .api-accordion'), 'ebLog', 'logos/ebay.png']
  ];
  const cards = [];
  for (const [platform, name, node, logId, logo] of groups) {
    if (!node) continue;
    const card = document.createElement('div'), button = document.createElement('button');
    card.setAttribute('role', 'tabpanel'); card.hidden = cards.length > 0;
    card.id = 'api-key-panel-' + platform; button.dataset.keyPlatform = platform;
    button.setAttribute('aria-controls', card.id);
    button.type = 'button'; button.className = 'btn btn-outline key-platform-tab-btn';
    button.innerHTML = `<img src="${logo}" class="key-platform-logo${platform === 'ebay' ? ' key-platform-logo-wide' : ''}" alt="" width="20" height="20"><span>${name}</span>`;
    button.setAttribute('role', 'tab'); button.setAttribute('aria-selected', String(!card.hidden));
    node.open = true; card.append(node); content.append(card); nav.append(button);
    cards.push({ platform, card, button });
    button.addEventListener('click', () => selectPlatform(platform));
    if (logId) {
      const source = document.getElementById(logId), status = document.createElement('p');
      status.setAttribute('role', 'status'); card.append(status);
      if (source) new MutationObserver(() => { status.textContent = source.lastElementChild?.textContent || ''; })
        .observe(source, { childList: true, subtree: true, characterData: true });
    }
  }
  function selectPlatform(platform) {
    const chosen = cards.find(c => c.platform === platform) || cards[0];
    for (const c of cards) {
      c.card.hidden = c !== chosen;
      c.button.setAttribute('aria-selected', String(c === chosen));
    }
  }
  window.VUApiKeys = { select: selectPlatform };
  if (window.parent !== window) window.parent.dispatchEvent(new Event('vu-api-keys-ready'));
  const $ = id => document.getElementById(id);
  function fill(config = {}) {
    $('nvKeyId').value = config.clientId || '';
    $('nvKeyAccount').value = config.accountId || '';
    $('nvKeyType').value = config.type || 'SELF';
    $('nvKeySecret').value = '';
    $('nvKeySecret').placeholder = config.hasClientSecret ? '저장된 Secret 있음 · 빈칸이면 유지' : 'Client Secret';
  }
  ipc.invoke('naver-key-config-get').then(r => {
    if (!r.success) throw new Error(r.error);
    fill(r.config); showConnection(r.connection);
    $('nvKeyStatus').textContent = r.config?.hasClientSecret ? '저장된 인증정보 있음' :
      r.configured ? '서버 또는 환경변수 인증정보 사용 중' : '인증정보를 입력해주세요.';
  }).catch(e => { $('nvKeyStatus').textContent = e.message; });
  function showConnection(connection) {
    if (!connection) return;
    $('nvKeyConnection').textContent = '현재 호출 경로: ' + connection.label +
      (connection.outboundIp ? ' · 확인된 외부 IPv4: ' + connection.outboundIp +
        ' (네이버 호출도 같은 외부 IP를 사용하는지 확인해주세요.)' : '') +
      ' · ' + connection.ipGuidance;
  }
  $('nvKeyCheck').addEventListener('click', async () => {
    $('nvKeyCheck').disabled = true; $('nvKeySave').disabled = true;
    $('nvKeyStatus').textContent = '저장된 설정으로 네이버 연결을 확인하고 있습니다…';
    try {
      const r = await ipc.invoke('naver-key-connection-check');
      showConnection(r.connection);
      $('nvKeyStatus').textContent = r.success ? '네이버 인증에 성공했습니다.' : r.error;
    } catch (e) { $('nvKeyStatus').textContent = e.message; }
    finally { $('nvKeyCheck').disabled = false; $('nvKeySave').disabled = false; }
  });
  $('nvKeySave').addEventListener('click', async () => {
    const button = $('nvKeySave'); button.disabled = true;
    try {
      const r = await ipc.invoke('naver-key-config-save', { clientId: $('nvKeyId').value, clientSecret: $('nvKeySecret').value,
        accountId: $('nvKeyAccount').value, type: $('nvKeyType').value });
      if (!r.success) throw new Error(r.error);
      fill(r.config); $('nvKeyStatus').textContent = '설정을 저장했습니다.';
    } catch (e) { $('nvKeyStatus').textContent = e.message; }
    finally { button.disabled = false; }
  });
})();
