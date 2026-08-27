export class BasePlatform {
  constructor(browser, sessionPath) {
    this.browser = browser;
    this.sessionPath = sessionPath;
    this.context = null;
    this.page = null;
  }

  get platformName() {
    const name = this.constructor.name.toLowerCase();
    if (name.includes('imweb')) return 'imweb';
    if (name.includes('naver') || name.includes('smartstore')) return 'naver';
    if (name.includes('esm')) return 'esm';
    return name;
  }

  async init(useSession = true, viewport = null) {
    const contextOptions = viewport ? { viewport } : {};
    
    // 플랫폼명이 일치하는 기존 컨텍스트가 있으면 재사용하여 창 중복 개설 방지
    // ⚠ Playwright 내부에 이미 `_platform` 필드가 있어(zones 보유) 그 이름을 쓰면 덮어써져
    //    newPage() 등에서 "reading 'current'" 크래시가 난다. 충돌 없는 키를 쓴다.
    const existingContexts = this.browser.contexts();
    const match = existingContexts.find(c => c._customPlatformName === this.platformName);
    if (match) {
      this.context = match;
      const pages = this.context.pages();
      this.page = pages.length > 0 ? pages[0] : await this.context.newPage();
      return;
    }

    if (useSession && this.sessionPath) {
      try {
        this.context = await this.browser.newContext({ storageState: this.sessionPath, ...contextOptions });
      } catch (e) {
        console.log('Session not found or invalid, starting new context');
        this.context = await this.browser.newContext(contextOptions);
      }
    } else {
      this.context = await this.browser.newContext(contextOptions);
    }
    this.context._customPlatformName = this.platformName;
    this.page = await this.context.newPage();
  }

  async saveSession() {
    if (this.context && this.sessionPath) {
      await this.context.storageState({ path: this.sessionPath });
      console.log(`Session saved to ${this.sessionPath}`);
    }
  }

  async close() {
    if (this.context) await this.context.close();
  }
}
