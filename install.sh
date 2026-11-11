#!/bin/sh
# Installs a Gyblos seller (docs/running-a-node.md#install-script). With Docker (Compose v2.17 or later):
# the published node image and its own loopback Ollama. Without Docker, on macOS Apple Silicon or Linux
# (x64, arm64, glibc): the packaged seller, checked against this release's checksum and signature, with
# the machine's own Ollama, run as a user service. No port is opened.
#
#   sh install.sh             install or update the seller; on a terminal it then registers the seller
#                             and publishes it, asking before each step (otherwise it prints those steps)
#   sh install.sh publish     list the installed seller in the discovery index (after registering it)
#   sh install.sh unpublish   withdraw it from the index; it keeps running
#   sh install.sh update      download the latest release's installer, check it and run it here
#
# Environment (all optional):
#   GYBLOS_MODE         docker or native (default: an existing install's, else docker when it runs)
#   GYBLOS_DIR          Docker: where compose.yaml, gyblos.toml and seller.env go (default: ~/gyblos-seller)
#   GYBLOS_HOME         native: the seller's home, with gyblos.toml and seller.env (default: ~/.gyblos)
#   GYBLOS_IMAGE        node image (default: the release pinned below, by version and digest)
#   GYBLOS_RELAY_TOKEN  the relay token; asked for without echo when unset
#   GYBLOS_REQUIRE_SIGNATURE=1  stop unless cosign verifies the seller image as a Gyblos release
#   GYBLOS_GUIDED=0     only print the steps to start selling; never ask to register or publish
#
# Existing gyblos.toml and seller.env are kept, and so is compose.yaml except for a Gyblos seller image,
# which moves to this script's release: rerunning resumes a failed install, updates the seller and
# restarts it with the current gyblos.toml. With cosign installed, a Gyblos image must carry the release
# signature of the release workflow (docs/running-a-node.md#image-signature).
# The relay token is written only to seller.env (mode 0600) and never printed.
set -eu
# Byte-wise character classes: [:graph:] is then exactly the printable ASCII seller.env accepts.
LC_ALL=C
export LC_ALL

# Set by scripts/release-image.sh when a release is published.
DEFAULT_IMAGE=ghcr.io/gyblos/seller:0.1.0-beta.2@sha256:ec35358fb0ec3426b5c3d42551937ee5a4466dc8292bf9652c842a0e4814a418
RELEASE_REPOSITORY=ghcr.io/gyblos/seller
# The same, as a sed pattern.
RELEASE_PATTERN='ghcr\.io/gyblos/seller'
# Releases are signed keyless by the release workflow at a version tag; cosign checks that identity.
RELEASE_IDENTITY='^https://github\.com/Gyblos/gyblos-node/\.github/workflows/release-seller-image\.yml@refs/tags/v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$'
RELEASE_ISSUER=https://token.actions.githubusercontent.com
# Each release attaches its installer, checksum and signature bundle; the latest release is the update.
RELEASE_DOWNLOAD=https://github.com/Gyblos/gyblos-node/releases/latest/download
# Devnet USDC (packages/config/src/network.ts DEVNET_USDC).
MINT=4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU
# The model the default offer serves (examples/seller-docker.toml).
MODEL=qwen3:0.6b
COMPOSE_MAJOR=2
COMPOSE_MINOR=17
COSIGN_MAJOR=3
OLLAMA_WAIT_SECONDS=60
OLLAMA_POLL_SECONDS=2
# packages/transport-iroh/src/constants.ts RELAY_TOKEN_LENGTH.
RELAY_TOKEN_MIN=32
RELAY_TOKEN_MAX=512
# Set by scripts/pin-installer.sh: this release's packaged sellers, by checksum. Empty in the
# repository's copy, which then installs only with Docker.
NATIVE_VERSION=
NATIVE_SHA256_DARWIN_ARM64=
NATIVE_SHA256_LINUX_X64=
NATIVE_SHA256_LINUX_ARM64=
RELEASE_TAGS=https://github.com/Gyblos/gyblos-node/releases/download
# The machine's own Ollama, which a packaged seller uses.
NATIVE_OLLAMA=http://127.0.0.1:11434

dir=${GYBLOS_DIR:-$HOME/gyblos-seller}
docker_dir=$dir
native_home=${GYBLOS_HOME:-$HOME/.gyblos}
bin_dir=$HOME/.local/bin
mode=${GYBLOS_MODE:-}
case "$mode" in
  '' | docker | native) ;;
  *)
    printf 'gyblos install: GYBLOS_MODE must be docker or native.\n' >&2
    exit 1
    ;;
esac
strict=${GYBLOS_REQUIRE_SIGNATURE:-0}
case "$strict" in
  0 | 1) ;;
  *)
    printf 'gyblos install: GYBLOS_REQUIRE_SIGNATURE must be 1 or unset.\n' >&2
    exit 1
    ;;
esac
# This script's own path, for the next steps it prints (a piped script has none).
if [ -f "$0" ]; then
  self="$(cd "$(dirname -- "$0")" && pwd -P)/$(basename -- "$0")"
else
  self=install.sh
