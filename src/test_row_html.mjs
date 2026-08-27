import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import os from 'os';

async function test() {
    try {
        console.log('Resolving session path...');
        const appData = path.join(os.homedir(), 'AppData', 'Roaming', 'antigravity-commerce');
        const searchDirs = [
            path.join(os.homedir(), 'AppData', 'Roaming', 'antigravity-commerce'),
            path.join(os.homedir(), 'AppData', 'Roaming', 'Antigravity Automation'),
            path.join(os.gemini ? '' : os.homedir(), '.gemini', 'antigravity')
        ];
        
        let sessionPath = null;
        for (const dir of searchDirs) {
            const p = path.join(dir, 'session_imweb_portal.json');
            if (fs.existsSync(p)) {
                sessionPath = p;
                break;
            }
        }
        if (!sessionPath) {
            const p = 'C:\\Users\\wish\\.gemini\\antigravity\\session_imweb_portal.json';
            if (fs.existsSync(p)) sessionPath = p;
        }

        const browser = await chromium.launch({ headless: false, channel: 'msedge' });
        const context = await browser.newContext({ storageState: sessionPath });
        const page = await context.newPage();
        
        console.log('Navigating to product search page...');
        await page.goto('https://bbstore37.imweb.me/admin/shopping/product?search=1291&searchType=no');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(5000);
        
        const row = page.locator('div.product-row').filter({ has: page.locator('a[href*="/product/detail?idx=1291"]') }).first();
        const html = await row.evaluate(el => el.outerHTML);
        console.log('product-row HTML:', html);
        
        await browser.close();
    } catch (e) {
        console.error('Error in test:', e);
    }
}

test();
