// Stages the fixed public build artifacts; operational configuration is never included.
import { cp } from 'node:fs/promises';
import { join } from 'node:path';

import { DESKTOP_ASSETS } from './constants';

export async function stageDesktopAssets(dist: string, stage: string) {
  for (const file of DESKTOP_ASSETS)
    await cp(join(dist, file), join(stage, file), { recursive: true });
}
