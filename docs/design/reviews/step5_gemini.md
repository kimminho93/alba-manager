결론: 고친 뒤 배포

## 단계 5 위험 확인

| 항목 | 상태 | 근거 및 비고 |
|---|---|---|
| 0-3 `#cloudBtn` 유지 | 처리됨 | `web/index.html:29`에 그대로 유지되어 `renderCloudUi()`(`web/app.js:2310-2367`)와 `body.locked #cloudBtn`(`web/style.css:2263`) 정상 동작 |
| 0-5 `#helpBtn` · 가이드 문구 · 이동 동선 | 부분 미흡 | `#helpBtn`은 DOM에 남겨 `hidden` + `display: none !important`(`web/index.html:30`, `web/style.css:2893`) 처리해 `initTabs()`(`web/app.js:217-218,223-224`) 오류 없음. 한국어 가이드·확인창의 `[?]`·`[🔒 관리자]` 문구 정리 완료(`web/index.html:640,678`, `web/app.js:3688`). 다만 영어 가이드 버튼명 불일치(아래 2번)와 `#tab-guide` 열림 시 활성 탭 표시 부재(아래 3번)가 남음 |
| 외부 점프 (`acc-bank`, `acc-store`) | 처리됨 | 설정 배치를 기존 `<details class="set-acc">` 아코디언으로 유지해 `acc-bank`·`bankWarn` 스크롤(`web/app.js:3439`)과 `acc-store`·`sStoreName` 포커스(`web/app.js:3588`) 깨짐 없음 |
| 5-10 세율 입력 (`sRate_*`) | 처리됨 | `web/index.html:553-561`의 `sRate_*` `<input>` 6개 변경 없이 편집 가능 |
| `renderSetSummaries()` ID | 처리됨 | `#sumStore`·`#sumPunch`·`#sumSound`·`#sumSaver`·`#sumWage`·`#sumHealth`·`#sumTax`·`#sumLang`·`#sumInfo` 및 `#pinState`·`#devState`·`#bankState` 모두 유지(`web/index.html:438-580`, `web/app.js:2525,3530-3543`) |
| CSP와 CSS `mask` `data:` URI | 문제 없음 | `web/index.html:5`의 `img-src 'self' data: blob: https:;`가 CSS `mask` / `-webkit-mask`의 `data:image/svg+xml`을 허용(`web/style.css:2896-2904`). `#` 미사용·`currentColor` 적용으로 라이트/다크 모두 안전 |
| `#lockBtn` 사전 제외·아이콘 전환 | 처리됨 | `data-no-i18n`(`web/index.html:27`) + `applyLockUi()` 직접 분기(`web/app.js:2520-2523`) + `alba:lang` 재호출(`web/app.js:3783`)로 시트 탭 `"관리자"` 번역 오염 없이 한/영 전환 및 잠김/열림 아이콘 정상 |

## 새로 생긴 문제

1. **매장명 미입력 시 1300px+ `#railStore`가 언어 전환(`alba:lang`)에 반응하지 않음 (`web/app.js:3575,3762-3784`, `web/index.html:35`)** — **수정 필요**
   - `#railStore`에 `data-no-i18n`이 붙어 `i18n.js`가 건드리지 않고, `alba:lang` 리스너(`web/app.js:3762-3784`)에서도 `applyStoreInfo()`나 `#railStore`를 다시 쓰지 않음.
   - 재현: 매장명이 비어 있는 기본 상태로 1440px에서 한국어 → 영어 전환 시 왼쪽 메뉴 맨 위가 `"사장님 도우미"`로 남음(영어 → 한국어 전환 시 `"Boss Helper"`로 남음).
   - 수정: `alba:lang` 리스너(`web/app.js:3783`)에 `if ($('railStore')) $('railStore').textContent = storeName() || tr('사장님 도우미');` 추가.
2. **영어 가이드의 설정 버튼 명칭 불일치 (`web/lang_web.js:209` vs `web/lang_web.js:621`)** — **수정 필요**
   - `web/lang_web.js:209`는 `tap <b>[View guide]</b> at the bottom of <b>Settings</b>`라고 안내하지만, 실제 설정 맨 아래 `#btnSetGuide`(`web/index.html:597`)는 `web/lang_web.js:621`에 의해 **`Open the guide`**로 표시됨.
   - 수정: `web/lang_web.js:209`의 `[View guide]`를 `[Open the guide]`로 맞추거나 `web/lang_web.js:621`을 `View guide`로 통일.
3. **`#tab-guide` 열림 시 메뉴 활성 표시 없음 (`web/app.js:208-212`, `web/index.html:40`)** — **참고**
   - `#helpBtn`을 숨긴 뒤 사용 방법을 열면 숨은 `.tab-guide`만 `.active`가 되어 보이는 탭 4개가 모두 비활성 상태로 보임(다른 탭을 눌러 돌아갈 수는 있음). 필요하면 `target === 'guide'`일 때 `settings` 탭을 활성 표시하거나 가이드 상단에 돌아가기 동선 추가 검토.
