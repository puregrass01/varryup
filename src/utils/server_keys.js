// ─────────────────────────────────────────────────────────────
// 서버(관리자 서버)에서 인증키를 받아오는 유틸.
// - 앱은 이 모듈로 서버에 로그인(토큰) → 인증키를 받아온다.
// - 서버가 없거나 실패하면 예외를 던지므로, 호출부에서 try/catch 하여
//   "실패 시 기존 로컬 파일 사용"(fallback) 하도록 쓴다. → 앱이 절대 안 죽게.
// ─────────────────────────────────────────────────────────────

/** 서버에 직원 로그인 → 토큰 반환 */
export async function serverLogin(baseUrl, username, password) {
    const body = new URLSearchParams({ username, password });
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/login`, { method: 'POST', body });
    if (!res.ok) throw new Error(`서버 로그인 실패 (HTTP ${res.status})`);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || '로그인 실패');
    return { token: data.token, name: data.name, role: data.role };
}

/** 토큰으로 인증키(복호화된 값) 목록 조회. platform 지정 시 해당 플랫폼만.
 *  반환: [{ id, platform, label, data }]  (data = { ...키값 } 또는 null) */
export async function fetchCredentials(baseUrl, token, platform = null) {
    const base = baseUrl.replace(/\/+$/, '');
    const url = platform
        ? `${base}/api/credentials?platform=${encodeURIComponent(platform)}`
        : `${base}/api/credentials`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`인증키 조회 실패 (HTTP ${res.status})`);
    const data = await res.json();
    return data.credentials || [];
}

/** 특정 플랫폼의 첫 번째 인증키 값만 간편 조회 (없으면 null) */
export async function fetchOneCredential(baseUrl, token, platform) {
    const list = await fetchCredentials(baseUrl, token, platform);
    return list.length > 0 ? list[0].data : null;
}
