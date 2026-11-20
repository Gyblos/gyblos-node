# Recovery and reconciliation

Stop the buyer and keep its original home. Run `pnpm buyer:withdraw:paid` with
that home to recover reusable channels on devnet. The buyer signs the recovery
transactions and pays their network fees. Exit code 2 means another step is
needed. Wait for the reported delay before invoking the command again.

## Reusable batch recovery

`pnpm buyer:withdraw:paid` recovers the batch catalog and each of its channels,
including a single channel created before the catalog existed. The command takes
the buyer's runtime lock, then the catalog lock, then one channel lock. A
running buyer is refused. Recovery signs control transactions and spends buyer
fees.

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
