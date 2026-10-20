// The display follows the field this app edits, not the marketplace's entire HTML support.
export function imagePolicy(scope) {
  if (scope === 'amazon-us' || scope === 'amazon-jp') return { display: 'urls', label: '상품 이미지 (첫 URL = 대표)', max: 9 };
  if (scope === 'ebay') return { display: 'urls', label: '상품 이미지 (첫 URL = 대표)', max: 24 };
  if (['naver', 'coupang', 'imweb-b2b', 'imweb-en', 'imweb-ko', 'imweb-jp'].includes(scope))
    return { display: 'images', label: '상세 이미지', max: 100 };
  throw new Error('지원하지 않는 이미지 플랫폼입니다.');
}

export function parseImageUrls(value, scope, { allowEmpty = false } = {}) {
  const list = Array.isArray(value) ? value : String(value ?? '').trim().split(/[|\r\n]/);
  const values = list.map(x => String(x?.url ?? x ?? '').trim());
  if (allowEmpty && (!values.length || values.every(x => !x))) return [];
  if (!values.length || values.some(x => !x)) throw new Error('이미지 URL을 url|url 형식으로 입력하세요. 빈 항목은 허용하지 않습니다.');
  if (values.length > imagePolicy(scope).max) throw new Error(`이 플랫폼에서는 이미지 ${imagePolicy(scope).max}장까지 입력할 수 있습니다.`);
  return values.map(value => {
    let url;
    try { url = new URL(value); } catch { throw new Error('올바른 이미지 URL을 입력하세요: ' + value); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || /[<>"'\s]/.test(value))
      throw new Error('이미지는 인증정보·HTML이 없는 HTTP(S) URL로 입력하세요.');
    return url.href;
  });
}

export const sameImages = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function amazonImageUrls(product, marketplaceId) {
  const attrs = product.raw?.attributes || {};
  const value = key => (attrs[key]?.find(x => x.marketplace_id === marketplaceId) || attrs[key]?.find(x => !x.marketplace_id))?.media_location;
  return [value('main_product_image_locator') || product.mainImageUrl,
    ...Array.from({ length: 8 }, (_, i) => value('other_product_image_locator_' + (i + 1)))].filter(Boolean);
}

// Display-only normalization: preserve URL query strings and never change save payloads.
export function previewImageUrls(value) {
  if (typeof value === 'string' && value.trim().startsWith('[')) {
    try { value = JSON.parse(value); } catch { return []; }
  }
  const entries = (Array.isArray(value) ? value : [value]).flatMap(item => String(item?.url ?? item ?? '').split(/[|\r\n]/));
  return entries.flatMap(entry => {
    try {
      const url = new URL(entry.trim());
      return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? [url.href] : [];
    } catch { return []; }
  });
}
