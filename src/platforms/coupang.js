import { CoupangAPI } from './coupang_api.js';
import { markPreSend } from '../utils/api_error.js';
import { extractNaverDetailImages, replaceNaverDetailImages } from './naver_products.js';
import { parseImageUrls } from '../utils/bulk_images.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// 디버그 파일용 임시 폴더 (배포 환경에서도 안전, 없으면 생성)
function _debugDir() {
    try {
        const d = path.join(os.tmpdir(), 'antigravity-debug');
        if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
        return d;
    } catch { return null; }
}

// 등록상품ID·등록상품명 시트 (A열=등록상품ID, B열=등록상품명)
const PRODUCT_SHEET_ID = '1ByZ4AQxLfTQ_Mp4lsmY98PB5X4_Cgq9QDM_ouSJJCvU';

/** 따옴표 안 개행/콤마를 처리하는 최소 CSV 파서 */
function parseCSV(text) {
    const rows = []; let row = [], field = '', q = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (q) {
            if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
            else field += c;
        } else {
            if (c === '"') q = true;
            else if (c === ',') { row.push(field); field = ''; }
            else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
            else if (c === '\r') { /* skip */ }
            else field += c;
        }
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    return rows;
}

/**
 * 구글 시트에서 제조사·차종을 모두 포함하는 등록상품명을 찾아 {id, name} 목록을 돌려준다.
 * (공백 무시 부분일치)
 */
export async function findProductIdsFromSheet(brand, model) {
    const b = String(brand || '').trim();
    const m = String(model || '').trim();
    if (!b && !m) throw new Error('제조사 또는 차종을 입력해 주세요.');

    const url = `https://docs.google.com/spreadsheets/d/${PRODUCT_SHEET_ID}/export?format=csv`;
    let res;
    try { res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30000) }); }
    catch (e) { throw new Error(`상품 시트를 불러오지 못했습니다: ${e.name === 'TimeoutError' ? '응답 시간 초과(30초)' : e.message}`); }
    if (!res.ok) throw new Error(`상품 시트 응답 오류 (${res.status}). 시트 공유 설정(링크가 있는 모든 사용자 보기)을 확인해 주세요.`);
    const csv = await res.text();
    if (/^\s*<(!doctype|html)/i.test(csv)) throw new Error('상품 시트에 접근할 수 없습니다. 시트 공유를 "링크가 있는 모든 사용자"로 설정해 주세요.');

    const rows = parseCSV(csv);
    // A열(등록상품ID)이 숫자 9자리 이상인 행만 실제 상품
    const products = rows
        .filter(r => /^\d{9,}$/.test(String(r[0] || '').trim()))
        .map(r => ({ id: String(r[0]).trim(), name: String(r[1] || '').trim() }))
        .filter(p => p.name);

    const norm = s => String(s || '').replace(/\s+/g, '');
    const nb = norm(b), nm = norm(m);
    const hits = products.filter(p => {
        const n = norm(p.name);
        return (!nb || n.includes(nb)) && (!nm || n.includes(nm));
    });
    return hits;
}

// 한글 및 공백이 포함된 이미지 URL을 쿠팡 API 규격에 맞게 안전하게 인코딩하는 헬퍼 함수
function getSafeUrl(urlStr) {
  if (!urlStr) return '';
  try {
    let url = urlStr.trim();
    // 만약 <img src="주소" /> 형태로 붙여넣었다면 주소 부분만 자동 추출
    const match = url.match(/src=["']([^"']+)["']/i);
    if (match) {
      url = match[1];
    }
    return encodeURI(decodeURIComponent(url));
  } catch (e) {
    return urlStr;
  }
}

/**
 * 쿠팡 상품 등록 모듈 (Open API 방식)
 */
export class Coupang {
  /**
   * @param {string} configPath
   * @param {import('./coupang_store.js').CoupangStore|null} [store] 옵션 판매가 로컬 캐시. 없으면 캐시를 쓰지 않는다
   *   (테스트처럼 설정 파일만 넘기면 아무 파일도 더 쓰지 않는다 — amazon.js 의 AmazonStore 와 같은 방식).
   */
  constructor(configPath, store = null) {
    this.configPath = configPath;
    this.config = null;
    this.api = null;
    this.store = store;
  }

  // 캐시는 보여 주기용이라 실패해도 쿠팡 작업은 그대로 간다.
  _cache(work) {
    if (!this.store || !this.config?.vendorId) return;
    try { work(this.store, this.config.vendorId); }
    catch (e) { console.warn('[쿠팡] 판매가 캐시 저장 실패(무시):', e.message); }
  }

  // API 가 판매가를 알게 될 때마다(가격 조회·가격 변경) 캐시에 적는다. API 를 새로 만들 때마다 다시 단다.
  _watchPrices() {
    if (this.api) this.api.onPrice = (vendorItemId, salePrice) => this._cache((store, vendorId) => store.updatePrice(vendorId, vendorItemId, salePrice));
  }

  /**
   * 고정 IP 프록시 옵션. runtimeProxy(로그인 시 메모리에 주입되는 직원 토큰)가 우선이고,
   * 없으면 설정 파일 값을 쓴다. 토큰이 디스크에 남지 않도록 이 순서를 지킨다.
   *
   * ⚠ 왜 헬퍼로 뺐나: 예전에는 loadConfig() 에서만 프록시를 넘기고 saveConfig() 에서는
   *   CoupangAPI 를 **인자 4개**로 다시 만들어, 5번째인 proxy 가 조용히 빠졌다.
   *   그래서 직원이 쿠팡 설정을 저장하는 순간부터 앱을 다시 켤 때까지 모든 호출이
   *   PC 의 IP 로 직접 나갔다 — 쿠팡은 IP 허용목록을 쓰므로 전부 403 이 된다.
   *   화면에는 쿠팡 원문("IP가 허용되지 않음")만 떠서 원인을 짚기 어려웠다.
   *   두 곳이 같은 값을 쓰게 만들어 그 어긋남 자체를 없앤다.
   */
  _proxyOpts() {
    return {
      proxyUrl: this.runtimeProxy?.proxyUrl || this.config?.proxyUrl || '',
      proxyToken: this.runtimeProxy?.proxyToken || this.config?.proxyToken || ''
    };
  }

