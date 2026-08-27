// 蹂댁븞 ?곌껐(SSL) ?몄쬆??寃利?臾댁떆 (荑좏뙜 API ???곕룞 ???몄쬆???ㅻ쪟 諛⑹?)
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ?? 諛고룷 ?댁떇 寃쎈줈 ????????????????????????????????????????????????
// AI ?앹꽦湲곕뒗 ?깃낵 遺꾨━ 諛고룷?쒕떎(?⑸웾 ?????먮룞 ?낅뜲?댄듃 ??곸뿉???쒖쇅).
// ?ㅼ튂蹂몄뿉?쒕뒗 怨좎젙 ?몃? 寃쎈줈(%LOCALAPPDATA%\OpticGlassAI)??理쒖큹 1???ㅼ튂??寃껋쓣 ?곌퀬,
// 媛쒕컻 以묒뿉??湲곗〈 媛쒕컻 ?대뜑瑜??대떎. ??寃쎌슦 紐⑤몢 ?섍꼍蹂??AI_GEN_DIR 濡???뼱?????덈떎.
const AI_GEN_DIR = process.env.AI_GEN_DIR || (app.isPackaged
    ? path.join(process.env.LOCALAPPDATA || app.getPath('appData'), 'OpticGlassAI')
    : 'C:\\Users\\wish\\.gemini\\antigravity\\scratch\\auto_image_generator');
// ?ㅼ튂蹂몄쓽 resources ?대뜑???곌린 遺덇?(Program Files)?대?濡?AI 寃곌낵쨌?낅줈?쒕뒗
// ??긽 ?곌린 媛?ν븳 userData ?꾨옒???붾떎. server.js ?먮룄 媛숈? 寃쎈줈瑜??섍릿??
const AI_OUTPUT_DIR = path.join(app.getPath('userData'), 'ai_output');
const AI_UPLOAD_DIR = path.join(app.getPath('userData'), 'ai_uploads');

/** ?붾쾭洹??뚯씪???꾩떆 ?대뜑 (?놁뼱??議곗슜??臾댁떆) */
function debugDir() {
    try {
        const d = path.join(os.tmpdir(), 'antigravity-debug');
        if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
        return d;
    } catch { return null; }
}

// AI ?앹꽦湲??뚯씠???멸렇硫섑뀒?댁뀡 ?쒕쾭 + ?몃뱶 ?대?吏?⑹꽦 ?쒕쾭) ?먮룞 ?ㅽ뻾/醫낅즺
let aiProcs = [];
function startAiServers() {
    try {
        if (!fs.existsSync(AI_GEN_DIR)) {
            console.warn('AI ?앹꽦湲??대뜑媛 ?놁뼱 AI ?쒕쾭瑜??쒖옉?섏? ?딆뒿?덈떎:', AI_GEN_DIR);
            return;
        }
        // 1) ?뚯씠???멸렇硫섑뀒?댁뀡 ?쒕쾭 (PyInstaller 踰덈뱾 exe, ?ы듃 8000)
        const pyExe = path.join(AI_GEN_DIR, 'ai_server', 'dist', 'ai_server', 'ai_server.exe');
        if (fs.existsSync(pyExe)) {
            aiProcs.push(spawn(pyExe, [], { cwd: path.join(AI_GEN_DIR, 'ai_server'), detached: false, stdio: 'ignore' }));
        } else {
            console.warn('?뚯씠??AI ?쒕쾭 exe ?놁쓬:', pyExe);
        }
        // 2) ?몃뱶 ?대?吏?⑹꽦 ?쒕쾭 (server.js, ?ы듃 3000) ??Electron ?댁옣 ?몃뱶濡??ㅽ뻾 (?쒖뒪??node 遺덊븘??
        const serverJs = path.join(AI_GEN_DIR, 'server.js');
        if (fs.existsSync(serverJs)) {
            try { if (!fs.existsSync(AI_OUTPUT_DIR)) fs.mkdirSync(AI_OUTPUT_DIR, { recursive: true }); } catch {}
            try { if (!fs.existsSync(AI_UPLOAD_DIR)) fs.mkdirSync(AI_UPLOAD_DIR, { recursive: true }); } catch {}
            aiProcs.push(spawn(process.execPath, [serverJs], {
                cwd: AI_GEN_DIR, detached: false, stdio: 'ignore',
                env: {
                    ...process.env,
                    ELECTRON_RUN_AS_NODE: '1',
                    AI_OUTPUT_DIR,   // server.js 媛 寃곌낵 ?대?吏瑜??ш린???곕룄濡?                    AI_UPLOAD_DIR,   // multer ?낅줈?쒕룄 ?곌린 媛?ν븳 怨녹쑝濡?                },
            }));
        }
    } catch (e) {
        console.error('AI ?쒕쾭 ?쒖옉 ?ㅽ뙣(臾댁떆?섍퀬 怨꾩냽):', e.message);
    }
}
function stopAiServers() {
    for (const p of aiProcs) { try { p.kill(); } catch {} }
    aiProcs = [];
}

// ?뚯궗 怨듭슜 怨꾩젙 濡쒓렇???쒕뱶:
// ?ㅼ튂蹂몄뿉 ?ы븿??data/defaults/* (?ㅼ씠踰꽷텲SM쨌?꾩엫???몄뀡, 荑좏뙜 API?? ?꾩엫???ㅼ젙)瑜?// 媛?PC 泥??ㅽ뻾 ??userData 濡?蹂듭궗?쒕떎. ?대? ?덉쑝硫?吏곸썝???щ줈洹몄씤??寃쎌슦 ?? 嫄대뱶由ъ? ?딅뒗??
function seedSharedDefaults() {
    try {
        const ud = app.getPath('userData');
        const defDir = path.join(__dirname, '..', 'data', 'defaults');
        if (!fs.existsSync(defDir)) return;
        for (const f of fs.readdirSync(defDir)) {
            const dest = path.join(ud, f);
            if (!fs.existsSync(dest)) {
                try { fs.copyFileSync(path.join(defDir, f), dest); }
                catch (e) { console.error('怨듭슜 濡쒓렇???쒕뱶 ?ㅽ뙣:', f, e.message); }
            }
        }
    } catch (e) { console.error('怨듭슜 濡쒓렇???쒕뱶 ?ㅽ뙣:', e.message); }
}

// ?고듃 ?깅줉
const fontPath = path.join(__dirname, '..', 'data', 'NEXON_Lv2_Gothic_Bold.ttf');
if (fs.existsSync(fontPath)) {
    GlobalFonts.registerFromPath(fontPath, 'NexonGothic');
}

let mainWindow;   // ?꾩옱 ?쒖꽦 硫붿씤 李?let launcherWindow; // ?곗쿂 李?let seedWindow;     // 踰좊━?⑤뱶 李?let upWindow;       // 踰좊━??李?let browser;

// ?? ?곗쿂 李??앹꽦 ??????????????????????????????????????????????????
function createLauncher() {
    launcherWindow = new BrowserWindow({
        width: 820,
        height: 560,
        resizable: false,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
        },
        title: 'VERY UP VER2',
        backgroundColor: '#080f1e',
    });
    launcherWindow.loadFile(path.join(__dirname, 'ui/launcher.html'));
    launcherWindow.on('closed', () => { launcherWindow = null; });
}

