---
name: ship-check
description: 사장님 도우미를 main에 푸시(배포)하기 전에 거치는 점검 순서. "배포 전 점검", "/ship-check", 앱 코드를 고친 뒤 푸시하기 직전에 쓴다. 문서만 바꾼 커밋에는 필요 없다.
disable-model-invocation: true
---

<!-- everything-claude-code(MIT, 커밋 4adeee6)의 quality-gate/verify 흐름을 참고해 이 프로젝트 순서로 새로 씀 -->

# 배포 전 점검

아래를 순서대로 하고, 하나라도 실패하면 고친 뒤 처음부터 다시 한다. 결과는 한국어 표로 보고한다.

1. **바뀐 범위 확인** — `git status`, `git diff --stat`. 앱 코드(web/, src/, server/)가 바뀌었는지 본다. 의도하지 않은 파일이 섞였으면 멈추고 물어본다.
2. **빌드와 단위 테스트** — `make test` (= `tools/build.js` → `tests/test_main.js`, `tests/test_server.js`).
   출퇴근·동기화를 건드렸으면 `tests/test_punch_fuzz.js`, `tests/test_cloud.js`, `tests/test_single.js`, `tests/test_stress.js`도 돌린다.
3. **번역 누락** — `node tools/i18n_scan.js`. 새로 생긴 누락만 본다(기존 동적 버전 문자열은 무시).
4. **브라우저 e2e** — 바뀐 화면을 실제 브라우저(Playwright 등)로 390px 폭과 데스크톱 폭에서 눌러 본다. 한국어·영어 둘 다. 콘솔 오류가 없어야 한다.
   - 반복 테스트: 같은 흐름을 최소 2번 돌려 매번 같은 결과인지 확인한다.
5. **리뷰** — `code-reviewer` 에이전트로 diff를 검토한다. 입력·손님 화면·구글 연동·내보내기를 건드렸으면 `security-reviewer`도 쓴다. [심각]이 있으면 배포하지 않는다.
6. **기능 누락 확인** — 기능을 추가·삭제·이동했으면 `docs/FEATURES.md`가 맞게 고쳐졌는지 본다.
7. **가이드** — 화면이나 동작이 바뀌었으면 사용 방법(가이드) 글과 스크린샷을 최신화했는지 본다. 캐시 버스트(`?v=`)도 올린다.
8. **버전·기록** — 버전 번호와 `CHANGELOG.md`를 올렸는지 본다.
9. **큰 변경이면 아르곤 회의** — 새 기능, 데이터 구조 변경, 보안 관련이면 아르곤(agy)과 릴레이 회의를 하고 "결론: 배포 가능"을 받는다.
10. **커밋·푸시** — 한국어로 자세히 쓴 커밋 메시지(마지막에 Co-Authored-By, Claude-Session 줄)로 커밋하고 `git push origin HEAD:main`. 태그 푸시는 하지 않는다.
11. **배포 확인** — GitHub Actions의 Pages 배포가 성공했는지, 실제 주소에서 새 버전이 뜨는지 확인한다.

## 보고 예시
| 단계 | 결과 | 메모 |
|---|---|---|
| 단위 테스트 | 통과 | test_main, test_server |
| e2e | 통과 | 390px·데스크톱, 한/영, 2회 |
| 리뷰 | [중요] 1건 고침 | gsync 빈 catch |
| ... | | |

결론: 배포함 / 보류(이유)
