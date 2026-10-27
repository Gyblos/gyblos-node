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
`qwen3-0.6b` for small tests. Explicit aliases currently cover
`qwen3:30b-a3b-q4_K_M` (the hybrid build; Ollama's bare `qwen3:30b-a3b` tag now
points at a thinking-only build) and `qwen3:0.6b` from documented setup
examples. Matching is exact and
case-sensitive; suffixes/quantizations are not stripped. Unknown valid IDs are
returned as `custom`; membership is naming metadata, not proof of availability,
model weights, a license or an audit. Entries and aliases are frozen.

`reasoning` lists the levels a model supports (`levels`, in `REASONING_LEVELS`
order, plus `defaultReasoning`, one of them) from the closed set `off`, `low`,
`medium`, `high` (GYB-DOC-028); an on/off thinking switch is `off` and `high`.
`reasoning: null` means not verified from a primary model source or not mapped
onto the closed set yet. The per-model table and sources are in
`docs/configuration.md`. This catalog metadata changes no signed record or
golden vector.

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

## Control contracts and Iroh runtime

`./control-requests`, `./control-response`, `./control-framing` and
`./control-types` expose the free `gyblos/control/1` contract;
`./control-validation` exports `ControlError` and the bounded primitives that
core reuses. Requests are `{ version: 1, requestId, method, params }`; methods
are `catalog.get`, `presence.get` and `offer.request`. Catalog and presence queries
have empty params. Responses contain exactly one `result` or static typed `error`.
`matchControlResponse` binds every response (including errors) to the validated
request ID and, for results, its method before the buyer authenticates signatures.
`parseControlQuery` and `parseControlResponse` return detached validated values;
parsing a response alone does not authenticate its signed result.

Each stream contains one uint32 big-endian byte length, canonical UTF-8 JSON and
EOF. `ControlFrameReader` publishes only at `finish()`; the caller must enforce
its absolute deadline, admission lease and EOF. Limits are 8 KiB requests,
64 KiB responses and depth 16. Unknown fields, duplicate JSON keys, noncanonical
numbers/encoding, extra frames and invalid UTF-8 are rejected. A malformed frame
may be closed without replying; error replies require a validated request ID.

`./public-v2` adds node-signed catalog/presence/withdrawal records, with reasoning
levels and separate v2 domains. `./offer-v2` adds owner-signed quotes binding the
complete request digest and exact buyer/model/reasoning terms. Public signatures
remain lowercase hex; private signatures remain Base64. V1 exports, domains and
vectors are unchanged. V2 cache/sequence namespaces must be distinct from v1;
presence and withdrawal references cannot cross versions. Time validation has
zero clock-skew tolerance (`issuedAt > now` is rejected), as in v1. The runtime
retains zero: operators must synchronize clocks. A tolerance would widen quote
acceptance and needs separate policy review; no expiry grace is applied.

V2 prices are **atomic asset units per million tokens**, with the explicit
`inputAtomicPerMtok` and `outputAtomicPerMtok` fields in public listing pricing,
private offer prices and request price ceilings. Public pricing has
`unit: "million-tokens"`; v1 retains its `"token"` unit and `inputAtomic` /
`outputAtomic` keys. The previous per-token v2 shapes and mixed representations
are rejected, never guessed from values or converted after signature verification.
This is an intentional update of the not-yet-paid v2 family; v1 wire bytes,
APIs, signing domains and vectors remain unchanged. Existing v2 records must be
reissued with the explicit fields and fresh signatures/digests. Rollout must not
reuse old retained catalogs as if their prices had the new unit; normal sequence,
cache and withdrawal rules remain in force.

For complete usage, `@gyblos/core/pricing-v2` computes exactly
`ceil((inputTokens * inputAtomicPerMtok + outputTokens * outputAtomicPerMtok) / 1_000_000)`.
Round **once over the combined weighted total**, not separately for each side or
stream chunk. Zero weighted usage costs zero; a positive fraction rounds up to
one atomic unit. Counts are nonnegative integers bounded by the existing public
context-token limit; canonical decimal rates and the resulting charge are
bounded by the existing unsigned 64-bit atomic limit. Arbitrary-precision integer
intermediates may exceed u64 when the final result fits; overflow of the final
charge is a static typed limit error, never truncation or floating-point rounding.
This arithmetic is pure policy, not wired payment execution.

