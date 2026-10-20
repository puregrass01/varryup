// Match the common form's code first, otherwise brand/model or free text.
// 실제로 적용된 검색어. 0건 사유를 설명할 때도 같은 값을 써야 하므로 따로 노출한다.
export function effectiveQuery({ code = '', brand = '', model = '', searchText = '' } = {}) {
  return String(code || [brand, model].filter(Boolean).join(' ') || searchText).trim();
}

export function matchesProduct(item, query = {}) {
  const text = [item.id, item.name, item.brand, item.asin].filter(Boolean).join(' ').toLowerCase();
  return effectiveQuery(query).toLowerCase().split(/\s+/).filter(Boolean).every(term => text.includes(term));
}
