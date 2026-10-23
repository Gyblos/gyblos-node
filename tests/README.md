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
RPC is made.

## Native skips

Iroh transport cases need the pinned native binding and IPv6 loopback `[::1]`.
The helpers probe both first; a missing binding or a known IPv6 error gives an
explicit per-case skip, while unexpected errors fail the suite. The egress case
that pauses a child with `SIGSTOP` and the lock ownership/FIFO cases skip
outside macOS/Linux. Report passed, failed, cancelled and skipped counts
separately; a skipped case proves nothing on that host.

## Opt-in identity integration

`GYBLOS_IDENTITY_INTEGRATION=1 pnpm test:lab` starts a throwaway
`solana-test-validator` on loopback ports 18000-19999, cloning the 8004 program
and registry accounts read-only from public devnet. Its ledger stays in ignored
`.local/identity-validator/`. Without the binary, or if devnet is unreachable,
the four cases skip with a reason.

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
