// 신규 등록 원장 — 이 PC 가 **성공적으로** 등록한 상품의 기록.
//
// 왜 필요한가
//   네이버·쿠팡·아임웹은 등록 버튼을 누를 때마다 새 상품을 만든다. 채널 스냅샷
//   (data/vehicle_catalog.json)은 엑셀을 구운 시점까지만 알고, 실시간 조회는 실패할 수 있다.
//   '방금 이 PC 에서 올린 것'을 다시 올리는 가장 흔한 중복은 이 기록이 막는다.
//   판정은 duplicate_guard.js 가 하고, 이 파일은 읽고 쓰기만 한다.
//
// 어디에 두나
//   userData/registration_ledger.json. data/ 에 두면 배포본을 덮어쓸 때 같이 지워진다.
//
// 쓰기 규칙
//   record · supersede 는 **완전 동기**다(readFileSync → 수정 → writeFileSync → renameSync,
//   중간에 await 없음). 메인 프로세스는 스레드가 하나라 동기 구간은 끼어들 틈이 없다 —
//   두 등록이 동시에 끝나도 한쪽 기록이 다른 쪽을 덮어쓰지 않는다.
//   임시 파일 이름에 pid 를 넣는 것은 앱을 두 개 띄웠을 때 서로의 tmp 를 밟지 않게 하려는 것이다.
//   행은 지우지 않는다. 삭제가 확인된 행은 supersededAt 만 찍는다(나중에 원인을 따라갈 수 있게).
import fs from 'node:fs';
import path from 'node:path';

export const LEDGER_FILE = 'registration_ledger.json';

export class RegistrationLedger {
  constructor(directory, { now = () => new Date(), maxEntries = 20000 } = {}) {
    this.directory = directory;
    this.file = path.join(directory, LEDGER_FILE);
    this.now = now;
    this.maxEntries = maxEntries;
    this.lastReadError = null;
  }

  // 파일이 없으면 빈 원장. 깨졌으면 지우지 않고 옆으로 옮겨 보존한 뒤 빈 원장으로 시작한다 —
  // 깨진 파일 때문에 등록이 영영 막히면 안 되고, 조용히 덮어써서 증거가 사라져도 안 된다.
  _read() {
    this.lastReadError = null;
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return { version: 1, entries: [] };
      throw e;
    }
    try {
      const doc = JSON.parse(raw);
      if (!doc || !Array.isArray(doc.entries)) throw new Error('entries 배열이 없습니다');
      return doc;
    } catch (e) {
      const moved = `${this.file}.corrupt-${Date.now()}`;
      try { fs.renameSync(this.file, moved); } catch { /* 옮기지 못해도 빈 원장으로 진행 */ }
      this.lastReadError = `등록 원장이 손상되어 ${path.basename(moved)} 로 옮기고 새로 시작합니다(${e.message})`;
      return { version: 1, entries: [] };
    }
  }

  _write(doc) {
    fs.mkdirSync(this.directory, { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  /** 매번 파일을 다시 읽는다 — 다른 창·다른 등록이 방금 쓴 행도 보이게. */
  entries() {
    return this._read().entries;
  }

  /** supersededAt 이 없는(아직 유효한) 행. channel 을 주면 그 채널만. */
  active(channel) {
    return this.entries().filter(e => e && !e.supersededAt && (!channel || e.channel === channel));
  }

  /** id·registeredAt 을 채워 한 줄 추가하고, 저장한 행을 돌려준다. */
  record(entry) {
    const doc = this._read();
    const at = this.now();
    const row = {
      channel: '', keys: [], externalId: null, url: null, verified: false,
      title: '', detail: {}, bypass: false, supersededAt: null, supersededReason: null,
      ...entry,
      id: `${entry?.channel || 'unknown'}-${at.getTime()}-${Math.random().toString(36).slice(2, 6)}`,
      registeredAt: at.toISOString(),
    };
    doc.version = 1;
    doc.entries.push(row);
    // 오래된 것부터 버린다. 2만 줄이면 수년치라 판정에 쓰일 일이 없다.
    if (doc.entries.length > this.maxEntries) doc.entries.splice(0, doc.entries.length - this.maxEntries);
    this._write(doc);
    return row;
  }

  /** 지우지 않고 '더 이상 유효하지 않음'만 표시한다. 없는 id 면 null. */
  supersede(id, reason) {
    const doc = this._read();
    const row = doc.entries.find(e => e && e.id === id);
    if (!row) return null;
    row.supersededAt = this.now().toISOString();
    row.supersededReason = reason || '';
    this._write(doc);
    return row;
  }
}
