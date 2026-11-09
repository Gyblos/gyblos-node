// Owns one buyer utility until actual exit; never auto-restarts it or clears financial locks.
import {
  BUYER_RELAY_ONLY_ENV,
  ENVIRONMENT_SWITCH,
  NODE_ENVIRONMENT,
} from '@gyblos/config';
import { BUYER_SIDECAR } from '@gyblos/protocol/buyer-api';

import { DESKTOP_X402 } from './x402/constants';

export function buyerEnvironment(
  home: string,
  relayToken: string,
  environment: Readonly<NodeJS.ProcessEnv>,
) {
  if (
    environment.GYBLOS_RELAYS &&
    (environment.GYBLOS_RELAYS.length > DESKTOP_X402.MAX_RELAYS_LENGTH ||
      /[\r\n]/.test(environment.GYBLOS_RELAYS))
  )
    throw new Error('Invalid relay configuration');
  const relayOnly = environment[BUYER_RELAY_ONLY_ENV];
  if (
    relayOnly !== undefined &&
    relayOnly !== ENVIRONMENT_SWITCH.off &&
    relayOnly !== ENVIRONMENT_SWITCH.on
  )
    throw new Error('Invalid relay mode');
  const addresses: NodeJS.ProcessEnv = {};
  for (const key of [
    NODE_ENVIRONMENT.irohBind,
    NODE_ENVIRONMENT.irohExternalAddress,
  ]) {
    const value = environment[key];
    if (value !== undefined) {
      if (
        value.length > DESKTOP_X402.MAX_TRANSPORT_ADDRESS ||
        /[\r\n]/.test(value)
      )
        throw new Error('Invalid transport address');
      addresses[key] = value;
    }
  }
  return {
    ...(environment.PATH ? { PATH: environment.PATH } : {}),
    ...(environment.HOME ? { HOME: environment.HOME } : {}),
    ...(environment.TMPDIR ? { TMPDIR: environment.TMPDIR } : {}),
    ...(environment.GYBLOS_RELAYS
      ? { GYBLOS_RELAYS: environment.GYBLOS_RELAYS }
      : {}),
    ...(relayOnly !== undefined ? { [BUYER_RELAY_ONLY_ENV]: relayOnly } : {}),
    ...addresses,
    GYBLOS_HOME: home,
    GYBLOS_RELAY_TOKEN: relayToken,
  };
}

export interface BuyerWorker {
  on(event: 'spawn', callback: () => void): unknown;
  on(event: 'message', callback: (message: unknown) => void): unknown;
  on(event: 'exit', callback: (code: number) => void): unknown;
  postMessage(message: string): void;
  kill(): unknown;
}
interface Connection {
  url: string;
  token: string;
}
interface Running {
  exit: Promise<void>;
  stop(): void;
}
function supervise(
  worker: BuyerWorker,
  onExit: () => void,
  startMs: number,
  stopMs: number,
) {
  let spawned = false;
  let stopping = false;
  let exited = false;
  let accepted = false;
  let finish = () => {};
  let resolveReady = (_connection: Connection) => {};
  let rejectReady = (_reason: Error) => {};
  const exit = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const ready = new Promise<Connection>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const fail = () => {
    if (exited) return;
    rejectReady(new Error('Local buyer could not start'));
    worker.kill();
  };
  let timer = setTimeout(fail, startMs);
  const requestStop = () => {
    try {
      worker.postMessage(BUYER_SIDECAR.STOP);
    } catch {
      fail();
    }
  };
  worker.on('spawn', () => {
    spawned = true;
    if (stopping) requestStop();
  });
  worker.on('message', (message) => {
    if (exited || stopping || accepted) return;
    if (!message || typeof message !== 'object') {
      fail();
      return;
    }
    const value = message as Record<string, unknown>;
    if (
      value.kind !== BUYER_SIDECAR.READY ||
      typeof value.url !== 'string' ||
      typeof value.token !== 'string' ||
      value.url.length > DESKTOP_X402.MAX_ID ||
      value.token.length > DESKTOP_X402.MAX_TOKEN_LENGTH
    ) {
      fail();
      return;
    }
    accepted = true;
    clearTimeout(timer);
    resolveReady({ url: value.url, token: value.token });
  });
  worker.on('exit', () => {
    exited = true;
    clearTimeout(timer);
    rejectReady(new Error('Local buyer exited'));
    onExit();
    finish();
  });
  return {
    ready,
    exit,
    stop() {
      if (exited || stopping) return;
      stopping = true;
      clearTimeout(timer);
      rejectReady(new Error('Local buyer is stopping'));
      timer = setTimeout(fail, stopMs);
      if (spawned) requestStop();
    },
  };
}
export class ManagedBuyer {
  private running: Running | null = null;
  private closed = false;
  constructor(
    private readonly fork: (home: string, relayToken: string) => BuyerWorker,
    private readonly onExit: () => void,
    private readonly startMs: number = DESKTOP_X402.START_MS,
    private readonly stopMs: number = DESKTOP_X402.STOP_MS,
  ) {}
  async start(home: string, relayToken: string) {
    if (this.closed || this.running)
      throw new Error('A buyer is already running');
    const operation = supervise(
      this.fork(home, relayToken),
      () => {
        this.running = null;
        this.onExit();
      },
      this.startMs,
      this.stopMs,
    );
    this.running = operation;
    return operation.ready;
  }
  async close() {
    this.closed = true;
    await this.stop();
  }
  async stop() {
    const running = this.running;
    running?.stop();
    await running?.exit;
  }
}
