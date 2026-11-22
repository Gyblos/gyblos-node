# Tests

Offline regression suites for the product, the lab and the repository tooling,
plus opt-in acceptance runs that compose real processes over native transport.

## Commands

| Command             | Runs                                                                                          |
| ------------------- | --------------------------------------------------------------------------------------------- |
| `pnpm check`        | Typecheck, lint (including tooling tests), then product, standalone package and lab tests.    |
| `pnpm test`         | Product suites `tests/*.test.ts` and standalone package tests `packages/*/test/**/*.test.ts`. |
| `pnpm test:lab`     | Lab suites `tests/lab/**/*.test.ts`.                                                          |
| `pnpm test:all`     | Product, standalone package and lab tests.                                                    |
| `pnpm tooling:test` | Tests of the boundary checker and lint rules, `tooling/**/*.test.ts`.                         |

Run one file, or only the tests in it whose name matches `PATTERN`:

```sh
node --import tsx --test tests/iroh-transport.test.ts
node --import tsx --test --test-name-pattern "PATTERN" tests/iroh-transport.test.ts
```

Report passed, failed, cancelled and skipped counts for product, lab and tooling
tests separately.

## Linux CI shards

Linux CI distributes the product and lab suites by historical duration. The
workflow discovers files from the suite globs on each run. Within each suite, it
assigns heavier files first to the shard with the lowest estimated load. After
scheduling the measured files, new paths use the middle observed weight for
their suite. Deleted paths drop out automatically. The weights in
`tooling/ci-shard-durations.json` are median per-file process times in
nanoseconds from comparable green Linux runs. Refresh them from file lifetimes
including startup, since individual test cases can overlap.

## Layout

Node finds test files by glob; there is no allowlist. Every case is a top-level
`void test(...)` in a `*.test.ts` file.

- `tests/*.test.ts` exercise product packages and apps through their public
  entries. They never import `@gyblos/lab-harness` or `lab/`.
- `tests/lab/` covers lab code (the gate harness, the standalone lab
  facilitator, the exact scheme, journals, lab tools and entrypoints), the
  acceptance runs below and the opt-in identity integration.
- `tests/support/` holds fixtures, fakes, fault catalogs and helpers, never test
  cases. Both suites may import it. Contract suites that every plugin of a port
  must pass live there as `*-contract.ts`, run by one `tests/*.test.ts` per
  plugin.
- A standalone package (see [AGENTS.md](../AGENTS.md)) keeps its tests in
  `packages/<name>/test/` so they leave the monorepo with it; they import only
  that package.
- `tooling/**/*.test.ts` test the repository tooling, not the product, and are
  counted separately.

## Writing a test

- Import packages by name through their public `exports`, never by a relative
  path into another package.
- Run in a temporary directory, and set `GYBLOS_HOME` or `GYBLOS_LAB_HOME`
  inside it when the code touches local data. Never read a real `.local/`.
- Use synthetic inputs, ephemeral unfunded signers and fakes from
  `tests/support/`. A behavior fix starts with a failing test.
- Golden vectors in `packages/protocol/vectors/` protect signing domains,
  canonical bytes and error codes. Add new vectors for a new version; never
  change the bytes of an existing one.

## What the suites need

No funded wallet, Ollama, Docker, Python, devnet funds or network. The suites
use synthetic inputs, ephemeral unfunded signers, mocked RPC and temporary
files. Paid-call cases spawn the real CLI with stubbed payment ports and assert
that no RPC is made. Legacy-layout cases create synthetic paths in a temporary
directory and never read a real `.local/`.

## Native skips

Iroh transport cases need the pinned native binding and IPv6 loopback `[::1]`.
The helpers probe both first: a missing binding or a known IPv6 error skips the
case with a reason, and any other error fails the suite. The egress case that
pauses a child with `SIGSTOP` and the lock ownership and FIFO cases skip outside
macOS and Linux. The discovery index `sqlite-d1` cases skip where `node:sqlite`
is missing. A skipped case proves nothing on that host.

Native admission tests hold the incomplete client stream until explicit cleanup
and wait for the server's real `acceptBi` result before opening a competing
connection, because client handshake or write completion alone doesn't prove
server admission. `control-admission-order.test.ts` controls native completion
order to check this barrier for the data and control ALPNs, with no product
hook, fixed sleep, enlarged timeout or retry.

## Opt-in identity integration

`GYBLOS_IDENTITY_INTEGRATION=1 pnpm test:lab` starts a throwaway
`solana-test-validator` on loopback ports 18000-19999 and clones the 8004
program and registry accounts read-only from public devnet. Its ledger stays in
the ignored lab home (`.local/lab/identity-validator/` by default). Without the
binary, or when devnet is unreachable, the four cases skip with a reason.

## Fixtures policy

- `fixtures/finalized-payment-pair.json`: selected public metadata of one real
  finalized deposit and claim pair. Current-account responses and mutated
  variants are labelled synthetic. Never add payment payloads, logs or
  credentials.
