// Fixed gate runner: checks funding, spawns facilitator and seller hosts tied to a run ID, runs the
// paid gate and stops the children on exit or interrupt.
import { type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { HOSTS, MAX_ATOMIC, RETRY_DELAYS, ROUTES } from '@gyblos/config';
import { assertProgram, lamports, tokens } from '@gyblos/payments-x402/chain';
import { PROTOCOL_ERROR_CODES } from '@gyblos/protocol/constants';
import { ProtocolError } from '@gyblos/protocol/errors';
import {
  isMain,
  onShutdown,
  spawnChild,
  stopChild,
  waitReady,
} from '@gyblos/runtime';

import {
  ENTRYPOINTS,
  FIXED_MIN_FACILITATOR_LAMPORTS,
  GATE_HOST_MESSAGES,
  GATE_HOSTS,
  GATE_RETRIES,
  GATE_TIMEOUTS,
} from '../constants.js';
import { loadConfig } from '../wallet.js';
import { executeGate } from './execute.js';

export async function main() {
  const children: ChildProcess[] = [];
  const controller = new AbortController();
  const runId = randomUUID();
  const stop = () => {
    controller.abort(
      new Error('Gate interrupted; reconcile any recorded authorization.'),
    );
  };
  const dispose = onShutdown(stop);

  try {
    const config = await loadConfig();
    await assertProgram(config.rpcUrl);
    if (
      (await lamports(config.rpcUrl, config.addresses.facilitator)) <
      FIXED_MIN_FACILITATOR_LAMPORTS
    )
      throw new ProtocolError(
        PROTOCOL_ERROR_CODES.NEEDS_SOL,
        `Fund devnet facilitator ${config.addresses.facilitator} first.`,
      );
    if (
      (await tokens(config.rpcUrl, config.addresses.buyer, config.mint)) <
      BigInt(MAX_ATOMIC)
    )
      throw new ProtocolError(
        PROTOCOL_ERROR_CODES.NEEDS_TOKENS,
        'Fund the buyer or run gate:fund --test-mint first.',
      );
    controller.signal.throwIfAborted();
    const environment = { ...process.env, GYBLOS_GATE_RUN_ID: runId };
    const facilitator = spawnChild(
      process.execPath,
      ['--import', 'tsx', ENTRYPOINTS.facilitator],
      { env: environment, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    children.push(facilitator);
    facilitator.on('error', (error) => controller.abort(error));
    facilitator.stderr?.pipe(process.stderr);
    await waitReady(facilitator, `${HOSTS.facilitator}${ROUTES.health}`, {
      signal: controller.signal,
      expectedRunId: runId,
      attempts: GATE_RETRIES.fixedStartup,
      requestTimeout: RETRY_DELAYS.confirmation,
      checkSignalCode: false,
      retryResponseErrors: false,
      exitMessage: 'Gate host exited during startup.',
      timeoutMessage: GATE_HOST_MESSAGES.timeout,
      onMismatch: () =>
        new Error(
          'Gate port belongs to a different process. No payment attempted.',
        ),
    });
    const seller = spawnChild(
      process.execPath,
      ['--import', 'tsx', ENTRYPOINTS.seller],
      { env: environment, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    children.push(seller);
    seller.on('error', (error) => controller.abort(error));
    seller.stderr?.pipe(process.stderr);
    await waitReady(seller, `${GATE_HOSTS.seller}${ROUTES.health}`, {
      signal: controller.signal,
      expectedRunId: runId,
      attempts: GATE_RETRIES.fixedStartup,
      requestTimeout: RETRY_DELAYS.confirmation,
      checkSignalCode: false,
      retryResponseErrors: false,
      exitMessage: 'Gate host exited during startup.',
      timeoutMessage: GATE_HOST_MESSAGES.timeout,
      onMismatch: () =>
        new Error(
          'Gate port belongs to a different process. No payment attempted.',
        ),
    });
    console.log(JSON.stringify(await executeGate(controller.signal), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Gate failed.');
    process.exitCode = 1;
  } finally {
    for (const child of children.reverse())
      await stopChild(child, 'SIGTERM', GATE_TIMEOUTS.fixedStop);
    dispose();
  }
}

if (isMain(import.meta.url)) await main();
