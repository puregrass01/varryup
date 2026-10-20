// 아임웹 OAuth 를 두 단계로 나눠 진행하는 도구. 앱을 띄우지 않는다.
//
// 1단계 — authorize URL 만들기 (브라우저로 열어야 한다)
//   $env:IMWEB_CLIENT_ID='...'; $env:IMWEB_SITE_CODE='...'
//   $env:IMWEB_REDIRECT_URI='https://admin.veryup-domain.duckdns.org/imweb/auth/accepted'
//   node tests/imweb-oauth.mjs
//
// 2단계 — 동의 후 주소창의 전체 URL 을 인수로 넘겨 토큰 교환
//   $env:IMWEB_CLIENT_SECRET='...'
//   node tests/imweb-oauth.mjs "https://.../imweb/auth/accepted?code=...&state=..."
//
// state 는 1단계가 찍어준 값을 IMWEB_STATE 로 넣으면 2단계에서 대조한다.
import { authorizeUrl, readCallback, exchangeCode, randomState, DEFAULT_SCOPES, IMWEB_BASE, TOKEN_PATH } from '../src/platforms/openapi/imweb_oauth.js';

const env = (n) => (process.env[n] || '').trim();
const callbackUrl = process.argv[2];

const clientId = env('IMWEB_CLIENT_ID');
const clientSecret = env('IMWEB_CLIENT_SECRET');
const siteCode = env('IMWEB_SITE_CODE');
const redirectUri = env('IMWEB_REDIRECT_URI');
const scopes = env('IMWEB_SCOPES') ? env('IMWEB_SCOPES').split(/[\s,]+/).filter(Boolean) : DEFAULT_SCOPES;

const mask = (s) => (!s ? '(없음)' : s.length <= 6 ? '***' : `${s.slice(0, 4)}…${s.slice(-2)}`);

if (!callbackUrl) {
  // ── 1단계 ──────────────────────────────────────────────────
  const missing = [];
  if (!clientId) missing.push('IMWEB_CLIENT_ID');
  if (!siteCode) missing.push('IMWEB_SITE_CODE');
  if (!redirectUri) missing.push('IMWEB_REDIRECT_URI');
  if (missing.length) {
    console.error(`환경변수가 없습니다: ${missing.join(', ')}`);
    console.error('스크립트 상단 주석의 실행 예시를 참고하세요.');
    process.exit(2);
  }
  if (!/^https:\/\//.test(redirectUri)) {
    console.error('redirectUri 는 https 여야 합니다(아임웹 권장).');
    process.exit(2);
  }
  // /login 은 다시 이동하면서 ?code=... 를 버린다(eBay 때 실측). 루트 / 는 막지 않는다 —
  // optic-glass.co.kr 은 루트에서 쿼리를 그대로 둔다(아임웹 오류가 /?errorCode=… 로 남아 있었다).
  if (/\/login$/.test(new URL(redirectUri).pathname)) {
    console.error('✗ redirectUri 가 /login 입니다. 이 경로는 다시 이동하면서');
    console.error('  ?code=... 를 버립니다. 리디렉션하지 않는 경로를 쓰세요.');
    process.exit(2);
  }

  const state = env('IMWEB_STATE') || await randomState();
  const url = authorizeUrl({ clientId, redirectUri, siteCode, state, scopes });
  // 요청한 값이 아니라 URL 에 실제로 실린 값을 찍는다 — authorizeUrl 이 필수 범위를
  // 덧붙이므로, 요청값만 찍으면 화면과 실제가 어긋나 디버깅이 헛돈다.
  const sent = new URL(url).searchParams.get('scope');
  console.log('── 1단계: 아래 주소를 브라우저에서 여세요 ──');
  console.log(`  clientId   : ${mask(clientId)}`);
  console.log(`  siteCode   : ${siteCode}`);
  console.log(`  redirectUri: ${redirectUri}`);
  console.log(`  scope      : ${sent}`);
  if (sent !== scopes.join(' ')) console.log(`               (요청: ${scopes.join(' ')} + 아임웹 필수 범위)`);
  console.log('');
  console.log(url);
  console.log('');
  console.log('※ curl · Invoke-WebRequest 로 부르지 마세요. 사람이 로그인·동의해야 하는 흐름이라');
  console.log('  그렇게 부르면 로그인 페이지 HTML 만 돌아옵니다.');
  console.log('');
  console.log('동의 후 주소창의 전체 주소를 복사해 2단계를 실행하세요:');
  console.log(`  $env:IMWEB_STATE='${state}'`);
  console.log('  $env:IMWEB_CLIENT_SECRET=\'...\'');
  console.log('  node tests/imweb-oauth.mjs "붙여넣은_전체_주소"');
  process.exit(0);
}

// ── 2단계 ────────────────────────────────────────────────────
if (!clientSecret) {
  console.error('IMWEB_CLIENT_SECRET 이 필요합니다.');
  process.exit(2);
}
let parsed;
try {
  parsed = readCallback(callbackUrl, env('IMWEB_STATE') || null);
} catch (e) {
  console.error(`✗ ${e.message}`);
  process.exit(1);
}
console.log('── 2단계: 토큰 교환 ──');
console.log(`  code   : ${mask(parsed.code)} (${parsed.code.length}자)`);
console.log(`  state  : ${env('IMWEB_STATE') ? '대조 통과' : '(IMWEB_STATE 미설정 — 대조 생략)'}`);
console.log(`  대상   : ${IMWEB_BASE}${TOKEN_PATH}`);
console.log('');

try {
  const token = await exchangeCode({
    clientId, clientSecret, code: parsed.code,
    redirectUri: redirectUri || new URL(callbackUrl).origin + new URL(callbackUrl).pathname
  });
  console.log('✓ 토큰 발급 성공');
  console.log(`  accessToken : ${mask(token.accessToken)} (${token.accessToken.length}자)`);
  console.log(`  refreshToken: ${token.refreshToken ? `${mask(token.refreshToken)} (${token.refreshToken.length}자)` : '(없음)'}`);
  console.log(`  expiresIn   : ${token.expiresIn || '(응답에 없음)'}`);
  console.log('');
  console.log('응답 필드 이름(값 제외):', Object.keys(token.raw || {}).join(', ') || '(없음)');
  console.log('');
  console.log('이 필드 구성을 알려주시면 저장·갱신 코드를 정확히 작성하겠습니다.');
  process.exit(0);
} catch (error) {
  console.error(`✗ 토큰 교환 실패: ${error.message}`);
  if (error.status === 404) {
    console.error('');
    console.error(`  → ${TOKEN_PATH} 경로가 틀렸을 수 있습니다(문서에서 확인하지 못한 유일한 값).`);
    console.error('    imweb_oauth.js 의 TOKEN_PATH 상수만 고치면 됩니다.');
  }
  process.exit(1);
}