USDC-per-million configuration prices map exactly to atomic-per-million rates
by multiplying by 1,000,000 (at most six decimal places); there is no division
by token count during this conversion. Seller startup still advertises the
unchanged PoC v1 rates multiplied by the million-token scale, and the buyer's
legacy compatibility check compares those exact economic terms. It does not
convert a signed v2 quote into a v1 offer or enable v2 payments. Selector weights
compare the same per-million rate sums (without charge rounding); its minimum
paid budget covers the once-rounded cost of one input and one output token.
A quote's total budget remains a ceiling, not a promise that an unknown prompt
and the requested output fit within it.

Version mapping: the `gyblos/control/1` ALPN (control version 1) carries v2
records and offers; `gyblos/http/2` is a reserved future identifier, not a
supported paid ALPN. The current paid v1 validator rejects v2. The pure policy
in `@gyblos/core/control-quotes` (`createControlQuote` for sellers,
`acceptControlQuote` for buyers) verifies caller-trusted identities, catalog and
request terms. It does not carry v1 payment checks (payTo distinct from
owner/feePayer/authorizer, capability and metering requirements); payment
admission must enforce them when paid v2 is wired. Its caller supplies
engine/readiness snapshots and increments readiness generation when those
change; no engine or payment adapter runs here.
Free quotes can be consumed by the separate free-execution service described
below. Quote creation remains stateless: only execution admission consumes the
single-use identifier. A quote is not a reservation, wallet proof or payment
authorization.

`@gyblos/core/control-admission` supplies caller-owned connection/query leases
with a monotonic fake-clock-testable policy. The node runtime admits before
buffering/parsing, aggregates peers across connections, checks leases on input
and before publishing, releases in every terminal path, and enforces SDK
connection/stream limits. A full peer table evicts the least recently touched
entry with no open connection or query; it refuses only when every entry is
active. No timer, endpoint or registry lookup starts on import.
`CONTROL_CAPACITY` is a separate per-ALPN budget for control
streams, applied after the shared transport-iroh endpoint admission and its
configured transport connection/peer limits, so a control connection must pass
both. These values are initial safeguards, not measured production capacity.

The shared `TRANSPORT_LIMITS` currently allow 8 established connections (per
NodeId, 1 control and 1 data connection) and 2 active requests globally, 1 per
NodeId; these stricter endpoint
limits apply before the control limits (32/4 connections and active queries).
Connection-open attempts share a 60-second fixed window: 256 globally, 32 per
source address before validation and 30 per authenticated NodeId. Disconnecting
does not reset rate debt. Unknown/invalid attempts consume the pre-auth budget;
active handshakes retain their pending slot until native work settles.

Each control stream has a 10-second absolute deadline including the complete
frame and EOF, signing and response write. Control connection inactivity is
10 seconds; the shared pre-ALPN handshake timeout remains 30 seconds. Request
receive windows are bounded; oversized lengths are rejected before requesting
the body. A rejected or timed-out stream closes its connection; no queue or
late response is published. The buyer retains at most one pending native dial
until it settles, closing any late connection after cancellation. A buyer
client serializes its queries without a queue and reuses one connection.

The seller registers `gyblos/control/1` alongside `gyblos/http/1`. Control
requests never forward to the paid HTTP bridge, whose strict routes are
unchanged. Catalogs map the startup-cached, warmed engine identity explicitly
to its public model; only implemented reasoning levels (currently `off`) are
announced. Busy/readiness state is observed from normal inference lifecycle,
without querying or loading an engine on the control channel. Catalog and
readiness expire at the existing warmup deadline; restart is required to
refresh them. Quotes neither consume nor reserve capacity.

