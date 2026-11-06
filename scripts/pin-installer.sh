#!/bin/sh
# Pins install.sh (or the given file) to one signed seller release, as the release workflow does after
# publishing it. Accepts only ghcr.io/gyblos/seller:<version>@sha256:<64 hex>.
#
#   sh scripts/pin-installer.sh <reference> [file]
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
tmp=$(mktemp "$file.XXXXXX")
trap 'rm -f "$tmp"' EXIT
sed "s|^DEFAULT_IMAGE=.*|DEFAULT_IMAGE=$reference|" "$file" >"$tmp"
chmod 755 "$tmp"
mv -f "$tmp" "$file"
printf 'Pinned %s to %s\n' "$file" "$reference"
