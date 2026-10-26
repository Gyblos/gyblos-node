# Local node and discovery acceptance

This lab command reuses the product seller-control constructor, readiness probe,
public-record sequence allocator/publisher, buyer discovery/replay store,
selector and verified quote client. It stops at a signed v2 quote. It never
starts the paid seller daemon, facilitator, RPC, registration or a payment flow.

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
approval. Streaming and 8004 remain subsequent work.

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
