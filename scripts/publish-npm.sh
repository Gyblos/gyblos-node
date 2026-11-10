#!/bin/sh
# Publishes one release's npm packages (dist/npm, from scripts/release-native.sh); runs only in the release
# workflow's `npm` job. Platform packages go first, so `gyblos` never names a version npm lacks; a version
# already on npm is skipped, so a re-run finishes a partial publish. As with the GitHub release, `latest`
# moves only to a version newer than the current one by semver precedence (betas included, since the
# betas are the product); an older line's release is tagged `previous`.
#
#   sh scripts/publish-npm.sh <version>
set -eu

MAIN=gyblos
PLATFORMS='darwin-arm64 linux-x64 linux-arm64 win32-x64'
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
tag=latest
current=$(npm view "$MAIN" dist-tags.latest 2>/dev/null || true)
if [ -n "$current" ] && [ "$current" != "$version" ]; then
  status=0
  node "$(dirname "$0")/semver-newer.mjs" "$version" "$current" || status=$?
  case "$status" in
    0) ;;
    1) tag=previous ;;
    *) die "could not compare $version with npm's latest $current." ;;
  esac
fi

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
