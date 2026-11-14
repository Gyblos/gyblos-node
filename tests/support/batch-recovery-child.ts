// A real buyer BATCH store in a disposable process; synthetic signing and VM RPC stay in its parent.
import assert from 'node:assert/strict';

import {
  assertIsSignatureBytes,
  type createSolanaRpc,
  type MessagePartialSigner,
} from '@solana/kit';

import { batchPoolPathsIn, batchSessionPathsIn } from '@gyblos/config/home';
import { buyerPaymentsUnresolved } from '@gyblos/node/buyer-chain';
import {
  createBatchBuyer,
  recoverBatchPool,
} from '@gyblos/payments-upto/batch-session';
import { matchBatchTerms } from '@gyblos/protocol/batch-channel';
import type { PaymentSessionTerms } from '@gyblos/protocol/payment-session';
import { isMain } from '@gyblos/runtime';

import {
  CRASH_ACTIONS,
  CRASH_CALLS,
  CRASH_CUTS,
  CRASH_FAILURE,
  CRASH_MESSAGES,
  type CrashCut,
} from './channel-crash-constants';
import type { CrashReply } from './channel-crash-protocol';
import {
  childCrashPort,
  crashObject,
  crashRpc,
  crashSigner,
  type CrashCallPort,
} from './channel-crash-rpc';

export interface BatchCrashInput {
  root: string;
  now: number;
  terms: PaymentSessionTerms;
  action: typeof CRASH_ACTIONS.OPEN | typeof CRASH_ACTIONS.WITHDRAW;
  cut?: CrashCut;
}
function parseInput(raw: unknown): BatchCrashInput {
  const value = crashObject(raw);
  assert.ok(typeof value.root === 'string' && typeof value.now === 'number');
  assert.ok(
    value.action === CRASH_ACTIONS.OPEN ||
      value.action === CRASH_ACTIONS.WITHDRAW,
  );
  const cut = Object.values(CRASH_CUTS).find((item) => item === value.cut);
  assert.ok(cut || value.cut === undefined);
  // The owned parent supplies expectations; matchBatchTerms also runs the strict runtime parser.
  const terms = matchBatchTerms(
    value.terms as PaymentSessionTerms,
    value.terms,
  );
  return {
    root: value.root,
    now: value.now,
    terms,
    action: value.action,
    ...(cut ? { cut } : {}),
  };
}
function ports(input: BatchCrashInput, call: CrashCallPort) {
  const base = crashRpc(call);
  const projected = {
    ...base,
    getSignaturesForAddress: (key: string, config: unknown) => ({
      send: () => call(CRASH_CALLS.HISTORY, [key, config]),
    }),
    getTransaction: (key: string, config: unknown) => ({
      send: () => call(CRASH_CALLS.TRANSACTION, [key, config]),
    }),
    sendTransaction: (wire: string) => ({
      send: async () => {
        if (
          input.cut === CRASH_CUTS.CLOSE_CHECKPOINTED ||
          input.cut === CRASH_CUTS.REFUND_CHECKPOINTED
        )
          await call(CRASH_CALLS.CUT, []);
        return call(CRASH_CALLS.SEND, [wire]);
      },
    }),
  };
  const signer = crashSigner(input.terms.buyer, call);
  const payer = {
    ...signer,
    async signMessages(
      messages: Parameters<MessagePartialSigner['signMessages']>[0],
    ) {
      const reply = await call(CRASH_CALLS.SIGN, [
        messages.map((message) => Uint8Array.from(message.content)),
        true,
      ]);
      assert.ok(Array.isArray(reply) && reply.length === messages.length);
      return reply.map((raw) => {
        assert.ok(raw instanceof Uint8Array);
        assertIsSignatureBytes(raw);
        return { [signer.address]: raw };
      });
    },
  };
  return {
    rpc: projected as unknown as ReturnType<typeof createSolanaRpc>,
    payer,
  };
}

async function execute(
  input: BatchCrashInput,
  call: CrashCallPort,
): Promise<CrashReply> {
  Date.now = () => input.now;
  globalThis.fetch = async () => {
    throw new Error(CRASH_FAILURE);
  };
  const { rpc, payer } = ports(input, call);
  const before = await buyerPaymentsUnresolved();
  let financial: CrashReply['financial'] = null;
  if (input.action === CRASH_ACTIONS.OPEN) {
    const buyer = await createBatchBuyer({
      terms: input.terms,
      paths: batchSessionPathsIn({ GYBLOS_HOME: input.root }, 'buyer'),
      payer,
      now: () => input.now,
      hints: async () => {
        const block = await rpc
          .getLatestBlockhash({ commitment: 'finalized' })
          .send();
        return {
          blockhash: block.value.blockhash,
          lastValidBlockHeight: String(block.value.lastValidBlockHeight),
          slot: String(await rpc.getSlot({ commitment: 'finalized' }).send()),
        };
      },
    });
    try {
      const opening = await buyer.open();
      if (input.cut === CRASH_CUTS.OPEN_CHECKPOINTED)
        await call(CRASH_CALLS.CUT, []);
      await call(CRASH_CALLS.ADMIT, [opening]);
    } finally {
      await buyer.dispose();
    }
  } else {
    const results = await recoverBatchPool({
      paths: batchPoolPathsIn({ GYBLOS_HOME: input.root }),
      payer,
      rpc,
      rpcUrl: 'http://127.0.0.1:9',
      now: () => input.now,
      sleep: async () => {},
    });
    const settlement = results.find((item) => item.settlement)?.settlement;
    if (settlement)
      financial = {
        chargedAtomic: settlement.chargedAtomic,
        refundedAtomic: settlement.refundedAtomic,
      };
  }
  const blocked = await buyerPaymentsUnresolved();
  return {
    runtimeBlockedBefore: before,
    entry: null,
    financial,
    runtimeBlocked: blocked,
    startupBlocked: blocked,
  };
}
function main() {
  process.once('message', (raw: unknown) => {
    const value = crashObject(raw);
    assert.equal(value.kind, CRASH_MESSAGES.INIT);
    const call = childCrashPort();
    void execute(parseInput(value.input), call).then(
      (result) =>
        process.send!({ kind: CRASH_MESSAGES.DONE, ok: true, result }, () =>
          process.disconnect?.(),
        ),
      () =>
        process.send!(
          { kind: CRASH_MESSAGES.DONE, ok: false, code: CRASH_FAILURE },
          () => process.disconnect?.(),
        ),
    );
  });
}
if (isMain(import.meta.url)) main();
