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
presence and withdrawal references cannot cross versions. V2 time validation
accepts a record or quote issued up to `CONTROL_LIMITS.clockSkewMs` (5 s) ahead
of the verifier's clock (`issuedAt > now + 5000` is rejected), because real
machines differ by hundreds of milliseconds and a remote record issued an
instant earlier would otherwise look future-dated. Expiry gets no grace
(`expiresAt <= now` is rejected), so a quote is never usable past its signed
lifetime; the tolerance only lets it be accepted up to 5 s before the verifier's
clock reaches its issue time. V1 retains zero tolerance. Seller admission
compares the seller's own quote with the seller's own clock and keeps zero skew.

V2 prices are **atomic asset units per million tokens**, with the explicit
`inputAtomicPerMtok` and `outputAtomicPerMtok` fields in public listing pricing,
private offer prices and request price ceilings. Public pricing has
`unit: "million-tokens"`; v1 retains its `"token"` unit and `inputAtomic` /
`outputAtomic` keys. The previous per-token v2 shapes and mixed representations
are rejected, never guessed from values or converted after signature verification.
This is an intentional update of the v2 family; v1 wire bytes,
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
This helper is pure policy. Paid execution separately applies combined rounding,
caps the amount at the authorized ceiling, and charges zero if no output was
delivered or the output count is zero.

USDC-per-million configuration prices map exactly to atomic-per-million rates
by multiplying by 1,000,000 (at most six decimal places); there is no division
by token count during this conversion. Seller startup advertises configured v2
rates plus the protocol fee. The legacy buyer's v1 compatibility check does not
convert a signed v2 quote into a v1 offer. Selector weights
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
owner/feePayer/authorizer, capability and metering requirements); paid execution
admission enforces its own checks. Its caller supplies
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

The seller registers `gyblos/control/1` alongside the configured execution
channels. Control requests never forward to an execution channel. Catalogs map the startup-cached, warmed engine identity explicitly
to its public model; only implemented reasoning levels (currently `off`) are
announced. Busy/readiness state is observed from normal inference lifecycle,
without querying or loading an engine on the control channel. Catalog and
readiness expire at the existing warmup deadline; restart is required to
refresh them. Quotes neither consume nor reserve capacity.

`@gyblos/buyer/control` exposes `connectBuyerControl`, `getCatalog`,
`getPresence` and `requestOffer` for one independently chosen/trusted seller.
It binds the authenticated NodeId, configured relay policy, public signatures,
catalog digest/sequence and exact quote terms using `acceptControlQuote`.
This control client alone does not perform seller selection or execution.
Closing the client closes its connection, not the caller-owned endpoint.

`vectors/control-v2-mtok.json` fixes request framing/digest, all three public records
and owner-signed offer bytes using an independent Node/OpenSSL oracle. Only
synthetic public keys/signatures are retained. The historical `control-v2.json`
is retained unchanged to verify rejection of the previous per-token v2 shape.
The control contract and its admission, framing, trust and rollout constraints
are described in this section. Broader discovery choices remain proposed; see
[discovery](../../docs/discovery.md) and [limitations](../../docs/limitations.md).

## Free inference execution v4

`@gyblos/protocol/free-execution` and `./free-execution-framing` define a
non-streaming execution contract for previously verified signed free quotes.
The seller registers this ALPN only for its configured free offer, composing
quote authentication, token admission and its pinned engine. The protocol
helpers alone do not enforce state or execute work. Buyer wiring is separate;
no v2 payment path is enabled.

### Changes from free execution v3

Version 4 makes the seller serve whole conversations and replaces version 3 on
both free ALPNs; the two versions do not coexist (there were no users before
the seller beta). A v3 peer facing a v4 peer fails ALPN negotiation, before any
prompt byte is sent.

- ALPNs `gyblos/free/4` and `gyblos/free-stream/4`, `version: 4` and request
  digest domain `gyblos/free-execution-request/v4\n`.
- The request shape is unchanged; the seller now serves a conversation: an
  optional `system` message first, then turns alternating `user`, `assistant`,
  from and ending with `user`, each with non-empty text (every engine template
  accepts that; a buyer merges consecutive turns of one role first). Content
  the model's template cannot carry is refused as unsupported. Any other shape is still
  refused with `FREE_EXECUTION_UNSUPPORTED` before generation.
- Message content may total 256 KiB (was 64 KiB) and a request body 384 KiB
  (was 128 KiB); a stream may carry 32768 events (was 4096). The output text
  and response bounds are unchanged.
- There is no fixed token maximum: the offer's answer limit (refused at quote
  time) and the model's context bound `maxTokens` (see Seller runtime scope);
  the 256 KiB output text bound still applies.
- Paid execution v1 keeps its bounds (64 KiB input, 136 KiB requests, 4096
  stream events) and one user message.
- Vectors move from the `-v3.json` files to `free-execution-v4.json` and
  `free-stream-v4.json`, derived by an independent Python oracle that first
  reproduced the v3 vectors; the quote envelope and its signature are unchanged.

Version 3 added the `FREE_EXECUTION_SELLER_CANNOT_CONTINUE` terminal code (an
admitted generation stopped on an engine failure) with its `reason` and
`delivered` fields. Receipt exchange uses its own channel.

### Separate execution channel

The ALPN is **`gyblos/free/4`**. Reusing `gyblos/control/1` would break its
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

Request fields (required unless marked optional; unknown fields at every level are rejected):

- `version: 4`, and `requestId` equal to the quote's validated 128-bit lowercase
  hexadecimal requestId. A fresh execution identifier cannot make a quote reusable.
- `quote`: the unmodified seller-signed `SignedOfferV2` envelope.
- `input`: `messages`, `selection`, `reasoning`, `maxTokens`. `selection` is the
  quote's exact public `{modelId, variant, quantization}`; the quote already
  binds its internal engine `model` description. Neither identifier is an
  arbitrary engine URL or upstream model override.
- `messages`: 1–1024 text-only objects with exactly `role` and `content`. Roles
  are `system`, `user`, `assistant`; multiline/empty content is representable
  on the wire. The seller serves a conversation: an optional `system` message
  first, then turns alternating `user`, `assistant`, from and ending with
  `user`, each non-empty.
  Tool turns are described below; attachments, remote URLs and streaming
  options are not supported. A wire role does not imply a particular engine implements it:
  the seller must refuse unsupported input before generation, without silently
  flattening messages or downgrading reasoning.
- `maxTokens` is a positive safe integer no greater than the signed output
  maximum or model context. The engine-specific input token count plus the
  requested output maximum must fit the quoted context before generation.
