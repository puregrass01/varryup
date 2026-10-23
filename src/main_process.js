// TLS 인증서 검증은 켜둔다(기본값). 앱이 접속하는 서버·API(쿠팡·네이버·아임웹·파파고·클라우드 서버)가
// 모두 정상 인증서라 끌 필요 없다. (예전엔 NODE_TLS_REJECT_UNAUTHORIZED='0' 로 껐지만 MITM 위험이 있어 제거함)

import { app, BrowserWindow, ipcMain, dialog, safeStorage, shell } from 'electron';
import { registerBulkPriceIPC } from './bulk_price_ipc.js';
import { registerFxAutoPriceIPC, FxPriceStore } from './fx_auto_price.js';
import { loadVehicleNames, makeJpDraft, draftCsv, draftTsv } from './amazon_jp_draft.js';
import { detectUrlText } from './utils/image_text.js';
import { registerImwebUnitPricesIPC, createOpenApiGateway } from './imweb_unit_prices.js';
import { registerImwebUnitNamesIPC } from './imweb_unit_names.js';
import { createImwebSession, createImwebClient } from './platforms/openapi/imweb_client.js';
import { createImwebLock } from './utils/imweb_lock.js';
import { createB2bApi, B2B_SITE_CODE } from './platforms/openapi/imweb_b2b.js';
import { createImwebBulk } from './imweb_bulk.js';
import { englishPrice } from './utils/imweb_currency.js';
import { registerCurrencyRatesIPC } from './currency_rates_ipc.js';
import { registerEbayIPC } from './ebay_ipc.js';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import fs from 'fs';
import { NaverSmartStore } from './platforms/naver_smartstore.js';
import { NaverProducts } from './platforms/naver_products.js';
import { ImwebEdit } from './platforms/imweb_edit.js';
import { ESMPlusHosting } from './platforms/esmplus_hosting.js';
import { registerImageLibraryIPC } from './image_library_ipc.js';
import { NaverAPI, naverConnectionInfo } from './platforms/naver_api.js';
import { NaverStore } from './platforms/naver_store.js';
import { Coupang, findProductIdsFromSheet } from './platforms/coupang.js';
import { CoupangStore } from './platforms/coupang_store.js';
import { Amazon, cleanAmazonConfig } from './platforms/amazon.js';
import { AmazonStore } from './platforms/amazon_store.js';
import { Ebay } from './platforms/ebay.js';
import { EbayStore } from './platforms/ebay_store.js';
import { imwebRunResponse } from './platforms/imweb.js';
import { BasePlatform } from './platforms/base_platform.js';
import { chromium } from 'playwright';
import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas';

import { spawn } from 'child_process';
import electronUpdater from 'electron-updater';
import { serverLogin, fetchCredentials } from './utils/server_keys.js';
import { saveConfig as oaSaveConfig } from './platforms/openapi/imweb_keys.js';
import { looksLikeOAuthClientId, oauthCredentialsFromConfig } from './platforms/openapi/imweb_oauth.js';
import { resolveRuntimeProxy } from './utils/runtime_proxy.js';
import { loadUserEnv } from './utils/env_file.js';
import { toVeryupLog, VERYUP_LOG_CHANNEL } from './utils/ui_log.js';
import { RegistrationLedger } from './utils/registration_ledger.js';
import {
    createInflightLock, runGuardedRegistration, noticeSuffix, isGuardError, guardErrorResponse, brandsFromCatalog,
    planCoupang, checkCoupang, recordCoupang, planNaver, checkNaver, recordNaver,
    planAmazon, checkAmazon, recordAmazon, planImweb, checkImweb, recordImweb,
} from './utils/duplicate_guard.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── 설치본 설정 파일 ──────────────────────────────────────────
// ⚠ 위치가 중요하다: 바로 아래의 AI_GEN_DIR·ADMIN_SERVER_URL 등이 모듈 로드 시점에
//   process.env 를 읽어 굳어버리므로, 그보다 먼저 파일 값을 얹어야 한다.
//   (app.getPath('userData') 는 app.whenReady() 전에도 쓸 수 있다)
loadUserEnv(app.getPath('userData'), app.getAppPath());
// getEbayService: IPC 경로와 이 파일의 getEbay() 가 같은 Ebay 인스턴스를 쓰게 한다.
// (인스턴스가 둘이면 Ebay#busy 잠금이 갈라져 발행 중 설정 덮어쓰기를 못 막는다 — ebay_ipc.js 주석 참고)
registerEbayIPC({ app, ipcMain, safeStorage, shell, uiDirectory: path.join(__dirname, 'ui'), getRuntimeProxy: () => getRuntimeProxy('ebay'), getEbayService: () => getEbay() });

// ── 배포 이식 경로 ────────────────────────────────────────────────
// AI 생성기는 앱과 분리 배포한다(용량 큼 → 자동 업데이트 대상에서 제외).
// 설치본에서는 고정 외부 경로(%LOCALAPPDATA%\OpticGlassAI)에 최초 1회 설치된 것을 쓰고,
// 개발 중에는 기존 개발 폴더를 쓴다. 두 경우 모두 환경변수 AI_GEN_DIR 로 덮어쓸 수 있다.
const AI_GEN_DIR = process.env.AI_GEN_DIR || (app.isPackaged
    ? path.join(process.env.LOCALAPPDATA || app.getPath('appData'), 'OpticGlassAI')
    : 'C:\\Users\\wish\\.gemini\\antigravity\\scratch\\auto_image_generator');
// 설치본의 resources 폴더는 쓰기 불가(Program Files)이므로 AI 결과·업로드는
// 항상 쓰기 가능한 userData 아래에 둔다. server.js 에도 같은 경로를 넘긴다.
const AI_OUTPUT_DIR = path.join(app.getPath('userData'), 'ai_output');
const AI_UPLOAD_DIR = path.join(app.getPath('userData'), 'ai_uploads');

// AI 서버 주소(설정값). 기본은 로컬. 서버 PC로 옮길 때 환경변수 AI_SERVER_URL 로만 교체하면 된다.
//   예) AI_SERVER_URL=http://192.168.0.10:8000   또는   http://210.103.107.86:8000
const AI_SERVER_URL = (process.env.AI_SERVER_URL || 'https://ai.veryup-domain.duckdns.org').replace(/\/+$/, '');
// 원격 서버를 쓰면 각 PC에서 로컬 AI(807MB exe)를 띄울 필요가 없다.
const AI_IS_LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(AI_SERVER_URL);

// 관리자/인증키 서버 주소 (직원 로그인 · 인증키 조회). 배포 시 서버 PC 주소로 교체.
const ADMIN_SERVER_URL = (process.env.ADMIN_SERVER_URL || 'https://admin.veryup-domain.duckdns.org').replace(/\/+$/, '');
// 로그인 후 발급받은 토큰·직원정보 (메모리에만 보관, 파일로 저장하지 않음)
let serverAuth = null;
const currencyRatesService = registerCurrencyRatesIPC({ app, ipcMain });
// 서버에서 받은 "로그인(아이디/비번)" 인증키 (플랫폼별). 브라우저 로그인 자동입력에 쓴다.
// 메모리에만 보관 → 파일로 안 남김.
let serverCreds = {};

// AI 생성기(파이썬 세그멘테이션 서버 + 노드 이미지합성 서버) 자동 실행/종료
let aiProcs = [];
function startAiServers() {
    try {
        if (!AI_IS_LOCAL) {
            console.log('[AI] 원격 AI 서버 사용:', AI_SERVER_URL, '- 로컬 AI 서버는 실행하지 않습니다.');
            return;
        }
        if (!fs.existsSync(AI_GEN_DIR)) {
            console.warn('AI 생성기 폴더가 없어 AI 서버를 시작하지 않습니다:', AI_GEN_DIR);
            return;
        }
        // 1) 파이썬 세그멘테이션 서버 (PyInstaller 번들 exe, 포트 8000)
        const pyExe = path.join(AI_GEN_DIR, 'ai_server', 'dist', 'ai_server', 'ai_server.exe');
        if (fs.existsSync(pyExe)) {
            aiProcs.push(spawn(pyExe, [], { cwd: path.join(AI_GEN_DIR, 'ai_server'), detached: false, stdio: 'ignore' }));
        } else {
            console.warn('파이썬 AI 서버 exe 없음:', pyExe);
        }
        // 2) 노드 이미지합성 서버 (server.js, 포트 3000) — Electron 내장 노드로 실행 (시스템 node 불필요)
        const serverJs = path.join(AI_GEN_DIR, 'server.js');
        if (fs.existsSync(serverJs)) {
            try { if (!fs.existsSync(AI_OUTPUT_DIR)) fs.mkdirSync(AI_OUTPUT_DIR, { recursive: true }); } catch {}
            try { if (!fs.existsSync(AI_UPLOAD_DIR)) fs.mkdirSync(AI_UPLOAD_DIR, { recursive: true }); } catch {}
            aiProcs.push(spawn(process.execPath, [serverJs], {
                cwd: AI_GEN_DIR, detached: false, stdio: 'ignore',
                env: {
                    ...process.env,
                    ELECTRON_RUN_AS_NODE: '1',
                    AI_OUTPUT_DIR,   // server.js 가 결과 이미지를 여기에 쓰도록
                    AI_UPLOAD_DIR,   // multer 업로드도 쓰기 가능한 곳으로
                },
            }));
        }
    } catch (e) {
        console.error('AI 서버 시작 실패(무시하고 계속):', e.message);
    }
}
function stopAiServers() {
    for (const p of aiProcs) { try { p.kill(); } catch {} }
    aiProcs = [];
}

// 회사 공용 계정 로그인 시드:
// 개발 PC 에만 있는 data/defaults/* (네이버·ESM·아임웹 세션, 쿠팡 API키, 아임웹 설정)를
// 첫 실행 시 userData 로 복사한다. 이미 있으면(직원이 재로그인한 경우 등) 건드리지 않는다.
//
// 설치본에는 이 폴더를 일부러 넣지 않는다(package.json build.files 의 "!data/defaults/**").
// 설치파일 하나만 새어 나가도 전 플랫폼 계정이 같이 새기 때문 — 직원 PC 는 로그인 후
// 관리자 서버(/api/credentials)에서 인증키를 받는 게 정상 경로다.
// 그래서 폴더가 없는 것 자체는 오류가 아니지만, 예전처럼 말없이 return 하면
// "왜 아무 계정도 안 들어와 있지?" 를 추적할 단서가 로그에 하나도 안 남는다 → 반드시 남긴다.
function seedSharedDefaults() {
    try {
        const ud = app.getPath('userData');
        const defDir = path.join(__dirname, '..', 'data', 'defaults');
        if (!fs.existsSync(defDir)) {
            console.log('[시드] 번들된 공용 로그인 기본값 없음(설치본에서는 정상):', defDir);
            console.log('[시드] 인증키는 로그인 성공 후 관리자 서버에서 내려받습니다:', ADMIN_SERVER_URL || '(주소 미설정)');
            // server_keys.js 의 "로컬 모드로 계속" 으로 들어오면 이 다운로드가 아예 일어나지 않는다.
            console.log('[시드] "로컬 모드로 계속" 으로 시작하면 인증키가 하나도 없는 상태이므로, 각 플랫폼 탭에서 직접 입력해야 합니다.');
            return;
        }
        let copied = 0;
        for (const f of fs.readdirSync(defDir)) {
            const dest = path.join(ud, f);
            if (!fs.existsSync(dest)) {
                try { fs.copyFileSync(path.join(defDir, f), dest); copied++; }
                catch (e) { console.error('공용 로그인 시드 실패:', f, e.message); }
            }
        }
        console.log('[시드] 개발용 공용 로그인 기본값 적용:', copied, '건 복사 →', ud);
    } catch (e) { console.error('공용 로그인 시드 실패:', e.message); }
}

// ── 아임웹 Open API 키 경로 ──────────────────────────────────
// openapi/imweb_keys.js 는 electron 을 import 하지 않으므로 userData 경로를 알 수 없다.
// 여기서 환경변수로 넘겨준다. 설치본에서는 data/ 가 빌드에서 빠지고 설치 폴더도
// 쓰기 대상이 아니라, userData 에 두어야 앱 안에서 키를 입력·저장할 수 있다.
function setupImwebOpenApiConfig() {
    try {
        const dest = path.join(app.getPath('userData'), 'imweb_openapi_config.json');
        process.env.IMWEB_OPENAPI_CONFIG = dest;
        // 개발 환경에서 쓰던 data/ 파일이 있으면 최초 1회만 옮겨 심는다.
        if (!fs.existsSync(dest)) {
            const legacy = path.join(__dirname, '..', 'data', 'imweb_openapi_config.json');
            if (fs.existsSync(legacy)) {
                fs.copyFileSync(legacy, dest);
                console.log('[아임웹] Open API 키를 userData 로 옮겼습니다:', dest);
            }
        }
    } catch (e) {
        console.warn('[아임웹] Open API 키 경로 설정 실패:', e.message);
    }
}

// 폰트 등록
const fontPath = path.join(__dirname, '..', 'data', 'NEXON_Lv2_Gothic_Bold.ttf');
if (fs.existsSync(fontPath)) {
    GlobalFonts.registerFromPath(fontPath, 'NexonGothic');
}

/** 지금 살아 있는 앱 창들. */
function liveWindows() {
    return [upWindow, seedWindow, mapWindow, launcherWindow]
        .filter((w) => w && !w.isDestroyed());
}

/**
 * 열려 있는 모든 창으로 IPC 를 보낸다.
 * 창 하나를 콕 집지 않는 이유: 사용자가 베리씨드만 열었는지 베리업만 열었는지
 * 알 수 없고, 로그가 안 보이는 것보다 두 번 보이는 편이 낫다.
 * 렌더러가 해당 채널을 안 듣고 있으면 그냥 버려지므로 부작용이 없다.
 */
function sendToUI(channel, payload) {
    // 옛 채널('log' · 'imweb-log' · …)은 지금 화면이 듣지 않는다. veryup-log 로 번역해
    // 같이 보낸다 — 이게 없으면 창을 찾아도 화면에는 여전히 아무것도 안 뜬다.
    const translated = toVeryupLog(channel, payload);
    for (const w of liveWindows()) {
        try {
            w.webContents.send(channel, payload);
            if (translated) w.webContents.send(VERYUP_LOG_CHANNEL, translated);
        } catch { /* 닫히는 중인 창 */ }
    }
}

/** 모달 대화상자의 부모로 쓸 창. 없으면 null(자유 위치 대화상자)이어도 동작한다. */
function dialogParent() {
    return BrowserWindow.getFocusedWindow() || liveWindows()[0] || null;
}
let launcherWindow;
let seedWindow;
let upWindow;
let mapWindow;
let browser;

// ── Coupang instance (API-based, no browser needed) ──
let coupangInstance = null;
// 쿠팡만 AWS 고정 IP 프록시를 사용한다. 다른 쇼핑몰은 PC에서 직접 호출한다.
// 직원 토큰은 메모리에만 보관한다. USE_SERVER_PROXY=0이면 쿠팡도 직접 호출한다.
function getRuntimeProxy(platform) {
    return resolveRuntimeProxy({ platform, baseUrl: ADMIN_SERVER_URL, token: serverAuth?.token });
}

function getCoupang() {
    if (!coupangInstance) {
        const configPath = path.join(app.getPath('userData'), 'coupang_config.json');
        
        // Copy default config if user config doesn't exist
        if (!fs.existsSync(configPath)) {
            const defaultConfig = path.join(__dirname, '..', 'data', 'coupang_config.json');
            if (fs.existsSync(defaultConfig)) {
                fs.copyFileSync(defaultConfig, configPath);
            } else {
                // Write minimal default
                fs.writeFileSync(configPath, JSON.stringify({
                    vendorId: '', accessKey: '', secretKey: '',
                    outboundShippingPlaceCode: '', returnCenterCode: '',
                    deliveryChargeType: 'FREE', deliveryCharge: 0,
                    deliveryCompanyCode: 'CJGLS', deliveryMethod: 'SEQUENCIAL',
                    brand: '옵틱글래스', displayCategoryCode: null,
                    returnCharge: 5000,
                    afterServiceInformation: '옵틱글래스 A/S 센터',
                    afterServiceContactNumber: ''
                }, null, 2), 'utf-8');
            }
        }
        // 옵션 판매가 로컬 캐시(coupang_prices_cache.json) — 상품 일괄 수정 목록의 '(목록)' 판매가. 아마존·eBay 의 목록 캐시와 같은 자리.
        coupangInstance = new Coupang(configPath, new CoupangStore(app.getPath('userData')));
    }
    coupangInstance.runtimeProxy = getRuntimeProxy('coupang');
    return coupangInstance;
}

