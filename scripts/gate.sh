#!/usr/bin/env bash
# Stop hook: blocks the turn from ending (exit 2) until every check passes.
# Claude Code feeds stderr back to the agent as the reason to keep working.
cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/..}" || exit 1

out=$(
  {
    pnpm turbo run typecheck lint test --output-logs=errors-only &&
    pnpm exec knip
  } 2>&1
)

if [ $? -ne 0 ]; then
  printf 'Gate failed. Fix the root cause; do not edit tests/gold or silence checks.\n\n%s\n' "$out" | tail -n 80 >&2
  exit 2
fi
echo "gate: ok"
