// `pnpm buyer:agent <opencode|pi|codex|claude> [--write] [--context <tokens>] [--token-env <NAME>]`: prints
// the configuration that connects a coding agent to this buyer's local endpoint, with every model
// selection.json serves. With --write it updates the tool's own file (OpenCode, pi, Codex), changing only
// the gyblos provider and keeping a copy of the previous file beside it. Never reads role keys or tokens.
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';

import { FILE_MODES, LOCALHOST, PORTS } from '@gyblos/config';
import {
  AGENT_SETUP,
  AGENT_TOOLS,
  agentFilePath,
  AgentSetupError,
  claudeCodeEnvironment,
  codexBlock,
  mergedAgentFile,
  mergedCodexConfig,
  opencodeProvider,
  piProvider,
  type AgentEndpoint,
  type AgentTool,
} from '@gyblos/node/agent-setup';
import { AGENT_SETUP_CODES } from '@gyblos/node/constants';
import { isMain } from '@gyblos/runtime';

import { endpointRoutes } from './model-routes';
import { loadBuyerSelectionConfig } from './selection-config';

const USAGE =
  'Usage: pnpm buyer:agent <opencode|pi|codex|claude> [--write] [--context <tokens>] [--token-env <NAME>]';

export async function agentEndpoint(
  environment: NodeJS.ProcessEnv,
  options: { context?: number; tokenEnv?: string } = {},
): Promise<AgentEndpoint> {
  const config = await loadBuyerSelectionConfig(environment).catch(
    () => undefined,
  );
  if (!config) throw new AgentSetupError(AGENT_SETUP_CODES.ENDPOINT);
  return {
    origin: `http://${LOCALHOST}:${PORTS.buyerProxy}`,
    models: endpointRoutes({
      selection: config.request.selection,
      maxTokens: config.request.maxTokens,
      ...(config.models ? { models: config.models } : {}),
    }).map((route) => ({
      id: route.id,
      maxOutputTokens: route.maxTokens,
      ...(options.context ? { contextTokens: options.context } : {}),
    })),
    ...(options.tokenEnv ? { tokenEnv: options.tokenEnv } : {}),
  };
}

// What to print for a tool: its file's gyblos part, or the environment for one shell.
export function agentText(tool: AgentTool, endpoint: AgentEndpoint) {
  if (tool === AGENT_TOOLS.OPENCODE)
    return JSON.stringify(
      { provider: { [AGENT_SETUP.provider]: opencodeProvider(endpoint) } },
      null,
      2,
    );
  if (tool === AGENT_TOOLS.PI)
    return JSON.stringify(
      { providers: { [AGENT_SETUP.provider]: piProvider(endpoint) } },
      null,
      2,
    );
  if (tool === AGENT_TOOLS.CODEX) return codexBlock(endpoint);
  return claudeCodeEnvironment(endpoint);
}

async function existing(path: string) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

// Writes the tool's file, keeping the first copy of what was there as <file>.before-gyblos (later runs
// never replace it). The new text goes to a temporary file beside the real target and is renamed over it,
// so a crash never leaves half a file and a symlinked config stays a symlink.
export async function writeAgentFile(
  tool: Exclude<AgentTool, typeof AGENT_TOOLS.CLAUDE_CODE>,
  endpoint: AgentEndpoint,
  home: string,
  environment: NodeJS.ProcessEnv = {},
) {
  const path = agentFilePath(tool, home, environment);
  if (
    tool === AGENT_TOOLS.OPENCODE &&
    (await existing(`${path}c`)) !== undefined
  )
    throw new AgentSetupError(AGENT_SETUP_CODES.FILE); // opencode.jsonc: comments this command would drop
  const before = await existing(path);
  const text =
    tool === AGENT_TOOLS.CODEX
      ? mergedCodexConfig(endpoint, before)
      : mergedAgentFile(tool, endpoint, before);
  await mkdir(dirname(path), { recursive: true });
  const target = before === undefined ? path : await realpath(path);
  let saved = false;
  if (before !== undefined)
    saved = await copyFile(
      path,
      `${path}.before-gyblos`,
      constants.COPYFILE_EXCL,
    ).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'EEXIST') return false;
        throw error;
      },
    );
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, {
      flag: 'wx',
      mode: FILE_MODES.privateFile,
    });
    if (before !== undefined) await chmod(temporary, (await stat(target)).mode);
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
  return { path, backup: saved ? `${path}.before-gyblos` : undefined };
}

const NEXT: Record<AgentTool, string> = {
  opencode: 'In OpenCode, pick a gyblos model with /models.',
  pi: 'In pi, pick a gyblos model with /model.',
  codex:
    'Run `codex --profile gyblos`, or `codex --profile gyblos-<model>` for another model.',
  claude:
    'Run these in the shell where you start Claude Code; switch with /model <name>.',
};

export async function main(argv = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      write: { type: 'boolean' },
      context: { type: 'string' },
      'token-env': { type: 'string' },
    },
  });
  const tool = positionals[0] as AgentTool | undefined;
  const context =
    values.context === undefined ? undefined : Number(values.context);
  if (
    positionals.length !== 1 ||
    !Object.values(AGENT_TOOLS).includes(tool!) ||
    (context !== undefined && (!Number.isSafeInteger(context) || context < 1))
  ) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  try {
    const endpoint = await agentEndpoint(process.env, {
      ...(context ? { context } : {}),
      ...(values['token-env'] ? { tokenEnv: values['token-env'] } : {}),
    });
    if (values.write && tool === AGENT_TOOLS.CLAUDE_CODE)
      console.log('Claude Code reads these from your shell; nothing to write.');
    if (values.write && tool !== AGENT_TOOLS.CLAUDE_CODE) {
      const { path, backup } = await writeAgentFile(
        tool!,
        endpoint,
        homedir(),
        process.env,
      );
      console.log(
        backup
          ? `Updated ${path} (previous copy: ${backup}).`
          : `Updated ${path}.`,
      );
    } else console.log(agentText(tool!, endpoint));
    console.log(NEXT[tool!]);
  } catch (error) {
    console.error(failure(error));
    process.exitCode = 1;
  }
}

function failure(error: unknown) {
  if (error instanceof AgentSetupError)
    return error.code === AGENT_SETUP_CODES.FILE
      ? 'That file has comments (or is opencode.jsonc), is not plain JSON, or already defines gyblos outside the managed block; print the configuration without --write and paste it yourself.'
      : 'Could not read the models from selection.json; run pnpm buyer:init first.';
  const { code, path } = error as NodeJS.ErrnoException;
  return code
    ? `Could not write ${path ?? 'the configuration'} (${code}).`
    : 'Could not prepare the configuration.';
}

if (isMain(import.meta.url)) await main();
