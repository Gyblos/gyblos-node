// Product startup exchanges paid usage attestations over local Iroh; finance and homes remain synthetic.
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { chatSession } from '@gyblos/buyer/chat-cli';
import { FILE_MODES, PROTOCOL_FEE, receiptPathsIn } from '@gyblos/config';
import { listReceipts } from '@gyblos/node/receipts';
import { loadRole } from '@gyblos/node/roles';
import {
  OFFER_PRICING_KINDS,
  P2P_ROLES,
  RECEIPT_VERDICTS,
} from '@gyblos/protocol/constants';
import { settlementShares } from '@gyblos/protocol/payment-binding';
import { verifyReceipt } from '@gyblos/protocol/receipt';

import { blockTestMeter } from '../support/batch-block-product';
import { within } from '../support/native-fixture';
import { NATIVE_CAPABILITY } from '../support/native-runtime';
import { sessionProductHost } from '../support/session-product-host';

void test(
  'paid block startup confirms per-question usage and cumulative fee attribution without settling the channel',
  { skip: NATIVE_CAPABILITY.transportSkip },
  async (t) => {
    const host = await sessionProductHost(OFFER_PRICING_KINDS.PAID, undefined, {
      meter: blockTestMeter,
      observe() {},
    });
    t.after(host.close);
    for (let question = 1; question <= 2; question++) {
      let calls = 0;
      let output = '';
      await chatSession({
        ...host.buyer().chat,
        read: async () =>
          ++calls === 1 ? 'synthetic private question' : '/exit',
        write: (text) => {
          output += text;
        },
      });
      assert.match(output, /Approved this question/);
      const signal = AbortSignal.timeout(3000);
      await within(
        (async () => {
          while (host.buyer().receipts().active)
            await delay(10, undefined, { signal });
        })(),
      );
      assert.equal(host.buyer().receipts().saved, question);
    }
    assert.deepEqual(host.finance.calls, ['deposit']);
    assert.equal(host.engine.attempts(), 2);
    const buyer = await loadRole(P2P_ROLES.BUYER);
    const seller = await loadRole(P2P_ROLES.SELLER);
    const records = await listReceipts({
      environment: process.env,
      role: P2P_ROLES.BUYER,
      nodeId: buyer.nodeId,
    });
    assert.equal(records.length, 2);
    let amount = 0n;
    let fees = 0n;
    for (const stored of records) {
      const receipt = await verifyReceipt(stored.receipt);
      assert.ok(receipt.buyer);
      assert.equal(receipt.buyer.record.verdict, RECEIPT_VERDICTS.AGREED);
      assert.equal(
        receipt.seller.record.pricing.kind,
        OFFER_PRICING_KINDS.PAID,
      );
      assert.equal(receipt.seller.record.streaming, true);
      assert.equal(receipt.buyer.record.observed.inputTokens, 2);
      assert.equal(
        receipt.buyer.record.observed.outputTokens,
        receipt.seller.record.usage.outputTokens,
      );
      amount += BigInt(receipt.seller.record.amountAtomic);
      fees += BigInt(receipt.seller.record.feeAtomic);
    }
    assert.equal(
      String(fees),
      settlementShares(String(amount), PROTOCOL_FEE.bps).feeAtomic,
    );
    const confirmed = await listReceipts({
      environment: process.env,
      role: P2P_ROLES.SELLER,
      nodeId: seller.nodeId,
    });
    assert.deepEqual(
      confirmed.map((row) => row.receipt),
      records.map((row) => row.receipt),
    );
    for (const role of [P2P_ROLES.BUYER, P2P_ROLES.SELLER]) {
      const paths = receiptPathsIn(process.env, role);
      assert.equal(
        (await stat(paths.state)).mode & 0o777,
        FILE_MODES.privateFile,
      );
      assert.equal(
        (await readFile(paths.state, 'utf8')).includes(
          'synthetic private question',
        ),
        false,
      );
    }
    await host.restartBoth();
    assert.equal(
      (
        await listReceipts({
          environment: process.env,
          role: P2P_ROLES.BUYER,
          nodeId: buyer.nodeId,
        })
      ).length,
      2,
    );
    assert.equal(host.engine.attempts(), 2);
  },
);

void test(
  'lost terminal approval ACK does not create a completed paid receipt or replay the prompt',
  { skip: NATIVE_CAPABILITY.transportSkip },
  async (t) => {
    const host = await sessionProductHost(OFFER_PRICING_KINDS.PAID, undefined, {
      meter: blockTestMeter,
      observe() {},
    });
    t.after(host.close);
    host.finance.loseAcknowledgment();
    let calls = 0;
    let output = '';
    await chatSession({
      ...host.buyer().chat,
      read: async () =>
        ++calls === 1 ? 'synthetic private question' : '/exit',
      write: (text) => {
        output += text;
      },
    });
    assert.match(output, /No retry was made/);
    assert.equal(host.engine.attempts(), 1);
    assert.equal(host.buyer().receipts().saved, 0);
    const buyer = await loadRole(P2P_ROLES.BUYER);
    const seller = await loadRole(P2P_ROLES.SELLER);
    for (const [role, nodeId] of [
      [P2P_ROLES.BUYER, buyer.nodeId],
      [P2P_ROLES.SELLER, seller.nodeId],
    ] as const) {
      assert.deepEqual(
        await listReceipts({ environment: process.env, role, nodeId }),
        [],
      );
    }
    await host.restartBoth();
    assert.equal(host.engine.attempts(), 1);
    assert.equal(host.finance.approvals(), 1);
    assert.deepEqual(host.finance.calls, ['deposit']);
  },
);
