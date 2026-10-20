import { parseFragment } from 'parse5';

// Bundled HTML keeps the default list available without local image folders or
// an ESM login/listing request. Public image URLs verified on 2026-09-28.
const hostedHtml = (folder, names) => names.map(name =>
  `<p><img src="https://ai.esmplus.com/yhshma/${['기본값', folder, name].map(encodeURIComponent).join('/')}" /></p>`
).join('\n');

export const DEFAULT_IMAGE_HTML = Object.freeze({
  domestic: hostedHtml('스마트스토어 상세페이지', Array.from({ length: 6 }, (_, i) => `${i}.jpg`)),
  amazon: hostedHtml('아마존 영어 번역', [
    '71iShdvWLtL.jpg', '71jcnyaxoGL.jpg', '81440WRxehL.jpg',
    '815LUazWwqL.jpg', '81BWjqtdwdL.jpg', '81yGj-TNFpL.jpg',
  ]),
  ebay: hostedHtml('이베이 영어 번역', Array.from({ length: 7 }, (_, i) => `${i + 1}.jpg`)),
});

export function esmImagesFromHtml(html) {
  const urls = [];
  function visit(node) {
    if (node.tagName === 'img') {
      const src = node.attrs?.find(a => a.name === 'src')?.value?.trim();
      let url;
      try { url = new URL(src); } catch { throw new Error('이미지 HTML에 올바른 ESM 이미지 주소를 넣어주세요.'); }
      if (url.protocol !== 'https:' || url.hostname !== 'ai.esmplus.com' || url.username || url.password || url.port) {
        throw new Error('이미지 HTML에는 https://ai.esmplus.com 이미지 주소를 사용해주세요.');
      }
      if (!urls.includes(url.href)) urls.push(url.href);
    }
    for (const child of node.childNodes || []) visit(child);
  }
  visit(parseFragment(String(html || '')));
  if (!urls.length) throw new Error('ESM 이미지의 <img src="…"> HTML을 넣어주세요.');
  return urls;
}
