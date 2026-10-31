# Private free-receipt collector policy

`@gyblos/core/receipt-collector` implements the first private ingestion policy,
without an HTTP endpoint, filesystem backend, exporter or startup wiring. It
accepts existing `receipt/v1` pairs, not inference requests, payments or public
statistics. No receipt leaves a process through this API.

## Boundary and ownership

`createPrivateReceiptCollector(store).collect(body, signal?)` takes one complete
canonical JSON UTF-8 byte body containing the existing `{ seller, buyer }`
envelope. This is an in-process policy boundary, not a newly registered network
protocol. No protocol fields, signing domains or golden vectors change.

The collector checks:

- Nonempty bytes, at most 4096 bytes and depth 16, strict UTF-8 and canonical
  JSON. Duplicate keys, trailing data and alternate whitespace are rejected.
- Strict existing receipt parsers, both node signatures, request/peer linkage
  and the buyer's binding to the seller receipt digest.
- Free pricing only; the existing parser requires amount and fee to be zero.
- A buyer attestation is mandatory. Its dispute fields must exactly match the
  discrepancies in its known input/output token counts and output bytes.

Disputes are retained as disputes. Unknown observations stay `null`; differences
in the two parties' latency observations are allowed. A signature attests a
claim, not truthful usage, delivery, a model or identity ownership. This layer
makes no RPC/index queries and does not verify owner-to-node registry bindings.
It applies no freshness/expiry policy: receipt timestamps are signed historical
claims, not expiring quotes. Fraud detection, aggregate accounting and public
ranking remain separate work.

## Atomic storage contract

`PrivateReceiptStore.insert(entry, signal?)` is injected, with no default
implementation. The entry contains the verified detached pair, its canonical
`[sellerNodeId, buyerNodeId, requestId]` key and a SHA-256 fingerprint of the
entire canonical pair, including signatures. The fingerprint is a storage
identity, not a new signing domain.

The backend must atomically return:

- `INSERTED` for a new key.
- `IDENTICAL` for the exact same pair, without a second insertion.
- `CONFLICT` for a different pair at an existing key, preserving the first.
- `FULL` when its configured capacity prevents insertion, without eviction.

The key deliberately excludes `requestDigest`. A seller cannot turn a changed
request digest into an independent stored call by re-signing the same request
ID. Changed seller or buyer attestations conflict, including attempts to replace
a disputed pair with an agreed one. Independent peer pairs can reuse request
IDs. Atomicity across processes and collector instances belongs to the backend;
a read-then-write implementation does not satisfy this contract.

The backend owns private access control, bounded total storage, capacity,
retention, concurrency and durability. Policy tests use a synthetic memory
backend. The optional private file implementation described below is available
separately and is not wired into any runtime host. Deduplication lasts only
while the backend retains the key. Retention and replay tombstones must be
specified before external collection/public counting is enabled. No aggregate
counter or public metric is maintained by this API.

## Admission, cancellation and errors

Each collector instance admits at most four active calls without a queue.
Invalid submissions consume admission too. These are prototype policy bounds,
not measured production capacity or per-peer/Sybil protection. Callers must
supply future transport body-read limits, deadlines, authentication and abuse
protection; the already bounded body passed here is not a bounded network read.

The caller supplies cancellation; core creates no timers or clock. Cancellation
is checked before validation and before storage, and suppresses a successful
acknowledgement after cancellation. The backend must honor abort-before-commit.
If storage already committed before cancellation or acknowledgement failure,
there is no rollback promise. Retry only the identical receipt metadata, never
the prompt. The admission lease remains occupied until crypto/storage settles,
so an uncancellable backend cannot create unlimited abandoned work. A
permanently stalled backend can occupy the bounded pool and requires lifecycle
handling by its future host.

Results contain only `STORED` or `DUPLICATE`. Typed errors use the static
`RECEIPT_COLLECTOR_CODES` catalog. Conflicts and capacity are explicit; backend
exception text and input contents are never echoed. There is no logging,
external transmission, exporter activation, payment execution or prompt retry.

A future host must choose privacy/access and retention policies before exposing
collection. Complete receipts remain private to Gyblos under the existing
metrics decision; public per-seller/model aggregates and buyer totals require a
separate reviewed implementation. Local telemetry is not an independent source
of usage truth and is not a substitute for verified ingestion.

## Optional private file persistence

