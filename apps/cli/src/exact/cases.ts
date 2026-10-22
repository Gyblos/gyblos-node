import assert from 'node:assert/strict';

import { encodePaymentSignatureHeader } from '@x402/core/http';

import { EXACT_PRICE } from '@gyblos/application/constants';
import { COMMITMENT, HTTP_STATUS, TIMEOUTS } from '@gyblos/config';
import {
  CASE_STATUSES,
  EVIDENCE_STATUSES,
  EXACT_CASES,
  EXACT_REPLAY_SCOPE,
  JOURNAL_STATES,
  RECONCILIATION_CLASSIFICATIONS,
  WALLET_ROLES,
} from '@gyblos/gate/constants';
import { saveJournal } from '@gyblos/gate/journal';
import type { ChainTransaction } from '@gyblos/gate/types';
import { confirm, explorer, GateError, rpc } from '@gyblos/payments-x402/chain';
import {
  DEVNET,
  GATE_ERROR_CODES,
  PUBLIC_CALL_OPERATIONS,
  PUBLIC_CALL_OUTCOMES,
} from '@gyblos/payments-x402/constants';
import { assertExactFallbackSafe } from '@gyblos/payments-x402/exact/index';

import { assertEmpty, assertUntrusted } from './assertions.js';
import { createChallenge } from './challenge.js';
import { createPaidRequest } from './payment.js';
import { authorizationMetadata, reconcile, snapshot } from './reconcile.js';
import type { ExactContext } from './types.js';

export async function runProvider(context: ExactContext) {
  const {
    config: config,
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
      payTo: config.addresses.seller,
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
    const cases = evidence.results;
    await assertUntrusted(context, required, policy);
    const paid = createPaidRequest(context, challenge, policy, (value) => {
      active = value;
    });
    await assertEmpty(context, challenge, policy);
    const success = await paid(WALLET_ROLES.BUYER, EXACT_CASES.PAID_REQUEST);
    if (
      success.response.status !== HTTP_STATUS.ok ||
      !success.receipt?.success
    ) {
      assertExactFallbackSafe(success.calls);
      const reconciliation = await reconcile(
        config,
        config.addresses.buyer,
        success.metadata.buyerSignature,
      );
      if (reconciliation.matches.length)
        throw new GateError(
          GATE_ERROR_CODES.PUBLIC_OUTCOME_UNCERTAIN,
          'Payment transaction observed without successful delivery.',
        );
      cases.push({
        case: EXACT_CASES.PAID_REQUEST,
        facilitator: provider.url,
        status: CASE_STATUSES.REJECTED,
        httpStatus: success.response.status,
        calls: success.calls,
        reconciliation,
      });
      await saveJournal(journalPath, {
        state: JOURNAL_STATES.REJECTED,
        ...success.metadata,
        reconciliation,
      });
      active = undefined;
      await persist();
      return false;
    }
    const receipt = success.receipt;
    assert.equal(receipt.network, DEVNET);
    assert.equal(receipt.payer, config.addresses.buyer);
    assert.ok(receipt.transaction);
    if (receipt.amount !== undefined) assert.equal(receipt.amount, EXACT_PRICE);
    await confirm(config.rpcUrl, receipt.transaction);
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
        (call) =>
          call.operation === PUBLIC_CALL_OPERATIONS.VERIFY &&
          call.outcome === PUBLIC_CALL_OUTCOMES.SUCCESS,
      ),
    );
    assert.ok(
      success.calls.some(
        (call) =>
          call.operation === PUBLIC_CALL_OPERATIONS.SETTLE &&
          call.outcome === PUBLIC_CALL_OUTCOMES.SUCCESS,
      ),
    );
    const onChain = await rpc<ChainTransaction | null>(
      config.rpcUrl,
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
      case: EXACT_CASES.PAID_REQUEST,
      status: CASE_STATUSES.PASSED,
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
    await saveJournal(journalPath, {
      state: JOURNAL_STATES.CONFIRMED,
      transaction: receipt.transaction,
      ...success.metadata,
    });
    active = undefined;
    await persist();
    const replayBefore = await snapshot(config, config.addresses.buyer),
      handlers = host.handlerCalls(),
      callCount = facilitator.calls.length;
    const replay = await fetch(url, {
      headers: {
        'PAYMENT-SIGNATURE': encodePaymentSignatureHeader(success.payload),
      },
      signal: AbortSignal.timeout(TIMEOUTS.publicRequest),
    });
    assert.equal(replay.status, HTTP_STATUS.conflict);
    const replayAfter = await snapshot(config, config.addresses.buyer);
    assert.deepEqual(replayAfter, replayBefore);
    assert.equal(host.handlerCalls(), handlers);
    assert.equal(facilitator.calls.length, callCount);
    cases.push({
      case: EXACT_CASES.REPLAY,
      status: CASE_STATUSES.PASSED,
      httpStatus: HTTP_STATUS.conflict,
      before: replayBefore,
      after: replayAfter,
      handlerDelta: 0,
      publicCallDelta: 0,
      originalTransaction: receipt.transaction,
      scope: EXACT_REPLAY_SCOPE,
    });
    evidence.status = EVIDENCE_STATUSES.PASSED;
    evidence.gatePassed = true;
    evidence.finishedAt = new Date().toISOString();
    await persist();
    console.log(
      JSON.stringify({
        status: EVIDENCE_STATUSES.PASSED,
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
        config,
        active.buyer,
        active.buyerSignature,
      ).catch(() => ({
        classification: RECONCILIATION_CLASSIFICATIONS.UNAVAILABLE,
      }));
      evidence.status = EVIDENCE_STATUSES.UNCERTAIN;
      evidence.reconciliation = reconciliation;
      await saveJournal(journalPath, {
        state: JOURNAL_STATES.UNCERTAIN,
        ...active,
        reconciliation,
      });
      await persist();
    }
    throw error;
  }
}
