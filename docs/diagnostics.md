# Operational diagnostics

Operational logs explain where a local operation failed. Inference telemetry
describes measured activity; receipts describe execution evidence. Their
schemas, activation and retention are independent. Enabling telemetry does not
enable an operational log exporter. There is no central log upload in this
implementation.

## Current coverage

- The buyer compatibility HTTP boundary records admission refusals, invalid
  input, execution failures, request deadlines and client disconnects. A
  terminal failure is emitted once per admitted chat request. Debug mode also
  records successful chat/count-token completion; it never captures content.
- Tool acceptance workers emit validated phase frames while starting,
  requesting, verifying, cancelling and closing resources. On failure the parent
  adds observed child exit code, signal and stdout/stderr byte counts. Raw child
  stderr is never copied into a diagnostic. If the child never starts, the last
  known phase is startup. A phase is the last observed boundary, not proof of an
  underlying cause.
- Cleanup errors are separate records. `withDiagnosticCleanup` preserves the
  original thrown value, including `undefined`; cleanup failure after successful
  work still fails the operation.

This is initial coverage, not instrumentation of every seller, transport,
discovery or payment path. Existing service output is not retroactively
sanitized by this channel. No deadline, concurrency, retry or economic policy is
changed.

## Ownership and record contract

`packages/runtime` owns the envelope, severity/outcome/cause vocabularies,
projection, bounded private persistence and read-only reader. Each producer owns
its canonical component, operation, phase, scenario and error-code catalogs in
its `constants.ts`. Supply these catalogs to `createDiagnostics`; map unknown
errors to a known code and a fixed cause category. Never accept arbitrary
`.code`, `.message`, `.stack` or `.cause` values from a thrown object.

Records contain schema version, random event and correlation IDs, UTC timestamp,
build version (`source` for source runs), level, component, operation, phase,
canonical code, outcome, cause category and monotonic elapsed milliseconds.
Optional child fields are scenario, exit code, signal and output byte counts.
IDs are generated locally, not taken from client headers, receipt digests or
identities. There are no prompts, responses, model names, payloads, endpoints,
addresses, payment signatures, authorization headers or raw exception strings.

Projection uses own data properties, ignores unknown fields and never invokes
getters or `toJSON`. The file reader parses external input as `unknown`,
validates the common envelope and prints only projected metadata. Producer
catalogs provide semantic validation; the generic CLI cannot infer an app's
closed vocabulary. Unknown complete records fail with `DIAGNOSTICS_UNAVAILABLE`;
an unfinished last line is withheld. Existing files are never repaired by the
reader.

## Local configuration and lifecycle

The buyer reads these independent `config.toml` controls at startup:

```toml
[diagnostics]
enabled = true
level = "warn"

[telemetry]
file = false
```

Diagnostics default to enabled with minimum level `warn`. Levels in order are
`debug`, `info`, `warn`, `error`; `debug` changes metadata verbosity only. There
is no environment override for these controls. Seller startup accepts the
section, but seller failure boundaries are not instrumented by this change.

Path computation belongs to `packages/config/src/home.ts`:

- Product: `<GYBLOS_HOME>/<buyer|seller>/diagnostics/`.
- Lab: `<GYBLOS_LAB_HOME>/diagnostics/` when explicitly composed by the caller.

The runtime logger is lazy: no file is created until an enabled event meets the
minimum level. The buyer owns and closes its logger after its resources stop;
the returned host exposes `diagnostics()` health. A library caller can instead
inject a `DiagnosticSink` into `startFreeBuyerHttp`; that caller owns its sink.
Sink callbacks must be synchronous and nonblocking; thrown callback errors are
isolated, but an arbitrary blocking callback cannot be made nonblocking by a
logger.

`runToolAcceptance({ diagnostics })` accepts the same sink. Its default writes
safe failure JSONL to stderr, which the local test runner can capture. It does
not silently open a parent product or lab home. To retain lab failures, compose
`createDiagnosticLog(labLayout(environment).diagnostics)` with an explicitly
selected lab environment, pass `log.write`, and await `log.close()` in
`finally`. Child homes remain temporary and are cleaned up normally. Use
temporary homes in tests; never use a real operator profile for validation.

## Bounds and evidence limits

Storage reuses `private-log`: private directories/files, no-follow opens,
single-link checks, a maximum of 16 slots of 4 MiB, 4 KiB per record, 128 queued
records and a 2-second drain budget. Each process can rotate at most three
times; closed old slots can be reclaimed under the existing private-log rules.
These limits are unchanged. Health reports degraded storage and dropped records.
Logging does not await disk writes on an inference path and never authorizes a
retry, payment, fallback or longer deadline.

This bounded journal is best effort. A crash, forced kill, storage failure, full
queue or exhausted pool can lose evidence. Capture health with an incident
report; absence of a record is not proof of success. Captures are private
operational artifacts and stay outside Git; they are not retained receipt
evidence.

## Reading logs

```sh
pnpm gyblos logs --role buyer
pnpm gyblos logs --role buyer --follow --level error
pnpm gyblos logs --role buyer --json --component buyer-http --operation chat
pnpm gyblos logs --role lab --correlation-id <generated-id> --limit 100
```

Installed releases use `gyblos` instead of `pnpm gyblos`. The default role is
seller. `--limit` accepts 1–1000 records (default 100); with `--follow` it
bounds the initial tail, then new matching records are printed until
cancellation. Human and JSON output share the same projection. The command is
local, read-only, does not create a missing home, and refuses unsafe paths/files
with a static error. A missing directory gives an empty successful result. It
does not read service.log, telemetry files, journals or receipt bodies.

## Investigating a failure

Use the
[shared diagnostic procedure](../.agents/skills/gyblos-diagnostics/SKILL.md).
Keep raw captures private; public handoffs contain only curated metadata, exact
test counts and the limits of the conclusion. A passing repetition does not
explain a previous failure. Prove a suspected bug with a red assertion before
changing behavior, then rerun the relevant regression and all required gates.
