import { BasePlatform } from './base_platform.js';
import fs from 'fs';
import path from 'path';
import http from 'http';
import https from 'https';
import os from 'os';
import { fileURLToPath } from 'url';

// <project>/src/platforms/imweb.js → <project>/data/*.json
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const BOARDS_PATH = path.join(MODULE_DIR, '..', '..', 'data', 'imweb_boards.json');
const CATEGORIES_PATH = path.join(MODULE_DIR, '..', '..', 'data', 'imweb_categories.json');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// 디버그 캡처용 임시 폴더 (배포 환경에서도 안전; 실패 시 null)
function _debugDir() {
    try {
        const d = path.join(os.tmpdir(), 'antigravity-debug');
        if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
        return d;
    } catch { return null; }
}

async function downloadFile(url, destPath) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(destPath);
        const client = url.startsWith('https') ? https : http;
        client.get(url, (response) => {
            response.pipe(file);
            file.on('finish', () => {
                file.close(resolve);
            });
        }).on('error', (err) => {
            fs.unlink(destPath, () => {});
            reject(err);
        });
    });
}

export class Imweb extends BasePlatform {
    constructor(configPath, getBrowserSync) {
        super(null, null); // Browser context will be initialized per operation
        this.configPath = configPath;
        this.getBrowserSync = getBrowserSync;
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

    saveConfig(config) {
        fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2), 'utf-8');
    }

    async getSessionPath() {
        const userDataPath = path.dirname(this.configPath);
        return path.join(userDataPath, 'session_imweb_portal.json');
    }

    async login(targetUrl) {
        const sessionPath = await this.getSessionPath();
        this.sessionPath = sessionPath;
        this.browser = this.getBrowserSync();

        this.log(`[아임웹] 로그인 대기 초기화 중...`);
        await this.init(true, { width: 1920, height: 1000 });

        this.log(`[아임웹] 로그인 페이지 이동: https://imweb.me/login`);
        await this.page.goto('https://imweb.me/login');
        await this.page.waitForLoadState('domcontentloaded');

        this.log(`[아임웹] 로그인을 완료해주세요. (대기시간 120초)`);
        try {
            await this.page.waitForURL(url => this.isPortalHomeUrl(url.href), { timeout: 120000 });
            await sleep(3000);
            this.log(`[아임웹] 로그인 감지 성공! 세션을 저장합니다.`);
            await this.saveSession();
            return true;
        } catch (e) {
            if (this.isPortalHomeUrl(this.page.url())) {
                this.log(`[아임웹] 로그인 완료.`);
                await this.saveSession();
                return true;
            }
            await this.close();
            throw new Error(`로그인 대기 시간이 초과되었습니다.`);
        }
    }

    // Fresh browser context with the saved session + the popup guard + console loggers.
    // (No navigation — callers then open the admin URL they need directly.)
    async initBrowserSession() {
        const sessionPath = await this.getSessionPath();
        this.sessionPath = sessionPath;
        this.browser = this.getBrowserSync();

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
    // session has expired we land on a login page instead of `readyPath`; then we wait for
    // the user to log in manually and re-navigate, saving the refreshed session.
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

        // Still not on the admin page → login required.
        this.log('[아임웹] 로그인이 필요합니다. 열린 브라우저 창에서 로그인을 완료해 주세요... (대기 120초)');
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

    // Refreshes data/imweb_categories.json from the live B2B site. The category tree comes
    // back fully nested in ONE API response (광각미러 > 국산차/수입차 > 제조사 > 모델), which
    // the product page fires automatically — we just open that page and capture the response.
    async syncCategories() {
        this.log('[카테고리 동기화] 시작 — 관리자 로그인 및 상품 페이지 진입...');
        await this.initBrowserSession();

        const API = '/domain/product/bo/categories';
        const rootRespPromise = this.page.waitForResponse(
            res => res.url().includes(API) && res.url().includes('parentId=root'),
            { timeout: 30000 }
        ).catch(() => null);

        await this.openAdminAt('https://bbstore37.imweb.me/admin/shopping/product', '/admin/shopping/');

        this.log('[카테고리 동기화] 카테고리 API 응답 수신 대기 중...');
        const rootResp = await rootRespPromise;
        if (!rootResp) {
            await this.close();
            throw new Error('카테고리 API 응답을 받지 못했습니다. (로그인/네트워크 확인)');
        }

        const json = await rootResp.json();
        const rootCategories = json?.data?.categories || [];
        this.log(`[카테고리 동기화] 최상위 카테고리 ${rootCategories.length}개 수신, 트리 가공 중...`);

        // Category names are localized objects like { "u2021...": "국산차" }; prefer a
        // Korean-looking value and strip any trailing zero-width chars.
        const nameOf = (node) => {
            if (!node || !node.name) return '';
            const vals = Object.values(node.name);
            return (vals.find(v => /[가-힣]/.test(v)) || vals[0] || '').replace(/[​‌‍﻿]/g, '').trim();
        };
        const brandMap = (node) => {
            const out = {};
            for (const brand of (node.children || [])) {
                const bname = nameOf(brand);
                if (!bname) continue;
                out[bname] = (brand.children || []).map(m => nameOf(m)).filter(Boolean).sort();
            }
            return out;
        };

        const domestic = rootCategories.find(c => nameOf(c).replace(/\s+/g, '') === '국산차');
        const foreign = rootCategories.find(c => nameOf(c).replace(/\s+/g, '') === '수입차');
        const formatted = {
            "국산차": domestic ? brandMap(domestic) : {},
            "수입차": foreign ? brandMap(foreign) : {},
        };

        const dCount = Object.keys(formatted["국산차"]).length;
        const fCount = Object.keys(formatted["수입차"]).length;
        if (dCount === 0 && fCount === 0) {
            await this.close();
            throw new Error('국산차/수입차 카테고리를 찾지 못했습니다. (API 응답 구조 확인 필요)');
        }

        fs.writeFileSync(CATEGORIES_PATH, JSON.stringify(formatted, null, 2), 'utf-8');
        this.log(`[카테고리 동기화] ✓ 완료! 국산차 ${dCount}개 / 수입차 ${fCount}개 제조사 저장됨.`);

        await this.close();
        return formatted;
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

    // ── Helper: Get Locator dynamically from main page or admin iframe ──
    async getElement(selector) {
        await sleep(2000);
        const hasIframe = await this.page.locator('iframe#admin_iframe, iframe[name="admin_iframe"]').count() > 0;
        if (hasIframe) {
            return this.page.frameLocator('iframe#admin_iframe, iframe[name="admin_iframe"]').locator(selector).first();
        }
        return this.page.locator(selector).first();
    }

    async getElements(selector) {
        await sleep(2000);
        const hasIframe = await this.page.locator('iframe#admin_iframe, iframe[name="admin_iframe"]').count() > 0;
        if (hasIframe) {
            return await this.page.frameLocator('iframe#admin_iframe, iframe[name="admin_iframe"]').locator(selector).all();
        }
        return await this.page.locator(selector).all();
    }

    async getLocator(selector) {
        const hasIframe = await this.page.locator('iframe#admin_iframe, iframe[name="admin_iframe"]').count() > 0;
        if (hasIframe) {
            return this.page.frameLocator('iframe#admin_iframe, iframe[name="admin_iframe"]').locator(selector);
        }
        return this.page.locator(selector);
    }

    async fillInput(selector, value) {
        const el = await this.getElement(selector);
        await el.fill(value);
    }

    // Imweb's admin UI uses hashed CSS classes with no stable name/id/placeholder,
    // so form fields are located by the label text that precedes them in the DOM.
    async fillByLabel(labelText, value) {
        // Shadow DOM을 포함하여 평평하게 순회하며 라벨 바로 뒤의 input 요소를 찾아 입력하고 이벤트를 발생시킵니다.
        const ok = await this.page.evaluate(({ labelText, value }) => {
            const all = [];
            const w = (root) => {
                let n;
                try { n = root.querySelectorAll('*'); } catch (e) { return; }
                for (const el of n) {
                    all.push(el);
                    if (el.shadowRoot) w(el.shadowRoot);
                }
            };
            w(document);
            
            const labelEl = all.find(el => {
                const tag = el.tagName.toLowerCase();
                const text = (el.textContent || '').trim();
                return (tag === 'p' || tag === 'label' || tag === 'span') && text === labelText;
            });
            if (!labelEl) return false;
            
            const idx = all.indexOf(labelEl);
            if (idx === -1) return false;
            
            for (let i = idx + 1; i < all.length; i++) {
                const el = all[i];
                if (el.tagName === 'INPUT') {
                    const type = el.getAttribute('type') || 'text';
                    if (['text', 'number', 'tel'].includes(type)) {
                        el.value = value;
                        el.dispatchEvent(new Event('input', { bubbles: true }));
                        el.dispatchEvent(new Event('change', { bubbles: true }));
                        return true;
                    }
                }
            }
            return false;
        }, { labelText, value });

        if (!ok) {
            // Shadow DOM에서 요소를 찾지 못한 경우 기존 XPath로 대체(Fallback) 처리합니다.
            const el = await this.getElement(`xpath=//*[self::p or self::label or self::span][contains(text(),"${labelText}")]/following::input[@type="text" or @type="number" or @type="tel" or not(@type)][1]`);
            await el.fill(value.toString());
        }
    }

    async clickElement(selector) {
        const el = await this.getElement(selector);
        await el.click();
    }

    async debugCapture(label) {
        try {
            const debugDir = _debugDir();
            if (!debugDir) return;
            await this.page.screenshot({ path: path.join(debugDir, `debug_${label}_screenshot.png`) });
        } catch (e) {}
    }

    // page.content() 는 Shadow DOM 내부를 직렬화하지 못한다(임웹 신규 관리자는
    // web-component/clay 기반이라 상품 목록이 shadow root 안에 있음). 진단용으로
    // shadow root 까지 뚫어서 상품 행 주변 HTML 을 덤프한다.
    async deepDumpDom(label) {
        try {
            const debugDir = _debugDir();
            if (!debugDir) return;
            const html = await this.page.evaluate(() => {
                const out = [];
                const walk = (root) => {
                    let nodes; try { nodes = root.querySelectorAll('*'); } catch (e) { return; }
                    for (const el of nodes) { if (el.shadowRoot) walk(el.shadowRoot); }
                };
                walk(document);
                const anchor = (() => {
                    const all = [];
                    const w = (root) => { let n; try { n = root.querySelectorAll('*'); } catch (e) { return; } for (const el of n) { all.push(el); if (el.shadowRoot) w(el.shadowRoot); } };
                    w(document);
                    return all.find(el => el.tagName === 'A' && (el.getAttribute('href') || '').includes('/product/detail?idx='));
                })();
                if (!anchor) return '<!-- 상품 상세 링크를 찾지 못함 -->';
                // 링크에서 위로 올라가며 행 후보(가장 가까운 tr / role=row)의 outerHTML 반환
                const up = (node) => { if (node.parentElement) return node.parentElement; const rn = node.getRootNode(); return rn && rn.host ? rn.host : null; };
                let row = anchor, hops = 0;
                while (row && hops < 15) {
                    if (row.matches && (row.matches('tr') || (row.getAttribute && row.getAttribute('role') === 'row'))) break;
                    row = up(row); hops++;
                }
                const target = row || anchor.parentElement || anchor;
                return (target.outerHTML || '').slice(0, 20000);
            });
            fs.writeFileSync(path.join(debugDir, `debug_${label}_deepdom.html`), html, 'utf-8');
        } catch (e) {}
    }

    // 편집 페이지(카테고리/옵션)의 Shadow DOM 까지 뚫어 전체 구조를 직렬화한다.
    // 임웹 재배포로 해시 클래스가 바뀌면 셀렉터가 죽으므로, 실제 현재 구조를 확보해
    // 해시에 의존하지 않는 셀렉터로 고치기 위한 진단 덤프.
    async deepDumpEditPage(label) {
        try {
            const debugDir = _debugDir();
            if (!debugDir) return;
            const html = await this.page.evaluate(() => {
                const serialize = (node, depth) => {
                    if (depth > 40) return '';
                    if (node.nodeType === 3) { const t = (node.textContent || '').trim(); return t ? t : ''; }
                    if (node.nodeType !== 1) return '';
                    const tag = node.tagName.toLowerCase();
                    if (tag === 'script' || tag === 'style' || tag === 'svg' || tag === 'path') return '';
                    let attrs = '';
                    for (const a of node.attributes || []) {
                        if (a.name === 'class' && a.value.length > 120) { attrs += ` class="${a.value.slice(0, 120)}…"`; }
                        else attrs += ` ${a.name}="${a.value}"`;
                    }
                    let inner = '';
                    if (node.shadowRoot) { inner += '<!--#shadow-->'; for (const c of node.shadowRoot.childNodes) inner += serialize(c, depth + 1); }
                    for (const c of node.childNodes) inner += serialize(c, depth + 1);
                    return `<${tag}${attrs}>${inner}</${tag}>`;
                };
                return serialize(document.body, 0);
            });
            fs.writeFileSync(path.join(debugDir, `debug_${label}_editpage.html`), (html || '').slice(0, 800000), 'utf-8');
        } catch (e) {}
    }

    async executeAutomation(data) {
        let summary = [];

        try {
            // 1. B2B Mall Product Registration / Modification
            if (data.targetB2b) {
                if (data.isEditMode) {
                    if (data.bsaO !== undefined || data.bsaX !== undefined) {
                        data.hasBsa = !data.bsaX && !!data.bsaO;
                    }

                    // 새 방식: 내부 API PATCH 로 수정 (화면 클릭 없이 빠르고 견고)
                    if (typeof this.modifyB2bViaApi === 'function') {
                        const results = await this.modifyB2bViaApi(data);
                        const okTypes = results.filter(r => r.ok).map(r => r.type === 'set' ? '세트' : '개별');
                        const failed = results.filter(r => !r.ok);
                        if (failed.length) summary.push(`B2B몰 수정 일부 실패 (성공: ${okTypes.join(', ') || '없음'})`);
                        else summary.push(`B2B몰 수정 성공 (${okTypes.join(', ')})`);
                        await this.close();
                    } else {
                        // 백업: 기존 UI 클릭 방식
                        this.log('========== B2B몰 쇼핑 상품 수정 시작 (UI 방식·백업) ==========');
                        await this.initBrowserSession();
                        await this.openAdminAt('https://bbstore37.imweb.me/admin/shopping/product', '/admin/shopping/');

                        const updatedProducts = [];

                        if (data.registerIndiv) {
                            this.log(`[B2B 개별] 상품 수정 시작...`);
                            const prodId = await this.modifyProduct(data, 'indiv');
                            if (prodId) updatedProducts.push({ type: 'indiv', id: prodId });
                        }
                        if (data.registerSet) {
                            this.log(`[B2B 세트] 상품 수정 시작...`);
                            const prodId = await this.modifyProduct(data, 'set');
                            if (prodId) updatedProducts.push({ type: 'set', id: prodId });
                        }
                        for (const p of updatedProducts) {
                            if (p.id) await this.setProductOnSale(p.id);
                        }

                        summary.push(`B2B몰 수정 성공 (${updatedProducts.map(p => p.type).join(', ')})`);
                        await this.close();
                    }
                } else {
                    if (data.bsaO !== undefined || data.bsaX !== undefined) {
                        data.hasBsa = !data.bsaX && !!data.bsaO;
                    }

                    // 새 방식: Open API 로 생성 + 내부 API 로 템플릿 가격(그룹가격·조합가격) 상속.
                    // 화면 클릭이 없어 Clay 디자인 변경에 견고하다. (ImwebEdit 인스턴스에만 존재)
                    if (typeof this.registerB2bViaApi === 'function') {
                        this.log('========== B2B몰 쇼핑 상품 등록 시작 (API 방식) ==========');
                        const results = await this.registerB2bViaApi(data);
                        const okTypes = results.filter(r => r.ok).map(r => r.type === 'set' ? '세트' : '개별');
                        const failed = results.filter(r => !r.ok);
                        if (failed.length) summary.push(`B2B몰 등록 일부 실패 (성공: ${okTypes.join(', ') || '없음'})`);
                        else summary.push(`B2B몰 등록 성공 (${okTypes.join(', ')})`);
                        await this.close();
                    } else {
                        // 백업: 기존 UI 클릭 방식 (registerB2bViaApi 가 없을 때만)
                        this.log('========== B2B몰 쇼핑 상품 등록 시작 (UI 방식·백업) ==========');
                        await this.initBrowserSession();
                        await this.openAdminAt('https://bbstore37.imweb.me/admin/shopping/product', '/admin/shopping/');

                        const registeredProducts = [];
                        const linkBoth = data.registerIndiv && data.registerSet;

                        if (data.registerIndiv) {
                            const title = `옵틱글래스 ${data.titleBrand} ${data.titleModel} 미러 운전석/조수석 [${data.code}]`;
                            const price = data.hasBsa ? 115000 : 80000;
                            this.log(`[B2B 개별] 상품 등록 시작: ${title} (가격: ${price}원)`);
                            const prodId = await this.registerProduct(data, title, price, 'indiv');
                            registeredProducts.push({ type: 'indiv', id: prodId, title });
                        }
                        if (data.registerSet) {
                            const title = `옵틱글래스 ${data.titleBrand} ${data.titleModel} 미러 1셋 [${data.code}]`;
                            const price = data.hasBsa ? 220000 : 150000;
                            const relatedTo = linkBoth ? registeredProducts[0] : null;
                            this.log(`[B2B 세트] 상품 등록 시작: ${title} (가격: ${price}원)`);
                            const prodId = await this.registerProduct(data, title, price, 'set', relatedTo);
                            registeredProducts.push({ type: 'set', id: prodId, title });
                        }
                        for (const p of registeredProducts) {
                            if (p.id) await this.setProductOnSale(p.id);
                        }
                        summary.push(`B2B몰 등록 성공 (${registeredProducts.map(p => p.type).join(', ')})`);
                        await this.close();
                    }
                }
            }

            // 2. Board posting (본사몰/해외몰/일본몰)
            const langJobs = [
                { on: data.targetHead, lang: 'ko', label: '본사몰(한국어)' },
                { on: data.targetUs,   lang: 'en', label: '해외몰(영문)' },
                { on: data.targetJp,   lang: 'jp', label: '일본몰(일문)' },
            ].filter(j => j.on);

            if (langJobs.length > 0) {
                await this.initBrowserSession();
                await this.openAdminAt(
                    'https://optic-glass.imweb.me/admin/contents/post/list?page=1&page_size=20',
                    '/admin/contents/post');

                for (const job of langJobs) {
                    if (data.isEditMode) {
                        this.log(`========== ${job.label} 게시판 글 수정 시작 ==========`);
                        const ok = await this.modifyBoardContent(data, job.lang);
                        summary.push(ok ? `${job.label} 수정 성공` : `${job.label} 수정 실패`);
                    } else {
                        this.log(`========== ${job.label} 게시판 포스팅 시작 ==========`);
                        const ok = await this.postBoardContent(data, job.lang);
                        summary.push(ok ? `${job.label} 포스팅 성공` : `${job.label} 포스팅 실패`);
                    }
                }
                await this.close();
            }

            return summary.join(', ');

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

    // Copy-registration: duplicate a known template product (chosen by BSA/개별-세트),
    // then edit only what differs — title, category, price, description, options.
    async registerProduct(data, title, price, type, relatedTo = null) {
        const isSet = type === 'set';

        const templateNo = data.hasBsa
            ? (isSet ? '1290' : '1291')
            : (isSet ? '712' : '803');

        const newIdx = await this.duplicateTemplateProduct(templateNo);

        const adminBaseUrl = this.page.url().split('/admin')[0];
        this.log(`복제본 편집 페이지로 이동 (상품번호: ${newIdx})...`);
        await this.page.goto(`${adminBaseUrl}/admin/shopping/product/detail?idx=${newIdx}`);
        await this.page.waitForLoadState('domcontentloaded');
        await sleep(3000);

        // 1. Title
        this.log(`상품명 변경: ${title}`);
        await this.fillInput('input[placeholder*="상품명"]', title);

        // 2. Price
        this.log(`판매가 변경: ${price}원`);
        await this.fillByLabel('판매가', price.toString());

        // 3. Category: keep 광각미러, remove the template's other categories, add the new ones
        await this.cleanupAndAddCategory(data.nationality, data.brand, data.model);

        // 4. Representative Image (Thumbnail): replace with the user-picked local file.
        //    The 상품 정보 이미지 field is multi-image and setInputFiles APPENDS, so we first
        //    delete every existing template image (each thumbnail exposes a hover-only
        //    button.delete-button), then upload the picked file — it becomes the sole 대표 image.
        if (data.mainImagePath) {
            try {
                if (!fs.existsSync(data.mainImagePath)) {
                    this.log(`⚠ 대표 이미지 파일을 찾을 수 없습니다: ${data.mainImagePath} (템플릿 이미지 유지)`);
                } else {
                    this.log(`대표 이미지 교체 시작 (기존 이미지 삭제 후 업로드)...`);
                    // 4a. delete all existing images
                    for (let i = 0; i < 8; i++) {
                        const delBtns = await this.getLocator('button.delete-button');
                        const n = await delBtns.count();
                        if (n === 0) break;
                        await delBtns.first().click({ force: true }).catch(() => {});
                        await sleep(800);
                    }
                    // 4b. upload the picked file into the 대표이미지 input (unique: accepts bmp)
                    let fileInput = (await this.getLocator('input[type="file"][accept*="bmp"]')).first();
                    if ((await fileInput.count()) === 0) {
                        fileInput = (await this.getLocator(
                            'xpath=//*[self::p or self::label or self::span][normalize-space(text())="이미지"]/following::input[@type="file"][1]'
                        )).first();
                    }
                    if (await fileInput.count() > 0) {
                        await fileInput.setInputFiles(data.mainImagePath);
                        await sleep(2500);
                        this.log(`대표 이미지 업로드 완료.`);
                    } else {
                        this.log(`⚠ 대표 이미지 업로드 실패: 파일 입력 요소를 찾지 못했습니다. (수동으로 업로드해 주세요)`);
                    }
                }
            } catch (err) {
                this.log(`⚠ 대표 이미지 업로드 오류: ${err.message} (수동으로 업로드해 주세요)`);
            }
        } else {
            this.log(`대표 이미지가 선택되지 않아 템플릿의 기존 대표 이미지를 그대로 사용합니다.`);
        }

        // 5. Details Description (HTML replace)
        this.log(`상세설명 조견표 영역 교체...`);
        await this.injectHtmlEditor(data);

        // 6. Options (차종/연식 값 교체)
        await this.setupOptions(data, type);

        // 6b. Related product (연관상품) — if this is the last product and the other one was
        // already registered, link it here as the last task BEFORE saving, so there is no
        // save → re-enter → save-again round trip. The single 저장 below commits it too.
        if (relatedTo) {
            await this.linkRelatedProduct(relatedTo, data.titleBrand, data.titleModel, data.code);
        }

        // 7. Save
        this.log(`상품 저장 중...`);
        await this.clickElement('button:has-text("저장")');
        await sleep(3000);

        this.log(`✓ 상품 복사등록이 완료되었습니다. (상품번호: ${newIdx})`);
        return newIdx;
    }

    // Searches the product list for `templateNo`, duplicates it via the row's "⋮" menu,
    // then finds the resulting copy (named "<원본 상품명> 복제") and returns its idx.
    async duplicateTemplateProduct(templateNo) {
        const adminBaseUrl = this.page.url().split('/admin')[0];

        this.log(`템플릿 상품(${templateNo}) 검색 중...`);
        await this.page.goto(`${adminBaseUrl}/admin/shopping/product?search=${templateNo}&searchType=no`);
        await this.page.waitForLoadState('domcontentloaded');
        await sleep(3000);

        const templateLink = this.page.locator('a[href*="/product/detail?idx="]').first();
        if ((await templateLink.count()) === 0) {
            throw new Error(`템플릿 상품(${templateNo})을 찾지 못했습니다.`);
        }
        const originalTitle = (await templateLink.innerText()).trim();
        this.log(`템플릿 상품명 확인: ${originalTitle}`);
        await this.debugCapture('kebab_before');

        this.log(`상품 복제 중...`);
        // 상품 목록 행의 "⋮"(액션) 컨트롤은 [data-column-id="actions"] 셀 안의 아이콘(svg)이며
        // <button>이 아니다. 셀 가운데를 클릭하면 빈 여백을 눌러 메뉴가 안 열리므로 아이콘을 직접 클릭한다.
        const row = this.page.locator('div.product-row, tr, [role="row"]').filter({
            has: this.page.locator(`a[href*="/product/detail?idx=${templateNo}"]`)
        }).first();
        if ((await row.count()) === 0) {
            await this.deepDumpDom('kebab_fail');
            throw new Error(`상품 목록에서 ${templateNo} 행을 찾지 못했습니다.`);
        }
        const kebab = row.locator('[data-column-id="actions"] svg').first();
        // 드롭다운의 "복제" 항목(정확히 "복제", 보이는 것만). 메뉴가 열리기 전엔 매칭 0.
        const dupItem = this.page.locator(':text-is("복제"):visible').first();

        let menuOpen = false;
        for (let i = 0; i < 6; i++) {
            await kebab.scrollIntoViewIfNeeded().catch(() => {});
            await kebab.click({ timeout: 5000, force: true }).catch(() => {});
            await sleep(700);
            this.log(`[디버그] 케밥 클릭 시도 ${i + 1}회 / URL: ${this.page.url()}`);
            if (!this.page.url().includes('imweb.me')) {
                await this.debugCapture('kebab_wrong_navigation');
                throw new Error(`케밥 버튼 클릭 후 관리자 페이지를 벗어났습니다: ${this.page.url()}`);
            }
            menuOpen = (await dupItem.count()) > 0;
            if (menuOpen) break;
        }
        await this.debugCapture('kebab_after');
        if (!menuOpen) {
            await this.deepDumpDom('kebab_fail');
            throw new Error('상품 목록의 "⋮" 메뉴를 열지 못했습니다.');
        }
        // 드롭다운의 "복제" 클릭 → 확인 모달("상품 복제", 구매평/문의 포함 체크박스)이 뜬다.
        await dupItem.click();
        await sleep(1000);
        await this.debugCapture('duplicate_confirm_dialog');

        const confirmBtn = this.page.locator('button:text-is("복제")').last();
        if ((await confirmBtn.count()) > 0) {
            await confirmBtn.click();
            this.log('복제 확인 대화상자에서 "복제" 버튼 클릭 완료.');
        } else {
            this.log('⚠ 복제 확인 대화상자를 찾지 못했습니다 (이미 진행됐을 수 있음).');
        }
        await sleep(2500);
        this.log(`[디버그] "복제" 클릭 후 URL: ${this.page.url()}`);
        await this.debugCapture('after_duplicate_click');
        if (!this.page.url().includes('imweb.me')) {
            throw new Error(`"복제" 클릭 후 관리자 페이지를 벗어났습니다: ${this.page.url()}`);
        }
        this.log(`✓ 상품 복제 완료.`);

        const dupTitle = `${originalTitle} 복제`;

        // Prefer the unfiltered list (sorted newest-first) over a name search — search
        // indexing can lag a few seconds right after a product is created, which was
        // returning zero results even though the duplicate already existed.
        let newIdx = null;
        for (let attempt = 0; attempt < 5 && !newIdx; attempt++) {
            await this.page.goto(`${adminBaseUrl}/admin/shopping/product`);
            await this.page.waitForLoadState('domcontentloaded');
            await sleep(2000);

            const firstLink = this.page.locator('a[href*="/product/detail?idx="]').first();
            if ((await firstLink.count()) > 0 && (await firstLink.innerText()).trim() === dupTitle) {
                const href = await firstLink.getAttribute('href');
                const idxMatch = href && href.match(/idx=(\d+)/);
                if (idxMatch) newIdx = idxMatch[1];
            }
            if (!newIdx) {
                this.log(`복제본을 아직 찾지 못했습니다 (시도 ${attempt + 1}/5). 잠시 후 다시 확인합니다...`);
                await sleep(1500);
            }
        }

        if (!newIdx) {
            // Fallback: name search, in case the "newest first" list-order assumption doesn't hold.
            await this.page.goto(`${adminBaseUrl}/admin/shopping/product?search=${encodeURIComponent(dupTitle)}&searchType=name`);
            await this.page.waitForLoadState('domcontentloaded');
            await sleep(2000);
            const dupLink = this.page.locator(`a[href*="/product/detail?idx="]:has-text("${dupTitle}")`).first();
            if ((await dupLink.count()) > 0) {
                const href = await dupLink.getAttribute('href');
                const idxMatch = href && href.match(/idx=(\d+)/);
                if (idxMatch) newIdx = idxMatch[1];
            }
        }

        if (!newIdx) {
            await this.debugCapture('duplicate_not_found');
            throw new Error('복제된 상품을 찾지 못했습니다.');
        }
        this.log(`복제본 상품번호: ${newIdx}`);
        return newIdx;
    }

    // Removes every existing category chip except "광각미러", then adds the newly
    // selected nationality (국산차/수입차), brand, and model via the checkbox-tree picker.
    async cleanupAndAddCategory(nationality, brand, model) {
        this.log(`카테고리 정리 중 (광각미러 유지, 나머지 삭제 후 ${model} 추가)...`);

        try {
            const debugDir = _debugDir();
            if (debugDir) {
                await this.page.screenshot({ path: path.join(debugDir, 'debug_category_edit_screenshot.png') });
                fs.writeFileSync(path.join(debugDir, 'debug_category_edit_dom.html'), await this.page.content(), 'utf-8');
            }
        } catch (e) {}
        // Shadow DOM 까지 뚫은 진단 덤프(해시 클래스 변경 대응용)
        await this.deepDumpEditPage('category');

        // 1. Remove every chip except 광각미러 (chips are always visible in the 카테고리 field).
        for (let i = 0; i < 15; i++) {
            const removed = await this.removeNonEssentialCategoryChip();
            if (!removed) break;
            await sleep(400);
        }

        // 2. Open the category picker and check the target model.
        if (model) {
            await this.openCategoryPicker();
            await this.checkCategoryNode(model);
            await sleep(500);
            await this.page.keyboard.press('Escape').catch(() => {});
            await sleep(500);
        }
    }

    // Opens the 카테고리 select dialog. 새 Clay UI: 트리거 = 칩(action-tag)을 품은 유일한
    // button.select_selectTrigger. 버튼 중앙은 칩(=클릭 시 삭제)이라 오른쪽 chevron 을 눌러야
    // 열린다. 카테고리 필드는 Shadow DOM 안 → CSS 로만 접근(XPath 불가). 열렸는지(aria-expanded)
    // 확인하고, 안 열렸으면 포커스 후 Enter/ArrowDown 으로 재시도한다.
    async openCategoryPicker() {
        const trigger = this.page.locator(
            'button[class*="selectTrigger"]:has([class*="actionTagLabel"])'
        ).first();
        if ((await trigger.count()) === 0) {
            this.log('⚠ 카테고리 필드 트리거(칩 가진 selectTrigger)를 찾지 못했습니다.');
            return false;
        }
        const chevron = trigger.locator('[class*="selectChevron"]').first();
        if (await chevron.count()) {
            await chevron.click().catch(() => {});
        } else {
            await trigger.click({ position: { x: 8, y: 8 } }).catch(() => {});
        }
        await sleep(1200);
        let expanded = await trigger.getAttribute('aria-expanded').catch(() => null);
        if (expanded !== 'true') {
            await trigger.focus().catch(() => {});
            await this.page.keyboard.press('Enter').catch(() => {});
            await sleep(700);
            await this.page.keyboard.press('ArrowDown').catch(() => {});
            await sleep(700);
            expanded = await trigger.getAttribute('aria-expanded').catch(() => null);
        }
        await sleep(800);
        return expanded === 'true';
    }

    // Removes ONE non-essential category chip (keeps 광각미러). Returns true if it removed
    // one (caller loops until false). 새 Clay UI: 카테고리 필드의 각 칩 =
    // <span role="button" aria-label="삭제" class="action-tag_actionTag__…"> 안에
    // <span class="action-tag_actionTagLabel__…">{name}</span>. 칩 자체를 클릭하면 삭제된다
    // (별도 X 아이콘이 아니라 칩 전체가 삭제 버튼). 칩 텍스트에 zero-width 문자가 붙을 수 있어
    // 비교 전에 제거한다.
    async removeNonEssentialCategoryChip() {
        const chips = this.page.locator('span[role="button"][aria-label="삭제"]:has([class*="actionTagLabel"])');
        const n = await chips.count();
        for (let i = 0; i < n; i++) {
            const chip = chips.nth(i);
            const raw = await chip.locator('[class*="actionTagLabel"]').first().innerText().catch(() => '');
            // Strip zero-width chars (ZWSP U+200B, ZWNJ, ZWJ, BOM) before comparing.
            const text = raw.replace(/[​‌‍﻿]/g, '').trim();
            if (text && text !== '광각미러') {
                await chip.click().catch(() => {});
                return true;
            }
        }
        return false;
    }

    // Checks the category-tree row whose name exactly matches `text`.
    //
    // 새 Clay UI 카테고리 트리는 Shadow DOM 안에 있고 가상 스크롤일 수 있어, 해시 클래스에
    // 의존하지 않고 shadowRoot 를 재귀적으로 뚫어 처리한다. 행 후보 = 체크박스/role=option/
    // treeitem 를 품고 이름 텍스트가 붙은 요소. 스크롤 컨테이너를 자동 탐지해 한 스텝씩 내리며
    // target 행을 찾으면 클릭한다. Row names carry trailing zero-width chars → strip before match.
    async checkCategoryNode(text, optional = false) {
        const target = text.replace(/[​‌‍﻿]/g, '').trim();

        // 새 Clay UI 카테고리 트리는 Shadow DOM 안 + (가상 스크롤일 수 있음)이라,
        // 열린 트리 구조를 한 번 덤프해 두고(다음 정교화용), 아래 검색은 shadowRoot 를 모두
        // 뚫어 처리한다. 행 후보 = 체크박스/role=option/treeitem 를 품고 이름 텍스트가 있는 요소.
        try {
            if (!Imweb._catTreeDumped) {
                await this.deepDumpEditPage('category_picker_open');
                this.log('[진단] 카테고리 트리(열림) DOM 저장 완료 (category_picker_open).');
                Imweb._catTreeDumped = true;
            }
        } catch (e) {}

        // 한 스텝: 열린 트리에서 target 행을 찾으면 클릭하고, 없으면 스크롤 컨테이너를 dy 만큼
        // 내린다. shadowRoot 를 재귀적으로 뚫는다. 반환: clicked | already | scrolled | notfound.
        const step = async (dy) => this.page.evaluate((args) => {
            const [tgt, dy] = args;
            const strip = s => (s || '').replace(/[​‌‍﻿]/g, '').trim();
            // 모든 요소(shadow 포함) 수집
            const all = [];
            const walk = (root) => {
                let nodes; try { nodes = root.querySelectorAll('*'); } catch (e) { return; }
                for (const el of nodes) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot); }
            };
            walk(document);

            // 행 후보: 체크박스/option/treeitem 를 가진 가장 가까운 컨테이너
            const rowOf = (el) => {
                let n = el, hops = 0;
                while (n && hops < 4) {
                    const t = strip(n.textContent);
                    if (t && t.length < 60) return n;
                    n = n.parentElement; hops++;
                }
                return el.parentElement || el;
            };
            const checkables = all.filter(el =>
                (el.matches && (el.matches('input[type="checkbox"]') ||
                                el.getAttribute('role') === 'option' ||
                                el.getAttribute('role') === 'treeitem')));

            for (const c of checkables) {
                const row = c.getAttribute && (c.getAttribute('role') === 'option' || c.getAttribute('role') === 'treeitem') ? c : rowOf(c);
                if (strip(row.textContent) === tgt || strip(c.textContent) === tgt) {
                    const cb = c.matches && c.matches('input[type="checkbox"]') ? c : (row.querySelector && row.querySelector('input[type="checkbox"]'));
                    const selected = (cb && cb.checked) || row.getAttribute('aria-selected') === 'true';
                    if (selected) return { status: 'already' };
                    const clickTarget = (row.querySelector && row.querySelector('label')) || row;
                    try { clickTarget.click(); } catch (e) { try { c.click(); } catch (e2) {} }
                    return { status: 'clicked' };
                }
            }

            // target 을 못 찾음 → 스크롤 컨테이너를 찾아 dy 만큼 내린다.
            let sc = null, best = 0;
            for (const el of all) {
                let oy = ''; try { oy = getComputedStyle(el).overflowY; } catch (e) {}
                if (/(auto|scroll)/.test(oy) && el.scrollHeight - el.clientHeight > 50) {
                    // 카테고리 행을 실제로 담은 스크롤러 우선
                    const hasRows = el.querySelector && el.querySelector('input[type="checkbox"], [role="option"], [role="treeitem"]');
                    const score = (hasRows ? 1e6 : 0) + (el.scrollHeight - el.clientHeight);
                    if (score > best) { best = score; sc = el; }
                }
            }
            if (sc) {
                const before = sc.scrollTop;
                sc.scrollTop = Math.min(before + dy, sc.scrollHeight);
                return { status: 'scrolled', atBottom: sc.scrollTop <= before + 1, hasScroller: true };
            }
            return { status: 'notfound', hasScroller: false };
        }, [target, dy]);

        // 처음엔 스크롤을 맨 위로 올린 뒤, 아래로 훑으며 검색한다.
        for (let i = 0; i < 60; i++) {
            const r = await step(i === 0 ? -100000 : 220);
            if (r.status === 'already') { this.log(`카테고리 "${target}" 는 이미 선택되어 있습니다.`); return; }
            if (r.status === 'clicked') { await sleep(400); this.log(`✓ 카테고리 "${target}" 선택 완료.`); return; }
            if (r.status === 'notfound' && i > 1) {
                this.log(`⚠ 카테고리 목록 스크롤 영역을 찾지 못했습니다.`);
                break;
            }
            if (r.status === 'scrolled' && r.atBottom && i > 0) break;  // 바닥 도달
            await sleep(120);
        }

        if (optional) {
            this.log(`카테고리 트리에 "${target}" 항목이 없어 건너뜁니다.`);
        } else {
            this.log(`⚠ 카테고리 항목("${target}")을 스크롤 탐색했지만 찾지 못했습니다.`);
        }
    }

    async selectDropdownOption(locator, text) {
        await locator.waitFor({ state: 'visible' });
        await locator.evaluate((el, txt) => {
            const opt = Array.from(el.options).find(o => o.text.trim().includes(txt));
            if (opt) {
                el.value = opt.value;
                el.dispatchEvent(new Event('change'));
            }
        }, text);
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

    generateDescriptionHtml(data) {
        const specUrl = this.extractImageUrl(data.specImageUrl);
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

    async injectHtmlEditor(data) {
        try {
            // Switch to the "에디터로 등록" tab (vs "이미지로 등록") for the 상품 상세 설명 section.
            const editorTab = await this.getElements('text=에디터로 등록');
            if (editorTab.length > 0) {
                await editorTab[editorTab.length - 1].click();
                await sleep(800);
            }

            try {
                const debugDir = _debugDir();
                if (debugDir) {
                    await this.page.screenshot({ path: path.join(debugDir, 'debug_description_screenshot.png') });
                    fs.writeFileSync(path.join(debugDir, 'debug_description_dom.html'), await this.page.content(), 'utf-8');
                }
            } catch (e) {}

            // Read/write the description through Froala's own API rather than the "</>"
            // code view. The code view here is backed by CodeMirror — its <textarea.fr-code>
            // stays empty, so reading it returned "" and writing it did nothing (this was the
            // real reason 상세설명 never updated). window.FroalaEditor.INSTANCES exposes both
            // editors on the page; 상품 상세 설명 is the one holding content (요약 설명 is empty).
            // Normalise the 조견표 field first: it may hold a bare URL or a whole
            // `<img src="..." />` snippet pasted from the ESM upload step.
            const specUrl = this.extractImageUrl(data.specImageUrl);
            if (!specUrl) {
                this.log('⚠ 조견표 이미지 URL이 비어 있어 상세설명 교체를 건너뜁니다.');
                return;
            }
            this.log(`조견표 이미지 URL: ${specUrl}`);

            const result = await this.page.evaluate(({ data, specUrl }) => {
                const insts = (window.FroalaEditor && window.FroalaEditor.INSTANCES) || [];
                if (!insts.length) return { ok: false, reason: 'NO_INSTANCE' };

                let inst = null, best = -1;
                for (const i of insts) {
                    try { const l = i.html.get().length; if (l > best) { best = l; inst = i; } } catch (e) {}
                }
                if (!inst) return { ok: false, reason: 'NO_USABLE_INSTANCE' };

                const html = inst.html.get();
                const SPEC_START = '<!--2. 조견표 영역-->';
                const SPEC_END = '<!--3. 상세페이지 영역-->';
                const newBlock =
                    `${SPEC_START}<p><br></p>` +
                    `<p style="text-align: center;"><span style="font-size: 36px;">` +
                    `<strong>※${data.titleBrand} ${data.titleModel} 조견표※</strong></span></p>` +
                    `<p><img src="${specUrl}" class="fr-fic fr-dib"></p>`;

                let out = null, mode = null;
                const s = html.indexOf(SPEC_START);
                const e = html.indexOf(SPEC_END);

                if (s !== -1 && e !== -1 && e > s) {
                    // Preferred: swap the whole 조견표 section between the template's own
                    // section comments. Handles templates that carry several 조견표 images
                    // (e.g. a product covering two codes) — they collapse to the new one.
                    out = html.slice(0, s) + newBlock + html.slice(e);
                    mode = 'SECTION';
                } else {
                    // Fallback: no section comments — retitle and swap the first image
                    // that follows the "조견표※" heading.
                    const anchor = html.indexOf('조견표※');
                    if (anchor === -1) return { ok: false, reason: 'NO_ANCHOR' };
                    out = html.replace(/※[\s\S]*?조견표※/, `※${data.titleBrand} ${data.titleModel} 조견표※`);
                    const idx = out.indexOf('조견표※');
                    out = out.slice(0, idx) +
                          out.slice(idx).replace(/(<img[^>]*\bsrc=")[^"]*(")/, `$1${specUrl}$2`);
                    mode = 'ANCHOR';
                }

                inst.html.set(out);
                try { inst.events.trigger('contentChanged'); } catch (e) {}

                const after = inst.html.get();
                return {
                    ok: true, mode,
                    hasNewUrl: after.includes(specUrl),
                    hasNewTitle: after.includes(`${data.titleBrand} ${data.titleModel} 조견표`),
                };
            }, { data, specUrl });

            if (!result.ok) {
                this.log(`⚠ 상세설명 조견표 교체 실패 (${result.reason}). 수동으로 확인해주세요.`);
                return;
            }
            this.log(`✓ 상세설명 조견표 교체 완료 (방식: ${result.mode}, 이미지 적용: ${result.hasNewUrl}, 제목 적용: ${result.hasNewTitle}).`);
        } catch (e) {
            this.log(`⚠ 상세설명 주입 오류: ${e.message} (수동으로 붙여넣기 해주세요)`);
        }
    }

    // Edits the template's EXISTING "차종"/"연식" option rows in place (does NOT delete
    // and recreate them). Deleting would wipe the per-combination 옵션 가격 (e.g. BSA O
    // = +price) that the template already has configured. The real UI (verified against
    // idx=1193) exposes each option row with a pencil (edit) button; clicking it opens an
    // inline form whose value input is a stable input[name="option-choices"].
    // 세트(1셋) 상품은 옵션이 2개(차종/연식), 개별(운전석/조수석) 상품은 여기에 구성(운전석만/
    // 조수석만)이 더해져 3개입니다. 템플릿(1291/803)에 이미 구성 옵션이 있으므로 값만 교체합니다.
    async setupOptions(data, type) {
        try {
            const isSet = type === 'set';
            this.log(`옵션 값 편집 시작 (${isSet ? '세트: 차종/연식' : '개별: 차종/연식/구성'})...`);
            await this.deepDumpEditPage('options');  // 진단: 옵션 영역 실제 구조(해시 변경 대응)

            // 연식 values: a "BSA X" product also sells BSA as an upgrade, so it carries
            // BOTH marks (matching templates 712/803). A pure "BSA O" product carries one.
            let marks;
            if (data.bsaO !== undefined || data.bsaX !== undefined) {
                marks = data.bsaX ? ['BSA X', 'BSA O'] : ['BSA O'];
            } else {
                marks = data.hasBsa ? ['BSA O'] : ['BSA X', 'BSA O']; // legacy callers
            }

            const yearValues = marks.map(m => `${data.year} [No.${data.code}] ${m}`);

            // Re-applying option values regenerates the 필수 옵션 목록 and wipes its per-row
            // 옵션 가격. Capture the copied template's prices first, then restore them after
            // — the template already holds the correct figures, so nothing is hard-coded.
            const priceMap = await this.captureOptionPrices();
            this.log(`기존 옵션 가격 ${Object.keys(priceMap).length}건 확보: ${JSON.stringify(priceMap)}`);

            // Target rows by POSITION, not by name. Templates aren't consistent about the
            // first option's label ("차종" vs "차량" vs …), which caused it to be skipped.
            // The order is fixed across the templates we copy from:
            //   1) 차종/차량  2) 연식  3) 구성 (개별 상품에만 존재)
            // 새 Clay UI: 각 옵션 행 = div[data-testid="applied-option-card"] (차종/연식[/구성]).
            const rowCount = await this.page.locator('[data-testid="applied-option-card"]').count();
            const expected = isSet ? 2 : 3;
            if (rowCount !== expected) {
                this.log(`⚠ 옵션 개수가 예상과 다릅니다 (발견 ${rowCount}개 / 예상 ${expected}개). 순서대로 진행합니다.`);
            }

            // 차종 값은 카테고리에서 고른 모델명(data.model)이 아니라 제목용 차종명
            // (data.titleModel)을 사용한다. titleModel이 비어 있으면 model로 폴백.
            await this.editOptionRowAt(0, [data.titleModel || data.model], '차종');
            await this.editOptionRowAt(1, yearValues, '연식');
            if (!isSet) {
                await this.editOptionRowAt(2, ['운전석만', '조수석만'], '구성');
            }

            await this.applyOptionPrices(priceMap);

            this.log(`✓ 옵션 값 편집 완료.`);
        } catch (e) {
            this.log(`⚠ 옵션 설정 실패: ${e.message}`);
        }
    }

    // The 필수 옵션 목록 is a CSS grid with no per-row wrapper, so a row's price input is
    // located as "the first input[placeholder='0'] following that row's 옵션값 cell in
    // document order". Rows are keyed by "<BSA 표기>|<구성>" (구성 is empty for 세트).
    async readOptionPriceRows() {
        return await this.page.evaluate(() => {
            // 필수 옵션 목록 표는 Shadow DOM 안이라 document.querySelector 로는 못 찾는다.
            // shadowRoot 를 뚫어 [data-testid="option-tables-wrap"] 를 찾는다.
            let wrap = null;
            const findWrap = (root) => {
                let hit; try { hit = root.querySelector('[data-testid="option-tables-wrap"]'); } catch (e) { hit = null; }
                if (hit) { wrap = hit; return true; }
                let nodes; try { nodes = root.querySelectorAll('*'); } catch (e) { return false; }
                for (const el of nodes) { if (el.shadowRoot && findWrap(el.shadowRoot)) return true; }
                return false;
            };
            findWrap(document);
            if (!wrap) return [];

            // wrap 하위를 문서 순서로 평탄화하고, 각 BSA 조합 셀 뒤에 처음 나오는
            // input[placeholder="0"](= 그 행의 옵션가격 칸)을 짝지어 값을 읽는다. (XPath 미사용)
            const flat = Array.from(wrap.querySelectorAll('*'));
            const rows = [];
            flat.forEach((el, idx) => {
                if (el.children.length > 0) return;             // leaf nodes only
                const t = (el.textContent || '').trim();
                if (!(t.includes('BSA') && t.length < 200)) return;
                let priceEl = null;
                for (let j = idx + 1; j < flat.length; j++) {
                    if (flat[j].matches && flat[j].matches('input[placeholder="0"]')) { priceEl = flat[j]; break; }
                }
                const bsa = t.includes('BSA O') ? 'BSA O' : (t.includes('BSA X') ? 'BSA X' : '');
                const seat = t.includes('운전석만') ? '운전석만'
                           : (t.includes('조수석만') ? '조수석만' : '');
                rows.push({ i: rows.length, text: t, key: `${bsa}|${seat}`, price: priceEl ? priceEl.value : '' });
            });
            return rows;
        });
    }

    // Snapshot the copied template's per-combination 옵션 가격 before options are re-applied.
    async captureOptionPrices() {
        const rows = await this.readOptionPriceRows();
        const map = {};
        for (const r of rows) {
            if (r.key !== '|' && r.price) map[r.key] = r.price;
        }
        return map;
    }

    // Restore the captured prices onto the regenerated rows, matching by BSA/구성 key.
    // Filling one cell re-renders the grid, which can silently drop a neighbouring write,
    // so this re-reads and retries until every row matches (or we run out of passes).
    async applyOptionPrices(priceMap) {
        if (!priceMap || Object.keys(priceMap).length === 0) {
            this.log('저장된 옵션 가격이 없어 가격 복원을 건너뜁니다.');
            return;
        }

        const digits = (v) => String(v || '').replace(/[^\d]/g, '');

        // Each write re-renders the grid and can drop a neighbouring one — measured on a
        // 4-row product it took 4 passes (4→2→1→1) to settle, so allow generous headroom.
        for (let pass = 1; pass <= 8; pass++) {
            const rows = await this.readOptionPriceRows();
            if (rows.length === 0) {
                this.log('⚠ 필수 옵션 목록을 찾지 못해 옵션 가격을 설정하지 못했습니다.');
                return;
            }

            const unmatched = rows.filter(r => !priceMap[r.key]);
            const todo = rows.filter(r => priceMap[r.key] && digits(r.price) !== digits(priceMap[r.key]));

            if (todo.length === 0) {
                for (const r of unmatched) {
                    this.log(`⚠ "${r.text}" 에 해당하는 기존 가격이 없어 건너뜀 (수동 확인 필요).`);
                }
                this.log('✓ 옵션 가격 복원 완료.');
                return;
            }

            for (const row of todo) {
                const wanted = priceMap[row.key];
                const handle = await this.page.evaluateHandle((i) => {
                    // Shadow DOM 을 뚫어 표를 찾고, i번째 BSA 셀 뒤의 첫 가격 input 을 반환.
                    let wrap = null;
                    const findWrap = (root) => {
                        let hit; try { hit = root.querySelector('[data-testid="option-tables-wrap"]'); } catch (e) { hit = null; }
                        if (hit) { wrap = hit; return true; }
                        let nodes; try { nodes = root.querySelectorAll('*'); } catch (e) { return false; }
                        for (const el of nodes) { if (el.shadowRoot && findWrap(el.shadowRoot)) return true; }
                        return false;
                    };
                    findWrap(document);
                    if (!wrap) return null;
                    const flat = Array.from(wrap.querySelectorAll('*'));
                    const cellIdx = [];
                    flat.forEach((el, idx) => {
                        if (el.children.length > 0) return;
                        const t = (el.textContent || '').trim();
                        if (t.includes('BSA') && t.length < 200) cellIdx.push(idx);
                    });
                    if (cellIdx[i] === undefined) return null;
                    for (let j = cellIdx[i] + 1; j < flat.length; j++) {
                        if (flat[j].matches && flat[j].matches('input[placeholder="0"]')) return flat[j];
                    }
                    return null;
                }, row.i);

                const el = handle.asElement && handle.asElement();
                if (!el) continue;
                await el.fill(digits(wanted)).catch(() => {});
                await sleep(350);
                if (pass === 1) this.log(`옵션 가격 설정: ${row.text} → ${wanted}`);
            }
        }

        const after = await this.readOptionPriceRows();
        const mismatches = after.filter(r => priceMap[r.key] &&
            digits(r.price) !== digits(priceMap[r.key]));
        if (mismatches.length > 0) {
            this.log(`⚠ 옵션 가격 ${mismatches.length}건이 예상과 다릅니다 (저장 전 확인 필요): ` +
                mismatches.map(m => `${m.text}=${m.price}`).join(', '));
        } else {
            this.log('✓ 옵션 가격 복원 완료.');
        }
    }

    // Opens the Nth option row's inline editor (0-based), removes its existing value tags,
    // types the new value(s), then applies. Rows are addressed by position because option
    // NAMES vary between templates ("차종" vs "차량" …) — `expectedLabel` is only for logs.
    async editOptionRowAt(index, newValues, expectedLabel) {
        // Close any editor left open by the previous row first — while one is open the row
        // list is re-rendered, so indexes would point at the wrong card.
        if ((await this.page.locator('input[name="option-choices"]').count()) > 0) {
            const preCancel = this.page.locator('button:text-is("취소")').last();
            if ((await preCancel.count()) > 0) {
                await preCancel.click({ timeout: 3000 }).catch(() => {});
                await sleep(800);
            }
        }

        // 새 Clay UI: 각 옵션 행 = div[data-testid="applied-option-card"] (차종/연식[/구성]),
        // 순서 고정. 카드 안 이름은 span[data-variant-xsmall="body-medium-bold"] ("차종(필수)").
        const rows = this.page.locator('[data-testid="applied-option-card"]');
        if ((await rows.count()) <= index) {
            this.log(`옵션 ${index + 1}번째(${expectedLabel}) 항목이 없어 건너뜁니다.`);
            return;
        }
        const row = rows.nth(index);

        // Log whatever the template actually calls this option, so a mismatch is visible.
        const actualName = (await row.locator('[data-variant-xsmall="body-medium-bold"]').first()
            .innerText().catch(() => '')).trim() || '(이름 확인 실패)';
        this.log(`옵션 ${index + 1}번째 "${actualName}" (예상: ${expectedLabel}) → "${newValues.join(', ')}" 로 변경 중...`);

        await row.scrollIntoViewIfNeeded().catch(() => {});

        // 수정(연필) 버튼 = 카드 안 button[aria-label="옵션 수정"].
        const pencil = row.locator('button[aria-label="옵션 수정"]').first();
        await pencil.click();
        await sleep(2000);

        // Confirm the editor actually opened before typing into it.
        if ((await this.page.locator('input[name="option-choices"]').count()) === 0) {
            this.log(`⚠ 옵션 "${actualName}" 편집창이 열리지 않았습니다.`);
            return;
        }

        // Remove every existing value tag BEFORE typing new ones (기존값 삭제 → 새값 삽입).
        // 새 UI의 옵션값 태그 = 편집 폼 안의 button[class*="actionTag"] 로, 유일하게 정렬용
        // 드래그 핸들([aria-roledescription="sortable"])을 품는다(카테고리 칩/카드 표시태그와 구분).
        // 태그의 삭제 X 는 hover 해야 나타나는 svg 다(연필=수정 아이콘 옆의 마지막 svg). 그래서
        // 반드시 태그를 hover 한 뒤 마지막 svg(X)를 클릭한다. 안 지워지면 입력칸 Backspace 폴백.
        const tagsLoc = () => this.page.locator('button[class*="actionTag"]:has([aria-roledescription="sortable"])');
        const valueInput = this.page.locator('input[name="option-choices"]').first();

        // [진단] 태그의 실제 구조(svg 포함 원본 HTML)를 1회만 저장 — X 셀렉터 정밀화용.
        try {
            if (!Imweb._optTagDumped && (await tagsLoc().count()) > 0) {
                const raw = await tagsLoc().first().evaluate(el => el.outerHTML).catch(() => '');
                const dbg = _debugDir();
                if (dbg && raw) {
                    fs.writeFileSync(path.join(dbg, 'debug_option_value_tag.html'), raw, 'utf-8');
                    this.log('[진단] 옵션 값 태그 원본 HTML 저장 (debug_option_value_tag.html).');
                }
                Imweb._optTagDumped = true;
            }
        } catch (e) {}

        let stuck = 0;
        for (let i = 0; i < 25; i++) {
            const before = await tagsLoc().count();
            if (before === 0) break;
            const firstTag = tagsLoc().first();
            // hover 로 X 를 드러낸 뒤, 태그 안 마지막 svg(=X) 를 클릭.
            await firstTag.hover().catch(() => {});
            await sleep(200);
            let clicked = false;
            const svgs = firstTag.locator('svg');
            const ns = await svgs.count().catch(() => 0);
            if (ns > 0) {
                await svgs.nth(ns - 1).click({ force: true }).catch(() => {});
                clicked = true;
            }
            if (!clicked) {
                await firstTag.locator('> div').last().click({ force: true }).catch(() => {});
            }
            await sleep(350);
            let now = await tagsLoc().count();
            if (now >= before) {
                // 폴백: 입력칸 포커스 후 Backspace 로 마지막 태그 삭제
                await valueInput.click().catch(() => {});
                await valueInput.press('Backspace').catch(() => {});
                await sleep(350);
                now = await tagsLoc().count();
            }
            if (now >= before) {
                if (++stuck >= 3) {
                    this.log(`⚠ 옵션 "${actualName}" 기존값 삭제가 진행되지 않아 중단합니다 (남은 태그 ${now}개).`);
                    break;
                }
            } else {
                stuck = 0;
            }
        }
        const remain = await tagsLoc().count();
        if (remain > 0) {
            this.log(`⚠ 옵션 "${actualName}" 기존 태그 ${remain}개가 남아 새 값과 섞일 수 있습니다.`);
        }

        // Type the new value(s); each Enter commits one tag.
        for (const v of newValues) {
            await valueInput.click();
            await valueInput.fill(v);
            await valueInput.press('Enter');
            await sleep(500);
        }

        // Apply: values are only committed once "옵션 목록에 적용" is pressed — typing the
        // tags alone leaves the row unchanged. That click then raises a confirm dialog
        // ("옵션값을 수정하시겠어요?") whose "변경" button must also be pressed. Finally we
        // confirm the inline edit form closed (its option-choices input disappears).
        for (let attempt = 1; attempt <= 3; attempt++) {
            const applyBtn = this.page.locator('button:has-text("옵션 목록에 적용")').last();
            if ((await applyBtn.count()) === 0) {
                this.log(`⚠ "옵션 목록에 적용" 버튼을 찾지 못했습니다 (${actualName}).`);
                break;
            }
            await applyBtn.scrollIntoViewIfNeeded().catch(() => {});
            await applyBtn.click({ timeout: 5000 }).catch(() => {});
            await sleep(1200);

            // Confirm dialog: "옵션값을 수정하시겠어요?" → 닫기 / 변경. Press 변경.
            const confirmBtn = this.page.locator('button:text-is("변경")').last();
            if ((await confirmBtn.count()) > 0) {
                await confirmBtn.click({ timeout: 5000 }).catch(() => {});
                this.log(`옵션 "${actualName}" 수정 확인창에서 "변경" 클릭.`);
                await sleep(1200);
            }

            const stillOpen = await this.page.locator('input[name="option-choices"]').count();
            if (stillOpen === 0) {
                this.log(`✓ 옵션 "${actualName}" 적용 완료.`);
                return;
            }
            this.log(`"옵션 목록에 적용" 재시도 ${attempt}/3 (${actualName})...`);
        }

        if ((await this.page.locator('input[name="option-choices"]').count()) > 0) {
            this.log(`⚠ 옵션 "${actualName}" 적용이 확인되지 않았습니다. 저장 전 수동 확인이 필요할 수 있습니다.`);
        }
    }

    async clickIfExists(selector) {
        const el = await this.getElements(selector);
        if (el.length === 0) return false;
        await el[0].click();
        return true;
    }

    // Copies default to 숨김 (hidden). Flip a product to 판매중 on the product LIST page, via
    // the 상태 column dropdown: click the status cell → pick "판매중" → confirm "변경".
    async setProductOnSale(idx) {
        try {
            const base = this.page.url().split('/admin')[0];
            await this.page.goto(`${base}/admin/shopping/product?search=${idx}&searchType=no`);
            await this.page.waitForLoadState('domcontentloaded');
            await sleep(3000);

            const cell = this.page.locator('.product-row [data-column-id="status"]').first();
            if ((await cell.count()) === 0) {
                this.log(`⚠ [판매중 전환] 상품 ${idx} 행을 찾지 못했습니다.`);
                return false;
            }
            const before = (await cell.innerText()).trim();
            if (before.includes('판매중')) {
                this.log(`[판매중 전환] 상품 ${idx}은 이미 판매중입니다.`);
                return true;
            }

            await cell.scrollIntoViewIfNeeded().catch(() => {});
            await cell.click();
            await sleep(1000);

            // pick the "판매중" option in the opened dropdown. 새 Clay UI: 상태 셀 클릭 시
            // ul[role="listbox"] > li[role="option"] (판매중/품절/숨김) 가 열린다. shadowRoot 를
            // 뚫어 텍스트가 "판매중"인 option 을 클릭한다(옛 kkqblk 클래스는 없어짐).
            const picked = await this.page.evaluate(() => {
                const strip = s => (s || '').replace(/[​‌‍﻿]/g, '').trim();
                const all = [];
                const walk = (root) => {
                    let nodes; try { nodes = root.querySelectorAll('*'); } catch (e) { return; }
                    for (const el of nodes) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot); }
                };
                walk(document);
                // 우선순위 1: li[role=option] 중 텍스트 "판매중"
                let cands = all.filter(e => e.getAttribute && e.getAttribute('role') === 'option'
                    && strip(e.textContent) === '판매중');
                // 우선순위 2: 아무 leaf 나 텍스트 "판매중"
                if (!cands.length) {
                    cands = all.filter(e => e.children.length === 0 && strip(e.textContent) === '판매중');
                }
                if (cands.length) { cands[cands.length - 1].click(); return true; }
                return false;
            });
            if (!picked) {
                this.log(`⚠ [판매중 전환] 상품 ${idx}: "판매중" 옵션을 찾지 못했습니다.`);
                return false;
            }
            await sleep(1000);

            // confirmation dialog: "선택한 상품을 판매중으로 변경할까요?" → click 변경
            const confirmBtn = this.page.locator('button:text-is("변경")').last();
            if (await confirmBtn.count()) {
                await confirmBtn.click();
            }
            await sleep(2500);

            const after = (await this.page.locator('.product-row [data-column-id="status"]').first().innerText()).trim();
            const ok = after.includes('판매중');
            this.log(ok ? `[판매중 전환] ✓ 상품 ${idx} → 판매중` : `⚠ [판매중 전환] 상품 ${idx} 상태 변경 확인 실패 (현재: ${after})`);
            return ok;
        } catch (e) {
            this.log(`⚠ [판매중 전환] 상품 ${idx} 처리 오류: ${e.message}`);
            return false;
        }
    }

    // On the LAST-registered product's edit page, add the FIRST-registered product to the
    // 연관상품 (related products) linking — runs INLINE on the current product's edit page as
    // the last step BEFORE its save (no re-navigation, no extra save). Called from
    // registerProduct when both 개별+세트 are registered, on the last product, pointing to the
    // first. Verified structure: the 연관상품 section (before 추가상품) has a search box
    // input[placeholder*="상품명으로 검색"]; typing 브랜드+모델 opens a dropdown of result rows,
    // each with a checkbox; checking the matching row then clicking "N개 상품 추가" links it.
    async linkRelatedProduct(firstProduct, titleBrand, titleModel, code) {
        try {
            this.log(`[B2B 연관상품] 먼저 등록한 상품(${firstProduct.type})을 연관상품으로 연결합니다.`);

            // 연관상품 검색창 = 페이지 첫 번째 "상품명으로 검색" 입력 (연관상품이 추가상품보다 앞).
            const searchBox = this.page.locator('input[placeholder*="상품명으로 검색"]').first();
            if ((await searchBox.count()) === 0) {
                this.log('⚠ 연관상품 검색창을 찾지 못했습니다.');
                return false;
            }
            await searchBox.scrollIntoViewIfNeeded().catch(() => {});
            await searchBox.click();
            await searchBox.fill(`${titleBrand} ${titleModel}`);
            await sleep(3000);

            // The target row is a DROPDOWN RESULT naming one product. Match by model + type
            // marker (개별=운전석/조수석, 세트=1셋); the code may be absent from 개별 titles, so
            // it is only a tie-breaker, not a hard requirement.
            //
            // The result checkbox <input> is a 1×1 element with `pointer-events: none` (the
            // visible box is drawn over it), so we locate the checkbox, read its on-screen
            // rect, and click that exact point with the mouse — i.e. click the checkbox square
            // precisely. (Clicking the <input> node directly does nothing.) 결과 목록은 Shadow
            // DOM 안이라 체크박스 수집도 shadowRoot 를 재귀적으로 뚫는다.
            const marker = firstProduct.type === 'indiv' ? '운전석/조수석' : '1셋';

            const rect = await this.page.evaluate(({ titleModel, marker, code }) => {
                const cbs = [];
                const walk = (root) => {
                    let nodes; try { nodes = root.querySelectorAll('*'); } catch (e) { return; }
                    for (const el of nodes) {
                        if (el.matches && el.matches('input[type="checkbox"]')) cbs.push(el);
                        if (el.shadowRoot) walk(el.shadowRoot);
                    }
                };
                walk(document);
                const cands = [];
                for (const cb of cbs) {
                    // Climb to the checkbox's OWN result row = first ancestor whose text names a
                    // single product ("… 미러 …", short). Exclude the current-product summary
                    // table (contains 판매가/KRW). Stop before a parent that groups several rows.
                    let row = cb.parentElement, rowText = null;
                    for (let i = 0; i < 8 && row; i++) {
                        const t = (row.textContent || '').trim();
                        if (t.includes('미러') && t.length < 90 && !t.includes('KRW') && !t.includes('판매가')) {
                            rowText = t; break;
                        }
                        row = row.parentElement;
                    }
                    if (!rowText) continue;
                    if (!rowText.includes(titleModel) || !rowText.includes(marker)) continue;
                    cands.push({ cb, hasCode: !!(code && rowText.includes(code)) });
                }
                if (!cands.length) return null;
                const best = cands.find(c => c.hasCode) || cands[0];
                window.__relCb = best.cb;   // stash for post-click verification
                best.cb.scrollIntoView({ block: 'center' });
                const r = best.cb.getBoundingClientRect();
                return { cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
            }, { titleModel, marker, code });

            if (!rect) {
                await this.debugCapture('related_no_match');
                this.log(`⚠ 연관상품 검색 결과에서 대상(${titleModel} / ${marker})을 찾지 못했습니다.`);
                return false;
            }
            // click the checkbox square precisely
            await this.page.mouse.click(rect.cx, rect.cy);
            await sleep(1000);
            let checked = await this.page.evaluate(() => window.__relCb ? window.__relCb.checked : false);
            if (!checked) {
                // fallback: click the checkbox's wrapping label (native toggle)
                await this.page.evaluate(() => { const l = window.__relCb && window.__relCb.closest('label'); (l || window.__relCb).click(); });
                await sleep(1000);
                checked = await this.page.evaluate(() => window.__relCb ? window.__relCb.checked : false);
            }
            if (!checked) {
                await this.debugCapture('related_not_checked');
                this.log(`⚠ 연관상품 체크박스가 선택되지 않았습니다 (${marker}).`);
                return false;
            }
            this.log(`[B2B 연관상품] 대상 상품 체크 완료 (${marker}).`);

            // Checking a row only selects it — the panel's "상품 추가" button then relabels to
            // "N개 상품 추가"; clicking it actually adds the selected product to the 연관상품 list.
            const addedLabel = await this.page.evaluate(() => {
                // 버튼도 Shadow DOM 안일 수 있어 shadowRoot 를 뚫어 수집한다.
                const buttons = [];
                const walk = (root) => {
                    let nodes; try { nodes = root.querySelectorAll('button'); } catch (e) { nodes = []; }
                    for (const el of nodes) buttons.push(el);
                    let all; try { all = root.querySelectorAll('*'); } catch (e) { return; }
                    for (const el of all) { if (el.shadowRoot) walk(el.shadowRoot); }
                };
                walk(document);
                const b = buttons.find(x => {
                    const t = (x.textContent || '').trim();
                    return /\d+개\s*상품 추가/.test(t) && !x.disabled;
                });
                if (b) { b.click(); return b.textContent.trim(); }
                return null;
            });
            if (addedLabel) {
                this.log(`[B2B 연관상품] "${addedLabel}" 클릭 — 연관상품 목록에 추가.`);
                await sleep(1500);
            } else {
                this.log('⚠ "N개 상품 추가" 버튼을 찾지 못했습니다 (체크는 되었으나 추가 버튼 미확인).');
            }
            // NOTE: the caller (registerProduct) performs the single 저장 right after this.
            this.log('[B2B 연관상품] ✓ 연관상품 연결 완료 (저장은 상품 저장 시 함께 반영).');
            return true;
        } catch (e) {
            this.log(`⚠ 연관상품 연결 실패: ${e.message}`);
            return false;
        }
    }

    // The 본사몰 admin renders its content inside a nested iframe (iframe.app → /_/site-content/),
    // unlike the B2B admin which is plain page DOM. Wait for that frame to actually hold the
    // expected text before using it — it reports empty for several seconds after navigation.
    async siteContentFrame(needle, timeoutMs = 30000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const f = this.page.frames().find(fr => fr.url().includes('/_/site-content'));
            if (f) {
                try {
                    const ok = await f.evaluate((n) => (document.body?.innerText || '').includes(n), needle);
                    if (ok) return f;
                } catch (e) { /* frame swapped mid-check */ }
            }
            await sleep(1000);
        }
        return null;
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

    // Posts one 조견표 article to the brand's board in the given language ('ko' | 'en' | 'jp').
    // Returns true on success. Flow verified live:
    //   게시물 목록 → 게시판 클릭(board_code 확정) → 게시물 작성 → 새로운 글 쓰기
    //   → 제목 입력 → Froala 본문 주입 → 발행
    async postBoardContent(data, lang) {
        const LANGS = { ko: '한국어', en: '영문', jp: '일문' };
        const boardName = this.boardNameFor(data.brand, lang);
        if (!boardName) {
            this.log(`⚠ "${data.brand}" 의 ${LANGS[lang]} 게시판이 매핑에 없어 건너뜁니다 (data/imweb_boards.json).`);
            return false;
        }
        this.log(`대상 게시판: "${boardName}" (${LANGS[lang]})`);

        const adminBaseUrl = this.page.url().split('/admin')[0];
        await this.page.goto(`${adminBaseUrl}/admin/contents/post/list?page=1&page_size=20`);
        await this.page.waitForLoadState('domcontentloaded');

        let frame = await this.siteContentFrame('전체 게시물');
        if (!frame) {
            this.log('⚠ 게시물 목록 프레임을 불러오지 못했습니다.');
            return false;
        }

        // 1. Pick the board. Board rows are span.clay-label-medium-bold; the list is long, so
        //    narrow it with the "게시판 이름으로 검색" box first when it's available.
        const searchBox = frame.locator('input[placeholder*="게시판 이름"]').first();
        if ((await searchBox.count()) > 0) {
            await searchBox.fill(boardName).catch(() => {});
            await sleep(2000);
        }

        let boardItem = frame.locator(`span.clay-label-medium-bold:text-is("${boardName}")`).first();
        if ((await boardItem.count()) === 0) {
            // Not rendered yet — scroll the board list looking for it.
            for (let i = 0; i < 25 && (await boardItem.count()) === 0; i++) {
                await frame.evaluate(() => {
                    const el = document.querySelector('span.clay-label-medium-bold');
                    let e = el && el.parentElement;
                    while (e && e !== document.body) {
                        const st = getComputedStyle(e);
                        if (/(auto|scroll)/.test(st.overflowY) && e.scrollHeight > e.clientHeight) {
                            e.scrollTop += 250; return;
                        }
                        e = e.parentElement;
                    }
                });
                await sleep(300);
                boardItem = frame.locator(`span.clay-label-medium-bold:text-is("${boardName}")`).first();
            }
        }
        if ((await boardItem.count()) === 0) {
            this.log(`⚠ 게시판 "${boardName}" 을(를) 목록에서 찾지 못했습니다.`);
            return false;
        }
        await boardItem.click();
        await sleep(3000);

        const boardCode = (this.page.url().match(/board_code=([^&]+)/) || [])[1] || '';
        if (!boardCode) {
            this.log('⚠ 게시판을 클릭했지만 board_code를 확인하지 못했습니다.');
            return false;
        }
        this.log(`게시판 선택 완료 (board_code=${boardCode})`);

        // 2. 게시물 작성 → 새로운 글 쓰기
        frame = await this.siteContentFrame('게시물 작성') || frame;
        await frame.locator('button:has-text("게시물 작성")').last().click();
        await sleep(1800);
        const newPost = frame.locator('text=새로운 글 쓰기').first();
        if ((await newPost.count()) === 0) {
            this.log('⚠ "새로운 글 쓰기" 메뉴를 찾지 못했습니다.');
            return false;
        }
        await newPost.click();
        await sleep(5000);

        if (!this.page.url().includes('/post/editor')) {
            this.log(`⚠ 작성 화면으로 진입하지 못했습니다: ${this.page.url()}`);
            return false;
        }

        // 3. Title — Korean board uses the Korean names, English/Japanese boards use the
        // English names (일본어 게시판도 영문과 동일 형식으로 씁니다).
        const editorFrame = await this.siteContentFrame('제목');
        if (!editorFrame) {
            this.log('⚠ 작성 폼 프레임을 불러오지 못했습니다.');
            return false;
        }
        const nameBrand = (lang === 'ko') ? data.titleBrand : (data.titleBrandEn || data.titleBrand);
        const nameModel = (lang === 'ko') ? data.titleModel : (data.titleModelEn || data.titleModel);

        const title = `${nameBrand} ${nameModel} [${data.code}]`;
        this.log(`게시글 제목 작성: ${title}`);
        await editorFrame.locator('input[placeholder*="게시글 제목"]').first().fill(title);
        await sleep(500);

        // 4. Body. Formats copied from live posts:
        //   한국어 : "※ 인피니티 G25 조견표 ※"                          + 국내용 조견표 이미지
        //   영문/일문 : "※ INFINITI G25 Fitment Guide ※" / "4th gen [No.612]" + 해외용 조견표 이미지
        // Note the spaces inside the ※ … ※ markers.
        const bannerTitle = lang === 'ko'
            ? `※ ${nameBrand} ${nameModel} 조견표 ※`
            : `※ ${nameBrand} ${nameModel} Fitment Guide ※<br>${data.generation || ''} [No.${data.code}]`;

        const rawSpec = (lang === 'ko') ? data.specImageUrl : (data.specImageUrlEn || data.specImageUrl);
        const specUrl = this.extractImageUrl(rawSpec);
        if (!specUrl) {
            this.log(`⚠ ${LANGS[lang]} 조견표 이미지 URL이 비어 있어 포스팅을 중단합니다.`);
            return false;
        }
        const contentHtml =
            `<p style="text-align: center;"><strong><span style="font-size: 30px;">${bannerTitle}</span></strong></p>` +
            `<p style="text-align: center;"><img src="${specUrl}" class="fr-fic fr-dii"></p>`;

        // The board editor's Froala lives inside the /_/site-content iframe and does NOT
        // expose window.FroalaEditor there, so the B2B FroalaEditor.INSTANCES approach
        // fails. The reliable path (matching how it's done by hand, verified live) is the
        // "</>" code-view button (data-cmd="html"): open it, write the raw HTML into the
        // code textarea via the native value setter + input event, then toggle it off so
        // Froala renders it.
        const codeBtn = editorFrame.locator('button[data-cmd="html"]').last();
        if ((await codeBtn.count()) === 0) {
            this.log('⚠ 본문 코드보기(</>) 버튼을 찾지 못했습니다.');
            return false;
        }
        await codeBtn.click();
        await sleep(1200);

        const filled = await editorFrame.evaluate((html) => {
            const tas = Array.from(document.querySelectorAll('textarea'));
            // the visible code textarea (CodeMirror's), falling back to Froala's fr-code
            const ta = tas.find(t => (t.offsetWidth || t.offsetHeight))
                    || tas.find(t => (t.className || '').includes('fr-code'))
                    || tas[0];
            if (!ta) return false;
            ta.focus();
            const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
            setter.call(ta, html);
            ta.dispatchEvent(new Event('input', { bubbles: true }));
            ta.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
        }, contentHtml);
        if (!filled) {
            this.log('⚠ 코드 입력창을 찾지 못했습니다.');
            return false;
        }
        await sleep(800);

        // Toggle code view off → Froala renders the HTML.
        await codeBtn.click();
        await sleep(1200);

        const ok = await editorFrame.evaluate((url) => {
            const el = document.querySelector('.fr-element');
            return !!el && el.innerHTML.includes(url);
        }, specUrl);
        if (!ok) {
            await this.debugCapture(`post_${lang}_body`);
            this.log('⚠ 본문 렌더 결과를 확인하지 못했습니다. (저장 전 확인 필요)');
        } else {
            this.log('게시글 본문 조견표 이미지 주입 완료.');
        }

        // 5. Publish — two steps: top-right "발행" opens a "게시물 발행" dialog whose own
        // "발행하기" button actually posts it. The board is already fixed by the editor
        // URL's board_code, so the dialog's optional 카테고리 선택 is left untouched.
        this.log('게시글 발행 중 (1/2: 발행 버튼)...');
        await editorFrame.locator('button:text-is("발행")').last().click();
        await sleep(2000);
        await this.debugCapture(`post_${lang}_dialog`);

        this.log('게시글 발행 중 (2/2: 발행하기 버튼)...');
        const publishNow = editorFrame.locator('button:text-is("발행하기")').last();
        if ((await publishNow.count()) === 0) {
            this.log('⚠ "발행하기" 확인 버튼을 찾지 못했습니다.');
            return false;
        }
        await publishNow.click();
        await sleep(4000);

        const stillEditing = this.page.url().includes('/post/editor');
        if (stillEditing) {
            await this.debugCapture(`post_${lang}_publish`);
            this.log(`⚠ 발행 후에도 작성 화면에 남아 있습니다. 확인이 필요합니다.`);
            return false;
        }

        this.log(`✓ [${LANGS[lang]}] 게시글 포스팅 완료: ${title}`);
        return true;
    }

    // 아임웹 B2B몰 상품 수정 자동화
    async modifyProduct(data, type) {
        const isSet = type === 'set';
        const searchKeyword = isSet ? `1셋 [${data.code}]` : `운전석/조수석 [${data.code}]`;
        
        const adminBaseUrl = this.page.url().split('/admin')[0];
        
        this.log(`상품 목록에서 "${searchKeyword}" 검색 중...`);
        await this.page.goto(`${adminBaseUrl}/admin/shopping/product?search=${encodeURIComponent(searchKeyword)}&searchType=title`);
        await this.page.waitForLoadState('domcontentloaded');
        await sleep(3000);
        
        const productLink = this.page.locator('a[href*="/product/detail?idx="]').first();
        if ((await productLink.count()) === 0) {
            this.log(`⚠ 수정할 상품을 찾지 못했습니다: ${searchKeyword}`);
            return null;
        }
        
        const href = await productLink.getAttribute('href');
        const idx = (href.match(/idx=([^&]+)/) || [])[1];
        if (!idx) {
            throw new Error(`상품의 고유 번호(idx)를 추출하지 못했습니다.`);
        }
        
        this.log(`상품 편집 페이지로 이동 (상품번호: ${idx})...`);
        await this.page.goto(`${adminBaseUrl}/admin/shopping/product/detail?idx=${idx}`);
        await this.page.waitForLoadState('domcontentloaded');
        await sleep(3000);
        
        // 1. Title
        const title = isSet 
            ? `옵틱글래스 ${data.titleBrand} ${data.titleModel} 미러 1셋 [${data.code}]`
            : `옵틱글래스 ${data.titleBrand} ${data.titleModel} 미러 운전석/조수석 [${data.code}]`;
        this.log(`상품명 변경: ${title}`);
        await this.fillInput('input[placeholder*="상품명"]', title);
        
        // 2. Price
        const price = data.hasBsa ? (isSet ? 220000 : 115000) : (isSet ? 150000 : 80000);
        this.log(`판매가 변경: ${price}원`);
        await this.fillByLabel('판매가', price.toString());
        
        // 3. Category
        await this.cleanupAndAddCategory(data.nationality, data.brand, data.model);
        
        // 4. Representative Image
        if (data.mainImagePath) {
            try {
                if (fs.existsSync(data.mainImagePath)) {
                    this.log(`대표 이미지 교체 시작 (기존 이미지 삭제 후 업로드)...`);
                    // delete all existing images
                    for (let i = 0; i < 8; i++) {
                        const delBtns = await this.getLocator('button.delete-button');
                        const n = await delBtns.count();
                        if (n === 0) break;
                        await delBtns.first().click({ force: true }).catch(() => {});
                        await sleep(800);
                    }
                    // upload the picked file
                    let fileInput = (await this.getLocator('input[type="file"][accept*="bmp"]')).first();
                    if ((await fileInput.count()) === 0) {
                        fileInput = (await this.getLocator(
                            'xpath=//*[self::p or self::label or self::span][normalize-space(text())="이미지"]/following::input[@type="file"][1]'
                        )).first();
                    }
                    if (await fileInput.count() > 0) {
                        await fileInput.setInputFiles(data.mainImagePath);
                        await sleep(2500);
                        this.log(`대표 이미지 업로드 완료.`);
                    }
                }
            } catch (err) {
                this.log(`⚠ 대표 이미지 업로드 오류: ${err.message}`);
            }
        }
        
        // 5. Details Description
        this.log(`상세설명 조견표 영역 교체...`);
        await this.injectHtmlEditor(data);
        
        // 6. Options
        await this.setupOptions(data, type);
        
        // 7. Save
        this.log(`상품 저장 중...`);
        await this.clickElement('button:has-text("저장")');
        await sleep(3000);
        
        this.log(`✓ 상품 수정 완료. (상품번호: ${idx})`);
        return idx;
    }

    // 아임웹 게시판 게시글 수정 자동화
    async modifyBoardContent(data, lang) {
        const LANGS = { ko: '한국어', en: '영문', jp: '일문' };
        const boardName = this.boardNameFor(data.brand, lang);
        if (!boardName) {
            this.log(`⚠ "${data.brand}" 의 ${LANGS[lang]} 게시판이 매핑에 없어 건너뜁니다.`);
            return false;
        }
        this.log(`대상 게시판: "${boardName}" (${LANGS[lang]})`);

        const adminBaseUrl = this.page.url().split('/admin')[0];
        await this.page.goto(`${adminBaseUrl}/admin/contents/post/list?page=1&page_size=20`);
        await this.page.waitForLoadState('domcontentloaded');

        let frame = await this.siteContentFrame('전체 게시물');
        if (!frame) {
            this.log('⚠ 게시물 목록 프레임을 불러오지 못했습니다.');
            return false;
        }

        // 1. Pick the board.
        const searchBox = frame.locator('input[placeholder*="게시판 이름"]').first();
        if ((await searchBox.count()) > 0) {
            await searchBox.fill(boardName).catch(() => {});
            await sleep(2000);
        }

        let boardItem = frame.locator(`span.clay-label-medium-bold:text-is("${boardName}")`).first();
        if ((await boardItem.count()) === 0) {
            for (let i = 0; i < 25 && (await boardItem.count()) === 0; i++) {
                await frame.evaluate(() => {
                    const el = document.querySelector('span.clay-label-medium-bold');
                    let e = el && el.parentElement;
                    while (e && e !== document.body) {
                        const st = getComputedStyle(e);
                        if (/(auto|scroll)/.test(st.overflowY) && e.scrollHeight > e.clientHeight) {
                            e.scrollTop += 250; return;
                        }
                        e = e.parentElement;
                    }
                });
                await sleep(300);
                boardItem = frame.locator(`span.clay-label-medium-bold:text-is("${boardName}")`).first();
            }
        }
        if ((await boardItem.count()) === 0) {
            this.log(`⚠ 게시판 "${boardName}" 을(를) 목록에서 찾지 못했습니다.`);
            return false;
        }
        await boardItem.click();
        await sleep(3000);

        // 2. Search for the post
        frame = await this.siteContentFrame('게시판 선택') || frame;
        
        const postSearchInput = frame.locator('input[placeholder*="검색"]').first();
        if ((await postSearchInput.count()) === 0) {
            this.log('⚠ 게시글 검색창을 찾지 못했습니다.');
            return false;
        }
        
        this.log(`게시판 내에서 "${data.code}" 검색 중...`);
        await postSearchInput.fill(data.code);
        await postSearchInput.press('Enter');
        await sleep(3000);
        
        const postLink = frame.locator(`a:has-text("${data.code}")`).first();
        if ((await postLink.count()) === 0) {
            this.log(`⚠ 수정할 게시글을 찾지 못했습니다: [${data.code}]`);
            return false;
        }
        
        this.log('게시글을 선택하여 에디터로 진입합니다.');
        await postLink.click();
        await sleep(5000);

        if (!this.page.url().includes('/post/editor')) {
            this.log(`⚠ 작성 화면으로 진입하지 못했습니다: ${this.page.url()}`);
            return false;
        }

        // 3. Title update
        const editorFrame = await this.siteContentFrame('제목');
        if (!editorFrame) {
            this.log('⚠ 에디터 프레임을 불러오지 못했습니다.');
            return false;
        }
        
        const nameBrand = (lang === 'ko') ? data.titleBrand : (data.titleBrandEn || data.titleBrand);
        const nameModel = (lang === 'ko') ? data.titleModel : (data.titleModelEn || data.titleModel);
        const title = `${nameBrand} ${nameModel} [${data.code}]`;
        this.log(`게시글 제목 수정: ${title}`);
        await editorFrame.locator('input[placeholder*="게시글 제목"]').first().fill(title);
        await sleep(500);

        // 4. Body update
        const bannerTitle = lang === 'ko'
            ? `※ ${nameBrand} ${nameModel} 조견표 ※`
            : `※ ${nameBrand} ${nameModel} Fitment Guide ※<br>${data.generation || ''} [No.${data.code}]`;

        const rawSpec = (lang === 'ko') ? data.specImageUrl : (data.specImageUrlEn || data.specImageUrl);
        const specUrl = this.extractImageUrl(rawSpec);
        if (!specUrl) {
            this.log(`⚠ ${LANGS[lang]} 조견표 이미지 URL이 비어 있어 수정을 중단합니다.`);
            return false;
        }
        const contentHtml =
            `<p style="text-align: center;"><strong><span style="font-size: 30px;">${bannerTitle}</span></strong></p>` +
            `<p style="text-align: center;"><img src="${specUrl}" class="fr-fic fr-dii"></p>`;

        const codeBtn = editorFrame.locator('button[data-cmd="html"]').last();
        if ((await codeBtn.count()) === 0) {
            this.log('⚠ 본문 코드보기(</>) 버튼을 찾지 못했습니다.');
            return false;
        }
        
        const isCodeActive = await codeBtn.evaluate(el => el.classList.contains('fr-active') || el.getAttribute('aria-pressed') === 'true');
        if (!isCodeActive) {
            await codeBtn.click();
            await sleep(1200);
        }

        const filled = await editorFrame.evaluate((html) => {
            const tas = Array.from(document.querySelectorAll('textarea'));
            const ta = tas.find(t => (t.offsetWidth || t.offsetHeight))
                    || tas.find(t => (t.className || '').includes('fr-code'))
                    || tas[0];
            if (!ta) return false;
            ta.focus();
            const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
            setter.call(ta, html);
            ta.dispatchEvent(new Event('input', { bubbles: true }));
            ta.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
        }, contentHtml);
        
        if (!filled) {
            this.log('⚠ 코드 입력창을 찾지 못했습니다.');
            return false;
        }
        await sleep(800);

        await codeBtn.click();
        await sleep(1200);

        // 5. Publish
        this.log('게시글 발행 중 (1/2: 발행 버튼)...');
        await editorFrame.locator('button:text-is("발행")').last().click();
        await sleep(2000);

        this.log('게시글 발행 중 (2/2: 발행하기 버튼)...');
        const publishNow = editorFrame.locator('button:text-is("발행하기")').last();
        if ((await publishNow.count()) === 0) {
            this.log('⚠ "발행하기" 확인 버튼을 찾지 못했습니다.');
            return false;
        }
        await publishNow.click();
        await sleep(4000);

        this.log(`✓ [${LANGS[lang]}] 게시글 수정 완료: ${title}`);
        return true;
    }

    // 아임웹 본사·해외몰 기존 게시글 수정 전용 불러오기 기능
    async loadPostForEdit(code, lang, brand) {
        const boardName = this.boardNameFor(brand, lang);
        if (!boardName) {
            throw new Error(`"${brand}"의 해당 언어 게시판이 매핑에 없습니다.`);
        }
        
        await this.initBrowserSession();
        await this.openAdminAt('https://optic-glass.imweb.me/admin/contents/post/list?page=1&page_size=20', '/admin/contents/post');
        const adminBaseUrl = this.page.url().split('/admin')[0];
        
        this.log(`[게시글] 전체 게시물 이동 및 "${boardName}" 검색 중...`);
        await this.page.goto(`${adminBaseUrl}/admin/contents/post/list?page=1&page_size=20`);
        await this.page.waitForLoadState('domcontentloaded');
        await sleep(3000);
        
        let frame = await this.siteContentFrame('전체 게시물');
        if (!frame) throw new Error('게시물 목록 프레임을 불러오지 못했습니다.');
        
        const searchBox = frame.locator('input[placeholder*="게시판 이름"]').first();
        if ((await searchBox.count()) > 0) {
            await searchBox.fill(boardName);
            await sleep(2000);
        }
        
        let boardItem = frame.locator(`span.clay-label-medium-bold:text-is("${boardName}")`).first();
        if ((await boardItem.count()) === 0) {
            for (let i = 0; i < 25 && (await boardItem.count()) === 0; i++) {
                await frame.evaluate(() => {
                    const el = document.querySelector('span.clay-label-medium-bold');
                    let e = el && el.parentElement;
                    while (e && e !== document.body) {
                        const st = getComputedStyle(e);
                        if (/(auto|scroll)/.test(st.overflowY) && e.scrollHeight > e.clientHeight) {
                            e.scrollTop += 250; return;
                        }
                        e = e.parentElement;
                    }
                });
                await sleep(300);
                boardItem = frame.locator(`span.clay-label-medium-bold:text-is("${boardName}")`).first();
            }
        }
        if ((await boardItem.count()) === 0) {
            throw new Error(`게시판 "${boardName}" 을(를) 목록에서 찾지 못했습니다.`);
        }
        await boardItem.click();
        await sleep(3000);
        
        frame = await this.siteContentFrame('게시판 선택') || frame;
        const postSearchInput = frame.locator('input[placeholder*="검색"]').first();
        if ((await postSearchInput.count()) === 0) {
            throw new Error('게시글 검색창을 찾지 못했습니다.');
        }
        
        this.log(`게시판 내에서 "${code}" 검색 중...`);
        await postSearchInput.fill(code);
        await postSearchInput.press('Enter');
        await sleep(3000);
        
        const postLink = frame.locator(`a:has-text("${code}")`).first();
        if ((await postLink.count()) === 0) {
            throw new Error(`수정할 게시글을 찾지 못했습니다: [${code}]`);
        }
        
        this.log('게시글 편집 화면으로 이동합니다.');
        await postLink.click();
        await sleep(5000);
        
        if (!this.page.url().includes('/post/editor')) {
            throw new Error('게시글 작성/수정 에디터 화면으로 이동하지 못했습니다.');
        }
        
        const editorFrame = await this.siteContentFrame('제목') || frame;
        const titleInput = editorFrame.locator('input[placeholder*="게시글 제목"]').first();
        const title = await titleInput.inputValue();
        
        const codeBtn = editorFrame.locator('button[data-cmd="html"]').last();
        if ((await codeBtn.count()) === 0) {
            throw new Error('본문 코드보기(</>) 버튼을 찾지 못했습니다.');
        }
        
        const isCodeActive = await codeBtn.evaluate(el => el.classList.contains('fr-active') || el.getAttribute('aria-pressed') === 'true');
        if (!isCodeActive) {
            await codeBtn.click();
            await sleep(1200);
        }
        
        const html = await editorFrame.evaluate(() => {
            const tas = Array.from(document.querySelectorAll('textarea'));
            const ta = tas.find(t => (t.offsetWidth || t.offsetHeight))
                    || tas.find(t => (t.className || '').includes('fr-code'))
                    || tas[0];
            return ta ? ta.value : '';
        });
        
        await codeBtn.click();
        await sleep(1000);
        
        const detailImages = [];
        const matches = html.matchAll(/<img[^>]+src=["']([^"']+)["']/g);
        for (const match of matches) {
            detailImages.push(match[1]);
        }
        
        await this.close();
        
        return {
            title,
            detailImages
        };
    }

    // 아임웹 본사·해외몰 기존 게시글 수정 전용 적용 기능 (대화형)
    async updatePost(data) {
        const boardName = this.boardNameFor(data.brand, data.lang);
        if (!boardName) {
            throw new Error(`"${data.brand}"의 해당 언어 게시판이 매핑에 없습니다.`);
        }
        
        await this.initBrowserSession();
        await this.openAdminAt('https://optic-glass.imweb.me/admin/contents/post/list?page=1&page_size=20', '/admin/contents/post');
        const adminBaseUrl = this.page.url().split('/admin')[0];
        
        this.log(`[게시글] 전체 게시물 이동 및 "${boardName}" 검색 중...`);
        await this.page.goto(`${adminBaseUrl}/admin/contents/post/list?page=1&page_size=20`);
        await this.page.waitForLoadState('domcontentloaded');
        await sleep(3000);
        
        let frame = await this.siteContentFrame('전체 게시물');
        if (!frame) throw new Error('게시물 목록 프레임을 불러오지 못했습니다.');
        
        const searchBox = frame.locator('input[placeholder*="게시판 이름"]').first();
        if ((await searchBox.count()) > 0) {
            await searchBox.fill(boardName);
            await sleep(2000);
        }
        
        let boardItem = frame.locator(`span.clay-label-medium-bold:text-is("${boardName}")`).first();
        if ((await boardItem.count()) === 0) {
            for (let i = 0; i < 25 && (await boardItem.count()) === 0; i++) {
                await frame.evaluate(() => {
                    const el = document.querySelector('span.clay-label-medium-bold');
                    let e = el && el.parentElement;
                    while (e && e !== document.body) {
                        const st = getComputedStyle(e);
                        if (/(auto|scroll)/.test(st.overflowY) && e.scrollHeight > e.clientHeight) {
                            e.scrollTop += 250; return;
                        }
                        e = e.parentElement;
                    }
                });
                await sleep(300);
                boardItem = frame.locator(`span.clay-label-medium-bold:text-is("${boardName}")`).first();
            }
        }
        if ((await boardItem.count()) === 0) {
            throw new Error(`게시판 "${boardName}" 을(를) 목록에서 찾지 못했습니다.`);
        }
        await boardItem.click();
        await sleep(3000);
        
        frame = await this.siteContentFrame('게시판 선택') || frame;
        const postSearchInput = frame.locator('input[placeholder*="검색"]').first();
        if ((await postSearchInput.count()) === 0) {
            throw new Error('게시글 검색창을 찾지 못했습니다.');
        }
        
        this.log(`게시판 내에서 "${data.code}" 검색 중...`);
        await postSearchInput.fill(data.code);
        await postSearchInput.press('Enter');
        await sleep(3000);
        
        const postLink = frame.locator(`a:has-text("${data.code}")`).first();
        if ((await postLink.count()) === 0) {
            throw new Error(`수정할 게시글을 찾지 못했습니다: [${data.code}]`);
        }
        
        this.log('게시글 편집 화면으로 이동합니다.');
        await postLink.click();
        await sleep(5000);
        
        if (!this.page.url().includes('/post/editor')) {
            throw new Error('게시글 작성/수정 에디터 화면으로 이동하지 못했습니다.');
        }
        
        const editorFrame = await this.siteContentFrame('제목') || frame;
        
        // 1. Title
        this.log(`게시글 제목 수정: ${data.title}`);
        await editorFrame.locator('input[placeholder*="게시글 제목"]').first().fill(data.title);
        await sleep(500);
        
        // 2. Body HTML Generation
        const titleBrandText = data.title.split(' ')[0] || data.brand;
        let contentHtml = `<p style="text-align: center;"><strong><span style="font-size: 30px;">※ ${titleBrandText} 조견표 ※</span></strong></p>`;
        data.detailImages.forEach(img => {
            contentHtml += `<p style="text-align: center;"><img src="${img}" class="fr-fic fr-dii"></p>`;
        });
        
        const codeBtn = editorFrame.locator('button[data-cmd="html"]').last();
        if ((await codeBtn.count()) === 0) {
            throw new Error('본문 코드보기(</>) 버튼을 찾지 못했습니다.');
        }
        
        const isCodeActive = await codeBtn.evaluate(el => el.classList.contains('fr-active') || el.getAttribute('aria-pressed') === 'true');
        if (!isCodeActive) {
            await codeBtn.click();
            await sleep(1200);
        }
        
        const filled = await editorFrame.evaluate((html) => {
            const tas = Array.from(document.querySelectorAll('textarea'));
            const ta = tas.find(t => (t.offsetWidth || t.offsetHeight))
                    || tas.find(t => (t.className || '').includes('fr-code'))
                    || tas[0];
            if (!ta) return false;
            ta.focus();
            const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
            setter.call(ta, html);
            ta.dispatchEvent(new Event('input', { bubbles: true }));
            ta.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
        }, contentHtml);
        
        if (!filled) {
            throw new Error('코드 입력창을 찾지 못했습니다.');
        }
        await sleep(800);
        
        await codeBtn.click();
        await sleep(1200);
        
        // 3. Publish
        this.log('게시글 발행 중 (1/2)...');
        await editorFrame.locator('button:text-is("발행")').last().click();
        await sleep(2000);
        
        this.log('게시글 발행 중 (2/2)...');
        const publishNow = editorFrame.locator('button:text-is("발행하기")').last();
        if ((await publishNow.count()) === 0) {
            throw new Error('"발행하기" 확인 버튼을 찾지 못했습니다.');
        }
        await publishNow.click();
        await sleep(4000);
        
        this.log(`✓ 게시글 수정 완료: ${data.title}`);
        await this.close();
        return `수정 완료`;
    }
}
