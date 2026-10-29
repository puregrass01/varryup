export function validateSku(value) {
  const sku = String(value || '').trim();
  if (!sku || sku.length > 50 || /[\x00-\x1f\x7f]/.test(sku)) throw new Error('SKU는 제어문자 없이 1~50자로 입력해주세요.');
  return sku;
}

// eBay 상품명은 80자까지다 — 신규 등록과 기존 상품 제목 수정이 같이 쓴다.
export function validateTitle(value) {
  const title = String(value || '').trim();
  if (!title || title.length > 80) throw new Error('영문 상품명은 1~80자로 입력해주세요.');
  return title;
}

export function priceQuantity(data) {
  const price = String(data.price ?? '').trim();
  const quantity = String(data.quantity ?? '').trim();
  if (!/^\d+(\.\d{1,2})?$/.test(price) || Number(price) <= 0 || !Number.isFinite(Number(price))) throw new Error('USD 가격을 소수점 두 자리 이내의 양수로 입력해주세요.');
  if (!/^\d+$/.test(quantity) || !Number.isSafeInteger(Number(quantity)) || Number(quantity) > 999999) throw new Error('재고는 0~999999 정수로 입력해주세요.');
  return { price: Number(price).toFixed(2), quantity: Number(quantity) };
}

export function parseAspects(value) {
  let aspects;
  try { aspects = typeof value === 'string' ? JSON.parse(value || '{}') : (value || {}); }
  catch { throw new Error('상품 속성 JSON 형식을 확인해주세요.'); }
  if (!aspects || Array.isArray(aspects) || typeof aspects !== 'object') throw new Error('상품 속성은 이름과 문자열 배열로 입력해주세요.');
  for (const [key, values] of Object.entries(aspects)) {
    if (!key.trim() || !Array.isArray(values) || !values.length || values.some(v => typeof v !== 'string' || !v.trim())) throw new Error(`속성 ${key}: 비어 있지 않은 문자열 배열이 필요합니다.`);
  }
  return aspects;
}

export function validateAspects(aspects, metadata) {
  if (!Array.isArray(metadata.aspects)) throw new Error('카테고리 속성 정보를 확인하지 못했습니다. 다시 조회해주세요.');
  for (const aspect of metadata.aspects || []) {
    const name = aspect.localizedAspectName;
    const c = aspect.aspectConstraint || {};
    const values = aspects[name] || [];
    if (c.aspectRequired && !values.length) throw new Error(`필수 상품 속성이 없습니다: ${name}`);
    if (c.itemToAspectCardinality === 'SINGLE' && values.length > 1) throw new Error(`${name}: 값은 하나만 입력해주세요.`);
    if (c.aspectMaxLength && values.some(v => v.length > c.aspectMaxLength)) throw new Error(`${name}: 최대 ${c.aspectMaxLength}자입니다.`);
    if (c.aspectMode === 'SELECTION_ONLY') {
      const allowed = new Set((aspect.aspectValues || []).map(v => v.localizedValue));
      if (values.some(v => !allowed.has(v))) throw new Error(`${name}: 카테고리에서 허용한 값을 선택해주세요.`);
    }
  }
}

export function buildEbayPayload(data, config) {
  const sku = validateSku(data.sku);
  const { price, quantity } = priceQuantity(data);
  if (quantity === 0) throw new Error('신규 상품 재고는 1개 이상이어야 합니다.');
  const title = validateTitle(data.title);
  const description = String(data.description || '').trim();
  if (!description || description.length > 50000) throw new Error('상품 설명은 1~50000자로 입력해주세요.');
  if (!/^\d+$/.test(String(data.categoryId || ''))) throw new Error('미국 최하위 카테고리 ID를 입력해주세요.');
  const inputs = Array.isArray(data.imageUrls) ? data.imageUrls : String(data.imageUrls || '').split(/\r?\n/);
  const imageUrls = [...new Set(inputs.map(v => String(v).trim()).filter(Boolean))];
  if (!imageUrls.length || imageUrls.length > 24) throw new Error('상품 이미지 HTTPS URL을 1~24개 입력해주세요.');
  for (const imageUrl of imageUrls) {
    let url; try { url = new URL(imageUrl); } catch { throw new Error('잘못된 이미지 URL입니다.'); }
    if (url.protocol !== 'https:' || url.username || url.password || /^(localhost|127\.|\[|10\.|192\.168\.)/i.test(url.hostname)) throw new Error('외부에서 접근 가능한 HTTPS 이미지 URL이 필요합니다.');
  }
  for (const field of ['merchantLocationKey', 'fulfillmentPolicyId', 'paymentPolicyId', 'returnPolicyId']) {
    if (!String(config[field] || '').trim()) throw new Error(`설정이 필요합니다: ${field}`);
  }
  const aspects = parseAspects(data.aspects);
  if (data.brand?.trim()) aspects.Brand = [data.brand.trim()];
  if (data.mpn?.trim()) aspects.MPN = [data.mpn.trim()];
  const packageWeightAndSize = {};
  if (String(data.weightKg || '').trim()) {
    const weight = Number(data.weightKg);
    if (!Number.isFinite(weight) || weight <= 0) throw new Error('포장 무게는 0보다 큰 kg 값으로 입력해주세요.');
    packageWeightAndSize.weight = { value: weight, unit: 'KILOGRAM' };
  }
  if (['lengthCm', 'widthCm', 'heightCm'].some(field => String(data[field] || '').trim())) {
    const dimensions = { length: Number(data.lengthCm), width: Number(data.widthCm), height: Number(data.heightCm), unit: 'CENTIMETER' };
    if (['length', 'width', 'height'].some(field => !Number.isFinite(dimensions[field]) || dimensions[field] <= 0)) throw new Error('포장 가로·세로·높이를 모두 양수로 입력해주세요.');
    packageWeightAndSize.dimensions = dimensions;
  }
  // User description is plain text: existing ESM HTML is imported as image URLs, never executable markup.
  const escaped = description.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/\r?\n/g, '<br>');
  return {
    sku,
    inventory: { availability: { shipToLocationAvailability: { quantity } }, condition: 'NEW',
      ...(Object.keys(packageWeightAndSize).length ? { packageWeightAndSize } : {}),
      product: { title, description, aspects, imageUrls,
        ...(aspects.Brand ? { brand: aspects.Brand[0] } : {}), ...(aspects.MPN ? { mpn: aspects.MPN[0] } : {}) }
    },
    offer: { sku, marketplaceId: 'EBAY_US', format: 'FIXED_PRICE', listingDuration: 'GTC', availableQuantity: quantity,
      categoryId: String(data.categoryId), merchantLocationKey: config.merchantLocationKey, listingDescription: escaped,
      pricingSummary: { price: { currency: 'USD', value: price } },
      listingPolicies: { fulfillmentPolicyId: config.fulfillmentPolicyId, paymentPolicyId: config.paymentPolicyId, returnPolicyId: config.returnPolicyId }
    }
  };
}