- Optional tool calling uses the common grammar below. Active session v4 also
  accepts it with its own unchanged bounds; legacy individual settlement refuses
  it before payment (see [common execution](#active-common-tool-aware-execution)):
  - `input.tools`: 1–128 `{name, description?, parameters}`. `name` matches
    `[A-Za-z0-9_-]{1,64}` and is unique; `description` is non-empty text up to
    8 KiB; `parameters` is JSON text (up to 64 KiB) holding one JSON object, the
    tool's JSON Schema. JSON values travel as text so signing and digests never
    reorder keys or round numbers.
  - `input.toolChoice`: `auto`, `none`, `required` or `{name}` naming one of
    the tools; it requires `tools`.
  - An assistant message may carry `toolCalls`: 1–32 `{id, name, arguments}`,
    `id` printable ASCII up to 64 characters and unique in the turn,
    `arguments` JSON text holding one object. Its `content` may then be empty.
  - A message `{role: "tool", content, toolCallId}` answers one call; its
    content may be empty.
  - With tools or tool turns, the conversation is an optional `system` message,
    then a `user` turn; an `assistant` turn follows a `user` turn or the
    results of every call of the previous assistant turn; each call is
    answered exactly once by the results right after it; a `user` turn may
    follow the results; it ends with a `user`
    turn or with results. Tools and tool JSON count against `inputBytes`.
  - A buyer that will offer tools sets `tools: true` in its quote request
    (`params.tools`); a seller whose offer cannot serve tools refuses it with
    `CONTROL_TOOLS_UNSUPPORTED`. The signed offer is unchanged. A seller that
    receives tools for an engine without tool support refuses the execution
    with `FREE_EXECUTION_UNSUPPORTED` before generation.

Success response:
`{version: 4, requestId, requestDigest, result: {text, usage: {inputTokens, outputTokens}, finishReason, toolCalls?}}`.
Usage contains non-negative safe integer counts under the public context bound;
output must not exceed the requested maximum, and combined usage must fit the
quoted context. `finishReason` is `stop`, `length` or `tool_calls`; a result
has `toolCalls` (same shape as above, the seller naming each call) exactly when
`finishReason` is `tool_calls`, and its text may then be empty. A stream
delivers only the visible text as deltas; the calls arrive whole in the
terminal result. Receipts and telemetry record `tool_calls` as `stop`. Empty text/zero counts are
representable; usage is reported evidence, not a cryptographic proof of work.
There are no fragments or buyer-visible streaming in this version.

Failure response uses exactly the same header and
`error: {code, reason?, delivered?}`, never `result` as well. Codes are the
closed `FREE_EXECUTION_CODES` catalog: invalid, version, limit, binding,
signature, expired, wrong peer, replay, not-free, daily-cap, buyer-cap,
unsupported, busy, engine-unavailable, timeout, cancelled, internal and
seller-cannot-continue. Messages, provider errors and input contents are never
reflected.

Shape rules, checked by `parseFreeExecutionResponse` without context:

- `reason` is present if and only if the code is
  `FREE_EXECUTION_SELLER_CANNOT_CONTINUE`, and is one of
  `FREE_EXECUTION_STOP_REASONS`: `quota_exhausted`, `rate_limited`,
  `engine_unavailable`, `engine_interrupted`, `engine_timeout`,
  `engine_invalid_response`. `ENGINE_ERROR_STOP_REASON` maps each uniform engine
  error to one reason. An upstream authentication failure is reported as
  `engine_unavailable`: the credential state of a seller's provider account is
  not revealed to buyers. The seller keeps the exact engine code locally.
- `delivered`, when present, is exactly `{outputTokens}` with a safe integer
  from 1 to the public context bound (`PUBLIC_RECORD_LIMITS.maxContextTokens`),
  and appears only beside `FREE_EXECUTION_SELLER_CANNOT_CONTINUE`.

Context rules, checked by `matchFreeExecutionResponse(response, request, mode)`:
a complete response (`mode` `'complete'`, the default) never carries
`delivered`; a streaming terminal (`'stream'`) may, and its `outputTokens`
must not exceed the request's `maxTokens`. The streaming rule for when
`delivered` is required is under free streaming execution below.
`delivered.outputTokens` is the seller's recount of the text it already
delivered; like all usage it is reported evidence, not a proof of work. Free
admission still keeps the full conservative debit after any engine failure.
If framing/structure is invalid and no complete validated request is available,
close the stream; do not invent or echo an unvalidated correlation identifier.
In the current seller, structural parse failures (including version, binding
and not-free failures) close the stream before a reply header exists. Those
error codes are eligible for a reply only if raised after successful parsing;
the error catalog does not promise every rejection has a wire response.

`requestDigest` is SHA-256 of UTF-8
`"gyblos/free-execution-request/v4\n" + canonicalJson(validatedRequest)`.
It includes the signed quote and the complete chat input, and is distinct from
the quote's prompt-free control request digest. The buyer matches requestId and
this digest before acting on either an error or a result. Responses are bound
to the authenticated seller connection. Independent usage receipts are defined
but not yet emitted; they do not change response authentication.
`FreeExecutionError.remote` defaults to false for local checks. A matched
remote error also exposes its `reason` and `delivered`.
`matchFreeExecutionResponse` sets it to true only for a parsed error whose
requestId and digest match; it is local metadata, never a wire field. This
flag does not authorize fallback or retry after any prompt bytes were sent.
The exported `FreeChatMessage` type and `buildFreeExecutionRequest` helper
build a detached request from the quote's selection/reasoning. Building does
not authenticate/consume a quote, flatten chat or change its model.

### Bounds and admission obligations

Request JSON bodies are at most 384 KiB and response bodies at most 1 MiB.
Message content totals at most 256 KiB of UTF-8; result text at most 256 KiB.
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
limits; then enforces one-use replay admission and the configured free caps. A
request whose selection no free offer of the seller serves is refused with
`FREE_EXECUTION_UNSUPPORTED` first, before these checks and without engine
work; the catalog already makes the served selections public.
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

`vectors/free-execution-v4.json` pins the independent Node/OpenSSL quote
signature, request canonical bytes/domain digest, request framing and
success/error/seller-cannot-continue response framing. Its request (a system
message and a user message) digest, canonical bytes and frames come from an
independent one-shot Python oracle that first reproduced every v3 vector; the
oracle is not committed. The v1 vectors,
control v2 vectors and their domains remain unchanged.
Each protocol change ships the contract first, then the seller, then the buyer.
Free offers use their own handler and caps; paid offers use a separate paid
stream when a payment server is configured. Acceptance covers publication → discovery → selection → free quote →
execution → answer using an in-process index and synthetic engine, including
replay, expiry, wrong peer, exhausted caps, engine failure and no fallback once
prompt transmission begins. Real engines, off-host or production runs require
separate founder authorization. Free streaming and conditional paid-v2 wiring
are separate channels; see their runtime documentation for scope and limits.

### Seller runtime scope

`packages/core/free-admission` owns one bounded seller-wide ledger (single use,
concurrency and distinct buyers per UTC day across all free offers) and each
offer's token budget; `packages/node/free-router` sends a request to the offer
whose selection its quote names; `packages/node/free-execution` composes
signature/peer/time checks with that offer's listing and engine;
`packages/transport-iroh/free-server` owns the framed data stream.
`seller-transport` connects those pieces once at startup. Renewing public
records never recreates the ledger or token counters.

The engines serve a conversation with reasoning `off`. The pinned Ollama
adapter renders it with the pinned Qwen3 template's no-tools, thinking-off
branch (a lone user message exactly as before), or its tools branch when tools
or tool turns are present: the tools block in the system turn, calls as
`<tool_call>` JSON and results as `<tool_response>` in one user turn, byte for
byte as the public template renders them (`toolChoice: none` leaves the tools
block out; `required` and a named choice cannot be forced and act as `auto`).
The adapter reads well-formed `<tool_call>` blocks naming offered tools back
out of the output and keeps anything else as text. The recounted meter counts
tools in the input and a result's calls as the template writes them. The
OpenAI adapter sends the messages as they are (calls as `tool_calls`, results
as role `tool`) and the Anthropic adapter sends the system message as its
`system` field, calls as `tool_use` blocks and a run of results as one user
turn of `tool_result` blocks. Other shapes are refused with `FREE_EXECUTION_UNSUPPORTED`
before generation; no message flattening occurs. `maxTokens` may not exceed the
offer's answer limit (`free.max_output_tokens` in gyblos.toml, 4096 by default
and at most 32768; quotes beyond it are refused) and, with the templated input,
must fit the model's context (a free Ollama offer's `engine.context_tokens`,
8192 by default and at most 32768). The engine deadline grows by 25 ms per
requested token past 128, up to 170 seconds. Input and output
are recounted with the pinned tokenizer over the same rendered conversation,
rather than trusting engine-reported usage for cap refunds. Admission reserves
templated input plus maximum output, refunds only a successfully recounted completion and keeps the
full debit for engine errors, cancellation or uncertain work. UTC-day counters
reset on restart; per-buyer counters are best effort. The in-memory replay table
is bounded at 4096 live identifiers and the seller's daily buyer table at 1024
entries by default (`[limits] max_free_buyers_per_day`).
Capacity exhaustion refuses new work without evicting unexpired accounting.
A startup-time barrier rejects quotes issued at or before startup, including
the same millisecond; backward clock movement during a process fails closed.
This assumes a trustworthy wall clock across restarts, as does the seller's
zero-skew admission of its own quotes.

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

