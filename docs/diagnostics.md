# Operational diagnostics

Operational diagnostics are private local logs that say where an operation
failed: which component, operation and phase, with a static error code. They
never hold content and never leave the machine.

| Record                    | Purpose                           | Default          | Stored                                  | Leaves the machine                           |
| ------------------------- | --------------------------------- | ---------------- | --------------------------------------- | -------------------------------------------- |
| Diagnostics (this page)   | Where a local operation failed    | On, level `warn` | `<role>/diagnostics/` in the local home | No                                           |
| [Telemetry](telemetry.md) | Measured activity per request     | File off         | `<role>/telemetry/` when the file is on | Release builds upload observations (opt-out) |
| [Receipts](receipts.md)   | Signed evidence of each execution | On               | The role's receipt store                | Release builds upload receipts               |

Their schemas, settings and retention are independent. Turning on telemetry
doesn't turn on diagnostics, and there is no diagnostic upload.

## Reading logs

```sh
gyblos logs --role buyer
gyblos logs --role buyer --follow --level error
gyblos logs --role buyer --json --component buyer-http --operation chat
gyblos logs --role lab --correlation-id CORRELATION_ID --limit 100
```

From a checkout, use `pnpm gyblos` instead of `gyblos`. Replace `CORRELATION_ID`
with the `correlationId` of a record you already found.

- `--role` is `buyer`, `seller` or `lab`; the default is `seller`. Only the
  buyer writes product diagnostics (see [Coverage](#coverage)), so use
  `--role buyer`; the seller role usually prints nothing.
- `--level` is `debug`, `info`, `warn` or `error`.
- `--limit` accepts 1 to 1000 records (default 100). With `--follow`, it bounds
  the initial tail; new matching records then print until you cancel.
- Human and `--json` output show the same projected fields.

The command is local and read-only. It doesn't create a missing home, refuses
unsafe paths and files with a static error, and treats a missing directory as an
empty result. It never reads `service.log`, telemetry files, journals or receipt
bodies.

## Configuration

The buyer reads these `config.toml` settings at startup:

```toml
[diagnostics]
enabled = true
level = "warn"
```

Diagnostics are on by default at level `warn`. Levels, in order, are `debug`,
`info`, `warn` and `error`; `debug` adds metadata only, never content. There is
no environment override. Seller startup accepts the `[diagnostics]` table, but
writes no records. [configuration.md](configuration.md) has the key reference.

`packages/config/src/home.ts` owns the paths:

- product: `<GYBLOS_HOME>/<buyer|seller>/diagnostics/`;
- lab: `<GYBLOS_LAB_HOME>/diagnostics/`, only when the caller composes it.

## Coverage

- **Buyer HTTP boundary.** Admission refusals, invalid input, execution
  failures, request deadlines and client disconnects. Each admitted chat request
  emits at most one terminal failure. At level `debug` the buyer also records
  successful chat and count-token completions, without content.
- **Lab tool acceptance workers.** Validated phase frames while starting,
  requesting, verifying, cancelling and closing resources. On failure the parent
  adds the child's exit code, signal and stdout/stderr byte counts, never raw
  stderr. The duration runs from when the parent began spawning the child. If
  the child never starts, the last phase is `startup`. A phase is the last
  observed boundary, not proof of a cause.
- **Cleanup.** `withDiagnosticCleanup` records cleanup failures separately and
  preserves the original thrown value, including `undefined`. A cleanup failure
  after successful work still fails the operation. Nested receipt-startup
  cleanup is not instrumented, so a cleanup failure there can hide its original
  startup error.

Seller, transport, discovery and payment paths write no diagnostics. Other
service output does not pass through this channel.

## Record contract

`packages/runtime` owns the envelope, the severity, outcome and cause
vocabularies, projection, bounded private persistence and the read-only reader.
Each producer owns its component, operation, phase, scenario and error-code
catalogs in its `constants.ts` and passes them to `createDiagnostics`. Map
unknown errors to a known code and a fixed cause category; never copy `.code`,
`.message`, `.stack` or `.cause` from a thrown object.

A record holds:

- schema version, random event and correlation IDs, UTC timestamp, build version
  (`source` for source runs) and level;
- component, operation, phase, canonical code, outcome, cause category and
  monotonic elapsed milliseconds;
- optionally, scenario, child exit code, signal and output byte counts.

IDs are generated locally, never taken from client headers, receipt digests or
identities. Records never hold prompts, responses, model names, payloads,
endpoints, addresses, payment signatures, authorization headers or raw exception
strings.

Projection reads own data properties only, ignores unknown fields and never
calls getters or `toJSON`. The reader parses files as `unknown`, validates the
common envelope and prints only projected metadata. An unknown complete record
fails with `DIAGNOSTICS_UNAVAILABLE`; an unfinished last line is withheld. The
reader never repairs files.

## Lifecycle

- The logger is lazy: no file exists until an enabled event meets the minimum
  level.
- The buyer owns its logger and closes it after its resources stop. The buyer
  host exposes `diagnostics()` health.
- A library caller can inject its own `DiagnosticSink` into `startFreeBuyerHttp`
  and owns that sink. Sink callbacks must be synchronous and non-blocking;
  thrown errors are isolated, but a blocking callback still blocks.
- `runToolAcceptance({ diagnostics })` accepts the same sink. By default it
  writes failure JSONL to stderr and opens no product or lab home. To keep lab
  failures, compose `createDiagnosticLog(labLayout(environment).diagnostics)`
  with an explicitly selected lab environment, pass `log.write`, and await
  `log.close()` in `finally`.
- Use temporary homes in tests. Never validate with a real operator profile.

## Bounds and evidence limits

Storage uses the private log (`PRIVATE_LOG_LIMITS` in `@gyblos/config`):

- private directories and files, no-follow opens and single-link checks;
- at most 16 files of 4 MiB, 4 KiB per record and 128 queued records;
- a 2-second drain budget and at most three rotations per process.

Health reports degraded storage and dropped records. Logging never waits for
disk on an inference path, and never authorizes a retry, payment, fallback or
longer deadline.

The log is best effort. A crash, forced kill, storage failure, full queue or
exhausted pool can lose records, so a missing record is not proof of success.
Keep diagnostic captures private and outside Git; they are not receipt evidence.

## Investigating a failure

Follow the
[shared diagnostic procedure](../.agents/skills/gyblos-diagnostics/SKILL.md).
Public handoffs contain only curated metadata, exact test counts and the limits
of the conclusion. A passing repetition does not explain an earlier failure:
prove a suspected bug with a failing assertion before you change behavior, then
rerun the relevant regression and all required checks.
