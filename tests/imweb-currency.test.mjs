import test from 'node:test';
import assert from 'node:assert/strict';
import { englishPrice, englishPriceHtml, replaceEnglishPrice, readEnglishPrice, ENGLISH_BOARD_ADMIN } from '../src/utils/imweb_currency.js';
import { ImwebEdit } from '../src/platforms/imweb_edit.js';

const data = () => ({ priceUsd: '109.32', currencySnapshot: { base: 'USD',
  rates: { USD: 1, JPY: 150, KRW: 1350 }, marketDate: '2026-09-28', fetchedAt: new Date().toISOString() } });
test('Excel USD stays unchanged; computed values appear only in price tooltip', () => {
  const price = englishPrice(data());
  assert.equal(price.usd, '109.32');
  assert.equal(price.jpy, '16398.00');
  assert.equal(price.krw, '147582.00');
  const html = englishPriceHtml(data(), 'en');
  assert.match(html, /title="USD 109.32 · JPY 16398.00 · KRW 147582.00"/);
  assert.match(html, />Price \(USD\): \$109.32</);
  assert.doesNotMatch(html, /<table/);
  assert.equal(englishPriceHtml({}, 'ko'), '');
  assert.equal(englishPriceHtml({}, 'jp'), '');
});
test('invalid source prices and stale, future, missing, invalid rates fail closed', () => {
  for (const priceUsd of ['', '-1', '0', '12oops', '1.234', 'Infinity'])
    assert.throws(() => englishPrice({ ...data(), priceUsd }));
  for (const patch of [{ stale: true }, { fetchedAt: new Date(Date.now() - 86400001).toISOString() },
    { fetchedAt: new Date(Date.now() + 60000).toISOString() }, { rates: { USD: 1, JPY: 0, KRW: 1350 } }]) {
    const d = data(); Object.assign(d.currencySnapshot, patch);
    assert.throws(() => englishPrice(d));
  }
  assert.throws(() => englishPrice({ priceUsd: '100' }));
});
test('managed price replacement is idempotent and preserves unrelated text/images', () => {
  const original = '<p>Fitment guide. Model 2024. Shipping $20</p><img src="https://example.test/a.jpg">';
  const first = replaceEnglishPrice(original, englishPriceHtml(data(), 'en'));
  const next = englishPriceHtml({ ...data(), priceUsd: '99.99' }, 'en');
  const updated = replaceEnglishPrice(first, next);
  assert.ok(updated.startsWith(original));
  assert.equal(readEnglishPrice(updated), '99.99');
  assert.equal(replaceEnglishPrice(updated, next), updated);
  assert.equal(readEnglishPrice(original), '');
  assert.equal((replaceEnglishPrice(first + first, next).match(/data-vu-price/g) || []).length, 1);
});
test('English routing always uses confirmed English site', () => {
  const board = Object.create(ImwebEdit.prototype);
  board.loadConfig = () => ({ headUrl: 'https://optic-glass.imweb.me/admin', usUrl: 'https://wrong.example/admin' });
  assert.equal(board.boardAdminUrl('en'), ENGLISH_BOARD_ADMIN);
  assert.equal(board.boardAdminUrl('ko'), 'https://optic-glass.imweb.me/admin');
  assert.equal(board.boardAdminUrl('jp'), 'https://optic-glass.imweb.me/admin');
});
function boardFixture() {
  const board = Object.create(ImwebEdit.prototype);
  board.log = () => {};
  board.boardNameFor = () => 'Test Board';
  board.nameForLang = (_, key) => key === 'titleBrand' ? 'TEST' : 'MODEL';
  board.findBoard = async (_, lang) => { board.requestLang = lang; return { boardCode: 'board-test', boardName: 'Test Board' }; };
  board.extractImageUrl = value => value;
  board.cmFetchMultipart = async (_, fields) => { board.sent = fields; return { text: JSON.stringify({ status: 'success', data: { code: 'post-test' } }) }; };
  return board;
}
test('API creation carries English price and uses language-specific board; Korean has no price', async () => {
  const board = boardFixture();
  const input = { ...data(), brand: 'TEST', code: '1', specImageUrl: 'https://example.test/ko.jpg', specImageUrlEn: 'https://example.test/en.jpg' };
  assert.equal(await board.createBoardPostViaApi(input, 'en'), true);
  assert.equal(board.requestLang, 'en');
  assert.equal(readEnglishPrice(board.sent.body), '109.32');
  assert.match(board.sent.body, /en.jpg/);
  assert.equal(await board.createBoardPostViaApi({ ...input, currencySnapshot: null }, 'ko'), true);
  assert.equal(readEnglishPrice(board.sent.body), '');
  board.sent = null;
  await assert.rejects(board.createBoardPostViaApi({ ...input, currencySnapshot: null }, 'en'), /최신 환율/);
  assert.equal(board.sent, null);
});
test('price-only edit preserves body and verifies saved price; blank keeps existing price', async () => {
  const board = boardFixture();
  const original = '<p>Keep model and shipping $20</p><img src="https://example.test/a.jpg">';
  let current = { content: original, subject: 'Test', images: ['https://example.test/a.jpg'] };
  board.ensureBoardBase = async lang => { board.requestLang = lang; };
  board.loadPost = async () => ({ ...current });
  board.cmFetch = async (_, { form }) => { current = { ...current, content: form.body, subject: form.subject }; return { text: '{"status":"success"}' }; };
  await board.updatePost({ ...data(), lang: 'en', postCode: 'post-test' });
  assert.equal(board.requestLang, 'en');
  assert.ok(current.content.startsWith(original));
  assert.equal(readEnglishPrice(current.content), '109.32');
  await board.updatePost({ priceUsd: '', lang: 'en', postCode: 'post-test', subject: 'Renamed' });
  assert.equal(readEnglishPrice(current.content), '109.32');
  await assert.rejects(board.updatePost({ priceUsd: '100', lang: 'en', postCode: 'post-test' }), /최신 환율/);
});
test('save rejects silently stripped price markup', async () => {
  const board = boardFixture();
  board.ensureBoardBase = async () => {};
  board.loadPost = async () => ({ content: '<p>original</p>', subject: 'Test', images: [] });
  board.cmFetch = async () => ({ text: '{"status":"success"}' });
  await assert.rejects(board.updatePost({ ...data(), lang: 'en', postCode: 'post-test' }), /USD 판매가 미반영/);
});

test('board authentication captures only target origin and switches from English to Korean', async () => {
  const board = Object.create(ImwebEdit.prototype);
  let listener;
  board.page = { on: (_, fn) => { listener = fn; }, off() {} };
  board.log = () => {};
  board.loadConfig = () => ({ headUrl: 'https://optic-glass.imweb.me/admin' });
  const visited = [];
  board.openAdminAt = async url => {
    visited.push(url);
    listener({ url: () => 'https://wrong.example/admin/ajax/contents/v2/api.cm?site_code=wrong&unit_code=wrong' });
    listener({ url: () => new URL(url).origin + '/admin/ajax/contents/v2/api.cm?site_code=test&unit_code=test' });
  };
  const en = await board.ensureBoardBase('en');
  assert.ok(en.startsWith('https://optic-glass-us.imweb.me/'));
  const ko = await board.ensureBoardBase('ko');
  assert.ok(ko.startsWith('https://optic-glass.imweb.me/'));
  assert.equal(visited.length, 2);
});
