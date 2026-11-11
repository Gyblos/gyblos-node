// Observes only method/correlation metadata on real native loopback; never records prompts or answers.
import assert from 'node:assert/strict';

import { receiptNativeBinding } from '@gyblos/lab-harness/acceptance/receipt-native';
import { BATCH_CHANNEL, BATCH_METHODS } from '@gyblos/protocol/batch-channel';
import { CONTROL_ALPN, CONTROL_METHODS } from '@gyblos/protocol/constants';
import { ControlFrameReader } from '@gyblos/protocol/control-framing';
import { controlObject } from '@gyblos/protocol/control-validation';

import { batchDeferred } from './batch-deferred';

export function httpMultiWire() {
  const binding = receiptNativeBinding({ calls: () => 0 });
  const quotes = new Map<string, Set<string>>();
  const executions = new Map<string, number>();
  const streams = new Map<string, number>();
  const paused = batchDeferred<void>();
  const resume = batchDeferred<void>();
  let hold: string | undefined;
  const bind: typeof binding.bind = async (...args) => {
    const endpoint = await binding.bind(...args);
    const connect = endpoint.connect.bind(endpoint);
    endpoint.connect = async (...input) => {
      const connection = await connect(...input);
      const nodeId = connection.remoteId().toString();
      const alpn = Buffer.from(input[1]).toString();
      if (alpn !== CONTROL_ALPN && alpn !== BATCH_CHANNEL.alpn)
        return connection;
      const open = connection.openBi.bind(connection);
      connection.openBi = async () => {
        if (alpn === BATCH_CHANNEL.alpn) {
          const number = (streams.get(nodeId) ?? 0) + 1;
          streams.set(nodeId, number);
          if (hold === nodeId && number === 3) {
            paused.resolve();
            await resume.promise;
          }
        }
        const stream = await open();
        const send = stream.send;
        const write = send.writeAll.bind(send);
        send.writeAll = async (bytes) => {
          const frame = new ControlFrameReader(BATCH_CHANNEL.requestBytes);
          frame.push(Uint8Array.from(bytes));
          const row = controlObject(frame.finish(), [
            'version',
            'requestId',
            'method',
            'params',
          ]);
          if (alpn === CONTROL_ALPN && row.method === CONTROL_METHODS.OFFER) {
            assert.equal(typeof row.requestId, 'string');
            const known = quotes.get(nodeId) ?? new Set<string>();
            known.add(String(row.requestId));
            quotes.set(nodeId, known);
          }
          if (
            alpn === BATCH_CHANNEL.alpn &&
            row.method === BATCH_METHODS.EXECUTE
          )
            executions.set(nodeId, (executions.get(nodeId) ?? 0) + 1);
          return write(bytes);
        };
        return { recv: stream.recv, send };
      };
      return connection;
    };
    return endpoint;
  };
  return {
    bind,
    quotes,
    executions,
    pause: (id: string) => {
      hold = id;
    },
    paused: paused.promise,
    resume: () => resume.resolve(),
    close: binding.close,
  };
}
