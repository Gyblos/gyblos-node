import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Server } from 'node:http';
import { loadConfig, saveJson, signer } from '../../../scripts/config.js';
import { withExclusiveLock } from '../../../scripts/lock.js';
import { assertNoUnresolvedAuthorizations } from '../../../scripts/journal.js';
import {
  appendMeasurement,
  measurementRow,
  measurementSalt,
} from '../../../scripts/measurements.js';
import {
  inferenceSnapshot,
  confirmInference,
  readChain,
  tokenAddress,
  transaction,
  transactionTransfers,
} from '../../../scripts/inference-chain.js';
import {
  createOllama,
  createModelTokenizer,
  MODEL,
  type EngineUsage,
} from '../../../packages/inference-ollama/src/index.js';
import {
  assessCharge,
  charge,
  compareUsage,
  OFFER_ID,
  PRICES,
  TOLERANCE,
} from '../../../packages/application/src/metering.js';
import { createInferenceBuyer } from '../../../packages/payments-x402/src/inference-buyer.js';
import {
  assertProgram,
  GateError,
  lamports,
} from '../../../packages/payments-x402/src/chain.js';
import {
  DEVNET,
  DEVNET_USDC,
} from '../../../packages/payments-x402/src/constants.js';
import type { SettlementEvent } from '../../../packages/payments-x402/src/facilitator.js';
import { validateSettlement } from '../../../packages/payments-x402/src/trust.js';
import {
  createInferenceSeller,
  inferenceCeiling,
} from '../../seller/src/inference.js';

const evidencePath = 'evidence/gate-0005.json';
const journalPath = '.local/devnet/inference-attempt.json';
const ollamaUrl = 'http://127.0.0.1:11436';
const facilitatorUrl = 'http://127.0.0.1:4022';
const runId = randomUUID();
const children: ChildProcess[] = [];
const controller = new AbortController();
let sellerServer: Server | undefined;
const stop = () => controller.abort(new Error('Gate interrupted.'));
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

async function stopChild(
  child: ChildProcess,
  signal: NodeJS.Signals = 'SIGTERM',
) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill(signal);
  await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(resolve, 2000)),
  ]);
  if (child.exitCode === null && child.signalCode === null)
    child.kill('SIGKILL');
}
async function waitReady(
  child: ChildProcess,
  url: string,
  expectedRunId?: string,
) {
  for (let i = 0; i < 120; i++) {
    controller.signal.throwIfAborted();
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error('Gate-owned host exited during startup.');
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(500) });
      if (response.ok) {
        const body = (await response.json()) as { runId?: string };
        if (expectedRunId && body.runId !== expectedRunId)
          throw new GateError('PORT_BUSY', 'Host is not owned by this gate.');
        return;
      }
    } catch (error) {
      if (error instanceof GateError) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Gate host startup timeout.');
}
async function assertPortFree(url: string) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(500) });
  } catch {
    return;
  }
  throw new GateError('PORT_BUSY', 'Gate requires an unused local host port.');
}