fi
image=${GYBLOS_IMAGE:-$DEFAULT_IMAGE}
guided=${GYBLOS_GUIDED:-1}
case "$guided" in
  0 | 1) ;;
  *)
    printf 'gyblos install: GYBLOS_GUIDED must be 0 or 1 (unset means 1).\n' >&2
    exit 1
    ;;
esac
# Where the guided steps read their answers; tests point it at a file.
terminal=${GYBLOS_TERMINAL:-/dev/tty}

say() { printf '%s\n' "$*"; }
die() {
  printf 'gyblos install: %s\n' "$*" >&2
  exit 1
}

check_docker() {
  command -v docker >/dev/null 2>&1 ||
    die 'Docker is not installed: https://docs.docker.com/engine/install/'
  docker info >/dev/null 2>&1 ||
    die 'Docker is not running, or this account may not use it (on Linux, add it to the docker group).'
  version=$(docker compose version --short 2>/dev/null) ||
    die "Docker Compose v2 is missing: install the compose plugin (v$COMPOSE_MAJOR.$COMPOSE_MINOR or later)."
  version=${version#v}
  major=${version%%.*}
  rest=${version#*.}
  minor=${rest%%.*}
  case "$major$minor" in
    '' | *[!0-9]*) die "Unrecognized Docker Compose version: $version" ;;
  esac
  if [ "$major" -lt "$COMPOSE_MAJOR" ] ||
    { [ "$major" -eq "$COMPOSE_MAJOR" ] && [ "$minor" -lt "$COMPOSE_MINOR" ]; }; then
    die "Docker Compose $version is too old; v$COMPOSE_MAJOR.$COMPOSE_MINOR or later is needed."
  fi
}

check_image() {
  case "$image" in
    '' | *[!A-Za-z0-9./:_@-]*) die "GYBLOS_IMAGE is not an image reference: $image" ;;
  esac
}

# Refuses a symbolic link where the script writes a file, so the token never lands elsewhere.
refuse_symlink() {
  [ ! -L "$1" ] || die "$dir/$1 is a symbolic link; remove it and run this script again."
}

# Writes standard input to a private temporary file beside $1, then renames it with mode $2: an
# interrupted run never leaves a partial file that a rerun would keep.
install_file() {
  tmp=$(mktemp "./.$1.XXXXXX")
  cat >"$tmp"
  chmod "$2" "$tmp"
  mv -f "$tmp" "$1"
  tmp=
}

# Runs on every exit: removes a temporary file an interruption left (it may hold the token) and turns
# echo back on if the token prompt was interrupted.
cleanup() {
  # An interrupted or failed publish change goes back to the saved original before it is removed.
  [ -z "${restore:-}" ] || cat "$original" >gyblos.toml
  [ -z "${tmp:-}" ] || rm -f "$tmp"
  [ -z "${work:-}" ] || rm -rf "$work"
  [ -z "${unpack:-}" ] || rm -rf "$unpack"
  [ -z "${prompting:-}" ] || stty echo </dev/tty 2>/dev/null || true
}

# The same compose.yaml as the repository's, with the published image instead of a local build.
write_compose() {
  refuse_symlink compose.yaml
  if [ -e compose.yaml ]; then
    update_compose_image
    return
  fi
  # A substitution, not a pipe, so `set -e` sees a failing sed; it drops the final newline printf restores.
  contents=$(sed "s|GYBLOS_IMAGE_PLACEHOLDER|$image|" <<'COMPOSE'
# A seller with its own Ollama. Setup and use: docs/running-a-node.md#docker.
# The seller shares Ollama's network namespace because the Ollama engine accepts only a literal loopback
# URL; Ollama listens on 127.0.0.1 there and no port is published. Iroh connects outbound only.
services:
  ollama:
    image: ollama/ollama:0.40.0
    environment:
      OLLAMA_HOST: 127.0.0.1:11434
      OLLAMA_NO_CLOUD: '1'
      OLLAMA_NUM_PARALLEL: '1'
      OLLAMA_MAX_LOADED_MODELS: '1'
    volumes:
      - ollama:/root/.ollama
    restart: unless-stopped

  seller:
    image: GYBLOS_IMAGE_PLACEHOLDER
    network_mode: service:ollama
    # A restarted Ollama gets a new network namespace; compose then restarts the seller into it.
    depends_on:
      ollama:
        condition: service_started
        restart: true
    # Forwards stop signals to the daemon even during startup, before it installs its own handler.
    init: true
    # GYBLOS_RELAY_TOKEN and any api_key_env variables, NAME=value per line; keep it private.
    env_file:
      - ./seller.env
    volumes:
      - gyblos:/data
      - type: bind
        source: ./gyblos.toml
        target: /config/gyblos.toml
        read_only: true
        bind:
          create_host_path: false
    # Startup needs 1.5 GiB of memory headroom above the seller itself.
    mem_limit: 2g
    cpus: 1.0
    stop_grace_period: 120s
    restart: unless-stopped

volumes:
  ollama:
  gyblos:
COMPOSE
  )
  printf '%s\n' "$contents" | install_file compose.yaml 644
  say "Wrote $dir/compose.yaml"
}

