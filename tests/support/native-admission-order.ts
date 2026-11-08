// Controls native completion order in test-owned endpoints; all real admission still runs in serveIroh.
// Records only phase/counter state, never identities, addresses, prompts or payment material.
import assert from 'node:assert/strict';

import type { BiStream, Endpoint } from '@number0/iroh';

import { CONTROL_ALPN, GYBLOS_ALPN } from '@gyblos/protocol/constants';

import type { nativeControlFixture } from './native-control';
import { within } from './test-deadline';

function signal() {
  let resolve = () => {};
  const ready = new Promise<void>((finish) => {
    resolve = finish;
  });
  return { ready, resolve };
}
export function admissionOrder(alpn: typeof GYBLOS_ALPN | typeof CONTROL_ALPN) {
  const blocked = signal();
  const written = signal();
  const release = signal();
  const second = signal();
  let arrivals = 0;
  let admitted = 0;
  function observeSeller(endpoint: Endpoint) {
    const acceptNext = endpoint.acceptNext.bind(endpoint);
    endpoint.acceptNext = async () => {
      const incoming = await acceptNext();
      if (!incoming) return incoming;
      const accept = incoming.accept.bind(incoming);
      incoming.accept = async () => {
        const accepting = await accept();
        const connect = accepting.connect.bind(accepting);
        accepting.connect = async () => {
          const connection = await connect();
          if (Buffer.from(connection.alpn()).toString() !== alpn)
            return connection;
          arrivals++;
          const ordinal = arrivals;
          if (ordinal === 1) {
            blocked.resolve();
            await release.ready;
          }
          const acceptBi = connection.acceptBi.bind(connection);
          let observed = false;
          connection.acceptBi = () => {
            if (!observed) {
              observed = true;
              admitted++;
              if (ordinal > 1) second.resolve();
            }
            return acceptBi();
          };
          return connection;
        };
        return accepting;
      };
      return incoming;
    };
  }
  return {
    observeSeller,
    onWritten: written.resolve,
    blocked: blocked.ready,
    written: written.ready,
    secondAdmitted: second.ready,
    release: release.resolve,
    counts: () => ({ arrivals, admitted }),
  };
}

// Runs the inverted-order scenario so setup failures exercise its real resource cleanup too.
export async function invertedDataAdmission(
  run: Awaited<ReturnType<typeof nativeControlFixture>>,
  order: ReturnType<typeof admissionOrder>,
) {
  let stream: BiStream | undefined;
  try {
    const first = await within(
      run.buyer.connect(run.seller.addr(), [...Buffer.from(GYBLOS_ALPN)]),
    );
    stream = await within(first.openBi());
    await within(stream.send.writeAll([0]));
    await within(order.blocked);
    await within(run.client.getCatalog());
    const second = await within(
      run.buyer.connect(run.seller.addr(), [...Buffer.from(GYBLOS_ALPN)]),
    );
    await within(order.secondAdmitted);
    order.release();
    await within(first.closed());
    assert.equal(second.closeReason(), null);
    assert.deepEqual(order.counts(), { arrivals: 2, admitted: 1 });
    assert.equal(run.httpRequests, 0);
  } finally {
    order.release();
    try {
      await stream?.send.reset(1n).catch(() => undefined);
    } finally {
      await run.close();
    }
  }
}
