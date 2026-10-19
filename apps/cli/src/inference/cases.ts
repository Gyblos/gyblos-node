import assert from 'node:assert/strict';
import { resolve } from 'node:path';

import { observeInferenceResponse } from '@gyblos/application/inference-observation';
import { assessCharge, charge, OFFER_ID } from '@gyblos/application/metering';
import { localPath } from '@gyblos/config';
import { saveJson, signer } from '@gyblos/gate/config';
import { inferenceSnapshot, transaction } from '@gyblos/gate/inference-chain';
import { assertNoUnresolvedAuthorizations } from '@gyblos/gate/journal';
import { appendMeasurement, measurementRow } from '@gyblos/gate/measurements';
import { MODEL } from '@gyblos/inference-ollama/index';
import { DEVNET } from '@gyblos/payments-x402/constants';
import { createInferenceBuyer } from '@gyblos/payments-x402/inference-buyer';

import { inferenceCeiling } from '../../../seller/src/inference.js';
import { reconcileCase } from './reconcile.js';
import type { CaseContext } from './types.js';

export async function runCases({
  url,
  c,
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
  const buyerSigner = await signer(c, 'buyer');
  for (const testCase of cases) {
    controller.signal.throwIfAborted();
    await assertNoUnresolvedAuthorizations();
    const request = {
      requestId: testCase.requestId,
      prompt: testCase.prompt,
      maxTokens: 128,
    };
    const ceiling = inferenceCeiling(request, buyerTokenizer);
    const before = await inferenceSnapshot(c);
    assert.ok(BigInt(before.buyer) >= BigInt(ceiling));
    let signedAt: number | undefined, channelId: string | undefined;
    const buyer = createInferenceBuyer(
      buyerSigner,
      c.rpcUrl,
      {
        mint: c.mint,
        payTo: c.addresses.seller,
        feePayer: c.addresses.facilitator,
        receiverAuthorizer: c.addresses.authorizer,
        maxAtomic: ceiling,
      },
      {
        beforeSigning() {
          signedAt = performance.now();
        },
        async authorized(id, authorizedCeiling) {
          assert.equal(authorizedCeiling, ceiling);
          channelId = id;
          await saveJson(journalPath, {
            state: 'authorization-created',
            requestId: request.requestId,
            channelId: id,
            ceilingAtomic: ceiling,
            network: DEVNET,
            mint: c.mint,
            createdAt: new Date().toISOString(),
          });
        },
      },
    );
    const response = await buyer(url, request, controller.signal);
    await saveJson(localPath('inference-last-transport.json'), {
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
      c,
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
    const {
      body,
      failed,
      text,
      recounted,
      engineTokens,
      delivered,
      comparison,
    } = observeInferenceResponse({
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
    assert.equal(body.requestId, request.requestId);
    const assessment = assessCharge(actual, recounted, delivered, failed);
    const row = measurementRow(
      {
        requestId: request.requestId,
        seller: c.addresses.seller,
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
    if (testCase.name === 'engine-interrupted') {
      assert.equal(failed, true);
      assert.equal(response.status, 502);
      assert.equal(actual, 0n);
      assert.equal(row.anomaly, 'failed');
      assert.ok(trace.firstFragmentAt && trace.stoppedAt);
      assert.equal(row.delivered, false);
    } else {
      assert.equal(failed, false);
      assert.equal(body.offer, OFFER_ID);
      assert.equal(body.model, MODEL.name);
      assert.equal(body.digest, MODEL.digest);
      assert.ok(delivered && engineTokens && comparison?.withinTolerance);
      assert.equal(actual, charge(body.billedTokens!));
      if (testCase.name === 'overcharge') {
        assert.ok(body.billedTokens!.output > engineTokens.output);
        assert.equal(row.anomaly, 'overcharge');
      } else {
        assert.deepEqual(body.billedTokens, engineTokens);
        assert.equal(actual, charge(engineTokens));
        assert.equal(row.anomaly, 'none');
      }
    }
    await saveJson(journalPath, {
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
    await new Promise((resolve) => setTimeout(resolve, 12_000));
  }
}
