#!/bin/sh
# Builds the seller node image for amd64 and arm64 from a commit already on origin/main and pushes it to
# the GitHub Container Registry as the commit's tag and a moving tag (default `beta`, what install.sh
# pulls). Needs `docker login ghcr.io` with a token allowed to write Gyblos packages, never passed here,
# and a buildx builder that builds both platforms (`docker buildx create --use` makes one).
#
#   sh scripts/publish-image.sh [tag]
#
# A first push creates the package private; its visibility is set in the package's settings on GitHub.
set -eu

REPOSITORY=ghcr.io/gyblos/node
SOURCE=https://github.com/Gyblos/gyblos-node
PLATFORMS=linux/amd64,linux/arm64

die() {
  printf 'publish-image: %s\n' "$*" >&2
  exit 1
}

tag=${1:-beta}
case "$tag" in
  '' | *[!A-Za-z0-9._-]*) die "invalid tag: $tag" ;;
esac
cd "$(git rev-parse --show-toplevel)"
git fetch -q origin main
# Only the tip, so the moving tag never goes back to an older commit.
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] ||
  die 'HEAD is not origin/main; check out the latest main to publish.'
revision=$(git rev-parse HEAD)
short=$(git rev-parse --short=12 HEAD)

# The build context is the commit itself, so no local, untracked or ignored file can reach the image.
context=$(mktemp -d)
trap 'rm -rf "$context" "$context.tar"' EXIT
git archive --output "$context.tar" HEAD
tar -x -f "$context.tar" -C "$context"
rm -f "$context.tar"

docker buildx build \
  --platform "$PLATFORMS" \
  --label "org.opencontainers.image.source=$SOURCE" \
  --label "org.opencontainers.image.revision=$revision" \
  --tag "$REPOSITORY:$short" \
  --tag "$REPOSITORY:$tag" \
  --push \
  "$context"
printf 'Pushed %s:%s and %s:%s\n' "$REPOSITORY" "$short" "$REPOSITORY" "$tag"
