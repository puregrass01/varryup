// 아임웹 OAuth 토큰 발급을 명령 한 번으로 — 브라우저도 환경변수도 필요 없다.
//
//   node tests/imweb-token.mjs                    ← 지금 신청한 범위(DEFAULT_SCOPES) 전부
//   node tests/imweb-token.mjs product:write      ← 범위를 직접 지정 (site-info:write 는 자동으로 붙는다)
//   node tests/imweb-token.mjs --complete         ← 토큰을 받은 뒤 연동중 → 연동완료 처리까지
//
// 아임웹이 거부하는 scope(30099)가 섞여 있어도 멈추지 않는다. 받아주는 것만 추려 진행하고, 거부된
// 것을 이름으로 알려준다 — 아임웹의 오류는 어느 scope 가 문제인지 알려주지 않는다.
// API 설정에 scope 를 추가한 뒤 같은 명령을 다시 실행하면 자동으로 포함된다.
//
// --complete 는 아임웹 쪽 상태를 바꾸는 유일한 동작이라 명시했을 때만 한다. 문서상 '연동중' 에서는
// 이 API 외에 다른 API 를 쓸 수 없고, 이미 연동완료면 30128 로 거절될 뿐 아무것도 바뀌지 않는다.
//
// clientId · clientSecret 은 VERY UP 이 저장한 아임웹 키 설정(userData 의 imweb_openapi_config.json)에서
// 읽는다 — 앱에 등록한 값과 이 요청이 같은 값을 쓰게 하기 위해서다. 우선순위:
//   1) 환경변수 IMWEB_CLIENT_ID (+ IMWEB_CLIENT_SECRET)
//   2) VERY UP 설정 (clientId · clientSecret 칸, 없으면 UUID 인 apiKey · apiSecret)
// secret 이 어디에도 없을 때만 화면에 표시하지 않고 묻는다. 명령줄 인수로 받지 않는 이유는
// 인수가 PowerShell 명령 기록(PSReadLine)에 그대로 남기 때문이다.
//
// 앱이 그 사이트에 이미 설치돼 있어 authorize 가 로그인 없이 코드를 준다는 전제다(2026-09-23 실측).
// 동의 화면이 필요한 사이트면 tests/imweb-oauth.mjs 의 브라우저 2단계 방식을 쓴다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  requestApprovedCode, exchangeCode, completeIntegration, getSiteInfo, oauthCredentialsFromConfig,
  DEFAULT_SCOPES, REQUIRED_SCOPES, IMWEB_BASE, TOKEN_PATH
} from '../src/platforms/openapi/imweb_oauth.js';

const env = (n) => (process.env[n] || '').trim();

// main_process 가 쓰는 것과 같은 파일. Electron 의 userData 는 %APPDATA%/<package.json name> 이다.
const configFile = env('IMWEB_OPENAPI_CONFIG')
  || path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'very-up-ver2', 'imweb_openapi_config.json');
let saved = null;
try { saved = oauthCredentialsFromConfig(JSON.parse(fs.readFileSync(configFile, 'utf8'))); }
catch { /* 파일이 없거나 깨졌으면 환경변수·입력으로 간다 */ }

const fromEnv = !!env('IMWEB_CLIENT_ID');
const clientId = fromEnv ? env('IMWEB_CLIENT_ID') : saved?.clientId;
// 환경변수로 다른 clientId 를 줬으면 저장된 secret 은 다른 앱의 것이라 섞지 않는다.
const savedSecret = fromEnv ? '' : (saved?.clientSecret || '');
if (!clientId) {
  console.error('✗ 아임웹 OAuth clientId 가 없습니다.');
  console.error(`  VERY UP 아임웹 탭 > Open API 키에 Client ID / Secret 을 저장하거나(${configFile}),`);
  console.error("  $env:IMWEB_CLIENT_ID='...' 로 지정하세요.");
  process.exit(2);
}

// 비밀이 아닌 식별자. authorize 주소창에 그대로 드러나는 값이다. 환경변수로 덮어쓸 수 있다.
const siteCode = env('IMWEB_SITE_CODE') || 'S20260120dfa7cee190bbb';
// 개발자센터에 등록한 리다이렉트 URI 와 글자까지 같아야 한다 — 끝의 / 를 빼면 30098(Invalid redirect uri).
const redirectUri = env('IMWEB_REDIRECT_URI') || 'https://optic-glass.co.kr/';