  loadConfig() {
    if (!fs.existsSync(this.configPath)) {
      throw new Error('쿠팡 설정 파일이 없습니다. 먼저 API 설정을 완료해주세요.');
    }
    const raw = fs.readFileSync(this.configPath, 'utf-8');
    const newConfig = JSON.parse(raw);

    if (!newConfig.vendorId || !newConfig.accessKey || !newConfig.secretKey) {
      throw new Error('쿠팡 API 키가 설정되지 않았습니다. 쿠팡 탭에서 API 설정을 완료해주세요.');
    }

    const oldConfig = this.config;
    this.config = newConfig;
    const proxy = this._proxyOpts();
    const canReuse = this.api && oldConfig
      && oldConfig.vendorId === newConfig.vendorId
      && oldConfig.accessKey === newConfig.accessKey
      && oldConfig.secretKey === newConfig.secretKey
      && (oldConfig.vendorUserId || oldConfig.vendorId) === (newConfig.vendorUserId || newConfig.vendorId)
      && this.api.proxyUrl === (proxy.proxyUrl || '')
      && this.api.proxyToken === (proxy.proxyToken || '');

    if (!canReuse) {
      const oldCache = this.api?._productCache;
      this.api = new CoupangAPI(
        this.config.vendorId,
        this.config.accessKey,
        this.config.secretKey,
        this.config.vendorUserId || this.config.vendorId,
        proxy
      );
      if (oldCache) this.api._productCache = oldCache;
    }
    this._watchPrices();

    return this.config;
  }

  /**
   * 쿠팡 API로 등록 상품 전체를 페이징 수집한다. (5분 캐시)
   */
  async fetchAllProducts(force = false) {
    if (!this.api) this.loadConfig();
    const now = Date.now();
    if (!force && this._allProducts && (now - this._allProductsAt) < 5 * 60 * 1000) {
      return this._allProducts;
    }
    const all = [];
    let nextToken = '', pages = 0;
    do {
      const r = await this.api.listProducts(nextToken, 100);
      // 오류 본문을 `r.data || []` 로 읽으면 '상품 0개'가 5분 동안 캐시되어 검색이 전부 비어 보인다.
      // 거부 코드는 _request 가 던지고, 모양이 다른 응답도 여기서 멈춘다(캐시에 쓰기 전).
      if (!Array.isArray(r?.data)) {
        throw new Error(`쿠팡 상품 목록 응답이 예상과 다릅니다 (code=${r?.code ?? '없음'}). 목록을 캐시하지 않았습니다.`);
      }
      for (const d of r.data) {
        all.push({ id: String(d.sellerProductId), name: String(d.sellerProductName || '') });
      }
      nextToken = r.nextToken;
      pages++;
    } while (nextToken && pages < 50);
    if (nextToken) throw new Error('쿠팡 목록이 50페이지를 넘었습니다. 전체 목록을 읽지 못했습니다.');
    this._allProducts = all;
    this._allProductsAt = now;
    console.log(`쿠팡 상품 목록 수집: ${all.length}개 (${pages}페이지)`);
    return all;
  }

  /**
   * 제조사·차종을 모두 포함하는 등록 상품을 API에서 찾는다. (공백 무시 부분일치)
   */
  async searchProductsByName(brand, model, { force = false } = {}) {
    const b = String(brand || '').trim();
    const m = String(model || '').trim();
    if (!b && !m) throw new Error('제조사 또는 차종을 입력해 주세요.');
    const all = await this.fetchAllProducts(force);
    const norm = s => String(s || '').replace(/\s+/g, '');
    const nb = norm(b), nm = norm(m);
    return all.filter(p => {
      const n = norm(p.name);
      return (!nb || n.includes(nb)) && (!nm || n.includes(nm));
    });
  }

  /**
   * 상품 일괄 수정 목록. 쿠팡 상품 목록 API 는 옵션ID·판매가를 주지 않는다(상품 목록 페이징 조회 — 공식 문서).
   * 아마존·eBay 가 목록 캐시를 '(목록)' 판매가로 보여 주듯, 이 PC 에서 불러온 적 있는 상품은 그때의 옵션·판매가
   * 행으로 펼친다(coupang_store.js). 처음 보는 상품은 예전처럼 상품 한 줄이다.
   * 보여 주기만 한다 — 판매가를 고치려면 지금처럼 현재가를 다시 불러오고, 저장은 그 값과 비교한다.
   * @returns {{ items: object[], cached: number }} cached: 옵션·판매가를 펼친 상품 수
   */
  async listForPriceEdit() {
    const products = await this.fetchAllProducts(true);
    const known = this.store && this.config?.vendorId ? this.store.products(this.config.vendorId) : {};
    // 쿠팡 목록에 없는 상품(삭제됨)은 캐시에서 뺀다 — 목록은 전체를 다 읽었을 때만 돌아온다(fetchAllProducts).
    this._cache((store, vendorId) => store.keepOnly(vendorId, products.map(p => p.id)));
    const when = iso => {
      const d = new Date(iso);
      return Number.isFinite(d.getTime()) ? d.toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
    };
    let cached = 0;
    const items = products.flatMap(p => {
      const options = known[p.id]?.options || [];
      if (!options.length) return [p];
      cached++;
      return options.map(o => {
        const at = o.price === '' ? '' : when(o.checkedAt);
        return {
          ...p, optionId: o.optionId, variant: o.itemName, price: o.price,
          ...(o.readonly
            ? { readonly: true, result: '승인완료 전 옵션이라 판매가를 바꿀 수 없습니다(쿠팡 승인 후 가능).' }
            : { result: ['현재가 조회 전', at && `${at} 에 읽은 판매가`].filter(Boolean).join(' · ') }),
        };
      });
    });
    return { items, cached };
  }

  saveConfig(newConfig) {
    if (this.config) {
      this.config = { ...this.config, ...newConfig };
    } else {
      this.config = newConfig;
    }
    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf-8');
    console.log('쿠팡 설정 저장 완료:', this.configPath);

    if (this.config.vendorId && this.config.accessKey && this.config.secretKey) {
      // 5번째 인자(proxy)를 빠뜨리면 이 순간부터 쿠팡 호출이 PC IP 로 직접 나가 403 이 된다.
      this.api = new CoupangAPI(
        this.config.vendorId,
        this.config.accessKey,
        this.config.secretKey,
        this.config.vendorId,
        this._proxyOpts()
      );
      this._watchPrices();
    }
  }

  async testConnection() {
    if (!this.api) this.loadConfig();
    return await this.api.testConnection();
  }

  async getShippingPlaces() {
    if (!this.api) this.loadConfig();
    return await this.api.getOutboundShippingPlaces();
  }

  async getReturnCenters() {
    if (!this.api) this.loadConfig();
    return await this.api.getReturnCenters();
  }

  static TEMPLATE_CAR = '13670011949';
  static TEMPLATE_MOTORCYCLE = '16237601401';

