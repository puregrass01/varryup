/**
 * executeAutomation 결과 → imweb-register IPC 응답 (공통 계약 C1).
 * success 는 요청한 대상이 전부 성공했을 때만 true. 일부만 성공하면 success:false + partial:true 이고,
 * error 에 실패한 대상과 이유를 적는다. 아무 대상도 처리하지 않았으면(선택 없음) 성공으로 치지 않는다.
 * @param {{summary?: string, results?: Array<{target: string, ok: boolean, error?: string}>}} run
 * @param {string} [suffix] 중복검사 안내(noticeSuffix) — message·error 끝에 붙인다.
 */
export function imwebRunResponse(run, suffix = '') {
    const results = (run?.results || []).map(r => ({ target: r.target, ok: !!r.ok, ...(r.ok ? {} : { error: r.error || '실패' }) }));
    const message = (run?.summary || '') + suffix;
    if (!results.length) {
        return { success: false, error: '처리한 대상이 없습니다 (개별/세트를 선택하세요).' + suffix, message, results };
    }
    const failed = results.filter(r => !r.ok);
    if (!failed.length) return { success: true, message, results };
    const partial = failed.length < results.length;
    const detail = failed.map(r => `${r.target}: ${r.error}`).join(' / ');
    return {
        success: false,
        partial,
        message,
        results,
        error: (partial ? `일부 실패 (성공: ${results.filter(r => r.ok).map(r => r.target).join(', ')}) — ` : '') + detail + suffix,
    };
}

// 브라우저를 쓰지 않는다 — 본사·해외·일본몰 게시판(관리자 로그인 + cm API 크롤링)은 Open API 에 게시판이 없어 2026-10-27 지웠다.
export class Imweb {
    constructor() {
        this.logCallback = null;
    }

    log(msg) {
        console.log(msg);
        if (this.logCallback) {
            this.logCallback(msg);
        }
    }

    /**
     * 아임웹 B2B몰 등록.
     * @returns {Promise<{summary: string, results: Array<{target: string, ok: boolean, error?: string}>}>}
     *   results 는 요청한 대상마다 한 줄. main 의 imweb-register 가 imwebRunResponse 로 success/partial 을 정한다.
     *   예전엔 요약 문자열만 돌려주고 main 이 무조건 success:true 로 감싸서 "B2B몰 등록 일부 실패",
     *   숨김 상태로 남은 상품까지 성공으로 보고됐다.
     */
    async executeAutomation(data) {
        const summary = [];
        const results = [];
        // 이번 실행에서 실제로 만든 B2B 상품번호. main 이 중복 방지 원장에 적는다.
        this.lastRegistered = [];

        const b2bTarget = type => (type === 'set' ? 'B2B 세트' : 'B2B 개별');
        const requestedB2b = [data.registerIndiv && 'indiv', data.registerSet && 'set'].filter(Boolean);
        const b2bSummary = (verb, list) => {
            const okTypes = list.filter(r => r.ok).map(r => (r.type === 'set' ? '세트' : '개별'));
            return list.some(r => !r.ok)
                ? `B2B몰 ${verb} 일부 실패 (성공: ${okTypes.join(', ') || '없음'})`
                : `B2B몰 ${verb} 성공 (${okTypes.join(', ')})`;
        };
        // 대상별 결과 → results. 결과가 비어 있는(요청했는데 아무 줄도 안 돌아온) 대상도 실패로 채운다.
        const pushB2b = (list, missingError) => {
            for (const type of requestedB2b) {
                const r = list.find(x => x.type === type);
                results.push(r
                    ? { target: b2bTarget(type), ok: !!r.ok, ...(r.ok ? {} : { error: r.error || '실패 (로그 참고)' }) }
                    : { target: b2bTarget(type), ok: false, error: missingError });
            }
        };

        if (data.targetB2b) {
            const verb = '등록';
            // B2B몰은 아임웹 Open API 로만 한다(imweb_b2b.js). 단계가 통째로 던지면
            // (OAuth 값 · 토큰 · 카테고리 트리 등 대상 처리 전 단계) 요청한 개별/세트를 모두 그 오류로 실패
            // 처리한다. 대상별 오류는 *ViaApi 가 결과에 담아 돌려준다.
            try {
                this.log('========== B2B몰 쇼핑 상품 등록 시작 (Open API) ==========');
                const list = await this.registerB2bViaApi(data);
                // 만들어진 상품은 성공 여부와 상관없이 원장에 적는다 — 숨김·소매가로 남았어도 상품은
                // 있으므로 재시도가 같은 상품을 또 만들면 안 된다. (recordImweb 은 ok && no 만 적는다)
                for (const r of list) if (r.no) this.lastRegistered.push({ kind: 'b2b', type: r.type, ok: true, no: r.no, title: r.title });
                pushB2b(list, `${verb} 결과가 없습니다 (로그 참고)`);
                summary.push(b2bSummary(verb, list));
            } catch (e) {
                this.log(`⚠ B2B몰 ${verb} 중단: ${e.message}`);
                pushB2b([], e.message);
                summary.push(`B2B몰 ${verb} 실패`);
            }
        }
        return { summary: summary.join(', '), results };
    }
}