const args = process.argv.slice(2);
const unknownFlags = args.filter(a => a.startsWith('--') && a !== '--complete');
if (unknownFlags.length) {
  console.error(`알 수 없는 옵션: ${unknownFlags.join(' ')}  (쓸 수 있는 옵션: --complete)`);
  process.exit(2);
}
const complete = args.includes('--complete');
const scopeArgs = args.filter(a => !a.startsWith('--')).flatMap(a => a.split(/[\s,]+/)).filter(Boolean);
const scopes = scopeArgs.length ? scopeArgs : DEFAULT_SCOPES;

const mask = (s) => (!s ? '(없음)' : s.length <= 6 ? '***' : `${s.slice(0, 4)}…${s.slice(-2)}`);

/**
 * 화면에 표시하지 않고 한 줄을 읽는다. 붙여넣기도 된다.
 * 터미널이 아닌 곳(파이프 등)에서 실행되면 표시를 숨길 수 없어서 그냥 읽는다.
 */
function askHidden(question) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    stdin.setEncoding('utf8');
    process.stdout.write(question);

    if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
      let buf = '';
      stdin.on('data', (d) => { buf += d; });
      stdin.on('end', () => { process.stdout.write('\n'); resolve(buf.split(/\r?\n/)[0].trim()); });
      return;
    }

    let value = '';
    const cleanup = () => { stdin.off('data', onData); stdin.setRawMode(false); stdin.pause(); };
    const onData = (raw) => {
      // 터미널 제어 시퀀스를 먼저 걷어낸다. Windows Terminal 의 붙여넣기는 ESC[200~ … ESC[201~ 로
      // 감싸여 올 수 있고, 화살표 키도 ESC[A 같은 시퀀스다. ESC 만 버리면 '[200~' 이 secret 뒤에
      // 붙어 틀린 secret 이 되고, 아임웹은 그걸 30098 로만 알려줘서 원인을 찾을 수 없다.
      const chunk = raw.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '');
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {                 // Enter (붙여넣기에 줄바꿈이 섞여도 여기서 끝낸다)
          cleanup();
          process.stdout.write(` (${value.length}자 입력됨)\n`);
          resolve(value.trim());
          return;
        }
        if (ch === '\u0003') {                            // Ctrl+C — raw 모드에서는 직접 처리해야 한다
          cleanup();
          process.stdout.write('\n');
          reject(new Error('입력을 취소했습니다.'));
          return;
        }
        if (ch === '\u007f' || ch === '\b') { value = value.slice(0, -1); continue; }  // Backspace (유닉스 / 윈도)
        if (ch < ' ') continue;                           // 그 밖의 제어문자는 버린다
        value += ch;
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

console.log('── 아임웹 토큰 발급 ──');
console.log(`  clientId   : ${clientId}  (${fromEnv ? '환경변수 IMWEB_CLIENT_ID' : 'VERY UP 설정'})`);
console.log(`  siteCode   : ${siteCode}`);
console.log(`  redirectUri: ${redirectUri}`);
console.log(`  요청 scope : ${[...new Set([...REQUIRED_SCOPES, ...scopes])].join(' ')}`);
if (!fromEnv && saved?.from === 'apiKey') {
  console.log('  ※ OAuth 값이 아임웹 탭 "Open API 키"의 apiKey/apiSecret 칸(구 v2 키 자리)에 들어 있습니다.');
  console.log('    그 칸의 구 v2 키로 동작하던 기능(B2B 상품 생성·카테고리/이미지 수정)은 지금 키가 없는 상태입니다.');
}
console.log('');

// ── 1) 인가 코드 ────────────────────────────────────────────────
// secret 을 묻기 전에 먼저 한다. scope·siteCode 문제면 secret 을 입력할 필요도 없이 여기서 끝난다.
let code;
let rejected = [];
try {
  const got = await requestApprovedCode({ clientId, redirectUri, siteCode, scopes });
  code = got.code;
  rejected = got.rejected;
  console.log(`✓ 1) 인가 코드 받음 (${code.length}자, 값은 표시하지 않음)`);
  console.log(`     받아준 scope: ${[...REQUIRED_SCOPES, ...got.scopes].join(' ')}`);
  if (rejected.length) {
    console.log(`     ✗ 거부된 scope: ${rejected.join(' ')}  (30099) — 빼고 계속합니다`);
    console.log('       이 앱의 API 설정에 없는 scope 입니다. 개발자센터 > 앱 > API 설정에서 선택해 저장하세요.');
    console.log("       (앱이 '심사 중'이면 API 설정이 잠겨 있습니다.)");
  }
} catch (error) {
  console.error(`✗ 1) 인가 코드 실패: ${error.message}`);
  process.exit(1);
}

