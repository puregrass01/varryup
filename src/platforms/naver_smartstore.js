import { BasePlatform } from './base_platform.js';
import { uploadRepresentative, replaceDescriptionImages } from './naver_managed_images.js';
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

    // 서버 로그인정보가 있으면 네이버 아이디 팝업까지 자동입력 시도. (실패 시 수동 진행)
    await this._tryAutoLogin();

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

  /**
   * 네이버 로그인 페이지가 보이면 '네이버 아이디로 로그인' 팝업을 열어 아이디/비번을 자동입력한다.
   * 첫 로그인(login)과 등록 중 재로그인(_navigateWithCacheBust) 양쪽에서 재사용한다.
   * 네이버가 자동입력을 막거나 캡차를 띄우면 실패로 두고 수동 진행하게 한다.
   */
  async _tryAutoLogin() {
    if (!(this.autoLogin && this.autoLogin.loginId && this.autoLogin.password)) return false;
    try {
      console.log('[네이버] 자동 로그인 시도... URL:', this.page.url());
      await this.page.waitForLoadState('domcontentloaded').catch(() => {});
      await sleep(1200);

      // '네이버 아이디로 로그인'을 누르면 로그인이 '새 팝업창'으로 열린다 → 그 팝업에 입력해야 한다.
      let loginPage = null;
      for (const sel of [
        'button:has-text("네이버 아이디로 로그인")',
        'a:has-text("네이버 아이디로 로그인")',
        '[role="tab"]:has-text("네이버 아이디로 로그인")',
      ]) {
        const el = this.page.locator(sel).first();
        if (await el.count() === 0) continue;
        try {
          const [popup] = await Promise.all([
            this.page.waitForEvent('popup', { timeout: 8000 }).catch(() => null),
            el.click({ timeout: 2500 }),
          ]);
          loginPage = popup;
          console.log('[네이버] 탭 클릭:', sel, '| 팝업:', popup ? '열림' : '없음(같은창)');
          break;
        } catch (e) { /* 다음 후보 시도 */ }
      }

      const target = loginPage || this.page;   // 팝업이 열렸으면 팝업, 아니면 현재 창
      await target.waitForLoadState('domcontentloaded').catch(() => {});
      await sleep(1500);
      console.log('[네이버][진단] 입력대상 URL:', target.url());

      const pwField = target.locator('input[type="password"]:visible, #pw').first();
      const idField = target.locator('#id, input[type="text"]:visible, input[type="email"]:visible').first();
      await pwField.waitFor({ timeout: 8000 });
      await idField.fill(this.autoLogin.loginId);
      await pwField.fill(this.autoLogin.password);
      await target.keyboard.press('Enter');
      console.log('[네이버] 자동 입력 완료. (캡차·2단계 인증이 뜨면 직접 처리)');
      return true;
    } catch (e) {
      console.log('[네이버] 자동 로그인 입력 실패 → 수동으로 진행:', e.message);
      return false;
    }
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
    if (data.mainImagePath) await uploadRepresentative(this.page, data.mainImagePath);
    else console.log('Skipping main image update (using template image from copy registration).');

    // 6. Update Smart Editor ONE (상세설명) - inject ESM HTML
    if (data.esmHtml || data.detailHtml) {
        console.log('Updating product description (Smart Editor ONE)...');
        await this._updateSmartEditorContent([data.esmHtml, data.detailHtml].filter(Boolean).join('\n'), data.category, !!data.detailHtml);
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

    // 9. Save the product — 저장 요청의 응답을 지켜보며 누른다(판정 신호).
    console.log('Saving copied product...');
    const watch = this._watchSaveResponse();
    try {
        const saved = await this._saveProduct();

        // 10. 저장이 실제로 됐는지 확인하고 URL 을 얻는다. 확인하지 못하면 던진다 —
        //     main 의 중복 방지 원장은 여기서 값이 돌아와야만 '등록됨'을 적는다.
        console.log('Extracting registered product URL...');
        return await this._extractResultUrl(watch.save, saved);
    } finally {
        watch.stop();
    }
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
            console.log('등록 중 로그인 페이지로 튕김 → 자동 로그인 재시도...');
            await this._tryAutoLogin();   // 첫 로그인과 동일하게 네이버 아이디 팝업 자동입력
            console.log('로그인 대기 (자동입력 실패 시 직접 로그인, 120초)...');
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
  async _updateSmartEditorContent(esmHtml, category, replaceAll = false) {
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
                if (replaceAll) {
                    await replaceDescriptionImages(editorPage, esmHtml);
                    await editorPage.waitForEvent('close', { timeout: 10000 }).catch(() => {});
                    return;
                }

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
                if (replaceAll) throw new Error('네이버 상세설명 팝업을 열지 못했습니다. 상품은 저장하지 않았습니다.');
            console.log('  Failed to intercept SmartEditor ONE popup.');
            }
        } else {
            console.log('  "SmartEditor ONE" button not found. Dumping "상세설명" section HTML for debugging...');
            const sectionHtml = await this.page.locator('xpath=//div[contains(@class, "title-line") and contains(., "상세설명")]/..').evaluate(el => el.outerHTML).catch(() => 'Failed to dump');
            if (replaceAll) throw new Error('네이버 상세설명 버튼을 찾지 못했습니다. 상품은 저장하지 않았습니다.');
            const debugHtmlPath = path.join(os.tmpdir(), 'debug_desc_section.html');
            fs.writeFileSync(debugHtmlPath, sectionHtml);
            console.log(`  Saved HTML to ${debugHtmlPath}`);
        }

    } catch(e) {
        console.log('  Smart Editor update failed:', e.message);
        if (replaceAll) throw e;
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
            throw new Error('옵션 입력칸(#choice_option_value0)을 찾지 못했습니다.');
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
            throw new Error('옵션 입력칸이 화면에 열리지 않았습니다.');
        }

        // Step 4: Fill all 3 option values
        // 넣으라고 받은 값을 못 넣으면 템플릿 옵션이 그대로 남는다 → 채우지 못한 칸이 있으면 멈춘다.
        const fills = [
            ['choice_option_value0', data.optionModel, 'Option 0 (모델명)', '모델명'],
            ['choice_option_value1', data.optionProduct, 'Option 1 (상품선택)', '상품선택'],
            ['choice_option_value2', data.optionSeat, 'Option 2 (운전석/조수석)', '운전석/조수석'],
        ];
        for (const [inputId, value, label, name] of fills) {
            if (!value) continue;
            const filled = await this._fillOptionInput(inputId, value, label);
            if (!filled) throw new Error(`옵션 "${name}" 입력칸(#${inputId})을 채우지 못했습니다.`);
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
            // 적용을 못 누르면 입력칸 값이 옵션 목록에 들어가지 않는다 — 템플릿 옵션 그대로 저장된다.
            throw new Error('"옵션목록으로 적용" 버튼을 찾지 못했습니다.');
        }
    } catch(e) {
        // 예전엔 "non-critical" 로 삼키고 저장까지 진행했다. 그러면 템플릿의 옵션(다른 차종)이 붙은
        // 상품이 만들어지고 등록 성공으로 보고됐다. 옵션을 못 바꾸면 저장하지 않고 멈춘다.
        console.log('Option update failed:', e.message);
        throw new Error(`스마트스토어 옵션 변경 실패 — 상품은 저장하지 않았습니다. (${e.message})`);
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
        // 옵션 재고·조수석 가격을 못 넣은 채 저장하면 가격이 틀린 상품이 생긴다 → 옵션 변경 실패로 올린다.
        console.log('  Option stock/price update failed:', e.message);
        throw new Error(`옵션 재고/가격 입력 실패: ${e.message}`);
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

  // ── Helper: Watch the save request ──────────────────────────────────
  // 판매자센터는 "저장하기"를 누르면 /api/products 로 본문을 보낸다(수정 화면에서 실측 —
  // 옛 수정 모듈은 PATCH 를 가로챘다. 복사등록은 새 상품이라 POST 일 것이다).
  // 그 응답 상태가 저장 성공·거부의 가장 확실한 신호라 저장 전후로 지켜본다.
  // 주소가 달라 못 잡으면 status 0 으로 남고, 그때는 화면 신호(성공 팝업·주소)로 판정한다.
  _watchSaveResponse() {
    const save = { status: 0, text: '', method: '' };
    const onResponse = async (r) => {
      try {
        const method = r.request().method();
        if (!['POST', 'PUT', 'PATCH'].includes(method)) return;
        if (!/\/api\/products$/.test(r.url().split('?')[0])) return;
        save.status = r.status();
        save.method = method;
        try { save.text = (await r.text()).slice(0, 500); } catch { /* 본문 없음 */ }
      } catch { /* 응답 읽기 실패는 무시 — 화면 신호로 판정한다 */ }
    };
    this.page.on('response', onResponse);
    return { save, stop: () => { try { this.page.off('response', onResponse); } catch { /* 이미 닫힘 */ } } };
  }

  /** 지금 떠 있는 팝업들의 글자 (저장 결과 판정·오류 안내용) */
  async _visibleModalText() {
    try {
      return await this.page.evaluate(() => Array.from(document.querySelectorAll('.modal-dialog, .seller-layer-modal'))
        .filter(el => el.getClientRects().length > 0)
        .map(el => String(el.textContent || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean).join(' / ').slice(0, 300));
    } catch { return ''; }
  }

  // ── Helper: Save product ────────────────────────────────────────────
  // 예전엔 전체를 try/catch 로 감싸 로그만 남겼다 — 저장 버튼을 못 찾거나 클릭이 실패해도
  // 등록 성공으로 보고됐고, 원장에 '등록됨'이 남아 최대 24시간 재시도가 막혔다. 이제 던진다.
  async _saveProduct() {
    // IMPORTANT: Dismiss any remaining modals before trying to save
    await this._dismissModals();
    await sleep(1000);

    // Force remove any modal backdrops and overlays (정리 작업이라 실패해도 저장은 시도한다)
    try {
        await this.page.evaluate(() => {
            document.querySelectorAll('.modal-backdrop, .modal.fade.in').forEach(el => {
                // ':has-text' 는 Playwright 전용이라 브라우저 querySelector 에선 SyntaxError 가 난다.
                // 예전 코드는 그 예외로 저장 단계 전체가 건너뛰어졌다 → 글자로 직접 확인한다.
                const hasSave = Array.from(el.querySelectorAll('button')).some(b => String(b.textContent || '').includes('저장'));
                if (!hasSave) el.remove();
            });
            document.body.classList.remove('modal-open');
            document.body.style.overflow = '';
            document.body.style.paddingRight = '';
        });
    } catch (e) {
        console.log('  Backdrop cleanup failed (continuing):', e.message);
    }
    await sleep(500);

    // Scroll to top where save button is typically visible
    await this.page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    await sleep(500);

    // The save button: '저장하기'
    const submitBtn = this.page.locator('button:has-text("저장하기")').first();
    if (await submitBtn.count() === 0) {
        throw new Error('저장하기 버튼을 찾지 못했습니다 — 상품이 저장되지 않았습니다.');
    }
    try {
        await submitBtn.click({ force: true });
    } catch (e) {
        throw new Error(`저장하기 버튼을 누르지 못했습니다 — 상품이 저장되지 않았습니다. (${e.message})`);
    }
    await sleep(5000);

    // Handle save confirmation dialog
    // 누르기 전에 팝업 글자와 상품 링크를 남긴다 — 이 팝업이 성공 안내면 '확인'을 누르는 순간 링크가
    // 사라지고, 저장이 안 됐으면 이유(필수값 누락 등)가 대개 여기 적혀 있다.
    let modalText = '', href = '';
    const confirmBtn = this.page.locator('.modal-dialog button:has-text("확인"), .seller-layer-modal button:has-text("확인")').first();
    if (await confirmBtn.count() > 0 && await confirmBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
        modalText = await this._visibleModalText();
        href = await this._successLinkHref();
        await confirmBtn.click({ force: true });
        await sleep(3000);
    }
    console.log('  ✓ Save button clicked.');
    return { modalText, href };
  }

  /** 성공 팝업의 상품 링크 (없으면 '') */
  async _successLinkHref() {
    try {
        const linkLocator = this.page.locator('.modal-dialog a[href*="smartstore"], .modal-dialog a:has-text("상품보기")').first();
        if (await linkLocator.count() > 0) return (await linkLocator.getAttribute('href')) || '';
    } catch { /* 링크 없음 — 다른 신호로 판정 */ }
    return '';
  }

  // ── Helper: Extract result URL ──────────────────────────────────────
  // 저장이 실제로 됐는지 판정하고 결과 URL 을 돌려준다. 확인하지 못하면 던진다.
  // 예전엔 성공 팝업이 없으면 '지금 열린 페이지 주소'를 그대로 돌려줘서, 저장이 안 돼 아직
  // 복사등록 양식(#/products/copy/{템플릿})에 있어도 등록 성공으로 보고됐다.
  async _extractResultUrl(save = {}, { modalText = '', href: savedHref = '' } = {}) {
    await sleep(2000);

    // Look for success modal with product link (지금 떠 있는 것 → 없으면 '확인' 전에 잡아 둔 것)
    const href = (await this._successLinkHref()) || savedHref;

    const verdict = judgeNaverSave({
        saveStatus: save.status || 0,
        saveText: save.text || '',
        href,
        url: this.page.url(),
        modalText: [modalText, await this._visibleModalText()].filter(Boolean).join(' / '),
    });
    if (!verdict.ok) {
        console.log(`  ✗ 저장 확인 실패: ${verdict.error}`);
        throw new Error(verdict.error);
    }
    console.log(`  ✓ Product saved (${verdict.basis}): ${verdict.url}`);
    return verdict.url;
  }
}

const NAVER_FORM_URL = /#\/products\/(?:copy|edit|create)(?:[/?]|$)/;
const NAVER_LOGIN_URL = /nid\.naver\.com|accounts\.commerce\.naver\.com|#\/login/;
const SAVE_DONE_TEXT = /(등록|저장)(이|을|를)?\s*(완료|되었습니다|됐습니다)/;
const SAVE_FAIL_TEXT = /(실패|오류|에러|않았|못했|입력해\s*주|필수)/;

/**
 * 복사등록 저장 결과 판정 (브라우저 없이 시험할 수 있게 순수 함수로 둔다).
 * 신호 우선순위: 저장 API 응답 오류 → 성공 팝업의 상품 링크 → 저장 API 2xx → 로그인 튕김 →
 * 성공 문구 팝업 → 아직 등록·수정 양식 주소면 실패 → 양식을 떠났으면 성공.
 * @returns {{ok: true, url: string, basis: string} | {ok: false, error: string}}
 */
export function judgeNaverSave({ saveStatus = 0, saveText = '', href = '', url = '', modalText = '' } = {}) {
  const popup = modalText ? ` (팝업: "${String(modalText).slice(0, 150)}")` : '';
  if (saveStatus >= 400) {
    let reason = String(saveText || '').slice(0, 200);
    try { const j = JSON.parse(saveText); reason = j.message || j.errorMessage || j.code || reason; } catch { /* 본문이 JSON 이 아님 */ }
    return { ok: false, error: `스마트스토어가 저장을 거부했습니다 (HTTP ${saveStatus})${reason ? `: ${reason}` : ''}` };
  }
  if (href) return { ok: true, url: href, basis: '성공 팝업 링크' };
  if (saveStatus >= 200 && saveStatus < 300) return { ok: true, url, basis: `저장 응답 ${saveStatus}` };
  if (NAVER_LOGIN_URL.test(url)) {
    return { ok: false, error: '저장 중 로그인 화면으로 넘어갔습니다 — 상품이 저장되지 않았습니다. 다시 로그인한 뒤 시도하세요.' };
  }
  if (modalText && SAVE_DONE_TEXT.test(modalText) && !SAVE_FAIL_TEXT.test(modalText)) {
    return { ok: true, url, basis: '성공 문구' };
  }
  if (NAVER_FORM_URL.test(url)) {
    return { ok: false, error: `저장 완료를 확인하지 못했습니다 — 화면이 아직 상품 등록 양식에 있습니다${popup}. 판매자센터에서 등록 여부를 확인한 뒤 다시 시도하세요.` };
  }
  return { ok: true, url, basis: '양식을 벗어남' };
}
