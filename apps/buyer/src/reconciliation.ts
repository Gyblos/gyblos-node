import assert from 'node:assert/strict';

import {
  finalizedPaymentProof,
  type FinalizedPaymentExpectation,
} from '@gyblos/payments-x402/accounting/finalized-proof';

import { RECONCILED_ZERO_CHARGE } from './constants.js';

export interface UncertainAttempt {
  channelId: string;
  ceilingAtomic: string;
  runId?: string;
}

export interface ReconciliationSignatures {
  channelId: string;
  ceilingAtomic: string;
  depositSignature: string;
  claimSignature: string;
}

export type RecoveryAccounts = Omit<
  FinalizedPaymentExpectation,
  'channelId' | 'ceiling' | 'depositSignature' | 'claimSignature'
>;

export async function verifyZeroChargeReconciliation(
  accounts: RecoveryAccounts,
  attempt: UncertainAttempt,
  record: ReconciliationSignatures,
) {
  assert.equal(record.channelId, attempt.channelId);
  assert.match(attempt.ceilingAtomic, /^\d+$/);
  assert.equal(record.ceilingAtomic, attempt.ceilingAtomic);
  assert.ok(
    typeof record.depositSignature === 'string' &&
      record.depositSignature.length > 0,
  );
  assert.ok(
    typeof record.claimSignature === 'string' &&
      record.claimSignature.length > 0,
  );
  const proof = await finalizedPaymentProof({
    ...accounts,
    channelId: attempt.channelId,
    ceiling: attempt.ceilingAtomic,
    depositSignature: record.depositSignature,
    claimSignature: record.claimSignature,
  });
  assert.equal(
    proof.chargedAtomic,
    '0',
    'A confirmed charge requires charged-outcome recovery, not a zero-charge record.',
  );
  assert.equal(proof.refundAtomic, attempt.ceilingAtomic);
  assert.equal(proof.balanceDeltas.escrow, '0');
  return {
    ...proof,
    channelId: attempt.channelId,
    ceilingAtomic: attempt.ceilingAtomic,
    status: RECONCILED_ZERO_CHARGE,
    runId: attempt.runId ?? null,
    provenanceVerified: false,
  };
}
