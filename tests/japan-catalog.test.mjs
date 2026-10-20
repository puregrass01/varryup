import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const japan = JSON.parse(read('data/japan_vehicle_catalog.json'));
const catalog = JSON.parse(read('data/vehicle_catalog.json'));
const names = JSON.parse(read('data/vehicle_i18n.json'));
function suggest(enabled = true) {
  const window = {}; window.parent = window;
  const document = { addEventListener() {}, body: null, getElementById() { return null; } };
  new Function('window', 'document', read('src/ui/vu-suggest.js'))(window, document);
  const vu = window.VUSuggest;
  vu.setCatalog(JSON.parse(read('data/imweb_categories.json')));
  vu.setNames(names); vu.setVehicleCatalog({ ...catalog, japan }); vu.setJapanMode(enabled);
  return vu;
}

test('all 289 workbook rows retain provenance, BSA text and no fabricated product identities', () => {
  assert.equal(japan.variants.length, 289);
  assert.equal(new Set(japan.variants.map(r => r.brand)).size, 9);
  assert.equal(new Set(japan.variants.map(r => [r.brand, r.model].join('|'))).size, 132);
  assert.equal(new Set(japan.variants.map(r => r.sourceRange)).size, 289);
  for (const row of japan.variants) {
    assert.match(row.sourceRange, /^시트1![GQ]\d+:[LV]\d+$/);
    assert.equal(row.no, ''); assert.deepEqual(row.skus, []);
    assert.equal(typeof row.bsa, 'string');
  }
});

test('Japan mode resolves source brand aliases and native model names', () => {
  const vu = suggest();
  assert.equal(vu.brandJa('토요타'), 'トヨタ');
  assert.equal(vu.brandJa('닛산'), '日産');
  assert.equal(vu.modelJa('도요타', '시엔타'), 'シエンタ');
  assert.equal(vu.modelJa('도요타', '시에나'), 'シエナ', 'Sienna is not Sienta');
  assert.equal(vu.modelJa('토요타', '비츠'), 'ヴィッツ');
  assert.equal(vu.modelJa('마쓰다', 'CX-5'), 'CX-5');
  assert.equal(vu.modelJa('도요타', '라브4'), 'RAV4');
});

test('generations, production dates and series remain matched to the same source row', () => {
  const rows = suggest().variantsFor('도요타', '시엔타');
  assert.deepEqual(rows.map(r => [r.gen, r.year, r.code]), [
    ['1세대', '2003 ~ 2015', 'XP80'], ['2세대', '2015 ~ 2022', 'XP170'], ['3세대', '2022 ~ 현재', 'XP210']
  ]);
  const late = suggest().variantsFor('도요타', '라이즈').find(r => r.gen === '1세대 후기형');
  assert.equal(late.genJa, '1世代 後期型');
  assert.equal(late.bsa, '기본');
});

test('grouped aliases do not select an arbitrary Japanese model', () => {
  const vu = suggest();
  assert.equal(vu.modelJa('토요타', '야리스 ( 비츠 )'), null, 'group includes Vitz and Yaris, so a row must be selected');
  assert.equal(vu.modelJa('렉서스', 'LBX 모리조 RR'), null, 'missing source translation must stay empty');
});

test('Japan-only passenger vehicles augment suggestions without becoming motorcycles', () => {
  const vu = suggest();
  assert.ok(vu.modelsOf('혼다').includes('N-BOX'));
  assert.ok(vu.modelsOf('스즈키').includes('스페이시아'));
  assert.equal(vu.isBikeBrand('스즈키'), false);
  vu.setJapanMode(false);
  assert.equal(vu.isBikeBrand('스즈키'), true);
  assert.equal(vu.brandJa('닛산'), names.brands['닛산'].jp);
});

test('turning Japan off restores existing variants and does not mutate base catalogs', () => {
  const before = JSON.stringify(catalog), vu = suggest(false);
  const original = vu.variantsFor('도요타', '시에나');
  vu.setJapanMode(true);
  assert.deepEqual(vu.variantsFor('도요타', '시에나'), original);
  vu.setJapanMode(false);
  assert.deepEqual(vu.variantsFor('도요타', '시에나'), original);
  assert.equal(JSON.stringify(catalog), before);
});

test('existing catalog IPC returns the separate Japan data for packaged apps', async () => {
  const main = read('src/main_process.js');
  const start = main.indexOf("ipcMain.handle('vehicle-load-catalog'");
  const end = main.indexOf("ipcMain.handle('vehicle-load-i18n'", start);
  let handler;
  vm.runInNewContext(main.slice(start, end), { ipcMain: { handle(_name, fn) { handler = fn; } }, fs, path, __dirname: path.join(root, 'src'), console });
  const result = await handler();
  assert.equal(result.success, true);
  assert.equal(result.catalog.japan.variants.length, 289);
  assert.equal(JSON.stringify(result.catalog.variants), JSON.stringify(catalog.variants));
});
