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
- Mainnet, MPP, mobile apps, reputation, penalties and seller discovery are not
  implemented.

## Payments and recovery

- A timeout, a 503 or a missing history entry does not prove that no payment
  happened. Uncertain payments block new ones until reconciled; there is no
  automatic retry or provider switch after settlement was attempted.
- A buyer can be charged and still not receive the answer (for example after a
  disconnect). That case must be reconciled as charged but undelivered.
- `p2p:reconcile` clears only **zero-charge** outcomes. Charged-but-undelivered
  recovery, missing-claim recovery and journal-derived paid exports are not
  implemented; `--audit-only` can still verify a charged payment.
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
- The older in-memory `/gate/events` and `/gate/verifications` are not
  sanitized; do not publish them.
- Loopback `Host` checks stop browser DNS rebinding, not other local processes.
  Ollama is not covered by them.

## Inference and verification

- There is no signed seller receipt. Token recounts **detect** an overcharge
  within the ceiling after settlement; they do not prevent, refund or penalize
  it.
- Model pins check local artifacts only. The buyer cannot verify the remote
  seller's model or the correctness of an answer.
- Responses are buffered: no buyer-facing streaming and no first-word latency.
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

- Limits: one connection and one active request per NodeId, two active requests
  globally, eight pending handshakes (two per source address), and 30 requests
  per NodeId within a shared 256-request minute.
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

- Keys, journals and diagnostics live under `.local/devnet/` (gates) and
  `.local/p2p/` (node roles). Models are in `.local/ollama/models/`. Never share
  these.
- `GYBLOS_GATE_CONFIG` moves only the config file, not keys, journals or models.
  Inference needs the default key paths.
- `.env` is not loaded; set variables in the process environment.
- There is no command yet to write the buyer's `trust.json` or to fund P2P
  roles.
- Local gate reports (`gate-0004.json`, `gate-0005.json`) are not signed
  receipts and are not committed.

## Test coverage

The offline suite uses synthetic inputs, mocked RPC, native loopback Iroh and
one saved public finalized payment pair. It does not establish a fresh chain
audit, public relay compatibility, exactly-once settlement or physical recovery
of a signed offer. Unsigned modified payment variants in the fixture were never
executed on-chain. See [tests/README.md](../tests/README.md).