### Free streaming execution v4

`gyblos/free-stream/4` is a separate execution ALPN. It reuses the unchanged
`gyblos/free/4` request and its digest domain. This keeps one-shot consumers and
all existing vectors intact, without overloading the control ALPN or enabling
`gyblos/http/2`. The seller shares one policy/admission instance across both
free execution ALPNs: the buyer-bound quote/requestId is consumed once across
modes, not once per mode. Free still requires both prices and maxAtomic zero.

Each response event is canonical UTF-8 JSON prefixed with a four-byte big-endian
length. Events carry version 4, requestId, requestDigest and a zero-based,
strictly consecutive sequence. `delta` adds text; `terminal` carries the existing
complete FreeExecutionResponse. Successful terminal text must equal the exact
concatenated deltas, and terminal usage/context bounds are checked as for the
complete response. An error terminal is unsuccessful, including after partial
text. A `FREE_EXECUTION_SELLER_CANNOT_CONTINUE` terminal carries `delivered`
if and only if at least one delta preceded it; every other error terminal,
for example `LIMIT` after partial text, never carries `delivered`. Its
`outputTokens` may not exceed the UTF-8 bytes of the delivered deltas, since
every token covers at least one byte. `vectors/free-stream-v4.json` pins two
deltas followed by such a terminal with reason `engine_interrupted`. EOF before
terminal, bytes after terminal, unknown fields, invalid UTF-8, noncanonical or
duplicate JSON fields, changed bindings and reordered events are rejected. Fragments are provisional until a valid terminal and EOF.

A delta contains at most 8192 UTF-8 bytes; splitting preserves Unicode scalar
values. There are at most 32768 events including terminal, at most
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
Expiry has no grace: quote expiry is rechecked immediately before the first
write. Streaming does not authorize payments, call a
facilitator, modify the v1 flow or reserve capacity during quotation.

## Paid inference execution v1

`@gyblos/protocol/paid-execution`, `./paid-stream` and `./paid/constants` define
the paid execution wire. They perform no I/O and admit no payment: quote
authentication, replay, the payment adapter (`PaymentServer`), metering and
settlement belong to the seller runtime, which does not register this channel
yet. Vectors: `vectors/paid-execution-v1.json`.

### Channel and request

The ALPN is **`gyblos/paid-stream/1`**, stream-only: a one-shot response cannot
show delivery before settlement. One bidirectional stream carries one request
frame, then ordered events, each with a four-byte big-endian length and
canonical UTF-8 JSON. The free ALPNs are unchanged and never carry payments.

Request: the free request shape (unchanged since v3) with `version: 1`, plus `payment`, a
`PaymentAuthorization` `{channelId, payer, requestDigest, maxAtomic, payload}`:

- `quote` must be priced (`maxAtomic` above `"0"`), otherwise
  `PAID_EXECUTION_NOT_PAID`.
- `payment.requestDigest`, `payment.maxAtomic` and `payment.payer` must equal
  the quote's `requestDigest`, `maxAtomic` and `buyer`, otherwise
  `PAID_EXECUTION_PAYMENT_MISMATCH`.
- `payload` is the scheme's signed channel open in base64, at most 4096
  characters. For x402 `upto` on Solana, the open transaction's memo is
  `paymentMemo(terms)` and its distribution is `paymentSplits(terms)`
  (`payment-binding`), so the buyer's wallet signs every money field and the
  protocol fee split.
- The request digest is SHA-256 over `gyblos/paid-execution-request/v1\n` plus
  the canonical request, so it covers the authorization; the request is bounded
  to the free bound plus 8 KiB.

### Events and terminal

Deltas are as in free streaming. The terminal is the free result or error with
paid codes (`PAID_EXECUTION_*`): the free codes except the free-only admission
caps, plus `NOT_PAID`, `PAYMENT_MISMATCH`, `PAYMENT_REJECTED`,
`PAYMENT_UNAVAILABLE` and `BUDGET_EXHAUSTED`. After a deposit the terminal
carries both `charge {inputTokens, outputTokens, chargedAtomic}` and `payment`,
which is `{settlement: PaymentSettlement}`,
`{pending: {channelId, chargedAtomic, transaction | null}}` while settlement is
still being confirmed, or `{lapsed: {channelId}}` when the chain refused the
claim for good: nothing was charged and the whole deposit returns to the buyer,
while `charge` still reports what was metered. Rules:

- Refusals before any deposit (request validation codes, `NOT_PAID`, `BUSY`,
  `PAYMENT_*`) carry neither. `SELLER_CANNOT_CONTINUE` and `BUDGET_EXHAUSTED`
  only happen after a deposit and always carry both. A result always carries
  both.
- Delivered text was always deposited for, so a terminal after any delta
  carries both.
- A stop after deltas (`SELLER_CANNOT_CONTINUE`, `BUDGET_EXHAUSTED`, `TIMEOUT`,
  `CANCELLED`) reports `delivered.outputTokens` and charges exactly that
  output; only `SELLER_CANNOT_CONTINUE` carries a `reason`. Any other error,
  or a stream that delivered no text, charges `"0"`.
- The charge's tokens equal a result's usage. Output tokens never exceed the
  delivered UTF-8 bytes, and input plus output fit the quoted model context.
- The charge never exceeds the deposited ceiling. Every payment variant names
  the request's channel. The settlement refunds the rest of the ceiling, and its
  seller plus fee shares cover the charge except at most one atomic unit of
  rounding dust; a pending charge equals the terminal's charge.
- `pending` and `lapsed` are the seller's word, not proof. Before treating the
  charge as paid or the deposit as returned, the buyer reconciles the channel
  on chain: a pending claim may still land, and a lapsed one leaves the deposit
  in the channel until the buyer reclaims it after the channel expires. Under
  `lapsed` the buyer still recomputes `charge`, which is then informational.
- The terminal is bounded to the free response bound plus 2 KiB.

