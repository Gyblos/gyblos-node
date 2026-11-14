// Shared host-side coding-agent configuration output and atomic file publication.
// Hosts supply their own home/environment; token values and process startup never enter this module.
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { FILE_MODES } from '@gyblos/config';

import {
  AGENT_SETUP,
  AGENT_SETUP_CODES,
  AGENT_TOOLS,
  agentFilePath,
  AgentSetupError,
  claudeCodeEnvironment,
  codexBlock,
  codexProfiles,
  codexProfileText,
  mergedAgentFile,
  mergedCodexConfig,
  mergedCodexProfile,
  opencodeProvider,
  piProvider,
  type AgentEndpoint,
  type AgentTool,
} from './agent-setup';
import { CODEX_MARKS } from './agent-setup-constants';
import { withAgentSetupLock } from './agent-setup-lock';

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
  if (tool === AGENT_TOOLS.CODEX)
    return [
      `# config.toml\n${codexBlock(endpoint)}`,
      ...codexProfiles(endpoint).map(
        (profile) => `# ${profile.file}, beside it\n${profile.text}`,
      ),
    ].join('\n\n');
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
// never replace it). Codex also gets one profile per model; stale profiles keep unique recoverable
// backups, and an observed concurrent edit is restored without overwriting another save. All new text
// is prepared first, so a refused file leaves all of
// them as they were. Each file is replaced atomically, but not all of them together: a write failing
// midway (a full disk, a read-only directory) can leave some updated, and running it again finishes.
export async function writeAgentFile(
  tool: Exclude<AgentTool, typeof AGENT_TOOLS.CLAUDE_CODE>,
  endpoint: AgentEndpoint,
  home: string,
  environment: NodeJS.ProcessEnv = {},
) {
  if (tool !== AGENT_TOOLS.CODEX)
    return writeAgentFileUnlocked(tool, endpoint, home, environment);
  // Validate the endpoint before creating a tool directory or taking publication ownership.
  codexProfiles(endpoint);
  const path = agentFilePath(tool, home, environment);
  await mkdir(dirname(path), { recursive: true });
  return withAgentSetupLock(dirname(path), () =>
    writeAgentFileUnlocked(tool, endpoint, home, environment),
  );
}

async function writeAgentFileUnlocked(
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
  const profiles =
    tool === AGENT_TOOLS.CODEX
      ? await Promise.all(
          codexProfiles(endpoint).map(async (profile) => {
            const file = join(dirname(path), profile.file);
            const previous = await existing(file);
            return {
              file,
              previous,
              text: mergedCodexProfile(profile.text, previous),
            };
          }),
        )
      : [];
  await mkdir(dirname(path), { recursive: true });
  const backup = `${path}${AGENT_SETUP.backupSuffix}`;
  let saved = false;
  if (before !== undefined)
    saved = await copyFile(path, backup, constants.COPYFILE_EXCL).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'EEXIST') return false;
        throw error;
      },
    );
  await replaced(path, text, before);
  for (const profile of profiles)
    await replaced(profile.file, profile.text, profile.previous);
  const stale =
    tool === AGENT_TOOLS.CODEX
      ? await removeStaleProfiles(
          dirname(path),
          new Set(
            await Promise.all(
              profiles.map((profile) => realpath(profile.file)),
            ),
          ),
        )
      : { removed: [], backups: [] };
  return {
    path,
    backup: saved ? backup : undefined,
    ...(profiles.length
      ? { profiles: profiles.map((profile) => profile.file) }
      : {}),
    ...(stale.removed.length ? { removed: stale.removed } : {}),
    ...(stale.backups.length ? { profileBackups: stale.backups } : {}),
  };
}

// Profile files an earlier run wrote for models this endpoint no longer serves: a `codex --profile` on
// one would fail. Known edits and links are left alone; candidates are archived atomically before
// removal. An editor racing the earlier read cannot lose its bytes to an unchecked unlink.
function isUneditedProfile(text: string) {
  const marker = text.lastIndexOf(CODEX_MARKS.profileDigest);
  return marker > 0 && codexProfileText(text.slice(0, marker)) === text;
}

function isProfileFile(name: string) {
  const prefix = AGENT_SETUP.provider;
  const suffix = AGENT_SETUP.codexProfileSuffix;
  if (!name.startsWith(prefix) || !name.endsWith(suffix)) return false;
  const model = name.slice(prefix.length, -suffix.length);
  return model.length === 0 || /^-[A-Za-z0-9_-]+$/.test(model);
}
async function removeStaleProfiles(directory: string, kept: Set<string>) {
  const removed: string[] = [];
  const backups: string[] = [];
  for (const name of await readdir(directory)) {
    const file = join(directory, name);
    if (!isProfileFile(name)) continue;
    if (!(await lstat(file)).isFile()) continue;
    // Replacement follows an existing target: filesystem identity preserves its actual casing.
    if (kept.has(await realpath(file))) continue;
    let text: string;
    try {
      text = await readFile(file, 'utf8');
      mergedCodexProfile('', text);
      if (!isUneditedProfile(text)) continue;
    } catch {
      continue;
    }
    const archived = await archiveProfile(file, text);
    backups.push(archived.backup);
    if (archived.removed) removed.push(file);
  }
  return { removed, backups };
}

// Reserve a unique backup before moving the actual pathname, preserving even a racing editor's inode.
// Backups are retained; a detected edit is copied back only when no newer file occupies its old name.
async function archiveProfile(file: string, snapshot: string) {
  const backup = `${file}.${randomUUID()}${AGENT_SETUP.backupSuffix}`;
  const reservation = await open(backup, 'wx', FILE_MODES.privateFile);
  await reservation.close();
  try {
    await rename(file, backup);
  } catch (error) {
    await rm(backup, { force: true });
    throw error;
  }
  if ((await readFile(backup, 'utf8')) !== snapshot) {
    await copyFile(backup, file, constants.COPYFILE_EXCL).catch(
      (error: unknown) => {
        if (
          error instanceof Error &&
          'code' in error &&
          error.code === 'EEXIST'
        )
          return;
        throw error;
      },
    );
    return { backup, removed: false };
  }
  return { backup, removed: true };
}

// The new text goes to a temporary file beside the real target and is renamed over it, so a crash never
// leaves half a file and a symlinked config stays a symlink.
async function replaced(
  path: string,
  text: string,
  before: string | undefined,
) {
  const target = before === undefined ? path : await realpath(path);
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
}
