# Running a node from a checkout

This is the engineering and self-hosting reference for running a seller node or
a local buyer from a source checkout, and for how the installers and release
packages work. Everything here runs on Solana devnet.

If you install a seller with the installer, Docker image or npm package, follow
the public handbook instead:
[install a seller](https://docs.gyblos.com/en/sellers/beta-guide),
[register and publish](https://docs.gyblos.com/en/sellers/register-publish),
[operate it](https://docs.gyblos.com/en/sellers/operate), the
[CLI reference](https://docs.gyblos.com/en/reference/cli) and the
[configuration reference](https://docs.gyblos.com/en/reference/configuration).
To call Gyblos from your own code, see
[Connect your coding tools](https://docs.gyblos.com/en/buyers/use-from-code).
The site's source is `apps/docs/content/docs/`.

On this page:

- [Local home](#local-home) and [Roles and files](#roles-and-files)
- [Seller](#seller): native seller, [service](#running-the-seller-as-a-service),
  [registration](#seller-registration-beta-invite), [status](#seller-status),
  [Docker](#docker), [installers](#install-script) and
  [release packages](#releasing-the-seller-image)
- [Buyer](#buyer): [`selection.json`](#optional-buyer-selection-and-discovery),
  [free endpoint](#free-v2-buyer-endpoint),
  [paid endpoint](#paid-v2-buyer-endpoint)
- [Control queries](#control-queries), [Relays](#relays),
  [Relay-only and privacy](#relay-only-and-privacy),
  [Free execution on the seller](#free-v2-seller-execution),
  [Receipts](#private-free-inference-receipts),
  [Environment variables](#other-settings)

## Local home

All node data lives under one local home, `GYBLOS_HOME`. Its default depends on
how the node runs:

| Install                           | Default home                                     |
| --------------------------------- | ------------------------------------------------ |
| Source checkout (`pnpm ...`)      | `.local/gyblos` in the working directory         |
| Docker seller image               | `/data` (the `gyblos` volume)                    |
| Packaged release (installer, npm) | `~/.gyblos` (`%USERPROFILE%\.gyblos` on Windows) |

Each role has its own directory, so one machine can hold a local buyer and a
seller side by side without sharing keys or journals:

| Path                              | Contents                                                                                    |
| --------------------------------- | ------------------------------------------------------------------------------------------- |
| `<home>/buyer/`                   | Buyer keys, role, `selection.json`, `api-token`, payment journals, locks, receipts, logs.   |
| `<home>/seller/`                  | Seller keys, role, status, engine readiness, public sequence, registration, receipts, logs. |
| `<home>/artifacts/tokenizer/`     | The pinned public tokenizer (safe to download again).                                       |
| `<home>/artifacts/ollama-models/` | Lab-only cache of the pinned model for the lab's own Ollama.                                |

Lab state lives in a separate `GYBLOS_LAB_HOME` (default `.local/lab`); see
[lab/README.md](../lab/README.md). The lab may use `<home>/artifacts/` as a
public cache, but it never reads or writes a role directory.

Keep a custom `GYBLOS_HOME` or `GYBLOS_LAB_HOME` outside the repository or under
`.local/`. Only `.local/` is ignored by git.

### Moving data from the old layout

Very old checkouts kept role data in `.local/p2p/` (one role per checkout), the
tokenizer in `.local/devnet/tokenizer/`, models in `.local/ollama/models/` and
lab state in `.local/devnet/`. Nothing is migrated automatically. When a home
directory is missing but its old path exists, setup and startup stop with
`LEGACY_LOCAL_LAYOUT` and name both paths. A fresh role next to an old, possibly
uncertain payment journal could otherwise lose recovery state (see
[recovery.md](recovery.md)).

The check only tests whether the old path exists; it never reads it. It applies
whether or not `GYBLOS_HOME` is set. For the lab, the test is lab state, not the
directory: an empty or lock-only `.local/lab` does not count, so every lab
command keeps refusing until the old lab files are moved.

Before you move anything:

- Stop every node, buyer and lab process.
- Never merge into an existing destination. `mv` would put the old directory
  inside it and hide its journal one level down. If a destination exists, stop
  and compare the two directories by hand. Remove an empty one with `rmdir`,
  which refuses a non-empty directory.
- Run the commands from the same working directory. `ls .local/p2p` shows
  `buyer.json` for a buyer or `owner.json` for a seller.

Choose the role destination (`buyer` below, or `seller`), then run this block.
It uses `GYBLOS_HOME` and `GYBLOS_LAB_HOME` when set, stops on the first
failure, and runs in a subshell so a failure does not close your terminal. It
refuses existing destinations, including dangling symlinks. Omit moves whose
source never existed.

The lab config records absolute key paths. After the move, the block rewrites
only keys directly inside the old lab directory to the new directory. It keeps
the original config as `config.json.bak` and stages the replacement before
renaming it. Unexpected key paths stop the block for manual review. It never
reads or rewrites keys or journals.

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

Review the moved `config.json` and its key paths before you restart anything,
then delete `config.json.bak`: the old copy may hold an RPC URL with an API key.
After a failure, inspect the source and destination and resume only the
remaining moves; do not repeat the whole block. An incomplete config rewrite
leaves the moved config and the original backup for manual recovery.
`.local/identity-validator/` is disposable test scratch and is not checked.

## Roles and files

`pnpm node:setup --role <buyer|seller> --mint <mint>` creates the role
directory, `role.json`, the Iroh node key (`node.key`) and the role's Solana
keys with private permissions. Product roles use devnet USDC as the mint:

```text
4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU
```

This is `DEVNET_USDC` in `packages/config/src/network.ts`; `install.sh` and
`pnpm buyer:init` use the same value. Setup never overwrites existing keys. An
existing role with a different role or mint stops with an error; a different
mint needs its own `GYBLOS_HOME`. Setup records `GYBLOS_RPC_URL` (default
`https://api.devnet.solana.com`) as the role's `rpcUrl` when it creates the
role.

A seller gets an owner key, a node key and two payment keys: the authorizer and
the fee payer (`facilitator.json`). Its payout address is the owner, so any
offer can be free or priced. Running setup again on a seller that has no payment
keys adds them and keeps its NodeId, owner and registration. The installer runs
setup on every run for this reason.

| File                                                | Role   | Contents                                                                                                               |
| --------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------- |
| `role.json`                                         | both   | Role, mint, RPC URL, NodeId and public addresses.                                                                      |
| `node.key`                                          | both   | Iroh secret key (private).                                                                                             |
| `buyer.json`                                        | buyer  | Buyer wallet key.                                                                                                      |
| `owner.json`, `authorizer.json`, `facilitator.json` | seller | Owner, authorizer and fee payer keys.                                                                                  |
| `selection.json`                                    | buyer  | Which sellers and terms the buyer accepts ([reference](#optional-buyer-selection-and-discovery)).                      |
| `api-token`                                         | buyer  | Bearer token of the automatic buyer endpoint ([paid endpoint](#paid-v2-buyer-endpoint)).                               |
| `payments/`                                         | both   | Buyer channel journal, or the seller's payment ledger.                                                                 |
| `status.json`                                       | both   | `starting` with a phase, then `ready`; a seller lists each offer's index, model, engine kind and whether it is listed. |
| `engine-readiness.json`                             | seller | Each offer's latest private warmup outcome, by index.                                                                  |
| `receipts/`                                         | both   | Signed free-inference receipts ([Receipts](#private-free-inference-receipts)).                                         |
| `diagnostics/`                                      | both   | Local operational logs, read with `pnpm gyblos logs` ([diagnostics.md](diagnostics.md)).                               |

## Seller

Prerequisites:

- Node.js 24.22.1 or later and the pnpm version pinned in `package.json`, with
  dependencies installed (`pnpm install --frozen-lockfile`).
- [Ollama](https://ollama.com) installed (`ollama --version`), or an OpenAI- or
  Anthropic-compatible engine URL.
- About 1.5 GiB of free memory for the engine above the seller itself; startup
  checks it.

Run a dedicated Ollama, used only for selling, on loopback. Leave it running in
its own terminal:

```sh
OLLAMA_HOST=127.0.0.1:11435 OLLAMA_MODELS=$HOME/.gyblos-ollama OLLAMA_NO_CLOUD=1 OLLAMA_NUM_PARALLEL=1 OLLAMA_MAX_LOADED_MODELS=1 ollama serve
```

In another terminal, set up the seller and start it:

```sh
OLLAMA_HOST=127.0.0.1:11435 ollama pull qwen3:0.6b
pnpm node:setup --role seller --mint 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU
pnpm node:tokenizer
pnpm gyblos seller init
pnpm gyblos doctor
pnpm node:start
```

1. `ollama pull` downloads the pinned model. `ollama list` must show ID
   `7df6b6e09427` for `qwen3:0.6b`; another digest makes doctor report
   `ENGINE_UNAVAILABLE`.
2. `node:setup` creates the seller keys (see
   [Roles and files](#roles-and-files)).
3. `node:tokenizer` downloads and verifies the pinned public tokenizer. Doctor
   reports it as `NOT_NEEDED` when every offer's usage is declared by its
   provider.
4. `seller init` asks for the engine (`ollama`, `openai` or `anthropic`), its
   URL (default: the dedicated Ollama above), the model, the daily token caps
   and whether to list the seller in discovery (default no). It writes
   `GYBLOS_CONFIG` or `./config.toml` with one free offer. See
   [`seller init`](#seller-init) below.
5. `doctor` runs the read-only startup preflight. Its last line is
   `Result: READY`, and it prints the seller's public `nodeId` and `owner`.
   `pnpm gyblos doctor --online` also calls remote engines, reads missing
   payment token accounts and warns when this machine's clock is more than 2 s
   off the discovery index.
6. `node:start` runs the seller in the foreground until you press Ctrl-C.

Offer rules (which engines, models and URLs startup accepts, free caps, paid
offers and the fee payer) live in
[configuration.md: Seller startup](configuration.md#seller-startup). To charge
for an offer, see [Get paid](https://docs.gyblos.com/en/sellers/get-paid).

### `seller init`

Without a terminal, `seller init` takes flags and defaults: `--engine`, `--url`,
`--model`, `--upstream-model`, `--context-tokens`, `--api-key-env <NAME>|none`,
`--daily-cap`, `--per-buyer-cap`, `--publish` or `--no-publish`, and `--force`.
It writes the file with mode 0600, because an engine URL may carry a key in its
path. It replaces an existing file only with `--force` and never writes through
a symlink. It writes nothing when the file format or startup's offer rules would
refuse the values. It handles no secret: API keys and the optional relay token
stay in the environment or `seller.env`, and it prints only their variable
names. `examples/seller-daemon.toml` is an equivalent file to copy instead.

### Engine on the same machine

The seller never starts Ollama. Startup warms each offer in order at its own
engine URL, checks memory headroom for engines on this machine, and signs its
public records once one offer is ready. It warms the others again in the
background and lists each one when it is ready.

Use a dedicated Ollama with its own models directory (`OLLAMA_MODELS`), so the
Ollama app cannot remove or replace the model. A shared instance can evict the
pinned model or slow it down, which buyers see as `ENGINE_TIMEOUT` or a
withdrawn offer.

> **Warning:** Never expose the seller's Ollama to the network
> (`OLLAMA_HOST=0.0.0.0` or the app's "Expose Ollama to the network" setting).
> Ollama has no authentication: anyone who reaches it can replace or delete the
> model, and the seller trusts whatever answers on the offer URL. Keep the
> loopback address, and run the seller on a machine where only you can bind
> local ports.

### Stopping the seller

Stop with Ctrl-C, not Ctrl-Z (which only suspends the process). Stopping
withdraws the seller from discovery and saves its public sequence. Further
Ctrl-C presses, and SIGTERM from a supervisor, are ignored with a notice during
that stop, so wait for the prompt.

If a stop hangs, Ctrl-\\ (SIGQUIT) ends the process, but it can interrupt the
withdrawal or a state write and leave a sequence lock. A Ctrl-C during startup,
a crash or `kill -9` can also leave a lock. Run `pnpm gyblos doctor` and follow
the guarded [sequence recovery procedure](discovery.md#seller-duties). Never
reset the persisted sequence high-water mark.

### Running the seller as a service

Once `pnpm gyblos doctor` reports `READY`, the seller can run in the background
and restart with the machine. Run these commands as the account that owns the
seller home and keys, never as root:

```sh
pnpm gyblos seller service install --dry-run
pnpm gyblos seller service install
pnpm gyblos seller service uninstall
```

`--dry-run` prints the unit and changes nothing; `install` writes and starts it;
`uninstall` stops and removes it. If an offer has an `api_key_env`, put its
`NAME=value` line in `<home>/seller.env` (mode 0600) first.

- The service sees only `<home>/seller.env`, plus `GYBLOS_HOME` and
  `GYBLOS_CONFIG` resolved to absolute paths from the directory where you run
  `install`. Install first runs the offline doctor with exactly that environment
  and writes nothing unless it is `READY`, so an API key exported only in your
  shell is reported as missing.
- `seller.env` holds any `api_key_env` variables and, only for a relay that
  requires one, `GYBLOS_RELAY_TOKEN`. It is optional. When present it must be a
  regular file you own, mode 0600, not a symlink. Each line is `NAME=value` with
  no spaces, quotes, `$`, backticks, backslashes, `#`, `~` or shell operators in
  the value, because systemd and the macOS agent read only that form. It may not
  set `GYBLOS_HOME`, `GYBLOS_CONFIG`, `PATH`, `HOME`, shell variables (`UID`,
  `IFS`, `BASH*` and similar) or `NODE_*`, `LD_*`, `DYLD_*`, `TSX_*` or
  `OPENSSL_*` variables. No line, comment included, may contain a backslash or
  carriage return.
- The engine is not part of the service. Run Ollama as its own service (its
  Linux installer creates one) on the offer URL.
- Installing again refuses while a unit exists; uninstall first. The unit runs
  this checkout with the Node that ran `install`, so reinstall after moving
  either.

| Platform | Service                                                                                              | Logs                                 | Limits                                                                                      |
| -------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------- |
| Linux    | systemd user unit `~/.config/systemd/user/gyblos-seller.service`                                     | `journalctl --user -u gyblos-seller` | `MemoryMax` (`--memory`, default and minimum `2048M`), `CPUQuota` (`--cpu`, default `100%`) |
| macOS    | launch agent `~/Library/LaunchAgents/com.gyblos.seller.plist`, while you are logged in               | `<home>/service.log`                 | none; the startup headroom check still applies                                              |
| Windows  | scheduled task `Gyblos\Seller-<id>` at your logon (packaged release only, from `install.ps1` or npm) | `<home>/service.log`                 | none; the startup headroom check still applies                                              |

On Linux the unit stops the seller with SIGINT and waits 120 s for withdrawal.
It restarts the seller on failure but gives up after 5 failed starts in 10
minutes; `systemctl --user reset-failed gyblos-seller` clears that once you fix
the cause. A user unit stops when you log out and does not start at boot unless
lingering is on (`sudo loginctl enable-linger ACCOUNT`, once). On a server where
the seller has its own account, enable lingering, then run the commands in a
login shell of that account (`sudo -iu ACCOUNT`). Replace `ACCOUNT` with that
account's name.

On Windows the task runs `gyblos service-run` with least privilege and no window
(`conhost --headless`); its XML and script live in `%LOCALAPPDATA%\Gyblos`. That
supervisor loads `seller.env` (Notepad's CRLF lines are accepted; reserved names
are matched in any case and also include `SystemRoot`, `ComSpec`, `PATHEXT`,
`USERPROFILE` and `PSModulePath`), appends the seller's output to
`<home>/service.log` and restarts it on failure with the same 5-in-10-minutes
limit. On uninstall it stops the seller like a first Ctrl-C, through its named
pipe, before removing the task. The task stops when you log out.

<a id="seller-registration-beta-invite"></a>

### Seller registration

The discovery index lists only sellers admitted with a one-use invite code
([discovery-index.md](discovery-index.md#beta-registration-invites)). Register
once, then publish:

```sh
pnpm gyblos seller register
```

It asks for the invite code on a terminal, or reads `GYBLOS_INVITE`. It takes no
flags, so the code never goes on the command line. The operator steps, including
Solana enrollment and funding, are in
[Register and publish](https://docs.gyblos.com/en/sellers/register-publish).

What the command does:

1. It checks this home's seller role and that `node:start` would accept the
   configuration and `discovery.url`.
2. It prints the index origin, then sends only the invite code and this home's
   NodeId.
3. If the index accepts the code but the NodeId has no 8004 agent registry
   entry, a terminal offers to register it on Solana devnet. The owner wallet
   pays. The command shows the estimated SOL cost and asks before it signs and
   submits. Simulation always runs before signing, and the final estimate is
   never lower than the first one. On a terminal it waits for missing SOL: it
   reads the owner's balance periodically, never signs while it waits, and gives
   up after three waits. Without a terminal it stops with the funding hint.
4. `Registered` or `Already registered` (a retry with the same code) means the
   seller may publish. Set `publish = true` under `[discovery]` in `config.toml`
   and restart, or run `sh install.sh publish` for an installed seller.

The asset key and the signed attempt are stored privately in the seller home.
Keep that state if a result is uncertain. Running the command again checks the
saved attempt and may resend the identical signed transaction; it never creates
another asset while that attempt is unresolved. When the saved blockhash is
invalid in a finalized view and all three asset accounts are absent, it can
rebuild with the same asset after fresh consent. Expiry does not prove the
earlier transaction never landed or cost a fee. Inconclusive or partial state
needs operator assistance; never delete it. A verified registration under
another asset of the same owner and NodeId is accepted.

Codes before the index is contacted: `SELLER_ROLE_MISSING`,
`SELLER_ROLE_UNREADABLE`, `SELLER_ROLE_NOT_SELLER`, `REGISTER_CONFIG_INVALID`,
`REGISTER_NO_INVITE` (no `GYBLOS_INVITE` and no terminal) and
`REGISTER_INVITE_FORMAT`. Refusals from the index are static codes with a hint:
`DISCOVERY_INVITE_INVALID` (wrong, spent or expired code: ask Gyblos for a new
one), `DISCOVERY_IDENTITY_NOT_REGISTERED`, `DISCOVERY_NODE_REVOKED`,
`DISCOVERY_RATE_LIMITED`, `DISCOVERY_UNAVAILABLE`,
`DISCOVERY_REGISTRATION_REJECTED`, or a 404 `DISCOVERY_HTTP_STATUS` when that
index does not take registrations. The invite code is never printed, although a
terminal shows it as you type.

Publication itself (renewal, retry, shutdown and sequence recovery) is described
in [discovery.md](discovery.md#seller-duties). `GYBLOS_DISCOVERY_PUBLISH` and
`GYBLOS_DISCOVERY_URL` override `publish` and `discovery.url` for one run. Do
not reset `public-sequence-v2.json` or remove a leftover sequence lock by
script. Running your own index is described in
[discovery-index.md](discovery-index.md).

### Seller status

```sh
pnpm gyblos seller status
pnpm gyblos seller status --online
```

`seller status` is read-only and uses the same `GYBLOS_HOME` and `config.toml`
as `node:start`. `--online` also looks this NodeId up in the discovery index,
paging it by the served model names. While the index refuses or fails this
seller's publication, the discovery line adds `publishing refused:` and the
static code the daemon keeps in `status.json`. While a model is served, an
`uptime` line then asks the index for this NodeId's public uptime (the share of
five-minute slots with an accepted presence over 24 hours, 7 and 30 days) and
says `online, last presence … ago` or `offline since …`, and a `github` line
shows the GitHub account the index links to this seller and its state (see
[GitHub verification](#github-verification)); these two are the only requests
that carry the NodeId, which the daemon already publishes to the same index. The
output is described in the
[CLI reference](https://docs.gyblos.com/en/reference/cli#status-and-registration).

`Result: RUNNING` (exit 0) needs an active service and a ready daemon.
`STARTING`, `FAILING`, `STOPPED` and `NOT_CONFIRMED` (no service to confirm the
process) exit 1. `FAILING` names the failed phase, its static code and a hint,
such as `SELLER_RELAY_OFFLINE` when no Gyblos relay answered (check HTTPS and
UDP 7842). Receipt counts cover at most 256 records over 7 days, so a busy
seller sees a lower bound. It writes nothing and prints no buyer, prompt, key or
home location.

From a checkout, `gyblos seller status` service detection covers the systemd
unit or launch agent that `seller service install` wrote. Inside the seller
image (`GYBLOS_CONTAINER=1`) it looks for the daemon in its own container, so
run it with `docker compose exec`, not `docker compose run`, which starts a new
container that cannot see the seller.

Read local operational logs with `pnpm gyblos logs --role seller` (`--follow`,
`--json` and filters); see
[the CLI reference](https://docs.gyblos.com/en/reference/cli#local-operational-logs)
and [diagnostics.md](diagnostics.md).

### GitHub verification

```sh
pnpm gyblos seller verify github <user>
pnpm gyblos seller verify github <user> --gist <gist URL or id>
pnpm gyblos seller verify github --status
pnpm gyblos seller verify github --cancel
```

`seller verify github` shows buyers which GitHub account runs this seller. It
needs a seller the index already knows (registered with `seller register`, or
publishing). The binding has two public halves that anyone can re-check: a gist
owned by `<user>` with a file named `gyblos-proof.txt` that contains the line
`gyblos-node=<NodeId>` (an unlisted gist works too: the index publishes its id,
so the proof is public either way), and a claim signed by the node key naming
the account and the gist, which the discovery index checks
([discovery-index.md](discovery-index.md#github-claims)).

1. The account is lowercased and checked (letters, digits and single hyphens, at
   most 39 characters).
2. The gist: `--gist` if given; otherwise the one this home saved earlier, or
   the one the index already holds for this account. Failing that, if the GitHub
   CLI (`gh`) is installed and signed in as `<user>`, it reuses the proof gist
   an earlier, interrupted run made (found by its description, which names the
   NodeId) or creates one; a failing `gh` ends with `VERIFY_GH_FAILED` and never
   prints its error text. If `gh` is signed in as another account the command
   says so. Otherwise it prints the text to put in a file named
   `gyblos-proof.txt` in a new gist at gist.github.com and asks for its URL on a
   terminal (or, without a terminal, tells you to run it again with `--gist`). A
   gist URL naming another owner is refused (`VERIFY_GIST_OWNER_MISMATCH`).
3. It reads that file's raw text at `<user>`'s own URL, by the same rule as the
   index and stops with `VERIFY_PROOF_MISSING` or `VERIFY_GIST_NOT_FOUND` when
   the proof line is not there yet.
4. It signs the claim with the node key and sends it to the index, which checks
   the gist itself. `Verified` exits 0. Anything else exits 1 with the state and
   what to do: `GIST_NOT_FOUND`, `NODE_ID_MISSING`, or `GITHUB_UNAVAILABLE` (the
   claim stays pending; run it again later). When the index checked this seller
   less than a minute ago (`CHECK_DEFERRED`), a wait of up to 2 minutes is
   waited out once and the claim sent again; a longer one is reported. A
   `DISCOVERY_STALE_CLAIM` answer is re-signed once with a newer time. A
   `DISCOVERY_UNKNOWN_NODE` refusal means the index does not know the seller
   yet: register or publish first.

Progress (account, gist id and last step) is saved in
`<GYBLOS_HOME>/seller/github-verification.json`, owner-only and written
atomically. Each run first asks the index and reads the gist, so stopping it
with Ctrl+C at any point is safe: nothing is signed or sent after Ctrl+C (exit
130), and the next run skips what is done. A saved gist that is no longer on
GitHub is dropped, so a plain rerun makes a new one. Failures lead with a
sentence saying what to do and end with the static code in brackets. A finished
verification run again just says `Already verified`.

`--status` prints the index's view: account, gist URL, state, reason and when it
was last checked. `--cancel` signs a cancel claim, so the index stops linking
the seller to the account, and removes the progress file. The gist stays on
GitHub; delete it yourself. Only `verified` means the index found the proof. The
command prints public identifiers only (NodeId, account, gist URL and the index
origin), never a key or the home location.

### Docker

`compose.yaml` runs a seller from this checkout with its own Ollama. The host
needs only Docker with Compose v2.17 or later. No port is published, because
Iroh connects outbound. The steps with the published image are in
[Install by hand](https://docs.gyblos.com/en/sellers/manual-install); to build
the image from this checkout instead:

```sh
cp examples/seller-docker.toml config.toml
(umask 077; touch seller.env)
docker compose build
docker compose up -d ollama
docker compose exec ollama ollama pull qwen3:0.6b
docker compose run --rm seller setup --role seller --mint 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU
docker compose run --rm seller tokenizer
docker compose run --rm seller gyblos doctor
docker compose up -d
docker compose exec seller gyblos seller status
```

Doctor must end with `Result: READY` before `up -d`. Status reports
`Result: RUNNING` once the seller serves. `docker compose logs -f seller`
follows its output, and `docker compose stop seller` sends SIGINT and waits up
to 120 s for withdrawal.

> **Warning:** `docker compose down -v` deletes the `gyblos` volume, and with it
> the seller's keys and journals. This cannot be undone. Back up the volume
> first, or use `docker compose down` without `-v`, which keeps it.

How `compose.yaml` is built:

- The image (`Dockerfile`) holds the node and the `gyblos` CLI, runs as the
  unprivileged `node` user and has no engine. Its commands are `start` (the
  default), `gyblos ...`, `setup ...` and `tokenizer`. It sets
  `GYBLOS_HOME=/data`, `GYBLOS_CONFIG=/config/config.toml` and
  `GYBLOS_CONTAINER=1`.
- Keys, journals, the public sequence and the tokenizer live in the `gyblos`
  volume (`/data`). `config.toml` is mounted read-only at `/config/config.toml`
  and must exist before the first `up`; compose refuses to create it.
  `seller.env` holds any `api_key_env` variables and the optional
  `GYBLOS_RELAY_TOKEN`. It may be empty; it is ignored by git; keep it
  mode 0600.
- The Ollama engine accepts only a literal loopback URL, so the seller shares
  the Ollama container's network namespace (`network_mode: service:ollama`).
  Ollama listens on `127.0.0.1:11434` there, and the example offer points to it.
  Do not publish its port or set `OLLAMA_HOST=0.0.0.0`. A restarted Ollama
  container gets a new namespace: compose restarts the seller with it, but after
  Ollama restarts on its own (a crash), run `docker compose restart seller`.
- The seller runs with `init: true`, so a stop signal reaches it even during
  startup, and with `stop_grace_period: 120s`.
- The seller container has `mem_limit: 2g` and one CPU, because startup needs
  1.5 GiB of headroom in its own cgroup above the seller itself. Ollama's model
  memory counts in its own container. The host needs cgroup v2, and startup also
  checks 1.5 GiB of available memory on the host or Docker Desktop VM.
- A remote engine (an OpenAI- or Anthropic-compatible URL) needs no Ollama
  service: point the offer at it, put its `api_key_env` variable in `seller.env`
  and remove `ollama` and `network_mode` from the compose file.
- After you edit `config.toml`, run
  `docker compose up -d --force-recreate seller`; a plain `up -d` does not apply
  the edit.

#### Install script

`install.sh` sets up the same seller from a signed release, without a checkout.
The operator steps are in the
[seller handbook](https://docs.gyblos.com/en/sellers/beta-guide); this section
describes what the script does. `https://gyblos.com/install.sh` redirects to the
copy attached to the latest GitHub release
(`https://github.com/Gyblos/gyblos-node/releases/latest/download/install.sh`).

Subcommands: `sh install.sh` installs or updates, then on a terminal finishes
onboarding; `publish` and `unpublish` set `publish` in the installed
`config.toml`; `update` downloads and runs the latest release's installer.

With Docker, it:

- writes `compose.yaml` (this repository's, with the published image),
  `config.toml` (`examples/seller-docker.toml`) and `seller.env` into
  `~/gyblos-seller` (mode 0700; `GYBLOS_DIR` changes it);
- pulls the images and the model, creates the seller keys with the devnet USDC
  mint, downloads the tokenizer and runs `gyblos doctor`;
- starts the seller only when doctor is `READY`.

On a terminal, an unpublished seller then finishes onboarding, asking before
each step: it runs `gyblos seller register` in the container, then asks to
publish. A failed or declined step prints how to continue, and a rerun picks up
where it stopped. With `GYBLOS_GUIDED=0`, or without a terminal, it prints the
steps instead (fund the owner with devnet SOL, `gyblos seller register`,
`sh install.sh publish`). `GYBLOS_TERMINAL` names another answer source; tests
use it.

Behavior worth knowing when you change the script:

- **Reruns.** Rerunning resumes a failed install and updates the seller.
  `config.toml`, `seller.env` and `compose.yaml` are kept, except that a seller
  `image:` from `ghcr.io/gyblos/seller` moves to the installer's release. Any
  other image is the operator's own build and stays. It then recreates the
  seller with the current files.
- **Pinned image.** `DEFAULT_IMAGE` pins one release by version and digest
  (`ghcr.io/gyblos/seller:<version>@sha256:<digest>`). The release workflow sets
  it in the copy attached to each release; the copy in this repository keeps an
  earlier pin. `GYBLOS_IMAGE` overrides it.
- **Mode.** `GYBLOS_MODE` is `docker` or `native`. The default is an existing
  install's mode, else Docker when it runs (see
  [Without Docker](#without-docker)).
- **Update.** `sh install.sh update` downloads the latest release's
  `install.sh`, `install.sh.sha256` and `install.sh.sigstore.json`, checks the
  checksum and, with cosign 3 or later, the release signature. It then renames
  the new installer over this one (or writes `install.sh` in the install
  directory when this one is not a writable file) and runs it with the same
  `GYBLOS_DIR`. Older cosign cannot read the bundle, so the check is skipped
  (refused with `GYBLOS_REQUIRE_SIGNATURE=1`). An installer pinning the same
  image runs again, which completes an update that stopped halfway.
- **Publish.** `publish` and `unpublish` rewrite the installed `config.toml` in
  place (so the container's bind mount keeps working), validate it and recreate
  the seller. An invalid result or an interruption restores the file.
- **Relay token.** It asks for none: the Gyblos relays admit every client. It
  always writes `seller.env` (mode 0600), holding only a comment unless
  `GYBLOS_RELAY_TOKEN` is set. A set token is validated and written only to
  `seller.env`, never printed. A `gyb_` invite code in `GYBLOS_RELAY_TOKEN`
  stops the installer: unset it and enter the code with
  `gyblos seller register`.
- **Update check.** Release builds set `GYBLOS_VERSION` in the image.
  `gyblos seller status` then asks GitHub for the latest release (one bounded
  HTTPS request that sends nothing about the seller) and, when it is newer, ends
  with an `Update:` line. `GYBLOS_UPDATE_CHECK=0` turns it off. A build without
  `GYBLOS_VERSION` checks nothing, and `gyblos --version` prints the version.

#### Image signature

The release workflow (`.github/workflows/release-seller-image.yml`) builds and
signs every release keyless with its GitHub OIDC identity. There is no
long-lived signing key, and each signature is recorded in the public Sigstore
log with this repository and workflow name.

With cosign 3 or later installed, the installer verifies a
`ghcr.io/gyblos/seller` image before pulling it (identity `RELEASE_IDENTITY`,
issuer `RELEASE_ISSUER` in `install.sh`) and stops on a bad signature. Without
cosign, or with an older one, it says the check was skipped; integrity then
rests on HTTPS and the digest the installer pins. The check reads the seller
image from `compose.yaml`, and the installer names any override file or
`COMPOSE_FILE` it does not cover.

With `GYBLOS_REQUIRE_SIGNATURE=1`, each of those cases (no cosign, an older one,
a non-Gyblos image, an override file or `COMPOSE_FILE`) stops the installer
before anything is pulled. The default stays permissive because the pinned
digest already fixes the image bytes; strict mode matters most with
`GYBLOS_IMAGE` or a moving tag.

To verify an image by hand:

```sh
cosign verify ghcr.io/gyblos/seller:<version>@sha256:<digest> \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity-regexp '^https://github\.com/Gyblos/gyblos-node/\.github/workflows/release-seller-image\.yml@refs/tags/v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$'
```

The same workflow signs the installer attached to a release; its Sigstore bundle
and SHA-256 are attached next to it. Name the release so both files come from
the same one:

```sh
base=https://github.com/Gyblos/gyblos-node/releases/download/v<version>
curl -fsSL -O "$base/install.sh" -O "$base/install.sh.sigstore.json"
cosign verify-blob install.sh --bundle install.sh.sigstore.json \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity-regexp '^https://github\.com/Gyblos/gyblos-node/\.github/workflows/release-seller-image\.yml@refs/tags/v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$'
```

Replace `<version>` with the release version and `<digest>` with the image
digest.

#### Without Docker

A release's `install.sh` installs the packaged seller of the same release on
macOS Apple Silicon or Linux (x64, arm64, glibc) when Docker does not run for
this account, or with `GYBLOS_MODE=native`. It says so when Docker is installed
but not usable. Intel Macs and musl Linux are told to use Docker, and Windows to
use [`install.ps1`](#windows). With Docker running, a new install uses Docker;
on Apple Silicon it notes that Docker cannot use the Mac's GPU. An existing
install keeps its mode.

- It downloads `gyblos-<version>-<target>.tar.gz` and its `.sigstore.json` from
  the release, checks the SHA-256 the installer pins (`NATIVE_SHA256_<TARGET>`)
  and, with cosign, the release signature. It unpacks the archive into
  `~/.gyblos/app/` beside the previous release, on the same file system and
  marked complete, so an interrupted download is fetched again. Once doctor
  passes it points `app/current` at it and links `~/.local/bin/gyblos`. The
  release it replaced stays for rollback, also across reruns.
- It uses the machine's own Ollama at `127.0.0.1:11434` and never installs it.
  When Ollama does not answer, it says how to install and start it and stops; a
  rerun continues. It pulls the model with `ollama`.
- It writes `config.toml` and `seller.env` into `~/.gyblos` (`GYBLOS_HOME`
  changes it), creates the keys, downloads the tokenizer, runs `gyblos doctor`
  with `seller.env` and installs the user service
  (`gyblos seller service install`). It replaces an earlier service, so a rerun
  or update runs the current release.
- Registering, `publish`, `unpublish` and `update` work as with Docker, with
  `gyblos` in place of `docker compose exec seller gyblos`. `publish` restarts
  the service, and `update` compares the pinned `NATIVE_VERSION`.

#### Windows

A release's `install.ps1` installs the same release's packaged seller on Windows
10 (1803) or later, x64. The operator steps are in the
[seller handbook](https://docs.gyblos.com/en/sellers/beta-guide#windows). The
script:

- downloads `gyblos-<version>-win32-x64.tar.gz`, checks the SHA-256 it pins
  (`$NativeSha256`, set by `scripts/pin-installer-windows.sh` in the release)
  and, with cosign, the release signature, and unpacks it with Windows' own
  `tar` into `%LOCALAPPDATA%\Gyblos\app\` the same way as `install.sh`;
- once doctor passes, points the `app\current` junction at it, writes
  `%LOCALAPPDATA%\Gyblos\bin\gyblos.cmd` and adds that folder to your user
  `PATH` (not with `GYBLOS_MODIFY_PATH=0`);
- uses the home `%USERPROFILE%\.gyblos` (`GYBLOS_HOME`), created readable only
  by your account, SYSTEM and Administrators, which `gyblos setup` and doctor
  check, and writes `config.toml` and `seller.env` there once, as UTF-8 without
  a byte order mark.

Ollama, the keys, the tokenizer, doctor, the
[service](#running-the-seller-as-a-service), registering and `publish` work as
in [Without Docker](#without-docker). `update` downloads the latest
`install.ps1`, checks its checksum (and signature, with cosign) and runs it.
`GYBLOS_RELEASE_URL` changes where releases are downloaded from (a mirror); the
pinned checksum still applies.

#### npm package

The same packaged sellers are published to npm. `npm install -g gyblos` installs
a small `gyblos` wrapper and, as an optional dependency, only this machine's
`@gyblos/seller-<target>` (macOS arm64, Linux x64 and arm64 glibc, Windows x64).
That package is the release archive with its own Node runtime, so the seller
never runs on the user's Node; npm installs the pinned iroh binding as its
dependency.

Then run `gyblos seller init`,
`gyblos setup --role seller --mint 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`,
`gyblos tokenizer`, `gyblos doctor` and `gyblos seller service install`, with
the machine's own Ollama as in [Without Docker](#without-docker).
`gyblos seller status` says to update with `npm install -g gyblos@latest` and
then reinstall the service, so it restarts on the new code (a service from an
nvm-managed Node follows that Node version). `npx gyblos` runs commands, but the
service refuses to run from a temporary cache (npx, pnpm dlx, bunx).

`pnpm build:npm --version <v>` packs the npm packages from `pnpm build:native`
archives of the same version.

#### Releasing the seller image

A release is a version tag on a commit of `main`. The release workflow
(`.github/workflows/release-seller-image.yml`) then publishes everything;
nothing is committed to the repository:

1. `scripts/release-image.sh` builds the tagged commit alone (`git archive`) for
   amd64 and arm64, pushes `ghcr.io/gyblos/seller:<version>` and `:<commit>`,
   signs the digest and verifies that the signature names this workflow at this
   tag. It refuses a commit outside `main`, an existing version and any run
   outside the workflow.
2. `scripts/release-native.sh` builds and signs the
   [packaged sellers](#building-the-packaged-seller).
3. `scripts/publish-installer.sh` pins a copy of `install.sh` to that image and
   to the packaged sellers (`scripts/pin-installer.sh`), pins `install.ps1` to
   the Windows seller, signs both keyless with the same identity, and creates
   the GitHub release with the installers, their SHA-256 files and Sigstore
   bundles, and the packaged sellers. Only a version newer than the latest
   release by semantic-version precedence (`scripts/semver-newer.mjs`) becomes
   latest, which is what `https://gyblos.com/install.sh` serves, and moves the
   `:beta` tag. An older line's patch never replaces either. Releases are never
   marked pre-release, because GitHub's latest download skips those.
4. When enabled, the `npm` job publishes the [npm packages](#npm-package) with
   provenance. A version already on npm is skipped, and `latest` moves only to a
   newer version.

The package is public, so the image exposes the node's source. Cutting a release
and the one-time repository setup are a maintainer procedure kept outside the
repository.

#### Building the packaged seller

The packaged seller (for installs without Docker) is a folder with its own Node
runtime, so the seller's machine needs no checkout, pnpm or Node:

| Path                   | Contents                                                   |
| ---------------------- | ---------------------------------------------------------- |
| `bin/gyblos`           | Launcher: sets the packaged mode and runs the bundle.      |
| `runtime/node`         | The official Node release binary (and its `LICENSE`).      |
| `lib/gyblos.mjs`       | One bundle of `apps/node/src/bin.ts` and its dependencies. |
| `lib/node_modules/...` | The iroh binding for the target (the only native module).  |

To build it:

```sh
pnpm build:native --version 0.1.0-beta.8 --target darwin-arm64 --target linux-x64 --target linux-arm64
```

Targets are `darwin-arm64`, `linux-x64` and `linux-arm64` (glibc), and
`win32-x64`, whose folder has `bin/gyblos.cmd` and `runtime/node.exe` (Node's
Windows zip, unpacked with `unzip`). Intel Macs and musl Linux keep Docker. Each
archive, `dist/native/gyblos-<version>-<target>.tar.gz`, comes with a `.sha256`.
The build checks the Node archive against the SHA-256 pinned in
`tooling/native-build.ts` and the iroh binding against `pnpm-lock.yaml`.
`--node "$(command -v node)"` reuses this machine's Node and installed binding
for a local build of this machine's target, with no download.

The packaged seller keeps its home and `config.toml` in `~/.gyblos` and runs as
`gyblos start`; `gyblos seller service install` makes the service run the
launcher.

## Buyer

The local buyer runs from a checkout; the installers and the npm package contain
the seller only. The
[desktop app](https://docs.gyblos.com/en/buyers/desktop-app) runs the same buyer
for people who do not use a terminal.

Prerequisites: Node.js 24.22.1 or later and the pinned pnpm, with dependencies
installed.

```sh
pnpm buyer:init
pnpm buyer:chat
```

1. `buyer:init` creates the buyer identity with the devnet USDC mint and saves
   `selection.json`. By default it accepts free quotes from any seller
   registered in the index. See [buyer-init.md](buyer-init.md).
2. `buyer:chat` starts its own local buyer on an ephemeral port and opens a
   terminal chat. It prints the model, the mode (`automatic (free quotes only)`
   or `automatic (free or paid by signed quote)`) and the spending limit, then
   streams each answer. It keeps confirmed turns in memory and sends the whole
   conversation with each question; nothing is written to disk. `/new` starts a
   new conversation, `/exit` quits, and `/settle` closes the reusable payment
   session when one is configured. See
   [payment-sessions.md](payment-sessions.md#terminal-conversation-history).

To serve OpenAI- and Anthropic-compatible clients instead, run one of these
endpoints on `127.0.0.1:4031`:

| Command           | What it executes                                                         | Token                | Concurrency                                   |
| ----------------- | ------------------------------------------------------------------------ | -------------------- | --------------------------------------------- |
| `pnpm buyer`      | Free or paid, chosen from each verified signed quote within the ceilings | `api-token` required | One request at a time (`PAID_BUYER_BUSY`)     |
| `pnpm buyer:free` | Free quotes only; loads no wallet signer, tokenizer or RPC               | none                 | Up to two at once, each on a different seller |

Both use the same `selection.json`. Client setup, formats, tools, coding agents
and errors are in
[Connect your coding tools](https://docs.gyblos.com/en/buyers/use-from-code).
`pnpm buyer:agent <opencode|pi|codex|claude>` prints (or with `--write` updates)
a coding agent's configuration for every model the buyer serves;
`--context <tokens>` passes the sellers' context size (it must match the
verified model limits; without it the generator uses the same 8,192-token
fallback as the desktop app) and `--token-env <NAME>` names the variable holding
the endpoint token.

The automatic buyer can also issue bounded API keys
([buyer-api-keys.md](buyer-api-keys.md)) and keep reusable payment sessions
([payment-sessions.md](payment-sessions.md)).

### Optional buyer selection and discovery

`selection.json` in the buyer home (`$GYBLOS_HOME/buyer`, default
`.local/gyblos/buyer`) is the buyer's whole policy. `buyer:init` writes a valid
one; edit it by hand only for settings the form does not cover. Unknown fields
are refused. It contains:

- `request` (required): `selection` (`modelId`, nullable `variant` and
  `quantization`), exact `reasoning`, nullable `lowestReasoning`, `network`,
  `asset`, `maxTokens`, the canonical decimal ceiling `maxAtomic` (atomic units
  of devnet USDC per request), `priceCeilings` (`inputAtomicPerMtok`,
  `outputAtomicPerMtok`, atomic units per million tokens),
  `minimumBadge: "declared-usage"` and an accepted `retention` array.
- `sellers` (required, may be empty with open discovery): at most 16
  `{ owner, nodeId, relayUrl, directAddresses }` entries, each with an optional
  signed `withdrawal`. These identity bindings must come from an independent
  source, never the seller's own declaration. Relay origins must be configured
  ([Relays](#relays)).
- `discovery` (optional): `{}` uses the default index
  (`https://discovery.gyblos.com/v1`); `baseUrl`, `maxPages` and `open` adjust
  it. `"open": true` admits any listed seller whose 8004 agent registry entry
  matches, for free answers only ([discovery.md](discovery.md#open-discovery)).
  Unknown identities are never enrolled otherwise. The index supplies
  availability hints only; see
  [discovery.md](discovery.md#buyer-runtime-integration) for replay state,
  pagination, cache lifetime and failures.
- `identity` (optional): `{ rpcUrl, reuseMs? }`, the devnet RPC used to check
  each seller's 8004 registration.
- `pinnedNodeId` (optional): use one seller ("choose myself"). A pinned seller
  still passes every filter; `PINNED_SELLER_IN_COOLDOWN` includes
  `cooldownUntil`.
- `failover` (optional): `"safe"` (default) or `"never"`. With `"safe"`, a free
  request whose seller dropped or stalled after the prompt was sent, before any
  visible text, goes to another seller. `"never"` keeps a sent prompt on one
  seller.
- `quoteWindowMs` (optional): how long quotes may race, 100 to 10000
  milliseconds (default 3000). A quote wins as soon as it arrives, so the window
  only bounds how long a slow seller can take.
- `models` (optional): 1 to 32 `{ id, aliases?, selection, maxTokens? }` entries
  that the endpoint serves by name. A client sends `id` or an alias as `model`.
  The list must serve `request.selection.modelId` by name. `GET /v1/models`
  lists them with `max_output_tokens` and `context_length`: the smallest context
  its sellers list in their verified catalogs (configured sellers at the buyer's
  own prices; with open discovery, also the index's free sellers), so a prompt
  sized to it fits whichever seller is chosen. One read that finds it serves 30
  seconds; the field is left out when no seller's catalog can be read within 4
  seconds. An unknown name gets 404 `FREE_BUYER_MODEL_NOT_FOUND`. Paid modes
  refuse to start unless every listed model meets the paid limits.
- `session` is required for a positive request ceiling. Guided setup includes a
  deposit of 1 USDC and a one-hour lifetime. Existing paid profiles can
  [add the session settings](payment-sessions.md#explicit-startup-policy).
- `routing` optionally configures busy-seller handling.

How selection works: the buyer verifies catalog, presence and withdrawal
signatures and bindings, picks candidates, then asks for signed quotes in
parallel without sending the prompt. Seller snapshots have a 10-second
collection budget; a peer that times out does not discard healthy snapshots. A
downgrade cannot win while an exact candidate is pending. Quotes reserve no
capacity. A seller that has not answered when the window closes is cooled down
like one that refused.

`selection-stats.json` beside it stores only local quote successes and failures,
latency, cooldown and nullable wait metadata, written by staged replacement with
mode 0600. It holds no prompts, offers or payment payloads.

### Free v2 buyer endpoint

`pnpm buyer:free` serves free quotes only. It needs the buyer role's public
configuration, `node.key` and `selection.json`. It does not load a wallet signer
or tokenizer, and it does not contact RPC. It enforces zero ceilings even if
`selection.json` allows paid quotes. `pinnedNodeId`, retention filters and
configured relays still apply.

Set `request.reasoning` to `"off"`, `lowestReasoning` to `null` and `maxTokens`
to at most 32768 (default 4096, the sellers' default answer limit; a seller
refuses to quote above its own `free.max_output_tokens`).

If startup fails, it prints `FREE_BUYER_CONFIGURATION_REQUIRED` with a reason
and a next step, for example `BUYER_ROLE_MISSING` (run `pnpm buyer:init` or
`node:setup`), `SELECTION_CONFIG_MISSING` or `SELECTION_CONFIG_INVALID`,
`SELECTION_STATS_INVALID`, `DISCOVERY_STATE_UNAVAILABLE`,
`IDENTITY_STATE_UNAVAILABLE`, `SELECTION_MAX_TOKENS_TOO_HIGH`,
`SELECTION_REASONING_UNSUPPORTED`, `BUYER_NODE_KEY_MISMATCH`, a relay code such
as `INVALID_RELAY_TOKEN_LENGTH`, or `BUYER_PORT_IN_USE`. No path or file content
is printed.

#### Endpoint behavior

The site's [integration guide](https://docs.gyblos.com/en/buyers/use-from-code)
covers the routes, request formats, tools, options and coding agents. These
details matter when you change or debug the endpoint:

- **Routes.** `POST /v1/chat/completions`, `POST /v1/messages`,
  `POST /v1/responses` and `GET /v1/models`. `POST /v1/messages/count_tokens`
  answers an estimate (about four bytes per token over system, messages and
  tools) without contacting a seller.
- **Request bounds.** A conversation holds at most 1024 messages and 256 KiB of
  text. A body declared larger than 384 KiB gets 413 before it is read; a larger
  streamed body gets the same 413 once it passes the limit. Both close the
  connection. Requests must send `Content-Type: application/json`.
- **Browser isolation.** Invalid UTF-8, requests with an `Origin` header and
  other content types get 400, and a foreign `Host` gets 421, so a web page
  cannot reach the endpoint. There is no CORS.
- **Responses API.** It is stateless: `store` must be false, and
  `previous_response_id`, structured `text.format`, custom or other provider
  tools, and audio or file parts are refused with a 400 that names them. For
  Codex sessions, the `web_search` tool, `namespace` tool groups, `reasoning`
  and `web_search_call` records from another provider are left out, and images
  become a short `[image omitted ...]` text. Non-neutral reasoning, sampling
  settings and `parallel_tool_calls: false` are refused, because the signed
  protocol cannot express those constraints. A failure after the stream starts
  is `response.failed` with code `invalid_prompt` and the Gyblos code in
  `gyblos_code`. A conversation larger than the network carries, or one a seller
  refuses as too long, gets `context_length_exceeded`, so Codex compacts it.
- **Status codes.** 400 for an invalid request or one beyond the quote's limits,
  413 for an oversized body, 429 when the endpoint already runs as many requests
  as it can (safe to retry), 503 when no seller could take the request, 504 when
  the 180-second deadline expires, and 500 for an unexpected failure. Whenever
  the prompt may already have reached a seller, or the request is the caller's
  fault, the error carries `x-should-retry: false`. Clients that retry 5xx on
  their own must check it: a retry would resend the prompt, possibly to another
  seller.
- **Refusals.** `FREE_BUYER_INVALID_REQUEST` (400) names the field in
  `error.param` and says why in `error.message`, using fixed text or the
  operator's own limits, never the prompt. In the Anthropic format errors take
  that API's shape and carry the same `code`.
- **Seller failures.** When a seller's engine fails after it accepted the
  request, the code is `FREE_EXECUTION_SELLER_CANNOT_CONTINUE` and
  `error.reason` is `quota_exhausted`, `rate_limited`, `engine_unavailable`,
  `engine_interrupted`, `engine_timeout` or `engine_invalid_response`. Before
  the first token this is a 503 JSON error; mid-stream it is the final SSE error
  event, with `error.usage.completion_tokens`. The buyer does not retry it. For
  `engine_timeout` the message says the seller was too slow: before any text,
  too slow to read a request this size (send it again to try another seller, or
  shorten the conversation); after text, too slow to finish. This holds in the
  OpenAI, Anthropic and Responses formats, for a JSON error and for a stream's
  last event. `FREE_EXECUTION_ENGINE_UNAVAILABLE` is the refusal before
  generation.
- **Diagnostics line.** When a seller drops out of a selection, the buyer prints
  one stderr line:
  `FREE_BUYER_SELLER_FAILED <first 8 hex of the NodeId> <phase> <code>`, with
  phase `identity`, `connect`, `discovery`, `quote` or `timeout`. It carries no
  address, key or error text.
- **Streaming.** Fragments are provisional until a verified terminal and a clean
  end of the Iroh stream. A failure after SSE starts sends a static error and
  closes without `[DONE]` or `message_stop`. A disconnect or deadline cancels
  execution.
- **Failover.** Before the prompt is sent, a failed seller is excluded and
  selection repeats. With `failover: "safe"`, a seller that dropped or stalled
  after the prompt was sent, before any visible text, also triggers a resend: at
  most two resends per request, each counted against the failed seller. An error
  the seller answered itself (busy, caps, engine failure), a refused request or
  a client that left is never resent. No seller runs twice in one request, and
  visible text is never restarted.
- **Concurrency.** `buyer:free` runs up to two requests at once, each on a
  different seller, because a seller serves one request per buyer at a time.
  When every candidate is busy with this buyer's other request, the new request
  waits up to 60 seconds for one to be handed back (an agent often sends a title
  and its main request together), then runs on it; the wait counts against the
  180-second request deadline. Only if none comes back in time is the answer 429
  (`FREE_BUYER_BUSY`); the seller is not cooled down. A third request at once
  gets 429 at the door.
- **Seller preference.** The buyer remembers which seller served a conversation
  (by a digest of its model, system text and first user message, for the last
  256 conversations, in memory only). That seller stays a candidate while
  competitive, and another seller's quote waits up to 500 ms for it. A seller
  that fails while executing weighs less in later selections.
- **Identity.** The buyer checks each seller's 8004 registration again after
  quoting, before admitting the winner; no earlier identity decision is reused.
- **Privacy.** No prompt or response is written to logs, journals or selection
  metadata. The seller that answers can read the prompt: free does not mean
  private or verified.

### Paid v2 buyer endpoint

`pnpm buyer` (the automatic buyer, also used by `buyer:chat` and the desktop
app) verifies each signed quote and executes it accordingly. A quote with both
prices zero runs free, with no payment transaction. A quote with a positive
price opens a payment channel, within the `selection.json` ceilings. A positive
`maxAtomic` is a ceiling, not a mode: the buyer still takes free quotes. Payment
preparation starts only when a positive quote wins.

Paid execution is devnet only and needs:

- a buyer role whose `rpcUrl` serves devnet (checked by its genesis hash) and
  whose wallet holds devnet SOL and devnet USDC. Get them from the
  [Solana devnet faucet](https://faucet.solana.com) and
  [Circle's devnet faucet](https://faucet.circle.com). No Gyblos command funds a
  role;
- the pinned public tokenizer (`pnpm node:tokenizer`), because the buyer
  recounts every answer itself;
- `request.selection.modelId` `qwen3-0.6b`, reasoning `off`, `network` devnet
  and `asset` the role's mint, with `maxAtomic` the maximum charge for one
  response and `priceCeilings` the highest prices it accepts (protocol fee
  included).

If a channel needs recovery, stop the buyer and follow the
[channel recovery guide](recovery.md#reusable-batch-recovery). Never reset or
delete a journal or lock to bypass the block.

#### Endpoint token

The endpoint listens on loopback only and refuses browser requests, but loopback
is not authentication. The automatic buyer therefore requires a bearer token on
every request, including free ones. Its first start creates `api-token` in the
buyer home, a private 0600 file, and later starts reuse it. Send it as
`Authorization: Bearer <token>` or, as Anthropic SDKs do, `x-api-key: <token>`.
A request without it gets 401 `PAID_BUYER_UNAUTHORIZED` with
`x-should-retry: false`, before its body is read. The token is never printed;
read it yourself:

```sh
export OPENAI_API_KEY="$(cat .local/gyblos/buyer/api-token)"
curl http://127.0.0.1:4031/v1/chat/completions \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"model":"qwen3-0.6b","messages":[{"role":"user","content":"Hello"}]}'
```

With an OpenAI SDK, set `baseURL` (`base_url` in Python) to
`http://127.0.0.1:4031/v1` and `apiKey` to the token.

> **Warning:** Anyone who can read `api-token`, or run as your user, can spend
> up to `maxAtomic` of the buyer wallet's devnet USDC per request, and an
> on-chain payment cannot be undone. Run the paid buyer only on a machine you
> control, with a devnet wallet. To rotate the token, stop the buyer, delete
> `api-token` and start it again; `pnpm buyer:free` needs no token.

Startup reasons beyond the free ones: `BUYER_PAYMENT_NETWORK_MISMATCH` (RPC,
network or asset not devnet USDC), `BUYER_PAID_MODEL_UNSUPPORTED`,
`BUYER_PAID_MODELS_UNSUPPORTED` (the explicit paid entry `startPaidBuyer` serves
only `request.selection`; the automatic buyer serves the `models` list),
`BUYER_WALLET_KEY_INVALID`, `BUYER_TOKENIZER_UNAVAILABLE`,
`BUYER_PAYMENT_JOURNAL_UNAVAILABLE` and `BUYER_API_TOKEN_INVALID` (`api-token`
is not a private 0600 regular file with one link, owned by you and holding a
token; it is never repaired, since its token may already have been read).

## Control queries

The seller exposes `catalog.get`, `presence.get` and `offer.request` on the
`gyblos/control/1` protocol, separate from execution. A query never runs
inference, takes a payment or reserves capacity, and never triggers a warmup.
The catalog lists every ready offer; a request for an unsupported reasoning
level or a busy offer is refused. A background lifecycle renews availability
through bounded private warmups and memory checks; a failed or expired check, or
busy inference, blocks availability until a later check succeeds. See
[discovery.md](discovery.md#seller-duties) for timing and cancellation limits.

The programmatic `@gyblos/buyer/control` client connects to one chosen seller
with a caller-owned Iroh endpoint and independently confirmed owner, NodeId and
relay policy. `getCatalog`, `getPresence` and `requestOffer` verify request
correlation, signatures and exact quote terms. It does not choose a seller. Call
`close()` when finished; the endpoint stays owned by the caller. There is no
control CLI.

Quotes indicate observed availability, not guaranteed admission. A record or
quote issued up to 5 s ahead of the buyer's clock is accepted; expiry has no
grace. Keep automatic time sync (NTP) on. Queries have a 10-second absolute
deadline. See [the protocol specification](../packages/protocol/SPEC.md).

## Relays

- Default relay: `https://na1.relay.gyblos.com/`, with QUIC address discovery on
  UDP 7842. Public n0 relays are not used as a fallback.
- The Gyblos relays admit every client, bounded by per-client rate limits.
  Neither role needs a relay token.
- `GYBLOS_RELAY_TOKEN` is optional, only for a relay that requires one
  (`relays.relay_token_env` names a different variable). When set, it must be 32
  to 512 printable characters without spaces, or endpoint binding stops. It is
  sent only to the owned hosts `na1.relay.gyblos.com` and
  `na2.relay.gyblos.com`. Never put it in a relay URL, an offer, a config file
  or a committed env file, and never print it.
- `GYBLOS_RELAYS` overrides the relay list (comma-separated HTTPS origins), for
  example `https://na1.relay.gyblos.com/,https://na2.relay.gyblos.com/`. Both
  roles must use the same list. The buyer accepts an offer's relay only if it is
  in that list.
- Iroh prefers a direct path and falls back to the relay. That never retries a
  paid request.

## Relay-only and privacy

A direct connection shows each peer's IP address to the other.

- `GYBLOS_RELAY_ONLY=1` (seller): binds loopback only, advertises no direct
  addresses and rejects an observed non-loopback direct path.
- `GYBLOS_BUYER_RELAY_ONLY=1` (buyer): binds loopback only, ignores
  `GYBLOS_IROH_BIND` and the seller's direct addresses, and dials only the
  offer's configured relay. An offer without a relay is rejected.
- `GYBLOS_IROH_BIND` sets the UDP bind address; `GYBLOS_IROH_EXTERNAL_ADDR` adds
  a public address to advertise (rejected in relay-only mode).

The relay still sees both peers' IP addresses. Off-host relay-only privacy has
not been measured.

You can test a relay-only seller with its buyer on the same machine. After the
first exchange Iroh may switch to a direct loopback path. Relay-only accepts a
direct path only when its remote address is loopback (`127.0.0.0/8`, `::1` or
`::ffff:127.x.y.z`); a relay-only endpoint binds only loopback, so that path
reveals no address. A local UDP forwarder on loopback (a tunnel or proxy) would
also look like loopback, so do not run one on a relay-only machine.

## Free v2 seller execution

A free offer in `config.toml` starts the control protocol plus the
`gyblos/free/4` (complete response) and `gyblos/free-stream/4` (streaming)
execution protocols. Paid offers use reusable payment channels described in the
protocol specification. Free execution serves a conversation (an optional system
message, then alternating user and assistant turns that start and end with the
user) with reasoning `off`, up to the offer's answer limit
(`free.max_output_tokens`, 4096 by default, at most 32768) within the model's
context. The engine's deadline has two parts: time to read the prompt, 10 ms per
counted input token (a 7000-token agent prompt gets 70 seconds more), and time
to answer, which grows with the requested answer. Together they stay under 170
seconds.

Each offer learns how fast its engine reads a prompt, in input tokens per
second, only from the engine's own timing of the input in each completed answer
(prompts under 256 tokens, and engines that do not time the input, do not
count). A timeout teaches it nothing, since its time also holds queueing, model
loading and hidden reasoning. Buyers send every seller they ask a rough estimate
of each request's size in the quote request, rounded up to a multiple of 1024
tokens, and an offer that would not finish reading it with 15 seconds left
before its deadline refuses the quote with `CONTROL_TOO_SLOW_TO_READ`; the buyer
picks another seller before any prompt is sent. The seller that answered the
conversation's previous turn less than 4 minutes ago is not sent the size, since
its prompt cache likely still holds most of it. A seller from before this field
refuses the sized quote as invalid; the buyer asks it once more without the size
and does not count the refusal against it. The estimate lives in memory: after a
restart the offer accepts every size until it measures again.

### Token caps

`daily_token_cap` applies across all buyers and `per_buyer_cap` per
authenticated NodeId, both counting input plus output tokens
([configuration.md](configuration.md#file-reference-version-1)). The seller
reserves input plus maximum output before inference; only a valid recounted
completion returns unused tokens, and errors or cancellation keep the
reservation. Caps live in memory and reset on restart; renewing availability
does not reset them. The per-buyer cap is best effort: a new NodeId gets its own
allocation, but not more of the shared offer cap.

Token caps belong to each free offer, and each offer has its own readiness: one
offer generating or renewing never makes another's quotes busy. Across the whole
seller, quotes are single-use through expiry, one generation runs at a time, and
`max_free_buyers_per_day` counts buyers across all offers. A quote for an offer
the catalog no longer lists is refused with `CONTROL_MODEL_UNSUPPORTED`; a
selection no offer serves gets `FREE_EXECUTION_UNSUPPORTED`. Startup rejects
quotes issued at or before its startup time, so the seller needs a trustworthy
wall clock across restarts. Disconnecting or retrying never refunds uncertain
work or reuses a consumed quote. No fallback happens after any prompt bytes were
sent, and nothing on this channel authorizes payment.

### Metering modes

Every quote carries the offer's metering mode:

- **Recounted**: the model's public tokenizer is pinned (Qwen3 0.6B). The seller
  counts the prompt and output with it, as the buyer can.
- **Declared**: any other model, served through the `openai` or `anthropic`
  engine. The usage is the provider's, which the buyer cannot check. The seller
  therefore:
  - reserves each message's UTF-8 bytes plus 64 tokens per message for the chat
    template, and never refunds that reservation;
  - stops a stream with `FREE_EXECUTION_LIMIT_EXCEEDED` once it would deliver
    more than 32 bytes per allowed output token;
  - treats a count below one input token, below one output token per 32
    delivered bytes, above `maxTokens` or beyond the model's context as an
    invalid provider response (`SELLER_CANNOT_CONTINUE`, reason
    `engine_invalid_response`);
  - reports a stopped stream's delivered bytes, at most `maxTokens`.

An engine on this machine renews readiness with a one-token private warmup and
memory checks. An engine the seller pays per call renews by describing its model
only and never generates for readiness.

### Free-service availability limits

The seller serves at most `max_free_buyers_per_day` distinct NodeIds per UTC day
(default 1,024, at most 65,536; see
[Seller limits](configuration.md#seller-limits)). A peer with many cheap NodeIds
can fill that table while using little of the daily token budget; new buyers
then get `FREE_EXECUTION_BUSY` until the next UTC day or a restart. Buyers
already tracked keep their own limits. The bound protects memory; it does not
guarantee fair access.

After admission, cancellation keeps the full input-plus-output reservation, even
when no answer arrived, so repeated cancellations across cheap NodeIds can
exhaust the shared daily budget. A generation rejection, including cancellation,
also invalidates cached readiness: quotes stay closed until the next successful
background check (normally a 10-second tick plus probe time).

Free quotes keep the shared quote shape: `authorizer` and `feePayer` hold the
owner's address as placeholders, and both prices and `maxAtomic` are zero. These
fields grant no payment authority, and no payment signer is loaded for them.

## Private free-inference receipts

After a verified free answer, the buyer asks the seller for its signed receipt
on `gyblos/receipt/1`, checks it against its own execution, countersigns it and
stores the pair. This is best effort: a failure never repeats the prompt or
turns a successful answer into a failure. Each role keeps its receipts in
`<home>/<role>/receipts/receipts-v1.json` (directories 0700, files 0600). They
hold signed metadata, not prompts, responses or keys.

Release builds (`GYBLOS_VERSION` set) upload receipts to the metrics collector
at `https://collector.gyblos.com/v1`; there is no opt-out for receipts. They
also send telemetry observations unless `GYBLOS_OBSERVATIONS=off`. A build
without `GYBLOS_VERSION`, such as a checkout, uploads only when
`GYBLOS_COLLECTOR_URL` is set. Receipts include the seller's owner address, and
the collector sees the uploader's IP address. Construction, storage bounds and
the upload cursor are in [receipts.md](receipts.md); the collector is described
in [metrics-collector.md](metrics-collector.md).

## Other settings

Operator environment variables and their `config.toml` equivalents are listed in
the
[configuration reference](https://docs.gyblos.com/en/reference/configuration#environment-overrides)
and [configuration.md](configuration.md); variables take precedence over the
file. Check a file with `pnpm gyblos config validate`. Variables used by this
page but not listed there:

| Variable                  | Meaning                                                                    |
| ------------------------- | -------------------------------------------------------------------------- |
| `GYBLOS_LAB_HOME`         | Lab state home (default `.local/lab`).                                     |
| `GYBLOS_VERSION`          | Set by release builds; turns on receipt upload and the update check.       |
| `GYBLOS_UPDATE_CHECK`     | `0` turns off the update check in `seller status`.                         |
| `GYBLOS_COLLECTOR_URL`    | Collector base URL; https, or http on loopback only.                       |
| `GYBLOS_OBSERVATIONS`     | `off` stops uploading telemetry observations.                              |
| `GYBLOS_BUYER_RELAY_ONLY` | Buyer relay-only mode ([Relay-only and privacy](#relay-only-and-privacy)). |

Ports: the buyer endpoint listens on `127.0.0.1:4031`; the seller reaches its
Ollama at the offer URL on loopback. The lab uses its own ports; see
[lab/README.md](../lab/README.md#lab-ports).

`role.json` and `selection.json` are validated before use: required fields,
Solana addresses, lowercase hex NodeIds, HTTP(S) RPC URLs and canonical positive
decimal-string amounts (`"10"`, not `"0010"`). They reject unknown fields.
Validation errors never echo field values, so an RPC URL with provider
credentials is never printed.
