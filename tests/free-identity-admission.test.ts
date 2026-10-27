// Identity refusal at the prompt boundary must precede any execution client or transport access.
import assert from 'node:assert/strict';
import test from 'node:test';

import type { Endpoint } from '@number0/iroh';

import { FREE_BUYER_CODES } from '@gyblos/buyer/constants';
import { freeBuyerDependencies } from '@gyblos/buyer/free-selection';
import type { PreparedBuyerSelection } from '@gyblos/buyer/selection-runtime';
import { IDENTITY_POLICY_CODES } from '@gyblos/core/identity-policy';
import { FREE_CHAT_ROLES } from '@gyblos/protocol/constants';
import { buildFreeExecutionRequest } from '@gyblos/protocol/free-execution';

import { selectionFixture } from './support/buyer-selection';
import { freeSellerFixture } from './support/free-seller';

void test('a free quote cannot send a prompt after independent identity is revoked', async () => {
  const run = await selectionFixture();
  const source = await freeSellerFixture();
  try {
    const quote = (await source.request()).quote;
    let touched = 0;
    const endpoint = {
      id: () => {
        touched++;
        throw new Error('Execution endpoint must remain untouched');
      },
    } as unknown as Endpoint;
    const prepared: PreparedBuyerSelection = {
      config: {
        ...run.config,
        identity: { rpcUrl: 'https://rpc.invalid' },
        sellers: [
          {
            owner: quote.offer.owner,
            nodeId: quote.offer.nodeId,
            relayUrl: null,
            directAddresses: [],
          },
        ],
      },
      stats: { rows: new Map(), save: async () => {} },
      discovery: undefined,
      identity: {
        verify: async () => ({
          ok: false,
          code: IDENTITY_POLICY_CODES.REVOKED,
        }),
      },
    };
    const dependencies = freeBuyerDependencies(prepared, {
      endpoint,
      buyer: quote.offer.buyer,
      relayOnly: false,
    });
    const request = buildFreeExecutionRequest(quote, {
      messages: [{ role: FREE_CHAT_ROLES.USER, content: 'synthetic' }],
      maxTokens: 1,
    });
    await assert.rejects(
      dependencies.execute(
        { nodeId: quote.offer.nodeId, quote },
        request,
        new AbortController().signal,
      ),
      { code: FREE_BUYER_CODES.UNAVAILABLE },
    );
    assert.equal(touched, 0);
  } finally {
    await run.wire.close();
  }
});
void test('registry configuration cannot silently run with an absent identity verifier', async () => {
  const run = await selectionFixture();
  try {
    const prepared: PreparedBuyerSelection = {
      config: { ...run.config, identity: { rpcUrl: 'https://rpc.invalid' } },
      stats: { rows: new Map(), save: async () => {} },
      discovery: undefined,
    };
    assert.throws(
      () =>
        freeBuyerDependencies(prepared, {
          endpoint: {} as Endpoint,
          buyer: run.request.params.buyer,
          relayOnly: false,
        }),
      { code: 'BUYER_IDENTITY_UNAVAILABLE' },
    );
  } finally {
    await run.wire.close();
  }
});
