import { chromium } from 'playwright-core';
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
        
        // Load existing session for Imweb to bypass login
        const sessionPath = 'C:\\Users\\wish\\AppData\\Roaming\\antigravity-automation\\session_imweb_portal.json';
        const context = await browser.newContext({ storageState: sessionPath });
        const page = await context.newPage();
        
        // Listen to all network responses
        page.on('response', async (response) => {
            const url = response.url();
            if (url.includes('api') || url.includes('category') || url.includes('shopping')) {
                try {
                    const text = await response.text();
                    if (text.includes('렉스턴') || text.includes('국산차') || text.includes('categories')) {
                        console.log("\n[API MATCH] URL:", url);
                        console.log("Content Preview:", text.substring(0, 1000));
                        fs.writeFileSync('C:\\Users\\wish\\.gemini\\antigravity\\scratch\\api_category_response.json', text);
                        console.log("Saved full response to api_category_response.json");
                    }
                } catch(e){}
            }
        });
        
        console.log("Navigating to BlackStore B2B Admin Page...");
        // Navigate to the mysite list first
        await page.goto('https://imweb.me/mysite');
        await page.waitForTimeout(5000);
        
        // Find the B2B admin site management button and click it to trigger admin login
        const linkLocator = page.locator('a:has-text("사이트 관리"), button:has-text("사이트 관리"), a:has-text("관리"), button:has-text("관리")');
        const count = await linkLocator.count();
        console.log(`Found ${count} admin buttons`);
        for (let i = 0; i < count; i++) {
            const txt = await linkLocator.nth(i).evaluate(el => el.closest('article, li, .card, .site-item, .row')?.innerText || el.innerText);
            if (txt.includes('B2B') || txt.includes('블랙스토어')) {
                console.log("Clicking admin button for:", txt.trim());
                const [popup] = await Promise.all([
                    context.waitForEvent('page'),
                    linkLocator.nth(i).click()
                ]);
                await popup.waitForLoadState('domcontentloaded');
                console.log("Navigating popup to product detail page...");
                await popup.goto('https://bbstore37.imweb.me/admin/shopping/product/detail?product-type=normal');
                await popup.waitForTimeout(10000);
                break;
            }
        }
        
    } catch(e) {
        console.error("Error:", e);
    } finally {
        if (browser) await browser.close();
    }
})();
