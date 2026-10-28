import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { NaverAPI, NaverAPIError } from '../src/platforms/naver_api.js';
import os from 'node:os';
import path from 'node:path';
import { NaverProducts, naverEditProduct, buildNaverProductUpdate, extractNaverDetailImages, replaceNaverDetailImages, buildNaverCopyProduct, insertNaverDetail } from '../src/platforms/naver_products.js';

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

// ── 신규 복사등록 (커머스API) ──────────────────────────────────────
function copyTemplate() {
  const body = fixture();
  body.originProduct.name = '템플릿 상품';
  body.originProduct.statusType = 'SUSPENSION';
  body.originProduct.detailAttribute.optionInfo = {
    useStockManagement: true, optionCombinationSortType: 'CREATE',
    optionCombinationGroupNames: { optionGroupName1: '모델명', optionGroupName2: '상품선택', optionGroupName3: '운전석/조수석' },
    optionCombinations: [{ id: 7, optionName1: '그랜저 IG', optionName2: '광각', optionName3: '운전석', price: 0, stockQuantity: 3, usable: true }]
  };
  body.smartstoreChannelProduct.channelProductName = '템플릿 채널 상품명';
  // 조회 응답에만 있는 필드와 템플릿 카탈로그 연결
  body.groupProduct = { groupProductNo: 1 };
  body.windowChannelProduct = { channelNo: 2 };
  body.originProduct.customerBenefit.promotionDiscountPolicies = [{ value: 1 }];
  body.originProduct.detailAttribute.naverShoppingSearchInfo = { modelId: 99, catalogMatchingYn: true, matchedCatalogId: 98, manufacturerName: '옵틱글래스' };
  return body;
}
const copyData = (extra = {}) => ({
  templateId: '111', category: '자동차', title: '옵틱글래스 현대 싼타페 TM 와이드미러', price: '99000', stock: '',
  optionModel: '싼타페 TM 2018~', optionProduct: "'18-'20[No.1234], '21-'23[No.1235] BSA", optionSeat: '운전석,조수석', esmHtml: 'https://ai.esmplus.com/x/new.jpg', ...extra
});
const imageUrls = h => [...h.matchAll(/<img[^>]*src="([^"]+)"/g)].map(m => m[1]);

test('복사등록 본문: 상품명·판매가·옵션 조합·조수석 할인·재고를 바꾸고 나머지는 템플릿을 보존한다', () => {
  const template = copyTemplate();
  const before = clone(template);
  const body = buildNaverCopyProduct(template, copyData());
  assert.deepEqual(template, before, '템플릿 응답을 바꾸지 않는다');
  const p = body.originProduct;
  assert.equal(p.name, '옵틱글래스 현대 싼타페 TM 와이드미러');
  assert.equal(p.salePrice, 99000);
  assert.equal(p.statusType, 'SALE');
  const combos = p.detailAttribute.optionInfo.optionCombinations;
  assert.deepEqual(combos.map(o => [o.optionName1, o.optionName2, o.optionName3, o.price, o.stockQuantity]), [
    ['싼타페 TM 2018~', "'18-'20[No.1234]", '운전석', 0, 999],
    ['싼타페 TM 2018~', "'18-'20[No.1234]", '조수석', -10000, 999],
    ['싼타페 TM 2018~', "'21-'23[No.1235] BSA", '운전석', 0, 999],
    ['싼타페 TM 2018~', "'21-'23[No.1235] BSA", '조수석', -10000, 999],
  ]);
  assert.ok(combos.every(o => !('id' in o)), '템플릿 옵션 ID 를 새 상품에 보내지 않는다');
  assert.equal(p.stockQuantity, 999 * 4);
  assert.deepEqual(p.deliveryInfo, before.originProduct.deliveryInfo);
  assert.deepEqual(p.images, before.originProduct.images, '대표이미지 파일이 없으면 템플릿 이미지를 쓴다');
  assert.equal(body.smartstoreChannelProduct.channelProductName, undefined);
  assert.equal(body.smartstoreChannelProduct.channelProductDisplayStatusType, 'ON');
  assert.equal(body.groupProduct, undefined);
  assert.equal(body.windowChannelProduct, undefined);
  assert.equal(p.customerBenefit.promotionDiscountPolicies, undefined);
  assert.deepEqual(p.customerBenefit.immediateDiscountPolicy, before.originProduct.customerBenefit.immediateDiscountPolicy);
  assert.deepEqual(p.detailAttribute.naverShoppingSearchInfo, { manufacturerName: '옵틱글래스' });

  const bike = buildNaverCopyProduct(copyTemplate(), copyData({ category: '오토바이', stock: '5', optionSeat: '' }));
  assert.deepEqual(bike.originProduct.detailAttribute.optionInfo.optionCombinations.map(o => [o.optionName3, o.price, o.stockQuantity]),
    [['운전석', 0, 5], ['운전석', 0, 5]], '비운 옵션 칸은 템플릿 값, 조수석 할인은 자동차만');
});

