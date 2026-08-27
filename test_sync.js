import { chromium } from 'playwright-core';
import { Imweb } from './src/platforms/imweb.js';
import fs from 'fs';

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
        
        const configPath = 'C:\\Users\\wish\\AppData\\Roaming\\antigravity-commerce\\imweb_config.json';
        const imweb = new Imweb(configPath, () => browser);
        imweb.logCallback = console.log;
        
        console.log("Running syncCategories...");
        const result = await imweb.syncCategories();
        console.log("Sync Result:", JSON.stringify(result, null, 2));
        
    } catch(e) {
        console.error("Test Error:", e);
    } finally {
        if (browser) await browser.close();
    }
})();
