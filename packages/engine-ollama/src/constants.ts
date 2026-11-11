// Pinned model (qwen3:0.6b digest, tokenizer and config hashes, template mode), deterministic generation
// settings and prompt/output size limits.
import {
  INFERENCE_REQUEST_LIMITS,
  TOKENIZER_SDK_VERSION,
} from '@gyblos/config';

export const MODEL = {
  name: 'qwen3:0.6b',
  digest: '7df6b6e09427a769808717c0a93cadc4ae99ed4eb8bf5ca557c90846becea435',
  quantization: 'Q4_K_M',
  publicModel: 'Qwen/Qwen3-0.6B',
  revision: 'c1899de289a04d12100db370d81485cdf75e47ca',
  tokenizerVersion: `@huggingface/tokenizers@${TOKENIZER_SDK_VERSION}`,
  tokenizerSha256:
    'aeb13307a71acd8fe81861d94ad54ab689df773318809eed3cbe794b4492dae4',
  configSha256:
    'd5d09f07b48c3086c508b30d1c9114bd1189145b74e982a265350c923acd8101',
  templateMode:
    'single-user/no-tools/enable_thinking=false/add_generation_prompt=true',
} as const;

export const READINESS_GENERATION = {
  prompt: 'Reply OK.',
  maxTokens: 1,
  residencyMs: 5 * 60_000,
} as const;

export const GENERATION = {
  // The default context; an offer may set its own up to MODEL_LIMITS.maxContextTokens.
  numCtx: 8192,
  seed: 42,
  temperature: 0,
  keepAlive: `${READINESS_GENERATION.residencyMs}ms`,
} as const;

export const MODEL_LIMITS = {
  // The lab's inference evidence keeps the original bounded request.
  requestMaxOutputTokens: INFERENCE_REQUEST_LIMITS.maxOutputTokens,
  // Qwen3-0.6B's native context; the model card's longer window needs rope scaling Ollama does not set.
  minContextTokens: 512,
  maxContextTokens: 32768,
  // The free channel's input bytes, rendered: the context bounds it again in tokens.
  maxConversationCharacters: 262144,
  maxFrameCharacters: 1_000_000,
  // The free channel's output bytes.
  maxOutputCharacters: 262144,
} as const;
