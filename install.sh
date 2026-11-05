#!/bin/sh
# Installs a Gyblos seller with Docker: the published node image and its own loopback Ollama
# (docs/running-a-node.md#install-script). Needs only Docker with Compose v2.17 or later; no port is opened.
#
#   sh install.sh
#
# Environment (all optional):
#   GYBLOS_DIR          where compose.yaml, gyblos.toml and seller.env go (default: ~/gyblos-seller)
#   GYBLOS_IMAGE        node image (default below)
#   GYBLOS_RELAY_TOKEN  the relay token; asked for without echo when unset
#
# Existing gyblos.toml, seller.env and compose.yaml are kept; rerunning resumes a failed install and
# restarts the seller with the current gyblos.toml.
# The relay token is written only to seller.env (mode 0600) and never printed.
set -eu
# Byte-wise character classes: [:graph:] is then exactly the printable ASCII seller.env accepts.
LC_ALL=C
export LC_ALL

DEFAULT_IMAGE=ghcr.io/gyblos/seller:beta
# Devnet USDC (packages/config/src/network.ts DEVNET_USDC).
MINT=4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU
# The model the default offer serves (examples/seller-docker.toml).
MODEL=qwen3:0.6b
COMPOSE_MAJOR=2
COMPOSE_MINOR=17
OLLAMA_WAIT_SECONDS=60
OLLAMA_POLL_SECONDS=2
# packages/transport-iroh/src/constants.ts RELAY_TOKEN_LENGTH.
RELAY_TOKEN_MIN=32
RELAY_TOKEN_MAX=512

dir=${GYBLOS_DIR:-$HOME/gyblos-seller}
image=${GYBLOS_IMAGE:-$DEFAULT_IMAGE}

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
  [ -z "${tmp:-}" ] || rm -f "$tmp"
  [ -z "${prompting:-}" ] || stty echo </dev/tty 2>/dev/null || true
}

# The same compose.yaml as the repository's, with the published image instead of a local build.
write_compose() {
  refuse_symlink compose.yaml
  if [ -e compose.yaml ]; then
    say "Kept existing $dir/compose.yaml"
    [ -z "${GYBLOS_IMAGE:-}" ] || say "  GYBLOS_IMAGE is not applied to it; change its seller image there."
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
# Paid offers are refused at startup until paid selling returns (docs/configuration.md).

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
free = { daily_token_cap = 200000, per_buyer_cap = 5000 }
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
    printf 'Relay token (from your Gyblos invitation; not shown): ' >/dev/tty
    prompting=1
    stty -echo </dev/tty
    IFS= read -r token </dev/tty || token=
    stty echo </dev/tty
    prompting=
    printf '\n' >/dev/tty
  fi
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

  say 'Pulling images…'
  docker compose pull
  docker compose up -d ollama
  wait_for_ollama
  say "Pulling $MODEL into Ollama…"
  docker compose exec -T ollama ollama pull "$MODEL"
  say 'Creating the seller keys (kept if they exist)…'
  docker compose run --rm seller setup --role seller --mint "$MINT"
  docker compose run --rm seller tokenizer
  if ! docker compose run --rm seller gyblos doctor; then
    die "The seller is not ready; fix the failures above, then run this script again (cd $dir)."
  fi
  # Recreated so a rerun applies the current gyblos.toml and seller.env; stopping sends SIGINT.
  docker compose up -d --force-recreate seller
  say ''
  say "The seller is running. In $dir:"
  say '  docker compose exec seller gyblos seller status   is it serving?'
  say '  docker compose logs -f seller        follow it'
  say '  docker compose stop seller           stop it (withdraws within 120 s)'
  say '  docker compose up -d --force-recreate seller   apply an edited gyblos.toml'
  say '  docker compose pull && docker compose up -d   update it'
  say 'Its keys are in the gyblos volume: `docker compose down -v` deletes them.'
}

main "$@"
