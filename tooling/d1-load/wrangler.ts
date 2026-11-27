import {
  execFileSync,
  type ExecFileSyncOptionsWithStringEncoding,
} from 'node:child_process';

import { wranglerLaunch } from '@gyblos/discovery-index/wrangler-d1';

import { D1_ANALYTICS } from './constants';

export interface WranglerRun {
  env: NodeJS.ProcessEnv;
  exec(
    file: string,
    args: readonly string[],
    options: ExecFileSyncOptionsWithStringEncoding,
  ): string;
}

const nodeRun: WranglerRun = {
  env: process.env,
  exec: (file, args, options) => execFileSync(file, [...args], options),
};

export function runWrangler(
  args: readonly string[],
  { env, exec }: WranglerRun = nodeRun,
): string {
  const launch = wranglerLaunch(process.platform, process.execPath, args);
  return exec(launch.file, launch.args, {
    env: {
      ...env,
      [D1_ANALYTICS.wranglerLogsEnv]: D1_ANALYTICS.wranglerLogsOff,
    },
    stdio: ['ignore', 'pipe', 'ignore'],
    encoding: 'utf8',
  });
}
