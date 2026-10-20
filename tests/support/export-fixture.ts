import assert from 'node:assert/strict';
import childProcess, { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { basename } from 'node:path';
import { PassThrough } from 'node:stream';
import type { TestContext } from 'node:test';

import { CHARGE_ANOMALIES } from '@gyblos/application/constants';
import { CALL_OUTCOMES, type CallOutcome } from '@gyblos/cli/p2p/constants';
import { collectDockerCalls } from '@gyblos/cli/p2p/docker-evidence';
import type { paymentProof } from '@gyblos/cli/p2p/proof';
import { P2P } from '@gyblos/config';
import { measurementRow, type Measurement } from '@gyblos/gate/measurements';
import { TRANSPORT_ROUTES } from '@gyblos/transport/constants';
import type { RouteObservation } from '@gyblos/transport/types';

import { paymentFixture, withOfflineProof } from './payment-fixture.js';
import { fullPrincipalRefund, tokenCredit } from './payment-mutations.js';

type Proof = Awaited<ReturnType<typeof paymentProof>>;
interface PaidCall extends Proof {
  outcome: CallOutcome;
  requestId: string;
  channelId: string;
  ceilingAtomic: string;
  measurement: Measurement;
  transport: RouteObservation;
}
interface Trace {
  requestId: string;
  channelId: string;
  during: Proof['before'];
}
type Selection = Parameters<typeof collectDockerCalls>[1];

export async function exportFixture(
  testContext: TestContext,
  fullRefund = true,
) {
  const financial = await paymentFixture();
  if (fullRefund) await fullPrincipalRefund(financial);
  await tokenCredit(financial, 1n);
  const ceiling = BigInt(financial.expected.ceiling),
    runId = randomUUID();
  // Paid journal rows/traces are synthetic and independent of the raw-derived zero-charge proof.
  const paid: PaidCall[] = Array.from(
    { length: P2P.minimumRequests },
    (_, index) => {
      const fields = {
        requestId: 'synthetic-request-' + index,
        channelId: 'synthetic-channel-' + index,
        ceilingAtomic: ceiling.toString(),
        chargedAtomic: '1',
        depositSignature: 'synthetic-deposit-' + index,
        claimSignature: 'synthetic-claim-' + index,
      };
      const measurement = measurementRow(
        {
          ...fields,
          model: { name: 'synthetic-model', digest: 'synthetic-digest' },
          seller: 'synthetic-seller',
          offer: 'synthetic-offer',
          expectedAtomic: '1',
          differenceAtomic: '0',
          allowanceAtomic: '0',
          relativeDifference: 0,
          engineTokens: null,
          billedTokens: null,
          recountedTokens: { input: 1, output: 1 },
          countComparison: null,
          latencyMs: 1,
          delivered: true,
          anomaly: CHARGE_ANOMALIES.NONE,
          responseText: 'synthetic',
        },
        new Uint8Array([0]),
      );
      return {
        ...fields,
        outcome: CALL_OUTCOMES.CONFIRMED,
        refundAtomic: (ceiling - 1n).toString(),
        depositSlot: 100,
        claimSlot: 102,
        before: {
          slot: 99,
          buyer: '10000',
          seller: '0',
          escrow: null,
          buyerLamports: '0',
        },
        after: {
          slot: 103,
          buyer: '9999',
          seller: '1',
          escrow: '0',
          buyerLamports: '0',
        },
        measurement,
        transport: {
          transport: TRANSPORT_ROUTES.DIRECT,
          connectMs: 1,
          directObserved: true,
          relayObserved: false,
        },
      };
    },
  );
  const calls: unknown[] = [
    ...paid,
    {
      outcome: CALL_OUTCOMES.UNCERTAIN,
      requestId: 'independent-zero-charge',
      channelId: financial.expected.channelId,
      ceilingAtomic: financial.expected.ceiling,
    },
  ];
  const traces: Trace[] = paid.map((call) => ({
    requestId: call.requestId,
    channelId: call.channelId,
    during: {
      slot: 101,
      buyer: (10000n - ceiling).toString(),
      seller: '0',
      escrow: ceiling.toString(),
      buyerLamports: '0',
    },
  }));
  const records = [
    {
      channelId: financial.expected.channelId,
      ceilingAtomic: financial.expected.ceiling,
      depositSignature: financial.expected.depositSignature,
      claimSignature: financial.expected.claimSignature,
      chargedAtomic: '0',
      refundAtomic: financial.expected.ceiling,
      treasurySweepAtomic: '0',
      escrowInterveningTokenCreditAtomic: '0',
    },
  ];
  const context: Parameters<typeof collectDockerCalls>[0] = {
    project: 'synthetic-project',
    runId,
    image: 'synthetic-image',
    source: { algorithm: 'synthetic-only', digest: '0'.repeat(64) },
    scenario: 'flat',
    environment: {
      GYBLOS_P2P_RPC: financial.expected.rpcUrl,
      GYBLOS_P2P_RUN_ID: runId,
      GYBLOS_P2P_IMAGE: 'synthetic-image',
      GYBLOS_P2P_ROUTER_IMAGE: '',
      GYBLOS_P2P_USER: P2P.docker.user,
      GYBLOS_P2P_CPUS: String(P2P.docker.cpus),
      GYBLOS_P2P_ACTOR_ENTRY: P2P.actorEntry,
      GYBLOS_P2P_PIDS: String(P2P.docker.processLimit),
      GYBLOS_P2P_SELLER_MEMORY: P2P.docker.sellerMemory,
      GYBLOS_P2P_BUYER_MEMORY: P2P.docker.buyerMemory,
      GYBLOS_P2P_SUBNET: P2P.docker.flatSubnet,
      GYBLOS_P2P_SELLER_IP: P2P.docker.sellerIp,
      GYBLOS_P2P_BUYER_IP: P2P.docker.buyerIp,
    },
    buyerContainer: 'synthetic-buyer',
    sellerContainer: 'synthetic-seller',
    buyer: {
      role: 'buyer',
      buyer: financial.expected.buyer,
      nodeId: 'synthetic-buyer-node',
      keys: [],
    },
    seller: {
      role: 'seller',
      buyer: financial.expected.buyer,
      owner: financial.expected.authorizer,
      authorizer: financial.expected.authorizer,
      facilitator: financial.expected.feePayer,
      payTo: financial.expected.payTo,
      mint: financial.expected.mint,
      nodeId: 'synthetic-seller-node',
      keys: [],
    },
  };
  // Stub only process creation; actual container-read parsing and collector code remain.
  testContext.mock.method(
    childProcess,
    'spawn',
    (command: string, args: readonly string[]) => {
      assert.equal(command, 'docker');
      assert.equal(args[0], 'exec');
      assert.equal(args[2], 'node');
      assert.equal(args[3], '-e');
      const filename = basename(args.at(-1)!);
      assert.ok(
        new Set<string>([
          P2P.callsFilename,
          P2P.traceFilename,
          P2P.reconciliationsFilename,
        ]).has(filename),
      );
      assert.equal(
        args[1],
        filename === P2P.traceFilename
          ? context.sellerContainer
          : context.buyerContainer,
      );
      const payload =
        filename === P2P.callsFilename
          ? calls
          : filename === P2P.traceFilename
            ? traces
            : records;
      const child = new ChildProcess(),
        output = new PassThrough();
      child.stdout = output;
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      queueMicrotask(() => {
        output.end(JSON.stringify(payload));
        child.emit('exit', 0, null);
      });
      return child;
    },
  );
  syncBuiltinESMExports();
  testContext.after(() => {
    testContext.mock.restoreAll();
    syncBuiltinESMExports();
  });
  return {
    financial,
    paid,
    calls,
    traces,
    records,
    collect: (
      selection: Selection = {
        offset: 0,
        expectedRoute: TRANSPORT_ROUTES.DIRECT,
      },
    ) =>
      withOfflineProof(financial, () => collectDockerCalls(context, selection)),
  };
}
