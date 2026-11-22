// Owns the initial shared model catalog, explicit case-sensitive aliases and each model's supported
// reasoning levels with the offer default.
// Catalog membership is naming metadata, never proof of weights, availability or audits.
import {
  MODEL_CLASSIFICATIONS,
  MODEL_IDS,
  REASONING_LEVELS,
  type CatalogModelId,
  type ReasoningLevel,
} from './constants';
import { publicIdentifier } from './public-validation';

export interface PublicTokenizer {
  repository: string;
  revision: string;
  // tokenizer.json and tokenizer_config.json, whose chat template the recount renders.
  sha256: string;
  configSha256: string;
}

// Levels a model supports, in REASONING_LEVELS order, and the level an offer gets when it lists none.
export interface ReasoningSupport {
  levels: readonly ReasoningLevel[];
  defaultReasoning: ReasoningLevel;
}

export interface CatalogModel {
  id: CatalogModelId;
  aliases: readonly string[];
  // Null means not verified from a primary model/license source in this catalog.
  openWeights: boolean | null;
  tokenizer: Readonly<PublicTokenizer> | null;
  // Null means the levels were not verified from a primary model source (GYB-DOC-028).
  reasoning: Readonly<ReasoningSupport> | null;
}

export type ModelResolution =
  | {
      kind: typeof MODEL_CLASSIFICATIONS.CATALOG;
      model: Readonly<CatalogModel>;
    }
  | { kind: typeof MODEL_CLASSIFICATIONS.CUSTOM; modelId: string };

interface EntryOptions {
  aliases?: string[];
  tokenizer?: PublicTokenizer;
  reasoning?: ReasoningSupport;
}

function entry(
  id: CatalogModelId,
  options: EntryOptions = {},
): Readonly<CatalogModel> {
  const { aliases = [], tokenizer, reasoning } = options;
  return Object.freeze({
    id,
    aliases: Object.freeze(aliases),
    openWeights: null,
    tokenizer: tokenizer === undefined ? null : Object.freeze(tokenizer),
    reasoning:
      reasoning === undefined
        ? null
        : Object.freeze({
            levels: Object.freeze([...reasoning.levels]),
            defaultReasoning: reasoning.defaultReasoning,
          }),
  });
}

// Reasoning sets, verified 2026-10-24 against primary sources (table in docs/configuration.md):
// - gpt-oss: OpenAI gpt-oss model card ("three reasoning levels: low, medium, and high") and the harmony
//   guide ("By default, the model will do medium level reasoning"); there is no off level. The offer
//   default is low (founder decision 2026-10-24): gpt-oss always reasons and thinking is not metered yet.
// - Qwen3: Qwen model cards, enable_thinking hard switch (on/off), mapped to off/high per GYB-DOC-028. The
//   vendor default is thinking on; the offer default is off because thinking is not metered yet and the
//   Ollama adapter runs Qwen3 with thinking disabled (GYB-DOC-028 decisions 4-5).
// - Gemma 4 26B A4B: Google model card, <|think|> system-prompt token turns thinking on or off, no graded
//   levels; mapped to off/high, default off as for Qwen3 (the card states no default).
// - Llama 3.3 70B Instruct: Meta model card, an instruction-tuned text model with no reasoning mode.
// - DeepSeek V4.1 Flash (effort 1-100), Kimi K3 (always thinking; low/high/max, default max) and GLM 5.3
//   Flash (low/high/max, default max) do not map one-to-one onto off/low/medium/high: null until decided.
const THINKING_SWITCH: ReasoningSupport = {
  levels: [REASONING_LEVELS.OFF, REASONING_LEVELS.HIGH],
  defaultReasoning: REASONING_LEVELS.OFF,
};
const GPT_OSS_EFFORT: ReasoningSupport = {
  levels: [
    REASONING_LEVELS.LOW,
    REASONING_LEVELS.MEDIUM,
    REASONING_LEVELS.HIGH,
  ],
  defaultReasoning: REASONING_LEVELS.LOW,
};
const NO_REASONING: ReasoningSupport = {
  levels: [REASONING_LEVELS.OFF],
  defaultReasoning: REASONING_LEVELS.OFF,
};

// The Qwen3 hybrid models share one public tokenizer and chat template: every member's tokenizer.json and
// tokenizer_config.json hash to this pair (Hugging Face, checked 2026-11-21), which the recount uses.
const QWEN3_TOKENIZER = {
  sha256: 'aeb13307a71acd8fe81861d94ad54ab689df773318809eed3cbe794b4492dae4',
  configSha256:
    'd5d09f07b48c3086c508b30d1c9114bd1189145b74e982a265350c923acd8101',
} as const;
const qwen3 = (size: string, revision: string): PublicTokenizer => ({
  repository: `Qwen/Qwen3-${size}`,
  revision,
  ...QWEN3_TOKENIZER,
});

