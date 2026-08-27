import { BasePlatform } from './base_platform.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ADMIN = 'https://sell.smartstore.naver.com';

/**
 * 스마트스토어 "기존 상품 수정" 전용 모듈.
 *
 * 복사등록(naver_smartstore.js)과 완전히 분리되어 있으며 그 코드를 전혀 건드리지 않는다.
 *
 * 커머스 API 키 없이, 로그인된 브라우저 안에서 관리자 화면이 쓰는 내부 API를 그대로 호출한다.
 * (실측으로 확인한 프로토콜)
 *   - 채널상품번호 → 원상품번호 : POST /api/products/list/search  (CHANNEL_PRODUCT_NO)
 *   - 불러오기                  : GET  /api/products/{원상품번호}
 *   - 저장                      : PATCH /api/products  { product, savedTemplate, singleChannelProductMap }
 *
 * 저장 본문(92KB)은 우리가 직접 조립하지 않는다. 편집 페이지에서 "저장하기"를 누르면 SPA가
 * 완전한 본문을 만들어 보내는데, 그 요청을 가로채 옵션/상세이미지 부분만 바꿔치기해서
 * 흘려보낸다(route.continue). 요청을 abort 하면 네이버가 광고차단으로 오인해 페이지를
 * 막아버리므로 절대 차단하지 않는다.
 */
export class NaverSmartStoreEdit extends BasePlatform {
  constructor(browser, sessionPath) {
    super(browser, sessionPath);
    this.logCallback = null;
  }

  log(msg) {
    console.log(`[스마트스토어 수정] ${msg}`);
    if (this.logCallback) this.logCallback(msg);
  }

  // ── 세션/진입 ────────────────────────────────────────────────────────────
  async openAdmin() {
    if (!this.page) await this.init(true, { width: 1600, height: 1000 });
    await this.page.goto(`${ADMIN}/#/home/dashboard`, { waitUntil: 'domcontentloaded' });
    await sleep(6000);
    const url = this.page.url();
    if (/nid\.naver\.com|accounts\.commerce/i.test(url)) {
      this.log('로그인이 필요합니다. 열린 브라우저에서 로그인을 완료해 주세요...');
      await this.page.waitForURL(/sell\.smartstore\.naver\.com/, { timeout: 180000 });
      await sleep(4000);
      await this.saveSession();
    }
    this.log('관리자 접속 완료.');
  }

  /**
   * 제조사·차종으로 등록 상품을 찾아 [{id(원상품번호), name}] 을 돌려준다.
   * 스마트스토어 목록 검색 API(/api/products/list/search)는 서버 이름검색이 약해서,
   * 목록 전체를 페이징으로 받아 클라이언트에서 이름 부분일치(공백 무시)로 거른다.
   * (5분 캐시)
   */
  async searchProductsByName(brand, model, { force = false } = {}) {
    const b = String(brand || '').trim();
    const m = String(model || '').trim();
    if (!b && !m) throw new Error('제조사 또는 차종을 입력해 주세요.');

    await this.openAdmin();
    const all = await this._fetchAllProducts(force);
    const norm = s => String(s || '').replace(/\s+/g, '');
    const nb = norm(b), nm = norm(m);
    return all.filter(p => {
      const n = norm(p.name);
      return (!nb || n.includes(nb)) && (!nm || n.includes(nm));
    });
  }

  /** 등록 상품 전체를 페이징으로 수집 (5분 캐시) */
  async _fetchAllProducts(force = false) {
    const now = Date.now();
    if (!force && this._allProducts && (now - this._allProductsAt) < 5 * 60 * 1000) {
      return this._allProducts;
    }
    // 목록 페이지가 실제로 보내는 검색 body 형식을 확보한다
    let listBody = null;
    const grab = (req) => { if (/\/api\/products\/list\/search/.test(req.url())) { try { listBody = req.postData(); } catch {} } };
    this.page.on('request', grab);
    await this.page.goto(`${ADMIN}/#/products/origin-list`, { waitUntil: 'domcontentloaded' });
    await sleep(9000);
    this.page.off('request', grab);
    if (!listBody) throw new Error('상품 목록 검색 형식을 확보하지 못했습니다. 잠시 후 다시 시도해 주세요.');

    const all = await this.page.evaluate(async (body) => {
      const base = JSON.parse(body);
      base.searchKeyword = '';
      base.fromDate = '2000-01-01T00:00:00.000+09:00';   // 오래된 상품까지 전부
      base.size = 200;
      const out = [];
      let pageNo = 0, pages = 0;
      while (pages < 60) {
        base.page = pageNo;
        const r = await fetch('/api/products/list/search', {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(base),
        });
        const j = await r.json();
        const c = j.content || [];
        for (const p of c) out.push({ id: String(p.id), name: p.productName || '' });
        pages++; pageNo++;
        if (c.length < 200) break;   // 마지막 페이지
      }
      return out;
    }, listBody);

    this._allProducts = all;
    this._allProductsAt = now;
    this.log(`스마트스토어 상품 목록 수집: ${all.length}개`);
    return all;
  }

