// Owns an isolated loopback synthetic 8004 RPC; it never accepts an operator origin, key or home.
// In-memory fixture mutation is explicit; only the three product registry read methods are served.
import { createServer, type Server } from 'node:http';

import { HTTP_STATUS, LOCALHOST } from '@gyblos/config';
import { IDENTITY_RPC_LIMITS } from '@gyblos/identity/constants';

import { ACCEPTANCE_CODES } from './constants';
import {
  acceptanceAssert,
  AcceptanceError,
  assertAcceptanceActive,
} from './errors';
import {
  registryClaim,
  type RegistryClaim,
  type RegistrySubject,
} from './identity-registry-accounts';
import { REGISTRY_FIXTURE } from './identity-registry-constants';
import {
  registryMethodAllowed,
  registryReadCall,
  registryReadResult,
} from './identity-registry-rpc';

function listen(server: Server, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      server.removeListener('listening', listening);
      server.removeListener('error', failed);
      signal.removeEventListener('abort', aborted);
    };
    const listening = () => {
      cleanup();
      resolve();
    };
    const failed = () => {
      cleanup();
      reject(new AcceptanceError(ACCEPTANCE_CODES.FAILED));
    };
    const aborted = () => {
      cleanup();
      reject(new AcceptanceError(ACCEPTANCE_CODES.CANCELLED));
    };
    server.once('listening', listening);
    server.once('error', failed);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
    else server.listen(0, LOCALHOST);
  });
}
export async function createAcceptanceRegistry(signal: AbortSignal) {
  assertAcceptanceActive(signal);
  let claims: RegistryClaim[] = [];
  let available = true;
  let oversized = false;
  let reads = 0;
  let forbidden = 0;
  let closing: Promise<void> | undefined;
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/') {
      forbidden++;
      response.writeHead(HTTP_STATUS.badRequest).end();
      return;
    }
    void registryReadCall(request)
      .then((call) => {
        if (!registryMethodAllowed(call.method)) {
          forbidden++;
          response.writeHead(HTTP_STATUS.badRequest).end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: call.id,
              error: {
                code: REGISTRY_FIXTURE.rpcInvalidMethod,
                message: 'Method unavailable',
              },
            }),
          );
          return;
        }
        reads++;
        if (!available) {
          response.writeHead(HTTP_STATUS.serviceUnavailable).end();
          return;
        }
        const result = registryReadResult(
          call,
          claims.flatMap((claim) => claim.accounts),
          oversized,
        );
        const padding =
          oversized && call.method === 'getProgramAccounts'
            ? ' '.repeat(IDENTITY_RPC_LIMITS.maxResponseBytes + 1)
            : '';
        response
          .writeHead(HTTP_STATUS.ok, { 'content-type': 'application/json' })
          .end(
            JSON.stringify({ jsonrpc: '2.0', id: call.id, result }) + padding,
          );
      })
      .catch(() => {
        if (!response.destroyed)
          response.writeHead(HTTP_STATUS.badRequest).end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: null,
              error: {
                code: REGISTRY_FIXTURE.rpcInvalidRequest,
                message: 'Invalid request',
              },
            }),
          );
      });
  });
  server.requestTimeout = REGISTRY_FIXTURE.requestMs;
  server.headersTimeout = REGISTRY_FIXTURE.requestMs;
  const close = () => {
    if (!closing) {
      signal.removeEventListener('abort', abort);
      server.closeAllConnections();
      closing = new Promise<void>((resolve) => server.close(() => resolve()));
    }
    return closing;
  };
  const abort = () => {
    void close();
  };
  try {
    await listen(server, signal);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) {
      await close();
      assertAcceptanceActive(signal);
    }
    const location = server.address();
    acceptanceAssert(location && typeof location !== 'string');
    return {
      url: `http://${LOCALHOST}:${location.port}`,
      async bind(subject: RegistrySubject, sequence: bigint) {
        assertAcceptanceActive(signal);
        acceptanceAssert(
          !closing && claims.length < REGISTRY_FIXTURE.maxBindings,
        );
        const claim = await registryClaim(subject, sequence);
        assertAcceptanceActive(signal);
        acceptanceAssert(
          !closing && claims.length < REGISTRY_FIXTURE.maxBindings,
        );
        claims.push(claim);
      },
      revoke(nodeId: string) {
        claims = claims.filter((claim) => claim.nodeId !== nodeId);
      },
      rollback(nodeId: string, sequence: bigint) {
        claims = claims.filter(
          (claim) => claim.nodeId !== nodeId || claim.sequence <= sequence,
        );
      },
      available(value: boolean) {
        available = value;
      },
      oversized(value: boolean) {
        oversized = value;
      },
      counts: () => ({ reads, forbidden }),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
export type AcceptanceRegistry = Awaited<
  ReturnType<typeof createAcceptanceRegistry>
>;
