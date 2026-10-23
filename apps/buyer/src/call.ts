// CLI for one paid inference call on a synthetic case: checks budget and model, journals the
// authorization before paying, proves the payment on chain and records the call and its measurement.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { HTTP_STATUS, LOCALHOST, PORTS, ROUTES } from '@gyblos/config';
import { ROLE_FILES } from '@gyblos/config/home';
import { OFFER_ID } from '@gyblos/core/constants';
import { observeInferenceResponse } from '@gyblos/core/inference-observation';
import { assessCharge, charge } from '@gyblos/core/metering';
import { modelTokenizer } from '@gyblos/node/artifacts';
import { P2P_ROLES } from '@gyblos/node/constants';
import { assertRoleHome } from '@gyblos/node/home';
import { inferenceCeiling } from '@gyblos/node/http/inference';
import { roleDirectory, rolePath, roleSigner } from '@gyblos/node/roles';
import { inferenceSnapshot } from '@gyblos/payments-x402/accounting/chain';
import { assertProgram } from '@gyblos/payments-x402/chain';
import {
  JOURNAL_STATES,
  type BuyerDiagnosticCode,
} from '@gyblos/payments-x402/constants';
import { createInferenceBuyer } from '@gyblos/payments-x402/inference-buyer';
import { withExclusiveLock } from '@gyblos/payments-x402/recovery/lock';
import { validateSettlement } from '@gyblos/payments-x402/trust';
import { isMain, saveJson } from '@gyblos/runtime';
import {
  expectedIrohRoute,
  routesMatchRequired,
} from '@gyblos/transport-iroh/route-policy';

import { trustedOffer } from './buyer.js';
import {
  assertPriorCallResolved,
  priorCalls,
  proofObservation,
  readCallMetrics,
  type CallPaymentObservation,
} from './call-evidence.js';
import {
  CALL_OUTCOMES,
  CALL_PHASES,
  MINIMUM_REQUESTS,
  P2P_JOURNAL_STATES,
  type CallPhase,
} from './constants.js';
import { errorDiagnostic } from './diagnostics.js';
import {
  appendMeasurement,
  measurementRow,
  measurementSalt,
} from './measurements.js';
import { paymentProof } from './proof.js';
import { createCases } from './synthetic-cases.js';

const buyerPath = (name: string) => rolePath(P2P_ROLES.BUYER, name);

type CallContext = Awaited<ReturnType<typeof prepareCall>>;
type CallResponse = Awaited<
  ReturnType<ReturnType<typeof createInferenceBuyer>>
>;
type ConfirmedProof = Awaited<ReturnType<typeof paymentProof>>;
interface CallState {
  confirmedProof?: ConfirmedProof;
  phase: CallPhase;
  observedPayment?: CallPaymentObservation;
  responseObservation?: BuyerDiagnosticCode;
  authorization?: { channelId: string; ceiling: string };
  signedAt: number;
}

