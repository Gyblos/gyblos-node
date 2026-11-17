# Telemetry

The seller node and the local buyer record content-free telemetry events for
every inference request they handle, free or paid: when it arrived, its first
token, how it ended, token counts, latency and the network route. Events never
contain prompts, responses, keys or addresses.

Telemetry is separate from [receipts](receipts.md) (signed records of each
request) and from [operational diagnostics](diagnostics.md) (private failure
logs).

## Where events go

Every event goes through the `TelemetrySink` port to each destination that is
on:

| Destination              | Default              | Turn it on or off                                            | Leaves the machine |
| ------------------------ | -------------------- | ------------------------------------------------------------ | ------------------ |
| Metrics collector upload | On in release builds | Off with `GYBLOS_OBSERVATIONS=off`                           | Yes                |
| Private local file       | Off                  | `[telemetry] file = true` in `config.toml`                   | No                 |
| A sink you pass in code  | None                 | `createNode({ telemetry })`, `startFreeBuyer({ telemetry })` | Your choice        |

### Upload to the metrics collector

Release builds of the seller node, the buyer CLI and the desktop app upload
telemetry events, called observations, to the
[metrics collector](metrics-collector.md) at `collector.gyblos.com`. This is on
by default and does not depend on the local file setting. To turn it off, set
this variable before you start the seller or buyer:

```sh
GYBLOS_OBSERVATIONS=off
```

The packaged desktop app passes this setting to the buyer it runs. Signed
receipts are uploaded either way; they have no opt-out.

