import { EndpointAddr, EndpointId, type Endpoint } from '@number0/iroh';

import { CONTROL_CAPACITY } from '@gyblos/core/constants';
import { FREE_CHAT_ROLES } from '@gyblos/protocol/constants';
import { matchControlResponse } from '@gyblos/protocol/control-response';
import {
  controlAddress,
  controlArray,
  controlHex,
  controlObject,
  controlText,
} from '@gyblos/protocol/control-validation';
import { buildFreeExecutionRequest } from '@gyblos/protocol/free-execution';
import { createControlTransport } from '@gyblos/transport-iroh/control-client';
import { assertConfiguredRelay } from '@gyblos/transport-iroh/endpoint';
import { createFreeExecutionClient } from '@gyblos/transport-iroh/free-client';

import { MAX_DIRECT_ADDRESSES, MODEL_VERIFIER } from './constants';
import { ephemeralAddress } from './key';
import { createFreeQuoter, invalidSeller, type QuoteExchange } from './quotes';

export interface SellerTarget {
  owner: string;
  nodeId: string;
  relayUrl: string | null;
  directAddresses: string[];
}

export function parseSellerTarget(value: unknown): SellerTarget {
  try {
    const input = controlObject(value, [
      'owner',
      'nodeId',
      'relayUrl',
      'directAddresses',
    ]);
    return {
      owner: controlAddress(input.owner),
      nodeId: controlHex(input.nodeId),
      relayUrl: input.relayUrl === null ? null : controlText(input.relayUrl),
      directAddresses: controlArray(
        input.directAddresses,
        MAX_DIRECT_ADDRESSES,
      ).map((address) => controlText(address)),
    };
  } catch {
    throw invalidSeller();
  }
}

function relayAllowed(origin: string) {
  try {
    assertConfiguredRelay(origin);
    return true;
  } catch {
    return false;
  }
}

export async function openSeller(
  endpoint: Endpoint,
  target: SellerTarget,
  modelId: string,
) {
  if (target.relayUrl && !relayAllowed(target.relayUrl)) throw invalidSeller();
  const remote = new EndpointAddr(
    EndpointId.fromString(target.nodeId),
    target.relayUrl ?? undefined,
    target.directAddresses,
  );
  const trust = { owner: target.owner, nodeId: target.nodeId, relayAllowed };
  const transport = createControlTransport(endpoint, remote, target.nodeId, {
    queryMs: CONTROL_CAPACITY.queryMs,
  });
  const exchange: QuoteExchange = async (query) =>
    matchControlResponse(await transport.exchange(query), query);
  const quoter = createFreeQuoter(exchange, trust, modelId, {
    address: ephemeralAddress(),
    nodeId: endpoint.id().toString(),
  });
  try {
    const selection = await quoter.open();
    return {
      selection,
      async ask(prompt: string, maxTokens: number) {
        const quote = await quoter.quote(maxTokens);
        const request = buildFreeExecutionRequest(quote, {
          messages: [{ role: FREE_CHAT_ROLES.USER, content: prompt }],
          maxTokens,
        });
        const client = createFreeExecutionClient(endpoint, remote, trust, {
          requestMs: MODEL_VERIFIER.answerTimeoutMs,
          relayAllowed,
        });
        try {
          return (await client.execute(request)).text;
        } finally {
          client.close();
          await client.settled();
        }
      },
      async close() {
        try {
          await transport.close();
        } finally {
          await transport.settled();
        }
      },
    };
  } catch (error) {
    await transport.close().catch(() => {});
    await transport.settled();
    throw error;
  }
}
