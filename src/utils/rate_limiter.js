// 플랫폼 API 호출 간격 조절 — 이 PC(메인 프로세스)에서 나가는 호출을 한 줄로 세운다.
//
// 사연
//   일괄 수정·단일 수정·등록이 각자 API 를 불러서, 한 PC 에서도 같은 API 가 1초에 여러 번 나갔다.
//   네이버 '내 스토어' 앱은 API별 2RPS(초과 시 처리하지 않고 429), 쿠팡은 vendorId 당 초당 5회
//   (넘으면 수 분~수십 분 차단), 아마존 Listings 는 초당 5회다. 렌더러의 고정 대기(550/650ms)는
//   한 행 안의 여러 호출을 막지 못했다. 클라이언트가 요청을 보내기 직전에 여기서 순서를 받는다.
//
//   여러 직원이 같은 앱 키를 나눠 쓰는 한도는 서버 프록시(server/proxy.py)가 한 번 더 조절한다.
//   여기서는 한 PC 가 혼자서 한도를 넘지 않게만 한다.

import { apiError } from './api_error.js';

// 플랫폼별 최소 호출 간격(ms). 공식 한도보다 조금 느리게 잡는다.
export const CALL_GAP_MS = {
  naver: 550,     // API별 2RPS → 약 1.8RPS
  coupang: 250,   // vendorId 당 5RPS → 4RPS
  amazon: 220,    // Listings Items 5RPS → 약 4.5RPS
};

const nextAt = new Map();        // key → 다음 호출을 보낼 수 있는 시각
const coolUntil = new Map();     // key → 이 시각까지는 보내지 않고 바로 알린다(429 차단 중)

/** 경로의 숫자·ID 부분을 지워 'API 하나'를 나타내는 키로 만든다. 쿼리는 버린다. */
export function apiTemplate(pathOrUrl) {
  let p = String(pathOrUrl || '');
  try { if (/^https?:\/\//i.test(p)) p = new URL(p).pathname; } catch { /* 경로 그대로 쓴다 */ }
  return p.split('?')[0].split('/').map(seg => (/^\d+$/.test(seg) || /^[A-Z0-9]{10,}$/.test(seg) ? '{id}' : seg)).join('/');
}

/**
 * key 에 대해 간격을 지켜 차례를 기다린다. 예약은 부르는 순서대로 쌓이므로 동시에 불러도 겹치지 않는다.
 * @param {string} key          예) 'naver:/v2/products/origin-products/{id}', 'coupang:A00012345'
 * @param {number} gapMs
 * @param {{sleep?: Function, now?: Function, label?: string}} [opts]
 */
export async function paceCall(key, gapMs, { sleep = ms => new Promise(r => setTimeout(r, ms)), now = Date.now, label = '' } = {}) {
  const t = now();
  const until = coolUntil.get(key) || 0;
  if (until > t) {
    const sec = Math.ceil((until - t) / 1000);
    throw apiError(`${label || key} 호출 한도를 넘어 잠시 멈춘 상태입니다. ${sec}초 뒤 다시 시도해주세요.`, { status: 429 });
  }
  const at = Math.max(t, nextAt.get(key) || 0);
  nextAt.set(key, at + gapMs);
  if (at > t) await sleep(at - t);
}

/** 플랫폼이 429 로 막았을 때, 이 PC 에서 같은 key 호출을 ms 동안 바로 거절하게 한다. */
export function coolDown(key, ms, { now = Date.now } = {}) {
  coolUntil.set(key, Math.max(coolUntil.get(key) || 0, now() + ms));
}

/** 테스트용 초기화. */
export function resetPacing() {
  nextAt.clear();
  coolUntil.clear();
}