// ── 2) 토큰 교환 ────────────────────────────────────────────────
let clientSecret = env('IMWEB_CLIENT_SECRET');
if (clientSecret) {
  console.log(`  client secret: 환경변수 IMWEB_CLIENT_SECRET 사용 (${clientSecret.length}자)`);
} else if (savedSecret) {
  clientSecret = savedSecret;
  console.log(`  client secret: VERY UP 설정에 저장된 값 사용 (${clientSecret.length}자, 값은 표시하지 않음)`);
} else {
  try {
    clientSecret = await askHidden('  client secret 입력(화면에 표시되지 않음, 붙여넣기 가능): ');
  } catch (error) {
    console.error(`✗ ${error.message}`);
    process.exit(1);
  }
}
if (!clientSecret) {
  console.error('✗ client secret 이 비어 있습니다.');
  process.exit(2);
}

let token;
try {
  token = await exchangeCode({ clientId, clientSecret, code, redirectUri });
} catch (error) {
  console.error(`✗ 2) 토큰 교환 실패: ${error.message}`);
  process.exit(1);
}
console.log(`✓ 2) 토큰 발급 성공  (${IMWEB_BASE}${TOKEN_PATH})`);
console.log(`  accessToken : ${mask(token.accessToken)} (${token.accessToken.length}자)`);
console.log(`  refreshToken: ${token.refreshToken ? `${mask(token.refreshToken)} (${token.refreshToken.length}자)` : '(없음)'}`);
console.log(`  scope(응답) : ${token.scope.join(' ') || '(응답에 없음)'}`);
console.log(`  expiresIn   : ${token.expiresIn || '(응답에 없음 — 문서상 액세스 토큰 2시간 · 리프레시 토큰 90일)'}`);
// 값 없이 구조만 보여준다. 저장·갱신 코드를 이 구조에 맞춰 쓴다.
// 배열도 typeof 'object' 라 배열 검사를 먼저 한다(아니면 인덱스가 키로 풀린다).
const shape = (o, depth = 0) => Array.isArray(o) ? `array(${o.length})`
  : (o && typeof o === 'object' && depth < 2)
    ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, shape(v, depth + 1)]))
    : o === null ? 'null' : typeof o;
console.log('  응답 구조(값 제외):', JSON.stringify(shape(token.raw)));

// ── 3) 연동완료 처리 (--complete 일 때만) ─────────────────────────
// 연동중 상태에서는 이 API 외의 다른 API 를 쓸 수 없으므로 사이트 정보 조회보다 먼저 한다.
if (complete) {
  try {
    await completeIntegration(token.accessToken);
    console.log('✓ 3) 연동완료 처리됨 (연동중 → 연동완료)');
  } catch (error) {
    if (error.errorCode === '30128') {
      console.log('  3) 연동완료 처리는 필요 없습니다 — 이미 연동완료이거나 연동중이 아닙니다 (30128, 아무것도 바뀌지 않음)');
    } else {
      console.error(`✗ 3) 연동완료 처리 실패: ${error.message}`);
      process.exit(1);
    }
  }
}

// ── 4) 연결된 사이트 확인 ────────────────────────────────────────
// 토큰이 실제로 통하는지, 어느 사이트(유닛·통화)에 붙었는지 보여주는 읽기 전용 호출이다.
try {
  const info = await getSiteInfo(token.accessToken);
  console.log('✓ 4) 토큰으로 사이트 정보 조회 성공');
  console.log(`  siteCode: ${info.siteCode}`);
  for (const unit of info.unitList || []) {
    console.log(`  유닛 ${unit.unitCode}  ${unit.name || '(이름 없음)'}  ${unit.currency || ''}`.trimEnd());
  }
} catch (error) {
  console.error(`✗ 4) 사이트 정보 조회 실패: ${error.message}`);
  if (!complete) {
    console.error("  연동중 상태에서는 연동완료 처리 외의 API 를 쓸 수 없습니다. --complete 를 붙여 다시 실행해보세요.");
  }
  process.exit(1);
}

if (rejected.length) {
  console.log('');
  console.log(`※ ${rejected.join(' ')} 는 아직 받지 못했습니다. API 설정에 추가한 뒤 같은 명령을 다시 실행하면 자동으로 포함됩니다.`);
}
process.exit(0);
