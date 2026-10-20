# Gyblos Payments

Experimental x402 payments for Gyblos, a P2P inference project. A buyer
authorizes a budget, a seller reports token usage, and a facilitator settles the
charge and returns the unused deposit on Solana. This repository runs
fixed-resource checks, local Ollama inference and an experimental native Iroh
transport between isolated Docker roles and native peers. A native Mac–VPS trial
completed three paid devnet inferences with direct routing at source `2c8eeac`;
see the redacted [real-network report](evidence/gate-0007.json). The Docker NAT
experiment remains partial. Hotspot and broader NAT coverage remain pending;
this result does not validate every subsequent source change.

> **Status:** experimental, Solana **devnet** only. Not audited. Never use
> mainnet keys. Part of [Gyblos](https://gyblos.com) ·
> [Paper](https://gyblos.com/paper).

## How it works

```text
buyer (CLI) ── requests / receives 402 terms ──▶ seller (HTTP + Ollama)
     │ signs a ceiling                              │ reports usage
     ▼                                              ▼
facilitator ── opens & settles a Solana payment channel
                    └── seller paid; unused deposit returned to buyer
```

| Route   | Payment                                 | Facilitator                 | Use                 |
| ------- | --------------------------------------- | --------------------------- | ------------------- |
| `upto`  | Reported usage, within a signed ceiling | Local process in this repo  | Metered inference   |
| `exact` | Fixed price; no unused-budget refund    | x402.org, with PayAI backup | Fixed test resource |

Both routes use the official `@x402/*` SDK pinned to 2.28.0. The buyer
independently recounts inference tokens and detects discrepancies; this does
**not** prevent a dishonest charge within the signed ceiling. The quickstart
uses a test token, **not USDC**; the public fixed-price route uses Circle devnet
USDC.

## Quickstart: make a fixed-resource payment

Requirements: Node.js 22+, pnpm 10.12.1 and access to a Solana devnet RPC. Run
from the repository root. Funding and network confirmation can take several
minutes.

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm gate:setup
# Fund the printed facilitator address with at least 0.05 devnet SOL:
# https://faucet.solana.com
pnpm gate:fund --test-mint
pnpm gate:preflight
pnpm gate:challenge
pnpm gate:run
```

Wallet setup creates isolated buyer, seller, authorizer, facilitator and
test-mint keys in `.local/devnet/`, preserving existing keys. If configuration
already exists, find the facilitator address in its `addresses.facilitator`
field. Provisioning creates a six-decimal SPL test token and accounts; rerunning
it does not mint more tokens when the mint already exists.

The preflight checks devnet, the program, mint and funding. The unpaid challenge
must return HTTP 402 without executing the resource or settling a payment. The
full run starts both hosts and verifies distinct confirmed open/claim
transactions: **10,000 deposited, 4,000 charged, 6,000 returned**, matching
token balances, unchanged buyer SOL, channel distribution and fixed-resource
delivery.

## Run metered inference

Install the Ollama executable and complete the wallet/token setup above first.
Stop other gate hosts, then download the pinned model and run the six cases:

```sh
pnpm gate:inference:setup
pnpm gate:inference
```

Setup downloads Qwen3 0.6B Q4_K_M (about 523 MB of model layers) into
`.local/ollama/models/` and verifies pinned tokenizer artifacts. The gate runs
three honest calls, a deliberately inflated bill, a deliberately reduced bill
and an engine interruption. The buyer checks token counts against a predefined
tolerance.

Measurements append to `.local/devnet/measurements.jsonl` without prompts or
answers. Pricing, tokenization, case classification and measurement details are
in [docs/inference.md](docs/inference.md).

## Experimental Iroh Docker trial

The flat-network PoC keeps payment policy, the interchangeable `Engine`
interface and `Transport` separate. A buyer verifies an owner-signed offer and
the actual Iroh peer identity before forwarding HTTP payment requests through
its loopback proxy. Only the paid inference route reaches the seller; Ollama and
the facilitator stay on seller loopback.

After the test-token and pinned model/tokenizer setup above, with Docker
running:

```sh
pnpm p2p:docker --scenario flat --operator-root /absolute/path/to/funded/checkout
```

The operator checkout supplies isolated devnet funding keys and verified public
model/tokenizer files. Its keys stay on the host. Each container generates and
retains its own role keys in a distinct volume; the seller receives only the
buyer's public address, and the buyer receives a signed offer plus separately
pinned public trust settings. The payout key stays outside both containers.

The command checks real container isolation and blocked HTTP ports before
funding the new facilitator with 0.05 devnet SOL and the buyer with 10,000
atomic test tokens. It then attempts three paid synthetic requests and exports
an allowlisted report to `evidence/gate-0006.json`. Docker requires outbound
access to devnet and the default Iroh relays. Native bindings were exercised on
macOS ARM64 and Linux ARM64.

To reuse the isolated roles for the two-home-network NAT experiment, stop the
previous experiment's containers while preserving its volumes, then run:

```sh
pnpm p2p:docker --scenario nat-direct --volume-prefix gyblos-p2p-EXISTING --operator-root /absolute/path/to/funded/checkout
pnpm p2p:docker --scenario nat-relay --volume-prefix gyblos-p2p-EXISTING --operator-root /absolute/path/to/funded/checkout
```

Use the actual lowercase volume prefix from the local operator record. NAT runs
reuse funded role volumes and do not fund them again. Each actor has one home
network and uses its keyless router as the verified default gateway. Only the
two test routers receive `NET_ADMIN`; actors retain `cap_drop: ALL`. Routers
remain non-root and read-only, with no role keys, privileged mode or published
ports. Their bootstrap sets no-new-privileges before configuring MASQUERADE. The
relay scenario drops inbound WAN UDP on the seller router.

A missing required route stops before payment. The original direct trials are
retained in the report. Follow-up diagnostics reproduced an unsolicited UDP
conntrack collision in the test routers: an early packet could reserve a tuple
and force the peer's source port to change. Routers now drop new WAN UDP
addressed to themselves; replies translated to actors still use the FORWARD
rules.

Run the keyless UDP/conntrack regression without model files, wallets or RPC:

```sh
pnpm p2p:diagnose
```

With an already built P2P runtime image, add native Iroh observations:

```sh
pnpm p2p:diagnose --native-image gyblos-p2p-poc --lab-candidates
pnpm p2p:diagnose --native-image gyblos-p2p-poc --lab-candidates --idle
pnpm p2p:diagnose --native-image gyblos-p2p-poc --lab-candidates --block-udp
```

These commands generate ephemeral native identities, use tmpfs instead of role
volumes, verify the pinned SDK version, and exchange only bounded synthetic
bytes. They authorize no payments and start no model or facilitator. Full
addresses/mappings stay private; console reports contain counts, route classes
and source/image hashes. The base command tests UDP; optional native controls
also test Iroh. The diagnostic's idle workers stop with its own Compose project.

With corrected routers, native direct routing succeeded with explicit lab WAN
candidates, including an idle control. Those candidates remain disabled by
default and do not establish automatic discovery. Default discovery still used
relay: its learned addresses omitted the intermediate lab WAN and shared an
outer public IP. Upstream hairpin failure is a hypothesis, not a demonstrated
cause. A later native Mac–VPS trial observed direct routing and completed paid
devnet inference at source `2c8eeac` ([report](evidence/gate-0007.json)). This
separate trial does not resolve the original Docker public-return cause or turn
the earlier paid NAT-direct case into a passing Docker payment gate.

To discover a usable address automatically **inside the simulated WAN**, run the
separate observer-assisted mode:

```sh
pnpm p2p:diagnose --native-image gyblos-p2p-poc --wan-discovery
pnpm p2p:diagnose --native-image gyblos-p2p-poc --wan-discovery --idle
```

This creates a temporary, unprivileged native Iroh observer on the WAN network.
Each peer connects to its pinned identity using its own endpoint and learns the
socket address observed after NAT. Peers bind random UDP ports; no manual peer
WAN candidate is configured. The tool adds the reflected candidate, verifies
that the same source socket has matching observer-directed and peer-directed
conntrack mappings on both routers, and requires the selected peer path to match
that candidate. Responses and time are bounded; late results cannot add
candidates. Manual candidates and blocked UDP are incompatible with this mode.

Active and idle observer-assisted controls selected direct peer paths. The
observer does not forward inference traffic. This corrects the lab's missing
usable intermediate candidate through explicit, lab-only reflection; it does
**not** change production endpoint discovery or fix public n0 discovery through
the outer NAT. Peer identities/descriptors are still exchanged by the test
orchestrator, not a production registry or rendezvous service. A ten-second
extra discovery wait also left the public-default control on relay. The exact
outer translation/filtering/hairpin cause remains unproven. Real-network tests
remain a separate requirement, and no new payments were run.

To locate missing public IPv4 peer returns without changing forwarding policy:

```sh
pnpm p2p:diagnose --native-image gyblos-p2p-poc --trace-public
```

This mode retains public n0 discovery and excludes observers, manual candidates
and intentional UDP blocking. It waits for a settled descriptor, pauses the
buyer, and installs counter-only rules on the two test routers before releasing
peer traffic. It counts exact candidate probes, ingress before DNAT, unmatched
router input and forwarded peer replies. Known return tuples distinguish
background discovery traffic from peer traffic. Missing/ambiguous counters or
resets are rejected; conntrack `UNREPLIED` is read explicitly, including its
extended IPv4 format. Lack of `ASSURED` alone does not establish no reply.

The measured window showed outgoing probes to both advertised public candidates
on each router, no peer return at either simulated WAN, and only known
server-return UDP arriving. Native application exchanges continued over relay. A
separate private host-only UDP control also received no public-address peer
returns while its same-host local-address control succeeded. The host control
used
[Cloudflare public STUN](https://developers.cloudflare.com/realtime/sfu/get-started/connection-patterns/)
and did not traverse another LAN device. Its mapping stayed unchanged across two
server ports; this does not establish independence for every destination.

These observations locate a public-return failure and show it can occur without
Docker. They do not identify the physical router, ISP/CGNAT or every host filter
as the cause, prove an IPv6 failure, or justify disabling firewalls. Public n0
IPv4 discovery is producing candidates and the SDK is attempting them; a
production discovery fix is not claimed. Router/provider details and a targeted
network correction remain necessary before claiming this path works. Raw
addresses, tuples and host/network observations stay local; no paid gate ran.

Seller startup now requires measured VM/cgroup memory headroom, then one bounded
private synthetic warmup before any offer is signed or readiness is reported.
Headroom is checked again after tokenizer, middleware and transport
initialization, before signing. Generated text is discarded. The 1.5 GiB reserve
is a conservative admission policy, not a proven minimum working set or a future
capacity guarantee. Memory snapshots and OOM deltas are private metadata;
failure aborts startup without an automatic retry. One model/parallel generation
and a bounded queue are explicit. Offers expire four minutes after warmup,
within the five-minute model keep-alive; slow publication cannot extend that
lease. A valid warmup cannot prevent later VM pressure, model eviction or
unrelated processes consuming memory.

The historical runner death was attributed to Docker-VM global OOM by its kernel
record, not to exhausting the seller's 3 GiB limit. Increasing the local Docker
allocation was an operator environment change; the repository does not change
Docker Desktop settings. Keep enough shared-VM headroom for other services.

A private per-run start manifest preserves the journal offset and prefix hash
before payment. Failed preparation may leave containers for local inspection;
stop only that project and preserve its funded role volumes.

Uncertain calls or funding block further authorizations until reconciliation;
there is no automatic payment retry. Private journals remain in each container's
volume. The local operator record `.local/p2p-docker-run.json` identifies the
containers. Preserve their volumes when stopping the experiment, and stop/remove
only this experiment's containers and network before starting another flat run
with the same configured subnet. No ports are published to the host.

Direct peers can see each other's IP addresses. `GYBLOS_RELAY_ONLY=1` restricts
seller binds and advertised candidates and rejects an observed direct path; its
off-host privacy behavior still needs empirical validation. Route labels are
sampled native observations, not a guarantee about every packet. This setting
configures the seller only: the buyer has no enforced relay-only privacy mode.
Requiring a relay route does not hide buyer addressing. This PoC does not verify
model authenticity or response correctness.

### Verify P2P settlement or reconcile zero charge

Preserve the original role, trust, signed offer, journal and call history. The
following command only reads the chain and changes local recovery files after
proving zero charged and complete unused-deposit return:

```sh
pnpm p2p:reconcile --deposit DEPOSIT_SIGNATURE --claim CLAIM_SIGNATURE
```

It verifies finalized transaction identities, token/SOL deltas, the canonical
distributed channel and sponsor fees versus retained channel rent. Proof is
saved before the matching journal can be confirmed; failed calls remain in
history. A charged outcome or unavailable/inconsistent proof keeps recovery
blocked. No signing, funding, submission or payment retry occurs.

For a charged or zero-charge payment, `--audit-only` emits the verified
financial proof without changing journal/reconciliation files. Keep the output
private:

```sh
umask 077
pnpm --silent p2p:reconcile --audit-only --deposit DEPOSIT_SIGNATURE --claim CLAIM_SIGNATURE > .local/p2p/finalized-audit.json
```

The proof includes sponsor starting/ending balances, transaction fees and
retained channel rent; it never infers historical balances from current wallets.
It supports fresh individually settled channels, retained canonical accounts and
no intervening sponsor-balance activity. Unsupported or incomplete data requires
separate investigation, not an inferred refund. See
[recovery limits](docs/limitations.md#verified-p2p-reconciliation-and-reproducible-audits).

A required-route discrepancy or missing telemetry now fails the route check
while preserving known financial confirmation. Post-exchange telemetry errors
cannot replace a paid `200` and receipt. Ingress, per-peer/global work,
connection idle/lifetime and late-handshake ownership are bounded; uncancellable
native jobs can still exhaust pending admission. These corrections have offline
regression coverage only; the physical paid evidence remains bound to `2c8eeac`.

## Pay through a public facilitator

Request **USDC on Solana Devnet** from the
[Circle faucet](https://faucet.circle.com) for the generated buyer address. The
accepted mint is `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`.

```sh
pnpm gate:exact
```

This serves a fixed resource on an ephemeral loopback port for **10,000 atomic
units (0.01 devnet USDC)**. The local wallet provisions token accounts; the
public facilitator pays the payment transaction fee. No local facilitator is
started. The buyer checks network, mint, amount, recipient and fee payer before
signing.

The seller explicitly verifies and settles before executing the resource. The
gate checks confirmation, balance changes, unchanged buyer SOL and replay
rejection. It also rejects untrusted terms and an empty buyer before signing.
Provider selection and uncertainty handling:
[known limits](docs/limitations.md).

## Other commands

Use these after setup. For separate fixed-resource hosts, start the facilitator
and seller in their own terminals, then run the buyer in a third terminal.

| Command                 | Task                                                                                     |
| ----------------------- | ---------------------------------------------------------------------------------------- |
| `pnpm gate:failures`    | Check insufficient funds and expiry; expiry alone waits about 62 s, plus RPC/setup time. |
| `pnpm gate:facilitator` | Start the local `upto` facilitator.                                                      |
| `pnpm gate:seller`      | Start the fixed-resource seller.                                                         |
| `pnpm gate:buyer`       | Execute the fixed-resource buyer against running local hosts.                            |
| `pnpm lint`             | Check source conventions and formatting.                                                 |
| `pnpm typecheck`        | Check TypeScript types.                                                                  |
| `pnpm format`           | Apply formatting and sort imports.                                                       |
| `pnpm format:check`     | Check formatting without changing files.                                                 |

The failure checks require the configured test SPL token. Formatting uses
Prettier with two-space indentation, an 80-column target and wrapped Markdown
prose; `.editorconfig` supplies matching basic editor settings.

## Configuration

| Variable             | Default and behavior                                                                               |
| -------------------- | -------------------------------------------------------------------------------------------------- |
| `GYBLOS_GATE_CONFIG` | `.local/devnet/config.json`, resolved from the working directory.                                  |
| `GYBLOS_RPC_URL`     | Overrides the config's `rpcUrl`; setup initially saves `https://api.devnet.solana.com` when unset. |

Commands do not load `.env` automatically. Changing the config path does not
move journals, measurements or model artifacts; inference requires the isolated
key paths under `.local/devnet/`. Devnet identity is checked using its genesis
hash. Never include keys in logs or shared results.

All HTTP hosts bind to loopback (`127.0.0.1`). Fixed-resource seller: **4021**;
local facilitator: **4022**; gate-owned Ollama: **11436**, or **11437** during
model setup. Inference and public fixed-price sellers use ephemeral ports. Child
Ollama processes use the local model directory and have cloud inference
disabled.

## Project structure

```text
packages/
  config/            @gyblos/config: hosts, paths, networks, limits, versions
  runtime/           @gyblos/runtime: processes, shutdown and atomic JSON
  gate/              @gyblos/gate: setup, funding, journals and gate utilities
  application/       Reusable workflow, accounting and measurement policy
  payments-x402/     upto/exact adapters, trust policies and chain reads
  transport/         Bounded HTTP over loopback or native Iroh
  inference-ollama/  Local generation and pinned public tokenization
apps/
  cli/src/           Runnable CLI composition and result reporting
    inference/       Inference cases, evidence and reconciliation
    exact/           Public-facilitator cases, evidence and reconciliation
  seller/            Fixed-resource, public exact and inference HTTP hosts
  facilitator/       Local upto facilitator
scripts/             Thin setup, funding and compatibility entrypoints
```

## Safety and known limits

- Timeouts are **not** refunds. Uncertain payments block new ones until
  reconciled on-chain.
- Do not delete `.local/devnet/buyer.lock` or a journal to retry; inspect the
  authorization and transactions first.
- Signed seller receipts, model verification, buyer-facing streaming and mainnet
  are not implemented.

Read [docs/limitations.md](docs/limitations.md) for recovery and the full scope.
Contribution rules are in [CONTRIBUTING.md](CONTRIBUTING.md).

## Run offline regression tests

```sh
pnpm test
```

The published suite requires Node.js 22 or later and a platform supported by the
pinned native Iroh binding. It was exercised on macOS ARM64 and Linux ARM64; Mac
Intel has no binding in this version. It needs no private files, wallets,
Ollama, Python or devnet payments. External RPC responses are mocked; local HTTP
and native loopback QUIC exercise middleware and transport boundaries. Public,
hash-checked template fixtures preserve independent renderer regression
coverage. Raw evidence and measurements stay local. Only the explicitly redacted
Docker and real-network reports are eligible for publication.
