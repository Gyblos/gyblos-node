import { execFileSync } from 'node:child_process';

import { wranglerLaunch } from '@gyblos/discovery-index/wrangler-d1';

import { runAnalytics } from './analytics-run';

process.exitCode = await runAnalytics({
  env: process.env,
  now: Date.now(),
  wrangler(args) {
    const launch = wranglerLaunch(process.platform, process.execPath, args);
    return execFileSync(launch.file, launch.args, {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    });
  },
  fetch: (url, init) => fetch(url, init),
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
});