// ── Amazon instance (API-based, no browser needed) ──
let amazonInstance = null;
function getAmazon() {
    if (!amazonInstance) {
        const configPath = path.join(app.getPath('userData'), 'amazon_config.json');

        // Copy default config if user config doesn't exist
        if (!fs.existsSync(configPath)) {
            const defaultConfig = path.join(__dirname, '..', 'data', 'amazon_config.json');
            if (fs.existsSync(defaultConfig)) {
                fs.copyFileSync(defaultConfig, configPath);
            } else {
                fs.writeFileSync(configPath, JSON.stringify({
                    sellerId: '', clientId: '', clientSecret: '', refreshToken: '',
                    endpoint: 'https://sellingpartnerapi-na.amazon.com',
                    marketplaceId: 'ATVPDKIKX0DER',
                    productType: 'AUTO_PART',
                    brand: 'Optic Glass', manufacturer: 'Optic Glass',
                    currency: 'USD'
                }, null, 2), 'utf-8');
            }
        }
        amazonInstance = new Amazon(configPath, new AmazonStore(app.getPath('userData')));
    }
    amazonInstance.runtimeProxy = getRuntimeProxy('amazon');
    return amazonInstance;
}

// ── eBay instance (singleton) ──
let ebayInstance = null;
function getEbay() {
    if (!ebayInstance) {
        ebayInstance = new Ebay(new EbayStore(app.getPath('userData'), safeStorage));
    }
    ebayInstance.runtimeProxy = getRuntimeProxy('ebay');
    return ebayInstance;
}

// ── Imweb instance (singleton) ──
let imwebInstance = null;
function getImweb() {
    if (!imwebInstance) {
        const configPath = path.join(app.getPath('userData'), 'imweb_config.json');
        
        if (!fs.existsSync(configPath)) {
            fs.writeFileSync(configPath, JSON.stringify({
                b2bUrl: 'https://bbstore37.imweb.me/admin/',
                b2bId: '',
                headUrl: 'https://optic-glass.imweb.me/admin',
                headId: '',
                usUrl: 'https://optic-glass-us.imweb.me/admin',
                usId: ''
            }, null, 2), 'utf-8');
        }
        
        // ImwebEdit 는 Imweb(게시판 · 로그인)을 상속하고, B2B몰 상품은 아임웹 Open API(imweb_b2b.js)로 한다.
        // B2B 쪽은 브라우저를 쓰지 않는다. 진행 로그는 그때그때의 logCallback 으로 간다.
        imwebInstance = new ImwebEdit(configPath, getBrowserSync);
        imwebInstance.b2b = createB2bApi(getImwebApiClient(B2B_SITE_CODE), { log: msg => imwebInstance.log(msg) });
    }
    // 서버에서 받은 아임웹 로그인정보(있으면)를 붙여준다 → login()에서 자동입력에 사용
    imwebInstance.autoLogin = serverCreds['imweb'] || null;
    // 진행 로그를 UI 로 보낸다. 예전에는 getImwebEdit() 쪽에만 붙어 있어서,
    // 같은 아임웹 작업이라도 어느 게터로 들어왔느냐에 따라 로그가 보이다 말다 했다.
    imwebInstance.logCallback = (msg) => {
        sendToUI('imweb-log', msg);
    };
    return imwebInstance;
}

// ── 신규 등록 중복 예외 (utils/duplicate_guard.js) ─────────────────
// 네이버·쿠팡·아임웹은 등록할 때마다 새 상품을 만들고, 아마존은 같은 SKU 를 덮어쓴다.
// 각 *-register 핸들러가 등록 전에 판정하고, 성공하면 원장에 적는다(다음 판정용).
// 원장은 userData 에 둔다 — data/ 는 배포본을 덮어쓸 때 같이 지워진다.
let registrationLedger = null;
function getRegistrationLedger() {
    if (!registrationLedger) registrationLedger = new RegistrationLedger(app.getPath('userData'));
    return registrationLedger;
}
// 같은 상품 등록이 동시에 두 번 들어오면(버튼 연타·창 두 개) 둘 다 '아직 없음'으로 판정된다.
const registerInflight = createInflightLock();
// 쿠팡 스냅샷(vehicle_catalog.json). 파일이 바뀌었을 때만 다시 읽는다.
let guardCatalogCache = { mtimeMs: -1, data: null };
function loadGuardCatalog() {
    const p = path.join(__dirname, '..', 'data', 'vehicle_catalog.json');
    try {
        const st = fs.statSync(p);
        if (st.mtimeMs !== guardCatalogCache.mtimeMs) {
            guardCatalogCache = { mtimeMs: st.mtimeMs, data: JSON.parse(fs.readFileSync(p, 'utf-8')) };
        }
    } catch (e) {
        // 스냅샷이 없어도 원장·실시간 조회로 판정한다.
        console.warn(`[중복검사] 차량 카탈로그를 읽지 못함 — 스냅샷 판정 생략: ${e.message}`);
        guardCatalogCache = { mtimeMs: -1, data: null };
    }
    return guardCatalogCache.data;
}
function guardBrands(catalog = loadGuardCatalog()) {
    return brandsFromCatalog(catalog);
}

// ── 플랫폼 인스턴스 (싱글턴) ──────────────────────────────────
// 생성자에 Browser 객체가 아니라 getBrowserSync '함수'를 넘긴다.
// BasePlatform 의 browser 게터가 매번 이 함수를 불러 현재 브라우저를 읽으므로,
// 예전처럼 핸들러마다 `instance.browser = browser` 를 다시 꽂을 필요가 없다.
// (그 수동 패치가 8군데 있었고, 새 핸들러에서 한 줄만 빠뜨려도 조용히 죽는 구조였다)

// ── ESM instance (singleton) ──
let esmInstance = null;
function getESM() {
    if (!esmInstance) {
        const sessionPath = path.join(app.getPath('userData'), 'session_esmplus.json');
        esmInstance = new ESMPlusHosting(getBrowserSync, sessionPath);
    }
    esmInstance.autoLogin = serverCreds['esm'] || null;
    return esmInstance;
}

// ── Naver instance (singleton) ──
let naverInstance = null;
function getNaver() {
    if (!naverInstance) {
        const sessionPath = path.join(app.getPath('userData'), 'session_naver.json');
        naverInstance = new NaverSmartStore(getBrowserSync, sessionPath);
    }
    naverInstance.autoLogin = serverCreds['naver'] || null;
    return naverInstance;
}

// ── Naver 커머스API (공식 API) ────────────────────────────────
// 기존 상품 조회·수정은 커머스API만 사용한다. 실패해도 브라우저로 전환하지 않는다.
const USE_NAVER_API = process.env.USE_NAVER_API !== '0';
// 시작 시 한 줄로 어느 코드가 로드됐는지 못 박는다. 이 줄이 없으면 옛 빌드다.
console.log('[네이버] 커머스API 경로 적용됨 — '
    + `USE_NAVER_API=${USE_NAVER_API ? '켜짐' : '꺼짐'}, `
    + `자격증명=${(process.env.NAVER_CLIENT_ID || '').trim() && (process.env.NAVER_CLIENT_SECRET || '').trim() ? '있음' : '없음'}, `
    + '기존 상품 조회·수정: API 전용');
let naverApiInstance = null;
let naverApiKey = '';
function getNaverAPI() {
    const store = new NaverStore(app.getPath('userData'), safeStorage);
    const saved = store.config();
    // 저장된 설정이 비어 있으면 환경변수로 동작한다(설정 UI 가 붙기 전 검증용).
    const config = {
        clientId: saved.clientId || (process.env.NAVER_CLIENT_ID || '').trim(),
        clientSecret: saved.clientSecret || (process.env.NAVER_CLIENT_SECRET || '').trim(),
        accountId: saved.accountId || (process.env.NAVER_ACCOUNT_ID || '').trim(),
        type: saved.type || 'SELF'
    };
    if (!config.clientId || !config.clientSecret) return null;
    const proxy = getRuntimeProxy('naver') || {};
    const key = JSON.stringify([config, proxy]);
    if (key !== naverApiKey) { naverApiInstance = new NaverAPI(config, { proxy }); naverApiKey = key; }
    return naverApiInstance;
}

function requireNaverAPI() {
    if (!USE_NAVER_API) {
        throw new Error('네이버 기존 상품 조회·수정에는 커머스API가 필요합니다. USE_NAVER_API=0 설정을 해제하고 앱을 다시 실행해주세요.');
    }
    const api = getNaverAPI();
    if (!api) {
        throw new Error('네이버 커머스API 인증정보가 없습니다. NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 설정을 확인해주세요.');
    }
    return api;
}

async function naverApiRead(label, work, log) {
    const api = requireNaverAPI();
    log?.(`커머스API로 ${label} 시도… (${api.proxyUrl ? `프록시 경유 ${api.proxyUrl}` : '직접 호출 — 이 PC 의 IP 가 네이버 허용목록에 있어야 함'})`);
    const result = await work(api);
    log?.(`커머스API로 ${label} 완료 (브라우저 미사용)`);
    return result;
}

const naverProductEditors = new WeakMap();
function getNaverProducts() {
    const api = requireNaverAPI();
    if (!naverProductEditors.has(api)) naverProductEditors.set(api, new NaverProducts(api));
    return naverProductEditors.get(api);
}

// Synchronous browser getter (returns existing or null)
function getBrowserSync() {
    return browser;
}

// 창 4개가 모두 nodeIntegration 이라, 앱 화면(src/ui) 밖 페이지로 넘어가면 그 페이지가 Node 권한을 얻는다 —
// 링크나 파일을 창에 끌어다 놓기만 해도 그렇다. 화면 밖으로의 이동과 새 창 열기를 막는다.
// 외부 페이지는 open-external(shell.openExternal)로만 연다.
const UI_URL = pathToFileURL(path.join(__dirname, 'ui')).href + '/';
app.on('web-contents-created', (_, contents) => {
    const block = e => { if (!String(e.url || '').startsWith(UI_URL)) e.preventDefault(); };
    contents.on('will-navigate', block);
    contents.on('will-frame-navigate', block);
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
});

function createLauncher() {
    const win = new BrowserWindow({
        width: 680, height: 560, resizable: false, frame: false,
        webPreferences: { nodeIntegration: true, contextIsolation: false },
        title: 'VERY UP VER3',
    });
    launcherWindow = win;
    win.on('closed', () => { if (launcherWindow === win) launcherWindow = null; });
    win.loadFile(path.join(__dirname, 'ui/launcher.html'));
}

// VERY UP·VERY SEED 는 열릴 때 런처를 숨기기만 한다(hide). 그 창을 ✕(또는 Alt+F4)로 닫고 나면
// 남는 건 숨은 런처뿐인데, Electron 은 숨은 창도 열린 창으로 쳐서 window-all-closed 를 보내지
// 않는다 — 화면에 아무것도 없는데 프로세스·자동화 Edge·AI 서버가 남고, '나중에' 로 미룬 업데이트도
// 설치되지 않았다. 그래서 앱 창이 닫힐 때 남은 게 숨은 런처뿐이면 런처도 닫아 정상 종료 경로
// (window-all-closed → 브라우저 정리 → stopAiServers → app.quit)를 타게 한다.
// '← 런처로'(close-app)는 창을 닫으면서 곧바로 런처를 보여 주므로 여기서 닫히지 않는다
// ('closed' 는 닫기가 끝난 뒤에 오고, 그때 런처는 이미 보이는 상태다).
function closeHiddenLauncherIfLast() {
    if (!launcherWindow || launcherWindow.isDestroyed() || launcherWindow.isVisible()) return;
    const others = BrowserWindow.getAllWindows().filter(w => w !== launcherWindow && !w.isDestroyed());
    if (!others.length) launcherWindow.close();
}
function createSeedWindow() {
    seedWindow = new BrowserWindow({
        // 폼은 980px 컬럼 하나뿐이다. 1400x900 은 아래·오른쪽을 그냥 비워 둘 뿐이었다.
        width: 1120, height: 760, minWidth: 940, minHeight: 620, frame: false,
        webPreferences: { nodeIntegration: true, contextIsolation: false },
        title: 'VERY SEED',
    });
    seedWindow.loadFile(path.join(__dirname, 'ui/index_seed.html'));
    const win = seedWindow;
    win.on('closed', () => { if (seedWindow === win) seedWindow = null; closeHiddenLauncherIfLast(); });
    if (launcherWindow) launcherWindow.hide();
}
let upWindowMode = 'new'; // 'new' | 'edit'

function setUpWindowMode(mode) {
    upWindowMode = mode === 'edit' ? 'edit' : 'new';
    if (upWindow && !upWindow.isDestroyed()) {
        upWindow.webContents.send('veryup-set-mode', upWindowMode);
    }
}

function createUpWindow(mode = 'new') {
    setUpWindowMode(mode);
    upWindow = new BrowserWindow({
        // 현황판(좌측 380px)만 보이는 접힌 화면으로 뜬다. '열기' 를 누르면 화면이 1200 으로 넓히며
        // 쇼핑몰 탭·신규등록 패널을 펼친다(index_up.html setPanels). 이 폭·minWidth 는
        // index_up.html 의 PANELS_COLLAPSED_WIDTH 와 같아야 한다 — 작으면 입력판이 잘린다.
        width: 400, height: 850, minWidth: 400, minHeight: 640, resizable: true, frame: false,
        // nodeIntegrationInSubframes: iframe(index.html)의 등록 폼도 IPC 쓰게
        webPreferences: { nodeIntegration: true, contextIsolation: false, nodeIntegrationInSubframes: true },
        title: 'VERY UP',
    });
    upWindow.loadFile(path.join(__dirname, 'ui/index_up.html'), {
        query: { mode: upWindowMode, panels: 'collapsed' }
    });
    const win = upWindow;
    win.webContents.on('did-finish-load', () => {
        win.webContents.send('veryup-set-mode', upWindowMode);
    });
    win.on('closed', () => { if (upWindow === win) upWindow = null; closeHiddenLauncherIfLast(); });
    if (launcherWindow) launcherWindow.hide();
}
// 베리맵: 코드표 ↔ 채널 대조. 창이 scripts/verimap_*.mjs 를 자식 프로세스로 띄우므로 nodeIntegration 이 필요하다.
function createMapWindow() {
    mapWindow = new BrowserWindow({
        width: 1100, height: 780, minWidth: 820, minHeight: 600, resizable: true, frame: false,
        webPreferences: { nodeIntegration: true, contextIsolation: false },
        title: 'VERY MAP',
    });
    mapWindow.loadFile(path.join(__dirname, 'ui/index_verimap.html'));
    const win = mapWindow;
    win.on('closed', () => { if (mapWindow === win) mapWindow = null; closeHiddenLauncherIfLast(); });
    if (launcherWindow) launcherWindow.hide();
}
function createWindow() { createLauncher(); }

