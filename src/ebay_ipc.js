import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Ebay } from './platforms/ebay.js';
import { EbayStore } from './platforms/ebay_store.js';

export function registerEbayIPC({ app, ipcMain, safeStorage, shell, uiDirectory, getRuntimeProxy = () => null, getEbayService = null }) {
  let service;
  // Ebay#busy(동시 실행 잠금)는 인스턴스마다 따로 걸린다. 여기서 따로 인스턴스를 만들면
  // 같은 ebay_config.json·ebay_jobs.json 을 두 인스턴스가 나눠 쥐게 되어, 발행 중에 들어온
  // 재로그인(applyEbayCredentials → saveConfig)이 잠금을 못 보고 설정을 덮어쓴다.
  // jobKey 가 environment·clientId·refreshToken 해시라서, 그러면 진행 중 작업의 저널 항목이
  // 미아가 되고 "create 타임아웃은 저널에 남겨 자동 재시도하지 않는다" 보호가 무력화된다.
  // → 앱에서는 main_process 의 싱글턴을 주입받아 하나만 쓴다(주입이 없으면 예전처럼 자체 생성).
  const getService = () => {
    const current = getEbayService ? getEbayService() : (service ||= new Ebay(new EbayStore(app.getPath('userData'), safeStorage)));
    // 프록시 토큰은 직원 로그인마다 바뀌므로 호출할 때마다 최신값을 다시 붙인다.
    current.runtimeProxy = getRuntimeProxy();
    return current;
  };
  // Existing iframe falls back to the parent's ipcRenderer on Electron versions
  // without require in subframes, so either of these local frames can send.
  // ⚠ 'index.html' 을 이 목록에서 빼지 마라. main_process 가 loadFile 로 열지 않아서
  //   죽은 화면처럼 보이지만, index_up.html:675 가 **iframe 으로 이 파일을 불러** 등록 폼으로 쓴다
  //   (src 를 JS 로 넣기 때문에 정적 검색에 걸리지 않는다). 빼면 그 iframe 에서 오는 eBay 요청이
  //   전부 "허용되지 않은 eBay 요청입니다" 로 막힌다.
  const trustedUrls = new Set(['index.html', 'index_up.html'].map(file => pathToFileURL(path.join(uiDirectory, file)).href));
  const handle = (channel, work) => ipcMain.handle(channel, async (event, data) => {
    try {
      if (!trustedUrls.has(event.senderFrame?.url?.split(/[?#]/)[0])) throw new Error('허용되지 않은 eBay 요청입니다.');
      return { success: true, data: await work(getService(), data, event) };
    } catch (error) {
      // 중복 등록 예외(ebay.js saveDraft/publish)는 다른 채널처럼 duplicate·existing 을 함께 싣는다.
      return { success: false, error: error.message || 'eBay 요청에 실패했습니다.', ...(error.duplicate === true ? { duplicate: true, existing: error.existing } : {}) };
    }
  });
  handle('ebay-load-config', s => s.store.publicConfig());
  handle('ebay-save-config', (s, input) => s.saveConfig(input));
  handle('ebay-connect', async s => { await shell.openExternal(s.authorizationUrl()); return { opened: true }; });
  handle('ebay-complete-auth', (s, input) => s.completeAuthorization(input));
  handle('ebay-settings', s => s.settings());
  handle('ebay-create-location', (s, input) => s.createLocation(input));
  handle('ebay-categories', (s, query) => s.categories(query));
  handle('ebay-aspects', (s, id) => s.client().api.aspects(id));
  handle('ebay-preview', (s, input) => s.preview(input));
  handle('ebay-save-draft', (s, input) => s.saveDraft(input));
  handle('ebay-publish', (s, sku) => s.publish(sku));
  handle('ebay-load-product', (s, sku) => s.load(sku));
  // 배열이 아니라 {items, stats} 를 돌려준다. 0건일 때 stats.reason 이 이유를 담는다.
  handle('ebay-search-products', async (s, query) => {
    const stats = {};
    return { items: await s.searchProducts(query, stats), stats };
  });
  handle('ebay-active-summary', s => s.getActiveListingsSummary());
  handle('ebay-cache-summary', s => s.getCachedListingsSummary());
  handle('ebay-refresh-cache', async (s, _, event) => {
    return s.refreshActiveListingsCache(p => event.senderFrame?.send('ebay-cache-progress', p));
  });
  handle('ebay-migrate-all', async (s, _, event) => {
    const listings = await s.getAllActiveListings(p => event.senderFrame?.send('ebay-migrate-progress', { stage: 'fetch', ...p }));
    const ids = listings.map(it => it.itemID).filter(Boolean);
    return s.migrateListings(ids, p => event.senderFrame?.send('ebay-migrate-progress', { stage: 'migrate', ...p }));
  });
  handle('ebay-update', (s, input) => s.updatePriceQuantity(input));
  handle('ebay-update-images', (s, input) => s.updateImages(input));
  handle('ebay-withdraw', (s, sku) => s.withdraw(sku));
}
