// 보안 연결(SSL) 인증서 검증 무시 (쿠팡 API 등 연동 시 인증서 오류 방지)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { NaverSmartStore } from './platforms/naver_smartstore.js';
import { NaverSmartStoreEdit } from './platforms/naver_smartstore_edit.js';
import { ImwebEdit } from './platforms/imweb_edit.js';
import { ESMPlusHosting } from './platforms/esmplus_hosting.js';
import { Coupang, findProductIdsFromSheet } from './platforms/coupang.js';
import { Imweb } from './platforms/imweb.js';
import { chromium } from 'playwright';
import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas';

import { spawn } from 'child_process';
import os from 'os';
import electronUpdater from 'electron-updater';
import { serverLogin, fetchCredentials } from './utils/server_keys.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
const AI_SERVER_URL = (process.env.AI_SERVER_URL || 'http://localhost:8000').replace(/\/+$/, '');
// 원격 서버를 쓰면 각 PC에서 로컬 AI(807MB exe)를 띄울 필요가 없다.
const AI_IS_LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(AI_SERVER_URL);

// 관리자/인증키 서버 주소 (직원 로그인 · 인증키 조회). 배포 시 서버 PC 주소로 교체.
const ADMIN_SERVER_URL = (process.env.ADMIN_SERVER_URL || 'http://localhost:8001').replace(/\/+$/, '');
// 로그인 후 발급받은 토큰·직원정보 (메모리에만 보관, 파일로 저장하지 않음)
let serverAuth = null;
// 서버에서 받은 "로그인(아이디/비번)" 인증키 (플랫폼별). 브라우저 로그인 자동입력에 쓴다.
// 메모리에만 보관 → 파일로 안 남김.
let serverCreds = {};

/** 디버그 파일용 임시 폴더 (없어도 조용히 무시) */
function debugDir() {
    try {
        const d = path.join(os.tmpdir(), 'antigravity-debug');
        if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
        return d;
    } catch { return null; }
}

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
// 설치본에 포함된 data/defaults/* (네이버·ESM·아임웹 세션, 쿠팡 API키, 아임웹 설정)를
// 각 PC 첫 실행 시 userData 로 복사한다. 이미 있으면(직원이 재로그인한 경우 등) 건드리지 않는다.
function seedSharedDefaults() {
    try {
        const ud = app.getPath('userData');
        const defDir = path.join(__dirname, '..', 'data', 'defaults');
        if (!fs.existsSync(defDir)) return;
        for (const f of fs.readdirSync(defDir)) {
            const dest = path.join(ud, f);
            if (!fs.existsSync(dest)) {
                try { fs.copyFileSync(path.join(defDir, f), dest); }
                catch (e) { console.error('공용 로그인 시드 실패:', f, e.message); }
            }
        }
    } catch (e) { console.error('공용 로그인 시드 실패:', e.message); }
}

// 폰트 등록
const fontPath = path.join(__dirname, '..', 'data', 'NEXON_Lv2_Gothic_Bold.ttf');
if (fs.existsSync(fontPath)) {
    GlobalFonts.registerFromPath(fontPath, 'NexonGothic');
}

let mainWindow;
let launcherWindow;
let seedWindow;
let upWindow;
let browser;

// ── Coupang instance (API-based, no browser needed) ──
let coupangInstance = null;
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
        coupangInstance = new Coupang(configPath);
    }
    return coupangInstance;
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
        
        // ImwebEdit 는 Imweb 을 상속하므로 기존 기능(복사등록/게시판)은 그대로 쓰면서,
        // 내부 관리자 API(가격 상속)와 registerB2bViaApi 도 함께 갖는다.
        imwebInstance = new ImwebEdit(configPath, getBrowserSync);
    }
    // 서버에서 받은 아임웹 로그인정보(있으면)를 붙여준다 → login()에서 자동입력에 사용
    imwebInstance.autoLogin = serverCreds['imweb'] || null;
    return imwebInstance;
}

// ── ESM instance (singleton) ──
let esmInstance = null;
function getESM() {
    if (!esmInstance) {
        const b = getBrowserSync();
        const sessionPath = path.join(app.getPath('userData'), 'session_esmplus.json');
        esmInstance = new ESMPlusHosting(b, sessionPath);
    }
    esmInstance.autoLogin = serverCreds['esm'] || null;
    return esmInstance;
}

// ── Naver instance (singleton) ──
let naverInstance = null;
function getNaver() {
    if (!naverInstance) {
        const b = getBrowserSync();
        const sessionPath = path.join(app.getPath('userData'), 'session_naver.json');
        naverInstance = new NaverSmartStore(b, sessionPath);
    }
    naverInstance.autoLogin = serverCreds['naver'] || null;
    return naverInstance;
}

