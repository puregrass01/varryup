// 아임웹 Open API (api.imweb.me v2) 클라이언트 — 실험용, 기존 프로그램과 완전 분리.
// Node 18+ (전역 fetch 사용). ESM.
//
// 인증: GET /v2/auth?key=KEY&secret=SECRET → access_token 발급.
//       이후 모든 요청 헤더에 `access-token: {token}`.
// (아임웹 v2 구 API 기준. 만약 계정이 신 OAuth 방식만 지원하면 auth 부분만 교체하면 됨.)

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = 'https://api.imweb.me/v2';

export function loadConfig() {
    // 기존 프로그램의 data/imweb_openapi_config.json 에서 키를 읽는다.
    // (src/platforms/openapi → ../../../data)
    const p = path.join(__dirname, '..', '..', '..', 'data', 'imweb_openapi_config.json');
    if (!fs.existsSync(p)) {
        throw new Error('data/imweb_openapi_config.json 이 없습니다. apiKey/apiSecret 를 넣어주세요.');
    }
    const cfg = JSON.parse(fs.readFileSync(p, 'utf-8'));
    if (!cfg.apiKey || !cfg.apiSecret || String(cfg.apiKey).includes('여기에')) {
        throw new Error('imweb_openapi_config.json 의 apiKey / apiSecret 를 실제 발급값으로 채워주세요.');
    }
    return cfg;
}

// access_token 발급. 응답 형태가 버전마다 조금 달라 여러 필드를 방어적으로 확인한다.
export async function getAccessToken(cfg = loadConfig()) {
    const url = `${BASE}/auth?key=${encodeURIComponent(cfg.apiKey)}&secret=${encodeURIComponent(cfg.apiSecret)}`;
    const res = await fetch(url, { method: 'GET' });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { throw new Error(`인증 응답 파싱 실패 (HTTP ${res.status}): ${text.slice(0, 300)}`); }
    const token = json.access_token || json.accessToken || (json.data && json.data.access_token);
    if (!token) {
        throw new Error(`access_token 을 못 받았습니다 (HTTP ${res.status}): ${JSON.stringify(json).slice(0, 400)}`);
    }
    return token;
}

// 공통 요청 헬퍼. token 을 재사용하려면 넘겨주고, 없으면 새로 발급.
export async function apiRequest(method, endpoint, { token, body, cfg } = {}) {
    if (!token) token = await getAccessToken(cfg);
    const res = await fetch(`${BASE}${endpoint}`, {
        method,
        headers: {
            'access-token': token,
            'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { _raw: text }; }
    return { status: res.status, ok: res.ok, json };
}

// ── 상품 ────────────────────────────────────────────────────────────────
export async function getProduct(prodNo, opts = {}) {
    return apiRequest('GET', `/shop/products/${prodNo}`, opts);
}
export async function listProducts(query = '', opts = {}) {
    const q = query ? `?${query}` : '';
    return apiRequest('GET', `/shop/products${q}`, opts);
}
export async function createProduct(payload, opts = {}) {
    return apiRequest('POST', `/shop/products`, { ...opts, body: payload });
}
export async function updateProduct(prodNo, payload, opts = {}) {
    return apiRequest('PATCH', `/shop/products/${prodNo}`, { ...opts, body: payload });
}
// 판매상태 전환: sale(판매중) / soldout(품절) / nosale(숨김)
export async function setProductStatus(prodNo, status, opts = {}) {
    return updateProduct(prodNo, { prod_status: status }, opts);
}

// ── 카테고리 ────────────────────────────────────────────────────────────
// 카테고리는 이름이 아니라 "코드"로 상품에 넣어야 하므로, 이름→코드 매핑용으로 목록을 받아온다.
export async function getCategories(opts = {}) {
    return apiRequest('GET', `/shop/categories`, opts);
}
