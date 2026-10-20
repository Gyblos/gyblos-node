import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';

import {
  verifyInferenceOffer,
  type OfferTrust,
  type SignedInferenceOffer,
} from '@gyblos/application/offers';
import { P2P } from '@gyblos/config';
import { JOURNAL_STATES } from '@gyblos/gate/constants';
import { finalizedPaymentProof } from '@gyblos/gate/finalized-proof';
import { withExclusiveLock } from '@gyblos/gate/lock';
import { withP2pRecoveryLock } from '@gyblos/gate/recovery-lock';
import { isMain, loadJson, saveJson } from '@gyblos/runtime';

import {
  CALL_OUTCOMES,
  P2P_JOURNAL_STATES,
  type CallOutcome,
  type P2pJournalState,
} from './constants.js';
import {
  verifyZeroChargeReconciliation,
  type RecoveryAccounts,
  type UncertainAttempt,
} from './reconciliation.js';
import { loadRole, rolePath } from './roles.js';

interface RecoveryJournal {
  state: P2pJournalState;
  requestId: string;
  channelId: string;
  paymentExpectation?: Omit<RecoveryAccounts, 'rpcUrl'>;
  ceiling?: string;
  ceilingAtomic?: string;
  runId?: string;
  depositSignature?: string;
  claimSignature?: string;
}

interface RecoveryCall extends UncertainAttempt {
  requestId: string;
  outcome: CallOutcome;
}

