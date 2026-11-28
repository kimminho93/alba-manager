# 6단계(QR·손님 화면·이모지) 변경 검토 요청 — 코드는 고치지 말 것

`docs/design/PATCH_PLAN_I.md` 6단계 변경. diff는 `logs/gemini/step6.diff`.
바뀐 것: #bankModal을 전체 화면(휴대폰 세로 배치, 1024px 이상 왼쪽 QR·오른쪽 계좌), web/pay.css 토스식 색, pay.js·pay.html 이모지 제거와 복사 실패 빨간 글씨,
장식 이모지(☁️ 🗂️ 💬 🖨️ 📊 ➕ 💳 🌐, "✅ 전체 적합으로 체크")를 index.html·app.js·lang_web.js에서 똑같이 지움(번역 키 맞춤, 같은 값 중복 키 4개 정리),
머리띠 로고·알림·테마 버튼을 선 아이콘 SVG로(app.js THEME_ICON, i18n.js 언어 버튼 글자).
⚠️·💡·◀▶와 src/ 안의 ✅(상태 표시)는 일부러 남겼다.

앞선 검토(`docs/design/reviews/patch_plan_I_gemini.md`)의 "단계 6" 위험(4-4 pay.js 덮어쓰기·CSP·다크·오류 상태, 4-2/4-3 #bankModal)을 확인하고,
번역 누락(이모지를 지운 한국어 문장이 lang_web.js 키와 정확히 같은지), 다크 모드에서 QR 흰 바탕, 인쇄(계좌 안내판 body.print-bank)를 본다.

이미 확인: 390/1180 QR 전체 화면, 손님 화면 표시·복사 성공(실제 클릭), 머리띠·설정 빠른 버튼에 이모지 없음, 테마 아이콘 전환, i18n 누락 0, 테스트 통과.

## 결과 파일
`docs/design/reviews/step6_gemini.md` 하나만. 맨 위 `결론: 배포 가능` 또는 `결론: 고친 뒤 배포`, `## 단계 6 위험 확인` 표, `## 새로 생긴 문제`. 짧게.
