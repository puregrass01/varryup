import { BasePlatform } from './base_platform.js';
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export class ESMPlusHosting extends BasePlatform {
  constructor(browser, sessionPath) {
    super(browser, sessionPath);
    this.baseUrl = 'https://www.esmplus.com';
  }

  // [개선] 모든 하위 프레임까지 뒤져서 로그인 상태인지 검사하는 헬퍼 함수
  async checkLoginStatus() {
    if (!this.page || this.page.isClosed()) return false;
    
    for (const frame of this.page.frames()) {
      try {
        const loggedIn = await frame.evaluate(() => {
          const text = document.body ? document.body.innerText : '';
          return text.includes('로그아웃') || 
                 !!document.querySelector('.btn_logout') || 
                 !!document.querySelector('a[href*="LogOut"]') ||
                 !!document.querySelector('a[href*="logout"]');
        });
        if (loggedIn) return true;
      } catch (e) {
        // 크로스 오리진 프레임 접근 에러 방지
      }
    }
    
    // URL 기반 보조 체크 (이미 호스팅 화면이나 메인 대시보드 주소에 접속해 있다면 로그인 완료 상태로 인식)
    const url = this.page.url();
    if (url.includes('Home/Home') || url.includes('Home/v2') || url.includes('ImgView')) {
      return true;
    }
    return false;
  }

  async login() {
    // 1. [개선] 이미 브라우저 창이 열려있고 로그인 상태라면 재초기화 없이 즉시 통과
    if (this.page && !this.page.isClosed()) {
      if (await this.checkLoginStatus()) {
        console.log('Already logged in to ESM Plus (reusing existing page)');
        return true;
      }
    } else {
      // 브라우저 창이 없거나 닫힌 경우에만 새로 초기화하여 창을 띄웁니다.
      await this.init(true);
    }

    // 로그인 페이지로 이동
    await this.page.goto(this.baseUrl);
    await this.page.waitForLoadState('networkidle');

    // 이동 후 다시 로그인 상태 검사 (이전 저장된 세션 복구 성공 시 즉시 통과)
    if (await this.checkLoginStatus()) {
      console.log('Already logged in to ESM Plus after navigation');
      return true;
    }

    console.log('Login required for ESM Plus. Please login manually in the opened browser.');

    // 서버에서 받은 로그인 정보가 있으면 자동입력 시도 (실패해도 아래 수동 대기로 그대로 진행)
    if (this.autoLogin && this.autoLogin.loginId && this.autoLogin.password) {
      try {
        console.log('[ESM] 저장된 계정으로 자동 로그인 시도...');
        await this.page.waitForSelector('#typeMemberInputId01', { timeout: 8000 });
        await this.page.fill('#typeMemberInputId01', this.autoLogin.loginId);
        await this.page.fill('#typeMemberInputPassword01', this.autoLogin.password);
        await this.page.click('button:has-text("로그인")');
        console.log('[ESM] 자동 입력 완료. (캡차·추가 인증이 뜨면 직접 처리)');
      } catch (e) {
        console.log('[ESM] 자동 로그인 입력 실패 → 수동으로 진행:', e.message);
      }
    }

    // 사용자가 웹 브라우저 상에서 수동 로그인 완료할 때까지 대기
    let loginSuccess = false;
    const startTime = Date.now();
    const timeout = 120000; // 2분 대기

    while (Date.now() - startTime < timeout) {
      if (await this.checkLoginStatus()) {
        loginSuccess = true;
        break;
      }
      await sleep(1500); // 1.5초 간격으로 확인
    }

    if (!loginSuccess) {
      console.log('Timeout waiting for login. Please ensure you are logged in.');
      return false;
    }

    console.log('ESM Plus Login successful!');
    await this.saveSession();

    // 이미지 호스팅 관리 페이지로 이동
    console.log('Navigating to ESM Image Hosting...');
    await this.page.goto('https://im.esmplus.com/IHv2/ImgMain/ImgView');
    await this.page.waitForLoadState('networkidle');

    return true;
  }

  /**
   * Navigate to image hosting page and into the specified folder path.
   * Uses jstree API when available, with DOM fallbacks.
   */
  async _navigateToFolder(folderPath) {
    console.log(`Navigating to Image Hosting folder: ${folderPath.join(' > ')}`);
    
    // Navigate to Image Hosting
    await this.page.goto('https://im.esmplus.com/IHv2/ImgMain/ImgView');
    await this.page.waitForLoadState('networkidle');
    await sleep(3000);

    for (const folderName of folderPath) {
        console.log(`  Entering folder: ${folderName}`);
        
        // Method 1: jstree API (most reliable)
        const apiSuccess = await this.page.evaluate((name) => {
            try {
                const $ = window.jQuery || window.$;
                if (!$) return false;
                const treeEl = document.querySelector('.jstree');
                if (!treeEl) return false;
                const treeObj = $(treeEl).jstree(true);
                if (!treeObj) return false;
                
                // Get all nodes and find exact text match
                const allNodes = treeObj.get_json('#', { flat: true });
                for (const node of allNodes) {
                    const nodeText = (node.text || '').replace(/<[^>]*>/g, '').trim();
                    if (nodeText === name) {
                        treeObj.deselect_all(true);
                        treeObj.select_node(node.id);
                        treeObj.open_node(node.id);
                        return true;
                    }
                }
            } catch(e) {
                console.log('jstree API error:', e.message);
            }
            return false;
        }, folderName);
        
        if (apiSuccess) {
            console.log(`    ✓ Opened via jstree API`);
            await sleep(2000);
            continue;
        }

        // Method 2: DOM - find tree anchor by exact text, click, and expand
        const domSuccess = await this.page.evaluate((name) => {
            const anchors = document.querySelectorAll('.jstree a, [id*="tree"] a, [id*="folder"] a');
            for (const a of anchors) {
                if (a.textContent.trim() === name) {
                    a.click();
                    // Also try to expand if closed
                    const li = a.closest('li');
                    if (li && li.classList.contains('jstree-closed')) {
                        const icon = li.querySelector(':scope > ins, :scope > i.jstree-ocl');
                        if (icon) icon.click();
                    }
                    return true;
                }
            }
            return false;
        }, folderName);

        if (domSuccess) {
            console.log(`    ✓ Clicked via DOM`);
            await sleep(2000);
            continue;
        }
        
        // Method 3: double-click in grid view
        try {
            await this.page.dblclick(`text=${folderName}`, { timeout: 5000 });
            console.log(`    ✓ Double-clicked in grid`);
            await sleep(2000);
        } catch (e) {
            console.log(`    ⚠ Folder "${folderName}" not found by any method`);
        }
    }
  }

  /**
   * List ONLY direct subfolders of the target folder path.
   * Uses jstree API to get precise children of the selected node.
   */
  async listSubfolders(folderPath) {
    console.log(`Listing subfolders in: ${folderPath.join(' > ')}`);
    
    await this._navigateToFolder(folderPath);
    await sleep(2000);

    // Method 1: jstree API - get children of the currently selected node
    let folders = await this.page.evaluate(() => {
        const results = [];
        try {
            const $ = window.jQuery || window.$;
            if (!$) return results;
            const treeEl = document.querySelector('.jstree');
            if (!treeEl) return results;
            const treeObj = $(treeEl).jstree(true);
            if (!treeObj) return results;
            
            const selected = treeObj.get_selected();
            if (selected.length === 0) return results;
            
            const node = treeObj.get_node(selected[0]);
            if (!node || !node.children || node.children.length === 0) return results;
            
            for (const childId of node.children) {
                const child = treeObj.get_node(childId);
                if (child) {
                    const name = (child.text || '').replace(/<[^>]*>/g, '').trim();
                    if (name) results.push({ name });
                }
            }
        } catch(e) {
            console.log('jstree API listing error:', e.message);
        }
        return results;
    });

    if (folders.length > 0) {
        console.log(`  Found ${folders.length} subfolders via jstree API`);
        return folders;
    }

    // Method 2: DOM - find the selected (.jstree-clicked) node's direct children
    folders = await this.page.evaluate(() => {
        const results = [];
        const selectedAnchor = document.querySelector('.jstree-clicked');
        if (!selectedAnchor) return results;
        
        const selectedLi = selectedAnchor.closest('li');
        if (!selectedLi) return results;
        
        // Get direct child <ul> and its <li> > <a> elements
        const childUl = selectedLi.querySelector(':scope > ul');
        if (!childUl) return results;
        
        const childAnchors = childUl.querySelectorAll(':scope > li > a');
        for (const anchor of childAnchors) {
            const name = anchor.textContent.trim();
            if (name) results.push({ name });
        }
        return results;
    });

    if (folders.length > 0) {
        console.log(`  Found ${folders.length} subfolders via DOM (selected node children)`);
        return folders;
    }

    // Method 3: Grid view - look for folder items in the right panel
    folders = await this.page.evaluate(() => {
        const results = [];
        const gridRows = document.querySelectorAll('.fileList tr, .file-list tr, [id*="fileList"] tr, .tbl_type tbody tr');
        for (const row of gridRows) {
            const nameCell = row.querySelector('td:nth-child(2), .fileName, [class*="name"]');
            const icon = row.querySelector('img[src*="folder"], .folder-icon, [class*="folder"]');
            if (nameCell && icon) {
                const name = nameCell.textContent.trim();
                if (name && name !== '.' && name !== '..') {
                    results.push({ name });
                }
            }
        }
        return results;
    });

    if (folders.length > 0) {
        console.log(`  Found ${folders.length} subfolders via grid view`);
        return folders;
    }

    console.log('  No subfolders found by any method.');
    
    // 디버그용 트루 구조 로그 출력
    const debugInfo = await this.page.evaluate(() => {
        const result = {
            selectedNode: 'none',
            allNodes: []
        };
        try {
            const $ = window.jQuery || window.$;
            if ($) {
                const treeEl = document.querySelector('.jstree');
                if (treeEl) {
                    const treeObj = $(treeEl).jstree(true);
                    if (treeObj) {
                        const selected = treeObj.get_selected();
                        result.selectedNode = selected.length > 0 ? treeObj.get_node(selected[0]).text : 'none';
                        
                        const allNodes = treeObj.get_json('#', { flat: true });
                        result.allNodes = allNodes.map(n => ({
                            id: n.id,
                            parent: n.parent,
                            text: (n.text || '').replace(/<[^>]*>/g, '').trim()
                        }));
                    }
                }
            }
        } catch(e) {
            result.error = e.message;
        }
        return result;
    });
    
    console.log('[ESM Debug] Tree structure:', JSON.stringify(debugInfo, null, 2));
    
    return folders;
  }

  /**
   * Upload an image to a specific folder path and return the hosted URL.
   */
  async uploadImage(filePath, folderPath = []) {
    console.log(`Uploading to ESM Image Hosting: ${filePath}`);
    console.log(`Target path: ${folderPath.join(' > ')}`);
    
    // Navigate to target folder
    await this._navigateToFolder(folderPath);
    await sleep(1000);

    // Click Upload Button
    console.log('Opening upload dialog...');
    const uploadBtn = this.page.locator('#fileUploadButton, button:has-text("업로드"), [id*="upload"]').first();
    await uploadBtn.click();
    await sleep(2000);
    
    // Handle File Chooser
    const [fileChooser] = await Promise.all([
      this.page.waitForEvent('filechooser'),
      this.page.click('#multiUploadButton, button:has-text("파일추가"), [id*="addFile"]')
    ]);
    await fileChooser.setFiles(filePath);
    await sleep(2000);

    // Check auto-close and Start Upload
    const autoClose = await this.page.$('text=전송 완료 시, 업로드 창 자동 닫기');
    if (autoClose) {
        await autoClose.click();
    }
    const startBtn = await this.page.$('text=전송시작');
    if (startBtn) {
        await startBtn.click();
        console.log('Clicked "전송시작" button.');
    }
    
    // Wait for upload to complete
    console.log('Waiting for upload to complete...');
    await sleep(8000);
    
    // Get the URL
    const fileName = filePath.split(/[\\/]/).pop();
    console.log(`Getting URL for: ${fileName}`);
    
    // Try to get the UserID to construct URL
    const userID = await this.page.evaluate(() => {
        const text = document.body.innerText;
        const match = text.match(/ai\.esmplus\.com\/([^/]+)\//);
        return match ? match[1] : 'yhshma'; // Default to yhshma if not found
    });

    if (userID) {
        let pathParts = [userID, ...folderPath, fileName];
        let directUrl = `https://ai.esmplus.com/${pathParts.map(p => encodeURIComponent(p)).join('/')}`;
        
        console.log(`Constructed URL: ${directUrl}`);
        return directUrl;
    }

    return null;
  }
}