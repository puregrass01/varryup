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