// The shared catalog is the canonical source for model names, aliases and reasoning support.
export const MODEL_CATALOG: readonly Readonly<CatalogModel>[] = Object.freeze([
  entry(MODEL_IDS.QWEN3_30B_A3B, {
    // Ollama's bare qwen3:30b-a3b tag now points at the thinking-only 2507 build; the hybrid q4_K_M tag
    // keeps the on/off switch, so only it is an alias.
    aliases: ['qwen3:30b-a3b-q4_K_M'],
    tokenizer: qwen3('30B-A3B', 'ad44e777bcd18fa416d9da3bd8f70d33ebb85d39'),
    reasoning: THINKING_SWITCH,
  }),
  entry(MODEL_IDS.QWEN3_235B_A22B, {
    tokenizer: qwen3('235B-A22B', '8efa61729e24bd65b1d152b5ab5409052aa80e65'),
    reasoning: THINKING_SWITCH,
  }),
  entry(MODEL_IDS.DEEPSEEK_V4_1_FLASH),
  entry(MODEL_IDS.KIMI_K3),
  entry(MODEL_IDS.GLM_5_3_FLASH),
  entry(MODEL_IDS.GPT_OSS_120B, { reasoning: GPT_OSS_EFFORT }),
  entry(MODEL_IDS.GPT_OSS_20B, { reasoning: GPT_OSS_EFFORT }),
  entry(MODEL_IDS.LLAMA_3_3_70B, { reasoning: NO_REASONING }),
  entry(MODEL_IDS.GEMMA_4_26B, { reasoning: THINKING_SWITCH }),
  entry(MODEL_IDS.QWEN3_0_6B, {
    aliases: ['qwen3:0.6b'],
    tokenizer: qwen3('0.6B', 'c1899de289a04d12100db370d81485cdf75e47ca'),
    reasoning: THINKING_SWITCH,
  }),
  entry(MODEL_IDS.QWEN3_1_7B, {
    aliases: ['qwen3:1.7b'],
    tokenizer: qwen3('1.7B', '70d244cc86ccca08cf5af4e1e306ecf908b1ad5e'),
    reasoning: THINKING_SWITCH,
  }),
  entry(MODEL_IDS.QWEN3_4B, {
    // Ollama's bare qwen3:4b tag may name the 2507 build, which has another template; no alias.
    tokenizer: qwen3('4B', '1cfa9a7208912126459214e8b04321603b3df60c'),
    reasoning: THINKING_SWITCH,
  }),
  entry(MODEL_IDS.QWEN3_8B, {
    aliases: ['qwen3:8b'],
    tokenizer: qwen3('8B', 'b968826d9c46dd6066d109eabc6255188de91218'),
    reasoning: THINKING_SWITCH,
  }),
  entry(MODEL_IDS.QWEN3_14B, {
    aliases: ['qwen3:14b'],
    tokenizer: qwen3('14B', '40c069824f4251a91eefaf281ebe4c544efd3e18'),
    reasoning: THINKING_SWITCH,
  }),
  entry(MODEL_IDS.QWEN3_32B, {
    aliases: ['qwen3:32b'],
    tokenizer: qwen3('32B', '9216db5781bf21249d130ec9da846c4624c16137'),
    reasoning: THINKING_SWITCH,
  }),
]);

// A model whose catalog pin is the public tokenizer and template the recount uses: its usage is recounted
// exactly, whatever engine serves it. Any other model can only be sold on declared usage.
export function usesPinnedTokenizer(value: string): boolean {
  const resolved = resolveModel(value);
  return (
    resolved.kind === MODEL_CLASSIFICATIONS.CATALOG &&
    resolved.model.tokenizer?.sha256 === QWEN3_TOKENIZER.sha256 &&
    resolved.model.tokenizer.configSha256 === QWEN3_TOKENIZER.configSha256
  );
}

export function resolveModel(value: string): ModelResolution {
  const modelId = publicIdentifier(value);
  const model = MODEL_CATALOG.find(
    (entry) => entry.id === modelId || entry.aliases.includes(modelId),
  );
  return model
    ? { kind: MODEL_CLASSIFICATIONS.CATALOG, model }
    : { kind: MODEL_CLASSIFICATIONS.CUSTOM, modelId };
}
