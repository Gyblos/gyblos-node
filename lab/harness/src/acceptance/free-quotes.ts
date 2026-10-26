// Acquires genuine buyer-bound control quotes, then supports adversarial native frames for seller guards.
// Invalid-peer/expired cases intentionally bypass only buyer preflight, never seller validation.
import type { Endpoint } from '@number0/iroh';

import { connectBuyerControl } from '@gyblos/buyer/control';
import {
  CONTROL_LIMITS,
  FREE_CHAT_ROLES,
  FREE_EXECUTION,
  type FreeExecutionCode,
} from '@gyblos/protocol/constants';
import {
  buildFreeExecutionRequest,
  FreeExecutionError,
  matchFreeExecutionResponse,
  type FreeExecutionRequest,
} from '@gyblos/protocol/free-execution';
import {
  encodeFreeExecutionRequest,
  FreeExecutionResponseReader,
} from '@gyblos/protocol/free-execution-framing';
import { HTTP_OVER_IROH } from '@gyblos/transport-iroh/constants';
import { controlDeadline } from '@gyblos/transport-iroh/control-io';
import {
  createFreeExecutionClient,
  FreeClientError,
} from '@gyblos/transport-iroh/free-client';

import { acceptanceSelection } from './buyer.js';
import { ACCEPTANCE } from './constants.js';
import { acceptanceAssert } from './errors.js';
import { FREE_ACCEPTANCE } from './free-constants.js';
import { createAcceptanceBuyerEndpoint } from './native.js';
import type { AcceptanceSession } from './session.js';

export async function acquireFreeQuote(
  run: AcceptanceSession,
  existing?: Endpoint,
) {
  const endpoint = existing ?? (await createAcceptanceBuyerEndpoint());
  let control: Awaited<ReturnType<typeof connectBuyerControl>> | undefined;
  try {
    control = await connectBuyerControl(
      endpoint,
      run.host().wire.endpoint.addr(),
      {
        owner: run.identity.owner.address,
        nodeId: run.host().wire.nodeId,
        relayAllowed: () => false,
        now: run.clock.now,
      },
    );
    const before = run.engine.generations();
    const attempts = run.engine.attempts();
    await control.getCatalog(run.signal);
    await control.getPresence(run.signal);
    const policy = acceptanceSelection(run).request;
    const quote = await control.requestOffer(
      {
        buyer: run.identity.buyer.address,
        selection: policy.selection,
        reasoning: policy.reasoning,
        maxTokens: FREE_ACCEPTANCE.maxTokens,
        maxAtomic: '0',
        priceCeilings: { inputAtomicPerMtok: '0', outputAtomicPerMtok: '0' },
        network: policy.network,
        asset: policy.asset,
      },
      run.signal,
    );
    acceptanceAssert(
      run.engine.generations() === before && run.engine.attempts() === attempts,
    );
    const request = buildFreeExecutionRequest(quote, {
      messages: [
        { role: FREE_CHAT_ROLES.USER, content: 'synthetic acceptance input' },
      ],
      maxTokens: FREE_ACCEPTANCE.maxTokens,
    });
    return {
      endpoint,
      request,
      async close() {
        if (!existing) await endpoint.close();
      },
    };
  } catch (error) {
    if (!existing) await endpoint.close();
    throw error;
  } finally {
    await control?.close();
    await control?.settled();
  }
}
export async function executeFreeQuote(
  run: AcceptanceSession,
  endpoint: Endpoint,
  request: FreeExecutionRequest,
) {
  const client = createFreeExecutionClient(
    endpoint,
    run.host().wire.endpoint.addr(),
    { owner: run.identity.owner.address, nodeId: run.host().wire.nodeId },
    { now: run.clock.now, requestMs: ACCEPTANCE.queryMs },
  );
  try {
    return await client.execute(request, run.signal);
  } finally {
    await client.settled();
  }
}
export async function rawFreeQuote(
  run: AcceptanceSession,
  endpoint: Endpoint,
  request: FreeExecutionRequest,
) {
  let close = () => {};
  try {
    return await controlDeadline(
      async (signal) => {
        const connection = await endpoint.connect(
          run.host().wire.endpoint.addr(),
          [...Buffer.from(FREE_EXECUTION.alpn)],
        );
        close = () => connection.close(HTTP_OVER_IROH.streamCloseCode, []);
        if (signal.aborted) {
          close();
          signal.throwIfAborted();
        }
        const stream = await connection.openBi();
        await stream.send.writeAll([...encodeFreeExecutionRequest(request)]);
        await stream.send.finish();
        const response = new FreeExecutionResponseReader();
        response.push(
          Uint8Array.from(
            await stream.recv.readToEnd(
              FREE_EXECUTION.responseBytes + CONTROL_LIMITS.prefixBytes,
            ),
          ),
        );
        return matchFreeExecutionResponse(response.finish(), request);
      },
      ACCEPTANCE.queryMs,
      () => close(),
      run.signal,
    );
  } finally {
    close();
  }
}
export async function expectFreeRefusal(
  run: AcceptanceSession,
  code: FreeExecutionCode,
  execute: () => Promise<unknown>,
) {
  const before = run.engine.generations();
  let refused = false;
  try {
    await execute();
  } catch (error) {
    refused =
      (error instanceof FreeExecutionError ||
        error instanceof FreeClientError) &&
      error.code === code;
  }
  acceptanceAssert(refused);
  acceptanceAssert(run.engine.generations() === before);
}
