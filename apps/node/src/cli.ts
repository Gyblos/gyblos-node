// The `gyblos` command: `config validate` checks gyblos.toml and the GYBLOS_* environment; `doctor` runs the
// seller's read-only startup preflight, calling remote engines only with --online; `seller init` writes a
// starting gyblos.toml, `seller service` installs the background service and `seller status` reports it. Prints codes, key
// paths and environment variable names; never a value read from the environment, and URLs only as
// origins, because providers embed API keys in URL paths.
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import {
  NODE_CONFIG_FILENAME,
  NODE_CONFIG_SOURCES,
  NODE_SETTINGS,
  type NodeSettingKey,
} from '@gyblos/node/constants';
import { readNodeConfigFile, type NodeOffer } from '@gyblos/node/node-config';
import {
  resolveNodeConfig,
  type NodeSettings,
  type SettingOrigin,
} from '@gyblos/node/node-config-resolve';
import type { DoctorProbes } from '@gyblos/node/seller-doctor';
import { OFFER_PRICING_KINDS } from '@gyblos/protocol/constants';
import { isMain } from '@gyblos/runtime';

import { doctor } from './cli-doctor';
import { COLUMN, issueLine, URL_HIDDEN, urlOrigin } from './cli-format';
import { initCommand, terminalPrompt, type Prompt } from './cli-init';
import { serviceCommand, type ServiceSystem } from './cli-service';
import { statusCommand, type StatusSystem } from './cli-status';
import { EXIT } from './constants';

export interface CliContext {
  env: Readonly<Record<string, string | undefined>>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  // Defaults to the process working directory; tests inject a temporary one.
  cwd?: string;
  // Loopback and devnet probes for `doctor`; tests inject fakes.
  doctor?: DoctorProbes;
  // The operating system for `seller service`; tests inject a fake.
  service?: ServiceSystem;
  // Terminal questions for `seller init`; without one it takes flags and defaults only.
  prompt?: Prompt;
  // The service manager, index and clock for `seller status`; tests inject fakes.
  status?: StatusSystem;
}

const USAGE =
  'Usage: gyblos config validate [--config <path>]\n       gyblos doctor [--online]   (reads GYBLOS_CONFIG or ./gyblos.toml, like node:start; --online also calls remote engines)\n       gyblos seller service install [--memory 3G] [--cpu 100%] [--dry-run]   (as the seller account, never root)\n       gyblos seller service uninstall [--dry-run]\n       gyblos seller init [--engine ollama|openai|anthropic] [--url <url>] [--model <id>] [--upstream-model <name>] [--context-tokens <n>] [--api-key-env <NAME>|none] [--daily-cap <n>] [--per-buyer-cap <n>] [--publish|--no-publish] [--force]\n       gyblos seller status [--online]   (--online also looks the seller up in the discovery index)\n';
// `seller init`'s flags, declared once for parsing and for refusing them on other commands.
const INIT_OPTIONS = {
  engine: { type: 'string' },
  url: { type: 'string' },
  model: { type: 'string' },
  'upstream-model': { type: 'string' },
  'context-tokens': { type: 'string' },
  'api-key-env': { type: 'string' },
  'daily-cap': { type: 'string' },
  'per-buyer-cap': { type: 'string' },
  publish: { type: 'boolean' },
  'no-publish': { type: 'boolean' },
  force: { type: 'boolean' },
} as const;
const INIT_FLAG_NAMES = Object.keys(
  INIT_OPTIONS,
) as (keyof typeof INIT_OPTIONS)[];
const URL_SETTINGS: ReadonlySet<NodeSettingKey> = new Set([
  NODE_SETTINGS.RPC_URL,
  NODE_SETTINGS.RELAY_URLS,
  NODE_SETTINGS.DISCOVERY_URL,
]);

