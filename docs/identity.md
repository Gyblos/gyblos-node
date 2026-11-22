# Identity (8004 agent registry)

A seller's NodeId is its Iroh public key. On the 8004 agent registry on Solana
devnet, the seller's owner wallet holds a registry asset that carries a binding
to that NodeId, signed by the node key. A buyer can require that binding before
it sends a prompt or a payment, so a listing or a seller's own claim never
creates trust. The discovery index also checks the binding before it registers a
seller.

`packages/identity` (`@gyblos/identity`) is the adapter. It runs on devnet only
and is built on `@solana/kit`, without Anchor or an indexer. The registry
program, collection and genesis it trusts are pinned in `@gyblos/config`
(`packages/config/src/identity.ts`).

Identity establishes a binding between an owner and a NodeId. It does not
establish model quality, capacity, reputation, payment authority or the
correctness of an answer.

## GitHub account claim

Separately from the registry, a seller can show which GitHub account runs it.
The node key signs an identity claim (`@gyblos/protocol/identity-claim`,
specified in
[packages/protocol/SPEC.md](../packages/protocol/SPEC.md#identity-claim-v1)):

```json
{
  "claim": {
    "schemaVersion": 1,
    "kind": "github",
    "nodeId": "<64 lowercase hex>",
    "account": "octo-cat",
    "gist": "0123456789abcdef0123456789abcdef",
    "issuedAt": 1763078400000
  },
  "signature": "<128 hex>"
}
```

`account` is the lowercase GitHub login (at most 39 characters) and `gist` the
id of a public gist that account owns. That gist must contain, on a line of its
own, the proof line `gyblos-node=<nodeId>` (`githubProofLine(nodeId)`). Both
fields `null` cancels the claim. The signing domain is
`gyblos/identity-claim/v1\n`.

Anyone can re-check the binding: verify the signature with the NodeId, then
fetch `https://gist.githubusercontent.com/<account>/<gist>/raw`, which answers
only when the account owns the gist (the account name is matched
case-insensitively), and look for the proof line. The discovery index does this
for sellers it knows and publishes the result
([discovery-index.md](discovery-index.md#github-claims)). Clients must treat an
account as proven only when the index reports `state` `verified`.

A seller creates and sends its claim with `gyblos seller verify github <user>`
([running-a-node.md](running-a-node.md#github-verification)).

A GitHub claim is a public label, not buyer trust: it is not the 8004 binding
and no buyer admission policy reads it.

## Seller registration

`gyblos seller register` registers the seller on the 8004 registry when the
discovery index reports that its NodeId has no registration. The procedure,
prompts and error codes are in
[running-a-node.md](running-a-node.md#seller-registration).

What happens on chain:

- The owner wallet funds the registration with devnet SOL. The command simulates
  the transaction, shows the estimated cost and asks for `yes` before it signs.
  Nothing is signed or sent on any other answer.
- One transaction creates the registry asset and writes an owner-signed
  `gyblos.nodeId` metadata entry. The entry carries the node key's signature
  over (version, sequence, program, asset, owner); the sequence is the
  registration time in milliseconds.
- The asset key and the signed attempt are stored in
  `<home>/seller/registration-8004-v1.json` under a private lock
  (`@gyblos/node/seller-registration`). Running the command again checks that
  attempt first. It resends the same signed bytes when the outcome is unknown,
  and builds a new attempt with the same asset, after fresh consent, only when
  the old one has expired and the asset is absent.

> **Warning:** Registration spends the owner's devnet SOL and can't be undone;
> most of the cost is rent. Keep the registration file while an attempt is
> unresolved: deleting it can lead to a second, separately paid asset. To stop
> without spending, answer anything other than `yes`.

## Require identity as a buyer

`pnpm buyer:init` writes an `identity` object into the buyer's `selection.json`,
so a buyer created that way verifies every seller. To add it by hand:

```json
"identity": { "rpcUrl": "https://api.devnet.solana.com", "reuseMs": 300000 }
```

| Field     | Meaning                                                                                                                                                          |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rpcUrl`  | Required. The devnet RPC the buyer reads the registry from: `https`, or `http` on loopback, without credentials, query or fragment. No implicit RPC URL is used  |
| `reuseMs` | Optional. How long an admitted binding is reused before the next read, 0 to 3,600,000 ms; default 300,000 (`BUYER_IDENTITY` in `packages/node/src/constants.ts`) |

Each entry in `sellers` names the NodeId and the expected `owner`. With
`identity` set, each seller needs independent registry verification unless its
entry sets `"manualTrust": true`. The rest of `selection.json` is described in
[running-a-node.md](running-a-node.md#optional-buyer-selection-and-discovery).

The buyer checks identity before it admits an index record, before it opens a
control connection, after it gets a quote, and immediately before free execution
or a paid channel open. A seller that fails the check drops out of selection;
the terminal chat reports it as `SELLER_IDENTITY_UNVERIFIED`. Unusable local
identity state stops the whole request instead: the free buyer refuses to start
with `IDENTITY_STATE_UNAVAILABLE`, and a running buyer refuses with
`BUYER_IDENTITY_STATE_UNAVAILABLE`. Investigate the state instead of deleting it
([Local state files](#local-state-files)).

Without `identity`, no registry client or state is opened, and the configured
owner and NodeId pairs in `sellers` are trusted as written.

## Read-only resolution and trust policy

`@gyblos/identity/resolution` exposes
`readRegistryIdentity(rpc, nodeId, options?)`. Its RPC port has only
`getGenesisHash`, `getProgramAccounts` and `getMultipleAccounts`. It builds no
transactions, loads no signer, touches no local files and uses no discovery
index. The caller supplies the RPC client.

- **Pinned profile.** The reader refuses a wrong genesis before any account
  scan. It never switches to mainnet or another deployment address.
- **Finalized reads.** Account reads use finalized commitment. One lookup has an
  absolute deadline, 5 seconds by default and configurable from 1 ms to 30 s.
  Cancellation reaches the RPC, and a late result never becomes a success.
- **Results.** Every result is bound to its queried NodeId: `bound` with a
  verified `{nodeId, owner, asset, sequence}`, `missing`, or `unavailable` with
  a static reason. Invalid NodeId input yields a sanitized null query marker.
- **Claimants.** The authoritative owner is the Core asset, not the registry's
  cached owner. Only bindings whose node signature verifies count. At most 16
  claimants (`READ_LIMITS.maxClaimants`) are considered per NodeId; more means
  "cannot decide", not "unregistered". The highest valid signed sequence must
  identify one asset; equal highest claims on different assets are ambiguous,
  even for the same owner.

`resolveOwner` and `readNodeIdentity` are older entry points with owner-only
semantics and their own defaults. Use `readRegistryIdentity` for admission.

`@gyblos/core/identity-policy` exposes the pure `evaluateIdentityPolicy(value)`:

- The caller supplies the expected owner, NodeId and registry scope. A registry
  observation must come from the verified adapter; shape validation alone is not
  signature or chain verification.
- The returned `state` holds the latest binding (its sequence is the **floor**)
  and any local revocation record (a **tombstone**), scoped to network, program,
  collection and NodeId. Keep the returned state even when a changed owner is
  denied.
- A lower sequence, or an equal sequence with a different owner or asset, is
  refused. A higher verified binding can move ownership, but it does not
  authorize the previous owner's offer.
- A missing identity after a prior acceptance creates a tombstone. The same or
  an older binding cannot reactivate it; only a strictly higher verified
  sequence can.
- Outages, timeouts, cancellation, ambiguity, scope mismatches and
  claimant-limit failures deny without erasing the previous state.
- An explicit `manual: {owner, nodeId}` pin takes precedence, even during a
  registry outage or after a local revocation. Its result is labelled `manual`,
  never registry-verified, and it keeps the floor and tombstone, so removing the
  pin cannot restore a revoked or older binding. A malformed or mismatched pin
  is refused. Without a pin, a registry failure never falls back to manual
  trust.

The policy owns no storage, cache, clock or RPC. `sequence` stays a `bigint`. A
denial without state is not permission to delete persisted state.

## Durable buyer identity admission

`@gyblos/node/identity-state` owns `openBuyerIdentityState(environment, scope)`.
Its `evaluate()` transaction rereads persisted state under an exclusive lock,
applies the pure policy and atomically commits the returned state **before it
returns, including on a denial**. `@gyblos/node/identity-verifier` composes that
transaction with independent `readRegistryIdentity` observations. It never
registers agents, loads signers or makes payments.

Reuse window (`reuseMs`):

- Only admitted bindings are reused; failures and manual pins are not cached.
- Each use still evaluates the durable floor and tombstone. A revocation or a
  newer floor that another verifier in the same home already recorded takes
  effect immediately.
- Within the window, an RPC outage does not exclude an already verified seller,
  and an unseen owner change or revocation is found on the next fresh read.
- The window uses both wall-clock age and monotonic elapsed time, so a clock
  rollback cannot extend it and a suspended machine still expires it.
- Set `reuseMs` to `0` to read on every check, as the identity acceptance runs
  do.

Trust rules:

- `manualTrust: true` skips the lookup and returns manual provenance. It never
  erases a floor or tombstone, and it cannot bypass unsafe or failed storage.
- An expected `owner` alone is never a fallback when the lookup fails. Adopting
  a newly verified owner requires changing the expected owner in
  `selection.json`; the denied lookup still advances the stored floor.
- With open discovery, the buyer admits indexed candidates only after
  independent registry verification and signed record and quote checks. Index
  claims never create trust or reset identity history.
- Identity checks never reset public replay state. An owner rotation requires a
  public catalog newer than the old node-wide high-water mark, and keeps
  withdrawal and conflict floors.
- Catalog, presence and withdrawal signatures, exact-catalog binding, request
  correlation, the authenticated Iroh peer and signed quote validation remain
  mandatory. Free streaming never changes seller or retries after sending
  begins.

### Local state files

`identity-state-8004.json` and `identity-state-8004.lock` live in the buyer role
directory (`homeLayout(...).roles.buyer`, mode 0700; files 0600). They hold
scoped public binding metadata and tombstones, never prompts, responses,
signatures, RPC URLs, keys or payment journals.

- Sequences are canonical u64 decimal strings. Canonical JSON rejects duplicate
  or unknown fields and duplicate NodeIds.
- Limits are 1,024 rows and 1 MiB. No expiry or eviction removes security
  history.
- Writes use an exclusive lock, a unique temporary file, file sync, atomic
  rename and parent sync where supported.
- Contention, stale locks, malformed or unsafe files, failed writes and observed
  rollback or disappearance fail closed. Symlinked path components, symlinks,
  hard links and special files are refused; use a canonical home path.

> **Caution:** Don't clear the state file or lock to make a seller pass. The
> buyer cannot detect a filesystem rollback or a full deletion across a fresh
> process, so restoring an old backup can silently lose observed revocations.

## Limits

- The registry has no universal revocation flag; reputation's `revokeFeedback`
  is unrelated. A removed `gyblos.nodeId`, a burned or missing Core asset, or a
  changed Core owner without a new valid node proof removes a valid identity.
  These conditions do not prove the operator's intent. A burned Core asset can
  leave its agent account behind. References:
  [pinned registry identity instructions](https://github.com/QuantuLabs/8004-solana/blob/6b344c9c71871daa35f649a6260e180be33c6810/programs/agent-registry-8004/src/identity/instructions.rs)
  and
  [pinned SDK burn semantics](https://github.com/QuantuLabs/8004-solana-ts/blob/67a896a6a871ca333c59b99fd73882d07d659959/docs/METHODS.md#burnagent-notes).
  These source revisions do not prove the deployed bytecode.
- Finalized reads span several requests, not one atomic snapshot, and no read
  can freeze ownership after its last observation.
- The RPC provider must be trusted for completeness. Genesis pinning does not
  prove the provider is honest.
- Removing a newer claim can reveal an older valid one. The stored floor rejects
  that rollback, but a first-time reader cannot reconstruct unseen history.
- The node signature covers program, asset and owner but not the cluster, so a
  binding is valid on any cluster that runs the same program with the same asset
  and owner.
- Reading by owner filters on the agent account's cached owner, so an asset
  transferred without that cache updating is missed. Results are rechecked
  against the Core owner, so they are never misattributed.
- Anyone who pays for 17 registrations claiming one NodeId can make it
  unresolvable (the claimant cap).
- Windows behavior and crash or power-loss recovery of the state files are
  covered only by synthetic tests.
- The 8004 program (`IDENTITY_REGISTRY_DEVNET` in `@gyblos/config`) is
  upgradeable by a single wallet,
  `2KmHw8VbShuz9xfj3ecEjBM5nPKR5BcYHRDSFfK1286t`, which is not a multisig and
  also holds the registry authority. An upgrade could change layouts or
  ownership checks. Golden tests pin real devnet account bytes. Treat 8004 as
  one signal verified by the Gyblos binding signature; the deployment addresses
  live in `@gyblos/config`, so another instance can replace it.

## Contributor reference

### Bounded RPC transport

`@gyblos/identity/resolution-rpc` exposes
`createIdentityResolutionRpc(url, options?)`, the transport the default buyer
uses. Node composition accepts either a URL (always bounded) or an injected
read-only RPC port, whose transport the caller owns. Registration and
sponsorship keep their own transports.

- **Size.** At most 1 MiB per decoded HTTP response, counted on the stream after
  decompression, so a missing or wrong `Content-Length` cannot bypass it.
  Options may lower `maxResponseBytes` (1 to 1,048,576); selection configuration
  cannot raise it. The bound covers response bytes, not the process heap.
- **Deadline.** One absolute deadline per HTTP operation, 5 s by default
  (`timeoutMs`, 1 to 30,000), covering headers, body and parsing. Caller
  cancellation is honored, and a late response is discarded. Parsing is
  synchronous, so a deadline refuses a late parsed result but does not preempt
  parser CPU time.
- **Methods.** Only `getGenesisHash`, `getProgramAccounts` and
  `getMultipleAccounts` pass, even from an untyped caller. Redirects are
  refused. There is no retry or request coalescing.
- **Parsing.** Strict UTF-8, the pinned Solana BigInt JSON helpers and SDK
  transformers. Response IDs must match, and the result or error envelope must
  be unambiguous. Remote error contents never appear in the static errors.
- **Oversize.** `IDENTITY_RPC_RESPONSE_TOO_LARGE` becomes an `unavailable`
  lookup with reason `LIMIT`, never `missing`, so an accepted binding is not
  revoked.

An injected `fetch` supports synthetic tests without replacing the global one.

### Sponsored registration (lab only)

The lab command `pnpm identity:devnet-run` tries a sponsored flow on devnet, and
opt-in tests run it against a local validator (see
[tests/README.md](../tests/README.md)). Product code does not wire sponsorship.

- `buildSponsoredRegistration` builds one atomic transaction paid by a sponsor:
  an exact rent prefund to the owner (sized by `simulateOwnerSpend`), the
  registration, the owner-signed `gyblos.nodeId` binding, and the payout wallet
  with its Ed25519 proof. The owner can hold 0 SOL. The final message is
  simulated once more, so an under-funded result throws `SIMULATION_FAILED`
  before anything is signed. It reports `sponsorCostLamports` (prefund plus
  network fee) and refuses to build above the caller's `maxSponsorCostLamports`.
- Rebinding: the latest binding signed by the node key wins. `bindingSequence`
  is a u64 that must strictly increase per node key. A previous owner cannot
  outbid a rebinding without the node key, and a tampered sequence fails the
  signature. Legacy v1 values without a sequence count as 0; only v2 is written.
- `undefined` from `resolveOwner` means no valid claim was found, not
  "unregistered, sponsor again". The sponsorship ledger decides whether a device
  or owner was already sponsored.
- The sponsor policy (`evaluateSponsorRules`, `decideSponsorship`,
  `recordSponsorship`) applies a per-registration cap, a total budget, one
  sponsorship per device key and per owner, then a required online check.
  `decideSponsorship` issues a fresh 32-byte challenge, and the check must
  return the node key's signature over
  `onlineChallengeMessage(challenge, request)`; wrong, stale or foreign
  signatures deny. Device keys must be canonical NodeIds (64 lowercase hex
  characters).
- Sponsorship stays out of product until an online check dials the NodeId over
  Iroh, delivers the challenge and verifies the node's signed catalog. Keys are
  free to generate, so without that check sponsorship can be farmed. The lab
  answers the challenge locally, which is not such a check. The ledger is not
  persisted.
- A sponsored transaction that fails on chain still costs the sponsor its
  network fee. Count failed attempts in the budget and never retry blindly.
- Most of a registration's cost is rent; only the metadata rent is refundable.
  With the v2 binding the transaction uses about 1,180 of 1,232 bytes, so
  `agentUri` must stay short (about 90 bytes).
