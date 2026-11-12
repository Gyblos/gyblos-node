// Real native loopback binding for product startup: no n0 discovery/relays, but product-selected ALPNs and services.
import { Endpoint, RelayMode } from '@number0/iroh';

import { IPV6_LOOPBACK, LOCALHOST } from '@gyblos/config';
import { BATCH_CHANNEL } from '@gyblos/protocol/batch-channel';
import {
  CONTROL_ALPN,
  FREE_EXECUTION,
  FREE_STREAM,
  GYBLOS_ALPN,
  RECEIPT_CHANNEL,
} from '@gyblos/protocol/constants';
import { PAID_STREAM } from '@gyblos/protocol/paid/constants';
import type { bindEndpoint } from '@gyblos/transport-iroh/endpoint';

import { ACCEPTANCE_CODES } from './constants';
import { acceptanceAssert, AcceptanceError } from './errors';
import type { ReceiptProvider } from './receipt-provider';

type AcceptanceAlpn =
  | typeof BATCH_CHANNEL.alpn
  | typeof PAID_STREAM.alpn
  | typeof CONTROL_ALPN
  | typeof FREE_EXECUTION.alpn
  | typeof FREE_STREAM.alpn
  | typeof GYBLOS_ALPN
  | typeof RECEIPT_CHANNEL.alpn;
export function receiptNativeBinding(provider: Pick<ReceiptProvider, 'calls'>) {
  let dials = 0;
  let controlDials = 0;
  let seller: Endpoint | undefined;
  let beforeFirst: number | undefined;
  const bound: Endpoint[] = [];
  const protocols: AcceptanceAlpn[][] = [];
  const bind: typeof bindEndpoint = async (secret, options = {}) => {
    try {
      const builder = Endpoint.builder();
      builder.applyMinimal();
      builder.relayMode(RelayMode.disabled());
      builder.bindAddr(`${LOCALHOST}:0`);
      builder.bindAddr(`${IPV6_LOOPBACK}:0`);
      builder.secretKey(secret);
      const alpns: AcceptanceAlpn[] = [];
      if (options.http !== false) alpns.push(GYBLOS_ALPN);
      if (options.control) alpns.push(CONTROL_ALPN);
      if (options.freeExecution)
        alpns.push(FREE_EXECUTION.alpn, FREE_STREAM.alpn);
      if (options.paidExecution) alpns.push(PAID_STREAM.alpn);
      if (options.batchSessions) alpns.push(BATCH_CHANNEL.alpn);
      if (options.receipts) alpns.push(RECEIPT_CHANNEL.alpn);
      builder.alpns(alpns.map((value) => [...Buffer.from(value)]));
      protocols.push(alpns);
      const endpoint = await builder.bind();
      bound.push(endpoint);
      if (options.control) seller = endpoint;
      // There are no relays whose readiness could be awaited; binding and the encrypted dial prove local readiness.
      endpoint.online = async () => {};
      const connect = endpoint.connect.bind(endpoint);
      endpoint.connect = async (...args) => {
        if (Buffer.from(args[1]).toString() === CONTROL_ALPN) controlDials++;
        if (
          [FREE_EXECUTION.alpn, FREE_STREAM.alpn, PAID_STREAM.alpn].some(
            (value) => value === Buffer.from(args[1]).toString(),
          )
        ) {
          dials++;
          beforeFirst ??= provider.calls();
        }
        return connect(...args);
      };
      acceptanceAssert(
        endpoint
          .boundSockets()
          .every(
            (value) =>
              value.startsWith(`${LOCALHOST}:`) ||
              value.startsWith(`${IPV6_LOOPBACK}:`),
          ),
      );
      return endpoint;
    } catch {
      throw new AcceptanceError(ACCEPTANCE_CODES.NATIVE_UNAVAILABLE);
    }
  };
  return {
    bind,
    directAddresses: () => {
      acceptanceAssert(seller);
      return seller.addr().directAddresses();
    },
    nodeSigner: async (bytes: Uint8Array) => {
      acceptanceAssert(seller);
      return Uint8Array.from(
        seller
          .secretKey()
          .sign([...bytes])
          .toBytes(),
      );
    },
    dials: () => dials,
    controlDials: () => controlDials,
    beforeFirst: () => beforeFirst,
    protocols: () => protocols,
    async close() {
      await Promise.allSettled(bound.map((endpoint) => endpoint.close()));
    },
  };
}
