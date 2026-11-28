결론: 고친 뒤 진행

## 단계 1 위험

1. **영어 전환 시 탭 아이콘(SVG) 삭제됨 (치명적)**
   - 근거: `web/index.html:35,37`의 출퇴근·위생 점검 탭 버튼에 `data-en="Clock-in"`, `data-en="Hygiene"`이 버튼 자체에 붙어 있고, `web/i18n.js:63-66`은 `data-en`이 있는 요소에 `el.textContent = el.getAttribute('data-en')`을 실행함.
   - 영향: `<button class="tab">` 안에 `<svg>`를 넣고 `data-en`을 버튼에 그대로 두면 영어 모드에서 `<svg>`가 통째로 지워짐.
   - 대응: 탭 라벨을 `<span>`으로 감싸고 `data-en`도 그 `<span>`으로 이동. `'근무·급여'`는 `web/lang_web.js`에 키가 없으므로(`"급여"`만 `web/lang_web.js:601`에 존재) 짧은 영어 라벨(예: `data-en="Work & Pay"` 또는 `"Payroll"`)을 함께 넣어야 함.

2. **영어 글자 길이로 인한 잘림·줄바꿈**
   - 근거: `web/style.css:2572`에 `.tab { white-space: nowrap; }`, `web/style.css:2652`에 380px 이하 영어 폰트 축소 규칙이 있음. 넓은 화면 1024~1299px 왼쪽 세로 메뉴는 폭 `88px`(버튼 `72px`, `docs/design/mockups/wide/I_Pay.html:38,57`).
   - 영향: 390px 4등분(~93px/칸) 및 88px 세로 레일(72px)에서 `Clock in/out`, `Work & Pay`, `Settings`가 겹치거나 넘칠 위험. `data-en` 짧은 라벨 + `font-size: 11~12px`·`min-width: 0` 점검 필요.

3. **탭 전환 JS가 의존하는 DOM 구조·숨긴 `guide` 탭·가게 이름 반영 누락**
   - 근거: `web/app.js:203`(`.tabs .tab`), `web/app.js:2420`(`.tabs .tab[data-tab="..."]`), `web/app.js:1639` (`#emptyGuide`가 `.tab[data-tab="guide"]` 직접 클릭), `web/index.html:39` + `web/style.css:2571`(`.tab-guide`는 `hidden` + `display: none !important`).
   - 영향: `.tabs` 마크업을 고치다 `.tab-guide` 버튼을 없애면 `#helpBtn`, `#btnSetGuide`, `#emptyGuide`의 사용 방법 열기가 전면 실패함.
   - 계획 누락: 1300px 이상 왼쪽 세로 메뉴에 "가게 이름"을 넣으려면(`docs/design/PATCH_PLAN_I.md:20`) `web/app.js:3438-3450` (`applyStoreInfo`)에서 새 요소를 갱신해야 하므로 `web/app.js` 수정이 필요함(계획표 1단계 파일 목록에 `app.js`·`lang_web.js` 누락). 또 `.app-header`를 1024px+에서 숨기면 `#lockBtn`·`#bellBtn`·`#cloudBtn`·`#helpBtn`(`web/index.html:26-31`)과 `.brand h1` 이스터에그(`web/app.js:3654`)가 사라지므로 1단계에서는 `.app-header`를 유지할지 명확히 정해야 함.

4. **`!important` 충돌 및 `body.locked` 빈 여백·노출 위험**
   - 근거: `web/style.css:2263` `body.locked .tabs { display: none !important; }` (명시도 `0,2,1`), `web/style.css:2570` `.tabs { display: grid !important; }` (명시도 `0,1,0`, 더 아래 선언).
   - 영향: 단계 1에서 `.tabs`에 `@media (min-width: 1024px)` 등으로 명시도가 더 높은 선택자 + `!important`를 쓰면 `body.locked`에서도 메뉴가 노출돼 관리자 잠금(0-1)이 뚫림.
   - 또한 잠금 상태(`body.locked`)에서는 `.tabs`가 숨겨지므로, 본문(`.container`, `.app-header`, `#devBar`, `.app-footer`)에 주는 하단 `padding-bottom`·좌측 `padding-left`/`margin-left`(88px/220px)는 반드시 `body:not(.locked)` 조건으로 걸어야 잠긴 출퇴근 화면에 빈 띠가 생기지 않음.

