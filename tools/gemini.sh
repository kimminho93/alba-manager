#!/usr/bin/env bash
# 제미나이(Antigravity CLI, agy)에게 작업 지시서를 넘겨 실행시키는 도구.
# Claude Code가 지시서를 쓰고 → 이 스크립트로 제미나이가 파일을 만들고 → Claude가 결과만 검토한다.
#
# 사용법:
#   bash tools/gemini.sh <지시서.md> [허용 폴더] [모델]
#   예) bash tools/gemini.sh docs/design/briefs/wide_I.md docs/design/mockups/wide
#
# - 허용 폴더(기본 docs/design): 지시서에 "이 폴더 안에서만 파일을 만들고 고친다"는 규칙이 자동으로 붙는다.
#   실행 후 그 폴더 밖이 바뀌었으면 경고하고 실패로 끝난다.
# - 모델 기본값: gemini-4-neon-high (환경 변수 GEMINI_MODEL로 바꿀 수 있다). 목록: agy models
# - 제미나이의 응답 전문은 logs/gemini/ 에 저장되고, 화면에는 끝부분만 보여 준다(토큰 절약).
set -euo pipefail

BRIEF="${1:?지시서 파일 경로를 넣어 주세요}"
ALLOW="${2:-docs/design}"
MODEL="${3:-${GEMINI_MODEL:-gemini-4-neon-high}}"
TIMEOUT="${GEMINI_TIMEOUT:-1500s}"

ROOT="$(cd "$(dirname "$0")/.." && (pwd -W 2>/dev/null || pwd))"
cd "$ROOT"

# agy 찾기: PATH → 기본 설치 위치
AGY="$(command -v agy || true)"
if [ -z "$AGY" ]; then
  for c in "$HOME/.gemini/bin/agy.exe" "$HOME/.gemini/bin/agy"; do
    [ -x "$c" ] && AGY="$c" && break
  done
fi
if [ -z "$AGY" ]; then
  echo "agy(Antigravity CLI)를 찾지 못했습니다. Antigravity를 설치하고 한 번 로그인해 주세요." >&2
  exit 2
fi

[ -f "$BRIEF" ] || { echo "지시서가 없습니다: $BRIEF" >&2; exit 2; }
mkdir -p "$ALLOW" logs/gemini
STAMP="$(date +%Y%m%d-%H%M%S)"
NAME="$(basename "$BRIEF" .md)"
LOG="logs/gemini/${STAMP}_${NAME}.log"

# 실행 전 상태 기록(허용 폴더 밖 변경 감지용)
BEFORE="$(git status --porcelain -- . ":(exclude)$ALLOW" ":(exclude)logs" | sort)"

PROMPT="$(cat <<EOF
너는 사장님 도우미 저장소($ROOT)에서 일하는 작업자다. 아래 작업 지시서를 끝까지 수행한다.

[반드시 지킬 규칙]
- 파일은 '$ALLOW' 폴더 안에서만 만들고 고친다. 그 밖의 파일은 읽기만 한다.
- 터미널(셸) 명령은 절대 실행하지 않는다(무인 실행이라 자동으로 거부되고 작업이 통째로 멈춘다).
  파일 목록 보기·읽기·쓰기는 모두 파일 도구로만 한다. git·패키지 설치도 하지 않는다.
- 계획만 세우고 끝내지 말고 실제 파일을 끝까지 만든다.
- 끝나면 만든·고친 파일 목록과 한두 줄 요약만 한국어로 답한다. 파일 내용을 답에 다시 붙여 넣지 않는다.

[작업 지시서: $BRIEF]
$(cat "$BRIEF")
EOF
)"

echo "제미나이 실행: 모델 $MODEL, 허용 폴더 $ALLOW, 로그 $LOG"
set +e
"$AGY" -p "$PROMPT" --model "$MODEL" --mode accept-edits --add-dir "$ROOT" --print-timeout "$TIMEOUT" >"$LOG" 2>&1
RC=$?
set -e

echo "----- 제미나이 응답(끝부분) -----"
tail -n 25 "$LOG"
echo "---------------------------------"

AFTER="$(git status --porcelain -- . ":(exclude)$ALLOW" ":(exclude)logs" | sort)"
if [ "$BEFORE" != "$AFTER" ]; then
  echo "경고: 허용 폴더($ALLOW) 밖의 파일이 바뀌었습니다. 확인하세요:" >&2
  diff <(echo "$BEFORE") <(echo "$AFTER") >&2 || true
  exit 3
fi

echo "허용 폴더 안 변경:"
git status --porcelain -- "$ALLOW" | head -50

# 권한 거부·빈 응답은 성공 코드여도 실패로 본다
if grep -q "no output produced" "$LOG" || [ ! -s "$LOG" ]; then
  echo "실패: 제미나이가 결과를 내지 못했습니다(권한 거부 또는 빈 응답). 로그: $LOG" >&2
  exit 4
fi
exit $RC