# An existing compose.yaml keeps every line except a seller image from the Gyblos repository, which
# moves to $image; any other image is the operator's own and stays.
update_compose_image() {
  current=$(sed -n "s|^    image: \($RELEASE_PATTERN[:@][^ ]*\)\$|\1|p" compose.yaml)
  if [ -z "$current" ] || [ "$(printf '%s\n' "$current" | wc -l)" -ne 1 ]; then
    say "Kept existing $dir/compose.yaml"
    [ -z "${GYBLOS_IMAGE:-}" ] || say "  GYBLOS_IMAGE is not applied to it; change its seller image there."
    return
  fi
  if [ "$current" = "$image" ]; then
    say "Kept existing $dir/compose.yaml"
    return
  fi
  contents=$(sed "s|^    image: $RELEASE_PATTERN[:@][^ ]*\$|    image: $image|" compose.yaml)
  printf '%s\n' "$contents" | install_file compose.yaml 644
  say "Updated the seller image in $dir/compose.yaml: $current -> $image"
}

# The seller image compose.yaml runs.
compose_image() {
  sed -n '/^  seller:$/,/^  [a-z]/s|^    image: \([^ ]*\)$|\1|p' compose.yaml
}

# A Gyblos image must carry the release workflow's signature when cosign is available; without cosign
# the check is skipped and said so. Another repository's image is the operator's own build and is not
# checked.
# A check that could not run: a note by default, a stop with GYBLOS_REQUIRE_SIGNATURE=1.
unchecked() {
  [ "$strict" = 1 ] || {
    say "$1"
    return
  }
  die "${1#"  "} GYBLOS_REQUIRE_SIGNATURE=1 requires a verified Gyblos release signature."
}

verify_image() {
  run=$(compose_image)
  case "$run" in
    "$RELEASE_REPOSITORY":* | "$RELEASE_REPOSITORY"@*) ;;
    *)
      unchecked "Not a Gyblos release image, so its signature is not checked: $run"
      return
      ;;
  esac
  if ! command -v cosign >/dev/null 2>&1; then
    unchecked 'cosign is not installed, so the image signature was not checked (docs: image signature).'
    return
  fi
  # Releases carry cosign 3 signature bundles, which older cosign does not find.
  major=$(cosign version 2>/dev/null | sed -n 's/^GitVersion: *v\{0,1\}\([0-9][0-9]*\)\..*/\1/p')
  if [ -z "$major" ] || [ "$major" -lt "$COSIGN_MAJOR" ]; then
    unchecked "cosign $COSIGN_MAJOR or later is needed to check the image signature; it was not checked."
    return
  fi
  # Compose also reads override files and COMPOSE_FILE; the check covers only compose.yaml's seller.
  for other in compose.override.yaml compose.override.yml docker-compose.override.yaml docker-compose.override.yml .env; do
    [ ! -e "$other" ] || unchecked "  $other is present: the signature check covers only the seller image in compose.yaml."
  done
  [ -z "${COMPOSE_FILE:-}" ] || unchecked '  COMPOSE_FILE is set: the signature check covers only the seller image in compose.yaml.'
  cosign verify --certificate-identity-regexp "$RELEASE_IDENTITY" \
    --certificate-oidc-issuer "$RELEASE_ISSUER" "$run" >/dev/null 2>&1 ||
    die "The image signature did not verify as a Gyblos release: $run"
  say "Verified the Gyblos release signature of $run"
}

# examples/seller-docker.toml without its repository-relative schema line.
write_config() {
  refuse_symlink gyblos.toml
  if [ -e gyblos.toml ]; then
    say "Kept existing $dir/gyblos.toml"
    return
  fi
  install_file gyblos.toml 644 <<'TOML'
# The seller daemon in Docker (compose.yaml): the pinned Qwen3 0.6B with reasoning off on the compose
# Ollama, given away free within daily token caps. Copy it next to compose.yaml as gyblos.toml; the seller
# shares Ollama's network namespace, so 127.0.0.1:11434 is that Ollama (docs/running-a-node.md#docker).
# Free by default. To charge, give an offer `price = {...}` instead of `free` (docs/configuration.md) and
# fund the fee payer `gyblos doctor` prints with devnet SOL.

version = 1

[node]
network = "devnet"

[discovery]
# Off so a test node is not listed by accident; set publish = true to appear in discovery.
publish = false

# Optional capacity limits; omitted keys keep these defaults (docs/configuration.md#seller-limits).
# [limits]
# max_connections = 8
# requests_per_minute = 30

[[offers]]
model = "qwen3:0.6b"
reasoning = ["off"]
engine = { kind = "ollama", url = "http://127.0.0.1:11434/" }
free = { daily_token_cap = 200000, per_buyer_cap = 50000 }
TOML
  say "Wrote $dir/gyblos.toml"
}

