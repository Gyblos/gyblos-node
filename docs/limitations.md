# Known limitations

Gyblos Node is experimental, devnet-only and not audited. This page lists what
it does **not** do or has not proven today. Use isolated generated devnet keys
only; never import mainnet keys.

## What has been proven, and what has not

- One real paid run: three sequential inferences, native Mac seller and VPS
  buyer, required direct Iroh route, test token (not USDC). All six transactions
  finalized and every answer was recounted. Report:
  [gate-0008.json](../lab/evidence/gate-0008.json), bound to source `ba168c4`.
- Later code is checked with offline tests only. No paid run has been repeated
  on the current head.
- Docker NAT-direct did not pass. A relay session with inbound UDP blocked did
  complete paid calls (see [gate-0006.json](../lab/evidence/gate-0006.json)).
  Hotspot/CGNAT and wider NAT coverage are untested, as is a direct-to-relay
  switch during a session.
- The PayAI backup facilitator has never been used for a payment.
- Mainnet, MPP, mobile apps, reputation, penalties and decentralized seller
  discovery are not implemented.

## Payments and recovery

- The devnet protocol fee treasury is a public Gyblos test wallet
  (`4Ui1dfvqbFx9CtjXNcKajHdr7aKT1nbYRiYjB1s7umNy`), distinct from the x402
  program's own treasury. Mainnet has no treasury configured. Before the first
  devnet claim, the treasury needs a token account for the test mint, since the
  claim pays its share there.
- Paid v2 selling (x402 upto channels) is wired to devnet but tested offline
  only; nothing has settled on devnet yet.
- A claim is recognized as landed only through the transactions this seller sent
  for it. If a claim lands without its signature being recorded (the process
  stops after sending it, or the RPC fails the send after it propagated), the
  claim stays unavailable: the seller was paid, but its ledger never marks the
  channel settled, and it must be reconciled by hand.
- Rent cleanup only knows the channels this process handled. After a restart, a
  channel from the previous run that no claim sealed keeps the fee payer's rent
  until the payer closes it.
- Setting up a paid v2 seller still needs `--buyer`, a v1 setup requirement that
  v2 does not use.
- A paid v2 claim not confirmed in time is retried in the background for about a
  minute and a half (at most about three minutes when every attempt times out).
  The retry queue lives in memory: claims still pending at shutdown are
  re-driven only by the payment server's own recovery at the next start, and a
  claim not settled within the channel's window (about two minutes) lapses, so
  the seller is not paid for it.

- A timeout, a 503 or a missing history entry does not prove that no payment
  happened. Uncertain payments block new ones until reconciled; there is no
  automatic retry or provider switch after settlement was attempted.
- A buyer can be charged and still not receive the answer (for example after a
  disconnect). That case must be reconciled as charged but undelivered.
- `buyer:reconcile` clears only **zero-charge** outcomes.
  Charged-but-undelivered recovery, missing-claim recovery and journal-derived
  paid exports are not implemented; `--audit-only` can still verify a charged
  payment.
- The verifier supports only fresh, individually settled channels with the
  expected account shapes. Anything else fails closed and needs manual
  investigation. It does not recover channel rent.
- The facilitator keeps channel state in memory. Durable channel storage,
  unilateral channel closure and recovery of all channel rent are not validated.
- Lock checks are cooperative and local: not a defense against a hostile process
  of the same user, not a multi-host lock. An interrupted `recovery.lock` needs
  manual investigation.
- Local persistence is not crash-proof. A full or read-only disk can lose a call
  row; the earlier journal then still blocks new payments.
- `exact` replay protection holds only within one seller process, not across
  restarts or several sellers.
- The fixed failure gate covers an empty buyer and an expired authorization
  only; it is not a replay or seller-crash test.

See [recovery.md](recovery.md) for how recovery works.

## Private facilitator diagnostics

- Diagnostics are a bounded ring buffer: restarts and rotations delete the
  oldest files, and a busy buyer can force rotations. Archive files you need.
- Records can be lost on a crash, forced exit or late SDK return; a missing
  record does not prove an operation never ran. File opening has no deadline.
- A crash during cleanup can leave one extra quarantine file outside the 64 MiB
  bound; a deleted file still held open by a process keeps its disk space.
- File checks protect cooperative POSIX storage on macOS/Linux only. Windows
  permissions are unvalidated.
- The older in-memory `/facilitator/events` and `/facilitator/verifications` are
  not sanitized; do not publish them.
- Loopback `Host` checks stop browser DNS rebinding, not other local processes.
  Ollama is not covered by them.

## Inference and verification

- Free-inference usage receipts are signed, exchanged and privately stored.
  Signatures attest to each party’s observation, not independently truthful
  usage. Token recounts **detect** an overcharge within the ceiling after
  settlement; they do not prevent, refund or penalize it.
- Model pins check local artifacts only. The buyer cannot verify the remote
  seller's model or the correctness of an answer.
