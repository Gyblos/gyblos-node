// Cancellation retains admission for native control work already detached after a seller timeout.
// Signed in-memory streams and partial native SDK doubles avoid sockets, real homes and payment paths.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type {
  BiStream,
  Connection,
  Endpoint,
  EndpointAddr,
} from '@number0/iroh';

import { FREE_BUYER_CODES } from '@gyblos/buyer/constants';
import { executeBuyerFree } from '@gyblos/buyer/free-execution';
import { freeBuyerDependencies } from '@gyblos/buyer/free-selection';
import type { LocalSellerStats } from '@gyblos/buyer/selection-stats';
import { SELLER_BADGES } from '@gyblos/core/constants';
import { createSellerControlService } from '@gyblos/node/control';
import { CONTROL_LIMITS, FREE_CHAT_ROLES } from '@gyblos/protocol/constants';
import {
  ControlFrameReader,
  encodeControlFrame,
} from '@gyblos/protocol/control-framing';

import { controlFixture } from './support/control-fixture';

async function isolatedHome(context: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'buyer-cancel-settlement-'));
  const originalDirectory = process.cwd();
  const originalHome = process.env.GYBLOS_HOME;
  const originalLabHome = process.env.GYBLOS_LAB_HOME;
  process.chdir(directory);
  process.env.GYBLOS_HOME = join(directory, 'product');
  process.env.GYBLOS_LAB_HOME = join(directory, 'lab');
  context.after(async () => {
    process.chdir(originalDirectory);
    if (originalHome === undefined) delete process.env.GYBLOS_HOME;
    else process.env.GYBLOS_HOME = originalHome;
    if (originalLabHome === undefined) delete process.env.GYBLOS_LAB_HOME;
    else process.env.GYBLOS_LAB_HOME = originalLabHome;
    await rm(directory, { recursive: true, force: true });
  });
}

async function within<T>(operation: Promise<T>, milliseconds: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Synthetic test watchdog expired')),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function cancellationRig() {
  const source = await controlFixture(true);
  const service = createSellerControlService({
    context: source.context,
    ownerSigner: source.ownerSigner,
    nodeSigner: source.nodeSigner,
  });
  const {
    buyer,
    buyerNodeId,
    catalogDigest: _digest,
    ...request
  } = source.request.params;
  const dead = '3'.repeat(64);
  const healthy = {
    owner: source.catalog.owner,
    nodeId: source.catalog.nodeId,
    relayUrl: null,
    directAddresses: [],
  };
  const prepared = {
    config: {
      request: {
        ...request,
        lowestReasoning: null,
        minimumBadge: SELLER_BADGES.DECLARED_USAGE,
        retention: [source.catalog.dataPolicy.retention],
      },
      sellers: [healthy, { ...healthy, nodeId: dead }],
    },
    stats: {
      rows: new Map<string, LocalSellerStats>(),
      save: async () => {},
    },
    discovery: undefined,
  };
  let deadDials = 0;
  let deadCloses = 0;
  const releases: (() => void)[] = [];
  let announceQuote = () => {};
  const quoting = new Promise<void>((resolve) => {
    announceQuote = resolve;
  });
  function stream() {
    const reader = new ControlFrameReader();
    let response: Uint8Array = new Uint8Array();
    let offset = 0;
    const read = async (size: number) => {
      const bytes = [...response.subarray(offset, offset + size)];
      offset += bytes.length;
      return bytes;
    };
    return {
      send: {
        async writeAll(bytes: number[]) {
          reader.push(Uint8Array.from(bytes));
        },
        async finish() {
          response = encodeControlFrame(
            await service.respond(
              reader.finish(),
              buyerNodeId,
              new AbortController().signal,
            ),
            CONTROL_LIMITS.responseBytes,
          );
        },
      },
      recv: { readExact: read, read },
    } as unknown as BiStream;
  }
  const endpoint = {
    id: () => ({ toString: () => buyerNodeId }),
    async connect(remote: EndpointAddr) {
      if (remote.id().toString() === dead) {
        deadDials++;
        return new Promise<Connection>((resolve) => {
          releases.push(() =>
            resolve({
              close() {
                deadCloses++;
              },
            } as unknown as Connection),
          );
        });
      }
      let opens = 0;
      let closed = false;
      let rejectQuote = (_error: Error) => {};
      return {
        remoteId: () => ({ toString: () => healthy.nodeId }),
        closeReason: () => (closed ? 'Synthetic connection closed' : null),
        close() {
          closed = true;
          rejectQuote(new Error('Synthetic connection cancelled'));
        },
        async openBi() {
          opens++;
          if (opens !== 3) return stream();
          announceQuote();
          return new Promise<BiStream>((_resolve, reject) => {
            rejectQuote = reject;
          });
        },
      } as unknown as Connection;
    },
  } as unknown as Endpoint;
  return {
    prepared,
    quoting,
    dependencies: freeBuyerDependencies(prepared, {
      endpoint,
      buyer,
      relayOnly: false,
      now: source.context.now,
    }),
    dials: () => deadDials,
    closes: () => deadCloses,
    release: () => releases.forEach((release) => release()),
  };
}

void test('a caller abort after snapshot timeout retains free admission until the detached native dial settles', async (context) => {
  await isolatedHome(context);
  const host = await cancellationRig();
  const input = {
    messages: [{ role: FREE_CHAT_ROLES.USER, content: 'Synthetic request' }],
    maxTokens: 10,
  };
  const first = new AbortController();
  const second = new AbortController();
  let firstFinished = false;
  let secondBusy = false;
  const firstOperation = executeBuyerFree(
    input,
    host.dependencies,
    first.signal,
  ).then(
    () => {
      firstFinished = true;
    },
    () => {
      firstFinished = true;
    },
  );
  let secondOperation = Promise.resolve();
  try {
    // A has already missed the snapshot deadline; B is now blocked in its signed quote query.
    await within(host.quoting, 15_000);
    assert.equal(host.dials(), 1);
    first.abort();
    await new Promise((resolve) => setTimeout(resolve, 20));
    secondOperation = executeBuyerFree(
      input,
      host.dependencies,
      second.signal,
    ).then(
      () => {},
      (error: unknown) => {
        secondBusy =
          error instanceof Error &&
          'code' in error &&
          error.code === FREE_BUYER_CODES.BUSY;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(
      {
        firstFinished,
        secondBusy,
        deadDials: host.dials(),
        deadCloses: host.closes(),
        savedStats: host.prepared.stats.rows.size,
      },
      {
        firstFinished: false,
        secondBusy: true,
        deadDials: 1,
        deadCloses: 0,
        savedStats: 0,
      },
    );
  } finally {
    first.abort();
    second.abort();
    host.release();
    await within(Promise.all([firstOperation, secondOperation]), 2000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(host.closes(), host.dials());
  }
});
