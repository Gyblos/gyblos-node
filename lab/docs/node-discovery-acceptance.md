# Lab acceptance runs: discovery, free inference, identity and receipts

These lab commands compose real product components (seller control, readiness,
the public sequence allocator and publisher, the reference discovery index, the
buyer discovery and replay store, selection, quotes and execution) over native
encrypted Iroh on loopback. A fake engine, a synthetic registry and an
in-process index stand in for everything external. Run them before you change
the components they cover. [tests/README.md](../../tests/README.md) lists every
acceptance run, including the paid, native-channel, multi-seller and tool-loop
suites.

| Command                                                       | Covers                                                   |
| ------------------------------------------------------------- | -------------------------------------------------------- |
| `pnpm --filter @gyblos/lab-harness acceptance:node-discovery` | Publication through discovery to a signed quote          |
| `pnpm --filter @gyblos/lab-harness acceptance:free`           | Complete free inference, failover, caps and replay       |
| `pnpm --filter @gyblos/lab-harness acceptance:free-stream`    | Streaming free inference and cancellation                |
| `pnpm --filter @gyblos/lab-harness acceptance:identity`       | Read-only 8004 agent registry identity                   |
| `pnpm acceptance:receipts`                                    | Product startup through confirmed receipts and telemetry |

## Rules every run follows

- **Synthetic only.** No command takes an engine, index URL, home or
  configuration override (except `--real-ollama`, below). None contacts the
  deployed discovery index, a live RPC, a wallet or a payment service, and no
  paid ALPN is advertised.
- **Native or nothing.** Iroh is native and encrypted over IPv4/IPv6 loopback
  with relays disabled. There is no TCP or mock fallback: a missing native
  binding fails with a static unavailable error and a nonzero exit code. In
  `pnpm test:lab`, native cases skip when the capability is missing; a skip is
  never an acceptance result.
- **In-process index.** The real `apps/discovery-index` handler runs in process
  with memory storage, development rate counters and an allowlist holding only
  the run's ephemeral seller NodeIds. Index access is injected; global `fetch`
  is refused.
- **Real deadlines.** Record time may be accelerated and background ticks are
  driven explicitly, but transport deadlines, admission and rate quotas keep
  real clocks and limits.
- **Disposable state.** Role homes live under a fresh private temporary root.
  Keys stay in memory. Cleanup runs on success, failure and handled
  cancellation (SIGINT, SIGTERM); a crash or forced kill can leave the
  temporary directory behind.
- **Content-free output.** The JSON result holds fixed case IDs, counters, flags
  and durations. It never holds addresses, identities, signatures, keys,
  prompts, responses, paths or raw errors. Failures print a static code.

### What these runs do not prove

Passing proves local synthetic composition. It does not establish production
capacity, durable daily caps, real engine crash or out-of-memory recovery, real
model behavior or tokenizer accuracy, relay, CGNAT or off-host connectivity,
live registry freshness, the deployed index, paid execution, or Windows ACLs.
Free caps and cancellation counters live in memory and reset when a real seller
restarts (see [limitations.md](../../docs/limitations.md)). Real Ollama, a
second machine, live RPC or the production index each need separate founder
approval.

## Publication to signed quote

```sh
pnpm install --frozen-lockfile
pnpm --filter @gyblos/lab-harness acceptance:node-discovery
```

The run stops at a signed quote. It starts no seller daemon, facilitator, RPC,
registration or payment flow, and its result always reports
`paymentsEnabled: false`. Cases:

- Publication feeds buyer discovery and selection, then a verified,
  buyer-bound quote over Iroh. An unrelated trusted identity forces the
  selector's quote-only result.
- Three readiness renewal cycles produce newer observations and catalogs and
  fresh quotes.
- Injected busy and engine-check failures block control queries and remove the
  listing; recovery produces higher catalog sequences.
- Suspending checks and publication through the exact observation deadline
  rejects stale availability, then recovers.
- A withdrawal rejects replay of a still-valid catalog. Restarting the control
  host reopens the durable sequence file, outranks the index tombstone and gets
  a fresh quote. Reopened buyer state refuses the older observation.
- The engine generation counter never moves during discovery, control quotes
  or refusals.

### Real-engine mode

Run this only when authorized; it is not part of CI:

```sh
pnpm --filter @gyblos/lab-harness acceptance:node-discovery --real-ollama
```

It needs Ollama already running at the product loopback origin with the pinned
model installed. It never downloads, launches or stops Ollama. It uses the real
engine adapter and memory snapshots with wall-clock waits: about 13 minutes plus
engine latency, within a 20-minute deadline. Busy and failure states are still
injected, so it does not show a real crash, forced unload or capacity under
load.

## Complete free inference acceptance

```sh
pnpm --filter @gyblos/lab-harness acceptance:free
```

The buyer uses independently supplied owner-to-NodeId bindings, private replay
metadata and local selection, verifies a signed zero-price quote, then sends the
request from its real loopback chat endpoint over the free Iroh ALPN. Cases:

- A complete answer after publication, discovery, selection and verification,
  then answers across three readiness and sequence cycles on the same seller.
- Busy, check failure and exact availability expiry remove the listing and
  return the expected refusal; recovery permits another answer.
