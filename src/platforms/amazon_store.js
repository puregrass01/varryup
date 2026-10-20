import fs from 'node:fs';
import path from 'node:path';

// src/platforms/ebay_store.js writeJson 과 같은 방식 — tmp 에 쓰고 rename 한다.
// 쓰는 중에 죽어도 잘린 캐시가 남지 않는다.
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}

const CACHE_FILE = /^amazon_listings_cache_[A-Z0-9]+\.json$/;

/**
 * 아마존 리스팅 로컬 캐시. 마켓플레이스마다 파일 하나다.
 * 예전에는 한 파일(amazon_listings_cache.json)이라 일본을 동기화하면 미국 목록이 지워졌고,
 * 그 뒤 미국 목록은 API 페이징 상한(1000건)에서 잘렸다.
 *
 * amazon_config.json 은 의도적으로 건드리지 않는다. 그 파일은 Amazon.saveConfig 와
 * main_process.mergeIntoConfig(관리 서버 동기화)가 각각 평문 JSON 으로 쓰고 있어서,
 * EbayStore 처럼 저장소가 설정 파일까지 소유하면 양쪽이 모두 깨진다.
 * (EbayStore 가 safeStorage 로 암호화하는 것도 같은 이유로 따라가지 않는다.)
 */
export class AmazonStore {
  constructor(directory) {
    this.directory = directory;
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

  listingsCache(marketplaceId) {
    try {
      return JSON.parse(fs.readFileSync(this.listingsPath(marketplaceId), 'utf8'));
    } catch {
      return null; // 없거나 손상된 캐시(잘못된 마켓 ID 포함)는 없는 것으로 친다. 다음 새로고침이 덮어쓴다.
    }
  }

  saveListingsCache(data) {
    writeJson(this.listingsPath(data?.marketplaceId), data);
    return data;
  }

  /** 계정이 바뀌면 모든 마켓의 캐시를 지운다. */
  clearListingsCache() {
    let names = [];
    try { names = fs.readdirSync(this.directory); } catch { return; }
    for (const name of names) {
      if (CACHE_FILE.test(name)) { try { fs.unlinkSync(path.join(this.directory, name)); } catch (_) {} }
    }
  }

  /** 상품 수정 후 캐시 행을 제자리에서 고친다. 전체 새로고침 없이 목록이 최신값을 보여주도록. */
  updateCachedListing(sku, fields = {}, marketplaceId) {
    const cache = this.listingsCache(marketplaceId);
    if (!cache?.items) return;
    let changed = false;
    for (const item of cache.items) {
      if (item.id !== sku) continue;
      for (const key of ['name', 'price', 'stock', 'description', 'brand', 'asin']) {
        if (fields[key] !== undefined) { item[key] = String(fields[key] ?? ''); changed = true; }
      }
    }
    if (changed) writeJson(this.listingsPath(marketplaceId), cache);
  }
}
