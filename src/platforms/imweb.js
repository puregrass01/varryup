import { ENGLISH_BOARD_ADMIN, englishPriceHtml } from '../utils/imweb_currency.js';
import { BasePlatform } from './base_platform.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

// <project>/src/platforms/imweb.js → <project>/data/*.json
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const BOARDS_PATH = path.join(MODULE_DIR, '..', '..', 'data', 'imweb_boards.json');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// 디버그 캡처용 임시 폴더 (배포 환경에서도 안전; 실패 시 null)
function _debugDir() {
    try {
        const d = path.join(os.tmpdir(), 'antigravity-debug');
        if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
        return d;
    } catch { return null; }
}

/**
 * executeAutomation 결과 → imweb-register IPC 응답 (공통 계약 C1).
 * success 는 요청한 대상이 전부 성공했을 때만 true. 일부만 성공하면 success:false + partial:true 이고,
 * error 에 실패한 대상과 이유를 적는다. 아무 대상도 처리하지 않았으면(선택 없음) 성공으로 치지 않는다.
 * @param {{summary?: string, results?: Array<{target: string, ok: boolean, error?: string}>}} run
 * @param {string} [suffix] 중복검사 안내(noticeSuffix) — message·error 끝에 붙인다.
 */
export function imwebRunResponse(run, suffix = '') {
    const results = (run?.results || []).map(r => ({ target: r.target, ok: !!r.ok, ...(r.ok ? {} : { error: r.error || '실패' }) }));
    const message = (run?.summary || '') + suffix;
    if (!results.length) {
        return { success: false, error: '처리한 대상이 없습니다 (개별/세트 또는 게시판을 선택하세요).' + suffix, message, results };
    }
    const failed = results.filter(r => !r.ok);
    if (!failed.length) return { success: true, message, results };
    const partial = failed.length < results.length;
    const detail = failed.map(r => `${r.target}: ${r.error}`).join(' / ');
    return {
        success: false,
        partial,
        message,
        results,
        error: (partial ? `일부 실패 (성공: ${results.filter(r => r.ok).map(r => r.target).join(', ')}) — ` : '') + detail + suffix,
    };
}

export class Imweb extends BasePlatform {
    constructor(configPath, getBrowserSync) {
        // 브라우저는 '가져오는 함수'를 그대로 넘긴다 — BasePlatform 의 게터가 매 접근마다
        // 현재 값을 읽으므로, 예전처럼 작업 시작 시 this.browser 를 다시 꽂을 필요가 없다.
        // sessionPath 는 null 로 둔다: getSessionPath() 가 작업(본사/B2B/US)마다 정한다.
        super(getBrowserSync, null);
        this.configPath = configPath;
        this.logCallback = null;
    }

    log(msg) {
        console.log(msg);
        if (this.logCallback) {
            this.logCallback(msg);
        }
    }

    loadConfig() {
        if (fs.existsSync(this.configPath)) {
            return JSON.parse(fs.readFileSync(this.configPath, 'utf-8'));
        }
        return {};
    }

    async getSessionPath() {
        const userDataPath = path.dirname(this.configPath);
        return path.join(userDataPath, 'session_imweb_portal.json');
    }

    // 로그인 폼에 서버에서 받은 계정을 채우고 제출한다. 현재 페이지가 로그인 폼이라고 가정한다.
    // 자격증명이 없거나 폼을 못 찾으면 false — 호출부는 수동 로그인 대기로 넘어간다.
    async fillLoginForm() {
        if (!(this.autoLogin && this.autoLogin.loginId && this.autoLogin.password)) return false;
        try {
            this.log(`[아임웹] 저장된 계정으로 자동 로그인 시도...`);
            await this.page.waitForSelector('input[name="email"]', { timeout: 8000 });
            await this.page.fill('input[name="email"]', this.autoLogin.loginId);
            await this.page.fill('input[name="password"]', this.autoLogin.password);
            try { await this.page.check('input[name="autoLogin"]', { timeout: 2000 }); } catch {}
            await this.page.click('button[type="submit"]');
            this.log(`[아임웹] 자동 입력 완료. (캡차·추가 인증이 뜨면 직접 처리해주세요)`);
            return true;
        } catch (e) {
            this.log(`[아임웹] 자동 로그인 입력 실패 → 수동으로 진행: ${e.message}`);
            return false;
        }
    }