# The relay token goes straight from the prompt or the environment into seller.env.
write_environment() {
  refuse_symlink seller.env
  if [ -e seller.env ]; then
    say "Kept existing $dir/seller.env"
    return
  fi
  token=${GYBLOS_RELAY_TOKEN:-}
  if [ -z "$token" ]; then
    # Opening it, not testing its mode: /dev/tty exists even without a controlling terminal.
    (exec </dev/tty) 2>/dev/null ||
      die 'No terminal to ask for the relay token: set GYBLOS_RELAY_TOKEN.'
    printf '%s\n' 'The relay token is the private key to the Gyblos relay. It is not the gyb_ invite code,' \
      'which you enter later with `gyblos seller register`.' >/dev/tty
    printf 'Relay token (not shown): ' >/dev/tty
    prompting=1
    stty -echo </dev/tty
    IFS= read -r token </dev/tty || token=
    stty echo </dev/tty
    prompting=
    printf '\n' >/dev/tty
  fi
  # An invite code here would install a seller that cannot reach the relay.
  case "$token" in
    gyb_*) die 'That is the gyb_ invite code, not the relay token. Enter the invite code later with `gyblos seller register`; rerun this with the relay token.' ;;
  esac
  # seller.env's grammar (`gyblos seller service install` reads it too): printable, no shell characters.
  case "$token" in
    '' | *[![:graph:]]* | *[\"\'\`\$\\\#\;\|\<\>\&\(\)\{\}~]*)
      die 'The relay token is empty or has characters a relay token never has.'
      ;;
  esac
  [ "${#token}" -ge "$RELAY_TOKEN_MIN" ] && [ "${#token}" -le "$RELAY_TOKEN_MAX" ] ||
    die "The relay token must have $RELAY_TOKEN_MIN to $RELAY_TOKEN_MAX characters."
  # printf is a shell builtin: the token never appears in a process's arguments.
  printf 'GYBLOS_RELAY_TOKEN=%s\n' "$token" | install_file seller.env 600
  token=
  say "Wrote $dir/seller.env (mode 0600)"
}

wait_for_ollama() {
  waited=0
  until docker compose exec -T ollama ollama list >/dev/null 2>&1; do
    [ "$waited" -lt "$OLLAMA_WAIT_SECONDS" ] || die 'Ollama did not start; see `docker compose logs ollama`.'
    sleep "$OLLAMA_POLL_SECONDS"
    waited=$((waited + OLLAMA_POLL_SECONDS))
  done
}

# The `gyblos` command of the installed seller: in its container, or the packaged one.
seller_cli() {
  if [ "$mode" = native ]; then
    "$native_home/app/current/bin/gyblos" "$@"
  else
    docker compose exec seller gyblos "$@"
  fi
}
# The same, as the operator types it.
# What a packaged seller's commands need besides `gyblos`: its home when not the default, and the mode
# when a Docker install is also here (which would otherwise win).
native_env() {
  [ "$native_home" = "$HOME/.gyblos" ] || printf 'GYBLOS_HOME=%s ' "$(quoted "$native_home")"
}
native_mode_env() {
  [ ! -f "$docker_dir/compose.yaml" ] || printf 'GYBLOS_MODE=native '
}
seller_typed() {
  if [ "$mode" = native ]; then
    printf '%sgyblos %s' "$(native_env)" "$1"
  else
    printf 'cd %s && docker compose exec seller gyblos %s' "$(quoted "$dir")" "$1"
  fi
}

# The steps between a running seller and a listed one; a seller already publishing only needs a check.
# Single-quoted for pasting (paths with spaces); with GYBLOS_DIR when it is not the default.
quoted() { printf "'%s'" "$1"; }
publish_command() {
  if [ "$mode" = native ]; then
    printf '%s%ssh %s%s' "$(native_mode_env)" "$(native_env)" "$(quoted "$self")" "${1:+ $1}"
  elif [ "$dir" = "$HOME/gyblos-seller" ]; then
    printf 'sh %s%s' "$(quoted "$self")" "${1:+ $1}"
  else
    printf 'GYBLOS_DIR=%s sh %s%s' "$(quoted "$dir")" "$(quoted "$self")" "${1:+ $1}"
  fi
}

# Tolerates spacing, a comment and CRLF line endings, like the TOML reader.
publishing() {
  tr -d '\r' <gyblos.toml | grep -Eq '^[[:space:]]*publish[[:space:]]*=[[:space:]]*true[[:space:]]*(#.*)?$'
}

next_steps() {
  say ''
  say 'Next steps, to start selling:'
  say "  1. Send about 0.02 devnet SOL to the seller's owner${owner:+ $owner}"
  say '     (https://faucet.solana.com, choose devnet). It pays the one-time registration, about 0.01 SOL.'
  say '  2. Register with the gyb_ invite code from your invitation (asked for, not the relay token):'
  say "       $(seller_typed 'seller register')"
  say '  3. Publish to the discovery index:'
  say "       $(publish_command publish)"
}

# y, yes or an empty answer (the default) from the terminal; anything else, or no answer, declines.
confirm() {
  printf '%s [Y/n] ' "$1"
  IFS= read -r answer <"$terminal" || answer=n
  case "$answer" in
    '' | [yY] | [yY][eE][sS]) return 0 ;;
    *) return 1 ;;
  esac
}

