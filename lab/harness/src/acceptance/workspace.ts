// Owns a freshly allocated temporary acceptance home; never accepts an existing path or reads .local.
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import { FILE_MODES, homeLayout } from '@gyblos/config';

import { ACCEPTANCE, ACCEPTANCE_CODES } from './constants';
import { AcceptanceError } from './errors';

export function assertAcceptanceTempBase(value: string) {
  if (!isAbsolute(value) || resolve(value).split(/[\\/]/).includes('.local'))
    throw new AcceptanceError(ACCEPTANCE_CODES.UNSAFE_TEMP);
}

export async function createAcceptanceWorkspace() {
  assertAcceptanceTempBase(tmpdir());
  const base = await realpath(tmpdir());
  assertAcceptanceTempBase(base);
  const root = await mkdtemp(join(base, ACCEPTANCE.temporaryPrefix));
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
