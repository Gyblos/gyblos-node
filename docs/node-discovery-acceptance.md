# Local node and discovery acceptance

This lab command reuses the product seller-control constructor, readiness probe,
public-record sequence allocator/publisher, buyer discovery/replay store,
selector and verified quote client. It stops at a signed v2 quote. It never
starts the seller daemon, facilitator, RPC, registration or a payment flow.

## Reproduce the synthetic run

```sh
pnpm install --frozen-lockfile
pnpm --filter @gyblos/lab-harness acceptance:node-discovery
```

The default uses a synthetic pinned-model engine and accelerated record time.
Iroh is native and encrypted over IPv4/IPv6 loopback, with relays disabled and
only the control ALPN registered. Transport deadlines and admission retain their
real monotonic clocks. There is no TCP/mock fallback: an unavailable native
binding or loopback capability returns a static unavailable error and a nonzero
exit status. CI tests explicitly skip native cases when that capability is
unavailable; a skip is not an acceptance result.

The actual `apps/discovery-index` handler runs in process with memory storage,
development rate counters and an explicit allowlist containing only the
ephemeral seller NodeId. Its injected HTTP fetch rejects every foreign origin
and never uses global fetch. This is an in-process HTTP handler test, not a TCP
connection to the deployed index. The command has no index URL, home or
configuration flags and does not load `gyblos.toml` or inherit discovery/role
settings.

Both role directories are created under a fresh private temporary root before
product helpers run, so their legacy guards do not inspect cwd-relative
`.local`. Keys exist only in memory. Only public sequence/replay metadata is
persisted in the disposable home; no wallet, payment journal or model artifact
is written. The temporary tree is removed on success, failure and handled
cancellation. A process crash or forced kill can leave that disposable tree
behind.

## What must pass

- Local publication feeds buyer discovery and selection, followed by a verified,
  buyer-bound quote over native Iroh. The intentionally unrelated trusted-v1
  identity forces the selector's quote-only result.
- Three readiness renewal cycles establish newer observations/catalogs and
  permit fresh quotes. Checking intentionally closes availability; this is not a
  promise of uninterrupted admission.
- Injected busy and engine-check failure states block typed control queries and
  remove the listing; recovery produces higher catalog sequences.
- Suspending checks/publication through the exact observation deadline rejects
  stale availability, followed by recovery.
- A withdrawal rejects replay of a still-unexpired signed catalog. Restarting
  the control host with the same in-memory NodeId key reopens the durable
  sequence file, outranks the index tombstone and obtains a fresh quote.
  Reopened buyer metadata refuses the older observation/digest.
- The engine generation counter does not change during discovery/control quotes
  or typed busy, stale-catalog and expired-availability refusals. No paid ALPN
  is advertised and no inference/payment HTTP service is started.

The JSON result contains mode, clock mode, fixed case IDs and durations only; no
addresses, signatures, keys, prompts, responses, paths or raw errors. Its
`paymentsEnabled` field is always false. Unknown flags and failures emit only a
static error code. SIGINT/SIGTERM cancel waits and trigger cleanup.

## Complete free inference acceptance

```sh
pnpm --filter @gyblos/lab-harness acceptance:free
```

This separate synthetic-only scenario extends the existing control procedure;
`acceptance:node-discovery` still stops at a quote. The free command accepts no
arguments, including no engine, index URL, home or configuration override. It
never contacts the deployed index or Ollama. Native unavailability produces a
static failure and nonzero exit status; there is no substitute transport.

The product publisher feeds the actual in-process index with memory storage and
an explicit ephemeral publisher allowlist. The buyer uses independently supplied
owner–NodeId bindings, private persistent replay metadata and local selection,
then verifies a signed zero-price/zero-budget quote. Its actual loopback chat
endpoint sends the input over the separate free Iroh ALPN and returns a complete
response with usage. Seller control, readiness, sequence, publication, free
admission and execution are product components; the lab supplies deterministic
fake generation and token counts. Tokenizer accuracy, TOML/daemon bootstrap and
real model behavior are not accepted by this run.

The cases require:

- A complete HTTP answer after publication/discovery/selection/verification,
  followed by answers across three advancing readiness/sequence cycles on the
  same running seller. Background ticks are driven explicitly with accelerated
  record time. Transport deadlines, admission and rate quotas keep real time;
  none of their limits is relaxed.
- Busy, check failure and exact availability expiry remove the listing and
  return the expected control refusal; recovery establishes newer observations
  and permits another complete answer. Control queries share a connection for
  these cases so accelerated time does not manufacture connection-rate debt.
- Seller restart reuses the in-memory NodeId key and reopens its private public
  sequence file. Old signed records are rejected by the index and the reopened
  buyer store. A still-unexpired quote from before startup is refused by the
  replay barrier. The harness refreshes the configured loopback address after
  restart; this is not automatic endpoint rediscovery.
- Execution replay, an expired quote and a different authenticated peer are
  refused without generation. Expiry and wrong-peer frames intentionally bypass
  only buyer preflight to exercise the seller's actual guards. A model failure
  after quoting returns a typed engine error, followed by recovery.