`@gyblos/telemetry-file/receipt-store` implements the storage port separately
from the existing rotating telemetry log. Its entry is never imported by normal
startup. No home path, uploader, HTTP endpoint, payment or public accounting is
configured. Existing telemetry file prefixes and behavior are unchanged.

`createReceiptFileStore({ path, maxEntries?, maxBytes?, maxPending? })`
explicitly creates a new store and refuses an existing snapshot.
`openReceiptFileStore` requires an existing valid snapshot; missing files never
become empty history. The caller supplies a complete absolute file path, so no
node home layout or configuration is added. Close releases the writer lock after
admitted writes settle; later inserts fail with a static code. Imports perform
no file I/O.

One runtime process lock owns the file for the entire store lifetime. Another
instance or process is refused while that owner is alive. The existing runtime
can reclaim a verifiably dead same-host owner under its documented assumptions;
foreign/uncertain lock owners fail closed. This is cooperative single-host
locking, not distributed fencing or protection from a malicious process of the
same OS user. No automatic lock repair specific to receipts is introduced.

Within the owner, writes serialize with at most four admitted operations
(including the active write). Extra calls fail `BUSY`, without growing a queue.
The limits may be lowered explicitly. Every incoming entry is detached before
queuing and re-verified through the existing core policy, including its derived
key and fingerprint. A restart verifies every stored pair, strict canonical
snapshot shape, unique keys and signatures before accepting new writes.

Defaults and hard ceilings are 256 entries and a 1 MiB snapshot. `FULL` never
evicts, prunes or resets observations; exact duplicates still succeed at full
capacity. There is no automatic age-based retention. Keys remain until the
operator deliberately replaces/destroys the entire store. This preserves
idempotence across normal restarts but is not rollback-resistant storage: an
older valid snapshot restored between lifetimes cannot be detected without an
independent anchor. Time retention and tombstones must be decided before
external collection or public counting is enabled.

Directories and files are owner-only, using the existing runtime's bounded,
no-follow, single-link reads and owner checks. Stage and snapshot files use mode
0600 and directories 0700. This is filesystem access control, not encryption at
rest. Windows ACL acceptance is not established; this backend is validated on
POSIX only. No existing keys, node stores or real local data are read.

A write stages the full bounded snapshot, syncs it, rechecks the owned lock,
directory and unchanged previous snapshot, then checks cancellation immediately
before dispatching atomic rename and syncing the directory. Before that commit
boundary, cancellation removes only the stage it created and preserves the old
snapshot. An already dispatched native rename cannot be cancelled; a committed
write can lose its acknowledgement. Retry only identical receipt metadata, never
inference. A storage failure can require close/reopen; the backend does not
silently reset state to make another call pass.

Staging uses one fixed sibling file under the exclusive lock. An orphaned stage
causes open to fail without deleting it, preventing repeated automatic crash
recovery from accumulating temporary snapshots. Snapshot and stage together may
use roughly twice the configured snapshot byte budget, plus the bounded lock.
There is no unconditional recovery from corrupt initialization or uncertain
writes. The runtime's sync caveats still apply: particularly, ordinary macOS
fsync does not establish power-loss durability of the drive cache.

Tests use synthetic receipts, real private files in disposable directories and
an isolated child process to check ownership. They do not validate production
load, crash/power-loss durability, multi-host storage, hostile local processes,
Windows ACLs or any external collection service.

## Standalone local receiver

`@gyblos/receipt-collector` composes the core policy with an explicitly selected
retained store. It never imports buyer/node startup, engines, payments, registry
adapters or an outbound client. Nothing uploads from a buyer or seller.

The service binds only `127.0.0.1`; it accepts exactly `POST /v1/receipts`.
There are no read, health, delete, reset, public aggregate or administrative
HTTP routes. Queries and alternate paths are refused. The existing exact-port
loopback Host guard rejects DNS rebinding. Browser Origin/Sec-Fetch-Site
requests are refused; CORS and redirects are not enabled. Loopback is not
authentication.

Each required configuration grant has one buyer NodeId, one independent random
32-byte capability (64 lowercase hex characters) and explicit `consent: true`.
The operator must obtain authorization before provisioning that grant; the
boolean does not prove a human consent interaction. Missing/false consent, empty
grants, duplicate buyers/tokens or unknown settings refuse startup. One
capability authorizes receipt submission for that buyer only. The service checks
`Authorization: Bearer <token>` before reading the body, then requires the
cryptographically verified buyer attestation to match the grant. Tokens are
compared through fixed-length SHA-256 digests and constant-time equality. They
are not node/wallet signatures, an 8004 proof or payment authorization. Removing
a grant or rotating a token requires a restart. A host process under the same OS
account can read its own private configuration; this is not a hostile-user
security boundary.

