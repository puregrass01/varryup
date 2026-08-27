// 카테고리 이름 → 코드 해석 모듈.
// 아임웹은 GET /shop/categories/{코드} 가 그 카테고리의 "전체 하위 트리"(중첩 list)를 반환한다.
// 국산차 + 수입차 두 트리만 받아 캐시하면, 브랜드/모델 코드를 로컬에서 해석할 수 있다.
//
// 확인된 저장 패턴(템플릿 1290 = 쌍용/렉스턴 뉴 아레나):
//   categories = [브랜드코드, 모델코드, 광각미러코드]   (국산차/수입차 최상위는 미포함)

import { apiRequest } from './imweb_api.js';

const 광각미러_CODE = 's20260130ce2d59e3e6905';
const 광각미러오토바이_CODE = 's202403132812bdb94ade8';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const norm = s => (s || '').replace(/[\s​‌‍﻿]+/g, '').trim();

// 최상위(국산차/수입차/…) 목록
export async function getRoots(token) {
    const r = await apiRequest('GET', '/shop/categories', { token });
    const d = r.json?.data;
    return Array.isArray(d) ? d : (d ? Object.values(d) : []);
}

// 특정 카테고리의 전체 하위 트리(중첩)
export async function getSubtree(token, code) {
    const r = await apiRequest('GET', `/shop/categories/${code}`, { token });
    return r.json?.code === 200 ? r.json.data : null;
}

// 국산차 + 수입차 전체 트리를 받아 하나로 합친다(호출 2회). 캐시해서 재사용 권장.
export async function loadCarTree(token) {
    const roots = await getRoots(token);
    const nat = {};
    for (const r of roots) {
        if (['국산차', '수입차'].includes(norm(r.name))) nat[norm(r.name)] = r.code;
    }
    const trees = [];
    for (const name of Object.keys(nat)) {
        await sleep(1200); // rate limit 회피
        const t = await getSubtree(token, nat[name]);
        if (t) trees.push(t);
    }
    return trees; // [{code,name:'국산차',list:[{브랜드...}]}, {수입차...}]
}

// 트리에서 이름으로 노드 찾기(깊이 우선). 정규화 비교.
function findNode(nodes, name) {
    const target = norm(name);
    for (const n of nodes || []) {
        if (norm(n.name) === target) return n;
        const hit = findNode(n.list, name);
        if (hit) return hit;
    }
    return null;
}

// 브랜드 → 그 하위에서 모델 찾기. 브랜드 노드부터 좁혀서 동명 모델 오인 방지.
export function resolveBrandModel(carTrees, brand, model) {
    for (const tree of carTrees) {
        const brandNode = findNode(tree.list, brand);
        if (brandNode) {
            const modelNode = findNode(brandNode.list, model);
            if (modelNode) return { brandCode: brandNode.code, modelCode: modelNode.code };
            return { brandCode: brandNode.code, modelCode: null }; // 브랜드는 있으나 모델 없음
        }
    }
    return { brandCode: null, modelCode: null };
}

// 최종 categories 배열 생성: [브랜드, 모델, 광각미러]
export function buildCategories(carTrees, brand, model, { moto = false } = {}) {
    const { brandCode, modelCode } = resolveBrandModel(carTrees, brand, model);
    const mirror = moto ? 광각미러오토바이_CODE : 광각미러_CODE;
    const arr = [];
    if (brandCode) arr.push(brandCode);
    if (modelCode) arr.push(modelCode);
    arr.push(mirror);
    return { categories: arr, brandCode, modelCode, mirror };
}
