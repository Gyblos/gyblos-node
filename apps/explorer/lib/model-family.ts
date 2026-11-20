// Owns which maker's mark a published model id shows: the family is read from the id's own name, never
// from a seller's claim of provenance. Unknown ids show no mark. Pure, no I/O.

// Each family's mark is `public/models/<family>.svg` (monochrome, from LobeHub icons, MIT).
const FAMILIES = [
  ['qwen', /qwen|qwq/],
  ['meta', /llama|meta/],
  ['mistral', /mistral|mixtral|codestral|ministral|devstral|magistral/],
  ['gemma', /gemma/],
  ['google', /gemini/],
  ['deepseek', /deepseek/],
  ['microsoft', /(^|[^a-z])phi/],
  ['openai', /gpt|(^|[^a-z])o[134]-/],
  ['claude', /claude/],
  ['nvidia', /nemotron/],
  ['ibm', /granite/],
  ['huggingface', /smollm/],
  ['kimi', /kimi/],
  ['zhipu', /glm/],
  ['yi', /(^|[^a-z])yi[-:]/],
] as const;

export type ModelFamily = (typeof FAMILIES)[number][0];

export function modelFamily(modelId: string): ModelFamily | null {
  const id = modelId.toLowerCase();
  return FAMILIES.find(([, pattern]) => pattern.test(id))?.[0] ?? null;
}

export const modelMarkUrl = (family: ModelFamily) => `/models/${family}.svg`;
