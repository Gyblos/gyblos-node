#!/bin/sh
# Builds and signs the packaged sellers of one release; runs only in the release workflow
# (.github/workflows/release-seller-image.yml, job `native`). Builds gyblos-<version>-<target>.tar.gz for
# every target (Windows included, for npm) with pinned inputs (tooling/native-build.ts), signs each archive keyless with the
# workflow's GitHub identity (the identity install.sh verifies) and verifies it. Writes the archives,
# their .sha256 and .sigstore.json files to dist/native, and the `native` output: one
# `<target>=<sha256>` per target, which scripts/publish-installer.sh pins into install.sh. Then packs the
# same archives as npm packages into dist/npm (tooling/npm-packages.ts), for scripts/publish-npm.sh.
#
#   sh scripts/release-native.sh <version>
set -eu

TARGETS='darwin-arm64 linux-x64 linux-arm64 win32-x64'
ISSUER=https://token.actions.githubusercontent.com
OUT=dist/native

die() {
  printf 'release-native: %s\n' "$*" >&2
  exit 1
}

version=${1:-}
valid=0
node "$(dirname "$0")/semver-newer.mjs" "$version" "$version" 2>/dev/null || valid=$?
[ "$valid" -ne 2 ] || die "not a semantic version: '$version'"
[ "${GITHUB_ACTIONS:-}" = true ] && [ -n "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ] ||
  die 'releases only in the release workflow: push the tag v<version> from main.'
[ "${GITHUB_REF_NAME:-}" = "v$version" ] || die "the tag '${GITHUB_REF_NAME:-}' does not name the release $version."

cd "$(git rev-parse --show-toplevel)"
rm -rf "$OUT"
set --
for target in $TARGETS; do set -- "$@" --target "$target"; done
pnpm -s build:native --version "$version" --out "$OUT" "$@" >/dev/null
pins=
for target in $TARGETS; do
  archive=$OUT/gyblos-$version-$target.tar.gz
  [ -f "$archive" ] || die "missing $archive"
  sha=$(sha256sum "$archive" | cut -d ' ' -f 1)
  [ "$(cut -d ' ' -f 1 "$archive.sha256")" = "$sha" ] || die "checksum mismatch for $archive"
  cosign sign-blob --yes --bundle "$archive.sigstore.json" "$archive" >/dev/null
  cosign verify-blob \
    --bundle "$archive.sigstore.json" \
    --certificate-identity "$GITHUB_SERVER_URL/$GITHUB_WORKFLOW_REF" \
    --certificate-oidc-issuer "$ISSUER" \
    "$archive" >/dev/null ||
    die "the signature of $archive does not verify."
  pins="$pins${pins:+ }$target=$sha"
done
rm -rf dist/npm
pnpm -s build:npm --version "$version" --archives "$OUT" --out dist/npm >/dev/null
printf 'native=%s\n' "$pins" >>"${GITHUB_OUTPUT:-/dev/null}"
printf 'Built and signed %s\n' "$pins"