`@gyblos/buyer/control` exposes `connectBuyerControl`, `getCatalog`,
`getPresence` and `requestOffer` for one independently chosen/trusted seller.
It binds the authenticated NodeId, configured relay policy, public signatures,
catalog digest/sequence and exact quote terms using `acceptControlQuote`.
This does not wire seller selection, the buyer proxy, paid v2 or free execution.
Closing the client closes its connection, not the caller-owned endpoint.

`vectors/control-v2-mtok.json` fixes request framing/digest, all three public records
and owner-signed offer bytes using an independent Node/OpenSSL oracle. Only
synthetic public keys/signatures are retained. The historical `control-v2.json`
is retained unchanged to verify rejection of the previous per-token v2 shape.
The complete design and rollout
constraints live in vault GYB-DOC-022, control-contract appendix.

## Free inference execution v2

`@gyblos/protocol/free-execution` and `./free-execution-framing` define a
non-streaming execution contract for previously verified signed free quotes.
The seller registers this ALPN only for its configured free offer, composing
quote authentication, token admission and its pinned engine. The protocol
helpers alone do not enforce state or execute work. Buyer wiring is separate;
no v2 payment path is enabled.

### Separate execution channel

The ALPN is **`gyblos/free/2`**. Reusing `gyblos/control/1` would break its
no-prompt/no-engine invariant, mix long-running inference with short discovery
queries and make their independent admission budgets ambiguous. A separate
ALPN preserves that boundary and permits separate execution admission under the
same endpoint limits. `gyblos/http/2` remains reserved and unregistered; the
existing v1 HTTP bridge, routes and payment admission are unchanged.

An existing `SignedOfferV2` still signs `protocol: "gyblos/http/2"`: this is the
unchanged quote-family marker, **not an instruction to dial or register that
reserved ALPN**. Only an authenticated offer with both atomic-per-million
prices `"0"` and `maxAtomic: "0"` is eligible for the explicitly free channel.
Never rewrite/re-sign the quote, strip its terms or convert it to v1. Paid
quotes are refused even when the buyer declares a zero budget elsewhere.

### Request and response

One bidirectional stream carries one request and one complete response, each
with a four-byte big-endian unsigned body length, canonical UTF-8 JSON, then
send EOF. A receiver processes nothing until the full body and EOF arrive.

Request fields (all required; unknown fields at every level are rejected):

- `version: 2`, and `requestId` equal to the quote's validated 128-bit lowercase
  hexadecimal requestId. A fresh execution identifier cannot make a quote reusable.
- `quote`: the unmodified seller-signed `SignedOfferV2` envelope.
- `input`: `messages`, `selection`, `reasoning`, `maxTokens`. `selection` is the
  quote's exact public `{modelId, variant, quantization}`; the quote already
  binds its internal engine `model` description. Neither identifier is an
  arbitrary engine URL or upstream model override.
- `messages`: 1–64 text-only objects with exactly `role` and `content`. Roles
  are `system`, `user`, `assistant`; multiline/empty content is representable.
  Tools, attachments, remote URLs, function calls and streaming options are not
  supported. A wire role does not imply a particular engine implements it:
  the seller must refuse unsupported input before generation, without silently
  flattening messages or downgrading reasoning.
- `maxTokens` is a positive safe integer no greater than the signed output
  maximum or model context. The engine-specific input token count plus the
  requested output maximum must fit the quoted context before generation.

Success response:
`{version: 2, requestId, requestDigest, result: {text, usage: {inputTokens, outputTokens}, finishReason}}`.
Usage contains non-negative safe integer counts under the public context bound;
output must not exceed the requested maximum, and combined usage must fit the
quoted context. `finishReason` is `stop` or `length`. Empty text/zero counts are
representable; usage is reported evidence, not a cryptographic proof of work.
There are no fragments or buyer-visible streaming in this version.

