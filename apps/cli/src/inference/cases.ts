import assert from 'node:assert/strict';

import { observeInferenceResponse } from '@gyblos/application/inference-observation';
import { assessCharge, OFFER_ID } from '@gyblos/application/metering';
import { INFERENCE_TRANSPORT_PATH, TIMEOUTS } from '@gyblos/config';
import { inferenceSnapshot } from '@gyblos/gate/chain';
import { saveJson, signer } from '@gyblos/gate/config';
import {
  assertNoUnresolvedAuthorizations,
  saveJournal,
} from '@gyblos/gate/journal';
import { appendMeasurement, measurementRow } from '@gyblos/gate/measurements';
import { GENERATION, MODEL_LIMITS } from '@gyblos/inference-ollama/constants';
import { MODEL } from '@gyblos/inference-ollama/index';
import { DEVNET } from '@gyblos/payments-x402/constants';
import { createInferenceBuyer } from '@gyblos/payments-x402/inference-buyer';
import { inferenceCeiling } from '@gyblos/seller/inference';

import { assertInferenceCase } from './assertions.js';
import { reconcileCase } from './reconcile.js';
import type { CaseContext } from './types.js';

export async function runCases({
  url,
  config: config,
  cases,
  controller,
  buyerTokenizer,
  salt,
  evidence,
  evidencePath,
  journalPath,
  events,
  traces,
}: CaseContext) {
  const buyerSigner = await signer(config, 'buyer');
  for (const testCase of cases) {
    controller.signal.throwIfAborted();
    await assertNoUnresolvedAuthorizations();
    const request = {
      requestId: testCase.requestId,
      prompt: testCase.prompt,
      maxTokens: MODEL_LIMITS.requestMaxOutputTokens,
    };
    const ceiling = inferenceCeiling(
      request,
      buyerTokenizer,
      GENERATION.numCtx,
    );
    const before = await inferenceSnapshot(config);
    assert.ok(BigInt(before.buyer) >= BigInt(ceiling));
    let signedAt: number | undefined, channelId: string | undefined;
    const buyer = createInferenceBuyer(
      buyerSigner,
      config.rpcUrl,
      {
        mint: config.mint,
        payTo: config.addresses.seller,
        feePayer: config.addresses.facilitator,
        receiverAuthorizer: config.addresses.authorizer,
        maxAtomic: ceiling,
      },
      {
        beforeSigning() {
          signedAt = performance.now();
        },
        async authorized(authorizedChannelId, authorizedCeiling) {
          assert.equal(authorizedCeiling, ceiling);
          channelId = authorizedChannelId;
          await saveJournal(journalPath, {
            state: 'authorization-created',
            requestId: request.requestId,
            channelId: authorizedChannelId,
            ceilingAtomic: ceiling,
            network: DEVNET,
            mint: config.mint,
            createdAt: new Date().toISOString(),
          });
        },
      },
    );
    const response = await buyer(url, request, controller.signal);
    await saveJson(INFERENCE_TRANSPORT_PATH, {
      requestId: request.requestId,
      httpStatus: response.status,
      receipt: response.receipt,
      events: await events(),
    });
    assert.ok(channelId && signedAt !== undefined);
    const {
      deposit,
      claim,
      actual,
      after,
      trace,
      openTx,
      claimTx,
      openTransfers,
      claimTransfers,
    } = await reconcileCase({
      config: config,
      events,
      channelId,
      ceiling,
      response,
      before,
      requestId: request.requestId,
      evidencePath,
      journalPath,
      traces,
    });
    const observation = observeInferenceResponse({
      status: response.status,
      body: response.body,
      expected: {
        requestId: request.requestId,
        offer: OFFER_ID,
        model: MODEL.name,
        digest: MODEL.digest,
      },
      inputTokens: buyerTokenizer.input(request.prompt),
      countOutput: buyerTokenizer.count,
    });
    const {
      body,
      failed,
      text,
      recounted,
      engineTokens,
      delivered,
      comparison,
    } = observation;
    assert.equal(body.requestId, request.requestId);
    const assessment = assessCharge(actual, recounted, delivered, failed);
    const row = measurementRow(
      {
        requestId: request.requestId,
        seller: config.addresses.seller,
        offer: OFFER_ID,
        channelId,
        depositSignature: deposit.transaction,
        claimSignature: claim.transaction,
        ceilingAtomic: ceiling,
        chargedAtomic: actual.toString(),
        ...assessment,
        engineTokens,
        billedTokens: body.billedTokens ?? null,
        recountedTokens: recounted,
        countComparison: comparison,
        latencyMs: response.receivedAt - signedAt,
        delivered,
        responseText: text,
      },
      salt,
    );
    await appendMeasurement(row);
    const result = {
      case: testCase.name,
      measurement: row,
      before,
      duringDeposit: trace.during,
      after,
      trace,
      refundAtomic: (BigInt(ceiling) - actual).toString(),
      engineUsage: body.usage ?? null,
      doneReason: body.doneReason ?? null,
      onChain: {
        open: {
          signature: deposit.transaction,
          slot: openTx.slot,
          transfers: openTransfers,
        },
        claim: {
          signature: claim.transaction,
          slot: claimTx.slot,
          transfers: claimTransfers,
        },
      },
    };
    evidence.results.push(result);
    await saveJson(evidencePath, evidence);
    assertInferenceCase({
      caseName: testCase.name,
      status: response.status,
      observation,
      measurement: row,
      actual,
      trace,
    });
    await saveJournal(journalPath, {
      state: 'verified',
      requestId: request.requestId,
      channelId,
      depositSignature: deposit.transaction,
      claimSignature: claim.transaction,
      chargedAtomic: actual.toString(),
      evidencePath,
    });
    console.log(
      `${testCase.name}: confirmed charge=${actual}, refund=${result.refundAtomic}, anomaly=${row.anomaly}`,
    );
    // Let the public devnet RPC rate window clear between paid cases.
    await new Promise((resolve) => setTimeout(resolve, TIMEOUTS.rpcCooldown));
  }
}
