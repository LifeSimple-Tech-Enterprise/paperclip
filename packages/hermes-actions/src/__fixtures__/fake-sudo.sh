#!/usr/bin/env bash
# Test stub for sudo. First arg is the wrapper path (ignored).
# Remaining args: the executor invokes us as
#   fake-sudo.sh <wrapper-path> <wrapper-argv...>
# We exit with the FIRST positional arg as the desired exit code,
# write a stderr line so executor truncation can be exercised, and
# echo a stdout line so journal duration is non-zero.
#
# Usage from a test:
#   ctx.sudoPath = path/to/fake-sudo.sh
#   intent args.name = "<exit-code>"
#
# i.e. wrapper-argv[0] is parsed as the exit code by this stub.
set -u
shift  # drop the wrapper path arg
code="${1:-0}"
echo "fake-sudo: stdout for arg '${1:-}'"
echo "fake-sudo: stderr exit ${code}" 1>&2
exit "${code}"
