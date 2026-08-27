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
        
        console.log('Locating product-row and actions cell...');
        const row = page.locator('div.product-row').filter({ has: page.locator('a[href*="/product/detail?idx=1291"]') }).first();
        const kebab = row.locator('[data-column-id="actions"]').first();
        
        console.log('Scrolling kebab into view and clicking...');
        await kebab.scrollIntoViewIfNeeded();
        await kebab.click();
        await page.waitForTimeout(2000);
        
        console.log('Checking if "복제" is visible...');
        const cloneMenu = page.getByText('복제', { exact: true }).first();
        const isVisible = await cloneMenu.isVisible();
        console.log('Is "복제" visible?', isVisible);
        
        await browser.close();
    } catch (e) {
        console.error('Error in test:', e);
    }
}

test();
