# Local free-inference telemetry

Seller and buyer free execution can emit content-free events through the
existing `TelemetrySink` port. Ordinary seller and free-buyer startup can opt in
to private local file telemetry through `gyblos.toml`; the default is off.
Programmatic sinks remain supported. Paid-path instrumentation, external
collection and OpenTelemetry startup configuration are separate work.

## File telemetry at startup

```toml
[telemetry]
file = true
```

Add this table to a valid `gyblos.toml` and run `pnpm node:start` or
`pnpm buyer:free`. Both read `GYBLOS_CONFIG`, else optional `./gyblos.toml`. An
explicit missing file, any invalid TOML configuration, unknown telemetry fields
and non-boolean `file` values refuse startup with static errors. The buyer
validates the selected whole TOML before opening sockets, but consumes only
`telemetry.file`: its role and selection files still own its other settings. No
environment/flag override or URL is introduced. Omission or `file = false`
constructs no file sink. Enabling is per process startup, not a hot-reload
switch.

The existing file plugin opens lazily on the first event under the role's
`telemetry/` directory owned by `homeLayout`. Startup without execution creates
no telemetry file. The existing diagnostic filename prefix is unchanged. Files
are private (0600) in private directories (0700), with the existing per-record,
queue, file-size and pool/rotation limits; retention is bounded storage, not
scheduled erasure. Records contain identifiers and operational metadata, so they
remain private even though content and credentials are excluded.

Startup owns this configured sink and drains/closes it after stopping the role's
services, also on startup failure. Close is idempotent with a five-second outer
deadline; the file logger has its own bounded drain. A filesystem call already
in progress may finish later: the deadline is not a forced I/O abort.
Persistence failure degrades local health, never inference/admission/retry
policy. Seller node health exposes a `telemetry` snapshot and the returned buyer
host exposes `telemetry()` metadata (`enabled`, `owned`, `closed`, `failed`);
sink failure can become visible on close. No error contents or paths are put in
health. Nothing sends these files elsewhere.

## Composition and ownership

Pass a sink to `createNode({ telemetry: sink })` or
`startFreeBuyer({ telemetry: sink })`. Lower-level seller services accept
`telemetry: { sink, engineKind, now? }`; buyer orchestration gets its sink,
local NodeId, configured selection and optional clock through its dependencies.
Seller startup obtains the engine kind from its own validated offer settings,
never from a model name. No engine adapter knows about telemetry.

A programmatically supplied sink takes precedence over the configured file
plugin; startup never closes or flushes that caller-owned sink. The caller owns
it, including `flush()` and `close()`. Stop the host before closing the sink,
and explicitly flush/close when collecting local logs. When file telemetry is
off and no programmatic sink is supplied, no sink is constructed, closed or
written. For private files, compose `createFileTelemetrySink` with an isolated
`GYBLOS_HOME` and the appropriate role. Existing private runtime log paths,
rotation limits and file modes apply; no new path or filename convention is
introduced. OTel destinations and consent configuration remain separate work.

## Event meanings

- A seller records `request_received` after authenticating the signed quote and
  Iroh peer, before checking the offer policy, readiness and admission.
  Malformed, bad-signature, expired and wrong-peer requests rejected before that
  point emit nothing; telemetry does not legitimize untrusted identities.
- Each buyer execution attempt records its quote-bound request once. A known
  pre-send connection failure emits `refused/connect_failed` and existing policy
  may select another seller. A selection failure emits one `unserved`, without
  claiming a selected seller or request ID. Cancelled/timed-out selection does
  not count as unavailable supply.
- `first_token` means the first non-empty streaming callback resolved while the
  request was still active. It is not observed for non-streaming responses.
- Seller `completed` means its validated result is ready to return; it does not
  attest transport delivery. Buyer `completed` means its execution client
  returned a verified result and cancellation did not win. Buyer usage is the
  verified response's usage, not a new independent tokenizer recount.
- Busy, exhausted caps, invalid policy and stale readiness are static refusals
  before generation. A started execution failure or cancellation emits `failed`.
  Provider messages and arbitrary exception text are never included.
- The buyer recognizes verified remote busy and cap refusals, but still never
  retries after the prompt was sent. Generic remote engine and unsupported
  errors remain failed attempts: those wire codes can also arise after
  generation (for example, an engine that returns text without using streaming
  callbacks). They do not prove the phase.
- Each observer emits its first-token event at most once and one terminal event.
  Late callbacks produce no additional telemetry. Sink or telemetry-clock
  failure cannot affect results, admission cleanup or retry decisions. Prompt
  transmission and callback failure retain the existing conservative no-retry
  rule.

Events contain only the port's known metadata, UTF-8 byte sizes, JavaScript
UTF-16 code-unit lengths, token counts and elapsed milliseconds. Reasoning usage
is `null` because it is not measured. `meteringMode` distinguishes
provider-declared usage from tokenizer recounts; admission estimates are never
recorded as actual completion usage. Timing uses a separately injected telemetry
clock, clamped at zero if it moves backwards, without changing quote/admission
time validation.

The signed quote and catalog do not expose a remote engine kind. Buyer events
therefore use `engineKind: null` with the known seller NodeId. The local
telemetry parser accepts that combination only for buyer observations; seller
observations still require their actual engine kind. This local-port extension
changes no wire messages, signed records or golden vectors. Existing events may
omit the new metering metadata and retain their prior representation.

No event contains messages, text, prompts, responses, signatures, URLs, IPs,
credentials or payment authorizations. `receipt` and `charged` are not emitted.
Buyer and seller observations are distinct: aggregate by role to avoid counting
one inference twice. The aggregate OTel adapter continues to omit peer/request
IDs and model strings; private file records are not public network accounting.

## Verification

Synthetic tests cover complete and streaming execution, failover before sending,
no retry after possible sending, callback errors, cancellation, caps/readiness,
late observations, declared usage and broken sinks/clocks. A real file-sink test
runs both product services under fresh homes and checks private modes, event
counts and absence of content. The startup receipt acceptance also enables TOML
file telemetry through real startup APIs and native loopback Iroh, checks
complete/cancel/failure events once per role/request across restarts, and
inspects content exclusion, bounds and private modes after shutdown. It uses an
in-process memory index and fake provider. Production engines, external
collectors and the paid flow are outside these tests.
