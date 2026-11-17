# Recovery and reconciliation

When a paid call fails halfway, the buyer cannot know whether money moved. The
rule: **an uncertain payment blocks new payments until it is proven on-chain.**
Nothing is retried automatically.

> **Warning:** Never delete a journal or lock to make the buyer pay again. The
> journal is the only record of a payment that may have moved funds, and
> deleting it can lose a deposit or pay twice. Keep the original buyer home,
> `GYBLOS_HOME` included, until recovery finishes, and don't downgrade the buyer
> while channels are pending.

## What to do

These commands work on devnet and run from a checkout with the buyer's
`GYBLOS_HOME`.

1. Stop the buyer. Keep its home as it is.
2. Run the read-only check:

   ```sh
   pnpm buyer:reconcile:paid
   ```

   It prints one JSON line per channel, then a summary line such as
   `{"summary":{"settled":1,"disputed":0,"unchecked":0,"never-opened":0,"open":0}}`.
   The exit code tells you what to do next:

   | Exit | Meaning                                       | Next step                                  |
   | ---- | --------------------------------------------- | ------------------------------------------ |
   | `0`  | Nothing blocks payments                       | Done                                       |
   | `2`  | A channel is still open, or its open may land | Step 3                                     |
   | `1`  | It could not finish; stderr names the code    | Fix the cause it names, then repeat step 2 |

3. Ask the chain to close and refund the open channels:

   ```sh
   pnpm buyer:withdraw:paid
   ```

   This signs transactions and pays devnet fees from the buyer wallet. It prints
   one JSON line per channel and a summary with `retryAfterSeconds`. While it
   exits `2`, wait that many seconds and run it again; the program enforces a
   grace period before a channel can be sealed. Exit `1` means a channel was
   refused or failed; stderr names the code.

4. When `buyer:withdraw:paid` exits `0`, run `pnpm buyer:reconcile:paid` again.
   For single-request channels, only reconciliation unblocks payments.

