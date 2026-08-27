import { chromium } from 'playwright-core';
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
        
        const sessionPath = 'C:\\Users\\wish\\AppData\\Roaming\\antigravity-automation\\session_imweb_portal.json';
        const context = await browser.newContext({ storageState: sessionPath });
        const page = await context.newPage();
        
        console.log("Navigating to site list...");
        await page.goto('https://imweb.me/mysite');
        await page.waitForTimeout(5000);
        
        const linkLocator = page.locator('a:has-text("사이트 관리"), button:has-text("사이트 관리"), a:has-text("관리"), button:has-text("관리")');
        const count = await linkLocator.count();
        for (let i = 0; i < count; i++) {
            const txt = await linkLocator.nth(i).evaluate(el => el.closest('article, li, .card, .site-item, .row')?.innerText || el.innerText);
            if (txt.includes('B2B') || txt.includes('블랙스토어')) {
                console.log("Entering site admin...");
                const [popup] = await Promise.all([
                    context.waitForEvent('page'),
                    linkLocator.nth(i).click()
                ]);
                await popup.waitForLoadState('domcontentloaded');
                
                console.log("Navigating to category management page...");
                await popup.goto('https://bbstore37.imweb.me/admin/shopping/category');
                await popup.waitForTimeout(5000);
                
                // Let's dump the DOM to see what the category structure is
                const domPath = 'C:\\Users\\wish\\.gemini\\antigravity\\scratch\\category_management_dom.html';
                fs.writeFileSync(domPath, await popup.content(), 'utf-8');
                console.log("Saved DOM to category_management_dom.html");
                
                // Check if Nestable class exists
                const hasNestable = await popup.locator('.dd, .dd-list').count() > 0;
                console.log("Has Nestable class:", hasNestable);
                
                break;
            }
        }
    } catch(e) {
        console.error(e);
    } finally {
        if (browser) await browser.close();
    }
})();
