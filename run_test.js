import { chromium } from 'playwright-core';
import { Imweb } from './src/platforms/imweb.js';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

// Find chrome executable
let executablePath;
try {
    const paths = [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
    ];
    executablePath = paths.find(p => fs.existsSync(p));
} catch(e){}

(async () => {
    let browser;
    try {
        console.log("Launching browser...");
        browser = await chromium.launch({ headless: true, executablePath });
        
        const configPath = 'C:\\Users\\wish\\AppData\\Roaming\\antigravity-automation\\imweb_config.json';
        
        const imweb = new Imweb(configPath, () => browser);
        imweb.logCallback = console.log;
        
        const data = {
            targetB2b: true,
            targetHead: false,
            targetUs: false,
            brand: '르노삼성',
            model: '르노 테스트',
            titleBrand: '르노삼성',
            titleModel: '르노 테스트',
            year: '12-12',
            code: '1212',
            nationality: '국산차',
            hasBsa: false,
            forceBoth: false,
            registerIndiv: true,
            registerSet: false,
            mainImageUrl: '',
            specImageUrl: ''
        };
        
        console.log("Starting automation...");
        const result = await imweb.executeAutomation(data);
        console.log("===== 최종 결과 =====");
        console.log(result);
        
        fs.writeFileSync('C:\\Users\\wish\\.gemini\\antigravity\\brain\\b14c6e76-a833-409b-9f2a-1c6113c8be58\\test_result.json', JSON.stringify(result, null, 2));
    } catch (e) {
        console.error("Error:", e);
    } finally {
        if (browser) await browser.close();
    }
})();
