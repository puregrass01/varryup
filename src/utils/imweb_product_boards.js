import fs from 'node:fs';

// The same language-specific board mapping is used when registering products.
const mappingUrl = new URL('../../data/imweb_boards.json', import.meta.url);
const normalize = value => String(value || '').normalize('NFC').replace(/\s+/g, '').toLocaleLowerCase();

export function selectImwebProductBoards(boards, lang) {
  if (!['ko', 'en', 'jp'].includes(lang)) throw new Error('지원하지 않는 게시판 언어입니다.');
  if (!Array.isArray(boards)) throw new Error('게시판 목록 응답을 확인할 수 없습니다.');
  const { brands } = JSON.parse(fs.readFileSync(mappingUrl, 'utf8'));
  if (!brands || typeof brands !== 'object') throw new Error('상품 게시판 매핑을 확인할 수 없습니다.');
  const names = new Set(Object.values(brands).map(entry => entry[lang]).filter(Boolean).map(normalize));
  const seen = new Set();
  return boards.filter(board => {
    if (!board?.code || !names.has(normalize(board.name)) || seen.has(board.code)) return false;
    seen.add(board.code);
    return true;
  });
}

export function isImwebProductPost(post, boardCode) {
  if (!post?.code) return false;
  // Global notices may also be included in a product board response.
  if (['y', 'true', '1'].includes(String(post.is_notice ?? '').toLowerCase())) return false;
  if (post.board_code && String(post.board_code) !== String(boardCode)) return false;
  return true;
}
