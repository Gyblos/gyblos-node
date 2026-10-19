# Limitations and recovery

This repository is an experimental TypeScript x402 payment foundation for
Gyblos. It exercises Solana devnet fixed resources and a local Ollama inference
gate, plus a separate experimental native Iroh Docker PoC. Home-router NAT and
real separate-network connectivity remain untested. Use isolated generated
devnet wallets only. Never import mainnet keys.

## Payment scope

The fixed `upto` gate demonstrates a signed spending ceiling, a smaller charge
and unused-deposit return through a payment channel. It checks distinct
confirmed open/claim transactions, buyer/seller balance changes, unchanged buyer
SOL, channel distribution and fixed-resource delivery. An unpaid HTTP 402
challenge alone establishes none of the paid settlement/refund behavior.

The six-decimal fallback SPL mint is labeled `devnet-test-token`, not USDC.
Provisioning preserves existing keys and does not mint additional tokens if that
mint already exists. Inference accepts the explicitly configured test token or
Circle devnet USDC; the public fixed-price gate requires Circle devnet USDC.

The fixed failure gate covers an empty buyer and an expired authorization, each
without resource execution or charge. Expiry has a roughly 60-second validity
window plus a two-second grace wait; setup and RPC work add to total runtime. It
is not a replay or seller-crash recovery test.

## Public fixed-price facilitator

The public `exact` route charges 10,000 atomic units (0.01 Circle devnet USDC)
for a fixed resource. It provides neither usage metering nor an unused-ceiling
refund. It runs alongside the local `upto` route and does not replace it. Its
seller uses an ephemeral loopback port and settles before resource execution.

The primary provider is `https://x402.org/facilitator`; the configured backup is
`https://facilitator.payai.network`. Capabilities are queried and recorded from
`/supported` before paying. A changed capability or fee payer stops the gate.
Paid interoperability has been verified with x402.org; the PayAI backup has not
been tested with a payment. Availability depends on these third parties.

Before signing, the buyer validates network, Circle mint, price, recipient and
fee payer. Negative cases reject an unexpected mint, recipient or fee payer. A
buyer without USDC is rejected locally before signing, without submitting its
payment to the public provider. Replay is rejected without another resource
execution, but the guard is limited to the same seller process; protection
across restarts or distributed sellers has not been validated.

The isolated local facilitator wallet sponsors token-account provisioning. The
public facilitator sponsors the payment transaction; the buyer's SOL should not
change. This does not remove the need for devnet SOL for provisioning.

## Uncertain outcomes and manual reconciliation

- A timeout does not establish absence of payment, failure or refund. A
  potentially uncertain settlement is recorded and blocks new payments until
  reconciled on-chain.
- A buyer disconnect after generation can leave a confirmed charge without a
  delivered answer or payment-response header. Reconcile that outcome as charged
  but undelivered; do not assume a refund or repeat the payment.
- An absent transaction in a history query does not prove payment failure. The
  gate does not automatically switch providers after attempting settlement.
- A crash may leave `.local/devnet/buyer.lock` or an unresolved journal. Do not
  delete these to retry without first inspecting the authorization and its
  transactions.
- The local facilitator uses in-memory storage. Durable recovery, unilateral
  channel closure and subsequent recovery of all channel PDA rent have not been
  validated.

Use the recorded public transaction signatures, authorization metadata and
on-chain balances to establish the outcome before another authorization. There
is no general automatic recovery command or guarantee that an interrupted run
has returned funds.

## Inference and verification limits

Buyer measurements have no signed seller receipt. Token recounts detect
within-ceiling overcharge after settlement; they do not prevent, automatically
refund or penalize it. The visible-output/EOS convention and declared tolerance
remain explicit. See [inference details](inference.md).

Model manifest and tokenizer pins check the gate's local artifacts. They do not
authenticate a remote seller's model with LOGIC or establish answer correctness.
The local gate does not validate P2P transport. The separate Iroh PoC does not
implement reputation scoring, penalties, MPP, mobile apps or mainnet. Responses
are buffered; buyer-facing streaming and first-word latency are not implemented.
Killing the gate-owned engine is not durable recovery of a crashed seller or
facilitator.

The fixed-resource gates retain their own scope. A successful fixed-resource or
public `exact` result does not validate metered inference, P2P transport or the
correctness of delivered content.

## Local files and configuration

Keys, journals and diagnostics normally live under `.local/devnet/`. Key files
must never enter logs or shared results. Measurements and the private salt use
fixed paths in that directory; model artifacts live in `.local/ollama/models/`.
Changing `GYBLOS_GATE_CONFIG` selects a config file without relocating these
other paths. Inference requires the default isolated key paths.

The public-facilitator report is saved locally to `evidence/gate-0004.json`,
with advertised capabilities, signatures and public metadata. The inference
report is at `evidence/gate-0005.json`; fixed-resource results and
failure/challenge reports stay under `.local/devnet/`. These reports are not
signed seller receipts. Keep private files local and review output before
sharing it.

Configuration is read from the process environment and config file; `.env` is
not loaded automatically. RPC identity is checked using the devnet genesis hash.
Operational paths and ports are defined in `@gyblos/config`, with the public
commands and defaults in the [README](../README.md#configuration).

## Experimental native transport

The flat Docker trial uses a separately pinned owner-signed offer, actual remote
NodeId verification and bounded HTTP framing over Iroh. The exact per-request
ceiling is independently calculated before signing. The seller exposes only the
paid inference route; Ollama and the facilitator remain loopback-only. Role keys
and journals stay in distinct container volumes under `.local/p2p/`.

An initially uncertain engine error was reconciled through finalized chain
transactions as zero charged and a complete unused-deposit return. An HTTP error
alone never establishes that result. Preserve failed attempts and their original
image/source identity when rebuilding; do not delete journals to rerun a case.

Native routes are sampled observations. Direct connections reveal peer IPs. The
relay-only seller option has local rejection tests but no off-host privacy
proof. NAT-direct, UDP-blocked relay fallback and real-network success rates
remain pending. A handshake timeout closes the entire endpoint because the
binding exposes no individual handshake-cancellation handle.

`evidence/gate-0006.json` is the explicitly authorized redacted Docker report.
It contains public settlement metadata and synthetic-case measurements, not
keys, salts, content, signed payment payloads, RPC URLs or endpoint addresses.
Raw measurements and reconciliation records remain private. See the
[Docker command](../README.md#experimental-iroh-docker-trial) for prerequisites.