# On a terminal, finishes onboarding: registers the seller (the command asks for the invite, waits for
# the owner's SOL and confirms before signing), then publishes it once the operator agrees. Returns 1
# without asking anything when there is no terminal or GYBLOS_GUIDED=0, so the caller prints the steps.
guided_setup() {
  [ "$guided" = 1 ] || return 1
  # Opening it, not testing its mode: /dev/tty exists even without a controlling terminal.
  (exec <"$terminal") 2>/dev/null || return 1
  say ''
  say 'Next: register this seller and publish it, so buyers can find it.'
  say 'Each step asks before it does anything. Press Ctrl+C at any time; run this script again to continue.'
  say ''
  say 'Step 1 of 2: register, with the gyb_ invite code from your invitation (not the relay token).'
  say "  The owner${owner:+ $owner} pays about 0.01 devnet SOL once; registration waits for it if needed."
  if ! seller_cli seller register <"$terminal"; then
    say ''
    say 'Registration did not finish. Fix what it says, then run this script again to continue:'
    say "  $(publish_command '')"
    return 0
  fi
  say ''
  if ! confirm 'Step 2 of 2: publish this seller to the discovery index now?'; then
    say 'Not published. When you are ready:'
    say "  $(publish_command publish)"
    return 0
  fi
  set_publish true
  say ''
  say 'Done: this seller is registered and published. Buyers can find it within about two minutes.'
}

# Checks gyblos.toml with the installed seller, then restarts it with the file.
validate_config() {
  if [ "$mode" = native ]; then
    seller_cli config validate --config "$dir/gyblos.toml" 2>&1
  else
    docker compose run --rm seller gyblos config validate --config /config/gyblos.toml 2>&1
  fi
}
restart_seller() {
  if [ "$mode" = native ]; then
    restart_service ||
      die "gyblos.toml is changed, but the seller service did not restart; restart it (or run $(seller_typed 'seller service install')) for the change to apply."
  else
    docker compose up -d --force-recreate seller
  fi
}

# Turns publishing on or off in the installed gyblos.toml, then restarts the seller with it. With Docker
# the file is read-only inside the container, so this runs on the host; an invalid result restores the
# original.
set_publish() {
  if [ "$mode" = native ]; then
    [ -f "$dir/gyblos.toml" ] && [ -e "$native_home/app/current" ] ||
      die "No packaged seller in $dir: run sh install.sh first (GYBLOS_HOME names another home)."
  else
    check_docker
    [ -f "$dir/gyblos.toml" ] && [ -f "$dir/compose.yaml" ] ||
      die "No installed seller in $dir: run sh install.sh first (GYBLOS_DIR names another directory)."
  fi
  cd "$dir"
  refuse_symlink gyblos.toml
  [ "$(grep -Ec '^publish = (true|false)$' gyblos.toml)" -eq 1 ] ||
    die 'gyblos.toml has no single "publish = true" or "publish = false" line under [discovery]; set it by hand.'
  original=$(mktemp ./.gyblos.toml.XXXXXX)
  tmp=$original
  cp gyblos.toml "$original"
  # Rewritten in place, keeping the file the running container has bind-mounted; until the seller is
  # recreated with it, any exit restores the original (cleanup).
  restore=1
  sed -E "s/^publish = (true|false)\$/publish = $1/" "$original" >gyblos.toml
  grep -Eq "^publish = $1\$" gyblos.toml || {
    cat "$original" >gyblos.toml
    die 'could not change publish in gyblos.toml; set it by hand.'
  }
  if ! report=$(validate_config); then
    cat "$original" >gyblos.toml
    printf '%s\n' "$report" >&2
    die 'gyblos.toml is not valid with that change; it was left as it was.'
  fi
  restore=
  restart_seller
  if [ "$1" = true ]; then
    say 'Publishing is on: the index lists this seller within about two minutes, once it is registered.'
    say "  Check: $(seller_typed 'seller status --online')"
  else
    say 'Publishing is off: the index withdraws this seller within about two minutes. It keeps running.'
  fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d ' ' -f 1
  else
    die 'sha256sum or shasum is needed to check the downloaded installer.'
  fi
}

# With cosign, checks a downloaded file's release signature (strict mode needs it): $1 the file, $2 what it
# is, for the messages.
verify_signature() {
  if ! command -v cosign >/dev/null 2>&1; then
    unchecked "cosign is not installed, so the $2 signature was not checked (docs: image signature)."
    return
  fi
  # Releases carry cosign 3 bundles, which older cosign cannot read.
  major=$(cosign version 2>/dev/null | sed -n 's/^GitVersion: *v\{0,1\}\([0-9][0-9]*\)\..*/\1/p')
  if [ -z "$major" ] || [ "$major" -lt "$COSIGN_MAJOR" ]; then
    unchecked "cosign $COSIGN_MAJOR or later is needed to check the $2 signature; it was not checked."
    return
  fi
  cosign verify-blob "$1" --bundle "$1.sigstore.json" \
    --certificate-identity-regexp "$RELEASE_IDENTITY" --certificate-oidc-issuer "$RELEASE_ISSUER" \
    >/dev/null 2>&1 ||
    die "The downloaded $2 signature did not verify as a Gyblos release; nothing was changed."
  say "Verified the Gyblos release signature of the $2."
}