    // Fresh browser context with the saved session + the popup guard + console loggers.
    // (No navigation — callers then open the admin URL they need directly.)
    async initBrowserSession() {
        const sessionPath = await this.getSessionPath();
        this.sessionPath = sessionPath;

        this.log(`[아임웹] 로그인 세션 초기화 중...`);
        // Admin tables (product list row actions, etc.) need a wide viewport — narrower
        // windows push the "⋮" action button off-screen.
        await this.init(true, { width: 1920, height: 1000 });

        // Some row icons open a NEW tab (e.g. the storefront "미리보기" preview → public
        // bb-store.co.kr). this.page never changes then, so watch for and close such popups.
        this.context.on('page', async (newPage) => {
            try {
                await newPage.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
                const url = newPage.url();
                if (url && url !== 'about:blank' && !url.includes('imweb.me')) {
                    this.log(`⚠ 예상치 못한 새 창(${url})이 열려 자동으로 닫았습니다.`);
                    await newPage.close().catch(() => {});
                }
            } catch (e) {}
        });

        this.page.on('console', msg => {
            const text = msg.text();
            if (msg.type() === 'error' || text.includes('failed') || text.includes('Error')) {
                this.log(`[브라우저 콘솔] ${msg.type().toUpperCase()}: ${text}`);
            }
        });
        this.page.on('pageerror', err => {
            this.log(`[브라우저 에러] ${err.stack || err.message}`);
        });
    }

    // Navigates STRAIGHT to an admin URL (no imweb.me/mysite portal hop — that portal step
    // was throwing the intermittent 500/505 and forced the extra "사이트 관리" click). The
    // saved session already carries admin cookies for both bbstore37 and optic-glass. If the
    // session has expired we land on a login page instead of `readyPath`; then we sign in
    // again with the stored account and re-navigate, saving the refreshed session. Only if
    // that fails (captcha, 2FA) do we fall back to waiting for a manual login.
    async openAdminAt(url, readyPath) {
        const onAdmin = () => this.page.url().includes(readyPath);

        for (let attempt = 1; attempt <= 2; attempt++) {
            this.log(`[아임웹] 관리자 페이지로 직접 이동: ${url}`);
            await this.page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
            await sleep(3000);
            if (onAdmin()) {
                this.log('[아임웹] ✓ 세션 유효 — 관리자 진입 완료.');
                return true;
            }
            this.log(`[아임웹] 관리자 진입 실패(시도 ${attempt}/2), 현재 URL: ${this.page.url()}`);
        }

        // Still not on the admin page → the saved session expired.
        // 등록·수정 실행 한 번에 끝나야 하므로, 여기서 같은 계정으로 다시 로그인한다.
        // (예전엔 무조건 사람이 창에 직접 치기를 120초 기다렸다.)
        this.log('[아임웹] 세션이 만료됐습니다 — 자동 로그인을 시도합니다.');
        await this.page.goto('https://imweb.me/login', { waitUntil: 'domcontentloaded' }).catch(() => {});
        if (await this.fillLoginForm()) {
            // 로그인 뒤에는 보통 포털 홈으로 떨어진다 → 홈이든 관리자든 먼저 오는 쪽을 기다린 뒤
            // 목표 관리자 URL 로 다시 들어간다.
            await this.page.waitForURL(u => this.isPortalHomeUrl(u.href) || u.href.includes(readyPath),
                                       { timeout: 60000 }).catch(() => {});
            if (!onAdmin()) {
                await this.page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
                await sleep(2500);
            }
            if (onAdmin()) {
                this.log('[아임웹] ✓ 자동 로그인 성공 — 세션을 저장합니다.');
                await this.saveSession();
                return true;
            }
            this.log('[아임웹] 자동 로그인으로 관리자에 못 들어갔습니다 (캡차·추가 인증일 수 있음).');
        }

        this.log('[아임웹] 열린 브라우저 창에서 로그인을 완료해 주세요... (대기 120초)');
        try {
            await this.page.waitForURL(u => u.href.includes(readyPath), { timeout: 120000 }).catch(() => {});
            if (!onAdmin()) {
                // User logged in on a generic page — re-navigate to the target.
                await this.page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
                await sleep(2500);
            }
        } catch (e) { /* handled below */ }

        if (onAdmin()) {
            this.log('[아임웹] 로그인 감지 완료 — 세션을 저장합니다.');
            await this.saveSession();
            return true;
        }
        throw new Error('[아임웹] 로그인/관리자 진입에 실패했습니다. (세션 만료 또는 대기 시간 초과)');
    }

