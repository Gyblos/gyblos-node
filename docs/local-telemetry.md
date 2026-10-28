# Local free-inference telemetry

Seller and buyer free execution can emit content-free events through the
existing `TelemetrySink` port. This is a programmatic opt-in; ordinary CLI
startup remains off. There is no TOML/environment switch, default destination,
receipt exchange, paid-path instrumentation or external collection in this
integration.

## Composition and ownership

Pass a sink to `createNode({ telemetry: sink })` or
`startFreeBuyer({ telemetry: sink })`. Lower-level seller services accept
`telemetry: { sink, engineKind, now? }`; buyer orchestration gets its sink,
local NodeId, configured selection and optional clock through its dependencies.
Seller startup obtains the engine kind from its own validated offer settings,
never from a model name. No engine adapter knows about telemetry.

The caller owns the sink, including `flush()` and `close()`. Stop the host
before closing the sink, and explicitly flush/close when collecting local logs.
No sink is constructed, closed or written when one is not supplied. For private
files, compose `createFileTelemetrySink` with an isolated `GYBLOS_HOME` and the
appropriate role. Existing private runtime log paths, rotation limits and file
modes apply; no new path or filename convention is introduced. OTel destinations
and consent configuration remain separate work.

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
counts and absence of content. Production engines, external collectors and the
paid flow are outside these tests.