# Checks the downloaded installer's checksum and, with cosign, its release signature.
verify_installer() {
  expected=$(cut -d ' ' -f 1 "$work/install.sh.sha256")
  [ "$(sha256_of "$work/install.sh")" = "$expected" ] ||
    die 'The downloaded installer does not match its checksum; nothing was changed.'
  verify_signature "$work/install.sh" installer
}

# Downloads the latest release's installer, checks it, keeps it in place of this one (or, when this one is
# not a writable file, in the install directory) and runs it for the same install. When it pins this one's
# image, this installer runs again instead: a rerun completes an earlier update that stopped halfway.
update_installer() {
  command -v curl >/dev/null 2>&1 || die 'curl is needed to download the update.'
  if [ "$mode" = native ]; then
    [ -e "$native_home/app/current" ] ||
      die "No packaged seller in $native_home: run sh install.sh first (GYBLOS_HOME names another home)."
    pin=NATIVE_VERSION
    pinned=$NATIVE_VERSION
  else
    [ -f "$dir/compose.yaml" ] ||
      die "No installed seller in $dir: run sh install.sh first (GYBLOS_DIR names another directory)."
    pin=DEFAULT_IMAGE
    pinned=$DEFAULT_IMAGE
  fi
  work=$(mktemp -d)
  for file in install.sh install.sh.sha256 install.sh.sigstore.json; do
    curl -fsSL --proto '=https' --tlsv1.2 -o "$work/$file" "$RELEASE_DOWNLOAD/$file" ||
      die "Could not download $file from the latest release; try again later."
  done
  verify_installer
  latest=$(sed -n "s/^$pin=//p" "$work/install.sh")
  [ -n "$latest" ] || die 'The downloaded installer names no release for this install; nothing was changed.'
  if [ "$latest" = "$pinned" ]; then
    say "This installer already pins the latest release ($pinned); running it again to apply it."
    install
    return
  fi
  say "Updating to $latest"
  # Renamed into place, never rewritten: this shell is still reading the old file.
  destination=$dir/install.sh
  if [ -f "$0" ] && [ -w "$0" ] && [ ! -L "$0" ]; then
    destination=$0
  fi
  cp "$work/install.sh" "$destination.update.$$"
  mv -f "$destination.update.$$" "$destination"
  GYBLOS_MODE=$mode GYBLOS_DIR=$docker_dir GYBLOS_HOME=$native_home sh "$destination"
}

# The packaged seller for this machine: its target and the checksum this installer pins for it.
native_target() {
  system=$(uname -s)
  machine=$(uname -m)
  # A Terminal under Rosetta reports x86_64 on Apple Silicon.
  if [ "$system-$machine" = Darwin-x86_64 ] &&
    [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then
    machine=arm64
  fi
  case "$system-$machine" in
    Darwin-arm64) target=darwin-arm64 sha=$NATIVE_SHA256_DARWIN_ARM64 ;;
    Linux-x86_64 | Linux-amd64) target=linux-x64 sha=$NATIVE_SHA256_LINUX_X64 ;;
    Linux-aarch64 | Linux-arm64) target=linux-arm64 sha=$NATIVE_SHA256_LINUX_ARM64 ;;
    Darwin-x86_64) die 'Intel Macs install the seller with Docker: install Docker Desktop and run this again.' ;;
    *) die "There is no packaged seller for $system $machine: install Docker and run this again." ;;
  esac
  if [ "$system" = Linux ] && ldd --version 2>&1 | grep -qi musl; then
    die 'The packaged seller needs glibc; on musl (Alpine) install Docker and run this again.'
  fi
  [ -n "$NATIVE_VERSION" ] && [ -n "$sha" ] ||
    die 'This installer has no packaged seller (only a release installer does): install Docker, or download https://gyblos.com/install.sh.'
}

# Downloads, checks and unpacks this release's packaged seller beside earlier ones. It is unpacked on the
# same file system and renamed into place with a marker, so an interrupted run never leaves a release a
# rerun would trust; a rerun downloads it again.
install_native() {
  command -v curl >/dev/null 2>&1 || die 'curl is needed to download the seller.'
  app=$native_home/app
  name=gyblos-$NATIVE_VERSION-$target
  mkdir -p "$app"
  if [ ! -f "$app/$name/.complete" ]; then
    work=$(mktemp -d)
    say "Downloading the Gyblos seller $NATIVE_VERSION for $target…"
    for file in "$name.tar.gz" "$name.tar.gz.sigstore.json"; do
      curl -fsSL --proto '=https' --tlsv1.2 -o "$work/$file" "$RELEASE_TAGS/v$NATIVE_VERSION/$file" ||
        die "Could not download $file; try again later."
    done
    [ "$(sha256_of "$work/$name.tar.gz")" = "$sha" ] ||
      die 'The downloaded seller does not match the checksum this installer pins; nothing was changed.'
    verify_signature "$work/$name.tar.gz" seller
    unpack=$(mktemp -d "$app/.unpack.XXXXXX")
    tar -xzf "$work/$name.tar.gz" -C "$unpack" "$name"
    [ -x "$unpack/$name/bin/gyblos" ] || die 'The downloaded seller has no bin/gyblos; nothing was changed.'
    : >"$unpack/$name/.complete"
    rm -rf "${app:?}/$name"
    mv "$unpack/$name" "$app/$name"
    rm -rf "$unpack"
    unpack=
  fi
  gyblos=$app/$name/bin/gyblos
}