Failure response uses exactly the same header and `error: {code}`, never
`result` as well. Codes are the closed `FREE_EXECUTION_CODES` catalog: invalid,
version, limit, binding, signature, expired, wrong peer, replay, not-free,
daily-cap, buyer-cap, unsupported, busy, engine-unavailable, timeout, cancelled
and internal. Messages, provider errors and input contents are never reflected.
If framing/structure is invalid and no complete validated request is available,
close the stream; do not invent or echo an unvalidated correlation identifier.
In the current seller, structural parse failures (including version, binding
and not-free failures) close the stream before a reply header exists. Those
error codes are eligible for a reply only if raised after successful parsing;
the error catalog does not promise every rejection has a wire response.

`requestDigest` is SHA-256 of UTF-8
`"gyblos/free-execution-request/v2\n" + canonicalJson(validatedRequest)`.
It includes the signed quote and the complete chat input, and is distinct from
the quote's prompt-free control request digest. The buyer matches requestId and
this digest before acting on either an error or a result. Responses are bound
to the authenticated seller connection. Independent usage receipts are defined
but not yet emitted; they do not change response authentication.
`FreeExecutionError.remote` defaults to false for local checks.
`matchFreeExecutionResponse` sets it to true only for a parsed error whose
requestId and digest match; it is local metadata, never a wire field. This
flag does not authorize fallback or retry after any prompt bytes were sent.
The exported `FreeChatMessage` type and `buildFreeExecutionRequest` helper
build a detached request from the quote's selection/reasoning. Building does
not authenticate/consume a quote, flatten chat or change its model.

### Bounds and admission obligations

Request JSON bodies are at most 128 KiB and response bodies at most 1 MiB.
Message content totals at most 64 KiB of UTF-8; result text at most 256 KiB.
The body limit also includes JSON escaping and the quote envelope, so text
below its own bound can still exceed the frame bound. A response containing
256 KiB of control characters can JSON-escape beyond 1 MiB; the seller returns
a bounded `FREE_EXECUTION_LIMIT_EXCEEDED` error instead of publishing that result. Lone UTF-16 surrogates
are invalid. Framing reuses the canonical codec's depth limit 16 and strict
UTF-8, duplicate/noncanonical-key/number rejection, EOF, no trailing bytes and
no additional-message rules. Reject an excessive length before body allocation.

Transport integration must apply shared endpoint `TRANSPORT_LIMITS` and
connection-open rates **before** separate execution admission. Do not borrow
or bypass control's independent `CONTROL_CAPACITY`. Preserve the existing
inference ingress/egress bounds (`IROH_DEADLINES`) and absolute inference
request deadline (`TRANSPORT_TIMEOUTS.requestMs`, currently 180 seconds) from
stream acceptance; the 10-second control-query total is not an inference
budget. No unbounded queue, late response or fallback after sending any prompt
bytes is allowed, including timeout, disconnect and unknown completion.
Cancellation must not release active engine work early if native cancellation
has not actually settled. These are integration requirements, not a claim that
this protocol-only PR enforces socket deadlines or resource admission.

### Quote authentication, replay and free caps

Before any engine generation, the seller verifies its own configured owner and
NodeId against the quote and verifies the owner's signature; enforces zero
clock skew (`issuedAt <= now < expiresAt`); matches authenticated Iroh peer to
`buyerNodeId`; checks free prices/budget, exact selection/reasoning and token
limits; then enforces one-use replay admission and the configured free caps.
Expiry must be checked again immediately before admitting generation after any
asynchronous validation. Expiry after admission does not extend the execution
deadline or authorize a second request.

The replay key is `(seller NodeId, buyerNodeId, requestId)`. Atomically consume
it before starting the engine and retain it through the quote's expiry, even
if the engine fails, the client disconnects or the response is lost. A full
replay table rejects new work rather than evicting unexpired entries. Parsing
and signature verification helpers are stateless and **do not consume** it.

The handler takes caps from the prepared `SellerCatalogOffer` free branch,
not from the client or a second configuration read. Enforce
`caps.dailyTokenCap` first, then `caps.perBuyerCap`, in total input plus output
tokens per UTC day. Key the offer budget by stable configured offer identity
within the seller (including model selection), not a renewing catalog digest
or requestId. Per-buyer accounting additionally keys by authenticated NodeId;
it is best effort because NodeIds are free to create.