  async copyRegisterProduct(data) {
    if (!this.api) this.loadConfig();

    const isCar = data.category === '자동차';
    const templateId = data.productId || (isCar ? Coupang.TEMPLATE_CAR : Coupang.TEMPLATE_MOTORCYCLE);

    console.log(`쿠팡 복사등록 시작: ${data.title} (템플릿 ID: ${templateId})`);
    const templateResult = await this.api.getProduct(templateId);
    const template = templateResult?.data;
    if (!template) {
      throw new Error(`템플릿 상품 조회 실패 (ID: ${templateId})`);
    }

    const payload = this._buildCopyPayload(template, data);
    
    // [추가] 쿠팡 디버그 로그 기록
    try {
      const logData = {
        timestamp: new Date().toISOString(),
        templateId,
        templateImages: template.items[0]?.images,
        payloadImages: payload.items[0]?.images,
        data
      };
      const _dd = _debugDir();
      if (_dd) fs.appendFileSync(path.join(_dd, 'coupang_debug.log'), JSON.stringify(logData, null, 2) + '\n\n', 'utf-8');
    } catch (e) {
      console.error('디버그 로그 작성 실패:', e);
    }
    
    // [추가] 쿠팡 페이로드 파일로 저장
    try {
      const _dd2 = _debugDir();
      if (_dd2) fs.writeFileSync(path.join(_dd2, 'coupang_payload_app.json'), JSON.stringify(payload, null, 2), 'utf-8');
    } catch (e) {
      console.error('페이로드 파일 저장 실패:', e);
    }
    
    // [추가] 쿠팡 페이로드 로그 출력
    console.log('COUPANG_PAYLOAD:', JSON.stringify(payload, null, 2));

    const result = await this.api.registerProduct(payload);
    // 거부 본문(code:'ERROR')은 _request 가 던진다. 성공 코드인데 등록상품ID가 없으면 무엇이
    // 만들어졌는지 알 수 없으므로 성공으로 보고하지 않는다(예전엔 "등록되었습니다 (ID: undefined)").
    if (result?.data == null || result.data === '') {
      throw new Error(`쿠팡 응답에 등록상품ID가 없습니다 (code=${result?.code ?? '없음'}, message=${result?.message || '없음'}). 쿠팡 판매자센터에서 등록 여부를 확인해주세요.`);
    }
    console.log(`✓ 쿠팡 복사등록 완료! (등록상품ID: ${result.data})`);
    return result;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 기존 상품 수정 (불러오기 → 옵션/상세이미지 편집 → 저장)
  //
  // 복사등록(copyRegisterProduct / _buildCopyPayload)과 완전히 분리되어 있으며,
  // 저장 시에는 조회한 원본을 통째로 스프레드({...existing})한 뒤 바뀐 부분만
  // 갈아끼운다. 필드를 손으로 나열하지 않으므로 미지정 항목이 유실되지 않는다.
  // ──────────────────────────────────────────────────────────────────────────

  /** 쿠팡 CDN 상대경로를 화면에 띄울 수 있는 전체 URL로 */
  _toCdnUrl(p) {
    const s = String(p || '').trim();
    if (!s) return '';
    if (/^https?:\/\//i.test(s)) return s;
    return `https://image1.coupangcdn.com/image/${s.replace(/^\/+/, '')}`;
  }

  /**
   * 상세설명 이미지 목록 추출.
   * 쿠팡은 상세 이미지를 contents[] 배열에 두 가지 형태로 섞어서 저장한다:
   *   - contentsType: IMAGE / IMAGE_NO_SPACE → contentDetails[].content 가 이미지 경로 자체
   *   - contentsType: HTML                   → content 안의 <img src="..."> 태그
   * 따라서 contents 배열 전체를 순회해야 한다. (예전엔 contents[0]만 HTML로 가정해서
   * IMAGE 방식 상품은 0장으로 읽혔고, 저장 시 상세가 통째로 날아갈 수 있었다.)
   */
  _extractDetailImages(contents) {
    const out = [];
    (contents || []).forEach(ct => {
      const blockType = String(ct.contentsType || '').toUpperCase();
      (ct.contentDetails || []).forEach(cd => {
        const raw = String(cd.content || '').trim();
        if (!raw) return;
        const detailType = String(cd.detailType || '').toUpperCase();
        if (detailType === 'IMAGE' || (blockType.startsWith('IMAGE') && !/<img/i.test(raw))) {
          out.push({ raw, url: this._toCdnUrl(raw), blockType: blockType || 'IMAGE_NO_SPACE' });
        } else {
          for (const m of raw.matchAll(/<img[^>]*src=["']([^"']+)["'][^>]*>/gi)) {
            out.push({ raw: m[1], url: this._toCdnUrl(m[1]), blockType: 'HTML' });
          }
        }
      });
    });
    return out;
  }

  /**
   * 이미지 목록을 쿠팡 contents[] 배열로 되돌린다.
   * 각 이미지는 원래의 블록 형식(IMAGE_NO_SPACE / HTML)과 원본 경로를 그대로 유지하고,
   * 새로 추가한 이미지는 복사등록에서 검증된 형식(HTML + 전체 URL)으로 만든다.
   */
  _buildDetailContents(images) {
    return (images || [])
      .filter(im => im && (im.raw || im.url))
      .map(im => {
        const blockType = String(im.blockType || '').toUpperCase();
        const value = im.raw || im.url;
        if (blockType.startsWith('IMAGE')) {
          return { contentsType: blockType, contentDetails: [{ content: value, detailType: 'IMAGE' }] };
        }
        const src = getSafeUrl(this._toCdnUrl(value));
        return {
          contentsType: 'HTML',
          contentDetails: [{
            content: `<p style="text-align: center;"><img style="display: block; margin-left: auto; margin-right: auto;" src="${src}" /></p>`,
            detailType: 'TEXT',
          }],
        };
      });
  }

  /**
   * 구매옵션(EXPOSED) 속성 목록.
   * 한 상품에 노출 옵션이 여러 개일 수 있다. 예) 수량="1개" + 차종="B104 - 3세대(21.11~)"
   * 이때 itemName은 이 값들을 공백으로 이어붙인 문자열이다.
   * → 옵션명 전체를 첫 속성에 밀어넣으면 "유효하지 않은 구매 옵션 값 혹은 단위" 오류가 난다.
   */
  _exposedAttrs(item) {
    return (item.attributes || [])
      .map((a, index) => ({ index, typeName: a.attributeTypeName || '', value: a.attributeValueName || '', exposed: a.exposed }))
      .filter(a => a.exposed === 'EXPOSED')
      .map(({ index, typeName, value }) => ({ index, typeName, value }));
  }

  /** 구매옵션 값들로 itemName을 만든다 (쿠팡이 쓰는 규칙: 공백으로 연결) */
  _itemNameFromAttrs(attrs, fallback) {
    const s = (attrs || []).map(a => String(a.value || '').trim()).filter(Boolean).join(' ');
    return s || fallback || '';
  }

  /** 옵션의 대표이미지(REPRESENTATION)를 화면에 띄울 수 있는 전체 URL로 변환 */
  _itemImageUrl(item) {
    const imgs = item.images || [];
    const rep = imgs.find(i => i.imageType === 'REPRESENTATION') || imgs[0];
    if (!rep) return '';
    const raw = rep.cdnPath || rep.vendorPath || '';
    if (!raw) return '';
    if (/^https?:\/\//i.test(raw)) return raw;
    return `https://image1.coupangcdn.com/image/${String(raw).replace(/^\/+/, '')}`;
  }

  /**
   * 수정 화면에 뿌릴 형태로 기존 상품을 불러온다.
   */
  async loadProductForEdit(productId) {
    if (!this.api) this.loadConfig();
    if (!productId) throw new Error('불러올 상품 ID가 입력되지 않았습니다.');

    console.log(`쿠팡 상품 불러오기 (ID: ${productId})`);
    const res = await this.api.getProduct(productId);
    const existing = res?.data;
    if (!existing) {
      throw new Error(`상품 조회 실패 (ID: ${productId}). 올바른 상품 ID인지 확인해주세요.`);
    }

    const items = existing.items || [];
    const options = items.map((it, i) => {
      const attrs = this._exposedAttrs(it);
      return {
        index: i,
        sellerProductItemId: it.sellerProductItemId ?? null,
        vendorItemId: it.vendorItemId ?? null,
        itemName: it.itemName || '',
        attrs,                                   // 구매옵션 속성별 값 (수량 / 차종 …)
        salePrice: it.salePrice ?? 0,
        originalPrice: it.originalPrice ?? 0,
        stock: it.maximumBuyCount ?? 0,
        imageUrl: this._itemImageUrl(it),   // 옵션별 대표이미지 (화면 표시용)
        imageInherited: false,
        isNew: false,
      };
    });

    // 상세설명은 보통 모든 아이템이 동일 → 첫 아이템의 contents 배열 전체에서 뽑는다.
    const detailImages = this._extractDetailImages(items[0]?.contents);

    console.log(`  옵션 ${options.length}개 / 상세이미지 ${detailImages.length}장 불러옴`);

    // 일괄 수정 목록이 옵션 행을 보여 주도록 옵션 구성을 적어 둔다. 판매가는 가격 조회 API 가 채운다(_watchPrices).
    // 옵션ID 가 없는 옵션(승인 전)은 bulk_price_ipc 의 현재가 행처럼 'item-{sellerProductItemId}' 로 둔다.
    this._cache((store, vendorId) => store.saveProduct(vendorId, existing.sellerProductId ?? productId, {
      name: existing.sellerProductName || '', statusName: existing.statusName || '',
      options: options.map(o => ({
        optionId: o.vendorItemId ? String(o.vendorItemId) : 'item-' + (o.sellerProductItemId ?? o.index),
        itemName: o.itemName, readonly: !o.vendorItemId, salePrice: o.salePrice,
      })),
    }));

    return {
      productId: existing.sellerProductId,
      title: existing.sellerProductName || '',
      statusName: existing.statusName || '',
      options,
      detailImages,
      imageContents: items.map(x => [x.sellerProductItemId, x.contents]),
    };
  }

  /**
   * 옵션 하나의 판매가를 바꾼다(일괄 수정용).
   * 상품 수정(PUT seller-products)은 승인 전 상품만 판매가를 바꿀 수 있고 승인 요청까지 다시 보내므로
   * (쿠팡 공식 문서), 승인완료 상품은 아이템별 가격 변경 API 로만 바꾼다.
   * 여기서 쓰기 전에 던지는 오류는 stage=pre-send 로 표시해 화면이 '전송 안 됨'으로 구분하게 한다.
   * @returns {{ unchanged: boolean, salePrice: number }}
   */
  async changeItemPrice({ vendorItemId, salePrice, expectedPrice }) {
    if (!this.api) this.loadConfig();
    const price = Number(salePrice);
    if (!Number.isSafeInteger(price) || price <= 0 || price % 10 !== 0) {
      throw markPreSend(new Error('쿠팡 판매가는 10원 단위 양의 정수여야 합니다.'));
    }
    if (!vendorItemId) throw markPreSend(new Error('승인완료 전 옵션(옵션ID 없음)은 판매가를 바꿀 수 없습니다.'));
    let current;
    try { current = await this.api.getItemInventory(vendorItemId); }
    catch (e) { throw markPreSend(e); }
    const now = Number(current.salePrice);
    if (expectedPrice !== undefined && now !== Number(expectedPrice)) {
      throw markPreSend(new Error(`쿠팡 현재 판매가(${now.toLocaleString('ko-KR')}원)가 조회 이후 변경됐습니다. 다시 불러온 뒤 수정하세요.`));
    }
    if (now === price) return { unchanged: true, salePrice: now };
    // 쿠팡 기본 변경폭: 기존가 대비 최대 50% 인하·100% 인상. 넘으면 쿠팡이 거부하므로 보내기 전에 알린다.
    if (now > 0 && (price < now * 0.5 || price > now * 2)) {
      throw markPreSend(new Error(`쿠팡은 한 번에 기존가(${now.toLocaleString('ko-KR')}원)의 50% 인하·100% 인상까지만 바꿀 수 있습니다. 두 번에 나눠 바꾸거나 쿠팡 판매자센터에서 변경해주세요.`));
    }
    await this.api.updateItemPrice(vendorItemId, price);
    return { unchanged: false, salePrice: price };
  }

  /**
   * 가격 변경 API 로 바꾼 옵션들을 다시 읽어 확인한다. 다르면 1.5초 뒤 한 번 더 읽고, 그래도 다르면 던진다.
   * 조회 자체가 실패하면 변경은 성공한 것이므로 던지지 않고 문구로만 남긴다.
   */
  async _verifyItemPrices(changes) {
    return this._verifyItems(changes, { label: '판매가', want: c => c.price, read: inv => Number(inv.salePrice), unit: '원', strict: true });
  }

  // 재고는 다시 읽은 값(amountInStock)이 요청과 달라도 실패로 치지 않는다 — 수량 API 가 받은 것(code SUCCESS)은
  // 이미 확인했고, amountInStock 이 주문 대기분을 뺀 값인지는 실계정으로 확인하지 못했다. 다르면 문구로 알린다.
  async _verifyItemStocks(changes) {
    return this._verifyItems(changes, { label: '재고', want: c => c.quantity, read: inv => Number(inv.amountInStock), unit: '개', strict: false });
  }

  async _verifyItems(changes, { label, want, read, unit, strict }) {
    const fmt = n => `${n.toLocaleString('ko-KR')}${unit}`;
    const differs = async () => {
      const bad = [];
      for (const c of changes) {
        const now = read(await this.api.getItemInventory(c.vendorItemId));
        if (now !== want(c)) bad.push(`"${c.name}" 현재 ${fmt(now)}(요청 ${fmt(want(c))})`);
      }
      return bad;
    };
    try {
      let bad = await differs();
      if (bad.length) { await sleep(1500); bad = await differs(); }
      if (bad.length && !strict) return `${label} ${changes.length}개 옵션 변경 요청 성공(다시 읽은 값이 다름: ${bad.join(', ')} — 쿠팡에서 확인하세요)`;
      if (bad.length) throw new Error(`쿠팡이 ${label} 변경을 받았지만 아직 반영되지 않았습니다: ${bad.join(', ')}. 잠시 후 다시 불러와 확인해주세요.`);
      return `${label} ${changes.length}개 옵션 변경 확인`;
    } catch (e) {
      if (/반영되지 않았습니다/.test(e.message)) throw e;
      return `${label} ${changes.length}개 옵션 변경 요청 성공(확인 조회 실패: ${e.message})`;
    }
  }

  /**
   * 편집한 옵션/상세이미지를 반영해 저장한다.
   * data = { productId, options: [...], detailImages: [url...] }
   */
  async updateBulkDetailImages({ productId, images, expectedContents }) {
    let payload;
    try {
      if (!this.api) this.loadConfig();
      const urls = parseImageUrls(images, 'coupang');
      // 충돌 검사·PUT 본문은 30초 조회 캐시가 아니라 지금 원본으로 한다.
      const existing = (await this.api.getProduct(productId, { force: true }))?.data;
      if (!existing?.items?.length) throw new Error('상품 옵션을 불러올 수 없습니다.');
      if (JSON.stringify(existing.items.map(x => [x.sellerProductItemId, x.contents])) !== JSON.stringify(expectedContents))
        throw new Error('상세 이미지가 변경됐습니다. 다시 불러오세요.');
      payload = JSON.parse(JSON.stringify(existing));
      for (const item of payload.items) {
        const slots = [];
        for (const block of item.contents || []) for (const detail of block.contentDetails || []) {
          const raw = String(detail.content || '');
          const direct = String(detail.detailType).toUpperCase() === 'IMAGE' ||
            (String(block.contentsType).toUpperCase().startsWith('IMAGE') && !/<img/i.test(raw));
          const count = direct ? 1 : extractNaverDetailImages(raw).length;
          if (count) slots.push({ block, detail, count, direct });
        }
        let cursor = 0;
        slots.forEach((slot, index) => {
          const next = urls.slice(cursor, index === slots.length - 1 ? undefined : cursor + slot.count);
          cursor += next.length;
          // Direct IMAGE fields cannot carry multiple URLs. Use HTML for their replacement.
          if (slot.direct) {
            slot.block.contentsType = 'HTML'; slot.detail.detailType = 'TEXT';
            slot.detail.content = replaceNaverDetailImages('', next.map(url => ({ url, isNew: true })));
          } else slot.detail.content = replaceNaverDetailImages(slot.detail.content, next.map(url => ({ url, isNew: true })));
        });
        if (!slots.length) {
          item.contents ||= [];
          item.contents.push(...this._buildDetailContents(urls.map(url => ({ url }))));
        }
      }
      payload.requested = true;
    } catch (e) { throw markPreSend(e); }
    const result = await this.api.updateProduct(productId, payload);
    if (!['SUCCESS', 'OK', '200'].includes(String(result?.code).toUpperCase()))
      throw Object.assign(new Error(result?.message || '쿠팡 이미지 수정 응답을 확인할 수 없습니다.'), result?.code ? { rejected: true } : {});
    return result;
  }

  async updateExistingProduct(data) {
    if (!this.api) this.loadConfig();

    const productId = data.productId;
    if (!productId) throw new Error('수정할 상품 ID가 입력되지 않았습니다.');

    // 항상 최신 원본을 다시 조회해서 그 위에 덮어쓴다(중간 변경 유실 방지). 30초 조회 캐시를 쓰면 그 사이
    // Wing·다른 PC 에서 바꾼 내용을 옛 본문으로 덮으므로 force 로 읽는다.
    const res = await this.api.getProduct(productId, { force: true });
    const existing = res?.data;
    if (!existing) {
      throw new Error(`상품 조회 실패 (ID: ${productId}). 올바른 상품 ID인지 확인해주세요.`);
    }

    const oldItems = existing.items || [];
    if (oldItems.length === 0) throw new Error('기존 옵션(items)이 없어 수정할 수 없습니다.');

    const editedOptions = Array.isArray(data.options) ? data.options : null;
    const editedImages = Array.isArray(data.detailImages) ? data.detailImages : null;

    if (!editedOptions && !editedImages) {
      throw new Error('변경할 내용이 없습니다.');
    }

    // 새 옵션을 만들 때 필수 필드(notices/attributes/certifications 등)를 물려받을 템플릿
    const templateItem = oldItems[0];
    const newDetailContents = editedImages ? this._buildDetailContents(editedImages) : null;
    if (editedImages && newDetailContents.length === 0) {
      throw new Error('상세페이지 이미지가 0장입니다. 최소 1장은 있어야 합니다. (실수로 전체 삭제되는 것을 막기 위해 중단했습니다)');
    }

    const sourceList = editedOptions || oldItems.map((it, i) => ({ index: i, isNew: false }));
    const usedSources = new Set();
    const priceChanges = [];   // 승인완료 옵션의 판매가 변경 — 아이템별 가격 변경 API 로 따로 보낸다
    const stockChanges = [];   // 승인완료 옵션의 재고 변경 — 아이템별 수량 변경 API 로 따로 보낸다

    const newItems = sourceList.map(opt => {
      // 기존 옵션이면 원본 아이템을, 새 옵션이면 템플릿을 복제해서 식별자를 제거
      let item;
      if (opt.isNew) {
        item = JSON.parse(JSON.stringify(templateItem));
        delete item.sellerProductItemId;
        delete item.vendorItemId;
        delete item.itemId;
      } else {
        // 기존 옵션은 sellerProductItemId(쿠팡이 준 고정 ID)로 찾는다. index 는 '불러올 때의 순서'라
        // 저장 뒤 옵션이 지워지면 어긋난다 — 예전엔 index 를 먼저 봐서, 옵션 하나를 지우고 한 번 더
        // 저장하면 옛 index 가 다른 아이템을 가리켜 한 옵션은 사라지고 한 옵션은 두 번 들어갔다.
        // ID 가 없을 때(ID 를 안 보내는 옛 화면)만 index 로 찾는다. ID 가 있는데 못 찾으면 index 로
        // 대신하지 않고 멈춘다 — 그 index 는 이미 다른 옵션일 수 있다.
        const hasId = opt.sellerProductItemId != null && opt.sellerProductItemId !== '';
        const src = hasId
          ? oldItems.find(o => o.sellerProductItemId != null && String(o.sellerProductItemId) === String(opt.sellerProductItemId))
          : oldItems[opt.index];
        if (!src) {
          throw new Error(hasId
            ? `옵션 원본을 찾지 못했습니다 (옵션ID: ${opt.sellerProductItemId}). 쿠팡에서 이미 삭제됐을 수 있습니다 — 상품을 다시 불러온 뒤 수정해주세요.`
            : `옵션 원본을 찾지 못했습니다 (index: ${opt.index}).`);
        }
        // 같은 원본이 두 번 쓰이면 저장 결과에 같은 옵션이 둘 생긴다(쿠팡은 이걸 막지 않는다).
        if (usedSources.has(src)) {
          throw new Error(`같은 기존 옵션("${src.itemName || src.sellerProductItemId}")이 두 번 들어 있어 저장을 중단했습니다. 상품을 다시 불러온 뒤 수정해주세요.`);
        }
        usedSources.add(src);
        item = JSON.parse(JSON.stringify(src));
      }

      // 구매옵션 값 반영: 속성별로 각각 써넣고, itemName은 그 값들을 이어붙여 만든다.
      // (옵션명 전체를 첫 속성에 넣으면 "유효하지 않은 구매 옵션 값 혹은 단위" 오류가 난다)
      if (Array.isArray(opt.attrs) && opt.attrs.length > 0) {
        for (const a of opt.attrs) {
          const target = item.attributes?.[a.index];
          if (!target) throw new Error(`옵션 속성을 찾지 못했습니다 (index: ${a.index}).`);
          const v = String(a.value ?? '').trim();
          if (!v) throw new Error(`"${a.typeName}" 옵션값이 비어 있습니다.`);
          target.attributeValueName = v;
        }
        item.itemName = this._itemNameFromAttrs(opt.attrs, item.itemName);
      } else if (opt.itemName != null && String(opt.itemName).trim() !== '') {
        // 노출 옵션 속성이 없는 상품용 폴백
        item.itemName = String(opt.itemName).trim();
      }
      if (opt.salePrice != null && opt.salePrice !== '') {
        const p = parseInt(opt.salePrice);
        // 승인완료 옵션(vendorItemId 있음)의 판매가는 상품 수정 PUT 으로 바뀌지 않는다(쿠팡 공식 문서).
        // 여기서는 기록만 하고, 아래에서 가격 변경 API 로 먼저 바꾼다.
        if (p > 0 && !opt.isNew && item.vendorItemId) {
          if (p !== Number(item.salePrice)) priceChanges.push({ item, vendorItemId: item.vendorItemId, name: item.itemName, price: p });
        } else if (p > 0) { item.salePrice = p; item.originalPrice = p; }
      }
      if (opt.stock != null && opt.stock !== '') {
        const s = parseInt(opt.stock);
        // 재고도 판매가처럼 승인완료 옵션은 PUT 으로 바뀌지 않는다(쿠팡 공식 문서). 예전에는 PUT 본문에만 넣고 '성공'으로
        // 알렸다. 화면에 보인 값(상품 문서의 maximumBuyCount)에서 바꾼 옵션만 수량 API 로 보낸다 — 안 바꾼 옵션을 실재고와
        // 견줘 보내면 그 사이 팔린 수량이 되살아난다.
        if (s >= 0 && !opt.isNew && item.vendorItemId) {
          if (s !== Number(item.maximumBuyCount)) stockChanges.push({ vendorItemId: item.vendorItemId, name: item.itemName, quantity: s });
        } else if (s >= 0) item.maximumBuyCount = s;
      }

      // 대표이미지: 사용자가 새 URL을 넣은 경우에만 교체한다.
      // (넣지 않으면 기존 옵션은 자기 이미지 유지, 신규 옵션은 복제한 템플릿 옵션의 이미지를 상속)
      const newImg = (opt.imageUrl || '').trim();
      if (newImg && newImg !== this._itemImageUrl(item)) {
        item.images = [{ imageOrder: 0, imageType: 'REPRESENTATION', vendorPath: getSafeUrl(newImg) }];
      }

      // 상세설명 이미지 교체 (각 이미지의 원본 블록 형식을 그대로 보존)
      if (newDetailContents) {
        item.contents = JSON.parse(JSON.stringify(newDetailContents));
      }

      return item;
    });

    // 원본을 통째로 보존하고 items만 교체
    const payload = {
      ...existing,
      sellerProductId: Number(productId),
      items: newItems,
      requested: true,   // 옵션/상세 변경은 승인 대상
    };

    // 상품명 변경 (입력했을 때만). 쿠팡은 3개 필드를 함께 맞춰야 한다.
    const newTitle = String(data.title ?? '').trim();
    const titleChanged = !!newTitle && newTitle !== existing.sellerProductName;
    if (titleChanged) {
      payload.sellerProductName = newTitle;
      payload.displayProductName = newTitle;
      payload.generalProductName = newTitle;
      console.log(`상품명 변경: "${existing.sellerProductName}" → "${newTitle}"`);
    }

    // 판매가·재고만 바뀌었으면 상품 수정 PUT 을 보내지 않는다 — requested:true 라 승인 요청이 다시 나간다.
    // (아무것도 안 바뀐 저장은 예전처럼 PUT 을 보낸다.)
    const priceOnly = (priceChanges.length > 0 || stockChanges.length > 0) && !titleChanged && !newDetailContents
      && JSON.stringify(newItems) === JSON.stringify(oldItems);

    // 가격은 아무것도 보내기 전에 전부 검사한다(10원 단위, 기존가 대비 50% 인하·100% 인상).
    for (const c of priceChanges) {
      if (c.price % 10 !== 0) throw new Error(`"${c.name}" 판매가(${c.price}원)는 10원 단위여야 합니다. 아무것도 저장하지 않았습니다.`);
      c.now = Number((await this.api.getItemInventory(c.vendorItemId)).salePrice);
      if (c.now > 0 && (c.price < c.now * 0.5 || c.price > c.now * 2)) {
        throw new Error(`"${c.name}" 판매가는 한 번에 기존가(${c.now.toLocaleString('ko-KR')}원)의 50% 인하·100% 인상까지만 바꿀 수 있습니다. 아무것도 저장하지 않았습니다.`);
      }
    }
    const changed = [];
    for (const c of priceChanges.filter(c => c.now !== c.price)) {
      try {
        await this.api.updateItemPrice(c.vendorItemId, c.price);
      } catch (e) {
        const done = changed.length ? ` 앞의 ${changed.length}개 옵션 판매가는 이미 바뀌었습니다.` : '';
        throw new Error(`"${c.name}" 판매가 변경 실패: ${e.message}${done} 상품명·옵션·이미지 수정은 보내지 않았습니다.`, { cause: e });
      }
      changed.push(c);
    }
    // PUT 본문에도 새 가격을 넣어, 쿠팡이 본문 가격을 읽더라도 방금 바꾼 값으로 되돌리지 않게 한다.
    for (const c of priceChanges) c.item.salePrice = c.price;
    if (changed.length) console.log(`쿠팡 판매가 변경 (가격 변경 API): ${changed.map(c => `${c.name} ${c.now}→${c.price}`).join(', ')}`);

    const stocked = [];
    const sentNote = () => [changed.length && `판매가 ${changed.length}개`, stocked.length && `재고 ${stocked.length}개`].filter(Boolean).join('·');
    for (const c of stockChanges) {
      try {
        await this.api.updateItemQuantity(c.vendorItemId, c.quantity);
      } catch (e) {
        const done = sentNote() ? ` 앞의 ${sentNote()} 옵션은 이미 바뀌었습니다.` : '';
        throw new Error(`"${c.name}" 재고 변경 실패: ${e.message}${done} 상품명·옵션·이미지 수정은 보내지 않았습니다.`, { cause: e });
      }
      stocked.push(c);
    }
    if (stocked.length) console.log(`쿠팡 재고 변경 (수량 변경 API): ${stocked.map(c => `${c.name} → ${c.quantity}`).join(', ')}`);

    if (priceOnly) {
      const verified = [changed.length && await this._verifyItemPrices(changed), stocked.length && await this._verifyItemStocks(stocked)]
        .filter(Boolean).join(', ') || '판매가가 이미 같습니다';
      console.log(`✓ 쿠팡 판매가·재고 변경 완료 (${verified}) — 상품 수정 요청은 보내지 않았습니다.`);
      return { code: 'SUCCESS', priceOnly: true, verified };
    }
    const priceNote = msg => (sentNote() ? `${sentNote()} 옵션은 이미 바뀌었습니다. 나머지 수정은 실패: ${msg}` : msg);

    const removed = oldItems.length - newItems.filter(i => i.sellerProductItemId).length;
    console.log(`쿠팡 상품수정 저장 (옵션 ${oldItems.length} → ${newItems.length}개${removed > 0 ? `, 삭제 ${removed}개` : ''})`);

    let result;
    try {
      result = await this.api.updateProduct(productId, payload);
    } catch (e) {
      e.message = priceNote(e.message);
      throw e;
    }

    // 쿠팡은 검증 실패도 HTTP 200 + {code:'ERROR', message:'...'} 로 돌려준다.
    // 본문 코드를 확인하지 않으면 실패를 성공으로 오보하게 된다.
    const code = String(result?.code ?? '').toUpperCase();
    const apiMsg = result?.message || result?.data?.message || '';
    console.log(`[쿠팡 수정 응답] code=${code || '(없음)'} message=${apiMsg || '(없음)'}`);
    if (code && !['SUCCESS', 'OK', '200'].includes(code)) {
      throw new Error(priceNote(`쿠팡이 수정을 거부했습니다: ${apiMsg || code}`));
    }

    // 실제 반영 검증: 다시 조회해서 옵션 수/이름과 상세 이미지 수를 대조한다.
    await sleep(2500);
    let verify = '';
    try {
      const after = (await this.api.getProduct(productId))?.data;
      const afterItems = after?.items || [];
      const afterImgs = this._extractDetailImages(afterItems[0]?.contents);
      const wantNames = newItems.map(i => i.itemName).sort().join('|');
      const gotNames = afterItems.map(i => i.itemName).sort().join('|');
      const optOk = wantNames === gotNames;
      const imgOk = !newDetailContents || afterImgs.length === newDetailContents.length;

      const titleOk = !payload.sellerProductName || after?.sellerProductName === payload.sellerProductName;

      verify = `옵션 ${afterItems.length}개(요청 ${newItems.length}개), 상세이미지 ${afterImgs.length}장`
        + (newDetailContents ? `(요청 ${newDetailContents.length}장)` : '')
        + (payload.sellerProductName ? `, 상품명 ${titleOk ? '변경됨' : '미반영'}` : '')
        + (changed.length ? `, ${await this._verifyItemPrices(changed)}` : '')
        + (stocked.length ? `, ${await this._verifyItemStocks(stocked)}` : '');

      if (!titleOk) {
        throw new Error(`상품명이 반영되지 않았습니다. 현재: "${after?.sellerProductName}"`);
      }
      if (!optOk || !imgOk) {
        throw new Error(
          `쿠팡이 성공을 응답했지만 실제로는 반영되지 않았습니다. 현재 상태: ${verify}. `
          + `상품 상태: ${after?.statusName || '?'}. (승인 심사 중이라 잠시 후 반영될 수도 있습니다)`
        );
      }
      console.log(`✓ 쿠팡 상품수정 완료 및 반영 확인! (${verify})`);
    } catch (e) {
      if (/반영되지 않았습니다/.test(e.message)) throw e;
      console.log(`(반영 확인 조회 실패: ${e.message}) — 저장 요청 자체는 성공했습니다.`);
    }

    return { ...result, verified: verify };
  }

  _buildCopyPayload(template, data) {
    const price = parseInt(data.price) || 115000;
    const stock = parseInt(data.stock) || 999;
    const now = new Date().toISOString().replace(/\.\d+Z$/, '');
    const endDate = '2099-01-01T23:59:59';

    // 대표 이미지 및 수량 파싱
    const mainImageUrl = getSafeUrl(data.mainImageUrl || '');
    const quantity = data.optionProduct || '1개';

    // 조견표 이미지 안전 처리
    let newImageUrl = getSafeUrl(data.esmImageUrl || '');
    if (!newImageUrl && data.esmHtml) {
      const htmlTrimmed = data.esmHtml.trim();
      if (htmlTrimmed.startsWith('http') && (!htmlTrimmed.includes('<') || htmlTrimmed.match(/\.(jpg|jpeg|png|gif|webp)$/i))) {
        newImageUrl = getSafeUrl(htmlTrimmed);
      } else {
        const match = htmlTrimmed.match(/src=["']([^"']+)["']/i);
        if (match) newImageUrl = getSafeUrl(match[1]);
      }
    }

    let newSpecHtml = data.esmHtml || '';
    if (newImageUrl && !newSpecHtml) {
      newSpecHtml = `<img src="${newImageUrl}" />`;
    }

    // 옵션 모델 파싱
    const models = (data.optionModel || '').split(',').map(s => s.trim()).filter(Boolean);

    const templateItem = template.items[0];
    const items = [];

    // [개선] 운전석/조수석 분리 루프를 제거하고, 사용자가 입력한 모델명 목록을 기반으로 직관적 매핑 진행
    for (const model of (models.length > 0 ? models : ['공용'])) {
      items.push(this._cloneTemplateItem(templateItem, {
        itemName: `${model} / ${quantity}`,
        carModel: model,
        price,
        stock,
        newSpecHtml,
        detailHtml: data.detailHtml ? [newSpecHtml, data.detailHtml].filter(Boolean).join('\n') : '',
        newImageUrl,
        mainImageUrl,
        quantity,
      }));
    }

    return {
      displayCategoryCode: template.displayCategoryCode,
      sellerProductName: data.title,
      displayProductName: data.title,
      generalProductName: data.title,
      vendorId: template.vendorId,
      brand: template.brand || '옵틱글래스',
      manufacture: template.manufacture || '중국',
      saleStartedAt: now,
      saleEndedAt: endDate,
      productGroup: '',
      deliveryMethod: template.deliveryMethod,
      deliveryCompanyCode: template.deliveryCompanyCode,
      deliveryChargeType: template.deliveryChargeType,
      deliveryCharge: template.deliveryCharge || 0,
      freeShipOverAmount: template.freeShipOverAmount || 0,
      deliveryNotice: '',
      returnCenterCode: String(template.returnCenterCode),
      returnChargeName: template.returnChargeName,
      returnCharge: template.returnCharge,
      deliveryChargeOnReturn: template.deliveryChargeOnReturn,
      returnZipCode: template.returnZipCode,
      returnAddress: template.returnAddress,
      returnAddressDetail: template.returnAddressDetail || '-',
      companyContactNumber: template.companyContactNumber,
      afterServiceInformation: template.afterServiceInformation,
      afterServiceContactNumber: template.afterServiceContactNumber,
      outboundShippingPlaceCode: Number(template.outboundShippingPlaceCode),
      vendorUserId: template.vendorUserId,
      requested: true,
      unionDeliveryType: template.unionDeliveryType || 'UNION_DELIVERY',
      remoteAreaDeliverable: template.remoteAreaDeliverable || 'N',
      items: items,
    };
  }

  _cloneTemplateItem(templateItem, { itemName, carModel, price, stock, newSpecHtml, detailHtml, newImageUrl, mainImageUrl, quantity }) {
    const contents = [];

    // 1. 원본 템플릿의 상세설명 HTML 복제
    let originalHtml = '';
    const templateContentObj = templateItem.contents?.find(c => c.contentsType === 'HTML');
    if (templateContentObj && templateContentObj.contentDetails?.length > 0) {
      originalHtml = templateContentObj.contentDetails[0].content || '';
    }

    // 2. 신규 상세이미지(조견표) 주소를 <img> 태그로 구성하여 첫 번째 </p> 뒤에 삽입
    let mergedHtml = '';
    if (detailHtml) {
      mergedHtml = detailHtml;
    } else if (newImageUrl) {
      const safeUrl = getSafeUrl(newImageUrl);
      const newImageTag = `<p style="text-align: center;"><img style="display: block; margin-left: auto; margin-right: auto;" src="${safeUrl}" /></p>`;
      
      const pIndex = originalHtml.indexOf('</p>');
      if (pIndex !== -1) {
        const part1 = originalHtml.substring(0, pIndex + 4);
        const part2 = originalHtml.substring(pIndex + 4);
        mergedHtml = part1 + '\n' + newImageTag + '\n' + part2;
      } else {
        mergedHtml = newImageTag + '<br>' + originalHtml;
      }
    } else {
      mergedHtml = originalHtml;
    }

    // 3. HTML 타입 상세설명 등록
    if (mergedHtml) {
      contents.push({
        contentsType: 'HTML',
        contentDetails: [{
          content: mergedHtml,
          detailType: 'TEXT'
        }]
      });
    }

    // 쿠팡 필수 속성 매핑 (차종, 수량)
    const attributes = [];
    for (const attr of (templateItem.attributes || [])) {
      if (attr.attributeTypeName === '차종') {
        attributes.push({ attributeTypeName: '차종', attributeValueName: carModel });
      } else if (attr.attributeTypeName === '수량') {
        attributes.push({ attributeTypeName: '수량', attributeValueName: quantity });
      }
    }

    // 대표 이미지 적용
    const images = [];
    if (mainImageUrl) {
      images.push({
        imageOrder: 0,
        imageType: 'REPRESENTATION',
        vendorPath: getSafeUrl(mainImageUrl),
      });
    } else if (templateItem.images?.length > 0) {
      const imgObj = templateItem.images[0];
      let imgPath = imgObj.vendorPath || '';
      if (imgPath && !imgPath.startsWith('http')) {
        if (imgObj.cdnPath) {
          imgPath = imgObj.cdnPath.startsWith('http') 
            ? imgObj.cdnPath 
            : `http://image1.coupangcdn.com/image/${imgObj.cdnPath}`;
        }
      }
      images.push({
        imageOrder: 0,
        imageType: 'REPRESENTATION',
        vendorPath: getSafeUrl(imgPath),
      });
    } else if (newImageUrl) {
      images.push({
        imageOrder: 0,
        imageType: 'REPRESENTATION',
        vendorPath: getSafeUrl(newImageUrl),
      });
    }

    // 고시정보 복사 및 에러 방지용 필터링
    const notices = [];
    for (const notice of (templateItem.notices || [])) {
      const detailName = notice.noticeCategoryDetailName || '';
      if (detailName.includes('검사합격증') || detailName.includes('검사합증') || detailName.includes('첨가제') || detailName.includes('촉매제')) {
        continue;
      }
      notices.push(notice);
    }

    return {
      itemName,
      originalPrice: price,
      salePrice: price,
      maximumBuyCount: stock,
      maximumBuyForPerson: 0,
      maximumBuyForPersonPeriod: 1,
      outboundShippingTimeDay: templateItem.outboundShippingTimeDay || 2,
      unitCount: 1,
      adultOnly: 'EVERYONE',
      taxType: 'TAX',
      parallelImported: 'NOT_PARALLEL_IMPORTED',
      overseasPurchased: 'NOT_OVERSEAS_PURCHASED',
      pccNeeded: false,
      bestPriceGuaranteed3P: false,
      searchTags: templateItem.searchTags || ['옵틱글래스', '사이드미러', '광각미러', '와이드미러'],
      images,
      notices,
      attributes,
      certifications: templateItem.certifications || [
        { certificationType: 'PRESENTED_IN_DETAIL_PAGE', certificationCode: '', certificationAttachments: [] }
      ],
      contents,
      offerCondition: 'NEW',
      offerDescription: '',
    };
  }
}
