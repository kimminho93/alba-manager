결론: 고친 뒤 배포

## 단계 6 위험 확인

| 항목 | 상태 | 근거 및 비고 |
|---|---|---|
| 4-4 `pay.js` 복사 버튼 덮어쓰기 | 처리됨 | `web/pay.html:23`과 `web/pay.js:11-12,19-20`에서 이모지(`📋`, `✅`)를 함께 지우고 순수 글자만 사용해 `pay.js:63,69,84`의 `textContent` 대입 충돌 없음 |
| 4-4 CSP · 다크 모드 · 오류 상태 | 부분 미흡 | `web/pay.html:5` CSP(`style-src 'self'`) 준수(인라인 스타일·외부 폰트 없음, `?v=202611290200` 갱신). 복사 실패 빨간 글씨(`.done.fail`, `web/pay.js:83`, `web/pay.css:20`)와 `#bad`(`pay.css:22`) 정상. 단, 다크 모드 복사 완료 버튼 대비 부족(아래 1번) |
| 4-2 / 4-3 `#bankModal` 확장·잠금 정책 | 처리됨 | `#bankModal` DOM(`web/index.html:984-998`)과 `openBank()`(`web/app.js:3398-3409`)는 유지하고 CSS만 전체 화면화(`web/style.css:2920-2953`). 모달 내 복사·인쇄 버튼을 넣지 않아 `body.locked` 보기 전용 유지. 단, 1440px+ 가로 중앙 정렬 어긋남(아래 3번) |
| 번역 누락·키 일치 · SVG 보호 | 부분 미흡 | 이모지 제거 35건 키 일치·중복 키 4개 정리 완료(`i18n` 누락 0). `#bellBtn`·`#themeToggle`·`.brand-logo` SVG는 한글 텍스트가 없어 `i18n.js`가 덮어쓰지 않으며 `alba:lang`에서 `syncThemeBtn()` 재실행(`web/app.js:3785`). 단, 영어 가이드 1곳에 `✅` 잔존(아래 2번) |
| 다크 모드 QR 흰 바탕 | 처리됨 | `web/style.css:2930` `#bankModal .bank-qr { background: #fff; padding: 16px; }`와 `src/qr.js:275` `<rect fill="#fff"/><path fill="#000"/>`로 다크 모드에서도 흰 바탕·여백 유지 |
| 인쇄 (`body.print-bank`) | 처리됨 | `#bankModal` 전체 화면 규칙(`web/style.css:2920-2953`)과 좌측 메뉴 여백(`web/style.css:2706,2715`)이 모두 `@media screen` 안에 있어 `@media print`의 `body.print-bank`(`web/style.css:2311,2522-2533`) 영향 없음 |

## 새로 생긴 문제

1. **손님 화면(`pay.html`) 다크 모드 복사 완료 버튼 대비 부족 (`web/pay.css:3,18`)** — **수정 필요**
   - `.btn.primary`(`pay.css:17`)는 다크 모드용 `--primary-ink: #0d1220`을 썼지만, `.btn.primary.copied`(`pay.css:18`)는 `color: #fff`를 고정해 다크 모드 `--ok: #34c77f` 위 흰 글씨 대비가 약 **2.18:1**(WCAG AA 대형 글씨 3:1 미달)로 떨어짐.
   - 수정: `web/pay.css:18`의 `color: #fff;`를 `color: var(--primary-ink);`로 변경(라이트는 `#fff` 유지, 다크는 `#0d1220`으로 대비 약 8.6:1).
2. **영어 가이드에 지운 `✅` 이모지 잔존 (`web/lang_web.js:262`)** — **수정 필요**
   - 한국어 키 `"전부 괜찮다면 <b>[전체 적합으로 체크]</b>를 누르면 됩니다."`는 맞아서 누락 검사에는 걸리지 않으나, 영어 값이 `"If everything is fine, just tap <b>[✅ Mark all as pass]</b>."`로 남아 실제 버튼(`Mark all as pass`, `web/lang_web.js:129`)과 다름.
   - 수정: `web/lang_web.js:262`에서 `✅ ` 제거.
3. **1440px+ 넓은 화면에서 `#bankModal`이 오른쪽으로 치우침 (`web/style.css:2942,2946`)** — **수정 권장**
   - `grid-template-columns: minmax(0, 1fr) minmax(320px, 420px)` 때문에 첫 열(`1fr`)이 남은 폭을 모두 가져가 `justify-content: center`가 듣지 않음(1440px 기준 왼쪽 빈 공간 388px vs 오른쪽 64px). 또한 `width: min(46vw, 520px)`에 세로(`vh`) 상한이 없어 높이가 낮은 가로 화면에서는 스크롤이 생길 수 있음.
   - 수정: `grid-template-columns: auto minmax(320px, 420px);`, `#bankModal .bank-qr`에 `width: min(46vw, 68vh, 520px);` 적용.