- A separate fresh free seller exhausts both per-buyer and total daily token
  caps without restarting its admission state. These in-memory counters remain
  resettable by a real seller restart, as documented for the MVP.
- Two separately signed sellers share a local index for failure testing. A
  native data dial fails before sending: the buyer excludes that seller and
  executes once on the other. A response is then deliberately lost after real
  native response bytes arrive: generation has occurred exactly once, the HTTP
  error disallows client retry, and no second data dial or selection occurs.
- Query-time engine attempts and successful generations stay zero, including
  refusal paths. Each successful HTTP answer has exactly one generation, and the
  paid HTTP ALPN is refused. No paid host, facilitator, payment command, RPC
  transport, wallet file or journal is started. Test guards reject any use of
  global fetch; index access is injected and HTTP stays on loopback.

Only the allocated private temporary homes hold sequence/replay/statistics
metadata. Keys, signed quotes and synthetic content remain in memory. Cleanup
runs on success, failure and handled cancellation; forced kills can still leave
the disposable directory. The JSON evidence reports fixed case IDs, HTTP answer
counts, zero query-engine deltas and elapsed/simulated time. It never includes
identities, addresses, signatures, input/output text, paths or raw errors.

This is local, synthetic, non-streaming acceptance. It does not establish
production capacity, durable daily caps, actual engine crash recovery,
relay/CGNAT/off-host connectivity, registry identity or paid execution. Real
Ollama, a second machine or the production index needs separate founder
approval. Separate commands below cover streaming and synthetic 8004 identity.

## Explicit real-engine mode

The following is a separate, opt-in local operation. Run it only when
authorized; it is not part of CI or evidence supplied by the default synthetic
command.

```sh
pnpm --filter @gyblos/lab-harness acceptance:node-discovery --real-ollama
```

It expects an already running Ollama at the fixed product loopback origin and
the already installed pinned model. It never downloads, launches or kills
Ollama. It uses the real product engine adapter and memory snapshots, with wall
clock waits (roughly thirteen minutes plus engine latency, bounded by a
20-minute run deadline and the product check deadlines). Generated private
warmup text is discarded.

Busy/failure controls are still wrapper injections. They do not demonstrate an
actual Ollama crash, forced unload, OOM recovery, physical capacity or reliable
cancellation under load. The default run's accelerated duration is simulated
record time, not a long-running production measurement. This accepts the shared
control components, not paid seller startup or the future TOML wiring.

No production URL is accepted. Publishing to the deployed index remains closed
until the founder approves seller NodeIds. Production, off-host/relay/CGNAT,
registration and paid execution require separate acceptance and authorization.

## Free streaming acceptance

Run `pnpm --filter @gyblos/lab-harness acceptance:free-stream` for the
synthetic-only streaming scenario. It accepts no options and uses the same
in-process memory index, temporary homes and native encrypted loopback as the
complete free acceptance. It publishes a seller, selects it, obtains a verified
free quote and sends `stream: true` to the product buyer HTTP endpoint.

The synthetic engine is held after its first fragment: HTTP must deliver that
fragment before the engine is released. The successful response must then have
both fragments, the finish reason, final usage and `[DONE]`. A second request
closes HTTP after its first fragment and must cancel the actual seller engine,
with one selection and one execution attempt for each request. Reports contain
only counters and flags; no content or endpoints. Native unavailability is a
failure of the standalone command, never a successful fallback.

This verifies composed product services, not full CLI/TOML bootstrap, real model
performance, off-host routing, production discovery or load capacity. Existing
free caps and replay are shared between complete and streaming execution.
Cancellation conservatively keeps the full reserved token budget; counters
remain in memory and reset on restart. Partial text is provisional until a valid
terminal; a stream error or missing terminal is not a successful answer. No
retry or seller switch is allowed after possible prompt transmission.

## Complete acceptance with read-only 8004 identity

```sh
pnpm --filter @gyblos/lab-harness acceptance:identity
```

This synthetic-only command loads the product buyer selection configuration from
its private temporary home with identity resolution enabled. A disposable HTTP
server on an allocated loopback port serves the three read-only registry methods
used by the product bounded RPC adapter. Its synthetic program/Core accounts and
metadata contain real signatures made by ephemeral NodeId keys; the actual 8004
reader, independent owner binding policy and durable buyer identity store verify
them. The discovery index supplies records, never identity authority. There is
no live blockchain, registration, funded wallet or external RPC.

The run requires complete and streaming HTTP answers, three readiness renewal
cycles, and zero engine calls during discovery/control queries. It then
exercises RPC outage and an oversized response without downgrading to manual
trust; revocation between quote selection and possible prompt transmission;
explicit manual override while retaining the revocation tombstone; removing that
override; and reopening buyer state after revocation and after a higher-sequence
owner change. Older claims cannot roll back the durable floor. Updating the
synthetic owner, restarting the seller with higher public sequences and a higher
registry binding restores inference; a still-valid old public record is rejected
by the index. Streaming cancellation reaches the fake engine. With two
independently resolved sellers, losing a real native response after generation
never triggers a second selection or execution dial.