Recomputing the charge from the quote's prices and recounted tokens, and
checking the settlement on chain, belong to the buyer runtime.

### Charge, budget and transport

`@gyblos/core/paid-charge` prices recounted tokens at the quote's prices, which
are what the buyer pays with the protocol fee included. `paidOutputAllowance`
is the most output tokens the ceiling still pays for after the recounted input,
within the requested tokens and the model context; it is null when the input
with one output token already exceeds the ceiling or fills the context, so
nothing is deposited. `paidCharge` charges `"0"` and zero output tokens when no
text was delivered, and never more than the deposited ceiling.

`@gyblos/transport-iroh/paid-server` and `./paid-client` carry the channel
under the same admission, peer limits and deadlines as free streaming. The
server reads one request of at most the paid bound, refusing an oversized
length before reading its body, streams the service's deltas and sends the
terminal the service returns. A terminal the wire refuses is never sent. A
buyer leaving or a deadline aborts the service's signal and closes the
connection; the admission lease is held until the service returns, because the
service settles after the buyer leaves. The client returns every verified
terminal, refusals included, and reports `sent` once the authorization may have
reached the seller. A terminal followed by extra bytes, or by no end of stream
before the ingress deadline, is an error, so the buyer then reconciles the
channel on chain. The service must bound its own settlement wait and report the
charge as pending, since the request lease is held until it returns. The
endpoint advertises the ALPN only with `paidExecution`.

### Seller execution

`@gyblos/node/paid-execution` serves one paid offer; `./paid-router` routes by
the quoted selection. In order, the seller authenticates the quote, refuses a
request outside the offer (selection, model, capabilities, reasoning, a single
user message, declared metering) with `UNSUPPORTED` or more output tokens than
free execution allows with `LIMIT`, recounts the input and refuses it with
`LIMIT` when the ceiling cannot pay for it plus one output token, refuses terms
that are not its payment server's own (`UNSUPPORTED`, or `PAYMENT_UNAVAILABLE`
when the server cannot describe them in time), spends the request id
(`@gyblos/core/paid-admission`: `REPLAY`, `BUSY`, `EXPIRED`), checks readiness,
and only then admits the deposit. Admission refusals map to
`PAYMENT_REJECTED`, `EXPIRED` or `PAYMENT_UNAVAILABLE`. An admission that is
unavailable, or not done within the wait, may still have deposited: one that
completes later is handed to the caller to settle at zero, and any other is
left to recovery.

Generation asks the engine for at most the allowance and recounts every delta
before delivering it; a delta past the allowance stops the stream with
`BUDGET_EXHAUSTED`, and text that cannot be sent stops it as an invalid engine
response. After the deposit, a stop reports the engine's reason and the
recounted delivered output, a refusal code becomes `INTERNAL`, and the charge
covers only delivered output; any seller-side failure while charging ends as
`INTERNAL` with nothing charged, so the deposit is always settled. Settlement
runs under the daemon's signal with a bounded wait: a lapsed claim is reported
`lapsed`; a claim not confirmed in time, retryably failed, or not started
because the daemon is stopping is reported `pending` and handed to the caller
to retry with the same charge; any other failure is reported `pending` and
handed to the caller as a failure to surface, never retried.

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
A non-null reason is required if and only if the code is
`FREE_EXECUTION_SELLER_CANNOT_CONTINUE`; its value must belong to the public
`FREE_EXECUTION_STOP_REASONS` catalog. Seller upstream credential state is not
public: authentication failures use the generic `engine_unavailable` reason,
never `engine_auth`. The seller-only failed/quota-exhausted golden case covers
an unconfirmed receipt; it requires no buyer signature.

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

## Receipt exchange channel v1

`gyblos/receipt/1` exchanges historical `receipt/v1` attestations independently
of control, free inference and the reserved paid HTTP v2 path. It never carries
inference input, starts generation, reserves capacity or authorizes payment.
The adapter supports it explicitly; node/buyer startup does not enable it yet.

Each bidirectional stream carries one request and one response, each as a
four-byte big-endian body length followed by canonical UTF-8 JSON and sending
EOF. Both bodies are capped at 8192 bytes, with the existing canonical depth
limit of 16. Reject excessive lengths before allocating/reading the body,
invalid UTF-8, duplicate fields, extra bytes/messages and incomplete EOF. The
existing receipt record caps and signatures remain unchanged. New independent
channel byte vectors are in `vectors/receipt-channel-v1.json`; old vectors and
signing domains are unchanged.

Request: `{ version: 1, requestId, method, params }`. The RPC requestId is a
16-byte lowercase-hex correlation ID chosen by the caller; it is distinct from
the execution requestId embedded in receipts. Methods:

- `receipt.get`: params are exactly `{ executionRequestId, requestDigest }`.
  The seller returns a seller-only or previously confirmed receipt from its
  existing store, scoped to its own NodeId and the authenticated buyer NodeId.
- `receipt.confirm`: params are exactly `{ receipt }`, requiring both signed
  records. The server verifies both signatures and their cross-binding, checks
  its local seller identity and authenticated buyer, and compares the seller
  digest with its existing record. It cannot create an unissued seller receipt.
  Identical confirmation is idempotent; a different buyer attestation for the
  same record is a conflict. A store must atomically compare and set so races
  cannot overwrite the first accepted buyer observation.

Response: `{ version: 1, requestId, result: { receipt } }` or exactly one
`error: { code }`. The validated RPC ID is echoed. Static codes are
`RECEIPT_INVALID`, `RECEIPT_VERSION`, `RECEIPT_BINDING`, `RECEIPT_SIGNATURE`,
`RECEIPT_NOT_FOUND`, `RECEIPT_CONFLICT`, `RECEIPT_BUSY`, `RECEIPT_LIMIT`,
`RECEIPT_CANCELLED`, `RECEIPT_INTERNAL`. Malformed framing/requests and admission
failures close the stream without reflecting an unvalidated identifier. Errors
from storage/native callbacks never expose their messages. Missing and foreign
buyer records are indistinguishable on lookup. Receipts do not expire here.

The client checks the Iroh peer, configured relay policy, RPC ID, execution
requestId/digest and both receipt NodeIds, and verifies all returned signatures.
A confirmation acknowledgment must contain the exact submitted pair. Remote
static errors are marked remote separately from local failures. Owner trust and
full selection/measurement policy remain the caller's independent responsibility;
use the core receipt builders before countersigning, never received claims as
expected context. A signature is an attestation, not proof of execution or usage.

Endpoint connection-open rates, global/source/peer admission and request quotas
apply first. Receipt streams use a separate receipt connection family with the existing
per-peer family cap; endpoint global/source/open-rate budgets remain shared.
Close the inference connection before opening receipts. A stalled receipt
connection cannot consume the inference family cap.
One independent receipt `ControlAdmission` instance per server then applies the
existing `CONTROL_CAPACITY` limits (32 connections/queries, 4 per peer, global
100/s burst100, peer5/s burst10, 1024 peers and existing idle eviction semantics).
These are provisional shared policy values, not measured capacity. The absolute
query deadline, including EOF, storage, crypto and response, is at most 10 s;
connection idle/lifetime and receive/stream windows retain endpoint limits.
Invalid requests consume quota; no queue is introduced. Client operations on one
transport are serial; its receipt connection may be reused only for receipt RPCs.
Cancellation closes its connection and rejects late results. Uncancellable native
connects remain tracked/busy until settled and are closed if they resolve late.
The caller owns the endpoint; close never shuts down other ALPNs.

