#!/usr/bin/env bash
# Self-check for the profile wrapper: bash pi/bin/pi-wrapper.test.sh
set -uo pipefail
cd "$(dirname "$0")"

fake=$(mktemp)
trap 'rm -f "$fake"' EXIT
printf '#!/bin/sh\nprintf "agent=%%s\\nargs=%%s\\n" "${PI_CODING_AGENT_DIR:-<unset>}" "$*"\n' >"$fake"
chmod +x "$fake"

fail=0
check() { # <name> <expected-first-line> <expected-args> <wrapper args...>
  local name=$1 want_agent=$2 want_args=$3
  shift 3
  local out
  out=$(PI_BIN=$fake ./pi "$@" 2>&1)
  local got_agent got_args
  got_agent=$(sed -n 's/^agent=//p' <<<"$out")
  got_args=$(sed -n 's/^args=//p' <<<"$out")
  if [[ $got_agent != "$want_agent" || $got_args != "$want_args" ]]; then
    echo "FAIL $name: agent=$got_agent args=$got_args"
    fail=1
  else
    echo "ok   $name"
  fi
}

minimalist=$HOME/.pi/agent/profiles/minimalist

check "default passthrough" "<unset>" "--version -p hi" --version -p hi
check "flag form" "$minimalist" "--version -p hi" --profile minimalist --version -p hi
check "equals form" "$minimalist" "--version" --profile=minimalist --version
check "profile=default" "<unset>" "" --profile default

err=$(PI_BIN=$fake ./pi --profile nope 2>&1)
[[ $? -eq 2 && $err == *"unknown profile"* ]] && echo "ok   unknown profile" || { echo "FAIL unknown profile: $err"; fail=1; }

err=$(PI_BIN=$fake ./pi --profile 2>&1)
[[ $? -eq 2 && $err == *"needs a name"* ]] && echo "ok   missing name" || { echo "FAIL missing name: $err"; fail=1; }

exit $fail
