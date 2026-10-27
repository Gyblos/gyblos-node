# Identity (8004 agent registry)

`packages/identity` (`@gyblos/identity`) is an adapter for node identity on the
8004 Solana agent registry, devnet only, built on `@solana/kit` without Anchor
or an indexer. Buyer selection can opt into its read-only resolver; registration
and sponsorship remain lab-only. The lab command `pnpm identity:devnet-run`
tries the sponsored flow on devnet, and opt-in tests run it against a local
validator (see [tests/README.md](../tests/README.md)).

## Read-only resolution and trust policy

`@gyblos/identity/resolution` exposes
`readRegistryIdentity(rpc, nodeId, options?)`. Its RPC port contains only
`getGenesisHash`, `getProgramAccounts` and `getMultipleAccounts`. It constructs
no transactions, loads no signer, reads/writes no local files and uses no
discovery index. The caller supplies the RPC client. Node composition and opt-in
buyer wiring are described below.

The profile is deliberately pinned to the existing configured **devnet**
genesis, registry program and collection. A wrong genesis is refused before
account scans; no automatic mainnet switch or deployment-address change is made.
Account reads request finalized commitment (Kit may omit that option because
finalized is the JSON-RPC default). One absolute lookup deadline is 5 seconds by
default, configurable from 1 millisecond to 30 seconds. Cancellation is
propagated to RPC and late results cannot become lookup success; an
uncooperative provider may still retain its own work after the caller returns.

Every result is bound to its queried `nodeId`, including negative evidence.
Invalid NodeId input uses a sanitized null query marker. Results are `bound`
with verified `{nodeId, owner, asset, sequence}`, `missing`, or `unavailable`
with a closed static reason. The adapter reuses existing
program/collection/Core-owner/node-proof validation and claimant bounds. The
highest valid signed sequence must identify one asset: equal highest claims on
different assets are ambiguous, even for the same owner. The legacy
`resolveOwner` and `readNodeIdentity` APIs retain their prior defaults and
owner-only semantics; use the new entry for the new policy.

`@gyblos/core/identity-policy` exposes pure `evaluateIdentityPolicy(value)`:

- The caller supplies expected owner, NodeId and registry scope; seller/index
  claims cannot create trust. A registry observation must come from the verified
  adapter. Shape validation alone is not signature or chain verification.
- Returned `state` tracks the latest binding and local revocation tombstone,
  scoped to network/program/collection and NodeId. Retain returned state even
  when a changed owner is denied. Lower sequences and equal-sequence changes of
  owner/asset are refused. A higher verified binding can move ownership; it does
  not authorize using the previous owner's offer.
- Missing identity after prior acceptance creates a local tombstone; the same or
  older binding cannot reactivate it. Only a strictly higher verified sequence
  can. Outages, timeouts, cancellation, ambiguity, scope mismatches and
  claimant-limit failures deny without erasing the previous state.
- An explicit `manual: {owner, nodeId}` pin takes precedence, including during a
  registry outage or local revocation. Its result is labelled `manual`, never
  registry-verified. It preserves the registry floor/tombstone, so removing the
  override cannot silently restore a revoked or older binding. A
  malformed/mismatched pin is refused, not ignored in favor of another source.
  Without an explicit pin, registry failure never enables manual fallback.

The policy owns no storage, cache, clock or RPC. `sequence` remains a bigint;
the durable node store encodes it exactly and retains state across restarts. An
omitted state in a denial is not permission to delete persisted state.

## Durable buyer identity admission

`@gyblos/node/identity-state` owns `openBuyerIdentityState(environment, scope)`.
Its `evaluate()` transaction rereads persisted state under an exclusive lock,
applies the pure policy and atomically commits returned state **before
returning, including denials**. `@gyblos/node/identity-verifier` composes that
transaction with independent `readRegistryIdentity` observations; it never
registers agents, loads signers or invokes payments.

Opt in through the existing buyer `selection.json`:

```json
"identity": { "rpcUrl": "https://rpc.example" }
```

The value must be HTTPS or loopback HTTP, without credentials, query or
fragment. The profile and request network remain devnet-only. No implicit RPC
URL is used. The existing `sellers` list still owns allowed NodeIds, expected
owners and Iroh endpoints: public catalogs intentionally contain no connection
addresses. This slice does not enroll arbitrary sellers returned by the index.

With no `identity` property, existing configured owner–NodeId bindings retain
their manual semantics and no registry client/state is opened. In registry mode,
each seller requires independent registry verification unless that configured
seller explicitly sets `"manualTrust": true`. That override skips lookup and
returns manual provenance; it never erases a binding floor or tombstone, and it
cannot bypass unsafe or failed storage. An expected `owner` alone is never a
fallback when registry lookup fails. Adopting a newly verified owner requires a
deliberate expected-owner configuration update; the denied lookup still advances
the persisted registry floor.

The buyer independently verifies configured identities before admitting index
records (including held entries omitted by an index), before opening control,
after quoting, and immediately before free execution. Public catalog/presence/
withdrawal signatures, exact-catalog binding, request correlation, authenticated
Iroh peer and signed quote validation remain mandatory. Public replay metadata
is separate from registry u64 sequences. An independently allowed owner rotation
requires a public catalog newer than the old node-global high-water mark and
retains withdrawal/conflict floors. Identity checks never reset public replay
state. The paid v1 proxy still requires its separate compatible trusted v1
offer; a cached decision checks identity again before forwarding authorization
and any refusal stops with reconciliation, without retry or reselection. Paid v2
remains disabled. Free streaming never changes seller or retries after sending
begins.

