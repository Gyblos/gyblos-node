import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { observeInferenceResponse } from '@gyblos/application/inference-observation';
import { assessCharge, charge, OFFER_ID } from '@gyblos/application/metering';
import { HTTP_STATUS, LOCALHOST, P2P, ROUTES } from '@gyblos/config';
import { inferenceSnapshot } from '@gyblos/gate/chain';
import { withExclusiveLock } from '@gyblos/gate/lock';
import {
  appendMeasurement,
  measurementRow,
  measurementSalt,
} from '@gyblos/gate/measurements';
import { assertProgram } from '@gyblos/payments-x402/chain';
import { createInferenceBuyer } from '@gyblos/payments-x402/inference-buyer';
import { validateSettlement } from '@gyblos/payments-x402/trust';
import { isMain, saveJson } from '@gyblos/runtime';
import { inferenceCeiling } from '@gyblos/seller/inference';

import { createCases } from '../inference/cases-data.js';
import { modelTokenizer } from './artifacts.js';
import { trustedOffer } from './buyer.js';
import { paymentProof } from './proof.js';
import { rolePath, roleSigner } from './roles.js';

interface TransportMetric {
  requestId: string;
  status: number;
  transport: string;
  connectMs: number;
  directObserved: boolean;
  relayObserved: boolean;
}

