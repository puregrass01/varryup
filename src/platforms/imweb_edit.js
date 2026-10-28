import path from 'path';
import { fileURLToPath } from 'url';
import { Imweb } from './imweb.js';

const CATEGORIES_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'imweb_categories.json');

/**
 * 아임웹 작업 묶음.
 *
 *  - B2B몰 상품(조회 · 등록 · 수정 · 상품수정 탭 · 카테고리 동기화): 아임웹 Open API — imweb_b2b.js(this.b2b).
 *    예전의 내부 관리자 API(브라우저로 가로챈 토큰) · v2 API · 화면 클릭은 2026-10-05 지웠다. 메서드 이름은
 *    화면 · 중복 검사 · 일괄 수정이 그대로 부르도록 남겨 두고 Open API 로 넘긴다.
 */
export class ImwebEdit extends Imweb {
    constructor() {
        super();
        this.b2b = null;   // main_process 가 createB2bApi(B2B몰 OAuth 클라이언트)로 넣는다
    }

    get b2bApi() {
        if (!this.b2b) throw new Error('아임웹 B2B몰 Open API 연결이 없습니다. 아임웹 탭 > Open API 키의 OAuth 값을 확인하세요.');
        return this.b2b;
    }

    // ── B2B몰: 전부 Open API(imweb_b2b.js) ─────────────────────────────────────
    registerB2bViaApi(data) { return this.b2bApi.registerB2bViaApi(data); }
    listB2bRowsByCode(code) { return this.b2bApi.listB2bRowsByCode(code); }
    b2bOptionValuesOf(prodNo) { return this.b2bApi.b2bOptionValuesOf(prodNo); }
    searchProducts(query) { return this.b2bApi.searchProducts(query); }
    loadGroup(prodNos) { return this.b2bApi.loadGroup(prodNos); }
    updateGroup(data) { return this.b2bApi.updateGroup(data); }
    loadProduct(prodNo) { return this.b2bApi.loadProduct(prodNo); }
    updateProduct(data) { return this.b2bApi.updateProduct(data); }
    /** 화면의 브랜드/차종 목록 파일을 B2B몰 카테고리로 새로 만든다(예전엔 관리자 화면 응답을 가로챘다). */
    syncCategories() { return this.b2bApi.syncCategories(CATEGORIES_PATH); }
}
