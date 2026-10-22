# Local inference and buyer measurements

Follow the [inference task in the README](../README.md#run-metered-inference)
after installing Ollama and provisioning the isolated devnet wallets and token
accounts. This is a local inference/payment gate, without P2P connectivity.

## Model and runtime

Setup downloads Qwen3 0.6B Q4_K_M, approximately 523 MB of model layers, into
`.local/ollama/models/`. Public tokenizer artifacts are stored under
`.local/devnet/tokenizer/`. The `@huggingface/tokenizers` dependency provides
independent buyer-side counting.

The model manifest digest, public model revision, tokenizer/config hashes and
tokenizer version are pinned in
[`packages/engine-ollama/src/constants.ts`](../packages/engine-ollama/src/constants.ts).
Setup verifies the model and artifacts; a mismatch stops inference before
payment. The single-user chat renderer lives in
[`model.ts`](../packages/engine-ollama/src/model.ts).

The gate starts its own loopback-only Ollama on port 11436 and a facilitator on
4022; its inference seller uses an ephemeral loopback port. Model setup
uses 11437. Stop other gate hosts first. Cloud inference is disabled. Child
environment values set `OLLAMA_HOST`, `OLLAMA_MODELS` and `OLLAMA_NO_CLOUD`; the
inference run also sets `OLLAMA_DEBUG=0` and `OLLAMA_CONTEXT_LENGTH=2048`.

## Template and generation

Only the pinned single-user/no-tools template branch is supported, with hidden
thinking disabled. The adapter sends the rendered prompt in raw mode, avoiding a
second implicit Ollama chat template. Generation uses context 2048, seed 42 and
temperature 0; the gate requests at most 128 output tokens.

The buyer counts the rendered input, including template tokens, and the visible
output independently. It does not add a terminal EOS token to the visible output
count. Both engine and recounted values, with their differences, remain
recorded.

## Ceiling and charge

The seller computes a ceiling through `DynamicPrice`. Deposit confirmation and
seller admission checks precede generation. Admission reads only the requested
channel with `getAccountInfo`, reuses the SDK's owner/layout/canonical-PDA
checks, and verifies channel participants, the committed deposit and canonical
escrow.

Actual test pricing, in atomic units, is:

```text
charge = input tokens × 1 + output tokens × 2
ceiling = 2 × (rendered input tokens × 1 + requested output limit × 2)
```

A ceiling above 10,000 atomic units is rejected, rather than silently reduced.
Prices are test values, not a commercial offer. The configured asset is labeled
explicitly as either `devnet-test-token` (not USDC) or Circle devnet USDC.

The buyer derives the actual charge from confirmed chain observations and
reconciles deposit, claim, balances and the unused deposit return. It separately
computes an expected charge from its own counts. A dishonest seller can settle
an inflated bill within the authorized ceiling; detection does not prevent
payment or reimburse the difference.

## Tolerance and case classification

Tolerance is fixed before measurement, separately for input and output:

```text
count allowance = max(2, ceil(recounted tokens × 0.02))
price allowance = input allowance × 1 + output allowance × 2
```

Engine-versus-buyer count comparison checks each side against its allowance. For
failed HTTP responses, expected charge and allowance are both zero. Successful
responses must have the expected request/offer/model/digest, nonempty content
and valid numeric usage and billing before a measurement is accepted.

The anomaly classification uses this priority:

| Condition                                                               | Classification |
| ----------------------------------------------------------------------- | -------------- |
| Actual charge exceeds expected charge plus price allowance              | `overcharge`   |
| Otherwise, HTTP status is not 200                                       | `failed`       |
| Otherwise, delivery is incomplete                                       | `incomplete`   |
| Otherwise, actual charge is below expected charge minus price allowance | `undercharge`  |
| Otherwise                                                               | `none`         |

`delivered` requires a successful complete response ending with `stop`; a
`length` termination is incomplete. Delivery does not establish answer quality.
Equality at either tolerance boundary remains `none`. A lower charge is labeled
`undercharge` only for delivered, successful inference; failed or incomplete
responses retain their earlier classifications. This records an anomaly without
changing settlement, refund, prices or reputation policy. Negative atomic and
relative charge differences remain recorded.

The six gate cases are:

1. Three honest calls: compare independent counts, billing, charge and delivery.
2. One adversarial call: inflate **billed output tokens by 40%, rounded up**,
   while remaining within the ceiling. The expected result is a settled
   overcharge that the buyer detects.
3. One undercharge call: bill **60% of output tokens, rounded down**, without
   changing the input count. The response must be complete and successful, the
   confirmed charge must be positive and strictly below the buyer's expected
   charge minus its allowance, and the measurement must record `undercharge`.
   The unused deposit is returned normally; no price or reputation policy
   changes.
4. One interruption: after a real output fragment, kill only the gate-owned
   Ollama process. The expected result is failed delivery, zero charge and a
   confirmed full unused-deposit return. This does not test a seller-process
   crash.

## Private local measurements

Records append to `.local/devnet/measurements.jsonl`. They include confirmed
deposit/claim signatures, chain-derived and expected charges, atomic and
relative differences, token counts, delivery and anomaly status. Records use an
explicit metadata allowlist; prompts and answers are not saved in measurements.

Only a salted response hash is retained. The private salt is stored at
`.local/devnet/measurement-salt`, with private file permissions. `sellerReceipt`
remains `null`; these are local buyer declarations, not authenticated seller
receipts or publicly verifiable content evidence.

Latency starts at signing and ends when the complete buffered response is
received. Effective tokens per second includes payment/settlement overhead.
Invalid or nonpositive latency produces null latency/throughput. First-word
latency is `null`; internal fragment timestamps support interruption injection,
not buyer-facing streaming measurements.

## Results and uncertainty

The local run report is written to `lab/evidence/gate-0005.json`; journals and
additional diagnostics stay under `.local/devnet/`. Existing attempts remain in
the report's history. The run waits between cases to let public RPC rate windows
clear.

An uncertain authorization blocks subsequent gates until it is reconciled. There
is no automatic payment retry. See [limitations and recovery](limitations.md)
for charges without delivery, journal handling and unvalidated recovery paths.
