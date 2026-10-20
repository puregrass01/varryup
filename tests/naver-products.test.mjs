import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { NaverAPI, NaverAPIError } from '../src/platforms/naver_api.js';
import { NaverProducts, naverEditProduct, buildNaverProductUpdate, extractNaverDetailImages, replaceNaverDetailImages } from '../src/platforms/naver_products.js';

const imageBlock = (id, url) => `<div class="se-component se-image" id="${id}"><div><a href="${url}"><img src="${url}" alt="${id}"></a></div><script type="application/json">{"image":"${id}"}</script></div>`;
const html = `<div class="se-main-container"><p>보존할 안내 문구 &amp; 배송 안내</p>${imageBlock('one', 'https://img.example/one.jpg')}<iframe src="https://video.example/embed"></iframe>${imageBlock('two', 'https://img.example/two.jpg')}<p>보존할 고지</p></div>`;
function fixture() {
  return {
    originProduct: {
      name: '기존 상품', statusType: 'SALE', saleType: 'NEW', leafCategoryId: '50000000',
      detailContent: html, salePrice: 10000, stockQuantity: 5,
      images: { representativeImage: { url: 'https://img.example/representative.jpg' } },
      deliveryInfo: { deliveryType: 'DELIVERY', deliveryFee: { deliveryFeeType: 'FREE' } },
      customerBenefit: { immediateDiscountPolicy: { discountMethod: { value: 1, unitType: 'PERCENT' } } },
      detailAttribute: {
        seoInfo: { pageTitle: '보존할 검색 제목' },
        optionInfo: { useStockManagement: true, optionCombinationSortType: 'CREATE',
          optionCombinationGroupNames: { optionGroupName1: '브랜드', optionGroupName2: '차종' },
          optionCombinations: [{ id: 501, optionName1: '현대', optionName2: '싼타페', price: 0, stockQuantity: 5, usable: true, sellerManagerCode: 'KEEP', skuYn: true }]
        }
      }
    },
    smartstoreChannelProduct: { naverShoppingRegistration: true, channelProductDisplayStatusType: 'ON' }
  };
}
const clone = obj => JSON.parse(JSON.stringify(obj));

test('API 원상품 응답을 기존 편집 화면의 옵션·이미지 계약으로 변환한다', async () => {
  const api = { originProduct: async no => { assert.equal(no, '10921625803'); return fixture(); } };
  const result = await new NaverProducts(api).loadProductForEdit('10921625803');
  assert.equal(result.originNo, '10921625803');
  assert.deepEqual(result.groups, ['브랜드', '차종']);
  assert.deepEqual(result.options[0].names, ['현대', '싼타페']);
  assert.equal(result.options[0].id, 501);
  assert.equal(result.detailImages.length, 2);
  assert.equal(result.revision.length, 64);
});

test('상품번호가 잘못됐으면 인증·조회 요청을 시작하지 않는다', async () => {
  const editor = new NaverProducts({ originProduct: () => assert.fail('network') });
  for (const no of ['', '../1', '1/2', '1?x=2', '9007199254740993']) await assert.rejects(editor.loadProductForEdit(no), /상품번호/);
});

test('원상품 404에서만 채널번호를 정확히 매칭해 원상품을 조회한다', async () => {
  const calls = [];
  const editor = new NaverProducts({
    originProduct: async no => { calls.push(no); if (no === '900') throw new NaverAPIError(404, { code: 'NOT_FOUND' }); return fixture(); },
    searchProducts: async query => {
      assert.deepEqual(query.channelProductNos, [900]);
      assert.equal(query.searchKeywordType, 'CHANNEL_PRODUCT_NO');
      return { contents: [
        { originProductNo: 888, channelProducts: [{ channelProductNo: 901 }] },
        { originProductNo: 777, channelProducts: [{ channelProductNo: 900 }] }
      ] };
    }
  });
  const product = await editor.loadProductForEdit('900');
  assert.equal(product.originNo, '777');
  assert.deepEqual(calls, ['900', '777']);
});

test('인증·프록시·네트워크 실패를 다른 번호 조회나 브라우저 재시도로 바꾸지 않는다', async () => {
  for (const error of [new NaverAPIError(403, { code: 'FORBIDDEN' }), new Error('network'), Object.assign(new Error('proxy missing'), { status: 404, proxyError: true })]) {
    const editor = new NaverProducts({ originProduct: async () => { throw error; }, searchProducts: () => assert.fail('fallback') });
    await assert.rejects(editor.loadProductForEdit('123'), e => e === error);
  }
});

test('채널번호 검색에서 정확한 번호가 없으면 첫 번째 다른 상품을 사용하지 않는다', async () => {
  const editor = new NaverProducts({
    originProduct: async () => { throw new NaverAPIError(404, { code: 'NOT_FOUND' }); },
    searchProducts: async () => ({ contents: [{ originProductNo: 12, channelProducts: [{ channelProductNo: 34 }] }] })
  });
  await assert.rejects(editor.loadProductForEdit('99'), /찾을 수 없습니다/);
});

