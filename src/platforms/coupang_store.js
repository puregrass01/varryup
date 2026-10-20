import fs from 'node:fs';
import path from 'node:path';

// src/platforms/amazon_store.js 와 같은 방식 — tmp 에 쓰고 rename 한다.
// 쓰는 중에 죽어도 잘린 캐시가 남지 않는다. 들여쓰기는 하지 않는다 — 아마존·eBay 캐시는 동기화 때 한 번
// 쓰지만 이 파일은 불러오는 동안 계속 쓰여서, 들여쓰면 크기(1.4MB → 0.9MB)와 쓰는 시간만 는다.
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(data), { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}

const clone = value => JSON.parse(JSON.stringify(value));

// 파일은 모아서 쓴다. 판매가 하나 알 때마다 통째로 쓰면(2026-10-01 실측: 상품 587개·옵션 6,444개 = 1.4MB,
// 1회 약 11ms) 전체 현재가 불러오기 한 번에 7천 번 가까이 써서 메인 프로세스가 40초 가까이 멈추고 디스크에
// 5GB 가 넘게 쓰였다. 값은 메모리에서 바로 바뀌고(읽는 쪽은 메모리를 본다), 파일은 조용해진 뒤 1초에, 계속
// 바뀌어도 5초마다 한 번 쓴다. 앱을 끌 때는 남은 것을 바로 쓴다(main_process before-quit → flush).
const FLUSH_IDLE_MS = 1000;
const FLUSH_MAX_MS = 5000;

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
    this.data = undefined;   // 한 번 읽으면 메모리에 둔다 — 가격 조회마다 파일을 다시 읽지 않는다
    this.dirty = false;      // 메모리에만 있고 아직 파일에 안 쓴 변경이 있다
    this.idleTimer = null;
    this.maxTimer = null;
  }

  read() {
    if (this.data !== undefined) return this.data;
    let data = null;
    try {
      if (fs.existsSync(this.pricesPath)) data = JSON.parse(fs.readFileSync(this.pricesPath, 'utf8'));
    } catch {
      data = null;   // 손상된 캐시는 없는 것으로 친다. 다음 저장이 덮어쓴다.
    }
    this.data = data && typeof data === 'object' && data.products && typeof data.products === 'object' ? data : null;
    return this.data;
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
    this.data = data;
    this.scheduleFlush();
    return true;
  }

  // 조용해지면 1초 뒤, 계속 바뀌어도 처음 바뀐 뒤 5초 안에는 쓴다. 타이머가 앱(테스트) 종료를 붙잡지 않게 unref.
  scheduleFlush() {
    this.dirty = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.flush(), FLUSH_IDLE_MS);
    this.idleTimer.unref?.();
    if (!this.maxTimer) {
      this.maxTimer = setTimeout(() => this.flush(), FLUSH_MAX_MS);
      this.maxTimer.unref?.();
    }
  }

  /** 아직 안 쓴 변경을 지금 파일에 쓴다. 쓸 것이 없으면 아무것도 하지 않는다. 실패하면 다음 변경 때 다시 쓴다. */
  flush() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.maxTimer) clearTimeout(this.maxTimer);
    this.idleTimer = this.maxTimer = null;
    if (!this.dirty || !this.data) return false;
    this.dirty = false;
    try {
      writeJson(this.pricesPath, this.data);
      return true;
    } catch (e) {
      this.dirty = true;
      console.warn('[쿠팡] 판매가 캐시 파일 저장 실패(다음 변경 때 다시 씀):', e.message);
      return false;
    }
  }

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
