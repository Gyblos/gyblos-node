# Protocol compatibility, version 1

This package owns canonical JSON, domain-separated signature bytes, the signed
inference offer wire shape, the Engine contract and the shared error taxonomy.
It has no SDK or workspace dependencies, filesystem access, network calls or
import-time process lifecycle. It uses the standard TextEncoder and Web Crypto
APIs; callers adapt their wallets.

## Canonical JSON and signing bytes

The representation preserves the existing inference-offer encoder. Null,
booleans and strings use JSON.stringify. Safe integer numbers remain JSON
numbers, including negative values; negative zero becomes zero. Floating-point,
nonfinite and unsafe numbers, undefined, bigint, symbols and functions are
unsupported. Object own enumerable string keys are sorted using JavaScript
String comparison (UTF-16 code units), encoded individually and joined without
whitespace. Arrays retain order. Use JSON data: this is the existing encoder,
not a claim of RFC 8785 compliance or a new validator for arbitrary JS objects.

Atomic monetary amounts are **decimal strings**. Existing issuedAt/expiresAt,
token bounds, context size and schema version remain safe integer JSON numbers.
Do not convert those existing numeric fields to strings during extraction.

Signing bytes are UTF-8(domain + canonicalJson(value)). Domain prefixes follow
gyblos/&lt;kind&gt;/v&lt;n&gt; followed by one newline. The existing offer prefix is
exactly `gyblos/signed-inference-offer/v1\n`, with a real LF byte, not the two
characters backslash and n. Keep this kind and payload shape unchanged. Callers
select the domain; the helpers do not introduce a new domain policy.