// ?? 踰좊━?⑤뱶 李??앹꽦 ??????????????????????????????????????????????
function createSeedWindow() {
    if (seedWindow) { seedWindow.focus(); return; }
    seedWindow = new BrowserWindow({
        width: 1280,
        height: 900,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
        },
        title: 'VERY UP VER2 - 踰좊━?⑤뱶',
        backgroundColor: '#0f172a',
    });
    seedWindow.loadFile(path.join(__dirname, 'ui/index_seed.html'));
    seedWindow.on('closed', () => {
        seedWindow = null;
        mainWindow = upWindow || null;
        if (!upWindow) {
            if (launcherWindow) launcherWindow.show();
            else createLauncher();
        }
    });
    mainWindow = seedWindow;
}

// ?? 踰좊━??李??앹꽦 ????????????????????????????????????????????????
function createUpWindow() {
    if (upWindow) { upWindow.focus(); return; }
    upWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
        },
        title: 'VERY UP VER2 - 踰좊━??,
        backgroundColor: '#0f172a',
    });
    upWindow.loadFile(path.join(__dirname, 'ui/index_up.html'));
    upWindow.on('closed', () => {
        upWindow = null;
        mainWindow = seedWindow || null;
        if (!seedWindow) {
            if (launcherWindow) launcherWindow.show();
            else createLauncher();
        }
    });
    mainWindow = upWindow;
}

// ?? IPC: ?곗쿂?먯꽌 ???좏깮 ?????????????????????????????????????????
ipcMain.on('launch-app', (event, appType) => {
    if (launcherWindow) launcherWindow.hide();
    if (appType === 'seed') createSeedWindow();
    else if (appType === 'up') createUpWindow();
});

// ?? IPC: ??李쎌뿉???곗쿂濡??뚯븘媛湲????????????????????????????????
ipcMain.on('close-app', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) win.close();
    if (launcherWindow) {
        launcherWindow.show();
    } else {
        createLauncher();
    }
});

// (湲곗〈 ?명솚) createWindow ???곗쿂 湲곕컲 吏꾩엯??function createWindow() {
    createLauncher();
}