// ── 서버 로그인 + 인증키 동기화 ──────────────────────────────
// 로그인한 직원만 서버에서 인증키를 받아, 앱이 읽는 로컬 설정파일에 병합한다.
// 서버가 없거나 실패해도 앱이 죽지 않도록 try/catch (기존 로컬 설정 사용).
function mergeIntoConfig(filename, data) {
    try {
        const p = path.join(app.getPath('userData'), filename);
        let cur = {};
        if (fs.existsSync(p)) { try { cur = JSON.parse(fs.readFileSync(p, 'utf-8')); } catch {} }
        const merged = { ...cur, ...data };
        fs.writeFileSync(p, JSON.stringify(filename === 'amazon_config.json' ? cleanAmazonConfig(merged) : merged, null, 2), 'utf-8');
    } catch (e) { console.warn('설정 병합 실패:', filename, e.message); }
}
// 이베이는 clientSecret·refreshToken 을 평문 JSON 이 아니라 OS 암호화 저장소(safeStorage)에
// 넣어 보관한다. 그래서 mergeIntoConfig 로 파일을 덮어쓰면 앱이 읽지 못한다 →
// 반드시 EbayStore.save() 를 거쳐서 같은 형식으로 다시 저장한다.
function applyEbayCredentials(data) {
    try {
        const input = {};
        for (const f of ['environment', 'clientId', 'ruName', 'merchantLocationKey',
                         'fulfillmentPolicyId', 'paymentPolicyId', 'returnPolicyId',
                         'clientSecret', 'refreshToken']) {
            // 서버가 빈 값을 내려도 로컬 설정(특히 ruName)을 지우지 않는다.
            if (data[f] !== undefined && data[f] !== null && String(data[f]).trim() !== '') input[f] = String(data[f]);
        }
        getEbay().saveConfig(input);
    } catch (e) { console.warn('설정 병합 실패: ebay_config.json', e.message); }
}
// 서버에서 받아올 플랫폼 목록.
// 새 서버(/api/credentials)는 platform 쿼리 파라미터를 **필수**로 요구한다 —
// 예전처럼 인자 없이 부르면 전량 덤프가 아니라 HTTP 400 이 오고, 아래 catch 가
// 그것을 조용히 삼켜 전 직원이 디스크에 남은 옛 키로 돌게 된다.
// 그래서 플랫폼을 하나씩 명시해 받는다. (server/app.py 의 PLATFORM_TEMPLATES 와 맞춘다)
const SYNC_PLATFORMS = ['coupang', 'naver', 'esm', 'imweb', 'ebay', 'amazon', 'papago'];

// 네이버 커머스API 자격증명을 서버에서 받아 safeStorage 저장소에 넣는다.
// eBay 와 같은 이유로 mergeIntoConfig 를 쓰지 않는다 — clientSecret 은 평문 JSON 이 아니라
// OS 암호화 저장소에 들어가야 하므로 NaverStore.save() 를 거쳐야 한다.
function applyNaverCredentials(data) {
    try {
        const input = {};
        for (const f of ['clientId', 'clientSecret', 'type', 'accountId']) {
            // 빈 값은 '변경 없음'으로 본다. 서버 템플릿의 빈 칸이 저장된 값을 지우면 안 된다.
            if (data[f] !== undefined && data[f] !== null && String(data[f]).trim() !== '') input[f] = String(data[f]);
        }
        if (!input.clientId && !input.clientSecret) return false;
        new NaverStore(app.getPath('userData'), safeStorage).save(input);
        naverApiKey = '';   // 다음 호출에서 새 자격증명으로 인스턴스를 다시 만들게 한다
        return true;
    } catch (e) {
        console.warn('설정 병합 실패: naver_config.json', e.message);
        return false;
    }
}

async function syncCredentialsFromServer() {
    if (!serverAuth) return;
    try {
        // 한 플랫폼이 실패해도(권한 없음·미등록) 나머지는 받는다.
        // role='staff' 는 STAFF_PLATFORMS 밖 플랫폼에 403 을 받는데, 그건 정상 동작이다.
        const settled = await Promise.all(SYNC_PLATFORMS.map(async (p) => {
            try {
                return await fetchCredentials(ADMIN_SERVER_URL, serverAuth.token, p);
            } catch (e) {
                console.warn(`[서버] ${p} 인증키 조회 건너뜀:`, e.message);
                return [];
            }
        }));
        const creds = settled.flat();
        serverCreds = {};
        let n = 0;
        for (const c of creds) {
            if (!c.data) continue;
            if (c.data.loginId) {
                // 로그인(아이디/비번) 종류 → 브라우저 로그인 자동입력용으로 메모리에 보관
                serverCreds[c.platform] = c.data; n++;
            } else if (c.platform === 'coupang') {
                mergeIntoConfig('coupang_config.json', c.data); n++;
            } else if (c.platform === 'amazon') {
                mergeIntoConfig('amazon_config.json', c.data); n++;
            } else if (c.platform === 'ebay') {
                applyEbayCredentials(c.data); n++;
            } else if (c.platform === 'naver') {
                // 네이버 로그인(아이디/비번)은 위 loginId 분기가 이미 가져갔다. 여기 오는 건
                // 커머스API 키뿐이다. 두 종류가 같은 플랫폼 이름으로 공존한다.
                if (applyNaverCredentials(c.data)) n++;
            } else if (c.platform === 'imweb') {
                // 서버 템플릿은 OAuth clientId · clientSecret 이다. 그 둘은 Open API 키 파일의 전용 칸으로
                // 보낸다 — imweb_config.json(브라우저 자동화 설정)에 섞으면 OAuth 요청이 읽지 못한다.
                // 빈 값은 '변경 없음'으로 본다(서버 템플릿의 빈 칸이 저장된 값을 지우면 안 된다).
                const { clientId, clientSecret, ...rest } = c.data;
                const oauth = {};
                if (String(clientId ?? '').trim()) oauth.clientId = String(clientId).trim();
                if (String(clientSecret ?? '').trim()) oauth.clientSecret = String(clientSecret).trim();
                if (Object.keys(oauth).length) oaSaveConfig(oauth);
                if (Object.keys(rest).length) mergeIntoConfig('imweb_config.json', rest);
                n++;
            } else if (c.platform === 'papago') {
                serverCreds['papago'] = c.data; n++;
            }
        }
        console.log('[서버] 인증키 동기화 완료:', n, '건 (로그인정보 보유 플랫폼:', Object.keys(serverCreds).join(',') || '없음', ')');
    } catch (e) {
        console.warn('[서버] 인증키 동기화 실패(로컬 설정 사용):', e.message);
    }
}
ipcMain.handle('server-login', async (event, { username, password }) => {
    try {
        serverAuth = await serverLogin(ADMIN_SERVER_URL, username, password);
        localMode = false;
        await syncCredentialsFromServer();
        return { ok: true, name: serverAuth.name, role: serverAuth.role };
    } catch (e) {
        serverAuth = null;
        // offline: 서버에 닿지 못한 경우만 true. 비번이 틀린 경우는 false 라서
        // 런처가 '로컬 모드로 계속' 버튼을 띄우지 않는다.
        return { ok: false, error: e.message, offline: !!e.offline };
    }
});

// ── 로컬 모드 ────────────────────────────────────────────────
// 관리자 서버 없이 각 PC 의 설정 파일만으로 동작하는 모드.
// 서버가 인증키를 못 내려주므로 각 플랫폼 탭에서 직접 입력한 값을 쓴다.
// (로그인 관문은 원래 렌더러에만 있어 보안 경계가 아니었다 — 여기서 잃는 보호는 없다.)
let localMode = false;

// 아예 서버를 안 쓰는 배포: ADMIN_SERVER_URL 을 비우거나 VERYUP_LOCAL_ONLY=1 로 둔다.
const LOCAL_ONLY = process.env.VERYUP_LOCAL_ONLY === '1' || !ADMIN_SERVER_URL;

ipcMain.handle('server-mode', () => ({
    // loginRequired=false 면 런처가 로그인 화면을 아예 띄우지 않는다.
    loginRequired: !LOCAL_ONLY,
    adminServer: ADMIN_SERVER_URL || null,
    localMode,
}));

// 런처의 "서버 열기". 주소를 렌더러에서 받지 않고 여기서 만든다 —
// 렌더러가 임의 URL 을 넘길 수 있게 하면 openExternal 이 아무 프로그램이나 여는 통로가 된다.
ipcMain.handle('open-admin-server', async () => {
    if (!ADMIN_SERVER_URL) return { ok: false, error: '관리자 서버 주소가 설정되어 있지 않습니다.' };
    const url = `${ADMIN_SERVER_URL}/login`;
    try {
        await shell.openExternal(url);
        return { ok: true, url };
    } catch (error) {
        return { ok: false, error: `브라우저를 열지 못했습니다: ${error.message}` };
    }
});

// 판매자 콘솔 열기 — **올라간 상품을 눈으로 확인하는 용도뿐이다.**
// 등록·수정은 API(쿠팡·아마존·이베이) 나 자동화 경로(네이버·아임웹)로 돌고,
// 여기서 여는 창은 그 경로에 전혀 끼어들지 않는다.
//
// 기본 브라우저(shell.openExternal) 대신 앱이 띄우는 Edge 를 쓴다. 기본 브라우저는
// 매번 로그인 상태가 제각각이라, 저장된 계정으로 자동 로그인해 줄 수가 없다.
// 콘솔 세션은 플랫폼마다 따로 저장되므로 두 번째부터는 바로 목록이 뜬다.
//
// open-admin-server 와 같은 이유로 URL 은 렌더러에서 받지 않는다(임의 주소 실행 통로가 된다).
const SELLER_SITES = {
    coupang: 'https://wing.coupang.com',
    ebay:    'https://www.ebay.com/sh/lst/active',
    naver:   'https://sell.smartstore.naver.com/#/products/origin-list',
    esm:     'https://www.esmplus.com',
    imweb:   'https://bbstore37.imweb.me/admin/shopping/product'
};

// 콘솔 창은 자동화 컨텍스트와 **분리한다.** 같은 컨텍스트를 쓰면 등록이 도는 중에
// 이 창이 같은 탭을 끌고 가 버린다 — getImwebEdit() 주석에 적힌 바로 그 사고다.
class SellerConsole extends BasePlatform {
    constructor(browserGetter, sessionPath, name) {
        super(browserGetter, sessionPath);
        this._name = name;
    }
    get platformName() { return `console-${this._name}`; }
}

const sellerConsoles = {};
function getSellerConsole(platform) {
    if (!sellerConsoles[platform]) {
        const sessionPath = path.join(app.getPath('userData'), `session_console_${platform}.json`);
        sellerConsoles[platform] = new SellerConsole(getBrowserSync, sessionPath, platform);
    }
    return sellerConsoles[platform];
}

// 로그인 폼이 보이면 서버에서 받아둔 계정을 채워 넣는다. 캡차·2단계 인증이 걸리면
// 그대로 두고 사람이 이어서 처리하게 한다 — 조회용이라 실패해도 잃는 게 없다.
async function fillConsoleLogin(page, creds) {
    if (!(creds && creds.loginId && creds.password)) return false;
    try {
        const pw = page.locator('input[type="password"]:visible').first();
        await pw.waitFor({ timeout: 6000 });
        const id = page.locator('input[type="text"]:visible, input[type="email"]:visible').first();
        if (await id.count()) await id.fill(creds.loginId);
        await pw.fill(creds.password);
        await page.keyboard.press('Enter');
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        return true;
    } catch (e) {
        console.log(`[판매자콘솔] 자동 로그인 입력 실패 → 수동으로 진행: ${e.message}`);
        return false;
    }
}

// 같은 버튼을 연달아 누르면 창 두 개가 서로 같은 URL 로 이동한다 → 한 번에 하나만.
let sellerConsoleBusy = false;

function amazonSellerCentralUrl() {
    // 마켓플레이스마다 콘솔 주소가 다르다. 미국 주소로 일본 상품을 찾으면 '내 상품이 없다' 로 보인다.
    let marketplaceId = 'ATVPDKIKX0DER';
    try {
        const p = path.join(app.getPath('userData'), 'amazon_config.json');
        if (fs.existsSync(p)) {
            marketplaceId = JSON.parse(fs.readFileSync(p, 'utf-8')).marketplaceId || marketplaceId;
        }
    } catch (e) { /* 설정을 못 읽어도 기본값으로 연다 */ }
    return marketplaceId === 'A1VC38T7YXB528'
        ? 'https://sellercentral.amazon.co.jp'
        : 'https://sellercentral.amazon.com';
}

ipcMain.handle('open-seller-site', async (event, platform) => {
    const url = platform === 'amazon'
        ? `${amazonSellerCentralUrl()}/inventory`
        : SELLER_SITES[platform];
    if (!url) return { ok: false, error: `알 수 없는 플랫폼입니다: ${platform}` };
    if (sellerConsoleBusy) return { ok: false, error: '판매자 콘솔을 여는 중입니다. 잠시만 기다려주세요.' };

    sellerConsoleBusy = true;
    try {
        await getBrowser();

        // 네이버·ESM·아임웹은 각자 로그인 절차가 따로 있다. 네이버는 '네이버 아이디로 로그인'
        // 이 새 팝업으로 열려서 일반적인 폼 자동입력으로는 잡히지 않고, 아임웹은 관리자 URL 로
        // 바로 들어가 봐야 세션이 살아 있는지 알 수 있다. 그래서 각자의 로그인을 그대로 쓴다
        // — 예전 '네이버 로그인' 버튼이 하던 일과 같다.
        if (platform === 'naver') {
            const ok = await getNaver().login();   // 로그인 후 상품목록까지 이동한다
            return ok ? { ok: true, url } : { ok: false, error: '네이버 로그인을 완료하지 못했습니다.' };
        }
        if (platform === 'esm') {
            const ok = await getESM().login();
            return ok ? { ok: true, url } : { ok: false, error: 'ESM 로그인을 완료하지 못했습니다.' };
        }
        if (platform === 'imweb') {
            const imweb = getImweb();
            await imweb.initBrowserSession();
            await imweb.openAdminAt(url, '/admin/shopping/');  // 세션 만료면 안에서 자동 로그인
            return { ok: true, url };
        }

        const console_ = getSellerConsole(platform);
        await console_.init(true, { width: 1600, height: 950 });
        await console_.page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});

        // 로그인 화면으로 튕겼으면 저장된 계정으로 채워 본다.
        const hasPasswordField = await console_.page
            .locator('input[type="password"]:visible').count().catch(() => 0);
        if (hasPasswordField) {
            const filled = await fillConsoleLogin(console_.page, serverCreds[platform]);
            if (filled) await console_.page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
        }

        // 다음에 열 때 로그인을 건너뛰도록 남긴다. 실패해도 조회에는 지장이 없다.
        await console_.saveSession().catch(() => {});
        return { ok: true, url };
    } catch (error) {
        // 자동화 브라우저를 못 띄우는 PC 도 있다(Edge 없음 등) → 기본 브라우저로 물러선다.
        console.error('[판매자콘솔]', error);
        try {
            await shell.openExternal(url);
            return { ok: true, url, fallback: true };
        } catch (e2) {
            return { ok: false, error: `브라우저를 열지 못했습니다: ${error.message}` };
        }
    } finally {
        sellerConsoleBusy = false;
    }
});

ipcMain.handle('enter-local-mode', () => {
    localMode = true;
    serverAuth = null;
    serverCreds = {};
    console.log('[모드] 로컬 모드로 시작합니다 — 서버 인증키 없이 로컬 설정 파일을 사용합니다.');
    // 설치본에는 번들된 공용 로그인(data/defaults/*)이 없다 → 로컬 모드로 들어오면 인증키가 0건일 수 있다.
    // 나중에 "로그인 실패"만 뜨면 원인을 짚기 어려우니, 그 사실을 이 시점에 로그로 남겨둔다.
    if (app.isPackaged) console.log('[모드] 설치본에는 번들 인증키가 없습니다 — 각 플랫폼 탭에서 인증키를 직접 입력하세요.');
    return { ok: true };
});