An injected store owns retention, bounded capacity, persistence and atomicity.
It must honor the abort signal before committing. A confirmation already
committed when cancellation occurs may have lost its acknowledgment; querying
or resubmitting that identical pair is safe and never reruns inference. This
adapter neither retries automatically nor claims durable/collector acceptance.
The transport takes an injected store; node composition owns signing. Free node startup supplies
the private local store described below. Full receipts stay private; no
collector, publication or aggregate export is enabled.

### Free inference receipt composition

After admitted free inference, the seller signs actual observations and stores
a seller-only record. Completed responses use validated usage; failed or
cancelled executions may record known recounted usage and partial output sizes.
Unknown provider usage is never replaced by an admission estimate. Pre-engine
refusals produce no receipt. A seller completion attests its result, not delivery
to the buyer. Buyer signatures are produced only for verified successful
responses, binding their independently held execution context. Independent token
counts remain null until a buyer-side counter exists. UTF-8 sizes and timings
are observations; signatures do not prove their truth.

Each role has a content-free private snapshot under its configured home. At
most 256 records and 1 MiB are retained; oldest entries are evicted to satisfy
both limits. Records expire logically seven days after first local storage;
reads ignore expired entries and the next successful write removes them. No
background purge is claimed. Files are 0600, directories 0700, with bounded
reads, strict signed parsing, exclusive updates and staged atomic replacement.
Unsafe/corrupt state fails closed for receipts without resetting or repairing
files. A crash can leave an exclusive lock; the runtime does not reclaim it.

Receipt work is scheduled in the background, outside inference response/done
deadlines, with one active operation per process/role and no queue. Seller signing/storage has a 500 ms budget; buyer lookup, countersigning,
local persistence and confirmation together have 2 s. Uncancellable work remains
tracked until settled; later receipt work is dropped meanwhile. Cancellation
checks precede commits and late results are ignored. Shutdown aborts receipt
work without waiting indefinitely. The buyer may make three metadata attempts
on static not-found/busy/internal replies with a 40 ms delay, within its budget.
It persists its first signed pair before confirming and reuses that exact pair
after a lost acknowledgment. Conflicting buyer attestations never overwrite it.
A failed or missing receipt never retries inference, changes the selected seller
after prompt transmission, discards successful output or enables a payment.

## Reusable buyer-authorized payment session port

`payment-session` is an additive library contract over the existing pinned
Solana x402 `batch-settlement` wire, not a replacement for existing paid execution.
The financial port itself defines no ALPN; the opt-in transport is specified below. Session terms bind both wallet/NodeId pairs,
network, asset, receiver, fee payer, receiver authorizer, fee policy, bounded
deposit, host expiry and withdrawal grace. The opening memo is
`gyblos/payment-session/v1:` followed by SHA-256 of
`gyblos/payment-session/v1\n` and the canonical JSON of all session terms.

An opening has a zero-charge buyer voucher. Each request reserves its ceiling
under a unique 128-bit lowercase-hex request ID and a 256-bit digest already
verified by its host. A bill binds those fields, its actual charge and the new
cumulative total. Only independently verified usage is eligible for buyer
approval. The native SDK voucher signs channel ID, cumulative amount and expiry,
not Gyblos request metadata. Its expiry is the SDK zero sentinel; request and
quote correlation must therefore be enforced in both local journals and the
authenticated host protocol, never inferred from the native voucher alone.

Finalization freezes the highest accepted voucher and stops new admissions.
The seller can present it without the buyer remaining online. The SDK's
receiver close authorization is distinct from buyer spending authority.
Retries retain the same buyer voucher and financial amount. A local deadline
or disconnected HTTP stream does not itself execute settlement or a refund.
No existing offer, free/paid execution or golden vector is modified by this port.
[Session composition and limitations](../../docs/payment-sessions.md).

## Reusable session v3 streaming

The active reusable-session channel is `gyblos/session/3`, envelope version 3,
with `gyblos/session-request/v3\n` for the canonical inner execution and
`gyblos/session-rpc/v3\n` for the outer RPC. Both peers upgrade together;
preparation fails before a new deposit opening on a v1/v2-only peer. Only one
active session implementation is kept. All previous v1/v2 vectors are frozen;
SDK cumulative voucher, terms and journal schemas are unchanged. Saved original
approvals recover over v3 with their exact original digest/bill/voucher, never a
reconstructed execution request. The historical v2 specification below remains
an explanation of those frozen bytes, not another active runtime.

PREPARE, OPEN, APPROVE, SNAPSHOT and CLOSE remain one bounded canonical JSON
frame and EOF. EXECUTE returns zero or more delta frames followed by exactly
one terminal frame and EOF. Every event contains version 3, the outer requestId,
the SHA-256 outer requestDigest, a zero-based contiguous sequence and type.
A delta has type `delta` and nonempty text; a terminal has type `terminal` and
response containing the existing complete BatchChannelResponse, including the
inner execution-bound bill or a static typed error. The outer request identifier
is independent of the quote's inner execution identifier. Unknown/duplicate
fields, noncanonical JSON, invalid UTF-8, reordered/crossed/replayed events,
missing terminal and any byte after terminal are refused.

Each delta is at most 8192 UTF-8 bytes, the stream has at most 4096 events
including the terminal, and total encoded frames including prefixes stay within
1048576 bytes, the former response budget. Prefixes exceeding the remaining
aggregate budget are rejected before body allocation. Output content remains
bounded by 262144 bytes, input 65536 bytes, 1024 messages and 128 output tokens;
context, signed price/budget, admission and absolute request deadlines are
unchanged. Deltas reserve 2048 bytes for a static error terminal. JSON escaping
and the repeated complete terminal text can exhaust the encoded budget earlier
than content size; return static LIMIT instead of a success that cannot fit.
Generation waits between events use the existing absolute request deadline.
After the first byte, incomplete prefixes and bodies retain the ingress deadline.
Consumers and writes are awaited with existing per-stage deadlines; cancellation
seals publication even if the engine ignores abort. Quote freshness is checked
before admission, not required to remain live during generation.

The engine receives intact conversation history. Seller output is bounded and
recounted over the accumulated text prefix, never by summing separate fragment
token counts. The final engine text must exactly match emitted text. The buyer
independently recounts full rendered input and concatenated output, checks the
terminal/bill, and requires EOF before cumulative signing. Visible fragments are
provisional until that verification; an error is not a successful answer.
Cancellation or loss before a verified terminal creates no new approval and
leaves recovery/closure pending; the seller can collect its previous highest
accepted signature only, with one unsigned last response as bounded exposure.
Once verified usage has entered durable approval, an abort cannot revoke an
already-started signature: recover its exact original financial approval without
replaying the prompt. No detached post-cancellation approval is introduced.

Independent Node/OpenSSL fixtures are batch-channel-v3.json,
batch-prepare-v3.json, batch-startup-v3.json and batch-stream-v3.json. Existing
per-request paid-stream/1 and free-stream contracts remain unchanged.

### Session admission and inference quota

Endpoint connection-open rates, pending/source/global/per-peer connection caps,
route policy and shared concurrency apply first, with their existing values.
A session connection stays in the data connection family, but does not reserve
an inference grant merely by connecting. It remains admissible after the peer
or global inference quota is exhausted, subject to all those transport caps.

