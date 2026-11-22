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

For seller fees and channel closure, see
[Payment sessions](payment-sessions.md).

**Uncertain outcomes**

- A timeout, a 503 or a missing history entry doesn't prove that no payment
  happened. Uncertain payments block new ones until reconciled. There is no
  automatic retry or provider switch after settlement was attempted.
- A buyer can be charged and still not receive the answer, for example after a
  disconnect.
- A lost reply to a closure or refund send keeps the signed transaction's
  signature and reports it unconfirmed. Finalized reconciliation is still
  required, and a missing account is not proof of a refund.

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

- A priced seller accepts authenticated buyers up to its configured capacity of
  1–16 unfinished sessions. Verified closed journals remain available after
  leaving the active index.
- Windows validates access to payment folders, locks and journals using ACLs.
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
- Free requests and payment sessions can produce signed usage receipts.
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
- Only the pinned Qwen3 0.6B engine is validated end to end. Any model can be
  priced, but only the Qwen3 family, which shares one pinned public tokenizer,
  is recounted. Other models bill the provider's declared usage, which the buyer
  bounds by bytes: an inflated count inside those bounds is accepted, up to the
  request's `maxTokens` and `maxAtomic`. Each tool call adds its own allowance
  to the output bound, so many tool calls raise it further.
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
