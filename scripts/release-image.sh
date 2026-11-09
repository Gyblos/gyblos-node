#!/bin/sh
# Releases the seller node image; runs only in the release workflow
# (.github/workflows/release-seller-image.yml), started by pushing a version tag such as v0.1.0-beta.2
# from main. Builds the tagged commit alone for amd64 and arm64, pushes it as the version and the
# commit and signs the pushed digest keyless with the workflow's GitHub identity (the identity install.sh
# verifies). Prints the pinned reference and hands it to the next job, scripts/publish-installer.sh,
# which publishes the installer and moves `beta` (docs/running-a-node.md#releasing-the-seller-image).
#
#   sh scripts/release-image.sh <version>
set -eu

REPOSITORY=ghcr.io/gyblos/seller
SOURCE=https://github.com/Gyblos/gyblos-node
PLATFORMS=linux/amd64,linux/arm64
ISSUER=https://token.actions.githubusercontent.com

die() {
  printf 'release-image: %s\n' "$*" >&2
  exit 1
}

version=${1:-}
# Semantic version, optionally with a pre-release such as -beta.1.
printf '%s\n' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z]+(\.[0-9A-Za-z]+)*)?$' ||
  die "invalid version: '$version' (expected for example 0.1.0-beta.1)"
# The same rule the publish job uses to order releases (no leading zeros), checked before anything is pushed.
valid=0
node "$(dirname "$0")/semver-newer.mjs" "$version" "$version" 2>/dev/null || valid=$?
[ "$valid" -ne 2 ] || die "invalid version: '$version' (expected for example 0.1.0-beta.1)"
# Keyless signing binds the release to the workflow's identity; anywhere else it would sign as a person.
[ "${GITHUB_ACTIONS:-}" = true ] && [ -n "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ] ||
  die 'releases run only in the release workflow: push the tag v<version> from main.'

cd "$(git rev-parse --show-toplevel)"
revision=$(git rev-parse HEAD)
short=$(git rev-parse --short=12 HEAD)
# origin/main comes from the workflow's full-history checkout; no credentials are needed here.
git merge-base --is-ancestor "$revision" origin/main ||
  die "the tagged commit $short is not on main."
# Only a clear "not found" lets the release go ahead; any other failure might hide an existing version.
if found=$(docker buildx imagetools inspect "$REPOSITORY:$version" 2>&1); then
  die "$REPOSITORY:$version already exists; choose a new version."
fi
case "$found" in
  *'not found'* | *MANIFEST_UNKNOWN* | *'manifest unknown'*) ;;
  *) die "could not check whether $REPOSITORY:$version exists: $found" ;;
esac

# The build context is the commit itself, so no local, untracked or ignored file can reach the image.
context=$(mktemp -d)
trap 'rm -rf "$context" "$context.tar" "$context.json"' EXIT
git archive --output "$context.tar" "$revision"
tar -x -f "$context.tar" -C "$context"
rm -f "$context.tar"

docker buildx build \
  --platform "$PLATFORMS" \
  --label "org.opencontainers.image.source=$SOURCE" \
  --label "org.opencontainers.image.revision=$revision" \
  --label "org.opencontainers.image.version=$version" \
  --build-arg "GYBLOS_VERSION=$version" \
  --tag "$REPOSITORY:$version" \
  --tag "$REPOSITORY:$short" \
  --metadata-file "$context.json" \
  --push \
  "$context"
digest=$(sed -n 's/.*"containerimage.digest": *"\(sha256:[0-9a-f]\{64\}\)".*/\1/p' "$context.json")
[ -n "$digest" ] || die 'the build did not report the pushed digest.'

# The signature covers the digest, never a tag, and names exactly this workflow at this tag.
cosign sign --yes "$REPOSITORY@$digest"
cosign verify \
  --certificate-identity "$GITHUB_SERVER_URL/$GITHUB_WORKFLOW_REF" \
  --certificate-oidc-issuer "$ISSUER" \
  "$REPOSITORY@$digest" >/dev/null ||
  die "the signature of $REPOSITORY@$digest does not verify."

pinned="$REPOSITORY:$version@$digest"
[ -z "${GITHUB_OUTPUT:-}" ] || printf 'pinned=%s\n' "$pinned" >>"$GITHUB_OUTPUT"
printf 'Released %s (commit %s), signed, also tagged :%s.\n' "$pinned" "$short" "$short"
