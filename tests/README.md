# Offline regression tests

| Command             | Runs                                                                  |
| ------------------- | --------------------------------------------------------------------- |
| `pnpm check`        | Typecheck, lint (including tooling), product and lab tests.           |
| `pnpm test`         | Product suites `tests/*.test.ts` (the PR gate).                       |
| `pnpm test:lab`     | Lab-only regressions `tests/lab/**/*.test.ts`.                        |
| `pnpm test:all`     | Both.                                                                 |
| `pnpm tooling:test` | Tests of the boundary checker and lint rules, `tooling/**/*.test.ts`. |

Node discovers test files by glob; there is no allowlist, and every case is a
top-level `test()` in a `*.test.ts` file.

- `tests/*.test.ts` exercise product packages and apps through their public
  entries. They never import `@gyblos/lab-harness` or `lab/`.
- `tests/lab/` covers lab code (gate harness, standalone lab facilitator, exact
  scheme, journals, lab tools and entrypoints) and the opt-in identity
  integration with its validator helper.
- `tests/support/` holds fixtures, fakes, fault catalogs and helpers only, no
  test cases. Both suites may import it.
- `tooling/**/*.test.ts` test the repository tooling, not the product, and are
  counted separately.

## What the suite needs

No funded wallet, Ollama, Docker, Python, devnet funds or network. It uses
synthetic inputs, ephemeral unfunded signers, mocked RPC and temporary files.
Paid-call cases spawn the real CLI with stubbed payment ports and assert that no
RPC is made. Cases that touch local data run in a temporary working directory
(and set `GYBLOS_HOME` or `GYBLOS_LAB_HOME` inside it when needed);
legacy-layout cases create synthetic paths there and never read a real
`.local/`.

## Native skips

Iroh transport cases need the pinned native binding and IPv6 loopback `[::1]`.
The helpers probe both first; a missing binding or a known IPv6 error gives an
explicit per-case skip, while unexpected errors fail the suite. The egress case
that pauses a child with `SIGSTOP` and the lock ownership/FIFO cases skip
outside macOS/Linux. The discovery index `sqlite-d1` cases use `node:sqlite`
(unflagged since Node 22.13) and skip where it is missing. Report passed,
failed, cancelled and skipped counts separately; a skipped case proves nothing
on that host.

## Opt-in identity integration

`GYBLOS_IDENTITY_INTEGRATION=1 pnpm test:lab` starts a throwaway
`solana-test-validator` on loopback ports 18000-19999, cloning the 8004 program
and registry accounts read-only from public devnet. Its ledger stays in the
ignored lab home (`.local/lab/identity-validator/` by default). Without the
binary, or if devnet is unreachable, the four cases skip with a reason.

## Fixtures policy

- `fixtures/finalized-payment-pair.json`: selected public metadata of one real
  finalized deposit/claim pair. Current-account responses and mutated variants
  are labelled synthetic. Never add payment payloads, logs or credentials.
- `fixtures/identity-devnet-accounts.json`: two public registry accounts,
  captured by `lab/tools/identity-fixtures.ts`. `pnpm identity:fixtures`
  recaptures it from devnet with read-only RPC calls and overwrites the file.
- `packages/protocol/vectors/public-discovery-v1.json`: synthetic keys and
  signatures only.
- Raw evidence, measurements and private notes stay out of Git. Keep manual or
  private probes outside the discovered test tree.

## Node and discovery acceptance

`tests/lab/node-discovery-acceptance.test.ts` covers the reusable local lab
command, its default synthetic engine, native Iroh capability boundary, private
temporary homes, in-process index, cancellation and static output. It exercises
renewal, failure/expiry/busy recovery, durable restart and replay refusal
without payments or RPC. Native cases use the same explicit capability gating as
other Iroh tests. The command has a separate real-Ollama opt-in that CI never
runs; see [the acceptance procedure](../docs/node-discovery-acceptance.md).

`tests/lab/free-acceptance.test.ts` adds the synthetic-only complete free
journey through the actual local index, native Iroh and product buyer HTTP
endpoint. It checks renewal answers, typed execution refusals, persistent public
replay state, caps and pre-/post-send failures. It also checks early
cancellation, CLI privacy and native-unavailable behavior; no TCP/mock fallback
or real-engine option is supplied by the free command.

`tests/lab/free-acceptance-review.test.ts` pins the synthetic HTTP finish reason
and choice index, plus cleanup on control-client initialization failure. An
owned endpoint closes on failure; a borrowed endpoint stays caller-owned. The
initialization probes use in-memory doubles and never bind native sockets.
