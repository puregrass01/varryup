// 엑셀 1줄(data) → 아임웹 상품등록 POST payload 조립.
// 실제 등록(POST)은 하지 않고 payload 객체만 만든다(= dry-run 가능). 쓰기는 register.js 에서.
//
// data 필드(메인 프로그램과 동일):
//   hasBsa, bsaO, bsaX, nationality, brand, model, titleBrand, titleModel,
//   year, code, price, mainImageUrl | mainImagePath, specImageUrl
// type: 'set'(1셋) | 'indiv'(운전석/조수석)

import { buildCategories } from './categories.js';

// 연식 값: BSA X 상품은 업그레이드용으로 BSA O 도 함께 판매(마크 2개), 순수 BSA O 는 1개.
function yearValues(data) {
    let marks;
    if (data.bsaO !== undefined || data.bsaX !== undefined) {
        marks = data.bsaX ? ['BSA X', 'BSA O'] : ['BSA O'];
    } else {
        marks = data.hasBsa ? ['BSA O'] : ['BSA X', 'BSA O'];
    }
    return marks.map(m => `${data.year} [No.${data.code}] ${m}`);
}

// 옵션(선택형) 구성. POST/PATCH 스키마: options = { is_mix, list:[{is_require,type,name,values:[문자열]}] }.
// (GET 응답의 value_list:[{name}] 과 다르니 주의 — 쓰기는 values:[문자열].)
// is_mix=true = 조합형(옵션끼리 조합), 템플릿 1290/1291 과 동일.
export function buildOptions(data, type) {
    const list = [
        { is_require: true, type: 'default', name: '차종',
          values: [data.titleModel || data.model] },
        { is_require: true, type: 'default', name: '연식',
          values: yearValues(data) },
    ];
    if (type === 'indiv') {
        list.push({ is_require: true, type: 'default', name: '구성',
            values: ['운전석만', '조수석만'] });
    }
    return { is_mix: true, list };
}

// 상세설명 HTML — 공지 + 조견표(상품별 교체) + 상세페이지(상단/본문/하단) 전체.
// 기존 프로그램 generateDescriptionHtml 과 동일. 고정 이미지 URL 은 이미 %-인코딩됨.
export function buildContent(data) {
    const specUrl = extractImageUrl(data.specImageUrl);
    return `<!--1. 공지 영역-->
<p><img src="https://ai.esmplus.com/yhshma/%EC%98%B5%ED%8B%B1%EA%B8%80%EB%9E%98%EC%8A%A4%20%EC%83%81%EC%84%B8%ED%8E%98%EC%9D%B4%EC%A7%80/%EA%B3%B5%EC%A7%80/%EA%B3%B5%EC%A7%804.jpg" class="fr-fic fr-dib">
	<br><img src="https://ai.esmplus.com/yhshma/%EC%98%B5%ED%8B%B1%EA%B8%80%EB%9E%98%EC%8A%A4%20%EC%83%81%EC%84%B8%ED%8E%98%EC%9D%B4%EC%A7%80/%EA%B3%B5%EC%A7%80/%EA%B3%B5%EC%A7%805.jpg" class="fr-fic fr-dib">
	<br><img src="https://ai.esmplus.com/yhshma/%EC%98%B5%ED%8B%B1%EA%B8%80%EB%9E%98%EC%8A%A4%20%EC%83%81%EC%84%B8%ED%8E%98%EC%9D%B4%EC%A7%80/%EA%B3%B5%EC%A7%80/%EA%B3%B5%EC%A7%806.jpg" class="fr-fic fr-dib">
	<br>
</p>
<!--2. 조견표 영역-->
<p>
	<br>
</p>
<p style="text-align: center;"><span style="font-size: 36px;"><strong>※${data.titleBrand} ${data.titleModel} 조견표※</strong></span></p>
<p><img src="${specUrl}" class="fr-fic fr-dib"></p>
<!--3. 상세페이지 영역-->
<p>
	<!--A .상세페이지 상단-->&nbsp;<img src="https://ai.esmplus.com/yhshma/%EC%98%B5%ED%8B%B1%EA%B8%80%EB%9E%98%EC%8A%A4%20%EC%83%81%EC%84%B8%ED%8E%98%EC%9D%B4%EC%A7%80/%EC%83%81%ED%9E%88%20%EC%83%81%EB%8B%A8/%EC%83%81%ED%8E%98%20%EC%83%81%EB%8B%A81.jpg" class="fr-fic fr-dib">
	<br><img src="https://ai.esmplus.com/yhshma/%EC%98%B5%ED%8B%B1%EA%B8%80%EB%9E%98%EC%8A%A4%20%EC%83%81%EC%84%B8%ED%8E%98%EC%9D%B4%EC%A7%80/%EC%83%81%ED%9E%88%20%EC%83%81%EB%8B%A8/%EC%83%81%ED%8E%98%20%EC%83%81%EB%8B%A82.jpg" class="fr-fic fr-dib">
	<br><img src="https://ai.esmplus.com/yhshma/%EC%98%B5%ED%8B%B1%EA%B8%80%EB%9E%98%EC%8A%A4%20%EC%83%81%EC%84%B8%ED%8E%98%EC%9D%B4%EC%A7%80/%EC%83%81%ED%9E%88%20%EC%83%81%EB%8B%A8/%EC%83%81%ED%8E%98%20%EC%83%81%EB%8B%A83.jpg" class="fr-fic fr-dib">
	<br>
	<!--B .상세페이지-->&nbsp;<img src="https://ai.esmplus.com/yhshma/%EC%98%B5%ED%8B%B1%EA%B8%80%EB%9E%98%EC%8A%A4%20%EC%83%81%EC%84%B8%ED%8E%98%EC%9D%B4%EC%A7%80/%EC%98%B5%ED%8B%B1%EA%B8%80%EB%9E%98%EC%8A%A4%20%EC%83%81%EC%84%B8%ED%8E%98%EC%9D%B4%EC%A7%80.jpg" class="fr-fic fr-dib">
	<br>
	<!--C. 상세페이지 하단-->&nbsp;<img src="https://ai.esmplus.com/yhshma/%EC%98%B5%ED%8B%B1%EA%B8%80%EB%9E%98%EC%8A%A4%20%EC%83%81%EC%84%B8%ED%8E%98%EC%9D%B4%EC%A7%80/%EC%83%81%ED%9E%88%20%ED%95%98%EB%8B%A8/%EC%83%81%ED%9E%88%20%ED%95%98%EB%8B%A81.jpg" class="fr-fic fr-dib">
	<br><img src="https://ai.esmplus.com/yhshma/%EC%98%B5%ED%8B%B1%EA%B8%80%EB%9E%98%EC%8A%A4%20%EC%83%81%EC%84%B8%ED%8E%98%EC%9D%B4%EC%A7%80/%EC%83%81%ED%9E%88%20%ED%95%98%EB%8B%A8/%EC%83%81%ED%9E%88%20%ED%95%98%EB%8B%A82.jpg" class="fr-fic fr-dib">
	<br><img src="https://ai.esmplus.com/yhshma/%EC%98%B5%ED%8B%B1%EA%B8%80%EB%9E%98%EC%8A%A4%20%EC%83%81%EC%84%B8%ED%8E%98%EC%9D%B4%EC%A7%80/%EC%83%81%ED%9E%88%20%ED%95%98%EB%8B%A8/%EC%83%81%ED%9E%88%20%ED%95%98%EB%8B%A83.jpg" class="fr-fic fr-dib">
	<br>
</p>`;
}

