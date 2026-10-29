// 상품정보 입력 자동완성 (VERY UP).
//
// 셸(index_up.html)과 iframe(index.html) 양쪽에서 같은 파일을 <head>에 로드해 쓴다.
// index.html 의 인라인 <script> 블록보다 먼저 평가되어야 하므로 반드시 <head> 에 둘 것 —
// 본문 뒤(ebay.js 옆)에 두면 인라인 블록이 이 모듈을 먼저 참조해 ReferenceError 로
// 최상위 초기화가 통째로 죽는다.
//
// 원래는 네이티브 <datalist> 만 썼다. 한글 IME 조합 처리를 브라우저에 맡길 수 있어서였다.
// 그런데 datalist 팝업은 CSS 로 높이·스크롤바를 제어할 수 없다 — 브라우저가 그리는 창이라
// 브랜드 438개가 화면을 세로로 가득 채웠다. 그래서 커스텀 목록으로 바꾸고, datalist 가
// 대신 해주던 일을 직접 떠안는다:
//   - 조합(composition) 중에는 목록을 다시 그리지 않는다 → 한글 입력 중 깜빡임 방지
//   - keydown 은 isComposing 일 때 전부 무시한다 → 조합 확정용 Enter 를 선택으로 오해하지 않게
//   - 선택 시 input·change 를 직접 발생시킨다 → bindShell 의 브랜드→차종 동기화가 돌도록
(() => {
  'use strict';

  // imweb_categories.json 에 없는 이륜차 브랜드.
  // 이 브랜드를 고르면 상품 카테고리 select 는 건드리지 않고 차량 종류만 오토바이로 잡는다.
  const BIKE_BRANDS = [
    '야마하', '스즈키', '가와사키', '할리데이비슨', '두카티', '트라이엄프',
    '아프릴리아', '피아지오', '존테스', '허스크바나', 'KTM', 'DNA 모터스',
    '로얄앤필드', '캔암', '씨에프모터', 'BMW 모토라드', '혼다 모터스',
  ];

  // 세대 표기 프리셋. 실등록 데이터에서 가장 흔한 형태만 추린다.
  const GEN_PRESETS = (() => {
    const out = [];
    for (let i = 1; i <= 8; i++) {
      out.push(`${i}세대`, `${i}세대 전기형`, `${i}세대 후기형`);
    }
    return out;
  })();

  // ── 커스텀 드롭다운 ────────────────────────────────────────
  // 문서(셸/iframe)마다 상태를 따로 둔다. 같은 파일이 두 문맥에서 로드되기 때문.
  const STORE = new WeakMap();
  function store(doc) {
    let st = STORE.get(doc);
    if (!st) { st = { options: new Map(), open: null, styled: false }; STORE.set(doc, st); }
    return st;
  }

  const CSS = [
    // 색은 theme.css 토큰만 쓴다 — 밝게·어둡게 모두 토큰이 바뀐다(셸·iframe 둘 다 theme.css 를 싣는다).
    '.vu-combo{position:absolute;z-index:9999;max-height:240px;overflow-y:auto;overflow-x:hidden;background:var(--bg-panel);border:1px solid var(--rule-2);border-radius:var(--radius);box-shadow:var(--shadow-panel);padding:4px;box-sizing:border-box;}',
    '.vu-combo-item{padding:6px 10px;font-size:13px;color:var(--text-primary);border-radius:4px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
    '.vu-combo-item[aria-selected=\"true\"]{background:var(--accent-wash);}',
    '.vu-combo-empty{padding:8px 10px;font-size:12px;color:var(--text-muted);}',
    '.vu-combo::-webkit-scrollbar{width:10px;}',
    '.vu-combo::-webkit-scrollbar-thumb{background:var(--ovl-3);border-radius:5px;}',
    '.vu-combo::-webkit-scrollbar-track{background:transparent;}',
    // 마우스를 올린 항목도 드러나야 한다(키보드 선택만 표시됐다).
    '.vu-combo-item:hover{background:var(--ovl-1);}',
    '.vu-combo-item[aria-selected=\"true\"]:hover{background:var(--accent-wash);}'
  ].join('');

  function ensureStyle(doc) {
    const st = store(doc);
    if (st.styled) return;
    const tag = doc.createElement('style');
    tag.textContent = CSS;
    (doc.head || doc.body).appendChild(tag);
    st.styled = true;
  }

  function closeList(doc) {
    const st = store(doc);
    if (!st.open) return;
    if (st.open.el && st.open.el.parentNode) st.open.el.parentNode.removeChild(st.open.el);
    st.open = null;
  }

  function place(doc, open) {
    const r = open.input.getBoundingClientRect();
    const view = doc.defaultView;
    // 숨은 칸(코드가 값을 채운 접힌 칸)은 상자가 없어 목록이 창 왼쪽 위(0,0)에 떴다 — 목록은 두되 보이지 않게
    open.el.style.visibility = open.input.getClientRects().length ? '' : 'hidden';
    open.el.style.left = (r.left + view.scrollX) + 'px';
    open.el.style.top = (r.bottom + view.scrollY + 2) + 'px';
    // 행 목록('2세대 · 12.03~19.05 · F20/F21 · No.101')은 2단 칸(160px 남짓)보다 길다.
    // 칸 폭을 최소로 두고 글 길이만큼 넓히되, 화면을 가로지르지 않게 상한을 둔다.
    open.el.style.minWidth = r.width + 'px';
    open.el.style.width = 'auto';
    open.el.style.maxWidth = Math.max(r.width, 460) + 'px';
  }

  // 목록 항목은 문자열이거나 행 객체 { label, value, pick } 다. 행은 보이는 글(label)과
  // 칸에 들어갈 값(value)이 다르고, 고르는 순간 pick 이 형제 칸까지 같은 행으로 채운다.
  // (연식·차량코드·상품번호는 한 묶음이라 따로 고르면 서로 다른 차의 값이 섞인다.)
  const isRow = v => v !== null && typeof v === 'object';
  const labelOf = v => isRow(v) ? String(v.label != null ? v.label : (v.value != null ? v.value : '')) : String(v);
  const valueOf = v => isRow(v) ? String(v.value != null ? v.value : '') : String(v);

  // 입력값으로 거른다. 빈 값이면 전체를 보여준다 — 목록이 있다는 걸 알 수 있어야 한다.
  // 앞부분 일치를 먼저 올린다: '벤' 을 치면 '벤츠' 가 '스즈벤' 보다 위에 와야 한다.
  // 행은 보이는 글 전체로 거른다 — 연식 칸에서 'F20' 을 쳐도 그 차량코드 행이 걸린다.
  // 몰 상품명을 그대로 붙여 넣어도 찾게('제네시스 GV70 광각 사이드 와이드미러', '…[No.K107]') 상품명에만 붙는 낱말 · 괄호는 단어에서 뺀다.
  const NAME_NOISE = new Set(['옵틱글래스', 'optic-glass', 'opticglass', 'ogwm', '광각', '광각미러', '사이드', '와이드', '와이드미러', '사이드미러', '미러']);
  function filterValues(values, query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return values.slice();
    const all = q.split(/\s+/).map(w => w.replace(/[[\]()]/g, '')).filter(Boolean);
    const kept = all.filter(w => !NAME_NOISE.has(w));
    const words = kept.length ? kept : all, starts = [], contains = [];
    for (const v of values) {
      const lower = labelOf(v).toLowerCase();
      if (lower.indexOf(q) === 0) starts.push(v);
      else if (words.every(w => lower.indexOf(w) !== -1)) contains.push(v);   // '기아 P415' — 단어마다 어디든
    }
    return starts.concat(contains);
  }

  function renderList(doc, open) {
    const values = store(doc).options.get(open.listId) || [];
    // 칸에 이미 목록의 값이 그대로 들어 있으면(= 고른 상태) 거르지 않고 전부 보여 준다.
    // 거르면 자기 자신 한 줄만 남아, 다른 걸로 바꾸려고 연 목록이 쓸모없어진다
    // (SKU 칸: No.101 을 쓰는 다른 차종 SKU 를 고르려는데 OBM0103N101 만 보였다).
    // 사람이 치기 시작하면(open.typed) 그때부터 거른다.
    const q = open.input.value.trim();
    const chosen = !open.typed && q && values.some(v => valueOf(v) === q);
    const items = chosen ? values.slice() : filterValues(values, open.input.value);
    open.items = items;
    open.index = -1;
    while (open.el.firstChild) open.el.removeChild(open.el.firstChild);
    if (items.length === 0) {
      const empty = doc.createElement('div');
      empty.className = 'vu-combo-empty';
      empty.textContent = '일치하는 항목이 없습니다';
      open.el.appendChild(empty);
      return;
    }
    items.forEach((v, i) => {
      const row = doc.createElement('div');
      row.className = 'vu-combo-item';
      row.setAttribute('role', 'option');
      row.textContent = labelOf(v);   // innerHTML 금지 — 카테고리·엑셀 문자열을 그대로 신뢰하지 않는다
      row.addEventListener('mousedown', ev => {
        ev.preventDefault();   // blur 보다 먼저 잡아야 선택이 취소되지 않는다
        choose(doc, open, i);
      });
      open.el.appendChild(row);
    });
  }

  function highlight(open, next) {
    const rows = open.el.querySelectorAll('.vu-combo-item');
    if (!rows.length) return;
    if (open.index >= 0 && rows[open.index]) rows[open.index].removeAttribute('aria-selected');
    open.index = (next + rows.length) % rows.length;
    const row = rows[open.index];
    row.setAttribute('aria-selected', 'true');
    const box = open.el.getBoundingClientRect(), r = row.getBoundingClientRect();
    if (r.bottom > box.bottom) open.el.scrollTop += r.bottom - box.bottom;
    else if (r.top < box.top) open.el.scrollTop -= box.top - r.top;
  }

  function choose(doc, open, index) {
    const value = open.items[index];
    if (value === undefined) return;
    const input = open.input;
    input.value = valueOf(value);
    closeList(doc);
    if (isRow(value) && typeof value.pick === 'function') value.pick();
    // datalist 는 선택 시 브라우저가 이 둘을 대신 발생시켰다. 직접 쏴야
    // bindShell 의 브랜드→차종 동기화와 자동차/오토바이 판정이 돈다.
    // 다만 아래 input 이벤트를 자기 핸들러가 받아 목록을 도로 여는 문제가 있어,
    // 발생시키는 동안에는 표시를 걸어 무시하게 한다(dispatchEvent 는 동기다).
    input.dataset.vuChoosing = '1';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    delete input.dataset.vuChoosing;
  }

  // 걸러서 행이 하나 남았는데 칸의 글자가 그 행의 '이 칸 값' 안에 없다 → 사람이 다른 열
  // (상품번호·차량코드)로 행을 찾은 것이다. 그 글자를 이 칸의 값으로 남기면 안 된다 — 연식 칸에
  // 1702 를 쳐서 BYD 씨라이언7 행을 찾고 Tab 하면 연식이 '1702' 가 됐다. 글자가 값의 일부면
  // (연식 칸에 '12.03') 사람이 값을 적는 중일 수 있어 건드리지 않는다.
  function searchedRow(open) {
    if (!open || !open.typed || open.items.length !== 1 || !isRow(open.items[0])) return -1;
    const q = open.input.value.trim().toLowerCase();
    if (!q) return -1;
    return valueOf(open.items[0]).toLowerCase().indexOf(q) === -1 ? 0 : -1;
  }

  function openList(doc, input, listId) {
    ensureStyle(doc);
    closeList(doc);
    const el = doc.createElement('div');
    el.className = 'vu-combo';
    el.setAttribute('role', 'listbox');
    doc.body.appendChild(el);
    const open = { el, input, listId, items: [], index: -1 };
    store(doc).open = open;
    renderList(doc, open);
    place(doc, open);
    return open;
  }

  function bindCombo(doc, input, listId) {
    if (input.dataset.vuCombo === '1') { input.dataset.vuList = listId; return; }
    input.dataset.vuCombo = '1';
    input.dataset.vuList = listId;
    let composing = false;

    const current = () => {
      const st = store(doc);
      return st.open && st.open.input === input ? st.open : null;
    };
    const show = () => openList(doc, input, input.dataset.vuList);

    input.addEventListener('focus', show);
    input.addEventListener('click', () => { if (!current()) show(); });

    // 조합 중에는 목록을 다시 그리지 않는다. 한글 한 글자가 완성되기 전의
    // 중간 자모로 거르면 목록이 비었다 찼다 하며 깜빡인다.
    input.addEventListener('compositionstart', () => { composing = true; });
    input.addEventListener('compositionend', () => {
      composing = false;
      const open = current() || show();
      open.typed = true;
      renderList(doc, open);
    });
    input.addEventListener('input', () => {
      if (composing || input.dataset.vuChoosing === '1') return;
      const open = current() || show();
      open.typed = true;
      renderList(doc, open);
      place(doc, open);
    });

    input.addEventListener('keydown', ev => {
      // isComposing 일 때의 Enter 는 '조합 확정' 이지 '선택' 이 아니다.
      if (composing || ev.isComposing || ev.keyCode === 229) return;
      const open = current();
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault();
        const o = open || show();
        highlight(o, o.index + (ev.key === 'ArrowDown' ? 1 : -1));
      } else if (ev.key === 'Enter') {
        if (open && open.index >= 0) { ev.preventDefault(); choose(doc, open, open.index); }
        // 걸러서 행이 하나만 남았으면 Enter 는 그 행을 고르는 것이다. 안 그러면 거르려고 친
        // 글자(연식 칸의 상품번호 '1702')가 그대로 이 칸의 값이 된다.
        else if (open && open.typed && open.items.length === 1 && isRow(open.items[0])) {
          ev.preventDefault(); choose(doc, open, 0);
        }
      } else if (ev.key === 'Escape') {
        if (open) { ev.preventDefault(); closeList(doc); }
      } else if (ev.key === 'Tab') {
        const i = searchedRow(open);
        if (i >= 0) choose(doc, open, i); else closeList(doc);
      }
    });

    // 자기 목록일 때만 닫는다. 칸에서 칸으로 넘어가면 다음 칸이 먼저 자기 목록을 여는데,
    // 그냥 closeList 하면 120ms 뒤 앞 칸의 blur 가 '지금 열린 목록' — 즉 다음 칸의 목록 — 을 닫았다.
    // 검색어만 남기고 나가는 경우(searchedRow)는 blur 가 다음 칸 focus 보다 먼저라 여기서 바로 고른다.
    // 닫는 건 blur 때 열려 있던 그 목록뿐이다. 120ms 안에 같은 칸으로 돌아와 새로 연 목록까지 닫으면
    // 목록이 열리자마자 사라졌다(차종 입력이 빨라지자 드러났다).
    input.addEventListener('blur', () => {
      const i = searchedRow(current());
      if (i >= 0) { choose(doc, current(), i); return; }
      const was = current();
      setTimeout(() => { if (was && current() === was) closeList(doc); }, 120);
    });

    // 문서마다 한 번 — 단, 이 파일은 셸과 iframe 에 따로 로드된 두 벌이 같은 iframe 문서에
    // 목록을 붙인다(셸이 이베이 제목 칸에 붙인다). 표시를 문서(body)에 남기면 먼저 붙인 쪽만
    // 바깥 클릭 닫기를 달고, 다른 벌의 목록은 바깥을 눌러도 안 닫혔다. 그래서 벌마다 따로 센다.
    const st0 = store(doc);
    if (!st0.docBound) {
      st0.docBound = true;
      doc.addEventListener('mousedown', ev => {
        const st = store(doc);
        if (st.open && ev.target !== st.open.input && !st.open.el.contains(ev.target)) {
          // 바깥 클릭은 blur 보다 먼저 온다. 여기서 그냥 닫으면 blur 가 고를 목록이 없어
          // 검색어(연식 칸의 '1702')가 값으로 남는다.
          const i = searchedRow(st.open);
          if (i >= 0) choose(doc, st.open, i); else closeList(doc);
        }
      });
      const reposition = () => { const st = store(doc); if (st.open) place(doc, st.open); };
      (doc.defaultView || window).addEventListener('resize', reposition);
      doc.addEventListener('scroll', reposition, true);
    }
  }

  let catalog = null;          // { 국산차: {브랜드:[차종]}, 수입차: {...} }
  let natIndex = {};           // 브랜드 → 국적
  let brandList = [];          // 카탈로그 브랜드 ∪ 이륜차 브랜드

  function reindex() {
    natIndex = {};
    const names = [];
    Object.keys(catalog || {}).forEach(nat => {
      Object.keys(catalog[nat] || {}).forEach(b => {
        natIndex[b] = nat;
        names.push(b);
      });
    });
    BIKE_BRANDS.forEach(b => { if (!names.includes(b)) names.push(b); });
    brandList = names.sort((a, b) => a.localeCompare(b, 'ko'));
  }

  const norm = s => String(s == null ? '' : s).trim();

  /* ── 한↔영↔일 사전 (data/vehicle_i18n.json) ─────────────────────────
     카탈로그와 같은 이유로 이 모듈이 소유한다 — 차종 데이터의 단일 소유자.
     사전이 비어 있어도 조회는 null 을 돌려줄 뿐 예외를 던지지 않는다.        */
  let names = null;            // { aliases, generationTokens, brands, models, generations }
  let nameBrandIndex = {};     // 정규화 키 → 사전의 브랜드 키
  let genTokenPairs = [];      // [[한글, 일문]] — 긴 토큰 우선 정렬

  // 공백 정규화. 사전 키는 생성 시 같은 규칙으로 정규화되어 있다.
  const nz = s => String(s == null ? '' : s).replace(/[\t\n\r  ]+/g, ' ').trim();
  // 브랜드 키 정규화: 공백 제거 + 괄호 주석 제거. '쌍용 (KGM)' 과 '쌍용' 을 같은 키로 모은다.
  const bkey = s => nz(s).replace(/\s*\([^)]*\)\s*/g, '').replace(/\s+/g, '').toLowerCase();

  function reindexNames() {
    nameBrandIndex = {};
    genTokenPairs = [];
    japanKeys = new Map();
    if (!names) return;
    Object.keys(names.brands || {}).forEach(b => { nameBrandIndex[bkey(b)] = b; });
    // 별칭(르노삼성 → 르노 코리아 등)도 같은 색인에 넣어 한 번에 찾게 한다.
    Object.keys(names.aliases || {}).forEach(from => {
      const to = names.aliases[from];
      if (nameBrandIndex[bkey(to)]) nameBrandIndex[bkey(from)] = nameBrandIndex[bkey(to)];
    });
    // '파생형' 이 '派生형' 이 되지 않도록 긴 토큰부터 치환한다.
    genTokenPairs = Object.keys(names.generationTokens || {})
      .sort((a, b) => b.length - a.length)
      .map(k => [k, names.generationTokens[k]]);
  }

  /* ── 차량 카탈로그 (data/vehicle_catalog.json) ────────────────────
     엑셀 코드표·이베이 표에서 구운 것(scratch/build_vehicle_catalog.mjs).
       variants — 차량 한 행: 세대·연식·차량코드·상품번호
       listings — 이베이·아마존 SKU 한 행: 영문 차종·연식 글·판매가(USD)·BSA 여부
     좌측 연식·차량코드·상품번호·SKU·판매가 목록이 여기서 나온다.                    */
  let vehicle = null;
  let japanMode = false;
  let japanKeys = new Map();   // japanBrandKey 결과. 사전(별칭)·카탈로그가 바뀌면 비운다(reindexNames · reindexVehicle).
  let listingBySku = new Map();
  let listingsByNo = new Map();
  // 앱이 API 로 받아 둔 '지금 몰 값'(main 'vehicle-live-values'): 아마존 미국·일본 목록, eBay 활성 리스팅, 쿠팡 옵션 판매가.
  // 판매가 자동완성은 표(엑셀)의 값(109.32)보다 이것(환율 자동 변경 뒤 110)을 먼저 쓴다. 없으면 표 값.
  let live = null;
  const liveOf = (sku, where) => {
    const k = nz(sku).toUpperCase();
    return !k || !live ? null : (where === 'ebay' ? live.ebay?.[k] : live.amazon?.[where]?.[k]) || null;
  };
  // 그 칸의 몰(아마존 칸이면 아마존 미국) 값 → 다른 몰 값 → 표 값.
  function priceOf(l, amazonFirst) {
    for (const where of amazonFirst ? ['US', 'ebay'] : ['ebay', 'US']) {
      const x = liveOf(l.sku, where), p = Number(x?.price);
      if (p > 0) return { price: p, stock: x.stock, where };
    }
    return { price: l.priceUsd, stock: null, where: '' };
  }
  const LIVE_NAME = { US: '아마존', JP: '아마존 일본', ebay: 'eBay' };
  let amazonKnown = false;   // 카탈로그에 아마존 실측값(asin)이 들어 있나 — 없으면 아마존 SKU 칸도 이베이 표 SKU 를 쓴다

  const squash = s => nz(s).toLowerCase().replace(/\s+/g, '');
  const modelKeyEn = s => nz(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  // 셸의 bareNo 와 같은 규칙('No.H131번(옵)' → 'H131'). 어긋나면 목록 번호와 등록 번호가 달라진다.
  const bareNoOf = s => { const m = nz(s).match(/^(?:No\.?\s*)?([A-Za-z]?\d+(?:-\d+)?)/i); return m ? m[1].toUpperCase() : ''; };
  const usd = p => (typeof p === 'number' && isFinite(p)) ? p.toFixed(2) : '';

  // 코드표 브랜드는 '기아 (Kia)' 처럼 괄호가 붙어 있고, 좌측은 '기아' 다. bkey 가 괄호를 뗀다.
  // 별칭(르노삼성 → 르노 코리아)도 사전과 같은 규칙으로 따른다.
  function vehicleBrandKey(s) {
    const k = bkey(s);
    const aliases = (names && names.aliases) || {};
    for (const from of Object.keys(aliases)) if (bkey(from) === k) return bkey(aliases[from]);
    return k;
  }

  function reindexVehicle() {
    listingBySku = new Map();
    listingsByNo = new Map();
    japanKeys = new Map();
    amazonKnown = !!vehicle && (vehicle.listings || []).some(l => l.asin);
    if (!vehicle) return;
    for (const l of vehicle.listings || []) {
      listingBySku.set(l.sku, l);
      if (!l.no) continue;
      if (!listingsByNo.has(l.no)) listingsByNo.set(l.no, []);
      listingsByNo.get(l.no).push(l);
    }
  }

  // 차종은 '포함' 으로 찾는다. 코드표 차종이 좌측(아임웹) 목록보다 잘게 나뉘어 있어서다
  // ('M3' ↔ 'M3 / M340i Pro', 'MINI 쿠퍼 해치백' ↔ 'MINI 쿠퍼 해치백 S').
  // 이름이 정확히 같은 행을 먼저, 이름에 포함된 행을 뒤에 둔다. 차종이 비면 브랜드 전체.
  // 별칭을 전부 훑어서 비싸다. 일본 289행을 행마다 다시 풀면 japanRowsFor 한 번에 4ms, 상품 표 1,800행에 17초였다.
  function japanBrandKey(brand) {
    if (japanKeys.has(brand)) return japanKeys.get(brand);
    const aliases = vehicle?.japan?.brandAliases || {};
    const alias = Object.keys(aliases).find(from => bkey(from) === bkey(brand));
    const key = vehicleBrandKey(alias ? aliases[alias] : brand);
    japanKeys.set(brand, key);
    return key;
  }

  function japanRowsFor(brand, model = '') {
    if (!japanMode || !brand) return [];
    const bk = japanBrandKey(brand);
    const rows = (vehicle?.japan?.variants || []).filter(v => japanBrandKey(v.brand) === bk);
    const key = squash(model);
    if (!key) return rows;
    const exact = rows.filter(v => squash(v.model) === key);
    return exact.length ? exact : rows.filter(v => (v.aliases || []).some(alias => squash(alias) === key));
  }

  function japanName(brand, model, field) {
    const rows = japanRowsFor(brand, model);
    if (!rows.length) return undefined;
    // A grouped name may refer to several domestic models. Do not pick the first one.
    const values = [...new Set(rows.map(row => row[field]).filter(Boolean))];
    return values.length === 1 ? values[0] : null;
  }

  function variantsFor(brand, model) {
    if (!vehicle) return [];
    const japan = japanRowsFor(brand, model);
    if (japan.length) return japan;
    const b = vehicleBrandKey(brand);
    if (!b) return [];
    const rows = (vehicle.variants || []).filter(v => vehicleBrandKey(v.brand) === b);
    const m = squash(model);
    if (!m) return rows;
    const exact = rows.filter(v => squash(v.model) === m);
    const part = rows.filter(v => squash(v.model) !== m && squash(v.model).indexOf(m) !== -1);
    return exact.concat(part);
  }

  // 이 차(행)에 '확실히' 이어진 SKU 하나. 같은 상품번호 + 같은 영문 차종으로 미리 이어 둔
  // 것(v.skus) 가운데 BSA 여부까지 같은 것이 딱 하나일 때만 돌려준다. 애매할 때 추측해서
  // 고르면 다른 차의 리스팅을 덮어쓴다 — 그럴 바엔 비워 두고 목록에서 사람이 고르게 한다.
  // bsa 가 null 이면(BSA 를 고를 수 없는 상태) BSA 로 거르지 않는다 — 이어진 SKU 가 하나뿐일 때만.
  // field: 이베이는 v.skus(이베이 표), 아마존은 v.amazonSkus(아마존에 실제로 있는 SKU). 같은 차라도 둘이 다를 수 있다.
  function listingFor(v, bsa, field = 'skus') {
    const linked = (v[field] || []).map(s => listingBySku.get(s)).filter(Boolean);
    const same = bsa === null ? linked : linked.filter(l => l.bsa === bsa);
    return same.length === 1 ? same[0] : null;
  }

  // 좌측 BSA 선택. 수정 모드에서는 BSA 칸이 숨겨져 기본값(O)인 채로 남는데, 그 보이지 않는 값으로
  // SKU 를 거르면 BSA 없는 차는 SKU 가 안 채워졌다(수정 모드에선 SKU 가 상품을 찾는 열쇠다).
  // 칸이 안 보이면 '모름' 으로 친다.
  const shellBsa = doc => {
    const r = doc.querySelector('input[name="bsa"]:checked');
    const box = r && r.closest('.field');
    if (box && box.offsetParent === null) return null;
    return !!r && r.value === 'o';
  };

  // 형제 칸에 값을 넣고 사람이 친 것처럼 input/change 를 쏜다(자동 채움·동기화가 돌도록).
  // 쏘는 동안 vuChoosing 을 걸어 그 칸의 목록이 덩달아 열리지 않게 한다.
  function setField(doc, id, value, auto) {
    const el = doc.getElementById(id);
    if (!el) return;
    el.value = value == null ? '' : String(value);
    if (auto) el.dataset.vuAuto = '1';
    el.dataset.vuChoosing = '1';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    delete el.dataset.vuChoosing;
  }

  // SKU·판매가·쿠팡 상품ID 는 '그 차' 의 값이다. 차가 바뀌면 사람이 목록에서 고른 값이라도
  // 버린다 — 남겨 두면 새 차가 앞 차의 SKU 로 올라가 앞 차 리스팅을 덮어쓴다(아마존은 SKU 로
  // PUT 한다). BMW 6GT 에서 고른 OBM2105N181 이 BYD 씨라이언7 로 바꾼 뒤에도 남아 있었다.
  // 같은 차에서 BSA 만 바꿀 때는 부르지 않는다 — 그때는 사람이 고른 값을 지킨다(reapplyListing).
  // 수정 모드의 변경 판매가도 그 차에 매긴 값이라 같이 버린다 — 남으면 다음 차에 그 가격으로 저장된다.
  const CAR_FIELDS = ['inp-sku', 'inp-amz-sku', 'inp-usd', 'inp-cpid', 'inp-edit-krw', 'inp-edit-usd', 'inp-edit-jpy'];
  function forgetCar(doc) {
    store(doc).variant = null;
    for (const id of CAR_FIELDS) {
      const el = doc.getElementById(id);
      if (el && el.value) setField(doc, id, '', true);
    }
  }

  // 브랜드·차종이 바뀌면 앞 차에서 고른 행(세대·연식·차량코드·상품번호)도 앞 차의 값이다. 고른 값 그대로인 칸만
  // 비운다(사람이 고친 칸은 둔다). 예전에는 남아서 라이즈 → 스페이시아로 바꿔도 '1세대 후기형 · A201A' 가 제목에 갔다.
  // forgetCar 가 고른 행을 지우므로 그보다 먼저 부른다. 상품번호를 손으로 바꿀 때(forgetCar)는 같은 차일 수 있어 안 부른다.
  function forgetRow(doc) {
    const v = store(doc).variant;
    if (!v) return;
    for (const [id, key] of [['inp-gen', 'gen'], ['inp-year', 'year'], ['inp-code', 'code'], ['inp-no', 'no']]) {
      const el = doc.getElementById(id);
      if (el && el.value && el.value === String(v[key] ?? '')) setField(doc, id, '', true);
    }
  }

  function pickVariant(doc, v) {
    const prev = store(doc).variant;
    if (prev && prev !== v) forgetCar(doc);
    if (v.source === 'japan') {
      // This workbook has vehicle series, not product IDs or listing SKUs.
      forgetCar(doc);
      setField(doc, 'inp-carmodel', v.model);
    }
    store(doc).variant = v;
    setField(doc, 'inp-gen', v.gen);
    setField(doc, 'inp-year', v.year);
    setField(doc, 'inp-code', v.code);
    setField(doc, 'inp-no', v.no);
    reapplyListing(doc);
    reapplyCoupang(doc);
  }

  // 본사몰 상품명('옵틱글래스 현대 넥쏘 광각미러 [No.H119]') → 좌측 칸. [No.] 의 번호로 카탈로그 행을 찾고, 같은 번호를
  // 여러 차가 쓰면(H131: 아반떼CN7·아반떼N) 상품명에 든 브랜드, 이어서 가장 긴 차종으로 좁힌다.
  // 한 행으로 안 좁혀지면 variant 는 null — 추측하지 않는다(listingFor 와 같은 원칙). 브랜드·차종은 좌측 목록의 표기로 돌려준다.
  function resolveTitle(title) {
    const raw = String(title || ''), m = raw.match(/\[No\.?\s*([^\]]+)\]/i), no = m ? bareNoOf(m[1]) : '';
    const t = squash(raw.replace(/\[No\.?[^\]]*\]/gi, ' '));   // 번호 괄호는 빼고 찾는다 — 'h131' 안의 'h1' 같은 짧은 이름이 걸리지 않게
    const all = no && vehicle ? vehicle.variants.filter(v => v.no === no) : [];
    let rows = all.filter(v => t.includes(vehicleBrandKey(v.brand)));
    if (!rows.length) rows = all;
    const len = v => squash(v.model).length;
    const named = rows.filter(v => t.includes(squash(v.model)));
    if (named.length) rows = named.filter(v => len(v) === Math.max(...named.map(len)));
    const longest = a => a.sort((x, y) => squash(y).length - squash(x).length)[0] || '';
    // 행들이 한 브랜드면 그 브랜드. 코드표의 '기타'(GMC·피아트…)처럼 좌측 목록에 없으면 상품명에 든 브랜드.
    const bks = new Set(rows.map(v => vehicleBrandKey(v.brand)));
    const brand = (bks.size === 1 && brandList.find(b => vehicleBrandKey(b) === [...bks][0]))
      || longest(brandList.filter(b => t.includes(squash(b))));
    const one = rows.length === 1 ? rows[0] : null;
    // 차종 칸은 좌측 목록의 이름('아반떼')이다. 행이 정해졌으면 그 행의 차종('아반떼N')에 든 것만 — 손으로 행을 고를 때와 같다.
    const model = longest(api.modelsOf(brand).filter(x => one ? squash(one.model).includes(squash(x)) : t.includes(squash(x))))
      || (one ? one.model : '');
    return { brand, model, no, variant: one };
  }

  // 새 차 SKU(이베이 · 아마존 같음) = 제조사 2자 + 차종 2자리 + 순번 2자리 + N + 상품번호 (FD0905N1108).
  // 제조사 · 차종 코드는 같은 차종의 기존 SKU 에서, 없으면 그 제조사에서 안 쓴 다음 차종 번호. 순번은 그 제조사+차종의 가장 큰 순번 + 1
  // (BSA 판도 따로 순번을 받는다 — 기존 데이터가 그렇다). 기존 SKU 앞의 'O' · BSA 판 끝의 '1' 은 생성 오류라 붙이지 않는다(10-28 결정).
  // 같은 SKU 가 몰에 이미 있으면 등록 단계가 막는다(duplicate_guard checkAmazon · ebay.js saveDraft).
  const SKU_RE = /^O?([A-Z]{2})(\d{2})(\d{2})N/;
  const pad2 = n => String(n).padStart(2, '0');
  // bsa: 좌측 BSA(true/false, 모르면 null). 같은 차종 · 같은 상품번호 · 같은 BSA 의 리스팅이 이미 있으면 새로 만들지 않는다('' — 목록에서 고른다).
  function suggestSku(brand, model, no, bsa = null) {
    if (!vehicle || !no) return '';
    const skusOf = rows => rows.flatMap(v => [...(v.skus || []), ...(v.amazonSkus || [])]).map(s => s.match(SKU_RE)).filter(Boolean);
    const bk = vehicleBrandKey(brand), m = squash(model);
    const brandRows = (vehicle.variants || []).filter(v => vehicleBrandKey(v.brand) === bk);
    const brandCodes = skusOf(brandRows);
    if (!brandCodes.length) return '';
    // 같은 차종의 SKU: 카탈로그 행에 이어진 것(좌측 표기 차이는 variantsFor 가 맞춘다) + 이베이 표 리스팅의 영문 차종이 같은 것
    // (6GT 는 카탈로그 행에 SKU 가 안 이어져 있고 표에만 OBM2105N181 · '6GT' 로 있다). 영문 비교는 글자 · 숫자만(F-150 = F150).
    const rows = m ? variantsFor(brand, model).filter(v => v.source !== 'japan') : [];
    const key = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const names = new Set([key(model), ...rows.map(v => key(v.modelEn))].filter(Boolean));
    const own = m ? [...skusOf(rows), ...(vehicle.listings || []).filter(l => names.has(key(l.modelEn))).map(l => l.sku.match(SKU_RE)).filter(Boolean)] : [];
    const ownKeys = new Set(own.map(c => c[1] + c[2]));
    const listed = (listingsByNo.get(no) || []).some(l => {
      const c = l.sku.match(SKU_RE);
      return c && ownKeys.has(c[1] + c[2]) && (bsa === null || !!l.bsa === bsa);
    });
    if (listed) return '';
    const count = {};
    for (const c of brandCodes) count[c[1]] = (count[c[1]] || 0) + 1;
    const bc = own[0]?.[1] || Object.keys(count).sort((a, b) => count[b] - count[a])[0];
    const all = [...(vehicle.listings || []).map(l => l.sku), ...brandCodes.map(c => c.input)]
      .map(s => String(s).match(SKU_RE)).filter(c => c && c[1] === bc);
    const top = list => Math.max(0, ...list);
    const mc = own.find(c => c[1] === bc)?.[2] || pad2(top(all.map(c => +c[2])) + 1);
    return bc + mc + pad2(top(all.filter(c => c[2] === mc).map(c => +c[3])) + 1) + 'N' + no;
  }
  // 신규 등록 모드에서 좌측 이베이 · 아마존 SKU 칸이 비었으면(이어진 리스팅 없음) 만든 SKU 를 넣고 '자동 생성' 표시를 단다.
  // 리스팅 SKU · 사람이 적은 값은 건드리지 않는다. 수정 모드는 SKU 가 찾는 열쇠라 만들지 않는다.
  function applyGeneratedSku(doc) {
    if (doc.getElementById('mode-new')?.checked === false) return;
    const val = id => nz(doc.getElementById(id)?.value);
    const sku = suggestSku(val('inp-brand'), val('inp-carmodel'), bareNoOf(val('inp-no')), shellBsa(doc));
    for (const id of ['inp-sku', 'inp-amz-sku']) {
      const el = doc.getElementById(id);
      if (!el || (el.value.trim() && el.dataset.vuGenerated !== '1')) continue;
      if (el.value !== sku) setField(doc, id, sku, true);
      el.dataset.vuGenerated = sku ? '1' : '';
      el.classList.toggle('vu-generated', !!sku);
      el.title = sku ? '자동 생성 SKU — 같은 SKU 가 몰에 이미 있으면 등록이 막힙니다' : '';
    }
  }

  // 신규 등록할 차(DB 에 없음)는 한 줄로 붙여 넣는다: 'No.1108번  F150  12세대 중기형  11~14  P415'
  // = 상품번호 · 차종 · 세대 · 연식 · 차량코드. 시트에서 복사한 탭(또는 두 칸 이상 띄움)으로 나누고, 한 칸씩 띄운 줄은
  // 연식 모양(11~14 · 12.03~19.05 · 26년 9월~)을 기준으로 나눈다(차종은 한 낱말). 'No.' 로 시작하지 않으면 null.
  // 끝은 '~' 또는 '-'(카탈로그 표기 10.03-12.06 · 20.12-현재), 끝 연식은 없어도 되고 '현재' 도 된다.
  const YEAR = String.raw`(?:\d{2}년\s*\d{1,2}월|\d{2}(?:\.\d{1,2})?)\s*[~-]\s*(?:\d{2}년\s*\d{1,2}월|\d{2}(?:\.\d{1,2})?|현재)?`;
  function parseDbLine(text) {
    const raw = String(text ?? '').trim();   // nz 는 겹친 띄움을 하나로 줄여 아래 '두 칸 이상' 나누기를 못 하게 한다
    if (!/^No\.?\s*[A-Za-z]?\d/i.test(raw)) return null;
    let parts = raw.split(/\t+|\s{2,}/).map(nz).filter(Boolean);
    if (parts.length < 3) {
      const m = raw.replace(/\s+/g, ' ').match(new RegExp(String.raw`^(\S+)\s+(\S+)\s*(.*?)\s*(${YEAR})\s*(.*)$`));
      if (!m) return null;
      parts = m.slice(1).map(nz);
      // 차종이 여러 낱말이면('더뉴 스포티지') 카탈로그 차종과 맞는 가장 긴 앞 낱말까지를 차종으로 본다.
      const words = [parts[1], ...parts[2].split(' ')].filter(Boolean);
      for (let k = words.length; k > 1; k--) {
        const cand = words.slice(0, k).join(' ');
        if ((vehicle?.variants || []).some(v => squash(v.model) === squash(cand))) { parts[1] = cand; parts[2] = words.slice(k).join(' '); break; }
      }
    }
    const [no, model, gen = '', year = '', code = ''] = parts;
    return { no: bareNoOf(no.replace(/번/g, '')), model, gen, year, code };   // 'No.K107번-2' → K107-2
  }
  // 차종으로 제조사를 정한다 — 좌측 목록(카테고리)이나 카탈로그에서 그 차종을 가진 제조사가 하나일 때만.
  function brandOfModel(model) {
    const m = squash(model);
    const hits = new Set(brandList.filter(b => api.modelsOf(b).some(x => squash(x) === m)));
    if (!hits.size) for (const v of vehicle?.variants || []) if (squash(v.model) === m) {
      const b = brandList.find(x => vehicleBrandKey(x) === vehicleBrandKey(v.brand)); if (b) hits.add(b);
    }
    return hits.size === 1 ? [...hits][0] : '';
  }
  function fillDbLine(doc, row) {
    const brand = brandOfModel(row.model);
    if (brand) setField(doc, 'inp-brand', brand);
    setField(doc, 'inp-carmodel', row.model);
    forgetRow(doc);
    forgetCar(doc);
    for (const [id, key] of [['inp-gen', 'gen'], ['inp-year', 'year'], ['inp-code', 'code'], ['inp-no', 'no']]) setField(doc, id, row[key]);
    applyGeneratedSku(doc);
    refreshListingLists(doc);
    refreshCoupangList(doc);
  }

  // 본사몰 상품 찾기 칸: 차량 DB(카탈로그) 한 행 → 좌측 칸 전부. 브랜드·차종은 좌측 목록의 표기로 넣는다(resolveTitle 과 같다).
  // 브랜드·차종부터 넣는다 — bindShell 의 sync·onModel 이 앞 차의 행·SKU 를 버리고 행 목록을 이 차로 다시 만든다.
  // pickVariant 는 그 뒤라야 방금 채운 칸이 지워지지 않는다. 같은 브랜드·차종이면 sync 가 안 버리니 여기서 버린다.
  const dbLabel = v => [v.no ? `No.${v.no}번` : '', v.brand, v.model, v.gen, v.year, v.code].filter(Boolean).join(' · ');
  function pickRow(doc, v) {
    const bk = vehicleBrandKey(v.brand), m = squash(v.model);
    const brand = brandList.find(b => vehicleBrandKey(b) === bk) || v.brand;
    const model = api.modelsOf(brand).filter(x => m.includes(squash(x))).sort((x, y) => squash(y).length - squash(x).length)[0] || v.model;
    setField(doc, 'inp-brand', brand);
    setField(doc, 'inp-carmodel', model);
    if (store(doc).variant !== v) forgetCar(doc);
    pickVariant(doc, v);
  }

  // 고른 차와 BSA 여부에 맞는 SKU·판매가를 채운다. 사람이 직접 적은 값(vuAuto 없음)은
  // 건드리지 않고, 우리가 채웠던 값만 갈아 끼우거나 비운다 — 차를 바꿨는데 앞 차의 SKU 가
  // 남아 있으면 그 SKU 로 올라가 앞 차 리스팅을 덮어쓴다.
  function reapplyListing(doc) {
    const v = store(doc).variant;
    if (!v) return;
    const bsa = shellBsa(doc);
    const hit = listingFor(v, bsa), amz = listingFor(v, bsa, v.amazonSkus ? 'amazonSkus' : 'skus');
    // 판매가는 이베이 SKU 의 지금 몰 값(없으면 표 값), 이베이 SKU 가 없는 차는 아마존 SKU 의 것
    const priced = hit ? priceOf(hit, false) : amz ? priceOf(amz, true) : null;
    const fill = [['inp-sku', hit ? hit.sku : ''], ['inp-amz-sku', amz ? amz.sku : ''], ['inp-usd', priced ? usd(priced.price) : '']];
    for (const [id, val] of fill) {
      const el = doc.getElementById(id);
      if (!el) continue;
      if (el.value.trim() && el.dataset.vuAuto !== '1') continue;
      setField(doc, id, val, true);
      delete el.dataset.vuGenerated;   // 리스팅 값(또는 빈 칸) — 아래에서 비었으면 다시 만든다
    }
    applyGeneratedSku(doc);
    refreshListingLists(doc);
  }

  // ── 쿠팡 ────────────────────────────────────────────────────────────
  // 쿠팡에는 SKU 가 없다. 상품(등록상품ID) 하나가 차종 하나이고 그 안에 세대별 옵션이 딸린다.
  // 그래서 쿠팡 쪽 열쇠는 '이 차종의 상품ID' 다 — 수정할 때 그 상품을 열고, 신규 등록 때는
  // 이미 있으면 중복을 막는다.
  function coupangFor(brand, model) {
    if (!vehicle || !Array.isArray(vehicle.coupang)) return [];
    const b = vehicleBrandKey(brand);
    if (!b) return [];
    const rows = vehicle.coupang.filter(p => vehicleBrandKey(p.brand) === b);
    const m = squash(model);
    if (!m) return rows;
    // 이름 표기가 서로 조금씩 달라(쿠팡 '캠리 4세대' ↔ 코드표 '캠리') 어느 쪽이 포함해도 같은 차로 본다.
    const exact = rows.filter(p => squash(p.model) === m);
    const part = rows.filter(p => {
      const pm = squash(p.model);
      return pm && pm !== m && (pm.indexOf(m) !== -1 || m.indexOf(pm) !== -1);
    });
    return exact.concat(part);
  }

  // 고른 차가 '확실히' 들어 있는 쿠팡 상품 하나. 같은 차종 상품 가운데 이 상품번호 옵션을
  // 가진 것이 딱 하나일 때만. 둘 이상이면(쿠팡에 같은 차가 중복 등록돼 있다) 고르지 않는다.
  function coupangProductFor(v, shellModel) {
    const cands = coupangFor(v.brand, v.model).concat(coupangFor(v.brand, shellModel));
    const uniq = [...new Map(cands.map(p => [p.id, p])).values()];
    const withNo = uniq.filter(p => p.options.some(o => o.no === v.no));
    return withNo.length === 1 ? withNo[0] : null;
  }

  function reapplyCoupang(doc) {
    const v = store(doc).variant;
    const el = doc.getElementById('inp-cpid');
    if (!v || !el) return;
    if (el.value.trim() && el.dataset.vuAuto !== '1') { refreshCoupangList(doc); return; }   // 사람이 적은 값
    const model = (doc.getElementById('inp-carmodel') || {}).value || '';
    const p = coupangProductFor(v, model);
    setField(doc, 'inp-cpid', p ? p.id : '', true);
    refreshCoupangList(doc);   // 상품번호가 방금 정해졌다 — 'No.○ 있음' 표시를 다시 단다
  }

  // 목록: 지금 차종의 쿠팡 상품. 적힌 상품번호 옵션을 가진 상품을 위로 올리고 표시한다.
  function refreshCoupangList(doc) {
    const val = id => { const el = doc.getElementById(id); return el ? el.value : ''; };
    const no = bareNoOf(val('inp-no'));
    const has = p => !!no && p.options.some(o => o.no === no);
    const prods = coupangFor(val('inp-brand'), val('inp-carmodel')).slice().sort((a, b) => has(b) - has(a));
    // 그 번호 옵션의 지금 쿠팡 판매가(앱이 가격 API 로 읽어 둔 값)가 있으면 같이 보인다.
    const nowPrice = p => {
      const prices = p.options.filter(o => o.no === no).map(o => Number(live?.coupang?.[o.id]?.price)).filter(x => x > 0);
      return prices.length ? ` · 지금 ${[...new Set(prices)].map(won).join('/')}원` : '';
    };
    api.setOptions(doc, 'vu-cpid', prods.map(p => ({
      label: `${p.id} · ${p.model || p.name} · 옵션 ${p.options.length}개${has(p) ? ` · No.${no} 있음${nowPrice(p)}` : ''}`,
      value: p.id,
      pick: () => { const el = doc.getElementById('inp-cpid'); if (el) delete el.dataset.vuAuto; },
    })));
  }

  // SKU 를 목록에서 고르면 판매가와 BSA 도 그 리스팅을 따른다. 셋이 어긋나면 BSA 상품이
  // 일반 가격·일반 SKU 로 올라간다. 목록에서 고른 것은 사람의 결정이라 자동 표시를 뗀다.
  // field: 이베이 SKU 칸(inp-sku) 또는 아마존 SKU 칸(inp-amz-sku). 어느 쪽에서 골라도 판매가는 고른 리스팅을 따른다.
  function pickListing(doc, l, field = 'inp-sku') {
    setField(doc, 'inp-usd', usd(priceOf(l, field === 'inp-amz-sku').price));
    for (const id of [field, 'inp-usd']) {
      const el = doc.getElementById(id);
      if (el) delete el.dataset.vuAuto;
    }
    // change 를 쏘지 않는다 — 쏘면 reapplyListing 이 방금 고른 SKU 를 도로 바꾼다.
    const radio = doc.querySelector(`input[name="bsa"][value="${l.bsa ? 'o' : 'x'}"]`);
    if (radio) radio.checked = true;
  }

  // SKU 후보: 적힌 상품번호를 쓰는 리스팅 전부. 번호가 아직 없으면 지금 차종의 행들이 쓰는
  // 번호 전부. 고른 차와 영문 차종이 같은 것을 위로 올린다(같은 번호를 다른 차종도 쓴다).
  function refreshListingLists(doc) {
    const val = id => { const el = doc.getElementById(id); return el ? el.value : ''; };
    const no = bareNoOf(val('inp-no'));
    let cands = no ? (listingsByNo.get(no) || []) : [];
    if (!cands.length && !no) {
      const nos = new Set(variantsFor(val('inp-brand'), val('inp-carmodel')).map(v => v.no));
      cands = [].concat(...[...nos].map(n => listingsByNo.get(n) || []));
    }
    const v = store(doc).variant;
    const mine = v ? modelKeyEn(v.modelEn) : '';
    const rank = l => (mine && modelKeyEn(l.modelEn) === mine) ? 0 : 1;
    cands = cands.slice().sort((a, b) => rank(a) - rank(b));

    // 이베이 칸은 이베이 표의 SKU, 아마존 칸은 아마존에 실제로 있는 SKU(asin). 아마존 실측값 없이 구운
    // 카탈로그(asin 이 하나도 없음)면 예전처럼 두 칸이 같은 목록을 쓴다.
    // 판매가·재고는 지금 몰 값(API 로 받아 둔 것)이 있으면 그것, 없으면 표 값이다. 어느 쪽인지 적는다.
    const row = (l, field, extra) => {
      const p = priceOf(l, field === 'inp-amz-sku');
      const now = p.where ? ` 지금 ${LIVE_NAME[p.where]}${p.stock !== '' && p.stock != null ? ` · 재고 ${p.stock}` : ''}` : ' (표)';
      return {
        label: `${l.sku} · ${l.modelEn} ${l.yearText || '(연식 원본 확인 필요)'} · $${usd(p.price)}${now}${extra}`,
        value: l.sku,
        pick: () => pickListing(doc, l, field),
      };
    };
    api.setOptions(doc, 'vu-sku', cands.filter(l => l.source !== 'amazon').map(l => row(l, 'inp-sku', '')));
    api.setOptions(doc, 'vu-amz-sku', cands.filter(l => !amazonKnown || l.asin).map(l => row(l, 'inp-amz-sku', l.asin ? ` · ASIN ${l.asin}` : '')));

    // 판매가: 후보들이 쓰는 값(지금 몰 값 우선). 없으면 표의 두 기본값(일반 109.32 / BSA 160.34).
    const byPrice = new Map(), livePrices = new Set();
    for (const l of cands) {
      const p = priceOf(l, false);
      if (typeof p.price !== 'number' || !isFinite(p.price)) continue;
      byPrice.set(usd(p.price), l.bsa);
      if (p.where) livePrices.add(usd(p.price));
    }
    if (!byPrice.size) { byPrice.set('109.32', false); byPrice.set('160.34', true); }
    api.setOptions(doc, 'vu-usd', [...byPrice.keys()].sort((a, b) => a - b).map(p => ({
      label: `${p} · ${byPrice.get(p) ? 'BSA' : 'BSA 없음'}${livePrices.has(p) ? ' · 지금 몰 판매가' : ''}`,
      value: p,
    })));
    store(doc).listingPrices = byPrice;
    store(doc).listingLive = livePrices;
    refreshEditPriceLists(doc);
  }

  // ── 단일 상품 수정의 변경 판매가 (원 · USD · 엔) ──────────────────────
  // 일괄 수정이 몰 탭에 불러온 상품의 판매가로 넣고 저장한다(index_up.html runBulkEdit). 목록은 국내 기준가
  // 등급('환율' 탭의 환율 자동 변경 등급표)과 그 환율가, USD 는 이베이 표의 판매가까지다.
  // 이 칸들은 스스로 채우지 않는다 — 비워 두는 것이 '판매가는 그대로' 라는 뜻이라, 차를 고를 때 표의 값을
  // 채우면 표의 옛 가격(109.32)이 환율로 바뀐 지금 가격(110) 위에 저장된다.
  let priceTiers = [];
  const won = n => Number(n).toLocaleString('ko-KR');
  // 목록 맨 위에는 좌측 SKU·쿠팡 상품의 '지금 몰 판매가'(API 로 받아 둔 값)를 둔다 — 무엇을 바꾸는지 보고 고른다.
  function refreshEditPriceLists(doc) {
    const name = t => t.label || '등급';
    const val = id => { const el = doc.getElementById(id); return el ? el.value.trim() : ''; };
    const now = (sku, where, unit) => {
      const x = liveOf(sku, where), p = Number(x?.price);
      return p > 0 ? [{ label: `${won(p)}${unit} · 지금 ${LIVE_NAME[where]} 판매가 (${sku})`, value: String(p) }] : [];
    };
    // 쿠팡: 좌측 쿠팡 상품ID 의, 좌측 상품번호 옵션들의 지금 판매가(옵션ID = 쿠팡 판매가 캐시의 열쇠)
    const cp = vehicle && Array.isArray(vehicle.coupang) ? vehicle.coupang.find(p => p.id === val('inp-cpid')) : null;
    const no = bareNoOf(val('inp-no'));
    const cpNow = (cp?.options || []).filter(o => no && o.no === no).flatMap(o => {
      const p = Number(live?.coupang?.[o.id]?.price);
      return p > 0 ? [{ label: `${won(p)}원 · 지금 쿠팡 판매가 (${o.text})`, value: String(p) }] : [];
    });
    api.setOptions(doc, 'vu-edit-krw', cpNow.concat(priceTiers.map(t => ({
      label: `${won(t.krw)}원 · ${name(t)} (국내 기준가)`, value: String(t.krw),
    }))));
    const fx = (cur, unit) => priceTiers.filter(t => t.preview && t.preview[cur]).map(t => ({
      label: `${won(t.preview[cur])}${unit} · ${name(t)} 환율가 (국내 ${won(t.krw)}원)`, value: String(t.preview[cur]),
    }));
    const table = store(doc).listingPrices || new Map();
    const usdNow = now(val('inp-amz-sku'), 'US', ' USD').concat(now(val('inp-sku'), 'ebay', ' USD'));
    const shown = new Set(usdNow.map(x => Number(x.value)));
    const fromLive = store(doc).listingLive || new Set();
    api.setOptions(doc, 'vu-edit-usd', usdNow.concat(fx('USD', ' USD'),
      [...table.keys()].filter(p => !shown.has(Number(p))).sort((a, b) => a - b)
        .map(p => ({ label: `${p} USD · ${table.get(p) ? 'BSA' : 'BSA 없음'} (${fromLive.has(p) ? '지금 몰 판매가' : '이베이 표'})`, value: p }))));
    api.setOptions(doc, 'vu-edit-jpy', now(val('inp-amz-sku'), 'JP', '엔').concat(fx('JPY', '엔')));
  }

  const brandEntry = brand => {
    if (!names) return null;
    const key = nameBrandIndex[bkey(brand)];
    return key ? names.brands[key] : null;
  };
  const brandField = (brand, f) => {
    const japan = japanName(brand, '', f === 'jp' ? 'brandJa' : 'brandEn');
    if (japan !== undefined) return japan;
    const e = brandEntry(brand); return (e && e[f]) || null;
  };

  // 브랜드를 함께 받는 이유: 한국어 차종명이 브랜드를 넘나든다
  // (렉스턴·컨티넨탈·MKZ·콜로라도 등). 평면 키로 찾으면 다른 브랜드 값이 나온다.
  function modelField(brand, model, f) {
    const japan = japanName(brand, model, f === 'jp' ? 'modelJa' : 'modelEn');
    if (japan !== undefined) return japan;
    if (!names) return null;
    const key = nameBrandIndex[bkey(brand)];
    const entry = key && (names.models[key] || {})[nz(model)];
    return (entry && entry[f]) || null;
  }

  // 세대는 2단 조회. 앱은 세대(inp-gen)와 연식(inp-year)을 따로 받는데 CSV 는
  // '5세대 전기형 05.05~09.02' 로 합쳐 두어서, exact 맵에 없는 조합이 흔하다.
  function genField(gen, f) {
    if (!names) return null;
    const key = nz(gen);
    if (!key) return null;
    const exact = (names.generations || {})[key];
    if (exact && exact[f]) return exact[f];
    if (f !== 'jp') return null;                 // 토큰 치환은 일본어에만 있다
    let out = key;
    let hit = false;
    genTokenPairs.forEach(p => {
      if (out.indexOf(p[0]) !== -1) { out = out.split(p[0]).join(p[1]); hit = true; }
    });
    // 치환이 없었거나 한글이 남았으면 번역이 안 된 것 — 지어내지 말고 없음으로 돌린다.
    if (!hit || /[가-힣]/.test(out)) return null;
    return out;
  }

  const api = {
    BIKE_BRANDS,
    GEN_PRESETS,

    setCatalog(categories) {
      if (!categories || typeof categories !== 'object') return false;
      catalog = categories;
      reindex();
      return true;
    },

    // iframe 쪽처럼 셸에서 데이터를 받지 못하는 문맥에서 직접 읽는다.
    // 오프라인·테스트 스텁이 {} 를 돌려줘도 예외 없이 빈 목록으로 떨어져야 한다.
    async loadCatalog(ipc) {
      try {
        const res = await ipc.invoke('imweb-load-categories');
        if (res && res.success && res.categories) return api.setCatalog(res.categories);
      } catch (e) { /* 무시하고 빈 목록 유지 */ }
      return false;
    },

    setNames(dict) {
      if (!dict || typeof dict !== 'object' || !dict.brands) return false;
      names = dict;
      reindexNames();
      return true;
    },

    // loadCatalog 과 같은 이유로 iframe 쪽에서도 직접 읽는다.
    async loadNames(ipc) {
      try {
        const res = await ipc.invoke('vehicle-load-i18n');
        if (res && res.success && res.names) return api.setNames(res.names);
      } catch (e) { /* 무시하고 빈 사전 유지 */ }
      return false;
    },

    namesReady() { return !!names; },

    // 아래 6개는 값이 없으면 빈 문자열이 아니라 null 을 돌려준다.
    // 호출부가 "사전에 없음" 경고를 띄워야 하므로 없음과 빈 값이 구분돼야 한다.
    brandJa(brand) { return brandField(brand, 'jp'); },
    brandEn(brand) { return brandField(brand, 'en'); },
    modelJa(brand, model) { return modelField(brand, model, 'jp'); },
    modelEn(brand, model) { return modelField(brand, model, 'en'); },
    genJa(gen) { return genField(gen, 'jp'); },
    genEn(gen) { return genField(gen, 'en'); },

    ready() { return !!catalog; },

    setVehicleCatalog(cat) {
      vehicle = (cat && Array.isArray(cat.variants)) ? cat : null;
      reindexVehicle();
      return !!vehicle;
    },
    setJapanMode(enabled, doc) {
      const changed = japanMode !== !!enabled;
      japanMode = !!enabled;
      if (changed && doc) {
        if (store(doc).variant?.source === 'japan') forgetCar(doc);
        api.refreshShell(doc);
      }
    },
    japanMode() { return japanMode; },
    japanSelection(doc) {
      const v = doc && store(doc).variant;
      if (!japanMode || v?.source !== 'japan') return null;
      const val = id => (doc.getElementById(id)?.value || '').trim();
      return japanBrandKey(val('inp-brand')) === japanBrandKey(v.brand)
        && squash(val('inp-carmodel')) === squash(v.model)
        && val('inp-gen') === v.gen && val('inp-year') === v.year && val('inp-code') === v.code ? v : null;
    },
    variantsFor,
    resolveTitle,
    parseDbLine,
    suggestSku,
    // 본사몰 상품 찾기 칸(inp-db-search)의 목록 = 차량 DB 전체 행. 아직 없는 차(신규 등록)도 나오고 아임웹은 읽지 않는다.
    setDbRows(doc) {
      api.setOptions(doc, 'vu-db', (vehicle?.variants || []).map(v => ({ label: dbLabel(v), value: dbLabel(v), pick: () => pickRow(doc, v) })));
    },
    // 표의 SKU 는 전부 대문자다. 소문자로 친 SKU 도 같은 리스팅으로 찾아야 BSA 확인·이베이 제목 후보가 빠지지 않는다.
    listing(sku) { return listingBySku.get(nz(sku).toUpperCase()) || null; },
    coupangFor,
    coupangProduct(id) {
      return (vehicle && Array.isArray(vehicle.coupang)) ? (vehicle.coupang.find(p => p.id === nz(id)) || null) : null;
    },
    // 변경 판매가 목록의 국내 기준가 등급. tiers 는 fx-auto-price-get 의 등급표({ krw, label, preview: { USD, JPY } | null }).
    // 환율을 못 받았으면 preview 가 없다 — 그때는 원화 등급과 이베이 표 판매가만 보인다.
    // 지금 몰 값(main 'vehicle-live-values'). SKU 열쇠는 대문자로 맞춘다(카탈로그 SKU 가 대문자다).
    setLiveValues(doc, data) {
      const items = x => Object.fromEntries(Object.entries(x?.items || {}).map(([k, v]) => [nz(k).toUpperCase(), v]));
      live = data ? {
        amazon: Object.fromEntries(Object.entries(data.amazon || {}).map(([k, v]) => [k, items(v)])),
        ebay: items(data.ebay), coupang: data.coupang?.items || {},
      } : null;
      if (doc) { refreshListingLists(doc); refreshCoupangList(doc); }
    },
    setPriceTiers(doc, tiers) {
      priceTiers = (Array.isArray(tiers) ? tiers : [])
        .filter(t => t && Number(t.krw) > 0)
        .map(t => ({ krw: Number(t.krw), label: norm(t.label), preview: t.preview && typeof t.preview === 'object' ? t.preview : null }))
        .sort((a, b) => a.krw - b.krw);
      if (doc) refreshEditPriceLists(doc);
    },

    // 브랜드·차종이 바뀔 때마다 연식·차량코드·상품번호 목록을 이 차의 행으로 다시 만든다.
    // 셋은 같은 행 목록을 보여 주되 칸마다 들어갈 값만 다르다.
    refreshVehicleLists(doc) {
      if (!doc) return;
      const val = id => { const el = doc.getElementById(id); return el ? el.value : ''; };
      const rows = variantsFor(val('inp-brand'), val('inp-carmodel'));
      const typed = squash(val('inp-carmodel'));
      const label = v => [squash(v.model) !== typed ? v.model : '', v.gen, v.year, v.code,
                          v.no ? `No.${v.no}` : '', v.source === 'japan' && v.bsa ? `BSA: ${v.bsa}` : ''].filter(Boolean).join(' · ');
      const items = field => rows.filter(v => v.source !== 'japan' || v[field]).map(v => ({ label: label(v), value: v[field] || '', pick: () => pickVariant(doc, v) }));
      api.setOptions(doc, 'vu-gen', rows.some(v => v.source === 'japan') ? items('gen') : GEN_PRESETS);
      api.setOptions(doc, 'vu-year', items('year'));
      api.setOptions(doc, 'vu-code', items('code'));
      api.setOptions(doc, 'vu-no', items('no'));
      refreshListingLists(doc);
      refreshCoupangList(doc);
    },
    brands() { return [...new Set([...brandList, ...(japanMode ? (vehicle?.japan?.variants || []).map(v => v.brand) : [])])].sort((a, b) => a.localeCompare(b, 'ko')); },
    nationalityOf(b) { return natIndex[norm(b)] || (japanRowsFor(b).length ? '수입차' : null); },
    isBikeBrand(b) { return !japanRowsFor(b).length && BIKE_BRANDS.indexOf(norm(b)) !== -1; },

    modelsOf(brand) {
      const b = norm(brand);
      const nat = natIndex[b];
      const base = nat ? ((catalog[nat] || {})[b] || []) : [];
      return [...new Set([...base, ...japanRowsFor(b).map(v => v.model)])];
    },

    // 목록 데이터만 보관한다. 실제 DOM 은 열릴 때 만든다 — 438개를 미리 그려둘 이유가 없다.
    // 값은 항상 textContent 로 넣는다: 카테고리 문자열은 아임웹에서 Open API 동기화(syncCategories)로
    // 받아 온 값이라 innerHTML 로 넣으면 항목 경계가 깨진다.
    setOptions(doc, listId, values) {
      store(doc).options.set(listId, (values || []).map(v => isRow(v) ? v : String(v)));
      const open = store(doc).open;
      if (open && open.listId === listId) renderList(doc, open);   // 열린 채로 갱신되면 즉시 반영
      return null;
    },

    attach(doc, inputId, listId, values) {
      const el = doc.getElementById(inputId);
      if (!el) return null;
      api.setOptions(doc, listId, values);
      el.removeAttribute('list');              // 예전 datalist 흔적이 남아 있으면 제거
      el.setAttribute('autocomplete', 'off');  // 브라우저 기록이 목록을 가리지 않게
      bindCombo(doc, el, listId);
      return el;
    },

    // 셸(index_up.html) 좌측 "상품 정보" 폼.
    // 브랜드가 실제로 바뀐 경우에만 차종 목록을 다시 만든다(키 입력마다 438개 재생성 금지).
    bindShell(doc) {
      if (!doc || !doc.body) return false;
      if (doc.body.dataset.vuShellBound === '1') { api.refreshShell(doc); return true; }

      api.attach(doc, 'inp-db-search', 'vu-db', []);   // 목록은 카탈로그가 오면 refreshShell 이 넣는다(setDbRows)
      const brandEl = api.attach(doc, 'inp-brand', 'vu-brand', api.brands());
      api.attach(doc, 'inp-carmodel', 'vu-carmodel', []);
      api.attach(doc, 'inp-gen', 'vu-gen', GEN_PRESETS);
      api.attach(doc, 'inp-year', 'vu-year', []);
      api.attach(doc, 'inp-code', 'vu-code', []);
      api.attach(doc, 'inp-no', 'vu-no', []);
      api.attach(doc, 'inp-sku', 'vu-sku', []);
      api.attach(doc, 'inp-amz-sku', 'vu-amz-sku', []);
      api.attach(doc, 'inp-usd', 'vu-usd', []);
      api.attach(doc, 'inp-cpid', 'vu-cpid', []);
      api.attach(doc, 'inp-edit-krw', 'vu-edit-krw', []);
      api.attach(doc, 'inp-edit-usd', 'vu-edit-usd', []);
      api.attach(doc, 'inp-edit-jpy', 'vu-edit-jpy', []);
      // 아마존 상품 유형. 두 값은 예전 아마존 탭 칸의 안내문 그대로다.
      api.attach(doc, 'inp-amz-ptype', 'vu-amz-ptype', ['AUTO_PART', 'VEHICLE_MIRROR']);

      const refreshRows = () => api.refreshVehicleLists(doc);
      const carEl = doc.getElementById('inp-carmodel');
      if (carEl) {
        // 차종이 실제로 바뀌면(빈 칸에서 처음 적는 것은 제외) 앞 차의 SKU·판매가·쿠팡ID 를 버린다.
        let lastModel = squash(carEl.value);
        const onModel = () => {
          const m = squash(carEl.value);
          if (m !== lastModel) { const had = lastModel; lastModel = m; if (had) { forgetRow(doc); forgetCar(doc); } }
          refreshRows();
        };
        carEl.addEventListener('input', onModel);
        carEl.addEventListener('change', onModel);
      }

      // 본사몰 상품 찾기에 DB 에 없는 차를 한 줄로 넣고 Enter · 칸 나가기 → 칸마다 나눠 넣는다(parseDbLine).
      // 영문 · 일문 칸은 셸의 자동 번역(autoFillLang)이 채운다. 목록에서 고를 때(vuChoosing)는 pickRow 가 한다.
      const dbEl = doc.getElementById('inp-db-search');
      if (dbEl) dbEl.addEventListener('change', () => {
        if (dbEl.dataset.vuChoosing === '1') return;
        const row = parseDbLine(dbEl.value);
        if (row) fillDbLine(doc, row);
      });
      // 상품번호를 손으로 바꾸면 고른 차는 더 이상 믿을 수 없다 — 그 차로 채웠던 SKU·판매가를
      // 비우고 SKU 후보를 새 번호로 바꾼다. (목록에서 고를 때는 vuChoosing 이라 여기 안 걸린다.)
      const noEl = doc.getElementById('inp-no');
      if (noEl) noEl.addEventListener('input', () => {
        if (noEl.dataset.vuChoosing === '1') return;
        forgetCar(doc);   // 번호가 바뀌면 다른 차다 — 사람이 고른 SKU 도 앞 번호의 것이다
        applyGeneratedSku(doc);
        refreshListingLists(doc);
        refreshCoupangList(doc);
      });
      // SKU·판매가·쿠팡 상품ID 를 손으로 고치면 그 뒤로는 자동으로 갈아 끼우지 않는다.
      for (const id of ['inp-sku', 'inp-amz-sku', 'inp-usd', 'inp-cpid']) {
        const el = doc.getElementById(id);
        if (el) el.addEventListener('input', () => {
          if (el.dataset.vuChoosing === '1') return;
          delete el.dataset.vuAuto; delete el.dataset.vuGenerated; el.classList.remove('vu-generated'); el.title = '';
        });
        // 변경 판매가 목록 맨 위의 '지금 몰 판매가' 는 이 칸들의 SKU·상품 것이다 — 바뀌면 다시 만든다.
        if (el && id !== 'inp-usd') el.addEventListener('input', () => refreshEditPriceLists(doc));
      }
      // BSA 를 바꾸면 같은 차의 BSA 판 / 일반 판 SKU·판매가로 갈아 끼운다.
      // 행 없이 친 차는 reapplyListing 이 건너뛰니 자동 생성 SKU 만 다시 정한다(BSA 에 따라 '이미 있음' 이 바뀐다).
      doc.querySelectorAll('input[name="bsa"]').forEach(r => r.addEventListener('change', () => {
        if (store(doc).variant) reapplyListing(doc); else applyGeneratedSku(doc);
      }));

      if (brandEl) {
        let lastBrand = null;
        const sync = () => {
          const b = norm(brandEl.value);
          if (b === lastBrand) return;
          const had = lastBrand;
          lastBrand = b;
          if (had) { forgetRow(doc); forgetCar(doc); }   // 브랜드가 바뀌면 앞 차의 고른 행·SKU·판매가·쿠팡ID 를 버린다
          api.setOptions(doc, 'vu-carmodel', api.modelsOf(b));
          refreshRows();
          // 브랜드로 자동차/오토바이를 자동 판정한다. 이 값이 제목 접두어와
          // ESM 폴더·네이버 템플릿·가격을 가른다.
          if (b && api.isBikeBrand(b)) {
            const bike = doc.getElementById('inp-kind-bike');
            if (bike && !bike.checked) { bike.checked = true; bike.dispatchEvent(new Event('change', { bubbles: true })); }
          } else if (b && api.nationalityOf(b)) {
            const car = doc.getElementById('inp-kind-car');
            if (car && !car.checked) { car.checked = true; car.dispatchEvent(new Event('change', { bubbles: true })); }
          }
        };
        brandEl.addEventListener('input', sync);
        brandEl.addEventListener('change', sync);
        sync();
      }

      // 목록이 있다는 것을 알 수 있게 한다 — list 속성이 붙은 input 은
      // 평범한 text input 과 시각적으로 구분되지 않는다.
      const hint = (id, text) => {
        const el = doc.getElementById(id);
        if (el && !/목록/.test(el.getAttribute('placeholder') || '')) {
          el.setAttribute('placeholder', text);
        }
      };
      hint('inp-brand', '예: 벤츠 (목록에서 선택 가능)');
      hint('inp-carmodel', '예: E클래스 (브랜드를 먼저 고르세요)');
      hint('inp-gen', '예: 1세대 전기형 (목록에서 선택 가능)');
      hint('inp-year', '예: 12.03~19.05 (목록에서 선택)');
      hint('inp-code', '예: F20/F21 (목록에서 선택)');
      hint('inp-no', '예: 101 (목록에서 선택)');
      hint('inp-sku', '예: OBM0103N101 (목록에서 선택)');
      hint('inp-amz-sku', '예: OBM0103N101 (목록에서 선택)');
      hint('inp-usd', '예: 109.32 (목록에서 선택)');
      hint('inp-cpid', '이미 올라간 상품 (목록에서 선택)');
      for (const id of ['inp-edit-krw', 'inp-edit-usd', 'inp-edit-jpy']) hint(id, '비우면 지금 가격 그대로 (목록에서 선택)');

      doc.body.dataset.vuShellBound = '1';
      return true;
    },

    // 카탈로그가 늦게 도착했을 때 목록만 다시 채운다.
    refreshShell(doc) {
      if (!doc || !doc.body) return;
      api.setOptions(doc, 'vu-brand', api.brands());
      const brandEl = doc.getElementById('inp-brand');
      if (brandEl) api.setOptions(doc, 'vu-carmodel', api.modelsOf(brandEl.value));
      api.refreshVehicleLists(doc);
      api.setDbRows(doc);
    },

    // iframe(index.html) 안의 제목 표기 칸.
    // 브랜드/차종 컨텍스트는 셸의 입력값을 1순위로 읽는다 — 폼의 브랜드 select 는
    // 빈 placeholder 옵션이 없어 항상 첫 브랜드가 선택돼 있으므로 신뢰할 수 없다.
    bindFrame(doc) {
      if (!doc || !doc.body) return false;
      if (doc.body.dataset.vuFrameBound === '1') { api.refreshFrame(doc); return true; }
      api.attach(doc, 'iwTitleBrand', 'vu-title-brand', brandList);
      api.attach(doc, 'iwTitleModel', 'vu-title-model', api.modelsOf(api.shellBrand(doc)));
      doc.body.dataset.vuFrameBound = '1';
      return true;
    },

    refreshFrame(doc) {
      if (!doc || !doc.body) return;
      api.setOptions(doc, 'vu-title-brand', brandList);
      api.setOptions(doc, 'vu-title-model', api.modelsOf(api.shellBrand(doc)));
    },

    shellBrand(doc) {
      try {
        const host = (doc.defaultView && doc.defaultView.parent && doc.defaultView.parent.document) || null;
        const el = host && host.getElementById('inp-brand');
        if (el) return norm(el.value);
      } catch (e) { /* 크로스 문맥 접근 실패 시 무시 */ }
      return '';
    },
  };

  window.VUSuggest = api;

  // iframe 문맥에서는 스스로 카탈로그를 읽어 둔다(셸은 자기 데이터를 setCatalog 로 넘긴다).
  if (window.parent !== window) {
    try {
      const req = (typeof require !== 'undefined') ? require
                : (window.parent && window.parent.require) ? window.parent.require : null;
      if (req) {
        const ipc = req('electron').ipcRenderer;
        api.loadCatalog(ipc).then(ok => {
          if (ok && document.body) api.bindFrame(document);
        });
        // 사전은 자동완성과 무관하므로 따로 태운다 — 늦게 와도 bindFrame 을 막지 않는다.
        api.loadNames(ipc);
      }
    } catch (e) { /* 비 Electron 환경 */ }
  }
})();
