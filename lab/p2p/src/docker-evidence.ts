import assert from 'node:assert/strict';

import { CALL_OUTCOMES, type CallOutcome } from '@gyblos/buyer/constants';
import type { paymentProof } from '@gyblos/buyer/proof';
import {
  verifyZeroChargeReconciliation,
  type ReconciliationSignatures,
} from '@gyblos/buyer/reconciliation';
import { IROH_SDK_VERSION, P2P, X402_SDK_VERSION } from '@gyblos/config';
import type { Measurement } from '@gyblos/node/measurements';
import { saveJson } from '@gyblos/runtime';
import type { RouteObservation } from '@gyblos/transport-iroh';
import { TRANSPORT_ROUTES } from '@gyblos/transport-iroh/constants';
import { routesMatchRequired } from '@gyblos/transport-iroh/route-policy';

import type { inspectDocker } from './docker-checks.js';
import { readContainerJson } from './docker-command.js';
import type { prepareDocker } from './docker-prepare.js';

interface PaidCall extends Awaited<ReturnType<typeof paymentProof>> {
  requestId: string;
  outcome: CallOutcome;
  runId?: string;
  channelId: string;
  ceilingAtomic: string;
  measurement: Measurement;
  transport: RouteObservation;
}
interface ReconciledAttempt extends ReconciliationSignatures {
  sourceFingerprint?: string;
  runtimeImage?: string;
  httpStatus?: number;
}

interface Trace {
  requestId: string;
  channelId: string;
  during: Awaited<ReturnType<typeof paymentProof>>['before'];
}

function atomicAmount(value: unknown): bigint {
  assert.ok(typeof value === 'string', 'Atomic amounts must be strings.');
  assert.match(value, /^(0|[1-9]\d*)$/, 'Invalid atomic amount.');
  return BigInt(value);
}

function preInferenceEvidence(call: PaidCall, traces: Trace[]) {
  assert.ok(typeof call.requestId === 'string' && call.requestId.trim());
  assert.ok(typeof call.channelId === 'string' && call.channelId.trim());
  const matchingTraces = traces.filter(
    (trace) =>
      trace.channelId === call.channelId || trace.requestId === call.requestId,
  );
  assert.equal(
    matchingTraces.length,
    1,
    'A unique matching trace is required.',
  );
  const trace = matchingTraces[0]!;
  assert.equal(trace.channelId, call.channelId);
  assert.equal(trace.requestId, call.requestId);
  const ceiling = atomicAmount(call.ceilingAtomic);
  assert.ok(ceiling > 0n, 'The original ceiling must be positive.');
  assert.equal(
    atomicAmount(call.chargedAtomic) + atomicAmount(call.refundAtomic),
    ceiling,
    'Principal settlement must equal the original ceiling.',
  );
  const observedEscrow = atomicAmount(trace.during.escrow);
  assert.ok(
    observedEscrow >= ceiling,
    'The observed escrow must cover principal.',
  );
  atomicAmount(trace.during.seller);
  atomicAmount(call.before.seller);
  assert.equal(trace.during.seller, call.before.seller);
  return {
    trace,
    preInferenceEscrowExcessAtomic: (observedEscrow - ceiling).toString(),
  };
}

