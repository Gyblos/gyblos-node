import assert from 'node:assert/strict';
import test from 'node:test';

import { CALL_OUTCOMES } from '@gyblos/cli/p2p/constants';
import { P2P } from '@gyblos/config';
import { TRANSPORT_ROUTES } from '@gyblos/transport/constants';

import { exportFixture } from './export-fixture.js';
import { paymentAccounts, tokenLeg } from './payment-mutations.js';

type Lab = Awaited<ReturnType<typeof exportFixture>>;
const call = (lab: Lab) => lab.paid[0]!;
const trace = (lab: Lab) => lab.traces[0]!;

export function registerExportCases() {
  test('actual collector preserves original payment fields and observed snapshots', async (context) => {
    const fixture = await exportFixture(context),
      original = structuredClone(call(fixture)),
      snapshot = structuredClone(trace(fixture).during);
    const result = await fixture.collect(),
      first = result.cases[0]!;
    assert.equal(result.cases.length, P2P.minimumRequests);
    for (const field of [
      'ceilingAtomic',
      'chargedAtomic',
      'refundAtomic',
      'depositSignature',
      'claimSignature',
      'depositSlot',
      'claimSlot',
    ] as const)
      assert.equal(first[field], original[field]);
    assert.deepEqual(first.balances, {
      before: original.before,
      depositConfirmed: snapshot,
      after: original.after,
    });
  });
  test('actual collector records exact-ceiling observation as explicit zero excess', async (context) => {
    const fixture = await exportFixture(context);
    assert.equal(
      (await fixture.collect()).cases[0]!.preInferenceEscrowExcessAtomic,
      '0',
    );
  });
  for (const excess of [1n, 17n, 9007199254740993n])
    test(
      'observed escrow excess stays separate from principal and finalized treasury=' +
        excess,
      async (context) => {
        const fixture = await exportFixture(context),
          original = structuredClone(call(fixture));
        trace(fixture).during.escrow = (
          BigInt(original.ceilingAtomic) + excess
        ).toString();
        const result = await fixture.collect(),
          first = result.cases[0]!;
        assert.equal(first.preInferenceEscrowExcessAtomic, excess.toString());
        assert.equal(first.ceilingAtomic, original.ceilingAtomic);
        assert.equal(first.chargedAtomic, original.chargedAtomic);
        assert.equal(first.refundAtomic, original.refundAtomic);
        assert.equal(
          first.balances.depositConfirmed.escrow,
          trace(fixture).during.escrow,
        );
        assert.equal(result.previousAttempts[0]!.treasurySweepAtomic, '1');
        assert.equal(
          result.previousAttempts[0]!.escrowInterveningTokenCreditAtomic,
          '1',
        );
        assert.equal(Object.hasOwn(first, 'treasurySweepAtomic'), false);
      },
    );
  test('surplus-aware export respects required relay and original call offset', async (context) => {
    const fixture = await exportFixture(context);
    for (const paid of fixture.paid)
      paid.transport = {
        transport: TRANSPORT_ROUTES.RELAY,
        connectMs: 1,
        directObserved: false,
        relayObserved: true,
      };
    trace(fixture).during.escrow = (
      BigInt(call(fixture).ceilingAtomic) + 3n
    ).toString();
    fixture.calls.unshift({
      outcome: CALL_OUTCOMES.UNCERTAIN,
      channelId: 'unselected-history',
      ceilingAtomic: '1',
    });
    const result = await fixture.collect({
      offset: 1,
      expectedRoute: TRANSPORT_ROUTES.RELAY,
    });
    assert.equal(result.cases[0]!.preInferenceEscrowExcessAtomic, '3');
    assert.equal(result.cases[0]!.transport, TRANSPORT_ROUTES.RELAY);
  });
  test('unrelated old traces do not prevent exact request and channel matching', async (context) => {
    const fixture = await exportFixture(context);
    fixture.traces.push({
      ...trace(fixture),
      requestId: 'older-request',
      channelId: 'older-channel',
    });
    assert.equal((await fixture.collect()).cases.length, P2P.minimumRequests);
  });
  const faults: Record<string, (lab: Lab) => void> = {
    'insufficient escrow': (f) => {
      trace(f).during.escrow = (BigInt(call(f).ceilingAtomic) - 1n).toString();
    },
    'changed seller balance': (f) => {
      trace(f).during.seller = '1';
    },
    'missing seller balances': (f) => {
      Reflect.deleteProperty(trace(f).during, 'seller');
      Reflect.deleteProperty(call(f).before, 'seller');
    },
    'non-string seller balances': (f) => {
      Reflect.set(trace(f).during, 'seller', 0);
      Reflect.set(call(f).before, 'seller', 0);
    },
    'negative seller balances': (f) => {
      trace(f).during.seller = '-1';
      call(f).before.seller = '-1';
    },
    'changed trace channel': (f) => {
      trace(f).channelId = 'different-channel';
    },
    'changed trace request': (f) => {
      trace(f).requestId = 'different-request';
    },
    'missing trace request': (f) => {
      Reflect.deleteProperty(trace(f), 'requestId');
    },
    'missing call request': (f) => {
      Reflect.deleteProperty(call(f), 'requestId');
    },
    'blank matching request': (f) => {
      call(f).requestId = ' ';
      trace(f).requestId = ' ';
    },
    'blank matching channel': (f) => {
      call(f).channelId = ' ';
      trace(f).channelId = ' ';
    },
    'missing matching channel': (f) => {
      Reflect.deleteProperty(call(f), 'channelId');
      Reflect.deleteProperty(trace(f), 'channelId');
    },
    'duplicate matching trace': (f) => {
      f.traces.push(structuredClone(trace(f)));
    },
    'duplicate channel with another request': (f) => {
      f.traces.push({ ...trace(f), requestId: 'conflicting-request' });
    },
    'duplicate request with another channel': (f) => {
      f.traces.push({ ...trace(f), channelId: 'conflicting-channel' });
    },
    'duplicate selected channel': (f) => {
      f.calls[1] = structuredClone(call(f));
    },
    'duplicate selected request': (f) => {
      f.paid[1]!.requestId = call(f).requestId;
      f.traces[1]!.requestId = call(f).requestId;
    },
    'missing trace': (f) => {
      f.traces.shift();
    },
    'missing snapshot': (f) => {
      Reflect.deleteProperty(trace(f), 'during');
    },
    'principal loss despite excess': (f) => {
      trace(f).during.escrow = (BigInt(call(f).ceilingAtomic) + 1n).toString();
      call(f).refundAtomic = (BigInt(call(f).refundAtomic) - 1n).toString();
    },
    'principal over-credit': (f) => {
      call(f).refundAtomic = call(f).ceilingAtomic;
    },
    'missing confirmed call': (f) => {
      f.calls.splice(1, 1);
    },
    'wrong required route': (f) => {
      call(f).transport = {
        transport: TRANSPORT_ROUTES.RELAY,
        connectMs: 1,
        directObserved: false,
        relayObserved: true,
      };
    },
    'mixed route observations': (f) => {
      call(f).transport.relayObserved = true;
    },
    'missing route observation': (f) => {
      Reflect.deleteProperty(call(f), 'transport');
    },
    'known paid discrepancy': (f) => {
      call(f).outcome = CALL_OUTCOMES.ROUTE_DISCREPANCY;
    },
  };
  for (const [name, mutate] of Object.entries(faults))
    test('collector rejects ' + name, async (context) => {
      const fixture = await exportFixture(context);
      mutate(fixture);
      await assert.rejects(fixture.collect());
    });
  for (const value of [
    null,
    undefined,
    -1,
    0,
    '-1',
    '1.5',
    '1e3',
    '+556',
    ' 556',
    '556 ',
    '0x22c',
    '0556',
    '',
    {},
    [],
  ]) {
    test(
      'collector rejects malformed escrow ' + JSON.stringify(value),
      async (context) => {
        const fixture = await exportFixture(context);
        Reflect.set(trace(fixture).during, 'escrow', value);
        await assert.rejects(fixture.collect());
      },
    );
  }
  const invalidFields = {
    ceilingAtomic: ['0', '-1', 556, '0556', '1.5', null],
    chargedAtomic: ['-1', 1, '01', '1.5', null],
    refundAtomic: ['-1', 555, '0555', '1.5', null],
  };
  for (const [field, values] of Object.entries(invalidFields))
    for (const value of values)
      test(
        'collector rejects malformed ' + field + ' ' + JSON.stringify(value),
        async (context) => {
          const fixture = await exportFixture(context);
          Reflect.set(call(fixture), field, value);
          await assert.rejects(fixture.collect());
        },
      );
  for (const ending of ['\n', '\r\n'])
    for (const field of [
      'escrow',
      'ceilingAtomic',
      'chargedAtomic',
      'refundAtomic',
      'seller',
    ] as const)
      test(
        'collector rejects trailing line ending in ' +
          field +
          ' ' +
          JSON.stringify(ending),
        async (context) => {
          const fixture = await exportFixture(context);
          if (field === 'escrow') trace(fixture).during.escrow += ending;
          else if (field === 'seller') {
            trace(fixture).during.seller += ending;
            call(fixture).before.seller += ending;
          } else call(fixture)[field] += ending;
          await assert.rejects(fixture.collect());
        },
      );
  test('zero-charge export re-fetches treasury proof despite stale local fields', async (context) => {
    const fixture = await exportFixture(context),
      result = await fixture.collect(),
      proof = result.previousAttempts[0]!;
    assert.equal(proof.treasurySweepAtomic, '1');
    assert.equal(proof.escrowInterveningTokenCreditAtomic, '1');
    assert.equal(proof.chargedAtomic, '0');
    assert.equal(proof.refundAtomic, fixture.financial.expected.ceiling);
    assert.ok(fixture.financial.methods.includes('getTransaction'));
    assert.equal(proof.provenanceVerified, false);
  });
  test('zero-charge export rejects an incorrect canonical treasury sweep', async (context) => {
    const fixture = await exportFixture(context),
      accounts = await paymentAccounts(fixture.financial);
    tokenLeg(fixture.financial, accounts.treasuryAta).info.tokenAmount.amount =
      '2';
    await assert.rejects(fixture.collect());
  });
  test('zero-charge export cannot mask a charged outcome with forged stored zero fields', async (context) => {
    const fixture = await exportFixture(context, false);
    await assert.rejects(
      fixture.collect(),
      /confirmed charge requires charged-outcome recovery/,
    );
  });
  test('zero-charge export binds the original attempt ceiling', async (context) => {
    const fixture = await exportFixture(context);
    fixture.records[0]!.ceilingAtomic = '1';
    await assert.rejects(fixture.collect());
  });
}
