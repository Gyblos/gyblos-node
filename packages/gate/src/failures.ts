import assert from 'node:assert/strict';
import { once } from 'node:events';

import { getCreateAssociatedTokenIdempotentInstructionAsync } from '@solana-program/token';
import {
  address,
  appendTransactionMessageInstructions,
  blockhash,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from '@solana/kit';
import {
  decodePaymentRequiredHeader,
  decodePaymentSignatureHeader,
} from '@x402/core/http';

import {
  COMMITMENT,
  LOCAL_DIR,
  LOCALHOST,
  localPath,
  LOCK_PATH,
} from '@gyblos/config';
import { loadConfig, saveJson, signer } from '@gyblos/gate/config';
import { assertNoUnresolvedAuthorizations } from '@gyblos/gate/journal';
import { withExclusiveLock } from '@gyblos/gate/lock';
import { createBuyer } from '@gyblos/payments-x402/buyer';
import {
  account,
  assertProgram,
  confirm,
  rpc,
  tokens,
} from '@gyblos/payments-x402/chain';
import { DEVNET, MAX_ATOMIC } from '@gyblos/payments-x402/constants';
import { createFacilitator } from '@gyblos/payments-x402/facilitator';
import { createGateSeller } from '@gyblos/payments-x402/seller';

export async function failureGate() {
  async function failures() {
    const c = await loadConfig();
    await assertProgram(c.rpcUrl);
    // This harness creates only devnet test-token accounts, never imports a user wallet.
    assert.equal(c.assetLabel, 'devnet-test-token');
    await assertNoUnresolvedAuthorizations();
    const sponsor = await signer(c, 'facilitator'),
      emptyBuyer = await generateKeyPairSigner();
    const latest = (
      await rpc<{ value: { blockhash: string; lastValidBlockHeight: number } }>(
        c.rpcUrl,
        'getLatestBlockhash',
        [{ commitment: COMMITMENT }],
      )
    ).value;
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(sponsor, m),
      (m) =>
        setTransactionMessageLifetimeUsingBlockhash(
          {
            blockhash: blockhash(latest.blockhash),
            lastValidBlockHeight: BigInt(latest.lastValidBlockHeight),
          },
          m,
        ),
      (m) => appendTransactionMessageInstructions([], m),
    );
    const ix = await getCreateAssociatedTokenIdempotentInstructionAsync({
      payer: sponsor,
      owner: emptyBuyer.address,
      mint: address(c.mint),
    });
    const tx = await signTransactionMessageWithSigners(
      appendTransactionMessageInstructions([ix], message),
    );
    const setupTransaction = await rpc<string>(c.rpcUrl, 'sendTransaction', [
      getBase64EncodedWireTransaction(tx),
      { encoding: 'base64', preflightCommitment: COMMITMENT },
    ]);
    await confirm(c.rpcUrl, setupTransaction);
    const results = [];
    for (const kind of ['F1', 'F2'] as const) {
      const buyerSigner = kind === 'F1' ? emptyBuyer : await signer(c, 'buyer');
      const f = createFacilitator(sponsor, c.rpcUrl, {
        buyer: buyerSigner.address,
        mint: c.mint,
        payTo: c.addresses.seller,
        authorizer: c.addresses.authorizer,
      });
      const fs = f.app.listen(0, LOCALHOST);
      await once(fs, 'listening');
      const fa = fs.address();
      assert.ok(fa && typeof fa !== 'string');
      let ss: ReturnType<typeof f.app.listen> | undefined;
      try {
        const s = await createGateSeller({
          rpcUrl: c.rpcUrl,
          facilitatorUrl: `http://${LOCALHOST}:${fa.port}`,
          mint: c.mint,
          payTo: c.addresses.seller,
          authorizer: await signer(c, 'authorizer'),
        });
        ss = s.app.listen(0, LOCALHOST);
        await once(ss, 'listening');
        const sa = ss.address();
        assert.ok(sa && typeof sa !== 'string');
        const url = `http://${LOCALHOST}:${sa.port}`;
        const before = {
          buyer: (
            await tokens(c.rpcUrl, buyerSigner.address, c.mint)
          ).toString(),
          seller: (
            await tokens(c.rpcUrl, c.addresses.seller, c.mint)
          ).toString(),
        };
        let channelId = '',
          expiresAt = 0,
          rejection: unknown;
        const fetchImpl: typeof fetch = async (input, init) => {
          const req = new Request(input, init);
          const header = req.headers.get('PAYMENT-SIGNATURE');
          if (header && kind === 'F2') {
            expiresAt = Number(
              decodePaymentSignatureHeader(header).payload.expiresAt,
            );
            const wait = Math.max(0, expiresAt * 1000 - Date.now() + 2000);
            console.log(
              `F2: waiting ${Math.ceil(wait / 1000)} seconds for authorization expiry.`,
            );
            await new Promise((resolve) => setTimeout(resolve, wait));
            // The resource layer can reject expiry before calling the facilitator.
            // Verify the same expired payload directly as a read-only diagnostic.
            const payload = decodePaymentSignatureHeader(header);
            const diagnostic = await fetch(
              `http://${LOCALHOST}:${fa.port}/verify`,
              {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  paymentPayload: payload,
                  paymentRequirements: payload.accepted,
                }),
              },
            );
            assert.equal(diagnostic.status, 200);
            const verification = (await diagnostic.json()) as {
              isValid: boolean;
              invalidReason?: string;
            };
            assert.equal(verification.isValid, false);
            assert.match(verification.invalidReason ?? '', /expir/i);
          }
          const response = await fetch(req);
          if (header && response.status === 402) {
            const required = response.headers.get('PAYMENT-REQUIRED');
            rejection = required
              ? decodePaymentRequiredHeader(required).error
              : await response.clone().json();
          }
          return response;
        };
        const b = createBuyer(
          buyerSigner,
          c.rpcUrl,
          {
            mint: c.mint,
            payTo: c.addresses.seller,
            feePayer: c.addresses.facilitator,
            receiverAuthorizer: c.addresses.authorizer,
            maxAtomic: MAX_ATOMIC,
          },
          fetchImpl,
          async (a) => {
            channelId = a.channelId;
            await saveJson(`${LOCAL_DIR}/failure-${kind}-attempt.json`, {
              state: 'authorization-created',
              channelId,
              createdAt: new Date().toISOString(),
              case: kind,
            });
          },
        );
        const response = await b.request(`${url}/api/generate`);
        assert.equal(response.status, 402);
        assert.ok(channelId);
        const health = (await fetch(`${url}/health`).then((r) => r.json())) as {
          handlerCalls: number;
        };
        assert.equal(health.handlerCalls, 0);
        assert.ok(f.events.every((e) => !e.success));
        const channel = await account(c.rpcUrl, channelId);
        const history = await rpc<unknown[]>(
          c.rpcUrl,
          'getSignaturesForAddress',
          [channelId, { limit: 10 }],
        );
        assert.equal(channel, null);
        assert.equal(history.length, 0);
        const after = {
          buyer: (
            await tokens(c.rpcUrl, buyerSigner.address, c.mint)
          ).toString(),
          seller: (
            await tokens(c.rpcUrl, c.addresses.seller, c.mint)
          ).toString(),
        };
        assert.deepEqual(after, before);
        if (kind === 'F1') {
          assert.equal(before.buyer, '0');
          assert.equal(
            f.events[0]?.errorReason,
            'invalid_upto_svm_settlement_simulation',
          );
          assert.match(f.events[0]?.errorMessage ?? '', /Custom.*1[^0-9]/);
        } else {
          assert.ok(expiresAt * 1000 < Date.now());
          assert.match(
            f.verifications.find((v) => !v.isValid)?.invalidReason ?? '',
            /expir/i,
          );
        }
        results.push({
          case: kind,
          status: 'passed',
          httpStatus: response.status,
          buyer: buyerSigner.address,
          channelId,
          expiresAt: expiresAt || undefined,
          rejection,
          verifications: f.verifications,
          events: f.events,
          handlerCalls: health.handlerCalls,
          before,
          after,
          channelExists: false,
          paymentTransactions: history,
        });
        await saveJson(
          `${LOCAL_DIR}/failure-${kind}-result.json`,
          results.at(-1),
        );
        await saveJson(`${LOCAL_DIR}/failure-${kind}-attempt.json`, {
          state: 'resolved-rejected',
          channelId,
          resolvedAt: new Date().toISOString(),
          resultPath: `${LOCAL_DIR}/failure-${kind}-result.json`,
        });
        console.log(
          `${kind} passed: HTTP 402, no channel, no resource execution, unchanged token balances.`,
        );
      } finally {
        if (ss)
          await new Promise<void>((resolve) => ss!.close(() => resolve()));
        await new Promise<void>((resolve) => fs.close(() => resolve()));
      }
    }
    const evidence = {
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      network: DEVNET,
      mint: c.mint,
      assetLabel: c.assetLabel,
      setupTransaction,
      results,
      limitations: [
        'F1/F2 only; no replay or seller-crash validation',
        'Fixed resource, not inference',
      ],
    };
    await saveJson(localPath('failure-evidence.json'), evidence);
    console.log(JSON.stringify(evidence, null, 2));
  }
  try {
    await withExclusiveLock(LOCK_PATH, failures);
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : 'Failure gate failed.',
    );
    process.exitCode = 1;
  }
}
