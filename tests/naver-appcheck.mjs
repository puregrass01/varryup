// 앱이 실제로 쓰는 경로 그대로 자격증명을 읽어 조회까지 해본다.
// Electron 을 띄우지 않으므로 "앱에서 안 되는데 스크립트에선 되네" 같은 모호함을 없앤다.
//
// 확인하는 것
//   1) veryup.env 가 읽히는가 (앱과 같은 파일, 같은 우선순위 규칙)
//   2) main_process.js 의 getNaverAPI() 와 같은 규칙으로 config 가 만들어지는가
//   3) USE_NAVER_API 토글이 어떤 상태인가
//   4) 그 config 로 실제 조회가 되는가
//
// 실행:  node tests/naver-appcheck.mjs  [제조사] [차종]
import path from 'node:path';
import { loadUserEnv } from '../src/utils/env_file.js';
import { NaverAPI } from '../src/platforms/naver_api.js';
import { NaverStore } from '../src/platforms/naver_store.js';

// Electron 의 app.getPath('userData') 와 같은 위치.
const userData = process.env.VERYUP_USERDATA
  || path.join(process.env.APPDATA || '', 'very-up-ver2');

console.log('── 앱 경로 그대로 확인 ──');
console.log(`  userData : ${userData}`);
console.log('');

// 1) 앱과 똑같이 veryup.env 를 얹는다(이미 있는 환경변수가 우선).
const envResult = loadUserEnv(userData);
console.log('');

// 2) safeStorage 는 Electron 전용이라 여기서는 쓸 수 없다. 저장소에 암호화된 값이
//    있더라도 이 스크립트는 읽지 못하므로, 환경변수 경로만 확인한다.
let stored = { clientId: '', accountId: '', type: '' };
try {
  const store = new NaverStore(userData, {
    isEncryptionAvailable: () => false,
    encryptString: () => { throw new Error('n/a'); },
    decryptString: () => ''
  });
  const c = store.config();
  stored = { clientId: c.clientId, accountId: c.accountId, type: c.type };
} catch { /* 파일이 없으면 그냥 비어 있는 것 */ }

const config = {
  clientId: stored.clientId || (process.env.NAVER_CLIENT_ID || '').trim(),
  clientSecret: (process.env.NAVER_CLIENT_SECRET || '').trim(),
  accountId: stored.accountId || (process.env.NAVER_ACCOUNT_ID || '').trim(),
  type: stored.type || 'SELF'
};

const useApi = process.env.USE_NAVER_API !== '0';
const mask = (s) => (!s ? '(없음)' : s.length <= 6 ? '***' : `${s.slice(0, 4)}…${s.slice(-2)}`);

console.log('  USE_NAVER_API      :', useApi ? '켜짐' : '꺼짐 ← 앱이 커머스API 를 건너뜁니다');
console.log('  NAVER_CLIENT_ID    :', mask(config.clientId));
console.log('  NAVER_CLIENT_SECRET:', config.clientSecret
  ? `${config.clientSecret.slice(0, 7)}… (${config.clientSecret.length}자)` : '(없음)');
console.log('  type               :', config.type);
console.log('');

const problems = [];
if (!useApi) problems.push('USE_NAVER_API=0 — 앱이 커머스API 를 건너뛰고 브라우저로 갑니다.');
if (!config.clientId) problems.push('NAVER_CLIENT_ID 가 없습니다.');
if (!config.clientSecret) problems.push('NAVER_CLIENT_SECRET 이 없습니다.');
if (config.clientSecret && !/^\$2[aby]\$\d{2}\$/.test(config.clientSecret)) {
  problems.push('NAVER_CLIENT_SECRET 이 bcrypt salt 형식이 아닙니다 ($2a$04$… 여야 함).');
}

if (problems.length) {
  console.log('✗ 앱이 커머스API 를 쓸 수 없는 상태입니다:');
  for (const p of problems) console.log(`   · ${p}`);
  console.log('');
  console.log(`  해결: ${path.join(userData, 'veryup.env')} 에 아래 두 줄을 넣고 앱을 다시 시작하세요.`);
  console.log('    NAVER_CLIENT_ID=...');
  console.log('    NAVER_CLIENT_SECRET=$2a$04$...');
  if (envResult.skipped?.length) {
    console.log('');
    console.log(`  ! 이 셸의 환경변수가 파일보다 우선해 무시된 항목: ${envResult.skipped.join(', ')}`);
  }
  process.exit(1);
}

// 4) 앱과 같은 config 로 실제 조회
const brand = process.argv[2] || '';
const model = process.argv[3] || '';
const api = new NaverAPI(config, {});
try {
  if (brand || model) {
    console.log(`검색: 제조사="${brand}" 차종="${model}"`);
    const rows = await api.searchProductsByName(brand, model, {
      onProgress: (n, total) => { if (total && n < total) console.log(`  상품 수집 ${n}/${total}`); }
    });
    console.log(`✓ ${rows.length}건`);
    for (const r of rows.slice(0, 10)) console.log(`   · ${r.id}  ${r.name}`);
    if (rows.length > 10) console.log(`   … 외 ${rows.length - 10}건`);
  } else {
    const res = await api.searchProducts({ page: 1, size: 1 });
    console.log(`✓ 조회 성공 — 전체 상품 ${res?.totalElements ?? '?'}건`);
    console.log('  (제조사·차종을 인수로 주면 실제 검색까지 해봅니다:');
    console.log('   node tests/naver-appcheck.mjs 옵틱글래스 벤츠)');
  }
  console.log('');
  console.log('앱도 같은 설정을 읽습니다. 앱에서 안 되면 재시작하지 않았을 가능성이 큽니다.');
  process.exit(0);
} catch (error) {
  console.log(`✗ 조회 실패: ${error.message}`);
  process.exit(1);
}