// ── Naver "기존 상품 수정" instance (별도 인스턴스: 복사등록과 분리) ──
let naverEditInstance = null;
function getNaverEdit() {
    if (!naverEditInstance) {
        const b = getBrowserSync();
        const sessionPath = path.join(app.getPath('userData'), 'session_naver.json');
        naverEditInstance = new NaverSmartStoreEdit(b, sessionPath);
    }
    naverEditInstance.browser = getBrowserSync();
    naverEditInstance.autoLogin = serverCreds['naver'] || null;
    return naverEditInstance;
}

// Synchronous browser getter (returns existing or null)
function getBrowserSync() {
    return browser;
}

function createLauncher() {
    launcherWindow = new BrowserWindow({
        width: 680, height: 480, resizable: false, frame: false,
        webPreferences: { nodeIntegration: true, contextIsolation: false },
        title: 'VERY UP VER2',
    });
    launcherWindow.loadFile(path.join(__dirname, 'ui/launcher.html'));
}
function createSeedWindow() {
    seedWindow = new BrowserWindow({
        width: 1400, height: 900, frame: false,
        webPreferences: { nodeIntegration: true, contextIsolation: false },
        title: 'VERY SEED',
    });
    seedWindow.loadFile(path.join(__dirname, 'ui/index_seed.html'));
    if (launcherWindow) launcherWindow.hide();
}
function createUpWindow() {
    upWindow = new BrowserWindow({
        width: 1400, height: 900, frame: false,
        webPreferences: { nodeIntegration: true, contextIsolation: false },
        title: 'VERY UP',
    });
    upWindow.loadFile(path.join(__dirname, 'ui/index_up.html'));
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
        fs.writeFileSync(p, JSON.stringify({ ...cur, ...data }, null, 2), 'utf-8');
    } catch (e) { console.warn('설정 병합 실패:', filename, e.message); }
}
async function syncCredentialsFromServer() {
    if (!serverAuth) return;
    try {
        const creds = await fetchCredentials(ADMIN_SERVER_URL, serverAuth.token);
        serverCreds = {};
        let n = 0;
        for (const c of creds) {
            if (!c.data) continue;
            if (c.data.loginId) {
                // 로그인(아이디/비번) 종류 → 브라우저 로그인 자동입력용으로 메모리에 보관
                serverCreds[c.platform] = c.data; n++;
            } else if (c.platform === 'coupang') {
                mergeIntoConfig('coupang_config.json', c.data); n++;
            } else if (c.platform === 'imweb') {
                mergeIntoConfig('imweb_config.json', c.data); n++;
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
        await syncCredentialsFromServer();
        return { ok: true, name: serverAuth.name, role: serverAuth.role };
    } catch (e) {
        serverAuth = null;
        return { ok: false, error: e.message };
    }
});
ipcMain.handle('server-status', () => ({ loggedIn: !!serverAuth, name: serverAuth ? serverAuth.name : null }));

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

ipcMain.on('launch-app', (event, appName) => {
    if (appName === 'seed') createSeedWindow();
    else if (appName === 'up') createUpWindow();
});
ipcMain.on('close-app', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) win.close();
    if (launcherWindow) launcherWindow.show(); else createLauncher();
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

// ── 자동 업데이트 ────────────────────────────────────────────────
// 클라우드 스토리지(정적 HTTP)에 올린 latest.yml / 설치파일 / .blockmap 을 보고
// 새 버전이 있으면 백그라운드로 받은 뒤, 다 받으면 사용자에게 "지금 설치" 를 물어본다.
// (개발 중에는 동작 안 함 — 설치본에서만 동작)
function setupAutoUpdate() {
    if (!app.isPackaged) return;
    try {
        const { autoUpdater } = electronUpdater;
        autoUpdater.autoDownload = true;
        autoUpdater.autoInstallOnAppQuit = true;
        const notify = (msg) => { try { if (mainWindow) mainWindow.webContents.send('log', `[업데이트] ${msg}`); } catch {} };

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
                detail: '지금 재시작하면 업데이트가 적용됩니다. "나중에" 를 누르면 다음 종료 시 자동 설치됩니다.',
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
    startAiServers();
    setupAutoUpdate();
  });
});

app.on('before-quit', () => { stopAiServers(); });

app.on('window-all-closed', async () => {
  // Clean up browser resources
  if (browser) {
    try { await browser.close(); } catch(e) { console.error('Browser cleanup error:', e); }
    browser = null;
  }
  // Reset singleton instances that depend on browser
  esmInstance = null;
  naverInstance = null;
  stopAiServers();
  if (process.platform !== 'darwin') app.quit();
});

