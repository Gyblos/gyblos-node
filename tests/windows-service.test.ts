// Owns the seller's Windows service as far as it runs anywhere: the scheduled task's XML (the account's SID
// at logon, least privilege, no time limit, the launcher's `service-run` with no console window), the paths
// it refuses, seller.env as Notepad writes it, the daemon's stop over its IPC channel, and the supervisor:
// it runs the seller with seller.env, GYBLOS_HOME and GYBLOS_CONFIG, logs its output, stops it gracefully
// on a pipe request and refuses to run twice. On real Windows, tests/windows-package.test.ts registers the
// task and runs its exact command line.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

import { SERVICE_ERRORS, SERVICE_KINDS } from '@gyblos/node-app/constants';
import {
  DEFAULT_MEMORY_MAX,
  ServiceError,
  servicePlan,
  type ServiceInput,
} from '@gyblos/node-app/service';
import { parseEnvironmentFile } from '@gyblos/node-app/service-environment';
import {
  requestStop,
  servicePipe,
  serviceRun,
} from '@gyblos/node-app/service-run';
import { taskName } from '@gyblos/node-app/service-windows';
import { STOP_MESSAGE } from '@gyblos/runtime';

import { REPOSITORY_ROOT } from './support/node-config-fixtures';

const TASK = taskName('C:\\Users\\ana');
const SID = 'S-1-5-21-1004336348-1177238915-682003330-1001';
const INPUT: ServiceInput = {
  kind: SERVICE_KINDS.SCHEDULED_TASK,
  nodePath: 'C:\\unused\\node.exe',
  repository: 'C:\\unused',
  launcher: 'C:\\Users\\ana\\.gyblos\\app\\current\\bin\\gyblos.cmd',
  home: 'C:\\Users\\ana\\.gyblos',
  config: 'C:\\Users\\ana\\.gyblos\\gyblos.toml',
  environmentFile: 'C:\\Users\\ana\\.gyblos\\seller.env',
  logFile: 'C:\\Users\\ana\\.gyblos\\service.log',
  accountHome: 'C:\\Users\\ana',
  uid: -1,
  windowsUser: SID,
  memoryMax: DEFAULT_MEMORY_MAX,
  cpuQuota: '100%',
};

const refused = (input: ServiceInput, code: string) =>
  assert.throws(
    () => servicePlan(input),
    (error: unknown) => error instanceof ServiceError && error.code === code,
  );

void test('the scheduled task runs the launcher’s supervisor at the account’s logon, hidden and unprivileged', () => {
  const plan = servicePlan(INPUT);
  assert.equal(
    plan.path,
    'C:\\Users\\ana\\AppData\\Local\\Gyblos\\seller-task.xml',
  );
  assert.equal(plan.encoding, 'utf16le');
  assert.ok(
    plan.contents.startsWith('<?xml version="1.0" encoding="UTF-16"?>\r\n'),
  );
  for (const line of [
    `<Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${SID}</UserId></LogonTrigger></Triggers>`,
    `<Principal id="Author"><UserId>${SID}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal>`,
    '<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
    '<Command>%SystemRoot%\\System32\\conhost.exe</Command>',
    '<Arguments>--headless cmd.exe /d /s /c ""C:\\Users\\ana\\.gyblos\\app\\current\\bin\\gyblos.cmd" service-run --home "C:\\Users\\ana\\.gyblos" --config "C:\\Users\\ana\\.gyblos\\gyblos.toml""</Arguments>',
    '<WorkingDirectory>C:\\Users\\ana\\.gyblos</WorkingDirectory>',
  ])
    assert.ok(
      plan.contents.split('\r\n').some((text) => text.trim() === line),
      line,
    );
  assert.deepEqual(plan.enable, [
    [
      'schtasks.exe',
      '/Create',
      '/TN',
      TASK,
      '/XML',
      'C:\\Users\\ana\\AppData\\Local\\Gyblos\\seller-task.xml',
    ],
    ['schtasks.exe', '/Run', '/TN', TASK],
  ]);
  assert.deepEqual(plan.disable, [
    ['schtasks.exe', '/Delete', '/TN', TASK, '/F'],
  ]);
  assert.match(plan.notes[0]!, /log is C:\\Users\\ana\\.gyblos\\service\.log/);
});

void test('the scheduled task refuses paths Task Scheduler or cmd would misread, and a checkout', () => {
  for (const launcher of [
    'C:\\Users\\%USERNAME%\\gyblos.cmd',
    'C:\\Users\\a"b\\gyblos.cmd',
    'C:\\Users\\a&b\\gyblos.cmd',
    '/home/ana/gyblos.cmd',
    'gyblos.cmd',
  ])
    refused({ ...INPUT, launcher }, SERVICE_ERRORS.UNSAFE_PATH);
  refused(
    { ...INPUT, windowsUser: 'ana"/><Exec>' },
    SERVICE_ERRORS.UNSAFE_PATH,
  );
  const { launcher: _launcher, ...checkout } = INPUT;
  refused(checkout, SERVICE_ERRORS.PLATFORM_UNSUPPORTED);
});

