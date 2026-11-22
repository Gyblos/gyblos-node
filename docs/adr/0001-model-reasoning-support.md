# ADR 0001: Expose only verified model reasoning modes

- Status: Accepted
- Date: 2026-10-24
- Owners: Gyblos maintainers

## Context

Providers represent reasoning differently. Some expose a graded effort, some a
binary thinking switch, and some do not expose a reasoning mode. Hidden
reasoning is not metered as visible output, so provider defaults must not
silently enable unpriced work.

The source comments recorded a primary-source verification snapshot dated
2026-10-24. The configuration guide holds the current model details; update this
record when the underlying model assumptions are reverified.

## Decision

The shared catalog is naming metadata, not proof of a model's weights,
availability, or audits. It records open-weight status and reasoning modes only
when primary model or license sources verify them. Unverified values remain
`null`; reasoning levels that do not map to the protocol vocabulary remain
unverified until maintainers decide how to represent them.

Offers use conservative defaults. `gpt-oss` supports low, medium and high, with
low as the offer default even though the model defaults to medium, because
reasoning is not metered. Qwen3 and Gemma 4 map their on/off thinking switch to
off/high and default to off; Llama 3.3 has only off. The catalog keeps the Qwen3
30B-A3B hybrid `q4_K_M` alias because the bare Ollama tag points to a
thinking-only build. The Qwen3 offer defaults to off because thinking is not
metered and the Ollama adapter disables it. DeepSeek V4.1 Flash, Kimi K3 and GLM
5.3 Flash remain unverified because their provider effort modes do not map
one-to-one to the protocol levels.

The Qwen3 `30b-a3b` alias uses the hybrid `q4_K_M` tag because the bare Ollama
tag points to a thinking-only build. The catalog does not treat model names as
proof of weights, availability or audits.

## Consequences

The catalog and adapter behavior must agree with the verified modes. A new
provider model remains without declared reasoning support until a primary source
and a compatible protocol mapping are available.

## References

- [Model configuration](../configuration.md)
- [Shared model catalog](../../packages/protocol/src/models.ts)
