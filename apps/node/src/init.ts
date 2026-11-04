// Renders the gyblos.toml that `gyblos seller init` writes: one free devnet offer. Values are written as
// TOML basic strings through JSON escaping (a subset TOML accepts); the caller validates the result with
// the same parser node:start uses, so anything the parser refuses is never written.
import {
  MODEL_CLASSIFICATIONS,
  type EngineKind,
} from '@gyblos/protocol/constants';
import { resolveModel } from '@gyblos/protocol/models';

export interface InitAnswers {
  engine: EngineKind;
  url: string;
  model: string;
  // Remote engines only; the parser requires context_tokens for them and refuses it for Ollama.
  upstreamModel?: string;
  contextTokens?: number;
  apiKeyEnv?: string;
  dailyTokenCap: number;
  perBuyerCap: number;
  publish: boolean;
}

const quote = (value: string) => JSON.stringify(value);

function engineTable(answers: InitAnswers) {
  const fields = [
    `kind = ${quote(answers.engine)}`,
    `url = ${quote(answers.url)}`,
  ];
  if (answers.apiKeyEnv)
    fields.push(`api_key_env = ${quote(answers.apiKeyEnv)}`);
  if (answers.upstreamModel)
    fields.push(`upstream_model = ${quote(answers.upstreamModel)}`);
  if (answers.contextTokens !== undefined)
    fields.push(`context_tokens = ${answers.contextTokens}`);
  return `{ ${fields.join(', ')} }`;
}

// An identifier the catalog cannot even read is left for the parser to refuse.
function isCustom(model: string) {
  try {
    return resolveModel(model).kind === MODEL_CLASSIFICATIONS.CUSTOM;
  } catch {
    return false;
  }
}

// The name `ollama pull` knows: a catalog id is pulled by its first Ollama alias.
export function ollamaTag(model: string) {
  try {
    const resolved = resolveModel(model);
    if (
      resolved.kind === MODEL_CLASSIFICATIONS.CATALOG &&
      resolved.model.id === model
    )
      return resolved.model.aliases[0] ?? model;
  } catch {
    // Left as typed; the parser refuses it before anything is printed.
  }
  return model;
}

export function initToml(answers: InitAnswers) {
  const custom = isCustom(answers.model);
  return [
    '# Written by `gyblos seller init`. Check it with `pnpm gyblos doctor`; docs/configuration.md lists every key.',
    '',
    'version = 1',
    '',
    '[node]',
    'network = "devnet"',
    '',
    '[discovery]',
    `publish = ${answers.publish}`,
    '',
    '[[offers]]',
    `model = ${quote(answers.model)}`,
    ...(custom ? ['custom = true'] : []),
    `engine = ${engineTable(answers)}`,
    `free = { daily_token_cap = ${answers.dailyTokenCap}, per_buyer_cap = ${answers.perBuyerCap} }`,
    '',
  ].join('\n');
}
