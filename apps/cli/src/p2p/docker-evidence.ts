import assert from 'node:assert/strict';

import { IROH_SDK_VERSION, P2P, X402_SDK_VERSION } from '@gyblos/config';
import type { Measurement } from '@gyblos/gate/measurements';
import { saveJson } from '@gyblos/runtime';

import type { inspectDocker } from './docker-checks.js';
import { readContainerJson } from './docker-command.js';
import type { prepareDocker } from './docker-prepare.js';
import type { paymentProof } from './proof.js';

interface PaidCall extends Awaited<ReturnType<typeof paymentProof>> {
  outcome: string;
  channelId: string;
  ceilingAtomic: string;
  measurement: Measurement;
  transport: {
    transport: string;
    connectMs: number;
    directObserved: boolean;
    relayObserved: boolean;
  };
}
interface ReconciledAttempt {
  channelId: string;
  sourceFingerprint: string;
  runtimeImage: string;
  httpStatus: number;
  status: 'finalized-zero-charge';
  reason?: string;
  ceilingAtomic: string;
  chargedAtomic: '0';
  refundAtomic: string;
  depositSignature: string;
  claimSignature: string;
  balances: Awaited<ReturnType<typeof paymentProof>>['after'];
}

interface Trace {
  channelId: string;
  depositConfirmedAt: string;
  engineStartedAt: string;
  during: Awaited<ReturnType<typeof paymentProof>>['before'];
}

export async function collectDockerCalls(
  context: Awaited<ReturnType<typeof prepareDocker>>,
  selection: { offset: number; expectedRoute: 'iroh-direct' | 'iroh-relay' },
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
      calls.every((call) => call.outcome === 'confirmed'),
      'An unresolved call prevents passing evidence.',
    );
  }
  const previousAttempts = calls
    .filter((call) => call.outcome !== 'confirmed')
    .map((call) => {
      const proof = reconciliations.find(
        (item) => item.channelId === call.channelId,
      );
      assert.ok(proof);
      assert.equal(proof.status, 'finalized-zero-charge');
      assert.equal(proof.chargedAtomic, '0');
      assert.equal(proof.refundAtomic, proof.ceilingAtomic);
      assert.equal(proof.balances.escrow, '0');
      return {
        channelId: proof.channelId,
        initialOutcome: 'uncertain',
        sourceFingerprint: proof.sourceFingerprint,
        runtimeImage: proof.runtimeImage,
        httpStatus: proof.httpStatus,
        reconciledOutcome: proof.status,
        ceilingAtomic: proof.ceilingAtomic,
        chargedAtomic: proof.chargedAtomic,
        refundAtomic: proof.refundAtomic,
        depositSignature: proof.depositSignature,
        claimSignature: proof.claimSignature,
        balances: proof.balances,
        reason:
          proof.reason ??
          'Manual finalized zero-charge/full-return reconciliation; retain per-attempt provenance.',
      };
    });
  const confirmedCalls = calls.filter((call) => call.outcome === 'confirmed');
  assert.equal(confirmedCalls.length, P2P.minimumRequests);
  const cases = confirmedCalls.map((call, index) => {
    assert.equal(call.outcome, 'confirmed');
    assert.equal(call.transport.transport, selection.expectedRoute);
    const trace = traces.find((trace) => trace.channelId === call.channelId);
    assert.ok(trace);
    assert.equal(trace.during.escrow, call.ceilingAtomic);
    assert.equal(trace.during.seller, call.before.seller);
    assert.ok(trace.depositConfirmedAt <= trace.engineStartedAt);
    return {
      case: index + 1,
      outcome: call.outcome,
      transport: call.transport.transport,
      connectMs: call.transport.connectMs,
      directObserved: call.transport.directObserved,
      relayObserved: call.transport.relayObserved,
      channelId: call.channelId,
      ceilingAtomic: call.ceilingAtomic,
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
    expectedRoute: 'iroh-direct',
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
