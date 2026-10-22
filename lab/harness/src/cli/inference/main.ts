import assert from 'node:assert/strict';
import { type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { resolve } from 'node:path';

import {
  DIAGNOSTIC_LIMITS,
  ENTRYPOINTS,
  EVIDENCE_PATHS,
  HOSTS,
  JOURNAL_PATHS,
  keyPath,
  LOCALHOST,
  LOCK_PATH,
  MIN_FACILITATOR_LAMPORTS,
  OLLAMA_MODELS_PATH,
  ROUTES,
  TIMEOUTS,
  TOKENIZER_FILES,
} from '@gyblos/config';
import { createModelTokenizer, createOllama } from '@gyblos/engine-ollama';
import { GENERATION } from '@gyblos/engine-ollama/constants';
import { createOllamaEngine } from '@gyblos/engine-ollama/engine';
import { createInferenceSeller } from '@gyblos/node/http/inference';
import { measurementSalt } from '@gyblos/node/measurements';
import { createCases } from '@gyblos/node/synthetic-cases';
import {
  confirmInference,
  inferenceSnapshot,
  transaction,
} from '@gyblos/payments-x402/accounting/chain';
import {
  assertProgram,
  GateError,
  lamports,
} from '@gyblos/payments-x402/chain';
import { DEVNET_USDC, GATE_ERROR_CODES } from '@gyblos/payments-x402/constants';
import type { SettlementEvent } from '@gyblos/payments-x402/facilitator';
import { withExclusiveLock } from '@gyblos/payments-x402/recovery/lock';
import {
  assertPortFree,
  onShutdown,
  spawnChild,
  stopChild,
  waitReady,
} from '@gyblos/runtime';

import { loadConfig, saveJson, signer } from '../../config.js';
import {
  CONFIG_ASSET_LABELS,
  EVIDENCE_STATUSES,
  INFERENCE_EVIDENCE_CODES,
  WALLET_ROLES,
} from '../../constants.js';
import type { InferenceTrace } from '../../inference-evidence-types.js';
import { assertNoUnresolvedAuthorizations } from '../../journal.js';
import { createGateBilling } from './billing.js';
import { runCases } from './cases.js';
import { initializeEvidence } from './evidence.js';

export async function main() {
  const evidencePath = EVIDENCE_PATHS.inference;
  const journalPath = JOURNAL_PATHS.inference;
  const ollamaUrl = HOSTS.ollama;
  const facilitatorUrl = HOSTS.facilitator;
  const runId = randomUUID();
  const children: ChildProcess[] = [];
  const controller = new AbortController();
  let sellerServer: Server | undefined;
  const stop = () => controller.abort(new Error('Gate interrupted.'));
  const dispose = onShutdown(stop);

  async function run() {
    const config = await loadConfig();
    // This gate accepts only isolated setup keys, never imported wallet paths.
    assert.equal(
      config.mint,
      config.assetLabel === CONFIG_ASSET_LABELS.DEVNET_USDC
        ? DEVNET_USDC
        : config.addresses.mint,
    );
    for (const role of [
      WALLET_ROLES.BUYER,
      WALLET_ROLES.SELLER,
      WALLET_ROLES.AUTHORIZER,
      WALLET_ROLES.FACILITATOR,
    ] as const) {
      assert.equal(resolve(config.keys[role]), resolve(keyPath(role)));
    }
    await assertNoUnresolvedAuthorizations();
    await assertProgram(config.rpcUrl);
    assert.ok(
      (await lamports(config.rpcUrl, config.addresses.facilitator)) >
        MIN_FACILITATOR_LAMPORTS,
      'Facilitator needs devnet SOL for the inference channels.',
    );
    const artifacts = {
      tokenizer: await readFile(TOKENIZER_FILES.tokenizer, 'utf8'),
      config: await readFile(TOKENIZER_FILES.config, 'utf8'),
    };
    const buyerTokenizer = createModelTokenizer(artifacts);
    const sellerTokenizer = createModelTokenizer(artifacts);
    const salt = await measurementSalt();
    const evidence = await initializeEvidence(config, runId, evidencePath);
    try {
      await assertPortFree(
        `${ollamaUrl}${ROUTES.ollamaVersion}`,
        () =>
          new GateError(
            GATE_ERROR_CODES.PORT_BUSY,
            'Gate requires an unused local host port.',
          ),
      );
      await assertPortFree(
        `${facilitatorUrl}${ROUTES.health}`,
        () =>
          new GateError(
            GATE_ERROR_CODES.PORT_BUSY,
            'Gate requires an unused local host port.',
          ),
      );
      const ollama = spawnChild('ollama', ['serve'], {
        env: {
          ...process.env,
          OLLAMA_HOST: HOSTS.ollamaBind,
          OLLAMA_MODELS: resolve(OLLAMA_MODELS_PATH),
          OLLAMA_NO_CLOUD: '1',
          OLLAMA_DEBUG: '0',
          OLLAMA_CONTEXT_LENGTH: String(GENERATION.numCtx),
        },
        stdio: 'ignore',
      });
      children.push(ollama);
      ollama.on('error', stop);
      await waitReady(ollama, `${ollamaUrl}${ROUTES.ollamaVersion}`, {
        signal: controller.signal,
      });
      await createOllama(ollamaUrl).assertModel();
      evidence.ollamaVersion = (
        (await fetch(`${ollamaUrl}${ROUTES.ollamaVersion}`).then((response) =>
          response.json(),
        )) as {
          version: string;
        }
      ).version;
      const facilitator = spawnChild(
        process.execPath,
        ['--import', 'tsx', ENTRYPOINTS.facilitator],
        { env: { ...process.env, GYBLOS_GATE_RUN_ID: runId }, stdio: 'ignore' },
      );
      children.push(facilitator);
      facilitator.on('error', stop);
      await waitReady(facilitator, `${facilitatorUrl}${ROUTES.health}`, {
        signal: controller.signal,
        expectedRunId: runId,
        onMismatch: () =>
          new GateError(
            GATE_ERROR_CODES.PORT_BUSY,
            'Host is not owned by this gate.',
          ),
      });
      const debugRequestId = randomUUID(),
        underchargeRequestId = randomUUID(),
        failureRequestId = randomUUID();
      const traces = new Map<string, InferenceTrace>();
      const events = async () =>
        (await fetch(`${facilitatorUrl}${ROUTES.events}`, {
          signal: AbortSignal.timeout(TIMEOUTS.events),
        }).then((response) => response.json())) as SettlementEvent[];
      const gateBilling = createGateBilling(
        config.addresses.facilitator,
        debugRequestId,
        underchargeRequestId,
      );
      const host = await createInferenceSeller({
        ...gateBilling,
        rpcUrl: config.rpcUrl,
        facilitatorUrl,
        engine: createOllamaEngine(ollamaUrl),
        mint: config.mint,
        payTo: config.addresses.seller,
        authorizer: await signer(config, WALLET_ROLES.AUTHORIZER),
        tokenizer: sellerTokenizer,
        async beforeInference(requestId, channelId) {
          const deposit = (await events()).find(
            (item) =>
              item.channelId === channelId &&
              item.phase === 'deposit' &&
              item.success,
          );
          assert.ok(deposit?.transaction);
          await confirmInference(config, deposit.transaction);
          const depositConfirmedAt = new Date().toISOString();
          const during = await inferenceSnapshot(config, channelId);
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
      const url = `http://${LOCALHOST}:${endpoint.port}${ROUTES.inference}`;
      const cases = createCases(
        debugRequestId,
        failureRequestId,
        underchargeRequestId,
      );
      await runCases({
        url,
        config: config,
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
      evidence.status = EVIDENCE_STATUSES.PASSED;
      evidence.gatePassed = true;
      evidence.completedAt = new Date().toISOString();
      await saveJson(evidencePath, evidence);
      console.log(
        'GYB-GATE-0005 passed. Evidence and private measurements saved without prompts or responses.',
      );
    } catch (error) {
      evidence.status = EVIDENCE_STATUSES.INCOMPLETE;
      evidence.errorCode =
        error instanceof GateError
          ? error.code
          : error instanceof assert.AssertionError
            ? INFERENCE_EVIDENCE_CODES.ASSERTION_FAILED
            : INFERENCE_EVIDENCE_CODES.EXECUTION_INTERRUPTED_OR_UNKNOWN;
      evidence.errorLocation =
        error instanceof Error
          ? error.stack
              ?.split('\n')
              .slice(1, DIAGNOSTIC_LIMITS.errorStackEnd)
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
