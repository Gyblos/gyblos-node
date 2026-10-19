import assert from 'node:assert/strict';
import { type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { resolve } from 'node:path';

import { type TokenCounts } from '@gyblos/application/metering';
import {
  HOSTS,
  LOCAL_DIR,
  LOCALHOST,
  localPath,
  LOCK_PATH,
  MIN_FACILITATOR_LAMPORTS,
} from '@gyblos/config';
import { loadConfig, saveJson, signer } from '@gyblos/gate/config';
import {
  confirmInference,
  inferenceSnapshot,
  transaction,
} from '@gyblos/gate/inference-chain';
import { assertNoUnresolvedAuthorizations } from '@gyblos/gate/journal';
import { withExclusiveLock } from '@gyblos/gate/lock';
import { measurementSalt } from '@gyblos/gate/measurements';
import { GENERATION } from '@gyblos/inference-ollama/constants';
import {
  createModelTokenizer,
  createOllama,
} from '@gyblos/inference-ollama/index';
import {
  assertProgram,
  GateError,
  lamports,
} from '@gyblos/payments-x402/chain';
import { DEVNET_USDC } from '@gyblos/payments-x402/constants';
import type { SettlementEvent } from '@gyblos/payments-x402/facilitator';
import {
  assertPortFree,
  onShutdown,
  spawnChild,
  stopChild,
  waitReady,
} from '@gyblos/runtime';

import { createInferenceSeller } from '../../../seller/src/inference.js';
import { createCases } from './cases-data.js';
import { runCases } from './cases.js';
import { initializeEvidence } from './evidence.js';

export async function main() {
  const evidencePath = 'evidence/gate-0005.json';
  const journalPath = localPath('inference-attempt.json');
  const ollamaUrl = HOSTS.ollama;
  const facilitatorUrl = HOSTS.facilitator;
  const runId = randomUUID();
  const children: ChildProcess[] = [];
  const controller = new AbortController();
  let sellerServer: Server | undefined;
  const stop = () => controller.abort(new Error('Gate interrupted.'));
  const dispose = onShutdown(stop);

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
      assert.equal(resolve(c.keys[role]), resolve(`${LOCAL_DIR}/${role}.json`));
    }
    await assertNoUnresolvedAuthorizations();
    await assertProgram(c.rpcUrl);
    assert.ok(
      (await lamports(c.rpcUrl, c.addresses.facilitator)) >
        MIN_FACILITATOR_LAMPORTS,
      'Facilitator needs devnet SOL for five channels.',
    );
    const artifacts = {
      tokenizer: await readFile(localPath('tokenizer/tokenizer.json'), 'utf8'),
      config: await readFile(
        localPath('tokenizer/tokenizer_config.json'),
        'utf8',
      ),
    };
    const buyerTokenizer = createModelTokenizer(artifacts);
    const sellerTokenizer = createModelTokenizer(artifacts);
    const salt = await measurementSalt();
    const evidence = await initializeEvidence(c, runId, evidencePath);
    try {
      await assertPortFree(
        `${ollamaUrl}/api/version`,
        () =>
          new GateError(
            'PORT_BUSY',
            'Gate requires an unused local host port.',
          ),
      );
      await assertPortFree(
        `${facilitatorUrl}/health`,
        () =>
          new GateError(
            'PORT_BUSY',
            'Gate requires an unused local host port.',
          ),
      );
      const ollama = spawnChild('ollama', ['serve'], {
        env: {
          ...process.env,
          OLLAMA_HOST: HOSTS.ollamaBind,
          OLLAMA_MODELS: resolve('.local/ollama/models'),
          OLLAMA_NO_CLOUD: '1',
          OLLAMA_DEBUG: '0',
          OLLAMA_CONTEXT_LENGTH: String(GENERATION.numCtx),
        },
        stdio: 'ignore',
      });
      children.push(ollama);
      ollama.on('error', stop);
      await waitReady(ollama, `${ollamaUrl}/api/version`, {
        signal: controller.signal,
      });
      await createOllama(ollamaUrl).assertModel();
      evidence.ollamaVersion = (
        (await fetch(`${ollamaUrl}/api/version`).then((r) => r.json())) as {
          version: string;
        }
      ).version;
      const facilitator = spawnChild(
        process.execPath,
        ['--import', 'tsx', 'apps/facilitator/src/main.ts'],
        { env: { ...process.env, GYBLOS_GATE_RUN_ID: runId }, stdio: 'ignore' },
      );
      children.push(facilitator);
      facilitator.on('error', stop);
      await waitReady(facilitator, `${facilitatorUrl}/health`, {
        signal: controller.signal,
        expectedRunId: runId,
        onMismatch: () =>
          new GateError('PORT_BUSY', 'Host is not owned by this gate.'),
      });
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
      const gateBilling = {
        feePayer: c.addresses.facilitator,
        billingOverride(requestId: string, usage: Readonly<TokenCounts>) {
          return requestId === debugRequestId
            ? { ...usage, output: Math.ceil(usage.output * 1.4) }
            : { ...usage };
        },
      };
      const host = await createInferenceSeller({
        ...gateBilling,
        rpcUrl: c.rpcUrl,
        facilitatorUrl,
        ollamaUrl,
        mint: c.mint,
        payTo: c.addresses.seller,
        authorizer: await signer(c, 'authorizer'),
        tokenizer: sellerTokenizer,
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
      sellerServer = host.app.listen(0, LOCALHOST);
      await once(sellerServer, 'listening');
      const endpoint = sellerServer.address();
      assert.ok(endpoint && typeof endpoint !== 'string');
      const url = `http://${LOCALHOST}:${endpoint.port}/v1/chat/completions`;
      const cases = createCases(debugRequestId, failureRequestId);
      await runCases({
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
      });
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
    await withExclusiveLock(LOCK_PATH, run);
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
    dispose();
  }
}
