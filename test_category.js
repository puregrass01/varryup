import { chromium } from 'playwright-core';
import { Imweb } from './src/platforms/imweb.js';
import fs from 'fs';
import path from 'path';

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
        browser = await chromium.launch({ headless: false, executablePath });
        
        const configPath = 'C:\\Users\\wish\\AppData\\Roaming\\antigravity-automation\\imweb_config.json';
        
        const imweb = new Imweb(configPath, () => browser);
        imweb.logCallback = console.log;
        
        const data = {
            targetB2b: true,
            targetHead: false,
            targetUs: false,
            brand: '테슬라',
            model: '모델 s',
            titleBrand: '테슬라',
            titleModel: '모델 s',
            year: '19~',
            code: '6868',
            price: '100000',
            nationality: '수입차',
            hasBsa: false,
            forceBoth: false,
            registerIndiv: true,
            registerSet: false,
            mainImageUrl: '',
            specImageUrl: ''
        };
        
        console.log("Starting automation...");
        // This will attempt to create a new product and test the category/price logic
        await imweb.executeAutomation(data);
        
        // Wait so we can see the result
        console.log("WAITING 60 SECONDS TO SEE RESULT...");
        await imweb.page.waitForTimeout(60000);
        
    } catch (e) {
        console.error("Test Error:", e);
    } finally {
        if (browser) await browser.close();
    }
})();