Every session stream, including malformed/incomplete input and EXECUTE, also
consumes an independent session query-rate budget using the existing
CONTROL_CAPACITY policy: 5/s with burst 10 per NodeId, 100/s with burst 100
globally, and a bounded 1024-entry peer table with 60-second idle expiry. This
budget is shared by all session connections; it is separate from the control
and receipt budgets. It guards ingress attempts, not an additional execution
slot or a shorter generation deadline. A refused ingress attempt closes the
connection before service dispatch. Streams retain the endpoint concurrency
slot through parsing, service completion, egress and draining cancellation.

Only a complete, canonical, validated EXECUTE consumes the existing per-peer
and global inference window quota, immediately before dispatch and exactly
once, even if the service refuses it. An exhausted quota returns a correlated
static LIMIT terminal without dispatching the prompt. PREPARE, OPEN, APPROVE,
SNAPSHOT and CLOSE consume no inference quota. Consequently the last accepted
execution can still approve its verified usage, recover its original approval
after a lost ACK/reconnection, and request closure. Query-rate exhaustion or
full transport capacity can still refuse those operations; this is no bypass
of abuse controls and grants no priority over active work. Reconnection never
erases spent inference quota, changes a financial intent or retries a prompt.

## Reusable conversation session channel v2

`gyblos/session/2` replaces the active session v1 transport. Both peers must
upgrade; the buyer requires successful v2 preparation before calling its opening
or signing port. It never falls back to session v1 or to per-request payment.
The previous v1 contract below is frozen historical context, not a second
registered implementation. The independently used `gyblos/paid-stream/1` path
keeps its single-user semantics and vectors.

The v2 envelope uses `version: 2` and the same six RPC methods, frame bounds,
strict parsing, authenticated peers and pinned financial terms described below.
RPC correlation uses `gyblos/session-rpc/v2\n`; execution binding uses
`gyblos/session-request/v2\n` over the complete canonical inner request,
including every historical role/content and the signed quote. No fields are
removed before hashing. v1 envelopes and replies fail closed, and their digests
cannot authorize a v2 execution.

The input is a nonempty text conversation: an optional nonempty system message
first, then alternating user/assistant turns beginning and ending with a user.
Unknown fields, tools, non-text modalities and other reasoning are refused.
Session bounds are fixed independently of free execution: at most 1024 messages,
64 KiB total content bytes, and 128 output tokens, additionally constrained by
the quote, model context, caller policy and request budget. Existing 1 MiB RPC
frames and depth 16 remain unchanged; JSON escaping counts toward the frame.

Both parties recount the entire rendered conversation with the selected model's
public `ChatTokenizer.chat` implementation, including the system and historical
assistant messages. The seller passes the same messages intact to the engine.
There is no concatenation, last-turn shortcut, declared-usage fallback or silent
history trimming. Unsupported templates/control tokens, unsafe counts, context
and worst-case budget violations fail before financial construction on the
buyer and before reservation/generation on the seller. The buyer recounts the
received output and verifies full input usage before cumulative signing.

SDK vouchers, financial session terms and the private journal remain v1 and
unchanged. A saved v1 approval may be acknowledged over v2 with its original
request ID, digest, bill and voucher; recovery never recalculates that digest or
reconstructs a prompt. Replay high-water state remains. New executions use v2
binding. No conversation content is persisted or logged. Possible-send marking,
uncertainty, cancellation, autonomous finalization and one-active-per-seller
admission retain their existing behavior. Execution is still one complete
response; token streaming over reusable sessions is separate work.

Independent Node/OpenSSL vectors are `batch-channel-v2.json`,
`batch-prepare-v2.json` and `batch-startup-v2.json`. All v1 fixtures remain
byte-identical and are tested independently along with explicit v1 rejection.

## Reusable single-seller session channel v1

`gyblos/session/1` is a separate, opt-in Iroh ALPN. It is registered only by a host
that supplies a matching session service. Existing control, free, paid-stream,
receipt and reserved HTTP ALPNs, signed quote formats and vectors are unchanged.
A quote's existing protocol field does not advertise this optional channel.
The host independently pins both identities and financial session terms; the
index and remote peer never choose those policies.

Each RPC uses one bidirectional stream: four-byte big-endian length, canonical
UTF-8 JSON and sender EOF, followed by one similarly framed reply and EOF.
Requests and replies are each at most 1 MiB excluding the prefix; an opaque SDK
opening is at most 512 KiB at the RPC boundary. The pinned financial adapter
additionally restricts its known-field SDK opening to 8 KiB and its transaction
to the SDK Solana packet bound before persistence, with initial proof verification.
The existing depth limit of 16 applies. Oversized
lengths are rejected before body allocation; invalid UTF-8, duplicate fields,
noncanonical JSON, trailing data, multiple messages and unknown fields fail.
Response JSON escaping counts against the frame bound: a legal text whose
encoded reply would be too large produces a correlated static LIMIT reply,
not a partial result. Invalid unparsed requests close without a reply.

The envelope is `{version: 1, requestId, method, params}`. RPC request IDs are
128-bit lowercase hex. The reply includes `version`, the same `requestId`,
`requestDigest` and exactly one `result` or static `error.code`.
`requestDigest` is SHA-256 of `gyblos/session-rpc/v1\n` plus the entire parsed
canonical request. Existing session and paid-execution error catalogs are used;
provider messages, input, private SDK payloads and network addresses are never
reflected. Remote errors are marked separately by the local client API.

| Method     | Params                                                                             | Result                                     |
| ---------- | ---------------------------------------------------------------------------------- | ------------------------------------------ |
| `prepare`  | fresh signed `quote`, optional full proposed `terms`                               | full provisioned `terms`, no side effects  |
| `open`     | `payload` (opaque SDK opening string), fresh signed `quote`, optional same `terms` | `snapshot`                                 |
| `execute`  | `channelId`, quote-bound `requestId`, fresh signed `quote`, `input`                | complete `value` and `bill`                |
| `approve`  | `bill`, buyer-signed cumulative `voucher`                                          | exact acknowledged `snapshot`              |
| `snapshot` | `channelId`                                                                        | `snapshot` metadata                        |
| `close`    | `channelId`                                                                        | independently verified seller `settlement` |

`prepare` is an additive capability and terms-agreement operation on this ALPN;
all earlier methods, digests and vector bytes remain unchanged. A seller that
does not implement it rejects the method. The current shared buyer requires a
successful correlated preparation reply before calling its opening/signing
port; an older seller therefore fails before any new opening signature. An
earlier provisioned buyer can still use the unchanged `open` contract.

Preparation accepts the quote and optionally the full proposed terms: no prompt
or SDK opening. A provisioned host may omit terms exactly as before. An
unassigned startup host requires the proposal, checks its locally allowed buyer
and financial policy, and allocates no resource until OPEN presents a valid SDK
proof whose memo binds those identical terms. OPEN repeats the proposal so a
prior stateless preparation is never a reservation. Unknown fields are rejected.
After authenticating the buyer and checking the fresh signed priced
quote, exact warmed model and live readiness, the seller returns the exactly matching terms. It calls no financial-session or engine methods and creates
no journal, reservation, channel or background worker. This reply is metadata,
not an offer signature, independent identity proof or finalized-chain proof.

