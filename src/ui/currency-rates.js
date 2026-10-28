(() => {
  const currencies = ['USD', 'JPY', 'KRW'];
  const ids = ['inp-usd', 'inp-edit-krw', 'inp-edit-usd', 'inp-edit-jpy', 'amzPrice', 'ebPrice', 'ebEditPrice'];
  // 아마존 칸은 마켓에 따라, 수정 모드의 변경 판매가는 칸마다 통화가 정해져 있다. 나머지는 USD.
  const fixedCurrency = { 'inp-edit-krw': 'KRW', 'inp-edit-jpy': 'JPY' };
  const docs = new Set();
  let snapshot = null, initialized = false, failure = '', pending = null;
  function valid(data) {
    return data?.base === 'USD' && data?.rates?.USD === 1 &&
      currencies.every(c => Number.isFinite(data.rates[c]) && data.rates[c] > 0) &&
      Number.isFinite(Date.parse(data.fetchedAt)) && /^\d{4}-\d{2}-\d{2}$/.test(data.marketDate);
  }
  function convert(amount, from, to, { allowStale = false } = {}) {
    const active = snapshot;
    const age = active ? Date.now() - Date.parse(active.fetchedAt) : Infinity;
    if (!active || (!allowStale && (active.stale || age < 0 || age >= 86400000)) ||
        !currencies.includes(from) || !currencies.includes(to) || !Number.isFinite(amount) || amount < 0) return null;
    const result = amount / active.rates[from] * active.rates[to];
    return Number.isFinite(result) ? result : null;
  }
  function currencyFor(el) {
    if (el.id === 'amzPrice') return el.ownerDocument.getElementById('amzCurrency')?.value;
    return fixedCurrency[el.id] || 'USD';
  }
  function amountOf(value) {
    const text = String(value ?? '').trim();
    if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(text)) return null;
    const amount = Number(text.replaceAll(',', ''));
    return Number.isFinite(amount) ? amount : null;
  }
  function tooltip(el) {
    const amount = amountOf(el.value), from = currencyFor(el);
    let title = '';
    if (amount !== null && currencies.includes(from)) {
      const values = currencies.map(to => convert(amount, from, to));
      if (values.every(v => v !== null)) {
        title = currencies.map((c, i) => c + ' ' + values[i].toLocaleString('ko-KR', {
          minimumFractionDigits: 2, maximumFractionDigits: 2,
        })).join(' · ');
      } else {
        title = failure || '최신 환율을 확인할 수 없습니다.';
      }
    }
    const doc = el.ownerDocument;
    const label = doc.querySelector('label[for="' + el.id + '"]') ||
      (el.id === 'amzPrice' ? doc.getElementById('amzPriceLabel') : null) ||
      el.closest('.input-col, .form-group')?.querySelector('label');
    for (const node of [el, label].filter(Boolean)) {
      if (title) node.setAttribute('title', title);
      else node.removeAttribute('title');
    }
    if (title) el.setAttribute('aria-description', title);
    else el.removeAttribute('aria-description');
    return title;
  }
  function refreshDocument(doc) {
    for (const id of ids) {
      const el = doc.getElementById(id);
      if (el) tooltip(el);
    }
  }
  function refreshAll() {
    for (const doc of docs) {
      if (!doc.defaultView || (doc !== document && doc.defaultView.document !== doc)) docs.delete(doc);
      else refreshDocument(doc);
    }
  }
  function bind(doc) {
    if (!doc || docs.has(doc)) return;
    docs.add(doc);
    const update = event => {
      const target = event.target;
      if (!target?.closest) return;
      let el = target.closest('input');
      if (!el) {
        const label = target.closest('label');
        el = label && (doc.getElementById(label.htmlFor) ||
          label.closest('.field, .input-col, .form-group')?.querySelector('input'));
      }
      if (el && ids.includes(el.id)) tooltip(el);
      if (['amzMarketplaceId', 'amzCurrency'].includes(target.id)) refreshDocument(doc);
    };
    // Read the current .value at hover/focus: Excel and API assignments need not emit events.
    for (const type of ['mouseover', 'focusin', 'input', 'change']) doc.addEventListener(type, update);
    refreshDocument(doc);
  }
  function init(ipc) {
    if (initialized) return;
    initialized = true;
    bind(document);
    const frame = document.getElementById('form-frame');
    frame?.addEventListener('load', () => { bind(frame.contentDocument); refreshAll(); });
    if (frame?.contentDocument) bind(frame.contentDocument);
    const refresh = () => {
      if (pending) return pending;
      pending = (async () => {
        try {
          const result = await ipc.invoke('currency-rates-get');
          if (!result?.success || !valid(result.data)) {
            // 앱이 Yahoo Finance 에서 직접 받는다(로그인 불필요). 못 받았으면 인터넷 연결 문제다.
            failure = '환율을 불러오지 못했습니다. 인터넷 연결을 확인하세요.' + (result?.error ? ' (' + result.error + ')' : '');
          } else {
            snapshot = result.data;
            failure = '';
          }
        } catch (error) {
          failure = /No handler registered/.test(String(error?.message))
            ? '환율 기능을 사용하려면 앱을 완전히 종료한 뒤 다시 실행하세요.'
            : '환율을 불러오지 못했습니다. 인터넷 연결을 확인하세요.';
        } finally {
          refreshAll();
          pending = null;
        }
      })();
      return pending;
    };
    refresh();
    const timer = setInterval(refresh, 60 * 60 * 1000);
    window.addEventListener('focus', refresh);
    window.addEventListener('beforeunload', () => clearInterval(timer), { once: true });
  }
  window.VUCurrency = { init, convert, refreshDocument };
})();