- A seller restart reopens its sequence file. The index and the reopened buyer
  store reject old signed records, and the replay barrier refuses a quote from
  before the restart. The harness refreshes the seller's loopback address
  itself; this is not automatic rediscovery.
- Execution replay, an expired quote and a different authenticated peer are
  refused without generation. A model failure after quoting returns a typed
  engine error, then recovers.
- A fresh seller exhausts both the per-buyer and total daily token caps.
- Failover with two sellers sharing the index:
  - a data dial that fails before sending makes the buyer exclude that seller
    and execute once on the other;
  - with failover `"safe"` (the default), a response lost after generation but
    before any visible text is resent to the other seller: two dials, two
    selections, two generations;
  - with failover `"never"`, the same loss ends after one dial and one
    generation, and the HTTP error tells the client not to retry.
- Query-time generations stay zero, each successful answer has exactly one
  generation per seller attempted, and the paid ALPN is refused.

## Free streaming acceptance

```sh
pnpm --filter @gyblos/lab-harness acceptance:free-stream
```

The run publishes a seller, selects it, gets a verified free quote and sends
`stream: true` to the product buyer endpoint. Cases:

- The engine is held after its first fragment, and HTTP must deliver that
  fragment before the engine is released. The response then carries both
  fragments, the finish reason, final usage and `[DONE]`.
- A second request closes HTTP after its first fragment and must cancel the
  seller's engine.
- Each request makes one selection and one execution attempt. Cancellation keeps
  the full reserved token budget; partial text is provisional until a valid
  terminal frame.

## Complete acceptance with read-only 8004 identity

```sh
pnpm --filter @gyblos/lab-harness acceptance:identity
```

The run loads the product buyer selection with identity resolution enabled. A
loopback HTTP server serves the three read-only registry methods the product RPC
adapter uses, with synthetic accounts signed by ephemeral NodeId keys. The real
8004 reader, owner binding policy and durable identity store verify them; the
index supplies records, never identity. Cases:

- Complete and streaming answers, three readiness cycles, and zero engine calls
  during discovery and control queries.
- An RPC outage and an oversized response, without falling back to manual trust.
- Revocation between quote selection and sending the prompt; an explicit manual
  override that keeps the revocation tombstone; removing that override.
- Reopening buyer state after revocation and after a higher-sequence owner
  change: older claims can't roll back the durable floor. A new owner, a seller
  restart with higher sequences and a higher registry binding restore inference.
- Streaming cancellation reaches the fake engine.
- With two sellers, a response lost after generation never triggers a second
  selection or dial, because this run sets failover `"never"`; the free run
  covers `"safe"`.

## Product startup through private receipt confirmation

```sh
pnpm acceptance:receipts
```

The run calls the public `createNode().start()` and `startFreeBuyer()`
lifecycles with real temporary role files, `config.toml`, selection, discovery
and replay state, and private receipt stores. A parent process owns the home and
starts an isolated child with an allowlisted environment.

- **Engine:** the OpenAI-compatible adapter talks to a deterministic in-memory
  provider with declared usage, so independent token recounts are not checked.
- **Identity:** a loopback RPC serves synthetic 8004 registry reads, starting at
  a sequence above JavaScript's safe-integer range. Only POSTs to that exact URL
  may use local HTTP, and forbidden RPC methods must stay at zero.
- **Transport:** only the native endpoint binding is injected: minimal preset,
  loopback, no relays or address discovery, and the ALPNs product startup asks
  for. This validates encrypted control, free and receipt channels, not
  internet or relay bootstrap.

Cases:

- Publication and discovery, exact signed quotes, and complete and streamed
  answers with matching verified signed receipt pairs in both role stores.
- Restart of both roles with persistent receipts and higher public sequences;
  the index rejects the older signed catalog.
- Registry outage and oversized replies, revocation, manual override and its
  removal, replay of the original binding after a buyer restart, and owner
  changes. Each identity refusal leaves engine attempts, execution dials and
  confirmed receipt counts unchanged.
- Receipt-storage failure, engine failure, stream cancellation and a tiny free
  cap. Failures never re-send the prompt; dials and provider attempts are
  counted. Retention checks use the store's clock and entry bounds with a
  reduced limit; they don't wait seven days.
- Local file telemetry, turned on through TOML for both roles: after shutdown,
  private modes, file bounds, no content, and exactly one request and terminal
  event per role and request. Identity refusals emit buyer-only `unserved`
  events, one per refused request.

### In-process collector persistence and restart

This lab step does not use the product uploader or the metrics collector. It
takes the confirmed pairs from the receipts run through `gyblos/receipt/1`,
verifies them again with the core private collector and stores them with the
telemetry-file backend, inside the temporary workspace. Cases:

- Bounded concurrent submission, then exact keys and fingerprints in the
  private snapshot.
- A separate credential-free process reopens and verifies the snapshot and
  resubmits every pair as an exact duplicate without changing the file; its
  exit and a further reopen prove it released exclusive ownership.
- Cancellation right after spawning, before the child opens the store.
- A one-entry snapshot: capacity refusal without eviction, duplicates at full
  capacity, pre-cancellation and refusal of a seller-only pair, all without
  changing the snapshot bytes.

This proves a clean process restart, not crash or power-loss recovery. It adds
no retention, network collection or public accounting, and a receipt signature
remains an attestation, not proof of truthful usage.