The existing free/control scenarios separately cover engine busy/down/recovery,
quote replay/expiry/wrong peer, caps and pre-send failover. This identity
scenario adds registry-enabled composition; it does not replace those cases or
relax any product limits. Background readiness/publication ticks and record time
are driven explicitly. Reopening real product storage verifies persisted
barriers; the test runner remains one process. Seller endpoint addresses are
refreshed explicitly after restart. This is not full CLI/TOML bootstrap or
automatic address discovery.

The command accepts no arguments. Index access stays injected in-process; RPC
uses only allocated loopback HTTP and native Iroh uses encrypted loopback with
relays disabled. No paid services start. A missing native runtime is a nonzero
static unavailable result, never a successful fallback. Output contains fixed
case IDs, counters and flags only, with no identity, endpoint, signature or
content. Cancellation and completion close the registry, buyers, sellers and
temporary homes; a forced kill can still leave a disposable temporary directory.

Passing proves synthetic local composition, not chain freshness/finality,
production identity-provider behavior, real model performance, off-host routing,
load capacity or production discovery. Real Ollama, a second machine, live RPC
or the production index requires separate founder authorization.

## Product startup through private receipt confirmation

```sh
pnpm acceptance:receipts
```

This synthetic-only scenario calls the public `createNode().start()` lifecycle
and `startFreeBuyer()`, loading real temporary role files, `gyblos.toml`,
selection configuration, discovery/replay state and private receipt stores. The
actual in-process discovery index uses memory storage and an explicit seller
allowlist. The OpenAI-compatible engine adapter talks only to a deterministic
in-memory provider with declared usage; no provider account, API key, model
download or Ollama process is used. This does not validate independently
recounted tokens.

Identity resolution is enabled through the buyer’s ordinary selection file. An
owned loopback HTTP RPC serves only synthetic 8004 registry reads; the actual
product reader verifies the signed owner–NodeId binding and persists its trust
floors. The registry starts with a sequence above JavaScript’s safe integer
range. Discovery is never identity authority.

Only native endpoint binding is injected: real Iroh uses its minimal preset,
IPv4/IPv6 loopback, no relays or address discovery, and the ALPN flags passed by
product startup. Relay-online waiting is unnecessary for this isolated binding.
This validates the startup composition and encrypted control/free/receipt
channels, not ordinary Internet/relay bootstrap. The buyer's allocated HTTP URL
is used to send both complete and streaming requests.

The run checks publication and buyer discovery reads, exact signed quotes,
complete/streamed answers, matching independently verified signed pairs in both
role stores, restart of both roles with persistent receipts and higher public
sequences, and index rejection of the still-valid older signed catalog. It also
checks registry outage and oversized replies, revocation, explicit manual
override and its removal, byte-identical original binding replay after buyer
restart, and a higher-sequence owner change. The old configured owner is
refused; an older binding cannot roll back persisted history. A newer binding
back to that configured owner restores full/streamed execution and confirmed
receipts after restarting both roles. This tests binding policy, not owner-key
migration or a live registry. Each identity refusal must leave engine attempts,
execution dials and confirmed receipt counts unchanged. Manual override
preserves the revocation tombstone and performs no registry reads.

The run also checks receipt-storage failure, engine failure, stream cancellation
and a tiny configured free cap. Failures never re-send the prompt: execution
dials and provider attempts are counted. Queries perform no generation before
the first execution. Unsafe receipt modes are restored after the negative case.
Retention checks use the production store's clock/entry-bound ports to prove
logical expiry and eviction with a reduced bound; they do not wait seven days or
stress the maximum store size. Files remain private and contain metadata only.

The command accepts no arguments or operational overrides. A parent owns the
fresh home and launches an isolated child with an allowlisted environment. Only
its synthetic index/provider fetches are allowed; every other fetch is refused,
including external RPC and the deployed index. Only POSTs to the exact owned
registry URL may use local HTTP, and forbidden RPC methods must remain zero. The
paid ALPN is absent. Output contains fixed case IDs, counters and flags, without
content, identities, signatures, addresses or paths. Parent
cancellation/deadline closes the child before removing the owned home, with a
bounded forced-kill fallback. Output/error capture is bounded and sanitized.
Native failures or test skips never count as acceptance.

No payments, devnet transactions, deployments, real engine, live identity RPC,
production index, second machine or Windows ACL validation is included. Those
require separate authorization and evidence.

The startup receipt scenario also opts both roles into local file telemetry via
TOML. After shutdown it checks private modes, the existing record/file/pool
bounds, no content/provider URL, and exactly one request plus terminal event per
role/request across restarts. Complete, streaming, engine failure, cancellation
and cap refusal remain part of the same no-retry scenario. This checks local
records only, not public metrics or external exporters. Identity refusals emit
buyer-only unserved observations with no selected seller or request ID; their
count must match the refused HTTP requests. The metadata-only report includes
registry-read, forbidden-method and refusal counters, never registry accounts or
identity details.
