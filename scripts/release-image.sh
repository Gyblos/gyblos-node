#!/bin/sh
# Releases the seller node image; runs only in the release workflow
# (.github/workflows/release-seller-image.yml), started by pushing a version tag such as v0.1.0-beta.1
# from main. Builds the tagged commit alone for amd64 and arm64, pushes it as the version, the commit
# and the moving `beta` tag, signs the pushed digest keyless with the workflow's GitHub identity (the
# identity install.sh verifies) and pins install.sh in this checkout to that version and digest
# (docs/running-a-node.md#releasing-the-seller-image).
#
#   sh scripts/release-image.sh <version>
set -eu

REPOSITORY=ghcr.io/gyblos/seller
SOURCE=https://github.com/Gyblos/gyblos-node
PLATFORMS=linux/amd64,linux/arm64
CHANNEL=beta
ISSUER=https://token.actions.githubusercontent.com

die() {
  printf 'release-image: %s\n' "$*" >&2
  exit 1
}

version=${1:-}
# Semantic version, optionally with a pre-release such as -beta.1.
printf '%s\n' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z]+(\.[0-9A-Za-z]+)*)?$' ||
  die "invalid version: '$version' (expected for example 0.1.0-beta.1)"
# Keyless signing binds the release to the workflow's identity; anywhere else it would sign as a person.
[ "${GITHUB_ACTIONS:-}" = true ] && [ -n "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ] ||
  die 'releases run only in the release workflow: push the tag v<version> from main.'

cd "$(git rev-parse --show-toplevel)"
revision=$(git rev-parse HEAD)
short=$(git rev-parse --short=12 HEAD)
git fetch -q origin main
git merge-base --is-ancestor "$revision" origin/main ||
  die "the tagged commit $short is not on main."
if docker buildx imagetools inspect "$REPOSITORY:$version" >/dev/null 2>&1; then
  die "$REPOSITORY:$version already exists; choose a new version."
fi

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
  --tag "$REPOSITORY:$version" \
  --tag "$REPOSITORY:$short" \
  --tag "$REPOSITORY:$CHANNEL" \
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
tmp=$(mktemp ./.install.sh.XXXXXX)
sed "s|^DEFAULT_IMAGE=.*|DEFAULT_IMAGE=$pinned|" install.sh >"$tmp"
chmod 755 "$tmp"
mv -f "$tmp" install.sh
printf 'Released %s (commit %s), signed, also tagged :%s and :%s.\n' "$pinned" "$short" "$short" "$CHANNEL"
