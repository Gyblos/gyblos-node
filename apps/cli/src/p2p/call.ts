import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { observeInferenceResponse } from '@gyblos/application/inference-observation';
import { assessCharge, charge, OFFER_ID } from '@gyblos/application/metering';
import { HTTP_STATUS, LOCALHOST, P2P, ROUTES } from '@gyblos/config';
import { inferenceSnapshot } from '@gyblos/gate/chain';
import { JOURNAL_STATES } from '@gyblos/gate/constants';
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
import type { RouteObservation } from '@gyblos/transport';
import {
  expectedIrohRoute,
  routesMatchRequired,
} from '@gyblos/transport/route-policy';

import { createCases } from '../inference/cases-data.js';
import { modelTokenizer } from './artifacts.js';
import { trustedOffer } from './buyer.js';
import {
  CALL_OUTCOMES,
  P2P_JOURNAL_STATES,
  type P2pJournalState,
} from './constants.js';
import { paymentProof } from './proof.js';
import { rolePath, roleSigner } from './roles.js';

interface TransportMetric extends RouteObservation {
  requestId: string;
  status: number;
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
  const requiredRoute = expectedIrohRoute(process.env.GYBLOS_EXPECTED_ROUTE);
  const { config, offer, trust } = await trustedOffer();
  await assertProgram(config.rpcUrl);
  try {
    const previous = JSON.parse(
      await readFile(rolePath(P2P.journalFilename), 'utf8'),
    ) as { state: P2pJournalState };
    if (previous.state !== JOURNAL_STATES.CONFIRMED)
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
  const paymentExpectation = {
    buyer: buyer.address,
    mint: config.mint,
    payTo: offer.payTo,
    feePayer: offer.feePayer,
    authorizer: offer.authorizer,
  };
  let confirmedProof: Awaited<ReturnType<typeof paymentProof>> | undefined;
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
          state: P2P_JOURNAL_STATES.AUTHORIZED,
          requestId: request.requestId,
          ...authorization,
          paymentExpectation,
          before,
          runId: process.env.GYBLOS_P2P_RUN_ID,
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
    confirmedProof = proof;
    await saveJson(rolePath(P2P.journalFilename), {
      state: JOURNAL_STATES.CONFIRMED,
      requestId: request.requestId,
      channelId: authorization.channelId,
      depositSignature: proof.depositSignature,
      claimSignature: proof.claimSignature,
    });
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
        model: { name: offer.model.name, digest: offer.model.digest },
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
    const metrics = (
      await readFile(rolePath(P2P.metricsFilename), 'utf8').catch(() => '')
    )
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as TransportMetric)
      .filter((metric) => metric.requestId === request.requestId);
    const paid = metrics.find((metric) => metric.status === HTTP_STATUS.ok);
    const routeAccepted =
      Boolean(paid) &&
      metrics.some((metric) => metric.status === HTTP_STATUS.paymentRequired) &&
      routesMatchRequired(metrics, requiredRoute);
    const result = {
      requestId: request.requestId,
      case: testCase.name,
      outcome: routeAccepted
        ? CALL_OUTCOMES.CONFIRMED
        : CALL_OUTCOMES.ROUTE_DISCREPANCY,
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
    console.log(JSON.stringify(result));
    if (!routeAccepted) process.exitCode = 1;
  } catch {
    const result = {
      requestId: request.requestId,
      case: testCase.name,
      outcome: confirmedProof
        ? CALL_OUTCOMES.CONFIRMED_ERROR
        : authorization
          ? CALL_OUTCOMES.UNCERTAIN
          : CALL_OUTCOMES.REJECTED,
      channelId: authorization?.channelId,
      ceilingAtomic: ceiling,
      before,
      paymentExpectation,
      runId: process.env.GYBLOS_P2P_RUN_ID,
      ...(confirmedProof ?? {}),
    };
    if (authorization && !confirmedProof)
      await saveJson(rolePath(P2P.journalFilename), {
        state: JOURNAL_STATES.UNCERTAIN,
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
