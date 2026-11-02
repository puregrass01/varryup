/**
 * 나라별 가격 통일(일괄 수정 [한국] [미국] [일본])이 쓰는 짝 인덱스 → data/country_index.json
 *
 * 베리맵 대조표(data/verimap)와 CSVdatabase 는 배포본에 없다 — 앱은 이 JSON 만 읽는다(vehicle_i18n.json 과 같은 방식).
 *   본사몰 상품번호 → 코드표 행   : 베리맵 match_명단.csv 의 '확정' 행. 없으면 Vehicles 시트(구매 URL 의 idx)로 코드표 행을 찾는다.
 *                                  대조표에 이미 있는 상품은 시트를 보지 않는다(중복).
 *   코드표 행 → 네이버 · 쿠팡      : 같은 match_명단.csv 의 '확정' 행(네이버는 naver_list.csv 로 원상품번호를 붙인다).
 *   코드표 행 → 아마존 · eBay SKU  : 카탈로그(vehicle_catalog.json) variants 를 제조사 · 모델 · 연식 · 번호로 잇고, 판은 listings 의 bsa.
 *
 * 실행   node scripts/build_country_index.mjs ["CSVdatabase/Vehicles - Grid view - 날짜.csv"]
 *        경로를 안 주면 CSVdatabase 의 가장 새 Vehicles 시트(V2 아님). 베리맵을 다시 돌린 뒤에도 다시 실행한다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCsv } from './verimap_csv.mjs';
import { hasBsa, brandKey, squash } from '../src/utils/duplicate_guard.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERIMAP = path.join(ROOT, 'data', 'verimap'), OUT = path.join(ROOT, 'data', 'country_index.json');
const sheetFile = process.argv[2] ? path.resolve(process.argv[2]) : (() => {
  const dir = path.join(ROOT, 'CSVdatabase');
  const name = fs.readdirSync(dir).filter(f => /^Vehicles - Grid view - .+\.csv$/.test(f)).sort().pop();
  if (!name) throw new Error('CSVdatabase 에 Vehicles 시트(Vehicles - Grid view - 날짜.csv)가 없습니다.');
  return path.join(dir, name);
})();

const match = readCsv(path.join(VERIMAP, 'match_명단.csv')).filter(r => r['판정'] === '확정' && r['코드표_행']);
const originOf = new Map(readCsv(path.join(VERIMAP, 'naver_list.csv')).map(r => [r['채널상품번호'], r['원상품번호']]));
const codetable = JSON.parse(fs.readFileSync(path.join(VERIMAP, 'codetable.json'), 'utf8'));
const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'vehicle_catalog.json'), 'utf8'));

const rows = {}, products = {}, stats = { noOrigin: 0, sheetDuplicate: 0, sheetAdded: 0, sheetMissing: [], skuRows: 0 };
const rowOf = n => (rows[n] ||= { naver: [], coupang: [], skus: [] });
const addProduct = (id, via, no, row) => {
  const p = products[id] ||= { via, no, rows: [] };
  if (!p.rows.includes(row)) p.rows.push(row);
};

for (const r of match) {
  const row = r['코드표_행'].trim(), id = r['상품ID'].trim(), option = String(r['옵션ID'] ?? '').trim();   // 옵션ID 가 ' ' 인 쿠팡 행이 있다
  if (r['채널'] === '본사몰') addProduct(id, 'index', r['추출_부품번호'], row);
  else if (r['채널'] === '스마트스토어') {
    const origin = originOf.get(id);
    if (!origin) { stats.noOrigin++; continue; }
    rowOf(row).naver.push([origin, id]);
  } else if (r['채널'] === '쿠팡' && option) rowOf(row).coupang.push([id, option, hasBsa(r['옵션'])]);
}

// 코드표 행 → 카탈로그 차종(SKU). 판은 listings 에서 그 SKU 의 판이 한 가지일 때만 정한다(SKU 하나가 두 판에 쓰이기도 한다).
const editions = new Map();
for (const l of catalog.listings || []) if (l.sku) editions.set(l.sku, (editions.get(l.sku) || new Set()).add(!!l.bsa));
// 제조사 · 모델 · 번호로 잇는다. 카탈로그 제조사는 '폭스바겐 (Volkswagen)', 연식은 '05.08~11.03/11.02~15.06' 처럼 적혀 있어
// 연식까지 맞추면 994행 중 114행만 이어진다. 같은 차 같은 번호의 다른 세대 SKU 가 섞여도 번호 · 판이 같으면 기준가가 같다.
const vehicleKey = (brand, model, no) => [brandKey(brand), squash(model), String(no ?? '').trim().toUpperCase()].join('|');
const skusOf = new Map();
for (const v of catalog.variants || []) {
  const k = vehicleKey(v.brand, v.model, v.no);
  skusOf.set(k, [...new Set([...(skusOf.get(k) || []), ...(v.skus || []), ...(v.amazonSkus || [])])]);
}
const entries = codetable.entries || [];
for (const e of entries) {
  const skus = skusOf.get(vehicleKey(e.brand, e.model, e.partKey));
  if (!skus?.length) continue;
  stats.skuRows++;
  rowOf(String(e.row)).skus.push(...skus.map(sku => [sku, editions.get(sku)?.size === 1 ? [...editions.get(sku)][0] : null]));
}

// Vehicles 시트: 구매 URL 의 idx(본사몰 상품번호) → 제조사 · 모델 · 연식 · 번호가 같은 코드표 행.
const clean = v => String(v ?? '').trim();
const years = v => clean(v).replace(/\s+/g, '').replace(/-/g, '~');   // 시트는 '12.10-18.01', 코드표는 '12.10~18.01'
for (const s of readCsv(sheetFile)) {
  const idx = clean(s['Purchase URL']).match(/optic-glass\.co\.kr\/shop_view\/?\?idx=(\d+)/)?.[1];
  if (!idx) continue;
  if (products[idx]?.via === 'index') { stats.sheetDuplicate++; continue; }
  const part = clean(s.Product), gen = years(s.Generation);
  const hits = entries.filter(e => brandKey(e.brand) === brandKey(s.Manufacturer) && squash(e.model) === squash(s.Model) &&
    clean(e.partRaw) === part && e.ymRaw && gen.includes(years(e.ymRaw)));
  if (!hits.length) { stats.sheetMissing.push(`${idx} ${clean(s.Label)} ${part}`); continue; }
  for (const e of hits) addProduct(idx, 'sheet', e.partKey, String(e.row));
  stats.sheetAdded++;
}

// 본사몰 상품이 가리키는 행만 남긴다.
const used = new Set(Object.values(products).flatMap(p => p.rows));
// 짝이 하나도 없는 행도 빈 칸으로 남긴다(본사몰 상품만 있는 차 — 화면은 '넣음 0' 으로 보인다).
const kept = Object.fromEntries([...used].sort((a, b) => a - b).map(n => [n, rowOf(n)]));
const out = {
  _about: '나라별 가격 통일 짝 인덱스. scripts/build_country_index.mjs 로 만든다 — 손으로 고치지 않는다.',
  _built: new Date().toISOString(),
  _sources: { verimap: 'data/verimap/match_명단.csv (' + fs.statSync(path.join(VERIMAP, 'match_명단.csv')).mtime.toISOString().slice(0, 10) + ')',
    codetable: codetable.loadedAt, catalog: catalog._built, sheet: path.relative(ROOT, sheetFile).replaceAll('\\', '/') },
  products, rows: kept,
};
fs.writeFileSync(OUT, JSON.stringify(out) + '\n');
const count = via => Object.values(products).filter(p => p.via === via).length;
console.log(`본사몰 상품 ${Object.keys(products).length}개 (대조표 ${count('index')} · 시트 ${count('sheet')}) · 코드표 행 ${Object.keys(kept).length}개`);
console.log(`네이버 ${Object.values(kept).reduce((n, r) => n + r.naver.length, 0)} · 쿠팡 옵션 ${Object.values(kept).reduce((n, r) => n + r.coupang.length, 0)} · SKU ${Object.values(kept).reduce((n, r) => n + r.skus.length, 0)} (SKU 있는 코드표 행 ${stats.skuRows}/${entries.length})`);
console.log(`시트: 중복이라 건너뜀 ${stats.sheetDuplicate} · 새로 이음 ${stats.sheetAdded} · 코드표에 없음 ${stats.sheetMissing.length} · 네이버 원상품번호 없음 ${stats.noOrigin}`);
if (stats.sheetMissing.length) console.log('  코드표에 없는 시트 행(앞 10개): ' + stats.sheetMissing.slice(0, 10).join(' / '));
console.log('→ ' + path.relative(ROOT, OUT));
