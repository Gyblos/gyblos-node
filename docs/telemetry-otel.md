# Aggregate OpenTelemetry adapter

## Scope and privacy

`@gyblos/telemetry-otel` implements `TelemetrySink` as an optional, unconnected
metrics adapter. It does not configure the node, read environment variables,
open files, choose an exporter endpoint, register a global provider or start a
periodic task. The caller explicitly supplies a `PushMetricExporter` and owns
consent and destination configuration. Ownership of that exporter transfers to
the sink; do not share it with another provider.

Only these metric attributes leave the adapter: `role`, `engine` (when known),
`streaming`, and the relevant closed-catalog `code`, `reason` or `refusal`.
There are no arbitrary model labels, seller/buyer NodeIds, request IDs, wallet
addresses, prompts, response text, URLs, timestamps from events, signed
receipts, trace IDs or span IDs. Model and per-seller breakdowns and receipt
collection belong to separate work. Operational metrics are not verified public
accounting. The SDK resource is empty; no resource autodetection is performed.
Recording uses the root context, so surrounding traces cannot supply exemplars.

## Event mapping

| Event                | Metric(s)                                                                                                                                  | Unit                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------- |
| `request_received`   | `gyblos.requests` counter                                                                                                                  | `{request}`                  |
| `first_token`        | `gyblos.first_token` histogram                                                                                                             | `ms`                         |
| `completed`          | `gyblos.completed` counter; `gyblos.input_tokens`, `gyblos.output_tokens`, `gyblos.reasoning_tokens` counters; `gyblos.duration` histogram | `{request}`, `{token}`, `ms` |
| `failed`             | `gyblos.failed` counter; `gyblos.delivered_output_tokens` counter when known; `gyblos.duration` histogram                                  | `{request}`, `{token}`, `ms` |
| `refused`            | `gyblos.refused` counter                                                                                                                   | `{request}`                  |
| `unserved`           | `gyblos.unserved` counter                                                                                                                  | `{request}`                  |
| `receipt`, `charged` | No metrics                                                                                                                                 | —                            |

Missing reasoning usage is unknown, not an observed zero. Partial output on
failure is separate from completed output. Duration includes `code` on failure,
so successful and failed latencies are distinguishable. The adapter validates
all events with the existing strict known-field projection, then records only
these measurements. Unknown fields are dropped, malformed known fields rejected.
A terminal event plus its receipt is counted only from the terminal event.
Producers must emit each lifecycle event once: there is no per-request dedup
state, and simultaneous buyer and seller observations must be queried by role.

## Bounds and lifecycle

The OpenTelemetry metrics SDK is pinned to 2.6.0 (API 1.9.0), compatible with
the repository's Node 22 minimum; SDK 3 requires Node 22.15 or newer. There are
eleven fixed instruments, cumulative temporality, a maximum of 128 attribute
sets per instrument (including the SDK's overflow series), and fixed latency
histogram boundaries. No per-request/model/peer table is retained. Finite
nonnegative safe-integer measurements are required by the telemetry port. OTel
counters use JavaScript numbers: cumulative values above the safe-integer range
are approximate; these measurements cannot be used for settlement.

Construction, empty flush and unused close are inert. SDK state is created on
the first valid mapped event. `emit` is synchronous and never throws; ignored
but valid receipt/charged events count as accepted in `TelemetryHealth.emitted`.
Invalid events and emissions after close are dropped. Export failures set the
sticky health `failed` flag and disable subsequent exports for this sink, never
expose exporter errors or fail inference. Closing still attempts shutdown.

`flush` explicitly collects and exports cumulative metrics; concurrent flushes
coalesce. No exports occur without flush/close. Each collection/export/exporter
flush/shutdown operation has a five-second deadline. Exporters must themselves
honor shutdown and bound their own I/O; a timeout cannot forcibly terminate an
arbitrary injected promise. Close rejects new emissions immediately, waits for
an existing flush, performs a final export, shuts down once and returns a stable
health snapshot. Closing an unused sink never initializes or shuts down the
caller-supplied exporter. Repeated close/flush after close is safe.

## Validation

Tests use an in-memory exporter, including real SDK aggregation, empty
resources, closed attribute allowlists, malformed inputs/getters,
high-cardinality floods, receipt double counting, partial usage, lifecycle
races, failure isolation and export timeout. Existing file/console
record-fidelity contract tests remain unchanged: a metrics adapter intentionally
cannot reconstruct complete events. No node integration, network collector,
production telemetry or dashboards are claimed by these tests.

References:
[JS instrumentation](https://opentelemetry.io/docs/languages/js/instrumentation/)
and
[metric cardinality and aggregation](https://opentelemetry.io/docs/specs/otel/metrics/sdk/).