The files `identity-state-8004.json` and `identity-state-8004.lock` live only
under `homeLayout(...).roles.buyer`. The private 0700 role directory and 0600
files contain scoped public binding metadata and local tombstones, never
prompts, responses, signatures, RPC URLs, keys or payment journals. Sequences
are canonical u64 decimal strings (including values above JavaScript's
exact-number range). Canonical JSON rejects duplicate/unknown fields and
duplicate NodeIds. Limits are 1,024 rows and 1 MiB; no expiry or eviction can
remove security history. Writes use an exclusive lock, a unique temporary file,
file sync, atomic rename and parent sync on supported platforms. Contention,
stale locks, malformed or unsafe files, failed writes and observed
rollback/disappearance fail closed; operators must investigate rather than
automatically clear state or locks. Symlinked path components, symlinks,
hardlinks and special files are refused. Use a canonical home path rather than a
symlink alias. Filesystem rollback or complete deletion across a fresh process
cannot be detected without an external anchor; restoring an old backup can lose
previously observed history. The local filesystem must be trusted. Windows and
crash/power-loss behavior have not been operationally certified by the synthetic
tests.

Lookup decisions are never cached as usable trust. Caller cancellation reaches
RPC; cancelled/late results cannot admit a quote or prompt. Static configured
candidate limits bound lookup fan-out. The default buyer uses the bounded RPC
transport described below. Read deadlines do not make multi-request chain
observations atomic and no read can freeze ownership after its last observation.
Real-registry/off-host/mainnet acceptance remains separate from local synthetic
tests.

### Bounded read-only RPC transport

`@gyblos/identity/resolution-rpc` exposes
`createIdentityResolutionRpc(url, options?)`. Node composition accepts either a
URL (the default buyer path, always bounded) or an injected read-only RPC port
(for callers/tests that explicitly own its transport). Legacy registration,
sponsorship and direct RPC APIs retain their existing transports.

The default limit is **1 MiB per decoded HTTP response**, including JSON framing
and whitespace. The fetch stream is counted after HTTP decompression; compressed
or absent/incorrect Content-Length cannot bypass the counter. An excessive
advertised length is rejected before allocating the bounded buffer. The reader
uses fixed storage rather than accumulating chunks, accepts fragmentation and
empty chunks, decodes strict UTF-8, then uses the pinned Solana BigInt JSON
helpers and SDK method transformers. Response IDs must match the request and a
JSON-RPC result/error envelope must be unambiguous. Remote error contents never
appear in the transport's static typed errors.

Each HTTP operation has one absolute deadline (default 5 seconds), covering
headers, body and parsing, and honors caller cancellation. Monotonic checks also
refuse late success when timer dispatch was delayed. Timeout, cancellation, HTTP
error and overflow release bodies without waiting for an uncooperative producer;
a late fetch response is discarded. Cleanup does not await late work. JavaScript
parsing is synchronous: deadlines refuse a late parsed result but do not preempt
parser CPU time. Fetch/decompression and parsed objects have their own
allocations; the byte limit is not a process-wide heap or aggregate-query
budget. Independently injected ports remain the caller's responsibility.

Options may lower `maxResponseBytes` (1 through 1,048,576) and set `timeoutMs`
(1 through 30,000); production selection configuration does not override the
byte ceiling. An injected `fetch` supports synthetic tests without replacing its
global counterpart. URLs must be HTTPS or loopback HTTP, without credentials,
query or fragment; redirects are refused. Only `getGenesisHash`,
`getProgramAccounts` and `getMultipleAccounts` are permitted by the transport,
even through an untyped caller. No transaction/signing/payment method is added.
There is no transport retry or request coalescing; independent requests keep
independent cancellation. SDK Solana request conversion, commitment defaults,
integer-overflow checks and exact BigInt response conversion are preserved.

An oversized response raises `IDENTITY_RPC_RESPONSE_TOO_LARGE` and becomes a
correlated unavailable lookup with reason `LIMIT`. It is never interpreted as a
missing binding, so a previously accepted binding does not become revoked. Other
provider faults remain unavailable, and explicit manual override and durable
history semantics are unchanged. RPC completeness, chain authenticity,
non-atomic observations and operational acceptance remain separate limitations.

### Revocation and evidence limits

There is no universal node-identity revocation flag in this contract.
Reputation's `revokeFeedback` is different. A removed mutable `gyblos.nodeId`, a
burned/missing Core asset or a changed Core owner without a new valid node proof
can remove a valid identity. These conditions can invalidate previously accepted
trust; they do not prove the operator's intent. A burned Core asset can leave
the AgentAccount PDA behind. The authoritative owner is the Core asset, not the
registry's cached owner. Primary references:
[pinned registry identity instructions](https://github.com/QuantuLabs/8004-solana/blob/6b344c9c71871daa35f649a6260e180be33c6810/programs/agent-registry-8004/src/identity/instructions.rs),
[pinned SDK burn semantics](https://github.com/QuantuLabs/8004-solana-ts/blob/67a896a6a871ca333c59b99fd73882d07d659959/docs/METHODS.md#burnagent-notes).
Those source revisions are not proof of the deployed bytecode; existing
fixture-pinned layouts and upgrade-authority limits below remain applicable.

Finalized reads span several requests, not one atomic snapshot. Claimant fan-out
is capped; response-size and concurrency limits still belong to the RPC
transport/caller, not this stateless API. The RPC provider must be trusted for
completeness and chain responses; genesis pinning is not cryptographic proof of
provider honesty. Removing a newer claim may reveal an older valid one. A
retained high-water mark rejects that rollback; a first-time reader cannot
reconstruct unseen history. Without caller persistence this protection does not
survive restart. Identity establishes a binding, not model quality, capacity,
reputation, payment authority or correctness of an answer.

Synthetic tests cover these reads and transitions; no live RPC, chain write,
payment or deployed-registry acceptance was run for this implementation.

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
