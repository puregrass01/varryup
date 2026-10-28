import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { DEFAULT_IMAGE_HTML, esmImagesFromHtml } from './image_defaults.js';
import { writeJsonAtomic } from './json_file.js';

const IMAGE_EXT = /\.(jpe?g|png|gif|webp)$/i;
export const MAX_URL = 200;   // 쿠팡 업체이미지경로 최대 길이 — 몰 가운데 가장 짧다
const LABELS = { domestic: '네이버 · 쿠팡 · 아임웹', amazon: 'Amazon', ebay: 'eBay' };
const hash = value => createHash('sha256').update(value).digest('hex');
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const imageHtml = urls => [...new Set(urls.filter(Boolean))].map(url => `<p><img src="${escape(url)}" style="max-width:100%;height:auto" /></p>`).join('\n');

export function imageDefaults(downloads, output) {
  const base = path.join(downloads, '20260923');
  return {
    domestic: { detailSource: 'esm', detailHtml: DEFAULT_IMAGE_HTML.domestic, thumbnail: path.join(base, '옵틱글래스 상세페이지', '썸네일', '이베이 썸네일', '썸네일.jpg'), seed: false },
    amazon: { detailSource: 'esm', detailHtml: DEFAULT_IMAGE_HTML.amazon, thumbnail: path.join(output, 'latest_global.jpg'), seed: true },
    ebay: { detailSource: 'esm', detailHtml: DEFAULT_IMAGE_HTML.ebay, thumbnail: path.join(output, 'latest_global.jpg'), seed: true },
  };
}

export function esmCandidates(file, profile) {
  const name = path.basename(file);
  const folders = profile.folder ? [path.basename(profile.folder)] : [];
  if (folders[0] === '아마존 영어 번역') folders.push('아마존');
  if (folders[0] === '이베이 영어 번역') folders.push('이베이');
  const paths = folders.map(folder => [folder, name]);
  if (name === '썸네일.jpg') paths.unshift(['옵틱글래스 상세페이지', '썸네일', '이베이 썸네일', name]);
  return paths.map(parts => `https://ai.esmplus.com/yhshma/${parts.map(encodeURIComponent).join('/')}`);
}

// Only an actual image response is accepted. Existing named assets are reused only
// when their bytes match the selected file; identical filenames are not identities.
export async function inspectHostedImage(url, expectedHash, fetcher = fetch) {
  const u = new URL(url);
  if (u.protocol !== 'https:' || u.hostname !== 'ai.esmplus.com' || u.username || u.password || u.port) return false;
  const response = await fetcher(u.href, { method: expectedHash ? 'GET' : 'HEAD', redirect: 'error', signal: AbortSignal.timeout(15000) });
  if (!response.ok || !/^image\//i.test(response.headers.get('content-type') || '')) return false;
  if (!expectedHash) return true;
  const limit = 20 * 1024 * 1024;
  if (Number(response.headers.get('content-length')) > limit) return false;
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) { await response.body.cancel?.().catch(() => {}); return false; }
    chunks.push(chunk);
  }
  return hash(Buffer.concat(chunks)) === expectedHash;
}