// ?? Coupang instance (API-based, no browser needed) ??
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
                    brand: '?듯떛湲?섏뒪', displayCategoryCode: null,
                    returnCharge: 5000,
                    afterServiceInformation: '?듯떛湲?섏뒪 A/S ?쇳꽣',
                    afterServiceContactNumber: ''
                }, null, 2), 'utf-8');
            }
        }
        coupangInstance = new Coupang(configPath);
    }
    return coupangInstance;
}

// ?? Imweb instance (singleton) ??
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
        
        // ImwebEdit ??Imweb ???곸냽?섎?濡?湲곗〈 湲곕뒫(蹂듭궗?깅줉/寃뚯떆??? 洹몃?濡??곕㈃??
        // ?대? 愿由ъ옄 API(媛寃??곸냽)? registerB2bViaApi ???④퍡 媛뽯뒗??
        imwebInstance = new ImwebEdit(configPath, getBrowserSync);
    }
    return imwebInstance;
}

// ?? ESM instance (singleton) ??
let esmInstance = null;
function getESM() {
    if (!esmInstance) {
        const b = getBrowserSync();
        const sessionPath = path.join(app.getPath('userData'), 'session_esmplus.json');
        esmInstance = new ESMPlusHosting(b, sessionPath);
    }
    return esmInstance;
}

// ?? Naver instance (singleton) ??
let naverInstance = null;
function getNaver() {
    if (!naverInstance) {
        const b = getBrowserSync();
        const sessionPath = path.join(app.getPath('userData'), 'session_naver.json');
        naverInstance = new NaverSmartStore(b, sessionPath);
    }
    return naverInstance;
}

// ?? Naver "湲곗〈 ?곹뭹 ?섏젙" instance (蹂꾨룄 ?몄뒪?댁뒪: 蹂듭궗?깅줉怨?遺꾨━) ??
let naverEditInstance = null;
function getNaverEdit() {
    if (!naverEditInstance) {
        const b = getBrowserSync();
        const sessionPath = path.join(app.getPath('userData'), 'session_naver.json');
        naverEditInstance = new NaverSmartStoreEdit(b, sessionPath);
    }
    naverEditInstance.browser = getBrowserSync();
    return naverEditInstance;
}

// Synchronous browser getter (returns existing or null)
function getBrowserSync() {
    return browser;
}

// (援?createWindow ?쒓굅?????곗쿂 湲곕컲 createWindow 濡??泥?