- `fixtures/identity-devnet-accounts.json`: two public registry accounts,
  captured by `lab/tools/identity-fixtures.ts`. `pnpm identity:fixtures`
  recaptures them from devnet with read-only RPC calls and overwrites the file.
- `packages/protocol/vectors/public-discovery-v1.json`: synthetic keys and
  signatures only.
- Raw evidence, measurements and private notes stay out of Git. Keep manual or
  private probes outside the discovered test tree.

## Acceptance runs

Acceptance runs start real product processes with temporary homes, an in-process
discovery index, native loopback Iroh and synthetic engines and chain services.
They make no real payment and contact no deployed index, relay or RPC. Runs over
Iroh need the native binding; without it a test case is reported as skipped, and
a skip is never a successful acceptance.

| Run                                   | Command or file                                                                           | Details                                                                                                             |
| ------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Publication to signed quote           | `pnpm --filter @gyblos/lab-harness acceptance:node-discovery`                             | [Lab acceptance runs](../lab/docs/node-discovery-acceptance.md)                                                     |
| Free inference, complete answer       | `pnpm --filter @gyblos/lab-harness acceptance:free`                                       | [Complete free inference](../lab/docs/node-discovery-acceptance.md#complete-free-inference-acceptance)              |
| Free streaming and cancellation       | `pnpm --filter @gyblos/lab-harness acceptance:free-stream`                                | [Free streaming](../lab/docs/node-discovery-acceptance.md#free-streaming-acceptance)                                |
| Read-only 8004 identity               | `pnpm --filter @gyblos/lab-harness acceptance:identity`                                   | [Identity acceptance](../lab/docs/node-discovery-acceptance.md#complete-acceptance-with-read-only-8004-identity)    |
| Product startup to confirmed receipts | `pnpm acceptance:receipts`                                                                | [Receipt acceptance](../lab/docs/node-discovery-acceptance.md#product-startup-through-private-receipt-confirmation) |
| Payment-channel program               | `tests/lab/paid-native.test.ts`                                                           | [Payment-channel program acceptance](../lab/docs/paid-native-acceptance.md)                                         |
| Abrupt exit and journal recovery      | `tests/lab/channel-crash-native.test.ts`, `channel-crash-boundaries.test.ts`              | [Offline abrupt-exit acceptance](../docs/recovery.md#offline-abrupt-exit-acceptance)                                |
| Two concurrent sellers                | `tests/lab/http-multiseller-acceptance.test.ts`                                           | Below                                                                                                               |
| Paid session conversations            | `tests/lab/paid-conversation-startup.test.ts`, `tests/lab/paid-session-streaming.test.ts` | Below                                                                                                               |
| Agent tool loop                       | `tests/lab/tools-acceptance.test.ts`                                                      | Below                                                                                                               |

Run a file-based acceptance with
`node --import tsx --test tests/lab/FILE.test.ts`. The standalone
`acceptance:identity` command fails, rather than skips, when native transport is
unavailable.

### Two concurrent sellers

`http-multiseller-acceptance.test.ts` runs the real buyer HTTP entry against two
product seller processes. It covers concurrent execution and reuse after a buyer
restart, the verified final charge and refund, queue expiry, HTTP disconnect, a
shared-budget race, and an uncertain payment on one seller that blocks new
requests and survives restart without replaying a prompt. Cancellation waits for
the server-side close; no case passes by timing out. Only numeric and status
evidence leaves the scenarios. It is local composition evidence, not a
live-chain, deployed-program, real-engine or power-loss acceptance.

### Paid session conversations

`tests/batch-conversation*.test.ts` cover complete-history recounting, quote,
context and budget bounds, cumulative approvals, cancellation and lost-ACK
restart. `batch-legacy-vectors.test.ts` freezes the v1 bytes.
`batch-streaming.test.ts` and `batch-stream-protocol.test.ts` cover visible text
before engine completion, one reused deposit, sequence and correlation,
backpressure and recovery.

`paid-conversation-startup.test.ts` and `paid-session-streaming.test.ts` run the
product buyer HTTP entry and a native Iroh seller in single-session and pooled
modes, reusing one deposit across requests and a peer restart. A cancellation
before a verified terminal never creates an approval or retries a prompt.

The opt-in `tests/lab/paid-conversation-tokenizer.test.ts` uses the real pinned
public tokenizer artifacts without an engine. Set `GYBLOS_TEST_TOKENIZER_HOME`
to an owned `/tmp/gyb-paid-chat-tokenizer-*` (or `/private/tmp/...`) home
prepared with `prepareModelTokenizer`. The test re-checks both artifact hashes
and refuses any other location. Without the variable it is skipped.

### Agent tool loop

`tools-acceptance.test.ts` runs the product seller and `buyer:free` with a
scripted in-memory provider. OpenAI and Anthropic client formats each complete a
JSON and a streaming tool loop: two generations and two execution dials per
loop. Negative cases cover invalid schemas and results, a seller without tool
support, malformed provider output, interrupted terminals and disconnect
cancellation without retry. Financial factories fail if called, and a fetch
allowlist rejects any other I/O. It doesn't prove live agents, provider behavior
or tokenizer billing.
