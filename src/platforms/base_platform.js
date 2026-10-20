export class BasePlatform {
  /**
   * @param {import('playwright').Browser|(() => import('playwright').Browser)} browserOrGetter
   *   브라우저 객체, 또는 **지금 살아 있는 브라우저를 돌려주는 함수**. 함수를 권한다.
   * @param {string|null} sessionPath  storageState 파일 경로
   */
  constructor(browserOrGetter, sessionPath) {
    this._browserSource = browserOrGetter;
    this.sessionPath = sessionPath;
    this.context = null;
    this.page = null;
  }

  // ── 브라우저는 '값'이 아니라 '가져오는 법'으로 들고 있는다 ──────────
  // main_process 는 창이 전부 닫히면 browser 를 close() 하고 null 로 바꾼다.
  // 인스턴스가 옛 Browser 객체를 필드로 붙들고 있으면 다음 작업이 'Target closed' 로
  // 죽는데, 그래서 예전에는 호출부마다 `instance.browser = browser` 를 손으로 다시
  // 꽂아 줬다(8군데). 한 군데만 빠뜨려도 조용히 죽는 구조였다.
  // 이제 게터가 매번 현재 값을 읽으므로 그 수동 패치가 필요 없다.
  get browser() {
    return typeof this._browserSource === 'function'
      ? this._browserSource()
      : this._browserSource;
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

    // 브라우저가 아직(또는 이미) 없는 상태. 예전에는 여기서
    // "Cannot read properties of null (reading 'contexts')" 가 떠서 원인을 짚기 어려웠다.
    const browser = this.browser;
    if (!browser) {
      throw new Error(
        `[${this.platformName}] 브라우저가 실행 중이 아닙니다. ` +
        `작업을 시작하기 전에 getBrowser() 로 브라우저를 먼저 띄워야 합니다.`
      );
    }

    // 플랫폼명이 일치하는 기존 컨텍스트가 있으면 재사용하여 창 중복 개설 방지
    // ⚠ Playwright 내부에 이미 `_platform` 필드가 있어(zones 보유) 그 이름을 쓰면 덮어써져
    //    newPage() 등에서 "reading 'current'" 크래시가 난다. 충돌 없는 키를 쓴다.
    // 연결이 끊긴 브라우저(사용자가 자동화 창을 직접 닫은 경우)를 여기서 잡아낸다.
    // 안 잡으면 아래 newContext/goto 가 "Target page, context or browser has been closed"
    // 로 죽는데, 그 메시지만으로는 원인이 사용자 행동이라는 걸 알 수 없다.
    if (browser.isConnected && !browser.isConnected()) {
      throw new Error(
        `[${this.platformName}] 브라우저 연결이 끊어졌습니다. ` +
        `자동화 창을 직접 닫으셨다면 작업을 다시 실행해 주세요(새 창이 열립니다).`
      );
    }

    const existingContexts = browser.contexts();
    const match = existingContexts.find(c => c._customPlatformName === this.platformName);
    if (match) {
      // 컨텍스트는 살아 있는데 **탭만** 닫힌 경우가 있다. 닫힌 page 를 재사용하면
      // 바로 다음 goto 에서 죽으므로, 살아 있는 탭만 고르고 없으면 새로 연다.
      try {
        this.context = match;
        const pages = this.context.pages().filter(p => !(p.isClosed && p.isClosed()));
        this.page = pages.length > 0 ? pages[0] : await this.context.newPage();
        return;
      } catch (e) {
        // 컨텍스트가 닫히는 중이었다면 재사용을 포기하고 아래에서 새로 만든다.
        console.log(`[${this.platformName}] 기존 창을 재사용할 수 없어 새로 엽니다:`, e.message);
        this.context = null;
        this.page = null;
      }
    }

    if (useSession && this.sessionPath) {
      try {
        this.context = await browser.newContext({ storageState: this.sessionPath, ...contextOptions });
      } catch (e) {
        console.log('Session not found or invalid, starting new context');
        this.context = await browser.newContext(contextOptions);
      }
    } else {
      this.context = await browser.newContext(contextOptions);
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
