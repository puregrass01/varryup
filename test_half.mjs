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
        return { success: true
