# Simulated paid startup acceptance

`pnpm acceptance:paid` starts the real seller and paid buyer, settles requests
against a simulated chain and checks every payment outcome, without a wallet,
RPC or transaction. Run it after you change paid startup, the payment client or
server, the seller ledger or the buyer journal. It is a verification command,
not a payment demonstration: never present its output as real paid inference.

## Prerequisites

- Node 24.22.1 or newer and the pnpm version pinned in `package.json`.
- Native Iroh for your platform. A missing or unsupported native binding fails
  the run; it is never a successful acceptance.

## Run it

```sh
pnpm acceptance:paid
```

The command takes no arguments: no home, RPC, index, wallet, engine or network
override. Any argument prints `ACCEPTANCE_INVALID_OPTIONS` and exits with a
nonzero code. `tests/lab/paid-startup-acceptance.test.ts` runs the same
scenario inside `pnpm test:lab`.

On success the command prints one JSON line with fixed case names, flags and
aggregate counters, similar to the following:

```text
{"ok":true,"nativeIroh":true,"simulatedChain":true,"realPayments":false,"cases":[…],"answers":…,"attempts":…,"deposits":…,"settlements":…}
```

On failure it prints `{"ok":false,"code":"<CODE>"}` with a static code from
`ACCEPTANCE_CODES` (for example `ACCEPTANCE_FAILED` or
`ACCEPTANCE_NATIVE_UNAVAILABLE`) and exits with a nonzero code. Output never holds
prompts, answers, identities, paths, authorizations or signatures.

## What runs

Real:

- the seller and paid buyer startup, in disposable private role homes, in a
  child process with an allowlisted environment;
- native encrypted Iroh over loopback, relays disabled, advertising only the
  ALPNs product startup requests;
- the `upto` client, server, offline signing and verification, seller ledger and
  buyer journal;
- the buyer terminal entrypoint and mode selection, driven with injected streams
  and adapters.

Simulated:

- the chain: no payment RPC or facilitator client is built, and nothing is
  broadcast;
- the engine: a deterministic recounted engine passed through the seller's
  engine factory port;
- the discovery index (in process) and the 8004 agent registry (local,
  synthetic).

The harness lives in `tests/support/paid-acceptance-*`, where the payment SDK
may be imported; product and lab code never import it.

## Cases

- Complete and streamed answers.
- Refusal before the prompt is sent, and discard of an unsent authorization.
- Independent checks of the settlement shares.
- Clean restarts of both roles, and persistent uncertainty: a request stays
  blocked while the previous payment is uncertain.
- Explicit receipt confirmation, using the buyer's recorded expected charge and
  the simulated chain, never a journal reset or another inference.
- Recovery of a pending seller claim exactly once.
- Engine failure and cancellation never repeat the prompt.
- An interrupted answer: the fake engine stops after one fragment, and the
  simulated ledger charges 45 atomic units from a 10,000-unit ceiling and
  returns 9,955. A second interruption also hides the settlement confirmation;
  the real reconciliation command reads a synthetic finalized history and
  resolves the record to `settled`.

A delivered answer can carry an `unverified` payment verdict: delivery is not
proof that accounting was verified.

## What it does not prove

It does not validate mainnet or devnet, USDC transfers, rent or SOL costs, RPC
finality, real tokenization, model performance, an internet relay or a separate
interactive terminal process. The buyer's API-key check passes, but this is not
an authentication audit. Native Ctrl-C on Windows is covered only by the
injected cancellation test. See [limitations.md](../../docs/limitations.md).
