# Gyblos Payments

Experimental x402 payments for Gyblos, a P2P inference project. A buyer
authorizes a budget, a seller reports token usage, and a facilitator settles the
charge and returns the unused deposit on Solana. This repository runs
fixed-resource checks, local Ollama inference and an experimental native Iroh
transport between isolated Docker roles and native peers. The final paid smoke
on `ba168c4` completed three strictly sequential native Mac–VPS inferences over
required direct Iroh routes, with a devnet test token and persistent facilitator
diagnostics enabled. All six payment transactions finalized; each delivered
answer passed independent recount and a finalized payment audit before the next
request started. See the [commit-bound report](lab/evidence/gate-0008.json).

The [older report](lab/evidence/gate-0007.json) remains historical. The separate
`24af211` attempt completed its first call; its second settled on-chain but left
the buyer uncertain, so its third was never started. That old journal and the
unknown historical 402 cause remain unresolved. This successful new run used
fresh isolated roles and did not retry or clear the old authorization. Docker
NAT-direct did not pass. Hotspot/CGNAT and broader NAT coverage remain untested.
This work was merged into `main` after the final review; issues #17–#23 stay
deferred.

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

## Reproduce checks on another host without payments

Create a source package from a committed revision. `git archive` includes only
tracked files; it does not copy local wallets, journals, logs or installed
packages. Keep the commit and SHA-256 digest with the private operator record:

```sh
GYBLOS_REVISION=$(git rev-parse --verify HEAD)
git archive --format=tar.gz --output="/tmp/gyblos-${GYBLOS_REVISION}.tar.gz" "$GYBLOS_REVISION"
shasum -a 256 "/tmp/gyblos-${GYBLOS_REVISION}.tar.gz"
```

