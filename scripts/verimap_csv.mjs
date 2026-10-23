// 베리맵 스크립트가 같이 쓰는 CSV 읽기 — 따옴표 안의 쉼표 · 줄바꿈 · "" 를 처리한다.
// 쉼표로 그냥 자르면 상품명 · 옵션에 쉼표가 든 행이 밀려 상품ID 를 놓친다(10-23 match_확인필요.csv: 837개 중 81개).
// 머리행을 키로 한 객체 배열을 돌려준다. 앞의 BOM 과 \r 은 버리고, 빈 칸뿐인 행은 뺀다.
import fs from 'node:fs';

export function readCsv(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; }
      else cell += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  const head = rows.shift() || [];
  return rows.filter(r => r.some(c => String(c).trim() !== ''))
             .map(r => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}