test('복사등록 상세: 첫 이미지를 지우고 자동차는 그 자리, 오토바이는 맨 위에 넣는다', () => {
  const car = insertNaverDetail(html, 'https://ai.esmplus.com/x/new.jpg', { category: '자동차' });
  assert.deepEqual(imageUrls(car), ['https://ai.esmplus.com/x/new.jpg', 'https://img.example/two.jpg']);
  assert.ok(car.startsWith('<div class="se-main-container"><p>보존할 안내 문구'), '자동차는 첫 이미지 자리에 넣는다');
  assert.ok(car.includes('<iframe src="https://video.example/embed"></iframe>') && !car.includes('"image":"one"'));
  const bike = insertNaverDetail(html, '<p><img src="https://ai.esmplus.com/x/a.jpg" /></p>', { category: '오토바이' });
  assert.ok(bike.startsWith('<p><img src="https://ai.esmplus.com/x/a.jpg" /></p><div class="se-main-container">'));
  assert.deepEqual(imageUrls(bike), ['https://ai.esmplus.com/x/a.jpg', 'https://img.example/two.jpg']);
  assert.equal(insertNaverDetail(html, '<img src="https://x/a.jpg">', { replaceAll: true }), '<img src="https://x/a.jpg">');
  assert.equal(insertNaverDetail('<p>글만</p>', 'https://x/a.jpg'), '<img src="https://x/a.jpg" /><p>글만</p>');
  assert.equal(insertNaverDetail(html, ''), html);
  // 이미지 목록 HTML(detailHtml)이 있으면 ESM HTML 과 합쳐 상세 전체를 바꾼다
  const full = buildNaverCopyProduct(copyTemplate(), copyData({ detailHtml: '<img src="https://x/d.jpg">' }));
  assert.equal(full.originProduct.detailContent, 'https://ai.esmplus.com/x/new.jpg\n<img src="https://x/d.jpg">');
});

test('복사등록: 옵션을 바꿀 수 없으면 등록 본문을 만들지 않는다 (템플릿 옵션이 붙은 상품 방지)', () => {
  assert.throws(() => buildNaverCopyProduct(copyTemplate(), copyData({ optionModel: ' ' })), /모델명/);
  assert.throws(() => buildNaverCopyProduct(copyTemplate(), copyData({ title: '' })), /상품명/);
  assert.throws(() => buildNaverCopyProduct(copyTemplate(), copyData({ price: '9,900' })), /정수/);
  assert.throws(() => buildNaverCopyProduct(fixture(), copyData()), /그룹이 2개라 "운전석\/조수석"/);
  const simple = copyTemplate();
  simple.originProduct.detailAttribute.optionInfo = { optionSimple: [{ groupName: '색상', name: '빨강' }] };
  assert.throws(() => buildNaverCopyProduct(simple, copyData()), /조합형 옵션이 없어/);
});

test('복사등록: 대표이미지를 네이버에 올린 주소로 바꾸고 새 상품을 등록한 뒤 상품 주소를 돌려준다', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naver-copy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'main.jpg');
  fs.writeFileSync(file, Buffer.from([0xff, 0xd8, 0xff]));
  const calls = [];
  const api = {
    originProduct: async no => { calls.push(['GET', no]); return copyTemplate(); },
    invalidateProducts: () => calls.push(['invalidate']),
    request: async (method, url, body) => {
      calls.push([method, url]);
      if (url === '/v1/product-images/upload') {
        assert.ok(body instanceof FormData);
        const image = body.get('imageFiles');
        assert.equal(image.name, 'main.jpg');
        assert.equal(image.type, 'image/jpeg');
        return { images: [{ url: 'https://shop-phinf.pstatic.net/main.jpg' }] };
      }
      assert.equal(body.originProduct.images.representativeImage.url, 'https://shop-phinf.pstatic.net/main.jpg');
      assert.equal(body.originProduct.name, copyData().title);
      return { originProductNo: 900, smartstoreChannelProductNo: 9222751781 };
    }
  };
  const products = new NaverProducts(api);
  const url = await products.copyRegister(copyData({ mainImagePath: file }));
  assert.equal(url, 'https://smartstore.naver.com/main/products/9222751781');
  assert.deepEqual(calls, [['GET', '111'], ['POST', '/v1/product-images/upload'], ['POST', '/v2/products'], ['invalidate']]);

  // 형식은 확장자가 아니라 내용으로 본다 — 이름만 .jpg 인 WebP 는 업로드·등록 전에 멈춘다
  const webp = path.join(dir, 'fake.jpg');
  fs.writeFileSync(webp, Buffer.from('RIFF0000WEBP'));
  calls.length = 0;
  await assert.rejects(products.copyRegister(copyData({ mainImagePath: webp })), /JPG·PNG·GIF·BMP/);
  assert.deepEqual(calls, [['GET', '111']]);
});

test('복사등록: 입력 오류는 이미지 업로드·등록 전에 멈추고, 채널번호 없는 응답은 성공으로 보지 않는다', async () => {
  const calls = [];
  const api = {
    originProduct: async () => copyTemplate(), invalidateProducts() {},
    request: async (method, url) => { calls.push(url); return { originProductNo: 900 }; }
  };
  const products = new NaverProducts(api);
  await assert.rejects(products.copyRegister(copyData({ templateId: 'abc' })), /숫자 상품번호/);
  await assert.rejects(products.copyRegister(copyData({ optionModel: '', mainImagePath: 'C:/none.jpg' })), /모델명/);
  assert.deepEqual(calls, []);
  await assert.rejects(products.copyRegister(copyData()), /채널상품번호가 없습니다 \(원상품 900\)/);
  assert.deepEqual(calls, ['/v2/products']);
  assert.equal(products.busy, false);
});

test('네이버 신규 등록 IPC 는 브라우저를 쓰지 않는다', () => {
  const source = fs.readFileSync(new URL('../src/main_process.js', import.meta.url), 'utf8');
  const start = source.indexOf("ipcMain.handle('naver-register'");
  const end = source.indexOf('// Coupang Handlers', start);
  assert.ok(start > 0 && end > start);
  assert.doesNotMatch(source.slice(start, end), /getBrowser|getNaver\(|login\(|copyAndRegisterProduct/);
  assert.match(source.slice(start, end), /copyRegister\(data\)/);
  assert.doesNotMatch(source, /naver_smartstore/);
});
