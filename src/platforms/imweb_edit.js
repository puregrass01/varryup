import path from 'path';
import { fileURLToPath } from 'url';
import { readEnglishPrice, replaceEnglishPrice } from '../utils/imweb_currency.js';
import { Imweb } from './imweb.js';
import { titleHasCode, extractDetailImages, replaceDetailImages } from './openapi/imweb_b2b.js';

// 상품명·게시글 제목에 상품번호가 있는지(대소문자 무시). 정의는 imweb_b2b.js — 예전 경로로 가져다 쓰는 곳을 위해 다시 내보낸다.
export { titleHasCode };

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const CATEGORIES_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'imweb_categories.json');

/**
 * 아임웹 작업 묶음.
 *
 *  - B2B몰 상품(조회 · 등록 · 수정 · 상품수정 탭 · 카테고리 동기화): 아임웹 Open API — imweb_b2b.js(this.b2b).
 *    예전의 내부 관리자 API(브라우저로 가로챈 토큰) · v2 API · 화면 클릭은 2026-10-05 지웠다. 메서드 이름은
 *    화면 · 중복 검사 · 일괄 수정이 그대로 부르도록 남겨 두고 Open API 로 넘긴다.
 *  - 본사 · 해외 · 일본몰 게시판 글: 아임웹 Open API 에 게시판이 없어 지금처럼 cm API(브라우저 세션)로 한다.
 */
export class ImwebEdit extends Imweb {
    constructor(...args) {
        super(...args);
        this.b2b = null;   // main_process 가 createB2bApi(B2B몰 OAuth 클라이언트)로 넣는다
    }

    get b2bApi() {
        if (!this.b2b) throw new Error('아임웹 B2B몰 Open API 연결이 없습니다. 아임웹 탭 > Open API 키의 OAuth 값을 확인하세요.');
        return this.b2b;
    }

    // ── B2B몰: 전부 Open API(imweb_b2b.js) ─────────────────────────────────────
    registerB2bViaApi(data) { return this.b2bApi.registerB2bViaApi(data); }
    modifyB2bViaApi(data) { return this.b2bApi.modifyB2bViaApi(data); }
    listB2bRowsByCode(code) { return this.b2bApi.listB2bRowsByCode(code); }
    b2bOptionValuesOf(prodNo) { return this.b2bApi.b2bOptionValuesOf(prodNo); }
    searchProducts(query) { return this.b2bApi.searchProducts(query); }
    loadGroup(prodNos) { return this.b2bApi.loadGroup(prodNos); }
    updateGroup(data) { return this.b2bApi.updateGroup(data); }
    loadProduct(prodNo) { return this.b2bApi.loadProduct(prodNo); }
    updateProduct(data) { return this.b2bApi.updateProduct(data); }
    /** 화면의 브랜드/차종 목록 파일을 B2B몰 카테고리로 새로 만든다(예전엔 관리자 화면 응답을 가로챘다). */
    syncCategories() { return this.b2bApi.syncCategories(CATEGORIES_PATH); }

    // 게시판 글 편집이 쓰는 HTML 도우미(순수 함수는 imweb_b2b.js)
    extractDetailImages(html) { return extractDetailImages(html); }
    replaceDetailImages(html, images) { return replaceDetailImages(html, images); }

    /**
     * executeAutomation 은 끝에 close() 로 컨텍스트를 닫지만 page·token 은 그대로 남는다.
     * 다음 게시판 작업이 닫힌 컨텍스트를 쓰면 원인을 알 수 없는 오류가 나므로 버린다.
     */
    resetClosedSession() {
        if (!this.page || (typeof this.page.isClosed === 'function' && this.page.isClosed())) {
            this.page = null;
            this.context = null;
            this.boardBase = null;
            this.currentLang = null;
        }
    }

