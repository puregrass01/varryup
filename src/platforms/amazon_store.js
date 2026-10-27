import fs from 'node:fs';
import path from 'node:path';
import { JsonCache } from '../utils/json_file.js';

const CACHE_FILE = /^amazon_listings_cache_[A-Z0-9]+\.json$/;

/**
 * 아마존 리스팅 로컬 캐시. 마켓플레이스마다 파일 하나다.
 * 예전에는 한 파일(amazon_listings_cache.json)이라 일본을 동기화하면 미국 목록이 지워졌고,
 * 그 뒤 미국 목록은 API 페이징 상한(1000건)에서 잘렸다.
 *
 * 마켓마다 JsonCache 하나 — 한 번 읽으면 메모리에 두고, 상품 수정이 고친 행은 모아서 쓴다(json_file.js).
 * 파일 모양(들여쓰기 2)은 예전 그대로다.
 *
 * amazon_config.json 은 의도적으로 건드리지 않는다. 그 파일은 Amazon.saveConfig 와
 * main_process.mergeIntoConfig(관리 서버 동기화)가 각각 평문 JSON 으로 쓰고 있어서,
 * EbayStore 처럼 저장소가 설정 파일까지 소유하면 양쪽이 모두 깨진다.
 * (EbayStore 가 safeStorage 로 암호화하는 것도 같은 이유로 따라가지 않는다.)
 */
export class AmazonStore {
  constructor(directory) {
    this.directory = directory;
    this.caches = new Map();   // 파일 경로 → JsonCache
    // 예전 한 파일짜리 캐시는 그 안의 마켓 파일로 한 번 옮긴다.
    const legacy = path.join(directory, 'amazon_listings_cache.json');
    try {
      const target = this.listingsPath(JSON.parse(fs.readFileSync(legacy, 'utf8')).marketplaceId);
      if (!fs.existsSync(target)) fs.renameSync(legacy, target);
    } catch { /* 없거나 손상됨 — 다음 동기화가 새로 만든다 */ }
  }

  listingsPath(marketplaceId) {
    const mp = String(marketplaceId ?? '');
    if (!/^[A-Z0-9]{8,20}$/.test(mp)) throw new Error(`마켓플레이스 ID가 올바르지 않습니다: ${mp || '(없음)'}`);
    return path.join(this.directory, `amazon_listings_cache_${mp}.json`);
  }

  cache(marketplaceId) {
    const file = this.listingsPath(marketplaceId);
    if (!this.caches.has(file)) this.caches.set(file, new JsonCache(file, { indent: 2, label: '아마존 목록' }));
    return this.caches.get(file);
  }

  listingsCache(marketplaceId) {
    try {
      return this.cache(marketplaceId).read();
    } catch {
      return null; // 없거나 손상된 캐시(잘못된 마켓 ID 포함)는 없는 것으로 친다. 다음 새로고침이 덮어쓴다.
    }
  }

  // 전체 동기화 결과는 바로 쓴다 — 수 분 걸려 받은 목록을 타이머에 맡기지 않는다.
  saveListingsCache(data) {
    this.cache(data?.marketplaceId).save(data);
    return data;
  }

  /** 계정이 바뀌면 모든 마켓의 캐시를 지운다 — 읽어 둔 것(메모리·남은 쓰기)과 아직 안 읽은 파일 모두. */
  clearListingsCache() {
    for (const cache of this.caches.values()) cache.clear();
    let names = [];
    try { names = fs.readdirSync(this.directory); } catch { return; }
    for (const name of names) {
      if (CACHE_FILE.test(name)) { try { fs.unlinkSync(path.join(this.directory, name)); } catch (_) {} }
    }
  }

  /** 아직 안 쓴 변경을 지금 쓴다(앱을 끌 때). */
  flush() {
    for (const cache of this.caches.values()) cache.flush();
  }

  /**
   * 상품 수정 후 캐시 행을 제자리에서 고친다. 전체 새로고침 없이 목록이 최신값을 보여주도록.
   * 파일은 모아서 쓴다 — refreshListings 는 SKU 마다 부르고, 예전처럼 매번 통째로 쓰면 1.9MB × SKU 수다.
   */
  updateCachedListing(sku, fields = {}, marketplaceId) {
    const cache = this.listingsCache(marketplaceId);
    if (!cache?.items) return;
    let changed = false;
    for (const item of cache.items) {
      if (item.id !== sku) continue;
      for (const key of ['name', 'price', 'stock', 'description', 'brand', 'asin']) {
        if (fields[key] === undefined) continue;
        const value = String(fields[key] ?? '');
        if (item[key] !== value) { item[key] = value; changed = true; }
      }
    }
    if (changed) this.cache(marketplaceId).set(cache);
  }
}
