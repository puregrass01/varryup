// 카테고리 이름 → 코드 해석 (아임웹 Open API 의 카테고리 트리).
//
// GET /products/shop-categories?unitCode=… 한 번에 전체 트리가 온다: [{ categoryCode, name, children: [...] }].
// 예전 v2 API(GET /shop/categories/{코드}를 국산차 · 수입차마다 부르던 방식)와 코드 체계는 같다 —
// 템플릿 1290(쌍용/렉스턴 뉴 아레나)의 카테고리가 두 API 에서 같은 코드로 나온다(2026-10-05 확인).
//
// 저장 패턴: categories = [브랜드코드, 모델코드, 광각미러코드] (국산차/수입차 자체는 넣지 않는다)

export const 광각미러_CODE = 's20260130ce2d59e3e6905';
export const 광각미러오토바이_CODE = 's202403132812bdb94ade8';

const norm = s => String(s || '').replace(/[\s​‌‍﻿]+/g, '').trim();

// 트리에서 이름으로 노드 찾기(깊이 우선, 공백 · 폭 없는 문자를 무시하고 비교)
function findNode(nodes, name) {
    const target = norm(name);
    for (const n of nodes || []) {
        if (norm(n.name) === target) return n;
        const hit = findNode(n.children, name);
        if (hit) return hit;
    }
    return null;
}

/** 국산차 · 수입차 노드. 트리의 어느 깊이에 있어도 찾는다(최상위가 광각미러 등으로 감싸여 있을 수 있다). */
export function nationalNodes(tree) {
    return ['국산차', '수입차'].map(name => findNode(tree, name)).filter(Boolean);
}

// 브랜드 → 그 하위에서 모델 찾기. 브랜드 노드부터 좁혀서 다른 브랜드의 같은 이름 모델로 잘못 붙지 않게 한다.
export function resolveBrandModel(tree, brand, model) {
    for (const national of nationalNodes(tree)) {
        const brandNode = findNode(national.children, brand);
        if (brandNode) {
            const modelNode = findNode(brandNode.children, model);
            return { brandCode: brandNode.categoryCode, modelCode: modelNode ? modelNode.categoryCode : null };
        }
    }
    return { brandCode: null, modelCode: null };
}

// 최종 categories 배열: [브랜드, 모델, 광각미러]
export function buildCategories(tree, brand, model, { moto = false } = {}) {
    const { brandCode, modelCode } = resolveBrandModel(tree, brand, model);
    const mirror = moto ? 광각미러오토바이_CODE : 광각미러_CODE;
    const categories = [];
    if (brandCode) categories.push(brandCode);
    if (modelCode) categories.push(modelCode);
    categories.push(mirror);
    return { categories, brandCode, modelCode, mirror };
}

/** 화면의 브랜드/차종 목록 파일(data/imweb_categories.json) 모양: { 국산차: { 브랜드: [모델…] }, 수입차: {…} } */
export function categoriesFileFromTree(tree) {
    const out = { 국산차: {}, 수입차: {} };
    for (const name of Object.keys(out)) {
        const national = findNode(tree, name);
        for (const brand of national?.children || []) {
            const brandName = String(brand.name || '').replace(/[​‌‍﻿]/g, '').trim();
            if (!brandName) continue;
            out[name][brandName] = (brand.children || [])
                .map(m => String(m.name || '').replace(/[​‌‍﻿]/g, '').trim())
                .filter(Boolean)
                .sort();
        }
    }
    return out;
}
