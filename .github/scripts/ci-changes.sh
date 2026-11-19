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

code=true
windows_full=true
if [[ $EVENT == pull_request && $TARGET == develop ]] && git cat-file -e "$BASE^{commit}" 2>/dev/null; then
  if ! changed -- . ':(exclude)apps/docs/**'; then
    code=false
    windows_full=false
  elif ! changed -- \
    '.github/**' 'scripts/**' 'install.*' 'Dockerfile' 'docker/**' 'patches/**' \
    'package.json' '**/package.json' 'pnpm-*' '.npmrc' '.node-version' '.nvmrc' 'tsconfig*.json' \
    ':(icase,glob)**/*windows*' ':(icase,glob)**/*win32*' '*.ps1' '*.cmd' '*.bat' \
    'apps/node/**' 'apps/desktop/scripts/**' 'apps/desktop/src/wallet/**' \
    'packages/config/**' 'packages/runtime/**' 'packages/node/**' 'packages/transport-iroh/**' \
    'tooling/native-*' 'tooling/npm-*' 'tests/native-*' 'tests/npm-*' 'tests/release-*' \
    'tests/support/node-config-fixtures.ts' 'tests/lab/seller-daemon-files.test.ts' \
    'tests/free-execution-iroh.test.ts' 'tests/iroh-transport.test.ts' 'tests/node-startup-failure.test.ts' \
    && ! changed -G 'win32|windows-acl|SystemRoot|LOCALAPPDATA|schtasks|icacls' -- '*.ts' '*.js' '*.mjs' '*.cjs'; then
    windows_full=false
  fi
fi
printf 'code=%s\nwindows_full=%s\n' "$code" "$windows_full"
