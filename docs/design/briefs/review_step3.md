# 3단계(근무·급여) 변경 검토 요청 — 코드는 고치지 말 것

`docs/design/PATCH_PLAN_I.md` 3단계를 적용한 변경이다. diff는 `logs/gemini/step3.diff`.
앞선 검토(`docs/design/reviews/patch_plan_I_gemini.md`)의 "단계 3" 위험(2-9 주휴 예외 버튼, 2-10/2-12 식대 1·2회 구분,
0-4 #conflictBox·1-10 #pendingBox, 2-18 줄 돈 바와 하위 버튼, 2-17 #rightViewSwitch, 2-1 no-workers·PC 2단)이 처리됐는지 확인한다.
CLAUDE.md "근무시간 정리(급여 홈) 화면 필수 조건" 5개도 확인한다(금액 기본 숨김, 달력, 칸 안에 일자·출근·퇴근·식대, 주차 요약, 390px 가독성).
필요하면 `web/app.js`(weekStatus, weekTiming, renderMonthCalendar, shiftRangeHtml, renderPayroll, moneyToggle), `web/style.css` 끝부분, `web/index.html`(#moneyBar)을 읽는다.

이미 확인: 390/1180/1440, 한/영, 다크, 주휴 예외 지급↔다시 제외, [보기]/[숨기기]가 위 버튼과 같은 상태, 주휴 금액은 보기일 때만,
넓은 화면에서 줄 돈 바가 달력 칸 아래에 붙음, 테스트(단위·서버·퍼즈·단일·스트레스·클라우드) 통과.

## 결과 파일
`docs/design/reviews/step3_gemini.md` 하나만.
- 맨 위 한 줄: `결론: 배포 가능` 또는 `결론: 고친 뒤 배포`
- `## 단계 3 위험 확인` 표, `## 필수 조건 1~5 확인` 표, `## 새로 생긴 문제`
짧게.
