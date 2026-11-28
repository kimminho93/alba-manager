# 시안 I 맞추기 — 커밋·푸시·배포 확인 (제미나이 작업용)

Claude가 화면 검토를 마쳤고 배포해도 된다고 했다. 지금 작업 폴더의 변경을 main에 올리고 배포까지 확인한다.

## 순서 (허용된 명령만, 글자 그대로)
1. 테스트를 다시 돌린다: `node tools/build.js`, `node tests/test_main.js`, `node tests/test_server.js`, `node tests/test_cloud.js`,
   `node tests/test_single.js 20`, `node tests/test_punch_fuzz.js 50`, `node tools/i18n_scan.js`, `node tools/i18n_scan.js web/app.js`.
   하나라도 실패하면 **커밋하지 말고** 멈춘 뒤 실패 내용을 답한다.
2. `git status --short`로 바뀐 파일을 본다. `web/engine.js`가 바뀌었다고 나오면(줄 끝만 다름) `git checkout -- web/engine.js`.
   `web/`, `docs/design/`, `docs/FEATURES.md` 밖의 파일(예: 저장소 맨 위 .exe)은 올리지 않는다(아래 add 명령이 알아서 뺀다).
3. 커밋 메시지를 파일 도구로 `logs/gemini/commit-msg.txt`에 쓴다(덮어쓰기). 규칙(CLAUDE.md):
   - 한국어, 자세히. 첫 줄 `feat: 시안 I 그대로 — <바꾼 화면>`.
   - 본문: 화면별로 시안과 같아진 점, 옮긴 기능과 새 위치, 테스트 결과, "작업: 제미나이(안티그래비티), 화면 검토: Claude".
   - 마지막 줄: `Co-Authored-By: Gemini (Antigravity) <noreply@google.com>`
4. `git add web docs/design docs/FEATURES.md` → `git commit -F logs/gemini/commit-msg.txt` → `git push origin HEAD:main`.
   push가 거절되면(다른 커밋이 먼저 올라감) 더 하지 말고 멈춰서 그대로 답한다(강제 푸시 금지).
5. `git log --oneline -1`, `gh run list --limit 1`로 배포 작업이 시작됐는지 본다.

## 답에 적을 것
커밋 해시, 푸시 결과, 배포 작업 상태(진행 중/성공/실패), 테스트 결과.
