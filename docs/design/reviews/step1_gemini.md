결론: 고친 뒤 배포

## 위험 1~9 확인

| 번호 | 상태 | 근거 파일:줄 |
|---|---|---|
| 1. 영어 전환 시 SVG 삭제 | 해결됨 | `web/index.html:35-38`, `web/i18n.js:35,61-66` — `<span class="tab-label" data-en="...">`로 분리해 SVG 보존, `근무·급여`는 `Work & Pay` 지정 |
| 2. 영어 라벨 잘림·줄바꿈 | 해결됨 | `web/style.css:2652,2666-2668,2680,2697-2699,2706-2708` — `nav.tabs .tab`(0,2,1)이 `html[lang="en"] .tab`(0,2,1)을 순서로 이겨 12px 적용, 88px 레일 2줄 허용 |
| 3. DOM 훅·`.tab-guide`·헤더/가게 이름 | 해결됨 | `web/index.html:18-39`, `web/style.css:2571`, `docs/design/PATCH_PLAN_I.md:40` — `.tabs .tab`·`.tab-guide`·`.app-header` 유지(220px 가게 이름은 5단계 연기) |
| 4. `!important` 충돌·`body.locked` 여백 | 해결됨 | `web/style.css:2263,2674-2710` — `display` 미재정의로 잠금 숨김 유지, 하단·좌측 여백은 모두 `body:not(.locked)` 한정 |
| 5. 하단 고정·z-index·스크롤·키보드 | 남음 | `web/style.css:1452,2675,2683-2685,2690` — 1024px 미만은 해결됐으나, **1024px 이상에서 `.toast`가 `z-index: 50`으로 남아 왼쪽 메뉴(`z-index: 80`) 뒤에 가려짐**(모바일 실기기 가상 키보드는 미확인) |
| 6. iOS `safe-area-inset-bottom` | 해결됨 | `web/index.html:6`, `web/style.css:2677,2683-2685,2692` — `viewport-fit=cover` 추가 및 메뉴·본문·푸터·토스트에 안전 영역 반영 |
| 7. 큰 글자 모드 `zoom` + `fixed` | 해결됨 | `web/style.css:1543` — 브라우저에서 정렬 확인됨(단 `body { zoom: 1.1 }` 자체는 유지되어 구형 iOS Safari 실기기 확인은 추후 권장) |
| 8. 인쇄 왼쪽 여백 밀림 | 해결됨 | `web/style.css:1672,2665-2710` — 새 규칙 전체를 `@media screen` 안으로 제한해 인쇄 시 여백 미적용 |
| 9. 기존 브레이크포인트·다크 모드 | 해결됨 | `web/style.css:26-45,2322-2329,2669,2676-2681,2691-2701` — `max-width: none; margin: 0`으로 기존 폭 해제, 고정 색 없이 CSS 변수만 사용 |

## 새로 생긴 문제

1. **1024px 이상에서 토스트가 왼쪽 메뉴 아래에 깔림 (수정 필요)**
   - 근거: `web/style.css:1452`(`.toast { z-index: 50; max-width: 92vw; }`), `web/style.css:2685`(`z-index: 85`가 `max-width: 1023.98px` 안에만 선언됨), `web/style.css:2690`(`nav.tabs { z-index: 80; }`).
   - 영향: 태블릿 가로(88px)·PC(220px)에서 긴 오류·자동 퇴근 안내 토스트(`web/app.js:111,2507,2583`)가 뜰 때 왼쪽 부분이 메뉴 뒤에 가려짐(`docs/design/PATCH_PLAN_I.md:31`의 `메뉴 80 < 토스트 85` 규칙 위반).
   - 조치: `@media screen` 공통 블록(`web/style.css:2665`)으로 `.toast { z-index: 85; }`를 이동(필요 시 `min-width: 1024px`에서 `body:not(.locked) .toast`의 `left`도 메뉴 폭의 절반만큼 보정).

2. **모바일 비출퇴근 탭 푸터 위 이중 여백 (경미)**
   - 근거: `web/style.css:2317,2683-2684` — `.container`(`92px`)와 `.app-footer`(`96px`) 둘 다에 하단 여백을 주어, 푸터가 보이는 급여·위생·설정·가이드 탭에서 마지막 카드와 푸터 사이에 약 92px 빈 공간이 생김(`body:not(.locked).on-punch .container`로 한정하면 자연스러움).

3. **모바일 `⋯` 더보기 메뉴(`.more-pop`) z-index 열세 (경미)**
   - 근거: `web/style.css:2597`(`.more-pop { z-index: 50; }`) < `web/style.css:2675`(`nav.tabs { z-index: 80; }`). `⋯` 버튼이 화면 하단에 걸친 상태로 열면 메뉴가 하단 바에 일부 가려짐(스크롤하면 보임, `z-index: 82` 등으로 보완 가능).
