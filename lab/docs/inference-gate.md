# Lab inference gate

`pnpm gate:inference` runs six metered-inference cases with a real local model
and a real devnet payment channel, then checks that the buyer's own token count
and the confirmed on-chain charge agree. It has no peer-to-peer connectivity and
uses lab test prices, not the seller node's pricing: the seller daemon prices
each offer from `config.toml` plus the protocol fee (see
[configuration.md](../../docs/configuration.md)).

Gates send real devnet transactions. Run this one only when authorized, never to
validate a change.

## Prerequisites

- Ollama installed.
- The lab gate setup and funding described in
  [lab/README.md](../README.md#gates).

Then download and verify the model and tokenizer, and run the gate:

```sh
pnpm gate:inference:setup
pnpm gate:inference
```

## Model and runtime

Setup downloads Qwen3 0.6B Q4_K_M (about 523 MB of model layers) into
`.local/gyblos/artifacts/ollama-models/` and the public tokenizer into
`.local/gyblos/artifacts/tokenizer/`. Both are public and hash-pinned. The
seller daemon uses only the tokenizer (its model comes from the seller's own
Ollama), so the model layers are a lab cache
([running-a-node.md](../../docs/running-a-node.md#local-home)). The
`@huggingface/tokenizers` dependency gives the buyer an independent count.

The model manifest digest, model revision, tokenizer and config hashes, and
tokenizer version are pinned in
[`packages/engine-ollama/src/constants.ts`](../../packages/engine-ollama/src/constants.ts).
Setup verifies them; a mismatch stops inference before any payment. The chat
renderer lives in
[`model.ts`](../../packages/engine-ollama/src/model.ts).

| Process                   | Port                    |
| ------------------------- | ----------------------- |
| Gate-owned Ollama         | 11436 (loopback only)   |
| Ollama during model setup | 11437                   |
| Facilitator               | 4022                    |
| Inference seller          | ephemeral loopback port |

Stop other gate hosts first. Cloud inference is off: the child environment sets
`OLLAMA_HOST`, `OLLAMA_MODELS` and `OLLAMA_NO_CLOUD`, and the run also sets
`OLLAMA_DEBUG=0` and `OLLAMA_CONTEXT_LENGTH=2048`.

## Template and generation

The gate uses the pinned template's no-tools branch with hidden thinking off: an
optional system message, then user and assistant turns ending with the user's.
A lone user message renders exactly as the single-user branch. The adapter sends
the rendered prompt in raw mode, so Ollama applies no second chat template.
Generation uses seed 42, temperature 0 and the adapter's default 2,048-token
context (`GENERATION.numCtx`); the gate requests at most 128 output tokens.

The buyer counts the rendered input, including template tokens, and the visible
output on its own. It adds no end-of-sequence token to the visible output.
Engine and recounted values, and their differences, are both recorded.

## Ceiling and charge

The seller computes a ceiling with `DynamicPrice`. Deposit confirmation and
seller admission run before generation. Admission reads only the requested
channel with `getAccountInfo`, reuses the SDK's owner, layout and canonical-PDA
checks, and verifies the channel participants, the committed deposit and the
canonical escrow.

Test prices, in atomic units (`PRICES` in `@gyblos/core`):

```text
charge = input tokens × 1 + output tokens × 2
ceiling = 2 × (rendered input tokens × 1 + requested output limit × 2)
```

A ceiling above 10,000 atomic units is rejected, not silently reduced. The gate's
asset is labeled either as the lab test token (`devnet-test-token`, not USDC) or
as Circle devnet USDC.

The buyer derives the actual charge from confirmed chain observations and
reconciles the deposit, claim, balances and the unused deposit returned. It
also computes an expected charge from its own counts. A dishonest seller can
still settle an inflated bill within the ceiling: detection doesn't prevent the
payment or refund the difference.

## Tolerance and classification

Tolerance is fixed before measuring, separately for input and output
(`TOLERANCE` in `@gyblos/core`):

```text
count allowance = max(2, ceil(recounted tokens × 0.02))
price allowance = input allowance × 1 + output allowance × 2
```

Engine and buyer counts are each checked against their allowance. For a failed
HTTP response, the expected charge and allowance are both zero. A successful
response must have the expected request, offer, model and digest, non-empty
content and valid usage and billing before its measurement is accepted.

Classification, in priority order:

| Condition                                                               | Classification |
| ----------------------------------------------------------------------- | -------------- |
| Actual charge exceeds expected charge plus price allowance              | `overcharge`   |
| Otherwise, HTTP status is not 200                                       | `failed`       |
| Otherwise, delivery is incomplete                                       | `incomplete`   |
| Otherwise, actual charge is below expected charge minus price allowance | `undercharge`  |
| Otherwise                                                               | `none`         |

`delivered` needs a successful, complete response ending with `stop`; `length`
is incomplete. Delivery says nothing about answer quality. A charge exactly at
either tolerance boundary is `none`. Classification records an anomaly; it never
changes settlement, refunds, prices or reputation.

## Cases

The six cases, in four groups:

1. **Three honest calls.** Compare independent counts, billing, charge and
   delivery.
2. **Overcharge.** Bill 40% more output tokens (rounded up), within the
   ceiling. Expected: a settled overcharge that the buyer detects.
3. **Undercharge.** Bill 60% of the output tokens (rounded down), input
   unchanged. Expected: a complete, successful response, a positive charge
   strictly below the expected charge minus its allowance, `undercharge`
   recorded, and the unused deposit returned normally.
4. **Interruption.** After a real output fragment, kill only the gate's Ollama.
   Expected: failed delivery, zero charge and the full unused deposit
   returned. This does not test a seller-process crash.

## Private local measurements

Lab records append to `.local/lab/measurements.jsonl`; paid calls from the
`buyer:call` command append to `measurements.jsonl` in the buyer home. They hold confirmed
deposit and claim signatures, actual and expected charges, absolute and relative
differences, token counts, delivery and anomaly status, under an explicit field
allowlist. Prompts and answers are never saved.

Only a salted response hash is kept; the private salt sits next to the records
as `measurement-salt`. `sellerReceipt` is `null`: these are local buyer
declarations, not authenticated seller receipts or verifiable content evidence.

Latency runs from signing to the complete buffered response, and tokens per
second includes payment and settlement overhead. Invalid or non-positive latency
gives `null` latency and throughput. First-word latency is `null`; fragment
timestamps exist to inject the interruption, not to measure streaming.

## Results

The run writes its report to `lab/evidence/gate-0005.json`, which Git ignores;
journals and other diagnostics stay in the lab home (`.local/lab/`). The run
waits between cases so public RPC rate windows can clear.

An uncertain authorization blocks later gates until it is reconciled; nothing
retries a payment automatically. See [recovery.md](../../docs/recovery.md) and
[limitations.md](../../docs/limitations.md).
