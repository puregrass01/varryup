// 일일 환율 자동 변경 패널 — 상품 일괄 수정 화면 위쪽. 계산·저장은 메인 프로세스(fx_auto_price.js)가 한다.
// bulk-edit.js 가 화면을 만든 뒤 mount 를 부른다. 설정은 PC 마다 따로 저장된다.
(() => {
  const COUNT_LABELS = [['updated', '저장 확인'], ['accepted', '아마존 접수'], ['unchanged', '이미 같은 값'], ['check', '확인 필요'],
    ['small', '1% 미만'], ['large', '변동 폭 초과'], ['noTier', '등급 없음'], ['noPrice', '현재가 없음'],
    ['failed', '조회 실패'], ['notSent', '전송 안 됨'], ['rejected', '거부'], ['unknown', '결과 불명']];
  const SAVED = ['updated', 'accepted'];
  let ipc, panel, state = null, tiers = [], dirty = false, busy = false;
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const q = id => panel.querySelector('#' + id);
  const num = n => Number(n).toLocaleString('ko-KR');
  const when = iso => { const d = new Date(iso); return Number.isFinite(d.getTime()) ? d.toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''; };
  const pct = c => Number.isFinite(c) ? (c > 0 ? '+' : '') + (c * 100).toFixed(1) + '%' : '';
  const label = id => state?.channels?.find(c => c.id === id)?.label || id;
  const counted = counts => COUNT_LABELS.filter(([k]) => counts?.[k]).map(([k, l]) => l + ' ' + num(counts[k])).join(' · ') || '처리 없음';
  const tell = text => { q('fx-status').textContent = text; };

  async function call(channel, data) {
    const result = await ipc.invoke(channel, data);
    if (!result?.success) throw new Error(result?.error || '요청을 처리하지 못했습니다.');
    return result.data;
  }

  // 화면에서만 보는 미리보기. 실제 저장 금액은 메인 프로세스가 같은 규칙(fx_pricing.js leadingTwo)으로 다시 계산한다.
  // 앞 두 자리만 남기고 버린다: 110.61 → 110, 17,396 → 17,000. digits 는 통화의 최소 단위(USD 2, JPY 0)다.
  function leadingTwo(value, digits) {
    const step = Math.max(10 ** (Math.floor(Math.log10(value)) - 1), 10 ** -digits);
    return Number((Math.floor(Number((value / step).toFixed(6))) * step).toFixed(digits));
  }
  function preview(krw) {
    const r = state?.rate;
    if (!r || !(krw > 0)) return { text: '—', title: '' };
    const usd = krw / r.KRW, jpy = usd * r.JPY;
    return { text: num(leadingTwo(usd, 2)) + ' USD · ' + num(leadingTwo(jpy, 0)) + ' JPY',
      title: '환산값 ' + usd.toFixed(2) + ' USD · ' + num(Math.round(jpy)) + ' JPY → 앞 두 자리만 남김' };
  }
  function showPreview(cell, krw) { const p = preview(krw); cell.textContent = p.text; cell.title = p.title; }

  function drawTiers() {
    const body = q('fx-tier-body'), linked = new Map((state?.tiers || []).map(t => [t.id, t.linked]));
    body.replaceChildren();
    tiers.forEach((tier, index) => {
      const tr = el('tr'), name = el('input'), krw = el('input'), remove = el('button', '', '삭제'), shown = el('td', 'fx-preview');
      showPreview(shown, tier.krw);
      name.type = 'text'; name.value = tier.label; name.placeholder = '예: 일반 미러'; name.maxLength = 30;
      name.setAttribute('aria-label', (index + 1) + '번째 등급 이름');
      krw.type = 'text'; krw.inputMode = 'numeric'; krw.value = tier.krw ? num(tier.krw) : ''; krw.placeholder = '150,000';
      krw.setAttribute('aria-label', (index + 1) + '번째 등급 국내 기준가(원)');
      name.oninput = () => { tier.label = name.value; touch(); };
      krw.oninput = () => { tier.krw = Number(krw.value.replace(/[^\d]/g, '')) || 0; showPreview(shown, tier.krw); touch(); };
      remove.type = 'button'; remove.setAttribute('aria-label', (index + 1) + '번째 등급 삭제');
      remove.onclick = () => { tiers.splice(index, 1); touch(); drawTiers(); };
      const cells = [el('td'), el('td'), shown, el('td', 'fx-linked', tier.id && linked.has(tier.id) ? num(linked.get(tier.id)) + '개' : '새 등급'), el('td')];
      cells[0].append(name); cells[1].append(krw); cells[4].append(remove);
      tr.append(...cells); body.append(tr);
    });
    syncControls();
  }

  function touch() { dirty = true; syncControls(); }

  function syncControls() {
    const running = !!state?.running;
    q('fx-dirty').hidden = !dirty;
    for (const id of ['fx-save', 'fx-tier-add', 'fx-enabled']) q(id).disabled = busy;
    q('fx-run').disabled = busy || running;
    q('fx-cancel').hidden = !running;
    q('fx-cancel').disabled = !!state?.running?.cancel;
    panel.querySelectorAll('.fx-channels input').forEach(box => { box.disabled = busy || box.dataset.unavailable === '1'; });
  }

  // 진행 알림(0.4초마다)에는 등급표를 다시 그리지 않는다. 입력칸이 바뀌면 커서가 빠진다.
  function render({ withTiers = false } = {}) {
    if (!state) return;
    const running = state.running;
    q('fx-chip').textContent = running ? '실행 중' : state.enabled ? '매일 자동' : '꺼짐';
    q('fx-chip').dataset.state = running ? 'running' : state.enabled ? 'on' : 'off';
    const last = state.lastRun;
    // 마지막 실행 기록은 현재 환율 조회 결과와 별개다. 서버 404 뒤 직접 조회가
    // 정상화돼도 기록을 지우거나 가격 작업이 재실행된 것처럼 표시하지 않는다.
    const rateRecovered = !!state.rate && !state.rateError && /환율/.test(last?.error || '');
    const lastSaved = last ? SAVED.reduce((sum, k) => sum + Object.values(last.scopes || {}).reduce((s, x) => s + (x.counts?.[k] || 0), 0), 0) : 0;
    q('fx-brief').textContent = running
      ? label(running.scope) + ' ' + num(running.index) + '/' + num(running.total) + ' · ' + counted(running.counts)
      : last ? '마지막 실행 ' + when(last.startedAt) + (last.trigger === 'auto' ? ' (자동)' : ' (수동)') +
          (last.error ? (rateRecovered ? ' · 당시 환율 조회 실패 · 현재 환율 정상' : ' · 이전 실행 실패: ' + last.error) : ' · 저장 ' + num(lastSaved) + '건')
        : '아직 실행 기록이 없습니다';
    if (!dirty) {
      q('fx-enabled').checked = !!state.enabled;
      panel.querySelectorAll('.fx-channels input').forEach(box => { box.checked = !!state.scopes?.[box.value]; });
    }
    q('fx-rate').textContent = state.rate
      ? '적용 환율 · ' + state.rate.marketDate + ' 기준 · 1 USD = ' + num(state.rate.KRW.toFixed(2)) + '원 · ' + state.rate.JPY.toFixed(2) + '엔 (수집 ' + when(state.rate.fetchedAt) + ')' + (state.rate.source ? ' · ' + state.rate.source : '')
      : state.rateError ? '환율을 쓸 수 없습니다: ' + state.rateError : '';
    q('fx-rate').classList.toggle('fx-warn', !state.rate && !!state.rateError);
    const box = q('fx-last');
    box.replaceChildren();
    if (running) box.append(el('p', '', '실행 중 (' + (running.trigger === 'auto' ? '자동' : '수동') + ') · ' + label(running.scope) + ' ' +
      num(running.index) + '/' + num(running.total) + (running.cancel ? ' · 지금 상품까지만 하고 멈춥니다' : '')));
    if (last && !running) {
      const head = '마지막 실행 ' + when(last.startedAt) + ' ~ ' + when(last.finishedAt) + (last.trigger === 'auto' ? ' · 자동' : ' · 수동') +
        (last.rate ? ' · 1 USD = ' + num(last.rate.KRW.toFixed(2)) + '원 · ' + last.rate.JPY.toFixed(2) + '엔 (' + last.rate.marketDate + ' 기준)' : '') +
        (last.cancelled ? ' · 중단됨' : '');
      box.append(el('p', 'fx-last-head', head));
      if (last.error) box.append(el('p', rateRecovered ? 'fx-hint' : 'fx-warn', '이전 실행 오류: ' + last.error));
      if (rateRecovered) box.append(el('p', 'fx-hint', '현재 환율은 정상 조회되었습니다. 위 오류는 이전 실행 기록이며, 실패한 가격 변경 작업이 다시 실행된 것은 아닙니다.'));
      for (const [scope, s] of Object.entries(last.scopes || {})) {
        const line = el('p', '', label(scope) + ' ' + num(s.total) + '개 — ' + counted(s.counts));
        box.append(line);
        if (s.error || s.stopped) box.append(el('p', 'fx-warn', label(scope) + ': ' + (s.error || s.stopped)));
      }
    }
    if (withTiers && !dirty) { tiers = state.tiers.map(t => ({ id: t.id, label: t.label, krw: t.krw })); drawTiers(); }
    else syncControls();
  }

  // 실행·중단 응답에는 환율이 없다(서버를 다시 부르지 않는다). 보던 환율은 그대로 둔다.
  function adopt(next) {
    state = next.rate || next.rateError || !state ? next : { ...next, rate: state.rate, rateError: state.rateError, tiers: state.tiers };
  }

  async function refresh() {
    try { state = await call('fx-auto-price-get'); render({ withTiers: true }); }
    catch (e) { tell('환율 자동 변경 설정을 불러오지 못했습니다: ' + e.message); }
  }

  async function save() {
    const scopes = Object.fromEntries([...panel.querySelectorAll('.fx-channels input')].map(box => [box.value, box.checked]));
    state = await call('fx-auto-price-save', { enabled: q('fx-enabled').checked, scopes, tiers: tiers.map(t => ({ id: t.id, label: t.label, krw: t.krw })) });
    dirty = false;
    render({ withTiers: true });
  }

  async function act(work) {
    if (busy) return;
    busy = true; syncControls();
    try { await work(); } catch (e) { tell(e.message); } finally { busy = false; syncControls(); }
  }

  // CSV 내려받기(엑셀이 한글을 읽도록 BOM). 수식으로 읽힐 첫 글자(= + @ -)는 ' 로 막는다.
  function downloadCsv(prefix, lines) {
    const cell = x => '"' + String(x ?? '').replace(/^[=+@\t\r-]/, "'$&").replaceAll('"', '""') + '"';
    const csv = lines.map(line => line.map(cell).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([String.fromCharCode(0xFEFF) + csv], { type: 'text/csv;charset=utf-8' }));
    const a = el('a'); a.href = url; a.download = prefix + new Date().toISOString().slice(0, 10) + '.csv'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function exportRows(rows) {
    downloadCsv('fx-auto-price-', [['쇼핑몰', 'SKU', '상품명', '등급', '국내 기준가(원)', '현재가', '환산값', '계산가(앞 두 자리)', '변동률', '결과'],
      ...rows.map(r => [label(r.scope), r.id, r.name, r.tier, r.krw, r.current, r.raw, r.target, pct(r.change), r.result])]);
  }

  // ── 아임웹 미국·일본 (임시 · 크롤링, imweb_unit_prices.js) ─────────────────
  // 본사몰 한 사이트의 한국 구역 가격을 기준으로 미국·일본 구역 가격을 위와 같은 규칙으로 바꾼다. 미리보기 → 저장.
  let iwBusy = false, iwPlanned = 0;
  const unitName = { KRW: '한국', USD: '미국', JPY: '일본' };
  const iwTell = text => { q('fx-iw-status').textContent = text; };
  function iwSync() {
    q('fx-iw-preview').disabled = iwBusy;
    q('fx-iw-save').disabled = iwBusy || !iwPlanned;
    q('fx-iw-export').disabled = iwBusy;
  }
  async function iwAct(work) {
    if (iwBusy) return;
    iwBusy = true; iwSync();
    try { await work(); } catch (e) { iwTell(e.message); } finally { iwBusy = false; iwSync(); }
  }
  const iwShow = lines => q('fx-iw-result').replaceChildren(...lines.filter(Boolean).map(([text, cls]) => el('p', cls || '', text)));
  function iwPreviewLines(s) {
    const units = s.site ? Object.entries(s.site.map).map(([unit, c]) => (unitName[c] || c) + ' ' + unit).join(' · ') +
      ' (사이트 정보의 통화)' : '구역(한국·미국·일본)을 확인하지 못했습니다. 저장할 수 없습니다.';
    return [
      ['미리보기 · 상품 ' + num(s.products) + '개 · 바꿀 상품 ' + num(s.changes) + '개' + (s.large ? ' · 10% 넘게 바뀌는 상품 ' + s.large + '개' : '') +
        (s.skipped ? ' · 건너뜀 ' + s.skipped + '개' : ''), 'fx-last-head'],
      ['구역: ' + units, s.site ? 'fx-hint' : 'fx-warn'],
      s.rate && ['적용 환율 · 1 USD = ' + num(s.rate.KRW.toFixed(2)) + '원 · ' + s.rate.JPY.toFixed(2) + '엔 (' + s.rate.marketDate + ' 기준)', 'fx-hint'],
      ...s.lines.map(line => [line]),
      s.changes > s.lines.length && ['나머지 ' + num(s.changes - s.lines.length) + '개는 결과 CSV에서 확인하세요.', 'fx-hint'],
    ];
  }
  function exportImweb(rows) {
    const pick = (r, currency, key) => r.units?.find(u => u.currency === currency)?.[key] ?? '';
    const raw = (value, digits) => value === '' ? '' : Number(value).toFixed(digits);
    downloadCsv('imweb-us-jp-prices-', [['상품번호', '상품명', '한국(원)', '미국 지금', '미국 환산값', '미국 새 가격', '일본 지금', '일본 환산값', '일본 새 가격', '옵션 변경', '결과'],
      ...rows.map(r => [r.prodNo, r.name, r.kr, pick(r, 'USD', 'current'), raw(pick(r, 'USD', 'raw'), 2), pick(r, 'USD', 'next'),
        pick(r, 'JPY', 'current'), raw(pick(r, 'JPY', 'raw'), 0), pick(r, 'JPY', 'next'), r.options, r.result])]);
  }
  function buildImweb() {
    const box = el('div', 'fx-imweb');
    box.append(el('div', 'fx-label', '아임웹 미국·일본'), el('p', 'fx-hint',
      '본사몰의 한국 판매가를 기준으로 같은 상품의 미국(USD)·일본(JPY) 판매가와 옵션 가격을 위와 같은 규칙(앞 두 자리, 1%)으로 바꿉니다. ' +
      '아임웹 Open API 로 읽고 씁니다(아임웹 탭 > Open API 키의 OAuth 값 필요 · 미리보기는 상품 1,000개에 30분쯤). ' +
      '미리보기로 확인한 뒤 저장하세요. 매일 자동 실행은 위 대상에서 아임웹 미국·일본을 체크했을 때만 하고, 10% 넘게 바뀌는 상품은 건너뜁니다.'));
    const actions = el('div', 'fx-line fx-actions'), status = el('span', 'fx-status'), result = el('div', 'fx-last');
    const previewBtn = el('button', '', '미리보기'), saveBtn = el('button', 'be-primary', '미리보기대로 저장'), exportBtn = el('button', '', '결과 CSV');
    for (const [b, id] of [[previewBtn, 'fx-iw-preview'], [saveBtn, 'fx-iw-save'], [exportBtn, 'fx-iw-export']]) { b.type = 'button'; b.id = id; }
    status.id = 'fx-iw-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    result.id = 'fx-iw-result'; saveBtn.disabled = true;
    actions.append(previewBtn, saveBtn, exportBtn, status);
    box.append(actions, result);
    previewBtn.onclick = () => iwAct(async () => {
      iwTell('미리보기 중… 상품마다 구역별 옵션 가격을 읽어 상품 1,000개에 30분쯤 걸립니다.');
      const s = await call('imweb-unit-prices-preview');
      iwPlanned = s.site ? s.changes : 0;
      iwShow(iwPreviewLines(s));
      iwTell(iwPlanned ? '미리보기 완료 · 확인한 뒤 저장하세요.' : '미리보기 완료 · 저장할 가격이 없습니다.');
    });
    saveBtn.onclick = () => iwAct(async () => {
      if (!window.confirm('미리보기한 ' + num(iwPlanned) + '개 상품의 미국·일본 판매가를 저장합니다.\n\n' +
        '· 미리보기 뒤에 기본가가 바뀐 상품은 보내지 않습니다.\n' +
        '· 가격을 모두 먼저 보내고, 다 보낸 뒤 한 번에 다시 읽어 확인합니다(계획과 다른 상품은 결과에 적습니다).\n' +
        '· 첫 상품만 바로 확인하고, 계획과 다르면 그 상품을 되돌린 뒤 멈춥니다.\n\n계속할까요?')) { iwTell('저장을 취소했습니다.'); return; }
      const r = await call('imweb-unit-prices-save');
      iwPlanned = 0;
      iwShow([
        ['저장 · 완료 ' + num(r.count.saved) + '개' + (r.count.changedSince ? ' · 미리보기 뒤 바뀜 ' + r.count.changedSince + '개' : '') +
          (r.count.failed ? ' · 실패 ' + r.count.failed + '개' : ''), 'fx-last-head'],
        r.stopped && [r.stopped, 'fx-warn'],
        ...r.results.filter(x => x.result !== '저장·확인 완료').map(x => [x.name + ' — ' + x.result, 'fx-warn']),
      ]);
      iwTell(r.stopped ? '저장을 멈췄습니다.' : '저장했습니다. 다시 미리보기하면 바뀐 가격을 확인할 수 있습니다.');
    });
    exportBtn.onclick = () => iwAct(async () => {
      const rows = await call('imweb-unit-prices-rows');
      if (!rows.length) { iwTell('내보낼 결과가 없습니다.'); return; }
      exportImweb(rows); iwTell(num(rows.length) + '행을 내보냈습니다.');
    });
    return box;
  }

  // ── 아임웹 미국·일본 상품명 (imweb_unit_names.js) ─────────────────
  // 아임웹이 한국어 그대로 복사해 둔 미국·일본 구역의 상품명 · 옵션 이름을 사전으로 번역한다. 미리보기 → 저장.
  let inBusy = false, inPlanned = 0;
  const inTell = text => { q('fx-in-status').textContent = text; };
  function buildImwebNames() {
    const box = el('div', 'fx-imweb');
    box.append(el('div', 'fx-label', '아임웹 미국·일본 상품명'), el('p', 'fx-hint',
      '아임웹이 한국어 그대로 복사해 둔 미국·일본 상품명과 옵션 이름(구성 선택 · 운전석 · 조수석 · BSA)을 영어 · 일본어로 바꿉니다. ' +
      '차 이름은 차량 명칭 사전(CSVdatabase V2 Vehicles · Manufacturers)과 코드표에서 찾고, 못 찾은 상품은 건너뜁니다(이유는 결과 CSV). ' +
      '이미 영어 · 일본어인 이름은 그대로 둡니다. 미리보기는 1분쯤, 저장은 상품 1,000개에 1시간쯤 걸립니다.'));
    const actions = el('div', 'fx-line fx-actions'), status = el('span', 'fx-status'), result = el('div', 'fx-last');
    const previewBtn = el('button', '', '미리보기'), saveBtn = el('button', 'be-primary', '미리보기대로 저장'), exportBtn = el('button', '', '결과 CSV');
    for (const [b, id] of [[previewBtn, 'fx-in-preview'], [saveBtn, 'fx-in-save'], [exportBtn, 'fx-in-export']]) { b.type = 'button'; b.id = id; }
    status.id = 'fx-in-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    result.id = 'fx-in-result'; saveBtn.disabled = true;
    actions.append(previewBtn, saveBtn, exportBtn, status);
    box.append(actions, result);
    const sync = () => { previewBtn.disabled = inBusy; saveBtn.disabled = inBusy || !inPlanned; exportBtn.disabled = inBusy; };
    const run = work => async () => {
      if (inBusy) return;
      inBusy = true; sync();
      try { await work(); } catch (e) { inTell(e.message); } finally { inBusy = false; sync(); }
    };
    const show = lines => result.replaceChildren(...lines.filter(Boolean).map(([text, cls]) => el('p', cls || '', text)));
    previewBtn.onclick = run(async () => {
      inTell('미리보기 중… 구역별 상품 목록을 읽습니다.');
      const s = await call('imweb-unit-names-preview');
      inPlanned = s.changes;
      show([
        ['미리보기 · 상품 ' + num(s.products) + '개 · 바꿀 상품 ' + num(s.changes) + '개 · 이미 번역됨 ' + num(s.translated) + '개' +
          (s.skipped ? ' · 건너뜀 ' + num(s.skipped) + '개' : ''), 'fx-last-head'],
        ...s.lines.map(line => [line]),
        (s.changes > s.lines.length || s.skipped) && ['나머지와 건너뛴 상품(이유)은 결과 CSV에서 확인하세요.', 'fx-hint'],
        s.options && ['옵션 이름은 저장할 때 상품마다 이 표대로만 바꿉니다: ' + s.options, 'fx-hint'],
      ]);
      inTell(inPlanned ? '미리보기 완료 · 확인한 뒤 저장하세요.' : '미리보기 완료 · 바꿀 이름이 없습니다.');
    });
    saveBtn.onclick = run(async () => {
      if (!window.confirm('미리보기한 ' + num(inPlanned) + '개 상품의 미국·일본 상품명과 옵션 이름을 바꿉니다.\n\n' +
        '· 한국 구역은 바꾸지 않습니다. 첫 상품을 바꾼 뒤 한국 이름이 그대로인지 확인하고, 바뀌었으면 되돌린 뒤 멈춥니다.\n' +
        '· 미리보기 뒤에 이름이 바뀐 상품은 보내지 않고, 끝나면 목록을 다시 읽어 확인합니다.\n\n계속할까요?')) { inTell('저장을 취소했습니다.'); return; }
      const r = await call('imweb-unit-names-save');
      inPlanned = 0;
      show([
        ['저장 · 완료 ' + num(r.count.saved) + '개' + (r.count.changedSince ? ' · 미리보기 뒤 바뀜 ' + r.count.changedSince + '개' : '') +
          (r.count.failed ? ' · 실패 ' + r.count.failed + '개' : ''), 'fx-last-head'],
        r.stopped && [r.stopped, 'fx-warn'],
        ...r.results.map(x => [x.name + ' — ' + x.result, 'fx-warn']),
      ]);
      inTell(r.stopped ? '저장을 멈췄습니다.' : '저장했습니다. 결과 CSV에서 상품별로 확인할 수 있습니다.');
    });
    exportBtn.onclick = run(async () => {
      const rows = await call('imweb-unit-names-rows');
      if (!rows.length) { inTell('내보낼 결과가 없습니다.'); return; }
      downloadCsv('imweb-us-jp-names-', [['상품번호', '한국 이름', '미국 지금', '미국 새 이름', '일본 지금', '일본 새 이름', '옵션 변경(저장 후)', '확인', '결과'],
        ...rows.map(r => [r.prodNo, r.kr, r.usNow, r.usNext, r.jpNow, r.jpNext, r.options, r.note, r.result])]);
      inTell(num(rows.length) + '행을 내보냈습니다.');
    });
    return box;
  }

  function build() {
    panel = el('details', 'fx-panel'); panel.id = 'fx-panel';
    const summary = el('summary', 'fx-summary');
    summary.append(el('span', 'fx-title', '일일 환율 자동 변경'), el('span', 'fx-chip', '확인 중'), el('span', 'fx-brief'));
    summary.children[1].id = 'fx-chip'; summary.children[2].id = 'fx-brief';
    const body = el('div', 'fx-body');
    const toggle = el('div', 'fx-line'), enabledLabel = el('label', 'fx-check'), enabled = el('input');
    enabled.type = 'checkbox'; enabled.id = 'fx-enabled'; enabled.onchange = touch;
    enabledLabel.append(enabled, document.createTextNode('이 PC에서 매일 자동 저장'));
    toggle.append(enabledLabel, el('span', 'fx-hint', '앱이 켜져 있을 때 새 환율이 들어오면 하루 한 번 저장합니다. 여러 PC 중 한 PC에서만 켜세요.'));
    const channels = el('div', 'fx-line fx-channels'); channels.setAttribute('role', 'group'); channels.setAttribute('aria-label', '대상 쇼핑몰');
    channels.append(el('span', 'fx-label', '대상'));
    const table = el('table', 'fx-tier-table'), head = el('tr'), tbody = el('tbody');
    for (const h of ['등급 이름', '국내 기준가 (원)', '오늘 환율로', '연결된 상품', '']) head.append(el('th', '', h));
    const thead = el('thead'); thead.append(head); tbody.id = 'fx-tier-body'; table.append(thead, tbody);
    const add = el('button', '', '등급 추가'); add.type = 'button'; add.id = 'fx-tier-add';
    add.onclick = () => { tiers.push({ id: '', label: '', krw: 0 }); touch(); drawTiers(); panel.querySelector('#fx-tier-body tr:last-child input')?.focus(); };
    const tierBox = el('div', 'fx-tiers');
    tierBox.append(el('div', 'fx-label', '국내 기준가 등급'), table, add);
    const rate = el('p', 'fx-hint'); rate.id = 'fx-rate';
    const rule = el('p', 'fx-hint', '해외 판매가 = 국내 기준가 ÷ 오늘 환율(우대 없음)에서 앞 두 자리만 남기고 버립니다(110.61 → 110달러, 17,396 → 17,000엔). ' +
      '환율로 계산한 값이 지금 판매가와 1% 이상 차이날 때만 저장하고(109.32처럼 두 자리 가격이 아니면 한 번 정리), 10% 넘게 바뀌는 상품은 자동으로 저장하지 않습니다. ' +
      '처음 보는 상품은 지금 가격으로 가장 가까운 등급을 찾아 기억하고, 맞는 등급이 없는 상품은 건드리지 않습니다.');
    const actions = el('div', 'fx-line fx-actions');
    const saveBtn = el('button', 'be-primary', '설정 저장'), runBtn = el('button', '', '지금 실행'), cancelBtn = el('button', '', '중단'), exportBtn = el('button', '', '결과 CSV');
    const dirtyNote = el('span', 'fx-dirty', '저장하지 않은 변경'), status = el('span', 'fx-status');
    for (const [b, id] of [[saveBtn, 'fx-save'], [runBtn, 'fx-run'], [cancelBtn, 'fx-cancel'], [exportBtn, 'fx-export']]) { b.type = 'button'; b.id = id; }
    dirtyNote.id = 'fx-dirty'; dirtyNote.hidden = true; status.id = 'fx-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    cancelBtn.hidden = true;
    actions.append(saveBtn, dirtyNote, runBtn, cancelBtn, exportBtn, status);
    const last = el('div', 'fx-last'); last.id = 'fx-last';
    body.append(toggle, channels, tierBox, rate, rule, actions, last, buildImweb(), buildImwebNames());
    panel.append(summary, body);

    saveBtn.onclick = () => act(async () => { await save(); tell('설정을 저장했습니다.'); });
    runBtn.onclick = () => act(async () => {
      if (dirty) await save();
      const picked = state.channels.filter(c => !c.unavailable && state.scopes[c.id]).map(c => c.label);
      if (!picked.length) { tell('대상 쇼핑몰을 하나 이상 고르세요.'); return; }
      if (!window.confirm(picked.join(' · ') + ' 판매가를 오늘 환율로 맞춥니다.\n\n' +
        '· 환산한 뒤 앞 두 자리만 남깁니다(110.61 → 110달러, 17,396 → 17,000엔).\n' +
        '· 환율 변동이 1% 미만인 상품은 그대로 두고, 10% 넘게 바뀌는 상품은 건너뜁니다.\n' +
        '· 상품이 많으면 1시간 넘게 걸릴 수 있습니다. 앱을 닫으면 남은 상품은 다음 실행에서 이어집니다.\n\n계속할까요?')) { tell('실행을 취소했습니다.'); return; }
      adopt(await call('fx-auto-price-run')); render(); tell('실행을 시작했습니다.');
    });
    cancelBtn.onclick = () => act(async () => { adopt(await call('fx-auto-price-cancel')); render(); tell('지금 상품까지만 처리하고 멈춥니다.'); });
    exportBtn.onclick = () => act(async () => {
      const rows = await call('fx-auto-price-rows');
      if (!rows.length) { tell('내보낼 실행 결과가 없습니다.'); return; }
      exportRows(rows); tell(num(rows.length) + '행을 내보냈습니다.');
    });
    panel.addEventListener('toggle', () => { if (panel.open && !dirty) refresh(); });
    return panel;
  }

  function mount(root, ipcRenderer) {
    if (panel || !root) return;
    ipc = ipcRenderer;
    const anchor = root.querySelector('.be-head');
    const node = build();
    if (anchor) anchor.after(node); else root.prepend(node);
    ipc.on('fx-auto-price-progress', (_, payload) => {
      if (!state) return;
      if (payload?.running) { state.running = payload.running; render(); }
      else refresh();
    });
    ipc.on('imweb-unit-prices-progress', (_, payload) => {
      const r = payload?.running;
      if (r) iwTell(({ save: '저장 ', check: '확인 ' }[r.step] || '미리보기 ') + (r.total ? num(r.index) + '/' + num(r.total) + ' · ' : '') + (r.message || ''));
    });
    ipc.on('imweb-unit-names-progress', (_, payload) => {
      const r = payload?.running;
      if (r) inTell((r.step === 'save' ? '저장 ' : '미리보기 ') + (r.total ? num(r.index) + '/' + num(r.total) + ' · ' : '') + (r.message || ''));
    });
    call('fx-auto-price-get').then(data => {
      state = data;
      const channels = panel.querySelector('.fx-channels');
      for (const c of state.channels) {
        const wrap = el('label', 'fx-check'), box = el('input');
        box.type = 'checkbox'; box.value = c.id; box.onchange = touch;
        if (c.unavailable) { box.dataset.unavailable = '1'; wrap.title = c.unavailable; }
        wrap.append(box, document.createTextNode(c.label + (c.unavailable ? ' (API 연동 후)' : '')));
        channels.append(wrap);
      }
      render({ withTiers: true });
    }).catch(e => { q('fx-chip').textContent = '오류'; q('fx-brief').textContent = '설정을 불러오지 못했습니다: ' + e.message; });
  }

  window.VUFxAutoPrice = { mount };
})();
