// B2B 상품의 옵션 값 · 상세설명(HTML) 조립 — 순수 함수. 등록 본문(Open API)은 imweb_b2b.js 가 만든다.
//
// data 필드(메인 프로그램과 동일):
//   hasBsa, bsaO, bsaX, brand, model, titleBrand, titleModel, year, code, specImageUrl, detailHtml

// 연식 값: BSA X 상품은 업그레이드용으로 BSA O 도 함께 판매(마크 2개), 순수 BSA O 는 1개.
export function yearValues(data) {
    let marks;
    if (data.bsaO !== undefined || data.bsaX !== undefined) {
        marks = data.bsaX ? ['BSA X', 'BSA O'] : ['BSA O'];
    } else {
        marks = data.hasBsa ? ['BSA O'] : ['BSA X', 'BSA O'];
    }
    return marks.map(m => `${data.year} [No.${data.code}] ${m}`);
}

// 상세설명 HTML — 공지 + 조견표(상품별 교체) + 상세페이지(상단/본문/하단) 전체.
// 기존 프로그램 generateDescriptionHtml 과 동일. 고정 이미지 URL 은 이미 %-인코딩됨.
export function buildContent(data) {
    if (data.detailHtml) return managedContent(data);
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
    if (data.detailHtml) return managedContent(data);
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

function managedContent(data) {
    const spec = extractImageUrl(data.specImageUrl);
    return (spec ? `<p><img src="${spec.replace(/"/g, '&quot;')}" /></p>\n` : '') + data.detailHtml;
}

export function extractImageUrl(input) {
    if (!input) return '';
    const s = String(input).trim();
    const m = s.match(/<img[^>]*\ssrc\s*=\s*["']([^"']+)["']/i);
    return encodeUrlSafe((m ? m[1] : s).trim());
}

// URL 경로의 공백/한글을 인코딩한다. 이미 %-인코딩된 URL 은 그대로 둔다(이중 인코딩 방지).
// 상세설명 속 조견표 이미지 주소는 브라우저가 그대로 불러오므로 공백 · 한글을 인코딩해 둔다.
export function encodeUrlSafe(url) {
    if (!url) return url;
    if (/%[0-9A-Fa-f]{2}/.test(url)) return url; // 이미 인코딩됨
    try { return encodeURI(url); } catch { return url; }
}
