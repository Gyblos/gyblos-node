// Owns call evidence in buyer; it must not know laboratory orchestration.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { STATUS_CODES } from 'node:http';

import type { Signature } from '@solana/kit';

import type { BuyerResponseObservation } from '@gyblos/payments-x402';
import { JOURNAL_STATES } from '@gyblos/payments-x402/constants';
import { signatureHint } from '@gyblos/payments-x402/signature-hint';
import type { RouteObservation } from '@gyblos/transport-iroh';
import { TRANSPORT_ROUTES } from '@gyblos/transport-iroh/constants';

import type { P2pJournalState } from './constants.js';
import type { PaymentProofObservation } from './proof.js';

export interface CallPaymentObservation extends BuyerResponseObservation {
  depositSignature?: Signature;
}

interface TransportMetric extends RouteObservation {
  requestId: string;
  status: number;
}

export async function assertPriorCallResolved(path: string) {
  try {
    const previous = JSON.parse(await readFile(path, 'utf8')) as {
      state: P2pJournalState;
    };
    if (previous.state !== JOURNAL_STATES.CONFIRMED)
      throw new Error('Reconcile prior authorization before another call.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export async function priorCalls(path: string): Promise<unknown[]> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    assert.ok(Array.isArray(value));
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return [];
  }
}

export async function readCallMetrics(path: string, requestId: string) {
  const lines = (
    await readFile(path, 'utf8').catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return '';
    })
  )
    .trim()
    .split('\n')
    .filter(Boolean);
  const metrics: TransportMetric[] = [];
  for (const line of lines) {
    const value: unknown = JSON.parse(line);
    if (!value || typeof value !== 'object' || !('requestId' in value))
      continue;
    if (value.requestId !== requestId) continue;
    assert.ok('status' in value && typeof value.status === 'number');
    assert.ok(Number.isInteger(value.status) && STATUS_CODES[value.status]);
    assert.ok('transport' in value);
    const route = Object.values(TRANSPORT_ROUTES).find(
      (candidate) => candidate === value.transport,
    );
    assert.ok(route);
    assert.ok('connectMs' in value && typeof value.connectMs === 'number');
    assert.ok(Number.isFinite(value.connectMs) && value.connectMs >= 0);
    assert.ok(
      'directObserved' in value && typeof value.directObserved === 'boolean',
    );
    assert.ok(
      'relayObserved' in value && typeof value.relayObserved === 'boolean',
    );
    metrics.push({
      requestId,
      status: value.status,
      transport: route,
      connectMs: value.connectMs,
      directObserved: value.directObserved,
      relayObserved: value.relayObserved,
    });
  }
  return metrics;
}

export function proofObservation(
  status: number,
  value: PaymentProofObservation,
): CallPaymentObservation {
  const claimSignature = signatureHint(value.claimSignature);
  const depositSignature = signatureHint(value.depositSignature);
  return {
    status,
    ...(claimSignature ? { claimSignature } : {}),
    ...(depositSignature ? { depositSignature } : {}),
  };
}