5. **화면 아래 고정 요소·모달 z-index·스크롤·가상 키보드 겹침**
   - 근거 (z-index 계층): `.scroll-menu` `40`(`web/style.css:717`), `.toast`·`.more-pop` `50`(`web/style.css:1452,2597`), `#cloudModal` `100`(`web/style.css:1790`), `#dayModal` `200`(`web/style.css:1985`), `.sheet-backdrop` `900` / `#setSheet`·`#addWorkerForm`·`#exportSheet` `910` / `body.slip-open #payDoc` `920`(`web/style.css:2107-2135,2233-2238`), `.punch-modal`(`#punchPw`·`#punchResult`·`#pinSetup`·`#healthModal`·`#bankModal`·`#adminPin`) `1000`(`web/style.css:2287`), `#saver` `3000`(`web/style.css:2362`).
   - 영향:
     - `.tabs`의 `z-index`가 `100` 이상이면 `#cloudModal`, `200` 이상이면 `#dayModal`의 하단 `.day-actions`(`web/style.css:2013`)를 가림 → `.tabs`는 `z-index: 60~80`으로 제한해야 함.
     - `.toast`(`web/style.css:1437-1454`)가 `bottom: 26px; z-index: 50`이라 하단 고정 메뉴 뒤에 가려짐 → `body:not(.locked)` 모바일에서 `bottom`을 하단 메뉴 높이 위로 올리고 `z-index`를 `.tabs`보다 높여야 함.
     - `.container`(`web/style.css:202` `padding-bottom: 24px`)·`.app-footer`(`web/style.css:1433` `padding-bottom: 28px`)에 하단 메뉴 높이 + 안전 영역만큼 여백을 더하지 않으면 `#punchLang`, 정산 명단 하단, 위생 점검 보관함 하단, 설정 맨 아래 `#btnSetGuide`가 가려져 터치 불가.
     - 가상 키보드(추측): 안드로이드 Chrome·iOS Safari에서 본문 내 `<input>`/`<textarea>`(위생 점검 `#chkForm`, 설정 아코디언, `#guideSearch`) 포커스 시 `position: fixed; bottom: 0` 메뉴가 키보드 위로 따라 올라와 입력칸을 가릴 수 있음(실기기/모바일 에뮬레이터 확인 필요).

6. **iOS 하단 안전 영역(`safe-area-inset-bottom`) 미동작**
   - 근거: `web/index.html:6`이 `<meta name="viewport" content="width=device-width, initial-scale=1">`로 `viewport-fit=cover`가 없음(`web/pay.html:6`에는 있음).
   - 영향: `viewport-fit=cover` 없이는 iOS Safari·홈 화면 추가(PWA)에서 `env(safe-area-inset-bottom)`이 `0`으로 계산돼(추측) 하단 고정 메뉴가 홈 인디케이터와 겹침. `viewport-fit=cover` 추가 후 `padding-bottom: calc(8px + env(safe-area-inset-bottom))` 적용 필요.

7. **큰 글자 모드(`가+`, `data-fs="large"`)의 `zoom` + `position: fixed` 충돌**
   - 근거: `web/style.css:1538,1543`에 `html[data-fs="large"] body { zoom: 1.2; }` / `@media screen { html[data-fs="large"] body { zoom: 1.1; } }`.
   - 영향: `body`에 `zoom`이 걸린 상태에서 `position: fixed` 하단/좌측 메뉴를 두면 브라우저별 좌표·폭 계산이 어긋나 메뉴가 화면 밖으로 잘리거나 본문 오프셋(`88px`/`220px`)과 어긋날 수 있음(추측: 특히 Safari/모바일 Chrome).

8. **인쇄(`@media print`)에서 왼쪽 여백 밀림 위험**
   - 근거: `@media print`(`web/style.css:1640-1757`)가 파일 중간에 있고, `.container`는 `padding: 0`만 초기화(`web/style.css:1690-1693`). `.tabs { display: none !important; }`은 `web/style.css:1672`에 있음.
   - 영향: 파일 하단(2654줄 이후)에 `@media (min-width: 1024px)`를 `screen` 없이 추가하면 인쇄 시에도 왼쪽 여백(`88px`/`220px`)이 적용돼 급여명세서·위생점검표·계좌 안내판(`body.print-bank`, `web/style.css:2522-2524`)이 오른쪽으로 밀림. 반드시 `@media screen and (min-width: 1024px)`로 감싸고 `@media print`에서 `margin-left`/`padding-left`/`padding-bottom`을 `0`으로 초기화해야 함.