    /** 게시판의 모든 글(코드 필터 없음). searchPosts 와 달리 0건이어도 던지지 않는다. */
    async listBoardPosts(brand, lang) {
        const { boardCode, boardName } = await this.findBoard(brand, lang);
        const all = [];
        let pageNo = 1, totalPages = 1;
        do {
            const d = await this.cmJson(`posts&type=post&board_code=${boardCode}&keyword=&status=&page=${pageNo}`, { method: 'POST' });
            if (!Array.isArray(d?.posts)) throw new Error(`게시판 "${boardName}" 글 목록 응답에 posts 가 없습니다.`);
            all.push(...d.posts);
            totalPages = parseInt(d.pagination?.total_pages) || 1;
            pageNo++;
        } while (pageNo <= totalPages && pageNo <= 50);   // searchPosts 와 같은 안전 상한
        const rows = all.map(p => ({
            postCode: p?.post?.code,
            subject: p?.post?.subject || '',
            idx: p?.post?.idx || p?.post?.id || '',
            boardCode,
            boardName,
        })).filter(r => r.postCode && r.subject);
        return { rows, complete: totalPages <= 50 };
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

        const adminBaseUrl = this.boardAdminUrl(lang);
        const cleanAdminBase = adminBaseUrl.replace(/\/+$/, '');
        const targetUrl = `${cleanAdminBase}/contents/post/list?page=1&page_size=20`;

        this.log(`게시판 API 인증 진행 (언어: ${lang}, 대상 URL: ${targetUrl})`);

        let base = null;
        const requestHandler = (r) => {
            const m = r.url().match(/(https:\/\/[^/]+\/admin\/ajax\/contents\/v2\/api\.cm\?site_code=[^&]+&unit_code=[^&]+)/);
            if (m && !base && new URL(m[1]).origin === new URL(targetUrl).origin) base = m[1];
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

    /** cm API 를 multipart/form-data 로 POST 한다 (add-post 등 multipart 전용 엔드포인트용, 쿠키 인증) */
    async cmFetchMultipart(endpointQs, fields) {
        const url = `${this.boardBase}&endpoint=${endpointQs}`;
        return this.page.evaluate(async ({ url, fields }) => {
            const fd = new FormData();
            for (const [k, v] of Object.entries(fields)) fd.append(k, v == null ? '' : String(v));
            const r = await fetch(url, { method: 'POST', credentials: 'include', body: fd }); // boundary 자동
            return { status: r.status, text: await r.text() };
        }, { url, fields });
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
            titleHasCode(r.subject, code) || 
            String(r.idx) === String(code) || 
            r.postCode === code
        ) : rows;
        this.log(`[게시글] "${boardName}"에서 ${filtered.length}건 검색됨${code ? ` (검색키워드/코드/번호 ${code})` : ''}`);
        if (!filtered.length) throw new Error(`게시글을 찾지 못했습니다 (${boardName}${code ? ' / ' + code : ''}).`);
        return filtered;
    }

    /** 게시글 하나를 불러온다 (제목 + 본문 이미지 목록) */
    async loadPost(postCode, lang = null) {
        await this.ensureBoardBase(lang);
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
            priceUsd: readEnglishPrice(d.content),
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
        const priceHtml = data.lang === 'en' && String(data.priceUsd ?? '').trim()
            ? this.priceHtmlFor(data, 'en') : '';
        await this.ensureBoardBase(data.lang);
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

        if (priceHtml) {
            content = replaceEnglishPrice(content, priceHtml);
            done.push('영문 USD 판매가·환율 적용');
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
        if ((data.imageUrl || Array.isArray(data.images) || data.content != null) && content !== cur.content && after.content === cur.content) {
            problems.push('본문/이미지 미반영');
        }
        if (priceHtml && readEnglishPrice(after.content) !== readEnglishPrice(priceHtml)) problems.push('USD 판매가 미반영');
        if (problems.length) throw new Error(`저장은 됐지만 반영이 다릅니다: ${problems.join(' / ')}`);

        const summary = `게시글 수정 완료 — ${done.join(', ')}`;
        this.log(`✓ ${summary}`);
        return summary;
    }

    /**
     * 본사·해외몰 게시글 신규 작성 — cm API(add-post)로 직접. 브라우저 폼 조작 없음.
     * 성공 true / 매핑·이미지 없어 건너뜀 false / 서버오류는 throw.
     */
    async createBoardPostViaApi(data, lang) {
        const LANGS = { ko: '한국어', en: '영문', jp: '일문' };
        const boardNameMapped = this.boardNameFor(data.brand, lang);
        if (!boardNameMapped) {
            this.log(`⚠ "${data.brand}" 의 ${LANGS[lang]} 게시판이 매핑에 없어 건너뜁니다 (data/imweb_boards.json).`);
            return false;
        }

        // ── 제목·본문 생성 ──
        // 이름·배너는 Imweb 의 공용 헬퍼를 쓴다. 세 경로가 복붙이던 걸 모아 둔 것이라
        // 여기서 따로 조립하면 신규 작성만 형식이 어긋난다.
        const nameBrand = this.nameForLang(data, 'titleBrand', lang);
        const nameModel = this.nameForLang(data, 'titleModel', lang);
        const subject = `${nameBrand} ${nameModel} [${data.code}]`;

        const bannerTitle = this.bannerFor(data, nameBrand, nameModel, lang);
        // 조견표 이미지는 언어가 아니라 지역 자산이라 일본몰도 해외용(En)을 공유한다.
        const rawSpec = (lang === 'ko') ? data.specImageUrl : (data.specImageUrlEn || data.specImageUrl);
        const specUrl = this.extractImageUrl(rawSpec);
        if (!specUrl) {
            this.log(`⚠ ${LANGS[lang]} 조견표 이미지 URL이 비어 있어 게시글 작성을 건너뜁니다.`);
            return false;
        }
        const body =
            `<p style="text-align: center;"><strong><span style="font-size: 30px;">${bannerTitle}</span></strong></p>` +
            `<p style="text-align: center;"><img src="${specUrl}" class="fr-fic fr-dii"></p>` + this.priceHtmlFor(data, lang) + (data.detailHtml || '');

        // ── 게시판 코드 확보 후 add-post 요청 ──
        const { boardCode, boardName } = await this.findBoard(data.brand, lang);
        this.log(`[게시글 작성] "${boardName}" (${LANGS[lang]}) — cm API add-post`);

        // add-post 는 multipart/form-data 전용, 그리고 board_code 는 쿼리스트링에서 읽는다
        // (posts&board_code=X 와 동일 규칙). 그래서 쿼리+body 둘 다에 넣는다. 쿠키 세션 인증.
        // code/idx 를 비우면 신규 생성. writer_code 는 세션에서 서버가 채운다(edit-post 도 작성자 안 보냄).
        const r = await this.cmFetchMultipart(`add-post&board_code=${encodeURIComponent(boardCode)}`, {
            board_code: boardCode, code: '', idx: '',
            subject, body,
            category_code: '', is_notice: 'N', is_secret: 'N', secret_pass: '',
            nick: '', writer_code: '', represent_img: data.mainImageUrl || '', cover_img: '',
            use_category: 'N', keywords: '',
        });
        let j; try { j = JSON.parse(r.text); } catch { j = {}; }
        if (j.status !== 'success') {
            throw new Error(`게시글 작성 실패(${boardName}): ${j.message || j.status_code || r.text.slice(0, 150)}`);
        }
        this._lastPost = { boardCode, boardName, subject, postCode: j.data?.code || null };   // 중복 방지 원장용
        this.log(`✓ [${LANGS[lang]}] 게시글 작성 완료: ${subject}`);
        return true;
    }
}
