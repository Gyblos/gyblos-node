# Running a seller and a buyer

For the invited free Docker seller, use the bilingual
[public seller handbook](https://docs.gyblos.com/en/sellers/beta-guide),
[CLI reference](https://docs.gyblos.com/en/reference/cli),
[configuration reference](https://docs.gyblos.com/en/reference/configuration)
and [troubleshooting](https://docs.gyblos.com/en/help/troubleshooting). Their
canonical source is `apps/docs/content/docs/`. This engineering document also
covers checkout, library and experimental paths; those paths are not
interchangeable with the invitation's Docker onboarding.

A seller node serves paid inference over Iroh. A buyer proxy on another machine
forwards local requests to it. Both are devnet-only and experimental.

## Local home

All node data lives under one local home, `GYBLOS_HOME` (default `.local/gyblos`
in the working directory; the seller image uses `/data`, and the packaged
release `~/.gyblos`, where it also reads `gyblos.toml`). Each role has its own
directory, so one machine can hold a buyer and a seller side by side without
sharing keys or journals:

| Path                              | Contents                                                    |
| --------------------------------- | ----------------------------------------------------------- |
| `<home>/buyer/`                   | Buyer keys, role, trust, offer copy, journals, lock, calls. |
| `<home>/seller/`                  | Seller keys, role, status, readiness, public sequence.      |
| `<home>/artifacts/tokenizer/`     | Pinned public tokenizer (re-downloadable).                  |
| `<home>/artifacts/ollama-models/` | Lab-only cache of the pinned model for the `gate:*` Ollama. |

Lab state (`gate:*`, identity tools) lives in a separate `GYBLOS_LAB_HOME`
(default `.local/lab`). The lab shares `<home>/artifacts/` as a public cache
(`gate:inference:setup` may write the tokenizer and model there) but never reads
or writes a role directory.

Keep a custom `GYBLOS_HOME` or `GYBLOS_LAB_HOME` outside the repository or under
`.local/`; only `.local/` is ignored by git.

### Moving data from the old layout

Older versions kept role data in `.local/p2p/` (one role per checkout), the
tokenizer in `.local/devnet/tokenizer/`, models in `.local/ollama/models/` and
lab state in `.local/devnet/`. Nothing is migrated automatically. When a home
directory is missing but its old path exists, setup and startup stop with
`LEGACY_LOCAL_LAYOUT`, naming both paths. For the lab the test is lab state, not
the directory: an empty or lock-only `.local/lab` does not count, so every lab
command keeps refusing until the old lab files are moved. A fresh role next to
an old, possibly uncertain authorization journal could otherwise lose recovery
state ([recovery.md](recovery.md)). The check only tests whether the old path
exists (it never reads it) and applies whether or not `GYBLOS_HOME` is set,
because an old journal in the working directory is just as unsafe to ignore when
the new home is elsewhere.

Before you move anything:

- Stop every node, buyer and lab (`gate:*`) process.
- Never merge into an existing destination: `mv` would put the old directory
  inside it, hiding its journal one level down. If a destination already exists,
  stop and compare the two directories by hand. An empty one can be removed with
  `rmdir`, which refuses a non-empty directory.
- Run the commands from the same working directory. `ls .local/p2p` shows
  `buyer.json` for a buyer or `owner.json` for a seller.

Run this block after choosing the role destination (`buyer` below, or `seller`).
It uses `GYBLOS_HOME` and `GYBLOS_LAB_HOME` when set, stops on the first
failure, and runs in a subshell so failure does not close your terminal.
Existing destinations, including dangling symlinks, are refused. Omit moves
whose source never existed.

The lab config records absolute key paths. After moving it, the block rewrites
only keys directly inside the old lab directory to the actual new directory. It
preserves the original config exclusively as `config.json.bak` and stages the
replacement before renaming it. Unexpected key paths require manual review; no
keys or journals are read or rewritten.

```sh
(
  umask 077
  product_home=${GYBLOS_HOME:-.local/gyblos}
  lab_home=${GYBLOS_LAB_HOME:-.local/lab}
  move() {
    if [ -e "$2" ] || [ -L "$2" ]; then
      echo "stop: destination exists; compare by hand" >&2
      return 1
    fi
    mkdir -p "$(dirname "$2")" && mv "$1" "$2"
  }
  move .local/p2p "$product_home/buyer" || exit 1  # seller checkout: use seller
  move .local/devnet/tokenizer "$product_home/artifacts/tokenizer" || exit 1
  move .local/ollama/models "$product_home/artifacts/ollama-models" || exit 1
  move .local/devnet "$lab_home" || exit 1
  node --input-type=module - "$lab_home/config.json" <<'NODE' || exit 1
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
try {
  const file = resolve(process.argv[2]);
  const original = readFileSync(file, 'utf8');
  const config = JSON.parse(original);
  for (const [role, path] of Object.entries(config.keys)) {
    if (typeof path !== 'string' || !isAbsolute(path) ||
        dirname(path) !== resolve('.local/devnet')) throw new Error();
    config.keys[role] = resolve(dirname(file), basename(path));
  }
  writeFileSync(file + '.bak', original, { flag: 'wx', mode: 0o600 });
  writeFileSync(file + '.migrating', JSON.stringify(config, null, 2) + '\n',
    { flag: 'wx', mode: 0o600 });
  renameSync(file + '.migrating', file);
} catch {
  console.error('stop: review the moved config and any backup manually');
  process.exitCode = 1;
}
NODE
  if [ -e .local/identity/keys ] || [ -L .local/identity/keys ]; then
    move .local/identity/keys "$lab_home/identity/keys" || exit 1
  fi
)
```

Review the moved `config.json` and its key paths before restarting anything,
then delete `config.json.bak`: the old copy may hold an RPC URL with an API key.
After any failure, inspect the source and destination and resume only the
remaining moves; do not repeat the whole block blindly. An incomplete config
rewrite leaves the moved config and original backup for manual recovery.
`.local/identity-validator/` is disposable test scratch and is not checked.

## Roles and files

`pnpm node:setup --role` creates the role directory, the role file, the Iroh
node key (`node.key`) and the role's Solana keys with private permissions. It
never overwrites existing keys; a mismatched existing role stops with an error.
A seller needs only `--mint`: it gets an owner key, a node key and the payment
keys (authorizer and facilitator, the fee payer), with `payTo` set to the owner,
so any offer can be free or priced. Running setup again on a seller created
without payment keys (earlier releases) adds them, keeping its NodeId, owner and
registration; the installer does this on every run. Existing roles with a
different payout are preserved and receive a warning at registration. `--buyer`
and `--pay-to` are no longer used and are refused. A seller `role.json` with
payment fields also keeps `buyer` (the owner, unused) so that an earlier image
still loads it; the `buyer` field is ignored. Running an earlier `install.sh`
after the upgrade is not supported.

| File                                             | Role   | Contents                                                                                                               |
| ------------------------------------------------ | ------ | ---------------------------------------------------------------------------------------------------------------------- |
| `role.json`                                      | both   | Role, mint, NodeId and public addresses.                                                                               |
| `node.key`                                       | both   | Iroh secret key (private).                                                                                             |
| `*.json` keys                                    | both   | Buyer key, or seller owner, authorizer and fee payer (facilitator) keys.                                               |
| `offer.json`                                     | buyer  | A paid v1 seller's signed offer (lab gates only).                                                                      |
| `trust.json`                                     | buyer  | Which seller and limits the buyer accepts.                                                                             |
| `status.json`                                    | both   | `starting` with a phase, then `ready`; a seller lists each offer's index, model, engine kind and whether it is listed. |
| `engine-readiness.json`                          | seller | Each offer's latest private warmup outcome, by index.                                                                  |
| `authorization.json`, `calls.json`, `buyer.lock` | buyer  | Payment journal, call history, lock.                                                                                   |

## Seller

```sh
export GYBLOS_RELAY_TOKEN=...    # private; 32-512 printable characters
pnpm node:setup --role seller --mint MINT
pnpm node:tokenizer              # pinned tokenizer; doctor reports NOT_NEEDED when every offer's usage is declared
# A dedicated Ollama, used only for selling, on loopback; leave it running in its own terminal:
OLLAMA_HOST=127.0.0.1:11435 OLLAMA_MODELS=$HOME/.gyblos-ollama OLLAMA_NO_CLOUD=1 OLLAMA_NUM_PARALLEL=1 OLLAMA_MAX_LOADED_MODELS=1 ollama serve
OLLAMA_HOST=127.0.0.1:11435 ollama pull qwen3:0.6b   # the pinned model
pnpm gyblos seller init         # asks for the engine, model and free caps; writes gyblos.toml
pnpm gyblos doctor               # read-only preflight; prints the public NodeId and owner
pnpm node:start
```

- `pnpm gyblos seller init` writes a `gyblos.toml` with one free devnet offer:
  it asks for the engine (`ollama`, `openai` or `anthropic`), its URL (default
  the dedicated Ollama above), the model and the daily caps, and whether to list
  the seller in discovery (default no). Without a terminal it takes flags and
  defaults (`--engine`, `--url`, `--model`, `--upstream-model`,
  `--context-tokens`, `--api-key-env <NAME>|none`, `--daily-cap`,
  `--per-buyer-cap`, `--publish` or `--no-publish`). It writes `GYBLOS_CONFIG`
  or `./gyblos.toml` (mode 0600, since an engine URL may carry a key in its
  path), replaces an existing file only with `--force`, never writes through a
  symlink, and writes nothing when the file format or startup's offer rules
  would refuse the values (for Ollama, only the pinned `qwen3:0.6b` at a literal
  loopback address). It handles no secret: API keys and the relay token stay in
  the environment or `seller.env`, and it prints only their variable names.
  `examples/seller-daemon.toml` is an equivalent file to copy instead.
- The seller serves configured free and paid offers in `gyblos.toml`; it needs
  at least one offer to start (`SELLER_OFFERS_MISSING`). A paid offer
  (`price = {...}` instead of `free`) is sold on devnet over the paid stream.
  The fee payer key (`fee payer` in `gyblos doctor`'s identity) needs devnet SOL
  for transaction fees, channel rent and, once, the rent of any missing payout,
  fee, fee payer or buyer token account, which the seller creates so that no
  claim is redirected to the payment program
  ([Seller startup](configuration.md#seller-startup)). Paid v2 has settled on
  devnet only in a controlled run; the v1 paid path remains in the lab gates
  only.
- The seller runs its own Ollama; the daemon never starts it. Startup warms each
  offer in order at its own engine URL (a literal loopback address), checking
  memory headroom for engines on this machine, and signs its public records once
  one offer is ready; the others are warmed again in the background and listed
  when they are ready.
- Use a dedicated Ollama for selling, with its own models directory
  (`OLLAMA_MODELS`) so the Ollama app cannot remove or replace the model. A
  shared one (the Ollama app, or other tools using the same instance) can evict
  the pinned model or slow it down, which shows up to buyers as `ENGINE_TIMEOUT`
  or a withdrawn offer. Never expose it to the network (`OLLAMA_HOST=0.0.0.0` or
  the app's "Expose Ollama to the network" setting): Ollama has no
  authentication, and anyone who can reach it could replace or delete the model.
  The seller trusts whatever answers on the offer URL, so run it on a machine
  where only you can bind local ports.
- `gyblos doctor` reports `ENGINE_UNAVAILABLE` both when Ollama is stopped and
  when the pulled model's digest differs from the pinned one; `ollama list` must
  show ID `7df6b6e09427` for `qwen3:0.6b`.
- The `gyblos/control/1` ALPN serves signed catalog, presence and quote queries;
  the free channels serve execution. Stop with Ctrl-C (not Ctrl-Z, which only
  suspends the process). Stopping withdraws from discovery and saves the public
  sequence; further Ctrl-C presses during that stop are ignored with a notice
  (SIGTERM from a supervisor too), so wait for the prompt. If a stop ever hangs,
  Ctrl-\\ (SIGQUIT) still ends the process, but can interrupt withdrawal or a
  state write and leave a sequence lock. A hung write or sync may itself be why
  shutdown has stalled; the order of cleanup does not make forced termination
  safe. A Ctrl-C during startup, a crash or `kill -9` can also leave a lock. Use
  `pnpm gyblos doctor` and the guarded
  [sequence recovery procedure](discovery.md#seller-duties); never reset the
  persisted sequence high-water mark.

### Running the seller as a service

Once `pnpm gyblos doctor` reports `READY`, the seller can run in the background
and restart with the machine. Run these as the account that owns the seller home
and keys, never as root:

```sh
(umask 077; printf 'GYBLOS_RELAY_TOKEN=%s\n' "$GYBLOS_RELAY_TOKEN" > "${GYBLOS_HOME:-.local/gyblos}/seller.env")
pnpm gyblos seller service install --dry-run   # prints the unit; changes nothing
pnpm gyblos seller service install             # writes and starts it
pnpm gyblos seller service uninstall           # stops and removes it
```

- The service sees only `<home>/seller.env`, plus `GYBLOS_HOME` and
  `GYBLOS_CONFIG` resolved to absolute paths from the directory where you run
  `install`. Install first runs the offline doctor with exactly that environment
  and writes nothing when it is not `READY`, so a token exported only in your
  shell is reported as missing.
- `seller.env` holds the relay token and any `api_key_env` variables: a regular
  file you own, mode 0600, not a symlink. Each line is `NAME=value` with no
  spaces, quotes, `$`, backticks, backslashes, `#`, `~` or shell operators in
  the value, because systemd and the macOS agent read only that form alike. It
  may not set `GYBLOS_HOME`, `GYBLOS_CONFIG`, `PATH`, `HOME`, shell variables
  (`UID`, `IFS`, `BASH*` and the like) or `NODE_*`, `LD_*`, `DYLD_*`, `TSX_*`,
  `OPENSSL_*` variables, and no line, comment included, may contain a backslash
  or carriage return.
- Linux: a systemd user unit (`~/.config/systemd/user/gyblos-seller.service`).
  It stops when you log out and does not start at boot unless lingering is on
  (`sudo loginctl enable-linger <account>`, once). On a server where the seller
  has its own account, enable lingering, then run the commands in a login shell
  of that account (`sudo -iu <account>`). The unit stops the seller with SIGINT
  and waits 120 s for withdrawal, restarts it on failure but gives up after 5
  failed starts in 10 minutes (`systemctl --user reset-failed gyblos-seller`
  clears that once fixed), and sets `MemoryMax` (`--memory`, default and minimum
  `2048M`, the 1.5 GiB startup headroom plus the seller itself) and `CPUQuota`
  (`--cpu`, default `100%`). Logs: `journalctl --user -u gyblos-seller`.
- macOS: a launch agent (`~/Library/LaunchAgents/com.gyblos.seller.plist`) that
  runs while you are logged in and logs to `<home>/service.log`. launchd has no
  memory or CPU limit; the startup headroom check still applies.
- Windows (packaged release only, from `install.ps1` or npm): a scheduled task
  `Gyblos\Seller-<id>` of your account (its XML and the script it runs are kept
  in `%LOCALAPPDATA%\Gyblos`) that starts at your logon, with least privilege
  and no window (`conhost --headless`), and runs `gyblos service-run`. That
  supervisor loads `seller.env` (Notepad's CRLF lines are accepted; names are
  reserved whatever their case, also `SystemRoot`, `ComSpec`, `PATHEXT`,
  `USERPROFILE` and `PSModulePath`), appends the seller's output to
  `<home>/service.log`, restarts it on failure with the same 5-in-10-minutes
  limit and, on uninstall, stops it like a first Ctrl-C through its named pipe
  before removing the task. It stops when you log out. Windows has no
  per-service memory or CPU limit; the startup headroom check still applies.
- The engine is not part of the service: run Ollama as its own service (its
  Linux installer creates one) on the offer URL.
- Installing again refuses while a unit exists; uninstall first. The unit runs
  this checkout with the Node that ran `install`, so reinstall after moving
  either.

### Seller registration (beta invite)

In the beta the discovery index lists only sellers admitted with a one-use
invite ([discovery-index.md](discovery-index.md#beta-registration-invites)):

```sh
pnpm gyblos seller register   # asks for the invite on a terminal, or reads GYBLOS_INVITE
```

In the seller image, from the compose directory:
`docker compose exec seller gyblos seller register`.

- It first sends the index only the invite and this home's NodeId, at the
  `discovery.url` node:start would publish to. If the index accepts the invite
  but the NodeId lacks an 8004 registration, an interactive terminal offers to
  register it on Solana devnet. The owner wallet pays; the command shows the
  estimated SOL cost and asks for consent before signing and submitting. Fund
  the owner wallet first; no automatic faucet is used. A funding estimate and
  missing SOL are available before simulation. The estimate uses pinned account
  layouts and the published Core create fee; upgradeable programs may change the
  actual cost. Simulation remains mandatory before signing, and the final
  estimate is never lower than the preliminary one.
- The asset key and signed attempt are stored privately in the seller home. Keep
  this state if a result is uncertain. Running the command again checks the
  saved attempt and may resend the identical signed transaction; it does not
  make another asset while that attempt is unresolved. Checking a saved attempt
  has its own bounded 30-second budget to accommodate slower RPC responses.
  Before resending it verifies both signatures, the owner, asset, NodeId and
  canonical instructions. When the saved blockhash is invalid in a finalized
  view and all three asset accounts are absent in a sufficiently recent view, it
  can rebuild with the same asset after fresh consent. Expiry does not prove the
  previous transaction never landed or incurred a fee. Inconclusive or partial
  state still requires operator assistance; never delete it. A verified
  registration under another asset of the same owner and NodeId is accepted.
  This devnet flow does not enable mainnet. The 8004 wallet is the owner;
  existing paid seller roles may still use a different payout address until
  wallet unification is completed.
- `Registered` or `Already registered` (a retry with the same invite) means the
  seller may now publish; set `publish = true` under `[discovery]` to be listed.
- Before asking for the invite it checks this home's seller role
  (`SELLER_ROLE_MISSING`, `SELLER_ROLE_UNREADABLE`, `SELLER_ROLE_NOT_SELLER`)
  and that node:start would accept the configuration and `discovery.url`
  (`REGISTER_CONFIG_INVALID`). It takes no flags, so the invite never goes on
  the command line: without `GYBLOS_INVITE` or a terminal it stops with
  `REGISTER_NO_INVITE`, and a malformed code with `REGISTER_INVITE_FORMAT`.
- It prints the index's origin before sending. The index's refusals are static
  codes with a hint: `DISCOVERY_INVITE_INVALID` (wrong, spent or expired: ask
  Gyblos for a new invite), `DISCOVERY_IDENTITY_NOT_REGISTERED` (not on chain
  yet), `DISCOVERY_NODE_REVOKED`, `DISCOVERY_RATE_LIMITED`,
  `DISCOVERY_UNAVAILABLE`, `DISCOVERY_REGISTRATION_REJECTED` or a 404
  `DISCOVERY_HTTP_STATUS` when that index does not take registrations, and other
  network or index failures (try again later). The invite is never printed
  (though a terminal shows it as it is typed); registration state is private.

### Seller status

```sh
pnpm gyblos seller status            # read-only; same GYBLOS_HOME and gyblos.toml as node:start
pnpm gyblos seller status --online   # also looks this NodeId up in the discovery index
```

It prints the NodeId and owner, then:

- `service`: inside the seller image
  (`docker compose exec seller gyblos seller status`; the image sets
  `GYBLOS_CONTAINER=1`), `active (container)` while the daemon runs in that
  container, `inactive (container)` when it does not, or `unknown (container)`
  when the process list cannot be read. Use `exec`, not `run`:
  `docker compose run` starts a new container that cannot see the seller and
  reports it inactive. Otherwise `active` while the unit or agent
  `seller service install` wrote has a running process (for launchd,
  `launchctl print` must show `state = running`; a loaded agent that exited is
  `inactive`), `inactive`, `not installed`, or `unknown` as root or on other
  platforms;
- `daemon`: the last state the daemon wrote to `status.json` (`starting` with
  its phase, or `ready`) and when; a stopped daemon does not rewrite it;
- one `offer` line per offer: `serving` once it is in the signed catalog, else
  `not serving yet`;
- `discovery`: `off`, `on` with the index origin, or `configuration invalid`
  when node:start would refuse the file (an explicit `GYBLOS_CONFIG` must
  exist). With `--online` it pages the index for each served model, sending only
  the model, and says `listed in the index`, `not found in the index`, that it
  stopped after 2000 sellers, `index unreachable`, or that no offer was serving
  to look up;
- counts from the seller's signed receipts for the last 24 hours and 7 days
  (completed, failed, cancelled, output tokens, and the approximate output
  tokens per second of completed sales: time after the first token when
  streamed, the whole request otherwise), the last request time and failure
  codes. Receipts keep at most 256 records for 7 days, so busy sellers see a
  lower bound.

`Result: RUNNING` (exit 0) needs an active service and a ready daemon;
`STARTING`, `FAILING`, `STOPPED` and `NOT_CONFIRMED` (no service to confirm the
process) exit 1. `FAILING` means the last start failed, including while the
service restarts after it; status then names the phase, the static code and a
hint, such as `SELLER_RELAY_OFFLINE` when no relay answered (a refused relay
token or no network). It writes nothing and prints no buyer, prompt, key or home
location.

### Docker

`compose.yaml` runs a seller with its own Ollama. Only Docker (with Compose
v2.17 or later) is needed on the host; no port is published, because Iroh
connects outbound.

```sh
cp examples/seller-docker.toml gyblos.toml        # one free offer; edit the caps
(umask 077; printf 'GYBLOS_RELAY_TOKEN=%s\n' "$GYBLOS_RELAY_TOKEN" > seller.env)
docker compose up -d ollama
docker compose exec ollama ollama pull qwen3:0.6b # `ollama list` must show 7df6b6e09427
docker compose run --rm seller setup --role seller --mint MINT
docker compose run --rm seller tokenizer
docker compose run --rm seller gyblos doctor      # READY, and the public NodeId and owner
docker compose up -d                              # starts the seller
docker compose exec seller gyblos seller status   # RUNNING once it serves
docker compose logs -f seller
docker compose stop seller                        # SIGINT; withdraws within 120 s
```

- The image (`Dockerfile`) holds the node and the `gyblos` CLI, runs as the
  unprivileged `node` user and has no engine. Its commands are `start` (the
  default), `gyblos …`, `setup …` and `tokenizer`.
- **`docker compose down -v` deletes the `gyblos` volume, and with it the
  seller's keys and journals.** Back the volume up before removing it.
- Keys, journals, the public sequence and the tokenizer live in the `gyblos`
  volume (`/data`, mode 0700). `gyblos.toml` is mounted read-only at
  `/config/gyblos.toml` and must exist before the first `up` (compose refuses to
  create it). `seller.env` holds the relay token and any `api_key_env` variables
  (it is in `.gitignore`; keep it mode 0600).
- The Ollama engine accepts only a literal loopback URL, so the seller shares
  the Ollama container's network namespace (`network_mode: service:ollama`):
  Ollama listens on `127.0.0.1:11434` there and the example's offer points to
  it. Do not publish its port or set `OLLAMA_HOST=0.0.0.0`. A restarted Ollama
  container gets a new namespace: compose restarts the seller with it, but after
  Ollama restarts on its own (a crash), run `docker compose restart seller`.
- The seller runs with `init: true`, so a stop signal reaches it even during
  startup.
- The seller container has `mem_limit: 2g`, because startup needs 1.5 GiB of
  headroom in its own cgroup above the seller itself, and one CPU. Ollama's
  model memory is counted in its own container. The host needs cgroup v2 (any
  current Docker Desktop or Linux distribution), and startup also checks 1.5 GiB
  of available memory on the host or Docker Desktop VM.
- A remote engine (an OpenAI- or Anthropic-compatible URL) needs no Ollama
  service: point the offer at it, put its `api_key_env` variable in `seller.env`
  and remove `ollama` and `network_mode` from the compose file.
- Build the image yourself with `docker compose build`, or use the published one
  through the install script below.

#### Install script

`install.sh` sets up the same seller from a signed release of the published
image without a checkout. It needs only Docker with Compose v2.17 or later; on
macOS Apple Silicon and Linux (x64, arm64, glibc) without Docker it installs the
packaged seller instead (see [Without Docker](#without-docker)). Sellers
download it from the official address, which redirects to the copy attached to
the latest GitHub release
(`https://github.com/Gyblos/gyblos-node/releases/latest/download/install.sh`):

```sh
curl -fsSL https://gyblos.com/install.sh -o install.sh
sh install.sh
```

- It writes `compose.yaml` (this repository's, with the published image),
  `gyblos.toml` (`examples/seller-docker.toml`) and `seller.env` into
  `~/gyblos-seller` (created mode 0700; `GYBLOS_DIR` changes it), then pulls the
  images and the model, creates the seller keys, downloads the tokenizer, runs
  `gyblos doctor` and starts the seller only when doctor is READY.
- On a terminal, an unpublished seller then finishes onboarding, asking before
  each step: it runs `gyblos seller register` in the container (the command asks
  for the invite code, waits for the owner's devnet SOL when it is short and
  confirms before signing), then asks to publish and runs the `publish` step
  below. A failed or declined step prints how to continue; a rerun picks up
  where it stopped. Without a terminal (`GYBLOS_TERMINAL` names another answer
  source, for tests) or with `GYBLOS_GUIDED=0`, it prints the steps instead:
  fund the owner doctor printed with devnet SOL, `gyblos seller register` with
  the invite code, and `sh install.sh publish` (`gyblos seller status` names the
  next step while the seller runs).
- `gyblos seller register` on a terminal waits for SOL when the registration
  stops for want of it: it reads the owner's balance every 15 seconds, for up to
  30 minutes, then tries again (at most three waits). It never signs while
  waiting. Without a terminal it stops with the funding hint.
- `sh install.sh update` downloads the latest release's `install.sh`,
  `install.sh.sha256` and `install.sh.sigstore.json` with curl, checks the
  checksum and, with cosign, the release signature (required with
  `GYBLOS_REQUIRE_SIGNATURE=1`), renames the new installer over this one (when
  it is a writable file; otherwise to `install.sh` in the install directory) and
  runs it with the same `GYBLOS_DIR`. Cosign older than 3 cannot read the
  bundle, so the check is skipped (refused in strict mode). An installer pinning
  the same image runs this one again, which completes an update that stopped
  halfway.
- The release build sets `GYBLOS_VERSION` in the image. `gyblos seller status`
  then asks GitHub for the latest release (one bounded HTTPS request, nothing
  about the seller) and, when it is newer, ends with an `Update:` line;
  `GYBLOS_UPDATE_CHECK=0` turns it off, and a build without `GYBLOS_VERSION`
  checks nothing.
- `sh install.sh publish` (or `unpublish`) sets `publish` in the installed
  `gyblos.toml` (`GYBLOS_DIR` names a non-default install), validates it and
  recreates the seller; an invalid result or an interruption restores the file.
  It rewrites the file in place, so the container's bind mount keeps working.
- `DEFAULT_IMAGE` pins one release by version and digest
  (`ghcr.io/gyblos/seller:<version>@sha256:<digest>`). The release workflow
  below sets it in the copy it attaches to each release; the copy in this
  repository keeps an earlier pin. `GYBLOS_IMAGE` overrides it.
- The relay token is read without echo, or from `GYBLOS_RELAY_TOKEN`, and is
  written only to `seller.env` (mode 0600), never printed. Without a terminal
  (for example `ssh host sh install.sh`), set `GYBLOS_RELAY_TOKEN`.
- Rerunning it resumes a failed install and updates the seller: `gyblos.toml`,
  `seller.env` and `compose.yaml` are kept, except that a seller `image:` from
  `ghcr.io/gyblos/seller` moves to the installer's release. Any other image is
  the operator's own build and stays. It then recreates the seller with the
  current files; after editing `gyblos.toml`, rerun it or run
  `docker compose up -d --force-recreate seller` (a plain `up -d` does not apply
  the edit).

##### Image signature

Every release is built and signed keyless by the release workflow
(`.github/workflows/release-seller-image.yml`) with its GitHub OIDC identity;
there is no long-lived signing key, and each signature is recorded in the public
Sigstore log (with this repository and workflow name). With cosign 3 or later
installed, the installer verifies a `ghcr.io/gyblos/seller` image before pulling
(identity `RELEASE_IDENTITY`, issuer `RELEASE_ISSUER` in `install.sh`) and stops
on a bad signature; without cosign, or with an older one, it says the check was
skipped, and integrity rests on HTTPS and the digest the installer pins. The
check reads the seller image from `compose.yaml`; the installer names any
override file or `COMPOSE_FILE` it does not cover. With
`GYBLOS_REQUIRE_SIGNATURE=1` every one of those cases (no cosign, an older one,
a non-Gyblos image, an override file or `COMPOSE_FILE`) stops the installer
before anything is pulled instead. The default stays permissive because the
pinned digest already fixes the image bytes; strict mode matters most with
`GYBLOS_IMAGE` or a moving tag. By hand, the image:

```sh
cosign verify ghcr.io/gyblos/seller:<version>@sha256:<digest> \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity-regexp '^https://github\.com/Gyblos/gyblos-node/\.github/workflows/release-seller-image\.yml@refs/tags/v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$'
```

The installer attached to a release is signed by the same workflow; its Sigstore
bundle and SHA-256 are attached next to it. Name the release, so both files come
from the same one:

```sh
base=https://github.com/Gyblos/gyblos-node/releases/download/v<version>
curl -fsSL -O "$base/install.sh" -O "$base/install.sh.sigstore.json"
cosign verify-blob install.sh --bundle install.sh.sigstore.json \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity-regexp '^https://github\.com/Gyblos/gyblos-node/\.github/workflows/release-seller-image\.yml@refs/tags/v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$'
```

##### Without Docker

When Docker does not run for this account (it says so when Docker is installed
but not usable) or with `GYBLOS_MODE=native`, a release's `install.sh` installs
the packaged seller of the same release on macOS Apple Silicon or Linux (x64,
arm64, glibc). Intel Macs and musl Linux are told to use Docker, and Windows to
use [`install.ps1`](#windows). With Docker running, a new install uses Docker;
on Apple Silicon it notes that Docker cannot use the Mac's GPU, and
`GYBLOS_MODE=native sh install.sh` installs the packaged seller instead. An
existing install keeps its mode.

- It downloads `gyblos-<version>-<target>.tar.gz` and its `.sigstore.json` from
  the release, checks the SHA-256 the installer pins (`NATIVE_SHA256_<TARGET>`)
  and, with cosign, the release signature, then unpacks it into `~/.gyblos/app/`
  beside the previous release (on the same file system, marked complete, so an
  interrupted download is fetched again). Once doctor passes it points
  `app/current` at it and links `~/.local/bin/gyblos`; the release it replaced
  stays for rollback, also across reruns.
- It uses the machine's own Ollama at `127.0.0.1:11434` and never installs it:
  when Ollama does not answer it says how to install and start it (the Ollama
  app on a Mac) and stops; a rerun continues. It pulls the model with `ollama`.
- It writes `gyblos.toml` and `seller.env` into `~/.gyblos` (`GYBLOS_HOME`
  changes it), creates the keys, downloads the tokenizer, runs `gyblos doctor`
  with `seller.env` and installs the user service
  (`gyblos seller service install`: a launch agent on macOS, a systemd user unit
  on Linux), replacing an earlier one so a rerun or update runs the current
  release.
- Registering, `publish`, `unpublish` and `update` work as with Docker, with
  `gyblos` in place of `docker compose exec seller gyblos`; `publish` restarts
  the service. `update` compares the pinned `NATIVE_VERSION`.

##### Windows

A release's `install.ps1` installs the same release's packaged seller on Windows
10 (1803) or later, x64, from PowerShell:

```powershell
irm https://github.com/Gyblos/gyblos-node/releases/latest/download/install.ps1 -OutFile install.ps1
powershell -ExecutionPolicy Bypass -File install.ps1   # also: publish, unpublish, update
```

- It downloads `gyblos-<version>-win32-x64.tar.gz`, checks the SHA-256 the
  installer pins (`$NativeSha256`, set by `scripts/pin-installer-windows.sh` in
  the release) and, with cosign, the release signature, and unpacks it with
  Windows' own `tar` into `%LOCALAPPDATA%\Gyblos\app\` the same way as
  `install.sh`. Once doctor passes it points the `app\current` junction at it,
  writes `%LOCALAPPDATA%\Gyblos\bin\gyblos.cmd` and adds that folder to your
  user `PATH` (not with `GYBLOS_MODIFY_PATH=0`).
- The home is `%USERPROFILE%\.gyblos` (`GYBLOS_HOME`), created readable only by
  your account, SYSTEM and Administrators, which `gyblos setup` and doctor
  check. `gyblos.toml` and `seller.env` are written there once, as UTF-8 without
  a byte order mark.
- Ollama, the keys, the tokenizer, doctor, the service (the scheduled task
  above), registering and `publish` work as in
  [Without Docker](#without-docker). `update` downloads the latest
  `install.ps1`, checks its checksum (and signature, with cosign) and runs it.
  `GYBLOS_RELEASE_URL` changes where releases are downloaded from (a mirror);
  the pinned checksum still applies.

##### npm package

The same packaged sellers are published to npm, for anyone who already uses it:
`npm install -g gyblos` installs a small `gyblos` wrapper and, as an optional
dependency, only this machine's `@gyblos/seller-<target>` (macOS arm64, Linux
x64 and arm64 glibc, Windows x64). That package is the release archive, with its
own Node runtime, so the seller never runs on the user's Node; npm installs the
pinned iroh binding as its dependency. Then `gyblos seller init`,
`gyblos setup --role seller --mint <mint>`, `gyblos tokenizer`, `gyblos doctor`
and `gyblos seller service install`, with the machine's own Ollama as in
[Without Docker](#without-docker). `gyblos seller status` says to update with
`npm install -g gyblos@latest` and then reinstall the service, so it restarts on
the new code (a service from an nvm-managed Node follows that Node version).
`npx gyblos` runs commands, but the service refuses to run from a temporary
cache (npx, pnpm dlx, bunx).

`pnpm build:npm --version <v>` packs them from `pnpm build:native` archives of
the same version. The release builds them in its `native` job; its `npm` job
publishes them with provenance only when the repository variable `NPM_PUBLISH`
is `true`. One-time setup: the npm organization `gyblos`, then an `NPM_TOKEN`
secret that can publish `gyblos` and `@gyblos/seller-<target>` (npm sets up
trusted publishing only on a package that already exists, so the first release
needs the token; afterwards this workflow can be their trusted publisher). A
version already on npm is skipped, so the job can be re-run. As on GitHub,
`latest` moves only to a newer version; an older line's release is tagged
`previous`.

##### Releasing the seller image

A release is a version tag pushed from a commit on `main`, one tag at a time.
Nothing else is committed or deployed: the release itself publishes the
installer. Tag a commit whose message does not contain `[skip ci]` (or another
skip marker): GitHub then skips every workflow for the push, including this
release, and the tag must be deleted and pushed again on another commit.

```sh
git tag v0.1.0-beta.3 origin/main
git push origin v0.1.0-beta.3
```

1. The `release` job waits in the `release` environment for a maintainer's
   approval, then runs `scripts/release-image.sh`. It refuses a commit outside
   `main`, an existing version (or a registry it cannot query) and any run
   outside the workflow; builds the tagged commit alone (`git archive`) for
   amd64 and arm64; pushes `:<version>` and `:<commit>`; and signs the digest
   and verifies that the signature names this workflow at this tag.
2. The `publish` job runs `scripts/publish-installer.sh`. It pins a copy of
   `install.sh` to that digest (`scripts/pin-installer.sh`), signs it keyless
   with the same identity, and creates the GitHub release of the tag with
   `install.sh`, `install.sh.sha256` and `install.sh.sigstore.json`. When the
   version is newer than the latest release by semantic-version precedence
   (`scripts/semver-newer.mjs`), the release becomes latest, which is what
   `https://gyblos.com/install.sh` serves, and `:beta` moves to it; an older
   line's patch is published without replacing either. Releases are never marked
   pre-release, because GitHub's latest download skips those.
3. If only `publish` fails, re-run that failed job; never push the tag again,
   because the release job refuses a version already pushed. A re-run signs a
   new copy of the installer, replaces the files of a release a previous run
   created, and moves `:beta` when that release is the latest.

One-time GitHub setup, by an organization owner:

- Package `seller` → Package settings → Manage Actions access: add `gyblos-node`
  with the Write role, so the workflow token can push.
- Repository Settings → Environments → `release`: required reviewer (the
  maintainers who may publish) and a deployment rule for tags `v*` only.
- Repository Settings → Rules → Rulesets: `Release tags v*`, where only
  repository admins may create, update or delete `v*` tags (the signature names
  the workflow at a tag, so whoever can push such a tag can sign a release), and
  `Protect main`: changes reach `main` only through a pull request, with no
  force push or deletion.
- Organization Settings → Authentication security: require two-factor
  authentication for every member.

The package is public, so the image exposes the node's source.

##### Building the packaged seller

The packaged seller (for installs without Docker) is a folder with its own Node
runtime, so the seller's machine needs no checkout, pnpm or Node:

| Path                   | Contents                                                   |
| ---------------------- | ---------------------------------------------------------- |
| `bin/gyblos`           | Launcher: sets the packaged mode and runs the bundle.      |
| `runtime/node`         | The official Node release binary (and its `LICENSE`).      |
| `lib/gyblos.mjs`       | One bundle of `apps/node/src/bin.ts` and its dependencies. |
| `lib/node_modules/...` | The iroh binding for the target (the only native module).  |

```sh
pnpm build:native --version 0.1.0-beta.8 --target darwin-arm64 --target linux-x64 --target linux-arm64
```

Targets are `darwin-arm64`, `linux-x64` and `linux-arm64` (glibc), and
`win32-x64`, whose folder has `bin/gyblos.cmd` and `runtime/node.exe` (Node's
Windows zip, unpacked with `unzip`; Windows 10 and later unpack the archive with
their own `tar`). Intel Macs and musl Linux keep Docker. Each archive,
`dist/native/gyblos-<version>-<target>.tar.gz`, comes with a `.sha256`. The Node
archive is checked against the SHA-256 pinned in `tooling/native-build.ts` and
the iroh binding against `pnpm-lock.yaml`. `--node "$(command -v node)"` reuses
this machine's Node and installed binding for a local build of this machine's
target, with no download.

The packaged seller keeps its home and `gyblos.toml` in `~/.gyblos` and runs as
`gyblos start`; `gyblos seller service install` makes the service run the
launcher.

## Buyer

Free inference uses `pnpm buyer:free`
([Free v2 buyer endpoint](#free-v2-buyer-endpoint)); `pnpm buyer` serves the
same endpoint and chooses free or paid execution from the verified signed quote,
within the `selection.json` ceilings
([Paid v2 buyer endpoint](#paid-v2-buyer-endpoint),
[routing](buyer-routing.md)). The paid v1 flow below needs a paid seller's
`offer.json`; the seller daemon never writes one, so the v1 flow runs only
against the lab gates (`gate:*`).

```sh
export GYBLOS_RELAY_TOKEN=...
pnpm node:setup --role buyer --mint MINT
pnpm node:tokenizer          # download and verify only the pinned tokenizer (`buyer:setup` is the same)
# copy the seller's .local/gyblos/seller/offer.json into .local/gyblos/buyer/
pnpm buyer:trust --owner SELLER_OWNER_ADDRESS --node-id SELLER_NODE_ID --pay-to PAYOUT_ADDRESS --max-atomic 10000
pnpm buyer:start
```

Independently confirm the seller owner, NodeId and payout address before running
`buyer:trust`. The command checks the offer signature, lifetime, payment terms
and configured relay against those explicit identities and the local buyer/mint.
It creates private `trust.json` exclusively and refuses to overwrite an existing
file. It does not derive trust automatically from the offer or make payments.

`trust.json` names the seller you trust; every field must match the offer:

```json
{
  "owner": "SELLER_OWNER_ADDRESS",
  "nodeId": "SELLER_NODE_ID",
  "mint": "MINT",
  "payTo": "PAYOUT_ADDRESS",
  "buyer": "BUYER_ADDRESS",
  "maxAtomic": "10000"
}
```

`node:tokenizer` (or `buyer:setup`) downloads public tokenizer files into
`.local/gyblos/artifacts/tokenizer/`. It does not install Ollama, download model
weights, read keys or contact Solana. Run it once before the synthetic paid-call
CLI.

There is no command that funds P2P roles. Give the buyer address test tokens of
`MINT` with your own Solana tooling.

The proxy listens on `127.0.0.1:4031` and accepts only
`POST /v1/chat/completions` with a loopback `Host`. It runs one request at a
time; a second waits and a third gets 429. Malformed JSON gets 400
`MALFORMED_JSON`. A transport failure returns 503 and is treated as an uncertain
payment, never retried.

One paid synthetic call through a running proxy: `pnpm buyer:call 0` (case 0, 1
or 2). It records journals and measurements in `.local/gyblos/buyer/`.

## Control queries

The seller exposes `catalog.get`, `presence.get` and `offer.request` over a
separate control ALPN. A query never runs inference, takes a payment or reserves
capacity. Startup still performs its normal warmup. The catalog currently lists
the pinned model with reasoning `off`; unsupported levels and busy state are
refused. A separate background lifecycle renews v2 availability through bounded
private warmup and memory checks; queries never trigger them. Failed/expired
checks and busy inference block availability; recovery produces a higher
catalog. The existing paid v1 offer and its original expiry are not renewed. See
[discovery.md](discovery.md#seller-duties) for timing and cancellation limits.

The programmatic `@gyblos/buyer/control` client connects to one chosen seller
using a caller-owned Iroh endpoint and independently confirmed owner/NodeId and
relay policy. Its `getCatalog`, `getPresence` and `requestOffer` methods verify
request correlation, signatures and exact quote terms. It does not choose a
seller or change proxy behavior. Call `close()` when finished; the endpoint
remains owned by the caller. There is no control CLI yet.

Quotes are `offer/v2` and are rejected by the legacy paid v1 flow. They indicate
observed availability, not guaranteed admission. A record or quote issued up to
5 s ahead of the buyer's clock is accepted; expiry has no grace. Keep automatic
time sync (NTP) on: `pnpm gyblos doctor --online` warns when the seller's clock
is over 2 s off the discovery index. Queries have a 10-second absolute deadline
and share endpoint admission before their separate control quotas. See
[the protocol specification](../packages/protocol/SPEC.md).

## Relays

- Default relay: `https://na1.relay.gyblos.com/` (QUIC address discovery on UDP
  7842). Public n0 relays are not used as a fallback.
- `GYBLOS_RELAY_TOKEN` is required by both roles. There is no built-in token; a
  missing or invalid token stops endpoint binding. It is sent only to the owned
  hosts `na1.relay.gyblos.com` and `na2.relay.gyblos.com`. Never put it in a
  relay URL, an offer, a config file or a committed env file.
- `GYBLOS_RELAYS` overrides the relay list (comma-separated HTTPS origins). Both
  roles must use the same list. The buyer accepts an offer's relay only if it is
  in that list. To add `na2` once it exists:
  `GYBLOS_RELAYS=https://na1.relay.gyblos.com/,https://na2.relay.gyblos.com/`.
- Iroh prefers a direct path and falls back to the relay. That does not retry a
  paid request.

## Relay-only and privacy

A direct connection shows each peer's IP address to the other.

- `GYBLOS_RELAY_ONLY=1` (seller): binds loopback only, advertises no direct
  addresses and rejects an observed non-loopback direct path.
- `GYBLOS_BUYER_RELAY_ONLY=1` (buyer): binds loopback only, ignores
  `GYBLOS_IROH_BIND` and the seller's direct addresses, and dials only the
  offer's configured relay. An offer without a relay is rejected.
- `GYBLOS_EXPECTED_ROUTE=iroh-direct|iroh-relay` (buyer) refuses to pay when the
  observed route differs. Requiring a relay route alone does not hide the
  buyer's address; use `GYBLOS_BUYER_RELAY_ONLY=1` for that.
- `GYBLOS_IROH_BIND` sets the UDP bind address; `GYBLOS_IROH_EXTERNAL_ADDR` adds
  a public address to advertise (rejected in relay-only mode).

The relay still sees both peers' IP addresses. Off-host relay-only privacy has
not been measured.

A relay-only seller can be tested with its buyer on the same machine. After the
first exchange Iroh may switch to a direct loopback path; relay-only accepts a
direct path only when its remote address is loopback (`127.0.0.0/8`, `::1` or
`::ffff:127.x.y.z`). A relay-only endpoint binds only loopback, so that path
reveals no address, and any other direct path is still refused. A local UDP
forwarder listening on loopback (a tunnel or proxy) would also look like
loopback, so do not run one on a relay-only machine.

## Other settings

These variables can also be written in a `gyblos.toml` file, checked with
`pnpm gyblos config validate`; the variables keep precedence over the file. See
[configuration.md](configuration.md). The seller reads `GYBLOS_CONFIG` or
`./gyblos.toml` at startup; see its "Seller startup" section for what it honors.

- `GYBLOS_HOME`: local home for both roles and shared artifacts (default
  `.local/gyblos`).
- `GYBLOS_RPC_URL`: devnet RPC; the genesis hash is checked before use.
- `GYBLOS_P2P_RUN_ID`: optional label copied into `status.json` and evidence.
- Ports: buyer proxy 4031 and the seller's Ollama at its offer URL (loopback
  only). The lab gates run their own Ollama on 11436 and the paid gates also use
  4032 and 4022.

Facilitator diagnostics are written only by the lab's paid gates; see
[payments.md](payments.md).

Local role/trust JSON is validated before use: required fields, Solana
addresses, lowercase hex NodeIds, HTTP(S) RPC URLs and positive decimal-string
budgets up to the local maximum. Existing malformed configurations now fail
explicitly. Operator RPC URLs may contain provider credentials; validation
errors never echo them.

Role and trust files reject unknown fields. Trust budgets must be canonical
positive decimal strings (`"10"`, not `"0010"`). Files produced by `node:setup`
and trust files with canonical budgets remain valid. Older `buyer:trust`
versions accepted leading-zero budgets; remove those leading zeros before
loading such a file. Validation errors do not echo field names or values.

### Optional buyer selection and discovery

A buyer may opt into local selection by placing `selection.json` in its buyer
home (`homeLayout`: `$GYBLOS_HOME/buyer`, default `.local/gyblos/buyer`).
Without this file, the existing trusted v1 proxy path is unchanged. The file
contains:

- `request`: `selection` (`modelId`, nullable `variant` and `quantization`),
  exact `reasoning`, nullable `lowestReasoning`, `network`, `asset`,
  `maxTokens`, canonical decimal `maxAtomic`, `priceCeilings`
  (`inputAtomicPerMtok`, `outputAtomicPerMtok`, atomic units per million
  tokens), `minimumBadge: "declared-usage"`, and an accepted `retention` array;
- `sellers`: at most 16 operator-trusted
  `{ owner, nodeId, relayUrl, directAddresses }` entries; an optional signed
  `withdrawal` is checked against the exact catalog. These identity bindings
  must come from an independent source, never the seller's own declaration.
  Relay origins must be configured;
- optional `pinnedNodeId` for “choose myself”. A pinned seller still passes all
  filters; `PINNED_SELLER_IN_COOLDOWN` includes `cooldownUntil` for the UI;
- optional `quoteWindowMs`, how long quotes may race (integer milliseconds, 100
  to 10000; default 3000).
- optional `models`: the models the local endpoint serves by name, 1 to 32
  `{ id, aliases?, selection, maxTokens? }`. A client sends `id` (or an alias)
  as `model`, and the buyer quotes that `selection` with that answer limit
  (`maxTokens`, default `request.maxTokens`, at most 32768); every other request
  setting is shared. Names are unique across ids and aliases, and the list must
  serve `request.selection.modelId` by name (`buyer:chat` asks for it). Paid
  modes refuse to start unless every listed model meets the paid limits (the
  pinned model, at most 128 tokens), since the buyer recounts with that model's
  tokenizer. `GET /v1/models` lists them (with `max_output_tokens`), and a name
  the endpoint does not serve gets 404 `FREE_BUYER_MODEL_NOT_FOUND` listing the
  ones it does. Without `models`, `request.selection` is the one model. Each
  request carries its whole conversation, so switching models between turns
  keeps the context. A seller that has not answered when the window closes is
  cooled down like one that refused.

Without a `discovery` option this is a static candidate list. With optional
`"discovery": {}` (or
`{ "baseUrl": "https://your-index.example/v1", "maxPages": 3 }`), the HTTP index
supplies availability hints filtered by these independent identity/endpoint
bindings. Unknown identities are never enrolled. See
[discovery.md](discovery.md#buyer-runtime-integration) for durable replay state,
pagination, cache lifetime and failure behavior. Every badge is `declared-usage`
until a real checkability source exists; a catalog cannot elevate it.
`openChannel` is always false until payment channel reuse exists.

The buyer verifies catalog, presence and withdrawal signatures and bindings,
selects candidates, then requests signed quotes in parallel without the prompt.
Snapshots have a 10-second collection budget; a timed-out peer does not discard
healthy snapshots. The quote window defaults to 3 seconds: in the first real
test a quote through a distant relay took about 250 ms each way, so the earlier
300 ms often expired before any quote arrived (`NO_ACCEPTABLE_CONTROL_OFFER`). A
quote still wins as soon as it arrives, so the window only bounds how long a
slow seller can take. A downgrade cannot win while an exact candidate is
pending, including at window expiry. Quotes reserve no capacity. Idle HTTP
connections are retired before control queries so the shared transport admission
still applies. Control connections close before v1 HTTP forwarding.

A different seller returns `SELECTED_SELLER_NOT_TRUSTED` (HTTP 409), with no
inference forwarding or payment. The trusted seller can proceed only through its
unchanged stored v1 offer. Quotes are never converted into v1. Because v1 has no
reasoning selection or separate selection-budget enforcement, execution requires
`off` reasoning, matching engine description/payment identities/prices/metering,
and the same maximum budget as the stored v1 offer. Other terms return
`QUOTE_REQUIRES_UNSUPPORTED_V2_EXECUTION`. This paid entry never executes free
v2; use the separate free buyer endpoint below.

The signed follow-up must match the original request ID and exact body bytes; no
new selection occurs after a payment header appears. A lost authorized response
blocks further routing until the existing reconciliation workflow has resolved
the uncertainty. Restarting the proxy is not reconciliation; the existing call
journal checks remain authoritative. The in-memory session admits at most 1,024
decisions, retaining authorized IDs to prevent replay until restart.

`selection-stats.json` stores only local quote successes/failures, latency,
cooldown and nullable wait metadata, via staged replacement with file mode 0600
and buyer-directory mode 0700. Quote latency is not inference latency; v2 quotes
provide no predicted wait, so quoted/observed wait and accuracy remain null
until an actual observation source exists. No prompts, offers or payment
payloads are stored there. No payments v2 are enabled.

## Optional seller discovery publication

The seller can publish its signed public catalog/presence to the HTTP index with
`GYBLOS_DISCOVERY_PUBLISH=1`. `GYBLOS_DISCOVERY_URL` overrides the configured
base URL; publication is off by default. See
[discovery.md](discovery.md#seller-duties) for renewal, retry, shutdown and
sequence-state recovery limits. Do not reset `public-sequence-v2.json` or
automatically remove a leftover sequence lock. Catalogs and quotes never outlive
the seller's current checked readiness observation; publication does not run an
engine or enable v2 payments. Creating/deploying an index is a separate operator
action, described in [discovery-index.md](discovery-index.md).

## Free v2 seller execution

A supported `gyblos.toml` free offer starts control plus the separate
`gyblos/free/4` complete-response and `gyblos/free-stream/4` streaming data
channels. The daemon has no paid HTTP service or v1 offer; paid v2 offers use
the separate paid stream described in the protocol spec. Free execution serves a
conversation (an optional system message, then turns alternating user and
assistant, from and ending with the user's) with `off` reasoning, up to the
offer's answer limit (`free.max_output_tokens`, 4096 tokens by default, at
most 32768) within the model's context (a free Ollama offer's
`engine.context_tokens`, 8192 by default, at most 32768). The engine's deadline
grows with the requested answer, up to 170 seconds. The separate `buyer:free`
entry executes free quotes; obtaining a control quote alone still does not send
a prompt.

The seller reads daily token caps from the prepared offer: `daily_token_cap`
applies across all buyers and `per_buyer_cap` per authenticated NodeId, both
counting input plus output tokens. The buyer cap is best effort: generating a
new NodeId bypasses that identity's allocation but not the shared offer cap.
Input plus maximum output is reserved before inference; only a valid recounted
completion returns unused tokens. Errors/cancellation retain the reservation.
Caps are in memory and reset on restart, so they do not promise durable daily
limits. Renewing availability does not reset them.

How tokens are counted depends on the offer's metering mode, which every quote
carries. A model whose public tokenizer is pinned is **recounted**: the seller
counts the prompt and output with that tokenizer, as the buyer can ("Uso
medible"). Any other model is **declared** ("Uso declarado"); today that is any
model the `openai` plugin serves other than Qwen3 0.6B, and every model the
`anthropic` plugin serves. The reported usage is then the engine provider's,
which the buyer cannot check:

- admission reserves the prompt's UTF-8 bytes plus 64 tokens for the provider's
  chat template, and the reservation is never refunded;
- a stream stops with `FREE_EXECUTION_LIMIT_EXCEEDED` once it would deliver more
  than 32 bytes per allowed output token;
- a count below one input token, below one output token per 32 delivered bytes,
  above `maxTokens` or beyond the model's context is the provider's invalid
  response (`SELLER_CANNOT_CONTINUE`, reason `engine_invalid_response`);
- a stopped stream reports its delivered bytes, at most `maxTokens`.

An engine on this machine renews readiness with a one-token private warmup and
memory checks; an engine the seller pays per call renews by describing its model
only, and never generates for readiness.

Token caps belong to each free offer, and each offer has its own readiness: one
offer generating or renewing never makes another's quotes busy, and a quote for
an offer the catalog no longer lists is refused with
`CONTROL_MODEL_UNSUPPORTED`. Quotes are single-use through expiry across the
whole seller, which also runs one free generation at a time and counts
`max_free_buyers_per_day` across all its offers; a request whose selection no
offer serves is refused with `FREE_EXECUTION_UNSUPPORTED`. Replay state is
bounded; startup rejects quotes issued at or before its startup timestamp. A
trustworthy wall clock is required across restarts. Disconnecting or retrying
never refunds uncertain work or permits reuse of a consumed quote. An engine
ignoring cancellation keeps its slot occupied until it settles. No fallback is
allowed after any prompt bytes have been sent. Nothing on this channel
authorizes payment.

### Free-service availability limits

The seller's buyer table is bounded at 1,024 NodeIds per UTC day by default
(`max_free_buyers_per_day` in [`[limits]`](configuration.md#seller-limits), at
most 65,536). A peer that controls many cheap NodeIds can fill it while using
only a small part of the daily token budget; further new buyers then receive
`FREE_EXECUTION_BUSY` until the next UTC day or restart. Existing tracked buyers
retain their own limits. A shared overflow policy is a follow-up; the current
bound protects memory and does not guarantee fair access.

After admission, cancellation retains the full input-plus-output reservation,
even when no answer was received. Repeated cancellations across cheap NodeIds
can exhaust the shared daily budget. No output is not proof that the engine did
no work, so refunds for proven pre-execution cancellation need separate engine
lifecycle evidence; they are not enabled here. A generation rejection, including
cancellation, also invalidates cached readiness. Quotes remain closed until the
next successful background check (normally scheduled on a 10-second tick, plus
probe time; longer outages can take longer).

Free quotes retain the shared v2 metadata shape: `authorizer` and `feePayer`
contain the owner's address as placeholders. Both prices and `maxAtomic` are
zero; these fields assign no payment authority and no auxiliary payment signer
is loaded. Paid v2 requires separate admission checks before it can exist.

Switching a home from paid to free can leave a prior `offer.json` in place. It
is not renewed or advertised by the free service, whose endpoint exposes only
control and free ALPNs. Startup deliberately preserves existing role files;
operators should use current signed v2 quotes rather than that old file.

## Free v2 buyer endpoint

### Terminal chat

After configuring the buyer, run `pnpm buyer:chat`. It starts and owns a local
buyer endpoint on an ephemeral port, uses the startup selection, shows the
configured model and per-request maximum deposit, and streams a response. Each
line is one independent user message; the terminal does not send history. Enter
`/exit` or press Ctrl-C to stop. The CLI does not choose or display a seller
independently of the buyer, and does not write conversations to files.

The automatic owned buyer manages its private bearer token without printing it,
including for free answers. An unresolved signed payment or another buyer
holding the journal blocks requests; starting chat does not itself open
payments. Amounts are atomic units of the configured devnet test token, not
USDC. The CLI prints usage and the payment verdict when available. If a request
fails after it may have been sent, or the payment is not confirmed, it stops
without retrying; use the buyer's reconciliation procedure before another paid
request. A completed streamed fragment is provisional until the final result
arrives.

`pnpm buyer:free` starts a separate loopback endpoint on the buyer proxy port
(default `127.0.0.1:4031`). Stop `buyer:start` first; both commands use that
port. It needs the buyer role's public configuration, node key and the
`selection.json` policy described above. It does not load a wallet signer,
trust/offer files or a tokenizer, and does not check a payment program or
contact RPC. Existing role configuration retains its legacy asset/RPC fields,
but this entry does not use RPC. Keep seller owner–NodeId bindings independently
verified; discovery only supplies signed availability hints for those configured
identities.

Set `request.reasoning` to `"off"`, `lowestReasoning` to `null`, and `maxTokens`
to at most 32768 (4096 by default, the sellers' default answer limit; a seller
refuses to quote above its own `free.max_output_tokens`). Paid mode keeps at
most 128 for now. For a clear operator policy, set `maxAtomic`,
`inputAtomicPerMtok` and `outputAtomicPerMtok` ceilings to `"0"`. The free entry
enforces those zero ceilings/budget even if a shared selection file permits paid
quotes. `pinnedNodeId`, data-retention filters and configured relays still
apply; `PINNED_SELLER_IN_COOLDOWN` retains `cooldownUntil` in the error object.
Badges stay `declared-usage` and `openChannel` stays false.

If startup fails, `buyer:free` prints `FREE_BUYER_CONFIGURATION_REQUIRED` with a
reason and a next step, for example `BUYER_ROLE_MISSING` (run `node:setup`),
`SELECTION_CONFIG_MISSING` or `SELECTION_CONFIG_INVALID` (create or fix
`selection.json` in the buyer home), `SELECTION_STATS_INVALID`,
`DISCOVERY_STATE_UNAVAILABLE` or `IDENTITY_STATE_UNAVAILABLE` (a state file
beside it), `SELECTION_MAX_TOKENS_TOO_HIGH`, `SELECTION_REASONING_UNSUPPORTED`,
`BUYER_NODE_KEY_MISMATCH`, a relay code such as `MISSING_RELAY_TOKEN`, or
`BUYER_PORT_IN_USE`. No path or file content is printed.

The endpoint speaks two chat formats over the same execution, so OpenAI- and
Anthropic-compatible clients and agents can point at it: set the client's base
URL to `http://127.0.0.1:4031/v1` (OpenAI) or `http://127.0.0.1:4031`
(Anthropic). `GET /v1/models` lists the models in `models`, or the one
`request.selection` model when there is no list.

OpenAI format, `POST /v1/chat/completions`:

```json
{
  "model": "the-exact-configured-model-id",
  "messages": [
    { "role": "system", "content": "Answer briefly." },
    { "role": "user", "content": "My name is Ana." },
    { "role": "assistant", "content": "Hello Ana." },
    { "role": "user", "content": "What is my name?" }
  ],
  "max_tokens": 512,
  "stream": false
}
```

Anthropic format, `POST /v1/messages`:

```json
{
  "model": "the-exact-configured-model-id",
  "system": "Answer briefly.",
  "max_tokens": 512,
  "messages": [{ "role": "user", "content": "What is my name?" }]
}
```

The whole conversation is sent to the seller each time, as these APIs expect.
Content may be a string or a list of `text` parts. System (and OpenAI
`developer`) instructions go first; turns of the same role in a row are joined;
the conversation must start and end with a user turn. It holds at most 1024
messages and 256 KiB of text, and the seller refuses what does not fit its
model's context. `max_tokens` (OpenAI also `max_completion_tokens`) is required
in the Anthropic format and optional in the OpenAI one; a value above the
buyer's `maxTokens` is served up to it, and the answer then ends with `length`
(`max_tokens` in the Anthropic format). `model` selects the exact configured
model/variant/quantization tuple; it is not an engine name.

Tools (function calling) work in both formats through the normal buyer endpoint:

- OpenAI: `tools` (functions with a JSON Schema in `parameters`), `tool_choice`
  (`auto`, `none`, `required` or one function), assistant `tool_calls` and
  `role: "tool"` results.
- Anthropic: `tools` with `input_schema` (client tools; server tools such as web
  search are refused), `tool_choice` (`auto`, `any`, `none`, `tool`), and
  `tool_use` and `tool_result` blocks; a result marked `is_error` reaches the
  model as `Error: ...`, and text after the results joins them.
- An answer that calls tools ends with `finish_reason: "tool_calls"`
  (`stop_reason: "tool_use"`); its calls carry ids the seller assigns. The buyer
  asks only sellers that serve tools (`params.tools` in the quote); when none
  does, it answers 503 saying so. A zero-price quote needs no financial
  services. A positive-price quote requires an explicitly configured reusable
  session and a tokenizer that can independently recount tool output. The old
  individual settlement mode refuses tools before opening a payment; it cannot
  acknowledge arguments held until the response terminal.
- The pinned qwen3:0.6b handles simple calls; agents that send many tools and
  long instructions (Claude Code) need a seller on a larger model through the
  OpenAI or Anthropic engine. Cursor's agent mode calls from its own cloud and
  cannot reach a local endpoint.

Options clients send by default and that do not change what is asked
(`temperature`, `top_p`, `top_k`, penalties, `seed`, `user`, `metadata`,
`stream_options`, `store`, `parallel_tool_calls`, and in the Anthropic format
`thinking`, `output_config` and `context_management`, which Claude Code sends)
are accepted and ignored: generation is deterministic and thinking is always
off. Options that would change the answer are refused rather than dropped,
unless they hold their neutral value: the legacy `functions` and
`function_call`, `response_format` other than text, `n` above 1, stop sequences,
logprobs, `mcp_servers`, images and other non-text parts. Thinking blocks a
client sends back in an assistant turn are left out, and a `system` message
inside `messages` joins the system instructions. Unknown options are refused.
Everything is checked before selection or prompt transmission. This is a
compatible subset, not the complete OpenAI or Anthropic API. Requests must send
`Content-Type: application/json`. Invalid UTF-8, foreign Host headers, requests
with an Origin header and other content types get 400 (a foreign Host gets 421),
so a web page cannot reach the endpoint; there is no CORS browser interface. A
body declared larger than 384 KiB gets 413 before it is read; a larger streamed
body gets the same 413 once it passes the limit. Both close the connection. Use
a local client, and apply normal trust to local processes. When the endpoint
requires its token (paid mode), send it as `Authorization: Bearer <token>` or,
as Anthropic SDKs do with their key, `x-api-key: <token>`.

Set `stream` to `true` for incremental `text/event-stream` responses. In the
OpenAI format each `data:` event is a `chat.completion.chunk` with a content
delta, and successful completion sends a finish reason and usage, then `[DONE]`.
In the Anthropic format the stream carries `message_start`, one text block's
`content_block_start`, `content_block_delta` and `content_block_stop`, then
`message_delta` with the stop reason and usage, and `message_stop`. Tool calls
arrive whole at the end: in the OpenAI format one chunk with every `tool_calls`
entry before the finish chunk; in the Anthropic format one `tool_use` block per
call (its start, one `input_json_delta` with the whole input, its stop).
OpenAI's Responses API, `POST /v1/responses` (the format Codex CLI speaks),
takes the same model, conversation and function tools: `instructions` and
leading `developer` or `system` messages become the system text, later ones
(Codex sends one when the model changes) are sent as user text, consecutive
`function_call` items form one assistant turn (checked together), and
`function_call_output` items answer them. It is stateless: `store` must be
false, and `previous_response_id`, structured `text.format`, custom or other
provider tools, and audio or file parts are refused with a 400 that names them.
For Codex sessions, three things are left out rather than refused: the
`web_search` tool and the tool groups (`namespace`, such as Codex's sub-agent
and MCP tools) Codex sends on every request (no seller runs them), `reasoning`
and `web_search_call` records from a session that began on another provider, and
images, which become a short `[image omitted …]` text so a session that once saw
a picture goes on. `include`, `prompt_cache_key` and bookkeeping hints are
accepted and ignored. Non-neutral reasoning, sampling settings and
`parallel_tool_calls: false` are refused before execution: the signed protocol
cannot express those constraints yet. Codex versions that require them are not
supported until that follow-up. A stream sends `response.created`, the message
item (`output_item.added`, `content_part.added`, `output_text.delta`, then their
`done` events) once text starts, each call as a `function_call` item
(`output_item.added`, `function_call_arguments.done`, `output_item.done`), and
`response.completed` with usage; a token-limited answer ends with
`response.incomplete`, status `incomplete`, and its delivered usage. A
possible-send failure before the first stream event uses HTTP 400 and
`invalid_prompt` to stop clients that ignore retry headers. A failure after the
stream starts is `response.failed` with code `invalid_prompt` (which Codex shows
and does not retry, since the prompt may have reached a seller), a readable
message and the Gyblos code in `gyblos_code`. A conversation over the size the
network carries gets code `context_length_exceeded`, so Codex compacts it. Paid
endpoints serve text only, so they refuse Codex's tools.

Codex CLI points at the endpoint as a custom provider in `~/.codex/config.toml`
(the built-in `openai` provider sends fields only OpenAI accepts):

```toml
model = "qwen3-0.6b"
model_provider = "gyblos"

[model_providers.gyblos]
name = "Gyblos"
base_url = "http://127.0.0.1:4031/v1"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0
```

Leave MCP servers off for these sessions; switch models with `/model` and any
name the endpoint serves.

`POST /v1/messages/count_tokens` answers an estimate (about four bytes per token
over system, messages and tools) without contacting a seller. The default
(absent or `false`) remains one complete JSON response.

Fragments are provisional until a verified terminal and clean end of the Iroh
stream. A failure after SSE starts sends a static error (an `error` event in the
Anthropic format) and closes without `[DONE]` or `message_stop`; an error before
SSE starts uses the JSON error response below. The stream sets
`x-should-retry: false`. A disconnect or deadline cancels execution; after
possible prompt transmission the buyer never retries or switches seller, even
before the first fragment. Writes await backpressure. Complete and streaming
execution share replay/caps; cancellation keeps a conservative full token
reservation. This free buyer does not invoke the separate paid-v2 path.

A free-only buyer runs up to two requests at once, each on a different seller,
since a seller serves one request per buyer at a time: selections take turns,
each skipping the sellers already serving this buyer. When every candidate is
busy with this buyer's other request the answer is 429 (the seller is not cooled
down), and a third request at once gets 429 too. Paid and session modes keep
their own admission. The buyer checks registered identity again after quoting,
before admitting the winner, even if discovery or catalog checks succeeded. No
identity decision is reused for final admission.

A free buyer goes back to the seller that served a conversation (known by a
digest of its model, system text and first user message, kept in memory only for
the last 256 conversations), so a warm prompt cache can answer sooner: that
seller is kept among the candidates when it is still competitive, and another
seller's quote waits up to 500 ms for its quote. A seller that fails while
executing (its connection breaks or it answers out of protocol, not the buyer's
own deadline or a client that left) counts a failure, so it weighs less in later
selections; it is not cooled down (a seller that is gone already is at its next
quote, and a buyer's only seller stays reachable). When that happens before the
prompt was sent, the request moves to another seller as before.

Status codes: 400 for an invalid request or a request beyond the quote's limits,
413 for an oversized body, 429 when the endpoint is already running as many
requests as it can (safe to retry), 503 when no seller could take the request,
504 when the endpoint's 180-second deadline expires, and 500 for an unexpected
failure. Whenever the prompt may already have reached a seller, or the request
is the caller's fault, the error carries `x-should-retry: false`, the header the
official OpenAI and Anthropic SDKs honor to skip their automatic retries.
Clients that retry 5xx on their own must check it: retrying would resend the
prompt, possibly to another seller.

A refused request (`FREE_BUYER_INVALID_REQUEST`, 400) names the offending field
in `error.param` (`model`, `messages`, `max_tokens`, `stream`, or an unsupported
field such as `n`) and says why in `error.message`, for example
`n is not supported yet; remove it or send its default`. The reason is fixed
text or the operator's own limits, never the prompt. In the Anthropic format
errors take that API's shape
(`{"type":"error","error":{"type": "invalid_request_error","message":...}}`) and
carry the same `code`.

When a seller drops out of a selection, `buyer:free` prints one stderr line:
`FREE_BUYER_SELLER_FAILED <first 8 hex of the NodeId> <phase> <code>`. The phase
is `identity`, `connect` (dial, catalog or presence), `discovery`, `quote` (the
seller refused, for example `CONTROL_MODEL_UNSUPPORTED`) or `timeout` (no quote
before the window closed). The line carries no address, key or error text.

When a seller's engine fails after it accepted the request (for example a
reseller out of quota, rate limited, or an engine that stops mid-answer), the
error code is `FREE_EXECUTION_SELLER_CANNOT_CONTINUE` and `error.reason` says
why: `quota_exhausted`, `rate_limited`, `engine_unavailable`,
`engine_interrupted`, `engine_timeout` or `engine_invalid_response`. Before the
first token this is a 503 JSON error. Mid-stream it is the final SSE error
event, which also carries `error.usage.completion_tokens`: the tokens the seller
delivered before it stopped. The buyer does not retry or reroute.
`FREE_EXECUTION_ENGINE_UNAVAILABLE` remains the refusal before generation, for
example when the seller's engine readiness has expired. A pinned model that
disappears during a request is reported as `engine_unavailable`.

The response contains one `choices` entry, its text/finish reason and
`usage.prompt_tokens`, `completion_tokens` and `total_tokens`. Static failures
use `error.code`; arbitrary exception contents are never returned. No prompt or
response is written to logs, journals or selection metadata. A free seller can
still observe the submitted text; free does not imply private or verified.

Control connections close before execution connects on `gyblos/free/4` or
`gyblos/free-stream/4`. The client verifies the seller peer, signed quote, local
buyer NodeId, exact terms and lifetime again before sending (an issue time up to
5 s ahead is accepted; expiry has no grace). Request/response bounds and
correlation use the free protocol codec. A query has an absolute 180-second
budget including discovery, quotes and execution; each transport also retains
its stage bounds. A failed seller may be excluded and selection repeated only
before sending begins, and no seller is executed twice in one local request. The
free runtime admits one orchestration at a time with no queue; overlapping
requests return `FREE_BUYER_BUSY` rather than racing the per-peer connection
limit or poisoning another request's cooldown. Cancelled selection attempts do
not commit quote statistics. Control and execution admission remain occupied
until pending native work settles. The client marks sending before the first
frame write: partial writes, remote errors, timeouts and lost responses never
cause automatic failover afterward. Native work that ignores cancellation
retains its execution resource until it actually settles. The v1 paid proxy
remains a separate command.

Product contract tests use a synthetic engine and native encrypted loopback.
They are not the complete publication-to-answer acceptance: the separate lab
scenario with an in-process discovery index follows this buyer's integration.
Real Ollama, off-host/relay/CGNAT and production acceptance remain separate
operations. See the following paid-v2 section and the identity documentation for
their separate scope and limits.

## Paid v2 buyer endpoint

`pnpm buyer` reads `selection.json`, selects a seller and verifies its signed
quote. Both prices zero and `maxAtomic: "0"` use free execution without payment
transactions. Either positive price uses the existing paid channel. A positive
configured `request.maxAtomic` is a ceiling and can also accept a free quote.
Payment preparation is deferred until a positive quote wins; the following paid
requirements are not needed to execute a free quote. See
[buyer routing](buyer-routing.md). Paid execution is devnet only and needs:

- the buyer role (`pnpm node:setup --role buyer --mint MINT`) whose `rpcUrl`
  serves devnet (checked by its genesis hash) and whose wallet holds devnet SOL
  and the test token;
- the pinned public tokenizer (`pnpm node:tokenizer`), because the buyer
  recounts every answer itself;
- `request.selection.modelId` `qwen3-0.6b`, reasoning `off`, `network` devnet
  and `asset` the role's mint, with `maxAtomic` the most one request may deposit
  and `priceCeilings` the highest prices it accepts (protocol fee included).
- every request to carry `Authorization: Bearer <token>`, with the token the
  first automatic start writes to `api-token` in the buyer home (below).

For a positive-price winning quote, the buyer signs one channel open for at most
`maxAtomic`, streams the answer and checks the seller's settlement against the
buyer's own count. A completed answer, and an error the seller answered after
receiving the open, carries `gyblos_payment`: the verdict, the ceiling, the
buyer's expected charge, the seller's charge, payout, fee and refund in atomic
units, and whether a record was kept. A stream cut before the seller answered,
or the endpoint's own deadline, carries only the error code. Only a single user
message the model's chat template accepts is sent; anything else is refused
before paying.

One paid request runs at a time (`PAID_BUYER_BUSY`) and one buyer process holds
the payment journal (`BUYER_PAYMENT_JOURNAL_UNAVAILABLE`). The buyer never fails
over once a seller received the signed open, since that seller could still land
it; an open that never left the buyer is discarded and the next seller is tried.
Any channel in the journal not settled on the buyer's own count (a refusal, a
stop, a pending or lapsed claim, a dispute or a settlement the chain could not
confirm) blocks new automatic requests, including free execution
(`PAID_BUYER_UNRESOLVED_PAYMENT`), until it is reconciled; the buyer also
appends it to `paid-records.jsonl` in the buyer home when it can (`recorded`).
Never reset or delete a journal or lock to bypass the block.

To reconcile, stop the paid buyer and run `pnpm buyer:reconcile:paid`. It checks
that the role's RPC serves devnet, then reads each open channel's finalized
history; it only reads the chain and never signs. One JSON line per channel
reports the outcome, then a summary line with the count of each:

- `settled`: the claim charged exactly the buyer's own count;
- `disputed`: it charged another amount, more or less (recorded, no penalty);
- `unchecked`: the chain shows a charge but no record of the buyer's count
  survived;
- `never-opened`: nothing was charged, because the chain shows the open never
  landed and never can: no deposit in the channel's whole history, no channel
  account, the open's blockhash expired by finalized block height, and the RPC
  still holds history back to the open's slot;
- `open`: the channel is open and unclaimed, its open may still land, or the
  chain cannot prove otherwise (a pruned RPC, or more history than it reads).

The charge is what left the escrow minus what came back to the buyer's wallet.
If the program redirected the refund elsewhere (for example because the buyer's
token account was closed), it shows as a larger charge and a dispute, never a
smaller one. Each outcome but `open` is appended to `paid-reconciliations.jsonl`
in the buyer home before the journal unblocks it, so a failed run loses nothing
and the next one picks up where it stopped. An `open` channel keeps blocking
until the seller claims it or the buyer withdraws it (below).

Use the role's RPC as one endpoint with complete, consistent finalized
transaction history. The command reads the finalized tip and checks that the RPC
still serves blocks and ledger back to the open's slot; those checks do not
prove that its signature history is complete or consistent across backends. The
operator must verify that history before running reconciliation: the command can
automatically mark an open as never landed and unblock payments. Do not run it
against an RPC whose history may be incomplete or inconsistent. A signed open
from an older journal has no recorded network and remains blocked, as described
below. A journal upgraded to the current format is refused by earlier releases
(`BUYER_PAYMENT_JOURNAL_UNAVAILABLE`, `PAID_RECONCILE_INCOMPLETE`,
`PAID_WITHDRAW_INCOMPLETE`), so do not roll back the buyer while channels need
recovery.

The command exits 0 when nothing blocks payments (disputes included, since they
are recorded and no longer block), 2 while a channel stays open, and 1 when it
could not finish, printing `PAID_RECONCILE_NETWORK_MISMATCH`,
`PAID_RECONCILE_ROLE_INVALID` or `PAID_RECONCILE_INCOMPLETE` (stop the buyer,
check the RPC and the home). The v1 `buyer:reconcile` is unchanged.

A channel that stays `open` because nobody claimed it is withdrawn with
`pnpm buyer:withdraw:paid` (buyer stopped, devnet only). Unlike reconciliation,
it signs with the buyer's wallet key and pays each transaction's fee from the
wallet's devnet SOL. Each run visits every open channel in the journal and takes
it one step further, chosen from the channel's confirmed state. It prints one
JSON line per channel, then a summary with the count of each step and the
shortest `retryAfterSeconds`:

- `claimable`: the seller may still claim it with the buyer's authorization, so
  it is left alone. That lasts until the quote expires or `maxTimeoutSeconds`
  after the open was signed, whichever is later, plus 150 seconds for a claim
  sent just before then to land and for clock differences.
- `close-requested`: `request_close` was sent, which starts the channel's grace
  period (`withdrawDelay`, 60 seconds).
- `waiting`: the grace period has not elapsed by the chain's block time, or the
  RPC does not know that block's time yet.
- `distributed`: `seal` and `distribute` were sent, which pay out whatever was
  settled and refund the rest of the escrow. The same transaction first creates
  the buyer's token account if it was closed (at the wallet's cost in rent),
  because the program would otherwise send the refund to its own treasury.
- `nothing`: already distributed, or no channel account at the address.
- `refused`: the account is not this buyer's channel with the journaled rent
  payer, deposit, mint and network fee distribution, so nothing was signed for
  it. The journal keeps the mint, fee treasury and fee rate each open accepted,
  so a later change to the role's mint or the network fee does not affect
  channels already open. Entries journaled before that have no recorded network
  and remain blocked until their provenance is independently established.
- `failed`: this channel's step failed with the static code in `failure`
  (`UPTO_UNAVAILABLE` for the RPC, `UPTO_CHAIN_REJECTED` when the chain or its
  preflight refused the transaction, which also happens when an earlier
  unconfirmed one has since landed or the wallet lacks SOL for the fee or the
  token account's rent). The other channels still take their step.

Each line also says whether its transaction confirmed within a minute. One that
did not is checked again after 30 seconds: run again before then and the same
step may be sent twice, and the second only costs a refusal (`failed`). The
command exits 2 while another run is needed, 0 when none is, and 1 when it
refused or failed a channel (`PAID_WITHDRAW_REFUSED`, `PAID_WITHDRAW_FAILED`,
after every channel was visited) or could not run
(`PAID_WITHDRAW_NETWORK_MISMATCH`, `PAID_WITHDRAW_ROLE_INVALID`,
`PAID_WITHDRAW_INCOMPLETE`).

The buyer journal records the network of new signed opens. A signed open entry
from an older version has no provable network: recovery keeps it open and
refuses withdrawal on every network, reporting `networkBlock: "unknown"`.
Confirm its provenance independently before attempting any separate recovery; do
not delete or edit it to unblock payments. An open channel belonging to a
different network is also left untouched and reports `networkBlock: "mismatch"`.
Recovery can still process signed channels bound to the selected, verified
network.

An older journal containing an unresolved signed open is not upgraded or
rewritten, so earlier software can still read it. Once no such entry remains,
the first journal write upgrades the file to the current format. Earlier
software rejects that format; do not roll back while channels need recovery.

It never changes the journal. Once a channel is distributed and finalized,
`pnpm buyer:reconcile:paid` reads it from history and unblocks payments: the
charge is what the seller had settled (usually nothing). If the buyer had
counted a delivered answer that the seller never claimed, that shows as
`disputed` with a smaller charge. A signed older entry without a recorded
network remains open; an empty history on the selected chain does not prove the
entry was created on that chain. There is no automatic legacy attribution or
recovery command yet.

The endpoint listens on loopback only and refuses browser requests, but loopback
is not authentication, so the automatic entry requires a bearer token for every
request, including free ones. Its first start creates `api-token` in the buyer
home (`.local/gyblos/buyer/` by default), a private 0600 file, and later starts
reuse it. Every request must send `Authorization: Bearer <token>`; OpenAI SDKs
send their `apiKey` this way. A request without the token gets 401
`PAID_BUYER_UNAUTHORIZED` with `x-should-retry: false`, before its body is read
or a seller is selected. The token is never printed; read it yourself. Every
call to the paid endpoint, from curl or an SDK, must carry the header:

```sh
export OPENAI_API_KEY="$(cat .local/gyblos/buyer/api-token)"
curl http://127.0.0.1:4031/v1/chat/completions \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"model":"qwen3-0.6b","messages":[{"role":"user","content":"Hello"}]}'
```

With an OpenAI SDK, set `baseURL` (`base_url` in Python) to
`http://127.0.0.1:4031/v1` and `apiKey` to the token; the SDK reads
`OPENAI_API_KEY` by default and sends it as `Authorization: Bearer`.

Anyone who can read that file, or run as your user, can still spend up to
`maxAtomic` per request: run the paid buyer only on a machine you control, with
a devnet wallet. To rotate the token, stop the buyer, delete `api-token` and
start it again. The free buyer needs no token.

Startup reasons beyond the free ones: `BUYER_PAYMENT_NETWORK_MISMATCH` (RPC,
network or asset not devnet's test token), `BUYER_PAID_MODEL_UNSUPPORTED`,
`BUYER_PAID_MODELS_UNSUPPORTED` (the older explicit paid entry,
`startPaidBuyer`, serves only `request.selection` and refuses a `models` list;
the automatic buyer serves the list), `BUYER_WALLET_KEY_INVALID`,
`BUYER_TOKENIZER_UNAVAILABLE`, `BUYER_PAYMENT_JOURNAL_UNAVAILABLE` and
`BUYER_API_TOKEN_INVALID` (`api-token` is not a private 0600 regular file with
one name, owned by you and holding a token; it is never repaired, since its
token may already have been read).

## Private free-inference receipts

Free sellers advertise `gyblos/receipt/1` alongside execution. After a verified
successful response, the free buyer requests the seller's signed receipt, checks
it against its own execution context, stores its countersigned pair and confirms
it. This is best effort: an unavailable channel, signer, disk or confirmation
never repeats the prompt or turns a successful answer into an inference failure.
The seller also retains seller-only failed/cancelled records when actual
recounted usage is available; unknown provider usage is omitted.

Each role stores a private `receipts/receipts-v1.json` beneath its configured
home (directories 0700, files 0600). It contains signed metadata, not prompts,
responses, keys, IPs or payment authorizations. Buyer token counts are null;
seller counts are not independent buyer measurements. Both signatures are
attestations, not proof of execution or usage. No collector or export is
enabled.

Retention is bounded to 256 records and 1 MiB, evicting oldest metadata first.
Seven-day expiry is logical: reads hide expired records; the next successful
write removes them physically. No background deletion is promised. Unsafe or
corrupt state disables receipt work, without repairing or truncating files. A
crash may leave `receipts-v1.lock`; there is no automatic lock reclamation.

One background receipt task per role/process runs at a time, without a queue.
Inference response/done frames never wait for receipt persistence. Seller
receipt work has a 500 ms budget; the whole buyer receipt exchange has 2 s. Late
uncancellable work keeps that receipt slot occupied and later receipt tasks are
dropped. Node health exposes content-free `receipts` counters (`active`,
`saved`, `failed`, `dropped`); `saved` records a finished task, not a collector
acknowledgment. Shutdown aborts receipt work. Receipt connections have their own
family cap, sharing endpoint global/source/rate limits with inference. Existing
inference admission, free caps, replay checks and payment paths remain
unchanged. No prompt retry is introduced by metadata retries.
