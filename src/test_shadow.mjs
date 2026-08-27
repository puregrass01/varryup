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
            path.join(os.homedir(), '.gemini', 'antigravity'),
            path.join(os.homedir(), '.gemini', 'antigravity', 'scratch')
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

        console.log('Session path:', sessionPath);
        if (!sessionPath) {
            throw new Error('session_imweb_portal.json not found!');
        }

        const browser = await chromium.launch({ headless: false, channel: 'msedge' });
        const context = await browser.newContext({ storageState: sessionPath });
        const page = await context.newPage();
        
        console.log('Navigating to product search page...');
        await page.goto('https://bbstore37.imweb.me/admin/shopping/product?search=1291&searchType=no');
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(5000);
        
        console.log('Inspecting DOM in page context...');
        const domDump = await page.evaluate(() => {
            const all = [];
            const w = (root) => {
                let n;
                try { n = root.querySelectorAll('*'); } catch (e) { return; }
                for (const el of n) {
                    all.push(el);
                    if (el.shadowRoot) w(el.shadowRoot);
                }
            };
            w(document);
            
            const anchor = all.find(el => el.tagName === 'A' && (el.getAttribute('href') || '').includes('/product/detail?idx='));
            if (!anchor) return { error: 'Anchor detail link not found!' };
            
            // Log ancestors of anchor
            const ancestors = [];
            let p = anchor;
            while (p) {
                const buttons = p.querySelectorAll ? Array.from(p.querySelectorAll('button')) : [];
                ancestors.push({
                    tagName: p.tagName,
                    className: p.className,
                    id: p.id,
                    role: p.getAttribute ? p.getAttribute('role') : null,
                    buttonCount: buttons.length,
                    buttons: buttons.map(b => ({
                        tagName: b.tagName,
                        className: b.className,
                        text: b.innerText,
                        html: b.outerHTML
                    }))
                });
                p = p.parentElement || (p.getRootNode && p.getRootNode().host);
            }
            
            return {
                ancestors,
                anchorOuterHTML: anchor.outerHTML
            };
        });
        
        console.log('DOM Dump result:', JSON.stringify(domDump, null, 2));
        await browser.close();
    } catch (e) {
        console.error('Error in test:', e);
    }
}

test();