test('이미지를 바꾸지 않으면 텍스트·스크립트·영상 포함 HTML이 바이트 단위로 보존된다', () => {
  const images = extractNaverDetailImages(html);
  assert.equal(replaceNaverDetailImages(html, images), html);
  const misleading = '<script>"<img src=\"https://fake.example/x\">"</script><!-- <img src="fake"> --><img src="https://img.example/a?x=1&amp;y=2">';
  assert.equal(extractNaverDetailImages(misleading).length, 1);
  assert.equal(extractNaverDetailImages(misleading)[0].url, 'https://img.example/a?x=1&y=2');
});

test('이미지 순서 변경은 SmartEditor 이미지 블록 전체를 옮기고 다른 내용은 보존한다', () => {
  const [one, two] = extractNaverDetailImages(html);
  const result = replaceNaverDetailImages(html, [two, one]);
  assert.ok(result.includes(imageBlock('one', 'https://img.example/one.jpg')));
  assert.ok(result.includes(imageBlock('two', 'https://img.example/two.jpg')));
  assert.ok(result.indexOf('id="two"') < result.indexOf('id="one"'));
  assert.ok(result.includes('<iframe src="https://video.example/embed"></iframe>'));
  assert.ok(result.includes('보존할 안내 문구 &amp; 배송 안내'));
  assert.ok(result.includes('보존할 고지'));
});

test('이미지 추가·삭제에도 다른 내용은 보존하고 잘못된 URL·오래된 ID는 거부한다', () => {
  const [one] = extractNaverDetailImages(html);
  const result = replaceNaverDetailImages(html, [{ isNew: true, url: 'https://img.example/new.jpg' }, one]);
  assert.ok(result.includes('new.jpg'));
  assert.ok(!result.includes('two.jpg'));
  assert.ok(result.includes('보존할 고지'));
  assert.throws(() => replaceNaverDetailImages(html, [{ isNew: true, url: 'javascript:alert(1)' }]), /HTTP/);
  assert.throws(() => replaceNaverDetailImages(html, [{ ...one, id: 'unknown' }]), /다시 불러와/);
  assert.throws(() => replaceNaverDetailImages(html, [one, one]), /다시 불러와/);
});

test('상품명·옵션 수정은 배송·할인·대표이미지·채널 속성을 보존한다', () => {
  const original = fixture(), before = clone(original);
  const form = naverEditProduct(original, '123');
  form.title = '수정 상품';
  form.options[0].stockQuantity = 0;
  form.options.push({ isNew: true, names: ['현대', '투싼'], price: 1000, stockQuantity: 3, usable: true });
  const next = buildNaverProductUpdate(original, form);
  assert.deepEqual(original, before, '원본을 변경하지 않는다');
  assert.deepEqual(next.originProduct.deliveryInfo, before.originProduct.deliveryInfo);
  assert.deepEqual(next.originProduct.customerBenefit, before.originProduct.customerBenefit);
  assert.deepEqual(next.originProduct.images, before.originProduct.images);
  assert.deepEqual(next.smartstoreChannelProduct, before.smartstoreChannelProduct);
  assert.equal(next.originProduct.detailContent, html);
  assert.equal(next.originProduct.stockQuantity, 3);
  const options = next.originProduct.detailAttribute.optionInfo.optionCombinations;
  assert.equal(options[0].id, 501);
  assert.equal(options[0].sellerManagerCode, 'KEEP');
  assert.equal(options[0].stockQuantity, 0);
  assert.equal(options[1].id, undefined);
  assert.equal(options[1].sellerManagerCode, undefined);
  assert.equal(options[1].skuYn, undefined);
});

test('잘못된 옵션 ID·재고·중복 조합을 저장 전에 거부한다', () => {
  const original = fixture();
  const form = naverEditProduct(original, '123');
  assert.throws(() => buildNaverProductUpdate(original, { options: [] }), /모두 삭제/);
  assert.throws(() => buildNaverProductUpdate(original, { options: [{ ...form.options[0], id: 999 }] }), /기존 옵션/);
  assert.throws(() => buildNaverProductUpdate(original, { options: [{ ...form.options[0], stockQuantity: -1 }] }), /재고/);
  assert.throws(() => buildNaverProductUpdate(original, { options: [form.options[0], { ...form.options[0], isNew: true }] }), /중복/);
});

