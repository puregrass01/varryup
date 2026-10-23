import path from 'node:path';
import { JsonCache } from '../utils/json_file.js';

const clone = value => JSON.parse(JSON.stringify(value));

/**
 * 쿠팡 옵션 판매가 로컬 캐시 — 상품 일괄 수정 목록에 '마지막으로 읽은 판매가' 를 보여 준다.
 *
 * 아마존·eBay 는 목록 동기화 한 번으로 판매가까지 캐시에 받아 둔다(amazon_store.js · ebay_store.js).
 * 쿠팡은 그럴 길이 없다 — 상품 목록 API(상품 목록 페이징 조회)는 옵션ID(vendorItemId)·판매가를 주지 않고
 * (공식 문서), 판매가는 옵션마다 가격 조회 API 로만 읽힌다. 그래서 상품 조회·가격 조회·가격 변경이 지나갈 때
 * 알게 된 값을 상품마다 모아 둔다(coupang.js 가 채운다).
 *
 * 화면에 보이기만 하는 값이다. 판매가를 고칠 때는 지금처럼 현재가를 다시 읽고 그 값과 비교해 저장한다.
 * 판매자(vendorId)가 바뀌면 이전 판매자의 캐시는 없는 것으로 친다 — 직원 PC 에서 계정이 바뀔 수 있다.
 *
 * 모양: { vendorId, updatedAt, products: { [등록상품ID]: { name, statusName, savedAt,
 *         options: [{ optionId, itemName, readonly, price, checkedAt }] } } }
 * optionId 는 옵션ID(vendorItemId)다. 승인 전 옵션은 옵션ID 가 없어 'item-{sellerProductItemId}' 로 둔다
 * (bulk_price_ipc 의 현재가 행과 같은 열쇠).
 */
export class CoupangStore {
  constructor(directory) {
    this.pricesPath = path.join(directory, 'coupang_prices_cache.json');
    // 한 번 읽으면 메모리에 두고(가격 조회마다 파일을 다시 읽지 않는다) 파일은 모아서 쓴다(json_file.js).
    // 들여쓰지 않는다 — 불러오는 동안 계속 쓰이는 파일이라 들여쓰면 크기(1.4MB → 0.9MB)와 쓰는 시간만 는다.
    this.cache = new JsonCache(this.pricesPath, { indent: 0, label: '쿠팡 판매가' });
  }

  read() {
    let data = null;
    try { data = this.cache.read(); } catch { /* 손상된 캐시는 없는 것으로 친다. 다음 저장이 덮어쓴다. */ }
    if (data && typeof data === 'object' && data.products && typeof data.products === 'object') return data;
    this.cache.data = null;   // 깨졌거나 모양이 틀린 것도 '없음' 으로 기억한다 — 부를 때마다 다시 읽지 않는다
    return null;
  }

  /** 이 판매자의 상품별 캐시(복사본). 다른 판매자 것이거나 없으면 빈 객체. */
  products(vendorId) {
    const data = this.read();
    return data && data.vendorId === String(vendorId) ? clone(data.products) : {};
  }

  write(vendorId, mutate) {
    const current = this.read();
    const data = current && current.vendorId === String(vendorId) ? current : { vendorId: String(vendorId), products: {} };
    if (mutate(data.products, new Date().toISOString()) === false) return false;
    data.updatedAt = new Date().toISOString();
    this.cache.set(data);
    return true;
  }

  /** 아직 안 쓴 변경을 지금 파일에 쓴다(앱을 끌 때). 쓸 것이 없으면 false. 실패하면 다음 변경 때 다시 쓴다. */
  flush() { return this.cache.flush(); }

  /**
   * 상품 조회로 알게 된 옵션 구성. 같은 옵션ID 에 모아 둔 판매가는 이어 간다 — 상품 조회 응답의 판매가는
   * 가격 변경 API 로 바꾼 값을 바로 보여 주는지 확인되지 않아 믿지 않는다. 승인 전 옵션(readonly)만은
   * 가격 조회 API 가 없어 상품 조회의 판매가가 유일한 값이라 그것을 쓴다. 사라진 옵션은 뺀다.
   */
  saveProduct(vendorId, productId, { name = '', statusName = '', options = [] } = {}) {
    return this.write(vendorId, (products, now) => {
      const id = String(productId);
      const before = new Map((products[id]?.options || []).map(o => [o.optionId, o]));
      products[id] = {
        name: String(name), statusName: String(statusName), savedAt: now,
        options: options.map(o => {
          const optionId = String(o.optionId), kept = before.get(optionId);
          const readonly = !!o.readonly;
          return {
            optionId, itemName: String(o.itemName ?? ''), readonly,
            price: readonly ? String(o.salePrice ?? '') : (kept?.price ?? ''),
            checkedAt: readonly ? now : (kept?.checkedAt ?? ''),
          };
        }),
      };
    });
  }

  /** 옵션 하나의 판매가(가격 조회·가격 변경 API 의 값). 그 옵션이 든 상품을 아직 모르면 버린다. */
  updatePrice(vendorId, optionId, price) {
    const id = String(optionId ?? '');
    if (!id) return false;
    return this.write(vendorId, (products, now) => {
      let hit = false;
      for (const product of Object.values(products)) {
        for (const option of product.options || []) {
          if (option.optionId === id) { option.price = String(price); option.checkedAt = now; hit = true; }
        }
      }
      return hit;
    });
  }

  /** 쿠팡 목록에 없는 상품(삭제됨)을 캐시에서 뺀다. 뺄 것이 없으면 파일을 쓰지 않는다. */
  keepOnly(vendorId, productIds) {
    const live = new Set([...productIds].map(String));
    return this.write(vendorId, products => {
      const gone = Object.keys(products).filter(id => !live.has(id));
      gone.forEach(id => { delete products[id]; });
      return gone.length > 0;
    });
  }
}
