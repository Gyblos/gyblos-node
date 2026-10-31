// Composes private storage and a loopback-only receiver; never starts a buyer, seller, payment or outbound connection.
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';

import { HTTP_STATUS, LOCALHOST } from '@gyblos/config';
import {
  createPrivateReceiptCollector,
  prepareCollectedReceipt,
} from '@gyblos/core/receipt-collector';
import { acceptLoopbackHost } from '@gyblos/runtime/loopback-host';
import {
  createRetainedReceiptStore,
  openRetainedReceiptStore,
} from '@gyblos/telemetry-file/retained-receipts';

import { collectorAccess } from './access';
import { LOCAL_COLLECTOR, LOCAL_COLLECTOR_CODES } from './constants';
import { collectorFail, LocalCollectorError } from './errors';
import { collectorBody, collectorFailure, collectorReply } from './http';
import { maintainCollector } from './maintenance';
import {
  collectorSettings,
  type CollectorOptions,
  type CollectorSettings,
} from './settings';

export type { CollectorOptions, CollectorPrincipal } from './settings';

type RetainedStore = Awaited<ReturnType<typeof createRetainedReceiptStore>>;
function handler(
  settings: ReturnType<typeof collectorSettings>,
  store: RetainedStore,
) {
  const access = collectorAccess(settings);
  const collector = createPrivateReceiptCollector(store);
  const pending = new Set<Promise<void>>();
  const controllers = new Set<AbortController>();
  let closed = false;
  let broken = false;
  const run = async (request: IncomingMessage, response: ServerResponse) => {
    const controller = new AbortController();
    let lease: ReturnType<typeof access.admit> | undefined;
    const timeout = setTimeout(() => {
      controller.abort();
      collectorFailure(
        request,
        response,
        new LocalCollectorError(LOCAL_COLLECTOR_CODES.TIMEOUT),
      );
      request.destroy();
    }, settings.requestMs);
    const cancel = () => {
      if (!response.writableEnded) controller.abort();
    };
    response.once('close', cancel);
    controllers.add(controller);
    try {
      if (closed || broken) return collectorFail(LOCAL_COLLECTOR_CODES.CLOSED);
      if (!acceptLoopbackHost(request, response)) return;
      if (pending.size >= LOCAL_COLLECTOR.active)
        return collectorFail(LOCAL_COLLECTOR_CODES.BUSY);
      lease = access.admit(request);
      if (request.method !== 'POST' || request.url !== LOCAL_COLLECTOR.route)
        return collectorFail(LOCAL_COLLECTOR_CODES.INVALID);
      const body = await collectorBody(request, controller.signal);
      const entry = await prepareCollectedReceipt(body);
      if (entry.receipt.buyer.record.buyerNodeId !== lease.buyerNodeId)
        return collectorFail(LOCAL_COLLECTOR_CODES.FORBIDDEN);
      const result = await collector.collect(body, controller.signal);
      if (!controller.signal.aborted) {
        collectorReply(request, response, HTTP_STATUS.ok, result);
      }
    } catch (error) {
      if (!controller.signal.aborted)
        collectorFailure(request, response, error);
    } finally {
      clearTimeout(timeout);
      response.removeListener('close', cancel);
      controllers.delete(controller);
      lease?.release();
    }
  };
  return {
    pending,
    dispatch(request: IncomingMessage, response: ServerResponse) {
      const task = run(request, response);
      pending.add(task);
      void task.then(
        () => pending.delete(task),
        () => {
          pending.delete(task);
          response.destroy();
        },
      );
    },
    stop() {
      closed = true;
      for (const controller of controllers) controller.abort();
    },
    broken() {
      broken = true;
    },
  };
}
async function listen(server: ReturnType<typeof createServer>, port: number) {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, LOCALHOST, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    return collectorFail(LOCAL_COLLECTOR_CODES.STORAGE);
  return address.port;
}
async function awaitCollectorClose(work: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new LocalCollectorError(LOCAL_COLLECTOR_CODES.TIMEOUT)),
          LOCAL_COLLECTOR.closeMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function serveLocalCollector(
  settings: CollectorSettings,
  store: RetainedStore,
) {
  const receiver = handler(settings, store);
  const server = createServer(
    {
      maxHeaderSize: LOCAL_COLLECTOR.headerBytes,
      headersTimeout: settings.requestMs,
      requestTimeout: settings.requestMs * 2,
      connectionsCheckingInterval: settings.requestMs,
    },
    receiver.dispatch,
  );
  server.maxConnections = LOCAL_COLLECTOR.connections;
  server.maxRequestsPerSocket = 1;
  server.setTimeout(settings.requestMs * 2, (socket) => socket.destroy());
  let sweeping = false;
  const timer = setInterval(() => {
    if (sweeping) return;
    sweeping = true;
    void maintainCollector(store)
      .catch(() => receiver.broken())
      .finally(() => {
        sweeping = false;
      });
  }, LOCAL_COLLECTOR.sweepMs);
  timer.unref();
  try {
    const port = await listen(server, settings.port);
    let closing: Promise<void> | undefined;
    return {
      url: `http://${LOCALHOST}:${port}${LOCAL_COLLECTOR.route}`,
      close() {
        closing ??= (async () => {
          clearInterval(timer);
          receiver.stop();
          const stopped = new Promise<void>((resolve) =>
            server.close(() => resolve()),
          );
          server.closeAllConnections();
          await Promise.allSettled([...receiver.pending]);
          await stopped;
          await store.close();
        })();
        return awaitCollectorClose(closing);
      },
    };
  } catch {
    clearInterval(timer);
    server.closeAllConnections();
    return collectorFail(LOCAL_COLLECTOR_CODES.STORAGE);
  }
}

export interface CollectorStorage {
  create: typeof createRetainedReceiptStore;
  open: typeof openRetainedReceiptStore;
}
export async function startLocalCollector(
  options: CollectorOptions,
  storage: CollectorStorage = {
    create: createRetainedReceiptStore,
    open: openRetainedReceiptStore,
  },
) {
  const settings = collectorSettings(options);
  const selected = {
    path: settings.path,
    retentionMs: settings.retentionMs,
    now: settings.now,
  };
  const store = await (settings.create
    ? storage.create(selected)
    : storage.open(selected));
  try {
    return await serveLocalCollector(settings, store);
  } catch {
    await store.close();
    return collectorFail(LOCAL_COLLECTOR_CODES.STORAGE);
  }
}
