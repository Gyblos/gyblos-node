// `gyblos seller init`: writes gyblos.toml with one free devnet offer, asking for each value on a terminal
// and taking flags or defaults otherwise. It writes the file node:start and doctor read (GYBLOS_CONFIG, else
// ./gyblos.toml), checks it with startup's own offer rules, never replaces one without --force, never
// follows a symlink, and handles no secret: API keys and the relay token stay in seller.env, so only their
// variable names appear.
import { createInterface, type Interface } from 'node:readline/promises';

import { NodeError } from '@gyblos/node/errors';
import { parseNodeConfig, type NodeConfig } from '@gyblos/node/node-config';
import { nodeConfigPath } from '@gyblos/node/node-config-file';
import { sellerSettings } from '@gyblos/node/seller-settings';
import { ENGINE_KINDS, type EngineKind } from '@gyblos/protocol/constants';

import { issueLine, urlOrigin } from './cli-format';
import {
  EXIT,
  INIT_DEFAULTS,
  INIT_ERRORS,
  type InitErrorCode,
} from './constants';
import { initToml, ollamaTag, type InitAnswers } from './init';
import { checkTarget, InitError, writeConfigFile } from './init-file';

// Answers a question typed at the terminal; rejects when the operator cancels.
export type Prompt = (question: string) => Promise<string>;

export interface InitOptions {
  engine?: string;
  url?: string;
  model?: string;
  upstreamModel?: string;
  contextTokens?: string;
  apiKeyEnv?: string;
  dailyCap?: string;
  perBuyerCap?: string;
  publish?: boolean;
  force: boolean;
}

