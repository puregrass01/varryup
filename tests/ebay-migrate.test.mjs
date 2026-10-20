import test from 'node:test';
import assert from 'node:assert/strict';
import { EbayAPI } from '../src/platforms/ebay_api.js';
import { Ebay } from '../src/platforms/ebay.js';

test('EbayAPI.getActiveListings parses XML response correctly', async () => {
  const sampleXml = `<?xml version='1.0' encoding='UTF-8'?>
<GetMyeBaySellingResponse xmlns="urn:ebay:apis:eBLBaseComponents">
  <Ack>Success</Ack>
  <ActiveList>
    <PaginationResult>
      <TotalNumberOfEntries>2</TotalNumberOfEntries>
      <TotalNumberOfPages>1</TotalNumberOfPages>
    </PaginationResult>
    <ItemArray>
      <Item>
        <ItemID>110552306915</ItemID>
        <Title>Test BMW Mirror Glass</Title>
        <SKU>BMW-MIR-01</SKU>
        <CurrentPrice currencyID="USD">49.99</CurrentPrice>
        <Quantity>5</Quantity>
        <ListingDetails>
          <ViewItemURL>https://www.ebay.com/itm/110552306915</ViewItemURL>
        </ListingDetails>
      </Item>
      <Item>
        <ItemID>110552306916</ItemID>
        <Title>Test Audi Mirror Glass</Title>
        <SKU>AUD-MIR-02</SKU>
        <CurrentPrice currencyID="USD">59.99</CurrentPrice>
        <Quantity>3</Quantity>
      </Item>
    </ItemArray>
  </ActiveList>
</GetMyeBaySellingResponse>`;

  const api = new EbayAPI({ environment: 'sandbox', clientId: 'app', clientSecret: 'sec', refreshToken: 'ref' }, {
    fetchImpl: async (url, options) => {
      if (url.endsWith('/token')) return { ok: true, text: async () => JSON.stringify({ access_token: 'fake-tok', expires_in: 7200 }) };
      if (url.includes('api.dll')) {
        assert.equal(options.headers['X-EBAY-API-CALL-NAME'], 'GetMyeBaySelling');
        assert.equal(options.headers['X-EBAY-API-IAF-TOKEN'], 'fake-tok');
        return { ok: true, text: async () => sampleXml };
      }
      throw new Error(`Unexpected url: ${url}`);
    }
  });

  const res = await api.getActiveListings(1, 100);
  assert.equal(res.total, 2);
  assert.equal(res.totalPages, 1);
  assert.equal(res.items.length, 2);
  assert.equal(res.items[0].itemID, '110552306915');
  assert.equal(res.items[0].sku, 'BMW-MIR-01');
  assert.equal(res.items[0].price, '49.99');
  assert.equal(res.items[0].quantity, '5');
  assert.equal(res.items[0].url, 'https://www.ebay.com/itm/110552306915');
  assert.equal(res.items[1].itemID, '110552306916');
  assert.equal(res.items[1].sku, 'AUD-MIR-02');
});

test('EbayAPI.bulkMigrateListing chunks up to 5 items and returns responses', async () => {
  let requestedBody = null;
  const api = new EbayAPI({ environment: 'sandbox', clientId: 'app', clientSecret: 'sec', refreshToken: 'ref' }, {
    fetchImpl: async (url, options) => {
      if (url.endsWith('/token')) return { ok: true, text: async () => JSON.stringify({ access_token: 'fake-tok', expires_in: 7200 }) };
      if (url.includes('/bulk_migrate_listing')) {
        requestedBody = JSON.parse(options.body);
        return {
          ok: true,
          text: async () => JSON.stringify({
            responses: requestedBody.requests.map(r => ({
              statusCode: 200,
              listingId: r.listingId,
              inventoryItemId: `SKU-${r.listingId}`,
              offerId: `OFFER-${r.listingId}`,
              errors: []
            }))
          })
        };
      }
      throw new Error(`Unexpected url: ${url}`);
    }
  });

  const res = await api.bulkMigrateListing(['1001', '1002']);
  assert.equal(res.responses.length, 2);
  assert.equal(res.responses[0].inventoryItemId, 'SKU-1001');

  await assert.rejects(api.bulkMigrateListing(['1', '2', '3', '4', '5', '6']), /최대 5개/);
});