Concurrent admission must atomically reserve a conservative input-token count
plus the output maximum against both caps before generation; reconcile actual
usage only when trustworthy and retain a conservative debit for uncertain work.
Insufficient cap rejects without generation. Midnight rollover must not erase
reservations held by running requests. Caps may be in memory for the MVP: restarting resets them and can permit
extra free work. Replay must still remain single-use through expiry across
restart: persist consumed identifiers, or reject every quote issued at or
before a new startup barrier (including the same clock tick) and issue only
newer quotes. An in-memory replay table alone is insufficient. The caps reset
limitation must be disclosed in seller wiring; counters are neither a durable
daily guarantee nor Sybil resistance.
No handler path may call payments, the facilitator or v1, including failures.

### Compatibility and rollout

`vectors/free-execution-v2.json` pins independent Node/OpenSSL quote signature,
request canonical bytes/domain digest, request framing and success/error
response framing. All existing v1 and v2 vectors/domains remain unchanged.
The contract ships first; seller wiring then enables free startup explicitly
with `loadSellerSettings(process.env, undefined, {freeExecution: true})` only
when its handler and caps are present. Buyer wiring follows separately.
Acceptance later covers publication → discovery → selection → free quote →
execution → answer using an in-process index and synthetic engine, including
replay, expiry, wrong peer, exhausted caps, engine failure and no fallback once
prompt transmission begins. Real engines, off-host or production runs require
separate founder authorization. Streaming and paid v2 remain later work.

### Seller runtime scope

`packages/core/free-admission` owns bounded per-offer replay and token budgets;
`packages/node/free-execution` composes signature/peer/time checks with the
prepared listing and engine; `packages/transport-iroh/free-server` owns the
framed data stream. `seller-transport` connects those pieces once at startup.
Renewing public records never recreates token counters.

The pinned Ollama adapter currently supports one user message and reasoning
`off`. Other contract-valid roles/conversations are refused with
`FREE_EXECUTION_UNSUPPORTED` before generation; no message flattening occurs.
Input and output are recounted with the pinned tokenizer, rather than trusting
engine-reported usage for cap refunds. Admission reserves templated input plus
maximum output, refunds only a successfully recounted completion and keeps the
full debit for engine errors, cancellation or uncertain work. UTC-day counters
reset on restart; per-buyer counters are best effort. The in-memory replay table
is bounded at 4096 live identifiers and the daily buyer table at 1024 entries.
Capacity exhaustion refuses new work without evicting unexpired accounting.
A startup-time barrier rejects quotes issued at or before startup, including
the same millisecond; backward clock movement during a process fails closed.
This assumes a trustworthy wall clock across restarts, as does zero-skew expiry.

Native ingress, generation and egress share endpoint request admission. A
read, engine or writer ignoring cancellation retains its request permit until
actual settlement. Timeout closes the connection and suppresses late output.
The free-configured seller starts neither the facilitator nor the paid HTTP
service, does not check the devnet payment program or load the auxiliary
payment signers, and writes no legacy v1 offer. Paid-configured startup keeps
the existing v1 service. The free branch advertises only control and free
ALPNs. Transport allows one control connection and one data connection per
authenticated peer at a time (the global connection pool and the per-peer
request quota stay shared). The buyer still closes its control connection
before dialing the data channel; the separate data allowance covers the moment
when the seller, over a relay, has not yet observed that close.

Synthetic service tests, bounded-stream tests and native loopback execution
cover this seller slice. No real engine, devnet, deployed index, production
startup or full publish-to-answer lab acceptance is claimed by these tests.

### Free streaming execution v2

`gyblos/free-stream/2` is a separate execution ALPN. It reuses the unchanged
`gyblos/free/2` request and its digest domain. This keeps one-shot consumers and
all existing vectors intact, without overloading the control ALPN or enabling
`gyblos/http/2`. The seller shares one policy/admission instance across both
free execution ALPNs: the buyer-bound quote/requestId is consumed once across
modes, not once per mode. Free still requires both prices and maxAtomic zero.

