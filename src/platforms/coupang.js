import { CoupangAPI } from './coupang_api.js';
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
    try { res = await fetch(url, { redirect: 'follow' }); }
    catch (e) { throw new Error(`상품 시트를 불러오지 못했습니다: ${e.message}`); }
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
  constructor(configPath) {
    this.configPath = configPath;
    this.config = null;
    this.api = null;
  }

  loadConfig() {
    if (!fs.existsSync(this.configPath)) {
      throw new Error('쿠팡 설정 파일이 없습니다. 먼저 API 설정을 완료해주세요.');
    }
    const raw = fs.readFileSync(this.configPath, 'utf-8');
    this.config = JSON.parse(raw);

    if (!this.config.vendorId || !this.config.accessKey || !this.config.secretKey) {
      throw new Error('쿠팡 API 키가 설정되지 않았습니다. 쿠팡 탭에서 API 설정을 완료해주세요.');
    }

    this.api = new CoupangAPI(
      this.config.vendorId,
      this.config.accessKey,
      this.config.secretKey,
      this.config.vendorId
    );

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
      for (const d of (r.data || [])) {
        all.push({ id: String(d.sellerProductId), name: String(d.sellerProductName || '') });
      }
      nextToken = r.nextToken;
      pages++;
    } while (nextToken && pages < 50);
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

  saveConfig(newConfig) {
    if (this.config) {
      this.config = { ...this.config, ...newConfig };
    } else {
      this.config = newConfig;
    }
    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf-8');
    console.log('쿠팡 설정 저장 완료:', this.configPath);

    if (this.config.vendorId && this.config.accessKey && this.config.secretKey) {
      this.api = new CoupangAPI(
        this.config.vendorId,
        this.config.accessKey,
        this.config.secretKey,
        this.config.vendorId
      );
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

  async getCategories() {
    if (!this.api) this.loadConfig();
    return await this.api.getCategories();
  }

  async getCategoryMeta(categoryCode) {
    if (!this.api) this.loadConfig();
    return await this.api.getCategoryMeta(categoryCode);
  }

  async registerProduct(data) {
    if (!this.api) this.loadConfig();

    console.log('쿠팡 상품 등록 시작:', data.title);
    const payload = this._buildProductPayload(data);

    console.log('쿠팡 API 요청 데이터 구성 완료');
    const result = await this.api.registerProduct(payload);

    console.log('✓ 쿠팡 상품 등록 완료!');
    return result;
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
    console.log('✓ 쿠팡 복사등록 완료!');
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

  /** 아이템(옵션)에서 화면에 노출되는 옵션값 attribute를 찾는다 */
  _exposedAttrIndex(item) {
    return (item.attributes || []).findIndex(a => a.exposed === 'EXPOSED');
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

    return {
      productId: existing.sellerProductId,
      title: existing.sellerProductName || '',
      statusName: existing.statusName || '',
      options,
      detailImages,
    };
  }

  /**
   * 편집한 옵션/상세이미지를 반영해 저장한다.
   * data = { productId, options: [...], detailImages: [url...] }
   */
  async updateExistingProduct(data) {
    if (!this.api) this.loadConfig();

    const productId = data.productId;
    if (!productId) throw new Error('수정할 상품 ID가 입력되지 않았습니다.');

    // 항상 최신 원본을 다시 조회해서 그 위에 덮어쓴다(중간 변경 유실 방지).
    const res = await this.api.getProduct(productId);
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

    const newItems = sourceList.map(opt => {
      // 기존 옵션이면 원본 아이템을, 새 옵션이면 템플릿을 복제해서 식별자를 제거
      let item;
      if (opt.isNew) {
        item = JSON.parse(JSON.stringify(templateItem));
        delete item.sellerProductItemId;
        delete item.vendorItemId;
        delete item.itemId;
      } else {
        const src = oldItems[opt.index] ?? oldItems.find(o => o.sellerProductItemId === opt.sellerProductItemId);
        if (!src) throw new Error(`옵션 원본을 찾지 못했습니다 (index: ${opt.index}).`);
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
        if (p > 0) { item.salePrice = p; item.originalPrice = p; }
      }
      if (opt.stock != null && opt.stock !== '') {
        const s = parseInt(opt.stock);
        if (s >= 0) item.maximumBuyCount = s;
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
    if (newTitle && newTitle !== existing.sellerProductName) {
      payload.sellerProductName = newTitle;
      payload.displayProductName = newTitle;
      payload.generalProductName = newTitle;
      console.log(`상품명 변경: "${existing.sellerProductName}" → "${newTitle}"`);
    }

    const removed = oldItems.length - newItems.filter(i => i.sellerProductItemId).length;
    console.log(`쿠팡 상품수정 저장 (옵션 ${oldItems.length} → ${newItems.length}개${removed > 0 ? `, 삭제 ${removed}개` : ''})`);

    const result = await this.api.updateProduct(productId, payload);

    // 쿠팡은 검증 실패도 HTTP 200 + {code:'ERROR', message:'...'} 로 돌려준다.
    // 본문 코드를 확인하지 않으면 실패를 성공으로 오보하게 된다.
    const code = String(result?.code ?? '').toUpperCase();
    const apiMsg = result?.message || result?.data?.message || '';
    console.log(`[쿠팡 수정 응답] code=${code || '(없음)'} message=${apiMsg || '(없음)'}`);
    if (code && !['SUCCESS', 'OK', '200'].includes(code)) {
      throw new Error(`쿠팡이 수정을 거부했습니다: ${apiMsg || code}`);
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
        + (payload.sellerProductName ? `, 상품명 ${titleOk ? '변경됨' : '미반영'}` : '');

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

  _cloneTemplateItem(templateItem, { itemName, carModel, price, stock, newSpecHtml, newImageUrl, mainImageUrl, quantity }) {
    const contents = [];

    // 1. 원본 템플릿의 상세설명 HTML 복제
    let originalHtml = '';
    const templateContentObj = templateItem.contents?.find(c => c.contentsType === 'HTML');
    if (templateContentObj && templateContentObj.contentDetails?.length > 0) {
      originalHtml = templateContentObj.contentDetails[0].content || '';
    }

    // 2. 신규 상세이미지(조견표) 주소를 <img> 태그로 구성하여 첫 번째 </p> 뒤에 삽입
    let mergedHtml = '';
    if (newImageUrl) {
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

  _buildProductPayload(data) {
    const config = this.config;
    const now = new Date().toISOString().replace(/\.\d+Z$/, '');
    const endDate = '2099-01-01T23:59:59';

    let detailHtml = '';
    if (data.esmHtml) {
      detailHtml = data.esmHtml;
      if (!detailHtml.toLowerCase().includes('<img') && !detailHtml.toLowerCase().includes('<div')) {
        if (detailHtml.trim().startsWith('http')) {
          detailHtml = `<img src="${detailHtml.trim()}" />`;
        } else {
          detailHtml = `<img src="${detailHtml}" />`;
        }
      }
    }

    let imageUrl = getSafeUrl(data.esmImageUrl || '');
    if (!imageUrl && data.esmHtml) {
      const htmlTrimmed = data.esmHtml.trim();
      if (htmlTrimmed.startsWith('http') && (!htmlTrimmed.includes('<') || htmlTrimmed.match(/\.(jpg|jpeg|png|gif|webp)$/i))) {
        imageUrl = getSafeUrl(htmlTrimmed);
      } else {
        const match = htmlTrimmed.match(/src=["']([^"']+)["']/i);
        if (match) imageUrl = getSafeUrl(match[1]);
      }
    }

    const items = this._buildItems(data, imageUrl, detailHtml, now, endDate);

    return {
      displayCategoryCode: config.displayCategoryCode,
      sellerProductName: data.title,
      displayProductName: data.title,
      vendorId: config.vendorId,
      saleStartedAt: now,
      saleEndedAt: endDate,
      brand: config.brand || '옵틱글래스',
      generalProductName: data.title,
      productGroup: '',
      deliveryMethod: config.deliveryMethod || 'SEQUENCIAL',
      deliveryCompanyCode: config.deliveryCompanyCode || 'CJGLS',
      deliveryChargeType: config.deliveryChargeType || 'FREE',
      deliveryCharge: config.deliveryCharge || 0,
      freeShipOverAmount: 0,
      deliveryNotice: '',
      returnCenterCode: config.returnCenterCode ? String(config.returnCenterCode) : '',
      returnChargeName: config.returnChargeName || '(주)퓨어그래스',
      returnCharge: config.returnCharge !== undefined ? config.returnCharge : 3000,
      deliveryChargeOnReturn: config.returnCharge !== undefined ? config.returnCharge : 3000,
      returnZipCode: '16481',
      returnAddress: '경기도 수원시 팔달구 경수대로507번길 5',
      returnAddressDetail: '-',
      companyContactNumber: '010-5931-9658',
      afterServiceInformation: config.afterServiceInformation || '옵틱글래스 A/S 센터',
      afterServiceContactNumber: config.afterServiceContactNumber || '',
      outboundShippingPlaceCode: config.outboundShippingPlaceCode ? Number(config.outboundShippingPlaceCode) : 0,
      vendorUserId: config.vendorUserId || 'puregrass001',
      requested: true,
      unionDeliveryType: 'UNION_DELIVERY',
      remoteAreaDeliverable: 'N',
      jejuDeliveryCharge: 0,
      islandDeliveryCharge: 0,
      items: items,
    };
  }

  _buildItems(data, imageUrl, detailHtml, startDate, endDate) {
    const items = [];
    const basePrice = parseInt(data.price) || 115000;
    const stock = parseInt(data.stock) || 999;

    const models = (data.optionModel || '').split(',').map(s => s.trim()).filter(Boolean);
    const quantity = data.optionProduct || '1개';

    const images = [];
    if (imageUrl) {
      images.push({
        imageOrder: 0,
        imageType: 'REPRESENTATION',
        vendorPath: getSafeUrl(imageUrl)
      });
    }

    const notices = [
      { noticeCategoryName: '자동차용품 (자동차부품/기타 자동차용품 등)', noticeCategoryDetailName: '품명 및 모델명', content: '상품 상세페이지 참조' },
      { noticeCategoryName: '자동차용품 (자동차부품/기타 자동차용품 등)', noticeCategoryDetailName: '동일모델 출시년월', content: '상품 상세페이지 참조' },
      { noticeCategoryName: '자동차용품 (자동차부품/기타 자동차용품 등)', noticeCategoryDetailName: 'KC 인증정보(자동차관리법에 따른 자기인증 대상 자동차부품에 한함)', content: '상품 상세페이지 참조' },
      { noticeCategoryName: '자동차용품 (자동차부품/기타 자동차용품 등)', noticeCategoryDetailName: '제조자(수입자)', content: '상품 상세페이지 참조' },
      { noticeCategoryName: '자동차용품 (자동차부품/기타 자동차용품 등)', noticeCategoryDetailName: '제조국', content: '상품 상세페이지 참조' },
      { noticeCategoryName: '자동차용품 (자동차부품/기타 자동차용품 등)', noticeCategoryDetailName: '크기', content: '상품 상세페이지 참조' },
      { noticeCategoryName: '자동차용품 (자동차부품/기타 자동차용품 등)', noticeCategoryDetailName: '적용차종', content: '상품 상세페이지 참조' },
      { noticeCategoryName: '자동차용품 (자동차부품/기타 자동차용품 등)', noticeCategoryDetailName: '제품사용으로 인한 위험 및 유의사항(연료절감장치에 한함)', content: '상품 상세페이지 참조' },
      { noticeCategoryName: '자동차용품 (자동차부품/기타 자동차용품 등)', noticeCategoryDetailName: '품질보증기준', content: '상품 상세페이지 참조' },
      { noticeCategoryName: '자동차용품 (자동차부품/기타 자동차용품 등)', noticeCategoryDetailName: 'A/S 책임자와 전화번호', content: this.config.afterServiceContactNumber || '상품 상세페이지 참조' }
    ];

    for (const model of (models.length > 0 ? models : ['공용'])) {
      items.push(this._createItem({
        itemName: `${model} / ${quantity}`,
        originalPrice: basePrice,
        salePrice: basePrice,
        stock,
        images,
        detailHtml,
        notices,
        startDate,
        endDate,
        attributes: [
          { attributeTypeName: '차종', attributeValueName: model },
          { attributeTypeName: '수량', attributeValueName: quantity }
        ]
      }));
    }

    return items;
  }

  _createItem({ itemName, originalPrice, salePrice, stock, images, detailHtml, notices, startDate, endDate, attributes }) {
    const item = {
      itemName: itemName,
      originalPrice: originalPrice,
      salePrice: salePrice,
      maximumBuyCount: 0,
      maximumBuyForPerson: 0,
      maximumBuyForPersonPeriod: 1,
      outboundShippingTimeDay: 2,
      unitCount: 1,
      adultOnly: 'EVERYONE',
      taxType: 'TAX',
      parallelImported: 'NOT_PARALLEL_IMPORTED',
      overseasPurchased: 'NOT_OVERSEAS_PURCHASED',
      pccNeeded: false,
      bestPriceGuaranteed3P: false,
      searchTags: ['옵틱글래스', '사이드미러', '광각미러', '와이드미러'],
      images: images,
      notices: notices,
      attributes: attributes || [],
      contents: [],
      offerCondition: 'NEW',
      offerDescription: '',
      emptyBarcode: true,
      emptyBarcodeReason: 'COUPANG',
      certifications: [
        {
          certificationType: 'PRESENTED_IN_DETAIL_PAGE',
          certificationCode: '',
          certificationAttachments: []
        }
      ],
    };

    if (detailHtml) {
      item.contents = [
        {
          contentsType: 'HTML',
          contentDetails: [
            {
              content: detailHtml,
              detailType: 'TEXT'
            }
          ]
        }
      ];
    }

    return item;
  }
}