export const MODEL_CATEGORIES = [
  'general',
  'coding',
  'agentic',
  'reasoning',
  'classification',
  'extraction',
  'embedding',
  'reranking',
  'vision',
  'speech-to-text',
  'text-to-speech',
  'translation',
  'moderation',
  'image-generation',
  'image-editing',
  'image-upscaling',
  'video-generation',
  'audio-generation',
  'document-understanding',
] as const;

export type ModelCategory = (typeof MODEL_CATEGORIES)[number];

export const isModelCategory = (value: unknown): value is ModelCategory =>
  MODEL_CATEGORIES.some((category) => category === value);

export function sortedCategories(values: readonly string[]): ModelCategory[] {
  const unique = new Set(values);
  return MODEL_CATEGORIES.filter((category) => unique.has(category));
}
