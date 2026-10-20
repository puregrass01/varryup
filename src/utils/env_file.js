// 설치본 설정 파일 로더 — userData/veryup.env 를 process.env 로 올린다.
//
// 왜 필요한가
//   이 앱의 운영 스위치는 전부 process.env 로만 들어온다:
//     UPDATE_TOKEN        자동 업데이트 인증 헤더 (없으면 서버가 401/404)
//     ADMIN_SERVER_URL    관리자·인증키 서버 주소
//     VERYUP_LOCAL_ONLY   서버 없이 쓰는 배포
//     AI_SERVER_URL / AI_GEN_DIR / PAPAGO_CLIENT_ID
//   그런데 설치본은 NSIS oneClick 으로 깔려 바로가기로 실행된다. 그 경로에는
//   환경변수를 끼워 넣을 자리가 없다 → 위 값들이 전부 '설정 불가'였다.
//   그 결과 UPDATE_TOKEN 을 서버에만 켜면 전 직원 업데이트가 조용히 끊기고,
//   서버 주소가 바뀌면 재빌드해야 했다. 파일 하나로 바꿀 수 있어야 한다.
//
// 파싱은 dotenv 에 맡긴다
//   dotenv 는 이미 package.json 의 dependencies 에 있었는데 어디서도 import 하지 않아
//   죽은 의존성이었다. 직접 파서를 쓸 이유가 없다 — 따옴표·주석·CRLF·여러 줄 값 같은
//   자잘한 경우를 이미 다 처리하고, 그 규칙이 팀에게 익숙한 .env 규칙 그대로다.
//
// 우선순위: 진짜 환경변수 > veryup.env
//   dotenv 의 기본 동작이 정확히 이것이다(이미 있는 키는 덮지 않는다).
//   개발 중에 셸에서 준 값이 파일에 덮이면 디버깅이 지옥이 되므로 이 동작이 맞다.
//
// 파일 형식
//   # 주석
//   UPDATE_TOKEN=abc123
//   ADMIN_SERVER_URL="https://admin.example.com"
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

/**
 * envPath 의 설정을 process.env 에 얹는다(이미 있는 값은 건드리지 않는다).
 * @returns {{loaded:boolean, path:string, applied:string[], skipped:string[], error?:string}}
 *          applied/skipped 에는 **키 이름만** 담는다 — 값이 로그로 새면 토큰이 새는 것이다.
 */
export function loadEnvFile(envPath) {
    const result = { loaded: false, path: envPath, applied: [], skipped: [] };
    try {
        if (!fs.existsSync(envPath)) return result;

        // dotenv.config() 는 '무엇이 새로 들어갔는지' 를 돌려주지 않는다(parsed 는 파일 전체다).
        // 어떤 키가 파일에서 왔고 어떤 키가 환경변수에 밀렸는지는 운영 문의를 가르는
        // 정보라서, 적용 전 스냅샷을 떠서 직접 구분한다.
        const parsed = dotenv.parse(fs.readFileSync(envPath));
        const before = new Set(
            Object.keys(parsed).filter(k => process.env[k] !== undefined && process.env[k] !== '')
        );

        // override 를 켜지 않는다 = 이미 있는 키는 그대로 둔다(환경변수 우선).
        const out = dotenv.config({ path: envPath, override: false });
        if (out.error) throw out.error;

        for (const key of Object.keys(parsed)) {
            (before.has(key) ? result.skipped : result.applied).push(key);
        }
        result.loaded = true;
    } catch (e) {
        result.error = e?.message || String(e);
    }
    return result;
}

/**
 * 배포본(앱 폴더)의 veryup.env 에 같이 담아도 되는 키.
 *
 * 앱 폴더째 압축해서 나눠주는 배포에서는 이 파일이 받는 사람 전원에게 그대로 간다.
 * 그래서 "모든 설치본이 같은 값을 써야 하고, 새어도 피해가 그 범위에 갇히는" 값만 허용한다.
 * 계정별 비밀값(각 플랫폼 clientSecret, refreshToken 등)은 절대 여기 두지 않는다 —
 * 그건 관리 서버가 로그인 때 내려주고(syncCredentialsFromServer), 네이버·eBay 는
 * safeStorage 로 암호화해 보관한다.
 */