- Paid v1 responses remain buffered, without first-word latency measurement.
  Free v2 supports incremental SSE; its synthetic native-loopback acceptance
  does not establish real-model or production streaming performance.
- Only the pinned Qwen3 0.6B engine is validated end to end.
- The seller's 1.5 GiB memory reserve is an admission policy, not a guarantee.
  Later memory pressure or model eviction can still break a request. The model
  stays loaded for five minutes; offers expire after four.

Details: [inference.md](inference.md).

## Transport and privacy

- Route labels are sampled observations, not proof of every packet's path.
- A direct connection reveals each peer's IP address. Relay-only modes
  (`GYBLOS_RELAY_ONLY`, `GYBLOS_BUYER_RELAY_ONLY`) have only been checked
  offline; off-host privacy is unmeasured. The relay always sees both IPs.
- Without `GYBLOS_BUYER_RELAY_ONLY=1`, requiring a relay route does not hide the
  buyer's address.
- Relay-token handling is tested offline; a successful native bind and relay
  handshake are not covered by the offline suite.
- Only one relay (`na1`) exists. The default changes when `na2` is deployed.
- `@number0/iroh` 1.1.0 has no Intel Mac build and no DHT, pkarr or gossip API.

## Admission limits and abuse

The seller limits work per Iroh identity, but identities are free to create.

- Limits: one control and one data connection and one active request per NodeId
  (so four identities can occupy all eight connection slots), two active
  requests globally, eight pending handshakes (two per source address), and 30
  requests per NodeId within a shared 256-request minute.
- Free challenges and failed requests count. About nine identities sending 30
  free requests each can deny new peers for the rest of the minute. No payment
  is needed for that; there is no Sybil resistance or availability guarantee.
- A disconnected peer has no guaranteed reservation; reconnecting may need to
  wait for spare capacity or the next window.
- Source budgets use full IP addresses (IPv6 not grouped by prefix) and relay
  identities, which are cheap to replace. Peers behind one NAT share a source
  limit.
- Stuck native handshakes or writes cannot be cancelled and can fill their
  bounded pools.
- These limits are tested with loopback Iroh only, not over relays or real
  networks.

## Local files

- Keys, journals and diagnostics live in the product home (`.local/gyblos/`, one
  directory per role) and the lab home (`.local/lab/`). Models and the tokenizer
  are in `.local/gyblos/artifacts/`. Never share role or lab directories.
- Legacy `.local/p2p`, `.local/devnet` and `.local/ollama/models` data is never
  migrated automatically; startup refuses until it is moved by hand
  ([running-a-node.md](running-a-node.md#local-home)). The check is local and
  existence-based only.
- `GYBLOS_GATE_CONFIG` moves only the lab config file. `gate:setup` writes the
  keys next to it, but `gate:inference` accepts only keys in the lab home
  (`GYBLOS_LAB_HOME`); journals and models never follow it.
- `.env` is not loaded; set variables in the process environment.
- P2P role funding remains manual. `buyer:trust` creates the trust file only
  from explicit seller identities after checking the signed offer.
- Local gate reports (`gate-0004.json`, `gate-0005.json`) are not signed
  receipts and are not committed.

## Test coverage

The offline suite uses synthetic inputs, mocked RPC, native loopback Iroh and
one saved public finalized payment pair. It does not establish a fresh chain
audit, public relay compatibility, exactly-once settlement or physical recovery
of a signed offer. Unsigned modified payment variants in the fixture were never
executed on-chain. See [tests/README.md](../tests/README.md).

HTTP discovery is opt-in and limited to independently configured owner–NodeId
bindings. Opt-in read-only 8004 admission verifies expected bindings
independently and persists scoped high-water/tombstone state, with explicit
manual overrides. It does not enroll unknown sellers, provide DHT discovery or
establish live-index production availability. Replay state and withdrawal
barriers persist; a retained lock or unsafe/corrupt state fails closed. Payment
execution remains the compatible trusted v1 flow.

Seller discovery publication is opt-in and locally tested. It uses one durable
public-v2 sequence allocator shared with control Iroh; it does not establish a
live public index, automatic 8004 identity, off-host reliability or production
load capacity. Unreachable withdrawal delivery relies on signed-record expiry.
Deleting/restoring local sequence state and automatic crash-lock recovery are
unsupported; Windows power-loss durability is unverified. A separate background
warmup/memory check can establish fresh v2 readiness; publication itself cannot.
Checks are skipped while inference is active and cancelled when inference
starts. An engine ignoring abort holds the single check slot and keeps
availability closed until it settles; no queued retry can accumulate. Shutdown
invalidates snapshots without waiting for an uncooperative engine. Timing is
locally tested, not a production load/cancellation guarantee. The legacy paid
offer retains its original expiry, and free execution has separate startup
acceptance. Paid v2 uses a separate conditional execution path; its devnet
settlement remains unverified as described above.
