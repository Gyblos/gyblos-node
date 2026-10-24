// Owns a freshly allocated temporary acceptance home; never accepts an existing path or reads .local.
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FILE_MODES, homeLayout } from '@gyblos/config';

import { ACCEPTANCE } from './constants.js';

export async function createAcceptanceWorkspace() {
  const root = await mkdtemp(join(tmpdir(), ACCEPTANCE.temporaryPrefix));
  try {
    const environment = { GYBLOS_HOME: root, GYBLOS_LAB_HOME: root };
    const layout = homeLayout(environment);
    // Pre-existing temp role homes keep product legacy guards away from cwd-relative .local.
    for (const directory of [layout.roles.buyer, layout.roles.seller])
      await mkdir(directory, { mode: FILE_MODES.privateDirectory });
    return {
      root,
      environment,
      close: () => rm(root, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
export type AcceptanceWorkspace = Awaited<
  ReturnType<typeof createAcceptanceWorkspace>
>;