# Once the release passed doctor: points app/current at it, links ~/.local/bin/gyblos and keeps only the
# release it replaced, for rollback.
switch_native() {
  previous=
  [ ! -L "$app/current" ] || previous=$(readlink "$app/current")
  ln -sfn "$name" "$app/current"
  # Rerunning the same release keeps everything: the release it replaced earlier is still the rollback.
  if [ "$previous" != "$name" ]; then
    for old in "$app"/gyblos-*; do
      case "${old##*/}" in
        "$name" | "$previous" | 'gyblos-*') ;;
        *) rm -rf "$old" ;;
      esac
    done
  fi
  mkdir -p "$bin_dir"
  ln -sfn "$app/current/bin/gyblos" "$bin_dir/gyblos"
  say "Installed the Gyblos seller $NATIVE_VERSION as $bin_dir/gyblos"
}

# The machine's own Ollama must answer; this script never installs it.
check_ollama() {
  if curl -fsS --max-time 5 "$NATIVE_OLLAMA/api/version" >/dev/null 2>&1; then
    return
  fi
  say 'The seller serves its model with Ollama, which is not running here (http://127.0.0.1:11434).'
  if [ "$target" = darwin-arm64 ]; then
    say '  Install the Ollama app from https://ollama.com/download and open it (or: brew install ollama && ollama serve).'
  else
    say '  Install Ollama with the official instructions at https://ollama.com/download/linux and start it.'
  fi
  die 'Run this script again once Ollama is running; it continues where it stopped.'
}

pull_model() {
  say "Pulling $MODEL into Ollama…"
  if command -v ollama >/dev/null 2>&1; then
    OLLAMA_HOST=127.0.0.1:11434 ollama pull "$MODEL"
  else
    curl -fsS --proto '=http' -X POST "$NATIVE_OLLAMA/api/pull" \
      -d "{\"model\":\"$MODEL\",\"stream\":false}" >/dev/null ||
      die "Ollama could not pull $MODEL; run: ollama pull $MODEL"
  fi
}

# The packaged seller's gyblos.toml: examples/seller-docker.toml's offer on the machine's own Ollama.
write_native_config() {
  refuse_symlink gyblos.toml
  if [ -e gyblos.toml ]; then
    say "Kept existing $dir/gyblos.toml"
    return
  fi
  install_file gyblos.toml 644 <<'TOML'
# The packaged seller: the pinned Qwen3 0.6B with reasoning off on this machine's Ollama, given away free
# within daily token caps. To charge, give an offer `price = {...}` instead of `free`
# (docs/configuration.md) and fund the fee payer `gyblos doctor` prints with devnet SOL.

version = 1

[node]
network = "devnet"

[discovery]
# Off so a test node is not listed by accident; set publish = true to appear in discovery.
publish = false

# Optional capacity limits; omitted keys keep these defaults (docs/configuration.md#seller-limits).
# [limits]
# max_connections = 8
# requests_per_minute = 30

[[offers]]
model = "qwen3:0.6b"
reasoning = ["off"]
engine = { kind = "ollama", url = "http://127.0.0.1:11434/" }
free = { daily_token_cap = 200000, per_buyer_cap = 50000 }
TOML
  say "Wrote $dir/gyblos.toml"
}

# Runs the packaged seller with seller.env's variables, as its service does.
with_seller_env() {
  (
    set -a
    [ ! -f seller.env ] || . ./seller.env
    set +a
    exec "$@"
  )
}

restart_service() {
  if [ "$target" = darwin-arm64 ]; then
    launchctl kickstart -k "gui/$(id -u)/com.gyblos.seller"
  else
    systemctl --user restart gyblos-seller.service
  fi
}

main_native() {
  trap cleanup EXIT
  trap 'exit 130' INT TERM HUP
  native_target
  if [ ! -d "$dir" ]; then
    mkdir -p "$dir"
    chmod 700 "$dir"
  fi
  cd "$dir"
  install_native
  write_native_config
  write_environment
  check_ollama
  pull_model
  say 'Creating the seller keys (kept if they exist)…'
  "$gyblos" setup --role seller --mint "$MINT" >/dev/null
  "$gyblos" tokenizer
  ready=1
  doctor=$(with_seller_env "$gyblos" doctor 2>&1) || ready=
  printf '%s\n' "$doctor"
  [ -n "$ready" ] ||
    die "The seller is not ready; fix the failures above, then run this script again."
  owner=$(printf '%s\n' "$doctor" | sed -n 's/^  owner  *\([1-9A-HJ-NP-Za-km-z]\{32,44\}\)[[:space:]]*$/\1/p' | sed -n 1p)
  switch_native
  # Reinstalled so a rerun or an update runs this release with the current gyblos.toml and seller.env;
  # removing the service stops the seller first (it withdraws within 120 s). It runs app/current.
  seller_cli seller service uninstall >/dev/null 2>&1 || true
  seller_cli seller service install ||
    die 'The background service could not be installed; fix what it says, then run this script again.'
  say ''
  say "The seller is running as a background service. Its home is $dir."
  say "  $(seller_typed 'seller status')   is it serving?"
  if [ "$target" = darwin-arm64 ]; then
    say "  tail -f $(quoted "$dir/service.log")   follow it"
  else
    say '  journalctl --user -u gyblos-seller -f   follow it'
  fi
  say "  $(seller_typed 'seller service uninstall')   stop it and remove the service"
  say "  $(publish_command update)   update it to the latest release"
  case ":$PATH:" in
    *":$bin_dir:"*) ;;
    *) say "Add $bin_dir to your PATH to type gyblos: export PATH=\"$bin_dir:\$PATH\"" ;;
  esac
  if publishing; then
    say 'Publishing is on. Check that the index lists it:'
    say "  $(seller_typed 'seller status --online')"
  elif ! guided_setup; then
    next_steps
  fi
}

