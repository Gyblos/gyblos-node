# Known limitations

Gyblos Node is experimental, devnet-only and not audited. This page lists what
it does **not** do or has not proven. Use isolated, generated devnet keys only;
never import mainnet keys.

Each bullet states one limit and its effect. The linked page owns the details.

## Validation status

- Paid execution has settled on devnet only in controlled runs. Those runs don't
  establish paid behavior on every later revision, in production or at load. The
  published lab evidence is listed in [lab/README.md](../lab/README.md).
- Docker NAT-direct connections did not pass the lab check. A relay session with
  inbound UDP blocked did complete paid calls. Hotspot/CGNAT, wider NAT coverage
  and a direct-to-relay switch during a session are untested.
- Mainnet, MPP, mobile apps, reputation, penalties and decentralized seller
  discovery are not implemented.

## Payments and recovery

Behavior and recovery steps are in [payments.md](payments.md) and
[recovery.md](recovery.md).

**Fees and accounts**

- The fee isn't collected at exactly 4%. Each payout is floored, and the
  rounding residual goes to the payment program's treasury, not to Gyblos
  ([Protocol fee](payments.md#protocol-fee)).
- The fee treasury is a public Gyblos devnet test wallet. No mainnet treasury
  exists, and the product refuses mainnet terms.
- The program pays a share whose token account is missing to its own treasury,
  for good. The seller creates the missing accounts (payout, fee treasury, fee
  payer and the channel's payer) before it starts and before each claim
  ([Seller startup](configuration.md#seller-startup)).
- A buyer that closed its emptied token account makes the seller pay about 0.002
  SOL rent to recreate it for the refund, at most about once per channel. This
  rent isn't recovered.
- Rent cleanup and a buyer's withdrawal distribute without that account check.
  An owner that closes its own token account while the seller runs loses those
  shares for good; the next claim or restart recreates the account.
- A claim whose buyer refund account is frozen isn't sent. It stays pending and
  is retried on recovery, with the same code as an unreachable RPC.
- Rent cleanup knows only the channels the current process handled. After a
  restart, an older channel that no claim sealed keeps the fee payer's rent
  until its payer closes it.

**Claims and deadlines**

- A claim counts as landed only through a transaction signature the seller
  recorded. If a claim lands without its signature being recorded (the process
  stops right after sending, or the RPC fails a send that still propagated), the
  seller was paid but its ledger never marks the channel settled. Reconcile it
  by hand.
- An unconfirmed claim is retried in the background for about a minute and a
  half (at most about three minutes when every attempt times out). The retry
  queue lives in memory: after a shutdown, only the next start's recovery drives
  pending claims again, and a claim past the SDK payload's expiry lapses. A
  broadcast transaction can still confirm later; recovery checks its signature
  instead of assuming no payment happened.
- The seller reserves the settlement wait before the claim deadline and stops
  publishing at that cutoff. A transport write already issued can't be taken
  back, and an engine that ignores abort can't be stopped. The buyer must
  reconcile such an interrupted result; the prompt is never retried.
- New paid channels use a 300-second withdrawal grace, which is part of the
  channel authorization. Run buyer and seller on the same release, and don't
  downgrade while paid channels are pending.
- Collection needs inclusion before voucher or grace expiry, bounded clock drift
  and a working RPC. A reserved wait is not a confirmation guarantee.

**Uncertain outcomes**

- A timeout, a 503 or a missing history entry doesn't prove that no payment
  happened. Uncertain payments block new ones until reconciled. There is no
  automatic retry or provider switch after settlement was attempted.
- A buyer can be charged and still not receive the answer, for example after a
  disconnect. `pnpm buyer:reconcile:paid` records what the chain charged; it
  doesn't refund a charge for an undelivered answer.
- A lost reply to a closure or refund send keeps the signed transaction's
  signature and reports it unconfirmed. Finalized reconciliation is still
  required, and a missing account is not proof of a refund.
- The legacy `pnpm buyer:reconcile` (for older per-request journals) clears only
  zero-charge outcomes, and `--audit-only` verifies a charged payment. Its
  verifier accepts only fresh, individually settled channels with the expected
  account shapes; anything else needs manual investigation. It doesn't recover
  channel rent.

**Local state**

- Recovery covers same-host process crashes. It doesn't cover power loss, other
  PID namespaces or a restored older backup; restoring an old journal can lose
  later checkpoints.
- Lock checks are cooperative and local: no defense against a hostile process of
  the same user, and no multi-host lock. An interrupted `recovery.lock` needs
  manual investigation.
- A full or read-only disk can lose a call row; the earlier journal then still
  blocks new payments.

**Test scope**

- Closing and expiry regressions run the real installed SDK against synthetic
  accounts and RPC replies. Native channel tests run the source-built program in
  LiteSVM with a synthetic mint. Neither establishes equivalence with the
  deployed program or a live run of the current code.

## Payment sessions

[payment-sessions.md](payment-sessions.md) owns session behavior.

- Sessions are an allowlisted pilot: a seller accepts at most 16 buyers through
  `GYBLOS_SESSION_BUYER_NODE_IDS`. There is no public session admission.
- Windows refuses financial sessions on both seller and buyer.
- A seller holds at most `max_sessions` (16 or fewer) unfinished sessions, and
  keeps closed-session proof for at most 64 buyers; past that it refuses new
  buyers instead of evicting proof.
- A buyer holds at most 16 seller channels. Each channel runs one request at a
  time.
- There is no automatic top-up, channel rotation or seller failover.
- A seller offline through the whole forced-close grace can lose signed earnings
  it never claimed.
- There is no rollback defense for a restored journal, and no validation on a
  live network or against the deployed program.

## Receipts and data upload

[receipts.md](receipts.md) owns the receipt lifecycle.

- Release builds upload signed receipts to `https://collector.gyblos.com/v1`
  with no setting to turn it off. Telemetry observations are uploaded too,
  unless `GYBLOS_OBSERVATIONS=off`.
- Per-request paid requests produce no usage receipts; free requests and payment
  sessions do.
- A receipt signature attests its signer's claim, not true usage. "Agreed" means
  two node keys agreed; node keys are free, so it doesn't show two independent
  parties.
- At 16,384 pending receipts or 64 MiB, new receipts fail with
  `RECEIPT_STORAGE_FULL` until uploads free space.

## Inference and verification

- Token recounts **detect** an overcharge within the ceiling after settlement.
  They don't prevent, refund or penalize it.
- Model pins check local artifacts only. The buyer can't verify the remote
  seller's model or the correctness of an answer.
- Only the pinned Qwen3 0.6B engine is validated end to end, and only
  `qwen3:0.6b` can be priced, because a priced model needs a public tokenizer
  the buyer can recount with.
- Streaming acceptance runs synthetic engines over native loopback. It doesn't
  establish real-model or production streaming performance.
- The seller's 1.5 GiB memory reserve is an admission policy, not a guarantee.
  Later memory pressure or model eviction can still break a request. The model
  stays loaded for five minutes; offers expire after four.
- On Linux the reserve is checked against available memory and the tightest
  cgroup limit from the seller's own group up to the root. An engine in a
  separately limited service or container is outside that path, so its own limit
  isn't checked.

## Transport and privacy

- Route labels are sampled observations, not proof of every packet's path.
- A direct connection reveals each peer's IP address. The relay always sees both
  IPs. Relay-only modes (`GYBLOS_RELAY_ONLY`, `GYBLOS_BUYER_RELAY_ONLY`) are
  checked offline only; off-host privacy is unmeasured.
- Without `GYBLOS_BUYER_RELAY_ONLY=1`, requiring a relay route doesn't hide the
  buyer's address.
- Relay-token handling is tested offline. A native bind and relay handshake are
  not covered by the offline suite.
- One relay (`na1`) exists.
- `@number0/iroh` 1.1.0 has no Intel Mac build and no DHT, pkarr or gossip API.

## Admission limits and abuse

The seller limits work per Iroh identity, and identities are free to create. The
defaults below are configurable within hard ceilings
([Seller limits](configuration.md#seller-limits)).

- By default: eight connections in total, one control and one data connection
  and one active request per NodeId, two active requests globally, eight pending
  handshakes (two per source address), and 30 requests per NodeId within a
  shared 256-request minute.
- Free challenges and failed requests count. About nine identities sending 30
  free requests each can deny new peers for the rest of the minute, with no
  payment. There is no Sybil resistance or availability guarantee.
- A disconnected peer has no reserved slot; reconnecting can wait for spare
  capacity or the next window.
- Source budgets use full IP addresses (IPv6 isn't grouped by prefix) and relay
  identities, which are cheap to replace. Peers behind one NAT share a source
  limit.
- Stuck native handshakes or writes can't be cancelled and can fill their
  bounded pools.
- These limits are tested with loopback Iroh only, not over relays or real
  networks.

## Discovery

[discovery.md](discovery.md) and
[discovery-index.md](discovery-index.md#security-model-and-limits) own the
details.

- There is no DHT or decentralized discovery; buyers rely on an index and their
  own record verification.
- Unreachable withdrawal delivery relies on signed-record expiry.
- Deleting or restoring the local public sequence state and automatic crash-lock
  recovery are unsupported. Windows power-loss durability is unverified.
- Readiness checks are skipped while inference runs. An engine that ignores
  abort holds the single check slot and keeps availability closed until it
  settles.

## Local files

- Keys, journals and diagnostics live in the product home, one directory per
  role: `~/.gyblos/` for an installed release, `.local/gyblos/` in a checkout,
  or `GYBLOS_HOME`. Models and the tokenizer are in its `artifacts/` directory.
  Never share role directories.
- Legacy `.local/p2p`, `.local/devnet` and `.local/ollama/models` data is never
  migrated automatically; startup refuses until you move it by hand
  ([Local home](running-a-node.md#local-home)). The check is local and
  existence-based only.
- `.env` is not loaded; set variables in the process environment.
- Funding the roles is manual.

## Test coverage

The offline suite uses synthetic inputs, mocked RPC, native loopback Iroh and
one saved public finalized payment pair. It doesn't establish a fresh chain
audit, public relay compatibility, exactly-once settlement or physical recovery
of a signed offer. Unsigned modified payment variants in the fixture never ran
on chain. See [tests/README.md](../tests/README.md).

## Prototypes

- The [PayPal Sandbox prototype](paypal-sandbox.md) uses simulated money only.
  It is not exactly-once and not safe for live money.