function originalAttempt(
  journal: RecoveryJournal,
  calls: RecoveryCall[],
  auditOnly: boolean,
): RecoveryCall {
  assert.ok(typeof journal.requestId === 'string' && journal.requestId.trim());
  assert.ok(typeof journal.channelId === 'string' && journal.channelId.trim());
  const ceiling = journal.ceiling ?? journal.ceilingAtomic;
  if (ceiling !== undefined) {
    assert.match(ceiling, /^\d+$/);
    assert.ok(BigInt(ceiling) > 0n);
    if (journal.ceilingAtomic !== undefined)
      assert.equal(journal.ceilingAtomic, ceiling);
  }
  const related = calls.filter(
    (call) =>
      call.channelId === journal.channelId ||
      call.requestId === journal.requestId,
  );
  assert.ok(related.length <= 1, 'Conflicting original call metadata.');
  const attempt = related[0];
  if (attempt) {
    assert.equal(attempt.requestId, journal.requestId);
    assert.equal(attempt.channelId, journal.channelId);
    assert.match(attempt.ceilingAtomic, /^\d+$/);
    assert.ok(BigInt(attempt.ceilingAtomic) > 0n);
    if (ceiling !== undefined) assert.equal(attempt.ceilingAtomic, ceiling);
    return attempt;
  }
  assert.ok(
    journal.state === P2P_JOURNAL_STATES.AUTHORIZED ||
      journal.state === P2P_JOURNAL_STATES.UNCERTAIN ||
      (auditOnly && journal.state === P2P_JOURNAL_STATES.CONFIRMED),
    'Journal-only recovery requires an unresolved authorization or read-only audit.',
  );
  assert.ok(
    journal.paymentExpectation,
    'Original payment identities required.',
  );
  assert.ok(ceiling, 'Original authorization ceiling required.');
  return {
    requestId: journal.requestId,
    channelId: journal.channelId,
    ceilingAtomic: ceiling,
    runId: journal.runId,
    outcome:
      journal.state === P2P_JOURNAL_STATES.CONFIRMED
        ? CALL_OUTCOMES.CONFIRMED
        : CALL_OUTCOMES.UNCERTAIN,
  };
}

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({
    args,
    options: {
      deposit: { type: 'string' },
      claim: { type: 'string' },
      'audit-only': { type: 'boolean', default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  const operation = async () => {
    const config = await loadRole();
    assert.equal(config.role, 'buyer');
    const journal = await loadJson<RecoveryJournal>(
      rolePath(P2P.journalFilename),
    );
    if (!values['audit-only'])
      assert.ok(
        journal.state === P2P_JOURNAL_STATES.UNCERTAIN ||
          journal.state === P2P_JOURNAL_STATES.AUTHORIZED,
        'Only an unresolved authorization can be reconciled.',
      );
    let calls: RecoveryCall[] = [];
    try {
      calls = await loadJson<RecoveryCall[]>(rolePath(P2P.callsFilename));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    assert.ok(Array.isArray(calls));
    const attempt = originalAttempt(journal, calls, values['audit-only']);
    if (!values['audit-only'])
      assert.equal(attempt.outcome, CALL_OUTCOMES.UNCERTAIN);
    const trust = await loadJson<OfferTrust>(rolePath(P2P.trustFilename));
    assert.equal(trust.buyer, config.buyer);
    assert.equal(trust.mint, config.mint);
    const signed = await loadJson<SignedInferenceOffer>(
      rolePath(P2P.offerFilename),
    );
    // An expired owner-signed offer is historical identity metadata only here.
    // This workflow never authorizes, signs, submits or retries a payment.
    const offer = await verifyInferenceOffer(
      signed,
      trust,
      signed.offer.issuedAt,
    );
    const accounts: RecoveryAccounts = {
      rpcUrl: config.rpcUrl,
      buyer: config.buyer,
      mint: config.mint,
      payTo: offer.payTo,
      feePayer: offer.feePayer,
      authorizer: offer.authorizer,
    };
    const { rpcUrl: _rpcUrl, ...identities } = accounts;
    if (journal.paymentExpectation)
      assert.deepEqual(journal.paymentExpectation, identities);
    const signatures = {
      channelId: attempt.channelId,
      ceilingAtomic: attempt.ceilingAtomic,
      depositSignature: values.deposit ?? journal.depositSignature ?? '',
      claimSignature: values.claim ?? journal.claimSignature ?? '',
    };
    if (values['audit-only']) {
      const proof = await finalizedPaymentProof({
        ...accounts,
        channelId: attempt.channelId,
        ceiling: attempt.ceilingAtomic,
        depositSignature: signatures.depositSignature,
        claimSignature: signatures.claimSignature,
      });
      console.log(JSON.stringify(proof));
      return proof;
    }
    const proof = await verifyZeroChargeReconciliation(
      accounts,
      attempt,
      signatures,
    );
    let prior: unknown[] = [];
    try {
      prior = await loadJson<unknown[]>(rolePath(P2P.reconciliationsFilename));
      assert.ok(Array.isArray(prior));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await saveJson(rolePath(P2P.reconciliationsFilename), [...prior, proof]);
    // A failed proof/record write never unlocks the buyer. Keep the failed call.
    await saveJson(rolePath(P2P.journalFilename), {
      state: JOURNAL_STATES.CONFIRMED,
      resolution: proof.status,
      requestId: attempt.requestId,
      channelId: attempt.channelId,
      ceilingAtomic: attempt.ceilingAtomic,
      paymentExpectation: identities,
      runId: attempt.runId,
      depositSignature: proof.depositSignature,
      claimSignature: proof.claimSignature,
    });
    console.log(JSON.stringify(proof));
    return proof;
  };
  if (values['audit-only'])
    return withExclusiveLock(rolePath(P2P.buyerLockFilename), operation);
  return withP2pRecoveryLock(
    {
      buyer: rolePath(P2P.buyerLockFilename),
      recovery: rolePath(P2P.recoveryLockFilename),
      audit: rolePath(P2P.staleLockJournalFilename),
    },
    operation,
  );
}

if (isMain(import.meta.url)) {
  try {
    await main();
  } catch {
    console.error(
      'Reconciliation or audit incomplete; preserve the journal and inspect the original call before another authorization.',
    );
    process.exitCode = 1;
  }
}
