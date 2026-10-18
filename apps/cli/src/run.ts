import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { executeGate } from './execute.js';
import { loadConfig } from '../../../scripts/config.js';
import {
  assertProgram,
  GateError,
  lamports,
  tokens,
} from '../../../packages/payments-x402/src/chain.js';
import { MAX_ATOMIC } from '../../../packages/payments-x402/src/constants.js';

const children: ChildProcess[] = [];
const controller = new AbortController();
const runId = randomUUID();
const stop = () => {
  controller.abort(
    new Error('Gate interrupted; reconcile any recorded authorization.'),
  );
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
async function ready(url: string, child: ChildProcess) {
  for (let i = 0; i < 80; i++) {
    controller.signal.throwIfAborted();
    if (child.exitCode !== null)
      throw new Error('Gate host exited during startup.');
    let response: Response | undefined;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(1000) });
    } catch {
      /* host starting */
    }
    if (response?.ok) {
      const body = (await response.json()) as { runId?: string };
      if (body.runId !== runId)
        throw new Error(
          'Gate port belongs to a different process. No payment attempted.',
        );
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Gate host startup timeout.');
}
try {
  const config = await loadConfig();
  await assertProgram(config.rpcUrl);
  if (
    (await lamports(config.rpcUrl, config.addresses.facilitator)) < 10_000_000n
  )
    throw new GateError(
      'NEEDS_SOL',
      `Fund devnet facilitator ${config.addresses.facilitator} first.`,
    );
  if (
    (await tokens(config.rpcUrl, config.addresses.buyer, config.mint)) <
    BigInt(MAX_ATOMIC)
  )
    throw new GateError(
      'NEEDS_TOKENS',
      'Fund the buyer or run gate:fund --test-mint first.',
    );
  controller.signal.throwIfAborted();
  const env = { ...process.env, GYBLOS_GATE_RUN_ID: runId };
  const facilitator = spawn(
    process.execPath,
    ['--import', 'tsx', 'apps/facilitator/src/main.ts'],
    { env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  children.push(facilitator);
  facilitator.on('error', (error) => controller.abort(error));
  facilitator.stderr?.pipe(process.stderr);
  await ready('http://127.0.0.1:4022/health', facilitator);
  const seller = spawn(
    process.execPath,
    ['--import', 'tsx', 'apps/seller/src/main.ts'],
    { env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  children.push(seller);
  seller.on('error', (error) => controller.abort(error));
  seller.stderr?.pipe(process.stderr);
  await ready('http://127.0.0.1:4021/health', seller);
  console.log(JSON.stringify(await executeGate(controller.signal), null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Gate failed.');
  process.exitCode = 1;
} finally {
  for (const child of children.reverse()) {
    if (child.exitCode !== null) continue;
    child.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
}