test('Ebay.migrateListings batches multiple items and invokes onProgress', async () => {
  const listingIds = ['1', '2', '3', '4', '5', '6', '7'];
  const chunksReceived = [];
  const fakeApi = {
    async bulkMigrateListing(chunk) {
      chunksReceived.push(chunk);
      return {
        responses: chunk.map(id => ({
          statusCode: 200,
          listingId: id,
          inventoryItemId: `SKU-${id}`,
          offerId: `OFF-${id}`
        }))
      };
    }
  };

  const ebay = new Ebay({ config: () => ({ environment: 'sandbox' }) }, () => fakeApi);
  const progressCalls = [];
  const result = await ebay.migrateListings(listingIds, p => progressCalls.push(p));

  assert.equal(chunksReceived.length, 2);
  assert.deepEqual(chunksReceived[0], ['1', '2', '3', '4', '5']);
  assert.deepEqual(chunksReceived[1], ['6', '7']);
  assert.equal(result.successful.length, 7);
  assert.equal(result.failed.length, 0);
  assert.ok(progressCalls.length >= 2);
});

test('EbayStore handles listings cache save, read, update, and clear', async () => {
  const os = await import('node:os');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { EbayStore } = await import('../src/platforms/ebay_store.js');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ebay-store-test-'));
  try {
    const store = new EbayStore(tmpDir, { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s), decryptString: b => b.toString() });
    assert.equal(store.listingsCache(), null);

    const data = {
      environment: 'sandbox',
      total: 2,
      updatedAt: new Date().toISOString(),
      items: [
        { id: 'SKU-1', sku: 'SKU-1', listingId: '111', name: 'Item 1', price: '10.00', stock: '5' },
        { id: 'SKU-2', sku: 'SKU-2', listingId: '222', name: 'Item 2', price: '20.00', stock: '2' }
      ]
    };
    store.saveListingsCache(data);

    const cached = store.listingsCache();
    assert.equal(cached.total, 2);
    assert.equal(cached.items.length, 2);

    store.updateCachedListing('SKU-1', { price: '15.50', stock: 8 });
    const updated = store.listingsCache();
    assert.equal(updated.items[0].price, '15.50');
    assert.equal(updated.items[0].stock, '8');

    store.clearListingsCache();
    assert.equal(store.listingsCache(), null);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// 배포 모델이 여기에 걸려 있다. 관리 서버에는 eBay refreshToken 을 등록하지 않고,
// 각 PC 가 '판매자 연결' 로 자기 토큰을 만든다(eBay 는 기존 토큰을 무효화하지 않는다).
// 그런데 로그인할 때마다 applyEbayCredentials → save() 가 돌기 때문에,
// 그 자리에서 토큰이 지워지면 직원이 매번 다시 연결해야 한다.
test('서버 동기화가 반복돼도 그 PC 가 만든 refreshToken 은 남는다', async () => {
  const os = await import('node:os');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { EbayStore } = await import('../src/platforms/ebay_store.js');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ebay-store-sync-'));
  try {
    const store = new EbayStore(tmpDir, {
      isEncryptionAvailable: () => true,
      encryptString: v => Buffer.from(v),
      decryptString: b => b.toString()
    });

    // 서버가 내려주는 집합. refreshToken 은 일부러 넣지 않는다.
    const fromServer = {
      environment: 'production',
      clientId: 'opticgla-r-PRD-xxxx',
      ruName: 'optic_glass-opticgla-r-PRD--gkpde',
      merchantLocationKey: 'LOC-1',
      fulfillmentPolicyId: '1', paymentPolicyId: '2', returnPolicyId: '3',
      clientSecret: 'PRD-secret'
    };

    // 1) 새 PC 첫 로그인
    store.save(fromServer);
    assert.equal(store.publicConfig().hasRefreshToken, false, '서버는 토큰을 주지 않는다');
    assert.equal(store.config().clientSecret, 'PRD-secret', 'clientSecret 은 내려받는다');

    // 2) 직원이 '판매자 연결' 로 그 PC 토큰을 만든다
    store.save({ refreshToken: 'v^1.1#PC-A-token' });
    assert.equal(store.config().refreshToken, 'v^1.1#PC-A-token');

    // 3) 이후 로그인마다 같은 동기화가 반복된다 — 토큰이 살아남아야 한다
    for (let i = 0; i < 3; i++) store.save(fromServer);
    assert.equal(store.config().refreshToken, 'v^1.1#PC-A-token',
      '같은 앱 설정으로 재동기화하면 PC 토큰을 지우면 안 된다');
    assert.equal(store.publicConfig().hasRefreshToken, true);

    // 4) 반대로 앱 자체가 바뀌면(환경·clientId) 옛 토큰은 무효다 — 이건 지워야 맞다
    store.save({ ...fromServer, environment: 'sandbox' });
    assert.equal(store.config().refreshToken, '',
      '환경이 바뀌면 이전 토큰은 쓸 수 없으므로 지운다');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Ebay.refreshActiveListingsCache fetches pages and writes to cache', async () => {
  let savedCache = null;
  const mockStore = {
    config: () => ({ environment: 'production' }),
    saveListingsCache: data => { savedCache = data; },
    listingsCache: () => savedCache
  };

  const mockApi = {
    async getActiveListings(page, limit) {
      if (page === 1) {
        return {
          total: 3,
          totalPages: 2,
          items: [
            { itemID: '101', title: 'Product 1', sku: 'P1', price: '25.00', quantity: '4', url: 'https://ebay.com/101' },
            { itemID: '102', title: 'Product 2', sku: 'P2', price: '30.00', quantity: '2', url: 'https://ebay.com/102' }
          ]
        };
      }
      return {
        total: 3,
        totalPages: 2,
        items: [
          { itemID: '103', title: 'Product 3', sku: '', price: '45.00', quantity: '1', url: 'https://ebay.com/103' }
        ]
      };
    }
  };

  const ebay = new Ebay(mockStore, () => mockApi);
  const progressCalls = [];
  const res = await ebay.refreshActiveListingsCache(p => progressCalls.push(p));

  assert.equal(res.total, 3);
  assert.equal(res.count, 3);
  assert.equal(savedCache.items.length, 3);
  assert.equal(savedCache.items[0].sku, 'P1');
  assert.equal(savedCache.items[2].id, '103'); // SKU 없으면 listingId가 id로 매핑
  assert.equal(progressCalls.length, 2);
});

test('Ebay.searchProducts searches from cache and filters accurately', async () => {
  const cachedData = {
    environment: 'production',
    total: 3,
    updatedAt: new Date().toISOString(),
    items: [
      { id: 'BMW-01', sku: 'BMW-01', listingId: '1001', name: 'BMW Side Mirror', price: '50.00', stock: '3', status: 'Active' },
      { id: 'AUD-02', sku: 'AUD-02', listingId: '1002', name: 'Audi Side Mirror Glass', price: '60.00', stock: '2', status: 'Active' },
      { id: 'HYU-03', sku: 'HYU-03', listingId: '1003', name: 'Hyundai Rear View', price: '40.00', stock: '5', status: 'Active' }
    ]
  };

  const mockStore = {
    config: () => ({ environment: 'production' }),
    listingsCache: () => cachedData
  };

  const ebay = new Ebay(mockStore, () => ({}));

  // 1. 전체 검색 (빈 검색어)
  const all = await ebay.searchProducts({});
  assert.equal(all.length, 3);

  // 2. 검색어 필터링
  const stats = {};
  const bmw = await ebay.searchProducts({ searchText: 'bmw' }, stats);
  assert.equal(bmw.length, 1);
  assert.equal(bmw[0].id, 'BMW-01');
  assert.equal(stats.matched, 1);
  assert.equal(stats.scanned, 3);

  // 3. 일치 항목 없음
  const noneStats = {};
  const none = await ebay.searchProducts({ searchText: 'kia' }, noneStats);
  assert.equal(none.length, 0);
  assert.match(noneStats.reason, /kia/);
});

test('Ebay.load performs JIT on-demand migration for cached item not yet in Inventory API', async () => {
  const cachedData = {
    environment: 'production',
    total: 1,
    updatedAt: new Date().toISOString(),
    items: [
      { id: 'OG-MIG-1', sku: 'OG-MIG-1', listingId: '998877665544', name: 'OpticGlass Mirror', price: '49.99', stock: '10', status: 'Active' }
    ]
  };

  let migratedIds = [];
  let isMigrated = false;

  const mockApi = {
    async inventory(sku) {
      if (!isMigrated) return null; // 아직 Inventory API에 없음
      return { sku, product: { title: 'OpticGlass Mirror' }, availability: { shipToLocationAvailability: { quantity: 10 } } };
    },
    async offers(sku) {
      if (!isMigrated) return [];
      return [{ offerId: 'off-99', status: 'PUBLISHED', availableQuantity: 10, pricingSummary: { price: { value: '49.99', currency: 'USD' } } }];
    },
    async bulkMigrateListing(chunk) {
      migratedIds.push(...chunk);
      isMigrated = true;
      return {
        responses: chunk.map(id => ({
          statusCode: 200,
          listingId: id,
          inventoryItemId: 'OG-MIG-1',
          offerId: 'off-99'
        }))
      };
    }
  };

  const mockStore = {
    config: () => ({ environment: 'production' }),
    listingsCache: () => cachedData
  };

  const ebay = new Ebay(mockStore, () => mockApi);

  const loaded = await ebay.load('OG-MIG-1');
  assert.equal(loaded.sku, 'OG-MIG-1');
  assert.equal(loaded.offer.offerId, 'off-99');
  assert.deepEqual(migratedIds, ['998877665544']); // 해당 상품의 Listing ID로 1건만 이관 호출됨!
});

