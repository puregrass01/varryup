// 옛 로그 채널 → 현재 화면이 듣는 채널로 번역.
//
// 사연
//   런처 구조로 바뀌기 전에는 단일 창(index.html)이 'log' · 'imweb-log' 등을
//   직접 들었다. 지금 화면(index_up.html)이 듣는 것은
//   **'veryup-log' 하나뿐**이고 형식도 {message, level} 로 다르다.
//
//   그런데 main_process 에는 옛 채널로 보내는 코드가 11곳 남아 있었고,
//   심지어 보내는 대상 창(mainWindow)조차 대입된 적이 없었다. 즉 두 겹으로 끊겨 있었다:
//     1) 창이 없어서 안 감  2) 갔어도 그 채널을 듣는 화면이 없음
//   그래서 업데이트가 401 로 막혀도, 아임웹·네이버 작업이 실패해도
//   **화면에는 아무것도 안 떴다.**
//
//   호출부 11곳을 전부 고쳐 쓰는 대신 여기서 번역한다 — 옛 채널로 보내는 코드가
//   또 생겨도 자동으로 화면에 닿는다.
export const VERYUP_LOG_CHANNEL = 'veryup-log';

/** 옛 채널 이름 → 화면에 붙일 접두사. 여기 없는 채널은 번역하지 않는다. */
const PREFIX = {
    'log': '',                       // 업데이트 알림 등. 메시지에 이미 [업데이트] 가 붙어 온다.
    'imweb-log': '[아임웹] ',
    'naver-log': '[네이버] ',
};

// 실패를 info 로 흘리면 사용자가 로그 더미에서 놓친다. 문구로 등급을 올린다.
const ERROR_WORDS = ['오류', '실패', '에러', 'error', 'failed', '401', '403', '404', '500'];

/**
 * 옛 채널 메시지를 veryup-log 형식으로 바꾼다.
 * @returns {{message: string, level: string}|null} 번역 대상이 아니면 null
 */
export function toVeryupLog(channel, payload) {
    const prefix = PREFIX[channel];
    if (prefix === undefined) return null;          // 모르는 채널은 건드리지 않는다

    // 현재 화면의 계약은 문자열 message 다. 객체가 오면 이미 새 형식이므로 그대로 둔다.
    if (payload && typeof payload === 'object') {
        return typeof payload.message === 'string'
            ? { message: prefix + payload.message, level: payload.level || 'info' }
            : null;
    }
    if (typeof payload !== 'string') return null;

    const lower = payload.toLowerCase();
    const level = ERROR_WORDS.some((w) => lower.includes(w.toLowerCase())) ? 'error' : 'info';
    return { message: prefix + payload, level };
}
