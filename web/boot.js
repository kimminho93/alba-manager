/* 화면을 그리기 전에 글자 크기·테마를 먼저 맞춤 (깜빡임 방지). 보안 정책(CSP)상 인라인 스크립트를 쓰지 않으려고 파일로 둠 */
(function () {
  try {
    if (localStorage.getItem('alba.bigFont') === '1') document.documentElement.setAttribute('data-fs', 'large');
    var t = localStorage.getItem('alba.theme');
    if (!t) t = window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', t);
  } catch (e) {}
  // 다른 사이트가 이 앱을 몰래 감싸(iframe) 누르게 하는 것(클릭재킹) 방지
  if (window.top !== window.self) {
    try { window.top.location.replace(window.self.location.href); } catch (e) { document.documentElement.style.visibility = 'hidden'; }
  }
  // 이 앱의 입력 양식은 페이지를 이동하지 않음 (예전 onsubmit="return false" 대신)
  document.addEventListener('submit', function (ev) { ev.preventDefault(); }, true);
})();
