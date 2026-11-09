// Stages the fixed public build artifacts; operational configuration is never included.
import { cp } from 'node:fs/promises';
import { join } from 'node:path';

const DESKTOP_ASSETS = [
  'main.cjs',
  'preload.cjs',
  'worker.cjs',
  'node-worker.cjs',
  'renderer',
] as const;

export async function stageDesktopAssets(dist: string, stage: string) {
  for (const file of DESKTOP_ASSETS)
    await cp(join(dist, file), join(stage, file), { recursive: true });
}