9. **기존 브레이크포인트 및 다크 모드 충돌**
   - 근거: `web/style.css:2322-2329`가 `min-width: 700px`에서 `.tabs { max-width: 640px }`, `min-width: 900px` 및 가로 `640px+`에서 `.tabs { max-width: 1240px }`을 지정함. 다크 모드 변수는 `web/style.css:26-45`에 있고, `web/style.css:2540-2552`는 라이트만 재정의함.
   - 영향: `.tabs`의 `max-width`·`margin: 0 auto`를 해제하지 않으면 왼쪽 세로 메뉴/하단 바 폭이 틀어짐. 시안의 고정 색(`#fff`, `#f2f4f6`, `#191f28`)을 그대로 쓰면 다크 모드에서 하얀 띠나 저대비 글자가 됨 → CSS 변수(`var(--card)`, `var(--card-2)`, `var(--text)`, `var(--muted)`, `var(--line)`) 사용 필수.

---

## 단계 2~6 위험

### 단계 2 (출퇴근 화면)
- **0-3 (구글 저장 상태 `#punchCloud`) 누락 위험**: 휴대폰 시안 `I_Punch.html`에 `#punchCloud`(`web/index.html:57`, `web/app.js:2200-2216`)가 없고, 넓은 화면 `wide/I_Punch.html:496-499`는 사이드바 하단에만 표시함. `body.locked`에서는 사이드바가 숨겨지므로(`web/style.css:2263`) 잠긴 매장 태블릿에서 구글 연결 끊김·미전송 출퇴근 건수를 볼 곳이 사라짐.
- **1-10 (퇴근 확인 필요) 잠금 상태 충돌**: `I_Punch.html`에 이름 옆 `.punch-chip.warn`(`web/app.js:2861`)이 빠졌고, `wide/I_Punch.html:551` 노란 띠는 급여 화면 이동 링크임. `body.locked`에서는 급여 탭으로 이동할 수 없으므로(`web/app.js:207`) 잠긴 기기 동작을 구분하고 이름 옆 경고를 유지해야 함.
- **5-3 (`#punchRemote` 요청자 기기 읽기 전용) 누락 위험**: `web/index.html:53`, `web/app.js:2837-2843,2862`의 요청자 기기 안내와 클릭 불가(`.punch-row.view`)가 시안에 없음.
- **1-2 / 1-3 (줄 구조·비밀번호 입력)**: 현재 `renderPunch()`(`web/app.js:2863`)는 줄 전체가 `<button data-punch>`임. 오른쪽 별도 버튼으로 바꾸면 `app.js` 수정이 필수(계획표 2단계 파일 목록에 `app.js` 누락). 또 `wide/I_Punch.html:642-671`의 4자리 숫자 키패드로 바꾸면 실제 비밀번호 규격(문자 포함 최대 20자, `web/index.html:928`, `web/app.js:2887`)과 충돌해 기존 매장 로그인 불가 → 기존 `#punchPwInput` 유지 필수.
- **1-5 (`#punchBankBtn` 숨김 레이아웃)**: 계좌 미설정/미확인 시 `#punchBankBtn`이 `hidden`(`web/app.js:3234`)이므로 `[계좌이체 QR][English]` 가로 배치 시 1개만 남을 때 레이아웃 깨짐 확인 필요.
- **0-1 (`#lockBtn` 위치/아이콘)**: `web/app.js:2429`가 `textContent`로 `'🔒 관리자'`/`'🔓 잠그기'`를 덮어쓰므로 SVG 교체 시 `app.js` 동시 수정 필요.