export const DISTRIBUTABLE_ENV_KEYS = new Set([
    'UPDATE_TOKEN',       // 설치본 전체가 같은 값이어야 한다. /updates 다운로드만 가른다.
    'ADMIN_SERVER_URL',   // 주소일 뿐 비밀이 아니다.
    'AI_SERVER_URL',
    'AI_GEN_DIR',
    'VERYUP_LOCAL_ONLY'
]);

function logResult(label, r) {
    if (r.error) {
        console.warn(`[설정] ${label} 읽기 실패:`, r.path, '-', r.error);
    } else if (!r.loaded) {
        // 없는 것이 오류는 아니다. 다만 "왜 업데이트가 안 되지" 를 추적할 단서는 남긴다.
        console.log(`[설정] ${label} 없음:`, r.path);
    } else {
        console.log(`[설정] ${label} 적용:`, r.applied.join(', ') || '(적용된 항목 없음)');
        if (r.skipped.length) {
            console.log('[설정] 앞선 값이 우선하여 무시된 항목:', r.skipped.join(', '));
        }
    }
    return r;
}

/** 배포본에 실리면 안 되는 키가 앱 폴더 파일에 있으면 경고한다. 값은 절대 찍지 않는다. */
export function undistributableKeys(keys) {
    return keys.filter(k => !DISTRIBUTABLE_ENV_KEYS.has(k));
}

/**
 * 설정 파일 경로를 정하고 읽어서 적용한다.
 *
 * 우선순위: 진짜 환경변수 > VERYUP_ENV_FILE > userData/veryup.env > <앱 폴더>/veryup.env
 *
 * userData 가 앱 폴더보다 먼저인 이유: 앱 폴더 쪽은 배포본에 딸려 오는 기본값이고,
 * userData 쪽은 그 PC 에서만 바꾸고 싶을 때 쓰는 덮어쓰기다. dotenv 는 override:false 라
 * 먼저 올라간 값이 그대로 이긴다.
 *
 * @param {string} userDataDir  app.getPath("userData")
 * @param {string} [appDir]     app.getAppPath(). 배포본에 같이 담긴 기본값을 읽는다.
 */
export function loadUserEnv(userDataDir, appDir = null) {
    // 경로를 통째로 지정하면 그것만 쓴다(테스트·특수 배포).
    if (process.env.VERYUP_ENV_FILE) {
        return logResult('veryup.env', loadEnvFile(process.env.VERYUP_ENV_FILE));
    }

    const userPath = path.join(userDataDir, 'veryup.env');
    const user = logResult('veryup.env(userData)', loadEnvFile(userPath));

    if (!appDir) return user;
    const appPath = path.join(appDir, 'veryup.env');
    if (path.resolve(appPath) === path.resolve(userPath)) return user;

    // 앱 폴더 쪽은 빈 칸만 채운다. userData 에 있던 값은 건드리지 않는다.
    const shipped = logResult('veryup.env(배포본)', loadEnvFile(appPath));
    if (shipped.loaded) {
        const risky = undistributableKeys([...shipped.applied, ...shipped.skipped]);
        if (risky.length) {
            console.warn('[설정] 배포본 veryup.env 에 배포하면 안 되는 값이 있습니다:', risky.join(', '));
            console.warn('[설정]   파일:', appPath);
            console.warn('[설정]   이 파일은 앱 폴더째 압축하면 받는 사람 전원에게 그대로 갑니다.');
            console.warn('[설정]   계정별 비밀값은 userData/veryup.env 나 관리 서버 인증키 관리로 옮기세요.');
        }
    }
    return user.loaded ? user : shipped;
}
