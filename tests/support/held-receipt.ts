// Holds one native receipt response to expose cross-channel admission races without slowing inference.
import type { TestContext } from 'node:test';

import { Endpoint } from '@number0/iroh';

import { RECEIPT_CHANNEL } from '@gyblos/protocol/constants';

export function holdFirstReceipt(context: TestContext) {
  let entered = () => {};
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let resume = () => {};
  const released = new Promise<void>((resolve) => {
    resume = resolve;
  });
  let held = false;
  const acceptNext = Endpoint.prototype.acceptNext;
  context.mock.method(
    Endpoint.prototype,
    'acceptNext',
    async function (this: Endpoint) {
      const incoming = await acceptNext.call(this);
      if (!incoming) return incoming;
      const accept = incoming.accept.bind(incoming);
      incoming.accept = async () => {
        const accepting = await accept();
        const connect = accepting.connect.bind(accepting);
        accepting.connect = async () => {
          const connection = await connect();
          if (
            Buffer.from(connection.alpn()).toString() !== RECEIPT_CHANNEL.alpn
          )
            return connection;
          const acceptBi = connection.acceptBi.bind(connection);
          connection.acceptBi = async () => {
            const stream = await acceptBi();
            const send = stream.send;
            const write = send.writeAll.bind(send);
            send.writeAll = async (bytes) => {
              if (!held) {
                held = true;
                entered();
                await released;
              }
              return write(bytes);
            };
            return { recv: stream.recv, send };
          };
          return connection;
        };
        return accepting;
      };
      return incoming;
    },
  );
  return { started, release: resume };
}
