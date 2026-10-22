import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { observeInferenceResponse } from '@gyblos/application/inference-observation';
import { assessCharge, charge, OFFER_ID } from '@gyblos/application/metering';
import { HTTP_STATUS, LOCALHOST, P2P, ROUTES } from '@gyblos/config';
import { inferenceSnapshot } from '@gyblos/lab-harness/chain';
import { JOURNAL_STATES } from '@gyblos/lab-harness/constants';
import { errorDiagnostic } from '@gyblos/lab-harness/diagnostics';
import { withExclusiveLock } from '@gyblos/lab-harness/lock';
import {
  appendMeasurement,
  measurementRow,
  measurementSalt,
} from '@gyblos/lab-harness/measurements';
import { assertProgram } from '@gyblos/payments-x402/chain';
import type { BuyerDiagnosticCode } from '@gyblos/payments-x402/constants';
import { createInferenceBuyer } from '@gyblos/payments-x402/inference-buyer';
import { validateSettlement } from '@gyblos/payments-x402/trust';
import { isMain, saveJson } from '@gyblos/runtime';
import { inferenceCeiling } from '@gyblos/seller/inference';
import {
  expectedIrohRoute,
  routesMatchRequired,
} from '@gyblos/transport/route-policy';

import { createCases } from '../inference/cases-data.js';
import { modelTokenizer } from './artifacts.js';
import { trustedOffer } from './buyer.js';
import {
  priorCalls,
  proofObservation,
  readCallMetrics,
  type CallPaymentObservation,
} from './call-evidence.js';
import {
  CALL_OUTCOMES,
  CALL_PHASES,
  P2P_JOURNAL_STATES,
  type CallPhase,
  type P2pJournalState,
} from './constants.js';
import { paymentProof } from './proof.js';
import { rolePath, roleSigner } from './roles.js';

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
  let phase: CallPhase = CALL_PHASES.REQUEST;
  let observedPayment: CallPaymentObservation | undefined;
  let responseObservation: BuyerDiagnosticCode | undefined;
  let authorization: { channelId: string; ceiling: string } | undefined,
    signedAt = performance.now();
  const retainAuthorization = async () => {
    assert.ok(authorization);
    await saveJson(rolePath(P2P.journalFilename), {
      state: P2P_JOURNAL_STATES.AUTHORIZED,
      requestId: request.requestId,
      ...authorization,
      paymentExpectation,
      before,
      runId: process.env.GYBLOS_P2P_RUN_ID,
      observedPayment,
    });
  };
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
      async responseObserved(observation) {
        phase = CALL_PHASES.RESPONSE;
        observedPayment = observation;
        if (authorization) await retainAuthorization();
      },
      responseObservationFailed(code) {
        responseObservation = code;
      },
      async authorized(channelId, amount) {
        authorization = { channelId, ceiling: amount };
        await retainAuthorization();
      },
    },
  );
  try {
    const response = await invoke(
      `http://${LOCALHOST}:${P2P.buyerProxyPort}${ROUTES.inference}`,
      request,
    );
    assert.ok(authorization);
    if (responseObservation) await retainAuthorization(); // Retry before proof.
    assert.equal(authorization.ceiling, ceiling);
    assert.equal(response.status, HTTP_STATUS.ok);
    assert.ok(response.receipt?.transaction);
    phase = CALL_PHASES.PROOF;
    const proof = await paymentProof(
      accounts,
      authorization.channelId,
      ceiling,
      response.receipt.transaction,
      before,
      async (observation) => {
        observedPayment = proofObservation(response.status, observation);
        await retainAuthorization();
      },
    );
    confirmedProof = proof;
    await saveJson(rolePath(P2P.journalFilename), {
      state: JOURNAL_STATES.CONFIRMED,
      requestId: request.requestId,
      channelId: authorization.channelId,
      depositSignature: proof.depositSignature,
      claimSignature: proof.claimSignature,
    });
    phase = CALL_PHASES.SETTLEMENT;
    validateSettlement(response.receipt, {
      payer: buyer.address,
      amount: proof.chargedAtomic,
    });
    phase = CALL_PHASES.OBSERVATION;
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
    phase = CALL_PHASES.MEASUREMENT;
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
    phase = CALL_PHASES.METRICS;
    const metrics = await readCallMetrics(
      rolePath(P2P.metricsFilename),
      request.requestId,
    );
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
      ...(responseObservation ? { responseObservation } : {}),
    };
    phase = CALL_PHASES.PERSISTENCE;
    await saveJson(rolePath(P2P.callsFilename), [
      ...(await priorCalls(rolePath(P2P.callsFilename))),
      result,
    ]);
    console.log(JSON.stringify(result));
    if (!routeAccepted) process.exitCode = 1;
  } catch (error) {
    const result = {
      failure: { phase, code: errorDiagnostic(error) },
      observedPayment,
      ...(responseObservation ? { responseObservation } : {}),
      metrics: await readCallMetrics(
        rolePath(P2P.metricsFilename),
        request.requestId,
      ).catch(() => []),
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
      ...(await priorCalls(rolePath(P2P.callsFilename))),
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