// Helper to get or launch browser
async function getBrowser() {
    if (!browser) {
        browser = await chromium.launch({ 
            headless: false,
            channel: 'msedge' // Use pre-installed Edge for portability
        });
    }
    return browser;
}

// File dialog handler
ipcMain.handle('select-file', async (event, { filters }) => {
    const result = await dialog.showOpenDialog(mainWindow, {
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

// ESM Handlers
ipcMain.handle('esm-login', async () => {
    try {
        await getBrowser();
        const esm = getESM();
        // Re-assign browser reference if it was re-created
        esm.browser = browser;
        await esm.login();
        return { success: true };
    } catch (error) {
        console.error(error);
        return { success: false, error: error.message };
    }
});

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
        esm.browser = browser;
        
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
        esm.browser = browser;
        
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
ipcMain.handle('naver-login', async () => {
    try {
        await getBrowser();
        const naver = getNaver();
        naver.browser = browser;
        await naver.login();
        return { success: true };
    } catch (error) {
        console.error(error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('naver-register', async (event, data) => {
    try {
        await getBrowser();
        const naver = getNaver();
        naver.browser = browser;
        
        const loginSuccess = await naver.login();
        if (!loginSuccess) {
            return { success: false, error: '스마트스토어 로그인이 필요합니다. 먼저 로그인 창을 열어 로그인해주세요.' };
        }
        
        // Let the platform script handle the copy registration
        const resultUrl = await naver.copyAndRegisterProduct(data);
        
        return { success: true, url: resultUrl };
    } catch (error) {
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

// 쿠팡 카테고리 조회
ipcMain.handle('coupang-get-categories', async () => {
    try {
        const coupang = getCoupang();
        coupang.loadConfig();
        const result = await coupang.getCategories();
        return { success: true, data: result?.data || [] };
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
        const result = await coupang.copyRegisterProduct(data);
        return { 
            success: true, 
            productId: result?.data,
            message: `상품이 성공적으로 등록되었습니다. (ID: ${result?.data})`
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
        await getBrowser();
        const ss = getNaverEdit();
        ss.logCallback = (msg) => {
            if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('naver-log', msg);
        };
        const rows = await ss.searchProductsByName(brand, model);
        return { success: true, rows };
    } catch (error) {
        console.error(error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('smartstore-load-product', async (event, productNo) => {
    try {
        await getBrowser();
        const ss = getNaverEdit();
        ss.logCallback = (msg) => {
            if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('naver-log', msg);
        };
        const product = await ss.loadProductForEdit(productNo);
        return { success: true, product };
    } catch (error) {
        console.error(error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('smartstore-update-product', async (event, data) => {
    try {
        await getBrowser();
        const ss = getNaverEdit();
        ss.logCallback = (msg) => {
            if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('naver-log', msg);
        };
        const result = await ss.updateProduct(data);
        return { success: true, message: `상품이 수정되었습니다. (${result.verified})` };
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
        const result = await coupang.updateExistingProduct(data);
        return { 
            success: true, 
            productId: data.productId,
            message: `상품이 성공적으로 수정되었습니다. (ID: ${data.productId})`
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

ipcMain.handle('imweb-sync-categories', async () => {
    try {
        await getBrowser();
        const imweb = getImweb();
        imweb.browser = browser;
        imweb.logCallback = (msg) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('imweb-log', msg);
            }
        };
        const categories = await imweb.syncCategories();
        return { success: true, categories };
    } catch (error) {
        console.error(error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('imweb-load-config', async () => {
    try {
        const imweb = getImweb();
        const config = imweb.loadConfig();
        return { success: true, config };
    } catch (error) {
        return {
            success: true,
            config: {
                b2bUrl: 'https://bbstore37.imweb.me/admin/',
                b2bId: '',
                headUrl: 'https://optic-glass.imweb.me/admin',
                headId: '',
                usUrl: 'https://optic-glass-us.imweb.me/admin',
                usId: ''
            }
        };
    }
});

ipcMain.handle('imweb-save-config', async (event, newConfig) => {
    try {
        const imweb = getImweb();
        imweb.saveConfig(newConfig);
        return { success: true };
    } catch (error) {
        console.error(error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('imweb-login', async (event, { targetUrl } = {}) => {
    try {
        await getBrowser();
        const imweb = getImweb();
        imweb.browser = browser;
        
        imweb.logCallback = (msg) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('imweb-log', msg);
            }
        };

        const success = await imweb.login(targetUrl);
        return { success };
    } catch (error) {
        console.error(error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('imweb-register', async (event, data) => {
    try {
        await getBrowser();
        const imweb = getImweb();
        imweb.browser = browser;

        // Route logs to the tab that started this run: B2B → imweb-log,
        // 본사·해외몰 게시판 → imweb-board-log.
        const channel = data.targetB2b ? 'imweb-log' : 'imweb-board-log';
        imweb.logCallback = (msg) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send(channel, msg);
            }
        };

        const resultMessage = await imweb.executeAutomation(data);
        return { success: true, message: resultMessage };
    } catch (error) {
        console.error(error);
        return { success: false, error: error.message };
    }
});

// ── 아임웹 B2B 기존 상품 수정 (내부 API 기반, 복사등록과 분리) ──
let imwebEditInstance = null;
function getImwebEdit() {
    if (!imwebEditInstance) {
        const configPath = path.join(app.getPath('userData'), 'imweb_config.json');
        imwebEditInstance = new ImwebEdit(configPath, getBrowserSync);
    }
    imwebEditInstance.browser = browser;
    imwebEditInstance.autoLogin = serverCreds['imweb'] || null;
    imwebEditInstance.logCallback = (msg) => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('imweb-log', msg);
    };
    return imwebEditInstance;
}

// 상품 번호(idx)로 제조사/차종/코드 추출
ipcMain.handle('imweb-extract-product-info', async (event, { idx }) => {
    try {
        await getBrowser();
        const info = await getImwebEdit().extractProductInfo(idx);
        return { success: true, info };
    } catch (error) {
        console.error(error);
        return { success: false, error: error.message };
    }
});

// 제조사/차종/코드로 검색 — 세트+개별을 한 묶음으로 반환
ipcMain.handle('imweb-search-products', async (event, { brand, model, code, idx }) => {
    try {
        await getBrowser();
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
        await getBrowser();
        const group = await getImwebEdit().loadGroup(prodNos);
        group.products.forEach(p => { delete p._raw; });   // 원본 전체는 렌더러로 넘기지 않는다
        return { success: true, group };
    } catch (error) {
        console.error(error);
        return { success: false, error: error.message };
    }
});

// 짝을 한 번에 수정
ipcMain.handle('imweb-update-group', async (event, data) => {
    try {
        await getBrowser();
        const result = await getImwebEdit().updateGroup(data);
        return { success: true, message: result };
    } catch (error) {
        console.error(error);
        return { success: false, error: error.message };
    }
});

// 본사·해외몰 게시글 수정 (내부 API 기반)
function getImwebBoardEdit() {
    const e = getImwebEdit();
    e.logCallback = (msg) => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('imweb-board-log', msg);
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
ipcMain.handle('imweb-load-post', async (event, { postCode }) => {
    try {
        await getBrowser();
        const post = await getImwebBoardEdit().loadPost(postCode);
        return { success: true, post };
    } catch (error) {
        console.error(error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('imweb-update-post', async (event, data) => {
    try {
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
ipcMain.handle('generate-ai-image', async (event, data) => {
    try {
        const { brand, carClass, no, gen, year, code, includeLogo, mirrorSide, skipAI, bsaType, mirrorPath, manualBsa, country } = data;
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
        ctx.font = `bold 45px ${fontName === 'NexonGothic' ? '"NexonGothic", "Malgun Gothic"' : fontName}`;
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

        ctx.font = `bold 35px ${fontName === 'NexonGothic' ? '"NexonGothic", "Malgun Gothic"' : fontName}`;
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
                    body: formData
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
        ctx.font = `bold 30px ${fontName === 'NexonGothic' ? '"NexonGothic", "Malgun Gothic"' : fontName}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        
        if (mirrorSide === 'passenger') {
            ctx.fillText("조수석", labelLeftCenterX, labelY + labelH / 2);
            ctx.fillText("운전석", labelRightCenterX, labelY + labelH / 2);
        } else {
            ctx.fillText("운전석", labelLeftCenterX, labelY + labelH / 2);
            ctx.fillText("조수석", labelRightCenterX, labelY + labelH / 2);
        }

        const finalBuffer = canvas.toBuffer('image/jpeg');
        
        const outputDir = AI_OUTPUT_DIR;
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }
        const outputPath = path.join(outputDir, 'latest_generated.jpg');
        fs.writeFileSync(outputPath, finalBuffer);

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
        const d = sc.getImageData(0, 0, src.width, src.height).data;
        let t = null, b = null, l = null, r = null;
        for (let y = 0; y < src.height; y++) {
            for (let x = 0; x < src.width; x++) {
                if (d[(y * src.width + x) * 4 + 3] > 0) {
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
        const res = await fetch(ep, { method: 'POST', body: fd });
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

    const finalBuffer = canvas.toBuffer('image/jpeg', { quality: 0.93 });
    const outputDir = AI_OUTPUT_DIR;
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
    const outputPath = path.join(outputDir, 'latest_generated.jpg');
    fs.writeFileSync(outputPath, finalBuffer);
    return { success: true, base64: finalBuffer.toString('base64'), outputPath };
}