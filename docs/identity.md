# Identity (8004 agent registry)

`packages/identity` (`@gyblos/identity`) is an adapter for node identity on the
8004 Solana agent registry, devnet only, built on `@solana/kit` without Anchor
or an indexer. **Nothing in the node or apps calls it yet.** The lab command
`pnpm identity:devnet-run` tries the sponsored flow on devnet, and opt-in tests
run it against a local validator (see [tests/README.md](../tests/README.md)).

## What it does

- `buildSponsoredRegistration` builds one atomic transaction paid by a sponsor:
  an exact rent prefund to the owner (sized by `simulateOwnerSpend`), the
  registration, an owner-signed `gyblos.nodeId` metadata entry carrying the node
  key's signature over (version, sequence, program, asset, owner), and the
  payout wallet set with its Ed25519 proof. The owner can hold 0 SOL. The final
  message (with the computed prefund, which is 0 for an owner who can already
  pay) is simulated once more, so an under-funded result throws
  `SIMULATION_FAILED` before anything is signed. It reports
  `sponsorCostLamports` (prefund plus network fee) and refuses to build when
  that exceeds the caller's `maxSponsorCostLamports`.
- Rebinding: the latest registration signed by the node key wins. The caller
  passes `bindingSequence`, a u64 that must strictly increase per node key (unix
  milliseconds, or a counter persisted next to the key). `resolveOwner` takes
  the valid claim with the highest sequence; equal highest sequences on
  different owners throw `NODE_ID_AMBIGUOUS`. A previous owner cannot outbid a
  rebinding because it lacks the node key, and a tampered sequence fails the
  signature. Legacy v1 values (no sequence) are still read and count as sequence
  0; only v2 is written.
- `readNodeIdentity` (by asset or by owner) and `resolveOwner` (NodeId → owner)
  read chain accounts directly; ownership comes from the Core asset, and only
  bindings whose node signature verifies count, so a replayed binding on another
  asset is reported as invalid. Agents outside the configured 8004 collection
  are rejected unless the caller passes `COLLECTION_POLICY.ANY`. Each claimant
  is judged alone: a missing, burned, foreign or undecodable claimant is skipped
  and RPC failures propagate. At most `READ_LIMITS.maxClaimants` (16) claimants
  are considered per NodeId or owner, fetched together with
  `getMultipleAccounts`; more throws `TOO_MANY_CLAIMANTS` instead of picking a
  subset. That bounds the work but lets anyone who pays for 17 registrations
  make a NodeId unresolvable; callers must treat it as "cannot decide", not as
  "unregistered".
- `undefined` from `resolveOwner` means no valid claim was found. It must not be
  read as "unregistered, sponsor again": the sponsorship ledger, not a chain
  read, decides whether a device or owner was already sponsored.
- The sponsor policy (`evaluateSponsorRules`, `decideSponsorship`,
  `recordSponsorship`) applies a per-registration cap, total budget, one
  sponsorship per device key and per owner, then a required online check with no
  default. `decideSponsorship` issues a fresh 32-byte challenge, and the check
  must return the node key's signature over
  `onlineChallengeMessage(challenge, request)`; a bare `true` placeholder no
  longer type-checks, and wrong, stale or foreign signatures deny. Device keys
  must be canonical NodeIds (64 lowercase hex, as iroh prints an EndpointId),
  owners valid Solana addresses, and cap and budget positive. Costs are the full
  sponsor cost (prefund plus fee).
- **Sponsorship wiring is blocked** until a real online check exists that dials
  the NodeId over Iroh, delivers the challenge and verifies the node's signed
  catalog. The challenge only proves the check reached a holder of the device
  key; keys are free to generate, so without that check sponsorship can be
  farmed. The lab flow answers the challenge locally and is not such a check.
  Ledger persistence is also future work.
- A sponsored transaction that fails on chain still costs the sponsor its
  network fee (the prefund transfer is reverted with it). Budgets should count
  the fees of failed attempts, and a failure must not be retried blindly.
- Known limitation (cluster binding): the node signature covers (program, asset,
  owner) but not the cluster, so a binding is valid on any cluster that runs the
  same program id with the same asset and owner.
- Known limitation (stale owner index): reading by owner filters on the agent
  PDA's cached owner, so an asset transferred without that cache updating is
  missed (results are re-checked against the Core owner, so never
  misattributed).

## Cost

Cost per sponsored node, measured on a local validator running the devnet
bytecode: about 12.5M lamports (12,544,640: agent PDA rent 6,096,960, Core asset
3,226,080, nodeId metadata rent 3,201,600, fee 20,000), roughly US$1.35 at ~108
USD/SOL. It is mostly rent; only the metadata rent is refundable. The
transaction uses 1,180 of 1,232 bytes with the v2 binding, so `agentUri` must
stay short (about 90 bytes).

## Risk

The 8004 program `8oo4J9tBB3Hna1jRQ3rWvJjojqM5DYTDJo5cejUuJy3C` is upgradeable
by a single wallet, `2KmHw8VbShuz9xfj3ecEjBM5nPKR5BcYHRDSFfK1286t` (not a
multisig), which also holds the registry authority. An upgrade could silently
change layouts or ownership checks. The golden tests pin real devnet account
bytes; treat 8004 as one signal verified by our own binding signature, and keep
the option to deploy our own instance (the deployment addresses live in
`@gyblos/config`).