interface InitOutput {
  env: Readonly<Record<string, string | undefined>>;
  cwd: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

// Typed for "no API key" (a local OpenAI-compatible server such as LM Studio).
const NO_KEY = 'none';
const YES = /^y(es)?$/i;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/;
// Stands in for the API key while startup's rules check the file; init never reads the real one.
const KEY_PRESENT = 'present';
const HINTS: Readonly<Record<InitErrorCode, string>> = {
  [INIT_ERRORS.MISSING_VALUE]:
    'pass it as a flag, or run on a terminal to be asked',
  [INIT_ERRORS.INVALID_ENGINE]: 'the engine is ollama, openai or anthropic',
  [INIT_ERRORS.INVALID_NUMBER]:
    'caps and context sizes are whole numbers above zero',
  [INIT_ERRORS.CONFIG_INVALID]:
    'node:start would refuse these values (docs/configuration.md#seller-startup); nothing was written',
  [INIT_ERRORS.FILE_EXISTS]:
    'the config file already exists; pass --force to replace it',
  [INIT_ERRORS.UNSAFE_PATH]:
    'the config path is a symlink or not a regular file; nothing was written',
  [INIT_ERRORS.WRITE_FAILED]:
    'could not write the config file; check the directory exists and is writable',
  [INIT_ERRORS.CANCELLED]: 'nothing was written',
};

const isEngine = (value: string): value is EngineKind =>
  (Object.values(ENGINE_KINDS) as string[]).includes(value);

function count(value: string, flag: string) {
  if (!POSITIVE_INTEGER.test(value) || !Number.isSafeInteger(Number(value)))
    throw new InitError(INIT_ERRORS.INVALID_NUMBER, flag);
  return Number(value);
}

// A flag wins; otherwise the terminal is asked with the default shown; otherwise the default is taken.
async function ask(
  prompt: Prompt | undefined,
  flag: string,
  question: string,
  given: string | undefined,
  fallback?: string,
) {
  if (given !== undefined) return given;
  const shown = fallback === undefined ? '' : ` [${fallback}]`;
  const answer = prompt ? (await prompt(`${question}${shown}: `)).trim() : '';
  const value = answer || fallback;
  if (!value) throw new InitError(INIT_ERRORS.MISSING_VALUE, flag);
  return value;
}

type RemoteAnswers = Pick<
  InitAnswers,
  'upstreamModel' | 'contextTokens' | 'apiKeyEnv'
>;

// Remote APIs only: the provider's model name, its context window and the key's variable.
async function remoteAnswers(
  engine: EngineKind,
  model: string,
  options: InitOptions,
  prompt: Prompt | undefined,
): Promise<RemoteAnswers> {
  const upstreamModel = await ask(
    prompt,
    '--upstream-model',
    'Model name at the provider',
    options.upstreamModel,
    model,
  );
  const contextTokens = count(
    await ask(
      prompt,
      '--context-tokens',
      'Context window in tokens',
      options.contextTokens,
    ),
    '--context-tokens',
  );
  const apiKeyEnv = await ask(
    prompt,
    '--api-key-env',
    engine === ENGINE_KINDS.OPENAI
      ? `Variable holding the API key (${NO_KEY} for no key)`
      : 'Variable holding the API key',
    options.apiKeyEnv,
    engine === ENGINE_KINDS.OPENAI
      ? INIT_DEFAULTS.openaiKeyEnv
      : INIT_DEFAULTS.anthropicKeyEnv,
  );
  // Only an OpenAI-compatible server may run without a key; for Anthropic, startup refuses the offer.
  return {
    upstreamModel,
    contextTokens,
    ...(apiKeyEnv === NO_KEY && engine === ENGINE_KINDS.OPENAI
      ? {}
      : { apiKeyEnv }),
  };
}

async function freeAnswers(options: InitOptions, prompt: Prompt | undefined) {
  const dailyTokenCap = count(
    await ask(
      prompt,
      '--daily-cap',
      'Free tokens per day, all buyers',
      options.dailyCap,
      INIT_DEFAULTS.dailyTokenCap,
    ),
    '--daily-cap',
  );
  const perBuyerCap = count(
    await ask(
      prompt,
      '--per-buyer-cap',
      'Free tokens per buyer per day',
      options.perBuyerCap,
      INIT_DEFAULTS.perBuyerCap,
    ),
    '--per-buyer-cap',
  );
  const publish =
    options.publish ??
    (prompt
      ? YES.test(
          (
            await prompt(
              'List this seller in the public discovery index? [y/N]: ',
            )
          ).trim(),
        )
      : false);
  return { dailyTokenCap, perBuyerCap, publish };
}

async function answersFrom(
  options: InitOptions,
  prompt: Prompt | undefined,
): Promise<InitAnswers> {
  const engine = await ask(
    prompt,
    '--engine',
    'Engine (ollama, openai or anthropic)',
    options.engine,
    ENGINE_KINDS.OLLAMA,
  );
  if (!isEngine(engine))
    throw new InitError(INIT_ERRORS.INVALID_ENGINE, '--engine');
  const local = engine === ENGINE_KINDS.OLLAMA;
  const defaultUrl = local
    ? INIT_DEFAULTS.ollamaUrl
    : engine === ENGINE_KINDS.OPENAI
      ? INIT_DEFAULTS.openaiUrl
      : INIT_DEFAULTS.anthropicUrl;
  const url = await ask(prompt, '--url', 'Engine URL', options.url, defaultUrl);
  const model = await ask(
    prompt,
    '--model',
    'Model to offer',
    options.model,
    local ? INIT_DEFAULTS.ollamaModel : undefined,
  );
  const remote = local
    ? {}
    : await remoteAnswers(engine, model, options, prompt);
  return {
    engine,
    url,
    model,
    ...remote,
    ...(await freeAnswers(options, prompt)),
  };
}

// Startup's own offer rules (engine, model, URL and key variable), with the key stood in for.
function startupRefusal(config: NodeConfig, answers: InitAnswers) {
  try {
    sellerSettings(
      config,
      answers.apiKeyEnv ? { [answers.apiKeyEnv]: KEY_PRESENT } : {},
    );
    return undefined;
  } catch (error) {
    if (error instanceof NodeError) return error.code;
    throw error;
  }
}

function nextSteps(answers: InitAnswers) {
  const steps = [
    'Put GYBLOS_RELAY_TOKEN=<your token> in seller.env (mode 600); docs/running-a-node.md shows how.',
  ];
  if (answers.apiKeyEnv)
    steps.push(`Put ${answers.apiKeyEnv}=<your API key> in seller.env too.`);
  if (answers.engine === ENGINE_KINDS.OLLAMA)
    steps.push(
      `Pull the model into that Ollama: OLLAMA_HOST=${new URL(answers.url).host} ollama pull ${ollamaTag(answers.model)}`,
    );
  steps.push(
    'Run `pnpm gyblos doctor`, then `pnpm node:start` or `pnpm gyblos seller service install`.',
  );
  return steps.map((step, index) => `  ${index + 1}. ${step}\n`).join('');
}

export async function initCommand(
  options: InitOptions,
  output: InitOutput,
  prompt?: Prompt,
) {
  const { path } = nodeConfigPath(output.env, output.cwd);
  try {
    await checkTarget(path, options.force);
    let answers: InitAnswers;
    try {
      answers = await answersFrom(options, prompt);
    } catch (error) {
      if (error instanceof InitError) throw error;
      output.stderr(
        `${INIT_ERRORS.CANCELLED}: ${HINTS[INIT_ERRORS.CANCELLED]}\n`,
      );
      return EXIT.interrupted;
    }
    const text = initToml(answers);
    const parsed = parseNodeConfig(text);
    if (!parsed.ok) {
      for (const issue of parsed.issues) output.stderr(issueLine(issue));
      throw new InitError(INIT_ERRORS.CONFIG_INVALID);
    }
    const refusal = startupRefusal(parsed.config, answers);
    if (refusal) {
      output.stderr(`  ${refusal}\n`);
      throw new InitError(INIT_ERRORS.CONFIG_INVALID);
    }
    // Checked again: the file may have appeared or changed while the operator was answering.
    await checkTarget(path, options.force);
    await writeConfigFile(path, text, options.force);
    output.stdout(
      `Wrote ${path}: free offer ${answers.model} via ${answers.engine} ${urlOrigin(answers.url)}; discovery ${answers.publish ? 'on' : 'off'}\nNext:\n${nextSteps(answers)}`,
    );
    return EXIT.ok;
  } catch (error) {
    if (!(error instanceof InitError)) throw error;
    const subject = error.subject ? ` ${error.subject}` : '';
    output.stderr(`${error.code}${subject}: ${HINTS[error.code]}\n`);
    return EXIT.failure;
  }
}

// Questions on the controlling terminal; Ctrl-C or end of input cancels the pending one.
export function terminalPrompt() {
  let terminal: Interface | undefined;
  const cancel = new AbortController();
  return {
    prompt: (question: string) => {
      if (!terminal) {
        terminal = createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        terminal.on('SIGINT', () => cancel.abort());
        terminal.on('close', () => cancel.abort());
      }
      return terminal.question(question, { signal: cancel.signal });
    },
    close: () => terminal?.close(),
  };
}
