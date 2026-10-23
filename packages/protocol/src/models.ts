// Owns the initial shared model catalog and explicit, case-sensitive aliases.
// Catalog membership is naming metadata, never proof of weights, availability or audits.
import {
  MODEL_CLASSIFICATIONS,
  MODEL_IDS,
  type CatalogModelId,
} from './constants.js';
import { publicIdentifier } from './public-validation.js';

export interface PublicTokenizer {
  repository: string;
  revision: string;
  sha256: string;
}

export interface CatalogModel {
  id: CatalogModelId;
  aliases: readonly string[];
  // Null means not verified from a primary model/license source in this catalog.
  openWeights: boolean | null;
  tokenizer: Readonly<PublicTokenizer> | null;
}

export type ModelResolution =
  | {
      kind: typeof MODEL_CLASSIFICATIONS.CATALOG;
      model: Readonly<CatalogModel>;
    }
  | { kind: typeof MODEL_CLASSIFICATIONS.CUSTOM; modelId: string };

function entry(
  id: CatalogModelId,
  aliases: string[] = [],
  tokenizer: PublicTokenizer | null = null,
): Readonly<CatalogModel> {
  return Object.freeze({
    id,
    aliases: Object.freeze(aliases),
    openWeights: null,
    tokenizer: tokenizer === null ? null : Object.freeze(tokenizer),
  });
}

// Initial names: GYB-DOC-026 / web/src/content.ts. Future consumers use this source.
// Only the tiny tokenizer has a pre-existing pinned local-adapter reference.
export const MODEL_CATALOG: readonly Readonly<CatalogModel>[] = Object.freeze([
  entry(MODEL_IDS.QWEN3_30B_A3B, ['qwen3:30b-a3b']),
  entry(MODEL_IDS.QWEN3_235B_A22B),
  entry(MODEL_IDS.DEEPSEEK_V4_1_FLASH),
  entry(MODEL_IDS.KIMI_K3),
  entry(MODEL_IDS.GLM_5_3_FLASH),
  entry(MODEL_IDS.GPT_OSS_120B),
  entry(MODEL_IDS.GPT_OSS_20B),
  entry(MODEL_IDS.LLAMA_3_3_70B),
  entry(MODEL_IDS.GEMMA_4_26B),
  entry(MODEL_IDS.QWEN3_0_6B, ['qwen3:0.6b'], {
    repository: 'Qwen/Qwen3-0.6B',
    revision: 'c1899de289a04d12100db370d81485cdf75e47ca',
    sha256: 'aeb13307a71acd8fe81861d94ad54ab689df773318809eed3cbe794b4492dae4',
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
