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

**Status.** The command `pnpm model-verifier`, the challenge set `gyblos-text`
version 1 and the signed record (`@gyblos/protocol/model-verification`) ship
with the `apps/model-verifier` app; in a checkout without that app they are
design only. Still design, not built: private or rotating challenge sets, paid
verification, and any use of a result in discovery, routing, payments or the
public metrics, none of which reads a verification result today.

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
followed by a letter or digit, not after another space). The points are drawn
after the answer arrives, from a secret 32-byte nonce made for each run, so a
seller cannot know them in advance; the nonce is published in the result. At
each point it gives the declared model the exact rendered prompt plus the
seller's answer up to that point, asks for one token at temperature 0 and reads
its 20 most likely next tokens with their log probabilities. The point is a
**deviation** when no candidate is a prefix of the seller's continuation, or the
most probable candidate that is has a probability below 0.1 % (1,000 parts per
million). An answer that contains a chat template marker such as `<|im_end|>` is
not scored and counts as unanswered, because those markers could steer the
reference. A point where the declared model's most likely next token ends the
answer is not counted: Ollama returns no probabilities there, so the point says
nothing either way.

This approach needs no log probabilities from the seller and no protocol change,
it tolerates sampling, and it works for any engine that serves an open-weight
catalog model. An honest seller sampling from the declared model almost never
picks a token that the same model gives less than 0.1 %; a smaller model often
does.

### Decision rule

The rule is fixed by challenge set `gyblos-text` version 1: 30 prompts in
English and Spanish (explanations, code, JSON, SQL, short creative text), at
most 200 output tokens each, reasoning off.

The unit of the test is the **answer**, not the check. The 24 checks of one
answer read the same generated text, so they are not independent, and a binomial
bound over pooled checks would not bound how often an honest seller fails a run.
Each answer is a separate request and a separate generation, so an answer is
**deviant** when at least one of its checks is a deviation, and the test counts
deviant answers.

| Parameter                              | Value                            |
| -------------------------------------- | -------------------------------- |
| Checks per answer                      | up to 24                         |
| Reference candidates                   | top 20 next tokens               |
| Deviation probability floor            | 0.1 %                            |
| Assumed honest rate of deviant answers | 12 %                             |
| False positive bound per run           | 0.01 % (1 in 10,000 honest runs) |
| Minimum checks for `pass`              | 480                              |

`failAt` is the smallest number of deviant answers whose probability under a
binomial distribution over the scored answers, with the assumed honest rate, is
at most 0.01 %. With 30 answers it is 12. An empty answer, or one with no point
left to check, counts as unanswered.

- `fail`: deviant answers ≥ `failAt`. This holds even when prompts went
  unanswered, because `failAt` is computed for the answers actually scored.
- `inconclusive`: not a fail, but a prompt went unanswered or fewer than 480
  checks were made.
- `pass`: not a fail, every prompt answered and at least 480 checks.

A seller cannot skip the prompts it is unsure about and still pass, and each run
asks for quotes from a new, unrelated buyer address.

The assumed rate, 12 %, is at least the 95 % upper bound of the worst honest
case measured below (17 deviant answers in 240 at temperature 1 without top-k:
one-sided upper bound 10.4 %). At that bound an honest run fails with
probability about 0.002 %.

Assumptions behind the bound:

- Each prompt's chance of a deviant honest answer is at most the assumed rate,
  independently across prompts. The 12 % comes from answers pooled across
  prompts; per-prompt rates (for example the short haiku and limerick prompts)
  are not measured separately. A prompt above the rate would risk failing an
  honest seller; it would not help a substitute.
- The rate holds among scored answers. Answers are excluded only when they are
  blank, carry a chat template marker, fail in transport or leave no point to
  check, none of which depends on whether their checked points deviate.

What the rule catches, and what it does not:

- A full-time `qwen3-0.6b` substitute had 27 or 28 deviant answers out of 30 in
  every run, far above 12.
- Partial substitution has a hard floor. A substituted answer was deviant about
  92 % of the time; clean answers with engine defaults never were. A seller that
  substitutes on 11 or fewer of the 30 answers therefore cannot reach 12 and
  passes. With 12 substituted answers it fails about 37 % of the time, with 13
  about 72 %, with 14 about 90 % and with 15 about 97 %.

## How references are produced

The reference is the declared model run by the verifier in its own Ollama, under
the catalog alias of that model (for example `qwen3-1.7b` → `qwen3:1.7b`). The
verifier refuses models without a catalog alias or without the pinned Qwen3
tokenizer and template. The prompt is rendered with the Qwen3 template the
Ollama engine adapter uses (`renderChat` in `packages/engine-ollama`, thinking
off). The reference model's Ollama digest is recorded in the signed result.

What that makes reproducible, and what it does not:

- The digest pins the reference **weights**. It does not pin the runtime that
  scores with them: the Ollama version, hardware and numeric path can move a
  probability near the 0.1 % floor or a candidate near rank 20.
- From the evidence file anyone can **recompute** the verdict: count the stored
  checks, recompute `failAt` from the signed rule and compare. That trusts the
  stored checks.
- **Regenerating** the checks means pulling the same digest and scoring the
  stored answers again at the stored positions (the nonce is published). On
  another runtime the result can differ slightly; the margin in the assumed rate
  is for that, but it is not measured across Ollama versions.

