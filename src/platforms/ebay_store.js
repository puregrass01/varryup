import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const SECRET_FIELDS = ['clientSecret', 'refreshToken'];
const CONFIG_FIELDS = ['environment', 'clientId', 'ruName', 'merchantLocationKey', 'fulfillmentPolicyId', 'paymentPolicyId', 'returnPolicyId'];

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}

export class EbayStore {
  constructor(directory, safeStorage) {
    this.configPath = path.join(directory, 'ebay_config.json');
    this.jobsPath = path.join(directory, 'ebay_jobs.json');
    this.listingsPath = path.join(directory, 'ebay_listings_cache.json');
    this.safeStorage = safeStorage;
  }
  read(file, fallback) { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback; }
  listingsCache() { return this.read(this.listingsPath, null); }
  saveListingsCache(data) { writeJson(this.listingsPath, data); return data; }
  clearListingsCache() { if (fs.existsSync(this.listingsPath)) { try { fs.unlinkSync(this.listingsPath); } catch (_) {} } }
  updateCachedListing(skuOrListingId, { price, stock }) {
    const cache = this.listingsCache();
    if (!cache?.items) return;
    let changed = false;
    for (const item of cache.items) {
      if (item.id === skuOrListingId || item.sku === skuOrListingId || item.listingId === skuOrListingId) {
        if (price !== undefined) item.price = String(price);
        if (stock !== undefined) item.stock = String(stock);
        changed = true;
      }
    }
    if (changed) writeJson(this.listingsPath, cache);
  }
  config() {
    const saved = this.read(this.configPath, { environment: 'sandbox' });
    const config = {};
    for (const field of CONFIG_FIELDS) config[field] = saved[field] || '';
    config.environment ||= 'sandbox';
    for (const field of SECRET_FIELDS) {
      config[field] = saved[`${field}Encrypted`] ? this.safeStorage.decryptString(Buffer.from(saved[`${field}Encrypted`], 'base64')) : '';
    }
    return config;
  }
  publicConfig() {
    const config = this.config();
    for (const field of SECRET_FIELDS) { config[`has${field[0].toUpperCase()}${field.slice(1)}`] = !!config[field]; delete config[field]; }
    return config;
  }
  save(input) {
    const config = this.config();
    const changedApp = (input.environment !== undefined && input.environment !== config.environment) || (input.clientId !== undefined && input.clientId.trim() !== config.clientId);
    if (changedApp) { config.clientSecret = ''; config.refreshToken = ''; this.clearListingsCache(); }
    for (const field of CONFIG_FIELDS) if (input[field] !== undefined) config[field] = String(input[field]).trim();
    for (const field of SECRET_FIELDS) if (input[field]?.trim()) config[field] = input[field].trim();
    if (input.disconnect === true) { config.refreshToken = ''; this.clearListingsCache(); }
    if (!['sandbox', 'production'].includes(config.environment)) throw new Error('잘못된 eBay 환경입니다.');
    if (SECRET_FIELDS.some(f => config[f]) && !this.safeStorage.isEncryptionAvailable()) throw new Error('Windows 암호화 저장소를 사용할 수 없습니다. 인증정보를 저장하지 않았습니다.');
    const saved = {};
    for (const field of CONFIG_FIELDS) saved[field] = config[field];
    for (const field of SECRET_FIELDS) if (config[field]) saved[`${field}Encrypted`] = this.safeStorage.encryptString(config[field]).toString('base64');
    writeJson(this.configPath, saved);
    return this.publicConfig();
  }
  jobKey(config, sku) {
    return createHash('sha256').update(JSON.stringify([config.environment, config.clientId, config.refreshToken, 'EBAY_US', sku])).digest('hex');
  }
  job(key, update) {
    const jobs = this.read(this.jobsPath, {});
    if (update) { jobs[key] = { ...jobs[key], ...update, updatedAt: new Date().toISOString() }; writeJson(this.jobsPath, jobs); }
    return jobs[key];
  }
}
