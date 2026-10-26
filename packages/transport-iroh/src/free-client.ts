// Executes one independently verified free quote against one authenticated seller.
// Tracks possible prompt transmission conservatively; never selects sellers or enables payments.
import type { Connection, Endpoint, EndpointAddr } from '@number0/iroh';

import { TRANSPORT_TIMEOUTS } from '@gyblos/config';
import { CONTROL_LIMITS, FREE_EXECUTION, FREE_EXECUTION_CODES, type FreeExecutionCode } from '@gyblos/protocol/constants';
import { FreeExecutionError, matchFreeExecutionResponse, verifyFreeExecutionRequest, type FreeExecutionRequest } from '@gyblos/protocol/free-execution';
import { encodeFreeExecutionRequest, FreeExecutionResponseReader } from '@gyblos/protocol/free-execution-framing';

import { HTTP_OVER_IROH, TRANSPORT_ROUTES } from './constants.js';
import type { ControlStream } from './control-io.js';
import { selectedRoute } from './paths.js';

export class FreeClientError extends Error {
  constructor(readonly code: FreeExecutionCode, readonly sent: boolean, readonly remote = false) {
    super(code);
    this.name = 'FreeClientError';
  }
}
async function readResponse(stream: ControlStream, check: () => void) {
  const reader = new FreeExecutionResponseReader();
  const prefix = Uint8Array.from(await stream.recv.readExact(CONTROL_LIMITS.prefixBytes));
  check();
  reader.push(prefix);
  const size = new DataView(prefix.buffer).getUint32(0);
  reader.push(Uint8Array.from(await stream.recv.readExact(size)));
  check();
  if ((await stream.recv.read(1)).length) throw new FreeExecutionError(FREE_EXECUTION_CODES.INVALID);
  check();
  return reader.finish();
}
export function createFreeExecutionClient(
  endpoint: Pick<Endpoint, 'id' | 'connect'>,
  remote: EndpointAddr,
  trust: { owner: string; nodeId: string },
  options: { now?: () => number; requestMs?: number; relayOnly?: boolean } = {},
) {
  const now = options.now ?? Date.now;
  const identity = { ...trust };
  let used = false;
  let sent = false;
  let connection: Connection | undefined;
  const lifetime = new AbortController();
  const close = () => {
    lifetime.abort();
    connection?.close(HTTP_OVER_IROH.streamCloseCode, []);
    connection = undefined;
  };
  async function authenticate(value: unknown) {
    return verifyFreeExecutionRequest(value, {
      ...identity, remoteNodeId: endpoint.id().toString(), now: now(),
    });
  }
  async function run(request: FreeExecutionRequest, check: () => void) {
    const bytes = encodeFreeExecutionRequest(request);
    check();
    if (remote.id().toString() !== identity.nodeId) throw new FreeExecutionError(FREE_EXECUTION_CODES.PEER);
    const connected = await endpoint.connect(remote, [...Buffer.from(FREE_EXECUTION.alpn)]);
    if (lifetime.signal.aborted) {
      connected.close(HTTP_OVER_IROH.streamCloseCode, []);
      check();
    }
    connection = connected;
    const route = () => {
      check();
      if (connected.remoteId().toString() !== identity.nodeId ||
        (options.relayOnly && selectedRoute(connected) !== TRANSPORT_ROUTES.RELAY))
        throw new FreeExecutionError(FREE_EXECUTION_CODES.PEER);
    };
    route();
    await authenticate(request);
    route();
    const stream = await connected.openBi();
    route();
    // Opening a stream can take time; validate zero-skew expiry immediately before transmission.
    await authenticate(request);
    route();
    sent = true;
    await stream.send.writeAll([...bytes]);
    route();
    await stream.send.finish();
    route();
    const response = await readResponse(stream, route);
    const result = await matchFreeExecutionResponse(response, request);
    route();
    return result;
  }
  return {
    async execute(value: unknown, external?: AbortSignal) {
      if (used) throw new FreeClientError(FREE_EXECUTION_CODES.REPLAY, sent);
      used = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let abort = () => {};
      let reason: FreeExecutionCode = FREE_EXECUTION_CODES.CANCELLED;
      const check = () => {
        if (lifetime.signal.aborted) throw new FreeExecutionError(reason);
      };
      const cancelled = new Promise<never>((_resolve, reject) => {
        abort = () => {
          close();
          reject(new FreeClientError(reason, sent));
        };
        external?.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => { reason = FREE_EXECUTION_CODES.TIMEOUT; abort(); }, options.requestMs ?? TRANSPORT_TIMEOUTS.requestMs);
      });
      try {
        if (external?.aborted) abort();
        const operation = (async () => { check(); return run(await authenticate(value), check); })();
        return await Promise.race([operation, cancelled]);
      } catch (error) {
        if (error instanceof FreeClientError) throw error;
        throw new FreeClientError(error instanceof FreeExecutionError ? error.code : FREE_EXECUTION_CODES.INTERNAL, sent, error instanceof FreeExecutionError && error.remote);
      } finally {
        clearTimeout(timer);
        external?.removeEventListener('abort', abort);
        close();
      }
    },
    close,
  };
}
