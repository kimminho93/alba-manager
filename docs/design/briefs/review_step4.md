# 4단계(위생 점검) 변경 검토 요청 — 코드는 고치지 말 것

`docs/design/PATCH_PLAN_I.md` 4단계를 적용한 변경이다. diff는 `logs/gemini/step4.diff`.
앞선 검토(`docs/design/reviews/patch_plan_I_gemini.md`)의 "단계 4" 위험(3-3 41개·9분류 동적, 3-4/3-5 2상태, 3-2 20번 온도 자동 판정,
3-6 4번 보건증 경고·buildChecklistForm·alba:lang 재생성, 3-1/3-8~3-11 입력 훅·#chkDoc 인쇄·보관함)이 처리됐는지 확인한다.
필요하면 `web/app.js`(buildChecklistForm, syncChkForm, renderChecklist, readChecklistForm, setAllChecks, #chkFormList click/change, alba:lang), `src/checklist.js`, `web/style.css` 끝부분을 읽는다.

이미 확인: 9분류 41항목, [적합]/[점검 필요]가 체크박스를 켜고 끄며 진행·판정 갱신, 전체 적합/전체 해제, 냉장 9도에서 20번 경고와 40/41, 4번 보건증 경고,
보관함 저장(0→1일), 사용자가 닫은 분류 유지, 한/영 전환 후 체크 유지, 390/1180/1440, 다크. 테스트(단위·서버·단일·클라우드) 통과.

## 결과 파일
`docs/design/reviews/step4_gemini.md` 하나만.
- 맨 위 한 줄: `결론: 배포 가능` 또는 `결론: 고친 뒤 배포`
- `## 단계 4 위험 확인` 표, `## 새로 생긴 문제`
짧게.
