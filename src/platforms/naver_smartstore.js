import { BasePlatform } from './base_platform.js';
import fs from 'fs';
import os from 'os';
import path from 'path';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export class NaverSmartStore extends BasePlatform {
  constructor(browser, sessionPath) {
    super(browser, sessionPath);
    this.baseUrl = 'https://sell.smartstore.naver.com';
  }

  async login() {
    await this.init(true);
    await this.page.goto(this.baseUrl);
    await this.page.waitForLoadState('networkidle');

    // Wait a bit for potential redirects
    await sleep(3000);

    // Check if we were redirected to any login page
    const currentUrl = this.page.url();
    const isOnLoginPage = currentUrl.includes('nid.naver.com') || 
                          currentUrl.includes('accounts.commerce.naver.com') || 
                          currentUrl.includes('/#/login');

    // Robust check using Playwright Locators
    let isLoggedIn = false;
    if (!isOnLoginPage) {
        try {
            const logoutBtnCount = await this.page.locator('button:has-text("로그아웃"), a:has-text("로그아웃")').count();
            const sellerMenuCount = await this.page.locator('ul.seller-menu, .nav_snb').count();
            
            if (logoutBtnCount > 0 || sellerMenuCount > 0 || currentUrl.includes('/home/dashboard')) {
                isLoggedIn = true;
            }
        } catch (e) {
            console.log('Login check error:', e);
        }
    }

    if (isLoggedIn) {
      console.log('Already logged in to Naver Smart Store');
      return true;
    }

    console.log('Login required. Please complete the login in the opened browser...');
    try {
        // Wait for SmartStore dashboard (after login redirect completes)
        await this.page.waitForURL(/sell\.smartstore\.naver\.com/, { timeout: 120000 });
        // Additional wait for SPA to load
        await sleep(3000);
        // Verify we're actually on dashboard, not still redirecting
        if (this.page.url().includes('accounts.commerce') || this.page.url().includes('nid.naver.com')) {
            await this.page.waitForURL(/sell\.smartstore\.naver\.com\/#\/home/, { timeout: 60000 });
        }
    } catch (e) {
        console.log('Timeout waiting for login. Checking if already on home...');
        if (!this.page.url().includes('sell.smartstore.naver.com')) return false;
    }
    
    console.log('Login successful!');
    await this.saveSession();
    
    // Land on product list page
    console.log('Navigating to SmartStore product list...');
    await this.page.goto(`${this.baseUrl}/#/products/origin-list`);
    await this.page.waitForLoadState('networkidle');
    
    return true;
  }

  async copyAndRegisterProduct(data) {
    console.log(`Starting Product Registration for Template ID: ${data.templateId} (Mode: ${data.mode || 'copy'})`);
    
    await this._navigateWithCacheBust(data.templateId, data.mode || 'copy');

    console.log(`Product page loaded. Current URL: ${this.page.url()}`);

    // 2. Update Title - use AngularJS-aware input filling
    if (data.title) {
        console.log('Updating Title...');
        await this._fillAngularInput(
          'input[name="product.name"]',
          data.title,
          'Title'
        );
    } else {
        console.log('Title not provided, skipping...');
    }
    
    // 3. Update Price - use the known id #prd_price2 from DOM dump
    if (data.price) {
        console.log('Updating Price...');
        await this._fillAngularInput(
          'input[name="product.salePrice"], input#prd_price2',
          data.price.toString(),
          'Price'
        );
    } else {
        console.log('Price not provided, skipping...');
    }

    // 4. Update Stock - may be disabled when options are enabled
    if (data.stock) {
        console.log('Updating Stock...');
        const stockLocator = this.page.locator('input[name="product.stockQuantity"], input#stock').first();
        try {
            if (await stockLocator.count() > 0 && await stockLocator.isEnabled()) {
                await this._fillAngularInput(
                  'input[name="product.stockQuantity"], input#stock',
                  data.stock.toString(),
                  'Stock'
                );
            } else {
                console.log('Stock input is disabled (options control stock). Will update via option rows.');
            }
        } catch(e) {
            console.log('Stock input not accessible, skipping:', e.message);
        }
    }

    // 5. Skip Main Image Upload - copy registration keeps the template's representative image.
    //    The SmartStore uses a photo-storage modal (not a simple file input), so we skip this.
    console.log('Skipping main image update (using template image from copy registration).');

    // 6. Update Smart Editor ONE (상세설명) - inject ESM HTML
    if (data.esmHtml) {
        console.log('Updating product description (Smart Editor ONE)...');
        await this._updateSmartEditorContent(data.esmHtml, data.category);
    } else {
        console.log('No ESM HTML provided, skipping description update.');
    }

    // 7. Update Option values
    if (data.optionModel) {
        console.log('Updating Options...');
        await this._updateOptions(data);
    }

    // 8. Update Origin Info (원산지)
    console.log('Setting origin info...');
    await this._updateOriginInfo();

    // 9. Save the product
    console.log('Saving copied product...');
    await this._saveProduct();

    // 10. Extract URL from success or current page
    console.log('Extracting registered product URL...');
    return await this._extractResultUrl();
  }

  // ── Helper: Navigate to copy or edit page with login redirect handling ──────
  async _navigateWithCacheBust(templateId, mode) {
    const maxAttempts = 3;
    const route = mode === 'edit' ? 'edit' : 'copy';
    
    // Helper to check if we're on a login page
    const isLoginPage = () => {
        const url = this.page.url();
        return url.includes('accounts.commerce.naver.com') || 
               url.includes('nid.naver.com') || 
               url.includes('/login');
    };
    
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        console.log(`Navigation attempt ${attempt}/${maxAttempts}...`);
        
        // Use cache-bust query param to force Playwright to do a full page load
        // This ensures the AngularJS SPA bootstraps fresh with the desired route
        const cacheBustUrl = `${this.baseUrl}/?_=${Date.now()}#/products/${route}/${templateId}`;
        console.log(`Navigating to: ${cacheBustUrl}`);
        
        await this.page.goto(cacheBustUrl, { waitUntil: 'networkidle' });
        await sleep(5000);
        
        // Handle login redirect if needed
        if (isLoginPage()) {
            console.log('Redirected to login page. Waiting for manual login (120s)...');
            try {
                await this.page.waitForURL(/sell\.smartstore\.naver\.com/, { timeout: 120000 });
                await sleep(3000);
                if (isLoginPage()) {
                    await this.page.waitForURL(/sell\.smartstore\.naver\.com\/#/, { timeout: 60000 });
                }
                console.log('Login completed. Saving session...');
                await this.saveSession();
                await sleep(3000);
                
                // Re-navigate to copy URL after login
                const retryUrl = `${this.baseUrl}/?_=${Date.now()}#/products/${route}/${templateId}`;
                await this.page.goto(retryUrl, { waitUntil: 'networkidle' });
                await sleep(5000);
            } catch (e) {
                throw new Error('로그인 시간 초과. 먼저 스마트스토어 로그인을 완료해주세요.');
            }
        }
        
        // Dismiss any modals (notice popups, etc.)
        await this._dismissModals();
        await sleep(1000);
        
        // Check for "존재하지 않는 상품" error
        const bodyText = await this.page.evaluate(() => document.body.innerText);
        if (bodyText.includes('존재하지 않는 상품')) {
            throw new Error(`템플릿 ID ${templateId}에 해당하는 상품이 존재하지 않습니다. 올바른 템플릿 ID를 확인해주세요.`);
        }
        
        // Wait for the actual product name input as confirmation the form loaded
        try {
            await this.page.waitForSelector('input[name="product.name"]', { state: 'visible', timeout: 15000 });
            console.log('✓ Successfully landed on the product registration form.');
            return;
        } catch(e) {
            console.log('Product form not fully loaded yet...');
            try { 
                const debugPath = path.join(os.tmpdir(), `debug_attempt_${attempt}.png`);
                await this.page.screenshot({ path: debugPath }); 
                console.log(`  Debug screenshot saved: ${debugPath}`);
            } catch(e2) {}
            console.log(`  Current URL: ${this.page.url()}`);
            continue;
        }
    }
    
    throw new Error('복사 등록 페이지에 진입할 수 없습니다. 네트워크 상태를 확인해주세요.');
  }

  // ── Helper: Dismiss all modals ──────────────────────────────────────
  async _dismissModals() {
    // Run multiple passes to catch stacked modals
    for (let pass = 0; pass < 3; pass++) {
        let dismissed = false;

        // seller-layer-modal X close buttons
        try {
            const xBtns = this.page.locator('.seller-layer-modal button.close, .seller-notice-popup button.close, .modal-header button.close, button[aria-label="Close"]');
            const xCount = await xBtns.count();
            for (let i = 0; i < xCount; i++) {
                try {
                    if (await xBtns.nth(i).isVisible({ timeout: 500 }).catch(() => false)) {
                        await xBtns.nth(i).click({ force: true });
                        await sleep(500);
                        dismissed = true;
                    }
                } catch(e) {}
            }
        } catch(e) {}

        // "닫기" / "하루동안 보지 않기" buttons
        try {
            const closeBtns = this.page.locator('button:has-text("닫기"), button:has-text("하루동안 보지 않기")');
            const count = await closeBtns.count();
            for (let i = 0; i < count; i++) {
                try {
                    if (await closeBtns.nth(i).isVisible({ timeout: 300 }).catch(() => false)) {
                        await closeBtns.nth(i).click({ force: true });
                        await sleep(300);
                        dismissed = true;
                    }
                } catch(e) {}
            }
        } catch(e) {}

        // Force-remove any modal backdrop via JS
        try {
            await this.page.evaluate(() => {
                document.querySelectorAll('.modal-backdrop').forEach(el => el.remove());
                document.body.classList.remove('modal-open');
                document.body.style.overflow = '';
                document.body.style.paddingRight = '';
            });
        } catch(e) {}

        if (!dismissed) break;
        await sleep(300);
    }
  }

  // ── Helper: Fill an AngularJS-bound input properly ──────────────────
  async _fillAngularInput(selector, value, fieldName) {
    const locator = this.page.locator(selector).first();
    
    // Wait for the element to appear
    await locator.waitFor({ state: 'visible', timeout: 15000 });
    
    // Clear and type (triple-click + type is more reliable than .fill for AngularJS)
    await locator.click({ clickCount: 3 });
    await sleep(200);
    await this.page.keyboard.press('Backspace');
    await sleep(200);
    await locator.type(value, { delay: 30 });
    
    // Trigger AngularJS model update via blur
    await locator.dispatchEvent('input');
    await locator.dispatchEvent('change');
    await locator.evaluate(el => el.blur());
    await sleep(300);
    
    console.log(`  ✓ ${fieldName} set to: ${value}`);
  }

  // ── Helper: Update Smart Editor ONE content ─────────────────────────
  async _updateSmartEditorContent(esmHtml, category) {
    try {
        // Scroll to description section first
        const descSection = this.page.locator('.title-line:has-text("상세설명")').first();
        if (await descSection.count() > 0) {
            await descSection.scrollIntoViewIfNeeded();
            await sleep(500);
            
            // Check if it is expanded by checking the class of the toggle button
            const toggleBtn = descSection.locator('a.btn-hide').first();
            if (await toggleBtn.count() > 0) {
                const isActive = await toggleBtn.evaluate(el => el.classList.contains('active')).catch(() => false);
                if (!isActive) {
                    console.log('  Expanding "상세설명" section...');
                    await toggleBtn.click({ force: true });
                    await sleep(1500);
                } else {
                    console.log('  "상세설명" section is already expanded.');
                }
            }
        }

        // Wait a bit for AngularJS to render the inner content
        await sleep(1000);

        // Click '직접작성' if it exists to ensure the SmartEditor button appears
        const directWriteRadio = this.page.locator('label:has-text("직접작성")').first();
        if (await directWriteRadio.count() > 0) {
            await directWriteRadio.click();
            await sleep(1000);
        }

        // New Logic: Click 'SmartEditor ONE 으로 수정' button
        // Find the button reliably using its data attribute
        const seOneBtn = this.page.locator('button[data-nclicks-code="descrip.sebtn"]').first();
        if (await seOneBtn.count() > 0 && await seOneBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
            console.log('  Found "SmartEditor ONE" button. Clicking...');
            
            // Wait for new page (popup) event
            const pagePromise = this.page.context().waitForEvent('page', { timeout: 15000 }).catch(e => {
                console.log("  Timeout waiting for SmartEditor popup event", e);
                return null;
            });
            
            await seOneBtn.evaluate(el => el.click());
            
            const editorPage = await pagePromise;

            if (editorPage) {
                console.log(`  SmartEditor ONE popup opened! URL: ${editorPage.url()}`);
                await editorPage.waitForLoadState('networkidle');
                await sleep(3000); // Wait for editor components to fully render

                // The user says: 
                // "자동차의 경우 16번째 줄에 있고, 오토바이의 경우 1번째 줄에 있어."
                // "기존 이미지는 삭제 하고, 그 자리에 HTML 주소를 채워 넣으면 돼"
                
                // SmartEditor ONE uses .se-image-resource for actual images
                // Let's locate all images.
                const imageLocator = editorPage.locator('.se-image-resource');
                const imageCount = await imageLocator.count();
                console.log(`  Found ${imageCount} images in SmartEditor ONE.`);

                // The user says: "자동차, 바이크 둘다 첫번째 줄에 삽입하는걸로 해줘"
                let targetIndex = 0; 

                if (targetIndex >= 0 && targetIndex < imageCount) {
                    console.log(`  Targeting image at index ${targetIndex} for deletion.`);
                    const targetImage = imageLocator.nth(targetIndex);
                    
                    // Click to focus the image
                    await targetImage.click();
                    await sleep(500);
                    
                    // Delete the image
                    await editorPage.keyboard.press('Delete');
                    await sleep(1000);
                    console.log('  ✓ Deleted existing image.');
                    
                    if (category === '오토바이' || category === '바이크') {
                        console.log('  Moving cursor to the top of the document for motorcycle...');
                        const firstComponent = editorPage.locator('.se-component').first();
                        if (await firstComponent.count() > 0) {
                            await firstComponent.click({ position: { x: 5, y: 5 } });
                            await sleep(200);
                            await editorPage.keyboard.press('Control+Home');
                            await sleep(500);
                        }
                    }
                    
                    console.log('  Clicking HTML Attach button...');
                    const htmlBtn = editorPage.locator('.se-shopping-html-toolbar-button').first();
                    if (await htmlBtn.count() > 0) {
                        await htmlBtn.click();
                        await sleep(1000);
                        
                        console.log('  Typing HTML into convert modal...');
                        const textarea = editorPage.locator('textarea#textarea');
                        await textarea.waitFor({ state: 'visible', timeout: 5000 }).catch(() => null);
                        
                        if (await textarea.count() > 0) {
                            await textarea.fill(''); // Clear any existing text
                            
                            // Ensure esmHtml is wrapped in an img tag if it's just a URL
                            let finalHtml = esmHtml.trim();
                            if (!finalHtml.toLowerCase().includes('<img')) {
                                finalHtml = `<img src="${finalHtml}" />`;
                            }
                            
                            // Use finalHtml directly because this is an HTML converter
                            await textarea.fill(finalHtml);
                            await sleep(500);
                            
                            console.log('  Clicking convert button...');
                            const convertBtn = editorPage.locator('.modal-dialog .modal-footer button.btn-primary:has-text("변환")').first();
                            if (await convertBtn.count() > 0) {
                                await convertBtn.click();
                            } else {
                                await editorPage.keyboard.press('Enter');
                            }
                            console.log('  ✓ HTML confirmed and inserted into editor as image.');
                        } else {
                            console.log('  Textarea not found in HTML modal, typing directly into editor...');
                            await editorPage.keyboard.insertText(esmHtml);
                            await sleep(500);
                            await editorPage.keyboard.press('Enter');
                        }
                        await sleep(1000);
                    } else {
                        console.log('  HTML button not found. Typing HTML directly...');
                        await editorPage.keyboard.type(esmHtml, { delay: 5 });
                        await editorPage.keyboard.press('Space'); 
                        await editorPage.keyboard.press('Enter');
                    }
                    
                    // Wait to ensure it's registered
                    await sleep(2000);
                    
                    // Click "등록" (Register) button in the editor popup
                    const registerBtn = editorPage.locator('button:has-text("등록"), a:has-text("등록")').first();
                    if (await registerBtn.count() > 0) {
                        console.log('  Clicking "등록" button in SmartEditor ONE...');
                        await registerBtn.click({ force: true });
                        
                        // Wait for popup to close
                        await sleep(3000);
                        console.log('  ✓ SmartEditor ONE updated successfully.');
                    } else {
                        console.log('  "등록" button not found in SmartEditor ONE popup.');
                    }
                } else {
                    console.log(`  Target image index ${targetIndex} is out of bounds (found ${imageCount} images). Cannot replace.`);
                }
            } else {
                console.log('  Failed to intercept SmartEditor ONE popup.');
            }
        } else {
            console.log('  "SmartEditor ONE" button not found. Dumping "상세설명" section HTML for debugging...');
            const sectionHtml = await this.page.locator('xpath=//div[contains(@class, "title-line") and contains(., "상세설명")]/..').evaluate(el => el.outerHTML).catch(() => 'Failed to dump');
            const debugHtmlPath = path.join(os.tmpdir(), 'debug_desc_section.html');
            fs.writeFileSync(debugHtmlPath, sectionHtml);
            console.log(`  Saved HTML to ${debugHtmlPath}`);
        }

    } catch(e) {
        console.log('  Smart Editor update failed:', e.message);
    }
  }

  // ── Helper: Fill a single option input by ID ─────────────────────────
  async _fillOptionInput(inputId, value, label) {
    const input = this.page.locator(`#${inputId}`);
    if (await input.count() === 0) {
        console.log(`  Option input #${inputId} not found. Skipping.`);
        return false;
    }
    const visible = await input.isVisible({ timeout: 2000 }).catch(() => false);
    if (!visible) {
        console.log(`  Option input #${inputId} not visible. Skipping.`);
        return false;
    }
    await input.scrollIntoViewIfNeeded().catch(() => {});
    await sleep(300);
    await input.click({ clickCount: 3, force: true });
    await sleep(200);
    await this.page.keyboard.press('Backspace');
    await sleep(200);
    await input.type(value, { delay: 30 });
    await input.dispatchEvent('input');
    await input.dispatchEvent('change');
    await sleep(500);
    console.log(`  ✓ ${label} set: ${value}`);
    return true;
  }

  // ── Helper: Update option values ────────────────────────────────────
  async _updateOptions(data) {
    try {
        // Step 1: Scroll to option section header
        const optionHeader = this.page.locator('.title-line:has-text("옵션")').first();
        if (await optionHeader.count() > 0) {
            await optionHeader.scrollIntoViewIfNeeded();
            await sleep(500);
        }

        // Step 2: Expand the option section
        const optToggleBtn = this.page.locator('.title-line:has-text("옵션") a.btn.btn-default').first();
        if (await optToggleBtn.count() > 0) {
            console.log('  Clicking option section toggle button...');
            await optToggleBtn.click({ force: true });
            await sleep(1500);
        }

        // Step 3: If still hidden, force-expand via AngularJS scope
        const optionInput0 = this.page.locator('#choice_option_value0');
        if (await optionInput0.count() === 0) {
            console.log('  Option input #choice_option_value0 not found.');
            return;
        }

        let isVisible = await optionInput0.isVisible({ timeout: 2000 }).catch(() => false);
        if (!isVisible) {
            console.log('  Option still hidden. Force-expanding via AngularJS scope...');
            await this.page.evaluate(() => {
                const el = document.getElementById('choice_option_value0');
                if (!el) return;
                let current = el;
                while (current) {
                    if (current.classList && current.classList.contains('ng-hide')) {
                        current.classList.remove('ng-hide');
                        current.style.display = '';
                        try {
                            const scope = angular.element(current).scope();
                            if (scope && scope.vm) {
                                scope.vm.isMenuOpen = true;
                                scope.$apply();
                            }
                        } catch(e) {}
                        break;
                    }
                    current = current.parentElement;
                }
            });
            await sleep(1000);
            isVisible = await optionInput0.isVisible({ timeout: 2000 }).catch(() => false);
        }

        if (!isVisible) {
            console.log('  Option inputs still not visible. Skipping.');
            return;
        }

        // Step 4: Fill all 3 option values
        // Option 0: 모델명
        if (data.optionModel) {
            await this._fillOptionInput('choice_option_value0', data.optionModel, 'Option 0 (모델명)');
        }
        // Option 1: 상품선택
        if (data.optionProduct) {
            await this._fillOptionInput('choice_option_value1', data.optionProduct, 'Option 1 (상품선택)');
        }
        // Option 2: 운전석/조수석 선택
        if (data.optionSeat) {
            await this._fillOptionInput('choice_option_value2', data.optionSeat, 'Option 2 (운전석/조수석)');
        }

        // Step 5: Click '옵션목록으로 적용' button
        const applyBtn = this.page.locator('a:has-text("옵션목록으로 적용")').first();
        if (await applyBtn.count() > 0) {
            await applyBtn.scrollIntoViewIfNeeded().catch(() => {});
            await sleep(300);
            await applyBtn.click({ force: true });
            await sleep(3000);

            // Handle confirmation dialog
            await this._dismissModals();
            await sleep(1000);

            // Update stock and price for all option rows
            await this._updateOptionStockAndPrice(data);
        } else {
            console.log('  옵션목록으로 적용 button not found.');
        }
    } catch(e) {
        console.log('Option update failed (non-critical):', e.message);
    }
  }

  // ── Helper: Update stock & price in option grid ─────────────────────
  async _updateOptionStockAndPrice(data) {
    try {
        const stock = data.stock || '999';
        const isCar = data.category === '자동차';

        console.log(`  Updating option grid: Stock=${stock}, isCar=${isCar}`);
        await sleep(3000); // Wait for grid to render fully

        // Strategy 1: Bulk UI Method
        try {
            // Click "Select All" checkbox in the grid header
            const selectAllCb = this.page.locator('.ag-header-row input[type="checkbox"], .ag-header-row .ag-selection-checkbox, .ag-header-select-all').first();
            if (await selectAllCb.count() > 0 && await selectAllCb.isVisible({ timeout: 2000 }).catch(() => false)) {
                await selectAllCb.scrollIntoViewIfNeeded();
                await selectAllCb.click({ force: true });
                await sleep(1000);
                
                // Set Bulk Stock using helper
                const bulkStockSelector = 'input[ng-model*="bulkStockQuantity"], input[ng-model*="StockQuantity"], input[placeholder="재고수량"]';
                if (await this.page.locator(bulkStockSelector).first().isVisible()) {
                    await this._fillAngularInput(bulkStockSelector, stock.toString(), 'Bulk Stock');
                    await sleep(500);
                }

                // Click Bulk Apply Button
                const bulkApplyBtn = this.page.locator('button:has-text("선택목록 일괄수정"), button:has-text("일괄적용")').first();
                if (await bulkApplyBtn.isVisible()) {
                    await bulkApplyBtn.click({ force: true });
                    await sleep(2000);
                    console.log(`  ✓ Bulk stock applied via UI.`);
                }
                
                // Deselect All
                await selectAllCb.click({ force: true });
                await sleep(500);
            }
        } catch(e) {
            console.log('  Bulk UI stock apply failed:', e.message);
        }

        // Strategy 2: Individual Row Method (for Price, and fallback for Stock)
        const rows = this.page.locator('.ag-center-cols-container .ag-row');
        const rowCount = await rows.count();
        console.log(`  Found ${rowCount} option rows for individual update.`);

        let stockUpdated = 0;
        let priceUpdated = 0;

        for (let i = 0; i < rowCount; i++) {
            const row = rows.nth(i);
            const rowText = await row.innerText().catch(() => '');
            
            // 1. Update Stock
            const stockCell = row.locator('div[col-id="stockQuantity"]');
            if (await stockCell.count() > 0) {
                await stockCell.evaluate(el => el.scrollIntoView({ block: 'center' })).catch(() => {});
                await sleep(100);
                
                // Double click using Playwright's native mouse interaction
                await stockCell.dblclick({ force: true });
                
                // Wait for the inline editor input to appear WITHIN THIS ROW
                const activeInput = row.locator('.ag-cell-inline-editing input').first();
                await activeInput.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
                
                if (await activeInput.isVisible()) {
                    await activeInput.fill('');
                    await activeInput.type(stock.toString(), { delay: 30 });
                    await sleep(200);
                    // Commit by pressing Enter
                    await activeInput.press('Enter');
                    await sleep(500);
                    stockUpdated++;
                }
            }

            // 2. Update Price for 조수석
            const isPassengerSeat = rowText.includes('조수석');
            if (isCar && isPassengerSeat) {
                const priceCell = row.locator('div[col-id="optionPrice"], div[col-id="price"]').first();
                if (await priceCell.count() > 0) {
                    await priceCell.evaluate(el => el.scrollIntoView({ block: 'center' })).catch(() => {});
                    await sleep(100);
                    
                    // Double click using Playwright's native mouse interaction
                    await priceCell.dblclick({ force: true });
                    
                    // Wait for the inline editor input to appear WITHIN THIS ROW
                    const activeInput = row.locator('.ag-cell-inline-editing input').first();
                    await activeInput.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
                    
                    if (await activeInput.isVisible()) {
                        await activeInput.fill('');
                        await activeInput.type('-10000', { delay: 30 });
                        await sleep(200);
                        // Commit by pressing Enter
                        await activeInput.press('Enter');
                        await sleep(500);
                        priceUpdated++;
                    }
                }
            }
        }

        console.log(`  ✓ Option grid updated. Stock updated: ${stockUpdated}, Price updated: ${priceUpdated}`);

    } catch(e) {
        console.log('  Option stock/price update skipped:', e.message);
    }
  }

  // ── Helper: Update origin info ──────────────────────────────────────
  async _updateOriginInfo() {
    try {
        // Click 국산 radio
        const domesticLabel = this.page.locator('label:has-text("국산")').first();
        if (await domesticLabel.count() > 0) {
            await domesticLabel.click();
            await sleep(500);
        }
        
        // Select 경기도
        const provinceSelect = this.page.locator('select[ng-model*="province"], select[name*="province"]').first();
        if (await provinceSelect.count() > 0 && await provinceSelect.isVisible({ timeout: 2000 }).catch(() => false)) {
            await provinceSelect.selectOption({ label: '경기도' });
            await sleep(500);
        }
        
        // Select 수원시
        const citySelect = this.page.locator('select[ng-model*="city"], select[name*="city"]').first();
        if (await citySelect.count() > 0 && await citySelect.isVisible({ timeout: 2000 }).catch(() => false)) {
            await citySelect.selectOption({ label: '수원시' });
        }
        
        console.log('  ✓ Origin info set: 국산 / 경기도 / 수원시');
    } catch(e) {
        console.log('  Origin info update skipped:', e.message);
    }
  }

  // ── Helper: Save product ────────────────────────────────────────────
  async _saveProduct() {
    try {
        // IMPORTANT: Dismiss any remaining modals before trying to save
        await this._dismissModals();
        await sleep(1000);

        // Force remove any modal backdrops and overlays
        await this.page.evaluate(() => {
            document.querySelectorAll('.modal-backdrop, .modal.fade.in').forEach(el => {
                if (!el.querySelector('button:has-text("저장")')) el.remove();
            });
            document.body.classList.remove('modal-open');
            document.body.style.overflow = '';
            document.body.style.paddingRight = '';
        });
        await sleep(500);

        // Scroll to top where save button is typically visible
        await this.page.evaluate(() => window.scrollTo(0, 0));
        await sleep(500);

        // The save button: '저장하기'
        const submitBtn = this.page.locator('button:has-text("저장하기")').first();

        if (await submitBtn.count() > 0) {
            await submitBtn.click({ force: true });
            await sleep(5000);

            // Handle save confirmation dialog
            const confirmBtn = this.page.locator('.modal-dialog button:has-text("확인"), .seller-layer-modal button:has-text("확인")');
            if (await confirmBtn.count() > 0 && await confirmBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
                await confirmBtn.click({ force: true });
                await sleep(3000);
            }
            console.log('  ✓ Save button clicked.');
        } else {
            console.log('  Save button not found. Product may need manual save.');
        }
    } catch(e) {
        console.log('  Save failed:', e.message);
    }
  }

  // ── Helper: Extract result URL ──────────────────────────────────────
  async _extractResultUrl() {
    try {
        await sleep(2000);
        
        // Look for success modal with product link
        const linkLocator = this.page.locator('.modal-dialog a[href*="smartstore"], .modal-dialog a:has-text("상품보기")');
        if (await linkLocator.count() > 0) {
            const href = await linkLocator.getAttribute('href');
            console.log(`  ✓ Product URL found: ${href}`);
            return href;
        }
        
        // Fallback: return current page URL
        const currentUrl = this.page.url();
        console.log(`  Product URL (fallback): ${currentUrl}`);
        return currentUrl;
    } catch(e) {
        return this.page.url();
    }
  }
}
