import test from 'node:test';
import assert from 'node:assert/strict';
import { CoupangAPI } from '../src/platforms/coupang_api.js';

test('CoupangAPI includes X-EXTENDED-TIMEOUT in request headers', async () => {
  let capturedHeaders = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    capturedHeaders = options.headers;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ code: 'SUCCESS', data: { sellerProductId: 12345 } })
    };
  };

  try {
    const api = new CoupangAPI('vendor123', 'ak-test', 'sk-test');
    await api.getProduct(12345);
    assert.ok(capturedHeaders, 'fetch should have been called');
    assert.equal(capturedHeaders['X-EXTENDED-TIMEOUT'], '45000', 'X-EXTENDED-TIMEOUT should be set to 45000ms');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('CoupangAPI getProduct caches results for consecutive calls within 30s', async () => {
  let fetchCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCount++;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ code: 'SUCCESS', data: { sellerProductId: 12345, items: [{ itemName: '옵션1' }] } })
    };
  };

  try {
    const api = new CoupangAPI('vendor123', 'ak-test', 'sk-test');
    const res1 = await api.getProduct(12345);
    const res2 = await api.getProduct(12345);

    assert.equal(fetchCount, 1, 'Second getProduct call should use cache without hitting network');
    assert.deepEqual(res1, res2);

    // After clearing cache, it should fetch again
    api.clearProductCache(12345);
    await api.getProduct(12345);
    assert.equal(fetchCount, 2, 'Should fetch again after clearProductCache');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('CoupangAPI retries once on 504 Gateway Timeout for GET requests', async () => {
  let attempts = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    attempts++;
    if (attempts === 1) {
      return {
        ok: false,
        status: 504,
        text: async () => JSON.stringify({ code: 'ERROR', message: 'Request timed out, if the situation continues consider applying timeout extension.' })
      };
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ code: 'SUCCESS', data: { sellerProductId: 999 } })
    };
  };

  try {
    const api = new CoupangAPI('vendor123', 'ak-test', 'sk-test');
    const res = await api.getProduct(999);
    assert.equal(attempts, 2, 'Should retry on 504');
    assert.equal(res.data.sellerProductId, 999);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
