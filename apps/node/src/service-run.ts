// `gyblos service-run --home <dir> --config <file>`: the Windows service's supervisor, which the scheduled
// task (service-windows.ts) starts at logon. Windows has no systemd or launchd to restart the seller,
// load its environment file, keep its log or stop it gracefully, so this does: it runs `gyblos start` as a
// child with seller.env, GYBLOS_HOME and GYBLOS_CONFIG, appends its output to service.log, restarts it after
// a failure (giving up after too many in a row, as systemd's start limit does), and on a `stop` request
// through its named pipe asks the daemon to stop like a first Ctrl-C, killing it only after the stop
// timeout. One supervisor per home: a second one finds the pipe taken and exits. The pipe's name carries a
// random secret kept in the private home, so no other account can take it first or connect to it.
import { fork, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { closeSync, openSync, writeSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';

import { homeLayout } from '@gyblos/config/home';
import { STOP_MESSAGE } from '@gyblos/runtime';

import { EXIT, SERVICE } from './constants';
import { readEnvironmentFile } from './service-environment';
import { pipeName, taskName } from './service-windows';

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

const SECRET = /^[0-9a-f]{32}$/;
// Resending the stop reaches a daemon still starting, which listens only once it has started.
const STOP_RESEND_MS = 2000;

// The supervisor's pipe for this home, from <home>/service-pipe; with `create`, the secret is made when
// missing (by `gyblos seller service install`). Undefined when there is none.
export async function servicePipe(home: string, create = false) {
  const file = join(home, SERVICE.pipeFile);
  try {
    const secret = (await readFile(file, 'utf8')).trim();
    return SECRET.test(secret) ? pipeName(secret) : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    if (!create) return undefined;
  }
  const secret = randomBytes(SERVICE.pipeSecretBytes).toString('hex');
  await writeFile(file, `${secret}\n`, { flag: 'wx', mode: SERVICE.logMode });
  return pipeName(secret);
}

export async function stopWindowsService(home: string) {
  const pipe = await servicePipe(home);
  return pipe ? requestStop(pipe) : false;
}

// Whether a supervisor answers on this home's pipe.
export async function windowsServiceRunning(home: string) {
  const pipe = await servicePipe(home).catch(() => undefined);
  if (!pipe) return false;
  return new Promise<boolean>((done) => {
    const socket = connect(pipe);
    socket.on('connect', () => {
      socket.destroy();
      done(true);
    });
    socket.on('error', () => done(false));
  });
}

// Resolves the child's exit code; a failed IPC send never turns into a rejection.
function exited(child: ChildProcess) {
  return new Promise<number | null>((done) => {
    child.on('error', () => undefined);
    child.once('exit', (code) => done(code));
  });
}

class Supervisor {
  private child: ChildProcess | undefined;
  private stopping = false;
  private finished = false;
  private readonly waiting: Socket[] = [];
  private readonly wake = new AbortController();

  constructor(
    private readonly log: (text: string) => void,
    private readonly start: () => ChildProcess,
  ) {}

  stop(socket: Socket) {
    // Once the supervisor has finished, nothing runs: answer at once.
    if (this.finished) {
      socket.end();
      return;
    }
    this.waiting.push(socket);
    if (this.stopping) return;
    this.stopping = true;
    this.log('stop requested');
    this.wake.abort();
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    const send = () => child.send(STOP_MESSAGE, () => undefined);
    send();
    const resend = setInterval(send, STOP_RESEND_MS);
    const kill = setTimeout(
      () => child.kill(),
      SERVICE.stopTimeoutSeconds * MILLISECONDS,
    );
    child.once('exit', () => {
      clearInterval(resend);
      clearTimeout(kill);
    });
  }

  // Runs the seller until it exits cleanly, is stopped, or fails too often; resolves the exit code.
  async run() {
    const failures: number[] = [];
    while (!this.stopping) {
      this.child = this.start();
      const code = await exited(this.child);
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
          `the seller failed ${failures.length} times; not restarting it until the next logon or \`schtasks /Run /TN ${taskName(homedir())}\``,
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
    this.finished = true;
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

function stopServer(server: Server, supervisor: Supervisor) {
  const sockets = new Set<Socket>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.setEncoding('utf8');
    let request = '';
    socket.on('data', (chunk: string) => {
      request += chunk;
      if (request.trim() === SERVICE.stopRequest) supervisor.stop(socket);
    });
    socket.on('error', () => undefined);
  });
  return () => {
    server.close();
    for (const socket of sockets) socket.destroy();
  };
}

export async function serviceRun(
  args: readonly string[],
  { program = process.argv[1]!, pipe }: ServiceRunOptions = {},
) {
  const { values } = parseArgs({
    args: [...args],
    options: { home: { type: 'string' }, config: { type: 'string' } },
  });
  if (!values.home || !values.config)
    throw new Error('service-run needs --home and --config');
  const layout = homeLayout({ GYBLOS_HOME: values.home });
  const log = openSync(layout.files.serviceLog, 'a', SERVICE.logMode);
  let open = true;
  const note = (text: string) => {
    if (open)
      writeSync(log, `${new Date().toISOString()} gyblos service: ${text}\n`);
  };
  try {
    const path = pipe ?? (await servicePipe(values.home));
    if (!path) {
      note('no service pipe in the home; run `gyblos seller service install`');
      return EXIT.failure;
    }
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
    const server = createServer();
    const close = stopServer(server, supervisor);
    if (!(await listen(server, path))) {
      note('already running for this home');
      return EXIT.ok;
    }
    note('started');
    const code = await supervisor.run();
    note('stopped');
    supervisor.finish();
    close();
    return code;
  } catch (error) {
    note(`could not run the seller: ${(error as Error).message}`);
    return EXIT.failure;
  } finally {
    open = false;
    closeSync(log);
  }
}
