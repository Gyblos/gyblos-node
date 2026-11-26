const FAMILIES = [
  ['qwen', /^(?:qwen|qwq)(?=[^a-z]|$)/],
  ['meta', /^(?:llama|meta-llama)(?=[^a-z]|$)/],
  [
    'mistral',
    /^(?:mistral|mixtral|codestral|ministral|devstral|magistral)(?=[^a-z]|$)/,
  ],
  ['gemma', /^(?:gemma)(?=[^a-z]|$)/],
  ['google', /^(?:gemini)(?=[^a-z]|$)/],
  ['deepseek', /^(?:deepseek)(?=[^a-z]|$)/],
  ['microsoft', /^(?:phi)(?=[^a-z]|$)/],
  ['openai', /^(?:gpt|o[134])(?=[^a-z]|$)/],
  ['claude', /^(?:claude)(?=[^a-z]|$)/],
  ['nvidia', /^(?:nemotron)(?=[^a-z]|$)/],
  ['ibm', /^(?:granite)(?=[^a-z]|$)/],
  ['huggingface', /^(?:smollm)(?=[^a-z]|$)/],
  ['kimi', /^(?:kimi)(?=[^a-z]|$)/],
  ['zhipu', /^(?:glm)(?=[^a-z]|$)/],
  ['yi', /^(?:yi)(?=[^a-z]|$)/],
] as const;

export type ModelFamily = (typeof FAMILIES)[number][0];

const PUBLISHERS = new Map<string, ModelFamily>([
  ['qwen', 'qwen'],
  ['meta-llama', 'meta'],
  ['mistralai', 'mistral'],
  ['google', 'google'],
  ['deepseek-ai', 'deepseek'],
  ['microsoft', 'microsoft'],
  ['openai', 'openai'],
  ['anthropic', 'claude'],
  ['nvidia', 'nvidia'],
  ['ibm-granite', 'ibm'],
  ['huggingfacetb', 'huggingface'],
  ['moonshotai', 'kimi'],
  ['zai-org', 'zhipu'],
  ['thudm', 'zhipu'],
  ['01-ai', 'yi'],
]);
function familyByName(name: string): ModelFamily | null {
  return FAMILIES.find(([, pattern]) => pattern.test(name))?.[0] ?? null;
}

export function modelFamily(modelId: string): ModelFamily | null {
  const [publisher, name] = modelId.toLowerCase().split('/');
  if (!publisher) return null;
  if (name === undefined) return familyByName(publisher);
  if (!name) return null;
  if (publisher === 'google' && familyByName(name) === 'gemma') return 'gemma';
  return PUBLISHERS.get(publisher) ?? familyByName(name);
}

const LABS: Record<ModelFamily, string> = {
  qwen: 'Alibaba · Qwen',
  meta: 'Meta',
  mistral: 'Mistral AI',
  gemma: 'Google DeepMind',
  google: 'Google DeepMind',
  deepseek: 'DeepSeek',
  microsoft: 'Microsoft',
  openai: 'OpenAI',
  claude: 'Anthropic',
  nvidia: 'NVIDIA',
  ibm: 'IBM',
  huggingface: 'Hugging Face',
  kimi: 'Moonshot AI',
  zhipu: 'Zhipu AI',
  yi: '01.AI',
};
export const UNKNOWN_LAB = 'Unknown';
export type ModelIdentity =
  | { family: ModelFamily; lab: string; source: 'rules' }
  | { family: 'other'; lab: string; source: 'fallback' };

export function modelIdentity(modelId: string): ModelIdentity {
  const family = modelFamily(modelId);
  if (family) return { family, lab: LABS[family], source: 'rules' };
  const [publisher, name] = modelId.split('/');
  const lab = name !== undefined && publisher ? publisher : UNKNOWN_LAB;
  return { family: 'other', lab, source: 'fallback' };
}

export const modelLab = (modelId: string) => modelIdentity(modelId).lab;