    // Strict check that we're actually on the portal's my-site page, not merely on a
    // login/redirect URL that happens to contain "/mysite" as a substring (e.g. in a
    // return_url query param) — that false positive was causing the automation to think
    // an expired session was still logged in.
    isPortalHomeUrl(urlString) {
        try {
            const u = new URL(urlString);
            return u.hostname === 'imweb.me' && u.pathname.replace(/\/+$/, '') === '/mysite';
        } catch (e) {
            return false;
        }
    }

    async debugCapture(label) {
        try {
            const debugDir = _debugDir();
            if (!debugDir) return;
            await this.page.screenshot({ path: path.join(debugDir, `debug_${label}_screenshot.png`) });
        } catch (e) {}
    }

    /**
     * 아임웹 B2B몰 등록 / 본사·해외·일본몰 게시판 포스팅.
     * @returns {Promise<{summary: string, results: Array<{target: string, ok: boolean, error?: string}>}>}
     *   results 는 요청한 대상마다 한 줄. main 의 imweb-register 가 imwebRunResponse 로 success/partial 을 정한다.
     *   예전엔 요약 문자열만 돌려주고 main 이 무조건 success:true 로 감싸서 "B2B몰 등록 일부 실패",
     *   "포스팅 실패", 숨김 상태로 남은 상품까지 성공으로 보고됐다.
     */
    async executeAutomation(data) {
        let summary = [];
        const results = [];
        // 이번 실행에서 실제로 만든 것(B2B 상품번호·게시글). main 이 중복 방지 원장에 적는다.
        this.lastRegistered = [];

        const b2bTarget = type => (type === 'set' ? 'B2B 세트' : 'B2B 개별');
        const requestedB2b = [data.registerIndiv && 'indiv', data.registerSet && 'set'].filter(Boolean);
        const b2bSummary = (verb, list) => {
            const okTypes = list.filter(r => r.ok).map(r => (r.type === 'set' ? '세트' : '개별'));
            return list.some(r => !r.ok)
                ? `B2B몰 ${verb} 일부 실패 (성공: ${okTypes.join(', ') || '없음'})`
                : `B2B몰 ${verb} 성공 (${okTypes.join(', ')})`;
        };
        // 대상별 결과 → results. 결과가 비어 있는(요청했는데 아무 줄도 안 돌아온) 대상도 실패로 채운다.
        const pushB2b = (list, missingError) => {
            for (const type of requestedB2b) {
                const r = list.find(x => x.type === type);
                results.push(r
                    ? { target: b2bTarget(type), ok: !!r.ok, ...(r.ok ? {} : { error: r.error || '실패 (로그 참고)' }) }
                    : { target: b2bTarget(type), ok: false, error: missingError });
            }
        };

        try {
            // 1. B2B Mall Product Registration
            if (data.targetB2b) {
                const verb = '등록';
                // B2B몰은 아임웹 Open API 로만 한다(imweb_b2b.js — 브라우저를 쓰지 않는다). 단계가 통째로 던지면
                // (OAuth 값 · 토큰 · 카테고리 트리 등 대상 처리 전 단계) 요청한 개별/세트를 모두 그 오류로 실패
                // 처리하고 게시판 단계로 넘어간다. 대상별 오류는 *ViaApi 가 결과에 담아 돌려준다.
                try {
                    this.log('========== B2B몰 쇼핑 상품 등록 시작 (Open API) ==========');
                    const list = await this.registerB2bViaApi(data);
                    // 만들어진 상품은 성공 여부와 상관없이 원장에 적는다 — 숨김·소매가로 남았어도 상품은
                    // 있으므로 재시도가 같은 상품을 또 만들면 안 된다. (recordImweb 은 ok && no 만 적는다)
                    for (const r of list) if (r.no) this.lastRegistered.push({ kind: 'b2b', type: r.type, ok: true, no: r.no, title: r.title });
                    pushB2b(list, `${verb} 결과가 없습니다 (로그 참고)`);
                    summary.push(b2bSummary(verb, list));
                } catch (e) {
                    this.log(`⚠ B2B몰 ${verb} 중단: ${e.message}`);
                    pushB2b([], e.message);
                    summary.push(`B2B몰 ${verb} 실패`);
                }
            }

            // 2. Board posting (본사몰/해외몰/일본몰)
            const langJobs = [
                { on: data.targetHead, lang: 'ko', label: '본사몰(한국어)' },
                { on: data.targetUs,   lang: 'en', label: '해외몰(영문)' },
                { on: data.targetJp,   lang: 'jp', label: '일본몰(일문)' },
            ].filter(j => j.on);

            if (langJobs.length > 0) {
                const verb = '포스팅';
                let pending = [...langJobs];
                try {
                    await this.initBrowserSession();

                    // 언어별 글은 서로 독립이다 — 한 곳이 실패해도(서버 거부로 던져도) 나머지는 올리고
                    // 실패는 그 대상의 결과로 남긴다. 예전엔 한 곳이 던지면 이미 올린 글까지 원장에 안 적혔다.
                    for (const job of langJobs) {
                        pending = pending.filter(j => j !== job);
                        let ok = false, error = '';
                        try {
                            this.log(`========== ${job.label} 게시판 포스팅 시작 ==========`);
                            ok = await this.createBoardPostViaApi(data, job.lang);
                            if (ok) this.lastRegistered.push({ kind: 'board', lang: job.lang, ...(this._lastPost || {}) });
                            // false 는 '건너뜀'(게시판 매핑·조견표 없음 등) — 글이 안 올라갔으므로 실패다. 이유는 로그에 있다.
                            if (!ok) error = `게시글 ${verb}을 하지 못했습니다 (게시판 매핑·조견표 이미지 등 로그 참고)`;
                        } catch (e) {
                            this.log(`⚠ ${job.label} ${verb} 실패: ${e.message}`);
                            await this.debugCapture(`board_${job.lang}_error`);   // 끝에서 창을 닫기 전에 남긴다
                            error = e.message;
                        } finally {
                            this._lastPost = null;
                        }
                        results.push(ok ? { target: job.label, ok: true } : { target: job.label, ok: false, error });
                        summary.push(`${job.label} ${verb} ${ok ? '성공' : '실패'}`);
                    }
                } catch (e) {
                    // 브라우저·관리자 진입 실패 — 아직 시작 못 한 게시판을 모두 이 오류로 실패 처리한다.
                    this.log(`⚠ 게시판 ${verb} 중단: ${e.message}`);
                    for (const job of pending) {
                        results.push({ target: job.label, ok: false, error: e.message });
                        summary.push(`${job.label} ${verb} 실패`);
                    }
                } finally {
                    try { await this.close(); } catch { /* 이미 닫힘 */ }
                }
            }

            return { summary: summary.join(', '), results };

        } catch (error) {
            // Save debug visual screenshot and DOM html on failure
            try {
                const brainDir = _debugDir();
                if (!brainDir) throw new Error('no debug dir');
                const screenshotPath = path.join(brainDir, 'debug_screenshot.png');
                const htmlPath = path.join(brainDir, 'debug_dom.html');

                await this.page.screenshot({ path: screenshotPath });
                this.log(`[디버그] 에러 당시 화면 캡처 완료: ${screenshotPath}`);

                const htmlContent = await this.page.content();
                fs.writeFileSync(htmlPath, htmlContent, 'utf-8');
                this.log(`[디버그] 에러 당시 DOM HTML 저장 완료: ${htmlPath}`);
            } catch (e) {
                this.log(`[디버그] 스크린샷 및 DOM 저장 실패: ${e.message}`);
            }
            throw error;
        }
    }

