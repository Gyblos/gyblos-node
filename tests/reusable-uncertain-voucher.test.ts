// Refuses a second signature when a voucher may already have escaped the signer.
// This regression uses only synthetic identities in a temporary home.
import assert from 'node:assert/strict';
import test from 'node:test';

import { openReusableJournal } from '@gyblos/payments-upto/reusable-journal';
import { PAYMENT_ERROR_CODES } from '@gyblos/protocol/constants';

import {
  A,
  context,
  fixture,
  observation,
  track,
} from './support/reusable-journal-fixture';

void test('a voucher signed before interruption is never re-signed on recovery', () =>
  fixture(async (root) => {
    const { environment, payer, terms } = await context(root);
    let journal = await openReusableJournal({ environment });
    let signs = 0;
    let generated = false;
    const interrupted = {
      ...payer,
      async signMessages(...args: Parameters<typeof payer.signMessages>) {
        signs++;
        const result = await payer.signMessages(...args);
        if (signs === 2) {
          generated = true;
          throw new Error('Synthetic interruption after signing');
        }
        return result;
      },
    };
    try {
      await track(journal, terms, payer);
      await journal.confirmOpen(terms.channelId, async () =>
        observation(terms),
      );
      await assert.rejects(
        journal.issueVoucher(terms.channelId, A, '40', interrupted, async () =>
          observation(terms),
        ),
      );
      assert.equal(generated, true);
      await journal.close();
      journal = await openReusableJournal({ environment });
      let reads = 0;
      let repeats = 0;
      const counted = {
        ...payer,
        async signMessages(...args: Parameters<typeof payer.signMessages>) {
          repeats++;
          return payer.signMessages(...args);
        },
      };
      await assert.rejects(
        journal.recoverPending(
          terms.channelId,
          async () => {
            reads++;
            return observation(terms);
          },
          counted,
        ),
        { code: PAYMENT_ERROR_CODES.JOURNAL_UNAVAILABLE },
      );
      assert.equal(reads, 0);
      assert.equal(repeats, 0);
      assert.equal(
        (await journal.get(terms.channelId))?.pending?.requestDigest,
        A,
      );
    } finally {
      await journal.close();
    }
  }));
