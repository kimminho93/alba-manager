결론: 고친 뒤 배포

## 단계 4 위험 확인

| 항목 | 상태 | 근거 및 비고 |
|---|---|---|
| 3-3 41개·9분류 동적 | 처리됨 | `web/app.js:1229-1249` `buildChecklistForm()`이 `E.getChecklistGroups()`(`src/checklist.js:19-79,90-98`)를 동적 순회해 9분류 41항목(39~41번 포함) 유지 |
| 3-4 / 3-5 2상태 | 처리됨 | 항목당 숨긴 체크박스(`input.chk-in`) + `[적합]`/`[점검 필요]` 2버튼 매핑(`aria-pressed` 상호 배타). 클릭 시 체크박스 토글 후 `change` 이벤트 발행(`web/app.js:1916-1927`), `readChecklistForm()`(`1212-1224`)·`setAllChecks()`(`1280-1283`)·저장 형식 그대로 유지 |
| 3-2 20번 온도 자동 판정 | 부분 미흡 | 20번 항목 안 경고(`web/app.js:1267`)는 정상 표시되나, 분류 제목의 개수·`필요 N`·자동 펼침/접힘이 `it.ok` 대신 `cb.checked`를 세어 온도 이탈 시에도 `온도 관리`가 초록 `3/3`으로 접혀 경고가 숨음(아래 1번) |
| 3-6 4번 보건증 경고 · `buildChecklistForm` · `alba:lang` | 부분 미흡 | `syncChkForm()`(`web/app.js:1266`)이 4번 항목에 보건증 경고를 직접 표시해 입력 폼 누락 해소. 단, `alba:lang`(`web/app.js:3760-3762`)은 체크 값만 복원하고 분류의 열림/`dataset.touched` 상태는 복원하지 않아 언어 전환 시 사용자가 접은 분류가 초기화됨(아래 2번) |
| 3-1 / 3-8~3-11 입력 훅 · `#chkDoc` 인쇄 · 보관함 | 처리됨 | `web/index.html`은 `?v=`만 변경돼 `#cStoreGo`·`#cDate`·`#cInspector`·`#cFridge`·`#cFreezer`·`#cMemo`와 `#chkDoc`·`#archiveBody`·삭제/엑셀/비우기 훅 그대로 유지. `@media print`에서 `.input-card` 숨김·`#chkDoc` 표 출력(`style.css:1676,1763-1766`) 영향 없음 |

## 새로 생긴 문제

1. **20번 온도 이탈 시 `온도 관리` 분류가 `3/3` 초록으로 표시되고 자동 접힘 (`web/app.js:1259-1276`)** — **수정 필요**
   - `syncChkForm()`이 `var ok = cb.checked; if (ok) on++;`로 분류 통과 수를 세고 `need = boxes.length - on`으로 배지·`.all-ok`·`gEl.open`을 결정함.
   - 재현: 냉장 `9°C` 입력 후 `[✅ 전체 적합으로 체크]` 클릭 → 상단 배너는 `적합 40/41 (점검필요 1건)`인데 `온도 관리` 제목은 초록 `3/3`·`필요` 배지 없음으로 바뀌고, `touched`가 없으면 `gEl.open = false`로 즉시 접혀 20번 경고가 화면에서 가려짐.
   - 수정: 버튼 `aria-pressed`는 `cb.checked`를 유지하되, 분류 집계(`on`/`need`/`.all-ok`/`open`)는 `var pass = it ? !!it.ok : ok; if (pass) on++;`로 판정 결과를 사용.
2. **언어 전환(`alba:lang`) 시 사용자가 접거나 편 분류 상태가 초기화됨 (`web/app.js:3760-3762`)** — **수정 필요**
   - `buildChecklistForm()`이 `#chkFormList.innerHTML`을 새로 쓰면서 `<details>`의 `open`과 `dataset.touched`가 사라지고, 이어지는 `recalcChecklist()`가 `need > 0` 기준으로 모든 분류를 다시 덮어씀.
   - 수정: `buildChecklistForm()` 호출 전에 `[data-g]`별 `{ open, touched }`를 저장했다가 재생성 직후 복원.
3. **항목을 하나씩 눌러 분류의 마지막 `[적합]`을 누르면 그 분류가 바로 접힘 (`web/app.js:1276,1916-1927`)** — **수정 권장**
   - 주석(`1252`: "처음 그릴 때만")과 달리 `dataset.touched`가 `<summary>` 클릭에서만 설정돼, 처음 열린 분류에서 마지막 미체크 항목의 `[적합]`을 누르는 순간 `need === 0`이 되며 분류가 즉시 닫힘(오클릭 되돌리기 불편·스크롤 튐·버튼 키보드 포커스 유실).
   - 수정: 초기 1회만 자동 펼침/접힘을 적용(예: `dataset.init`)하거나 항목 버튼 클릭 시에도 해당 `<details>`에 `touched = '1'` 표시.
4. **소소한 UI/문구 정리 (`web/style.css:2858-2859,2881`, `web/index.html:355`)** — **참고**
   - `.chk-gcount`·`.chk-gneed`에 `flex: none; white-space: nowrap;`이 없어 390px 영어 모드에서 긴 분류명 옆 `3 to fix`가 세로로 줄바꿈될 수 있음.
   - `web/index.html:355` 안내 줄이 여전히 `"눌러서 체크하세요. 체크하지 않은 항목은…"`으로 남아 있어 새 `[적합]`/`[점검 필요]` UI와 어긋남.