void test('seller.env on Windows: a byte order mark and CRLF lines are read, names are reserved whatever their case', () => {
  assert.deepEqual(
    parseEnvironmentFile(
      '# relay\r\nGYBLOS_RELAY_TOKEN=abc\r\n\r\nOPENAI_API_KEY=k1\r\n',
      true,
    ),
    { GYBLOS_RELAY_TOKEN: 'abc', OPENAI_API_KEY: 'k1' },
  );
  for (const line of [
    'Path=C:/x',
    'gyblos_home=x',
    'node_options=--x',
    'SystemRoot=x',
    'PSModulePath=x',
  ])
    assert.throws(
      () => parseEnvironmentFile(`${line}\r\n`, true),
      (error: unknown) =>
        error instanceof ServiceError &&
        error.code === SERVICE_ERRORS.ENVIRONMENT_RESERVED,
      line,
    );
  // systemd and the launch agent's shell would read a carriage return differently.
  assert.throws(() => parseEnvironmentFile('A=b\r\n', false));
  assert.deepEqual(parseEnvironmentFile('Path=x\n', false), { Path: 'x' });
});

void test('tasks are per account, whatever the case of its home; the pipe name is a secret in the home', async () => {
  assert.equal(taskName('C:\\Users\\Ana'), taskName('c:\\users\\ana'));
  assert.notEqual(taskName('C:\\Users\\ana'), taskName('C:\\Users\\bob'));
  assert.match(TASK, /^Gyblos\\Seller-[0-9a-f]{16}$/);
  const home = await mkdtemp(join(tmpdir(), 'gyblos-pipe-'));
  try {
    assert.equal(await servicePipe(home), undefined);
    const pipe = await servicePipe(home, true);
    assert.match(pipe ?? '', /^\\\\\.\\pipe\\gyblos-seller-[0-9a-f]{32}$/);
    assert.equal(await servicePipe(home), pipe);
    assert.equal(await servicePipe(home, true), pipe);
    await writeFile(join(home, 'service-pipe'), 'not-a-secret\n');
    assert.equal(await servicePipe(home), undefined);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

void test(
  'the daemon’s shutdown signal answers a supervisor’s stop message, then lets the process exit',
  { timeout: 30_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'gyblos-stop-message-'));
    try {
      const child = join(root, 'daemon.mts');
      const runtime = pathToFileURL(
        join(REPOSITORY_ROOT, 'packages/runtime/src/process.ts'),
      ).href;
      await writeFile(
        child,
        `import { shutdownSignal } from ${JSON.stringify(runtime)};\nconst shutdown = shutdownSignal();\nprocess.send?.('ready');\nawait shutdown.signalled;\nshutdown.dispose();\nprocess.stdout.write('stopped\\n');\n`,
      );
      const daemon = fork(child, [], {
        execArgv: ['--import', 'tsx'],
        cwd: REPOSITORY_ROOT,
        stdio: ['ignore', 'pipe', 'inherit', 'ipc'],
      });
      let output = '';
      daemon.stdout!.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
      await once(daemon, 'message');
      daemon.send(STOP_MESSAGE);
      // It exits by itself: the channel no longer keeps it alive once the signal is disposed.
      const [code] = (await once(daemon, 'exit')) as [number];
      assert.equal(code, 0);
      assert.equal(output, 'stopped\n');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

async function waitFor(path: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      return await readFile(path, 'utf8');
    } catch {
      await delay(50);
    }
  }
  throw new Error(`${path} never appeared`);
}

void test(
  'the supervisor runs the seller with its environment and log, and stops it gracefully on request',
  { timeout: 60_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'gyblos-supervisor-'));
    try {
      const home = join(root, 'home');
      await mkdir(home, { mode: 0o700 });
      await writeFile(
        join(home, 'seller.env'),
        'GYBLOS_RELAY_TOKEN=test-relay-value\n',
        { mode: 0o600 },
      );
      const config = join(home, 'gyblos.toml');
      const program = join(root, 'seller.mjs');
      // A seller that records how it was started and stops on the supervisor's message, which it listens
      // for only after a startup of a few seconds, as the daemon does: the supervisor resends it.
      await writeFile(
        program,
        `import { appendFileSync } from 'node:fs';\nconst record = (text) => appendFileSync(${JSON.stringify(join(root, 'seller.txt'))}, text + '\\n');\nrecord([process.argv[2], process.env.GYBLOS_HOME, process.env.GYBLOS_CONFIG, process.env.GYBLOS_RELAY_TOKEN].join(' '));\nprocess.stdout.write('seller output\\n');\nsetTimeout(() => process.on('message', (message) => {\n  if (message === ${JSON.stringify(STOP_MESSAGE)}) { record('stopping'); process.exit(0); }\n}), 3000);\n`,
      );
      const pipe =
        process.platform === 'win32'
          ? `\\\\.\\pipe\\gyblos-test-${process.pid}`
          : join(root, 'service.sock');
      const args = ['--home', home, '--config', config];
      const running = serviceRun(args, { program, pipe });
      const started = await waitFor(join(root, 'seller.txt'));
      assert.equal(started, `start ${home} ${config} test-relay-value\n`);
      // A second supervisor for the same account leaves the first alone.
      assert.equal(await serviceRun(args, { program, pipe }), 0);
      assert.equal(await requestStop(pipe), true);
      assert.equal(await running, 0);
      assert.equal(
        await readFile(join(root, 'seller.txt'), 'utf8'),
        `${started}stopping\n`,
      );
      const log = await readFile(join(home, 'service.log'), 'utf8');
      for (const text of [
        'gyblos service: started',
        'gyblos service: already running for this home',
        'seller output',
        'gyblos service: stop requested',
        'gyblos service: stopped',
      ])
        assert.ok(log.includes(text), text);
      assert.ok(!log.includes('test-relay-value'));
      // Nothing answers once it has stopped.
      assert.equal(await requestStop(pipe), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
