import { validRates, DAY } from './currency_rates.js';

export const ENGLISH_BOARD_ADMIN = 'https://optic-glass-us.imweb.me/admin';
export function englishPrice(data, now = Date.now()) {
  const value = String(data.priceUsd ?? '').trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(value) || !Number.isFinite(Number(value)) || Number(value) <= 0)
    throw new Error('영문 게시판 판매가(USD)를 소수 둘째 자리까지 입력하세요.');
  const rate = data.currencySnapshot;
  const age = now - Date.parse(rate?.fetchedAt);
  if (!validRates(rate) || rate.stale || age < 0 || age >= DAY)
    throw new Error('최신 환율을 확인할 수 없어 영문 게시판 가격 적용을 중단했습니다.');
  const usd = Number(value), jpy = usd * rate.rates.JPY, krw = usd * rate.rates.KRW;
  if (![jpy, krw].every(Number.isFinite)) throw new Error('환산 금액이 허용 범위를 초과했습니다.');
  return { usd: usd.toFixed(2), jpy: jpy.toFixed(2), krw: krw.toFixed(2),
    marketDate: rate.marketDate, fetchedAt: rate.fetchedAt };
}
const escapeAttr = value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
export function englishPriceHtml(data, lang, now = Date.now()) {
  if (lang !== 'en') return '';
  const p = englishPrice(data, now);
  const title = 'USD ' + p.usd + ' · JPY ' + p.jpy + ' · KRW ' + p.krw;
  return '<p data-vu-price="usd" data-price-usd="' + p.usd +
    '" data-rate-date="' + escapeAttr(p.marketDate) + '" data-rate-fetched-at="' + escapeAttr(p.fetchedAt) +
    '" style="text-align: center;"><span title="' + escapeAttr(title) +
    '">Price (USD): $' + p.usd + '</span></p>';
}
const managedPrice = () => /<p\b(?=[^>]*\bdata-vu-price=["']usd["'])[^>]*>[\s\S]*?<\/p>/gi;
export function replaceEnglishPrice(content, html) {
  let found = false;
  const result = String(content || '').replace(managedPrice(), () => {
    if (found) return '';
    found = true;
    return html;
  });
  return found ? result : result + html;
}
export function readEnglishPrice(content) {
  const block = String(content || '').match(managedPrice())?.[0] || '';
  return block.match(/\bdata-price-usd=["'](\d+(?:\.\d{1,2})?)["']/)?.[1] || '';
}