    // The 조견표 field may receive either a bare URL or a full HTML snippet — the ESM
    // upload step hands back `<img src="..." />`, and that whole tag often gets pasted in.
    // Pulling the src out keeps us from URL-encoding an entire tag into another tag's src.
    extractImageUrl(input) {
        if (!input) return '';
        const s = String(input).trim();
        const m = s.match(/<img[^>]*\ssrc\s*=\s*["']([^"']+)["']/i);
        return (m ? m[1] : s).trim();
    }

    // Resolves the board name for a brand in the requested language from data/imweb_boards.json.
    boardNameFor(brand, lang) {
        try {
            const brands = JSON.parse(fs.readFileSync(BOARDS_PATH, 'utf-8')).brands || {};
            const entry = brands[brand];
            if (!entry) return null;
            return entry[lang] || null;
        } catch (e) {
            this.log(`⚠ 게시판 매핑 파일을 읽지 못했습니다: ${e.message}`);
            return null;
        }
    }

    /**
     * 게시글 제목·본문에 쓸 언어별 표기를 고른다.
     *   ko → 한글 / jp → 일문(없으면 영문 → 한글) / en → 영문(없으면 한글)
     * 일본어는 셸이 data/vehicle_i18n.json 에서 찾아 폼에 채워 준다. 사전에 없어서 비어 오면
     * 폴백하되 반드시 로그를 남긴다 — 조용히 영문이 발행되던 것이 원래 문제였다.
     *
     * 게시글 작성(createBoardPostViaApi)과 중복 검사(planImweb)가 같이 쓴다. 따로 조립하면 한쪽만 영문으로 되돌아간다.
     */
    nameForLang(data, field, lang) {
        if (lang === 'ko') return data[field];
        if (lang === 'jp') {
            if (data[field + 'Jp']) return data[field + 'Jp'];
            this.log(`⚠ ${field} 의 일본어 표기가 없어 영문/한글로 대체합니다.`);
        }
        return data[field + 'En'] || data[field];
    }

