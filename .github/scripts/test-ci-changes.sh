#!/usr/bin/env bash
# Exercise the hosted change selector against real committed trees, including deletions.
set -euo pipefail
selector="$(cd "$(dirname "$0")" && pwd)/ci-changes.sh"
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
cd "$scratch"
git init -q
git config user.name "CI fixture"
git config user.email "ci@example.invalid"
git config commit.gpgsign false
git config core.hooksPath /dev/null
mkdir -p tests apps/docs
touch tests/windows-install.test.ts
git add .
git commit -qm base
base=$(git rev-parse HEAD)

expect() {
  local actual
  actual=$(EVENT="$1" TARGET="$2" BASE="$3" bash "$selector")
  [[ "$actual" == "$(printf 'code=%s\nwindows_full=%s' "$4" "$5")" ]] || {
    printf 'Unexpected selection for %s/%s (%s): %s\n' "$1" "$2" "$(git log -1 --format=%s)" "$actual" >&2
    exit 1
  }
}

touch apps/docs/page.md
git add .
git commit -qm docs
expect pull_request develop "$base" false false
expect pull_request main "$base" true true
touch tests/buyer-key-preflight.test.ts
git add .
git commit -qm ordinary
expect pull_request develop "$base" true false
expect push develop "$base" true true
expect pull_request develop unavailable true true

prior=$(git rev-parse HEAD)
git mv tests/windows-install.test.ts tests/renamed.test.ts
git commit -qm rename
expect pull_request develop "$prior" true true

prior=$(git rev-parse HEAD)
printf '%s\n' "process.platform === 'win32'" > tests/new-platform.test.ts
git add .
git commit -qm platform
expect pull_request develop "$prior" true true

prior=$(git rev-parse HEAD)
touch pnpm-lock.yaml
git add .
git commit -qm distribution
expect pull_request develop "$prior" true true
