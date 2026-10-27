// One display taxonomy for every marketplace. Original titles, IDs and API payloads stay intact.
(() => {
  'use strict';
  const UNKNOWN = '미분류';
  const text = value => String(value ?? '').trim();
  const fold = value => text(value).normalize('NFKC').toLowerCase().replace(/[\s_-]+/g, '');
  const PRODUCT_BRANDS = [
    ['옵틱글래스', '옵틱글라스', 'opticglass', 'optic glass'],
    ['퓨어글래스', '퓨어글라스', 'pureglass', 'pure glass'],
    ['스타포쉬', '스타푸쉬', 'starposh', 'star posh', 'スターポッシュ'],
    ['퓨어그래스', 'puregrass', 'ピュアグラス']
  ];
  const MAKES = [
    ['현대', 'hyundai'], ['기아', 'kia'], ['제네시스', 'genesis'], ['쌍용', 'kgm', 'ssangyong', 'KG 모빌리티'],
    ['르노삼성', '르노', 'renault'], ['쉐보레', 'chevrolet'], ['벤츠', 'mercedes-benz', 'mercedes', 'benz'],
    ['BMW'], ['아우디', 'audi'], ['폭스바겐', 'volkswagen'], ['볼보', 'volvo'], ['테슬라', 'tesla'],
    ['토요타', '도요타', 'toyota'], ['렉서스', 'lexus'], ['혼다', 'honda'], ['닛산', 'nissan'],
    ['포드', 'ford'], ['지프', 'jeep'], ['포르쉐', 'porsche'], ['랜드로버', 'land rover'],
    ['야마하', 'yamaha'], ['스즈키', 'suzuki'], ['가와사키', 'kawasaki'], ['두카티', 'ducati'],
    ['할리데이비슨', 'harley davidson'], ['KTM'], ['트라이엄프', 'triumph']
  ];
  const MODEL_ALIASES = [
    ['그랜저', '그랜져', 'grandeur', 'azera'], ['싼타페', '산타페', 'santa fe', 'santafe'],
    ['베라크루스', 'veracruz'], ['아반떼', 'avante', 'elantra'], ['쏘나타', '소나타', 'sonata'],
    ['캐스퍼', 'casper'], ['아이오닉 5', '아이오닉5', 'ioniq 5'], ['아이오닉 5N', '아이오닉5N', 'ioniq 5n'],
    ['아이오닉 6', '아이오닉6', 'ioniq 6'], ['아이오닉 9', '아이오닉9', 'ioniq 9'],
    ['투싼', 'tucson'], ['팰리세이드', 'palisade'], ['스타리아', 'staria'], ['스타렉스', 'starex'],
    ['코나', 'kona'], ['베뉴', 'venue'], ['포터', 'porter'], ['갤로퍼', 'galloper'], ['쏠라티', 'solati'],
    ['카렌스', 'carens'], ['카니발', 'carnival', 'sedona'], ['쏘렌토', '소렌토', 'sorento'],
    ['스포티지', 'sportage'], ['셀토스', 'seltos'], ['니로', 'niro'], ['모닝', 'picanto'],
    ['K3'], ['K5'], ['K7'], ['K8'], ['K9'], ['EV3'], ['EV4'], ['EV5'], ['EV6'], ['EV9'],
    ['G70'], ['G80'], ['G90'], ['GV60'], ['GV70'], ['GV80']
  ];
  const patterns = new Map();
  const contains = (source, alias) => {
    if (patterns.has(alias)) return patterns.get(alias).test(source);
    // Short Latin model codes must not match inside unrelated words or larger numbers.
    const escaped = text(alias).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[\s_-]+/g, '[\\s_-]*');
    const boundary = /^[a-z0-9]/i.test(alias) ? '(?<![a-z0-9])' : '';
    const end = /[a-z0-9]$/i.test(alias) ? '(?![a-z0-9])' : '';
    const pattern = new RegExp(boundary + escaped + end, 'i');
    patterns.set(alias, pattern);
    return pattern.test(source);
  };
  const aliasesIn = (source, groups) => groups.filter(group => group.some(alias => contains(source, alias))).map(group => group[0]);
  const KNOWN_MODELS = new Set(MODEL_ALIASES.flat().map(fold));

  // 차량 명칭 사전(vehicle_i18n)의 영어 · 일본어 이름도 별칭으로 쓴다 — 아임웹 영문 · 일본 상품명이 번역된 뒤(2026-10-20)
  // 'ジャガー XJ' · 'Hyundai GENESIS G90' 이 미분류가 되지 않게. 다른 무리가 이미 가진 별칭은 넣지 않는다('혼다 바이크' 가
  // 'Honda' 를 가져가지 않게). 사전 조회가 가볍지 않아(일본 모드는 일본차 표를 훑는다) 사전 · 카탈로그가 바뀔 때만 다시 만든다.
  let aliasCache = { key: '', catalog: null, makes: MAKES, models: new Map() };
  function catalogAliases(catalog) {
    const list = catalog?.brands?.() || [];
    const key = list.length + '|' + (catalog?.namesReady?.() ? 1 : 0);
    if (aliasCache.key === key && aliasCache.catalog === catalog) return aliasCache;
    const makes = MAKES.map(group => group.slice()), owned = new Set(makes.flat().map(fold));
    for (const make of new Set([...MAKES.map(group => group[0]), ...list])) {
      let group = makes.find(g => g.includes(make));
      if (!group) { group = [make]; makes.push(group); owned.add(fold(make)); }
      for (const alias of [catalog?.brandEn?.(make), catalog?.brandJa?.(make)]) {
        if (alias && !owned.has(fold(alias))) { owned.add(fold(alias)); group.push(alias); }
      }
    }
    return (aliasCache = { key, catalog, makes, models: new Map() });
  }
  const modelsOf = (cache, catalog, make) => {
    if (!cache.models.has(make)) cache.models.set(make, (catalog?.modelsOf?.(make) || [])
      .map(model => [model, catalog.modelEn?.(make, model), catalog.modelJa?.(make, model)].filter(Boolean)));
    return cache.models.get(make);
  };

  function normalize(item, catalog = window.VUSuggest) {
    const title = text(item.name ?? item.title ?? item.subject);
    const brands = aliasesIn(`${title} ${item.productBrand || item.brandName || item.brand || ''}`, PRODUCT_BRANDS);
    const cache = catalogAliases(catalog), makes = cache.makes;
    const makeSource = `${title} ${item.vehicleBrand || item.manufacturer || ''}`;
    let manufacturers = aliasesIn(makeSource, makes);
    // Prefer a more specific make name, e.g. BMW 모토라드 over BMW.
    manufacturers = manufacturers.filter(make => !manufacturers.some(other => other !== make && other.includes(make)));
    const modelGroups = MODEL_ALIASES.map(group => group.slice());
    // 이미 있는 차종은 Set 으로 거른다. 예전엔 카탈로그 차종마다 모든 별칭을 다시 접어 비교해 1,386행에 1.5초가 걸렸다.
    const known = new Set(KNOWN_MODELS);
    for (const make of manufacturers) {
      for (const group of modelsOf(cache, catalog, make)) {
        const key = fold(group[0]);
        if (!known.has(key)) { known.add(key); modelGroups.push(group); }
      }
    }
    const modelSource = `${title} ${item.vehicleModel || item.modelName || ''}`;
    // Longer catalog names win over overlapping short names; distinct models remain visible.
    const matches = [];
    for (const group of modelGroups) {
      for (const alias of group) {
        if (!contains(modelSource, alias)) continue;
        const normalized = fold(modelSource), needle = fold(alias);
        let offset = normalized.indexOf(needle);
        while (offset !== -1) {
          matches.push({ name: group[0], start: offset, end: offset + needle.length });
          offset = normalized.indexOf(needle, offset + 1);
        }
      }
    }
    const models = [...new Set(matches.filter(match => !matches.some(other => other.start <= match.start && other.end >= match.end && other.end - other.start > match.end - match.start)).sort((a, b) => a.start - b.start).map(match => match.name))];
    const bike = /오토바이|이륜차|motorcycle|motorbike/i.test(title) || manufacturers.some(make => catalog?.isBikeBrand?.(make) || ['야마하', '스즈키', '가와사키', '두카티', '할리데이비슨', 'KTM', '트라이엄프'].includes(make));
    const vehicle = manufacturers.length ? `${bike ? '오토바이' : '자동차'}(${manufacturers.join(' / ')})` : UNKNOWN;
    let kind = text(item.productType) || UNKNOWN;
    // 영어 · 일본어 상품명(아임웹 영문 · 일본): 'Wide View Side Mirror' · '広角ドアミラー' · 'Power Running Boards' · '電動サイドステップ'
    if (/전동\s*사이드\s*스[텝탭]|electric\s*(side\s*)?step|running[\s-]*boards?|サイドステップ/i.test(title)) kind = '전동사이드스텝';
    else if (/와이드\s*미러|광각\s*(사이드\s*)?미러|wide[\s-]*(angle[\s-]*|view[\s-]*)?(side[\s-]*)?mirror|広角|ワイド\s*ミラー/i.test(title)) kind = '와이드미러';
    else if (/사이드\s*미러|side[\s-]*mirror|wing[\s-]*mirror/i.test(title)) kind = '사이드미러';
    return { title, brand: brands.join(' / ') || UNKNOWN, vehicle, model: models.join(' / ') || UNKNOWN, kind, id: text(item.id ?? item.prodNo ?? item.postCode ?? item.sku) };
  }

  function render(container, items, { onSelect, configureAction, actionLabel = '선택', caption = '상품 검색 결과', pageSize = 25, currency = '' } = {}) {
    const doc = container.ownerDocument;
    const el = (tag, className, value) => { const node = doc.createElement(tag); if (className) node.className = className; if (value !== undefined) node.textContent = value; return node; };
    const records = items.map(item => ({ item, ...normalize(item) }));
    let page = 0, selected = null, busy = false;
    const root = el('section', 'vu-product-table');
    root.setAttribute('aria-label', caption);
    const tools = el('div', 'vu-product-filters');
    const filters = new Map();
    for (const [key, label] of [['brand', '브랜드'], ['vehicle', '차량·제조사'], ['model', '차종'], ['kind', '상품 종류']]) {
      const field = el('label', 'vu-product-filter'), select = el('select');
      select.setAttribute('aria-label', `${label} 필터`);
      const all = el('option', '', '전체'); all.value = ''; select.append(all);
      for (const value of [...new Set(records.map(r => r[key]))].sort((a, b) => a.localeCompare(b, 'ko'))) {
        const option = el('option', '', value); option.value = value; select.append(option);
      }
      field.append(el('span', '', label), select); tools.append(field); filters.set(key, select);
      select.addEventListener('change', () => { page = 0; draw(); });
    }
    const searchField = el('label', 'vu-product-filter vu-product-search'), search = el('input');
    search.type = 'search'; search.placeholder = '상품명·번호 검색'; search.setAttribute('aria-label', '표 안에서 검색');
    search.addEventListener('input', () => { if (!search.composing) { page = 0; draw(); } });
    search.addEventListener('compositionstart', () => { search.composing = true; });
    search.addEventListener('compositionend', () => { search.composing = false; page = 0; draw(); });
    searchField.append(el('span', '', '검색'), search); tools.append(searchField);
    const count = el('div', 'vu-product-count'); count.setAttribute('aria-live', 'polite');
    const scroll = el('div', 'vu-product-scroll'), table = el('table'), head = el('thead'), header = el('tr'), body = el('tbody');
    table.append(el('caption', 'vu-sr-only', caption));
    for (const label of ['브랜드', '차량·제조사', '차종', '상품 종류', '상품번호 / SKU', '선택']) {
      const th = el('th', '', label); th.scope = 'col'; header.append(th);
    }
    head.append(header); table.append(head, body); scroll.append(table);
    const error = el('div', 'vu-product-error'); error.setAttribute('role', 'alert');
    const pager = el('div', 'vu-product-pager'), prev = el('button', '', '이전'), next = el('button', '', '다음'), position = el('span');
    prev.type = next.type = 'button';
    prev.addEventListener('click', () => { page--; draw(); scroll.scrollTop = 0; });
    next.addEventListener('click', () => { page++; draw(); scroll.scrollTop = 0; });
    pager.append(prev, position, next); root.append(tools, count, scroll, error, pager); container.replaceChildren(root);
    function draw() {
      const words = text(search.value).split(/[\s,]+/).map(fold).filter(Boolean);
      const filtered = records.filter(r => [...filters].every(([key, select]) => !select.value || select.value === r[key]) && words.every(word => fold([r.title, r.id, r.brand, r.vehicle, r.model, r.kind].join(' ')).includes(word)));
      page = Math.min(Math.max(0, page), Math.max(0, Math.ceil(filtered.length / pageSize) - 1));
      count.textContent = `${filtered.length}개 상품 · 전체 ${records.length}개 · 상품명 기준 자동 분류`;
      body.replaceChildren();
      for (const record of filtered.slice(page * pageSize, (page + 1) * pageSize)) {
        const { item } = record, row = el('tr'); row.classList.toggle('is-selected', selected === record);
        for (const key of ['brand', 'vehicle', 'model', 'kind', 'id']) {
          const cell = el('td', `vu-product-${key}`);
          const value = el('span', record[key] === UNKNOWN ? 'vu-product-unknown' : '', record[key] || '—'); cell.append(value);
          if (key === 'model') {
            const detail = el('details', 'vu-product-original'); detail.append(el('summary', '', '원래 상품명'), el('div', '', record.title || '상품명 없음')); cell.append(detail);
          }
          if (key === 'id') {
            const meta = [];
            if (item.price !== undefined && item.price !== null && item.price !== '') meta.push(`가격 ${item.price}${item.currency || currency ? ' ' + (item.currency || currency) : ''}`);
            if (item.stock !== undefined && item.stock !== null && item.stock !== '') meta.push(`재고 ${item.stock}`);
            if (item.status) meta.push(text(item.status));
            if (item.variantLabel) meta.push(text(item.variantLabel));
            if (meta.length) cell.append(el('small', '', meta.join(' · ')));
          }
          row.append(cell);
        }
        const action = el('td'), button = el('button', 'vu-product-select', typeof actionLabel === 'function' ? actionLabel(item) : actionLabel);
        button.type = 'button'; button.setAttribute('aria-label', `${button.textContent}: ${record.title || record.id}`);
        configureAction?.(button, item);
        if (onSelect) button.addEventListener('click', async () => {
          if (busy) return;
          busy = true; button.disabled = true; error.textContent = '';
          try { await onSelect(item); selected = record; draw(); }
          catch (e) { error.textContent = e.message || String(e); }
          finally { busy = false; button.disabled = false; }
        });
        action.append(button); row.append(action); body.append(row);
      }
      if (!filtered.length) { const row = el('tr'), cell = el('td', 'vu-product-empty', records.length ? '선택한 조건의 상품이 없습니다.' : '검색 결과가 없습니다.'); cell.colSpan = 6; row.append(cell); body.append(row); }
      pager.hidden = filtered.length <= pageSize;
      position.textContent = `${page + 1} / ${Math.max(1, Math.ceil(filtered.length / pageSize))}`;
      prev.disabled = page === 0; next.disabled = (page + 1) * pageSize >= filtered.length;
    }
    draw();
    // 찾기 결과가 1건이면 바로 고른다(모든 탭의 '선택'은 읽기만 한다 — 저장은 사람이 누른다).
    if (records.length === 1) body.querySelector('.vu-product-select')?.click();
    return { clearSelection() { selected = null; draw(); } };
  }
  window.VUProductTable = { normalize, render };
})();
