// Owns the initial shared model catalog, explicit case-sensitive aliases and each model's supported
// reasoning levels with the offer default.
// Catalog membership is naming metadata, never proof of weights, availability or audits.
import {
  MODEL_CLASSIFICATIONS,
  MODEL_IDS,
  REASONING_LEVELS,
  type CatalogModelId,
  type ReasoningLevel,
} from './constants.js';
import { publicIdentifier } from './public-validation.js';

export interface PublicTokenizer {
  repository: string;
  revision: string;
  sha256: string;
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

// Initial names: GYB-DOC-026 / web/src/content.ts. Future consumers use this source.
// Only the tiny tokenizer has a pre-existing pinned local-adapter reference.
export const MODEL_CATALOG: readonly Readonly<CatalogModel>[] = Object.freeze([
  entry(MODEL_IDS.QWEN3_30B_A3B, {
    // Ollama's bare qwen3:30b-a3b tag now points at the thinking-only 2507 build; the hybrid q4_K_M tag
    // keeps the on/off switch, so only it is an alias.
    aliases: ['qwen3:30b-a3b-q4_K_M'],
    reasoning: THINKING_SWITCH,
  }),
  entry(MODEL_IDS.QWEN3_235B_A22B, { reasoning: THINKING_SWITCH }),
  entry(MODEL_IDS.DEEPSEEK_V4_1_FLASH),
  entry(MODEL_IDS.KIMI_K3),
  entry(MODEL_IDS.GLM_5_3_FLASH),
  entry(MODEL_IDS.GPT_OSS_120B, { reasoning: GPT_OSS_EFFORT }),
  entry(MODEL_IDS.GPT_OSS_20B, { reasoning: GPT_OSS_EFFORT }),
  entry(MODEL_IDS.LLAMA_3_3_70B, { reasoning: NO_REASONING }),
  entry(MODEL_IDS.GEMMA_4_26B, { reasoning: THINKING_SWITCH }),
  entry(MODEL_IDS.QWEN3_0_6B, {
    aliases: ['qwen3:0.6b'],
    tokenizer: {
      repository: 'Qwen/Qwen3-0.6B',
      revision: 'c1899de289a04d12100db370d81485cdf75e47ca',
      sha256:
        'aeb13307a71acd8fe81861d94ad54ab689df773318809eed3cbe794b4492dae4',
    },
    reasoning: THINKING_SWITCH,
  }),
]);

export function resolveModel(value: string): ModelResolution {
  const modelId = publicIdentifier(value);
  const model = MODEL_CATALOG.find(
    (entry) => entry.id === modelId || entry.aliases.includes(modelId),
  );
  return model
    ? { kind: MODEL_CLASSIFICATIONS.CATALOG, model }
    : { kind: MODEL_CLASSIFICATIONS.CUSTOM, modelId };
}