`buyer:reconcile:paid` covers single-request channels only. Reusable batch
sessions are recovered by `buyer:withdraw:paid` alone, which also clears their
uncertainty once it verifies the close (see
[Reusable batch recovery](#reusable-batch-recovery)). The single-request
outcomes in the JSON lines are `settled` (charged exactly the buyer's own
count), `disputed` (charged another amount; recorded and no longer blocking),
`unchecked` (charged, but the buyer's own count was not kept), `never-opened`
(the open provably never landed; nothing was charged) and `open`.

The rest of this page explains what each command proves. The
[legacy paid v1 path](#legacy-paid-v1-recovery) has its own commands.

## Single-request paid v2 recovery

This section covers the Upto buyer journal used by the single-request paid flow.
Reusable batch channels are covered under
[Reusable batch recovery](#reusable-batch-recovery).

### Opening recovery

The paid v2 buyer journals an intent, then prepares one SDK channel open without
asking the wallet to sign. Before the real payer signature, it durably records
that exact channel ID, its original slot, blockhash lifetime and accepted
payment policy. The signer receives the same prepared message. A failed wallet
call or uncertain checkpoint write conservatively retains a known channel: it
does not prove that nothing was signed or sent.

`pnpm buyer:reconcile:paid` inspects the original channel and finalized history.
It can classify an open as never created only after its original blockhash
lifetime has passed, with complete history and account evidence. Quote expiry,
an absent account alone, incomplete history or an unavailable RPC do not unblock
it. New calls remain blocked while that opening is unresolved; no prompt or
authorization is retried. The checkpoint does not store a signed payload to
retransmit.

The journal reads formats v1 to v4 and writes v5, which also records closure and
refund attempts; older binaries refuse v5. Opening reconciliation does not
request closure, refund an open deposit or make a channel reusable between
requests. Lock acquisition can reclaim a complete lock whose owner is dead on
the same host and PID namespace. Ambiguous ownership requires investigation.

### Closure and refund results

`pnpm buyer:withdraw:paid` can request closure, wait for the chain's grace
period, then seal (finalize) and distribute an unclaimed channel. This command
signs transactions and spends buyer fees; it is separate from read-only
reconciliation. It checks the accepted channel and reconstructs the distribution
from the original terms. The payer's token account is created idempotently
before distribution to receive the refund.

Before broadcast, the buyer atomically checkpoints the locally signed signature,
original blockhash lifetime and finalized observation slot in that same journal.
A failed checkpoint prevents broadcast, including when a write may have landed
but its reply was lost. Concurrent attempts cannot replace a pending signature.
A lost send reply or a different RPC-returned signature keeps that local
signature with `confirmed: false`; the call does not sign or broadcast again. A
definite preflight or observed chain rejection remains `UPTO_CHAIN_REJECTED`.

`distributed` names the attempted operation, not a verified refund amount. Use
`buyer:reconcile:paid` for finalized financial evidence; neither a missing
channel nor a transport error proves a refund. The withdrawal leaves the buyer
journal unresolved until reconciliation. A pending control attempt independently
blocks new payments, even if financial reconciliation already settled its row.

After restart, withdrawal first queries the original signature in historical
statuses and reads context-bound finalized channel state. It does not sign or
send a replacement while the result is live, nonfinal or unavailable. Strict
expiry requires finalized block height greater than the original lifetime and a
valid channel observation; it is not proof of success or refund. Resolving a
pending attempt returns without another send in that call. A later invocation
can progress from the verified channel state. Resolved metadata retains its
observation slot to reject older bank views.

Same-host process-death recovery is exercised with actual SIGKILL and normal
lock acquisition. Incomplete owner records, another host, a live PID or an
orphan takeover guard beside an existing lock remain refused. The lock does not
detect process-start identity or coordinate across hosts or PID namespaces.

## Reusable batch recovery

`pnpm buyer:withdraw:paid` also recovers the batch catalog and each of its
channels, including a single channel created before the catalog existed. The
command takes the buyer's runtime lock, then the catalog lock, then one channel
lock. A running buyer is refused. Recovery signs control transactions and spends
buyer fees; it is not the read-only reconciliation command.

Opening checkpoints retain the exact SDK message before each payer signature,
then its verified signature. Restarting reuses the original salt, blockhash,
channel and zero voucher; it does not create a replacement deposit. Control
checkpoints retain the unsigned message before signing and the complete signed
transaction before sending. Lost replies are resolved against finalized
signature status and bound channel state. If the original signed transaction has
not landed and remains valid, recovery can resend **only those same saved
bytes**. It cannot sign a different live attempt. An interrupted unsigned intent
may be replaced only after its original blockhash has expired (about 90 s) in a
finalized view that never moves backward, or after its close is independently
proven complete.

The buyer can request closure without the seller. Further invocations wait for
the program's grace period, then seal and distribute to the original payer,
seller and treasury accounts. No channel, recipient or split comes from a seller
reply or a modified checkpoint. A confirmed control operation alone does not
release the deposit reservation. Recovery independently verifies the original
opening and final token transfers, checks the charge against the buyer's
cumulative authorization and checks charge plus refund against the deposit. Only
then does it persist `closed`, clear uncertainty and credit the verified refund
in the catalog. Missing evidence keeps the channel blocked.

### An expired opening that never created a channel

The command can also resolve an original opening that never reached the chain.
It reconstructs the original SDK message without wallet authority and compares
it to the retained deposit or exact pre-sign checkpoint. Saved payer signatures
are verified when present. Hints alone, quote expiry and account absence are
insufficient.

Resolution requires a finalized height strictly beyond the recorded lifetime, an
independently invalid original blockhash, complete retained history covering the
opening slot, no successful channel history and a null channel account. History
and account reads must be at least as recent as the finalized blockhash-expiry
observation. Malformed, stale, pruned, unavailable or ambiguous evidence keeps
the reservation blocked. Any successful unknown transaction is conservatively
treated as unresolved.

The result is `notCreated: true`, with no transaction or settlement. It does
**not** report a refund: no deposit moved. A validated terminal marker preserves
the original signing evidence in the existing private store before the catalog
clears uncertainty. The pool releases only that unfunded reservation and keeps
`refundedAtomic` at zero. Repeating recovery is idempotent; other sellers'
deposits and consumed amounts remain committed. The common buyer startup guard
recognizes this terminal outcome, and the original slot cannot reopen.

No prompt is replayed and no replacement channel is opened. Automatic
same-seller channel rotation, protection against an older home backup and
automatic top-up are not part of recovery. Older binaries do not recognize the
terminal marker and keep blocking.

## Offline abrupt-exit acceptance

The native crash suites test this recovery offline (see
[tests/README.md](../tests/README.md)). They run the real payment client,
journal, withdrawal and reconciliation modules in a child process, kill it at
checkpoints, signatures, inclusion and resolution, then reopen the same home
without deleting a journal or lock. A parent process holds the payment-channel
program in LiteSVM and the synthetic wallet keys; an accepted send can land
after the child dies.

What they don't prove:

- The node's devnet startup, a deployed binary, network finality or public RPC
  behavior. The suites use the SDK's testnet identifier and contact no network;
  simulated inclusion counts as finalized.
- Power loss. Process death is not drive power loss, and fsync does not provide
  `F_FULLFSYNC` on macOS.
- Rollback protection. Restoring an old home or journal can erase later
  checkpoints.

## Legacy paid v1 recovery

The sections below cover the paid v1 path, which only the lab uses.

### What blocks new payments

- `authorization.json` (the buyer journal in `$GYBLOS_HOME/buyer/`, or the lab
  journals under `$GYBLOS_LAB_HOME`) records each authorization before it is
  sent. It is cleared only after a finalized proof.
- `buyer.lock` stops two buyer processes from paying at once.
- `calls.json` keeps every call, including failed ones.

A timeout, a 503 from the proxy, a missing transaction in a history query or a
lost response does **not** mean "not charged". A buyer can be charged and still
miss the answer; reconcile that as charged but undelivered. Inspect the
authorization and its transactions first.

### Journals from the old layout

A buyer journal written by an older version sits in `.local/p2p/`, and lab
journals in `.local/devnet/`. The node never reads or moves them. Until they are
moved by hand, setup, `buyer:call` and `buyer:reconcile` stop with
`LEGACY_LOCAL_LAYOUT` before taking a lock, so a fresh buyer cannot pay past an
uncertain authorization. Move the whole directory, journal and lock included,
with the commands in
[running-a-node.md](running-a-node.md#moving-data-from-the-old-layout), then
reconcile as below.

### Verify or clear a zero-charge payment

Run from the buyer's working directory (same `GYBLOS_HOME`), with the original
role, trust, offer, journal and call history in place:

```sh
pnpm buyer:reconcile --deposit DEPOSIT_SIGNATURE --claim CLAIM_SIGNATURE
```

It reads finalized transactions and checks token and SOL movements, the
canonical channel, sponsor fees and rent. Only when it proves **zero charged and
the full deposit returned** does it save a reconciliation record and then clear
the journal. A charged outcome, conflicting rows, an incomplete journal or an
unavailable proof keep the block in place. It never signs, funds or submits
anything.

If the process died before writing a call row, a complete journal can supply the
missing identities. Missing history is never invented.

### Audit any payment without changing files

```sh
umask 077
pnpm --silent buyer:reconcile --audit-only --deposit DEPOSIT_SIGNATURE --claim CLAIM_SIGNATURE > "${GYBLOS_HOME:-.local/gyblos}/buyer/finalized-audit.json"
```

This prints the verified financial proof for a charged or zero-charge payment
and changes no journal or lock. Keep the output private. It reports, among
others, `retainedChannelRentLamports`, `escrowAccountRentLamports`,
`escrowInterveningTokenCreditAtomic` and `treasurySweepAtomic`; older records
without these fields mean "not recorded", not zero.

### What the verifier accepts

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

### Stale locks

Default `buyer:reconcile` can remove a stale `buyer.lock` only after proving its
owner process is gone: the file must be private, regular and unchanged, and its
host, boot and PID identity must match (Linux: boot ID and PID namespace; macOS:
boot session). An audit line is written before removal. Legacy, mismatched or
unreadable owners, live or reused PIDs and an interrupted `recovery.lock`
require manual investigation. `--audit-only` never removes locks.

These are cooperative local checks, not protection against a hostile process
running as the same user, and not a multi-host lock.

### Call diagnostics

Each P2P call row keeps a safe failure phase and code, filtered route metrics
and bounded deposit/claim signature hints in `observedPayment`. Those hints are
not proof of payment. If writing the journal fails, the call stays uncertain and
the earlier journal still blocks new payments.

Limits of this recovery path are listed in
[limitations.md](limitations.md#payments-and-recovery).
