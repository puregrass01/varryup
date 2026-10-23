// 아임웹 Open API 는 앱+사이트마다 살아 있는 토큰이 하나뿐이다. 베리업과 베리맵 수집기가 같은 앱으로
// 동시에 토큰을 받으면 서로의 토큰을 무효화하고, 401 → 재발급이 엇갈려 쓰기가 중간에 실패한다.
// 그래서 userData 의 파일 하나로 한 번에 한 프로세스만 아임웹을 쓰게 한다. 파일에는 주인 pid 를 적고,
// 주인이 죽었으면(크래시) 다음 사람이 가져간다. 같은 PC 안에서만 막는다 — 두 PC 가 같은 앱을 쓰면 못 막는다.
import fs from 'fs';

const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

/**
 * @param file 잠금 파일 경로(베리업 userData/imweb_api.lock)
 * @param idleMs 0 이면 release() 할 때까지 쥔다(수집기). 아니면 마지막 acquire() 뒤 이 시간 동안 조용하면 놓는다(베리업).
 */
export function createImwebLock(file, { idleMs = 0 } = {}) {
  let held = false, timer = null;
  const owner = () => { try { return Number(fs.readFileSync(file, 'utf8')) || 0; } catch { return 0; } };
  const arm = () => {
    if (!idleMs) return;
    clearTimeout(timer);
    timer = setTimeout(release, idleMs);
    timer.unref?.();
  };
  function acquire() {
    if (held) { arm(); return; }
    // ponytail: 파일을 만들고 pid 를 쓰는 사이(수 µs)에 다른 프로세스가 읽으면 빈 파일을 주인 없음으로 본다. 그 정도 겹침은 감수한다.
    for (let tries = 0; tries < 2; tries++) {
      try {
        fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
        held = true; arm(); return;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        const pid = owner();
        if (pid === process.pid) { held = true; arm(); return; }
        if (pid && alive(pid)) {
          throw new Error(`다른 프로그램(pid ${pid}, 베리업 또는 베리맵 아임웹 수집)이 아임웹을 쓰는 중입니다 — 끝난 뒤 다시 하세요.`);
        }
        fs.rmSync(file, { force: true });   // 주인이 없는 잠금(크래시로 남은 것)
      }
    }
    throw new Error('아임웹 잠금 파일을 잡지 못했습니다: ' + file);
  }
  function release() {
    clearTimeout(timer);
    if (!held) return;
    held = false;
    if (owner() === process.pid) fs.rmSync(file, { force: true });
  }
  return { acquire, release, get held() { return held; } };
}
