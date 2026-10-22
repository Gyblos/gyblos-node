// Owns offline facilitator diagnostic fixture regression cases; no funded wallets or live services.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';

import { generateKeyPairSigner } from '@solana/kit';
import { UptoSvmScheme } from '@x402/svm/upto/facilitator';

import {
  DEVNET,
  DEVNET_USDC,
  FACILITATOR_PHASES,
  PUBLIC_CALL_OPERATIONS,
  type PublicCallOperation,
} from '@gyblos/payments-x402/constants';
import { createFacilitator } from '@gyblos/payments-x402/facilitator';
import {
  createFacilitatorObserver,
  type FacilitatorDiagnosticOptions,
  type FacilitatorDiagnosticRecord,
} from '@gyblos/payments-x402/facilitator-diagnostics';
import { createPrivateLog } from '@gyblos/runtime/private-log';

export const DIAGNOSTIC_SIGNATURE = '1'.repeat(64);
export const DIAGNOSTIC_CHANNEL = '1'.repeat(32);
export const DIAGNOSTIC_CANARY = 'PRIVATE_SENTINEL_NEVER_LOG';

interface HostOptions extends FacilitatorDiagnosticOptions {
  settle?: typeof UptoSvmScheme.prototype.settle;
  verify?: typeof UptoSvmScheme.prototype.verify;
}

export function diagnosticBarrier<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export async function diagnosticUntil(predicate: () => boolean) {
  const deadline = performance.now() + 5000;
  while (!predicate()) {
    assert.ok(
      performance.now() < deadline,
      'Diagnostic condition was not observed',
    );
    await setImmediate();
  }
}

export async function diagnosticDirectory() {
  return mkdtemp(join(await realpath(tmpdir()), 'gyblos-facilitator-log-'));
}

export async function diagnosticRows(path: string) {
  const text = await readFile(path, 'utf8');
  return text
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as FacilitatorDiagnosticRecord);
}

export async function withDiagnosticHost<T>(
  options: HostOptions,
  run: (host: {
    url: string;
    records: FacilitatorDiagnosticRecord[];
    body: object;
    calls: { verify: number; settle: number; network: number };
    call(operation?: PublicCallOperation, body?: unknown): Promise<Response>;
  }) => Promise<T>,
) {
  const signer = await generateKeyPairSigner();
  const originalSettle = UptoSvmScheme.prototype.settle;
  const originalVerify = UptoSvmScheme.prototype.verify;
  const originalFetch = globalThis.fetch;
  const calls = { verify: 0, settle: 0, network: 0 };
  const records: FacilitatorDiagnosticRecord[] = [];
  let server: Server | undefined;
  try {
    UptoSvmScheme.prototype.settle = async (...args) => {
      calls.settle++;
      if (options.settle) return options.settle(...args);
      return {
        success: true,
        network: DEVNET,
        transaction: DIAGNOSTIC_SIGNATURE,
      };
    };
    UptoSvmScheme.prototype.verify = async (...args) => {
      calls.verify++;
      if (options.verify) return options.verify(...args);
      return { isValid: true };
    };
    const host = createFacilitator(
      signer,
      'https://forbidden.invalid/',
      {
        buyer: signer.address,
        mint: DEVNET_USDC,
        payTo: signer.address,
        authorizer: signer.address,
      },
      undefined,
      {
        onDiagnostic(record) {
          records.push(record);
          return options.onDiagnostic?.(record);
        },
      },
    );
    server = host.app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}`;
    const requirements = {
      scheme: 'upto',
      network: DEVNET,
      asset: DEVNET_USDC,
      payTo: signer.address,
      amount: '148',
      extra: { feePayer: signer.address, receiverAuthorizer: signer.address },
    };
    const body = {
      paymentPayload: {
        x402Version: 2,
        accepted: requirements,
        payload: {
          from: signer.address,
          type: FACILITATOR_PHASES.CLAIM,
          channelId: DIAGNOSTIC_CHANNEL,
        },
      },
      paymentRequirements: requirements,
    };
    globalThis.fetch = (async (input, init) => {
      const target =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (!target.startsWith(url + '/')) {
        calls.network++;
        throw new Error('External RPC is forbidden');
      }
      return originalFetch(input, init);
    }) as typeof fetch;
    return await run({
      url,
      records,
      body,
      calls,
      call(operation = PUBLIC_CALL_OPERATIONS.SETTLE, request = body) {
        return fetch(url + '/' + operation, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(request),
          signal: AbortSignal.timeout(5000),
        });
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
    UptoSvmScheme.prototype.settle = originalSettle;
    UptoSvmScheme.prototype.verify = originalVerify;
    server?.closeAllConnections();
    await new Promise<void>((resolve) =>
      server ? server.close(() => resolve()) : resolve(),
    );
    assert.equal(calls.network, 0);
  }
}

export { createFacilitatorObserver, createPrivateLog, rm };
