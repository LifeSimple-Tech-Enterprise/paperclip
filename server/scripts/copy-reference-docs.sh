#!/usr/bin/env bash
# Copies docs/reference/ into dist/docs/reference/ at the same relative depth
# so the compiled output is self-contained for the boot-smoke verification.
# The runtime resolver in server/src/paths.ts uses APP_ROOT = parent-of-dirname,
# i.e. server/. Shipping at the package root via `files` covers npm consumers,
# and this in-dist copy covers any consumer that bundles only `dist/`.
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ ! -d docs/reference ]]; then
  echo "copy-reference-docs: docs/reference is missing in source tree" >&2
  exit 1
fi

mkdir -p dist/docs
rm -rf dist/docs/reference
cp -R docs/reference dist/docs/reference
