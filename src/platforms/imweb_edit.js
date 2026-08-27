import { Imweb } from './imweb.js';
// Open API 클라이언트 (상품 생성용). 내부 API(가격 상속)와 함께 쓴다.
import { loadConfig as oaLoadConfig, getAccessToken as oaAuth, getProduct as oaGetProduct,
    createProduct as oaCreate, setProductStatus as oaSetStatus, apiRequest as oaRequest } from './openapi/imweb_api.js';
import { loadCarTree as oaLoadCarTree, buildCategories as oaBuildCategories } from './openapi/categories.js';
import { buildProductPayload as oaBuildPayload } from './openapi/build_payload.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ADMIN = 'https://bbstore37.imweb.me';
const API = 'https://gateway-brand.imwebapis.com/domain/product/bo';

/**
 * 아임웹 B2B몰 "기존 상품 수정" 전용 모듈.
 *
 * 복사등록(Imweb.executeAutomation / registerProduct 등)은 전혀 건드리지 않는다.
 *
 * 실측으로 확인한 내부 API 프로토콜:
 *   - 목록 검색 : GET   /bo/products?page=1&pageSize=50&search=...&sortBy=sort_no
 *   - 불러오기  : GET   /bo/products/{prodNo}
 *   - 저장      : PATCH /bo/products/{prodNo}   ← 진짜 부분 수정. 보낸 섹션만 바뀐다.
 *
 * 인증은 쿠키가 아니라 Authorization: Bearer <JWT> 이고, API 도메인이 관리자 화면과
 * 달라 브라우저 fetch 는 CORS 로 막힌다. 그래서 관리자 페이지를 한 번 연 뒤 요청 헤더에서
 * 토큰을 가로채고, 이후에는 Playwright 의 APIRequestContext 로 직접 호출한다(CORS 무관).
 *
 * PATCH 가 부분 수정이라 우리가 바꾼 섹션만 보내면 되고, 나머지 필드는 서버에 그대로
 * 남는다 — 쿠팡처럼 전체 본문을 재조립할 필요가 없어 유실 위험이 구조적으로 없다.
 */
export class ImwebEdit extends Imweb {
    constructor(...args) {
        super(...args);
        this.token = null;
    }

    async extractProductInfo(idx) {
        await this.initBrowserSession();
        await this.openAdminAt('https://bbstore37.imweb.me/admin/shopping/product', '/admin/shopping/');
        const adminBaseUrl = this.page.url().split('/admin')[0];
        
        this.log(`[B2B] URL 상품 정보 추출 중 (상품번호: ${idx})...`);
        await this.page.goto(`${adminBaseUrl}/admin/shopping/product/detail?idx=${idx}`);
        await this.page.waitForLoadState('domcontentloaded');
        await sleep(3000);
        
        const titleInput = this.page.locator('input[placeholder*="상품명"]').first();
        const rawTitle = await titleInput.inputValue();
        const title = rawTitle.replace(/\s*(?:1셋|운전석\/조수석)\s*(?:\[\w+\])?\s*$/, '').trim();
        
        const codeMatch = rawTitle.match(/\[([^\]]+)\]$/);
        const code = codeMatch ? codeMatch[1] : '';
        
        const cleanTitle = title.replace(/^옵틱글래스\s+/, '');
        const words = cleanTitle.split(/\s+/);
        const brand = words[0] || '';
        const model = words[1] || '';
        
