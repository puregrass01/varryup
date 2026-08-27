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
        
        console.log("Navigating to category settings manually in test...");
        await imweb.loginPortal();
        await imweb.navigateToSiteAdmin('블랙스토어B2B');
        
        const currentUrl = imweb.page.url();
        const baseUrl = new URL(currentUrl).origin;
        const categoryUrl = `${baseUrl}/admin/shopping/category`;
        
        console.log("Going to category page...");
        await imweb.page.goto(categoryUrl);
        await imweb.page.waitForLoadState('domcontentloaded');
        await new Promise(r => setTimeout(r, 5000));
        
        const content = await imweb.page.content();
        fs.writeFileSync('C:\\Users\\wish\\.gemini\\antigravity\\scratch\\category_settings_page.html', content, 'utf-8');
        console.log("Saved DOM to category_settings_page.html");
        
    } catch(e) {
        console.error("Test Error:", e);
    } finally {
        if (browser) await browser.close();
    }
})();
