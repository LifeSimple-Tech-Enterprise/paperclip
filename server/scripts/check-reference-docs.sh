#!/usr/bin/env bash
# Boot-smoke check: assert reference docs are physically present in the compiled
# output. Runs at the end of `pnpm build`; failure aborts the build.
set -euo pipefail

cd "$(dirname "$0")/.."

required=(
  "dist/docs/reference/ceo/AGENTS.md"
  "dist/docs/reference/ceo/HEARTBEAT.md"
  "dist/docs/reference/ceo/SOUL.md"
  "dist/docs/reference/ceo/TOOLS.md"
  "dist/docs/reference/default/AGENTS.md"
)

missing=0
for relpath in "${required[@]}"; do
  if [[ ! -s "$relpath" ]]; then
    echo "check-reference-docs: missing or empty $relpath" >&2
    missing=1
  fi
done

if [[ $missing -ne 0 ]]; then
  echo "check-reference-docs: dist/ is incomplete; rerun copy-reference-docs.sh" >&2
  exit 1
fi