  /**
   * 새로 추가할 이미지의 실제 크기를 브라우저에서 측정한다.
   * (스마트에디터 컴포넌트는 원본 가로/세로를 요구하므로 임의값을 넣으면 표시가 틀어진다)
   */
  async measureImages(images) {
    const targets = (images || []).filter(im => im.isNew && im.url && !im.originalWidth);
    if (!targets.length) return images;
    const sizes = await this.page.evaluate(async (urls) => {
      const one = (u) => new Promise(res => {
        const img = new Image();
        img.onload = () => res({ w: img.naturalWidth, h: img.naturalHeight });
        img.onerror = () => res(null);
        setTimeout(() => res(null), 8000);
        img.src = u;
      });
      const out = {};
      for (const u of urls) out[u] = await one(u);
      return out;
    }, targets.map(t => t.url));

    for (const t of targets) {
      const s = sizes[t.url];
      if (s && s.w > 0) { t.originalWidth = s.w; t.originalHeight = s.h; }
      else this.log(`⚠ 이미지 크기를 읽지 못했습니다(주소 확인 필요): ${t.url.slice(0, 70)}`);
    }
    return images;
  }

  /** 페이지 컨텍스트에서 내부 API 호출 (로그인 쿠키 그대로 사용) */
  async apiGet(path) {
    return this.page.evaluate(async (p) => {
      const r = await fetch(p, { headers: { Accept: 'application/json' }, credentials: 'include' });
      return { status: r.status, text: await r.text() };
    }, path);
  }

  /**
   * 관리자 화면에 보이는 번호는 '채널상품번호'라서 그대로는 조회되지 않는다.
   * 먼저 그대로 시도하고, 안 되면 목록 검색으로 원상품번호를 찾아낸다.
   */
  async resolveOriginNo(inputNo) {
    const no = String(inputNo).trim();
    const direct = await this.apiGet(`/api/products/${no}`);
    if (direct.status === 200) {
      this.log(`상품번호 ${no} (원상품번호)로 조회됩니다.`);
      return no;
    }

    this.log(`${no} 은(는) 채널상품번호로 보입니다. 원상품번호를 찾는 중...`);
    // 목록 페이지를 열어 검색 요청 본문 형식을 확보한 뒤, 검색어만 바꿔 재요청한다.
    let listBody = null;
    const grab = (req) => { if (/\/api\/products\/list\/search/.test(req.url())) { try { listBody = req.postData(); } catch {} } };
    this.page.on('request', grab);
    await this.page.goto(`${ADMIN}/#/products/origin-list`, { waitUntil: 'domcontentloaded' });
    await sleep(9000);
    this.page.off('request', grab);
    if (!listBody) throw new Error('상품 목록 검색 형식을 확보하지 못했습니다. 잠시 후 다시 시도해 주세요.');

    const found = await this.page.evaluate(async ({ body, ch }) => {
      const b = JSON.parse(body);
      b.searchKeywordType = 'CHANNEL_PRODUCT_NO';
      b.searchKeyword = ch;
      b.page = 1; b.size = 50;
      const r = await fetch('/api/products/list/search', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(b),
      });
      const j = await r.json();
      return (j.content || []).map(p => ({ id: p.id, ch: String(p.storefarmChannelProductNo), name: p.productName }));
    }, { body: listBody, ch: no });

