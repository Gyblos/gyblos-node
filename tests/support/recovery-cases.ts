// Owns offline recovery cases regression cases; no funded wallets or live services.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { basename } from 'node:path';
import test from 'node:test';

import { CALL_OUTCOMES, RECONCILED_ZERO_CHARGE } from '@gyblos/buyer/constants';
import { P2P } from '@gyblos/config';
import { JOURNAL_STATES } from '@gyblos/lab-harness/constants';

import { NATIVE_CAPABILITY } from './native-runtime.js';
import { recoveryFixture } from './recovery-fixture.js';

const RECOVERY_OPTIONS = { skip: NATIVE_CAPABILITY.bindingSkip };

export function registerRecoveryCases() {
  void test(
    'actual CLI recovers journal-only full principal return without wallet keys or invented calls',
    RECOVERY_OPTIONS,
    async () => {
      const fixture = await recoveryFixture();
      try {
        const proof = await fixture.run();
        assert.ok('status' in proof);
        assert.equal(proof.status, RECONCILED_ZERO_CHARGE);
        assert.equal(proof.treasurySweepAtomic, '17');
        assert.equal(proof.refundAtomic, fixture.financial.expected.ceiling);
        assert.equal(
          (await fixture.read<{ state: string }>(P2P.journalFilename)).state,
          JOURNAL_STATES.CONFIRMED,
        );
        await assert.rejects(stat(fixture.path(P2P.callsFilename)), {
          code: 'ENOENT',
        });
        for (const key of Object.values(P2P.keys))
          await assert.rejects(stat(fixture.path(key)), { code: 'ENOENT' });
        assert.ok(
          fixture.financial.methods.every((method) => method.startsWith('get')),
        );
      } finally {
        await fixture.close();
      }
    },
  );
  for (const target of [P2P.reconciliationsFilename, P2P.journalFilename])
    void test(
      'actual CLI leaves recovery unresolved if saving ' + target + ' fails',
      RECOVERY_OPTIONS,
      async (context) => {
        const fixture = await recoveryFixture();
        const original = fs.rename;
        let fail = true;
        try {
          context.mock.method(
            fs,
            'rename',
            async (
              from: Parameters<typeof fs.rename>[0],
              to: Parameters<typeof fs.rename>[1],
            ) => {
              if (fail && basename(String(to)) === target)
                throw new Error('Synthetic persistence failure');
              return original(from, to);
            },
          );
          syncBuiltinESMExports();
          await assert.rejects(fixture.run(), /Synthetic persistence failure/);
          assert.deepEqual(
            await fixture.read(P2P.journalFilename),
            fixture.journal,
          );
          if (target === P2P.reconciliationsFilename)
            await assert.rejects(stat(fixture.path(target)), {
              code: 'ENOENT',
            });
          else
            assert.equal(
              (await fixture.read<unknown[]>(P2P.reconciliationsFilename))
                .length,
              1,
            );
          const reads = fixture.financial.methods.length;
          fail = false;
          await fixture.run();
          assert.ok(fixture.financial.methods.length > reads);
          assert.equal(
            (await fixture.read<{ state: string }>(P2P.journalFilename)).state,
            JOURNAL_STATES.CONFIRMED,
          );
          assert.equal(
            (await fixture.read<unknown[]>(P2P.reconciliationsFilename)).length,
            target === P2P.journalFilename ? 2 : 1,
          );
          await assert.rejects(stat(fixture.path(P2P.callsFilename)), {
            code: 'ENOENT',
          });
        } finally {
          context.mock.restoreAll();
          syncBuiltinESMExports();
          await fixture.close();
        }
      },
    );
  void test(
    'actual CLI refuses a second recovery and preserves files during read-only audit',
    RECOVERY_OPTIONS,
    async () => {
      const fixture = await recoveryFixture();
      try {
        await fixture.run();
        const journal = await readFile(fixture.path(P2P.journalFilename));
        const records = await readFile(
          fixture.path(P2P.reconciliationsFilename),
        );
        const reads = fixture.financial.methods.length;
        await assert.rejects(fixture.run(), /Only an unresolved authorization/);
        assert.equal(fixture.financial.methods.length, reads);
        await fixture.run(['--audit-only']);
        assert.ok(fixture.financial.methods.length > reads);
        assert.deepEqual(
          await readFile(fixture.path(P2P.journalFilename)),
          journal,
        );
        assert.deepEqual(
          await readFile(fixture.path(P2P.reconciliationsFilename)),
          records,
        );
      } finally {
        await fixture.close();
      }
    },
  );
  void test(
    'actual CLI refuses charged recovery but permits a read-only financial audit',
    RECOVERY_OPTIONS,
    async () => {
      const fixture = await recoveryFixture(false);
      try {
        await assert.rejects(
          fixture.run(),
          /confirmed charge requires charged-outcome recovery/,
        );
        assert.deepEqual(
          await fixture.read(P2P.journalFilename),
          fixture.journal,
        );
        const proof = await fixture.run(['--audit-only']);
        assert.equal(
          proof.chargedAtomic,
          fixture.financial.historicalResult.chargedAtomic,
        );
        assert.deepEqual(
          await fixture.read(P2P.journalFilename),
          fixture.journal,
        );
      } finally {
        await fixture.close();
      }
    },
  );
  for (const fault of [
    'identity',
    'ceiling',
    'channel',
    'multiple',
    'missing signatures',
  ] as const)
    void test(
      'actual CLI rejects original metadata conflict before proof persistence: ' +
        fault,
      RECOVERY_OPTIONS,
      async () => {
        const fixture = await recoveryFixture();
        try {
          const call = {
            requestId: fixture.journal.requestId,
            channelId: fixture.journal.channelId,
            ceilingAtomic: fixture.journal.ceiling,
            outcome: CALL_OUTCOMES.UNCERTAIN,
          };
          if (fault === 'identity')
            await fixture.write(P2P.journalFilename, {
              ...fixture.journal,
              paymentExpectation: {
                ...fixture.journal.paymentExpectation,
                payTo: fixture.financial.expected.authorizer,
              },
            });
          else if (fault === 'missing signatures')
            await fixture.write(P2P.journalFilename, {
              ...fixture.journal,
              claimSignature: '',
            });
          else
            await fixture.write(
              P2P.callsFilename,
              fault === 'multiple'
                ? [call, { ...call, requestId: 'conflicting-request' }]
                : [
                    {
                      ...call,
                      ...(fault === 'ceiling'
                        ? { ceilingAtomic: '1' }
                        : { channelId: 'another-channel' }),
                    },
                  ],
            );
          const journalBefore = await readFile(
            fixture.path(P2P.journalFilename),
          );
          await assert.rejects(fixture.run());
          assert.deepEqual(
            await readFile(fixture.path(P2P.journalFilename)),
            journalBefore,
          );
          assert.equal(fixture.financial.methods.length, 0);
          await assert.rejects(
            stat(fixture.path(P2P.reconciliationsFilename)),
            { code: 'ENOENT' },
          );
        } finally {
          await fixture.close();
        }
      },
    );
}
