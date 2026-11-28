결론: 배포 가능

## 단계 2 위험 확인

| 항목 | 상태 | 근거 파일:줄 |
|---|---|---|
| 0-3 `#punchCloud` (구글 저장 상태) | 해결됨 | `web/index.html:57`, `web/app.js:2200-2216`, `web/style.css:2588,2730,2767,2784` — 모바일·1024px+ 모두 `#tab-punch .punch-wrap` 안(`grid-area: cloud`)에 유지되어 `body.locked`에서도 노출, 잠금 시 조용한 스타일도 보존 |
| 1-10 퇴근 확인 필요 경고 | 해결됨 | `web/app.js:2859,2862`, `web/style.css:2411,2751` — `.punch-main` 안에 비클릭 `<span class="punch-chip warn">` 유지(급여 탭 이동 링크 없어 `body.locked` 충돌 없음) |
| 5-3 `#punchRemote` (요청자 기기) | 해결됨 | `web/index.html:53`, `web/app.js:2836-2843,2864`, `web/style.css:2466-2468,2730,2738,2746,2780` — 안내 배너 유지, 제목·모두 퇴근 숨김, 줄은 비클릭 `<div class="punch-row view">`로 렌더링(오른쪽 출근/퇴근 표시 제외) |
| 1-2/1-3 줄 구조·비밀번호 20자 | 해결됨 | `web/app.js:2855-2866,2894-2949,3509-3516`, `web/index.html:923-935` — 줄 전체 `<button data-punch>` 유지(`.punch-act`는 `<span>`), `#punchPwInput`(`maxlength="20"`, 숫자/문자 `inputmode` 전환) 그대로 유지 |
| 1-5 `#punchBankBtn` 숨김 배치 | 해결됨 | `web/index.html:56,58`, `web/app.js:3251`, `web/style.css:2762-2765,2788` — 모바일에서 `#punchBankBtn[hidden] ~ .punch-lang { grid-column: 1 / -1; }`, 1024px+에서 `grid-column: auto`로 왼쪽 열 유지 |
| 0-1 `#lockBtn` 글자/아이콘 | 미룸 | `web/index.html:27`, `web/app.js:2429` — 5단계(머리띠 정리)에서 변경 예정으로 현재 유지 |

## 새로 생긴 문제

1. **긴 이름에서 말줄임(`…`) 미동작 및 근무 중 파란 점(`.punch-dot`) 잘림 (경미)**
   - 근거: `web/app.js:93,2860-2861`(`.punch-name` 안에 `<span data-no-i18n>` + `<span class="punch-dot">`), `web/style.css:2748-2749`(`#tab-punch .punch-name { display: flex; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }`).
   - 영향: `text-overflow: ellipsis`는 `display: flex` 컨테이너에 적용되지 않아, 1024px 2열 명단처럼 칸이 좁을 때 긴 이름이 `…` 없이 잘리고 오른쪽의 `.punch-dot`도 영역 밖으로 밀려 보이지 않음(출근/퇴근 상태 자체는 `.punch-sub`와 `.punch-act`로 확인 가능).
   - 조치: `#tab-punch .punch-name > :first-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; }` 추가.

2. **다크 모드 `[출근]` 표시(`.punch-act`) 명암비 낮음 (경미)**
   - 근거: `web/style.css:33-34`(`--primary: #6d8dff; --primary-ink: #0d1220;`), `web/style.css:2754`(`#tab-punch .punch-act { background: var(--primary); color: #fff; }`).
   - 영향: 다크 모드에서 밝은 파랑(`#6d8dff`) 위 흰 글씨(`#fff`) 명암비가 약 3.0:1로 떨어짐(`.btn-primary`는 `web/style.css:963`에서 `var(--primary-ink)` 사용).
   - 조치: `color: var(--primary-ink)`로 변경(라이트는 `#fff` 그대로 유지, 다크는 `#0d1220`으로 개선).
