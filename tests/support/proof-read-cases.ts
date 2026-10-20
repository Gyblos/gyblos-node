import assert from 'node:assert/strict';
import test from 'node:test';

import {
  paymentProof,
  type PaymentProofObservation,
} from '@gyblos/cli/p2p/proof';
import { COMMITMENT, RETRIES, TOKEN_PROGRAM_ADDRESS } from '@gyblos/config';
import { GateError } from '@gyblos/payments-x402/chain';
import { GATE_ERROR_CODES } from '@gyblos/payments-x402/constants';

import { paymentFixture } from './payment-fixture.js';

interface ReadFaults {
  laggingIndex?: boolean;
  missingIndex?: boolean;
  staleSnapshot?: boolean;
  requireContext?: boolean;
  duplicateDeposit?: boolean;
  wrongCeiling?: boolean;
}
interface ReadProbe {
  run: (
    observed?: Parameters<typeof paymentProof>[5],
  ) => ReturnType<typeof paymentProof>;
  histories: () => number;
  methods: string[];
}

async function withProofReads(
  options: ReadFaults,
  verify: (probe: ReadProbe) => Promise<void>,
) {
  const { expected, source, historicalResult } = await paymentFixture();
  const original = globalThis.fetch;
  let histories = 0;
  const methods: string[] = [];
  const before = {
    slot: source.deposit.slot - 1,
    buyer: '10000',
    seller: '10000',
    buyerLamports: '0',
    escrow: null,
  };
  globalThis.fetch = (async (url, init) => {
    assert.equal(String(url), expected.rpcUrl);
    const request: { method: string; params: unknown[] } = JSON.parse(
      String(init?.body),
    );
    const { method, params } = request;
    methods.push(method);
    let result: unknown;
    if (method === 'getSignatureStatuses')
      result = { value: [{ err: null, confirmationStatus: COMMITMENT }] };
    else if (method === 'getTransaction') {
      assert.ok(
        [expected.depositSignature, expected.claimSignature].includes(
          String(params[0]),
        ),
      );
      result =
        params[0] === expected.claimSignature ? source.claim : source.deposit;
    } else if (method === 'getSignaturesForAddress') {
      assert.equal(params[0], expected.channelId);
      histories++;
      if (options.requireContext)
        assert.equal(
          (params[1] as { minContextSlot?: number }).minContextSlot,
          source.claim.slot,
        );
      const deposit = { signature: expected.depositSignature, err: null };
      result = [
        { signature: expected.claimSignature, err: null },
        ...(options.missingIndex || (options.laggingIndex && histories === 1)
          ? []
          : [deposit]),
        ...(options.duplicateDeposit ? [deposit] : []),
      ];
    } else if (method === 'getMultipleAccounts') {
      if (options.requireContext)
        assert.equal(
          (params[1] as { minContextSlot?: number }).minContextSlot,
          source.claim.slot,
        );
      const account = (owner: string, amount: string) => ({
        owner: TOKEN_PROGRAM_ADDRESS,
        data: {
          parsed: {
            info: { owner, mint: expected.mint, tokenAmount: { amount } },
          },
        },
      });
      result = {
        context: { slot: source.claim.slot - (options.staleSnapshot ? 1 : 0) },
        value: [
          account(
            expected.buyer,
            (10000n - BigInt(historicalResult.chargedAtomic)).toString(),
          ),
          account(
            expected.payTo,
            (10000n + BigInt(historicalResult.chargedAtomic)).toString(),
          ),
          null,
          null,
        ],
      };
    } else throw new Error(`Forbidden mock RPC: ${method}`);
    return Response.json({ result });
  }) as typeof fetch;
  try {
    await verify({
      run: (observed) =>
        paymentProof(
          {
            rpcUrl: expected.rpcUrl,
            mint: expected.mint,
            addresses: { buyer: expected.buyer, seller: expected.payTo },
          },
          expected.channelId,
          options.wrongCeiling
            ? (BigInt(expected.ceiling) + 1n).toString()
            : expected.ceiling,
          expected.claimSignature,
          before,
          observed,
        ),
      histories: () => histories,
      methods,
    });
    assert.ok(methods.every((method) => method.startsWith('get')));
  } finally {
    globalThis.fetch = original;
  }
}

export function registerProofReadCases() {
  test('a lagging deposit index is reread without another payment', async () => {
    await withProofReads({ laggingIndex: true }, async ({ run, histories }) => {
      const proof = await run();
      assert.equal(histories(), 2);
      assert.ok(BigInt(proof.chargedAtomic) > 0n);
    });
  });
  test('the known claim slot constrains subsequent history and account reads', async () => {
    await withProofReads({ requireContext: true }, async ({ run }) => {
      await run();
    });
  });
  test('a post-claim snapshot older than the claim slot cannot pass coincidentally matching balances', async () => {
    await withProofReads({ staleSnapshot: true }, async ({ run }) => {
      await assert.rejects(run, /snapshot.*claim slot/i);
    });
  });
  test('deposit discovery is observable before a later snapshot guard rejects the proof', async () => {
    const { expected } = await paymentFixture();
    const observed: PaymentProofObservation[] = [];
    await withProofReads({ staleSnapshot: true }, async ({ run }) => {
      await assert.rejects(
        run((value) => {
          observed.push(value);
        }),
        /snapshot.*claim slot/i,
      );
    });
    assert.deepEqual(observed, [
      {
        depositSignature: expected.depositSignature,
        claimSignature: expected.claimSignature,
      },
    ]);
  });
  test('missing deposit visibility stops at the configured read budget', async () => {
    await withProofReads({ missingIndex: true }, async ({ run, histories }) => {
      await assert.rejects(
        run,
        (error: unknown) =>
          error instanceof GateError &&
          error.code === GATE_ERROR_CODES.TRANSACTION_UNKNOWN,
      );
      assert.equal(histories(), RETRIES.transaction);
    });
  });
  test('read retries do not relax charge-plus-refund conservation', async () => {
    await withProofReads({ wrongCeiling: true }, async ({ run, histories }) => {
      await assert.rejects(run, assert.AssertionError);
      assert.equal(histories(), 0);
    });
  });
  test('ambiguous duplicate deposits fail instead of selecting one through retries', async () => {
    await withProofReads(
      { duplicateDeposit: true },
      async ({ run, histories }) => {
        await assert.rejects(run, assert.AssertionError);
        assert.equal(histories(), 1);
      },
    );
  });
}
