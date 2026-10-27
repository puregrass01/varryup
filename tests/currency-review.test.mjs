import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CurrencyRatesClient, RETRY } from '../src/utils/currency_rates.js';
import { createFxAutoPrice, FxPriceStore } from '../src/fx_auto_price.js';
import { Amazon, JP_MARKETPLACE_ID as JP, US_MARKETPLACE_ID as US } from '../src/platforms/amazon.js';

const now = Date.parse('2026-09-30T01:00:00Z');
const snapshot = () => ({ ok: true, base: 'USD', rates: { USD: 1, JPY: 150, KRW: 1350 },
  marketDate: '2026-09-29', fetchedAt: new Date(now).toISOString() });
function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-review-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// 관리 서버 환율 경로는 2026-10-23 지웠다(운영 미배포). 출처가 stale 로 표시한 값은 직접 조회(direct)로 흉내 낸다.
test('stale flag survives disk/restart, blocks price calculation, and clears only with fresh rates', async t => {
  const dir = temp(t); let clock = now, fresh = false, calls = 0;
  const options = { cachePath: path.join(dir, 'rates.json'), clock: () => clock,
    direct: async () => { calls++; return { ...snapshot(), stale: !fresh, warning: fresh ? null : 'source marked stale' }; } };
  const client = new CurrencyRatesClient(options);
  assert.equal((await client.get()).data.stale, true);
  assert.equal(JSON.parse(fs.readFileSync(options.cachePath)).warning, 'source marked stale');
  const restarted = new CurrencyRatesClient(options);
  const cached = await restarted.get();
  assert.equal(cached.data.stale, true);
  assert.equal(calls, 1);
  const fx = createFxAutoPrice({ store: new FxPriceStore(dir), rates: () => restarted.get(), clock: () => clock,
    service: { list() { assert.fail('stale rates must not call marketplaces'); } } });
  await assert.rejects(fx.plan({ scope: 'amazon-jp', rows: [{ id: 'JP1', price: '16000' }] }), /24시간/);
  assert.match((await fx.run()).error, /24시간/);
  clock += RETRY; fresh = true;
  const updated = await restarted.get();
  assert.equal(calls, 2);
  assert.equal(updated.data.stale, false);
  assert.equal(updated.data.warning, null);
  assert.equal((await fx.plan({ scope: 'amazon-jp', rows: [{ id: 'JP1', price: '16000' }] })).rows[0].target, '16000');
});

const product = { marketplaceId: JP, price: '17000', title: '日本商品', description: '日本語説明', bulletPoints: ['日本語特徴'] };
test('Japan new product uses JPY price even when an unrelated USD reference is included', () => {
  const service = new Amazon('unused');
  const offer = service._buildProductPayload({ ...product, priceUsd: '109.32' }).attributes.purchasable_offer[0];
  assert.equal(offer.currency, 'JPY');
  assert.equal(offer.our_price[0].schedule[0].value_with_tax, 17000);
  assert.throws(() => service._buildProductPayload({ ...product, price: '', priceUsd: '109.32' }), /USD/);
  for (const price of ['109.32', '12oops', '-1', '0', 'Infinity'])
    assert.throws(() => service._buildProductPayload({ ...product, price }), /정수/);
  assert.throws(() => service._buildProductPayload({ ...product, currency: 'USD' }), /JPY/);
});

test('Japan partial edit cannot mistake USD for JPY and image-only edits leave prices unchanged', () => {
  const service = new Amazon('unused');
  assert.throws(() => service._buildPartialAttributes({ priceUsd: '109.32' }, JP), /USD/);
  assert.throws(() => service._buildPartialAttributes({ price: '100.5' }, JP), /정수/);
  assert.throws(() => service._buildPartialAttributes({ price: '17000', currency: 'USD' }, JP), /JPY/);
  const attrs = service._buildPartialAttributes({ price: '17000', priceUsd: '109.32' }, JP);
  assert.equal(attrs.purchasable_offer[0].our_price[0].schedule[0].value_with_tax, 17000);
  assert.equal(service._buildPartialAttributes({ mainImageUrl: 'https://example.test/image.jpg' }, JP).purchasable_offer, undefined);
  assert.equal(service._buildPartialAttributes({ priceUsd: '109.32' }, US).purchasable_offer[0].our_price[0].schedule[0].value_with_tax, 109.32);
});
