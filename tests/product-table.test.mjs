import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const window = {};
vm.runInNewContext(fs.readFileSync(new URL('../src/ui/product-table.js', import.meta.url), 'utf8'), { window });
const normalize = (item, catalog) => JSON.parse(JSON.stringify(window.VUProductTable.normalize(item, catalog)));

test('all marketplaces share product brand / make / model / type classification', () => {
  for (const name of ['옵틱글래스 현대 싼타페 광각 사이드 와이드미러', 'OPTICGLASS Hyundai Santa Fe Wide Angle Mirror']) {
    const row = normalize({ id: '000123', name });
    assert.equal(row.brand, '옵틱글래스');
    assert.equal(row.vehicle, '자동차(현대)');
    assert.equal(row.model, '싼타페');
    assert.equal(row.kind, '와이드미러');
    assert.equal(row.title, name);
    assert.equal(row.id, '000123');
  }
});

test('product brands are separate from car makes and unrecognized data stays unclassified', () => {
  assert.equal(normalize({ name: '현대 그랜저 와이드미러' }).brand, '미분류');
  const row = normalize({ name: '퓨어글래스 자동차 액세서리', brand: 'Hyundai' });
  assert.equal(row.brand, '퓨어글래스');
  assert.equal(row.model, '미분류');
  assert.equal(row.kind, '미분류');
  assert.equal(normalize({ name: 'unknown product for skateboard K50' }).model, '미분류');
});

test('longest model names win and multiple distinct models remain visible', () => {
  const catalog = { brands: () => ['현대'], modelsOf: () => ['싼타페', '싼타페 더 프라임', '아이오닉5'] };
  assert.equal(normalize({ name: '옵틱글래스 현대 싼타페 더 프라임 광각미러' }, catalog).model, '싼타페 더 프라임');
  assert.equal(normalize({ name: '옵틱글래스 현대 아이오닉5N 와이드미러' }, catalog).model, '아이오닉 5N');
  assert.equal(normalize({ name: '퓨어글래스 현대 그랜저/싼타페/베라크루스 와이드미러' }, catalog).model, '그랜저 / 싼타페 / 베라크루스');
});

test('steps and motorcycle products do not become car mirrors', () => {
  const step = normalize({ name: '스타포쉬 프로 LED 현대 아이오닉 9 2025 전동사이드스텝' });
  assert.equal(step.brand, '스타포쉬');
  assert.equal(step.model, '아이오닉 9');
  assert.equal(step.kind, '전동사이드스텝');
  assert.equal(normalize({ name: 'OPTICGLASS Yamaha Motorcycle Wide Mirror' }).vehicle, '오토바이(야마하)');
});

test('normalization preserves marketplace records, titles and IDs without mutations', () => {
  const item = { prodNo: 100, name: "퓨어글래스 현대 그랜저 '20~23' [No.2]", price: 0, stock: 0, groupProductNos: [100, 101] };
  const original = structuredClone(item);
  normalize(item);
  assert.deepEqual(item, original);
  assert.equal(normalize({ postCode: 'post/<id>', subject: '<img onerror=alert(1)>', }).id, 'post/<id>');
});
