#!/usr/bin/env bash
# Emit CI job selections for the merge tree checked out by actions/checkout.
set -euo pipefail

# A failed diff must fail the changes job rather than select a smaller suite.
changed() {
  local status
  git diff --no-renames --quiet "$BASE" HEAD "$@" && return 1
  status=$?
  if [[ $status == 1 ]]; then return 0; fi
  exit "$status"
}

# A change inside a Windows branch can leave its platform guard untouched.
# Search the complete before/after images of changed source files only.
windows_source_changed() {
  local file list result
  local sources=()
  list=$(mktemp) || exit 1
  if ! git diff --no-renames --name-only -z "$BASE" HEAD -- \
    '*.ts' '*.tsx' '*.mts' '*.cts' '*.js' '*.jsx' '*.mjs' '*.cjs' > "$list"; then
    rm -f "$list"
    exit 1
  fi
  while IFS= read -r -d '' file; do sources+=("$file"); done < "$list"
  rm -f "$list" || exit 1
  [[ ${#sources[@]} -gt 0 ]] || return 1
  git --literal-pathspecs grep -qiE 'win32|windows|SystemRoot|LOCALAPPDATA|schtasks|icacls' \
    "$BASE" HEAD -- "${sources[@]}" && return 0
  result=$?
  if [[ $result == 1 ]]; then return 1; fi
  exit "$result"
}

code=true
windows_full=true
if [[ $EVENT == pull_request && $TARGET == develop ]] && git cat-file -e "$BASE^{commit}" 2>/dev/null; then
  if ! changed -- . ':(exclude)apps/docs/**'; then
    code=false
    windows_full=false
  elif ! changed -- \
    '.github/**' 'scripts/**' 'install.*' 'LICENSE' 'NOTICE' '.gitattributes' '.dockerignore' 'compose.yaml' 'Dockerfile' 'docker/**' 'patches/**' \
    'package.json' '**/package.json' 'pnpm-*' '.npmrc' '.node-version' '.nvmrc' 'tsconfig*.json' \
    ':(icase,glob)**/*windows*' ':(icase,glob)**/*win32*' '*.ps1' '*.cmd' '*.bat' \
    ':(icase,glob)**/*windows*/**' ':(icase,glob)**/*win32*/**' \
    'apps/node/**' 'apps/desktop/**' \
    'packages/config/**' 'packages/runtime/**' 'packages/node/**' 'packages/transport-iroh/**' \
    'tooling/native-*' 'tooling/npm-*' 'tests/native-*' 'tests/npm-*' 'tests/release-*' 'tests/*packag*' 'tests/*install*' \
    'tests/support/node-config-fixtures.ts' 'tests/lab/seller-daemon-files.test.ts' \
    'tests/free-execution-iroh.test.ts' 'tests/iroh-transport.test.ts' 'tests/node-startup-failure.test.ts' \
    && ! windows_source_changed; then
    windows_full=false
  fi
fi
printf 'code=%s\nwindows_full=%s\n' "$code" "$windows_full"
