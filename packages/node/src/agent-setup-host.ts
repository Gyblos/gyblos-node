// Shared host-side coding-agent configuration output and atomic file publication.
// Hosts supply their own home/environment; token values and process startup never enter this module.
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
import { dirname } from 'node:path';

import { FILE_MODES } from '@gyblos/config';

import {
  AGENT_SETUP,
  AGENT_SETUP_CODES,
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
} from './agent-setup';

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
