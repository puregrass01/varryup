import path from 'node:path';
import { CurrencyRatesClient } from './utils/currency_rates.js';

// Register synchronously before opening windows. Delay client setup until invocation
// so a cache/path initialization failure returns a response, never a missing handler.
export function registerCurrencyRatesIPC({ app, ipcMain, baseUrl, getToken,
  createClient = options => new CurrencyRatesClient(options) }) {
  let client;
  const get = async () => {
    try {
      client ||= createClient({
        cachePath: path.join(app.getPath('userData'), 'currency_rates.json'), baseUrl, getToken,
      });
      return await client.get();
    } catch {
      return { success: false, error: '환율을 불러오지 못했습니다.' };
    }
  };
  ipcMain.handle('currency-rates-get', get);
  return { get };
}