Transfer it over authenticated SSH/SCP and compare its SHA-256 digest with the
local value before extracting into a fresh, empty directory. Install
dependencies on each host; native Mac packages are not a Linux runtime. From
that directory:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm typecheck
pnpm lint
pnpm test
```

An already populated pnpm store can use `--offline` for installation. These
checks need no funded wallets, model or payment service. Native Iroh cases
report explicit capability skips; see [Contributing](CONTRIBUTING.md). Keep role
state in its original private directory, and preserve an uncertain authorization
until it is reconciled. This workflow does not start a buyer, seller or
facilitator.

P2P calls retain a safe failure phase/code, filtered route metrics and bounded
receipt/deposit signature hints in `observedPayment`. Those hints do not confirm
a payment. Read-only proof retries tolerate a temporarily missing deposit index;
post-claim snapshots must reach the known claim slot. A remaining failure blocks
another authorization. See
[reconciliation limits](docs/limitations.md#uncertain-outcomes-and-manual-reconciliation).

## Enforced import boundaries

`pnpm boundaries` statically checks the package layers and reports current, new
and resolved violations against `tooling/boundaries-baseline.json`. It also runs
as part of `pnpm lint`. The checker and its separate regression suites are
TypeScript, included in strict `pnpm typecheck` and ESLint checks, and run
through the existing `tsx` loader. Architectural violations, a nonempty
baseline, analysis failures, configuration errors and resolution errors fail the
command.

`core` owns domain policy; `engine-ollama`, `payments-x402` and `transport-iroh`
are separate adapters; `node` owns composition; gates, scripts and experiments
live in `lab`. Each app is independent. Tests and verification tooling may
inspect every layer. Protocol is independent; config/runtime are shared support
above protocol. Product cannot import lab, adapters cannot import one another,
and apps cannot import other apps.

Use `pnpm boundaries --json` for a structured report and `pnpm boundaries:test`
for the separate synthetic tooling checks. Baseline changes are deliberate:
`pnpm boundaries --update-baseline` can only confirm an empty baseline; normal
checks never rewrite it. Both the current graph and the versioned baseline must
stay empty. Explicit package exports expose the public entries used by tests;
internal imports stay relative to their owning package.

Analysis parses source without executing it. Git checkouts use tracked and
nonignored source files; source archives use the same explicit source roots.
Private and generated trees are excluded, and installed dependencies are
resolved without following their implementations. Source symlinks and linked
source roots are excluded; imports outside the vetted source inventory fail
analysis before their contents are parsed. The verifier remains in `tooling/`
when experimental tools move to `lab/`.

## Private facilitator diagnostics

The standalone facilitator and the P2P seller append private JSONL records to
`.local/devnet/facilitator-diagnostics/` and
`.local/p2p/facilitator-diagnostics/`, respectively, relative to the role's
working directory. Each process reserves a separate `diagnostic-N.jsonl` file;
files use mode `0600`, and their directory uses `0700`. Keep these files out of
Git and public reports.

Records identify the SDK version, process instance, attempt, operation,
deposit/claim phase and ordered stages: received, policy decision, SDK start,
SDK result/exception, and local HTTP finish or early close/error. Only bounded,
validated channel, amount and transaction-signature hints are included. Raw
errors, messages, stacks, payloads, salts, prompts and RPC URLs are excluded
from this new stream. Existing in-memory `/gate/events` and
`/gate/verifications` are separate legacy diagnostics, outside this projection.

The loopback facilitator exposes `GET /gate/diagnostics`: `state`, a canonical
failure `code`, `queued`, `synced`, `dropped`, `rotations` and `closed`.
`synced` advances only after append and filesystem sync; queued records can be
lost on a crash. SDK rejection can retain HTTP 200 from the facilitator and
cause a seller-facing 402. HTTP finish is local completion, not buyer
acknowledgment. Neither record is proof of settlement, refund or delivery.

Logging does not await disk I/O on the payment path. It is bounded to 128
pending entries, 4 KiB per record, 4 MiB per file, 3 budget rotations per
process and 16 named slot files (at most 64 MiB). A crash during reclamation can
leave one extra quarantine file until a later reclamation removes it, and an
unlinked file still open by another process keeps its blocks until it closes;
neither is counted in that bound. When every slot is taken, the oldest settled
`diagnostic-N.jsonl` file owned by this subsystem is deleted after ownership,
link and inode checks; otherwise opening fails closed. Archive files you must
keep privately, because restarts and rotations reclaim the oldest diagnostics. A
full queue, exhausted rotations or persistence failure degrades diagnostic
health and emits a fixed warning without retrying or replacing a payment result.
Files are never truncated or repaired. Mixed legacy layouts that cannot preserve
the bound are refused. Drain and descriptor close share a two-second deadline;
file opening, including rotation, has no deadline. Late disconnected SDK work is
not awaited, and its final diagnostics can be lost at shutdown. See
[diagnostic limits](docs/limitations.md#private-facilitator-diagnostics).

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
an allowlisted report to `lab/evidence/gate-0006.json`. Docker requires outbound
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
cause. The final native Mac–VPS smoke observed direct routing and completed
three sequential paid devnet inferences at source `ba168c4`
([report](lab/evidence/gate-0008.json)). This separate trial does not resolve
the original Docker public-return cause or turn the earlier paid NAT-direct case
into a passing Docker payment gate.

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
distributed channel, sponsor fees, retained channel rent and temporary canonical
escrow-account rent. Proof is saved before the matching journal can be
confirmed; failed calls remain in history. If a process stopped before writing a
call row, complete original identities and the ceiling in its durable journal
can supply that metadata. Conflicting rows or incomplete journals stop recovery;
no delivered call is invented. A charged outcome or unavailable/inconsistent
proof keeps recovery blocked. No signing, funding, submission or payment retry
occurs.

The recovery command can reclaim a buyer lock only after checking a private,
regular, unchanged file, matching its host/boot/PID ownership domain and proving
its recorded local PID is absent. Linux records the boot ID and PID namespace;
macOS reads a bounded boot-session identifier. Legacy, mismatched or unavailable
owner identity requires manual investigation, as do live/reused PIDs, corrupt
metadata and an interrupted recovery lock. Nonblocking, no-follow opens reject
FIFO and link paths. A structured stale-owner audit is synchronized before
removal. Normal exclusive locking remains usable if owner detection is
unavailable; its cleanup preserves replacement files. Audit-only performs no
stale-lock cleanup.

For a charged or zero-charge payment, `--audit-only` emits the verified
financial proof without changing journal/reconciliation files. Keep the output
private:

```sh
umask 077
pnpm --silent p2p:reconcile --audit-only --deposit DEPOSIT_SIGNATURE --claim CLAIM_SIGNATURE > .local/p2p/finalized-audit.json
```

The proof includes the sponsor's pre/post balances and fee/rent conservation for
each selected transaction. It reports unrelated sponsor movement between them
separately, without attributing that movement to fees. Canonical escrow ATA
creation and closure must account for the sponsor's temporary rent advance and
its return; this is separate from retained channel rent and network fees. It
never infers historical token balances from current wallets. Positive net
lamport credits between the selected transactions or after the claim are
reported separately and do not invalidate an otherwise consistent proof.
`retainedChannelRentLamports` is the initial sponsored channel allocation;
actual deposit/claim/current channel snapshots, claim-time changes and interval
or later credits have separate fields. `escrowAccountRentLamports` remains the
initial sponsored ATA allocation. Credits do not identify their sender and are
not token refunds or network fees. Negative channel movement, missing escrow
rent, an underfunded initial channel or deltas that violate the checked
sponsor/channel/escrow equations still stop verification. Supported channels are
fresh and individually settled, with a retained channel account and an escrow
ATA created by the sponsor and closed back to it. Unsupported or incomplete data
requires separate investigation, not an inferred refund. See
[recovery limits](docs/limitations.md#verified-p2p-reconciliation-and-reproducible-audits).

Positive net token credits to the escrow between deposit and claim are also
supported. The entire surplus must be swept to the canonical devnet treasury ATA
for the expected mint. The seller's charge plus the buyer's principal refund
must still equal the original ceiling, and the charge must match the canonical
channel settlement. Treasury surplus is neither a buyer refund nor a fee. Buyer,
seller, escrow and treasury token accounts must be distinct. The selected
deposit permits only buyer-to-escrow token transfers; the claim permits only
escrow-to-buyer, escrow-to-seller and escrow-to-treasury transfers. Incoming
claim-time transfers, prefunded escrow accounts, other mints and unrelated token
movements remain unsupported and fail closed.

Finalized proofs report `escrowInterveningTokenCreditAtomic` and
`treasurySweepAtomic` separately, plus `escrowDepositBeforeAtomic`,
`escrowDepositAfterAtomic`, `escrowClaimBeforeAtomic` and
`escrowClaimAfterAtomic`. The credit is a net interval balance increase, without
donor attribution. `balanceDeltas.escrow` retains the initial-empty/final-empty
endpoint value; the token snapshots expose the intervening surplus. Older
records without these fields do not establish zero surplus. Zero-charge recovery
still requires zero charge and return of the full principal; export re-fetches
that proof. Confirmed paid rows retain their existing journal-based scope.

Paid Docker/NAT reports also expose `preInferenceEscrowExcessAtomic`: the
seller's recorded pre-inference escrow balance minus the original ceiling.
Export requires a positive ceiling, sufficient escrow, charge plus principal
refund equal to that ceiling, unchanged seller balance and one trace matching
the distinct request/channel pair. The original ceiling and balance snapshots
remain intact. This is a local trace observation with the same journal-based
scope as the paid rows; it establishes neither a finalized treasury sweep nor
who funded the excess. Older reports without this field leave the excess
unrecorded.

A required-route discrepancy or missing telemetry now fails the route check
while preserving known financial confirmation. Post-exchange telemetry errors
cannot replace a paid `200` and receipt. Ingress and response delivery each have
a five-second limit; origin work has its own permit and deadline. Established
connections are limited to one per NodeId. Up to eight handshakes are tracked
separately, with two pending jobs per validated source. Connected or actively
working peers reserve up to 30 requests from the shared 256-request minute
budget. After disconnect and completion of active work, unused grace is
best-effort: another admission or quota refill may reclaim it. LRU eviction can
also return inactive unused reservations. Consumed per-NodeId debt is kept
separately until rollover, so eviction, reclamation and reconnection cannot
reset the 30-request allowance. That debt storage is bounded by the 256 actual
admissions per window. Active work and live connections cannot be evicted. At
lease release, unused quota is returned when the identity has no current-window
admitted work and no active operation. Otherwise, inactive quota remains
reclaimable.

A same-identity reconnect can reuse or refill quota when shared capacity
remains; it has no guaranteed reservation against competing work while
disconnected. Every admitted request still counts, including free challenges and
failed origin work. No payment header or HTTP status grants priority. Inactive
reservations can no longer make nine single-request, disconnected identities
deny a newcomer. Once all 256 admissions are actually consumed, both new and
disconnected known peers must wait for rollover. Connected reservations remain
protected. A peer that spends a partial reservation may need to reconnect before
obtaining newly available allowance. About nine identities attempting 30 free
requests each per minute can deny new peers for the window: eight consume 240
admissions and the ninth consumes the remaining 16 of 256. No payment is
required. There is no Sybil resistance or production availability guarantee.

Uncancellable native jobs can still consume their bounded pools. Pending IP
sources use full addresses, including full IPv6 addresses rather than prefixes;
relay sources use the remote endpoint identity. Free identities or multiple
addresses can therefore bypass a single actor's effective source budget. A
shared NAT may see temporary handshake rejection; additional sources can
saturate pending capacity. Relay compatibility and adversarial off-host
admission testing remain unvalidated. The final physical smoke covers the
selected direct paid happy path. Public regressions cover FIFO/process failures,
quota debt and rollover, real loopback Iroh reconnection, malformed frames and
simulated payment delivery failures. Nine single-request, disconnected
identities no longer exclude a newcomer; known peers still refuse work after all
256 actual admissions until rollover. The earlier unconditional
disconnected-grace expectation is superseded by this best-effort contract.

The public finalized payment-pair fixture retains selected historical on-chain
metadata and parsed financial instructions. The real SDK verifier replays saved
finality with an explicitly synthetic current canonical account. Unsigned
full-refund, token-surplus and lamport-credit variants test supported accounting
and rejection boundaries; they were not executed on-chain. Recovery cases run
the actual CLI workflow, ephemeral unfunded offer signing/verification, locks
and temporary-file persistence. RPC is mocked, and persistence-failure cases
also inject rename errors. Export cases use synthetic paid rows/traces, a
separate raw-derived zero-charge proof and mocked container process creation.
These checks establish offline behavior, without a fresh chain audit or physical
signed-offer recovery run. Raw evidence and private measurements remain
excluded. The owner-authorized [final paid report](lab/evidence/gate-0008.json)
is a curated metadata-only exception, bound to the exact tested source
`ba168c4fae043dc1170268cad9c0852d3c7533d9` and its verified source archive.
Later evidence and documentation commits record that run; they do not claim that
another runtime revision was paid-tested.

### Final paid smoke: native Mac seller and VPS buyer

On 2026-10-21, three short synthetic requests ran strictly one after another,
using only the devnet test token. Each CLI invocation and its unchanged
finalized transaction/current-channel audit completed before the next began.
Required-direct admission passed before signing; all sampled 402 and 200
exchanges were direct, with no relay observation. All answers were delivered and
independently recounted within tolerance. Amounts below are atomic units.

| Request | Authorized | Charged | Refunded | Conservation        |
| ------- | ---------- | ------- | -------- | ------------------- |
| 1       | 556        | 140     | 416      | 140 + 416 = 556     |
| 2       | 558        | 139     | 419      | 139 + 419 = 558     |
| 3       | 558        | 147     | 411      | 147 + 411 = 558     |
| Total   | 1,672      | 426     | 1,246    | 426 + 1,246 = 1,672 |

Six distinct selected transactions finalized. Buyer/seller token deltas were
−426/+426; buyer SOL delta was zero. The sponsor paid 60,006 lamports in payment
transaction fees, with 5,852,160 lamports retained as channel rent. Safe
facilitator diagnostics persisted 24 records: six successful SDK settlement
results and six local HTTP 200 finishes, zero dropped records or SDK exceptions.
These observations accompany the independent delivery and on-chain checks.

No request overlapped, became uncertain or was retried. Historical task files
and all 14 existing containers retained their observed metadata; only owned
smoke actors were stopped. The [report](lab/evidence/gate-0008.json) publishes
public signatures, amounts, route categories and source hashes. Keys, salts,
prompts, response content, IPs, endpoint tickets, RPC URLs, raw logs and private
measurements/journals remain excluded. This one configuration does not establish
every packet's path, production discovery, Sybil resistance, model/content
correctness or general recovery. The old uncertain payment remains intact;
issues #17–#23 are outside this frozen scope. The PR is not merged.

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

Gate-owned HTTP servers (facilitator, sellers and the P2P buyer proxy) answer
only requests whose `Host` is `127.0.0.1`, `localhost` or `[::1]` with the exact
listening port. Any other or missing `Host` gets an empty **421** before routing
or body parsing (Node itself answers HTTP/1.1 without `Host` with 400). This
blocks DNS-rebinding reads from a browser; it is not authentication against
local processes.

## Project structure

Stack and technology choices: [docs/stack.md](docs/stack.md).

```text
packages/
  config/            @gyblos/config: hosts, paths, networks, limits, versions
  runtime/           @gyblos/runtime: processes, shutdown and atomic JSON
  protocol/          SDK-independent signed bytes, Engine contracts and error codes
  core/              Reusable workflow, accounting and measurement policy
  payments-x402/     upto/exact adapters, trust policies and chain reads
  transport-iroh/    Bounded HTTP over loopback or native Iroh
  engine-ollama/     Local generation and pinned public tokenization
  node/              Native seller composition with start, stop and health