Each response event is canonical UTF-8 JSON prefixed with a four-byte big-endian
length. Events carry version 2, requestId, requestDigest and a zero-based,
strictly consecutive sequence. `delta` adds text; `terminal` carries the existing
complete FreeExecutionResponse. Successful terminal text must equal the exact
concatenated deltas, and terminal usage/context bounds are checked as for the
complete response. An error terminal is unsuccessful, including after partial
text. EOF before terminal, bytes after terminal, unknown fields, invalid UTF-8,
noncanonical or duplicate JSON fields, changed bindings and reordered events
are rejected. Fragments are provisional until a valid terminal and EOF.

A delta contains at most 8192 UTF-8 bytes; splitting preserves Unicode scalar
values. There are at most 4096 events including terminal, at most
FREE_EXECUTION.responseBytes+1024 canonical body bytes per event, and at most
twice FREE_EXECUTION.responseBytes across all framed events. The original
256 KiB output-text cap also applies across deltas. JSON escaping counts toward
wire limits; legal text can exceed a wire bound after escaping and must fail
with LIMIT, never be silently truncated. The consumer validates declared frame
length before allocating/reading its body. Per-frame ingress/egress and whole
request deadlines, relay/peer authentication, endpoint quotas and free caps
remain enforced. Writes and consumer callbacks are awaited for backpressure.

Cancellation closes the connection and reaches the engine's abort signal;
late deltas are forbidden. A writer ignoring abort retains its admission permit
until it actually settles. The buyer marks possible transmission before its
first write, so partial/failed writes and any later failure prohibit failover.
Zero clock skew remains: quote expiry is rechecked immediately before the first
write, with no grace interval. Streaming does not authorize payments, call a
facilitator, modify the v1 flow or reserve capacity during quotation.

## Usage receipts v1

Usage receipts are defined but not yet emitted. No execution channel, seller,
buyer, collector or payment path is wired to them. They apply to v2-and-later
quotes; paid v1 does not have the required request identifiers and digests.
A receipt is evidence of what its signer reports, not proof of model execution,
correctness or independently measured usage.

`ReceiptV1 = { seller: { record, signature }, buyer?: { record, signature } }`.
The seller signs `SellerReceiptV1` with its node key; the optional buyer signs a
separate `BuyerReceiptV1` with its own node key. A seller-only receipt is
unconfirmed. Each signature is 64 Ed25519 bytes encoded as 128 lowercase hex
characters. Optional `buyer` is omitted, never `undefined`.

Signing bytes are UTF-8 of the domain followed by the existing canonical JSON:
`gyblos/receipt-seller/v1\n` and `gyblos/receipt-buyer/v1\n` respectively.
`sellerReceiptDigest` is SHA-256 of the seller signing bytes, lowercase hex.
`signSellerReceipt` and `signBuyerReceipt` parse, sign, then self-verify against
`sellerNodeId` and `buyerNodeId`. `verifyReceipt` strictly parses the envelope,
verifies both available signatures and checks the buyer's seller digest,
requestId and both NodeIds against the seller record. It takes no `now`:
receipts have no expiry. Resolving a node's owner is separate policy.

The seller record has exactly these fields:

- `version: 1`, `requestId` (16-byte lowercase hex), `requestDigest` (32-byte
  lowercase hex), `sellerNodeId` and `buyerNodeId` (32-byte lowercase hex),
  `owner` (32-byte base58 address).
- `selection: { modelId, variant, quantization }`, using the control selection
  grammar; exact `reasoning`, `engineKind`, `metering` and boolean `streaming`.
- `pricing: { kind: 'free' }` or `{ kind: 'paid', prices, network, asset }`.
  Prices use `inputAtomicPerMtok` and `outputAtomicPerMtok`; amounts and prices
  use the existing canonical decimal/u64 bounds. `amountAtomic`, `feeAtomic`.
