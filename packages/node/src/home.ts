// Fail-closed guard for the local home: a missing home directory next to an existing legacy path stops
// setup and startup. Uses lstat existence checks only; never reads, lists, moves or migrates legacy data.
import { lstat } from 'node:fs/promises';

import {
  homeLayout,
  LEGACY_LOCAL_PATHS,
  type HomeEnvironment,
  type HomeRole,
} from '@gyblos/config';

import { NODE_ERROR_CODES } from './constants';
import { NodeError } from './errors';

export const LEGACY_LAYOUT_GUIDE = 'docs/running-a-node.md#local-home';

export class LegacyLayoutError extends NodeError {
  constructor(
    readonly legacyPath: string,
    readonly homePath: string,
    missing = 'does not',
  ) {
    super(NODE_ERROR_CODES.LEGACY_LOCAL_LAYOUT);
    this.name = 'LegacyLayoutError';
    this.message = `${NODE_ERROR_CODES.LEGACY_LOCAL_LAYOUT}: ${legacyPath} exists but ${homePath} ${missing}. Move it manually (see ${LEGACY_LAYOUT_GUIDE}); nothing was migrated.`;
  }
}

async function pathExists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw error;
  }
}

// Legacy paths are relative to the working directory, whatever GYBLOS_HOME says: an uncertain journal
// left there is just as unsafe to ignore when the new home is elsewhere.
export async function assertNoLegacyLayout(
  homePath: string,
  legacyPaths: readonly string[],
) {
  if (await pathExists(homePath)) return;
  for (const legacyPath of legacyPaths)
    if (await pathExists(legacyPath))
      throw new LegacyLayoutError(legacyPath, homePath);
}

// For a home whose directory other writers may create first (locks, scratch): the home counts as in use
// only once one of its state files exists, so an empty or lock-only directory cannot silence legacy state.
export async function assertNoLegacyState(
  homePath: string,
  statePaths: readonly string[],
  legacyPaths: readonly string[],
) {
  for (const statePath of statePaths) if (await pathExists(statePath)) return;
  for (const legacyPath of legacyPaths)
    if (await pathExists(legacyPath))
      throw new LegacyLayoutError(legacyPath, homePath, 'holds no lab state');
}

export function assertRoleHome(
  role: HomeRole,
  environment: HomeEnvironment = process.env,
) {
  return assertNoLegacyLayout(homeLayout(environment).roles[role], [
    LEGACY_LOCAL_PATHS.roles,
  ]);
}

export function assertTokenizerHome(
  environment: HomeEnvironment = process.env,
) {
  return assertNoLegacyLayout(homeLayout(environment).artifacts.tokenizer, [
    LEGACY_LOCAL_PATHS.tokenizer,
  ]);
}

export function assertOllamaModelsHome(
  environment: HomeEnvironment = process.env,
) {
  return assertNoLegacyLayout(homeLayout(environment).artifacts.ollamaModels, [
    LEGACY_LOCAL_PATHS.ollamaModels,
  ]);
}