test('표준형·단독형 옵션과 이미지가 없는 상세설명은 그대로 보존한다', () => {
  const original = fixture();
  original.originProduct.detailAttribute.optionInfo = { optionSimple: [{ id: 7, groupName: '색상', name: '검정', usable: true }] };
  original.originProduct.detailContent = '<p>텍스트만 있는 설명</p>';
  const form = naverEditProduct(original, '123');
  assert.match(form.optionNotice, /유지/);
  assert.deepEqual(buildNaverProductUpdate(original, form), original);
});

test('수정은 API PUT 후 조회로 확인하고, 새 옵션 ID와 revision을 화면에 반환한다', async () => {
  let body = fixture();
  const writes = [];
  let invalidations = 0;
  const editor = new NaverProducts({
    originProduct: async () => clone(body),
    request: async (method, path, payload) => {
      writes.push({ method, path }); body = clone(payload);
      body.originProduct.detailAttribute.optionInfo.optionCombinations.forEach((o, i) => { o.id ||= 600 + i; });
      return {};
    }, invalidateProducts: () => invalidations++
  });
  const form = await editor.loadProductForEdit('123');
  form.options.push({ isNew: true, names: ['현대', '투싼'], stockQuantity: 2, price: 0 });
  const result = await editor.updateProduct(form);
  assert.deepEqual(writes, [{ method: 'PUT', path: '/v2/products/origin-products/123' }]);
  assert.equal(invalidations, 1);
  assert.equal(result.product.options[1].isNew, false);
  assert.equal(result.product.options[1].id, 601);
  assert.notEqual(result.product.revision, form.revision);
});

test('다른 곳에서 수정한 상품은 덮어쓰지 않는다', async () => {
  const original = fixture(), changed = fixture(); changed.originProduct.salePrice = 30000;
  const editor = new NaverProducts({ originProduct: async () => changed, request: () => assert.fail('write') });
  await assert.rejects(editor.updateProduct(naverEditProduct(original, '123')), /다른 곳에서 변경/);
});

test('응답 유실·확인 조회 실패에서 PUT이나 브라우저 저장을 재전송하지 않는다', async () => {
  for (const writeFailure of [true, false]) {
    let reads = 0, writes = 0;
    const editor = new NaverProducts({
      originProduct: async () => { if (++reads > 1) throw new Error('read timeout'); return fixture(); },
      request: async () => { writes++; if (writeFailure) throw new Error('write timeout'); return {}; }, invalidateProducts() {}
    });
    await assert.rejects(editor.updateProduct({ originNo: '123', title: '변경' }), writeFailure ? /write timeout/ : /다시 저장하지 말고/);
    assert.equal(writes, 1);
  }
});

test('실제 API 전송 계층에서 직원 프록시로 원상품을 읽으며 브라우저가 필요 없다', async () => {
  const calls = [];
  const api = new NaverAPI({}, { proxy: { proxyUrl: 'https://admin.example', proxyToken: 'staff' }, fetchImpl: async (url, options) => {
    calls.push({ url, options }); return new Response(JSON.stringify(fixture()), { status: 200 });
  } });
  api.accessToken = 'naver-access'; api.expiresAt = Date.now() + 60000;
  const product = await new NaverProducts(api).loadProductForEdit('123');
  assert.equal(product.options.length, 1);
  assert.equal(calls[0].url, 'https://admin.example/naver');
  const envelope = JSON.parse(calls[0].options.body);
  assert.equal(envelope.method, 'GET');
  assert.equal(envelope.path, '/external/v2/products/origin-products/123');
  assert.equal(envelope.headers.Authorization, 'Bearer naver-access');
});

test('실제 상품 불러오기·저장 IPC는 닫힌 브라우저에 접근하지 않는다', async () => {
  const source = fs.readFileSync(new URL('../src/main_process.js', import.meta.url), 'utf8');
  const start = source.indexOf("ipcMain.handle('smartstore-load-product'");
  const end = source.indexOf('// 쿠팡 기존 상품 불러오기', start);
  assert.ok(start > 0 && end > start);
  const handlers = new Map(), editor = new NaverProducts({ originProduct: async () => fixture() });
  const form = await editor.loadProductForEdit('123');
  const context = vm.createContext({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    getNaverProducts: () => ({ loadProductForEdit: no => editor.loadProductForEdit(no), updateProduct: async data => ({ product: data, verified: '확인' }) }),
    getBrowser: () => assert.fail('closed browser accessed'), getNaverEdit: () => assert.fail('browser editor accessed'),
    sendToUI() {}, console: { error() {} }
  });
  vm.runInContext(source.slice(start, end), context);
  assert.equal((await handlers.get('smartstore-load-product')({}, '123')).success, true);
  assert.equal((await handlers.get('smartstore-update-product')({}, form)).success, true);
  context.getNaverProducts = () => { throw new Error('API credentials missing'); };
  const failure = await handlers.get('smartstore-load-product')({}, '123');
  assert.equal(failure.success, false);
  assert.equal(failure.error, 'API credentials missing');
});