### 단계 3 (근무·급여 화면)
- **2-9 (결근 주 주휴 예외 지급 버튼) 유실 위험**: 현재 `renderMonthCalendar()`(`web/app.js:630-649,700-703,1362-1377`)가 주차 요약 줄 안에 `[이 주는 주휴 지급]`/`[다시 제외하기]`(`data-week-excuse`) 버튼을 넣음. 시안 `I_Pay.html`·`wide/I_Pay.html`과 계획표 3단계 문구(`N주 · N일 · Nh · 식대 N · 주휴 O`)에는 이 버튼이 빠져 있어 그대로 옮기면 기능이 사라짐.
- **2-10 / 2-12 (식대 1회 vs 2회 구분 손실)**: 실제 앱은 하루에 점심(`점`), 저녁(`저`), 점심+저녁(`점저`, 2회)이 구분되지만(`src/payroll.js:97-123`, `web/app.js:692`), 시안의 칸 아래 파란 막대 1개(`I_Pay.html:27`)로는 1회·2회를 구분할 수 없음.
- **0-4 (`#conflictBox` 수정 충돌) & 1-10 (`#pendingBox` 퇴근 확인 입력)**: 계획은 노란 띠만 언급하지만, 실제 `#pendingBox`(`web/app.js:2709-2777`)는 시각 입력+`[퇴근 기록]`/`[근무 없음]` UI이고, `#conflictBox`(`web/app.js:2156-2196`)와 `#workNow`(`web/app.js:1088-1099`) 배치도 빠져 있음.
- **2-18 (줄 돈 고정 바 vs 하단 메뉴 이중 고정 & 하위 버튼 유실)**:
  - 휴대폰에서 하단 고정 메뉴 위에 줄 돈 고정 바까지 겹치면 세로 공간이 ~140px+ 줄어 390×844에서 달력이 지나치게 좁아짐.
  - 현재 카톡 복사(`#copyKakao`, 2-20)·명세서(`#btnSlipOpen`, 2-19)·PDF(`#btnPrintPay`, 2-21)·엑셀(`#btnXlsxPay`, 2-22)은 `body.money-show`일 때만 표시됨(`web/style.css:2205-2207`). 줄 돈 바 개편 시 위 버튼들과 정산 설정(`#openSet`), 전체 휴무 초기화(`#btnClearAllDays`, 2-16), 달 선택기(`#monthPicker`, 2-11), 명단 삭제(`data-del-worker`)·명단 엑셀/전체 지우기(`#btnRosterXlsx`·`#btnRosterClear`, 2-5·2-23)의 접근 경로가 빠지지 않게 배치해야 함.
- **2-17 (`#rightViewSwitch` 제거 시 JS 에러)**: `web/app.js:608,619-620,1349-1350`이 `#rightViewSwitch`, `#btnViewSchedule`, `#btnViewSlip`에 직접 접근·이벤트 바인딩하므로 DOM에서 지우면 즉시 `TypeError` 발생.
- **2-1 (`body.no-workers`) & 기존 PC 2단 CSS 충돌**: `web/app.js:1659` `placeMonthField()`의 `window.matchMedia('screen')`과 `web/style.css:2328-2347`의 기존 PC 2단 그리드(`380px 1fr`)를 새 넓은 화면 3단(`사이드바 + 알바생 명단 + 달력`)과 정리하지 않으면 겹침 발생. 계획표 3단계 파일 목록에 `index.html` 및 `app.js` 추가 함수들이 누락됨.

