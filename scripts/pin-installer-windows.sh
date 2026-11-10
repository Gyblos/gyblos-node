#!/bin/sh
# Pins install.ps1 (or the given file) to one release's packaged Windows seller, as the release workflow
# does after publishing it (scripts/publish-installer.sh): its version and the SHA-256 of
# gyblos-<version>-win32-x64.tar.gz.
#
#   sh scripts/pin-installer-windows.sh <version> <sha256> [file]
set -eu

die() {
  printf 'pin-installer-windows: %s\n' "$*" >&2
  exit 1
}

version=${1:-}
sha=${2:-}
valid=0
node "$(dirname "$0")/semver-newer.mjs" "$version" "$version" 2>/dev/null || valid=$?
[ "$valid" -ne 2 ] || die "not a semantic version: '$version'"
printf '%s\n' "$sha" | grep -Eq '^[0-9a-f]{64}$' || die "not a SHA-256: '$sha'"
file=${3:-$(git rev-parse --show-toplevel)/install.ps1}
for name in NativeVersion NativeSha256; do
  [ "$(grep -c "^[\$]$name = '" "$file")" -eq 1 ] || die "$file has no single \$$name line."
done
tmp=$(mktemp "$file.XXXXXX")
trap 'rm -f "$tmp"' EXIT
sed -e "s|^[\$]NativeVersion = .*|\$NativeVersion = '$version'|" \
  -e "s|^[\$]NativeSha256 = .*|\$NativeSha256 = '$sha'|" "$file" >"$tmp"
mv -f "$tmp" "$file"
printf 'Pinned %s to %s\n' "$file" "$version"
