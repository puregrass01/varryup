// 아임웹 Open API 는 앱+사이트마다 살아 있는 토큰이 하나뿐이다. 베리업과 베리맵 수집기가 같은 앱으로
// 동시에 토큰을 받으면 서로의 토큰을 무효화하고, 401 → 재발급이 엇갈려 쓰기가 중간에 실패한다.
// 그래서 userData 의 파일 하나로 한 번에 한 프로세스만 아임웹을 쓰게 한다. 파일에는 주인 pid 를 적고,
// 쥔 동안은 파일 시각을 계속 새로 한다(요청마다 · 30초마다). 주인이 죽었거나(pid 없음) 시각이 2분 넘게 멈췄으면
// 남겨진 잠금으로 보고 가져간다 — 강제 종료·재부팅으로 남은 파일의 pid 를 다른 프로그램이 다시 받아도 막히지 않게.
// 같은 PC 안에서만 막는다 — 두 PC 가 같은 앱을 쓰면 못 막는다.
import fs from 'fs';

const STALE_MS = 2 * 60 * 1000;
const TOUCH_MS = 30 * 1000;

// EPERM 도 살아 있는 것으로 본다 — 같은 사용자라도 관리자 권한으로 띄운 베리업은 일반 권한 쪽에 EPERM 을 준다.
// 재부팅 뒤 pid 를 시스템 프로세스가 다시 받은 경우는 아래 2분 시각 검사가 풀어 준다.
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

/**
 * @param file 잠금 파일 경로(베리업 userData/imweb_api.lock)
 * @param idleMs 0 이면 release() 할 때까지 쥔다(수집기). 아니면 마지막 acquire() 뒤 이 시간 동안 조용하면 놓는다(베리업).
 */
export function createImwebLock(file, { idleMs = 0, now = Date.now } = {}) {
  let held = false, idleTimer = null, touchTimer = null;
  const owner = () => { try { return Number(fs.readFileSync(file, 'utf8')) || 0; } catch { return 0; } };
  const age = () => { try { return now() - fs.statSync(file).mtimeMs; } catch { return Infinity; } };
  const touch = () => { try { const t = new Date(now()); fs.utimesSync(file, t, t); } catch { /* 지워졌으면 다음 acquire 가 다시 만든다 */ } };
  const take = () => {
    held = true;
    touchTimer = setInterval(touch, TOUCH_MS);
    touchTimer.unref?.();
    arm();
  };
  const arm = () => {
    if (!idleMs) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(release, idleMs);
    idleTimer.unref?.();
  };
  function acquire() {
    // 쥐고 있다고 믿어도 파일 주인을 다시 본다 — 남겨진 잠금으로 오해받아 빼앗겼으면(또는 사람이 지웠으면) 아래로 내려가 다시 다툰다.
    if (held && owner() === process.pid) { touch(); arm(); return; }
    if (held) release();
    // ponytail: 파일을 만들고 pid 를 쓰는 사이(수 µs), 그리고 남겨진 잠금을 지우고 새로 만드는 사이에 다른 프로세스가 끼어들면
    // 둘 다 쥘 수 있다. 두 프로세스가 1ms 안에 동시에 시작해야 생기는 일이라 감수한다(막으려면 원자적 인수인계가 필요).
    for (let tries = 0; tries < 2; tries++) {
      try {
        fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
        take(); return;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        const pid = owner();
        if (pid === process.pid) { touch(); take(); return; }
        if (pid && alive(pid) && age() < STALE_MS) {
          throw new Error(`다른 프로그램(pid ${pid}, 베리업 또는 베리맵 아임웹 수집)이 아임웹을 쓰는 중입니다 — 끝난 뒤 다시 하세요. `
            + `그런 프로그램이 없다면 잠금 파일을 지우세요: ${file}`);
        }
        fs.rmSync(file, { force: true });   // 남겨진 잠금(강제 종료 · 재부팅)
      }
    }
    throw new Error('아임웹 잠금 파일을 잡지 못했습니다: ' + file);
  }
  function release() {
    clearTimeout(idleTimer);
    clearInterval(touchTimer);
    if (!held) return;
    held = false;
    if (owner() === process.pid) fs.rmSync(file, { force: true });
  }
  return { acquire, release, get held() { return held; } };
}