### 단계 4 (위생 점검)
- **3-3 항목 수 불일치 (사실 오류)**: 실제 앱(`src/checklist.js:2,19-79,100`, `web/index.html:347,366`)은 **9개 분류 41개 항목**(`교육·게시물·서류` 39~41번 포함)이나, `docs/FEATURES.md:87`과 시안 `I_Chk.html:19`·`wide/I_Chk.html:532`는 **8개 분류 38개 항목**으로 잘못 기재됨. 시안대로 고정 마크업하면 39~41번이 누락되므로 반드시 `E.getChecklistGroups()` 동적 렌더링 유지 필요.
- **3-4 / 3-5 (2상태 vs 3상태 충돌)**: 실제 저장 형식은 `checks: [번호]`(체크=적합, 미체크=점검필요 2상태, `src/checklist.js:128,146`)인데, 시안 `I_Chk.html:25`·`wide/I_Chk.html:702-705`는 둘 다 꺼진 3번째 상태(미선택)처럼 그려짐. 원칙 1(저장 형식 유지)에 따라 2상태 매핑 규칙을 먼저 정해야 함.
- **3-2 (20번 온도 항목 자동 판정)**: `src/checklist.js:149-154`는 20번이 체크되어 있어도 온도 이탈 시 `ok=false`로 판정함. `[적합]` 버튼과 실제 판정이 어긋나 보이지 않게 온도 이탈 경고를 20번 항목에 함께 표시 필요.
- **3-6 (4번 보건증 경고) & 계획표 함수명 오류**: 계획표는 `renderChecklist`만 적었으나 실제 입력 폼 생성 함수는 **`buildChecklistForm()`**(`web/app.js:1189-1202`)이며, 현재 4번 보건증 경고(`web/app.js:1238`)는 미리보기(`#chkBody`/`#chkCards`)에만 있고 입력 폼(`#chkFormList`)에는 없음. 또 `alba:lang` 이벤트(`web/app.js:3635`)가 `buildChecklistForm()`을 다시 호출하므로 접힘/선택 분류 상태 유지 필요.
- **3-1 / 3-2 / 3-8 / 3-9 / 3-10 / 3-11 누락 위험**: 시안 온도 카드가 읽기 전용처럼 보여 `#cStoreGo`·`#cDate`·`#cInspector`·`#cFridge`·`#cFreezer` 입력 훅 누락 주의. `#chkDoc` 미리보기를 숨기거나 모달화할 때 `@media print`에 `#chkDoc { display: block !important; }`가 현재 없어(`web/style.css:1686-1688`에는 `#payDoc`만 있음) 위생점검표 PDF 인쇄가 빈 페이지가 될 수 있음. 보관함 목록(`#archiveBody`)·삭제·엑셀·비우기 UI도 유지 필수.

### 단계 5 (설정)
- **0-3 (`#cloudBtn` 제거/이동 시 치명적 버그)**: `web/app.js:2221-2223` (`renderCloudUi`)에 `if (!btn || !body) return;`이 있어 `#cloudBtn`이 DOM에서 사라지면 구글 연동 모달 본문(`#cloudBody`) 렌더링이 통째로 중단됨. 설정 안으로 옮기거나 복제할 때 `#cloudBtn` 훅과 `body.locked #cloudBtn`(`web/style.css:2263`) 처리 필수.
- **0-5 (`#helpBtn` 제거 및 사용 방법 이동)**: `web/app.js:217-218,223-224`는 null 가드가 있어 에러는 안 나지만, 가이드 본문(`web/index.html:633`, `web/lang_web.js:210`)의 `"오른쪽 위 [?]"` 문구가 낡은 안내로 남음. `#tab-guide`가 열렸을 때 하단/좌측 메뉴 활성 표시와 설정으로 돌아가기 동선 필요.
- **넓은 화면 설정 분류 패널 전환 시 외부 점프 깨짐**: `web/app.js:3240,3311`(`acc-bank` 열기·`bankWarn` 스크롤)과 `web/app.js:3459`(`acc-store` 열기·`sStoreName` 포커스)는 현재 아코디언이 항상 DOM에 보이는 전제임. `wide/I_Set.html`처럼 비활성 분류 패널을 `hidden` 처리하면 다른 분류를 보던 중 점프할 때 포커스/스크롤이 실패함 → 해당 분류 패널 자동 활성화 필요.
- **5-10 / 5-1~5-13 훅 유지**: `wide/I_Set.html:530-537` 세율 표는 읽기 전용이 아니라 6개 `<input>`(`sRate_*`, `web/index.html:546-554`) 편집이 가능해야 함. `renderSetSummaries()`(`web/app.js:3402-3415`)의 `#sum*`와 `#pinState`/`#devState`/`#bankState` ID 유지 필수.

### 단계 6 (QR 전체 화면 + 손님 화면 + 가이드)
- **4-4 (`web/pay.js`가 SVG 아이콘을 덮어씀)**: `web/pay.js:11,19,63,69,83`이 `#copyNo`에 `textContent = '📋 계좌번호 복사'` / `'✅ 복사 완료'`를 직접 대입함. `pay.html` 버튼에 SVG를 넣으면 즉시 지워지므로 `pay.html`·`pay.js` 동시 수정 필요(계획표 6단계에 `pay.html`·`pay.js` 누락).
- **4-4 CSP·다크 모드·오류 상태**: `web/pay.html:5` CSP가 `style-src 'self'`이므로 인라인 스타일·외부 Google Fonts 사용 불가. `web/pay.css:2` 다크 모드(`prefers-color-scheme: dark`)와 `#done`/`#bad`(`web/pay.html:25,28`) 스타일 유지 필수.
- **4-2 / 4-3 (`#bankModal` 기능 확장)**: 시안 `I_QR.html`·`wide/I_QR.html`에 있는 모달 내 계좌 복사·안내판 인쇄 버튼은 현재 `#bankModal`(`web/index.html:977-991`)에 없어 `index.html`·`app.js` 수정이 필요하며, `body.locked`(보기 전용)에서 인쇄 버튼 허용 여부를 먼저 정해야 함.

