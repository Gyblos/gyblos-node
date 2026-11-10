// `gyblos service-run --home <dir> --config <file>`: the Windows service's supervisor, which the scheduled
// task (service-windows.ts) starts at logon. Windows has no systemd or launchd to restart the seller,
// load its environment file, keep its log or stop it gracefully, so this does: it runs `gyblos start` as a
// child with seller.env, GYBLOS_HOME and GYBLOS_CONFIG, appends its output to service.log, restarts it after
// a failure (giving up after too many in a row, as systemd's start limit does), and on a `stop` request
// through its named pipe asks the daemon to stop like a first Ctrl-C, killing it only after the stop
// timeout. One supervisor per account: a second one finds the pipe taken and exits.
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, openSync, writeSync } from 'node:fs';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { homedir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';

import { homeLayout } from '@gyblos/config/home';
import { STOP_MESSAGE } from '@gyblos/runtime';

import { EXIT, SERVICE } from './constants';
import { readEnvironmentFile } from './service-environment';
import { pipeName } from './service-windows';

const MILLISECONDS = 1000;

// Asks the supervisor on this pipe to stop the seller and waits until it has; false when none runs.
export function requestStop(
  pipe: string,
  timeoutMs = (SERVICE.stopTimeoutSeconds + SERVICE.restartSeconds) *
    MILLISECONDS,
) {
  return new Promise<boolean>((done, fail) => {
    const socket = connect(pipe);
    const timer = setTimeout(() => {
      socket.destroy();
      fail(new Error('the seller did not stop in time'));
    }, timeoutMs);
    socket.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (error.code === 'ENOENT') done(false);
      else fail(error);
    });
    socket.on('connect', () => socket.write(`${SERVICE.stopRequest}\n`));
    // The supervisor closes the connection once the seller has stopped.
    socket.on('close', (failed) => {
      clearTimeout(timer);
      if (!failed) done(true);
    });
    socket.resume();
  });
}

export const stopWindowsService = (accountHome: string) =>
  requestStop(pipeName(accountHome));

// Whether a supervisor answers on this account's pipe.
export function windowsServiceRunning(accountHome: string) {
  return new Promise<boolean>((done) => {
    const socket = connect(pipeName(accountHome));
    socket.on('connect', () => {
      socket.destroy();
      done(true);
    });
    socket.on('error', () => done(false));
  });
}

class Supervisor {
  private child: ChildProcess | undefined;
  private stopping = false;
  private readonly waiting: Socket[] = [];
  private readonly wake = new AbortController();

  constructor(
    private readonly log: (text: string) => void,
    private readonly start: () => ChildProcess,
  ) {}

  stop(socket?: Socket) {
    if (socket) this.waiting.push(socket);
    if (this.stopping) return;
    this.stopping = true;
    this.log('stop requested');
    this.wake.abort();
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    child.send(STOP_MESSAGE);
    setTimeout(
      () => child.kill(),
      SERVICE.stopTimeoutSeconds * MILLISECONDS,
    ).unref();
  }

  // Runs the seller until it exits cleanly, is stopped, or fails too often; resolves the exit code.
  async run() {
    const failures: number[] = [];
    while (!this.stopping) {
      this.child = this.start();
      const [code] = (await once(this.child, 'exit')) as [number | null];
      this.child = undefined;
      if (this.stopping) break;
      if (code === EXIT.ok) return EXIT.ok;
      const now = Date.now();
      failures.push(now);
      while (
        failures[0]! <
        now - SERVICE.startLimitIntervalSeconds * MILLISECONDS
      )
        failures.shift();
      if (failures.length >= SERVICE.startLimitBurst) {
        this.log(
          `the seller failed ${failures.length} times; not restarting it until the next logon or \`schtasks /Run /TN ${SERVICE.taskName}\``,
        );
        return EXIT.failure;
      }
      this.log(
        `the seller exited with ${code}; restarting in ${SERVICE.restartSeconds}s`,
      );
      await delay(SERVICE.restartSeconds * MILLISECONDS, undefined, {
        signal: this.wake.signal,
      }).catch(() => undefined);
    }
    return EXIT.ok;
  }

  finish() {
    for (const socket of this.waiting) socket.end();
  }
}

function listen(server: Server, path: string) {
  return new Promise<boolean>((done, fail) => {
    server.once('error', (error: NodeJS.ErrnoException) =>
      error.code === 'EADDRINUSE' ? done(false) : fail(error),
    );
    server.listen(path, () => done(true));
  });
}

export interface ServiceRunOptions {
  // The entry the child runs with `start`, and the pipe stop requests arrive on; tests replace both.
  program?: string;
  pipe?: string;
}

export async function serviceRun(
  args: readonly string[],
  {
    program = process.argv[1]!,
    pipe = pipeName(homedir()),
  }: ServiceRunOptions = {},
) {
  const { values } = parseArgs({
    args: [...args],
    options: { home: { type: 'string' }, config: { type: 'string' } },
  });
  if (!values.home || !values.config)
    throw new Error('service-run needs --home and --config');
  const layout = homeLayout({ GYBLOS_HOME: values.home });
  const log = openSync(layout.files.serviceLog, 'a', SERVICE.logMode);
  const note = (text: string) =>
    writeSync(log, `${new Date().toISOString()} gyblos service: ${text}\n`);
  try {
    const environment = await readEnvironmentFile(
      layout.files.sellerEnvironment,
    );
    const supervisor = new Supervisor(note, () =>
      fork(program, [SERVICE.start], {
        cwd: values.home,
        env: {
          ...process.env,
          ...environment,
          GYBLOS_HOME: values.home,
          GYBLOS_CONFIG: values.config,
        },
        // The packaged bundle needs no loader; the service never runs from a checkout.
        execArgv: [],
        stdio: ['ignore', log, log, 'ipc'],
        windowsHide: true,
      }),
    );
    const server = createServer((socket) => {
      socket.setEncoding('utf8');
      let request = '';
      socket.on('data', (chunk: string) => {
        request += chunk;
        if (request.trim() === SERVICE.stopRequest) supervisor.stop(socket);
      });
      socket.on('error', () => undefined);
    });
    if (!(await listen(server, pipe))) {
      note('already running for this account');
      return EXIT.ok;
    }
    note('started');
    const code = await supervisor.run();
    note('stopped');
    supervisor.finish();
    server.close();
    return code;
  } catch (error) {
    note(`could not run the seller: ${(error as Error).message}`);
    return EXIT.failure;
  } finally {
    closeSync(log);
  }
}