The result is exactly `{terms}`. Terms have exactly `buyer`, `buyerNodeId`,
`owner`, `sellerNodeId`, `network`, `mint`, `payTo`, `feePayer`, `authorizer`,
`treasury`, `protocolFeeBps`, `depositAtomic`, `expiresAt` and
`withdrawDelaySeconds`. Addresses and NodeIds use the existing strict control
primitives; deposit is a positive canonical bounded decimal, host expiry and
withdrawal delay are positive safe integers, and basis points are an integer
within the existing denominator. Adapter-specific network, grace and party
policy remains enforced by the financial constructor.

The buyer strictly parses both remote terms and its independently authorized,
persisted local terms and requires exact canonical equality of every field.
Remote terms never raise the deposit, extend expiry/grace or alter parties or
fees. The existing request ID and whole-request digest bind the reply to the
specific preparation quote. Identity, quote policy, zero-skew time and
cancellation are rechecked after preparation and before the opening port. A
failed preparation does not discard or replace any earlier uncertain opening
or financial approval. Hosts must still restore the original terms and attempt
before new execution; arbitrary-peer provisioning and implicit application
activation are not authorized by preparation alone. The independent
`batch-prepare-v1.json` and `batch-startup-v1.json` vectors supplement the unchanged
earlier fixtures. The latter pins the optional-terms PREPARE and OPEN encodings.

The inner execution request signs no new payment authorization. Its session
request digest is SHA-256 of `gyblos/session-request/v1\n` plus the canonical
`{channelId, requestId, quote, input}`. The persisted financial reservation/bill
binds that digest, quote request ID and quote budget. The full prompt is never
written into the session journal. The SDK cumulative voucher retains its native
signing format; the journals and authenticated channel enforce request binding.
Inference IDs/digests are single-use; the same accepted financial approval may
be acknowledged again without new inference or charge.

Before any engine call the seller checks its authenticated buyer NodeId, its own
quote signature and zero-skew validity, all pinned financial identities/terms,
exact warmed selection/model/capabilities, implemented reasoning, supported
input, live nonbusy readiness, context/output limits and affordable budget. This
version supports one user message, reasoning `off` and a complete response.
Input/output prices must not both be zero and the quote budget must be positive;
free quotes keep the existing transaction-free path. The session reserves the
request ceiling before generation and forbids another active request.

Before signing, the buyer independently verifies seller identity and selected
catalog/quote policy, validates response correlation and bounds, recounts
received input/output, and recomputes the charge at the signed per-million
prices. It signs only that verified amount. An approval ACK must match the
channel, exact cumulative voucher amount and zero remaining reservation. A
reported settlement is not proof for the buyer: its independent finalized-chain
observer must confirm the actual amounts/transaction before local reconciliation.

Transport connection-open rate, global/per-peer connection and request budgets
apply first; the host's one-active-session operation budget applies separately.
Existing ingress/egress deadlines and absolute inference deadline apply. Cancel
closes the connection, suppresses late publication and drains native operations
before releasing admission. The client marks possible transmission before its
first write, never retries inference and closes late-arriving connections.
Quote time is rechecked immediately before sending. Financial approval recovery
is explicit and reuses the original approved bill; it never sends a prompt.

