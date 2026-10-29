// 밝게 / 어둡게 — 런처·베리씨드·베리업이 공유한다.
//
// 세 화면이 각자 테마를 들고 있으면 창을 옮길 때마다 색이 달라진다. 값은 localStorage
// 하나에만 두고(같은 file:// 오리진이라 세 문서가 같은 저장소를 본다) 여기서만 읽고 쓴다.
//
// 이 파일은 반드시 <head> 에서, 스타일시트보다 먼저 불러야 한다. 아래 즉시 실행이
// <html data-theme> 를 먼저 박아 두지 않으면 첫 페인트가 어두운 채로 한 번 번쩍인다.
(function () {
  const KEY = 'veryup-theme';

  // 저장소가 막혀 있어도(사생활 모드·정책) 화면은 떠야 하므로 기본값으로 떨어진다.
  const read = () => {
    try { return localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light'; }
    catch (e) { return 'light'; }
  };

  // 버튼에는 누르면 갈 쪽을 그린다: 어두울 때 해, 밝을 때 달. 색은 버튼 글자색을 따른다.
  const SVG = (d) => '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + '</svg>';
  const ICON = {
    dark: SVG('<circle cx="8" cy="8" r="3"/><path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1"/>'),
    light: SVG('<path d="M13.5 9.6A5.6 5.6 0 0 1 6.4 2.5a5.6 5.6 0 1 0 7.1 7.1z"/>'),
  };

  let onApply = null;

  function applyTheme(theme) {
    theme = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.dataset.theme = theme;
    for (const btn of document.querySelectorAll('[data-theme-toggle]')) {
      btn.innerHTML = ICON[theme];
      btn.title = theme === 'dark' ? '밝게 보기' : '어둡게 보기';
      btn.setAttribute('aria-label', btn.title);
    }
    try { localStorage.setItem(KEY, theme); } catch (e) {}
    if (onApply) onApply(theme);   // iframe 을 가진 화면이 자기 쪽을 맞출 기회
  }

  function toggleTheme() {
    applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  }

  // 1단계: 첫 페인트 전에 값만 박는다.
  document.documentElement.dataset.theme = read();

  // 2단계: DOM 이 준비된 뒤 버튼을 묶는다. onApply 를 주면 테마가 바뀔 때마다 불린다.
  function init(opts) {
    onApply = (opts && opts.onApply) || null;
    applyTheme(read());
    for (const btn of document.querySelectorAll('[data-theme-toggle]')) {
      btn.addEventListener('click', toggleTheme);
    }
  }

  window.VUTheme = { applyTheme, toggleTheme, init, current: read };
})();