async function prepareCall() {
  const requiredRoute = expectedIrohRoute(process.env.GYBLOS_EXPECTED_ROUTE);
  const { config, offer, trust } = await trustedOffer();
  await assertProgram(config.rpcUrl);
  await assertPriorCallResolved(buyerPath(ROLE_FILES.journal));
  const index = Number(process.argv[2]);
  if (!Number.isInteger(index) || index < 0 || index >= MINIMUM_REQUESTS)
    throw new Error('Select a synthetic case index.');
  const testCase = createCases(randomUUID(), randomUUID())[index]!;
  const request = {
    requestId: testCase.requestId,
    prompt: testCase.prompt,
    maxTokens: offer.maxTokens,
  };
  const tokenizer = await modelTokenizer();
  const ceiling = inferenceCeiling(
    request,
    tokenizer,
    offer.model.contextTokens,
  );
  if (
    BigInt(ceiling) > BigInt(trust.maxAtomic) ||
    BigInt(ceiling) > BigInt(offer.maxAtomic) ||
    offer.model.digest === undefined
  )
    throw new Error('Local budget or model mismatch.');
  const buyer = await roleSigner(P2P_ROLES.BUYER, 'buyer');
  const accounts = {
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
  return {
    requiredRoute,
    config,
    offer,
    trust,
    request,
    testCase,
    tokenizer,
    ceiling,
    buyer,
    accounts,
    before,
    paymentExpectation,
  };
}

async function retainCallAuthorization(context: CallContext, state: CallState) {
  const { request, before, paymentExpectation } = context;
  assert.ok(state.authorization);
  await saveJson(buyerPath(ROLE_FILES.journal), {
    state: P2P_JOURNAL_STATES.AUTHORIZED,
    requestId: request.requestId,
    ...state.authorization,
    paymentExpectation,
    before,
    runId: process.env.GYBLOS_P2P_RUN_ID,
    observedPayment: state.observedPayment,
  });
}

function callInvoker(
  context: CallContext,
  state: CallState,
  retainAuthorization: () => Promise<void>,
) {
  const { config, offer, ceiling, buyer, before } = context;
  return createInferenceBuyer(
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
        state.signedAt = performance.now();
      },
      async responseObserved(observation) {
        state.phase = CALL_PHASES.RESPONSE;
        state.observedPayment = observation;
        if (state.authorization) await retainAuthorization();
      },
      responseObservationFailed(code) {
        state.responseObservation = code;
      },
      async authorized(channelId, amount) {
        state.authorization = { channelId, ceiling: amount };
        await retainAuthorization();
      },
    },
  );
}

async function confirmCallPayment(
  context: CallContext,
  state: CallState,
  response: CallResponse,
  retainAuthorization: () => Promise<void>,
) {
  const { request, ceiling, buyer, accounts, before } = context;
  assert.ok(state.authorization);
  if (state.responseObservation) await retainAuthorization(); // Retry before proof.
  assert.equal(state.authorization.ceiling, ceiling);
  assert.equal(response.status, HTTP_STATUS.ok);
  assert.ok(response.receipt?.transaction);
  state.phase = CALL_PHASES.PROOF;
  const proof = await paymentProof(
    accounts,
    state.authorization.channelId,
    ceiling,
    response.receipt.transaction,
    before,
    async (observation) => {
      state.observedPayment = proofObservation(response.status, observation);
      await retainAuthorization();
    },
  );
  state.confirmedProof = proof;
  await saveJson(buyerPath(ROLE_FILES.journal), {
    state: JOURNAL_STATES.CONFIRMED,
    requestId: request.requestId,
    channelId: state.authorization.channelId,
    depositSignature: proof.depositSignature,
    claimSignature: proof.claimSignature,
  });
  state.phase = CALL_PHASES.SETTLEMENT;
  validateSettlement(response.receipt, {
    payer: buyer.address,
    amount: proof.chargedAtomic,
  });
  return proof;
}