// 템플릿 상품의 content 를 받아 "조견표 영역"만 교체한다(공지/상세페이지는 템플릿 그대로).
// UI 방식(injectHtmlEditor SECTION)과 동일 — 상세페이지 이미지 URL 이 실제 템플릿 것이라 안 깨짐.
export function buildContentFromTemplate(templateContent, data) {
    const specUrl = extractImageUrl(data.specImageUrl);
    const S = '<!--2. 조견표 영역-->';
    const E = '<!--3. 상세페이지 영역-->';
    const s = templateContent.indexOf(S);
    const e = templateContent.indexOf(E);
    const newBlock = `${S}<p><br></p>` +
        `<p style="text-align: center;"><span style="font-size: 36px;">` +
        `<strong>※${data.titleBrand} ${data.titleModel} 조견표※</strong></span></p>` +
        `<p><img src="${specUrl}" class="fr-fic fr-dib"></p>`;
    if (s !== -1 && e !== -1 && e > s) {
        return templateContent.slice(0, s) + newBlock + templateContent.slice(e);
    }
    return buildContent(data); // 마커 없으면 하드코딩 폴백
}

function extractImageUrl(input) {
    if (!input) return '';
    const s = String(input).trim();
    const m = s.match(/<img[^>]*\ssrc\s*=\s*["']([^"']+)["']/i);
    return encodeUrlSafe((m ? m[1] : s).trim());
}

// URL 경로의 공백/한글을 인코딩한다. 이미 %-인코딩된 URL 은 그대로 둔다(이중 인코딩 방지).
// imweb 은 images/조견표 URL 을 서버가 직접 fetch 하므로, 인코딩 안 하면 못 가져와 504 가 난다.
export function encodeUrlSafe(url) {
    if (!url) return url;
    if (/%[0-9A-Fa-f]{2}/.test(url)) return url; // 이미 인코딩됨
    try { return encodeURI(url); } catch { return url; }
}

// 대표이미지 URL 결정: URL 우선, 없으면 로컬은 업로드 필요 표시.
// (로컬→URL 업로드는 register 단계에서 esmplus 업로더로 처리)
function resolveImages(data) {
    if (data.mainImageUrl) return { images: [extractImageUrl(data.mainImageUrl)], needUpload: null };
    if (data.mainImagePath) return { images: [], needUpload: data.mainImagePath };
    return { images: [], needUpload: null };
}

// 최종 payload. 첫 등록은 항상 숨김(nosale)으로 만들고, 확인 후 판매중(sale)으로 전환.
export function buildProductPayload(data, type, carTrees, { status = 'nosale', templateContent = null } = {}) {
    const { categories, brandCode, modelCode } = buildCategories(carTrees, data.brand, data.model);
    const { images, needUpload } = resolveImages(data);
    const content = templateContent
        ? buildContentFromTemplate(templateContent, data)
        : buildContent(data);
    const payload = {
        name: data.title,
        price: Number(data.price),
        price_tax: true,
        categories,
        content,
        images,
        options: buildOptions(data, type),
        prod_status: status,
        // 템플릿(1290/1291)과 동일한 재고설정: 재고관리 ON + 무제한. (안 넣으면 조합가격 0/재고
        // 관리안함 으로 표시됨). stock_* 는 최상위 필드(POST/PATCH), GET 은 stock{} 로 반환.
        stock_use: true,
        stock_unlimit: true,
        stock_no_option: 2000000000,
    };
    return { payload, meta: { brandCode, modelCode, needUpload, type } };
}
