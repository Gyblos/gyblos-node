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
  depositSignature?: string;
  claimSignature?: string;
}

interface RecoveryCall extends UncertainAttempt {
  requestId: string;
  outcome: CallOutcome;
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
  return withExclusiveLock(rolePath(P2P.buyerLockFilename), async () => {
    const config = await loadRole();
    assert.equal(config.role, 'buyer');
    const journal = await loadJson<RecoveryJournal>(
      rolePath(P2P.journalFilename),
    );
    if (!values['audit-only'])
      assert.ok(
        journal.state === CALL_OUTCOMES.UNCERTAIN ||
          journal.state === P2P_JOURNAL_STATES.AUTHORIZED,
        'Only an unresolved authorization can be reconciled.',
      );
    const calls = await loadJson<RecoveryCall[]>(rolePath(P2P.callsFilename));
    assert.ok(Array.isArray(calls));
    const attempt = calls.find(
      (call) =>
        call.channelId === journal.channelId &&
        call.requestId === journal.requestId,
    );
    assert.ok(attempt, 'Matching original call metadata is required.');
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
    if (journal.paymentExpectation) {
      const { rpcUrl: _rpcUrl, ...identities } = accounts;
      assert.deepEqual(journal.paymentExpectation, identities);
    }
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
      depositSignature: proof.depositSignature,
      claimSignature: proof.claimSignature,
    });
    console.log(JSON.stringify(proof));
    return proof;
  });
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
