// 네이버 커머스API 자격증명 저장. ebay_store.js 와 같은 규칙을 따른다.
//   - Client Secret 은 OS 암호화 저장소(safeStorage)에만 넣는다. 평문 저장은 하지 않고 실패한다.
//   - UI 로는 저장 여부만 돌려준다. 값 자체는 절대 읽어 보내지 않는다.
//   - 파일명을 ebay_config.json 과 분리해 두 플랫폼이 서로를 덮어쓰지 못하게 한다.
import fs from 'node:fs';
import path from 'node:path';

const SECRET_FIELDS = ['clientSecret'];
const CONFIG_FIELDS = ['clientId', 'accountId', 'type'];

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}

export class NaverStore {
  constructor(directory, safeStorage) {
    this.configPath = path.join(directory, 'naver_config.json');
    this.safeStorage = safeStorage;
  }

  read(file, fallback) {
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback;
  }

  config() {
    const saved = this.read(this.configPath, {});
    const config = {};
    for (const field of CONFIG_FIELDS) config[field] = saved[field] || '';
    config.type ||= 'SELF';   // 자사 스토어 전용. 타사 판매자를 대신 다룰 때만 SELLER.
    for (const field of SECRET_FIELDS) {
      config[field] = saved[`${field}Encrypted`]
        ? this.safeStorage.decryptString(Buffer.from(saved[`${field}Encrypted`], 'base64'))
        : '';
    }
    return config;
  }

  publicConfig() {
    const config = this.config();
    for (const field of SECRET_FIELDS) {
      config[`has${field[0].toUpperCase()}${field.slice(1)}`] = !!config[field];
      delete config[field];
    }
    return config;
  }

  save(input) {
    const config = this.config();
    // Client ID 가 바뀌면 이전 Secret 은 다른 앱의 것이므로 함께 버린다.
    if (input.clientId !== undefined && String(input.clientId).trim() !== config.clientId) {
      config.clientSecret = '';
    }
    for (const field of CONFIG_FIELDS) if (input[field] !== undefined) config[field] = String(input[field]).trim();
    // 빈 입력은 '변경 없음'으로 본다. 빈 문자열이 저장된 비밀값을 지우지 못하게 한다.
    for (const field of SECRET_FIELDS) if (input[field]?.trim()) config[field] = input[field].trim();
    if (input.disconnect === true) config.clientSecret = '';
    config.type ||= 'SELF';   // 자사 스토어 전용. 타사 판매자를 대신 다룰 때만 SELLER.
    if (!['SELLER', 'SELF'].includes(config.type)) throw new Error('잘못된 네이버 인증 유형입니다.');

    if (SECRET_FIELDS.some(f => config[f]) && !this.safeStorage.isEncryptionAvailable()) {
      throw new Error('Windows 암호화 저장소를 사용할 수 없습니다. 인증정보를 저장하지 않았습니다.');
    }
    const saved = {};
    for (const field of CONFIG_FIELDS) saved[field] = config[field];
    for (const field of SECRET_FIELDS) {
      if (config[field]) saved[`${field}Encrypted`] = this.safeStorage.encryptString(config[field]).toString('base64');
    }
    writeJson(this.configPath, saved);
    return this.publicConfig();
  }
}
