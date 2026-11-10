#!/bin/sh
# Publishes the installer of one seller release; runs only in the release workflow
# (.github/workflows/release-seller-image.yml), after scripts/release-image.sh has pushed and signed the
# image. Pins a copy of install.sh to that image, signs the copy keyless with the workflow's GitHub
# identity and creates the GitHub release of the pushed tag with install.sh, its SHA-256 and its
# Sigstore bundle. From NATIVE_PINS and NATIVE_DIR (scripts/release-native.sh, required) it also checks the
# packaged sellers' signatures and checksums, pins install.sh to them and attaches them; install.ps1 is
# pinned to the Windows seller and signed the same way. Only a version newer than the latest release becomes latest (what
# https://gyblos.com/install.sh serves) and moves `beta`, so an older line's patch never replaces it.
# Re-running it finishes a partial publish: an existing release gets its files replaced, and a release
# that is already latest still moves `beta`. Nothing is committed to the repository
# (docs/running-a-node.md#releasing-the-seller-image).
#
#   sh scripts/publish-installer.sh <ghcr.io/gyblos/seller:<version>@sha256:<digest>>
set -eu

REPOSITORY=ghcr.io/gyblos/seller
CHANNEL=beta
ISSUER=https://token.actions.githubusercontent.com

die() {
  printf 'publish-installer: %s\n' "$*" >&2
  exit 1
}

reference=${1:-}
printf '%s\n' "$reference" |
  grep -Eq '^ghcr\.io/gyblos/seller:[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z]+(\.[0-9A-Za-z]+)*)?@sha256:[0-9a-f]{64}$' ||
  die "not a seller release reference: '$reference'"
version=${reference#"$REPOSITORY:"}
version=${version%@*}
digest=${reference#*@}
valid=0
node "$(dirname "$0")/semver-newer.mjs" "$version" "$version" 2>/dev/null || valid=$?
[ "$valid" -ne 2 ] || die "not a semantic version: '$version'"
# Keyless signing binds the installer to the workflow's identity; anywhere else it would sign as a person.
[ "${GITHUB_ACTIONS:-}" = true ] && [ -n "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ] ||
  die 'publishes only in the release workflow: push the tag v<version> from main.'
tag=${GITHUB_REF_NAME:-}
[ "$tag" = "v$version" ] || die "the tag '$tag' does not name the release $version."

cd "$(git rev-parse --show-toplevel)"
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
native_files=
# Every release carries its packaged sellers: an installer without them would strand native installs.
[ -n "${NATIVE_PINS:-}" ] && [ -d "${NATIVE_DIR:-}" ] ||
  die 'NATIVE_PINS and NATIVE_DIR (from the native job) are required.'
if [ -n "${NATIVE_PINS:-}" ]; then
  for pin in $NATIVE_PINS; do
    archive=$NATIVE_DIR/gyblos-$version-${pin%%=*}.tar.gz
    [ "$(sha256sum "$archive" | cut -d ' ' -f 1)" = "${pin#*=}" ] ||
      die "$archive does not match its pinned checksum."
    cosign verify-blob \
      --bundle "$archive.sigstore.json" \
      --certificate-identity "$GITHUB_SERVER_URL/$GITHUB_WORKFLOW_REF" \
      --certificate-oidc-issuer "$ISSUER" \
      "$archive" >/dev/null ||
      die "the signature of $archive does not verify."
    native_files="$native_files $archive $archive.sha256 $archive.sigstore.json"
    [ "${pin%%=*}" != win32-x64 ] || windows_sha=${pin#*=}
  done
fi
[ -n "${windows_sha:-}" ] || die 'NATIVE_PINS has no win32-x64 seller for install.ps1.'
cp install.sh "$out/install.sh"
sh scripts/pin-installer.sh "$reference" "$out/install.sh" >/dev/null
cp install.ps1 "$out/install.ps1"
sh scripts/pin-installer-windows.sh "$version" "$windows_sha" "$out/install.ps1" >/dev/null
for installer in install.sh install.ps1; do
  (cd "$out" && sha256sum "$installer" >"$installer.sha256")
  cosign sign-blob --yes --bundle "$out/$installer.sigstore.json" "$out/$installer" >/dev/null
  cosign verify-blob \
    --bundle "$out/$installer.sigstore.json" \
    --certificate-identity "$GITHUB_SERVER_URL/$GITHUB_WORKFLOW_REF" \
    --certificate-oidc-issuer "$ISSUER" \
    "$out/$installer" >/dev/null ||
    die "the $installer signature does not verify."
done

# Prints the tag name at a releases API path, or nothing when GitHub answers a clear 404; any other
# failure stops before publishing.
release_tag() {
  if found=$(gh api "repos/$GITHUB_REPOSITORY/releases/$1" --jq .tag_name 2>&1); then
    printf '%s' "$found"
  else
    case "$found" in
      *'HTTP 404'*) ;;
      *) die "could not read the release $1: $found" ;;
    esac
  fi
}
current=$(release_tag latest)
existing=$(release_tag "tags/$tag")
latest=true
if [ -n "$current" ] && [ "$current" != "$tag" ]; then
  status=0
  node scripts/semver-newer.mjs "$version" "${current#v}" || status=$?
  case "$status" in
    0) ;;
    1) latest=false ;;
    *) die "could not compare $version with the latest release $current." ;;
  esac
fi

run="$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID"
cat >"$out/notes.md" <<EOF
Seller node $version.

- Image: \`$reference\`, signed by \`$GITHUB_SERVER_URL/$GITHUB_WORKFLOW_REF\` ([release run]($run)).
- \`install.sh\` installs exactly this image, or without Docker the packaged seller
  \`gyblos-$version-<target>.tar.gz\` (macOS arm64, Linux x64 and arm64) pinned by checksum and signed by
  the same workflow. \`install.sh.sigstore.json\` is the installer's signature by the same workflow and
  \`install.sh.sha256\` its checksum.
- \`install.ps1\` installs \`gyblos-$version-win32-x64.tar.gz\` on Windows x64, with its own checksum and
  signature; the same seller is on npm for every platform.
- Install or update: \`curl -fsSL https://gyblos.com/install.sh -o install.sh && sh install.sh\`
  (gyblos.com serves the installer of the latest release). On Windows, in PowerShell:
  \`irm $GITHUB_SERVER_URL/$GITHUB_REPOSITORY/releases/latest/download/install.ps1 -OutFile install.ps1; powershell -ExecutionPolicy Bypass -File install.ps1\`
EOF
files="$out/install.sh $out/install.sh.sha256 $out/install.sh.sigstore.json $out/install.ps1 $out/install.ps1.sha256 $out/install.ps1.sigstore.json$native_files"
if [ -z "$existing" ]; then
  # shellcheck disable=SC2086 # paths without spaces
  gh release create "$tag" $files \
    --verify-tag \
    --title "Seller $version" \
    --notes-file "$out/notes.md" \
    --generate-notes \
    --latest="$latest" >/dev/null
else
  # A previous run created the release; replace its files with this run's signed copies.
  # shellcheck disable=SC2086
  gh release upload "$tag" $files --clobber >/dev/null
  [ "$latest" = false ] || [ "$current" = "$tag" ] || gh release edit "$tag" --latest >/dev/null
fi

if [ "$latest" = true ]; then
  docker buildx imagetools create --tag "$REPOSITORY:$CHANNEL" "$REPOSITORY@$digest"
  printf 'Published release %s with its installer, marked latest, and moved :%s.\n' "$tag" "$CHANNEL"
else
  printf 'Published release %s with its installer; %s stays latest.\n' "$tag" "$current"
fi