The offer types `InferenceOffer` and `SignedInferenceOffer` are exported from
`./offer`. `./constants` names the wire values: `OFFER_DOMAIN` (the prefix
above), `OFFER_SCHEMA_VERSION` (`1`) and `GYBLOS_ALPN` (`gyblos/http/1`, the
Iroh ALPN, also carried in the offer's `protocol` field).

## Signatures, contracts and compatibility

`sign` invokes an injected byte signer; it must use Ed25519. `verify` uses Web
Crypto Ed25519 with a raw 32-byte public key. Signature encoding is the caller's
responsibility: the existing private offer stays `{ offer, signature }`, with a
Base64 signature over the offer. Solana addresses, signing-message adaptation,
trust checks, payment policy and expiry checks for that legacy offer stay outside
protocol. The public discovery contracts below are separate messages: they do
not replace, reinterpret or authorize the buyer-bound paid offer.

`EngineUsage` retains camelCase domain counters. `EngineWireUsage` retains the
distinct snake_case wire counters; inferenceWireUsage performs the existing
mapping. Engine completion reasons and error-code strings retain their values.
`ProtocolError` keeps Error's existing name/message and enumerable code.
Payment, node and buyer code throw and compare this same constructor and
`PROTOCOL_ERROR_CODES` catalog directly; there are no payment-package aliases.

`vectors/signed-inference-offer-v1.json` contains a synthetic, unfunded offer,
canonical JSON, complete signing bytes in hexadecimal, raw public key and
Base64 signature captured from main 6abdb6d **before** extraction. No private key
is retained. `pnpm test` reads the vector and verifies it independently and
through the existing application entrypoint. Changes to these bytes or wire
contracts require a separately reviewed protocol version, not a refactor.

## Public discovery records, version 1

The package adds `parsePublicRecord`, `signPublicRecord`, `verifyPublicRecord`
and `catalogDigest`, available from the root or `./public-records`. Types also
have an explicit `./public-types` entry. These pure functions do not publish,
resolve identities, connect, load a wallet, track peers or authorize payments.
The old offer, its domain, its Base64 encoding and its vector remain unchanged.

Every public envelope is exactly `{ record, signature }`. Signatures are
Ed25519, encoded as **128 lowercase hexadecimal characters**. The signer is the
**node key**, whose raw 32 public bytes are the lowercase 64-character Iroh
NodeId. The owner is a canonical Base58 32-byte Solana address. The domains are
`gyblos/catalog/v1\n`, `gyblos/presence/v1\n` and `gyblos/withdrawal/v1\n`, each
with a real terminal LF. The signature covers UTF-8(domain + canonical JSON of
record), using the unchanged encoder above. Do not normalize model aliases or
other fields after signing.

All three records have exactly these common fields:

| Field                   | Wire representation                                                     |
| ----------------------- | ----------------------------------------------------------------------- |
| `schemaVersion`         | Integer `1`                                                             |
| `kind`                  | `catalog`, `presence` or `withdrawal`                                   |
| `owner`                 | Solana owner address; not a registration claim                          |
| `nodeId`                | Raw Ed25519 node public key, lowercase hex                              |
| `sequence`              | Positive safe integer, increasing across **all three kinds** per NodeId |
| `issuedAt`, `expiresAt` | Nonnegative safe integers, Unix milliseconds                            |

Additional fields are closed, including every nested object:

| Kind         | Additional fields                     |
| ------------ | ------------------------------------- |
| `catalog`    | `models`, `dataPolicy: { retention }` |
| `presence`   | `catalogDigest`, `state: "alive"`     |
| `withdrawal` | `catalogDigest`                       |

Retention is `none`, `may-retain` or `unspecified`. It is a seller declaration,
not an enforced privacy guarantee. Each model listing has exactly `modelId`,
`variant`, `quantization`, `contextTokens` and `pricing`. Variant/quantization are
explicit identifiers or null (unknown); null does not mean unquantized. Model
identifiers are case-sensitive ASCII tokens, up to 128 characters, permitting
letters, numbers, `.`, `_`, `:`, `-` in nonempty slash-separated components;
URL schemes, empty/traversal components and whitespace are rejected. Distinct
variants/quantizations can coexist; duplicate triples are rejected. A custom
model is allowed. There is no verified-model badge in this schema.

Pricing is exactly `{ network, asset, unit, inputAtomic, outputAtomic }`.
`network` is a syntactic Solana CAIP-2 identifier; `asset` is a Base58 mint
address; `unit` is `token`. Amounts are **atomic units per input/output token**,
as canonical unsigned decimal strings (no leading zeros), bounded by u64.
Both zero prices are valid. No token symbol, decimal precision, mint existence,
network trust or payment eligibility is inferred. Consumers must verify the
live private payment offer independently and check its mint/network/budget.

Limits are exported from `constants.ts`: up to 64 listings, context from 1 to
10,000,000 tokens, canonical record up to 32 KiB, catalog/withdrawal lifetime up
to 10 minutes, presence lifetime up to 90 seconds. The suggested 30-second
heartbeat is a starting value, not a scheduler or a measured freshness result.
The size limit covers the **canonical record**, not a raw HTTP body: adapters
must bound raw input before JSON parsing and bound envelope/signature framing.
Only plain JSON data is accepted; accessors, custom prototypes, unknown fields,
non-enumerable/symbol fields and sparse/custom arrays are rejected. Parsing
returns detached data, so later caller mutation does not alter verified bytes.
Arbitrary JavaScript Proxies are outside the JSON input contract.

### Trust, references, replay and withdrawal

`verifyPublicRecord(value, { owner, nodeId, now, lastSequence?, catalog? })`
checks shape, caller-trusted identity, time, sequence, linked catalog and the node
signature. It returns the parsed record or a typed `PublicRecordError` with an
input-independent code/message. Existing `ProtocolError` and
its code catalog are unaffected. `signPublicRecord` validates shape/lifetime and
signature length; its injected signer must use the matching node key. Signer
failures retain their original identity. Signing does not establish discovery
trust or online status.

The caller supplies a trusted owner/NodeId association from its independent
identity policy (later 8004 owner-signed metadata/delegation integration).
**Copying owner/nodeId from an untrusted record into trust only proves
self-signing, not ownership, registration, delegation or non-revocation.**
This PR does not implement the registry, delegation or revocation.

For presence/withdrawal, `catalog` is required. Its identity must match, its
sequence must be earlier, its issue time must be no later, and the reference
cannot outlive it. `catalogDigest` is lowercase hex SHA-256 over the catalog's
**domain-prefixed signing bytes**, not its envelope/signature. A node-signed
reference authenticates that exact catalog content via the digest; catalog
shape/lifetime are checked even if supplied without its own envelope. This
does not say its model or retention claims are true.

Consumers must persist a high-water `lastSequence` per NodeId and atomically
verify/update it while merging concurrent sources. The optional field permits a
cold first observation; omitting it on later observations provides **no replay
protection**. Out-of-order lower sequences are rejected regardless of kind.
Do not reset the sequence on restart while retaining the same node key. Key
rotation/revocation is separate identity work. The functions keep no state and
cannot resolve concurrent updates for a caller.

A withdrawal is a signed tombstone for its referenced catalog. Retain the
high-water mark after expiry/withdrawal, suppress that catalog, and allow only a
higher-sequence **catalog** to reopen publication. Do not revive it with a later
presence for the withdrawn catalog. These cache/lifecycle actions are consumer
requirements, not implemented discovery behavior here. Retain old withdrawals
at least through the maximum catalog lifetime; do not discard replay state when
a presence expires. Cold clients can still be shown a replayed, unexpired older
record by a malicious source. Fresh presence means "seen recently", never that
a model is currently available or its contents have been verified.

There are no endpoint, IP, relay-token, engine-URL, buyer, prompt or payment
payload fields. Allowlisting prevents accidental inclusion of such fields; it
cannot prevent a malicious signer from encoding a secret/address in an allowed
identifier. Publishers and logs must still use public data only. No direct-route
IP privacy or Sybil resistance is established by a signature.

### Shared model catalog

`MODEL_CATALOG` / `resolveModel` live at `./models`. Initial canonical IDs copy
the nine names in GYB-DOC-026 / the website's `web/src/content.ts`, plus
`qwen3-0.6b` for small tests. Explicit aliases currently cover `qwen3:30b-a3b`
and `qwen3:0.6b` from documented setup examples. Matching is exact and
case-sensitive; suffixes/quantizations are not stripped. Unknown valid IDs are
returned as `custom`; membership is naming metadata, not proof of availability,
model weights, a license or an audit. Entries and aliases are frozen.

`openWeights: null` means not verified from primary model/license sources in
this catalog. A nullable tokenizer similarly makes missing metadata explicit.
Only Qwen3 0.6B carries the already pinned repository/revision/tokenizer SHA-256
from the existing Ollama adapter; that reference is not a new fetch or license
audit. All other tokenizer references are unknown. In particular, marketing
names copied from the website must not be treated as verified releases.
Website, init and discovery consumers and the Ollama adapter do not read this
catalog yet; primary-source model metadata curation is later work.

### Public golden vectors

`vectors/public-discovery-v1.json` fixes one catalog, one presence and one
withdrawal: exact domains, canonical JSON, complete signing-byte hex, SHA-256
catalog reference, public key and signatures. A separate one-shot Node/OpenSSL
oracle built and signed the records independently of the protocol helpers.
Only synthetic public material is retained. Tests check both Web Crypto and
OpenSSL, wrong domains, changed payloads and reordered JSON properties. These
are public discovery signatures, not signed payment authorizations. The
signed-offer vectors in `vectors/signed-inference-offer-v1.json` are a separate
set.
