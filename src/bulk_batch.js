import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { describeError } from './utils/api_error.js';
import { writeJsonAtomic } from './utils/json_file.js';

// 화면에서 파싱·환산한 변경 목록을 한 번에 받는다. 저장소는 전송 계획과 결과만 기록하며
// 기존 쇼핑몰 목록 DB를 대체하거나 오래된 상품 본문으로 덮어쓰지 않는다.
// savePrices 는 연속한 가격 변경을 groupSize(scope) 건까지 한 번에 받는다(eBay 25건 일괄 요청, 네이버 묶음 확인).
export function createBulkBatch({ directory, validate, save, savePrices, groupSize = scope => scope === 'ebay' ? 25 : 1, notify = () => {} }) {
  let active = null;
  const remembered = new Map();
  const file = id => directory && path.join(directory, 'bulk_changes', id + '.json');
  function persist(record) {
    if (directory) {
      writeJsonAtomic(file(record.jobId), record, 0);
    }
    remembered.set(record.jobId, record);
    if (remembered.size > 10) remembered.delete(remembered.keys().next().value);
  }
  function read(id) {
    if (!/^[a-zA-Z0-9-]{8,80}$/.test(id || '')) throw new Error('작업 ID가 올바르지 않습니다.');
    if (remembered.has(id)) return remembered.get(id);
    if (directory && fs.existsSync(file(id))) return JSON.parse(fs.readFileSync(file(id), 'utf8'));
    return null;
  }
  async function run(input, report = notify) {
    if (active) throw new Error('일괄 변경 작업이 진행 중입니다.');
    const { jobId, scope } = input;
    const previous = read(jobId);
    if (!Array.isArray(input.jobs) || !input.jobs.length || input.jobs.length > 5000) throw new Error('변경 목록은 1~5,000건이어야 합니다.');
    const jobs = structuredClone(input.jobs).map(job => ({ type: job.type, id: String(job.id ?? '').trim(), optionId: String(job.optionId ?? '').trim(),
      ...(job.type === 'images' ? { urls: job.urls, expectedRevision: job.expectedRevision }
        : job.type === 'name' ? { newName: job.newName, expectedName: job.expectedName }
        : { newPrice: job.newPrice, expectedPrice: job.expectedPrice }) }));
    const digest = createHash('sha256').update(JSON.stringify({ scope, jobs })).digest('hex');
    if (previous) {
      if (previous.digest !== digest) throw new Error('같은 작업 ID로 다른 변경 목록을 보낼 수 없습니다.');
      if (previous.status === 'DONE') return previous;
      throw new Error('이미 전송을 시작한 작업입니다. 현재가·이미지를 다시 조회해 결과를 확인하세요.');
    }
    const record = { jobId, scope, digest, jobs, status: 'PREPARING', startedAt: new Date().toISOString(), results: [], stopped: '', cancelled: false };
    const checks = new Map(), seen = new Set();
    const checkpoint = event => {
      if (directory) fs.appendFileSync(file(jobId) + 'l', JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n', { mode: 0o600 });
    };
    active = record;
    const emit = payload => { try { report({ jobId, scope, ...payload }); } catch {} };
    try {
      // 뒤쪽 행이 잘못돼도 앞쪽 상품이 먼저 바뀌지 않게 모든 입력과 공통 이미지 URL을 먼저 검사한다.
      for (const [index, job] of jobs.entries()) {
        if (record.cancelled) break;
        if (!['price', 'images', 'name'].includes(job.type)) throw new Error('변경 종류가 올바르지 않습니다.');
        const key = JSON.stringify([job.type, job.id, job.type === 'price' ? job.optionId || '' : '']);
        if (seen.has(key)) throw new Error('같은 상품·옵션의 중복 변경이 있습니다.');
        seen.add(key);
        await validate({ ...job, scope }, { checks });
        emit({ preparing: true, index: index + 1, total: jobs.length });
      }
      record.status = 'RUNNING';
      persist(record); // 이 기록에 실패하면 아직 어떤 상품에도 전송하지 않았다.
      for (let index = 0; index < jobs.length && !record.cancelled;) {
        let count = 1;
        const limit = savePrices && jobs[index].type === 'price' ? groupSize(scope) : 1;
        while (count < limit && index + count < jobs.length && jobs[index + count].type === 'price') count++;
        const group = jobs.slice(index, index + count);
        // 전송 직전 체크포인트. 앱 종료 뒤 같은 요청을 재전송하지 않는다.
        record.inFlight = { index, count };
        checkpoint({ inFlight: record.inFlight });
        let outcomes;
        try {
          // 묶음 안에서도 중단을 확인한다 — 중단 뒤에는 지금 보내는 한 건만 마친다.
          outcomes = limit > 1
            ? await savePrices(group.map(job => ({ ...job, scope })), { cancelled: () => record.cancelled })
            : [{ success: true, data: await save({ ...group[0], scope }, { checks }) }];
        } catch (error) {
          const info = describeError(error, { sent: !!error?.sent });
          outcomes = group.map(() => ({ success: false, ...info }));
        }
        for (let n = 0; n < group.length; n++) {
          const outcome = outcomes?.[n] || { success: false, stage: 'unknown', error: '일괄 요청 결과가 누락되었습니다.' };
          const item = { index: index + n, ...outcome };
          record.results.push(item);
          emit({ result: item, total: jobs.length });
          if ((!outcome.success && (group[n].type === 'images' || outcome.blocking || outcome.stage === 'unknown')) ||
              (group[n].type === 'images' && outcome.data?.status === 'CHECK'))
            record.stopped = outcome.error || outcome.data?.message || '반영 결과를 확인한 뒤 이어서 저장하세요.';
        }
        delete record.inFlight;
        checkpoint({ results: record.results.slice(-group.length) });
        index += count;
        if (record.stopped) break;
      }
      record.status = 'DONE'; record.finishedAt = new Date().toISOString();
      persist(record);
      return record;
    } catch (error) {
      if (record.inFlight || record.results.length) error.sent = true;
      throw error;
    } finally { active = null; }
  }
  return { run, read, cancel(jobId) { if (!active || active.jobId !== jobId) return false; active.cancelled = true; return true; } };
}
