# 2단계(출퇴근 화면) 변경 검토 요청 — 코드는 고치지 말 것

`docs/design/PATCH_PLAN_I.md` 2단계를 적용한 변경이다. diff는 `logs/gemini/step2.diff`.
앞선 검토(`docs/design/reviews/patch_plan_I_gemini.md`)의 "단계 2" 위험(0-3 #punchCloud, 1-10 퇴근 확인 경고, 5-3 #punchRemote,
1-2/1-3 줄 구조·비밀번호 20자, 1-5 #punchBankBtn 숨김, 0-1 #lockBtn)이 처리됐는지 하나씩 확인한다.
필요하면 `web/index.html`, `web/style.css`, `web/app.js`(renderPunch, punchSubText, openPunchPw, punchSubmit, askBulkOut), `src/workers.js`(punchNext, workerShifts)를 읽는다.

이미 브라우저로 확인한 것: 360/390/1180/1440 폭, 한/영, 다크, 잠금(body.locked), 숫자·문자 비밀번호 출근, 틀린 비밀번호 오류,
연속 찍기 막힘 토스트, 오늘 근무가 있으면 "14:00 퇴근", 근무 중 "16:00 출근 · 1분째", 모두 퇴근 버튼 글자, QR 버튼 보이기/숨기기 배치.
#lockBtn 글자(🔒 관리자)는 5단계(머리띠 정리)에서 바꾸기로 미뤘다.

## 결과 파일
`docs/design/reviews/step2_gemini.md` 하나만.
- 맨 위 한 줄: `결론: 배포 가능` 또는 `결론: 고친 뒤 배포`
- `## 단계 2 위험 확인` 표(항목 | 해결됨/남음/미룸 | 근거 파일:줄)
- `## 새로 생긴 문제` (없으면 "없음")
짧게.