export async function collectDockerCalls(
  context: Awaited<ReturnType<typeof prepareDocker>>,
  selection: {
    offset: number;
    expectedRoute:
      typeof TRANSPORT_ROUTES.DIRECT | typeof TRANSPORT_ROUTES.RELAY;
  },
) {
  const allCalls = await readContainerJson<PaidCall[]>(
    context.buyerContainer,
    `${P2P.root}/${P2P.callsFilename}`,
  );
  const calls = allCalls.slice(selection.offset);
  const traces = await readContainerJson<Trace[]>(
    context.sellerContainer,
    `${P2P.root}/${P2P.traceFilename}`,
  );
  let reconciliations: ReconciledAttempt[] = [];
  try {
    reconciliations = await readContainerJson<ReconciledAttempt[]>(
      context.buyerContainer,
      `${P2P.root}/${P2P.reconciliationsFilename}`,
    );
  } catch {
    assert.ok(
      calls.every((call) => call.outcome === CALL_OUTCOMES.CONFIRMED),
      'An unresolved call prevents passing evidence.',
    );
  }
  const previousAttempts = await Promise.all(
    calls
      .filter((call) => call.outcome !== CALL_OUTCOMES.CONFIRMED)
      .map(async (call) => {
        assert.equal(
          call.outcome,
          CALL_OUTCOMES.UNCERTAIN,
          'A known paid outcome or route discrepancy cannot become zero-charge evidence.',
        );
        const record = reconciliations
          .slice()
          .reverse()
          .find((item) => item.channelId === call.channelId);
        assert.ok(record, 'Verified reconciliation signatures are required.');
        // Bind the record before constructing RPC inputs or trusting any claimed balances.
        assert.equal(record.ceilingAtomic, call.ceilingAtomic);
        const proof = await verifyZeroChargeReconciliation(
          {
            rpcUrl: context.environment.GYBLOS_P2P_RPC!,
            buyer: context.buyer.buyer,
            mint: context.seller.mint,
            payTo: context.seller.payTo,
            feePayer: context.seller.facilitator,
            authorizer: context.seller.authorizer,
          },
          call,
          record,
        );
        return {
          ...proof,
          initialOutcome: CALL_OUTCOMES.UNCERTAIN,
          reconciledOutcome: proof.status,
          sourceFingerprint: record.sourceFingerprint ?? null,
          runtimeImage: record.runtimeImage ?? null,
          httpStatus: record.httpStatus ?? null,
          reason:
            'Financial state reverified from finalized chain data; historical source/image claims are operator supplied and unverified.',
        };
      }),
  );
  const confirmedCalls = calls.filter(
    (call) => call.outcome === CALL_OUTCOMES.CONFIRMED,
  );
  assert.equal(confirmedCalls.length, P2P.minimumRequests);
  assert.equal(
    new Set(confirmedCalls.map((call) => call.channelId)).size,
    confirmedCalls.length,
    'Confirmed calls must use distinct channels.',
  );
  assert.equal(
    new Set(confirmedCalls.map((call) => call.requestId)).size,
    confirmedCalls.length,
    'Confirmed calls must use distinct requests.',
  );
  const cases = confirmedCalls.map((call, index) => {
    assert.equal(call.outcome, CALL_OUTCOMES.CONFIRMED);
    assert.ok(
      routesMatchRequired([call.transport], selection.expectedRoute),
      'Mixed or unexpected routes cannot pass a required-route gate.',
    );
    const { trace, preInferenceEscrowExcessAtomic } = preInferenceEvidence(
      call,
      traces,
    );
    return {
      case: index + 1,
      outcome: call.outcome,
      transport: call.transport.transport,
      connectMs: call.transport.connectMs,
      directObserved: call.transport.directObserved,
      relayObserved: call.transport.relayObserved,
      channelId: call.channelId,
      ceilingAtomic: call.ceilingAtomic,
      preInferenceEscrowExcessAtomic,
      chargedAtomic: call.chargedAtomic,
      refundAtomic: call.refundAtomic,
      depositSignature: call.depositSignature,
      claimSignature: call.claimSignature,
      depositSlot: call.depositSlot,
      claimSlot: call.claimSlot,
      balances: {
        before: call.before,
        depositConfirmed: trace.during,
        after: call.after,
      },
      latencyMs: call.measurement.latencyMs,
      effectiveTokensPerSecond: call.measurement.effectiveTokensPerSecond,
      recountedTokens: call.measurement.recountedTokens,
      engineTokens: call.measurement.engineTokens,
      countComparison: call.measurement.countComparison,
      delivered: call.measurement.delivered,
      anomaly: call.measurement.anomaly,
      meteringMode: call.measurement.meteringMode,
      generationAfterConfirmedDeposit: true,
      generationOrderEvidence:
        'Canonical deposit admission and full escrow snapshot precede the awaited inference hook; local labels are not independent engine-start timing.',
    };
  });
  return { cases, previousAttempts };
}

export async function dockerEvidence(
  context: Awaited<ReturnType<typeof prepareDocker>>,
  security: Awaited<ReturnType<typeof inspectDocker>>,
  fundingSignature: string,
) {
  const { cases, previousAttempts } = await collectDockerCalls(context, {
    offset: 0,
    expectedRoute: TRANSPORT_ROUTES.DIRECT,
  });
  const evidence = {
    schemaVersion: 1,
    evidenceId: 'GYB-GATE-0006',
    source: context.source,
    runId: context.runId,
    recordedAt: new Date().toISOString(),
    status: 'partial',
    network: 'solana-devnet',
    assetLabel: 'devnet-test-token',
    mint: context.seller.mint,
    sdk: { iroh: IROH_SDK_VERSION, x402: X402_SDK_VERSION },
    images: {
      runtime: context.image,
      node: P2P.docker.nodeImage,
      ollama: P2P.docker.ollamaImage,
    },
    fundingSignature,
    previousAttempts,
    security,
    scenarios: {
      flat: { status: 'passed', cases },
      natDirect: { status: 'not-run' },
      natRelay: { status: 'not-run' },
    },
    limitations: [
      'Flat Docker networking validates native Iroh inference and devnet payments, not NAT traversal.',
      'NAT routers and UDP-blocked relay fallback have not been executed.',
      'Real separate-network Mac/VPS/mobile routes are not tested.',
      'No content correctness, model authenticity, MPP, streaming, registry or reputation validation.',
      'Routes are sampled observations, not proof of the path taken by every packet.',
      'Direct peers can see each other IP addresses; relay-only mode requires an off-host empirical test.',
      'Synthetic prompts only. Public output excludes keys, salts, content, signed payloads, RPC URLs and endpoint IP addresses.',
    ],
  };
  await saveJson(P2P.docker.evidence, evidence);
  return evidence;
}
