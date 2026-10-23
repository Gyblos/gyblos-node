// Fail-closed guard for the local home: a missing home directory next to an existing legacy path stops
// setup and startup. Uses lstat existence checks only; never reads, lists, moves or migrates legacy data.
import { lstat } from 'node:fs/promises';

import {
  homeLayout,
  LEGACY_LOCAL_PATHS,
  type HomeEnvironment,
  type HomeRole,
} from '@gyblos/config';

import { NODE_ERROR_CODES } from './constants.js';
import { NodeError } from './errors.js';

export const LEGACY_LAYOUT_GUIDE = 'docs/running-a-node.md#local-home';

export class LegacyLayoutError extends NodeError {
  constructor(
    readonly legacyPath: string,
    readonly homePath: string,
  ) {
    super(NODE_ERROR_CODES.LEGACY_LOCAL_LAYOUT);
    this.name = 'LegacyLayoutError';
    this.message = `${NODE_ERROR_CODES.LEGACY_LOCAL_LAYOUT}: ${legacyPath} exists but ${homePath} does not. Move it manually (see ${LEGACY_LAYOUT_GUIDE}); nothing was migrated.`;
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
