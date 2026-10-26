import fs from 'node:fs';
import path from 'node:path';

// 원자적 JSON 쓰기 — tmp 에 쓰고 rename 한다. 쓰는 중에 앱이 꺼져도 잘린 파일이 남지 않는다.
// tmp 이름에 pid 를 붙여 두 프로세스가 같은 파일을 써도 서로의 tmp 를 밟지 않는다.
// indent 0 은 한 줄로 쓴다 — 자주 다시 쓰는 큰 캐시는 들여쓰면 크기와 쓰는 시간만 는다.
export function writeJsonAtomic(file, data, indent = 2) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, indent), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// 파일은 모아서 쓴다. 값 하나 바뀔 때마다 통째로 쓰면(2026-10-01 쿠팡 실측: 1.4MB, 1회 약 11ms) 전체 불러오기
// 한 번에 수천 번 써서 메인 프로세스가 수십 초 멈추고 디스크에 GB 단위로 쓰였다(아마존 1.9MB × SKU 수도 같다).
// 값은 메모리에서 바로 바뀌고(읽는 쪽은 메모리를 본다), 파일은 조용해진 뒤 1초에, 계속 바뀌어도 5초마다
// 한 번 쓴다. 앱을 끌 때는 남은 것을 바로 쓴다(main_process before-quit → flush).
const FLUSH_IDLE_MS = 1000;
const FLUSH_MAX_MS = 5000;

/** 메모리에 두고 모아서 쓰는 JSON 파일 하나(쿠팡 판매가 · 아마존 · eBay 목록 캐시). */
export class JsonCache {
  constructor(file, { indent = 0, label = '캐시' } = {}) {
    Object.assign(this, { file, indent, label });
    this.data = undefined;   // 한 번 읽으면 메모리에 둔다
    this.dirty = false;      // 메모리에만 있고 아직 파일에 안 쓴 변경이 있다
    this.idleTimer = this.maxTimer = null;
  }

  /** 없으면 null. 깨진 파일은 던진다 — 메모리에 두지 않으므로 고쳐지면(다음 저장) 다시 읽힌다. */
  read() {
    if (this.data !== undefined) return this.data;
    if (!fs.existsSync(this.file)) return (this.data = null);
    return (this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')));
  }

  /** 메모리 값을 바꾸고(제자리에서 고친 같은 객체여도 된다) 모아서 쓴다. */
  set(data) {
    this.data = data;
    this.dirty = true;
    // 조용해지면 1초 뒤, 계속 바뀌어도 처음 바뀐 뒤 5초 안에는 쓴다. 타이머가 앱(테스트) 종료를 붙잡지 않게 unref.
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.flush(), FLUSH_IDLE_MS);
    this.idleTimer.unref?.();
    if (!this.maxTimer) {
      this.maxTimer = setTimeout(() => this.flush(), FLUSH_MAX_MS);
      this.maxTimer.unref?.();
    }
  }

  /** 지금 쓰고 메모리에 둔다. 못 쓰면 던지고 메모리도 그대로다 — 전체 동기화처럼 결과가 꼭 디스크에 닿아야 할 때. */
  save(data) {
    writeJsonAtomic(this.file, data, this.indent);
    this.stopTimers();
    this.data = data;
    this.dirty = false;
  }

  /** 아직 안 쓴 변경을 지금 쓴다. 쓸 것이 없으면 false. 실패하면 다음 변경(또는 flush) 때 다시 쓴다. */
  flush() {
    this.stopTimers();
    if (!this.dirty || !this.data) return false;
    this.dirty = false;
    try {
      writeJsonAtomic(this.file, this.data, this.indent);
      return true;
    } catch (e) {
      this.dirty = true;
      console.warn(`[${this.label}] 캐시 파일 저장 실패(다음 변경 때 다시 씀):`, e.message);
      return false;
    }
  }

  /** 메모리 · 남은 쓰기 · 파일을 모두 버린다(계정이 바뀌었을 때). */
  clear() {
    this.stopTimers();
    // null(=파일 없음 기억)이 아니라 처음 상태로 — 뒤에 생긴 파일(깨진 것 포함)을 다음 read() 가 다시 본다.
    this.data = undefined;
    this.dirty = false;
    try { fs.unlinkSync(this.file); } catch { /* 없으면 그만 */ }
  }

  stopTimers() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.maxTimer) clearTimeout(this.maxTimer);
    this.idleTimer = this.maxTimer = null;
  }
}
