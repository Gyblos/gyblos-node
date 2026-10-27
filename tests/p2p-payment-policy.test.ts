// Checks P2P buyer payment policy: per-request ceilings before signing, the exclusive buyer lock and
// single-process CLI.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { generateKeyPairSigner } from '@solana/kit';
import { encodePaymentRequiredHeader } from '@x402/core/http';

import { DEVNET, DEVNET_USDC, ROLE_FILES } from '@gyblos/config';
import { P2P_ROLES } from '@gyblos/node/constants';
import { createInferenceBuyer } from '@gyblos/payments-x402/inference-buyer';
import { withExclusiveLock } from '@gyblos/payments-x402/recovery/lock';
import { saveJson } from '@gyblos/runtime';

import { NATIVE_CAPABILITY } from './support/native-runtime';

void test('request-specific ceiling rejects altered challenges before any signature or paid request', async () => {
  const original = globalThis.fetch;
  const signer = await generateKeyPairSigner();
  const feePayer = 'HZLkSwMefjig2NhrKaW3Hb16JX8PTQnE4Jutdc2B433g';
  const authorizer = '4hL4FcqMnrjMLnmyWzaSHhYiwV7FMjVr3CwnpehHNCV7';
  let signatures = 0;
  let paidRequests = 0;
  try {
    for (const amount of ['561', '559', '560']) {
      globalThis.fetch = (async (_input, init) => {
        if (new Headers(init?.headers).has('payment-signature')) paidRequests++;
        return Response.json(
          {},
          {
            status: 402,
            headers: {
              'PAYMENT-REQUIRED': encodePaymentRequiredHeader({
                x402Version: 2,
                resource: {
                  url: 'https://synthetic.test/',
                  description: 'synthetic',
                  mimeType: 'application/json',
                },
                accepts: [
                  {
                    scheme: 'upto',
                    network: DEVNET,
                    asset: DEVNET_USDC,
                    amount,
                    payTo: feePayer,
                    maxTimeoutSeconds: 60,
                    extra: {
                      feePayer,
                      receiverAuthorizer: authorizer,
                      withdrawDelay: 60,
                      tokenProgram: TOKEN_PROGRAM_ADDRESS,
                      recentBlockhash: '11111111111111111111111111111111',
                      lastValidBlockHeight: '1000',
                      recentSlot: '1',
                    },
                  },
                ],
              }),
            },
          },
        );
      }) as typeof fetch;
      const invoke = createInferenceBuyer(
        {
          ...signer,
          async signTransactions(
            ...args: Parameters<typeof signer.signTransactions>
          ) {
            signatures++;
            return signer.signTransactions(...args);
          },
        },
        'https://rpc-forbidden.test/',
        {
          mint: DEVNET_USDC,
          payTo: feePayer,
          feePayer,
          receiverAuthorizer: authorizer,
          maxAtomic: '560',
          expectedAmount: '560',
        },
        {
          beforeSigning() {
            if (amount === '560')
              throw new Error('Signed offer expired before signing.');
          },
          async authorized() {
            throw new Error('Unexpected authorization');
          },
        },
      );
      await assert.rejects(
        invoke('https://synthetic.test/', { prompt: 'synthetic' }),
        undefined,
      );
    }
    assert.equal(signatures, 0);
    assert.equal(paidRequests, 0);
  } finally {
    globalThis.fetch = original;
  }
});

void test('exclusive buyer lock preserves an unresolved authorization against concurrent calls', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gyblos-p2p-journal-'));
  const lock = join(directory, 'buyer.lock');
  const journal = join(directory, 'authorization.json');
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const first = withExclusiveLock(lock, async () => {
      await saveJson(journal, {
        state: 'uncertain',
        channelId: 'synthetic-channel',
      });
      entered();
      await hold;
    });
    await started;
    await assert.rejects(
      withExclusiveLock(lock, async () => {
        await saveJson(journal, { state: 'confirmed' });
      }),
      /holds the buyer lock/,
    );
    assert.equal(
      JSON.parse(await readFile(journal, 'utf8')).state,
      'uncertain',
    );
    release();
    await first;
  } finally {
    release();
    await rm(directory, { recursive: true, force: true });
  }
});

void test(
  'P2P CLI refuses a second process before loading config or making requests',
  { skip: NATIVE_CAPABILITY.bindingSkip },
  async () => {
    const { main: paidCall } = await import('@gyblos/buyer/call');
    const { rolePath } = await import('@gyblos/node/roles');
    const original = process.cwd();
    const directory = await mkdtemp(join(tmpdir(), 'gyblos-p2p-call-lock-'));
    try {
      process.chdir(directory);
      await withExclusiveLock(
        rolePath(P2P_ROLES.BUYER, ROLE_FILES.buyerLock),
        async () => {
          await assert.rejects(paidCall(), /holds the buyer lock/);
        },
      );
    } finally {
      process.chdir(original);
      await rm(directory, { recursive: true, force: true });
    }
  },
);
