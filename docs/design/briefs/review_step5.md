# 5단계(머리띠·설정) 변경 검토 요청 — 코드는 고치지 말 것

`docs/design/PATCH_PLAN_I.md` 5단계를 적용한 변경이다. diff는 `logs/gemini/step5.diff`.
바뀐 것: 위쪽 ? 버튼 숨김(요소는 남김, 사용 방법은 설정 맨 아래 [사용 방법 보기]), 관리자 버튼 이모지 → CSS 선 아이콘(잠김/열림, mask data URI),
"관리자"/"잠그기"는 사전에 넣지 않고 언어별로 바로 씀(가이드의 시트 탭 이름 "관리자"가 Admin으로 바뀌지 않게), 가이드·확인창의 [🔒 관리자] → [관리자],
1300px 이상 왼쪽 메뉴 맨 위 가게 이름(#railStore, applyStoreInfo에서 채움). 설정 화면 배치는 기존 분류·아코디언을 그대로 둠.

앞선 검토(`docs/design/reviews/patch_plan_I_gemini.md`)의 "단계 5" 위험(0-3 #cloudBtn, 0-5 #helpBtn·가이드 문구, 외부 점프, 5-10 세율 입력, renderSetSummaries ID)이 괜찮은지 확인한다.
필요하면 `web/app.js`(initTabs, applyLockUi, applyStoreInfo, btnPinSave, openTab), `web/index.html`, `web/style.css` 끝부분, `web/i18n.js`, `web/lang_web.js`를 읽는다.
CSP(`web/index.html` 5줄)가 CSS mask의 data: URI를 막지 않는지도 본다.

이미 확인: ? 버튼 안 보임, 설정 → 사용 방법 열림, 관리자 비밀번호 정하면 바로 잠김·버튼 "관리자"(잠김 아이콘)·메뉴 숨김, 비밀번호로 풀면 "잠그기"(열림 아이콘),
한/영 전환, 1440에서 가게 이름 보임, 1180·390에서는 숨김·메뉴 4개 그대로, 테스트 통과.

## 결과 파일
`docs/design/reviews/step5_gemini.md` 하나만. 맨 위 `결론: 배포 가능` 또는 `결론: 고친 뒤 배포`, `## 단계 5 위험 확인` 표, `## 새로 생긴 문제`. 짧게.
