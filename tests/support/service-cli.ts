// The fake operating system and CLI runner the `gyblos seller service` tests share.
import assert from 'node:assert/strict';
import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { runCli } from '@gyblos/node-app/cli';
import { type ServiceSystem } from '@gyblos/node-app/cli-service';

import { freeToml, withOllama, type Fixture } from './doctor-fixture';
import { FAKE_SECRET } from './node-config-fixtures';

export const RELAY_SECRET = `${FAKE_SECRET}-relay-token-value`;

export function fakeSystem(run: Fixture, platform: NodeJS.Platform = 'linux') {
  const commands: string[][] = [];
  const system: ServiceSystem = {
    platform,
    uid: process.getuid?.() ?? 1000,
    accountHome: join(run.root, 'account'),
    nodePath: '/opt/node24/bin/node',
    repository: join(run.root, 'repo'),
    run: async (argv) => {
      commands.push([...argv]);
      return 0;
    },
    windowsUser: async () => 'S-1-5-21-1-2-3-1001',
    stopWindowsService: async () => {
      commands.push(['stop-windows-service']);
      return true;
    },
    windowsTaskRunning: async () => false,
    launchAgentLoaded: async () => false,
  };
  return { system, commands };
}

export async function service(
  run: Fixture,
  args: string[],
  system: ServiceSystem,
  env: Record<string, string> = {},
) {
  let output = '';
  const code = await runCli(['seller', 'service', ...args], {
    env: { GYBLOS_HOME: run.home, ...env },
    cwd: run.root,
    stdout: (text) => {
      output += text;
    },
    stderr: (text) => {
      output += text;
    },
    doctor: { tokenizer: async () => undefined },
    service: system,
  });
  assert.equal(output.includes(RELAY_SECRET), false, output);
  return { code, output };
}

export async function readySeller(run: Fixture) {
  await withOllama(run);
  await writeFile(join(run.root, 'config.toml'), freeToml(run));
  const environment = join(run.home, 'seller.env');
  await writeFile(environment, `GYBLOS_RELAY_TOKEN=${RELAY_SECRET}\n`);
  await chmod(environment, 0o600);
  return environment;
}
