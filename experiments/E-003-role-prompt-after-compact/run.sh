#!/usr/bin/env bash
# E-003: --append-system-prompt-file 로 넣은 역할이 /compact 이후에도 유지되는가
# 실행: bash run.sh   (Git Bash 또는 Linux, claude CLI 필요)
set -e
cd "$(dirname "$0")"
ID=$(node -e "console.log(require('crypto').randomUUID())")
echo "[1] 세션 시작 (역할 주입)"
claude -p --session-id "$ID" --append-system-prompt-file role.md "1부터 5까지 세고, 오늘 할 일 없음이라고 답해." < /dev/null
echo "[2] /compact"
claude -p --resume "$ID" --append-system-prompt-file role.md "/compact" < /dev/null
echo "[3] 압축 후 역할 질문 (플래그 재전달)"
claude -p --resume "$ID" --append-system-prompt-file role.md "너의 역할과 코드네임은?" < /dev/null
echo
echo "확인: ~/.claude/projects/*/$ID.jsonl 에 \"subtype\":\"compact_boundary\" 가 있어야 압축이 실제로 일어난 것"