async function measureCallDelivery(
  context: CallContext,
  state: CallState,
  response: CallResponse,
  proof: ConfirmedProof,
) {
  const { offer, request, tokenizer, ceiling } = context;
  state.phase = CALL_PHASES.OBSERVATION;
  const observation = observeInferenceResponse({
    status: response.status,
    body: response.body,
    expected: {
      requestId: request.requestId,
      offer: OFFER_ID,
      model: offer.model.name,
      digest: offer.model.digest!,
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
  state.phase = CALL_PHASES.MEASUREMENT;
  const row = measurementRow(
    {
      requestId: request.requestId,
      model: { name: offer.model.name, digest: offer.model.digest! },
      seller: offer.payTo,
      offer: OFFER_ID,
      channelId: state.authorization!.channelId,
      depositSignature: proof.depositSignature,
      claimSignature: proof.claimSignature,
      ceilingAtomic: ceiling,
      chargedAtomic: proof.chargedAtomic,
      ...assessment,
      engineTokens: observation.engineTokens,
      billedTokens: observation.body.billedTokens ?? null,
      recountedTokens: observation.recounted,
      countComparison: observation.comparison,
      latencyMs: response.receivedAt - state.signedAt,
      delivered: observation.delivered,
      anomaly: assessment.anomaly,
      responseText: observation.text,
      meteringMode: offer.meteringMode,
    },
    await measurementSalt(roleDirectory(P2P_ROLES.BUYER)),
  );
  await appendMeasurement(row, buyerPath(ROLE_FILES.measurements));
  return row;
}

async function recordCallSuccess(
  context: CallContext,
  state: CallState,
  proof: ConfirmedProof,
  row: Awaited<ReturnType<typeof measureCallDelivery>>,
) {
  const { requiredRoute, request, testCase, ceiling } = context;
  state.phase = CALL_PHASES.METRICS;
  const metrics = await readCallMetrics(
    buyerPath(ROLE_FILES.metrics),
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
    channelId: state.authorization!.channelId,
    ceilingAtomic: ceiling,
    ...proof,
    measurement: row,
    transport: paid,
    metrics,
    ...(state.responseObservation
      ? { responseObservation: state.responseObservation }
      : {}),
  };
  state.phase = CALL_PHASES.PERSISTENCE;
  await saveJson(buyerPath(ROLE_FILES.calls), [
    ...(await priorCalls(buyerPath(ROLE_FILES.calls))),
    result,
  ]);
  console.log(JSON.stringify(result));
  if (!routeAccepted) process.exitCode = 1;
}

async function recordCallFailure(
  context: CallContext,
  state: CallState,
  error: unknown,
) {
  const { request, testCase, ceiling, before, paymentExpectation } = context;

  const result = {
    failure: { phase: state.phase, code: errorDiagnostic(error) },
    observedPayment: state.observedPayment,
    ...(state.responseObservation
      ? { responseObservation: state.responseObservation }
      : {}),
    metrics: await readCallMetrics(
      buyerPath(ROLE_FILES.metrics),
      request.requestId,
    ).catch(() => []),
    requestId: request.requestId,
    case: testCase.name,
    outcome: state.confirmedProof
      ? CALL_OUTCOMES.CONFIRMED_ERROR
      : state.authorization
        ? CALL_OUTCOMES.UNCERTAIN
        : CALL_OUTCOMES.REJECTED,
    channelId: state.authorization?.channelId,
    ceilingAtomic: ceiling,
    before,
    paymentExpectation,
    runId: process.env.GYBLOS_P2P_RUN_ID,
    ...(state.confirmedProof ?? {}),
  };
  if (state.authorization && !state.confirmedProof)
    await saveJson(buyerPath(ROLE_FILES.journal), {
      state: JOURNAL_STATES.UNCERTAIN,
      ...result,
    });
  await saveJson(buyerPath(ROLE_FILES.calls), [
    ...(await priorCalls(buyerPath(ROLE_FILES.calls))),
    result,
  ]);
  console.error(JSON.stringify(result));
  process.exitCode = 1;
}

async function run() {
  const context = await prepareCall();
  const state: CallState = {
    phase: CALL_PHASES.REQUEST,
    signedAt: performance.now(),
  };
  const retainAuthorization = () => retainCallAuthorization(context, state);
  const invoke = callInvoker(context, state, retainAuthorization);
  try {
    const response = await invoke(
      `http://${LOCALHOST}:${PORTS.buyerProxy}${ROUTES.inference}`,
      context.request,
    );
    const proof = await confirmCallPayment(
      context,
      state,
      response,
      retainAuthorization,
    );
    const row = await measureCallDelivery(context, state, response, proof);
    await recordCallSuccess(context, state, proof, row);
  } catch (error) {
    await recordCallFailure(context, state, error);
  }
}

export async function main() {
  await assertRoleHome(P2P_ROLES.BUYER); // The lock would create the directory.
  return withExclusiveLock(buyerPath(ROLE_FILES.buyerLock), run);
}

if (isMain(import.meta.url)) await main();