async function priorCalls() {
  try {
    return JSON.parse(
      await readFile(rolePath(P2P.callsFilename), 'utf8'),
    ) as unknown[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return [];
  }
}

async function run() {
  const { config, offer, trust } = await trustedOffer();
  await assertProgram(config.rpcUrl);
  try {
    const previous = JSON.parse(
      await readFile(rolePath(P2P.journalFilename), 'utf8'),
    ) as { state: string };
    if (previous.state !== 'confirmed')
      throw new Error('Reconcile prior authorization before another call.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const index = Number(process.argv[2]);
  if (!Number.isInteger(index) || index < 0 || index >= P2P.minimumRequests)
    throw new Error('Select a synthetic case index.');
  const testCase = createCases(randomUUID(), randomUUID())[index]!;
  const request = {
    requestId: testCase.requestId,
    prompt: testCase.prompt,
    maxTokens: offer.maxTokens,
  };
  const tokenizer = await modelTokenizer(),
    ceiling = inferenceCeiling(request, tokenizer, offer.model.contextTokens);
  if (
    BigInt(ceiling) > BigInt(trust.maxAtomic) ||
    BigInt(ceiling) > BigInt(offer.maxAtomic) ||
    offer.model.digest === undefined
  )
    throw new Error('Local budget or model mismatch.');
  const buyer = await roleSigner('buyer'),
    accounts = {
      rpcUrl: config.rpcUrl,
      mint: config.mint,
      addresses: { buyer: buyer.address, seller: offer.payTo },
    };
  const before = await inferenceSnapshot(accounts);
  let authorization: { channelId: string; ceiling: string } | undefined,
    signedAt = performance.now();
  const invoke = createInferenceBuyer(
    buyer,
    config.rpcUrl,
    {
      mint: config.mint,
      payTo: offer.payTo,
      feePayer: offer.feePayer,
      receiverAuthorizer: offer.authorizer,
      maxAtomic: ceiling,
      expectedAmount: ceiling,
    },
    {
      beforeSigning: () => {
        if (Date.now() >= offer.expiresAt)
          throw new Error('Signed offer expired before signing.');
        signedAt = performance.now();
      },
      async authorized(channelId, amount) {
        authorization = { channelId, ceiling: amount };
        await saveJson(rolePath(P2P.journalFilename), {
          state: 'authorized',
          requestId: request.requestId,
          ...authorization,
        });
      },
    },
  );
  try {
    const response = await invoke(
      `http://${LOCALHOST}:${P2P.buyerProxyPort}${ROUTES.inference}`,
      request,
    );
    assert.ok(authorization);
    assert.equal(authorization.ceiling, ceiling);
    assert.equal(response.status, HTTP_STATUS.ok);
    assert.ok(response.receipt?.transaction);
    const proof = await paymentProof(
      accounts,
      authorization.channelId,
      ceiling,
      response.receipt.transaction,
      before,
    );
    validateSettlement(response.receipt, {
      payer: buyer.address,
      amount: proof.chargedAtomic,
    });
    const observation = observeInferenceResponse({
      status: response.status,
      body: response.body,
      expected: {
        requestId: request.requestId,
        offer: OFFER_ID,
        model: offer.model.name,
        digest: offer.model.digest,
      },
      inputTokens: tokenizer.input(request.prompt),
      countOutput: tokenizer.count,
    });
    const assessment = assessCharge(
      BigInt(proof.chargedAtomic),
      observation.recounted,
      observation.delivered,
      observation.failed,
    );
    assert.equal(assessment.anomaly, 'none');
    assert.equal(observation.delivered, true);
    assert.equal(observation.comparison?.withinTolerance, true);
    assert.equal(
      BigInt(proof.chargedAtomic),
      charge(observation.body.billedTokens!),
    );
    assert.deepEqual(observation.body.billedTokens, observation.engineTokens);
    const row = measurementRow(
      {
        requestId: request.requestId,
        seller: offer.payTo,
        offer: OFFER_ID,
        channelId: authorization.channelId,
        depositSignature: proof.depositSignature,
        claimSignature: proof.claimSignature,
        ceilingAtomic: ceiling,
        chargedAtomic: proof.chargedAtomic,
        ...assessment,
        engineTokens: observation.engineTokens,
        billedTokens: observation.body.billedTokens ?? null,
        recountedTokens: observation.recounted,
        countComparison: observation.comparison,
        latencyMs: response.receivedAt - signedAt,
        delivered: observation.delivered,
        anomaly: assessment.anomaly,
        responseText: observation.text,
        meteringMode: offer.meteringMode,
      },
      await measurementSalt(P2P.root),
    );
    await appendMeasurement(row, rolePath(P2P.measurementsFilename));
    const metrics = (await readFile(rolePath(P2P.metricsFilename), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as TransportMetric)
      .filter((metric) => metric.requestId === request.requestId);
    assert.ok(
      metrics.some((metric) => metric.status === HTTP_STATUS.paymentRequired),
    );
    const paid = metrics.find((metric) => metric.status === HTTP_STATUS.ok);
    assert.ok(paid && ['iroh-direct', 'iroh-relay'].includes(paid.transport));
    const result = {
      requestId: request.requestId,
      case: testCase.name,
      outcome: 'confirmed',
      channelId: authorization.channelId,
      ceilingAtomic: ceiling,
      ...proof,
      measurement: row,
      transport: paid,
      metrics,
    };
    await saveJson(rolePath(P2P.callsFilename), [
      ...(await priorCalls()),
      result,
    ]);
    await saveJson(rolePath(P2P.journalFilename), {
      state: 'confirmed',
      requestId: request.requestId,
      channelId: authorization.channelId,
      depositSignature: proof.depositSignature,
      claimSignature: proof.claimSignature,
    });
    console.log(JSON.stringify(result));
  } catch {
    const result = {
      requestId: request.requestId,
      case: testCase.name,
      outcome: authorization ? 'uncertain' : 'rejected',
      channelId: authorization?.channelId,
      ceilingAtomic: ceiling,
    };
    if (authorization)
      await saveJson(rolePath(P2P.journalFilename), {
        state: 'uncertain',
        ...result,
      });
    await saveJson(rolePath(P2P.callsFilename), [
      ...(await priorCalls()),
      result,
    ]);
    console.error(JSON.stringify(result));
    process.exitCode = 1;
  }
}

export async function main() {
  return withExclusiveLock(rolePath(P2P.buyerLockFilename), run);
}

if (isMain(import.meta.url)) await main();
