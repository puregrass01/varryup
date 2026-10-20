// 아임웹 키 설정 파일(imweb_openapi_config.json) 읽기 · 쓰기.
//
// 담는 값: OAuth clientId · clientSecret (아임웹 Open API — imweb_oauth.js · imweb_client.js 가 쓴다).
// 예전 v2 API(api.imweb.me/v2, apiKey · apiSecret)를 부르던 클라이언트(imweb_api.js)는 B2B몰까지 Open API 로
// 옮기면서 2026-10-05 지웠다. 파일에 남아 있는 apiKey · apiSecret 은 이제 아무도 읽지 않는다.
//
// electron 을 import 하지 않으므로 userData 경로는 main_process 가 IMWEB_OPENAPI_CONFIG 환경변수로 넘겨준다.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 설정 파일 경로.
 * 1) IMWEB_OPENAPI_CONFIG 환경변수 (main_process 가 userData 경로로 지정한다)
 * 2) 개발용 레거시 경로 data/imweb_openapi_config.json
 *
 * 설치본에서는 data/ 가 빌드에서 제외되고 설치 폴더가 쓰기 대상도 아니라,
 * userData 를 1순위로 두어야 앱 안에서 키를 입력·저장할 수 있다.
 */
export function configPath() {
    if (process.env.IMWEB_OPENAPI_CONFIG) return process.env.IMWEB_OPENAPI_CONFIG;
    return path.join(__dirname, '..', '..', '..', 'data', 'imweb_openapi_config.json');
}

/** 아임웹 탭 · 서버 동기화에서 받은 키를 저장한다. 기존 값과 병합하고 원자적으로 쓴다. */
export function saveConfig(newConfig) {
    const p = configPath();
    let cur = {};
    try {
        if (fs.existsSync(p)) cur = JSON.parse(fs.readFileSync(p, 'utf-8')) || {};
    } catch { cur = {}; }
    const merged = { ...cur, ...newConfig };
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), 'utf-8');
    fs.renameSync(tmp, p);
    return merged;
}
