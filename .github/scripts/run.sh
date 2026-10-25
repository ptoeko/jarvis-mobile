#!/usr/bin/env bash
# Запускает команду и при ошибке выносит строки с причиной в аннотации GitHub
# (их видно на странице сборки без открытия журнала).
# Использование: .github/scripts/run.sh "название" команда аргументы…
set -uo pipefail
NAME="$1"; shift
LOG=$(mktemp)
"$@" 2>&1 | tee "$LOG"
CODE=${PIPESTATUS[0]}
if [ "$CODE" -ne 0 ]; then
  grep -E 'FAIL|not ok|Error|assert|Assertion|не дождались|не найден|FAILURE|What went wrong|error:' "$LOG" \
    | grep -v '^\s*$' | tail -15 | while IFS= read -r line; do
      echo "::error title=${NAME}::${line:0:900}"
    done
  echo "::error title=${NAME}::код завершения ${CODE}; последние строки: $(tail -3 "$LOG" | tr '\n' ' ' | cut -c1-600)"
fi
exit "$CODE"