---

## 계획에 더할 것

1. **선행(0단계 또는 1단계 앞부분)에 공통 기반 정리 추가**
   - `web/index.html:6`에 `viewport-fit=cover` 추가.
   - `web/style.css` 라이트·다크 모드 공통 색 변수 정비(`docs/design/README.md:46,68` 기준, 다크 모드 `web/style.css:26-45` 포함) 및 z-index 계층표 확정(하단 메뉴 `< 100` < 토스트 < `#cloudModal` `100` < `#dayModal` `200` < 시트 `900~920` < `.punch-modal` `1000` < `#saver` `3000`).
2. **단계마다 캐시 무효화 `?v=` 갱신 절차 명시**
   - `web/index.html:14-15,1175-1179`와 `web/pay.html:10,30`의 `?v=` 타임스탬프를 단계 배포마다 같이 올려야 함. 특히 `app.js?v=`가 올라가야 `initUpdate()`(`web/app.js:2615-2661`)가 매장 태블릿을 안전하게 자동 새로고침하며, 구 CSS + 신 HTML 혼용 깨짐을 막음.
3. **번역 점검 명령 보완 (`i18n_scan.js` 맹점 해결)**
   - `node tools/i18n_scan.js`는 기본으로 `src/` 5개 파일만 검사함(`tools/i18n_scan.js:9`). 점검 절차에 `node tools/i18n_scan.js web/app.js` 실행과, Playwright에서 `window.AlbaLang.collect()`(`web/i18n.js:157`) 결과가 빈 배열인지 확인하는 단계를 추가해야 `web/index.html` 번역 누락을 잡을 수 있음.
4. **Playwright e2e 점검 매트릭스 보강**
   - **큰 글자 모드(`data-fs="large"`, `가+`)** 확인 추가(`body { zoom }` + `position: fixed` 충돌 검증).
   - **인쇄(`emulateMedia({ media: 'print' })`)** 확인 추가: 급여명세서(`#payDoc`), 위생점검표(`#chkDoc`), 계좌 안내판(`body.print-bank`) 3종.
   - **경계 화면 폭** 추가: `360×740`(소형 폰 영어 라벨), `768×1024`(태블릿 세로·900px/1024px 사이), `1024×768`(88px 레일 진입), `1300×900`(220px 레일 진입).
   - **특수 상태** 추가: `body.no-workers`(알바생 0명), 요청자 기기(`isRequester()`, `#devBar`·`#punchRemote`), `#conflictBox`·`#pendingBox` 노출 상태, 모달(`#cloudModal`·`#dayModal`·`#setSheet`·`#exportSheet`·`#punchPw`) 열림 시 하단 메뉴 겹침 여부.
5. **계획표·기준 문서의 틀린 사실 수정**
   - `docs/FEATURES.md:87`: 위생 점검 `38개, 8개 분류` → `41개, 9개 분류`(`교육·게시물·서류` 39~41번 포함)로 정정.
   - `docs/design/PATCH_PLAN_I.md` 단계표의 누락 파일/잘못된 함수명 수정: 1단계(`app.js`, `lang_web.js`), 2단계(`app.js` `renderPunch`), 3단계(`index.html`, `app.js` 여러 함수), 4단계(`renderChecklist` → `buildChecklistForm` + `renderChecklist`), 6단계(`index.html`, `app.js`, `pay.html`, `pay.js`).
   - 단계 6 점검에 `security-reviewer` 에이전트 추가(`CLAUDE.md:47`, 손님 화면 `pay.html`/`pay.js` 및 QR 변경 대상).
   - 마지막 단계에 가이드 스크린샷뿐 아니라 가이드 본문 텍스트(`web/index.html:627-911`, `web/lang_web.js`) 최신화도 포함.