    const hit = found.find(f => f.ch === no) || found[0];
    if (!hit) throw new Error(`상품번호 ${no} 를 찾지 못했습니다. 번호를 확인해 주세요.`);
    this.log(`채널상품번호 ${no} → 원상품번호 ${hit.id} (${String(hit.name || '').slice(0, 30)})`);
    return String(hit.id);
  }

  // ── 상세설명(스마트에디터 문서) 파싱/조립 ────────────────────────────────
  /** detailContent → { pdc, doc, comps } 로 풀어낸다 */
  _openDetail(product) {
    const raw = product?.detailContent?.productDetailInfoContent;
    if (!raw) return null;
    const pdc = JSON.parse(raw);                 // { summary, json, html }
    const doc = JSON.parse(pdc.json);            // { documentId, document }
    return { pdc, doc, comps: doc.document.components || [] };
  }

  /**
   * html 은 컴포넌트별로 <div class="se-component ..." id="SE-xxx"> 블록이
   * json 의 components 와 같은 순서로 들어있다. 그 경계로 잘라 블록 배열을 만든다.
   */
  _splitHtmlBlocks(html) {
    const MARK = '<div class="se-component ';
    const idx = [];
    let p = html.indexOf(MARK);
    while (p !== -1) { idx.push(p); p = html.indexOf(MARK, p + 1); }
    if (!idx.length) return null;
    const head = html.slice(0, idx[0]);
    const blocks = idx.map((s, i) => html.slice(s, i + 1 < idx.length ? idx[i + 1] : html.length));
    // 마지막 블록에 붙어있는 꼬리(container 닫기 등)를 분리
    const last = blocks[blocks.length - 1];
    const tailAt = last.lastIndexOf('</div>');
    let tail = '';
    if (tailAt !== -1) {
      const closeAll = last.slice(tailAt);
      // 마지막 컴포넌트 뒤에 남는 컨테이너 닫기 부분만 꼬리로 취급
      const m = last.match(/(<\/div>\s*)+$/);
      if (m && m[0].length < last.length) { tail = m[0]; blocks[blocks.length - 1] = last.slice(0, last.length - m[0].length); }
      void closeAll;
    }
    return { head, blocks, tail };
  }

  _blockIdOf(block) {
    const m = block.match(/id="(SE-[^"]+)"/);
    return m ? m[1] : null;
  }

  /** 상세 이미지 목록 추출 (프로그램 화면 표시용) */
  extractDetailImages(product) {
    const d = this._openDetail(product);
    if (!d) return [];
    return d.comps
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => c['@ctype'] === 'image')
      .map(({ c, i }) => ({ id: c.id, compIndex: i, url: c.src || '', isNew: false }));
  }

  /**
   * 편집된 이미지 목록을 반영해 detailContent 를 다시 만든다.
   * json(components)과 html(블록) 을 함께 동기화한다.
   */
  buildDetailContent(product, images) {
    const d = this._openDetail(product);
    if (!d) throw new Error('상세설명 구조를 읽지 못했습니다.');
    const { pdc, doc, comps } = d;

    const split = this._splitHtmlBlocks(pdc.html || '');
    if (!split) throw new Error('상세설명 HTML 구조를 읽지 못했습니다.');
    const blockById = {};
    split.blocks.forEach(b => { const id = this._blockIdOf(b); if (id) blockById[id] = b; });

    const imgTemplateComp = comps.find(c => c['@ctype'] === 'image');
    const imgTemplateBlock = imgTemplateComp ? blockById[imgTemplateComp.id] : null;
    if (!imgTemplateComp || !imgTemplateBlock) throw new Error('기존 이미지 컴포넌트가 없어 새 이미지를 만들 수 없습니다.');

    const newId = () => 'SE-' + 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, ch => {
      const r = Math.random() * 16 | 0; const v = ch === 'x' ? r : (r & 0x3 | 0x8); return v.toString(16);
    });

    // 이미지가 아닌 컴포넌트(텍스트 등)는 원래 자리를 유지하고, 이미지 자리만 새 목록으로 채운다.
    const wanted = images.map(im => {
      if (!im.isNew) {
        const src = comps.find(c => c.id === im.id);
        return src ? { comp: JSON.parse(JSON.stringify(src)), block: blockById[im.id] } : null;
      }
      // 새 이미지 컴포넌트.
      // domain / path / fileName / fileSize 는 서버 필수 항목이다. (지우면 저장이 500으로 실패한다)
      // 외부(ESM) 이미지의 실제 형식에 맞춰 URL에서 만들어 넣는다.
      const id = newId();
      const comp = JSON.parse(JSON.stringify(imgTemplateComp));
      let domain = '', path = '', fileName = '';
      try {
        const u = new URL(im.url);
        domain = u.origin;
        path = u.pathname;
        fileName = decodeURIComponent(u.pathname.split('/').pop() || '');
        fileName = encodeURIComponent(fileName);
      } catch {
        domain = ''; path = im.url; fileName = '';
      }
      const ow = parseInt(im.originalWidth) || 860;
      const oh = parseInt(im.originalHeight) || 860;
      const w = Math.min(860, ow);
      const h = Math.max(1, Math.round(oh * (w / ow)));

      comp.id = id;
      comp.src = im.url;
      comp.internalResource = false;
      comp.represent = false;
      comp.domain = domain;
      comp.path = path;
      comp.fileName = fileName;
      comp.fileSize = 0;
      comp.format = 'normal';
      comp.imageLoaded = true;
      comp.ai = false;
      comp.origin = { srcFrom: 'copyUrl', '@ctype': 'imageOrigin' };
      comp.width = w; comp.height = h;
      comp.originalWidth = ow; comp.originalHeight = oh;

      // html 블록은 템플릿을 복제한 뒤 식별자/주소/경로/파일명을 치환한다.
      let block = imgTemplateBlock;
      const swap = (from, to) => { if (from && String(from).length > 2) block = block.split(from).join(to); };
      swap(imgTemplateComp.id, id);
      swap(imgTemplateComp.src, im.url);
      swap(encodeURI(imgTemplateComp.src), encodeURI(im.url));
      swap(imgTemplateComp.path, path);
      swap(imgTemplateComp.fileName, fileName);
      return { comp, block };
    }).filter(Boolean);

    const outComps = [];
    const outBlocks = [];
    let wi = 0;
    for (const c of comps) {
      if (c['@ctype'] === 'image') continue;           // 이미지는 아래에서 한 번에 배치
      outComps.push(c);
      if (blockById[c.id]) outBlocks.push(blockById[c.id]);
    }
    // 원본에서 첫 이미지가 있던 위치에 새 이미지 묶음을 넣는다.
    const firstImgAt = comps.findIndex(c => c['@ctype'] === 'image');
    const nonImgBefore = comps.slice(0, firstImgAt).filter(c => c['@ctype'] !== 'image').length;
    outComps.splice(nonImgBefore, 0, ...wanted.map(w => w.comp));
    outBlocks.splice(nonImgBefore, 0, ...wanted.map(w => w.block).filter(Boolean));
    wi = wanted.length; void wi;

    doc.document.components = outComps;
    pdc.json = JSON.stringify(doc);
    pdc.html = split.head + outBlocks.join('') + split.tail;

    const out = JSON.parse(JSON.stringify(product.detailContent));
    out.productDetailInfoContent = JSON.stringify(pdc);
    return out;
  }

  // ── 불러오기 ─────────────────────────────────────────────────────────────
  async loadProductForEdit(inputNo) {
    await this.openAdmin();
    const originNo = await this.resolveOriginNo(inputNo);

    const res = await this.apiGet(`/api/products/${originNo}`);
    if (res.status !== 200) throw new Error(`상품 조회 실패 (HTTP ${res.status})`);
    const body = JSON.parse(res.text);
    const product = body.product;
    if (!product) throw new Error('상품 데이터를 읽지 못했습니다.');

    const oi = product.detailAttribute?.optionInfo || {};
    const groups = (oi.options || []).map(g => g.groupName);
    const options = (oi.optionCombinations || []).map((c, i) => ({
      index: i,
      id: c.id ?? null,
      names: [c.optionName1, c.optionName2, c.optionName3].slice(0, Math.max(groups.length, 1)).map(v => v ?? ''),
      stockQuantity: c.stockQuantity ?? 0,
      price: c.price ?? 0,
      usable: c.usable !== false,
      isNew: false,
    }));

    const detailImages = this.extractDetailImages(product);
    this.log(`불러오기 완료 — 옵션 ${options.length}개, 상세이미지 ${detailImages.length}장`);

    return {
      inputNo: String(inputNo),
      originNo,
      title: product.name || '',
      statusType: product.statusType || '',
      salePrice: product.salePrice ?? 0,
      groups,
      options,
      detailImages,
    };
  }

  // ── 저장 ─────────────────────────────────────────────────────────────────
  /**
   * 편집 페이지에서 "저장하기"를 눌러 SPA가 만든 PATCH 본문을 가로채고,
   * 옵션/상세이미지 부분만 우리 값으로 바꿔치기해 그대로 흘려보낸다.
   */
  async updateProduct(data) {
    const { originNo, options, detailImages, title } = data;
    if (!originNo) throw new Error('원상품번호가 없습니다. 먼저 불러오기를 해주세요.');

    await this.openAdmin();

    // 새 이미지의 실제 크기를 먼저 측정해 둔다 (컴포넌트 필수 항목)
    if (Array.isArray(detailImages)) await this.measureImages(detailImages);

    let patched = false, patchErr = null;
    await this.page.route('**/api/products', async (route) => {
      const req = route.request();
      if (req.method() !== 'PATCH') return route.continue();
      try {
        const raw = req.postData();
        if (!raw) return route.continue();          // 본문을 못 읽으면 원본 그대로 통과
        const body = JSON.parse(raw);
        const product = body.product;

        // 0) 상품명 변경 (입력했을 때만).
        //    채널상품은 selfProductNameUsable=false 라 원상품명을 따라가므로 여기만 바꾸면 된다.
        const newTitle = String(title ?? '').trim();
        if (newTitle && newTitle !== product.name) {
          this.log(`상품명 변경: "${product.name}" → "${newTitle}"`);
          product.name = newTitle;
        }

        // 1) 옵션 교체
        if (Array.isArray(options) && options.length) {
          const oi = product.detailAttribute.optionInfo;
          const tpl = (oi.optionCombinations || [])[0];
          if (!tpl) throw new Error('기존 옵션이 없어 옵션을 수정할 수 없습니다.');
          oi.optionCombinations = options.map((o, i) => {
            const base = o.isNew
              ? (() => { const c = JSON.parse(JSON.stringify(tpl)); delete c.id; return c; })()
              : JSON.parse(JSON.stringify((oi.optionCombinations || []).find(x => x.id === o.id) || tpl));
            base.optionName1 = o.names[0] ?? base.optionName1;
            if (o.names.length > 1) base.optionName2 = o.names[1] ?? base.optionName2;
            if (o.names.length > 2) base.optionName3 = o.names[2] ?? base.optionName3;
            base.stockQuantity = parseInt(o.stockQuantity) || 0;
            base.price = parseInt(o.price) || 0;
            base.usable = o.usable !== false;
            base.regOrder = i;
            return base;
          });
        }

        // 2) 상세 이미지 교체
        if (Array.isArray(detailImages)) {
          if (detailImages.length === 0) throw new Error('상세 이미지가 0장입니다. 최소 1장은 있어야 합니다.');
          product.detailContent = this.buildDetailContent(product, detailImages);
        }

        patched = true;
        this.log('저장 요청에 수정 내용을 반영했습니다.');
        return route.continue({ postData: JSON.stringify(body) });
      } catch (e) {
        patchErr = e;
        return route.abort();   // 우리 가공이 실패하면 잘못된 저장을 막는다
      }
    });

    const resp = { status: 0, text: '' };
    this.page.on('response', async (r) => {
      if (r.request().method() === 'PATCH' && /\/api\/products$/.test(r.url().split('?')[0])) {
        resp.status = r.status();
        try { resp.text = (await r.text()).slice(0, 500); } catch {}
      }
    });

    this.log('편집 페이지를 여는 중...');
    await this.page.goto(`${ADMIN}/?_=${Date.now()}#/products/edit/${originNo}`, { waitUntil: 'domcontentloaded' });
    await sleep(18000);

    const btn = this.page.locator('button:has-text("저장하기")').first();
    if ((await btn.count()) === 0) throw new Error('저장하기 버튼을 찾지 못했습니다.');
    await btn.scrollIntoViewIfNeeded().catch(() => {});
    await btn.click({ force: true });
    await sleep(12000);

    await this.page.unroute('**/api/products').catch(() => {});

    if (patchErr) throw new Error(`수정 내용 반영 실패: ${patchErr.message}`);
    if (!patched) throw new Error('저장 요청을 가로채지 못했습니다. 저장이 이뤄지지 않았습니다.');
    if (resp.status !== 200) throw new Error(`저장 실패 (HTTP ${resp.status}) ${resp.text.slice(0, 200)}`);

    // 반영 확인
    await sleep(2500);
    const after = await this.apiGet(`/api/products/${originNo}`);
    let verify = '';
    if (after.status === 200) {
      const p = JSON.parse(after.text).product;
      const n = (p.detailAttribute?.optionInfo?.optionCombinations || []).length;
      const m = this.extractDetailImages(p).length;
      const wantTitle = String(title ?? '').trim();
      const titleOk = !wantTitle || p.name === wantTitle;
      verify = `옵션 ${n}개, 상세이미지 ${m}장` + (wantTitle ? `, 상품명 ${titleOk ? '변경됨' : '미반영'}` : '');
      const wantN = options?.length ?? n, wantM = detailImages?.length ?? m;
      if (!titleOk) throw new Error(`상품명이 반영되지 않았습니다. 현재: "${p.name}"`);
      if (n !== wantN || m !== wantM) {
        throw new Error(`저장은 됐지만 반영이 다릅니다. 현재: ${verify} (요청: 옵션 ${wantN}개, 이미지 ${wantM}장)`);
      }
    }
    this.log(`✓ 저장 및 반영 확인 완료 (${verify})`);
    return { originNo, verified: verify };
  }
}