        return { brand, model, code, title };
    }

    /** 관리자 페이지를 열어 API Bearer 토큰을 확보한다 */
    /**
     * API Bearer 토큰을 확보한다. force=true 면 만료된 토큰을 버리고 관리자 페이지를 새로고침해
     * 새 토큰을 잡는다. (아임웹 JWT 는 일정 시간 뒤 만료되므로 401 이 나면 갱신해야 한다)
     */
    async ensureToken(force = false) {
        if (this.token && !force) return this.token;
        if (!this.page) await this.initBrowserSession();

        let token = null;
        const grab = (r) => {
            const a = r.headers()['authorization'];
            if (a && !token && /imwebapis/.test(r.url())) token = a;
        };
        this.page.on('request', grab);
        try {
            if (force) {
                // 새로고침으로 SPA 가 새 토큰으로 인증 요청을 다시 보내게 한다
                await this.page.goto(`${ADMIN}/admin/shopping/product?_=${Date.now()}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
            } else {
                await this.openAdminAt(`${ADMIN}/admin/shopping/product`, '/admin/shopping/');
            }
            for (let i = 0; i < 20 && !token; i++) await sleep(700);
        } finally {
            this.page.off('request', grab);   // 리스너 누수 방지
        }

        // 이미 로그인된 상태로 관리자에 진입하면 SPA 가 새 인증요청을 안 보내 토큰을 못 잡는다.
        // 이 경우 캐시무효화 URL 로 강제 새로고침해 재시도한다.
        if (!token && !force) {
            this.log('토큰을 못 잡아 강제 새로고침으로 재시도합니다...');
            return this.ensureToken(true);
        }
        if (!token) throw new Error('아임웹 API 인증 토큰을 확보하지 못했습니다. 로그인 상태를 확인해 주세요.');
        this.token = token;
        this.log(force ? '아임웹 인증 토큰 갱신 완료.' : '아임웹 관리자 인증 완료.');
        return token;
    }

    get _headers() {
        return { authorization: this.token, accept: 'application/json' };
    }

    async apiGet(path) {
        let r = await this.context.request.get(`${API}${path}`, { headers: this._headers });
        if (r.status() === 401) {   // 토큰 만료 → 새로 받아 한 번 재시도
            this.log('아임웹 토큰이 만료되어 갱신 후 재시도합니다...');
            await this.ensureToken(true);
            r = await this.context.request.get(`${API}${path}`, { headers: this._headers });
        }
        const text = await r.text();
        if (!r.ok()) throw new Error(`아임웹 API 오류 (${r.status()}): ${text.slice(0, 200)}`);
        return JSON.parse(text);
    }

    async apiPatch(path, body) {
        const send = () => this.context.request.patch(`${API}${path}`, {
            headers: { ...this._headers, 'content-type': 'application/json' },
            data: body,
        });
        let r = await send();
        if (r.status() === 401) {
            this.log('아임웹 토큰이 만료되어 갱신 후 재시도합니다...');
            await this.ensureToken(true);
            r = await send();
        }
        const text = await r.text();
        if (!r.ok()) throw new Error(`아임웹 저장 실패 (${r.status()}): ${text.slice(0, 300)}`);
        const j = JSON.parse(text);
        if (j.statusCode && Number(j.statusCode) !== 200) {
            throw new Error(`아임웹이 저장을 거부했습니다: ${j.message || j.statusCode}`);
        }
        return j;
    }

    // ── B2B 복사등록 (API 방식) ────────────────────────────────────────────────
    // Open API 로 상품을 생성하고, 내부 API 로 템플릿의 그룹가격·조합가격을 상속시킨다.
    // (Open API 는 B2B 그룹가격/조합가격을 못 쓰지만, 내부 관리자 API 는 쓸 수 있다 — 실측 확인.)
    // 화면 클릭이 하나도 없어 Clay 디자인 변경에 견고하다.

    // 템플릿의 그룹가격(즉시/기간할인)과 조합가격을 새 상품에 복사한다(내부 API).
    async inheritTemplatePricing(newProdNo, templateNo) {
        await this.ensureToken();
        const tmpl = (await this.apiGet(`/products/${templateNo}`)).data;
        let cur = (await this.apiGet(`/products/${newProdNo}`)).data;
        const done = [];

        // 디버그: 템플릿과 신규 상품의 옵션 데이터 상태 확인
        const tmplDetails = tmpl.productOptionInfo?.optionDetails || [];
        let curDetails = cur.productOptionInfo?.optionDetails || [];
        this.log(`[B2B-API 진단] 템플릿(${templateNo}) optionDetails: ${tmplDetails.length}건`);
        for (const td of tmplDetails) {
            const per = td.dataPerUnit?.[0] || {};
            this.log(`  → ${per.displayText || '(displayText 없음)'}  가격: ${per.price ?? '?'}`);
        }
        this.log(`[B2B-API 진단] 신규상품(${newProdNo}) optionDetails: ${curDetails.length}건, unitCode: ${cur.priceInfo?.[0]?.unitCode || '없음'}`);

        // 옵션 데이터가 아직 반영 안 됐으면 추가 대기 후 재조회
        if (curDetails.length === 0) {
            this.log(`[B2B-API] 신규 상품 옵션 데이터 미반영 — 5초 대기 후 재조회...`);
            await sleep(5000);
            cur = (await this.apiGet(`/products/${newProdNo}`)).data;
            curDetails = cur.productOptionInfo?.optionDetails || [];
            this.log(`[B2B-API 진단] 재조회 결과: optionDetails ${curDetails.length}건`);
        }

        // 각 설정을 "따로" PATCH 한다. 한 섹션이 검증 오류로 거부돼도 나머지는 반영되게.
        const patchSection = async (label, body) => {
            try { await this.apiPatch(`/products/${newProdNo}`, body); done.push(label); }
            catch (e) { this.log(`⚠ [B2B-API] ${label} 실패: ${e.message}`); }
        };

        // A. 가격 (그룹가격 discountInfo + 조합가격 optionDetails)
        const pricePayload = {};
        const tmplDisc = tmpl.priceInfo?.[0]?.discountInfo;
        if (tmplDisc && Array.isArray(cur.priceInfo) && cur.priceInfo[0]) {
            const pi = JSON.parse(JSON.stringify(cur.priceInfo));
            pi[0].discountInfo = JSON.parse(JSON.stringify(tmplDisc));
            pricePayload.priceInfo = pi;
        }
        const basePrice = cur.priceInfo?.[0]?.price ?? 0;
        const unitCode = cur.priceInfo?.[0]?.unitCode
            || cur.productOptionInfo?.optionDetails?.[0]?.dataPerUnit?.[0]?.unitCode;

        // 템플릿의 조합별 가격을 "마크(BSA O/X)|구성(운전석만/조수석만)" 키로 맵핑한다.
        // BSA X 상품은 조합마다 가격이 다르다(예: 세트 BSA X=150,000 / BSA O=170,000).
        // 그래서 전부 기본가로 통일하면 안 되고, 같은 마크·구성끼리 템플릿 가격을 복사한다.
        const comboKey = (text) => {
            const s = String(text || '');
            const mark = /BSA\s*O/i.test(s) ? 'O' : (/BSA\s*X/i.test(s) ? 'X' : '');
            const seat = s.includes('운전석만') ? '운전석만' : (s.includes('조수석만') ? '조수석만' : '');
            return `${mark}|${seat}`;
        };
        const tmplPriceByKey = {};
        for (const td of (tmpl.productOptionInfo?.optionDetails || [])) {
            const per = td.dataPerUnit?.[0] || {};
            if (per.price != null) tmplPriceByKey[comboKey(per.displayText)] = per.price;
        }

        const poi = cur.productOptionInfo ? JSON.parse(JSON.stringify(cur.productOptionInfo)) : null;
        const details = poi?.optionDetails || [];
        const priceLog = [];
        this.log(`[B2B-API 진단] 템플릿 가격맵: ${JSON.stringify(tmplPriceByKey)}`);
        this.log(`[B2B-API 진단] 신규상품 조합 ${details.length}건, unitCode=${unitCode || '없음'}`);
        if (details.length && unitCode) {
            poi.optionDetails = details.map((d0, i) => {
                const per = d0.dataPerUnit?.[0] || {};
                const key = comboKey(per.displayText);
                const price = tmplPriceByKey[key] != null ? tmplPriceByKey[key] : basePrice;
                priceLog.push(`${per.displayText} [${key}] → ${price}원`);
                const out = {
                    no: i + 1,
                    optionValuePairs: d0.optionValuePairs,
                    prices: [{ unitCode, price }],
                    status: d0.status || 'SALE',
                    stock: d0.stock ?? 0,
                    stockSku: d0.stockSku || '',
                };
                if (d0.optionDetailCode) out.optionDetailCode = d0.optionDetailCode;
                return out;
            });
            pricePayload.productOptionInfo = poi;
        } else {
            this.log(`⚠ [B2B-API] 조합가격 상속 건너뜀: details=${details.length}, unitCode=${unitCode || '없음'}`);
        }
        if (Object.keys(pricePayload).length) {
            const g = tmplDisc?.periodOptionData?.targetGroups?.length || 0;
            this.log(`[B2B-API] 가격 PATCH 전송: 그룹 ${g}건, 조합: ${priceLog.join(' / ')}`);
            await patchSection(`가격(그룹 ${g}건/조합 ${priceLog.join(', ')})`, pricePayload);
        } else {
            this.log(`⚠ [B2B-API] 가격 PATCH 전송할 내용 없음`);
        }

        // B. 상단/하단 공통 상세 (description 의 commonHeaderCode / commonFooterCode) 상속
        if (Array.isArray(cur.description) && cur.description[0] && tmpl.description?.[0]) {
            const desc = JSON.parse(JSON.stringify(cur.description));
            desc[0].commonHeaderCode = tmpl.description[0].commonHeaderCode || '';
            desc[0].commonFooterCode = tmpl.description[0].commonFooterCode || '';
            await patchSection('상단/하단 공통', { description: desc });
        }

        // C. 외부 채널 노출 OFF — 템플릿의 externalIntegrationInfo 를 그대로 복사한다.
        //    (템플릿은 이미 채널이 꺼져 있으므로, 그 구조를 그대로 쓰면 확실하다)
        const extSource = tmpl.externalIntegrationInfo || cur.externalIntegrationInfo;
        this.log(`[B2B-API 진단] 템플릿 externalIntegrationInfo: ${JSON.stringify(tmpl.externalIntegrationInfo)}`);
        this.log(`[B2B-API 진단] 신규상품 externalIntegrationInfo: ${JSON.stringify(cur.externalIntegrationInfo)}`);
        if (extSource) {
            const ext = JSON.parse(JSON.stringify(extSource));
            ext.externalDisplayChannels = [];
            delete ext.productRentalPeriod; // 소매=0 보내면 '1 이상이어야', 1 보내면 '렌탈만 가능' → 빼버린다
            this.log(`[B2B-API] 외부채널 OFF PATCH 전송: ${JSON.stringify({ externalIntegrationInfo: ext })}`);
            await patchSection('외부채널 OFF', { externalIntegrationInfo: ext });
        } else {
            this.log(`[B2B-API] externalIntegrationInfo 없음 — 빈 구조로 시도`);
            await patchSection('외부채널 OFF', { externalIntegrationInfo: { externalDisplayChannels: [] } });
        }

        this.log(`[B2B-API] 상속 완료 (${done.join(', ') || '없음'})`);
    }

    // Open API 로 만든 직후 504(이미지 지연)로 상품번호를 못 받았을 때 목록에서 찾는다.
    async _oaFindByTitle(token, title) {
        const r = await oaRequest('GET', '/shop/products?order=wtime&order_type=desc&limit=15', { token });
        const d = r.json?.data;
        const arr = Array.isArray(d) ? d : (d?.list || (d ? Object.values(d) : []));
        const hit = arr.find(p => (p.name || p.prod_name || '') === title);
        return hit ? (hit.no || hit.prod_no) : null;
    }

    // 두 상품을 서로 연관상품으로 연결한다(내부 API). 세트↔개별 상호 연결.
    async linkRelated(noA, noB) {
        await this.ensureToken();
        const a = (await this.apiGet(`/products/${noA}`)).data;
        const b = (await this.apiGet(`/products/${noB}`)).data;
        if (!a.prodCode || !b.prodCode) { this.log('⚠ [B2B-API] 연관상품 코드 확인 실패'); return; }
        await this.apiPatch(`/products/${noA}`, { relativeProducts: [{ prodCode: b.prodCode, sortNo: 1, isMutual: true }] });
        await this.apiPatch(`/products/${noB}`, { relativeProducts: [{ prodCode: a.prodCode, sortNo: 1, isMutual: true }] });
        this.log(`[B2B-API] 연관상품 연결 완료: ${noA} ↔ ${noB}`);
    }

    // 개별/세트 B2B 상품을 API 로 등록한다. 둘 다 등록하면 서로 연관상품으로 연결.
    async registerB2bViaApi(data) {
        const cfg = oaLoadConfig();
        const token = await oaAuth(cfg);
        await sleep(500);
        if (!this._oaCarTrees) this._oaCarTrees = await oaLoadCarTree(token);
        const carTrees = this._oaCarTrees;

        if (data.bsaO !== undefined || data.bsaX !== undefined) data.hasBsa = !data.bsaX && !!data.bsaO;
        const hasBsa = !!data.hasBsa;

        const results = [];
        const doOne = async (type) => {
            const suffix = type === 'set' ? '1셋' : '운전석/조수석';
            const title = `옵틱글래스 ${data.titleBrand} ${data.titleModel} 미러 ${suffix} [${data.code}]`;
            const price = type === 'set' ? (hasBsa ? 220000 : 150000) : (hasBsa ? 115000 : 80000);
            const templateNo = hasBsa ? (type === 'set' ? '1290' : '1291') : (type === 'set' ? '712' : '803');
            this.log(`[B2B-API] ${type === 'set' ? '세트' : '개별'} 등록: ${title} (${price}원, 템플릿 ${templateNo})`);

            // 1. 템플릿 content 로 상세설명 구성(조견표만 교체)
            const tp = await oaGetProduct(templateNo, { token });
            const templateContent = tp.json?.code === 200 ? String(tp.json.data?.content || '') : '';

            // 2. Open API 로 상품 생성 (숨김)
            const pdata = { ...data, hasBsa, title, price };
            const { payload, meta } = oaBuildPayload(pdata, type, carTrees, { status: 'nosale', templateContent });
            if (!meta.brandCode || !meta.modelCode) {
                this.log(`⚠ 카테고리 코드 확인 실패 (브랜드=${meta.brandCode ? 'OK' : '❌'}, 모델=${meta.modelCode ? 'OK' : '❌'}) — 등록은 진행`);
            }
            const res = await oaCreate(payload, { token });
            let no = res.json?.data?.no;
            if (!no || typeof no === 'object') { await sleep(2500); no = await this._oaFindByTitle(token, title); }
            if (!no) { this.log(`⚠ [B2B-API] ${type} 상품번호 확인 실패 — 건너뜀`); results.push({ type, ok: false }); return; }
            this.log(`[B2B-API] ${type === 'set' ? '세트' : '개별'} 생성됨: 상품번호 ${no}`);

            // 3. 판매중 전환 (먼저! — 전환 시 조합가격·외부채널이 초기화될 수 있으므로 상속보다 앞에)
            await sleep(2000);
            await oaSetStatus(no, 'sale', { token });
            this.log(`[B2B-API] ${type === 'set' ? '세트' : '개별'} 판매중 전환 완료`);

            // 4. 내부 API 로 그룹가격 + 조합가격 + 외부채널 상속 (판매중 전환 후에 적용해야 리셋되지 않음)
            await sleep(3000); // 내부 API 에 옵션 데이터가 반영될 시간 확보
            try { await this.inheritTemplatePricing(no, templateNo); }
            catch (e) { this.log(`⚠ [B2B-API] 가격 상속 실패: ${e.message}`); }
            await sleep(1000);

            // 5. 외부 채널 노출 OFF 최종 확인 + 검증
            try {
                await this.ensureToken();
                const fresh = (await this.apiGet(`/products/${no}`)).data;
                this.log(`[B2B-API 진단] 최종 외부채널 상태(PATCH 전): ${JSON.stringify(fresh.externalIntegrationInfo)}`);

                // 템플릿의 externalIntegrationInfo 를 기반으로 채널 OFF
                const tmplForExt = (await this.apiGet(`/products/${templateNo}`)).data;
                const extBase = tmplForExt.externalIntegrationInfo || fresh.externalIntegrationInfo || {};
                const ext = JSON.parse(JSON.stringify(extBase));
                ext.externalDisplayChannels = [];
                delete ext.productRentalPeriod; // 소매 상품은 이 필드 자체를 빼야 검증 통과
                await this.apiPatch(`/products/${no}`, { externalIntegrationInfo: ext });
                this.log(`[B2B-API] 외부 채널 노출 OFF PATCH 완료`);

                // 검증: 다시 조회해서 실제로 꺼졌는지 확인
                await sleep(1000);
                const verify = (await this.apiGet(`/products/${no}`)).data;
                const channels = verify.externalIntegrationInfo?.externalDisplayChannels || [];
                if (channels.length === 0) {
                    this.log(`[B2B-API] ✅ 외부 채널 노출 OFF 검증 성공 (0개 활성)`);
                } else {
                    this.log(`[B2B-API] ❌ 외부 채널 노출 OFF 검증 실패! 여전히 ${channels.length}개 활성`);
                    this.log(`[B2B-API 진단] 활성 채널: ${JSON.stringify(channels)}`);
                    this.log(`[B2B-API 진단] 전체 externalIntegrationInfo: ${JSON.stringify(verify.externalIntegrationInfo)}`);
                }
            } catch (e) { this.log(`⚠ [B2B-API] 외부채널 OFF 실패: ${e.message}`); }
            results.push({ type, ok: true, no, title });
        };

        if (data.registerIndiv) { await doOne('indiv'); await sleep(1500); }
        if (data.registerSet) { await doOne('set'); }

        // 연관상품: 개별+세트 둘 다 성공하면 서로 연결
        const ok = results.filter(r => r.ok && r.no);
        if (ok.length === 2) {
            try { await this.linkRelated(ok[0].no, ok[1].no); }
            catch (e) { this.log(`⚠ [B2B-API] 연관상품 연결 실패: ${e.message}`); }
        }
        return results;
    }

    // ── B2B 수정 (API 방식) ──────────────────────────────────────────────────
    // 기존 UI 자동화(modifyProduct)를 내부 API PATCH 로 대체. 훨씬 빠르고 견고하다.
    async modifyB2bViaApi(data) {
        this.log('========== B2B몰 쇼핑 상품 수정 시작 (API 방식) ==========');
        await this.ensureToken();

        // Open API 준비 (카테고리 업데이트용)
        const oaCfg = oaLoadConfig();
        const oaToken = await oaAuth(oaCfg);
        await sleep(500);
        if (!this._oaCarTrees) this._oaCarTrees = await oaLoadCarTree(oaToken);
        const carTrees = this._oaCarTrees;

        if (data.bsaO !== undefined || data.bsaX !== undefined) {
            data.hasBsa = !data.bsaX && !!data.bsaO;
        }
        const hasBsa = !!data.hasBsa;

        const results = [];
        const doOne = async (type) => {
            const isSet = type === 'set';
            const searchKeyword = isSet ? `1셋 [${data.code}]` : `운전석/조수석 [${data.code}]`;

            // 1. 내부 API 로 상품 검색
            this.log(`[B2B-API 수정] "${searchKeyword}" 검색 중...`);
            const rows = await this._searchRows(searchKeyword);
            const match = rows.find(r => r.name.includes(data.code));
            if (!match) {
                this.log(`⚠ [B2B-API 수정] 수정할 상품을 찾지 못했습니다: ${searchKeyword}`);
                results.push({ type, ok: false });
                return;
            }
            const prodNo = match.prodNo;
            this.log(`[B2B-API 수정] 상품 발견: ${match.name} (상품번호: ${prodNo})`);

            // 2. 현재 상품 데이터 불러오기
            const cur = await this.loadProduct(prodNo);
            const payload = {};
            const done = [];

            // 3. 상품명 변경
            const suffix = isSet ? `1셋 [${data.code}]` : `운전석/조수석 [${data.code}]`;
            const newTitle = `옵틱글래스 ${data.titleBrand} ${data.titleModel} 미러 ${suffix}`;
            if (newTitle !== cur.title) {
                const base = JSON.parse(JSON.stringify(cur._raw.baseInfo));
                base.images = (base.productImages || []).map(i => ({ imageCode: i.imageCode, imagePath: i.imagePath }));
                delete base.productImages;
                base.prodBaseInfoByUnit = (base.prodBaseInfoByUnit || []).map(u => ({ ...u, productName: newTitle }));
                payload.baseInfo = base;
                done.push(`상품명 → "${newTitle}"`);
            }

            // 4. 판매가 변경
            const newPrice = hasBsa ? (isSet ? 220000 : 115000) : (isSet ? 150000 : 80000);
            if (newPrice !== cur.price) {
                const pi = JSON.parse(JSON.stringify(cur._raw.priceInfo));
                pi[0].price = newPrice;
                payload.priceInfo = pi;
                done.push(`판매가 → ${newPrice}원`);
            }

            // 5. 상세설명 — 조견표 영역만 교체
            if (data.specImageUrl) {
                const specUrl = this._extractSpecUrl(data.specImageUrl);
                if (specUrl) {
                    const desc = JSON.parse(JSON.stringify(cur._raw.description));
                    const html = desc[0]?.description || '';
                    const SPEC_START = '<!--2. 조견표 영역-->';
                    const SPEC_END = '<!--3. 상세페이지 영역-->';
                    const newBlock =
                        `${SPEC_START}<p><br></p>` +
                        `<p style="text-align: center;"><span style="font-size: 36px;">` +
                        `<strong>※${data.titleBrand} ${data.titleModel} 조견표※</strong></span></p>` +
                        `<p><img src="${specUrl}" class="fr-fic fr-dib"></p>`;

                    const s = html.indexOf(SPEC_START);
                    const e = html.indexOf(SPEC_END);
                    if (s !== -1 && e !== -1 && e > s) {
                        desc[0].description = html.slice(0, s) + newBlock + html.slice(e);
                        payload.description = desc;
                        done.push('상세설명(조견표)');
                    } else {
                        this.log(`⚠ [B2B-API 수정] 조견표 마커를 찾지 못해 상세설명 변경 건너뜀`);
                    }
                }
            }

            // 6. 옵션 — 차종/연식 값 교체 + 조합 가격 재설정
            const poi = JSON.parse(JSON.stringify(cur._raw.productOptionInfo));
            let optionChanged = false;

            // 6a. 차종 옵션값 교체
            for (const o of (poi.optionList || [])) {
                const od = (o.optionData || [])[0];
                if (!od) continue;
                if (od.name === '차종') {
                    const newVal = data.titleModel || data.model;
                    const oldMap = new Map((od.valueList || []).map(v => [v.valueName, v.valueCode]));
                    od.valueList = [{ valueCode: oldMap.get(newVal) || this._newOptionCode(), valueName: newVal }];
                    optionChanged = true;
                }
                if (od.name === '연식') {
                    const oldMap = new Map((od.valueList || []).map(v => [v.valueName, v.valueCode]));
                    let marks;
                    if (data.bsaX) marks = ['BSA X', 'BSA O'];
                    else if (data.bsaO) marks = ['BSA O'];
                    else marks = hasBsa ? ['BSA O'] : ['BSA X', 'BSA O'];
                    const newVals = marks.map(m => `${data.year} [No.${data.code}] ${m}`);
                    od.valueList = newVals.map(v => ({ valueCode: oldMap.get(v) || this._newOptionCode(), valueName: v }));
                    optionChanged = true;
                }
                if (od.name === '구성' && !isSet) {
                    // 개별에만 있는 구성 옵션 — 값은 그대로 유지
                }
            }

            if (optionChanged) {
                // 6b. 조합 재생성 (카테시안 곱)
                const opts = (poi.optionList || []).map(o => ({
                    optionCode: o.optionCode,
                    values: ((o.optionData || [])[0]?.valueList) || [],
                }));
                let rows = [[]];
                for (const o of opts) {
                    const next = [];
                    for (const row of rows) for (const v of o.values) {
                        next.push([...row, { optionCode: o.optionCode, valueCode: v.valueCode, valueName: v.valueName }]);
                    }
                    rows = next;
                }
                const tpl = (cur._raw.productOptionInfo.optionDetails || [])[0];
                const unitCode = tpl?.dataPerUnit?.[0]?.unitCode || cur.unitCode;

                // 기존 조합 가격 맵 (BSA/구성 기준)
                const comboKey = (text) => {
                    const s = String(text || '');
                    const mark = /BSA\s*O/i.test(s) ? 'O' : (/BSA\s*X/i.test(s) ? 'X' : '');
                    const seat = s.includes('운전석만') ? '운전석만' : (s.includes('조수석만') ? '조수석만' : '');
                    return `${mark}|${seat}`;
                };
                const oldPriceMap = {};
                for (const c of cur.combos) oldPriceMap[comboKey(c.displayText)] = c.price;

                // 템플릿 가격 참조 (새 조합의 기본가격)
                const templateNo = hasBsa ? (isSet ? '1290' : '1291') : (isSet ? '712' : '803');
                let tmplPriceMap = {};
                try {
                    const tmpl = (await this.apiGet(`/products/${templateNo}`)).data;
                    for (const td of (tmpl.productOptionInfo?.optionDetails || [])) {
                        const per = td.dataPerUnit?.[0] || {};
                        if (per.price != null) tmplPriceMap[comboKey(per.displayText)] = per.price;
                    }
                } catch (e) { this.log(`⚠ 템플릿(${templateNo}) 가격 조회 실패: ${e.message}`); }

                poi.optionDetails = rows.map((row, i) => {
                    const text = row.map(p => p.valueName).join(' / ');
                    const key = comboKey(text);
                    // 우선순위: 기존 가격 → 템플릿 가격 → 기본가
                    const price = oldPriceMap[key] != null ? oldPriceMap[key]
                        : (tmplPriceMap[key] != null ? tmplPriceMap[key] : newPrice);
                    return {
                        no: i + 1,
                        optionValuePairs: row.map(p => ({ optionCode: p.optionCode, valueCode: p.valueCode })),
                        prices: [{ unitCode, price }],
                        status: 'SALE',
                        stock: 0,
                        stockSku: '',
                    };
                });
                payload.productOptionInfo = poi;
                done.push(`옵션/조합 ${poi.optionDetails.length}개`);
            }

            // PATCH 전송
            if (Object.keys(payload).length) {
                this.log(`[B2B-API 수정] 저장 중 — ${done.join(', ')}`);
                await this.apiPatch(`/products/${prodNo}`, payload);
                this.log(`[B2B-API 수정] ✓ 상품 ${prodNo} 수정 완료`);
            } else {
                this.log(`[B2B-API 수정] 변경 사항 없음 (상품번호: ${prodNo})`);
            }

            // 7. 카테고리 변경 (Open API)
            if (data.brand && data.model) {
                try {
                    const { categories } = oaBuildCategories(carTrees, data.brand, data.model);
                    if (categories.length) {
                        await oaRequest('PATCH', `/shop/products/${prodNo}`, { token: oaToken, body: { categories } });
                        this.log(`[B2B-API 수정] 카테고리 업데이트 완료`);
                    }
                } catch (e) { this.log(`⚠ [B2B-API 수정] 카테고리 변경 실패: ${e.message}`); }
            }

            // 8. 대표 이미지 (URL 이 있으면 Open API 로 교체)
            if (data.mainImageUrl) {
                try {
                    const imgUrl = this._extractSpecUrl(data.mainImageUrl);
                    if (imgUrl) {
                        await oaRequest('PATCH', `/shop/products/${prodNo}`, { token: oaToken, body: { images: [imgUrl] } });
                        this.log(`[B2B-API 수정] 대표 이미지 교체 완료`);
                    }
                } catch (e) { this.log(`⚠ [B2B-API 수정] 대표 이미지 교체 실패: ${e.message}`); }
            }

            results.push({ type, ok: true, prodNo });
        };

        if (data.registerIndiv) { await doOne('indiv'); await sleep(1000); }
        if (data.registerSet) { await doOne('set'); }

        return results;
    }

    /** URL 또는 <img> 태그에서 src URL 추출 + 인코딩 */
    _extractSpecUrl(input) {
        if (!input) return '';
        const s = String(input).trim();
        const m = s.match(/<img[^>]*\ssrc\s*=\s*["']([^"']+)["']/i);
        const url = (m ? m[1] : s).trim();
        if (!url) return '';
        if (/%[0-9A-Fa-f]{2}/.test(url)) return url;
        try { return encodeURI(url); } catch { return url; }
    }

    // ── 검색 ─────────────────────────────────────────────────────────────────
    /**
     * 제조사/차종/코드로 후보 상품을 찾는다. (개별·세트가 각각 별도 상품)
     * 코드를 입력하면 상품명에 그 코드가 든 것만 남긴다.
     */
    /**
     * 세트와 개별은 "미러" 앞부분이 같고 뒤만 다르다.
     *   옵틱글래스 인피니티 G25 미러 1셋 [612]
     *   옵틱글래스 인피니티 G25 미러 운전석/조수석
     * → 공통 부분("옵틱글래스 인피니티 G25")을 짝의 키로 쓴다.
     */
    _baseKeyOf(name) {
        return String(name || '').split(/\s*미러\s*(?:1셋|운전석\/조수석)/)[0].trim();
    }

    /** 상품명에서 공통 부분을 뺀 나머지 (예: "미러 1셋 [612]") */
    _suffixOf(name) {
        const n = String(name || '').trim();
        const base = this._baseKeyOf(n);
        return n.slice(base.length).trim();
    }

    /**
     * 제조사/차종/코드로 검색해 "세트+개별" 짝 단위로 묶어서 돌려준다.
     * 개별 상품명에는 코드가 없는 경우가 많아(예: "…미러 운전석/조수석"), 코드로 걸러내면
     * 개별이 빠져버린다. 그래서 코드는 짝을 고르는 데만 쓰고, 같은 공통명을 가진 상품은
     * 코드가 없어도 함께 가져온다.
     */
    /** 키워드로 상품 목록을 받아 행 배열로 변환 (내부용) */
    async _searchRows(keyword) {
        if (!keyword || !keyword.trim()) return [];
        const q = `?page=1&pageSize=50&search=${encodeURIComponent(keyword.trim())}&sortBy=sort_no`;
        const j = await this.apiGet(`/products${q}`);
        return (j.data?.products || []).map(p => {
            const uv = (p.unitVariants || [])[0] || {};
            const name = String(uv.name || '').trim();
            return {
                prodNo: p.no ?? p.idx,
                name,
                baseKey: this._baseKeyOf(name),
                price: Math.round(parseFloat(uv.price || 0)),
                status: p.status || '',
                type: name.includes('1셋') ? 'set' : (name.includes('운전석/조수석') ? 'indiv' : 'etc'),
            };
        }).filter(r => r.prodNo && r.name);
    }

    async searchProducts({ brand, model, code, idx }) {
        await this.ensureToken();
        if (idx) {
            this.log(`[B2B] 상품 번호(idx: ${idx})로 자동 검색 정보를 추출합니다...`);
            const info = await this.extractProductInfo(idx);
            brand = info.brand;
            model = info.model;
            code = info.code;
        }
        code = (code || '').trim();
        const keyword = [brand, model].filter(Boolean).join(' ').trim();
        if (!keyword && !code) throw new Error('제조사·차종 또는 상품 코드를 입력해 주세요.');
        this.log(`[B2B] 검색 중 (제조사: ${brand || '-'}, 차종: ${model || '-'}, 코드: ${code || '-'} / idx: ${idx || '-'})...`);

        // 아임웹 검색은 "단어 AND" 방식이라 "현대 소나타"로는 "현대 LF소나타"가 안 잡힌다.
        // 그래서 코드로도 검색해서 세트(코드가 이름에 있는 상품)를 찾은 뒤, 그 상품의 공통명
        // (예: "옵틱글래스 현대 LF소나타")으로 다시 검색해 개별까지 함께 모은다.
        const seen = new Map();      // prodNo → row
        const add = rows => rows.forEach(r => { if (!seen.has(r.prodNo)) seen.set(r.prodNo, r); });

        if (keyword) add(await this._searchRows(keyword));
        if (code) {
            const codeRows = await this._searchRows(code);
            add(codeRows);
            // 코드로 찾은 상품들의 공통명으로 짝(개별) 확장
            const baseKeys = [...new Set(codeRows.map(r => r.baseKey).filter(Boolean))];
            for (const bk of baseKeys) add(await this._searchRows(bk));
        }

        const norm = s => String(s || '').replace(/\s+/g, '');

        // 공통명으로 묶기 — 세트/개별 이름의 띄어쓰기 차이로 갈라지지 않도록 공백을 무시한 키로 묶는다.
        const byKey = new Map();
        for (const r of seen.values()) {
            const nk = norm(r.baseKey);
            if (!byKey.has(nk)) byKey.set(nk, { baseKey: r.baseKey, items: [] });
            byKey.get(nk).items.push(r);
        }
        let groups = [...byKey.values()];

        // 코드가 있으면: 그 코드를 가진 상품이 속한 묶음만 남긴다.
        // (세트에는 코드가 이름에 있고 개별에는 없지만, 둘은 같은 묶음이라 함께 유지된다)
        if (code) groups = groups.filter(g => g.items.some(i => i.name.includes(code)));

        // 차종(모델)은 상품명에 거의 항상 들어있으므로 이걸로 좁힌다. 코드는 substring 이라
        // 다른 제조사(예: "101"→야마하/포드)까지 걸리는데, 모델로 좁히면 걸러진다.
        if (model) groups = groups.filter(g => norm(g.baseKey).includes(norm(model)));

        // 제조사는 "카테고리 이름"이라 상품명과 다를 수 있다.
        //   예) 카테고리 제조사=에디슨모터스 이지만 상품명은 "옵틱글래스 세미시스코 D2 스마트 EV".
        // 그래서 제조사명이 상품명에 있으면 그걸로 더 좁히고, 하나도 없으면(카테고리명≠상품명)
        // 모델 기준 결과를 그대로 둔다. (제조사명 불일치로 전부 사라지는 문제 방지)
        if (brand) {
            const withBrand = groups.filter(g => norm(g.baseKey).includes(norm(brand)));
            if (withBrand.length) groups = withBrand;
        }
        groups.forEach(g => g.items.sort((a, b) => (a.type === 'set' ? -1 : 1) - (b.type === 'set' ? -1 : 1)));

        const total = groups.reduce((n, g) => n + g.items.length, 0);
        this.log(`[B2B] 검색 결과 ${groups.length}묶음 / 상품 ${total}건`);
        if (!groups.length) {
            throw new Error(`상품을 찾지 못했습니다 (${keyword || ''}${code ? ' / ' + code : ''}).`);
        }
        return groups;
    }

    /** 짝(세트+개별)을 한 번에 불러온다 */
    async loadGroup(prodNos) {
        const products = [];
        for (const no of prodNos) products.push(await this.loadProduct(no));

        // 공통 상품명(앞부분)과 상품별 접미사
        const baseKey = this._baseKeyOf(products[0].title);
        products.forEach(p => { p.suffix = this._suffixOf(p.title); p.type = p.title.includes('1셋') ? 'set' : 'indiv'; });

        // 양쪽에 공통으로 있는 옵션(이름 기준) — 차종/연식처럼 함께 바꿀 것들
        const nameSets = products.map(p => new Set(p.optionGroups.map(g => g.name)));
        const sharedNames = [...nameSets[0]].filter(n => nameSets.every(s => s.has(n)));
        const sharedGroups = sharedNames.map(n => {
            const g = products[0].optionGroups.find(x => x.name === n);
            return { name: n, values: g.values.map(v => v.valueName) };
        });

        this.log(`[B2B] 짝 불러오기 완료 — ${products.map(p => `${p.type}(${p.prodNo})`).join(' + ')}`);
        return { baseKey, products, sharedGroups };
    }

    /**
     * 짝을 한 번에 수정한다.
     * data = { baseKey, sharedGroups:[{name,values[]}], detailImages[],
     *          products:[{ prodNo, price, combos[] }] }
     */
    async updateGroup(data) {
        const results = [];
        for (const p of (data.products || [])) {
            const cur = await this.loadProduct(p.prodNo);
            const one = { prodNo: p.prodNo };

            // 상품명: 공통 앞부분 + 각자의 접미사 유지
            if (data.baseKey) {
                const suffix = this._suffixOf(cur.title);
                one.title = `${String(data.baseKey).trim()} ${suffix}`.trim();
            }
            if (p.price != null && p.price !== '') one.price = p.price;
            if (Array.isArray(data.detailImages) && data.detailImages.length) one.detailImages = data.detailImages;

            // 공통 옵션 값은 "이름"으로 각 상품의 optionCode 에 매핑한다
            if (Array.isArray(data.sharedGroups) && data.sharedGroups.length) {
                one.optionValues = cur.optionGroups.map(g => {
                    const shared = data.sharedGroups.find(s => s.name === g.name);
                    return {
                        optionCode: g.optionCode,
                        values: shared ? shared.values.slice() : g.values.map(v => v.valueName),
                    };
                });
            }
            if (Array.isArray(p.combos) && p.combos.length) one.combos = p.combos;

            results.push(await this.updateProduct(one));
        }
        return results.join(' / ');
    }

    // ── 불러오기 ─────────────────────────────────────────────────────────────
    /**
     * 아임웹 옵션 값 코드 생성기.
     * 새 옵션 값의 valueCode 는 서버가 아니라 클라이언트가 만든다(실측 확인).
     * 형식: O + YYYYMMDD + 13자리 hex
     */
    _newOptionCode() {
        const d = new Date(), p = n => String(n).padStart(2, '0');
        const rand = Array.from({ length: 13 }, () => '0123456789abcdef'[Math.random() * 16 | 0]).join('');
        return `O${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${rand}`;
    }

    /** 상세설명 HTML에서 <img> 주소 목록을 뽑는다 */
    extractDetailImages(html) {
        if (!html) return [];
        return [...String(html).matchAll(/<img[^>]*src=["']([^"']+)["'][^>]*>/gi)].map(m => m[1]);
    }

    async loadProduct(prodNo) {
        await this.ensureToken();
        this.log(`[B2B] 상품 ${prodNo} 불러오는 중...`);
        const d = (await this.apiGet(`/products/${prodNo}`)).data;

        // === [진단·임시] 외부채널 노출 필드 확인용. %TEMP%\antigravity-debug 에 저장. ===
        try {
            const dbg = 'C:\\Users\\wish\\AppData\\Local\\Temp\\antigravity-debug';
            await import('fs').then(fs => fs.writeFileSync(`${dbg}\\debug_internal_product_${prodNo}.json`, JSON.stringify(d, null, 2), 'utf-8'));
        } catch (e) {}

        const unit = d.baseInfo?.prodBaseInfoByUnit?.[0] || {};
        const html = d.description?.[0]?.description || '';

        // 옵션 정의 (차종 / 연식 …) — 값 목록을 그대로 노출
        const optionGroups = (d.productOptionInfo?.optionList || []).map(o => {
            const od = (o.optionData || [])[0] || {};
            return {
                optionCode: o.optionCode,
                name: od.name || '',
                values: (od.valueList || []).map(v => ({ valueCode: v.valueCode, valueName: v.valueName })),
            };
        });

        // 옵션 조합 (가격·재고)
        const combos = (d.productOptionInfo?.optionDetails || []).map(c => {
            const per = (c.dataPerUnit || [])[0] || {};
            return {
                optionDetailCode: c.optionDetailCode,
                displayText: per.displayText || '',
                price: per.price ?? 0,
                stock: c.stock ?? 0,
                status: c.status || 'SALE',
            };
        });

        const detailImages = this.extractDetailImages(html);
        this.log(`[B2B] 불러오기 완료 — 옵션값 ${optionGroups.map(g => g.name + ' ' + g.values.length + '개').join(' / ')}, 조합 ${combos.length}개, 상세이미지 ${detailImages.length}장`);

        return {
            prodNo,
            title: unit.productName || '',
            price: d.priceInfo?.[0]?.price ?? 0,
            unitCode: d.priceInfo?.[0]?.unitCode || unit.unitCode || '',
            optionGroups,
            combos,
            detailImages,
            _raw: {
                baseInfo: d.baseInfo,
                description: d.description,
                priceInfo: d.priceInfo,
                productOptionInfo: d.productOptionInfo,
            },
        };
    }

    // ── 저장 ─────────────────────────────────────────────────────────────────
    /**
     * 상세설명 HTML에서 이미지 목록만 새 목록으로 교체한다.
     * 텍스트·레이아웃은 건드리지 않기 위해, 기존 <img> 태그를 순서대로 치환하고
     * 남거나 모자란 만큼만 더하거나 뺀다.
     */
    replaceDetailImages(html, images) {
        const src = String(html || '');
        const tags = [...src.matchAll(/<img[^>]*src=["']([^"']+)["'][^>]*>/gi)];
        const list = images || [];

        if (!tags.length) {
            return list.map(u => `<p style="text-align: center;"><img src="${u}" class="fr-fic fr-dii"></p>`).join('');
        }

        // 이미지 자리는 순서대로 1:1 치환한다. 목록이 더 길면 남는 이미지는 "마지막 자리"가
        // 아니라 그 자리에 이어서 넣어, 사용자가 정한 순서가 그대로 유지되게 한다.
        // (기존 <img> 태그의 속성/클래스는 그대로 물려받아 스타일이 깨지지 않는다)
        const swapSrc = (tag, url) => tag.replace(/src=["'][^"']+["']/i, `src="${url}"`);
        const n = Math.min(tags.length, list.length);
        let out = '', cursor = 0;

        for (let i = 0; i < n; i++) {
            const t = tags[i];
            out += src.slice(cursor, t.index);
            if (i === n - 1 && list.length > tags.length) {
                // 마지막 치환 자리에서 남은 이미지들을 함께 펼친다
                out += list.slice(i).map(u => swapSrc(t[0], u)).join('');
            } else {
                out += swapSrc(t[0], list[i]);
            }
            cursor = t.index + t[0].length;
        }
        // 이미지가 줄었으면 남은 <img> 태그는 제거하고 사이 텍스트는 살린다
        for (let i = n; i < tags.length; i++) {
            const t = tags[i];
            out += src.slice(cursor, t.index);
            cursor = t.index + t[0].length;
        }
        out += src.slice(cursor);
        return out;
    }

    /**
     * data = { prodNo, title?, price?, detailImages?, optionValues?, combos? }
     * 지정한 항목만 PATCH 한다. (아임웹 PATCH 는 부분 수정)
     */
    async updateProduct(data) {
        const { prodNo } = data;
        if (!prodNo) throw new Error('수정할 상품번호가 없습니다.');

        const cur = await this.loadProduct(prodNo);
        const payload = {};
        const done = [];

        // 1) 상품명
        const newTitle = String(data.title ?? '').trim();
        if (newTitle && newTitle !== cur.title) {
            const base = JSON.parse(JSON.stringify(cur._raw.baseInfo));
            // 저장 형식에 맞춰 images 는 imageCode/imagePath 만 남긴다
            base.images = (base.productImages || []).map(i => ({ imageCode: i.imageCode, imagePath: i.imagePath }));
            delete base.productImages;
            base.prodBaseInfoByUnit = (base.prodBaseInfoByUnit || []).map(u => ({ ...u, productName: newTitle }));
            payload.baseInfo = base;
            done.push(`상품명 "${cur.title}" → "${newTitle}"`);
        }

        // 2) 판매가
        if (data.price != null && data.price !== '' && Number(data.price) !== cur.price) {
            const pi = JSON.parse(JSON.stringify(cur._raw.priceInfo));
            pi[0].price = Number(data.price);
            payload.priceInfo = pi;
            done.push(`판매가 ${cur.price} → ${Number(data.price)}원`);
        }

        // 3) 상세페이지 이미지
        if (Array.isArray(data.detailImages)) {
            if (!data.detailImages.length) {
                throw new Error('상세페이지 이미지가 0장입니다. 최소 1장은 있어야 합니다.');
            }
            const desc = JSON.parse(JSON.stringify(cur._raw.description));
            desc[0].description = this.replaceDetailImages(desc[0].description, data.detailImages);
            payload.description = desc;
            done.push(`상세이미지 ${cur.detailImages.length} → ${data.detailImages.length}장`);
        }

        // 4) 옵션값 (차종/연식 등) + 조합
        //    아임웹은 optionMixType=MIX 라서 optionDetails 가 항상 "모든 값의 조합(카테시안 곱)"
        //    이어야 한다. 값을 하나 추가하면 조합도 그만큼 다시 만들어 함께 보내야 하고,
        //    안 그러면 400 "모든 옵션 상세 정보를 제공해야 합니다" 오류가 난다.
        //    새로 추가한 값의 valueCode 는 서버가 아니라 클라이언트가 만든다. (실측 확인)
        const wantValues = Array.isArray(data.optionValues) && data.optionValues.length;
        const wantCombos = Array.isArray(data.combos) && data.combos.length;

        if (wantValues || wantCombos) {
            const poi = JSON.parse(JSON.stringify(cur._raw.productOptionInfo));

            // 4a. 값 목록 교체 (기존 값은 valueCode 유지, 새 값은 코드 생성)
            if (wantValues) {
                for (const g of data.optionValues) {
                    const target = (poi.optionList || []).find(o => o.optionCode === g.optionCode);
                    const od = target && (target.optionData || [])[0];
                    if (!od) continue;
                    const oldMap = new Map((od.valueList || []).map(v => [v.valueName, v.valueCode]));
                    od.valueList = g.values.map(name => ({
                        valueCode: oldMap.get(name) || this._newOptionCode(),
                        valueName: name,
                    }));
                    done.push(`옵션 "${od.name}" ${g.values.length}개 값`);
                }
            }

            // 4b. 기존 조합의 가격/재고를 "값 조합" 기준으로 기억해 둔다
            const keyOf = codes => codes.slice().sort().join('|');
            const prev = new Map();
            for (const d0 of (cur._raw.productOptionInfo.optionDetails || [])) {
                prev.set(keyOf((d0.optionValuePairs || []).map(p => p.valueCode)), d0);
            }
            // 화면에서 편집한 가격/재고를 덮어쓴다.
            // 새로 생긴 조합은 아직 optionDetailCode 가 없으므로 표시문구(displayText)로도 찾는다.
            const edited = new Map();
            const editedByText = new Map();
            if (wantCombos) for (const c of data.combos) {
                if (c.optionDetailCode) edited.set(c.optionDetailCode, c);
                if (c.displayText) editedByText.set(String(c.displayText).trim(), c);
            }

            // 4c. 모든 조합을 카테시안 곱으로 재생성
            const opts = (poi.optionList || []).map(o => ({
                optionCode: o.optionCode,
                values: ((o.optionData || [])[0]?.valueList) || [],
            }));
            let rows = [[]];
            for (const o of opts) {
                const next = [];
                for (const row of rows) for (const v of o.values) {
                    next.push([...row, { optionCode: o.optionCode, valueCode: v.valueCode, valueName: v.valueName }]);
                }
                rows = next;
            }

            const tpl = (cur._raw.productOptionInfo.optionDetails || [])[0];
            if (!tpl) throw new Error('기존 옵션 조합이 없어 조합을 만들 수 없습니다.');
            const unitCode = tpl.dataPerUnit?.[0]?.unitCode || cur.unitCode;

            // 조합은 "쓰기 형식"으로 만든다. 가격은 읽기 필드(dataPerUnit)가 아니라
            // 쓰기 필드 prices[{unitCode, price}] 로 보내야 서버가 반영한다(실측 확인).
            poi.optionDetails = rows.map((row, i) => {
                const k = keyOf(row.map(p => p.valueCode));
                const src = prev.get(k);           // 같은 값 조합이 원래 있었으면 그 정보 재사용
                const text = row.map(p => p.valueName).join(' / ');
                const ed = (src && src.optionDetailCode && edited.get(src.optionDetailCode)) || editedByText.get(text);

                // 가격: 편집값 우선 → 기존 조합 가격 → (신규면) 0
                let price = 0;
                if (ed && ed.price != null && ed.price !== '') price = parseInt(ed.price) || 0;
                else if (src) price = src.dataPerUnit?.[0]?.price ?? 0;

                // 재고: 편집값 우선 → 기존 재고 → 0
                let stock = 0;
                if (ed && ed.stock != null && ed.stock !== '') stock = parseInt(ed.stock) || 0;
                else if (src) stock = src.stock ?? 0;

                const detail = {
                    no: i + 1,
                    optionValuePairs: row.map(p => ({ optionCode: p.optionCode, valueCode: p.valueCode })),
                    prices: [{ unitCode, price }],
                    status: (src && src.status) || 'SALE',
                    stock,
                    stockSku: (src && src.stockSku) || '',
                };
                if (src && src.optionDetailCode) detail.optionDetailCode = src.optionDetailCode;
                return detail;
            });

            const oldN = (cur._raw.productOptionInfo.optionDetails || []).length;
            if (poi.optionDetails.length !== oldN) done.push(`옵션 조합 ${oldN} → ${poi.optionDetails.length}개`);
            else if (wantCombos) done.push(`옵션 조합 ${data.combos.length}건 가격/재고`);
            payload.productOptionInfo = poi;
        }

        if (!Object.keys(payload).length) {
            throw new Error('변경할 내용이 없습니다.');
        }

        this.log(`[B2B] 저장 중 — ${done.join(', ')}`);
        await this.apiPatch(`/products/${prodNo}`, payload);

        // 반영 검증
        await sleep(1500);
        const after = await this.loadProduct(prodNo);
        const problems = [];
        if (payload.baseInfo && after.title !== newTitle) problems.push(`상품명 미반영 (현재 "${after.title}")`);
        if (payload.priceInfo && after.price !== Number(data.price)) problems.push(`판매가 미반영 (현재 ${after.price})`);
        if (payload.description && after.detailImages.length !== data.detailImages.length) {
            problems.push(`상세이미지 ${after.detailImages.length}장 (요청 ${data.detailImages.length}장)`);
        }
        if (payload.productOptionInfo && wantCombos) {
            for (const c of data.combos) {
                if (c.price == null || c.price === '' || c.displayText == null) continue;
                const got = after.combos.find(x => String(x.displayText).trim() === String(c.displayText).trim());
                if (got && got.price !== (parseInt(c.price) || 0)) {
                    problems.push(`조합 "${got.displayText}" 가격 ${got.price} (요청 ${c.price})`);
                }
            }
        }

        if (problems.length) throw new Error(`저장은 됐지만 반영이 다릅니다: ${problems.join(' / ')}`);

        const summary = `상품 ${prodNo} 수정 완료 — ${done.join(', ')}`;
        this.log(`✓ ${summary}`);
        return summary;
    }

    // ══════════════════════════════════════════════════════════════════════════
    // 본사몰/해외몰 게시글(조견표) 수정
    //
    // 게시판 관리자는 별도 사이트(optic-glass.imweb.me)의 레거시 컨텐츠 API를 쓴다.
    // 실측으로 확인한 프로토콜(모두 /admin/ajax/contents/v2/api.cm, 쿠키 인증):
    //   - 게시판 목록 : POST endpoint=boards                     → 제조사 이름으로 board_code 확보
    //   - 게시글 검색 : POST endpoint=posts&board_code=X&keyword=Y
    //   - 불러오기    : GET  endpoint=post&code=X                → subject(제목) + content(본문 HTML)
    //   - 저장        : POST endpoint=edit-post&code=X (form 인코딩)
    //                    필드: idx, board_code, code, post_code, subject, body(=본문), ...
    //                    ※ 본문 필드명이 읽기는 content, 쓰기는 body 로 다르다.
    // ══════════════════════════════════════════════════════════════════════════

    /** 게시판 관리자 페이지를 열고, cm API 의 site_code/unit_code 가 든 기본 URL을 확보한다 */
    async ensureBoardBase(lang = null) {
        if (lang) {
            if (this.currentLang && this.currentLang !== lang) {
                this.boardBase = null; // 다른 언어/도메인 진입 시 기존 base 주소 초기화
            }
            this.currentLang = lang;
        } else {
            lang = this.currentLang || 'ko';
        }

        if (this.boardBase) return this.boardBase;
        if (!this.page) await this.initBrowserSession();

        const config = this.loadConfig();
        const adminBaseUrl = (/^en/i.test(lang) ? config.usUrl : config.headUrl) || 'https://optic-glass.imweb.me/admin';
        const cleanAdminBase = adminBaseUrl.replace(/\/+$/, '');
        const targetUrl = `${cleanAdminBase}/contents/post/list?page=1&page_size=20`;

        this.log(`게시판 API 인증 진행 (언어: ${lang}, 대상 URL: ${targetUrl})`);

        let base = null;
        const requestHandler = (r) => {
            const m = r.url().match(/(https:\/\/[^/]+\/admin\/ajax\/contents\/v2\/api\.cm\?site_code=[^&]+&unit_code=[^&]+)/);
            if (m && !base) base = m[1];
        };
        this.page.on('request', requestHandler);

        try {
            await this.openAdminAt(targetUrl, '/admin/contents/post');
            for (let i = 0; i < 24 && !base; i++) await sleep(700);
        } finally {
            this.page.off('request', requestHandler);
        }

        if (!base) throw new Error('게시판 API 주소(site_code/unit_code)를 확보하지 못했습니다.');
        this.boardBase = base;
        this.log(`${/^en/i.test(lang) ? '해외몰' : '본사'} 게시판 관리자 인증 완료.`);
        return base;
    }

    /** 페이지 컨텍스트에서 cm API 호출 (쿠키 인증) */
    async cmFetch(endpointQs, { method = 'GET', form = null } = {}) {
        const url = `${this.boardBase}&endpoint=${endpointQs}`;
        return this.page.evaluate(async ({ url, method, form }) => {
            const opt = { method, credentials: 'include' };
            if (form) { opt.headers = { 'Content-Type': 'application/x-www-form-urlencoded' }; opt.body = new URLSearchParams(form).toString(); }
            const r = await fetch(url, opt);
            return { status: r.status, text: await r.text() };
        }, { url, method, form });
    }

    async cmJson(endpointQs, opt) {
        const r = await this.cmFetch(endpointQs, opt);
        let j; try { j = JSON.parse(r.text); } catch { throw new Error(`게시판 API 응답 파싱 실패: ${r.text.slice(0, 120)}`); }
        if (j.status !== 'success') throw new Error(`게시판 API 오류: ${j.message || j.status_code}`);
        return j.data;
    }

    /** 제조사 이름(+언어)으로 board_code 를 찾는다. 언어별 게시판명은 data/imweb_boards.json 매핑 사용 */
    async findBoard(brand, lang) {
        await this.ensureBoardBase(lang);
        const boardName = this.boardNameFor(brand, lang) || brand;
        const boards = await this.cmJson('boards', { method: 'POST' });
        // 정확 일치 우선, 없으면 공백 제거 비교
        const norm = s => String(s || '').replace(/\s+/g, '');
        let hit = boards.find(b => b.name === boardName)
            || boards.find(b => norm(b.name) === norm(boardName));
        if (!hit) throw new Error(`게시판 "${boardName}"을(를) 찾지 못했습니다. (제조사: ${brand}, 언어: ${lang})`);
        this.log(`게시판 확인: "${hit.name}" (board_code=${hit.code})`);
        return { boardCode: hit.code, boardName: hit.name };
    }

    /**
     * 제조사/언어/코드로 게시글을 찾는다. 코드로 게시판 안을 검색해 제목에 그 코드가 든 글을 고른다.
     */
    async searchPosts({ brand, lang, code }) {
        const { boardCode, boardName } = await this.findBoard(brand, lang);
        // 서버 keyword 는 부분일치가 약해 0건이 되기도 하고, page_size 도 무시된다(항상 20건씩).
        // 그래서 게시판의 모든 페이지를 순회해 전부 모은 뒤, 코드는 제목 포함으로 클라이언트 필터.
        const all = [];
        let pageNo = 1, totalPages = 1;
        do {
            const d = await this.cmJson(`posts&type=post&board_code=${boardCode}&keyword=&status=&page=${pageNo}`, { method: 'POST' });
            for (const p of (d.posts || [])) all.push(p);
            totalPages = parseInt(d.pagination?.total_pages) || 1;
            pageNo++;
        } while (pageNo <= totalPages && pageNo <= 50);   // 안전 상한

        const rows = all.map(p => ({
            postCode: p.post.code,
            subject: p.post.subject || '',
            idx: p.post.idx || p.post.id || '',
            boardCode,
            boardName,
        })).filter(r => r.postCode && r.subject);
        const filtered = code ? rows.filter(r => 
            r.subject.includes(code) || 
            String(r.idx) === String(code) || 
            r.postCode === code
        ) : rows;
        this.log(`[게시글] "${boardName}"에서 ${filtered.length}건 검색됨${code ? ` (검색키워드/코드/번호 ${code})` : ''}`);
        if (!filtered.length) throw new Error(`게시글을 찾지 못했습니다 (${boardName}${code ? ' / ' + code : ''}).`);
        return filtered;
    }

    /** 게시글 하나를 불러온다 (제목 + 본문 이미지 목록) */
    async loadPost(postCode) {
        await this.ensureBoardBase();
        const d = await this.cmJson(`post&code=${postCode}`, { method: 'GET' });
        const images = this.extractDetailImages(d.content);
        this.log(`[게시글] 불러오기 완료 — "${d.subject}", 이미지 ${images.length}장`);
        return {
            postCode,
            idx: d.idx,
            boardCode: d.board_code,
            categoryCode: d.category_code || '',
            subject: d.subject || '',
            content: d.content || '',
            isNotice: d.is_notice || 'N',
            isHide: d.is_hide || 'N',
            isSecret: d.is_secret || 'N',
            images,
        };
    }

    /**
     * 게시글 저장. data = { postCode, subject, imageUrl? , content? }
     * imageUrl 을 주면 본문의 <img> 를 그 주소로 교체한다 (사용자가 </> 로 넣던 것과 동일 효과).
     */
    async updatePost(data) {
        await this.ensureBoardBase();
        const cur = await this.loadPost(data.postCode);

        let content = cur.content;
        const done = [];

        const newSubject = String(data.subject ?? '').trim();
        if (newSubject && newSubject !== cur.subject) done.push(`제목 "${cur.subject}" → "${newSubject}"`);
        const subject = newSubject || cur.subject;

        // 이미지 교체 우선순위: content 직접 > images 배열 > imageUrl 단일
        if (data.content != null && data.content !== '') {
            content = data.content;
            done.push('본문 교체');
        } else if (Array.isArray(data.images)) {
            if (!data.images.length) throw new Error('게시글 이미지가 0장입니다. 최소 1장은 있어야 합니다.');
            const clean = data.images.map(u => { const m = String(u).match(/src=["']([^"']+)["']/i); return m ? m[1] : String(u).trim(); });
            content = this.replaceDetailImages(content, clean);   // 본문 텍스트·배너는 보존, <img>만 교체
            done.push(`조견표 이미지 ${cur.images.length} → ${clean.length}장`);
        } else if (data.imageUrl) {
            let url = String(data.imageUrl).trim();
            const m = url.match(/src=["']([^"']+)["']/i);
            if (m) url = m[1];
            content = this.replaceDetailImages(content, [url]);
            done.push('조견표 이미지 교체');
        }

        if (!done.length) throw new Error('변경할 내용이 없습니다.');

        this.log(`[게시글] 저장 중 — ${done.join(', ')}`);
        const r = await this.cmFetch(`edit-post&code=${data.postCode}`, {
            method: 'POST',
            form: {
                idx: cur.idx, board_code: cur.boardCode, code: data.postCode, post_code: data.postCode,
                subject, body: content,
                category_code: cur.categoryCode, is_notice: cur.isNotice, is_hide: cur.isHide, is_secret: cur.isSecret,
            },
        });
        let j; try { j = JSON.parse(r.text); } catch { j = {}; }
        if (j.status !== 'success') throw new Error(`게시글 저장 실패: ${j.message || r.text.slice(0, 120)}`);

        // 반영 검증
        await sleep(1000);
        const after = await this.loadPost(data.postCode);
        const problems = [];
        if (newSubject && after.subject !== newSubject) problems.push(`제목 미반영 (현재 "${after.subject}")`);
        if ((data.imageUrl || Array.isArray(data.images) || data.content != null) && after.content === cur.content) {
            problems.push('본문/이미지 미반영');
        }
        if (problems.length) throw new Error(`저장은 됐지만 반영이 다릅니다: ${problems.join(' / ')}`);

        const summary = `게시글 수정 완료 — ${done.join(', ')}`;
        this.log(`✓ ${summary}`);
        return summary;
    }
}
