#!/bin/sh
# Pins install.sh (or the given file) to one signed seller release, as the release workflow does after
# publishing it. Accepts only ghcr.io/gyblos/seller:<version>@sha256:<64 hex>. With NATIVE_PINS
# (`<target>=<sha256>` for darwin-arm64, linux-x64 and linux-arm64, space-separated) it also pins the
# release's packaged sellers: NATIVE_VERSION and one NATIVE_SHA256_<TARGET> line each. install.sh does not
# install on Windows, so a win32-x64 pin is skipped.
#
#   [NATIVE_PINS='darwin-arm64=<sha256> …'] sh scripts/pin-installer.sh <reference> [file]
set -eu

die() {
  printf 'pin-installer: %s\n' "$*" >&2
  exit 1
}

reference=${1:-}
printf '%s\n' "$reference" |
  grep -Eq '^ghcr\.io/gyblos/seller:[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z]+(\.[0-9A-Za-z]+)*)?@sha256:[0-9a-f]{64}$' ||
  die "not a seller release reference: '$reference'"
file=${2:-$(git rev-parse --show-toplevel)/install.sh}
[ "$(grep -c '^DEFAULT_IMAGE=' "$file")" -eq 1 ] || die "$file has no single DEFAULT_IMAGE line."
version=${reference#ghcr.io/gyblos/seller:}
version=${version%@*}
# One sed expression per pinned line; a pin for an unknown target or a missing line stops here.
set -- -e "s|^DEFAULT_IMAGE=.*|DEFAULT_IMAGE=$reference|"
if [ -n "${NATIVE_PINS:-}" ]; then
  [ "$(grep -c '^NATIVE_VERSION=' "$file")" -eq 1 ] || die "$file has no single NATIVE_VERSION line."
  set -- "$@" -e "s|^NATIVE_VERSION=.*|NATIVE_VERSION=$version|"
  count=0
  for pin in $NATIVE_PINS; do
    target=${pin%%=*}
    sha=${pin#*=}
    case "$target" in
      darwin-arm64 | linux-x64 | linux-arm64) ;;
      win32-x64) continue ;;
      *) die "not a packaged seller target: '$target'" ;;
    esac
    case " ${seen:-} " in
      *" $target "*) die "$target is pinned twice." ;;
    esac
    seen="${seen:-} $target"
    printf '%s\n' "$sha" | grep -Eq '^[0-9a-f]{64}$' || die "not a SHA-256 for $target: '$sha'"
    name=NATIVE_SHA256_$(printf '%s' "$target" | tr 'a-z-' 'A-Z_')
    [ "$(grep -c "^$name=" "$file")" -eq 1 ] || die "$file has no single $name line."
    set -- "$@" -e "s|^$name=.*|$name=$sha|"
    count=$((count + 1))
  done
  [ "$count" -eq 3 ] || die 'NATIVE_PINS needs darwin-arm64, linux-x64 and linux-arm64.'
fi
tmp=$(mktemp "$file.XXXXXX")
trap 'rm -f "$tmp"' EXIT
sed "$@" "$file" >"$tmp"
chmod 755 "$tmp"
mv -f "$tmp" "$file"
printf 'Pinned %s to %s\n' "$file" "$reference"
