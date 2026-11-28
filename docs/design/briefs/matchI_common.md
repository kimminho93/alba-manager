# 시안 I 그대로 맞추기 — 공통 규칙 (제미나이 작업용)

사용자 판단: 지금 배포된 화면이 시안 I와 다르다. **시안 I의 화면 구성(배치)을 그대로** 따르도록 고친다.
Claude는 작업하지 않고 화면이 시안과 같은지만 검토한다. 작업·테스트는 너(제미나이)가 한다.

## 기준 시안 (직접 열어 읽는다)
- 휴대폰(390×844): `docs/design/mockups/I_Punch.html`, `I_Pay.html`, `I_Chk.html`, `I_QR.html`, `I_Set.html`, `I_Cust.html`
- 태블릿 가로·PC: `docs/design/mockups/wide/I_*.html`
- 색·글꼴 기준: `docs/design/README.md`. 기능 목록: `docs/FEATURES.md`(하나도 빠지면 안 됨)
- 지금까지의 패치 기록과 지켜야 할 것: `docs/design/PATCH_PLAN_I.md`, 앞선 검토 `docs/design/reviews/*.md`

## 시안 I의 공통 구성 (지금 앱과 다른 점)
- 시안에는 **모든 화면 위에 공통 머리띠(“사장님 도우미” + 버튼들)가 없다.** 화면마다 자기 머리 줄이 있다.
  - 출퇴근: 왼쪽 가게 이름, 오른쪽 [관리자] 버튼
  - 근무·급여: 왼쪽 "홍길동 ▾"(알바생 고르기), 오른쪽 알림(종, 숫자 배지)·⋯ 더보기
  - 위생 점검: 왼쪽 "위생 점검", 오른쪽 보관함 아이콘·⋯ 더보기
  - 설정: "설정" + 버전
- 휴대폰 아래 메뉴 4개, 넓은 화면 왼쪽 세로 메뉴는 이미 되어 있다(그대로 둔다).

## 반드시 지킬 것
1. **계산·저장·동기화는 바꾸지 않는다**: `web/engine.js`, `web/gsync.js`, `src/`는 고치지 않는다. 저장 형식(localStorage 키, 체크박스 2상태 등)도 그대로.
2. **id·data- 속성 훅을 지우지 않는다.** `web/app.js`가 `$('…')`로 찾는 요소는 모두 남아 있어야 한다(옮기기·숨기기·모양 바꾸기는 된다).
   특히 `#cloudBtn`(없으면 구글 연동 창이 멈춤), `#lockBtn`, `#bellBtn`, `#helpBtn`, `#workerChips`, `#moneyToggle`, `#openSet`, `#setSheet`,
   `#rightViewSwitch`, `#btnViewSchedule`, `#btnViewSlip`, `#pendingBox`, `#conflictBox`, `#workNow`, `#moneyBar`, `#chkFormList`, `#cDate`, `#cInspector`,
   `#cFridge`, `#cFreezer`, `#cMemo`, `#btnCheckAll`, `#btnCheckNone`, `#btnAddArchive`, `#chkDoc`, `#archiveBody`, `.tabs .tab[data-tab]`, `[data-day-idx]`, `[data-week-excuse]`, `[data-punch]`.
3. **기능이 화면에서 사라지면 안 된다.** 시안에 안 보이는 기능(예: 정산 설정, 명세서·카톡·PDF·엑셀, 정산 명단, 출퇴근 중 표시, 점검표 미리보기·보관함)은
   ⋯ 더보기, 이름 ▾ 메뉴, 줄 돈 바를 눌렀을 때 펼침 같은 곳으로 **옮겨서** 남긴다. 어디로 옮겼는지 답에 적는다.
4. 급여 금액은 기본 숨김(눌러야 보임). 숨김일 때 금액 글자를 화면에 넣지 않는 지금 방식(`fillMoney`, `syncMoneyUi`)을 유지한다.
5. 잠긴 매장 기기(`body.locked`)는 출퇴근 화면만 보여야 한다. 인쇄(명세서·점검표·계좌 안내판)가 깨지면 안 된다.
6. 새 글자는 `web/lang_web.js`에 영어도 넣는다. 이미 있는 키를 다른 뜻으로 덮어쓰지 않는다(예: "출근", "퇴근", "휴무", "관리자"는 사전에 넣지 않음).
   이모지 대신 선 아이콘(SVG, stroke 1.8~2). 색은 CSS 변수(다크 모드 유지).
7. 휴대폰 390px, 태블릿 가로 1180px, PC 1440px 모두. 넓은 화면은 `mockups/wide/I_*.html` 배치를 따른다.
8. 파일을 고쳤으면 `web/index.html`의 `?v=` 7개 값을 모두 같은 새 숫자로 올린다(매장 기기 자동 새로 고침).
9. 끝나면 허용된 명령으로 테스트를 돌린다: `node tools/build.js`, `node tests/test_main.js`, `node tests/test_server.js`, `node tests/test_cloud.js`,
   `node tools/i18n_scan.js`, `node tools/i18n_scan.js web/app.js`. build 뒤 `git status --short`에 `web/engine.js`가 바뀌었다고 나오면(줄 끝만 다름)
   `git checkout -- web/engine.js`로 되돌린다. 실패가 있으면 고치고 다시 돌린다.
10. 커밋·푸시는 이 단계에서 하지 않는다(Claude가 화면 검토를 마친 뒤 따로 맡긴다).

## 답에 적을 것
- 고친 파일, 시안과 같아진 점, 시안과 아직 다른 점(이유), 옮긴 기능과 새 위치, 테스트 결과.
