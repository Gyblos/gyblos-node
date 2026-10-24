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
- The engine generation counter does not change during discovery/control quotes.
  No paid ALPN is advertised and no inference/payment HTTP service is started.

The JSON result contains mode, clock mode, fixed case IDs and durations only; no
addresses, signatures, keys, prompts, responses, paths or raw errors. Its
`paymentsEnabled` field is always false. Unknown flags and failures emit only a
static error code. SIGINT/SIGTERM cancel waits and trigger cleanup.

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
