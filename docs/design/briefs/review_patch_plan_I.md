# 시안 I 패치 계획 검토 요청 (코드는 고치지 말 것)

너는 검토자다. 매장에서 지금 쓰고 있는 앱에 UI 패치를 하기 전에, 계획에 빠진 위험이 없는지 찾는다.

## 읽을 것
- `docs/design/PATCH_PLAN_I.md` — 검토 대상 계획
- `CLAUDE.md`, `docs/FEATURES.md`
- 시안: `docs/design/mockups/I_Punch.html`, `I_Pay.html`(휴대폰), `docs/design/mockups/wide/I_Pay.html`(넓은 화면)
- 실제 앱: `web/index.html`, `web/style.css`, `web/app.js` (특히 `initTabs`, `openTab`, `renderMonthCalendar`, `renderPunch`, `renderChecklist`, `renderSetSummaries`, `body.locked`, `money-show`, 모달·팝업, `@media print`)

## 찾을 것
1. 단계 1(메뉴를 아래 고정/왼쪽 세로로 옮기기)에서 깨질 수 있는 것: 탭 전환 JS가 의존하는 DOM 구조, 화면 아래 고정 요소(팝업, 토스트, 저장 바, 키보드)와 겹침, `body.locked`, 인쇄, 다크 모드, 영어 글자 길이, iOS 아래 안전 영역.
2. 단계 2~6 각각에서 기능이 빠지거나 동작이 바뀔 위험 (FEATURES.md 번호로).
3. 계획의 순서·점검 방법에 빠진 것.
4. 계획에서 틀린 사실이 있으면(예: 함수 이름, 파일 위치, 월요일 시작 가정) 근거 줄 번호와 함께.

## 결과 파일
`docs/design/reviews/patch_plan_I_gemini.md` 하나만 만든다. 형식:
- 맨 위 한 줄: `결론: 진행 가능` 또는 `결론: 고친 뒤 진행` 
- `## 단계 1 위험` (가장 자세히, 항목마다 파일:줄 근거)
- `## 단계 2~6 위험`
- `## 계획에 더할 것`
짧고 구체적으로. 추측은 "추측"이라고 표시한다.
