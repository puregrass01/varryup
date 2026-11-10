// 아임웹 B2B몰 등록의 상품명 · 가격 규칙(순수 모듈 — node 의존 없음). 등록(platforms/openapi/imweb_b2b.js)과
// 신규 모드 6몰 표 카드(ui/mall-grid.js, 올라갈 이름 · 가격 미리보기)가 같이 쓴다 — 규칙이 한 곳에만 있게.

// 개별(운전석/조수석) · 세트(1셋) × 일반 · BSA. 가격과 템플릿은 예전 등록과 같다.
export const B2B_PLAN = {
  indiv: { label: '개별', suffix: '운전석/조수석', price: { bsa: 115000, plain: 80000 }, template: { bsa: '1291', plain: '803' } },
  set: { label: '세트', suffix: '1셋', price: { bsa: 220000, plain: 150000 }, template: { bsa: '1290', plain: '712' } },
};

/** bsaO · bsaX 가 오면 그것으로 BSA 여부를 정한다(예전과 같은 판정). data.hasBsa 도 맞춰 둔다. */
export function resolveBsa(data) {
  if (data.bsaO !== undefined || data.bsaX !== undefined) data.hasBsa = !data.bsaX && !!data.bsaO;
  return !!data.hasBsa;
}
export const b2bTitle = (data, type) => `옵틱글래스 ${data.titleBrand} ${data.titleModel} 미러 ${B2B_PLAN[type].suffix} [${data.code}]`;