    boardAdminUrl(lang) {
        return lang === 'en' ? ENGLISH_BOARD_ADMIN : (this.loadConfig().headUrl || 'https://optic-glass.imweb.me/admin').replace(/\/+$/, '');
    }

    priceHtmlFor(data, lang) { return englishPriceHtml(data, lang); }

    /**
     * 본문 상단 배너. 기존 게시글과 문자 그대로 같은 문자열을 써야 해서 여기로 모았다.
     *   한국어 : ※ 인피니티 G25 조견표 ※
     *   일문   : ※ インフィニティ G25 適合表 ※ / 4世代 [No.612]
     *   영문   : ※ INFINITI G25 Fitment Guide ※ / 4th gen [No.612]
     * ※ 양옆의 공백과 <br> 위치는 실제 게시글에서 확인한 형식이므로 바꾸지 말 것.
     */
    bannerFor(data, nameBrand, nameModel, lang) {
        if (lang === 'ko') return `※ ${nameBrand} ${nameModel} 조견표 ※`;
        if (lang === 'jp') {
            const gen = data.generationJp || data.generation || '';
            return `※ ${nameBrand} ${nameModel} 適合表 ※<br>${gen} [No.${data.code}]`;
        }
        return `※ ${nameBrand} ${nameModel} Fitment Guide ※<br>${data.generation || ''} [No.${data.code}]`;
    }
}