- `usage: { inputTokens, outputTokens, reasoningTokens }`, where reasoning
  tokens are nullable to mean unmeasured; the other counts are nonnegative safe
  integers. `sizes: { inputBytes, outputBytes, inputChars, outputChars }` uses
  nonnegative safe integers; chars count Unicode code points.
- `timing: { receivedAt, firstTokenMs, totalMs }`: nonnegative safe integers,
  with `receivedAt` in epoch milliseconds and nullable `firstTokenMs`.
- `outcome` (`completed`, `failed`, `cancelled`), `code` (free execution code or
  null), `reason` (stop reason or null), `finishReason` (engine done reason or
  null).

Completed records require null code/reason and a non-null finish reason.
Failed records require a code. Cancelled records require the cancellation code.
The stop-reason equivalence and failed seller-only vector are pending the
separately owned `SELLER_CANNOT_CONTINUE` contract; this branch cannot ship
until those dependent pieces are integrated. Until then, non-null reasons are
rejected. This is an intermediate development restriction, not the final v1
receipt contract.

`firstTokenMs <= totalMs`, and `firstTokenMs === null` iff `outputBytes === 0`.
Free pricing requires both amounts to be `'0'`; paid pricing requires
`feeAtomic <= amountAtomic`. Seller canonical records are capped at 2048 UTF-8
bytes, buyer records at 1024 bytes. All records and nested objects reject extra
fields, missing fields, accessors, invalid decimals and `undefined` values.

The buyer record has exactly `version`, `requestId`, `sellerReceiptDigest`,
`sellerNodeId`, `buyerNodeId`, `observed`, `verdict`, and `disputed`.
`observed = { inputTokens, outputTokens, outputBytes, firstTokenMs, totalMs }`:
observed token counts are nullable when the buyer has no tokenizer; bytes and
timing use the seller's integer and first-token invariants. `verdict` is
`agreed` iff `disputed` is empty; otherwise it is `disputed`. Dispute fields
are unique and ordered `inputTokens`, `outputTokens`, `outputBytes`. Timing
is not disputed: each side signs its own network-dependent measurement.

No prompt, response, IP, key or arbitrary provider message belongs in these
records. Full receipts go only to Gyblos; individual raw receipts are not
public. Public data consists of seller/model aggregates, buyer totals and
signed daily snapshots, per the founder's receipt-privacy decision. Collection,
consent, retention and public aggregation are outside this contract.

### Telemetry port (not connected)

`TelemetrySink.emit` is synchronous and must never throw. `flush` drains
accepted work; `close` returns `{ emitted, dropped, failed }`. Both are
idempotent. Events are `request_received`, `first_token`, `completed`, `failed`,
`charged`, `receipt`, `refused` and `unserved`. They have common `at`, `role`,
`requestId`, `buyerNodeId`, `sellerNodeId`, `selection`, `engineKind`, `streaming`.
Only unserved has a null requestId; unserved and refused without a seller can
have null sellerNodeId/engineKind; those two fields are absent together. A refusal carries one static reason:
`seller_busy`, `daily_cap`, `buyer_cap`, `quote_rejected`, `connect_failed`,
`engine_not_ready`. There are no free-text fields.

`toTelemetryRecord` creates a detached, recursively allowlisted record,
including nested receipt fields. Invalid closed values fail locally; sinks
count projection failures as drops. `fanOut` isolates each destination's
exception, sums sink emitted/dropped counts plus its own caught emit failures,
and combines failure flags. It has no clock, I/O or plugin dependency.

The private file plugin is lazy and opens only on first emit, under the role's
`telemetry` directory, using the existing `diagnostic-*.jsonl` private runtime
log. Its open buffer is bounded by `PRIVATE_LOG_LIMITS.pendingRecords`.
Serialized records including newline are capped at 4096 bytes. Accepted events
increment emitted; buffer/projection drops and runtime log drops increment
dropped; persistence failure sets failed. The console plugin uses only its
injected write and emits one JSON line per projected event. No plugin is
installed into a live role by this change.
