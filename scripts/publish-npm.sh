#!/bin/sh
# Publishes one release's npm packages (dist/npm, from scripts/release-native.sh); runs only in the release
# workflow's `npm` job. Platform packages go first, so `gyblos` never names a version npm lacks; a version
# already on npm is skipped, so a re-run finishes a partial publish. A prerelease is tagged `beta`, anything
# else `latest`.
#
#   sh scripts/publish-npm.sh <version>
set -eu

MAIN=gyblos
PLATFORMS='darwin-arm64 linux-x64 linux-arm64'
DIR=dist/npm

die() {
  printf 'publish-npm: %s\n' "$*" >&2
  exit 1
}

version=${1:-}
valid=0
node "$(dirname "$0")/semver-newer.mjs" "$version" "$version" 2>/dev/null || valid=$?
[ "$valid" -ne 2 ] || die "not a semantic version: '$version'"
[ "${GITHUB_ACTIONS:-}" = true ] && [ -n "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ] ||
  die 'publishes only in the release workflow.'
[ "${GITHUB_REF_NAME:-}" = "v$version" ] || die "the tag '${GITHUB_REF_NAME:-}' does not name the release $version."
case "$version" in
  *-*) tag=beta ;;
  *) tag=latest ;;
esac

publish() {
  if npm view "$1@$version" version >/dev/null 2>&1; then
    printf 'Already on npm: %s@%s\n' "$1" "$version"
    return
  fi
  [ -f "$2" ] || die "missing $2"
  npm publish "$2" --provenance --access public --tag "$tag"
}

for target in $PLATFORMS; do
  publish "@gyblos/seller-$target" "$DIR/gyblos-seller-$target-$version.tgz"
done
publish "$MAIN" "$DIR/$MAIN-$version.tgz"
printf 'Published %s@%s (%s)\n' "$MAIN" "$version" "$tag"