export class ImageLibrary {
  constructor({ userData, downloads, output, upload, inspect = inspectHostedImage }) {
    this.file = path.join(userData, 'image-library.json');
    this.staging = path.join(userData, 'image-library-uploads');
    this.defaults = imageDefaults(downloads, output);
    this.upload = upload; this.inspect = inspect; this.busy = false;
    this.state = { profiles: {}, hosted: {} };
    if (fs.existsSync(this.file)) {
      try { this.state = JSON.parse(fs.readFileSync(this.file, 'utf8')); }
      catch { throw new Error('이미지 설정 파일을 읽을 수 없습니다. image-library.json을 확인해주세요.'); }
    }
    this.state.profiles ||= {}; this.state.hosted ||= {};
  }
  profile(id) {
    if (!Object.hasOwn(this.defaults, id)) throw new Error('지원하지 않는 이미지 목록입니다.');
    const p = { ...this.defaults[id], ...this.state.profiles[id] };
    if (p.seed) p.thumbnail = this.defaults[id].thumbnail;
    return p;
  }
  persist() {
    writeJsonAtomic(this.file, this.state, 2);
  }
  configure(id, changes) {
    if (this.busy) throw new Error('호스팅 작업이 끝난 뒤 설정을 바꿔주세요.');
    const p = this.profile(id);
    if (Object.hasOwn(changes, 'detailHtml')) esmImagesFromHtml(changes.detailHtml);
    // ESM 호스팅 창에서 끌어다 놓거나 붙여 넣은 주소: 지금 HTML 끝에 붙인다. 이미 있으면 건너뛰고, 제외해 둔 것은 다시 고른다.
    if (changes.addDetails) {
      if (p.detailSource !== 'esm') throw new Error('ESM 상세 목록에서만 이미지를 추가할 수 있습니다.');
      const add = esmImagesFromHtml(imageHtml(changes.addDetails)), have = esmImagesFromHtml(p.detailHtml);
      const fresh = add.filter(u => !have.includes(u));
      if (fresh.length) p.detailHtml += '\n' + imageHtml(fresh);
      p.excluded = (p.excluded || []).filter(u => !add.includes(u));
    }
    for (const key of ['folder', 'thumbnail', 'seed', 'excluded', 'order', 'detailHtml']) {
      if (Object.hasOwn(changes, key)) p[key] = changes[key];
    }
    // Local folders remain an explicit compatibility option, never the default.
    if (Object.hasOwn(changes, 'folder')) { p.detailSource = 'local'; p.excluded = []; p.order = []; }
    if (Object.hasOwn(changes, 'detailHtml') || changes.resetDetails) {
      p.detailSource = 'esm'; p.folder = ''; p.order = [];
      if (changes.resetDetails) { p.detailHtml = this.defaults[id].detailHtml; p.excluded = []; }
      else {
        // 편집기는 목록 순서(끌어 옮긴 순서)로 열리니(ui/image-library.js) 저장한 HTML 의 줄 순서가 곧 목록 순서다.
        // 체크 해제는 남아 있는 이미지 것만 지킨다.
        const kept = new Set(esmImagesFromHtml(p.detailHtml));
        p.excluded = (p.excluded || []).filter(u => kept.has(u));
      }
    }
    this.state.profiles[id] = p; this.persist();
    return this.scan(id);
  }
  scan(id) {
    const p = this.profile(id), errors = [];
    let files = [];
    if (p.detailSource === 'esm') {
      try { files = esmImagesFromHtml(p.detailHtml); }
      catch (e) { errors.push(e.message); }
    } else {
      try { files = fs.readdirSync(p.folder, { withFileTypes: true }).filter(f => f.isFile() && IMAGE_EXT.test(f.name)).map(f => path.join(p.folder, f.name)); }
      catch { errors.push('선택한 폴더를 찾을 수 없습니다. ESM 기본값으로 복원해주세요.'); }
      const collator = new Intl.Collator('ko', { numeric: true });
      files.sort((a, b) => collator.compare(path.basename(a), path.basename(b)));
    }
    const order = p.order || [];
    files.sort((a, b) => (order.includes(a) ? order.indexOf(a) : order.length) - (order.includes(b) ? order.indexOf(b) : order.length));
    const paths = [p.thumbnail, ...files.filter(f => f !== p.thumbnail)];
    const items = paths.map((file, i) => {
      const base = { path: file, name: path.basename(file), role: i === 0 ? '대표' : '상세', selected: i === 0 || !(p.excluded || []).includes(file) };
      if (i > 0 && p.detailSource === 'esm') {
        let name = new URL(file).pathname.split('/').pop();
        try { name = decodeURIComponent(name); } catch {}
        return { ...base, name, source: 'esm', previewUrl: file, url: file };
      }
      try {
        const stat = fs.statSync(file);
        if (!stat.isFile() || !IMAGE_EXT.test(file) || stat.size > 20 * 1024 * 1024) throw new Error('지원 형식: JPG/PNG/GIF/WebP, 최대 20MB');
        const sha = hash(fs.readFileSync(file));
        return { ...base, hash: sha, size: stat.size, modified: stat.mtime.toISOString(), previewUrl: pathToFileURL(file).href, url: this.state.hosted[sha]?.url || '' };
      } catch (e) { return { ...base, error: i === 0 ? '대표 이미지가 없습니다. VerySeed에서 GLOBAL 사진을 만들거나 대표 선택을 눌러주세요.' : e.message }; }
    });
    if (!files.length && p.detailSource !== 'esm') errors.push('이 폴더에 상세 이미지가 없습니다. 하위 폴더는 포함하지 않습니다.');
    const signature = hash(JSON.stringify(items.filter(i => i.selected).map(i => [i.path, i.hash])));
    return { id, label: LABELS[id], ...p, items, errors, signature };
  }
  async prepare(id, onProgress = () => {}) {
    if (this.busy) throw new Error('다른 이미지 호스팅 작업이 진행 중입니다.');
    this.busy = true;
    try {
      const snapshot = this.scan(id), selected = snapshot.items.filter(i => i.selected);
      if (snapshot.errors.length) throw new Error(snapshot.errors.join(' '));
      const bad = selected.find(i => i.error); if (bad) throw new Error(bad.error);
      if (id === 'amazon' && selected.length > 9) throw new Error('Amazon은 대표 1장과 추가 최대 8장입니다. 목록에서 선택을 줄여주세요.');
      if (id === 'ebay' && selected.length > 24) throw new Error('eBay 상품 사진은 최대 24장입니다. 목록에서 선택을 줄여주세요.');
      for (const [i, item] of selected.entries()) {
        onProgress(`${snapshot.label} ${i + 1}/${selected.length} · ${item.name}`);
        if (item.source === 'esm') {
          if (!(await this.inspect(item.url).catch(() => false))) {
            throw new Error(item.name + ': ESM 이미지에 연결하지 못했습니다. 기본 목록은 유지됩니다. 잠시 후 다시 적용해주세요.');
          }
          continue;
        }
        // 쿠팡은 이미지 주소(업체이미지경로)를 200자까지만 받는다. 한글 폴더 · 파일 이름은 %XX 로 세 배가 돼
        // ('…/옵틱글래스 상세페이지/썸네일/이베이 썸네일/썸네일.jpg' = 241자) 넘으니, 긴 주소는 다시 쓰지 않고 짧은 이름(vu_해시)으로 올린다.
        const short = u => u && u.length <= MAX_URL;
        let url = short(item.url) ? item.url : '';
        if (url && !(await this.inspect(url).catch(() => false))) url = '';
        if (!url) {
          for (const candidate of esmCandidates(item.path, snapshot).filter(short)) {
            if (await this.inspect(candidate, item.hash).catch(() => false)) { url = candidate; break; }
          }
        }
        if (!url) {
          // Content-specific names prevent latest_global.jpg and common 1.jpg files
          // from overwriting the pictures of already-published products.
          fs.mkdirSync(this.staging, { recursive: true });
          const uploadFile = path.join(this.staging, `vu_${item.hash}${path.extname(item.path).toLowerCase()}`);
          fs.copyFileSync(item.path, uploadFile);
          if (hash(fs.readFileSync(uploadFile)) !== item.hash) throw new Error('이미지가 변경됐습니다. 새로고침 후 다시 적용해주세요.');
          url = await this.upload(uploadFile);
          if (!(await this.inspect(url))) throw new Error(`${item.name}: 호스팅 이미지 응답을 확인하지 못했습니다.`);
          if (!short(url)) throw new Error(`${item.name}: 호스팅 주소가 ${url.length}자라 쿠팡 한도(${MAX_URL}자)를 넘습니다 — ESM 업로드 폴더 이름을 줄여 주세요.`);
        }
        this.state.hosted[item.hash] = { url, checkedAt: new Date().toISOString() };
        this.persist(); item.url = url;
      }
      if (this.scan(id).signature !== snapshot.signature) throw new Error('이미지 목록이 변경됐습니다. 새로고침 후 다시 적용해주세요.');
      const urls = selected.map(i => i.url);
      return { profile: this.scan(id), bundle: { signature: snapshot.signature, mainImagePath: selected[0].path, mainImageUrl: urls[0], imageUrls: [...new Set(urls)], subImages: [...new Set(urls.slice(1))].filter(u => u !== urls[0]), detailHtml: imageHtml(urls.slice(1)) } };
    } finally { this.busy = false; }
  }
}
