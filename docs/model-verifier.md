# Model verifier

The model verifier checks whether a seller serves the model it declares. It
behaves as an ordinary buyer: it asks a seller's free offer a fixed, versioned
set of challenge prompts, then rereads every answer with the declared model run
by the verifier itself. An answer that the declared model would almost never
write is evidence of another model. The outcome for one seller, model and
challenge set version is `pass`, `fail` or `inconclusive`, signed by the
verifier key.

This page records the design: the chosen signal, the rule and its thresholds,
how references are produced, and the measured error rates. It covers detecting a
seller that serves a different model than it declares. Quantization, inflated
usage, a false context length, paid offers and any use of the result in
discovery or routing are out of scope; see [Limits](#limits).

## Why not the other candidate signals

**Identical tokens at temperature 0.** Only the Ollama engine adapter generates
with temperature 0 and a fixed seed, and it serves only `qwen3-0.6b`. Every
other Qwen3 size is served through the OpenAI-compatible engine, which sends no
temperature or seed, so the engine samples with its own defaults (Ollama's Qwen3
defaults are temperature 0.6, top-k 20, top-p 0.95). The same prompt sent three
times to an honest local seller returned three different answers. Published
audits also report that greedy decoding does not reproduce across serving
stacks: agreement for the same weights on different providers can fall below 5 %
(Cai et al., _Are You Getting What You Pay For?_, 2025). Exact agreement would
make honest sellers fail, so it is not a signal here.

**Prompt token counts against a pinned tokenizer.** Every Qwen3 size in the
model catalog shares one tokenizer and chat template
(`packages/protocol/src/models.ts`), so a count cannot tell `qwen3-0.6b` from
`qwen3-32b`. It could only catch a seller that serves another model family, and
the chosen signal already catches that. It is not used.

**Throughput.** Tokens per second depend on the seller's hardware, load and
batching as much as on model size. A large GPU serving a small model looks like
a fast large model. Throughput is not part of the verdict.

## Chosen signal: rereading with the declared model

For each answer the verifier picks up to 24 points just before a word (a space
followed by a letter or digit, not after another space). At each point it gives
the declared model the exact rendered prompt plus the seller's answer up to that
point, asks for one token at temperature 0 and reads its 20 most likely next
tokens with their log probabilities. The point is a **deviation** when no
candidate is a prefix of the seller's continuation, or the highest-ranked
candidate that is has a probability below 0.1 % (1,000 parts per million).

This is the approach recorded in the internal model verification research: it
needs no log probabilities from the seller and no protocol change, it tolerates
sampling, and it works for any engine that serves an open-weight catalog model.
An honest seller sampling from the declared model almost never picks a token
that the same model gives less than 0.1 %; a smaller model often does.

### Decision rule

The rule is fixed by challenge set `gyblos-text` version 1
(`apps/model-verifier/src/challenge-set.ts`): 30 prompts in English and Spanish
(explanations, code, JSON, SQL, short creative text), at most 200 output tokens
each, reasoning off.

| Parameter                     | Value                               |
| ----------------------------- | ----------------------------------- |
| Checks per answer             | up to 24                            |
| Reference candidates          | top 20 next tokens                  |
| Deviation probability floor   | 0.1 %                               |
| Assumed honest deviation rate | 0.5 %                               |
| False positive bound          | 0.01 % (1 in 10,000 honest sellers) |
| Minimum checks for `pass`     | 480                                 |

`failAt` is the smallest number of deviations whose probability under a binomial
distribution with the assumed honest rate is at most 0.01 %. With 720 checks it
is 13; with 480 checks it is 11.

- `fail`: deviations ≥ `failAt`. This holds for any number of checks, because
  `failAt` is computed for the checks actually made.
- `inconclusive`: fewer deviations, but fewer than 480 checks (for example, the
  seller refused or failed most prompts).
- `pass`: fewer deviations and at least 480 checks.

The assumed honest rate, 0.5 %, is about 3.7 times the 95 % upper bound of the
measured honest rate below (0.14 %), as margin for hardware and serving stacks
not yet measured. At 480 checks the rule still catches a seller that deviates on
3.4 % of checks with probability 0.94, and at 720 checks with 0.996; a full-time
`qwen3-0.6b` substitute deviates on 10–21 %.

## How references are produced

The reference is the declared model run by the verifier in its own Ollama, under
the catalog alias of that model (for example `qwen3-1.7b` → `qwen3:1.7b`). The
verifier refuses models without a catalog alias or without the pinned Qwen3
tokenizer and template. The prompt is rendered with the Qwen3 template the
Ollama engine adapter uses (`renderChat` in `packages/engine-ollama`, thinking
off). The reference model's Ollama digest is recorded in the signed result, so
anyone can pull the same weights, rerun the same challenge set and recompute
every check from the evidence file.

## Measurements

Ollama 0.40.15 on one Apple M1 Max (64 GB). The verifier's reference ran on the
Metal GPU. Honest sellers generated either on the same GPU or on the CPU only
(`num_gpu 0`), which is a different numeric path. Each run asked each of the 30
prompts twice (once for the 0.6B greedy runs).

| Seller (all declare the reference model)          | Generates on | Sampling                          | Checks | Deviations     |
| ------------------------------------------------- | ------------ | --------------------------------- | ------ | -------------- |
| Honest `qwen3:1.7b` through Ollama's OpenAI API   | GPU          | engine defaults (T 0.6, top-k 20) | 1,316  | **0**          |
| Honest `qwen3:1.7b`                               | CPU          | engine defaults                   | 1,320  | **0**          |
| Honest `qwen3:1.7b`, worst case                   | GPU          | T 1.0, no top-k, top-p 1          | 1,319  | **2 (0.15 %)** |
| Honest `qwen3:0.6b`, the Ollama engine's own path | CPU          | T 0, seed 42                      | 647    | **0**          |
| `qwen3:0.6b` declared as `qwen3-1.7b`             | GPU          | engine defaults                   | 1,316  | 178 (13.5 %)   |
| `qwen3:0.6b` declared as `qwen3-1.7b`             | GPU          | T 1.0, no top-k, top-p 1          | 1,338  | 284 (21.2 %)   |
| `qwen3:1.7b` declared as `qwen3-0.6b`             | GPU          | T 0, seed 42                      | 680    | 19 (2.8 %)     |

Honest sellers: 2 deviations in 4,602 checks. Rescoring with the product
template, without the `/no_think` suffix Ollama's own template appends, gave 0
and 1 deviations on the two honest GPU runs and 166 on the substitute: the
reference does not need the seller's exact serving template.

End to end, the app ran against local sellers started with `pnpm node:start`
(ephemeral unfunded devnet keys, discovery off, free offer `qwen3-1.7b` on the
OpenAI-compatible engine):

| Seller serves | Answers | Checks | Deviations | `failAt` | Verdict |
| ------------- | ------- | ------ | ---------- | -------- | ------- |
| `qwen3:1.7b`  | 30      | 665    | 0          | 13       | `pass`  |
| `qwen3:0.6b`  | 30      | 646    | 65         | 13       | `fail`  |

A run takes a few minutes on this machine, mostly the seller's generation.

### Not measured yet

- An NVIDIA GPU, Windows or Linux seller, vLLM, SGLang or llama.cpp servers, and
  other Ollama versions. The 0.5 % assumption covers some drift; a measured
  false positive on another stack would raise it in a new challenge set version.
- A cloud provider serving the same weights in another precision.
- Sizes above 1.7B as the declared model.

## Run it

`pnpm model-verifier verify --seller seller.json --model qwen3-1.7b` runs the
challenge set against one seller and writes `result.json` and `evidence.json`;
`pnpm model-verifier check result.json` verifies a result. The seller file and
the full steps are on the docs site:
[Model verification](https://docs.gyblos.com/en/sellers/model-verification). The
app is `apps/model-verifier`. It uses public package entries only (protocol,
core, the Iroh transport and the Ollama engine's chat template) and never
imports the buyer, node or desktop code.

## Signed result

The result is a `gyblos/model-verification/v1` record in `packages/protocol`
(`model-verification.ts`, with golden vectors). It holds the verifier address,
the seller's owner and NodeId, the declared selection, the challenge set id,
version and digest, the reference tag and digest, the evidence counts
(`answers`, `checks`, `deviations`, `failAt`), one SHA-256 digest per answer and
the verdict, signed with the verifier's Ed25519 key. The parser refuses a
verdict its own evidence contradicts. The evidence file next to it keeps the
prompts, answers and every check, so the result can be recomputed.

## Limits

- **Quantization.** A weaker quantization of the declared model is not the
  target. Earlier internal measurements put it near 5 % deviations at
  temperature 0 under a stricter rule; it needs its own rule.
- **A seller that recognizes the verifier.** The challenge prompts are public in
  this repository. A seller could route them to the real model. Rotating private
  challenge sets and prompts shaped like real traffic are follow-ups.
- **Free offers only.** Paid verification needs a budget decision.
- **Reference hardware.** The verifier must run the declared model, so verifying
  a large model needs a machine that can load it.
- **Reasoning.** Only reasoning off is checked.
- **One verifier.** A result is evidence from one verifier key, not a network
  decision. How results reach the discovery index, the router or the public
  metrics is a follow-up.
