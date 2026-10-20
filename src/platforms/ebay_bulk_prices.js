import { describeError, markPreSend, apiError } from '../utils/api_error.js';

// eBay native batch: at most 25 SKUs, price only. Never send cached inventory quantities.
export async function updateEbayPricesBatch({ api, store }, jobs) {
  if (!Array.isArray(jobs) || !jobs.length || jobs.length > 25) throw markPreSend(new Error('eBay 가격 일괄 요청은 1~25건이어야 합니다.'));
  if (new Set(jobs.map(j => j.id)).size !== jobs.length) throw markPreSend(new Error('중복 SKU는 같은 배치에 보낼 수 없습니다.'));
  const results = new Array(jobs.length), pending = [];
  for (const [index, job] of jobs.entries()) {
    try {
      if (!/^\d+(?:\.\d{1,2})?$/.test(String(job.newPrice)) || !(Number(job.newPrice) > 0) || !Number.isFinite(Number(job.newPrice)) || Number(job.newPrice) > Number.MAX_SAFE_INTEGER || job.expectedPrice == null)
        throw new Error('USD 판매가 또는 조회 당시 가격이 올바르지 않습니다.');
      const offers = (await api.offers(job.id)).filter(o => ['EBAY_US', 'EBAY_MOTORS', 'EBAY_MOTORS_US'].includes(o.marketplaceId));
      if (offers.length !== 1 || offers[0].status !== 'PUBLISHED' || offers[0].pricingSummary?.price?.currency !== 'USD')
        throw new Error('게시된 미국 USD Offer가 하나인 상품만 일괄 수정할 수 있습니다.');
      const offer = offers[0], now = offer.pricingSummary.price.value;
      if (Number(now) !== Number(job.expectedPrice)) throw new Error('현재 판매가가 조회 이후 변경됐습니다. 다시 불러오세요.');
      if (Number(now) === Number(job.newPrice)) { results[index] = { success: true, data: { status: 'UNCHANGED', price: String(now) } }; continue; }
      if (!offer.offerId) throw new Error('eBay Offer ID가 없습니다.');
      pending.push({ index, job, offerId: String(offer.offerId) });
    } catch (error) {
      const info = describeError(markPreSend(error), { sent: false });
      if (info.blocking) throw error;
      results[index] = { success: false, ...info };
    }
  }
  if (!pending.length) return results;
  let body;
  try {
    body = await api.request('POST', '/sell/inventory/v1/bulk_update_price_quantity', { requests: pending.map(({ job, offerId }) => ({
      sku: job.id, offers: [{ offerId, price: { currency: 'USD', value: Number(job.newPrice).toFixed(2) } }],
    })) });
  } catch (error) {
    const info = describeError(error, { sent: true });
    for (const { index } of pending) results[index] = { success: false, ...info };
    return results;
  }
  // Match by SKU + offer, not array position: responses may be reordered or partially missing.
  for (const { index, job, offerId } of pending) {
    const matches = (Array.isArray(body?.responses) ? body.responses : []).filter(r => String(r.sku) === job.id && String(r.offerId) === offerId);
    const r = matches.length === 1 ? matches[0] : null;
    if (!r || !Number.isInteger(r.statusCode) || r.statusCode < 100 || r.statusCode > 599 || (r.errors != null && !Array.isArray(r.errors))) {
      results[index] = { success: false, stage: 'unknown', error: 'eBay 일괄 응답이 누락되거나 중복되었습니다. 현재가를 확인하세요.' }; continue;
    }
    if (Number(r.statusCode) < 200 || Number(r.statusCode) >= 300 || r.errors?.length) {
      const detail = r.errors?.map(e => e.longMessage || e.message).filter(Boolean).join('; ') || 'eBay 가격 수정 오류';
      results[index] = { success: false, ...describeError(apiError(detail, { status: Number(r.statusCode), rejected: Number(r.statusCode) < 500 }), { sent: true }) }; continue;
    }
    let message = 'eBay 가격 변경 접수 완료 · 현재가를 다시 조회해 반영을 확인하세요.';
    try { store.updateCachedListing?.(job.id, { price: Number(job.newPrice).toFixed(2) }); }
    catch { message += ' 로컬 목록 갱신 실패.'; }
    results[index] = { success: true, data: { status: 'ACCEPTED', price: String(job.newPrice), message, warnings: r.warnings || [] } };
  }
  return results;
}