async function run() {
  const c = await loadConfig();
  // This gate accepts only isolated setup keys, never imported wallet paths.
  assert.equal(
    c.mint,
    c.assetLabel === 'devnet-usdc' ? DEVNET_USDC : c.addresses.mint,
  );
  for (const role of [
    'buyer',
    'seller',
    'authorizer',
    'facilitator',
  ] as const) {
    assert.equal(resolve(c.keys[role]), resolve(`.local/devnet/${role}.json`));
  }
  await assertNoUnresolvedAuthorizations();
  await assertProgram(c.rpcUrl);
  assert.ok(
    (await lamports(c.rpcUrl, c.addresses.facilitator)) > 15_000_000n,
    'Facilitator needs devnet SOL for five channels.',
  );
  const artifacts = {
    tokenizer: await readFile('.local/devnet/tokenizer/tokenizer.json', 'utf8'),
    config: await readFile(
      '.local/devnet/tokenizer/tokenizer_config.json',
      'utf8',
    ),
  };
  const buyerTokenizer = createModelTokenizer(artifacts);
  const sellerTokenizer = createModelTokenizer(artifacts);
  const salt = await measurementSalt();
  const evidence: Record<string, any> = {
    schemaVersion: 1,
    evidenceId: 'GYB-GATE-0005',
    sdkVersion: '2.28.0',
    createdAt: new Date().toISOString(),
    runId,
    network: DEVNET,
    mint: c.mint,
    assetLabel: c.assetLabel,
    model: MODEL,
    prices: PRICES,
    tolerance: TOLERANCE,
    template: {
      raw: true,
      thinking: false,
      numCtx: 2048,
      seed: 42,
      temperature: 0,
      outputCountConvention:
        'Visible raw output only; terminal EOS is not added. Differences remain explicit under predeclared tolerance.',
    },
    status: 'in-progress',
    gatePassed: false,
    results: [],
    limitations: [
      'Measurements are local buyer declarations without a signed seller receipt',
      'No buyer-facing streaming or first-word latency; effective TPS includes payment and settlement',
      'Does not validate the model (LOGIC), MPP, Iroh, reputation scores or penalties',
      'Uses an explicitly labeled devnet asset, never mainnet',
      'In-memory facilitator; uncertain outcomes require manual on-chain reconciliation',
      'Detecting within-ceiling overcharge does not prevent or refund it; REV-13 remains open',
      'Only the pinned single-user no-tools chat template branch is supported',
    ],
  };
  try {
    const previous = JSON.parse(await readFile(evidencePath, 'utf8'));
    evidence.previousAttempts = [
      ...(previous.previousAttempts ?? []),
      { ...previous, previousAttempts: undefined },
    ];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await saveJson(evidencePath, evidence);
  try {
    await assertPortFree(`${ollamaUrl}/api/version`);
    await assertPortFree(`${facilitatorUrl}/health`);
    const ollama = spawn('ollama', ['serve'], {
      env: {
        ...process.env,
        OLLAMA_HOST: '127.0.0.1:11436',
        OLLAMA_MODELS: resolve('.local/ollama/models'),
        OLLAMA_NO_CLOUD: '1',
        OLLAMA_DEBUG: '0',
        OLLAMA_CONTEXT_LENGTH: '2048',
      },
      stdio: 'ignore',
    });
    children.push(ollama);
    ollama.on('error', stop);
    await waitReady(ollama, `${ollamaUrl}/api/version`);
    await createOllama(ollamaUrl).assertModel();
    evidence.ollamaVersion = (
      (await fetch(`${ollamaUrl}/api/version`).then((r) => r.json())) as {
        version: string;
      }
    ).version;
    const facilitator = spawn(
      process.execPath,
      ['--import', 'tsx', 'apps/facilitator/src/main.ts'],
      { env: { ...process.env, GYBLOS_GATE_RUN_ID: runId }, stdio: 'ignore' },
    );
    children.push(facilitator);
    facilitator.on('error', stop);
    await waitReady(facilitator, `${facilitatorUrl}/health`, runId);
    const debugRequestId = randomUUID(),
      failureRequestId = randomUUID();
    const traces = new Map<
      string,
      {
        channelId: string;
        depositConfirmedAt: string;
        engineStartedAt: string;
        during: Awaited<ReturnType<typeof inferenceSnapshot>>;
        firstFragmentAt?: string;
        stoppedAt?: string;
        stoppedSignal?: string;
      }
    >();
    const events = async () =>
      (await fetch(`${facilitatorUrl}/gate/events`, {
        signal: AbortSignal.timeout(5000),
      }).then((r) => r.json())) as SettlementEvent[];
    const host = await createInferenceSeller({
      rpcUrl: c.rpcUrl,
      facilitatorUrl,
      ollamaUrl,
      mint: c.mint,
      payTo: c.addresses.seller,
      authorizer: await signer(c, 'authorizer'),
      tokenizer: sellerTokenizer,
      debugOverchargeRequestId: debugRequestId,
      async beforeInference(requestId, channelId) {
        const deposit = (await events()).find(
          (item) =>
            item.channelId === channelId &&
            item.phase === 'deposit' &&
            item.success,
        );
        assert.ok(deposit?.transaction);
        await confirmInference(c, deposit.transaction);
        const depositConfirmedAt = new Date().toISOString();
        const during = await inferenceSnapshot(c, channelId);
        traces.set(requestId, {
          channelId,
          depositConfirmedAt,
          during,
          engineStartedAt: new Date().toISOString(),
        });
        evidence.engineTraces = Object.fromEntries(traces);
        await saveJson(evidencePath, evidence);
      },
      async onFragment(requestId) {
        const trace = traces.get(requestId)!;
        const firstFragment = !trace.firstFragmentAt;
        trace.firstFragmentAt ??= new Date().toISOString();
        if (requestId === failureRequestId && !trace.stoppedAt) {
          trace.stoppedAt = new Date().toISOString();
          trace.stoppedSignal = 'SIGKILL';
          await saveJson(evidencePath, evidence);
          await stopChild(ollama, 'SIGKILL');
        } else if (firstFragment) {
          await saveJson(evidencePath, evidence);
        }
      },
    });
    sellerServer = host.app.listen(0, '127.0.0.1');
    await once(sellerServer, 'listening');
    const endpoint = sellerServer.address();
    assert.ok(endpoint && typeof endpoint !== 'string');
    const url = `http://127.0.0.1:${endpoint.port}/v1/chat/completions`;
    const cases = [
      {
        name: 'honest-1',
        requestId: randomUUID(),
        prompt: 'Explain in three short sentences how rain forms.',
      },
      {
        name: 'honest-2',
        requestId: randomUUID(),
        prompt: 'Explain in three short sentences why plants need sunlight.',
      },
      {
        name: 'honest-3',
        requestId: randomUUID(),
        prompt: 'Explain in three short sentences how a bicycle moves.',
      },
      {
        name: 'overcharge',
        requestId: debugRequestId,
        prompt: 'Explain in four sentences how a seed becomes a tree.',
      },
      {
        name: 'engine-interrupted',
        requestId: failureRequestId,
        prompt:
          'Describe in detail the water cycle in ten numbered paragraphs.',
      },
    ];
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
      await saveJson('.local/devnet/inference-last-transport.json', {
        requestId: request.requestId,
        httpStatus: response.status,
        receipt: response.receipt,
        events: await events(),
      });
      assert.ok(channelId && signedAt !== undefined);
      const correlated = (await events()).filter(
        (event) => event.channelId === channelId,
      );
      const deposit = correlated.find(
        (event) => event.phase === 'deposit' && event.success,
      );
      const claim = correlated.find(
        (event) => event.phase === 'claim' && event.success,
      );
      assert.ok(deposit?.transaction && claim?.transaction);
      await confirmInference(c, deposit.transaction);
      await confirmInference(c, claim.transaction);
      const actual = BigInt(claim.amount);
      assert.ok(actual <= BigInt(ceiling));
      assert.equal(deposit.amount, ceiling);
      assert.ok(response.receipt);
      validateSettlement(response.receipt, {
        payer: c.addresses.buyer,
        amount: claim.amount,
      });
      assert.equal(response.receipt.transaction, claim.transaction);
      const after = await inferenceSnapshot(c, channelId);
      const trace = traces.get(request.requestId);
      assert.ok(trace);
      assert.equal(
        BigInt(before.buyer) - BigInt(trace.during.buyer),
        BigInt(ceiling),
      );
      assert.equal(trace.during.seller, before.seller);
      assert.equal(trace.during.escrow, ceiling);
      assert.equal(BigInt(before.buyer) - BigInt(after.buyer), actual);
      assert.equal(BigInt(after.seller) - BigInt(before.seller), actual);
      assert.equal(after.buyerLamports, before.buyerLamports);
      assert.equal(after.escrow, '0');
      const openTx = await transaction(c, deposit.transaction);
      const claimTx = await transaction(c, claim.transaction);
      const buyerAta = await tokenAddress(c.addresses.buyer, c.mint),
        sellerAta = await tokenAddress(c.addresses.seller, c.mint),
        escrowAta = await tokenAddress(channelId, c.mint);
      const openTransfers = transactionTransfers(openTx),
        claimTransfers = transactionTransfers(claimTx);
      const sum = (
        list: typeof openTransfers,
        source: string,
        destination: string,
      ) =>
        list
          .filter(
            (item) =>
              item.mint === c.mint &&
              item.source === source &&
              item.destination === destination,
          )
          .reduce((total, item) => total + BigInt(item.amount), 0n);
      assert.equal(sum(openTransfers, buyerAta, escrowAta), BigInt(ceiling));
      assert.equal(sum(claimTransfers, escrowAta, sellerAta), actual);
      assert.equal(
        sum(claimTransfers, escrowAta, buyerAta),
        BigInt(ceiling) - actual,
      );
      const failed = testCase.name === 'engine-interrupted';
      const body = response.body as {
        requestId: string;
        offer?: string;
        model?: string;
        digest?: string;
        content?: string;
        usage?: EngineUsage;
        billedTokens?: { input: number; output: number };
        done?: boolean;
        doneReason?: string;
      };
      assert.equal(body.requestId, request.requestId);
      const text = typeof body.content === 'string' ? body.content : '';
      const recounted = {
        input: buyerTokenizer.input(request.prompt),
        output: buyerTokenizer.count(text),
      };
      const engineTokens = body.usage
        ? { input: body.usage.prompt_eval_count, output: body.usage.eval_count }
        : null;
      const delivered =
        response.status === 200 &&
        body.done === true &&
        body.doneReason === 'stop' &&
        Boolean(text);
      const comparison = engineTokens
        ? compareUsage(engineTokens, recounted)
        : null;
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
      await saveJson(journalPath, {
        state: 'verified',
        requestId: request.requestId,
        channelId,
        depositSignature: deposit.transaction,
        claimSignature: claim.transaction,
        chargedAtomic: actual.toString(),
        evidencePath,
      });
      if (failed) {
        assert.equal(response.status, 502);
        assert.equal(actual, 0n);
        assert.equal(row.anomaly, 'failed');
        assert.ok(trace.firstFragmentAt && trace.stoppedAt);
        assert.equal(row.delivered, false);
      } else {
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
      console.log(
        `${testCase.name}: confirmed charge=${actual}, refund=${result.refundAtomic}, anomaly=${row.anomaly}`,
      );
      // Let the public devnet RPC rate window clear between paid cases.
      await new Promise((resolve) => setTimeout(resolve, 12_000));
    }
    evidence.status = 'passed';
    evidence.gatePassed = true;
    evidence.completedAt = new Date().toISOString();
    await saveJson(evidencePath, evidence);
    console.log(
      'GYB-GATE-0005 passed. Evidence and private measurements saved without prompts or responses.',
    );
  } catch (error) {
    evidence.status = 'incomplete';
    evidence.errorCode =
      error instanceof GateError
        ? error.code
        : error instanceof assert.AssertionError
          ? 'ASSERTION_FAILED'
          : 'EXECUTION_INTERRUPTED_OR_UNKNOWN';
    evidence.errorLocation =
      error instanceof Error
        ? error.stack
            ?.split('\n')
            .slice(1, 3)
            .map((line) => line.trim())
        : [];
    await saveJson(evidencePath, evidence);
    throw error;
  }
}

try {
  await withExclusiveLock('.local/devnet/buyer.lock', run);
} catch (error) {
  console.error(
    error instanceof GateError
      ? error.code
      : 'Inference gate incomplete. Inspect evidence and reconcile any pending journal before retrying.',
  );
  process.exitCode = 1;
} finally {
  sellerServer?.closeAllConnections();
  sellerServer?.close();
  for (const child of children.reverse()) await stopChild(child);
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
}