apps/
  node/              Headless seller daemon and fixed-resource compatibility entry
  buyer/             Buyer proxy, call and reconciliation commands
  facilitator/       Local upto facilitator
lab/
  harness/           @gyblos/lab-harness: gates, journals, CLI cases and scripts
  p2p/               @gyblos/lab-p2p: Docker/NAT experiments and constants
  tools/             Native and public-path diagnostic tooling
  docker/            Isolated test images and topology templates
  evidence/          Previously authorized redacted historical reports only
```

## Safety and known limits

- Timeouts are **not** refunds. Uncertain payments block new ones until
  reconciled on-chain.
- Do not delete `.local/devnet/buyer.lock` or a journal to retry; inspect the
  authorization and transactions first.
- Signed seller receipts, model verification, buyer-facing streaming and mainnet
  are not implemented.

Read [docs/limitations.md](docs/limitations.md) for recovery and the full scope.
The technology stack, why Iroh, and when to use Rust are in
[docs/stack.md](docs/stack.md). Contribution rules are in
[CONTRIBUTING.md](CONTRIBUTING.md).

## Run offline regression tests

```sh
pnpm test
```

The published suite requires Node.js 22 or later and a platform supported by the
pinned native Iroh binding. The earlier suite was exercised on macOS ARM64 and
Linux ARM64; these additional regressions were verified on macOS ARM64. Mac
Intel has no binding in this version. The suite needs no private files, funded
wallets, Ollama, Docker, Python or devnet payments. External RPC responses and
container process creation are mocked; local HTTP and native loopback QUIC
exercise actual middleware and transport boundaries. Lock cases use owned
temporary files and child processes; unsupported ownership/FIFO checks skip
explicitly on other platforms.

Existing test entrypoints register the case groups in `tests/support/`.
`tests/fixtures/finalized-payment-pair.json` is a minimal projection of one
saved finalized deposit/claim pair, not a complete signed transaction or a new
chain query. Public signatures, account addresses and decoded channel-creation
nonce are retained to derive and verify the original PDA; that public on-chain
nonce is separate from private measurement salts. Logs, encoded payment/voucher
payloads, private configuration and content are excluded. Public, hash-checked
model-template fixtures preserve independent renderer coverage. Raw evidence,
measurements and funded keys stay local; only the two explicitly authorized
redacted Docker and real-network reports are published as evidence.