// ?? ?먮룞 ?낅뜲?댄듃 ????????????????????????????????????????????????
// ?대씪?곕뱶 ?ㅽ넗由ъ?(?뺤쟻 HTTP)???щ┛ latest.yml / ?ㅼ튂?뚯씪 / .blockmap ??蹂닿퀬
// ??踰꾩쟾???덉쑝硫?諛깃렇?쇱슫?쒕줈 諛쏆? ?? ??諛쏆쑝硫??ъ슜?먯뿉寃?"吏湲??ㅼ튂" 瑜?臾쇱뼱蹂몃떎.
// (媛쒕컻 以묒뿉???숈옉 ???????ㅼ튂蹂몄뿉?쒕쭔 ?숈옉)
function setupAutoUpdate() {
    if (!app.isPackaged) return;
    try {
        const { autoUpdater } = electronUpdater;
        autoUpdater.autoDownload = true;
        autoUpdater.autoInstallOnAppQuit = true;
        const notify = (msg) => { try { if (mainWindow) mainWindow.webContents.send('log', `[?낅뜲?댄듃] ${msg}`); } catch {} };

        autoUpdater.on('checking-for-update', () => notify('??踰꾩쟾 ?뺤씤 以?..'));
        autoUpdater.on('update-available', (info) => notify(`??踰꾩쟾 ${info?.version} 諛쒓껄 ??諛깃렇?쇱슫???ㅼ슫濡쒕뱶 ?쒖옉`));
        autoUpdater.on('update-not-available', () => notify('理쒖떊 踰꾩쟾?낅땲??'));
        autoUpdater.on('download-progress', (p) => notify(`?ㅼ슫濡쒕뱶 ${Math.round(p.percent)}%`));
        autoUpdater.on('error', (err) => notify(`?낅뜲?댄듃 ?ㅻ쪟: ${err?.message || err}`));
        autoUpdater.on('update-downloaded', async (info) => {
            notify(`??踰꾩쟾 ${info?.version} ?ㅼ슫濡쒕뱶 ?꾨즺`);
            const { response } = await dialog.showMessageBox({
                type: 'info',
                buttons: ['吏湲??ъ떆?묓븯???ㅼ튂', '?섏쨷??],
                defaultId: 0,
                cancelId: 1,
                title: '?낅뜲?댄듃 以鍮??꾨즺',
                message: `??踰꾩쟾 ${info?.version} ??以鍮꾨릺?덉뒿?덈떎.`,
                detail: '吏湲??ъ떆?묓븯硫??낅뜲?댄듃媛 ?곸슜?⑸땲?? "?섏쨷?? 瑜??꾨Ⅴ硫??ㅼ쓬 醫낅즺 ???먮룞 ?ㅼ튂?⑸땲??',
            });
            if (response === 0) { stopAiServers(); autoUpdater.quitAndInstall(); }
        });

        autoUpdater.checkForUpdates().catch((e) => notify(`?낅뜲?댄듃 ?뺤씤 ?ㅽ뙣: ${e?.message || e}`));
    } catch (e) {
        console.error('?먮룞 ?낅뜲?댄듃 ?ㅼ젙 ?ㅽ뙣:', e?.message || e);
    }
}

app.whenReady().then(() => {
  seedSharedDefaults();
  startAiServers();
  createWindow();
  setupAutoUpdate();
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
ipcMain.handle('load-auto-image', async (event, customName = 'OPTICGLASS_?앹꽦?대?吏') => {
    const autoImagePath = path.join(AI_OUTPUT_DIR, 'latest_generated.jpg');
    if (fs.existsSync(autoImagePath)) {
        const outputDir = path.dirname(autoImagePath);
        const safeName = customName.replace(/[<>:"/\\|?*]/g, '_');
        const customImagePath = path.join(outputDir, `${safeName}.jpg`);
        
        fs.copyFileSync(autoImagePath, customImagePath);
        
        return { success: true, filePath: customImagePath, fileName: `${safeName}.jpg` };
    }
    return { success: false, error: '理쒓렐???먮룞 ?앹꽦???대?吏瑜?李얠쓣 ???놁뒿?덈떎.' };
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

ipcMain.handle('esm-list-folders', async (event, { category }) => {
    try {
        await getBrowser();
        const esm = getESM();
        esm.browser = browser;
        
        const loginSuccess = await esm.login();
        if (!loginSuccess) {
            return { success: false, error: 'ESM 濡쒓렇?몄씠 ?꾩슂?⑸땲??' };
        }
        
        const basePath = category === '?먮룞李? 
            ? ['?듯떛湲?섏뒪 ?곸꽭?섏씠吏', '議곌껄??] 
            : ['?듯떛湲?섏뒪 ?곸꽭?섏씠吏', '議곌껄??諛붿씠??];

        const folders = await esm.listSubfolders(basePath);
        return { success: true, folders, basePath };
    } catch (error) {
        console.error(error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('esm-upload', async (event, { filePath, category, targetFolder }) => {
    try {
        await getBrowser();
        const esm = getESM();
        esm.browser = browser;
        
        // Ensure logged in before upload
        const loginSuccess = await esm.login();
        if (!loginSuccess) {
            return { success: false, error: 'ESM 濡쒓렇?몄씠 ?꾩슂?⑸땲?? 癒쇱? 濡쒓렇??李쎌쓣 ?댁뼱 濡쒓렇?명빐二쇱꽭??' };
        }
        
        const basePath = category === '?먮룞李? 
            ? ['?듯떛湲?섏뒪 ?곸꽭?섏씠吏', '議곌껄??] 
            : ['?듯떛湲?섏뒪 ?곸꽭?섏씠吏', '議곌껄??諛붿씠??];

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
            return { success: false, error: '?ㅻ쭏?몄뒪?좎뼱 濡쒓렇?몄씠 ?꾩슂?⑸땲?? 癒쇱? 濡쒓렇??李쎌쓣 ?댁뼱 濡쒓렇?명빐二쇱꽭??' };
        }
        
        // Let the platform script handle the copy registration
        const resultUrl = await naver.copyAndRegisterProduct(data);
        
        return { success: true, url: resultUrl };
    } catch (error) {
        console.error(error);
        return { success: false, error: error.message };
    }
});

// ????????????????????????????????????????????
// Coupang Handlers (Open API 諛⑹떇)
// ????????????????????????????????????????????

// 荑좏뙜 ?ㅼ젙 濡쒕뱶
ipcMain.handle('coupang-load-config', async () => {
    try {
        const coupang = getCoupang();
        const config = coupang.loadConfig();
        // 蹂댁븞: secretKey??留덉뒪?뱁븯???꾨떖
        return { 
            success: true, 
            config
        };
    } catch (error) {
        // Config not yet set up ??return empty config
        return { 
            success: true, 
            config: {
                vendorId: '', accessKey: '', secretKey: '',
                outboundShippingPlaceCode: '', returnCenterCode: '',
                deliveryChargeType: 'FREE', deliveryCharge: 0,
                deliveryCompanyCode: 'CJGLS', deliveryMethod: 'SEQUENCIAL',
                brand: '?듯떛湲?섏뒪', displayCategoryCode: null,
                returnCharge: 5000,
                afterServiceInformation: '?듯떛湲?섏뒪 A/S ?쇳꽣',
                afterServiceContactNumber: ''
            }
        };
    }
});

// 荑좏뙜 ?ㅼ젙 ???ipcMain.handle('coupang-save-config', async (event, newConfig) => {
    try {
        const coupang = getCoupang();
        coupang.saveConfig(newConfig);
        return { success: true };
    } catch (error) {
        console.error(error);
        return { success: false, error: error.message };
    }
});

// 荑좏뙜 API ?곌껐 ?뚯뒪??ipcMain.handle('coupang-test-connection', async () => {
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

// 荑좏뙜 異쒓퀬吏 議고쉶
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

// 荑좏뙜 諛섑뭹吏 議고쉶
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

// 荑좏뙜 移댄뀒怨좊━ 議고쉶
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

// 荑좏뙜 ?곹뭹 ?깅줉 (蹂듭궗?깅줉 諛⑹떇)
ipcMain.handle('coupang-register', async (event, data) => {
    try {
        const coupang = getCoupang();
        coupang.loadConfig();
        const result = await coupang.copyRegisterProduct(data);
        return { 
            success: true, 
            productId: result?.data,
            message: `?곹뭹???깃났?곸쑝濡??깅줉?섏뿀?듬땲?? (ID: ${result?.data})`
        };
    } catch (error) {
        console.error(error);
        return { success: false, error: error.message };
    }
});

// ?? ?ㅻ쭏?몄뒪?좎뼱 湲곗〈 ?곹뭹 ?섏젙 (蹂듭궗?깅줉怨?遺꾨━??寃쎈줈) ??
// ?쒖“??룹감醫낆쑝濡??ㅻ쭏?몄뒪?좎뼱 ?깅줉 ?곹뭹踰덊샇 李얘린
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
        return { success: true, message: `?곹뭹???섏젙?섏뿀?듬땲?? (${result.verified})` };
    } catch (error) {
        console.error(error);
        return { success: false, error: error.message };
    }
});

// 荑좏뙜 湲곗〈 ?곹뭹 遺덈윭?ㅺ린 (?섏젙 ?붾㈃??
// ?쒖“??룹감醫낆쑝濡??깅줉?곹뭹ID 李얘린 ??荑좏뙜 API ?곗꽑(??긽 理쒖떊), ?ㅽ뙣 ??援ш? ?쒗듃 ?대갚
ipcMain.handle('coupang-find-id', async (event, { brand, model }) => {
    try {
        const coupang = getCoupang();
        coupang.loadConfig();
        const rows = await coupang.searchProductsByName(brand, model);
        return { success: true, rows, source: 'api' };
    } catch (apiError) {
        console.error('API 寃???ㅽ뙣, ?쒗듃濡??대갚:', apiError.message);
        try {
            const rows = await findProductIdsFromSheet(brand, model);
            return { success: true, rows, source: 'sheet', apiError: apiError.message };
        } catch (sheetError) {
            console.error(sheetError);
            return { success: false, error: `API 寃???ㅽ뙣(${apiError.message}) / ?쒗듃 寃?됰룄 ?ㅽ뙣(${sheetError.message})` };
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

// 荑좏뙜 湲곗〈 ?곹뭹 ?섏젙
ipcMain.handle('coupang-update', async (event, data) => {
    try {
        const coupang = getCoupang();
        coupang.loadConfig();
        const result = await coupang.updateExistingProduct(data);
        return { 
            success: true, 
            productId: data.productId,
            message: `?곹뭹???깃났?곸쑝濡??섏젙?섏뿀?듬땲?? (ID: ${data.productId})`
        };
    } catch (error) {
        console.error(error);
        return { success: false, error: error.message };
    }
});


// ????????????????????????????????????????????
// Imweb Handlers
// ????????????????????????????????????????????
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

        // Route logs to the tab that started this run: B2B ??imweb-log,
        // 蹂몄궗쨌?댁쇅紐?寃뚯떆????imweb-board-log.
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

// ?? ?꾩엫??B2B 湲곗〈 ?곹뭹 ?섏젙 (?대? API 湲곕컲, 蹂듭궗?깅줉怨?遺꾨━) ??
let imwebEditInstance = null;
function getImwebEdit() {
    if (!imwebEditInstance) {
        const configPath = path.join(app.getPath('userData'), 'imweb_config.json');
        imwebEditInstance = new ImwebEdit(configPath, getBrowserSync);
    }
    imwebEditInstance.browser = browser;
    imwebEditInstance.logCallback = (msg) => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('imweb-log', msg);
    };
    return imwebEditInstance;
}

// ?곹뭹 踰덊샇(idx)濡??쒖“??李⑥쥌/肄붾뱶 異붿텧
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

// ?쒖“??李⑥쥌/肄붾뱶濡?寃?????명듃+媛쒕퀎????臾띠쓬?쇰줈 諛섑솚
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

// 吏??명듃+媛쒕퀎)????踰덉뿉 遺덈윭?ㅺ린
ipcMain.handle('imweb-load-group', async (event, { prodNos }) => {
    try {
        await getBrowser();
        const group = await getImwebEdit().loadGroup(prodNos);
        group.products.forEach(p => { delete p._raw; });   // ?먮낯 ?꾩껜???뚮뜑?щ줈 ?섍린吏 ?딅뒗??        return { success: true, group };
    } catch (error) {
        console.error(error);
        return { success: false, error: error.message };
    }
});

// 吏앹쓣 ??踰덉뿉 ?섏젙
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

// 蹂몄궗쨌?댁쇅紐?寃뚯떆湲 ?섏젙 (?대? API 湲곕컲)
function getImwebBoardEdit() {
    const e = getImwebEdit();
    e.logCallback = (msg) => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('imweb-board-log', msg);
    };
    return e;
}

// 肄붾뱶濡?寃뚯떆湲 寃??(?щ윭 媛쒕㈃ ?꾨? 諛섑솚 ???ъ슜?먭? ?좏깮)
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

// 寃뚯떆湲 肄붾뱶濡?遺덈윭?ㅺ린
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

// AI ?대?吏 ?앹꽦 ?몃뱾??(Node Canvas 湲곕컲 濡쒖뺄 蹂??
ipcMain.handle('generate-ai-image', async (event, data) => {
    try {
        const { brand, carClass, no, gen, year, code, includeLogo, mirrorSide, skipAI, bsaType, mirrorPath, manualBsa, country } = data;
        console.log('====================================');
        console.log('generate-ai-image triggered with bsaType:', bsaType, 'manualBsa:', manualBsa, 'country:', country);

        // ?? 援?????곕씪 ?쒗뵆由?遺꾧린 ??????????????????????????????????
        // KOREA ??湲곗〈 960횞600 ?ㅽ겕 ?쒗뵆由?        // USA / JAPAN / ARAB ???좉퇋 3000횞1800 ?명꽣?댁뀛???쒗뵆由?        const isIntl = country && country !== 'KOREA';
        if (isIntl) {
            return await generateIntlImage({ brand, carClass, no, gen, year, code, includeLogo, mirrorSide, skipAI, bsaType, mirrorPath, manualBsa, country });
        }

        if (!mirrorPath || !fs.existsSync(mirrorPath)) {
            throw new Error('嫄곗슱 ?ъ쭊 ?뚯씪??李얠쓣 ???놁뒿?덈떎.');
        }

        const savedLogoPath = path.join(__dirname, '..', 'data', 'saved_logo.png');
        if (!fs.existsSync(savedLogoPath)) {
            throw new Error('data/saved_logo.png ?뚯씪???놁뒿?덈떎. 濡쒓퀬 ?뚯씪??癒쇱? 以鍮꾪빐二쇱꽭??');
        }

        // 理쒖쥌 罹붾쾭???ㅼ젙 (960 x 600)
        const width = 960;
        const height = 600;
        const canvas = createCanvas(width, height);
        const ctx = canvas.getContext('2d');

        // ?섏???諛곌꼍
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);

        // ?곷떒 寃????곸뿭
        ctx.fillStyle = '#191919';
        ctx.fillRect(0, 0, width, 150);

        // ?띿뒪???ㅼ젙
        const fontPath = path.join(__dirname, '..', 'data', 'NEXON_Lv2_Gothic_Bold.ttf');
        const fontName = fs.existsSync(fontPath) ? 'NexonGothic' : '"Malgun Gothic", "留묒? 怨좊뵓", sans-serif';
        
        ctx.fillStyle = '#ffffff';
        ctx.font = `bold 45px ${fontName === 'NexonGothic' ? '"NexonGothic", "Malgun Gothic"' : fontName}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        
        // 鍮???ぉ? 臾댁떆?섍퀬 ?먯뿰?ㅻ읇寃?議고빀?섎룄濡??섏젙 (鍮?媛믪뿉 ?곕Ⅸ 遺덊븘?뷀븳 ?щ옒?????쒓굅)
        let line1Parts = [];
        if (brand) line1Parts.push(brand);
        if (carClass) line1Parts.push(carClass);
        let line1Str = line1Parts.join(' ');
        if (no) line1Str += ` [No.${no}]`;
        line1Str = line1Str.trim();
        
        ctx.textAlign = 'center';
        if (bsaType === 'bsaOption') {
            const diamond = '??';
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
            line2Parts.push('BSA 媛??);
            ctx.fillText(line2Parts.join(' / '), width / 2, 100);
        } else if (bsaType === 'bsaOption') {
            const baseLine2 = line2Parts.join(' / ') + (line2Parts.length > 0 ? ' / ' : '');
            const lastPart = 'BSA ?좏깮?듭뀡';
            
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

        // ?щ챸 ?щ갚???먮룞?쇰줈 ?섎씪?대뒗 ?⑥닔
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

        // 嫄곗슱 ?대?吏 泥섎━ ?⑥닔
        async function getProcessedMirror(imagePath, maxWidth, maxHeight) {
            let img;
            try {
                const fileData = fs.readFileSync(imagePath);
                const blob = new Blob([fileData], { type: 'image/jpeg' });
                const formData = new FormData();
                formData.append('file', blob, 'mirror.jpg');
                
                // skipAI媛 李몄씠硫??뚭퀬由ъ쬁 諛⑹떇(predict_clean), 嫄곗쭞?대㈃ ?λ윭??諛⑹떇(predict) ?몄텧
                const endpoint = skipAI ? 'http://localhost:8000/predict_clean' : 'http://localhost:8000/predict';
                
                const response = await fetch(endpoint, {
                    method: 'POST',
                    body: formData
                });
                
                if (!response.ok) {
                    throw new Error(`AI ?쒕쾭 ?ㅻ쪟: ${response.statusText}`);
                }
                
                const arrayBuffer = await response.arrayBuffer();
                img = await loadImage(Buffer.from(arrayBuffer));
            } catch (error) {
                console.error('?뚯씠??AI ?쒕쾭 ?듭떊 ?ㅽ뙣:', error);
                throw new Error('?뚯씠??AI ?쒕쾭(FastAPI)? ?듭떊?????놁뒿?덈떎. ?뚯씠???쒕쾭媛 耳쒖졇 ?덈뒗吏 ?뺤씤?섏꽭??');
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

        // BSA 濡쒓퀬 ?ㅻ쾭?덉씠 異붽? (manualBsa媛 ?꾨땺 ?뚮쭔 ?먮룞 ?꾩튂 怨꾩궛 ??洹몃┝. Excel ?쇨큵 泥섎━ ??
        if (bsaType === 'bsa' && !manualBsa) {
            const bsaLogoPath = path.join(__dirname, '..', 'data', 'bsa_logo.png');
            if (fs.existsSync(bsaLogoPath)) {
                const bsaBuffer = fs.readFileSync(bsaLogoPath);
                const bsaImg = await loadImage(bsaBuffer);
                
                // ?쇱そ???꾩튂??誘몃윭(mirrorImages[0]) 湲곗??쇰줈 ?꾩튂 怨꾩궛
                const leftMirror = mirrorImages[0];
                
                // 鍮꾩쑉 怨꾩궛 (濡쒓퀬??媛濡??ш린瑜?70px濡?怨좎젙)
                const targetBsaW = 70;
                const bsaScale = targetBsaW / bsaImg.width;
                const targetBsaH = bsaImg.height * bsaScale;
                
                // 湲곕낯 ?꾩튂 怨꾩궛 (?쇱そ 媛?μ옄由?洹쇱쿂)
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
            ctx.fillText("議곗닔??, labelLeftCenterX, labelY + labelH / 2);
            ctx.fillText("?댁쟾??, labelRightCenterX, labelY + labelH / 2);
        } else {
            ctx.fillText("?댁쟾??, labelLeftCenterX, labelY + labelH / 2);
            ctx.fillText("議곗닔??, labelRightCenterX, labelY + labelH / 2);
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
        console.error('?대?吏 ?앹꽦 以??ㅻ쪟 諛쒖깮:', error);
        return { success: false, error: error.message };
    }
});

// ?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧
// ?댁쇅 ?쒗뵆由??대?吏 ?앹꽦 (USA / JAPAN / ARAB) ??3000횞1800
// 諛곌꼍: ?곗깋 / 濡쒓퀬: data/intl_logo.png (以묒븰 諛섑닾紐??뚰꽣留덊겕)
// ?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧?먥븧
async function generateIntlImage({ brand, carClass, no, gen, year, code, includeLogo, mirrorSide, skipAI, bsaType, mirrorPath, manualBsa, country }) {
    if (!mirrorPath || !fs.existsSync(mirrorPath)) {
        throw new Error('嫄곗슱 ?ъ쭊 ?뚯씪??李얠쓣 ???놁뒿?덈떎.');
    }

    const logoPath = path.join(__dirname, '..', 'data', 'intl_logo.png');

    // ?? 罹붾쾭??(3000횞1800) ???????????????????????????????????????????
    const W = 3000, H = 1800;
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');

    // 1. ?곗깋 諛곌꼍
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);

    // ?? ?щ챸 ?щ갚 ?먮Ⅴ湲??????????????????????????????????????????????
    function trimCanvas(src) {
        const sc = src.getContext('2d');
        const d  = sc.getImageData(0, 0, src.width, src.height).data;
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

    // ?? 嫄곗슱 ?대?吏 泥섎━ ?????????????????????????????????????????????
    async function getMirror(imgPath, maxW, maxH) {
        const blob = new Blob([fs.readFileSync(imgPath)], { type: 'image/jpeg' });
        const fd   = new FormData();
        fd.append('file', blob, 'mirror.jpg');
        const ep  = skipAI ? 'http://localhost:8000/predict_clean' : 'http://localhost:8000/predict';
        const res = await fetch(ep, { method: 'POST', body: fd });
        if (!res.ok) throw new Error(`AI ?쒕쾭 ?ㅻ쪟: ${res.statusText}`);
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

    // 2. Optic-Glass 濡쒓퀬 ??癒쇱? 洹몃젮??嫄곗슱 ?꾨옒 ?덉씠?댁뿉 ?꾩튂
    //    濡쒓퀬媛 500횞500px ??罹붾쾭?ㅼ뿉???ш쾶 蹂댁씠?꾨줉 ?몃줈 湲곗? 1100px
    if (includeLogo && fs.existsSync(logoPath)) {
        const logoImg = await loadImage(fs.readFileSync(logoPath));
        // ?몃줈 1100px 湲곗?, 媛濡쒕뒗 鍮꾩쑉??留욊쾶 (500횞500?대㈃ 1100횞1100)
        const targetH = 1100;
        const ls = targetH / logoImg.height;
        const lW = logoImg.width  * ls;
        const lH = logoImg.height * ls;
        const lX = (W - lW) / 2;
        const lY = (H - lH) / 2;
        ctx.globalAlpha = 0.28;  // 諛섑닾紐??뚰꽣留덊겕
        ctx.drawImage(logoImg, lX, lY, lW, lH);
        ctx.globalAlpha = 1.0;
    }

    // 3. 嫄곗슱 諛곗튂 (?곹븯 留덉쭊 150px, ?쇰꺼 怨듦컙 200px ?뺣낫)
    const marginTop    = 100;
    const marginBottom = 280;   // ?쇰꺼 + ?섎떒 ?щ갚
    const mirrorH      = H - marginTop - marginBottom;   // 1420px
    const mirrorW      = W - 300;                         // 醫뚯슦 ?щ갚 150px??    const centerX      = W / 2;
    const centerY      = marginTop + mirrorH / 2;

    let mirrorImages = [];
    let labelLeftCX, labelRightCX;

    if (mirrorSide === 'both') {
        const mc = await getMirror(mirrorPath, mirrorW, mirrorH);
        mirrorImages.push({ canvas: mc, x: centerX - mc.width / 2, y: centerY - mc.height / 2 });
        labelLeftCX  = centerX - mc.width  / 4;
        labelRightCX = centerX + mc.width  / 4;
    } else {
        const single  = await getMirror(mirrorPath, (mirrorW - 100) / 2, mirrorH);
        const flipped = flipCanvas(single);
        const gap     = 100;
        const leftX   = centerX - gap / 2 - single.width;
        const rightX  = centerX + gap / 2;
        const y       = centerY - single.height / 2;

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

    // 嫄곗슱 洹몃━湲?(濡쒓퀬 ?꾩뿉 ??엫)
    for (const m of mirrorImages) ctx.drawImage(m.canvas, m.x, m.y);

    // 4. BSA 濡쒓퀬 ?먮룞 諛곗튂
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

    // 5. L/R ?쇰꺼 諛뺤뒪
    const labelY  = H - 220;
    const labelW  = 250, labelH = 100;
    ctx.fillStyle = '#111111';
    ctx.fillRect(labelLeftCX  - labelW / 2, labelY, labelW, labelH);
    ctx.fillRect(labelRightCX - labelW / 2, labelY, labelW, labelH);

    const fontPath = path.join(__dirname, '..', 'data', 'NEXON_Lv2_Gothic_Bold.ttf');
    const fontName = fs.existsSync(fontPath) ? 'NexonGothic' : '"Malgun Gothic"';
    ctx.fillStyle    = '#ffffff';
    ctx.font         = `bold 70px "${fontName}", "Malgun Gothic"`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    const lbl = mirrorSide === 'passenger';
    ctx.fillText(lbl ? 'R' : 'L', labelLeftCX,  labelY + labelH / 2);
    ctx.fillText(lbl ? 'L' : 'R', labelRightCX, labelY + labelH / 2);

    // 6. ???    const finalBuffer = canvas.toBuffer('image/jpeg', { quality: 0.93 });
    const outputDir   = AI_OUTPUT_DIR;
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
    const outputPath  = path.join(outputDir, 'latest_generated.jpg');
    fs.writeFileSync(outputPath, finalBuffer);

    return { success: true, base64: finalBuffer.toString('base64'), outputPath };
}