function describeValue(
  setting: NodeSettingKey,
  value: NodeSettings[keyof NodeSettings],
) {
  if (value === undefined) return '(unset)';
  if (URL_SETTINGS.has(setting)) {
    if (typeof value === 'string') return urlOrigin(value);
    if (Array.isArray(value))
      return value
        .map((item) =>
          typeof item === 'string' ? urlOrigin(item) : URL_HIDDEN,
        )
        .join(', ');
  }
  if (!Array.isArray(value)) return String(value);
  return value.every((item) => typeof item === 'string')
    ? value.join(', ')
    : `${value.length} item(s)`;
}

// Values that came from the environment are never printed, only the variable that supplied them.
function settingLine(settings: NodeSettings, origin: SettingOrigin) {
  const value =
    origin.source === NODE_CONFIG_SOURCES.ENV
      ? `<from ${origin.name}>`
      : describeValue(origin.setting, settings[origin.setting]);
  const source =
    origin.source === NODE_CONFIG_SOURCES.DEFAULT
      ? 'default'
      : `${origin.source} ${origin.name}`;
  return `  ${origin.setting.padEnd(COLUMN)} ${value}  (${source})\n`;
}

function offerLine(entry: NodeOffer, index: number) {
  const pricing =
    entry.pricing.kind === OFFER_PRICING_KINDS.PAID
      ? `${entry.pricing.inputPerMtok} in / ${entry.pricing.outputPerMtok} out ${entry.pricing.currency} per Mtok`
      : `free, ${entry.pricing.dailyTokenCap} tokens/day, ${entry.pricing.perBuyerCap} per buyer`;
  return `  [${index}] ${entry.model.id} (${entry.model.kind}) via ${entry.engine.kind} ${urlOrigin(entry.engine.url)}; reasoning ${entry.reasoning.join(',')}; ${pricing}\n`;
}

async function validate(path: string, context: CliContext) {
  const parsed = await readNodeConfigFile(path);
  if (!parsed.ok) {
    context.stderr(`${path}: INVALID (${parsed.issues.length} issue(s))\n`);
    for (const issue of parsed.issues) context.stderr(issueLine(issue));
    return EXIT.failure;
  }
  const result = resolveNodeConfig({ file: parsed.config, env: context.env });
  for (const warning of [...parsed.warnings, ...result.warnings])
    context.stderr(`warning${issueLine(warning)}`);
  if (!result.ok) {
    context.stderr(
      `${path}: file OK, environment INVALID (${result.issues.length} issue(s))\n`,
    );
    for (const issue of result.issues) context.stderr(issueLine(issue));
    return EXIT.failure;
  }
  context.stdout(
    `${path}: OK (version ${parsed.config.version})\nEffective settings:\n`,
  );
  for (const origin of result.origins)
    context.stdout(settingLine(result.settings, origin));
  context.stdout(`Offers: ${result.settings.offers.length}\n`);
  result.settings.offers.forEach((entry, index) =>
    context.stdout(offerLine(entry, index)),
  );
  context.stdout('Secrets (environment variable names only):\n');
  for (const secret of result.secrets)
    context.stdout(
      `  ${secret.path.padEnd(COLUMN)} ${secret.env}  ${secret.present ? 'set' : 'not set'}\n`,
    );
  return EXIT.ok;
}

function parseCommand(args: readonly string[]) {
  try {
    return parseArgs({
      args: [...args],
      options: {
        config: { type: 'string' },
        online: { type: 'boolean' },
        memory: { type: 'string' },
        cpu: { type: 'string' },
        'dry-run': { type: 'boolean' },
        ...INIT_OPTIONS,
      },
      allowPositionals: true,
    });
  } catch {
    return undefined;
  }
}

type CommandValues = NonNullable<ReturnType<typeof parseCommand>>['values'];

// The service flags belong to `seller service` only.
const usesServiceFlags = (values: CommandValues) =>
  values.memory !== undefined ||
  values.cpu !== undefined ||
  values['dry-run'] !== undefined;

// The init flags belong to `seller init` only.
const usesInitFlags = (values: CommandValues) =>
  INIT_FLAG_NAMES.some((flag) => values[flag] !== undefined);