The seller's financial worker persists independently of the Iroh connection and
can finalize the highest accepted voucher while the buyer is offline. Both sides
offline still means no submission. This channel changes no fee, journal format,
mainnet restriction or restored-state guarantee. Arbitrary-peer provisioning,
concurrent requests, multiple sellers, implicit activation, a public gateway and
streaming on this new ALPN remain separately scoped. The normal seller daemon
and buyer chat can explicitly enable one pinned pair as described in the
[session startup policy](../../docs/payment-sessions.md#explicit-startup-policy). New canonical/digest/frame
vectors are in `vectors/batch-channel-v1.json`; older vectors are unchanged.

The local buyer opening port accepts an optional synchronous operation guard.
The SDK adapter invokes it immediately before each new transaction/message
signature, rechecking cancellation and quote/host expiry after delayed hints or
private writes. A signature already in progress may finish internally, but its
result is not transmitted after cancellation. This changes no signing bytes.

## Active common tool-aware execution

The active execution profiles are free `gyblos/free/4` and
`gyblos/free-stream/4`, individual paid `gyblos/paid-stream/2` (request version
2, domain `gyblos/paid-execution-request/v2\n`), and reusable paid
`gyblos/session/4` (version 4, domains `gyblos/session-request/v4\n` and
`gyblos/session-rpc/v4\n`). Earlier paid/session descriptions and golden
vectors document retired wire profiles; they are not additional registered
ALPNs. Free vectors, existing offers, cumulative SDK voucher signatures and
financial journals are unchanged. Upgrade both peers together; no downgrade,
reconstructed old request or automatic prompt replay is supported.

`InferenceInput` and `InferenceResult` own the common conversation, tools,
choice, output and usage shapes. `@gyblos/inference` owns capability validation,
generation, output validation and independent usage verification over injected
engine/meter ports. Economic policies remain outside that package: zero-price
quotes use caps and construct no financial service; positive-price tool
execution uses an explicitly authorized reusable session. Selection asks for
tools for definitions or prior tool turns, regardless of price. Only a seller
with an implemented engine and the required execution/meter ports may quote
that capability. Free and paid executions observe the same metadata lifecycle;
local persistence remains opt-in and no external export is enabled implicitly.

Session v4 accepts tool definitions, choice and tool-result history, and tool
calls on its complete result or stream terminal. The entire input retains its
65536-byte bound, 1024 messages and 128 output-token limit; definitions and tool
JSON consume the existing bound. Framing, deadlines, admission, budgets and
prices are unchanged. Deltas remain text. Calls are held until the terminal,
validated against the offered tools and choice, and included in independent
usage verification before any new cumulative voucher is signed. Incomplete or
invalid terminals authorize no new charge; prior accepted obligations remain
recoverable without sending another prompt.

Recounted input includes the model's whole conversation template, tool
specifications and tool results. Tool choice `none` uses exactly the template
sent to the engine, excluding the definitions block. Recounted output includes
canonical assistant text, tool names, arguments and template markup, excluding
local call identifiers. A tool-only response can therefore have positive usage
with empty text. This is the agreed public rendering, not a claim that every
remote provider tokenizes internally in that form. A paid tool request requires
a tokenizer able to render tool output before financial construction. Declared
provider usage remains suitable for conservative free caps only.

Individual paid settlement has no buyer acknowledgement for held tool calls:
it must reject tools and tool-result history with `UNSUPPORTED` before payment
construction/admission, even after a text runtime was cached. It retains full
text conversations and the common generator. Hosts must configure a reusable
session for positive-price tools; they must not silently create a new deposit
policy. Its v2 wire grammar is common, but this legacy economic policy does not
admit those inputs. This prevents charging generated arguments before delivery.

Telemetry is observational: failed sinks, clocks and generation callbacks do
not change inference, caps or billing. Both peers record received, first usable
output and one completed/failed/refused terminal. Tool-only first output is
observed with its validated result. A session bill or approved voucher is not a
confirmed payment; it emits no per-inference `CHARGED`. Existing confirmed
individual settlement evidence retains that event. Channel totals are not
attributed to the last request. Existing free signed usage receipts remain
free-specific; this change does not fabricate paid usage receipts.

New independent Node/OpenSSL vectors are `paid-execution-v2.json`,
`batch-channel-v4.json`, `batch-prepare-v4.json`, `batch-startup-v4.json`,
`batch-stream-v4.json` and `batch-tools-v4.json`. All historical vectors stay
byte-identical and their retired versions are rejected by active parsers.

## Reusable session block checkpoints (v5)

`@gyblos/protocol/session-blocks` defines the checkpoint grammar for
`gyblos/session/5`. This contract alone does not register or advertise the ALPN.
The existing session-v4 contracts and vectors remain unchanged. The native
payment program, cumulative voucher bytes and final settlement are unchanged.
There is no payment transaction per response block. A final settlement phase
can require more than one native transaction.

A checkpoint carries the channel, original inference `requestId` and
`requestDigest`, zero-based block index, newly delivered text, cumulative request
usage, cumulative request charge, cumulative channel charge, and either a full
terminal result or `null`. The terminal text must equal all delivered text, and
its usage must equal checkpoint usage. The final result uses the existing
inference/tool grammar; tools remain complete values, not partially accepted
arguments. The request digest is SHA-256 of the validated existing inference
parameters under `gyblos/session-request/v5\n`. A checkpoint digest is SHA-256 of
its strict canonical JSON under `gyblos/session-block/v5\n`. Domain suffixes are
literal LF bytes. Neither digest is a new native payment-signature format.

The exchange is strictly alternating on **one bidirectional execution stream**:
checkpoint → approval containing its digest and native cumulative voucher →
durable seller ACK containing that digest and cumulative amount → next
checkpoint. The buyer independently verifies usage and cumulative pricing
before approval. The native signature authorizes the cumulative channel amount;
it does not prove model quality or commit the native program to response bytes.
The application binds the checkpoint and persists that binding privately.
A separate concurrent APPROVE RPC must not be used while execution holds the
same peer's admission lease. Management/recovery does not execute a prompt.

A single original inference reservation remains active through all checkpoints.
If its maximum is M and its approved request charge is C, its remaining reserve
is M−C, until the terminal ACK releases the unused portion. Channel total is the
fixed pre-request total plus C. Input is charged once, and existing per-million
pricing rounds cumulative request usage once rather than each block separately.
The buyer checks all binding fields, exact index, immutable input usage and
request ceiling, monotone output usage and charges, deposit ceiling and the
independent usage/price result. No second checkpoint is accepted while one is
unacknowledged. Failure/early EOF poisons the transcript; late ACKs cannot repair
an unfinished stream.

All messages use existing four-byte big-endian canonical JSON framing and strict
UTF-8/depth/unknown-field checks. A frame and aggregate seller transcript retain
the existing 1 MiB response budget; delivered text retains the existing output
byte limit. There are at most `maxOutputTokens + 1` checkpoints, retaining the
128-token execution bound; the extra checkpoint allows a terminal result after
an already approved text prefix. The original absolute deadline, ingress/egress
limits, endpoint admission and per-peer execution capacity must apply without
renewal. Cancellation stops further publication and new signing, and a failed
write may already have transmitted bytes. Never repeat the prompt.

Both sides must persist the exact financial intent before a signature or ACK
escapes. The seller preserves the highest durably accepted voucher before ACK;
the buyer records approval and acknowledgment without freeing the remaining
inference reservation early. Recovery resends only the same stored financial
attempt; it does not regenerate or persist conversation content. At most the
latest accepted and one pending checkpoint need be retained, within existing
private-file bounds. Older unresolved session formats recover under their
original digest and voucher semantics before new block execution is admitted.

Bill only stable tokenizer prefixes: the count of a growing arbitrary prefix
may decrease. A max-of-counts clamp is forbidden because it can overcharge the
final result. For the hash-pinned Qwen tokenizer, a conservative certified cut is
immediately **before** the ASCII space in `[A-Za-z0-9] `. A nonterminal
checkpoint delivers that guard space too, but does not bill it yet; the buyer
must observe the boundary before signing. Its certified billed prefix ends one
character before the delivered text. Keep only the unfinished suffix for a later
checkpoint. NFC cannot compose across this fixed
space, no pinned added token contains it, and the preceding alphanumeric regex
piece cannot grow across it. Other tokenizers need their own certified frontier
or one final exact block within current limits. An indivisible piece can reach
the existing 128-token response bound. A proposed target block size is therefore
soft, and first-block exposure includes input cost. This contract does not select
a production target without engine and round-trip measurements.

The accepted residual risk is one unapproved delivery block per interrupted
exchange, **while native settlement remains live**. Reputation and dual-signed
receipts mitigate risk; they are not insurance or proof of blame for an unsigned
block. Host expiry triggers settlement work, not an automatic blockchain
transaction. A seller offline beyond forced-close grace can also lose older
unclaimed signed totals. No adaptor signatures, conditional cryptographic
payments, new service, protocol fee change or perfect fair-exchange claim is
introduced by this extension.

### Durable block ports and certified metering

`SessionBlockBuyer` and `SessionBlockSeller` extend the existing financial ports
without changing native voucher bytes. A `SessionBlockIntent` contains index,
checkpoint digest, cumulative usage/bill and a terminal boolean. It contains no
response text or tool arguments. The seller prepares it durably before
publishing a checkpoint; the buyer durably records the independently verified
intent before signing, then the exact voucher before sending. The seller
verifies the authenticated buyer and SDK signature and persists acceptance
before ACK. A terminal ACK alone marks the original inference complete.

The existing private session file has an explicit block-aware version 2; native
memo/voucher version 1 remains unchanged. Version 1 files stay readable under
existing semantics. Enabling a fresh block request upgrades the private record
atomically only after legacy pending requests resolve. Unknown versions or
contradictory state fail closed. Older software cannot read the new private
record and must not be used to downgrade an active block session.

Each original request has a fixed channel base, its latest accepted intent and
at most one pending intent/voucher. With request ceiling M and effective signed
request charge C, the remaining reserve stays M−C until the terminal ACK. The
effective charge is the pending charge only if its voucher is durable;
otherwise it is the accepted charge. Whole-request accounting and block
accounting are disjoint, so completed totals cannot be counted twice. The
existing private-file bound, exclusive lock, SDK-operation queue and poisoning
on uncertain persistence remain in force.

Recovery can reconstruct only the exact durably verified intent, or resend its
exact saved voucher. It cannot execute a prompt, invent a new block, change the
bill or clear the original request reservation. A cancellation before the first
intent creates no recoverable approval. If signing has already begun, its
result must be saved even when cancellation prevents its publication; later
financial recovery uses that same attempt. Runtime generation ownership is not
restored from disk. After release or restart, an interrupted block request is
eligible for the existing idle close using the highest seller-accepted total,
including the existing below-threshold exception for unfinished work.

`RecountTokenizer.stablePrefix` is optional and certified only by the tokenizer
implementation that owns it. The pinned Qwen adapter verifies its public
artifacts before exposing the conservative ASCII-space frontier. The optional
target selects the earliest certified frontier reaching that cumulative count;
a large engine fragment therefore need not become an arbitrarily larger block
when an earlier safe boundary exists. Text without such a frontier requires one
terminal exact block within existing limits. Free/declared metering and legacy
whole-result verification remain unchanged by the optional port.
