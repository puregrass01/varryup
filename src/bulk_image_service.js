import { createHash } from 'node:crypto';
import { imagePolicy, parseImageUrls, sameImages, amazonImageUrls } from './utils/bulk_images.js';
import { inspectHostedImage } from './utils/image_library.js';
import { esmImagesFromHtml } from './utils/image_defaults.js';
import { markPreSend } from './utils/api_error.js';
import { isImwebBulkScope } from './imweb_bulk.js';

const markets = { 'amazon-us': 'ATVPDKIKX0DER', 'amazon-jp': 'A1VC38T7YXB528' };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// 가격 조회 응답에 이미 들어 있는 이미지로 미리보기/충돌검사 해시를 함께 만든다.
export function productImageState(scope, product) {
  let urls, revisionData;
  if (scope === 'naver') urls = product.detailImages?.map(x => x.url);
  else if (scope === 'coupang') { urls = product.detailImages?.map(x => x.url); revisionData = product.imageContents; if (!revisionData) return {}; }
  else if (markets[scope]) urls = amazonImageUrls(product, markets[scope]);
  else if (scope === 'ebay') urls = product.inventory?.product?.imageUrls || [];
  else if (isImwebBulkScope(scope)) urls = product.detailImages;   // 아임웹: 그 구역 상세설명의 이미지
  if (!Array.isArray(urls)) return {};
  const images = urls.map(x => String(x?.url ?? x));
  return { images, imageRevision: hash(revisionData || images), imagesReady: true, newImages: null };
}

export function createBulkImageService({ naverProducts, coupang, amazon, ebay, imwebBulk,
  inspect = inspectHostedImage, sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
  const configured = get => { const service = get(); service.loadConfig(); return service; };
  const identity = input => {
    imagePolicy(input.scope);
    const id = String(input.id ?? '').trim();
    if (!id) throw new Error('상품번호 또는 SKU가 없습니다.');
    return id;
  };
  async function read(input) {
    const id = identity(input), { scope } = input;
    let service, product, images, revisionData;
    if (scope === 'naver') {
      service = naverProducts(); product = await service.loadProductForEdit(id);
      images = product.detailImages.map(x => x.url); revisionData = images;
    } else if (scope === 'coupang') {
      service = configured(coupang);
      const raw = (await service.api.getProduct(id))?.data;
      if (!raw?.items?.length) throw new Error('쿠팡 상품의 이미지 정보를 확인할 수 없습니다.');
      product = raw;
      images = service._extractDetailImages(raw.items[0].contents).map(x => x.url);
      revisionData = raw.items.map(x => [x.sellerProductItemId, x.contents]);
    } else if (markets[scope]) {
      service = configured(amazon); product = await service.loadProductForEdit(id, markets[scope]);
      images = amazonImageUrls(product, markets[scope]); revisionData = images;
    } else if (scope === 'ebay') {
      service = ebay(); product = await service.load(id, { allowMigration: false });
      images = product.inventory.product?.imageUrls || []; revisionData = images;
    } else if (isImwebBulkScope(scope)) {
      // B2B몰 · 본사몰 구역 상품의 상세설명 이미지(Open API). 예전 본사 범위는 게시판 글이었다.
      service = imwebBulk; product = await imwebBulk.readImages(scope, id);
      images = product.images; revisionData = images;
    } else {
      throw new Error('지원하지 않는 플랫폼입니다.');
    }
    // Existing lists may exceed the input limit; never truncate them on read.
    images = images.map(x => String(x?.url ?? x));
    return { service, product, images, revision: hash(revisionData) };
  }
  async function load(input) {
    const { images, revision } = await read(input);
    return { images, revision, policy: imagePolicy(input.scope) };
  }
  async function validate({ scope, urls }, { checks = new Map() } = {}) {
    const images = parseImageUrls(urls, scope);
    let verified = 0;
    for (const url of new Set(images)) {
      if (new URL(url).hostname !== 'ai.esmplus.com') continue;
      if (!checks.has(url)) checks.set(url, Promise.resolve().then(() => inspect(url)));
      if (!await checks.get(url)) throw new Error('ESM 이미지에 접근할 수 없거나 이미지 응답이 아닙니다: ' + url);
      verified++;
    }
    return { images, verified };
  }
  async function importImages({ scope, input }) {
    const value = String(input ?? '').trim();
    const urls = /<img\b/i.test(value) ? esmImagesFromHtml(value) : parseImageUrls(value, scope);
    return validate({ scope, urls });
  }
  async function save(input, options = {}) {
    let current, images;
    try {
      identity(input);
      ({ images } = await validate(input, options));
      if (!input.expectedRevision) throw new Error('이미지를 먼저 불러오세요.');
      current = await read(input);
      if (current.revision !== input.expectedRevision) throw new Error('이미지가 조회 이후 변경됐습니다. 다시 불러온 뒤 수정하세요.');
    } catch (e) { throw markPreSend(e); }
    if (sameImages(current.images, images)) return { status: 'UNCHANGED', images, revision: current.revision };
    const { service, product } = current, { scope, id } = input;
    try {
      if (scope === 'naver') await service.updateProduct({ originNo: product.originNo, revision: product.revision,
        detailImages: images.map(url => ({ url, isNew: true })) });
      else if (scope === 'coupang') await service.updateBulkDetailImages({ productId: id, images, expectedContents: product.items.map(x => [x.sellerProductItemId, x.contents]) });
      else if (markets[scope]) {
        await service.updateExistingProduct({ sku: id, marketplaceId: markets[scope], replaceImageUrls: images, expectedImageUrls: current.images });
        return { status: 'ACCEPTED', message: '아마존 이미지 접수 완료 · 잠시 뒤 이미지를 다시 불러와 반영을 확인하세요.' };
      } else if (scope === 'ebay') await service.updateImages({ sku: id, images, expectedImages: current.images });
      else if (isImwebBulkScope(scope)) await service.saveImages(scope, id, images, product.content);
    } catch (e) { e.sent = true; throw e; }
    let message = '';
    for (const delay of [0, 1500]) {
      if (delay) await sleep(delay);
      try {
        const after = await load(input);
        if (sameImages(after.images, images)) return { status: 'VERIFIED', ...after };
        message = '조회된 이미지 목록이 입력값과 다릅니다.';
      } catch (e) { message = e.message; }
    }
    return { status: 'CHECK', message: '이미지 요청 후 확인 필요: ' + message + ' 다시 저장하기 전에 이미지를 불러오세요.' };
  }
  return { load, validate, importImages, save };
}
