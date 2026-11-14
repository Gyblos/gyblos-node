// `pnpm buyer:agent <opencode|pi|codex|claude> [--write] [--context <tokens>] [--token-env <NAME>]`: prints
// the configuration that connects a coding agent to this buyer's local endpoint, with every model
// selection.json serves. With --write it updates the tool's own file (OpenCode, pi, Codex), changing only
// the gyblos provider and keeping a copy of the previous file beside it. Never reads role keys or tokens.
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';

import { LOCALHOST, PORTS } from '@gyblos/config';
import {
  AGENT_SETUP_CODES,
  AGENT_TOOLS,
  AgentSetupError,
  type AgentEndpoint,
  type AgentTool,
} from '@gyblos/node/agent-setup';
import { agentText, writeAgentFile } from '@gyblos/node/agent-setup-host';
import { isMain } from '@gyblos/runtime';

import { endpointRoutes } from './model-routes';
import { loadBuyerSelectionConfig } from './selection-config';

export { agentText, writeAgentFile } from '@gyblos/node/agent-setup-host';

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
      const { path, backup, profiles, removed } = await writeAgentFile(
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
      for (const profile of profiles ?? []) console.log(`Wrote ${profile}.`);
      for (const profile of removed ?? [])
        console.log(`Removed ${profile} (a model no longer served).`);
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
      ? 'That file has comments (or is opencode.jsonc), is not plain JSON, already defines gyblos outside the managed block, or a gyblos*.config.toml profile was not written by this command; print the configuration without --write and paste it yourself.'
      : 'Could not read the models from selection.json; run pnpm buyer:init first.';
  const { code, path } = error as NodeJS.ErrnoException;
  return code
    ? `Could not write ${path ?? 'the configuration'} (${code}).`
    : 'Could not prepare the configuration.';
}

if (isMain(import.meta.url)) await main();
