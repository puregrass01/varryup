import fs from 'node:fs';
import { createHash } from 'node:crypto';

// 상품 일괄 수정의 '카탈로그 참조 모드'(createImwebCatalogSource)는 2026-10-05 아임웹이 Open API 로 연결되며 지웠다
// (imweb_bulk.js). 카탈로그 행 만들기는 상품 표준 표기(product_identity) 확인에 남겨 둔다.
const scopes = new Set(['imweb-b2b', 'imweb-ko', 'imweb-en', 'imweb-jp']);
export const isImwebCatalogScope = scope => scopes.has(scope);
export const readVehicleCatalog = () => JSON.parse(fs.readFileSync(new URL('../../data/vehicle_catalog.json', import.meta.url), 'utf8'));

// Local catalog keys are never marketplace product/post IDs.
export function imwebCatalogRows(catalog, scope) {
  if (!isImwebCatalogScope(scope)) throw new Error('지원하지 않는 카탈로그 범위입니다.');
  if (!Array.isArray(catalog?.variants) || !Array.isArray(catalog?.listings)) throw new Error('차량 카탈로그 구조를 확인할 수 없습니다.');
  const listings = new Map(), matched = new Set(), rows = new Map();
  for (const item of catalog.listings) {
    if (!item.sku) continue;
    if (!listings.has(item.sku)) listings.set(item.sku, []);
    listings.get(item.sku).push(item);
  }
  function add(vehicle, offers, source) {
    const skus = [...new Set(vehicle.skus || [])];
    const prices = [...new Set(offers.map(o => o.priceUsd).filter(p => typeof p === 'number' && Number.isFinite(p) && p > 0))];
    const english = scope === 'imweb-en';
    const make = english ? offers[0]?.brandEn || vehicle.brand : vehicle.brand;
    const model = english ? vehicle.modelEn || vehicle.model : vehicle.model;
    const identity = JSON.stringify([source, vehicle.brand, vehicle.model, vehicle.gen, vehicle.year, vehicle.code, vehicle.no, vehicle.bsa, skus]);
    const id = 'catalog:' + createHash('sha256').update(identity).digest('hex').slice(0, 24);
    // 판(BSA/일반)은 이베이 목록의 bsa(참/거짓)만 안다. 코드표의 bsa 는 'BSA 여부' 칸의 메모('Bsa가능'·'사각브라켓' 등)라
    // 판이 아니다 — 예전에는 메모만 있어도 'BSA' 로 보였다. 메모는 그대로 보여 주고 판은 모름으로 둔다.
    const edition = typeof vehicle.bsa === 'boolean' ? vehicle.bsa : null;
    const bsaText = edition === null ? vehicle.bsa && 'BSA 여부: ' + vehicle.bsa : edition && 'BSA';
    rows.set(id, { id, scope, sku: skus.join(' | '), displayId: skus.join(' | ') || 'SKU 없음',
      name: [make, model].filter(Boolean).join(' '), vehicleBrand: vehicle.brand, vehicleModel: vehicle.model,
      variant: [vehicle.gen, vehicle.year, vehicle.code, vehicle.no && 'No.' + vehicle.no, bsaText].filter(Boolean).join(' · '),
      productNo: vehicle.no || '', bsaEdition: edition,
      catalogOnly: true, catalogSource: source, catalogBuiltAt: catalog._built || '',
      catalogPriceUsd: prices.length === 1 ? prices[0] : '',
      price: '', currency: scope === 'imweb-en' ? 'USD' : scope === 'imweb-jp' ? 'JPY' : 'KRW',
      ready: true, readonly: true, priceReadonly: true, imagesReady: true, images: [],
      result: '차량 카탈로그 참조 · API 연동 전' });
  }
  for (const vehicle of catalog.variants) {
    const offers = (vehicle.skus || []).flatMap(sku => { matched.add(sku); return listings.get(sku) || []; });
    add(vehicle, offers, 'variants');
  }
  for (const [sku, offers] of listings) {
    if (matched.has(sku)) continue;
    const item = offers[0];
    add({ brand: item.brandEn || item.sheet, model: item.modelEn, modelEn: item.modelEn,
      gen: item.yearText, no: item.no, bsa: item.bsa, skus: [sku] }, offers, 'listings');
  }
  return [...rows.values()];
}
