결론: 고친 뒤 배포

## 단계 3 위험 확인

| 항목 | 상태 | 근거 및 비고 |
|---|---|---|
| 2-9 주휴 예외 버튼 (`data-week-excuse`) | 처리됨 | `web/app.js:632-654,731`에서 `이 주는 주휴 지급`/`다시 제외하기` 버튼과 클릭 훅(`1400-1415`) 유지. 단, 아래 `주휴 미포함` 덮어쓰기 버그 수정 필요 |
| 2-10 / 2-12 식대 1·2회 구분 | 처리됨 | `web/app.js:709`에서 파란 막대(`.cal-meal-bar`) 안에 `mealShort()`(`점`/`저`/`점저`, 영 `L`/`D`/`L+D`) 출력. 단, `web/index.html:222` 안내 문구에 `🍚 = 식대` 잔존 |
| 0-4 `#conflictBox` · 1-10 `#pendingBox` | 처리됨 | `web/index.html:67-70`과 렌더 함수 그대로 유지. PC 2단(`grid-column: 1`)에서 `#moneyBar`(`grid-column: 2`)와 겹치지 않음 |
| 2-18 줄 돈 바와 하위 버튼 | 부분 주의 | `#moneyBarBtn`이 `#moneyToggle` 클릭을 위임해 카톡·명세서·PDF·엑셀·설정·초기화·명단 버튼 경로 모두 유지. `z-index: 70`으로 메뉴(80)·토스트(85)·모달(100+) 아래에 정리됨. 단, 휴대폰에서 하단 메뉴+고정 바가 ~140px을 차지하고, `[보기]` 시 세부 버튼(`.pay-banner`/`.pay-actions`)은 달력 위쪽에 열림 |
| 2-17 `#rightViewSwitch` | 처리됨 | `web/index.html:207-214`, `web/app.js:608,619-620` 훅 그대로 유지(JS 에러 없음) |
| 2-1 `no-workers` · PC 2단 | 처리됨 | `web/app.js:845` `mb.hidden = !state.workers.length` + `web/style.css:2832` `body.no-workers .money-bar { display: none; }` 이중 차단. PC 2단(`style.css:2842-2844`)에서 `grid-column: 2; order: 20`으로 기존 그리드와 충돌 없음 |

## 필수 조건 1~5 확인

| # | 필수 조건 | 결과 | 확인 내용 |
|---|---|---|---|
| 1 | 금액 기본 숨김 · 보기/숨기기 | 조건부 통과 | 기본 숨김(`.m-amt`, `.wk-money`, `.pay-banner`/`.pay-actions`), `#moneyToggle`↔`#moneyBarBtn` 연동 정상. 단, 언어 전환 시 버튼 문구 꼬임 버그 있음(아래 2번) |
| 2 | 월별 달력으로 근무량 한눈에 | 통과 | 월요일 시작 7열 달력 구조·주차 구분 유지 |
| 3 | 칸 안에 일자·출근·퇴근·식대 | 통과 | 일자(`.cal-date-num`), 출근/퇴근 두 줄(`shiftRangeHtml` `09:00`/`18:02` 그대로), 식대 파란 막대(`.cal-meal-bar` + `점/저/점저`) 모두 칸 안에 표시 |
| 4 | 주차별 요약 (일수·시간·식대·주휴) | 조건부 통과 | `1주 · 5일 · 40h · 식대 5 · 주휴 O` 구성 충족. 단, `주휴 미포함` 시 진행 중/예정으로 덮이는 버그 있음(아래 1번) |
| 5 | 390px 밀도와 가독성 균형 | 통과(참고) | `74px` 높이, `tabular-nums`, 출근/퇴근 명암 구분, 하단 막대 배치 양호. 360px·큰 글자(`가+`, `zoom: 1.1`)에서는 `18:02` 폭이 칸 내부 폭과 빠듯하므로(추측) 확인 권장 |

## 새로 생긴 문제

1. **주휴 미포함 설정 시 이번 주·다음 주가 `진행 중`/`예정`으로 덮어쓰임 (`web/app.js:717`)** — **수정 필요**
   - `if (timing && !(wkObj.eligible || wkObj.excused))`에 `r.includeWeekly` 조건이 빠져 있어, 주휴수당 체크를 꺼도(`주휴 미포함`) 현재·미래 주차에 `진행 중`/`예정`이 표시됨.
   - 수정: `if (r.includeWeekly && timing && !(wkObj.eligible || wkObj.excused))`로 제한.
2. **한↔영 전환 후 `#moneyBarBtn`·`#moneyToggleTitle` 글자가 `money-show` 상태와 어긋남 (`web/app.js:1688-1694,3694-3711`)** — **수정 필요**
   - 예: 영어로 바꾼 뒤 `[Show]`를 눌러 금액을 표시한 상태에서 한국어로 돌아오면 `i18n.js:129` `restoreAll()`이 예전 원문(`보기`/`줄 돈 보기`)을 복원해 금액이 보이는데도 버튼이 `보기`로 표시됨.
   - 수정: `alba:lang` 리스너에서 `document.body.classList.contains('money-show')` 기준으로 `#moneyToggleTitle`과 `#moneyBarBtn` 텍스트를 다시 맞춤.
3. **달력 상단 안내 문구에 구 `🍚 = 식대` 잔존 (`web/index.html:222`, `web/lang_web.js:78`)** — **수정 권장**
   - 달력 칸은 🍚 이모지를 없애고 파란 막대(`점/저/점저`)로 바꿨는데 바로 위 안내 줄에 `· 🍚 = 식대`(`· 🍚 = meal`)가 그대로 남아 실제 표시와 불일치.
4. **참고(소형 화면·접근성)**: 360px·`가+`(`zoom: 1.1`)에서 칸 내부 폭(~32px) 대비 `18:02`가 빠듯하고, `.cal-day-cell.meal-ok` 선택 시 `style.css:2805`의 `background: transparent`가 `.selected` 배경을 덮음(파란 테두리는 유지됨).