A build without a release version uploads nothing unless `GYBLOS_COLLECTOR_URL`
is set, so tests and development never use the network. The collector's
[uploader section](metrics-collector.md#uploader-nodes) describes the buffer,
pacing and exactly what is sent.

## File telemetry at startup

To keep a private copy of the events on disk, add this table to `config.toml`:

```toml
[telemetry]
file = true
```

Then start the seller (`gyblos start`, or `pnpm node:start` from a checkout) or
the free buyer (`pnpm buyer:free`). Both read the file named by `GYBLOS_CONFIG`,
else `./config.toml`. The setting is read once at startup; there is no hot
reload, flag or variable for it. Key details are in
[configuration.md](configuration.md).

Startup refuses with a static error when an explicitly named file is missing,
the TOML is invalid, `[telemetry]` has an unknown field, or `file` is not a
boolean. The buyer validates the whole file before it opens sockets, but uses
only `telemetry.file` (and `[diagnostics]`); its role file and `selection.json`
own its other settings.

The file sink:

- opens on the first event, in the role's `telemetry/` directory in the local
  home, so a process that serves nothing creates no file;
- writes private files (0600) in private directories (0700), with per-record,
  queue, file-size and rotation limits; old files rotate out, but nothing erases
  them on a schedule;
- holds identifiers and operational metadata, so keep the files private even
  though they hold no content or credentials.

Startup drains and closes the file sink after it stops the role's services, also
when startup fails. Close is idempotent with a five-second deadline; a
filesystem call already running may finish later. A write failure degrades local
health and never changes inference, admission or retry.

Seller node health exposes a `telemetry` snapshot, and the buyer host exposes
`telemetry()`: `enabled`, `owned`, `closed` and `failed`. Health never holds
error text or paths.

## Composition and ownership

- Pass a sink to `createNode({ telemetry: sink })` or
  `startFreeBuyer({ telemetry: sink })`. Lower-level seller services accept
  `telemetry: { sink, engineKind, now? }`.
- Seller startup takes the engine kind from its own validated offer settings,
  never from a model name. No engine adapter knows about telemetry.
- A sink you pass replaces the configured file sink. You own it: stop the host
  before you call its `flush()` and `close()`. Startup never flushes or closes
  it.
- The metrics collector buffer receives events alongside whichever sink is in
  use.
- For private files from code, compose `createFileTelemetrySink`
  (`@gyblos/telemetry-file`) with an isolated `GYBLOS_HOME` and the role.
  `@gyblos/telemetry-console` writes events to the console, and the
  [OpenTelemetry adapter](#opentelemetry-adapter) turns them into metrics.

## Events

The closed catalogs are `TELEMETRY_EVENTS`, `TELEMETRY_REFUSALS` and related
constants in `@gyblos/protocol/telemetry`.

| Event              | Emitted by    | When                                                                                                                                                    |
| ------------------ | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `request_received` | seller, buyer | Seller: after it authenticates the signed quote and Iroh peer, before policy, readiness and admission. Buyer: once per attempt at a selected seller.    |
| `first_token`      | seller, buyer | The first non-empty streaming callback while the request is still active. Not observed for non-streaming responses.                                     |
| `completed`        | seller, buyer | Seller: its validated result is ready to return (not proof of delivery). Buyer: it received a verified result and cancellation did not win.             |
| `failed`           | seller, buyer | A started execution failed or was cancelled.                                                                                                            |
| `refused`          | seller, buyer | A static refusal before generation: busy, exhausted caps, invalid policy, stale readiness, rejected quote. Buyer: also `connect_failed` before sending. |
| `unserved`         | buyer         | Selection found no seller. No seller or request ID is claimed.                                                                                          |
| `charged`          | seller        | A paid request settled; carries the charged amount, fee, network and asset.                                                                             |
| `receipt`          | (port only)   | Not sent to the metrics collector and not counted by the OpenTelemetry adapter.                                                                         |

Field rules:

- Events carry only the port's known metadata, UTF-8 byte sizes, UTF-16
  code-unit lengths, token counts and elapsed milliseconds.
- Seller `completed` and `failed` on an Iroh data channel carry `path`. `route`
  is the last direct (`iroh-direct`) or relay (`iroh-relay`) path the connection
  used during the request; `routeChanged` is true when an earlier sample saw the
  other one. `unknown` means neither was ever selected, which is a defect to
  investigate.
- Seller `completed` carries `generationMs`, the engine's own generation time,
  when the engine reports it (Ollama does). Output tokens per second is
  `outputTokens / generationMs × 1000`. Neither field is in the signed receipt.
- `meteringMode` says whether usage is provider-declared or a tokenizer recount.
  Admission estimates are never recorded as actual usage. Buyer usage is the
  verified response's usage, not a new recount. Reasoning usage is `null` when
  it is not measured.
- The signed quote and catalog don't expose the seller's engine kind, so buyer
  events use `engineKind: null` with the seller's NodeId. Seller events always
  carry their engine kind.
- Timing uses a separate telemetry clock, clamped at zero if it moves backwards;
  it never changes quote or admission time checks.

Behavior rules:

- Each observer emits at most one `first_token` and one terminal event. Late
  callbacks add nothing.
- Requests rejected before authentication (malformed, bad signature, expired,
  wrong peer) emit nothing, so telemetry never legitimizes an untrusted
  identity.
- One request can produce attempts at more than one seller. A known connection
  failure before sending emits `refused` (`connect_failed`), and the buyer may
  select another seller. With free failover `"safe"` (the default), a free
  request whose seller fails after the prompt was sent, but before any visible
  text, is resent to another seller up to twice; each attempt has its own
  events. With failover `"never"`, and for paid requests, the buyer never
  resends after the prompt may have been sent.
- Generic remote engine and unsupported errors count as failed attempts, because
  those codes can also arise after generation.
- A sink or clock failure never affects results, admission cleanup or retry
  decisions.

## Privacy

No event contains messages, text, prompts, responses, signatures, URLs, IP
addresses, credentials or payment authorizations. Buyer and seller observations
of the same request are separate: aggregate by role so you don't count one
inference twice. Telemetry events are operational data, not verified public
accounting; the metrics collector keeps observations apart from receipt-backed
figures.

## OpenTelemetry adapter

`@gyblos/telemetry-otel` is an optional `TelemetrySink` that turns events into
OpenTelemetry counters and histograms. No node or app uses it: you construct it
with your own exporter and pass it as a sink.

```ts
import { createNode } from '@gyblos/node';
import { createOtelTelemetrySink } from '@gyblos/telemetry-otel';

const telemetry = createOtelTelemetrySink({ exporter }); // your PushMetricExporter
const node = createNode({ telemetry });
```

The adapter reads no environment variables, opens no files, chooses no endpoint,
registers no global provider and starts no periodic task. You supply the
`PushMetricExporter` and own consent and destination; the sink takes ownership
of the exporter, so don't share it with another provider.

### Attributes

Only these attributes leave the adapter: `role`, `engine` (when known),
`streaming`, and the relevant closed-catalog `code`, `reason` or `refusal`. The
route counter adds `route`, `route_changed` and `outcome`. There are no model
labels, NodeIds, request IDs, wallet addresses, prompts, responses, URLs, event
timestamps, receipts, trace IDs or span IDs. For per-model and per-seller
figures, see the [metrics collector](metrics-collector.md). The SDK resource is
empty, and recording uses the root context, so surrounding traces can't supply
exemplars.

### Event mapping

| Event                | Metric(s)                                                                                                                                  | Unit                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------- |
| `request_received`   | `gyblos.requests` counter                                                                                                                  | `{request}`                  |
| `first_token`        | `gyblos.first_token` histogram                                                                                                             | `ms`                         |
| `completed`          | `gyblos.completed` counter; `gyblos.input_tokens`, `gyblos.output_tokens`, `gyblos.reasoning_tokens` counters; `gyblos.duration` histogram | `{request}`, `{token}`, `ms` |
| `failed`             | `gyblos.failed` counter; `gyblos.delivered_output_tokens` counter when known; `gyblos.duration` histogram                                  | `{request}`, `{token}`, `ms` |
| `refused`            | `gyblos.refused` counter                                                                                                                   | `{request}`                  |
| `unserved`           | `gyblos.unserved` counter                                                                                                                  | `{request}`                  |
| `receipt`, `charged` | No metrics                                                                                                                                 | (none)                       |

- A seller `completed` or `failed` event with a network path also adds one
  `gyblos.routes` point (`{request}`).
- A `completed` event with the engine's generation time also records
  `gyblos.output_tokens_per_second` (`{token}/s`): output tokens over generation
  time, without queueing, prompt evaluation or network time.
- Missing reasoning usage is unknown, not zero. Partial output on failure is
  separate from completed output. `duration` includes `code` on failure, so
  successful and failed latencies stay apart.
- Events pass the strict known-field projection first: unknown fields are
  dropped and malformed known fields rejected. There is no per-request dedup, so
  producers emit each lifecycle event once, and buyer and seller series must be
  queried by role.

### Bounds and lifecycle

- 13 fixed instruments (`OTEL_METRICS`), cumulative temporality, at most 128
  attribute sets per instrument (including the SDK's overflow series).
- Fixed histogram boundaries in `OTEL_SETTINGS`: latency
  `0, 10, 50, 100, 250, 500, 1000, 5000, 10000, 60000` ms and rate
  `0, 1, 5, 10, 20, 40, 80, 160, 320, 640` tokens per second.
- Counters use JavaScript numbers, so cumulative values above the safe-integer
  range are approximate. Never use them for settlement.
- Construction, an empty flush and an unused close are inert. SDK state starts
  on the first valid mapped event. Closing an unused sink never touches the
  exporter.
- `emit` is synchronous and never throws. Valid `receipt` and `charged` events
  count as accepted in `TelemetryHealth.emitted`. Invalid events and events
  after close are dropped.
- Nothing is exported without `flush()` or `close()`. Concurrent flushes
  coalesce. Each collect, export, exporter flush and shutdown has a five-second
  deadline; exporters must bound their own I/O, because a timeout can't stop an
  injected promise.
- An export failure sets the sticky health `failed` flag and disables later
  exports for this sink. It never exposes exporter errors or fails inference.
- `close()` rejects new events at once, waits for a running flush, exports one
  last time, shuts down once and returns a stable health snapshot. Repeated
  close or flush after close is safe.

References:
[JS instrumentation](https://opentelemetry.io/docs/languages/js/instrumentation/)
and
[metric cardinality and aggregation](https://opentelemetry.io/docs/specs/otel/metrics/sdk/).

## Tests

- Synthetic tests cover complete and streaming execution, failover, callback
  errors, cancellation, caps and readiness, late observations, declared usage
  and broken sinks and clocks.
- A file-sink test runs both product services under fresh homes and checks
  private modes, event counts and the absence of content.
- The receipts acceptance run enables TOML file telemetry through real startup
  and native loopback Iroh (see
  [lab acceptance scenarios](../lab/docs/node-discovery-acceptance.md)).
- The OpenTelemetry adapter tests use an in-memory exporter with real SDK
  aggregation, closed attribute allowlists, malformed input, high-cardinality
  floods, lifecycle races, failure isolation and export timeouts.