Bodies are the existing canonical `{ seller, buyer }` JSON UTF-8 pairs, with
`Content-Type: application/json`, no content encoding and a 4096-byte cap.
Unknown/ambiguous input, seller-only pairs, invalid signatures and conflicting
pairs are refused. Successful replies contain only `status: stored` or
`status: duplicate`; failures are static `COLLECTOR_*` codes, without input,
credentials, identity or filesystem detail. Host refusal is an empty 421 from
the shared runtime guard. HTTP parse/header errors can close the connection
before a collector response exists. No receipt contents are returned or logged.

Fixed prototype bounds: 16 connections, four active requests globally, one
active request per granted buyer, ten authenticated requests per buyer/minute,
and 120 requests/minute globally (including invalid credentials). There is no
queue. Invalid submissions consume the corresponding quota; grants cap the
principal table at 32. These are local safety bounds, not measured production
capacity or protection from a malicious OS user. Every response closes its
connection. Headers and socket inactivity are bounded; the application deadline
is five seconds from receiving complete headers, while the Node HTTP fallback
and inactivity cutoff are twice that bound. Startup settings may lower the
application deadline. A timeout/disconnect suppresses late success, but an
already dispatched filesystem rename can still commit. Retry identical receipt
metadata only, never inference. Close stops admission, closes sockets and waits
for admitted work; after five seconds it reports timeout while pending native
I/O retains its ownership until it settles. It never breaks a lock to finish.

### Retention with private replay markers

`@gyblos/telemetry-file/retained-receipts` is a separate, opt-in storage entry.
The older `receipt-store` API and version-1 snapshot format remain unchanged. No
existing snapshot is migrated automatically. Shared private snapshot I/O keeps
the same exclusive process ownership, bounded no-follow reads and staged
sync/rename. Explicit create refuses an existing file; open refuses missing or
corrupt history. The retained format records its policy and refuses a different
retention duration on reopen.

A positive retention duration is required (at most seven days); this is an
operator choice, not a new network-wide retention decision or default.
Expiration uses local ingestion time, never the receipt's claimed timestamp. The
service sweeps once per second while running, and reopening purges expired
bodies before listening. Ingress also checks expiration. Duplicate submissions
never extend retention. After expiration, the full signed body becomes `null`; a
private canonical key, fingerprint and received-at time remain as a replay
marker. The stored clock floor prevents rollback from reviving erased bodies.
Markers keep duplicate/conflict decisions and count against the 256-entry/ 1 MiB
limits forever; a full store refuses new entries without eviction. There is no
automatic marker pruning, rotation or reset. Deliberately destroying the whole
store loses its replay history and is not an accounting-safe reset.

Retention is logical removal through atomic replacement, not secure erasure:
filesystem journals/backups may retain old bytes. It cannot erase while the
process is stopped, and failed I/O can delay removal; maintenance failure stops
ingestion. No encryption at rest, power-loss/rollback resistance against old
snapshots, Windows ACL acceptance or production capacity is claimed. Markers
remain private metadata. Public accounting still requires separate retention,
identity, fraud and aggregation policy; signatures attest observations rather
than independently true usage.

### Explicit private startup

Create a private JSON config (0600 inside an operator-controlled directory),
provide its absolute path as `GYBLOS_COLLECTOR_CONFIG`, then run:

```sh
pnpm --filter @gyblos/receipt-collector start
```

The config has exactly `version`, `path`, `create`, `retentionMs`, `principals`
and `port`. `version` is 1; `path` is a complete absolute snapshot filename;
`create` is true only for explicit first creation and false for subsequent
opens. `retentionMs` is required. `port` is explicit (0 selects an ephemeral
port for programmatic tests). Each principal has exactly `buyerNodeId`, `token`
and `consent`. Provision unpredictable credentials outside the repository; never
reuse a wallet/node key or place credentials in CLI arguments, docs, fixtures or
logs. Synthetic test capabilities are not operator credentials. There is no
default path, role-home lookup, `.env` loading or network access. The entrypoint
accepts no command-line arguments and prints only a static startup flag or
static failure code. Programmatic callers can use `startLocalCollector` with
explicit options and own its `close()` lifecycle.