# An existing install's mode; for a new one Docker when it runs, otherwise the packaged seller.
choose_mode() {
  if [ -z "$mode" ]; then
    if [ -f "$dir/compose.yaml" ]; then
      mode=docker
    elif [ -d "$native_home/app" ]; then
      # Also a packaged install that stopped before its first start (for Ollama, say).
      mode=native
    elif [ -z "$NATIVE_VERSION" ]; then
      # The repository's copy has no packaged seller: Docker, which says what is missing.
      mode=docker
    elif command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
      mode=docker
      [ "$(uname -s)-$(uname -m)" != Darwin-arm64 ] ||
        say 'Note: Docker on a Mac cannot use its GPU. GYBLOS_MODE=native sh install.sh installs the packaged seller on this Mac'\''s own Ollama instead.'
    else
      mode=native
      ! command -v docker >/dev/null 2>&1 ||
        say 'Docker is installed but not usable by this account (not running, or no permission), so this installs the packaged seller. GYBLOS_MODE=docker sh install.sh uses Docker instead.'
    fi
  fi
  [ "$mode" = docker ] || {
    case "$native_home" in
      /*) ;;
      *) die 'GYBLOS_HOME must be an absolute path.' ;;
    esac
    dir=$native_home
    # publish, unpublish and update need the platform to restart the service.
    native_target
  }
}

install() {
  if [ "$mode" = native ]; then main_native; else main; fi
}

main() {
  trap cleanup EXIT
  trap 'exit 130' INT TERM HUP
  check_docker
  check_image
  if [ ! -d "$dir" ]; then
    mkdir -p "$dir"
    chmod 700 "$dir"
  fi
  cd "$dir"
  write_compose
  write_config
  write_environment

  verify_image
  say 'Pulling images…'
  docker compose pull
  docker compose up -d ollama
  wait_for_ollama
  say "Pulling $MODEL into Ollama…"
  docker compose exec -T ollama ollama pull "$MODEL"
  say 'Creating the seller keys (kept if they exist)…'
  # Quiet: doctor below prints the NodeId and owner to share.
  docker compose run --rm seller setup --role seller --mint "$MINT" >/dev/null
  docker compose run --rm seller tokenizer
  # Kept to read the public owner for the next steps; doctor never prints a secret.
  ready=1
  doctor=$(docker compose run --rm seller gyblos doctor 2>&1) || ready=
  printf '%s\n' "$doctor"
  [ -n "$ready" ] ||
    die "The seller is not ready; fix the failures above, then run this script again (cd $dir)."
  owner=$(printf '%s\n' "$doctor" | sed -n 's/^  owner  *\([1-9A-HJ-NP-Za-km-z]\{32,44\}\)[[:space:]]*$/\1/p' | sed -n 1p)
  # Recreated so a rerun applies the current gyblos.toml and seller.env; stopping sends SIGINT.
  docker compose up -d --force-recreate seller
  say ''
  say "The seller is running. In $dir:"
  say '  docker compose exec seller gyblos seller status   is it serving?'
  say '  docker compose logs -f seller        follow it'
  say '  docker compose stop seller           stop it (withdraws within 120 s)'
  say '  docker compose up -d --force-recreate seller   apply an edited gyblos.toml'
  say "  $(publish_command update)   update it to the latest release"
  say 'Its keys are in the gyblos volume: `docker compose down -v` deletes them.'
  if publishing; then
    say 'Publishing is on. Check that the index lists it:'
    say '  docker compose exec seller gyblos seller status --online'
  elif ! guided_setup; then
    next_steps
  fi
}

case "${1:-}" in
  '')
    choose_mode
    install
    ;;
  publish | unpublish)
    [ "$#" -eq 1 ] || die "Usage: sh install.sh [publish|unpublish|update]"
    choose_mode
    trap cleanup EXIT
    trap 'exit 130' INT TERM HUP
    if [ "$1" = publish ]; then set_publish true; else set_publish false; fi
    ;;
  update)
    [ "$#" -eq 1 ] || die "Usage: sh install.sh [publish|unpublish|update]"
    choose_mode
    trap cleanup EXIT
    trap 'exit 130' INT TERM HUP
    update_installer
    ;;
  *) die "Unknown command '$1'. Usage: sh install.sh [publish|unpublish|update]" ;;
esac
