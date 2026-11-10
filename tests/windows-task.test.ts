// Owns the Windows service on real Windows with the release's packaged seller (GYBLOS_WINDOWS_PACKAGE, as in
// tests/windows-package.test.ts; skipped elsewhere): Task Scheduler accepts the task's XML, and the task's
// exact command line, conhost --headless running gyblos.cmd service-run, starts the supervisor, which
// answers on the account's pipe and stops when asked. CI's account is not logged on interactively, so the
// task itself is registered and removed, not started at a logon.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

import { SERVICE_KINDS } from '@gyblos/node-app/constants';
import { DEFAULT_MEMORY_MAX, servicePlan } from '@gyblos/node-app/service';
import {
  servicePipe,
  stopWindowsService,
  windowsServiceRunning,
} from '@gyblos/node-app/service-run';
import { userSid } from '@gyblos/runtime/windows-acl';

import { archiveName, nativeLayout, TAR } from '../tooling/native-build';

const run = promisify(execFile);
const PACKAGE = process.env.GYBLOS_WINDOWS_PACKAGE;
const VERSION = process.env.GYBLOS_WINDOWS_VERSION ?? '';
const TARGET = 'win32-x64';
const SYSTEM_ROOT = process.env.SystemRoot ?? 'C:\\Windows';
const skip = process.platform !== 'win32' || !PACKAGE || !VERSION;

void test(
  'windows: Task Scheduler accepts the task, and its command line runs a supervisor that stops on request',
  { skip, timeout: 120_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'gyblos-wintask-'));
    try {
      // A profile path with a space, as `C:\Users\Ana Perez`: cmd /s /c must keep each quoted path whole.
      const account = join(root, 'the account');
      const home = join(account, '.gyblos');
      const app = join(home, 'app');
      await mkdir(app, { recursive: true });
      await run(TAR, [
        '-xzf',
        join(PACKAGE!, archiveName(VERSION, TARGET)),
        '-C',
        app,
      ]);
      await symlink(
        join(app, `gyblos-${VERSION}-${TARGET}`),
        join(app, 'current'),
        'junction',
      );
      const plan = servicePlan({
        kind: SERVICE_KINDS.SCHEDULED_TASK,
        nodePath: process.execPath,
        repository: root,
        launcher: join(app, 'current', nativeLayout(TARGET).launcher),
        home,
        config: join(home, 'gyblos.toml'),
        environmentFile: join(home, 'seller.env'),
        logFile: join(home, 'service.log'),
        accountHome: account,
        uid: -1,
        windowsUser: await userSid(),
        memoryMax: DEFAULT_MEMORY_MAX,
        cpuQuota: '100%',
      });

      // Task Scheduler reads the XML as the CLI writes it: UTF-16 with a byte order mark.
      const file = join(root, 'task.xml');
      await writeFile(
        file,
        Buffer.concat([
          Buffer.from('\ufeff', 'utf16le'),
          Buffer.from(plan.contents, 'utf16le'),
        ]),
      );
      const name = `Gyblos\\Test-${process.pid}`;
      const schtasks = join(SYSTEM_ROOT, 'System32', 'schtasks.exe');
      await run(schtasks, ['/Create', '/TN', name, '/XML', file]);
      try {
        const { stdout } = await run(schtasks, ['/Query', '/TN', name, '/XML']);
        assert.ok(stdout.includes('service-run'));
      } finally {
        await run(schtasks, ['/Delete', '/TN', name, '/F']);
      }

      // `gyblos seller service install` writes the task's script and the pipe's secret before starting it.
      for (const extra of plan.extra ?? []) {
        await mkdir(dirname(extra.path), { recursive: true });
        await writeFile(extra.path, extra.contents);
      }
      await servicePipe(home, true);
      // The task's action, exactly as Task Scheduler would start it.
      const command = /<Command>(.*)<\/Command>/.exec(plan.contents)![1]!;
      const args = /<Arguments>(.*)<\/Arguments>/
        .exec(plan.contents)![1]!
        .replaceAll('&amp;', '&');
      const supervisor = spawn(
        command.replace('%SystemRoot%', SYSTEM_ROOT),
        [args],
        {
          cwd: home,
          env: { ...process.env, USERPROFILE: account },
          stdio: 'ignore',
          windowsVerbatimArguments: true,
        },
      );
      const exited = once(supervisor, 'exit');
      let running = false;
      for (let attempt = 0; attempt < 120 && !running; attempt++) {
        running = await windowsServiceRunning(home);
        if (!running) await delay(250);
      }
      assert.ok(
        running,
        `the supervisor never answered on its pipe: ${await readFile(join(home, 'service.log'), 'utf8').catch(() => 'no service.log')}`,
      );
      assert.equal(await stopWindowsService(home), true);
      await exited;
      assert.equal(await windowsServiceRunning(home), false);
      const log = await readFile(join(home, 'service.log'), 'utf8');
      for (const text of [
        'gyblos service: started',
        'gyblos service: stop requested',
        'gyblos service: stopped',
      ])
        assert.ok(log.includes(text), `${text}\n${log}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
