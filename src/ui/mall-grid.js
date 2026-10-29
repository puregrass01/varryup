// 단일 상품 수정의 기본 화면 — 여섯 몰 카드(2 × 3). 셸(index_up.html)이 좌측에서 고른 상품의 열쇠로 여섯 몰을 한꺼번에 불러온다.
// 카드 칸은 그 몰 API 가 실제로 바꾸는 값만이다. 못 바꾸는 값(상품번호 · SKU)은 회색 글 + 이유로만 보인다.
// 카드 칸은 그 몰 탭의 상태 · 칸에 바로 쓰고 저장도 탭의 저장 함수를 부른다 — 검사는 탭 한 곳에 남는다. 그래서 전체 탭에서 고친 값도
// 카드에 '바뀜' 으로 보인다. 구역이 여럿인 자사몰(한국 · 미국 · 일본) · 아마존(미국 · 일본)은 상품 일괄 수정 채널
// (bulk-price-load-many · bulk-save-batch)을 구역마다 탄다. 이베이 이미지도 같은 채널이다(탭의 이미지 초안은 ebay.js 안에 있다).
// 저장은 바뀐 칸만 보내고, 보내기 전에 '몰 / 칸 / 이전 → 새' 를 묻는다(실제 판매 중인 몰이다). 결과는 카드마다 한 줄 + 셸 로그.
(() => {
  const ipc = ipcRenderer;   // index.html 의 것
  const $ = id => document.getElementById(id);
  const MALLS = [
    { id: 'own', name: '아임웹 자사몰', logo: 'logos/imweb.png', cell: ['KOREA', 'own'] },
    { id: 'b2b', name: '아임웹 B2B몰', logo: 'logos/b2b.png', cell: ['KOREA', 'b2b'] },
    { id: 'naver', name: '네이버', logo: 'logos/naver.png', cell: ['KOREA', 'open1'] },
    { id: 'coupang', name: '쿠팡', logo: 'logos/coupang.png', cell: ['KOREA', 'open2'] },
    { id: 'amazon', name: '아마존', logo: 'logos/amazon.png', cell: ['USA', 'open1'] },
    { id: 'ebay', name: 'eBay 미국', logo: 'logos/ebay.png', cell: ['USA', 'open2'] },
  ];
  const OWN_REGIONS = [['imweb-ko', '한국', 'KRW'], ['imweb-en', '미국', 'USD'], ['imweb-jp', '일본', 'JPY']];
  const AMZ_MARKETS = [['amazon-us', '미국', 'USD'], ['amazon-jp', '일본', 'JPY']];
  // cards[id]: { status: idle|loading|missing|pick|error|ready, note, rows, result, before: Map(칸 → 불러온 값), owner, applied }
  const cards = {};
  let gen = 0, busy = false, lastKeys = {}, prices = {}, priceOpts = {};

  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const same = (a, b) => {
    a = String(a ?? '').trim(); b = String(b ?? '').trim();
    return a === b || (a !== '' && b !== '' && !isNaN(a) && !isNaN(b) && Number(a) === Number(b));
  };
  const urlsOf = list => (list || []).map(x => String(x?.url ?? x ?? ''));
  const refuse = msg => ({ ok: false, error: `${msg} — 아무것도 보내지 않았습니다.` });
  // 카드에 칸이 없는데 탭의 저장이 같이 보내는 값(전체 탭에서만 고친다)
  const b2bOptSig = () => JSON.stringify([iwB2bEditState.sharedGroups, iwB2bEditState.products.map(p => p.combos)]);
  const cpOptSig = () => JSON.stringify(cpEditState.options.map(o => [o.isNew, o.itemName, (o.attrs || []).map(a => a.value), o.imageUrl]));
  const log = (mall, msg, type) => window.forwardLogToShell?.(mall.name, msg, type);
  const say = text => { $('mgStatus').textContent = text; };
  const until = async (done, ms = 120000) => {
    for (const end = Date.now() + ms; !done();) {
      if (Date.now() > end) throw new Error('응답을 기다리다 멈췄습니다 — 전체 탭에서 확인하세요');
      await new Promise(r => setTimeout(r, 100));
    }
  };
  // 탭의 입력칸을 카드 칸으로 쓴다. input 을 쏴서 탭 쪽 표시(환율 풍선 등)도 같이 바뀌게 한다.
  const tabField = (key, label, id, type = 'text') => ({ key, label, type, get: () => $(id)?.value ?? '',
    set: v => { const t = $(id); t.value = v; t.dispatchEvent(new Event('input', { bubbles: true })); } });

  // 구역(scope)마다 bulk-save-batch 한 번. 확인된 줄만 불러온 값(before)으로 삼는다 — 다시 누르면 실패한 줄만 간다.
  // 한 칸이 여러 구역으로 가면(아마존 이미지 미국 · 일본) 다 된 뒤에만 — 미국만 되고 일본이 실패하면 그 칸은 '바뀜' 으로 남는다
  // (다시 보내도 이미 된 미국은 같은 목록이라 UNCHANGED 로 끝난다).
  // list: [{ scope, key, value, label, job, after?(data) }]
  async function sendJobs(card, list) {
    const failed = [], done = [], ok = [];
    for (const scope of [...new Set(list.map(x => x.scope))]) {
      const mine = list.filter(x => x.scope === scope);
      let res;
      try { res = await ipc.invoke('bulk-save-batch', { jobId: crypto.randomUUID(), scope, jobs: mine.map(x => x.job) }); }
      catch (e) { res = { success: false, error: e?.message || String(e) }; }
      mine.forEach((x, i) => {
        const r = res?.success ? (res.data?.results || []).find(y => y.index === i) : null;
        if (r?.success && ['VERIFIED', 'UNCHANGED', 'ACCEPTED'].includes(r.data?.status)) {
          ok.push(x); x.after?.(r.data); done.push(x.label);
        } else {
          x.failed = true;
          failed.push(`${x.label}: ${!res?.success ? res?.error || '알 수 없는 오류'
            : r ? r.error || r.data?.message || r.data?.status : '보내지 않음(' + (res.data?.stopped || '앞 줄에서 멈춤') + ')'}`);
        }
      });
    }
    ok.filter(x => !list.some(y => y.failed && y.key === x.key)).forEach(x => card.before.set(x.key, x.value));
    return failed.length ? { ok: false, partial: done.length > 0, error: failed.join(' · ') } : { ok: true };
  }
  // bulk-price-load-many 한 상품의 줄들. 없으면 { error }.
  async function loadRows(scope, id, includeImages) {
    let res;
    try { res = await ipc.invoke('bulk-price-load-many', { scope, ids: [String(id)], includeImages }); }
    catch (e) { res = { success: false, error: e?.message || String(e) }; }
    const item = res?.success ? res.data?.items?.[0] : null;
    return item?.rows ? { rows: item.rows } : { error: (res?.success ? item?.error || res.data?.blocked : res?.error) || '결과가 비어 있습니다' };
  }

  // 좌측 SKU 가 비었으면 몰 목록에서 상품번호로 찾는다. SKU 끝이 'N' + 상품번호(FD0905N1108)이거나 상품명에 '[No.번호]'.
  // 부분 일치('N612' 가 'N6120' 에도)는 버린다. 하나면 바로 불러오고, 여럿(BSA 판 등)이면 카드 안 표에서 고른다.
  async function findBySkuNo(scopes, no, mallName, pick) {
    if (!no) return { missing: `좌측 ${mallName} SKU · 상품번호가 없습니다` };
    const esc = no.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const bySku = new RegExp('N' + esc + '$', 'i'), byName = new RegExp('\\[No\\.' + esc + '(?:\\(옵\\))?\\]', 'i');
    for (const scope of scopes) {
      const res = await ipc.invoke('bulk-price-list', { scope, query: no });
      if (!res?.success) throw new Error(res?.error || '목록을 읽지 못했습니다');
      const seen = new Set(), items = (res.data?.items || []).filter(p => {
        const sku = String(p.sku || p.id || '');
        if (seen.has(sku) || !(bySku.test(sku) || byName.test(p.name || ''))) return false;
        seen.add(sku);
        return true;
      });
      if (items.length) return items.length > 1 ? { pick: items } : pick(items[0]);
    }
    return { missing: `${mallName}에 상품번호 ${no} SKU 가 없습니다` };
  }

  // ── 몰마다: load(card, keys) → undefined(불러옴) | { missing } | { pick: rows } · pick(card, row) · fields · images · info · save ──
  const ADAPTERS = {
    // 아임웹 자사몰: 상품번호(prodNo)는 세 구역이 같다. 구역마다 상품명 + 1set 조합가. 상세 이미지는 구역마다 따로라 한국 구역만.
    own: {
      async load(card, { no }) {
        if (!no) return { missing: '좌측 상품번호가 없습니다' };
        const res = await ipc.invoke('bulk-price-list', { scope: 'imweb-ko', query: 'no.' + no });
        if (!res?.success) throw new Error(res?.error || '목록을 읽지 못했습니다');
        // 목록 검색은 부분 일치라 '[No.104]' 가 '[No.1041]' 에도 걸린다 — 이름의 '[No.번호]' · '[No.번호(옵)]' 만(imweb-head.js 와 같다).
        const exact = new RegExp('\\[No\\.' + no.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:\\(옵\\))?\\]', 'i');
        const items = (res.data?.items || []).filter(p => exact.test(p.name));
        if (!items.length) return { missing: `본사몰에 [No.${no}] 상품이 없습니다` };
        return items.length > 1 ? { pick: items } : this.pick(card, items[0]);
      },
      async pick(card, item) {
        card.regions = [];
        for (const [scope, label, currency] of OWN_REGIONS) {   // 아임웹 토큰은 하나 — 구역은 차례로 읽는다
          const { rows, error } = await loadRows(scope, item.id, scope === 'imweb-ko');
          if (!rows) { card.regions.push({ scope, label, error }); continue; }
          // 구역마다 옵션 값이 번역돼 있다(imweb_unit_names.js: 1set · 1세트(운전석+조수석) · 1セット(左右)). 1set 조합이 여럿이면
          // (BSA 없음 / 1set · BSA 있음 / 1set) 하나만 고치면 나머지가 그대로라 칸을 만들지 않는다.
          const base = rows.find(r => !r.optionId) || rows[0], sets = rows.filter(r => r.optionId && /1\s*(set|세트|セット)/i.test(r.variant || ''));
          const set = sets.length === 1 ? sets[0] : null;
          card.regions.push({ scope, label, currency, id: base.id, name: base.name ?? '', setId: set?.optionId, price: set?.price ?? '', sets: sets.length,
            images: base.images || [], revision: base.imageRevision });
        }
        if (card.regions.every(r => r.error)) throw new Error(card.regions[0].error);
        card.imagesNow = [...(card.regions[0].images || [])];
      },
      fields: card => card.regions.filter(r => !r.error).flatMap(r => [
        { key: r.scope + ':name', label: `${r.label} 상품명`, get: () => r.name, set: v => { r.name = v; } },
        ...(r.setId ? [{ key: r.scope + ':set', label: `${r.label} 1set (${r.currency})`, type: 'number', step: r.currency === 'USD' ? '0.01' : '1',
          get: () => r.price, set: v => { r.price = v; } }] : []),
      ]),
      info: card => [
        `상품번호 ${card.regions.find(r => r.id)?.id} — 아임웹이 매긴 번호라 바꿀 수 없음`,
        ...card.regions.filter(r => r.error).map(r => `${r.label} 구역: 불러오지 못함 — ${r.error}`),
        ...card.regions.filter(r => !r.error && !r.setId).map(r => `${r.label} 구역: 1set 조합이 ${r.sets ? `${r.sets}개라` : '없어'} 판매가는 전체 탭에서`),
        '운전석 · 조수석 가격은 전체 탭에서',
      ],
      images: card => (card.regions[0].error ? null : { label: '상세 이미지 (한국 구역)', note: '미국 · 일본 구역의 상세 이미지는 따로입니다 — 전체 탭에서',
        scope: 'imweb-ko', get: () => card.imagesNow, set: urls => { card.imagesNow = [...urls]; } }),
      async save(card, changes) {
        const list = [], ko = card.regions[0];
        for (const c of changes) {
          if (c.key === 'images') {
            if (!card.imagesNow.length) return refuse('상세 이미지는 최소 1장 필요합니다');
            list.push({ scope: 'imweb-ko', key: 'images', value: [...card.imagesNow], label: c.field, after: d => { ko.revision = d.revision || ko.revision; },
              job: { type: 'images', id: ko.id, urls: [...card.imagesNow], expectedRevision: ko.revision } });
            continue;
          }
          const [scope, what] = c.key.split(':'), r = card.regions.find(x => x.scope === scope), value = String(c.to).trim();
          if (what === 'name') {
            // [No.번호] 를 지우면 탭 찾기 · 신규 등록 중복 검사에서 빠져 같은 차가 또 만들어진다(imweb-head.js 와 같은 막기).
            const tag = String(c.from).match(/\[No\.[^\]]+\]/i)?.[0];
            if (!value) return refuse(`${c.field}이 비어 있습니다`);
            if (tag && !value.includes(tag)) return refuse(`${c.field}에 ${tag} 를 남겨 주세요 — 찾기 · 중복 검사가 이 표시로 상품을 찾습니다`);
            list.push({ scope, key: c.key, value, label: c.field, job: { type: 'name', id: r.id, newName: value, expectedName: c.from } });
          } else {
            list.push({ scope, key: c.key, value, label: c.field, job: { type: 'price', id: r.id, optionId: r.setId, newPrice: value, expectedPrice: c.from } });
          }
        }
        return sendJobs(card, list);
      },
    },

    // 아임웹 B2B몰: 세트 + 개별 두 상품이 한 묶음(탭의 iwB2bEditState). 조합 가격 · 옵션은 전체 탭에서.
    b2b: {
      async load(card, { no }) {
        if (!no) return { missing: '좌측 상품번호가 없습니다' };
        const res = await ipc.invoke('imweb-search-products', { brand: '', model: '', code: no, idx: '' });
        if (!res?.success) {
          if (/찾지 못했습니다/.test(res?.error || '')) return { missing: res.error };
          throw new Error(res?.error || '검색 실패');
        }
        const rows = (res.groups || []).map(g => ({ id: g.items.map(i => i.prodNo).join('+'), name: g.baseKey, prodNos: g.items.map(i => i.prodNo) }));
        if (!rows.length) return { missing: `B2B몰에 상품 코드 ${no} 가 없습니다` };
        return rows.length > 1 ? { pick: rows } : this.pick(card, rows[0]);
      },
      async pick(card, item) {
        if (card.gen !== gen) return;   // 찾는 사이 다른 상품을 골랐다 — 탭 상태(뒤에 고른 상품)를 덮지 않는다
        const was = iwB2bEditState;
        await loadImwebB2bGroup(item.prodNos);
        if (!iwB2bEditState || iwB2bEditState === was) throw new Error('불러오지 못했습니다 — 로그를 보세요');
      },
      owner: () => iwB2bEditState,
      // 옵션 · 조합은 카드에 없지만 저장(imweb-update-group)은 탭의 것을 통째로 보낸다 — 전체 탭에서 고쳤으면 확인 목록에 한 줄로.
      snapshot(card) { card.optSig = b2bOptSig(); },
      more: card => (b2bOptSig() === card.optSig ? [] : [{ key: 'opts', field: '옵션 · 조합 가격 · 재고 (전체 탭에서 고침)', from: '불러온 값', to: '전체 탭의 값' }]),
      fields: () => [
        tabField('title', '상품명 (세트 · 개별 공통)', 'iwB2bEditTitle'),
        ...iwB2bEditState.products.map(p => ({ key: 'price:' + p.prodNo, label: `${p.type === 'set' ? '세트' : p.type === 'indiv' ? '개별' : '기타'} 판매가 (원)`,
          type: 'number', get: () => p.price, set: v => { p.price = v; renderImwebB2bOptions(); } })),
      ],
      info: () => [`상품번호 ${iwB2bEditState.products.map(p => p.prodNo).join(' · ')} — 아임웹이 매긴 번호라 바꿀 수 없음`, '옵션 · 조합 가격은 전체 탭에서'],
      images: () => ({ label: '상세 이미지 (세트 · 개별 공통)', scope: 'imweb-b2b', get: () => urlsOf(iwB2bEditState.detailImages),
        set: urls => { iwB2bEditState.detailImages = [...urls]; renderImwebB2bImages(); } }),
      save: () => updateImwebB2bProduct(),
    },

    // 네이버: 탭의 ssEditState. 찾기(제조사 · 차종)는 상품 목록 전체를 훑는 무거운 조회라 상품을 고를 때만 돈다.
    naver: {
      async load(card, { brand, model }) {
        if (!brand && !model) return { missing: '좌측 브랜드 · 차종이 없습니다' };
        const res = await ipc.invoke('smartstore-find-id', { brand, model });
        if (!res?.success) throw new Error(res?.error || '찾기 실패');
        const rows = res.rows || [];
        if (!rows.length) return { missing: `스마트스토어에 "${[brand, model].join(' ').trim()}" 상품이 없습니다` };
        return rows.length > 1 ? { pick: rows } : this.pick(card, rows[0]);
      },
      async pick(card, item) {
        if (card.gen !== gen) return;   // 무거운 찾기 사이 다른 상품을 골랐다 — 탭 상태(뒤에 고른 상품)를 덮지 않는다
        pickSmartstoreId(item.id, item.name);
        await loadSmartstoreProduct();
        if (!ssEditState) throw new Error('불러오지 못했습니다 — 로그를 보세요');
      },
      owner: () => ssEditState,
      fields: () => [tabField('title', '상품명', 'ssEditTitle'), tabField('price', '기본 판매가 (원)', 'ssEditSalePrice', 'number')],
      info: () => [`상품번호 ${ssEditState.originNo} — 네이버가 매긴 번호라 바꿀 수 없음`],
      images: () => ({ label: '상세 이미지', scope: 'naver', get: () => urlsOf(ssEditState.detailImages),
        set: urls => { ssEditState.detailImages = VUImageGallery.keep(ssEditState.detailImages, urls, url => ({ url, isNew: true })); renderSmartstoreImages(); } }),
      // 옵션은 객체째 기억한다(이름 칸은 제자리에서 바뀌고, 삭제 · 추가는 배열이 바뀐다).
      snapshot(card) {
        card.opts = ssEditState.options.slice();
        card.optBefore = new WeakMap(card.opts.map(o => [o, { names: [...o.names], price: String(o.price ?? ''), stock: String(o.stockQuantity ?? '') }]));
      },
      more(card) {
        const now = ssEditState.options, out = [], name = names => names.filter(Boolean).join(' / ');
        now.forEach((o, i) => {
          const b = card.optBefore.get(o);
          if (!b) return out.push({ key: 'opt', field: '옵션 추가', from: '', to: `${name(o.names)} · ${o.price}원 · 재고 ${o.stockQuantity}` });
          if (name(b.names) !== name(o.names)) out.push({ key: 'opt', field: `옵션 ${i + 1} 이름`, from: name(b.names), to: name(o.names) });
          if (!same(b.price, o.price)) out.push({ key: 'opt', field: `옵션 ${name(o.names)} 가격 차이`, from: b.price, to: String(o.price) });
          if (!same(b.stock, o.stockQuantity)) out.push({ key: 'opt', field: `옵션 ${name(o.names)} 재고`, from: b.stock, to: String(o.stockQuantity) });
        });
        card.opts.filter(o => !now.includes(o)).forEach(o => out.push({ key: 'opt', field: '옵션 삭제', from: name(card.optBefore.get(o).names), to: '' }));
        return out;
      },
      // 옵션 표: 옵션명(그룹마다) · 가격 차이 · 재고 · 삭제, 아래 [+ 옵션 추가]. 저장은 탭의 전체 수정(PUT)이 한다.
      extra(card, rerender) {
        const opts = ssEditState.options, groups = ssEditState.groups || [], table = el('table', 'mg-opt-table');
        const head = el('tr');
        [...(opts[0]?.names || []).map((_, k) => groups[k] || `옵션${k + 1}`), '가격 차이', '재고', ''].forEach(t => head.append(el('th', '', t)));
        table.append(head);
        const cell = (value, write, type = 'text') => {
          const td = el('td'), input = el('input', 'form-input');
          input.type = type; input.value = value ?? '';
          input.addEventListener('input', () => { write(input.value); renderSmartstoreOptions(); refreshDirty(); });
          td.append(input); return td;
        };
        opts.forEach((o, i) => {
          const tr = el('tr');
          o.names.forEach((v, k) => tr.append(cell(v, x => { o.names[k] = x; })));
          tr.append(cell(o.price, x => { o.price = x; }, 'number'), cell(o.stockQuantity, x => { o.stockQuantity = x; }, 'number'));
          const del = el('button', 'btn btn-outline btn-sm', '삭제'), td = el('td');
          del.type = 'button';
          del.onclick = () => {
            if (opts.length <= 1) { card.result = '⚠ 옵션은 최소 1개는 있어야 합니다.'; return rerender(); }
            opts.splice(i, 1); renderSmartstoreOptions(); rerender();
          };
          td.append(del); tr.append(td); table.append(tr);
        });
        // 새 옵션은 마지막 옵션의 앞 칸을 물려받고 끝 칸(좌석 등)은 비운다 — 비운 채 저장하면 탭이 막는다(같은 옵션 두 개 방지).
        const add = el('button', 'btn btn-outline btn-sm', '+ 옵션 추가');
        add.type = 'button';
        add.onclick = () => {
          const last = opts.at(-1);
          opts.push({ isNew: true, names: (last?.names || ['']).map((v, k, a) => (k === a.length - 1 ? '' : v)), price: 0, stockQuantity: last?.stockQuantity ?? 0, usable: true });
          renderSmartstoreOptions(); rerender();
        };
        const wrap = el('div', 'mg-opts');
        wrap.append(el('div', 'mg-label', '옵션'), table, add);
        return wrap;
      },
      price: (card, currency, value) => currency === 'KRW' && (applyEditPrice('naverTab', value), true),
      save: () => saveSmartstoreEdit(),
    },

    // 쿠팡: 탭의 cpEditState. 판매가 · 재고만 바꾸면 가벼운 옵션 API, 상품명 · 이미지를 바꾸면 상품 수정(재승인) — main 이 가른다.
    coupang: {
      async load(card, { cpid }) {
        if (!cpid) return { missing: '쿠팡 상품 표에 이 차가 없습니다(좌측 쿠팡 상품ID 없음)' };
        $('cpProductIdInput').value = cpid;
        if (!(await loadCoupangProduct(cpid))) throw new Error('불러오지 못했습니다 — 로그를 보세요');
      },
      owner: () => cpEditState,
      fields: () => [
        tabField('title', '상품명', 'cpEditTitle'),
        ...cpEditState.options.flatMap((o, i) => {
          const key = 'opt' + (o.sellerProductItemId ?? o.vendorItemId ?? i);
          const name = (o.attrs?.length ? o.attrs.map(a => a.value).filter(Boolean).join(' ') : o.itemName) || `옵션 ${i + 1}`;
          return [
            { key: key + ':price', label: `${name} 판매가 (원)`, type: 'number', step: '10', get: () => o.salePrice, set: v => { o.salePrice = v; renderCoupangOptions(); } },
            { key: key + ':stock', label: `${name} 재고`, type: 'number', get: () => o.stock, set: v => { o.stock = v; renderCoupangOptions(); } },
          ];
        }),
      ],
      info: () => [`상품ID ${cpEditState.productId} — 쿠팡이 매긴 번호라 바꿀 수 없음`, '옵션 이름 · 추가 · 삭제는 전체 탭에서'],
      // 지웠다 다시 놓은 이미지도 불러온 항목(원래 블록)으로 — 새 항목이 되면 saveCoupangEdit 가 이미지가 바뀐 줄 알고 상품 수정(재승인)을 보낸다.
      images: () => ({ label: '상세 이미지', scope: 'coupang', get: () => urlsOf(cpEditState.detailImages),
        set: urls => { cpEditState.detailImages = VUImageGallery.keep([...cpEditState.detailImages, ...JSON.parse(cpEditState.loadedImages || '[]')], urls,
          url => ({ url, raw: url, blockType: 'HTML', isNew: true })); renderCoupangImages(); } }),
      // 옵션 이름 · 추가 · 삭제 · 옵션 이미지는 카드에 없지만 저장은 탭의 옵션을 통째로 보낸다(바뀌었으면 상품 수정 = 재승인).
      snapshot(card) { card.optSig = cpOptSig(); card.optCount = cpEditState.options.length; },
      more: card => (cpOptSig() === card.optSig ? []
        : [{ key: 'opts', field: '옵션 이름 · 추가 · 삭제 · 옵션 이미지 (전체 탭에서 고침)', from: `옵션 ${card.optCount}개`, to: `옵션 ${cpEditState.options.length}개` }]),
      warn: changes => (changes.some(c => ['title', 'images', 'opts'].includes(c.key)) ? '⚠ 상품명 · 상세 이미지 · 옵션을 바꿔 저장 시 쿠팡 재승인' : ''),
      price: (card, currency, value, opts) => currency === 'KRW' && (applyEditPrice('coupangTab', value, opts), true),
      save: () => saveCoupangEdit(),
    },

    // 아마존: 미국 · 일본을 같은 SKU 로 읽는다. 이미지는 두 마켓 목록이 같으면 하나로 고쳐 둘 다, 다르면 미국만.
    amazon: {
      async load(card, { amzSku, no }) {
        if (!amzSku) return findBySkuNo(['amazon-us', 'amazon-jp'], no, '아마존', item => this.pick(card, item));
        card.sku = amzSku; card.markets = [];
        for (const [scope, label, currency] of AMZ_MARKETS) {
          const { rows, error } = await loadRows(scope, amzSku, true), row = rows?.[0];
          card.markets.push(row ? { scope, label, currency, name: row.name ?? '', price: row.price ?? '', images: row.images || [], revision: row.imageRevision }
            : { scope, label, error });
        }
        const ok = card.markets.filter(m => !m.error);
        if (!ok.length) throw new Error(card.markets.map(m => `${m.label}: ${m.error}`).join(' · '));
        card.imageScopes = ok.length === 2 && ok[0].images.join('\n') === ok[1].images.join('\n') ? ok.map(m => m.scope) : [ok[0].scope];
        card.imageNote = ok.length === 2 && card.imageScopes.length === 1 ? 'JP 이미지는 다름 — 전체 탭에서' : '';
        card.imagesNow = [...ok[0].images];
      },
      pick(card, item) { return this.load(card, { amzSku: item.sku || item.id }); },
      fields: card => card.markets.filter(m => !m.error).flatMap(m => [
        { key: m.scope + ':name', label: `${m.label} 상품명`, get: () => m.name, set: v => { m.name = v; } },
        { key: m.scope + ':price', label: `${m.label} 판매가 (${m.currency})`, type: 'number', step: m.currency === 'USD' ? '0.01' : '1', get: () => m.price, set: v => { m.price = v; } },
      ]),
      info: card => [`SKU ${card.sku} — 아마존 리스팅의 열쇠라 바꿀 수 없음`, ...card.markets.filter(m => m.error).map(m => `${m.label}: 불러오지 못함 — ${m.error}`)],
      images: card => ({ label: `상품 이미지 (첫 장 = 대표)${card.imageScopes.length === 2 ? ' · 미국 · 일본 같은 목록' : ''}`, note: card.imageNote,
        scope: card.imageScopes[0], get: () => card.imagesNow, set: urls => { card.imagesNow = [...urls]; } }),
      price(card, currency, value) {
        const m = card.markets.find(x => !x.error && x.currency === currency);
        if (m) m.price = value;
        return !!m;
      },
      async save(card, changes) {
        const list = [];
        for (const c of changes) {
          if (c.key === 'images') {
            if (!card.imagesNow.length) return refuse('상품 이미지는 최소 1장 필요합니다');
            for (const scope of card.imageScopes) {
              const m = card.markets.find(x => x.scope === scope);
              list.push({ scope, key: 'images', value: [...card.imagesNow], label: `${m.label} ${c.field}`, after: d => { m.revision = d.revision || m.revision; },
                job: { type: 'images', id: card.sku, urls: [...card.imagesNow], expectedRevision: m.revision } });
            }
            continue;
          }
          const [scope, what] = c.key.split(':'), value = String(c.to).trim();
          if (what === 'name' && !value) return refuse(`${c.field}이 비어 있습니다`);
          list.push({ scope, key: c.key, value, label: c.field, job: what === 'name'
            ? { type: 'name', id: card.sku, newName: value, expectedName: c.from }
            : { type: 'price', id: card.sku, newPrice: value, expectedPrice: c.from } });
        }
        return sendJobs(card, list);
      },
    },

    // 이베이: 제목 · 판매가는 탭(ebEditTitle · ebEditPrice → ebayUpdate), 이미지는 일괄 수정 채널(scope ebay).
    ebay: {
      async load(card, { sku, no }) {
        if (!sku) return findBySkuNo(['ebay'], no, '이베이', item => this.pick(card, item));
        if (window.ebayBusy?.()) throw new Error('eBay 탭이 다른 요청을 처리 중입니다 — 끝난 뒤 다시 불러오세요');
        $('ebEditSku').value = sku;
        const images = loadRows('ebay', sku, true);
        document.querySelector('[data-eb="load"]').click();   // 탭의 [상품 불러오기] 와 같은 길(runAction)
        await until(() => !window.ebayBusy());
        if (!window.ebayEditItem?.()) throw new Error('불러오지 못했습니다 — 로그를 보세요');
        const { rows, error } = await images, row = rows?.[0];
        card.sku = sku;
        card.images = row ? { now: [...(row.images || [])], revision: row.imageRevision } : null;
        card.imageError = row ? '' : error;
      },
      pick(card, item) { return this.load(card, { sku: item.sku || item.id }); },
      owner: () => window.ebayEditItem?.()?.name,
      // 게시되지 않은 상품은 탭의 수정(ebayUpdate)이 거부한다 — 칸 대신 회색 글로.
      fields: () => (window.ebayEditItem?.()?.status !== 'PUBLISHED' ? [] : [
        tabField('title', '영문 상품명 (최대 80자)', 'ebEditTitle'),
        tabField('price', '판매가 (USD)', 'ebEditPrice', 'number'),
      ]),
      info: card => {
        const item = window.ebayEditItem?.();
        return [
          `SKU ${card.sku} — 이베이 리스팅의 열쇠라 바꿀 수 없음`,
          ...(item && item.status !== 'PUBLISHED' ? [`${item.name} · $${$('ebEditPrice').value} — 게시되지 않은 상품(상태: ${item.status})이라 제목 · 판매가는 게시 뒤에 바꿀 수 있습니다`] : []),
          ...(card.imageError ? [`상품 이미지: 불러오지 못함 — ${card.imageError}`] : []),
        ];
      },
      // 판매 수량은 카드에 없지만 탭의 수정이 같이 보낸다 — 전체 탭에서 고쳤으면 확인 목록에 한 줄로.
      more: () => {
        const item = window.ebayEditItem?.(), now = $('ebEditQuantity').value;
        return item?.status === 'PUBLISHED' && !same(now, item.quantity)
          ? [{ key: 'qty', field: '미국 판매 수량 (전체 탭에서 고침)', from: String(item.quantity ?? ''), to: now }] : [];
      },
      images: card => (card.images ? { label: '상품 이미지 (첫 장 = 대표)', scope: 'ebay', get: () => card.images.now, set: urls => { card.images.now = [...urls]; } } : null),
      price: (card, currency, value) => currency === 'USD' && (applyEditPrice('ebayTab', value), true),
      async save(card, changes) {
        // 탭의 이미지 초안은 탭의 수정이 같이 보내고, 카드 이미지와도 따로 논다 — 어느 쪽이 갈지 모르니 보내지 않는다.
        if (window.ebayEditItem?.()?.imageDraft) return refuse('eBay 전체 탭에 저장하지 않은 이미지 수정이 있습니다 — 전체 탭에서 저장하거나 상품을 다시 불러오세요');
        const tabPart = changes.some(c => c.key !== 'images');
        if (tabPart) {
          const r = await window.ebayUpdate();
          if (!r?.ok) return { ok: false, error: r?.error || '알 수 없는 오류' };
          // 탭 쪽은 저장됐다(탭이 다시 불러와 제목 = owner 가 바뀐다). 여기서 그 칸들만 불러온 값으로 삼아야 이미지가 실패해도
          // renderCard 가 통째로 다시 찍지 않는다 — 실패한 이미지는 '바뀜' 으로 남아 다시 보낼 수 있다.
          for (const f of this.fields(card)) card.before.set(f.key, String(f.get() ?? ''));
          card.owner = this.owner();
        }
        if (!changes.some(c => c.key === 'images')) return { ok: true };
        if (!card.images.now.length) return tabPart ? { ok: false, partial: true, error: '상품 이미지는 최소 1장 필요합니다 — 이미지는 보내지 않았습니다' } : refuse('상품 이미지는 최소 1장 필요합니다');
        const r = await sendJobs(card, [{ scope: 'ebay', key: 'images', value: [...card.images.now], label: '상품 이미지', after: d => { card.images.revision = d.revision || card.images.revision; },
          job: { type: 'images', id: card.sku, urls: [...card.images.now], expectedRevision: card.images.revision } }]);
        return !r.ok && tabPart ? { ...r, partial: true } : r;
      },
    },
  };

  // ── 바뀐 칸 ──
  function changesOf(id) {
    const card = cards[id], a = ADAPTERS[id];
    if (card?.status !== 'ready' || (a.owner && !a.owner())) return [];   // 전체 탭이 다시 불러오는 중(탭 상태가 빔)
    const out = a.fields(card).filter(f => !same(f.get(), card.before.get(f.key)))
      .map(f => ({ key: f.key, field: f.label, from: card.before.get(f.key), to: String(f.get() ?? '') }));
    const img = a.images?.(card);
    if (img) {
      const was = card.before.get('images') || [], now = urlsOf(img.get());
      if (was.join('\n') !== now.join('\n')) {
        const order = was.length === now.length && was.every(u => now.includes(u));
        out.push({ key: 'images', field: img.label, from: `${was.length}장`, to: `${now.length}장${order ? ' (순서만)' : ''}` });
      }
    }
    return out.concat(a.more?.(card) || []);
  }
  // 지금 값을 '불러온 값' 으로 삼는다(불러온 직후 · 저장이 다 된 뒤).
  function snapshot(id) {
    const card = cards[id], a = ADAPTERS[id];
    card.before = new Map(a.fields(card).map(f => [f.key, String(f.get() ?? '')]));
    const img = a.images?.(card);
    if (img) card.before.set('images', urlsOf(img.get()));
    a.snapshot?.(card);
    card.owner = a.owner?.();
  }

  // ── 그리기 ──
  const pane = el('section', 'panel glass-panel tab-pane');
  pane.id = 'mallGridTab'; pane.style.display = 'none';
  pane.innerHTML = `
    <div class="mg-bar">
      <button type="button" class="btn btn-outline btn-sm" id="mgReload">다시 불러오기</button>
      <span class="mg-status" id="mgStatus" role="status">좌측 본사몰 상품 찾기에서 상품을 고르면 여섯 몰을 한꺼번에 불러옵니다.</span>
      <button type="button" class="btn btn-gradient btn-sm vu-key vu-key-accent" id="mgSaveAll" disabled>바뀐 몰 모두 저장</button>
    </div>
    <div class="mg-grid" id="mgGrid"></div>`;
  document.querySelector('.tab-content-area').append(pane);
  const boxOf = id => $('mgGrid').querySelector(`[data-mall="${id}"]`);

  function renderCard(id) {
    const mall = MALLS.find(m => m.id === id), a = ADAPTERS[id], box = boxOf(id);
    let card = cards[id] || { status: 'idle' };
    // 전체 탭에서 다른 상품을 불러왔으면(탭 상태가 바뀜) 그것을 새로 불러온 값으로, 탭이 비었으면 다시 불러오게 한다.
    if (card.status === 'ready' && a.owner && card.owner !== a.owner()) {
      if (a.owner()) snapshot(id);
      else card = cards[id] = { status: 'idle', note: '전체 탭에서 상품이 비워졌습니다 — 다시 불러오세요.' };
    }
    const head = el('button', 'mg-head'), logo = el('img', 'mg-logo');
    head.type = 'button'; head.title = `${mall.name} 전체 탭 열기`;
    logo.src = mall.logo; logo.alt = '';
    head.append(logo, el('span', 'mg-name', mall.name), el('span', 'mg-open', '전체 탭 →'));
    head.onclick = () => window.parent?.openGridMall?.(...mall.cell);
    const parts = [head];
    if (card.status === 'idle') parts.push(el('p', 'mg-note', card.note || '상품을 고르면 불러옵니다.'));
    else if (card.status === 'loading') parts.push(el('p', 'mg-note', '불러오는 중…'));
    else if (card.status === 'missing') parts.push(el('p', 'mg-missing', '이 몰에 없음'), el('p', 'mg-note', card.note));
    else if (card.status === 'error') parts.push(el('p', 'mg-error', `❌ 불러오지 못함 — ${card.note}`));
    else if (card.status === 'pick') {
      const box = el('div');
      parts.push(el('p', 'mg-note', `${card.rows.length}개가 찾아졌습니다 — 고칠 상품을 고르세요.`), box);
      VUProductTable.render(box, card.rows, { caption: `${mall.name} 검색 결과`, onSelect: item => loadCard(id, null, gen, item) });
    } else {
      for (const line of a.info?.(card) || []) parts.push(el('p', 'mg-ro', line));
      for (const f of a.fields(card)) {
        const label = el('label', 'mg-field'), input = el('input', 'form-input');
        input.type = f.type || 'text'; if (f.step) input.step = f.step;
        input.value = f.get() ?? ''; input.dataset.key = f.key;
        input.addEventListener('input', () => { f.set(input.value); refreshDirty(); });
        label.append(el('span', '', f.label), input);
        parts.push(label);
      }
      if (a.extra) parts.push(a.extra(card, () => renderCard(id)));
      const img = a.images?.(card);
      if (img) parts.push(gallery(id, img));
      parts.push(el('p', 'mg-warn'));
    }
    const foot = el('div', 'mg-foot'), save = el('button', 'btn btn-sm vu-key mg-save', '저장');
    save.type = 'button'; save.onclick = () => saveCards([id]);
    // 결과 줄 색은 앞머리 표시(✅ ❌ ⚠)를 따른다 — 표시가 글자로 남아 색만으로 전하지 않는다.
    const result = el('p', 'mg-result', card.result || '');
    result.dataset.tone = /^✅/.test(card.result) ? 'ok' : /^❌/.test(card.result) ? 'err' : /^⚠/.test(card.result) ? 'warn' : '';
    foot.append(save, result);
    parts.push(foot);
    box.replaceChildren(...parts);
    refreshDirty();
  }

  // 이미지 목록: 탭과 같은 갤러리(× 삭제 · ←→ · ESM 상세 붙이기 · 끌어 놓기 · 배열 적용)에 타일 끌어 옮기기를 더한다. 첫 장 = 대표(아마존 · 이베이).
  function gallery(id, img) {
    const wrap = el('div', 'mg-images'), list = el('div');
    wrap.append(el('div', 'mg-label', img.label));
    if (img.note) wrap.append(el('p', 'mg-ro', img.note));
    const set = urls => { img.set(urls); renderCard(id); };
    VUImageGallery.render(list, img.get(), {
      scope: img.scope, isBusy: () => busy, onReplace: set,
      onRemove: i => set(img.get().filter((_, k) => k !== i)),
      onMove: (i, step) => { const l = [...img.get()]; [l[i], l[i + step]] = [l[i + step], l[i]]; set(l); },
    });
    let from = -1;
    list.querySelectorAll('.vu-image-tile').forEach((tile, i) => {
      tile.draggable = true;
      tile.addEventListener('dragstart', e => { from = i; e.dataTransfer.setData('application/x-vu-tile', String(i)); });
      tile.addEventListener('dragend', () => { from = -1; });
      tile.addEventListener('dragover', e => { if (from >= 0) e.preventDefault(); });
      // 갤러리 자체의 놓기(ESM 주소 · 파일 붙이기)로 넘어가지 않게 여기서 멈춘다.
      tile.addEventListener('drop', e => {
        if (from < 0) return;
        e.preventDefault(); e.stopPropagation();
        const l = [...img.get()]; l.splice(i, 0, ...l.splice(from, 1)); from = -1;
        if (!busy) set(l);
      });
    });
    wrap.append(list);
    return wrap;
  }

  function refreshDirty() {
    let n = 0;
    for (const m of MALLS) {
      const box = boxOf(m.id), changes = changesOf(m.id);
      if (changes.length) n++;
      box.classList.toggle('mg-changed', changes.length > 0);
      const save = box.querySelector('.mg-save');
      if (save) save.disabled = busy || !changes.length;
      box.querySelectorAll('input[data-key]').forEach(input => input.classList.toggle('mg-dirty', changes.some(c => c.key === input.dataset.key)));
      const warn = box.querySelector('.mg-warn');
      if (warn) warn.textContent = ADAPTERS[m.id].warn?.(changes) || '';
    }
    // 저장 중에는 카드를 못 고친다 — 탭 칸에 바로 쓰는 카드라, 차례를 기다리는 몰의 저장이 확인하지 않은 값을 보낸다.
    $('mgGrid').inert = busy;
    $('mgSaveAll').disabled = busy || !n;
    $('mgSaveAll').textContent = `바뀐 몰 모두 저장${n ? ` (${n})` : ''}`;
    $('mgReload').disabled = busy;
  }

  // ── 불러오기 ──
  async function loadCard(id, keys, my, item) {
    const card = cards[id] = { status: 'loading', gen: my }, a = ADAPTERS[id];
    renderCard(id);
    let out;
    try { out = item ? await a.pick(card, item) : await a.load(card, keys); }
    catch (e) { out = { error: e?.message || String(e) }; }
    if (my !== gen) return;   // 그 사이 다른 상품을 불러오기 시작했다
    if (out?.missing) Object.assign(card, { status: 'missing', note: out.missing });
    else if (out?.pick) Object.assign(card, { status: 'pick', rows: out.pick });
    else if (out?.error) Object.assign(card, { status: 'error', note: out.error });
    else { card.status = 'ready'; snapshot(id); applyPricesTo(id); }
    renderCard(id);
  }
  async function load(keys = {}) {
    if (busy) return say('저장 중에는 다시 불러오지 않습니다 — 끝난 뒤 다시 누르세요.');
    if (MALLS.some(m => changesOf(m.id).length) && !window.confirm('저장하지 않은 수정이 있습니다. 다시 불러오면 사라집니다. 불러올까요?')) return;
    lastKeys = keys;
    const my = ++gen;
    say('여섯 몰에서 불러오는 중…');
    await Promise.all(MALLS.map(m => loadCard(m.id, keys, my)));
    if (my !== gen) return;
    const count = s => MALLS.filter(m => cards[m.id]?.status === s).length;
    say(`불러옴 ${count('ready')} · 이 몰에 없음 ${count('missing')} · 고르기 ${count('pick')} · 오류 ${count('error')}`);
  }

  // ── 좌측 변경 판매가(셸 EDIT_PRICES) — 통화가 맞는 카드 칸에 '바뀐 값' 으로 넣는다. 저장은 사람이 누른다. ──
  function applyPricesTo(id) {
    const card = cards[id], a = ADAPTERS[id];
    if (card?.status !== 'ready' || !a.price) return;
    card.applied ||= {};
    let touched = false;
    for (const [currency, value] of Object.entries(prices)) {
      if (!value || card.applied[currency] === value) continue;
      card.applied[currency] = value;
      // 넣을 수 없으면(쿠팡에 그 번호 옵션이 없다 등) 카드에 알린다 — 그 칸은 그대로다.
      try { touched = a.price(card, currency, value, priceOpts) || touched; }
      catch (e) { card.result = `⚠ 좌측 변경 판매가를 넣지 못했습니다: ${e.message}`; touched = true; }
    }
    if (touched) renderCard(id);
  }
  function setPrices(next = {}, opts = {}) {
    prices = next; priceOpts = opts;
    for (const m of MALLS) {
      const applied = cards[m.id]?.applied;
      // 좌측 칸을 비웠으면 기억을 지운다 — 같은 값을 다시 넣으면 또 들어간다.
      if (applied) for (const c of Object.keys(applied)) if (!prices[c]) delete applied[c];
      applyPricesTo(m.id);
    }
  }

  // ── 저장 ──
  async function saveCards(ids) {
    if (busy) return;
    const list = ids.map(id => ({ mall: MALLS.find(m => m.id === id), changes: changesOf(id) })).filter(x => x.changes.length);
    if (!list.length) return say('바뀐 칸이 없습니다.');
    const lines = list.flatMap(({ mall, changes }) => changes.map(c => `${mall.name} / ${c.field} / ${c.from || '(없음)'} → ${c.to || '(없음)'}`));
    const warns = list.map(({ mall, changes }) => ADAPTERS[mall.id].warn?.(changes)).filter(Boolean);
    if (!window.confirm(`실제 판매 중인 몰에 저장합니다. 아래 ${lines.length}칸만 보냅니다.\n몰 / 칸 / 이전 → 새\n\n${lines.join('\n')}${warns.length ? '\n\n' + warns.join('\n') : ''}\n\n저장할까요?`)) {
      return say('저장을 취소했습니다 — 아무것도 보내지 않았습니다.');
    }
    busy = true; refreshDirty();
    try {
      // 한 몰씩 차례로 — 일괄 수정 채널(bulk-save-batch)은 한 번에 하나만 받는다.
      for (const { mall, changes } of list) {
        const card = cards[mall.id];
        card.result = '저장 중…'; boxOf(mall.id).querySelector('.mg-result').textContent = card.result;
        let r;
        // 확인한 뒤 바뀌었으면(앞 몰이 저장되는 사이 좌측 판매가 · 전체 탭에서 다른 상품을 불러옴) 보내지 않는다 — 탭의 저장은
        // 그때의 탭 값을 통째로 보내니 확인하지 않은 값이 나간다.
        const a = ADAPTERS[mall.id];
        if ((a.owner && card.owner !== a.owner()) || JSON.stringify(changesOf(mall.id)) !== JSON.stringify(changes)) r = refuse('확인한 뒤 값이 바뀌었습니다 — 다시 저장을 누르세요');
        else try { r = await a.save(card, changes); }
        catch (e) { r = { ok: false, error: e?.message || String(e) }; }
        if (r?.ok) snapshot(mall.id);
        card.result = r?.ok ? `✅ 저장 완료 — ${changes.map(c => c.field).join(', ')}${r.message ? ` (${r.message})` : ''}`
          : `❌ ${r?.partial ? '일부만 저장' : '저장 실패'}: ${r?.error || '알 수 없는 오류'}`;
        log(mall, card.result, r?.ok ? 'success' : 'error');
        renderCard(mall.id);
      }
    } finally {
      busy = false; refreshDirty();
    }
  }

  $('mgSaveAll').onclick = () => saveCards(MALLS.map(m => m.id));
  // 셸이 있으면 좌측의 지금 값으로(셸 loadMallGrid), 없으면 지난 열쇠로.
  $('mgReload').onclick = () => (window.parent !== window && window.parent.loadMallGrid ? window.parent.loadMallGrid() : load(lastKeys));
  MALLS.forEach(m => { const box = el('article', 'mg-card vu-cut'); box.dataset.mall = m.id; $('mgGrid').append(box); });
  MALLS.forEach(m => renderCard(m.id));

  // 셸이 6몰 표를 띄울 때 부른다(수정 모드 기본 화면 · [← 6몰 표]). 전체 탭에서 고친 값이 카드에 보이도록 다시 그린다.
  window.showMallGrid = () => {
    document.querySelectorAll('.tab-pane').forEach(p => { p.style.display = 'none'; });
    pane.style.display = 'block';
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    MALLS.forEach(m => renderCard(m.id));
  };
  window.VUMallGrid = { load, setPrices, changes: changesOf, busy: () => busy };
})();
