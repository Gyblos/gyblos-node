import assert from 'node:assert/strict';

import { encodePaymentSignatureHeader } from '@x402/core/http';

import { COMMITMENT, HTTP_STATUS, TIMEOUTS } from '@gyblos/config';
import { saveJson } from '@gyblos/gate/config';
import type { ChainTransaction } from '@gyblos/gate/types';
import { confirm, explorer, GateError, rpc } from '@gyblos/payments-x402/chain';
import { DEVNET } from '@gyblos/payments-x402/constants';
import {
  assertExactFallbackSafe,
  EXACT_PRICE,
} from '@gyblos/payments-x402/exact/index';

import { assertEmpty, assertUntrusted } from './assertions.js';
import { createChallenge } from './challenge.js';
import { createPaidRequest } from './payment.js';
import { authorizationMetadata, reconcile, snapshot } from './reconcile.js';
import type { ExactContext } from './types.js';

export async function runProvider(context: ExactContext) {
  const {
    c,
    provider,
    host,
    facilitator,
    url,
    evidence,
    persist,
    journalPath,
    evidencePath,
  } = context;
  let active:
    (ReturnType<typeof authorizationMetadata> & { buyer: string }) | undefined;
  try {
    const policy = {
      payTo: c.addresses.seller,
      feePayer: provider.feePayer,
      amount: EXACT_PRICE,
    };
    const challenge = createChallenge(context, policy);
    const required = await challenge();
    evidence.challenge = {
      httpStatus: HTTP_STATUS.paymentRequired,
      ...required,
    };
    await persist();
    const cases = evidence.results as unknown[];
    await assertUntrusted(context, required, policy);
    const paid = createPaidRequest(context, challenge, policy, (value) => {
      active = value;
    });
    await assertEmpty(context, challenge, policy);
    const success = await paid('buyer', 'paid-request');
    if (
      success.response.status !== HTTP_STATUS.ok ||
      !success.receipt?.success
    ) {
      assertExactFallbackSafe(success.calls);
      const reconciliation = await reconcile(
        c,
        c.addresses.buyer,
        success.metadata.buyerSignature,
      );
      if (reconciliation.matches.length)
        throw new GateError(
          'PUBLIC_OUTCOME_UNCERTAIN',
          'Payment transaction observed without successful delivery.',
        );
      cases.push({
        case: 'paid-request',
        facilitator: provider.url,
        status: 'rejected',
        httpStatus: success.response.status,
        calls: success.calls,
        reconciliation,
      });
      await saveJson(journalPath, {
        state: 'rejected',
        ...success.metadata,
        reconciliation,
      });
      active = undefined;
      await persist();
      return false;
    }
    const receipt = success.receipt;
    assert.equal(receipt.network, DEVNET);
    assert.equal(receipt.payer, c.addresses.buyer);
    assert.ok(receipt.transaction);
    if (receipt.amount !== undefined) assert.equal(receipt.amount, EXACT_PRICE);
    await confirm(c.rpcUrl, receipt.transaction);
    assert.equal(
      BigInt(success.before.buyer) - BigInt(success.after.buyer),
      BigInt(EXACT_PRICE),
    );
    assert.equal(
      BigInt(success.after.seller) - BigInt(success.before.seller),
      BigInt(EXACT_PRICE),
    );
    assert.equal(success.after.buyerLamports, success.before.buyerLamports);
    assert.equal(host.handlerCalls() - success.previousHandlers, 1);
    assert.ok(
      success.calls.some(
        (call) => call.operation === 'verify' && call.outcome === 'success',
      ),
    );
    assert.ok(
      success.calls.some(
        (call) => call.operation === 'settle' && call.outcome === 'success',
      ),
    );
    const onChain = await rpc<ChainTransaction | null>(
      c.rpcUrl,
      'getTransaction',
      [
        receipt.transaction,
        {
          encoding: 'jsonParsed',
          commitment: COMMITMENT,
          maxSupportedTransactionVersion: 0,
        },
      ],
    );
    assert.ok(onChain && !onChain.meta.err);
    assert.ok(
      onChain.transaction.signatures.includes(success.metadata.buyerSignature),
    );
    assert.equal(
      onChain.transaction.message.accountKeys[0]?.pubkey,
      provider.feePayer,
    );
    cases.push({
      case: 'paid-request',
      status: 'passed',
      httpStatus: HTTP_STATUS.ok,
      ...success.metadata,
      receipt,
      resource: success.body,
      before: success.before,
      after: success.after,
      handlerDelta: 1,
      calls: success.calls,
      transaction: receipt.transaction,
      explorer: explorer(receipt.transaction),
      onChain: {
        slot: onChain.slot,
        accountKeys: onChain.transaction.message.accountKeys,
        signatures: onChain.transaction.signatures,
        meta: onChain.meta,
      },
    });
    await saveJson(journalPath, {
      state: COMMITMENT,
      transaction: receipt.transaction,
      ...success.metadata,
    });
    active = undefined;
    await persist();
    const replayBefore = await snapshot(c, c.addresses.buyer),
      handlers = host.handlerCalls(),
      callCount = facilitator.calls.length;
    const replay = await fetch(url, {
      headers: {
        'PAYMENT-SIGNATURE': encodePaymentSignatureHeader(success.payload),
      },
      signal: AbortSignal.timeout(TIMEOUTS.publicRequest),
    });
    assert.equal(replay.status, HTTP_STATUS.conflict);
    const replayAfter = await snapshot(c, c.addresses.buyer);
    assert.deepEqual(replayAfter, replayBefore);
    assert.equal(host.handlerCalls(), handlers);
    assert.equal(facilitator.calls.length, callCount);
    cases.push({
      case: 'replay',
      status: 'passed',
      httpStatus: HTTP_STATUS.conflict,
      before: replayBefore,
      after: replayAfter,
      handlerDelta: 0,
      publicCallDelta: 0,
      originalTransaction: receipt.transaction,
      scope: 'same-process replay guard',
    });
    evidence.status = 'passed';
    evidence.gatePassed = true;
    evidence.finishedAt = new Date().toISOString();
    await persist();
    console.log(
      JSON.stringify({
        status: 'passed',
        evidencePath,
        facilitator: provider.url,
        transaction: receipt.transaction,
      }),
    );
    return true;
  } catch (error) {
    evidence.publicCalls = facilitator.calls;
    if (active) {
      const reconciliation = await reconcile(
        c,
        active.buyer,
        active.buyerSignature,
      ).catch(() => ({ classification: 'reconciliation-unavailable' }));
      evidence.status = 'uncertain';
      evidence.reconciliation = reconciliation;
      await saveJson(journalPath, {
        state: 'uncertain',
        ...active,
        reconciliation,
      });
      await persist();
    }
    throw error;
  }
}