## Measurements

Ollama 0.40.15 on one Apple M1 Max (64 GB). The verifier's reference ran on the
Metal GPU with the product template (`renderChat`). Honest sellers generated
either on the same GPU or on the CPU only (`num_gpu 0`), which is a different
numeric path. Every run asked all 30 prompts once, as a real verification does.

**Per complete run** (deviant answers out of 30; `failAt` is 12):

| Seller (all declare the reference model)          | Generates on | Sampling                          | Runs | Deviant answers per run |
| ------------------------------------------------- | ------------ | --------------------------------- | ---- | ----------------------- |
| Honest `qwen3:1.7b` through Ollama's OpenAI API   | GPU          | engine defaults (T 0.6, top-k 20) | 8    | 0 in every run          |
| Honest `qwen3:1.7b`                               | CPU          | engine defaults                   | 2    | 0, 0                    |
| Honest `qwen3:1.7b`, worst case                   | GPU          | T 1.0, no top-k, top-p 1          | 8    | 0, 1, 1, 1, 3, 3, 4, 4  |
| Honest `qwen3:0.6b`, the Ollama engine's own path | CPU          | T 0, seed 42                      | 1    | 0                       |
| `qwen3:0.6b` declared as `qwen3-1.7b`             | GPU          | engine defaults                   | 2    | 27, 27                  |
| `qwen3:0.6b` declared as `qwen3-1.7b`             | GPU          | T 1.0, no top-k, top-p 1          | 2    | 28, 28                  |
| `qwen3:1.7b` declared as `qwen3-0.6b`             | GPU          | T 0, seed 42                      | 1    | 11                      |

No honest run came near the threshold: the highest was 4 deviant answers, in the
worst-case sampling setting. With the usual engine defaults, 300 honest answers
had no deviation at all. The last row is a larger model sold as a smaller one;
it is not the fraud this check targets and it stays under 12.

Rescoring two earlier runs with Ollama's own template, which appends
`/no_think`, changed the counts by at most one deviation per run: the reference
does not need the seller's exact serving template.

End to end, the app ran against local sellers started with `pnpm node:start`
(ephemeral unfunded devnet keys, discovery off, free offer `qwen3-1.7b` on the
OpenAI-compatible engine):

| Seller serves | Answers | Checks | Deviant answers | `failAt` | Verdict |
| ------------- | ------- | ------ | --------------- | -------- | ------- |
| `qwen3:1.7b`  | 30      | 664    | 0               | 12       | `pass`  |
| `qwen3:0.6b`  | 30      | 661    | 28              | 12       | `fail`  |

A run takes a few minutes on this machine, mostly the seller's generation.

### Not measured yet

- An NVIDIA GPU, Windows or Linux seller, vLLM, SGLang or llama.cpp servers, and
  other Ollama versions. A higher measured honest rate on another stack would
  raise the assumed rate in a new challenge set version.
- A cloud provider serving the same weights in another precision.
- Sizes above 1.7B as the declared model.

## Run it

With the `apps/model-verifier` app in the checkout,
`pnpm model-verifier verify --seller seller.json --model qwen3-1.7b` runs the
challenge set against one seller and writes `result.json` and `evidence.json` to
a new result directory; `pnpm model-verifier check RESULT_DIRECTORY/result.json`
verifies a result's signature and that its rule matches the published challenge
set. The seller file and the full steps are on the docs site:
[Model verification](https://docs.gyblos.com/en/sellers/model-verification). The
app uses public package entries only (protocol, core, the Iroh transport and the
Ollama engine's chat template) and never imports the buyer, node or desktop
code.

## Signed result

The result is a `gyblos/model-verification/v1` record in `packages/protocol`
(`model-verification.ts`, with golden vectors). It holds the verifier address,
the seller's owner and NodeId, the declared selection, the challenge set id,
version and digest, the reference tag and digest, the evidence (prompt, answer,
check, deviation and deviant-answer counts, the rule's minimum checks, assumed
honest rate and false positive bound, `failAt`, the nonce and one SHA-256 digest
per answer) and the verdict, signed with the verifier's Ed25519 key. The parser
recomputes `failAt` and the verdict from the evidence and refuses any result
that does not match; a consumer still compares the signed rule with the
challenge set's. The evidence file next to it keeps the prompts, answers and
every check.

## Limits

- **Quantization.** A weaker quantization of the declared model is not the
  target. It changes the distribution much less than a different model size and
  needs its own rule.
- **A seller that recognizes the verifier.** The challenge prompts are public in
  this repository. A seller can recognize them and route them to the real model,
  or answer them with text prepared in advance, so a `pass` is not proof against
  a seller that targets the verifier. Answers with nothing to check only yield
  `inconclusive`. Rotating private challenge sets and prompts shaped like real
  traffic are follow-ups.
- **Partial substitution.** Substituting on 11 or fewer of 30 answers is not
  caught; see the decision rule.
- **Free offers only.** Paid verification needs a budget decision.
- **Reference hardware.** The verifier must run the declared model, so verifying
  a large model needs a machine that can load it.
- **Reasoning.** Only reasoning off is checked.
- **One verifier.** A result is evidence from one verifier key, not a network
  decision. How results reach the discovery index, the router or the public
  metrics is a follow-up.
