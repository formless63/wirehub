#!/usr/bin/env bash
# Tests for scripts/privacy-check.sh: each case builds a throwaway repository
# in a temporary directory, stages or commits something, and checks the exit
# status. Run: bash scripts/privacy-check.test.sh
set -u
here="$(cd "$(dirname "$0")" && pwd)"
script="$here/privacy-check.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
export CI=1   # no hostname/login rule: the test must not depend on the machine
unset PRIVACY_TERMS_FILE PRIVACY_ALLOWED_EMAILS
fail=0
pass=0

new_repo() {
  rm -rf "$work/r" && mkdir -p "$work/r" && cd "$work/r" || exit 1
  git init -q -b main .
  git config user.name tester
  git config user.email '1+tester@users.noreply.github.com'
  git config commit.gpgsign false
  echo base > README && git add README && git commit -q -m 'chore: base'
}

expect() { # status, description, command...
  local want="$1" what="$2"; shift 2
  "$@" > "$work/out" 2>&1
  local got=$?
  if [ "$got" -eq "$want" ]; then pass=$((pass + 1)); else
    fail=$((fail + 1)); echo "FAIL: $what (exit $got, wanted $want)"; sed 's/^/  | /' "$work/out"
  fi
}

stage() { # file, content
  mkdir -p "$(dirname "$1")" && printf '%s\n' "$2" > "$1" && git add -f "$1"
}

new_repo
stage ok.ts 'export const x = 1; // see /home/user/project and /home/node/app'
expect 0 'placeholder home paths are fine' bash "$script" --staged

new_repo; stage a.ts 'const p = "/home/alice/src/thing";'  # privacy-check: allow
expect 1 'a real home path is blocked' bash "$script" --staged

new_repo; stage a.md 'Open /Users/bob/Documents first'  # privacy-check: allow
expect 1 'a macOS home path is blocked' bash "$script" --staged

new_repo; stage k.txt '-----BEGIN OPENSSH PRIVATE KEY-----'  # privacy-check: allow
expect 1 'a private key block is blocked' bash "$script" --staged

new_repo; stage t.ts "const token = 'ghp_$(printf 'a%.0s' {1..36})';"
expect 1 'a GitHub token is blocked' bash "$script" --staged

new_repo; stage t.ts "const k = 'AKIA$(printf 'B%.0s' {1..16})';"
expect 1 'an AWS key id is blocked' bash "$script" --staged

new_repo; stage c.ts 'const config = { clientSecret: "s3cr3tValueThatIsLong" };'
expect 1 'a secret-like literal is blocked' bash "$script" --staged

new_repo; stage c.ts 'const config = { clientSecret: process.env.CLIENT_SECRET };'
expect 0 'a secret read from the environment is fine' bash "$script" --staged

new_repo; stage c.ts 'const config = { clientSecret: "s3cr3tValueThatIsLong" }; // privacy-check: allow'
expect 0 'the allow marker lets a line through' bash "$script" --staged

new_repo; stage .env 'X=1'
expect 1 'a .env file is blocked' bash "$script" --staged

new_repo; stage .env.example 'X='
expect 0 '.env.example is fine' bash "$script" --staged

new_repo; stage a.ts 'x'; git config user.email 'tester@example.com'
expect 1 'a non-noreply author email is blocked' bash "$script" --staged

new_repo
printf 'feat: x\n\nClaude-Session: https://example.invalid/s\n' > "$work/msg"
expect 1 'a session trailer in a message is blocked' bash "$script" --commit-msg "$work/msg"
printf 'feat: x\n\nCo-Authored-By: Claude <noreply@example.invalid>\n' > "$work/msg"
expect 1 'a Claude co-author trailer is blocked' bash "$script" --commit-msg "$work/msg"
printf 'feat: x\n\nPlain body.\n' > "$work/msg"
expect 0 'a plain message is fine' bash "$script" --commit-msg "$work/msg"

new_repo
printf 'acme-internal\nc:SECRETPROJ\n' > .privacy-terms
stage a.ts 'shipping to Acme-Internal next week'
expect 1 'a private term (case-insensitive) is blocked' bash "$script" --staged
git reset -q; stage a.ts 'the secretproj word in lower case'
expect 0 'a case-sensitive private term ignores other cases' bash "$script" --staged
rm -f .privacy-terms
expect 2 '--private-terms without the file is an error' bash "$script" --staged --private-terms

new_repo
base="$(git rev-parse HEAD)"
stage a.ts 'fine'; git commit -q -m 'feat: fine'
expect 0 'a clean range passes' bash "$script" --range "$base..HEAD"
git -c user.email=me@example.com commit -q --allow-empty -m 'chore: leak'
expect 1 'a range with a non-noreply author fails' bash "$script" --range "$base..HEAD"

echo "privacy-check tests: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
