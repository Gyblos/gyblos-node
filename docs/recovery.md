# Recovery and reconciliation

When a paid call fails halfway, the buyer cannot know whether money moved. The
rule is simple: **an uncertain payment blocks new payments until it is proven
on-chain.** Nothing is retried automatically.

## What blocks new payments

- `authorization.json` (the buyer journal in `.local/p2p/`, or the gate journals
  in `.local/devnet/`) records each authorization before it is sent. It is
  cleared only after a finalized proof.
- `buyer.lock` stops two buyer processes from paying at once.
- `calls.json` keeps every call, including failed ones.

A timeout, a 503 from the proxy, a missing transaction in a history query or a
lost response does **not** mean "not charged". A buyer can be charged and still
miss the answer; reconcile that as charged but undelivered.

**Never delete the lock or a journal to retry.** Inspect the authorization and
its transactions first.

## Verify or clear a zero-charge payment

Run from the buyer's working directory, with the original role, trust, offer,
journal and call history in place:

```sh
pnpm p2p:reconcile --deposit DEPOSIT_SIGNATURE --claim CLAIM_SIGNATURE
```

It reads finalized transactions and checks token and SOL movements, the
canonical channel, sponsor fees and rent. Only when it proves **zero charged and
the full deposit returned** does it save a reconciliation record and then clear
the journal. A charged outcome, conflicting rows, an incomplete journal or an
unavailable proof keep the block in place. It never signs, funds or submits
anything.

If the process died before writing a call row, a complete journal can supply the
missing identities. Missing history is never invented.

## Audit any payment without changing files

```sh
umask 077
pnpm --silent p2p:reconcile --audit-only --deposit DEPOSIT_SIGNATURE --claim CLAIM_SIGNATURE > .local/p2p/finalized-audit.json
```

This prints the verified financial proof for a charged or zero-charge payment
and changes no journal or lock. Keep the output private. It reports, among
others, `retainedChannelRentLamports`, `escrowAccountRentLamports`,
`escrowInterveningTokenCreditAtomic` and `treasurySweepAtomic`; older records
without these fields mean "not recorded", not zero.

## What the verifier accepts

- Fresh, individually settled channels with a retained channel account and an
  escrow token account created by the sponsor and closed back to it.
- The deposit may only move tokens buyer → escrow; the claim only escrow →
  buyer, seller or the canonical devnet treasury.
- Extra tokens that arrive in the escrow between deposit and claim must all go
  to the treasury; the charge plus the buyer refund must still equal the
  ceiling.
- Extra SOL credits to the channel or sponsor are reported separately and do not
  break the proof.

Anything else (closed or missing channels, prefunded escrow, other mints,
unexpected transfers, non-finalized data) stops verification. That is
deliberate: unsupported cases need manual investigation, not an inferred refund.

## Stale locks

Default `p2p:reconcile` can remove a stale `buyer.lock` only after proving its
owner process is gone: the file must be private, regular and unchanged, and its
host, boot and PID identity must match (Linux: boot ID and PID namespace; macOS:
boot session). An audit line is written before removal. Legacy, mismatched or
unreadable owners, live or reused PIDs and an interrupted `recovery.lock`
require manual investigation. `--audit-only` never removes locks.

These are cooperative local checks, not protection against a hostile process
running as the same user, and not a multi-host lock.

## Call diagnostics

Each P2P call row keeps a safe failure phase and code, filtered route metrics
and bounded deposit/claim signature hints in `observedPayment`. Those hints are
not proof of payment. If writing the journal fails, the call stays uncertain and
the earlier journal still blocks new payments.

Limits of this recovery path are listed in
[limitations.md](limitations.md#payments-and-recovery).