function runInit(values: CommandValues, context: CliContext) {
  return initCommand(
    {
      engine: values.engine,
      url: values.url,
      model: values.model,
      upstreamModel: values['upstream-model'],
      contextTokens: values['context-tokens'],
      apiKeyEnv: values['api-key-env'],
      dailyCap: values['daily-cap'],
      perBuyerCap: values['per-buyer-cap'],
      publish: values.publish ?? (values['no-publish'] ? false : undefined),
      force: values.force === true,
    },
    {
      env: context.env,
      cwd: context.cwd ?? process.cwd(),
      stdout: context.stdout,
      stderr: context.stderr,
    },
    context.prompt,
  );
}

function runService(
  command: string | undefined,
  values: CommandValues,
  context: CliContext,
) {
  return serviceCommand(
    command,
    {
      memory: values.memory,
      cpu: values.cpu,
      dryRun: values['dry-run'] === true,
    },
    {
      env: context.env,
      cwd: context.cwd ?? process.cwd(),
      stdout: context.stdout,
      stderr: context.stderr,
      doctor: context.doctor,
    },
    context.service,
  );
}

function runStatus(online: boolean, context: CliContext) {
  return statusCommand(
    { online },
    {
      env: context.env,
      cwd: context.cwd ?? process.cwd(),
      stdout: context.stdout,
      stderr: context.stderr,
    },
    context.status,
  );
}

export async function runCli(args: readonly string[], context: CliContext) {
  const parsed = parseCommand(args);
  const [group, command, ...rest] = parsed?.positionals ?? [];
  if (
    parsed &&
    group === 'seller' &&
    command === 'init' &&
    rest.length === 0 &&
    parsed.values.config === undefined &&
    parsed.values.online === undefined &&
    !usesServiceFlags(parsed.values) &&
    !(parsed.values.publish && parsed.values['no-publish'])
  ) {
    return runInit(parsed.values, context);
  }
  if (
    parsed &&
    group === 'seller' &&
    command === 'status' &&
    rest.length === 0 &&
    parsed.values.config === undefined &&
    !usesServiceFlags(parsed.values) &&
    !usesInitFlags(parsed.values)
  )
    return runStatus(parsed.values.online === true, context);
  if (parsed && usesInitFlags(parsed.values)) {
    context.stderr(USAGE);
    return EXIT.failure;
  }
  if (
    parsed &&
    group === 'seller' &&
    command === 'service' &&
    rest.length === 1 &&
    parsed.values.config === undefined &&
    parsed.values.online === undefined
  ) {
    const code = await runService(rest[0], parsed.values, context);
    if (code !== undefined) return code;
  }
  // doctor reads exactly what node:start reads (GYBLOS_CONFIG or ./gyblos.toml), so it takes no --config.
  if (
    parsed &&
    group === 'doctor' &&
    command === undefined &&
    parsed.values.config === undefined &&
    !usesServiceFlags(parsed.values)
  ) {
    const ready = await doctor(
      {
        env: context.env,
        cwd: context.cwd ?? process.cwd(),
        probes: context.doctor,
        online: parsed.values.online === true,
      },
      context,
    );
    return ready ? EXIT.ok : EXIT.failure;
  }
  if (
    !parsed ||
    group !== 'config' ||
    command !== 'validate' ||
    rest.length ||
    parsed.values.online !== undefined ||
    usesServiceFlags(parsed.values)
  ) {
    context.stderr(USAGE);
    return EXIT.failure;
  }
  return validate(
    resolve(parsed.values.config ?? NODE_CONFIG_FILENAME),
    context,
  );
}

export async function main(args = process.argv.slice(2)) {
  // Questions only on a terminal; piped or scripted runs take flags and defaults.
  const terminal = process.stdin.isTTY ? terminalPrompt() : undefined;
  try {
    process.exitCode = await runCli(args, {
      env: process.env,
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text),
      prompt: terminal?.prompt,
    });
  } finally {
    terminal?.close();
  }
}

if (isMain(import.meta.url)) await main();
