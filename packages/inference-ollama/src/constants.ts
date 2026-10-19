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
  parallel: 1,
  loadedModels: 1,
  residencyMs: 5 * 60_000,
} as const;

export const GENERATION = {
  numCtx: 2048,
  seed: 42,
  temperature: 0,
  keepAlive: `${READINESS_GENERATION.residencyMs}ms`,
} as const;

export const MODEL_LIMITS = {
  requestMinOutputTokens: INFERENCE_REQUEST_LIMITS.minOutputTokens,
  requestMaxOutputTokens: INFERENCE_REQUEST_LIMITS.maxOutputTokens,
  adapterMaxOutputTokens: 512,
  maxPromptCharacters: INFERENCE_REQUEST_LIMITS.maxPromptCharacters,
  maxFrameCharacters: 1_000_000,
  maxOutputCharacters: 100_000,
} as const;