// AI 이미지 1건 처리할 때마다 서버에 사용량 보고 (실패해도 무시 — 앱 동작에 영향 없음)
async function reportAiUsage(endpoint, ms) {
    if (!serverAuth) return;
    try {
        await fetch(`${ADMIN_SERVER_URL}/api/usage`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${serverAuth.token}` },
            body: new URLSearchParams({ endpoint, ms_elapsed: String(Math.round(ms || 0)) }),
        });
    } catch {}
}

ipcMain.on('launch-app', (event, appName, mode = 'new') => {
    if (appName === 'seed') createSeedWindow();
    else if (appName === 'up') createUpWindow(mode);
    else if (appName === 'map') createMapWindow();
});

ipcMain.handle('veryup-get-mode', () => upWindowMode);
ipcMain.on('veryup-set-mode', (event, mode) => {
    setUpWindowMode(mode);
});

ipcMain.on('close-app', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) win.close();
    if (launcherWindow && !launcherWindow.isDestroyed()) launcherWindow.show(); else createLauncher();
});

// 커스텀 윈도우 컨트롤 (최소화 / 닫기)
ipcMain.on('minimize-win', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) win.minimize();
});
ipcMain.on('close-win', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) win.close();
});
ipcMain.on('veryup-resize-window', (event, { width, height }) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
        const [curW, curH] = win.getSize();
        win.setSize(width || curW, height || curH, true);
    }
});

// ── 자동 업데이트 ────────────────────────────────────────────────
// 클라우드 스토리지(정적 HTTP)에 올린 latest.yml / 설치파일 / .blockmap 을 보고
// 새 버전이 있으면 백그라운드로 받은 뒤, 다 받으면 사용자에게 "지금 설치" 를 물어본다.
// (개발 중에는 동작 안 함 — 설치본에서만 동작)
function setupAutoUpdate() {
    if (!app.isPackaged) return;
    try {
        const { autoUpdater } = electronUpdater;
        autoUpdater.autoDownload = true;
        // 설치본에 코드 서명이 없어 electron-updater 가 서명을 검사하지 않는다 → 종료할 때 말없이 깔지 않고,
        // 사람이 '지금 재시작하여 설치' 를 눌렀을 때만 깐다. 서명을 붙이면(build.win.publisherName) 다시 켜도 된다.
        autoUpdater.autoInstallOnAppQuit = false;
        // 서버(server/public.py)가 UPDATE_TOKEN 을 켜면 /updates/* 는 X-Update-Token 헤더를 요구한다.
        // 클라이언트가 안 보내면 전 직원 업데이트가 401 로 조용히 끊기고(로그 한 줄만 스쳐 지나감)
        // 새 버전이 영영 안 깔린다 → 양쪽 값이 반드시 같아야 한다.
        // 토큰을 안 쓰는 배포에서는 환경변수가 없으므로 헤더도 안 붙는다(기존과 동일).
        // 토큰은 userData/veryup.env 에서 온다(loadUserEnv). 설치본에는 환경변수를 넣을
        // 자리가 없어서, 예전에는 이 값이 언제나 undefined 였다 → 서버가 토큰을 켜는 순간
        // 전 직원이 401 을 받고 원인 표시도 없었다. 없으면 없다고 말하게 한다.
        const updateToken = process.env.UPDATE_TOKEN;
        if (updateToken) {
            autoUpdater.requestHeaders = { 'X-Update-Token': updateToken };
        } else {
            console.warn('[업데이트] UPDATE_TOKEN 이 없습니다. 서버가 토큰을 요구하면 404/401 로 끊깁니다. '
                + `설정 파일: ${path.join(app.getPath('userData'), 'veryup.env')}`);
        }
        const notify = (msg) => { try { sendToUI('log', `[업데이트] ${msg}`); } catch {} };

        autoUpdater.on('checking-for-update', () => notify('새 버전 확인 중...'));
        autoUpdater.on('update-available', (info) => notify(`새 버전 ${info?.version} 발견 — 백그라운드 다운로드 시작`));
        autoUpdater.on('update-not-available', () => notify('최신 버전입니다.'));
        autoUpdater.on('download-progress', (p) => notify(`다운로드 ${Math.round(p.percent)}%`));
        autoUpdater.on('error', (err) => notify(`업데이트 오류: ${err?.message || err}`));
        autoUpdater.on('update-downloaded', async (info) => {
            notify(`새 버전 ${info?.version} 다운로드 완료`);
            const { response } = await dialog.showMessageBox({
                type: 'info',
                buttons: ['지금 재시작하여 설치', '나중에'],
                defaultId: 0,
                cancelId: 1,
                title: '업데이트 준비 완료',
                message: `새 버전 ${info?.version} 이 준비되었습니다.`,
                detail: '지금 재시작하면 업데이트가 적용됩니다. "나중에" 를 누르면 다음 실행 때 다시 묻습니다.',
            });
            if (response === 0) { stopAiServers(); autoUpdater.quitAndInstall(); }
        });

        autoUpdater.checkForUpdates().catch((e) => notify(`업데이트 확인 실패: ${e?.message || e}`));
    } catch (e) {
        console.error('자동 업데이트 설정 실패:', e?.message || e);
    }
}

app.whenReady().then(() => {
  // 런처 먼저 즉시 열기
  createWindow();

  // 무거운 작업은 UI가 뜬 후 백그라운드에서 실행
  setImmediate(() => {
    seedSharedDefaults();
    setupImwebOpenApiConfig();
    startAiServers();
    setupAutoUpdate();
  });
});

app.on('before-quit', () => { stopAiServers(); });

app.on('window-all-closed', async () => {
  // 정리 중 무엇이 실패하든 종료는 해야 한다. 예전에는 선언되지 않은 변수에 대입하는 줄이
  // (ES 모듈이라 엄격 모드) 여기서 ReferenceError 를 던져 AI 서버도 안 끄고 app.quit() 도
  // 못 부른 채 프로세스가 남았다 — 자동 업데이트 설치(autoInstallOnAppQuit)도 그래서 안 됐다.
  try {
    if (browser) {
      // Edge 가 멈춰 있으면 close() 가 끝나지 않는다. 기다리다 종료를 못 하는 일은 없게 한다.
      try {
        await Promise.race([browser.close(), new Promise(r => setTimeout(r, 5000))]);
      } catch (e) { console.error('Browser cleanup error:', e); }
      browser = null;
    }
    // 브라우저에 매달린 싱글턴을 모두 버린다(getBrowser 의 끊김 처리와 같은 목록).
    dropBrowserBoundInstances();
  } catch (e) {
    console.error('종료 정리 실패:', e);
  } finally {
    stopAiServers();
    if (process.platform !== 'darwin') app.quit();
  }
});

// Helper to get or launch browser
/**
 * 브라우저에 매달린 싱글턴을 전부 버린다.
 * 인스턴스는 닫힌 context/page 를 필드로 들고 있으므로, 브라우저가 죽으면 같이 버려야
 * 다음 작업이 새 context 를 만든다.
 */
// (예전에는 여기에 선언된 적 없는 naverEditInstance 가 있었다 — archive/ 에만 남은 옛 변수다.
//  ES 모듈이라 그 대입이 ReferenceError 를 던져, Edge 를 직접 닫은 뒤의 첫 작업이 실패하고
//  imwebInstance 는 죽은 브라우저를 붙든 채 남았다. tests/main-process-lifecycle.test.mjs 가 지킨다.)
function dropBrowserBoundInstances() {
    esmInstance = null;
    naverInstance = null;
    imwebInstance = null;
}

async function getBrowser() {
    // ⚠ 사람이 자동화 Edge 창을 **직접 닫으면** Browser 객체는 그대로 남고 연결만 끊긴다.
    //   `if (!browser)` 만 보면 그 죽은 객체를 그대로 돌려주게 되고, 다음 작업이
    //       page.goto: Target page, context or browser has been closed
    //   로 죽는다. 원인은 사용자 행동인데 메시지는 그 사실을 말해 주지 않아,
    //   "등록 실패"만 보고 코드를 뒤지게 된다. 여기서 걸러 새로 띄운다.
    if (browser && browser.isConnected && !browser.isConnected()) {
        console.warn('[브라우저] 연결이 끊겨 있어 새로 띄웁니다. (자동화 창을 직접 닫으면 이 상태가 됩니다)');
        browser = null;
        dropBrowserBoundInstances();
    }
    if (!browser) {
        browser = await chromium.launch({
            headless: false,
            channel: 'msedge' // Use pre-installed Edge for portability
        });
        // 다음 getBrowser() 를 기다리지 않고 끊기는 즉시 표시해 둔다.
        // (작업 도중에 닫히면 그 작업은 어차피 실패하지만, 그 다음 작업은 깨끗하게 시작한다)
        browser.on('disconnected', () => {
            console.warn('[브라우저] 연결이 끊어졌습니다.');
            browser = null;
            dropBrowserBoundInstances();
        });
    }
    return browser;
}

// File dialog handler
ipcMain.handle('select-file', async (event, { filters }) => {
    const result = await dialog.showOpenDialog(dialogParent(), {
        properties: ['openFile'],
        filters: filters || [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp'] }]
    });
    if (result.canceled || result.filePaths.length === 0) return { canceled: true };
    return { canceled: false, filePath: result.filePaths[0] };
});

// Load Auto-Generated Image Handler
ipcMain.handle('load-auto-image', async (event, customName = 'OPTICGLASS_생성이미지') => {
    const autoImagePath = path.join(AI_OUTPUT_DIR, 'latest_generated.jpg');
    if (fs.existsSync(autoImagePath)) {
        const outputDir = path.dirname(autoImagePath);
        const safeName = customName.replace(/[<>:"/\\|?*]/g, '_');
        const customImagePath = path.join(outputDir, `${safeName}.jpg`);
        
        fs.copyFileSync(autoImagePath, customImagePath);
        
        return { success: true, filePath: customImagePath, fileName: `${safeName}.jpg` };
    }
    return { success: false, error: '최근에 자동 생성된 이미지를 찾을 수 없습니다.' };
});

ipcMain.handle('save-merged-image', async (event, data) => {
    const { base64Data } = data;
    try {
        const outputDir = AI_OUTPUT_DIR;
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }
        const outputPath = path.join(outputDir, 'latest_generated.jpg');
        // Remove data URL prefix
        const base64Image = base64Data.replace(/^data:image\/\w+;base64,/, '');
        const buffer = Buffer.from(base64Image, 'base64');
        fs.writeFileSync(outputPath, buffer);
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

registerImageLibraryIPC({ app, ipcMain, dialog, output: AI_OUTPUT_DIR, upload: async file => {
    await getBrowser();
    const esm = getESM();
    if (!await esm.login()) throw new Error('ESM 로그인이 필요합니다. 판매자 콘솔 ESM에서 로그인해주세요.');
    return esm.uploadImage(file, ['옵틱글래스 상세페이지']);
} });

// ESM Handlers
ipcMain.handle('esm-login', async () => {
    try {
        await getBrowser();
        const esm = getESM();
        await esm.login();
        return { success: true };
    } catch (error) {
        console.error(error);
        return { success: false, error: error.message };
    }
});

// 베리씨드에서 만든 최신 사진 불러오기 (region: korea | global)
ipcMain.handle('veryup-load-photo', async (event, { region }) => {
    try {
        const file = region === 'global' ? 'latest_global.jpg' : 'latest_korea.jpg';
        const p = path.join(AI_OUTPUT_DIR, file);
        if (!fs.existsSync(p)) {
            const label = region === 'global' ? 'GLOBAL' : 'KOREA';
            return { success: false, error: `아직 생성된 ${label} 사진이 없습니다. (베리씨드에서 먼저 생성하세요)` };
        }
        const buf = fs.readFileSync(p);
        // ESM 업로드 때 저장된 조견표 HTML(있으면) 같이 반환
        let html = '';
        try {
            const htmlFile = path.join(AI_OUTPUT_DIR, `latest_${region === 'global' ? 'global' : 'korea'}_html.txt`);
            if (fs.existsSync(htmlFile)) html = fs.readFileSync(htmlFile, 'utf-8');
        } catch {}
        return { success: true, path: p, name: file, html, dataUrl: 'data:image/jpeg;base64,' + buf.toString('base64') };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

const bulkPriceService = registerBulkPriceIPC({
    directory: app.getPath('userData'),
    ipcMain, naverAPI: requireNaverAPI, naverProducts: getNaverProducts,
    coupang: getCoupang, amazon: getAmazon, ebay: getEbay,
    // 아임웹 네 범위(B2B · 본사 한국/미국/일본)는 Open API 로 읽고 쓴다 — 브라우저를 띄우지 않는다.
    imwebBulk: createImwebBulk({ clientFor: site => site === 'b2b' ? getImwebApiClient(B2B_SITE_CODE) : getImwebApiClient() }),
    rates: () => currencyRatesService.get(),
});
// 일일 환율 자동 변경: 아마존·eBay 판매가를 국내 기준가 ÷ 오늘 환율로 맞춘다(fx_auto_price.js).
// 아임웹 미국·일본은 체크했을 때만, 아래 imwebUnitPrices 의 sync(읽고 바로 저장)로 한다(호출은 실행 때라 선언 순서는 상관없다).
// 켜기·등급표는 상품 일괄 수정 화면에서 PC 마다 정한다. 꺼져 있으면 확인만 하고 아무것도 보내지 않는다.
const fxAutoPrice = registerFxAutoPriceIPC({
    ipcMain, dir: app.getPath('userData'), service: bulkPriceService,
    imwebUnits: { sync: options => imwebUnitPrices.sync(options) },
    rates: () => currencyRatesService.get(),
    notify: payload => sendToUI('fx-auto-price-progress', payload),
});
app.whenReady().then(() => fxAutoPrice.start());
app.on('before-quit', () => fxAutoPrice.stop());
// 쿠팡 판매가 캐시는 모아서 쓴다(coupang_store.js). 끄기 직전 몇 초 동안 읽은 판매가도 남긴다.
app.on('before-quit', () => { coupangInstance?.store?.flush(); });
// ── 아임웹 Open API(OAuth) ──────────────────────────────────────────
// 본사몰(KR·US·JP 구역이 있는 한 사이트)에 연동된 앱. 토큰은 디스크에 두지 않고 필요할 때 메모리에서
// 발급 · 갱신한다(imweb_client.js). siteCode · redirectUri 는 설정 파일에 있으면 그 값을 쓴다.
const IMWEB_SITE_CODE = 'S20260120dfa7cee190bbb';
const IMWEB_REDIRECT_URI = 'https://optic-glass.co.kr/';   // 개발자센터 등록값과 끝의 / 까지 같아야 한다
function readImwebOpenApiConfig() {
    try {
        const p = process.env.IMWEB_OPENAPI_CONFIG || path.join(app.getPath('userData'), 'imweb_openapi_config.json');
        return JSON.parse(fs.readFileSync(p, 'utf-8')) || {};
    } catch { return {}; }
}
// 같은 앱이 두 사이트에 연동돼 있다: 본사몰(기본) · B2B몰(B2B_SITE_CODE). 토큰은 사이트마다 따로다.
const imwebApiClients = new Map();
// 베리맵 아임웹 수집기(별도 프로세스)와 토큰을 서로 무효화하지 않게, 요청마다 공용 잠금을 잡는다.
// 1분 동안 요청이 없으면 놓는다 — 그 사이에 수집기를 돌릴 수 있다(utils/imweb_lock.js).
const imwebLock = createImwebLock(path.join(app.getPath('userData'), 'imweb_api.lock'), { idleMs: 60_000 });
const imwebLockedFetch = (url, init) => { imwebLock.acquire(); return fetch(url, init); };
app.on('before-quit', () => imwebLock.release());
function getImwebApiClient(siteCode) {
    const cfg = readImwebOpenApiConfig();
    const site = siteCode || cfg.siteCode || IMWEB_SITE_CODE;
    if (!imwebApiClients.has(site)) {
        const session = createImwebSession({
            // 부를 때마다 읽는다 — 앱에서 OAuth 값을 바꾸면 다음 발급부터 새 값을 쓴다.
            credentials: () => oauthCredentialsFromConfig(readImwebOpenApiConfig()),
            siteCode: site,
            redirectUri: cfg.redirectUri || IMWEB_REDIRECT_URI,
            need: ['product:write'],
            log: msg => console.log(msg),
            fetchImpl: imwebLockedFetch,
        });
        imwebApiClients.set(site, createImwebClient(session, { log: msg => console.log(msg), fetchImpl: imwebLockedFetch }));
    }
    return imwebApiClients.get(site);
}

// 아임웹 미국·일본 판매가(imweb_unit_prices.js): 본사몰 구역별 가격을 같은 상품의 한국 가격 기준으로 바꾼다.
// 아임웹 Open API 로만 한다(예전 크롤링은 지웠다). 환율 자동 변경 패널의 미리보기 → 저장으로 쓰고,
// '대상'에서 아임웹 미국·일본을 체크한 PC 는 매일 자동 실행도 이걸로 한다(10% 넘는 변동은 건너뜀).
const imwebUnitPrices = registerImwebUnitPricesIPC({
    ipcMain, dir: app.getPath('userData'),
    gateway: () => createOpenApiGateway(getImwebApiClient(), { log: msg => console.log(msg) }),
    rates: () => currencyRatesService.get(),
    notify: payload => sendToUI('imweb-unit-prices-progress', payload),
});
// 같은 구역의 상품명 · 옵션 이름(imweb_unit_names.js): 아임웹이 복사해 둔 한국어를 사전으로 번역한다. 미리보기 → 저장.
registerImwebUnitNamesIPC({
    ipcMain, dir: app.getPath('userData'), client: () => getImwebApiClient(),
    notify: payload => sendToUI('imweb-unit-names-progress', payload),
});
ipcMain.handle('naver-key-config-get', () => {
    try {
        const saved = new NaverStore(app.getPath('userData'), safeStorage).publicConfig();
        const active = getNaverAPI();
        const effective = active?.config;
        return { success: true, config: effective ? {
            ...saved, clientId: effective.clientId, accountId: effective.accountId,
            type: effective.type, hasClientSecret: !!effective.clientSecret,
        } : saved, configured: !!active, connection: naverConnectionInfo(getRuntimeProxy('naver')) };
    } catch (e) { return { success: false, error: e.message }; }
});
ipcMain.handle('naver-key-connection-check', async () => {
    let connection = naverConnectionInfo(getRuntimeProxy('naver'));
    try {
        const api = requireNaverAPI();
        connection = await api.connectionDiagnostics();
        await api.tokenRequest();
        return { success: true, connection };
    } catch (e) {
        return { success: false, error: e.message, code: e.code || '', connection };
    }
});
ipcMain.handle('naver-key-config-save', (_, data) => {
    try { return { success: true, config: new NaverStore(app.getPath('userData'), safeStorage).save(data) }; }
    catch (e) { return { success: false, error: e.message }; }
});

// 탭이 없는 몰(라쿠텐·쇼피파이)의 수정 모드 카드가 묻는다(index_up.html searchProduct). 그 몰은 연동이 없어 늘 빈 목록이다.
// 다른 몰 분기와 카드 수정(veryup-update-product)은 화면이 부를 수 없어 10-23 지웠다 — 그 몰들은 각 탭이 찾고 고친다.
ipcMain.handle('veryup-search-product', () => ({ items: [] }));

// ESM 이미지 호스팅 폴더 경로 (국가별). KOREA=조견표, 그 외(USA 등)=Compatibility Chart
function esmBasePath(country, category) {
    // 한글(자동차) + 영어(Car) 둘 다 자동차로 인식 (USA는 카테고리명이 영어)
    const isCar = (category === '자동차' || category === 'Car');
    if (country === 'USA') {
        return isCar
            ? ['옵틱글래스 상세페이지', 'Compatibility Chart', 'CAR']
            : ['옵틱글래스 상세페이지', 'Compatibility Chart', 'BIKE'];
    }
    return isCar
        ? ['옵틱글래스 상세페이지', '조견표']
        : ['옵틱글래스 상세페이지', '조견표 바이크'];
}

ipcMain.handle('esm-list-folders', async (event, { category, country }) => {
    try {
        await getBrowser();
        const esm = getESM();
        
        const loginSuccess = await esm.login();
        if (!loginSuccess) {
            return { success: false, error: 'ESM 로그인이 필요합니다.' };
        }
        
        const basePath = esmBasePath(country, category);

        const folders = await esm.listSubfolders(basePath);
        return { success: true, folders, basePath };
    } catch (error) {
        console.error(error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('esm-upload', async (event, { filePath, category, targetFolder, country }) => {
    try {
        await getBrowser();
        const esm = getESM();
        
        // Ensure logged in before upload
        const loginSuccess = await esm.login();
        if (!loginSuccess) {
            return { success: false, error: 'ESM 로그인이 필요합니다. 먼저 로그인 창을 열어 로그인해주세요.' };
        }
        
        const basePath = esmBasePath(country, category);

        // If a target folder is specified, navigate into it
        const folderPath = targetFolder ? [...basePath, targetFolder] : basePath;

        const url = await esm.uploadImage(filePath, folderPath);
        if (url) {
            const html = `<img src="${url}" />`;
            // 국가별로 생성 HTML 저장 → 베리업 '조견표 HTML' 칸에서 불러쓰기
            try {
                const region = (country === 'KOREA' || !country) ? 'korea' : 'global';
                fs.writeFileSync(path.join(AI_OUTPUT_DIR, `latest_${region}_html.txt`), html, 'utf-8');
            } catch {}
            return { success: true, html, url };
        } else {
            return { success: false, error: 'Failed to retrieve image URL.' };
        }
    } catch (error) {
        console.error(error);
        return { success: false, error: error.message };
    }
});

// Naver SmartStore Handlers
ipcMain.handle('naver-register', async (event, data) => {
    try {
        // 중복 판정은 브라우저를 띄우기 전에 끝낸다(커머스API 로 조회). 조회를 못 해도 등록은
        // 진행한다(fail-open) — 등록은 커머스API 없이 되고, 판매자센터에서 되돌릴 수 있다.
        let api = null, apiError = null;
        if (USE_NAVER_API) {
            try { api = getNaverAPI(); } catch (e) { apiError = e.message; }
        } else apiError = 'USE_NAVER_API=0';
        const plan = planNaver(data, { brands: guardBrands() });
        const { result: resultUrl, notices } = await runGuardedRegistration({
            channel: 'naver', data, plan, inflight: registerInflight,
            check: (p, opts) => checkNaver(p, opts, { ledger: getRegistrationLedger(), api, apiError }),
            register: async () => {
                await getBrowser();
                const naver = getNaver();
                const loginSuccess = await naver.login();
                if (!loginSuccess) {
                    throw new Error('스마트스토어 로그인이 필요합니다. 먼저 로그인 창을 열어 로그인해주세요.');
                }
                // 옵션 변경·저장 실패, 저장 확인 실패(아직 복사등록 양식)는 copyAndRegisterProduct 가 던진다.
                // runGuardedRegistration 은 register 가 값을 돌려줄 때만 record 를 부르므로, 실패가 원장에
                // '등록됨'으로 남아 최대 24시간 재시도를 막는 일이 없다.
                return naver.copyAndRegisterProduct(data);
            },
            record: (p, url, opts) => {
                try { naverApiInstance?.invalidateProducts(); } catch { /* 캐시 무효화 실패는 무시 */ }
                return recordNaver(getRegistrationLedger(), p, url, opts);
            },
        });
        for (const message of notices) sendToUI('naver-log', { message, level: 'warn' });

        // 중복검사 안내(notices)는 위에서 naver-log 로 이미 보냈으므로 message 에 다시 붙이지 않는다.
        return { success: true, url: resultUrl, message: `스마트스토어 복사등록 완료 (URL: ${resultUrl})` };
    } catch (error) {
        if (isGuardError(error)) return guardErrorResponse(error);
        console.error(error);
        return { success: false, error: error.message };
    }
});

// ────────────────────────────────────────────
// Coupang Handlers (Open API 방식)
// ────────────────────────────────────────────

// 쿠팡 설정 로드
ipcMain.handle('coupang-load-config', async () => {
    try {
        const coupang = getCoupang();
        const config = coupang.loadConfig();
        // 보안: secretKey는 마스킹하여 전달
        return { 
            success: true, 
            config
        };
    } catch (error) {
        // Config not yet set up — return empty config
        return { 
            success: true, 
            config: {
                vendorId: '', accessKey: '', secretKey: '',
                outboundShippingPlaceCode: '', returnCenterCode: '',
                deliveryChargeType: 'FREE', deliveryCharge: 0,
                deliveryCompanyCode: 'CJGLS', deliveryMethod: 'SEQUENCIAL',
                brand: '옵틱글래스', displayCategoryCode: null,
                returnCharge: 5000,
                afterServiceInformation: '옵틱글래스 A/S 센터',
                afterServiceContactNumber: ''
            }
        };
    }
});

// 쿠팡 설정 저장
ipcMain.handle('coupang-save-config', async (event, newConfig) => {
    try {
        const coupang = getCoupang();
        coupang.saveConfig(newConfig);
        return { success: true };
    } catch (error) {
        console.error(error);
        return { success: false, error: error.message };
    }
});

// 쿠팡 API 연결 테스트
ipcMain.handle('coupang-test-connection', async () => {
    try {
        const coupang = getCoupang();
        coupang.loadConfig();
        const result = await coupang.testConnection();
        return { success: true, ...result };
    } catch (error) {
        console.error(error);
        return { success: false, error: error.message };
    }
});

// 쿠팡 출고지 조회
ipcMain.handle('coupang-get-shipping-places', async () => {
    try {
        const coupang = getCoupang();
        coupang.loadConfig();
        const result = await coupang.getShippingPlaces();
        return { success: true, data: result?.content || result?.data?.addressBookList || [] };
    } catch (error) {
        console.error(error);
        return { success: false, error: error.message };
    }
});

// 쿠팡 반품지 조회
ipcMain.handle('coupang-get-return-centers', async () => {
    try {
        const coupang = getCoupang();
        coupang.loadConfig();
        const result = await coupang.getReturnCenters();
        return { success: true, data: result?.data?.content || result?.data || [] };
    } catch (error) {
        console.error(error);
        return { success: false, error: error.message };
    }
});

// 쿠팡 상품 등록 (복사등록 방식)
ipcMain.handle('coupang-register', async (event, data) => {
    try {
        const coupang = getCoupang();
        coupang.loadConfig();
        // 원장·스냅샷 적중은 막고(fail-closed), 실시간 목록 조회 실패는 통과시킨다(fail-open).
        const catalog = loadGuardCatalog();
        const plan = planCoupang(data, { vendorId: coupang.config?.vendorId, brands: guardBrands(catalog) });
        const { result, notices } = await runGuardedRegistration({
            channel: 'coupang', data, plan, inflight: registerInflight,
            check: (p, opts) => checkCoupang(p, opts, {
                ledger: getRegistrationLedger(), catalog,
                lookup: { listPage: (t) => coupang.api.listProducts(t, 100), getProduct: (id) => coupang.api.getProduct(id) },
            }),
            // 쿠팡이 HTTP 200 + code:'ERROR' 로 거부하거나 등록상품ID 가 없으면 copyRegisterProduct 가 던진다
            // → 아래 catch 가 쿠팡 메시지로 success:false 를 돌려주고, 원장(record)에도 적지 않는다.
            register: () => coupang.copyRegisterProduct(data),
            record: (p, r, opts) => {
                coupang._allProducts = null;   // 상품 목록 5분 캐시에 새 상품이 빠져 있다
                return recordCoupang(getRegistrationLedger(), p, r, opts);
            },
        });
        return {
            success: true,
            productId: result?.data,
            message: `상품이 성공적으로 등록되었습니다. (ID: ${result?.data})` + noticeSuffix(notices)
        };
    } catch (error) {
        if (isGuardError(error)) return guardErrorResponse(error);
        console.error(error);
        return { success: false, error: error.message };
    }
});

// ────────────────────────────────────────────
// Amazon Handlers (SP-API 방식)
// ────────────────────────────────────────────

// 아마존 설정 로드
ipcMain.handle('amazon-load-config', async () => {
    try {
        const amazon = getAmazon();
        const config = amazon.readConfig();
        return { success: true, config };
    } catch (error) {
        return {
            success: true,
            config: {
                sellerId: '', clientId: '', clientSecret: '', refreshToken: '',
                endpoint: 'https://sellingpartnerapi-na.amazon.com',
                marketplaceId: 'ATVPDKIKX0DER',
                productType: 'AUTO_PART',
                brand: 'Optic Glass', manufacturer: 'Optic Glass',
                currency: 'USD'
            }
        };
    }
});

// 아마존 설정 저장
ipcMain.handle('amazon-save-config', async (event, newConfig) => {
    try {
        const amazon = getAmazon();
        amazon.saveConfig(newConfig);
        return { success: true };
    } catch (error) {
        console.error(error);
        return { success: false, error: error.message };
    }
});

// 아마존 API 연결 테스트
ipcMain.handle('amazon-test-connection', async (_, { marketplaceId } = {}) => {
    try {
        const amazon = getAmazon();
        amazon.loadConfig();
        const result = await amazon.testConnection(marketplaceId);
        return { success: true, ...result };
    } catch (error) {
        console.error(error);
        return { success: false, error: error.message };
    }
});

// 아마존 상품 등록
ipcMain.handle('amazon-register', async (event, data) => {
    try {
        const amazon = getAmazon();
        amazon.loadConfig();
        // 같은 SKU 는 기존 리스팅 덮어쓰기다 — 실시간으로 확인하지 못하면 멈춘다(fail-closed).
        const plan = planAmazon(data, { config: amazon.config });
        const { result, notices } = await runGuardedRegistration({
            channel: 'amazon', data, plan, inflight: registerInflight,
            check: (p, opts) => checkAmazon(p, opts, {
                ledger: getRegistrationLedger(),
                // _fetchListingsBySku 는 비정상 응답을 [] 로 바꾸므로 쓰지 않는다('없음'으로 오판).
                searchBySkus: (ids, mp) => amazon.apiForMarketplace(mp).searchListingsItems({ marketplaceId: mp, identifiers: ids, identifiersType: 'SKU' }),
                toRow: (l, mp) => amazon.listingRow(l, mp),
                cache: (mp) => amazon.getCachedListings(mp),
            }),
            // HTTP 200 + status:INVALID 는 registerProduct 가 이슈 목록과 함께 던진다 → success:false, 원장 기록 없음.
            register: () => amazon.registerProduct(data),
            record: (p, r, opts) => recordAmazon(getRegistrationLedger(), p, r, opts),
        });
        return {
            success: true,
            sku: result?.sku,
            status: result?.status,
            message: `아마존 상품이 성공적으로 등록되었습니다. (SKU: ${result?.sku}, 상태: ${result?.status || 'ACCEPTED'})` + noticeSuffix(notices)
        };
    } catch (error) {
        if (isGuardError(error)) return guardErrorResponse(error);
        console.error(error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('amazon-search-products', async (event, query) => {
    try {
        const amazon = getAmazon();
        amazon.loadConfig();
        const stats = {};
        const items = await amazon.searchProducts(query, stats);
        return { success: true, items, stats };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// 로컬 캐시 상태 (건수 / 마지막 동기화 시각). 캐시는 마켓마다 따로라 탭의 마켓을 받는다(없으면 설정 마켓).
ipcMain.handle('amazon-cache-summary', async (event, options = {}) => {
    try {
        const amazon = getAmazon();
        amazon.loadConfig();
        return { success: true, ...amazon.getCachedListingsSummary(options?.marketplaceId) };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// 전체 목록 동기화. Reports API 라 수 분 걸릴 수 있어 진행상황을 렌더러로 흘려보낸다.
ipcMain.handle('amazon-refresh-cache', async (event, options = {}) => {
    try {
        const amazon = getAmazon();
        amazon.loadConfig();
        const result = await amazon.refreshListingsCache({
            marketplaceId: options.marketplaceId,
            enrichBrand: options.enrichBrand !== false,
            onProgress: p => { try { event.senderFrame.send('amazon-cache-progress', p); } catch (_) {} }
        });
        return { success: true, ...result };
    } catch (error) {
        console.error(error);
        return { success: false, error: error.message };
    }
});

// 아마존 일본 등록 초안 (amazon_jp_draft.js makeJpDraft) — 아마존에는 아무것도 보내지 않는다(읽기만 한다).
// 상품은 정규화 표(data/amazon_listings.json), 가격·재고·이미지·ASIN 은 미국 실시간 조회, 일본에 이미 있는 SKU 는
// 일본에 한 건씩 물어 표시, 메인 이미지는 글자 없는 사진(Windows OCR). 결과: 검토용 CSV + 업로드용 TSV(999줄씩).
ipcMain.handle('amazon-jp-draft', async (event) => {
    const progress = message => { try { event.senderFrame.send('amazon-jp-draft-progress', message); } catch { /* 창 닫힘 */ } };
    try {
        const amazon = getAmazon();
        amazon.loadConfig();
        const rates = await currencyRatesService.get();
        const { rows, summary } = await makeJpDraft({
            amazon, names: loadVehicleNames(), detect: detectUrlText, progress,
            fx: new FxPriceStore(app.getPath('userData')).read(),
            snapshot: rates?.success ? rates.data : null,
        });
        return { success: true, csv: draftCsv(rows), tsv: draftTsv(rows), summary,
            rateError: rates?.success ? '' : (rates?.error || '환율을 불러오지 못했습니다.') };
    } catch (error) {
        console.error('[아마존 JP 초안]', error);
        return { success: false, error: error.message };
    }
});

// Accept the legacy SKU string as well as a marketplace-specific selection.
ipcMain.handle('amazon-load-product', async (event, input) => {
    try {
        const amazon = getAmazon();
        amazon.loadConfig();
        const { sku, marketplaceId } = typeof input === 'string' ? { sku: input } : input;
        const product = await amazon.loadProductForEdit(sku, marketplaceId);
        return { success: true, product };
    } catch (error) {
        console.error(error);
        return { success: false, error: error.message };
    }
});

// 아마존 기존 상품 수정
ipcMain.handle('amazon-update', async (event, data) => {
    try {
        const amazon = getAmazon();
        amazon.loadConfig();
        // ACCEPTED 가 아니면(INVALID 등) updateExistingProduct 가 던진다 — 여기까지 오면 아마존이 접수했거나
        // 보낼 변경이 없었던(SKIPPED) 경우뿐이다.
        const result = await amazon.updateExistingProduct(data);
        return {
            success: true,
            sku: result?.sku,
            status: result?.status,
            message: result?.status === 'SKIPPED'
                ? `바뀐 값이 없어 아마존에 수정 요청을 보내지 않았습니다. (SKU: ${result?.sku})`
                : `아마존 상품이 성공적으로 수정되었습니다. (SKU: ${result?.sku})`
        };
    } catch (error) {
        console.error(error);
        return { success: false, error: error.message };
    }
});

// ── 스마트스토어 기존 상품 수정 (복사등록과 분리된 경로) ──
// 제조사·차종으로 스마트스토어 등록 상품번호 찾기
ipcMain.handle('smartstore-find-id', async (event, { brand, model }) => {
    try {
        const log = (msg) => sendToUI('naver-log', msg);
        const rows = await naverApiRead('상품 조회', api => api.searchProductsByName(brand, model, {
            onProgress: (n, total) => { if (total && n < total) log(`상품 수집 ${n}/${total}`); }
        }), log);
        return { success: true, rows };
    } catch (error) {
        console.error(error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('smartstore-load-product', async (event, productNo) => {
    try {
        sendToUI('naver-log', '커머스API로 상품 불러오는 중...');
        const product = await getNaverProducts().loadProductForEdit(productNo);
        sendToUI('naver-log', '커머스API 상품 불러오기 완료 (브라우저 미사용)');
        return { success: true, product };
    } catch (error) {
        console.error(error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('smartstore-update-product', async (event, data) => {
    try {
        sendToUI('naver-log', '커머스API로 상품 수정 요청 중...');
        const result = await getNaverProducts().updateProduct(data);
        return { success: true, product: result.product, message: `상품이 수정되었습니다. (${result.verified})` };
    } catch (error) {
        console.error(error);
        return { success: false, error: error.message };
    }
});

// 쿠팡 기존 상품 불러오기 (수정 화면용)
// 제조사·차종으로 등록상품ID 찾기 — 쿠팡 API 우선(항상 최신), 실패 시 구글 시트 폴백
ipcMain.handle('coupang-find-id', async (event, { brand, model }) => {
    try {
        const coupang = getCoupang();
        coupang.loadConfig();
        const rows = await coupang.searchProductsByName(brand, model);
        return { success: true, rows, source: 'api' };
    } catch (apiError) {
        console.error('API 검색 실패, 시트로 폴백:', apiError.message);
        try {
            const rows = await findProductIdsFromSheet(brand, model);
            return { success: true, rows, source: 'sheet', apiError: apiError.message };
        } catch (sheetError) {
            console.error(sheetError);
            return { success: false, error: `API 검색 실패(${apiError.message}) / 시트 검색도 실패(${sheetError.message})` };
        }
    }
});

ipcMain.handle('coupang-load-product', async (event, productId) => {
    try {
        const coupang = getCoupang();
        coupang.loadConfig();
        const product = await coupang.loadProductForEdit(productId);
        return { success: true, product };
    } catch (error) {
        console.error(error);
        return { success: false, error: error.message };
    }
});

// 쿠팡 기존 상품 수정
ipcMain.handle('coupang-update', async (event, data) => {
    try {
        const coupang = getCoupang();
        coupang.loadConfig();
        const saved = await coupang.updateExistingProduct(data);
        // 판매가·재고만 바꾼 저장은 아이템별 API 로만 가고 상품 수정(승인) 요청은 나가지 않는다.
        const approval = !saved?.priceOnly;
        // 저장 뒤 화면이 옛 옵션 목록(옛 index·삭제된 옵션)을 그대로 들고 있으면 두 번째 저장이
        // 엉뚱한 옵션에 덮어쓴다. coupang-load-product 와 같은 로더로 다시 읽어 돌려주고, 화면은 이걸로
        // 수정 상태를 새로 고친다. 다시 읽기만 실패하면 저장은 성공이므로 success 는 유지하고 알린다.
        let product = null, reloadNote = '';
        try {
            product = await coupang.loadProductForEdit(data.productId);
        } catch (e) {
            reloadNote = ` ⚠ 저장 후 상품을 다시 불러오지 못했습니다(${e.message}) — 이어서 수정하려면 먼저 다시 불러오세요.`;
        }
        return {
            success: true,
            productId: data.productId,
            product,
            approval,
            message: (approval ? `상품이 성공적으로 수정되었습니다. (ID: ${data.productId})`
                : `판매가·재고만 바꿨습니다 — 상품 수정(승인) 요청은 보내지 않았습니다. (ID: ${data.productId}, ${saved.verified})`) + reloadNote
        };
    } catch (error) {
        console.error(error);
        return { success: false, error: error.message };
    }
});


// ────────────────────────────────────────────
// Imweb Handlers
// ────────────────────────────────────────────
ipcMain.handle('imweb-load-categories', async () => {
    try {
        // Brand/model dropdown reads this file (refreshable via 'imweb-sync-categories').
        const categoriesPath = path.join(__dirname, '..', 'data', 'imweb_categories.json');
        const raw = fs.readFileSync(categoriesPath, 'utf-8');
        return { success: true, categories: JSON.parse(raw) };
    } catch (error) {
        console.error(error);
        return { success: false, error: error.message };
    }
});

// 차량 카탈로그: 엑셀 코드표·이베이 상품등록 표에서 구운 것(scratch/build_vehicle_catalog.mjs).
// 좌측 연식·차량코드·상품번호·SKU·판매가 목록. 엑셀은 배포본에 없으므로 이 JSON 이 정본이다.
ipcMain.handle('vehicle-load-catalog', async () => {
    try {
        const p = path.join(__dirname, '..', 'data', 'vehicle_catalog.json');
        const catalog = JSON.parse(fs.readFileSync(p, 'utf-8'));
        const japanPath = path.join(__dirname, '..', 'data', 'japan_vehicle_catalog.json');
        if (fs.existsSync(japanPath)) catalog.japan = JSON.parse(fs.readFileSync(japanPath, 'utf-8'));
        return { success: true, catalog };
    } catch (error) {
        console.error('[카탈로그] 불러오기 실패:', error.message);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('vehicle-load-i18n', async () => {
    try {
        // 차량 명칭 한↔영↔일 사전. 일본몰 게시글·아마존 JP 리스팅이 이 값을 쓴다.
        // (생성: scratch/build_vehicle_i18n.mjs — CSVdatabase 는 배포본에 없으므로 이 JSON 이 정본)
        const namesPath = path.join(__dirname, '..', 'data', 'vehicle_i18n.json');
        const raw = fs.readFileSync(namesPath, 'utf-8');
        return { success: true, names: JSON.parse(raw) };
    } catch (error) {
        console.error(error);
        return { success: false, error: error.message };
    }
});

// 좌측 자동완성(SKU·판매가·변경 판매가·쿠팡 상품)에 '지금 몰에 걸린 값' 을 보인다 — 앱이 API 로 받아 둔 값이다:
// 아마존 미국·일본 목록 캐시, eBay 활성 리스팅 캐시, 쿠팡 옵션 판매가 캐시. 칸마다 API 를 부르지 않는다(호출 한도).
// 캐시는 목록 동기화·현재가 조회·저장 때 갱신된다. 하나를 못 읽어도 나머지는 돌려준다.
ipcMain.handle('vehicle-live-values', async () => {
    const live = { amazon: {}, ebay: null, coupang: null };
    const pick = (items, keyOf) => Object.fromEntries(items.filter(keyOf).map(i => [keyOf(i), { price: i.price, stock: i.stock }]));
    try {
        const amazon = getAmazon();
        amazon.loadConfig();
        for (const [key, mp] of [['US', 'ATVPDKIKX0DER'], ['JP', 'A1VC38T7YXB528']]) {
            const cache = amazon.getCachedListings(mp);
            if (cache) live.amazon[key] = { updatedAt: cache.updatedAt || null, items: pick(cache.items, i => i.id) };
        }
    } catch (e) { console.warn('[자동완성 현재값] 아마존:', e.message); }
    try {
        const cache = getEbay().getCachedListings();
        if (cache) live.ebay = { updatedAt: cache.updatedAt || null, items: pick(cache.items, i => i.sku) };
    } catch (e) { console.warn('[자동완성 현재값] eBay:', e.message); }
    try {
        const coupang = getCoupang();
        coupang.loadConfig();
        const products = coupang.store && coupang.config?.vendorId ? coupang.store.products(coupang.config.vendorId) : {};
        const items = {};
        for (const p of Object.values(products)) {
            for (const o of p.options || []) if (o.price !== '' && o.price != null) items[o.optionId] = { price: o.price, checkedAt: o.checkedAt || null };
        }
        live.coupang = { items };
    } catch (e) { console.warn('[자동완성 현재값] 쿠팡:', e.message); }
    return { success: true, live };
});

ipcMain.handle('imweb-sync-categories', async () => {
    try {
        // B2B몰 카테고리를 Open API 로 받는다(브라우저 없음).
        const imweb = getImweb();
        imweb.logCallback = (msg) => {
            sendToUI('imweb-log', msg);
        };
        const categories = await imweb.syncCategories();
        return { success: true, categories };
    } catch (error) {
        console.error(error);
        return { success: false, error: error.message };
    }
});

// ── 아임웹 Open API(OAuth) 키 (clientId / clientSecret) ──────────
// B2B몰 상품 등록·수정과 본사몰 미국·일본 판매가가 이 키로 동작한다. userData 의 imweb_openapi_config.json 에
// 저장하고 앱 안에서 입력한다. 예전 v2 키(apiKey/apiSecret)는 쓰는 곳이 없어 화면에서 뺐다(파일에 남은 값은 무시).
ipcMain.handle('imweb-load-openapi-config', async () => {
    try {
        const p = process.env.IMWEB_OPENAPI_CONFIG
            || path.join(app.getPath('userData'), 'imweb_openapi_config.json');
        if (!fs.existsSync(p)) return { success: true, config: { clientId: '' }, configured: false };
        const oauth = oauthCredentialsFromConfig(JSON.parse(fs.readFileSync(p, 'utf-8')) || {});
        // 비밀값은 렌더러로 그대로 넘기지 않는다. 입력칸은 비워두고, 저장되어 있으면 표시만 한다.
        return { success: true, config: { clientId: oauth?.clientId || '' }, configured: !!(oauth?.clientId && oauth?.clientSecret) };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle('imweb-save-openapi-config', async (event, { clientId, clientSecret } = {}) => {
    try {
        const cid = String(clientId || '').trim();
        const csecret = String(clientSecret || '').trim();
        if (!cid) return { success: false, error: 'OAuth Client ID 를 입력해주세요.' };
        if (!looksLikeOAuthClientId(cid)) {
            return { success: false, error: 'Client ID 형식이 아닙니다. 개발자센터 앱의 클라이언트 ID(예: 0a1b2c3d-…)를 넣어주세요.' };
        }
        // secret 을 비워서 보내면 기존 값을 유지한다 (불러오기 때 비밀값을 안 내려주므로).
        const merged = oaSaveConfig(csecret ? { clientId: cid, clientSecret: csecret } : { clientId: cid });
        if (!merged.clientSecret) return { success: false, error: 'OAuth Client Secret 이 저장되어 있지 않습니다. 한 번은 입력해주세요.' };
        return { success: true };
    } catch (error) {
        console.error(error);
        return { success: false, error: error.message };
    }
});

async function prepareEnglishBoardPrice(data) {
    const currencySnapshot = data.currencySnapshot || (await currencyRatesService.get())?.data;
    const prepared = { ...data, currencySnapshot };
    englishPrice(prepared);
    return prepared;
}

ipcMain.handle('imweb-register', async (event, data) => {
    try {
        if (data.targetUs) data = await prepareEnglishBoardPrice(data);
        // B2B몰은 Open API 라 브라우저가 필요 없다. 게시판(본사 · 해외 · 일본)이 있을 때만 띄운다.
        if (data.targetHead || data.targetUs || data.targetJp) await getBrowser();
        const imweb = getImweb();

        // Route logs to the tab that started this run: B2B → imweb-log,
        // 본사·해외몰 게시판 → imweb-board-log.
        const channel = data.targetB2b ? 'imweb-log' : 'imweb-board-log';
        imweb.logCallback = (msg) => {
            sendToUI(channel, msg);
        };

        // 조회가 등록과 같은 토큰·세션을 쓰고 대신 볼 스냅샷이 없으며 중복이 즉시 공개된다
        // — 확인하지 못하면 멈춘다(fail-closed). 수정 모드(isEditMode)는 planImweb 이 건너뛴다.
        const plan = planImweb(data, {
            brands: guardBrands(),
            boardNameFor: (b, l) => imweb.boardNameFor(b, l),
            nameForLang: (d, f, l) => imweb.nameForLang(d, f, l),
            extractImageUrl: (s) => imweb.extractImageUrl(s),
        });
        const { result: run, notices } = await runGuardedRegistration({
            channel: 'imweb', data, plan, inflight: registerInflight,
            check: async (p, opts) => {
                if (opts.bypass) return { notices: [] };
                await imweb.resetClosedSession();
                const boardLangs = [...new Set(p.targets.filter(t => t.kind === 'board').map(t => t.lang))];
                try {
                    // 게시판 세션 확보(만료 시 자동 로그인 60초 + 수동 로그인 대기 120초)는 조회 시간 제한(90초) 밖에서
                    // 먼저 끝낸다. 제한 안에서 하면 캡차·2FA 로그인 도중 시간 초과로 끊기고 catch 가 로그인 창을 닫는다.
                    // 로그인 실패는 가드 오류가 아니라 기존 등록과 같은 오류로 끝난다. B2B 조회는 Open API 라 준비가 없다.
                    if (boardLangs.length) await imweb.ensureBoardBase(boardLangs[0]);
                    return await checkImweb(p, opts, {
                        ledger: getRegistrationLedger(),
                        b2bRows: (code) => imweb.listB2bRowsByCode(code),
                        b2bOptionValues: (no) => imweb.b2bOptionValuesOf(no),
                        boardPosts: (brand, lang) => imweb.listBoardPosts(brand, lang),
                    });
                } finally {
                    // 조회가 잡아 둔 게시판 주소는 등록 단계에서 다시 잡게 한다(새 탭에서 옛 주소로 cm API 를
                    // 부르면 인증이 안 붙는다).
                    imweb.boardBase = null;
                    // 등록 단계가 initBrowserSession() 을 다시 불러 조회가 연 같은 창에 콘솔·팝업 리스너가 한 번 더
                    // 붙는다(로그 두 줄씩) → 조회 창을 닫아 등록이 새 창에서 시작하게 한다.
                    if (boardLangs.length) {
                        try { await imweb.close(); } catch { /* 이미 닫힘 */ }
                        imweb.resetClosedSession();
                    }
                }
            },
            register: () => imweb.executeAutomation(data),
            // 일부만 성공해도 record 는 불린다 — 실제로 만들어진 것(lastRegistered)만 적으므로 재시도가
            // 이미 올라간 상품·글을 또 만들지 않게 막고, 실패한 대상은 적히지 않는다.
            record: (p, _run, opts) => recordImweb(getRegistrationLedger(), p, imweb.lastRegistered || [], opts),
        });
        // 대상(B2B 개별/세트·본사/해외/일본몰)별 결과로 판정한다. 예전엔 요약 문자열을 무조건
        // success:true 로 감싸 "일부 실패"·"포스팅 실패"도 성공으로 보고됐다.
        return imwebRunResponse(run, noticeSuffix(notices));
    } catch (error) {
        if (isGuardError(error)) {
            try { await getImweb().close(); } catch { /* 이미 닫힘 */ }
            return guardErrorResponse(error);
        }
        console.error(error);
        return { success: false, error: error.message };
    }
});

// ── 아임웹 B2B 기존 상품 수정 (내부 API 기반) ──────────────────
// 예전에는 여기에 imwebEditInstance 라는 **두 번째** ImwebEdit 인스턴스가 있었다.
// 같은 클래스·같은 imweb_config.json 이고, BasePlatform.init() 이 플랫폼명으로
// 컨텍스트를 재사용하므로 **브라우저 컨텍스트까지 같은 것**을 썼다. 다른 것은
// this.page 와 this.token 뿐이었다 → 복사등록 중에 상품수정을 쓰면 두 인스턴스가
// 같은 탭을 서로 끌고 다녀, 한쪽의 goto() 뒤에 다른 쪽이 엉뚱한 페이지에서
// 셀렉터를 찾았다. 재현이 어렵고 "가끔 이상하다"로만 보고되는 종류의 문제였다.
// 이제 getImweb() 하나로 합쳤다. 이름은 호출부 호환을 위해 남겨 둔다.
function getImwebEdit() {
    return getImweb();
}

// 제조사/차종/코드로 검색 — 세트+개별을 한 묶음으로 반환
ipcMain.handle('imweb-search-products', async (event, { brand, model, code, idx }) => {
    try {
        const groups = await getImwebEdit().searchProducts({ brand, model, code, idx });
        return { success: true, groups };
    } catch (error) {
        console.error(error);
        return { success: false, error: error.message };
    }
});

// 짝(세트+개별)을 한 번에 불러오기
ipcMain.handle('imweb-load-group', async (event, { prodNos }) => {
    try {
        const group = await getImwebEdit().loadGroup(prodNos);
        group.products.forEach(p => { delete p.content; delete p.periodDiscount; });   // 원본 전체는 렌더러로 넘기지 않는다
        return { success: true, group };
    } catch (error) {
        console.error(error);
        return { success: false, error: error.message };
    }
});

// 짝을 한 번에 수정
ipcMain.handle('imweb-update-group', async (event, data) => {
    try {
        const result = await getImwebEdit().updateGroup(data);
        return { success: true, message: result };
    } catch (error) {
        console.error(error);
        return { success: false, error: error.message, partial: !!error.partial };
    }
});

// 본사·해외몰 게시글 수정 (내부 API 기반)
function getImwebBoardEdit() {
    const e = getImwebEdit();
    e.logCallback = (msg) => {
        sendToUI('imweb-board-log', msg);
    };
    return e;
}

// 코드로 게시글 검색 (여러 개면 전부 반환 → 사용자가 선택)
ipcMain.handle('imweb-search-posts', async (event, { code, lang, brand }) => {
    try {
        await getBrowser();
        const rows = await getImwebBoardEdit().searchPosts({ brand, lang, code });
        return { success: true, rows };
    } catch (error) {
        console.error(error);
        return { success: false, error: error.message };
    }
});

// 게시글 코드로 불러오기
ipcMain.handle('imweb-load-post', async (event, { postCode, lang }) => {
    try {
        await getBrowser();
        const post = await getImwebBoardEdit().loadPost(postCode, lang);
        return { success: true, post };
    } catch (error) {
        console.error(error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('imweb-update-post', async (event, data) => {
    try {
        if (data.lang === 'en' && String(data.priceUsd ?? '').trim()) data = await prepareEnglishBoardPrice(data);
        await getBrowser();
        const e = getImwebBoardEdit();
        const result = await e.updatePost(data);
        return { success: true, message: result };
    } catch (error) {
        console.error(error);
        return { success: false, error: error.message };
    }
});

// AI 이미지 생성 핸들러 (Node Canvas 기반 로컬 변환)
// ── 번역 (파파고 우선, 미지원 언어[아랍어 등]는 구글 무료 폴백) ──
const PAPAGO_LANGS = new Set(['en','ja','zh-CN','zh-TW','vi','id','th','de','ru','es','it','fr']);

function getPapagoCreds() {
    if (serverCreds['papago'] && serverCreds['papago'].clientId) return serverCreds['papago'];
    try {
        // 소스 폴더(data/)에 두면 폴더 사본과 함께 새어 나간다 → 개발 PC 도 userData 에 둔다.
        const p = path.join(app.getPath('userData'), 'papago.json');
        if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8'));
    } catch (e) { console.warn('papago.json 읽기 실패:', e.message); }
    if (process.env.PAPAGO_CLIENT_ID) {
        return { clientId: process.env.PAPAGO_CLIENT_ID, clientSecret: process.env.PAPAGO_CLIENT_SECRET };
    }
    return null;
}

async function papagoTranslate(text, source, target) {
    const creds = getPapagoCreds();
    if (!creds || !creds.clientId) {
        throw new Error('파파고 인증키가 없습니다. userData 의 papago.json({clientId,clientSecret}) 또는 관리서버(papago)에 등록하세요.');
    }
    const res = await fetch('https://papago.apigw.ntruss.com/nmt/v1/translation', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'X-NCP-APIGW-API-KEY-ID': creds.clientId,
            'X-NCP-APIGW-API-KEY': creds.clientSecret,
        },
        body: new URLSearchParams({ source, target, text }).toString(),
        signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error('Papago ' + res.status + ': ' + (await res.text()).slice(0, 200));
    const j = await res.json();
    return j.message.result.translatedText;
}

// MyMemory (무료·키 불필요) — 파파고 미지원 언어(아랍어 등) 주력
async function myMemoryTranslate(text, source, target) {
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${encodeURIComponent(source)}|${encodeURIComponent(target)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error('MyMemory ' + res.status);
    const j = await res.json();
    const out = j.responseData && j.responseData.translatedText;
    if (!out || /MYMEMORY WARNING|INVALID|QUERY LENGTH LIMIT/i.test(out)) {
        throw new Error('MyMemory 실패: ' + String(out || '빈 응답').slice(0, 80));
    }
    return out;
}

// 구글 비공식(무료) — 폴백용. 429(요청과다) 자주 발생하므로 보조로만 사용
async function googleTranslate(text, source, target) {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${encodeURIComponent(source)}&tl=${encodeURIComponent(target)}&dt=t&q=${encodeURIComponent(text)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error('Google translate ' + res.status);
    const j = await res.json();
    const out = (j[0] || []).map(seg => seg[0]).join('');
    if (!out) throw new Error('Google 빈 응답');
    return out;
}

ipcMain.handle('translate-text', async (event, { text, source = 'ko', target }) => {
    try {
        if (!text || !text.trim()) return { success: true, text: '' };
        let out;
        if (PAPAGO_LANGS.has(target)) {
            out = await papagoTranslate(text, source, target);
        } else {
            // 아랍어(ar) 등 파파고 미지원 언어: MyMemory 우선, 실패 시 구글 폴백
            try {
                out = await myMemoryTranslate(text, source, target);
            } catch (e1) {
                console.warn('[번역] MyMemory 실패, 구글 폴백 시도:', e1.message);
                out = await googleTranslate(text, source, target);
            }
        }
        return { success: true, text: out };
    } catch (e) {
        console.warn('[번역] 실패:', target, e.message);
        return { success: false, error: e.message };
    }
});

ipcMain.handle('generate-ai-image', async (event, data) => {
    try {
        const { brand, carClass, no, gen, year, code, includeLogo, mirrorSide, skipAI, bsaType, mirrorPath, manualBsa, country, labelStyle } = data;
        console.log('====================================');
        console.log('generate-ai-image triggered with bsaType:', bsaType, 'manualBsa:', manualBsa, 'country:', country);
        if (country && country !== 'KOREA') {
            return await generateIntlImage({ brand, carClass, no, gen, year, code, includeLogo, mirrorSide, skipAI, bsaType, mirrorPath, manualBsa, country });
        }

        if (!mirrorPath || !fs.existsSync(mirrorPath)) {
            throw new Error('거울 사진 파일을 찾을 수 없습니다.');
        }

        const savedLogoPath = path.join(__dirname, '..', 'data', 'saved_logo.png');
        if (!fs.existsSync(savedLogoPath)) {
            throw new Error('data/saved_logo.png 파일이 없습니다. 로고 파일을 먼저 준비해주세요.');
        }

        // 최종 캔버스 설정 (960 x 600)
        const width = 960;
        const height = 600;
        const canvas = createCanvas(width, height);
        const ctx = canvas.getContext('2d');

        // 하얀색 배경
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);

        // 상단 검은색 영역
        ctx.fillStyle = '#191919';
        ctx.fillRect(0, 0, width, 150);

        // 텍스트 설정
        const fontPath = path.join(__dirname, '..', 'data', 'NEXON_Lv2_Gothic_Bold.ttf');
        const fontName = fs.existsSync(fontPath) ? 'NexonGothic' : '"Malgun Gothic", "맑은 고딕", sans-serif';
        
        ctx.fillStyle = '#ffffff';
        ctx.font = `bold 45px ${fontName === 'NexonGothic' ? '"NexonGothic", "Malgun Gothic", "Tahoma", "Arial"' : fontName}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        
        // 빈 항목은 무시하고 자연스럽게 조합되도록 수정 (빈 값에 따른 불필요한 슬래시 등 제거)
        let line1Parts = [];
        if (brand) line1Parts.push(brand);
        if (carClass) line1Parts.push(carClass);
        let line1Str = line1Parts.join(' ');
        if (no) line1Str += ` [No.${no}]`;
        line1Str = line1Str.trim();
        
        ctx.textAlign = 'center';
        if (bsaType === 'bsaOption') {
            const diamond = '◆ ';
            const diamondWidth = ctx.measureText(diamond).width;
            const textWidth = ctx.measureText(line1Str).width;
            const totalWidth = diamondWidth + textWidth;
            const startX = (width - totalWidth) / 2;
            
            ctx.textAlign = 'left';
            ctx.fillStyle = '#FFD000'; // Yellow for diamond
            ctx.fillText(diamond, startX, 50);
            ctx.fillStyle = '#FFFFFF'; // White for the rest of the text
            ctx.fillText(line1Str, startX + diamondWidth, 50);
            ctx.textAlign = 'center';
        } else {
            ctx.fillStyle = '#FFFFFF';
            ctx.fillText(line1Str, width / 2, 50);
        }

        ctx.font = `bold 35px ${fontName === 'NexonGothic' ? '"NexonGothic", "Malgun Gothic", "Tahoma", "Arial"' : fontName}`;
        let line2Parts = [];
        if (gen) line2Parts.push(gen);
        if (year) line2Parts.push(year);
        if (code) line2Parts.push(code);
        
        if (bsaType === 'bsa') {
            line2Parts.push('BSA 가능');
            ctx.fillText(line2Parts.join(' / '), width / 2, 100);
        } else if (bsaType === 'bsaOption') {
            const baseLine2 = line2Parts.join(' / ') + (line2Parts.length > 0 ? ' / ' : '');
            const lastPart = 'BSA 선택옵션';
            
            const baseWidth = ctx.measureText(baseLine2).width;
            const lastWidth = ctx.measureText(lastPart).width;
            const totalWidth = baseWidth + lastWidth;
            const startX = (width - totalWidth) / 2;
            
            ctx.textAlign = 'left';
            ctx.fillStyle = '#FFFFFF';
            ctx.fillText(baseLine2, startX, 100);
            ctx.fillStyle = '#FFD000';
            ctx.fillText(lastPart, startX + baseWidth, 100);
            ctx.textAlign = 'center';
            ctx.fillStyle = '#FFFFFF';
        } else {
            ctx.fillText(line2Parts.join(' / '), width / 2, 100);
        }

        // 투명 여백을 자동으로 잘라내는 함수
        function trimCanvas(canvas) {
            const ctx = canvas.getContext('2d');
            const w = canvas.width;
            const h = canvas.height;
            const imageData = ctx.getImageData(0, 0, w, h);
            const dataArr = imageData.data;
            
            let top = null, bottom = null, left = null, right = null;
            
            for (let y = 0; y < h; y++) {
                for (let x = 0; x < w; x++) {
                    const alpha = dataArr[(y * w + x) * 4 + 3];
                    if (alpha > 0) {
                        if (top === null) top = y;
                        bottom = y;
                        if (left === null || x < left) left = x;
                        if (right === null || x > right) right = x;
                    }
                }
            }
            
            if (top === null) return canvas;
            
            const trimmedWidth = right - left + 1;
            const trimmedHeight = bottom - top + 1;
            const trimmedCanvas = createCanvas(trimmedWidth, trimmedHeight);
            trimmedCanvas.getContext('2d').drawImage(canvas, left, top, trimmedWidth, trimmedHeight, 0, 0, trimmedWidth, trimmedHeight);
            return trimmedCanvas;
        }

        // 거울 이미지 처리 함수
        async function getProcessedMirror(imagePath, maxWidth, maxHeight) {
            let img;
            try {
                const fileData = fs.readFileSync(imagePath);
                const blob = new Blob([fileData], { type: 'image/jpeg' });
                const formData = new FormData();
                formData.append('file', blob, 'mirror.jpg');
                
                // skipAI가 참이면 알고리즘 방식(predict_clean), 거짓이면 딥러닝 방식(predict) 호출
                const endpoint = skipAI ? `${AI_SERVER_URL}/predict_clean` : `${AI_SERVER_URL}/predict`;

                const _t0 = Date.now();
                const response = await fetch(endpoint, {
                    method: 'POST',
                    body: formData,
                    signal: AbortSignal.timeout(120000)   // AI 서버가 멈추면 5분(undici 기본) 대신 2분 뒤 실패로 끝낸다
                });

                if (!response.ok) {
                    throw new Error(`AI 서버 오류: ${response.statusText}`);
                }
                reportAiUsage(skipAI ? 'predict_clean' : 'predict', Date.now() - _t0);

                const arrayBuffer = await response.arrayBuffer();
                img = await loadImage(Buffer.from(arrayBuffer));
            } catch (error) {
                console.error('파이썬 AI 서버 통신 실패:', error);
                throw new Error('파이썬 AI 서버(FastAPI)와 통신할 수 없습니다. 파이썬 서버가 켜져 있는지 확인하세요.');
            }
            
            const initialCanvas = createCanvas(img.width, img.height);
            initialCanvas.getContext('2d').drawImage(img, 0, 0);
            
            const trimmedCanvas = trimCanvas(initialCanvas);
            
            const scale = Math.min(maxWidth / trimmedCanvas.width, maxHeight / trimmedCanvas.height);
            const targetWidth = trimmedCanvas.width * scale;
            const targetHeight = trimmedCanvas.height * scale;
            
            const tempCanvas = createCanvas(targetWidth, targetHeight);
            const tempCtx = tempCanvas.getContext('2d');
            tempCtx.drawImage(trimmedCanvas, 0, 0, targetWidth, targetHeight);
            
            if (!skipAI) {
                tempCtx.globalCompositeOperation = 'source-in';
                const gradient = tempCtx.createLinearGradient(0, 0, 0, targetHeight);
                gradient.addColorStop(0, '#b4b9c5');
                gradient.addColorStop(1, '#525252');
                tempCtx.fillStyle = gradient;
                tempCtx.fillRect(0, 0, targetWidth, targetHeight);
                tempCtx.globalCompositeOperation = 'source-over';
            }
            
            const finalImgCanvas = tempCanvas;
            
            const scaleFinal = Math.min(maxWidth / finalImgCanvas.width, maxHeight / finalImgCanvas.height);
            const finalTargetWidth = finalImgCanvas.width * scaleFinal;
            const finalTargetHeight = finalImgCanvas.height * scaleFinal;
            
            const resizedCanvas = createCanvas(finalTargetWidth, finalTargetHeight);
            resizedCanvas.getContext('2d').drawImage(finalImgCanvas, 0, 0, finalTargetWidth, finalTargetHeight);
            
            return resizedCanvas;
        }

        function flipCanvas(sourceCanvas) {
            const flippedCanvas = createCanvas(sourceCanvas.width, sourceCanvas.height);
            const flippedCtx = flippedCanvas.getContext('2d');
            flippedCtx.translate(sourceCanvas.width, 0);
            flippedCtx.scale(-1, 1);
            flippedCtx.drawImage(sourceCanvas, 0, 0);
            return flippedCanvas;
        }

        let mirrorImages = [];
        let labelLeftCenterX = 240;
        let labelRightCenterX = 720;
        const centerY = 330;

        if (mirrorSide === 'both') {
            const bothCanvas = await getProcessedMirror(mirrorPath, 820, 300);
            mirrorImages.push({
                canvas: bothCanvas,
                x: 480 - bothCanvas.width / 2,
                y: centerY - bothCanvas.height / 2
            });
            labelLeftCenterX = 480 - bothCanvas.width / 4;
            labelRightCenterX = 480 + bothCanvas.width / 4;
        } else {
            const singleCanvas = await getProcessedMirror(mirrorPath, 390, 300);
            const flippedCanvas = flipCanvas(singleCanvas);
            const gap = 40; 
            const y = centerY - singleCanvas.height / 2;
            const leftX = 480 - (gap / 2) - singleCanvas.width;
            const rightX = 480 + (gap / 2);

            if (mirrorSide === 'driver') {
                mirrorImages.push({ canvas: singleCanvas, x: leftX, y: y });
                mirrorImages.push({ canvas: flippedCanvas, x: rightX, y: y });
            } else if (mirrorSide === 'passenger') {
                mirrorImages.push({ canvas: flippedCanvas, x: leftX, y: y });
                mirrorImages.push({ canvas: singleCanvas, x: rightX, y: y });
            }
            
            labelLeftCenterX = leftX + singleCanvas.width / 2;
            labelRightCenterX = rightX + singleCanvas.width / 2;
        }

        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 0;

        for (const img of mirrorImages) {
            ctx.drawImage(img.canvas, img.x, img.y);
        }

        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 0;

        // BSA 로고 오버레이 추가 (manualBsa가 아닐 때만 자동 위치 계산 후 그림. Excel 일괄 처리 등)
        if (bsaType === 'bsa' && !manualBsa) {
            const bsaLogoPath = path.join(__dirname, '..', 'data', 'bsa_logo.png');
            if (fs.existsSync(bsaLogoPath)) {
                const bsaBuffer = fs.readFileSync(bsaLogoPath);
                const bsaImg = await loadImage(bsaBuffer);
                
                // 왼쪽에 위치한 미러(mirrorImages[0]) 기준으로 위치 계산
                const leftMirror = mirrorImages[0];
                
                // 비율 계산 (로고의 가로 크기를 70px로 고정)
                const targetBsaW = 70;
                const bsaScale = targetBsaW / bsaImg.width;
                const targetBsaH = bsaImg.height * bsaScale;
                
                // 기본 위치 계산 (왼쪽 가장자리 근처)
                let bsaX = leftMirror.x + leftMirror.canvas.width * 0.12;
                let bsaY = leftMirror.y + leftMirror.canvas.height * 0.65 - (targetBsaW / 2);
                
                if (mirrorSide === 'both') {
                    bsaX = leftMirror.x + leftMirror.canvas.width * 0.08;
                    bsaY = leftMirror.y + leftMirror.canvas.height * 0.70 - (targetBsaW / 2);
                }
                
                ctx.drawImage(bsaImg, bsaX, bsaY, targetBsaW, targetBsaH);
            }
        }

        if (includeLogo) {
            const logoBuffer = fs.readFileSync(savedLogoPath);
            const logoImg = await loadImage(logoBuffer);
            const maxLWidth = 680;
            const maxLHeight = 150;
            const logoScale = Math.min(maxLWidth / logoImg.width, maxLHeight / logoImg.height);
            const lWidth = logoImg.width * logoScale;
            const lHeight = logoImg.height * logoScale;
            const lX = (width - lWidth) / 2;
            const lY = 150 + (450 - lHeight) / 2;
            ctx.drawImage(logoImg, lX, lY, lWidth, lHeight);
        }

        const labelY = 530;
        const labelW = 160;
        const labelH = 45;
        ctx.fillStyle = '#1e1e1e';
        ctx.fillRect(labelLeftCenterX - labelW / 2, labelY, labelW, labelH);
        ctx.fillRect(labelRightCenterX - labelW / 2, labelY, labelW, labelH);

        ctx.fillStyle = '#ffffff';
        ctx.font = `bold 30px ${fontName === 'NexonGothic' ? '"NexonGothic", "Malgun Gothic", "Tahoma", "Arial"' : fontName}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        
        // labelStyle==='LR' 이면 운전석/조수석 대신 L/R 표기 (범용 탭의 비-한국 나라용)
        const _driverLbl = labelStyle === 'LR' ? 'L' : '운전석';
        const _passLbl   = labelStyle === 'LR' ? 'R' : '조수석';
        if (mirrorSide === 'passenger') {
            ctx.fillText(_passLbl,   labelLeftCenterX,  labelY + labelH / 2);
            ctx.fillText(_driverLbl, labelRightCenterX, labelY + labelH / 2);
        } else {
            ctx.fillText(_driverLbl, labelLeftCenterX,  labelY + labelH / 2);
            ctx.fillText(_passLbl,   labelRightCenterX, labelY + labelH / 2);
        }

        const finalBuffer = await canvas.encode('jpeg');   // 비동기 인코딩 — 동기 toBuffer 와 같은 바이트, 메인 스레드를 막지 않는다
        
        const outputDir = AI_OUTPUT_DIR;
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }
        const outputPath = path.join(outputDir, 'latest_generated.jpg');
        fs.writeFileSync(outputPath, finalBuffer);
        try { fs.writeFileSync(path.join(outputDir, 'latest_korea.jpg'), finalBuffer); } catch {}
        // 새 사진에 지난 차의 조견표 URL 이 따라붙지 않게 한다 — 올리면 esm-upload 가 다시 쓴다.
        fs.rmSync(path.join(outputDir, 'latest_korea_html.txt'), { force: true });

        return { success: true, base64: finalBuffer.toString('base64'), outputPath };

    } catch (error) {
        console.error('이미지 생성 중 오류 발생:', error);
        return { success: false, error: error.message };
    }
});
// ══════════════════════════════════════════════════════════════
// International template (USA / JAPAN / ARAB) - 3000x1800
// Background: white | Logo: data/intl_logo.png (watermark)
// ══════════════════════════════════════════════════════════════
async function generateIntlImage({ brand, carClass, no, gen, year, code, includeLogo, mirrorSide, skipAI, bsaType, mirrorPath, manualBsa, country }) {
    if (!mirrorPath || !fs.existsSync(mirrorPath)) {
        throw new Error('Mirror image file not found.');
    }
    const logoPath = path.join(__dirname, '..', 'data', 'intl_logo.png');
    const W = 3000, H = 1800;
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);

    function trimCanvas(src) {
        const sc = src.getContext('2d');
        // 캔버스 width/height 는 네이티브 getter 다. 픽셀마다 읽으면 12MP 에서 1.7초 동안 앱 전체가 멈췄다(국내판 trimCanvas 는 47ms).
        const w = src.width, h = src.height;
        const d = sc.getImageData(0, 0, w, h).data;
        let t = null, b = null, l = null, r = null;
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                if (d[(y * w + x) * 4 + 3] > 0) {
                    if (t === null) t = y; b = y;
                    if (l === null || x < l) l = x;
                    if (r === null || x > r) r = x;
                }
            }
        }
        if (t === null) return src;
        const tw = r - l + 1, th = b - t + 1;
        const out = createCanvas(tw, th);
        out.getContext('2d').drawImage(src, l, t, tw, th, 0, 0, tw, th);
        return out;
    }

    async function getMirror(imgPath, maxW, maxH) {
        const blob = new Blob([fs.readFileSync(imgPath)], { type: 'image/jpeg' });
        const fd = new FormData();
        fd.append('file', blob, 'mirror.jpg');
        const ep = skipAI ? `${AI_SERVER_URL}/predict_clean` : `${AI_SERVER_URL}/predict`;
        const _t0 = Date.now();
        const res = await fetch(ep, { method: 'POST', body: fd, signal: AbortSignal.timeout(120000) });
        if (!res.ok) throw new Error('AI server error: ' + res.statusText);
        reportAiUsage(skipAI ? 'predict_clean' : 'predict', Date.now() - _t0);
        const img = await loadImage(Buffer.from(await res.arrayBuffer()));
        const raw = createCanvas(img.width, img.height);
        raw.getContext('2d').drawImage(img, 0, 0);
        const trimmed = trimCanvas(raw);
        const scale = Math.min(maxW / trimmed.width, maxH / trimmed.height);
        const fw = trimmed.width * scale, fh = trimmed.height * scale;
        const result = createCanvas(fw, fh);
        const rc = result.getContext('2d');
        rc.drawImage(trimmed, 0, 0, fw, fh);
        if (!skipAI) {
            rc.globalCompositeOperation = 'source-in';
            const grad = rc.createLinearGradient(0, 0, 0, fh);
            grad.addColorStop(0, '#b4b9c5');
            grad.addColorStop(1, '#525252');
            rc.fillStyle = grad;
            rc.fillRect(0, 0, fw, fh);
            rc.globalCompositeOperation = 'source-over';
        }
        return result;
    }

    function flipCanvas(src) {
        const f = createCanvas(src.width, src.height);
        const fc = f.getContext('2d');
        fc.translate(src.width, 0);
        fc.scale(-1, 1);
        fc.drawImage(src, 0, 0);
        return f;
    }

    const marginTop = 80, marginBottom = 300;
    const mirrorAreaH = H - marginTop - marginBottom;   // 1420px
    const mirrorAreaW = W - 200;                         // 좌우 여백 100px씩
    const centerX = W / 2;
    const centerY = marginTop + mirrorAreaH / 2;
    let mirrorImages = [], labelLeftCX, labelRightCX;

    if (mirrorSide === 'both') {
        const mc = await getMirror(mirrorPath, mirrorAreaW, mirrorAreaH);
        mirrorImages.push({ canvas: mc, x: centerX - mc.width / 2, y: centerY - mc.height / 2 });
        labelLeftCX  = centerX - mc.width / 4;
        labelRightCX = centerX + mc.width / 4;
    } else {
        const single = await getMirror(mirrorPath, (mirrorAreaW - 120) / 2, mirrorAreaH);
        const flipped = flipCanvas(single);
        const gap = 120;
        const leftX  = centerX - gap / 2 - single.width;
        const rightX = centerX + gap / 2;
        const y = centerY - single.height / 2;
        if (mirrorSide === 'driver') {
            mirrorImages.push({ canvas: single,  x: leftX,  y });
            mirrorImages.push({ canvas: flipped, x: rightX, y });
        } else {
            mirrorImages.push({ canvas: flipped, x: leftX,  y });
            mirrorImages.push({ canvas: single,  x: rightX, y });
        }
        labelLeftCX  = leftX  + single.width / 2;
        labelRightCX = rightX + single.width / 2;
    }

    // 거울 그리기 (흰 배경 위)
    for (const m of mirrorImages) ctx.drawImage(m.canvas, m.x, m.y);

    // BSA 로고
    if (bsaType === 'bsa' && !manualBsa) {
        const bsaLogoPath = path.join(__dirname, '..', 'data', 'bsa_logo.png');
        if (fs.existsSync(bsaLogoPath)) {
            const bsaImg = await loadImage(fs.readFileSync(bsaLogoPath));
            const lm = mirrorImages[0];
            const bW = 220;
            const bH = bsaImg.height * (bW / bsaImg.width);
            ctx.drawImage(bsaImg, lm.x + lm.canvas.width * 0.08, lm.y + lm.canvas.height * 0.65 - bH / 2, bW, bH);
        }
    }

    // 로고: 비율 유지, 약간 작게 — 높이 420px 기준으로 너비 자동 계산
    if (includeLogo && fs.existsSync(logoPath)) {
        const logoImg = await loadImage(fs.readFileSync(logoPath));
        const logoDrawH = 520;                                    // 높이 약간 키움
        const logoDrawW = logoImg.width * (logoDrawH / logoImg.height); // 비율 유지
        const logoX = (W - logoDrawW) / 2;
        const logoY = 680;
        ctx.globalAlpha = 1.0;   // 투명도 100%
        ctx.drawImage(logoImg, logoX, logoY, logoDrawW, logoDrawH);
        ctx.globalAlpha = 1.0;
    }

    // L/R 박스: 260×160px
    const labelBoxW = 260, labelBoxH = 160;
    const labelY = H - labelBoxH - 60;
    ctx.fillStyle = '#111111';
    ctx.fillRect(labelLeftCX  - labelBoxW / 2, labelY, labelBoxW, labelBoxH);
    ctx.fillRect(labelRightCX - labelBoxW / 2, labelY, labelBoxW, labelBoxH);

    const fp = path.join(__dirname, '..', 'data', 'NEXON_Lv2_Gothic_Bold.ttf');
    const fn = fs.existsSync(fp) ? 'NexonGothic' : 'Malgun Gothic';
    ctx.fillStyle = '#ffffff';
    ctx.font = '900 100px "' + fn + '", "Malgun Gothic"';   // 900 weight = 가장 두꺼운 bold
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const isP = mirrorSide === 'passenger';
    ctx.fillText(isP ? 'R' : 'L', labelLeftCX,  labelY + labelBoxH / 2);
    ctx.fillText(isP ? 'L' : 'R', labelRightCX, labelY + labelBoxH / 2);

    const finalBuffer = await canvas.encode('jpeg');   // 예전 { quality: 0.93 } 인자는 무시돼 기본 품질이었다 — 같은 바이트
    const outputDir = AI_OUTPUT_DIR;
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
    const outputPath = path.join(outputDir, 'latest_generated.jpg');
    fs.writeFileSync(outputPath, finalBuffer);
    try { fs.writeFileSync(path.join(outputDir, 'latest_global.jpg'), finalBuffer); } catch {}
    fs.rmSync(path.join(outputDir, 'latest_global_html.txt'), { force: true });   // 지난 차의 조견표 URL 을 버린다(위와 같은 이유)
    return { success: true, base64: finalBuffer.toString('base64'), outputPath };
}
