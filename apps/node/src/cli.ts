// The `gyblos` command: `config validate` checks gyblos.toml and the GYBLOS_* environment; `doctor` runs the
// seller's read-only startup preflight. Prints codes, key paths and environment variable names; never a
// value read from the environment, and URLs only as origins, because providers embed API keys in URL paths.
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

export interface CliContext {
  env: Readonly<Record<string, string | undefined>>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  // Defaults to the process working directory; tests inject a temporary one.
  cwd?: string;
  // Loopback and devnet probes for `doctor`; tests inject fakes.
  doctor?: DoctorProbes;
}

const EXIT = { ok: 0, failure: 1 } as const;
const USAGE =
  'Usage: gyblos config validate [--config <path>]\n       gyblos doctor [--online]   (reads GYBLOS_CONFIG or ./gyblos.toml, like node:start)\n';
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
      },
      allowPositionals: true,
    });
  } catch {
    return undefined;
  }
}

export async function runCli(args: readonly string[], context: CliContext) {
  const parsed = parseCommand(args);
  const [group, command, ...rest] = parsed?.positionals ?? [];
  // doctor reads exactly what node:start reads (GYBLOS_CONFIG or ./gyblos.toml), so it takes no --config.
  if (
    parsed &&
    group === 'doctor' &&
    command === undefined &&
    parsed.values.config === undefined
  ) {
    const ready = await doctor(
      {
        env: context.env,
        cwd: context.cwd ?? process.cwd(),
        online: parsed.values.online === true,
        probes: context.doctor,
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
    parsed.values.online !== undefined
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
  process.exitCode = await runCli(args, {
    env: process.env,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  });
}

if (isMain(import.meta.url)) await main();
