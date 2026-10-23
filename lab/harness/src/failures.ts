// F1/F2 failure gate: an empty buyer and an expired authorization must both get 402 with no channel,
// no resource execution and unchanged balances. Requires the devnet test token.
import assert from 'node:assert/strict';
import { once } from 'node:events';

import { address } from '@solana/kit';
import {
  decodePaymentRequiredHeader,
  decodePaymentSignatureHeader,
} from '@x402/core/http';

import {
  DEVNET,
  DIAGNOSTIC_LIMITS,
  HTTP_STATUS,
  LOCALHOST,
  MAX_ATOMIC,
  ROUTES,
  TIMEOUTS,
  UNITS,
} from '@gyblos/config';
import { CONFIG_ASSET_LABELS, WALLET_ROLES } from '@gyblos/config/constants';
import { loadConfig, signer } from '@gyblos/config/wallet';
import { createBuyer } from '@gyblos/payments-x402';
import {
  account,
  assertProgram,
  rpc,
  tokens,
} from '@gyblos/payments-x402/chain';
import { JOURNAL_STATES } from '@gyblos/payments-x402/constants';
import { createFacilitator } from '@gyblos/payments-x402/facilitator';
import { withExclusiveLock } from '@gyblos/payments-x402/recovery/lock';
import { saveJson } from '@gyblos/runtime';

import {
  CASE_STATUSES,
  FAILURE_CASES,
  FAILURE_EVIDENCE_PATH,
  failureJournalPath,
  failureResultPath,
  GATE_ROUTES,
  LOCK_PATH,
  SCHEMA_VERSIONS,
} from './constants.js';
import { prepareFailureAccounts } from './failure-setup.js';
import { createGateSeller } from './fixed-seller.js';
import type {
  FailureCaseResult,
  FailureGateEvidence,
} from './fixture-evidence-types.js';
import { assertNoUnresolvedAuthorizations, saveJournal } from './journal.js';

export async function failureGate() {
  async function failures() {
    const config = await loadConfig();
    await assertProgram(config.rpcUrl);
    // This harness creates only devnet test-token accounts, never imports a user wallet.
    assert.equal(config.assetLabel, CONFIG_ASSET_LABELS.TEST_TOKEN);
    await assertNoUnresolvedAuthorizations();
    const { sponsor, emptyBuyer, setupTransaction } =
      await prepareFailureAccounts(config);
    const results: FailureCaseResult[] = [];
    for (const kind of [
      FAILURE_CASES.EMPTY_BUYER,
      FAILURE_CASES.EXPIRED,
    ] as const) {
      const buyerSigner =
        kind === FAILURE_CASES.EMPTY_BUYER
          ? emptyBuyer
          : await signer(config, WALLET_ROLES.BUYER);
      const facilitator = createFacilitator(sponsor, config.rpcUrl, {
        buyer: buyerSigner.address,
        mint: config.mint,
        payTo: config.addresses.seller,
        authorizer: config.addresses.authorizer,
      });
      const facilitatorServer = facilitator.app.listen(0, LOCALHOST);
      await once(facilitatorServer, 'listening');
      const facilitatorAddress = facilitatorServer.address();
      assert.ok(facilitatorAddress && typeof facilitatorAddress !== 'string');
      let sellerServer: ReturnType<typeof facilitator.app.listen> | undefined;
      try {
        const seller = await createGateSeller({
          rpcUrl: config.rpcUrl,
          facilitatorUrl: `http://${LOCALHOST}:${facilitatorAddress.port}`,
          mint: config.mint,
          payTo: config.addresses.seller,
          authorizer: await signer(config, WALLET_ROLES.AUTHORIZER),
        });
        sellerServer = seller.app.listen(0, LOCALHOST);
        await once(sellerServer, 'listening');
        const sellerAddress = sellerServer.address();
        assert.ok(sellerAddress && typeof sellerAddress !== 'string');
        const url = `http://${LOCALHOST}:${sellerAddress.port}`;
        const before = {
          buyer: (
            await tokens(config.rpcUrl, buyerSigner.address, config.mint)
          ).toString(),
          seller: (
            await tokens(config.rpcUrl, config.addresses.seller, config.mint)
          ).toString(),
        };
        let channelId = '';
        let expiresAt = 0;
        let rejection: unknown;
        const fetchImpl: typeof fetch = async (input, init) => {
          const request = new Request(input, init);
          const header = request.headers.get('PAYMENT-SIGNATURE');
          if (header && kind === FAILURE_CASES.EXPIRED) {
            expiresAt = Number(
              decodePaymentSignatureHeader(header).payload.expiresAt,
            );
            const wait = Math.max(
              0,
              expiresAt * UNITS.millisecondsPerSecond -
                Date.now() +
                TIMEOUTS.expiryGrace,
            );
            console.log(
              `F2: waiting ${Math.ceil(wait / UNITS.millisecondsPerSecond)} seconds for authorization expiry.`,
            );
            await new Promise((resolve) => setTimeout(resolve, wait));
            // The resource layer can reject expiry before calling the facilitator.
            // Verify the same expired payload directly as a read-only diagnostic.
            const payload = decodePaymentSignatureHeader(header);
            const diagnostic = await fetch(
              `http://${LOCALHOST}:${facilitatorAddress.port}${ROUTES.verify}`,
              {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  paymentPayload: payload,
                  paymentRequirements: payload.accepted,
                }),
              },
            );
            assert.equal(diagnostic.status, HTTP_STATUS.ok);
            const verification = (await diagnostic.json()) as {
              isValid: boolean;
              invalidReason?: string;
            };
            assert.equal(verification.isValid, false);
            assert.match(verification.invalidReason ?? '', /expir/i);
          }
          const response = await fetch(request);
          if (header && response.status === HTTP_STATUS.paymentRequired) {
            const required = response.headers.get('PAYMENT-REQUIRED');
            rejection = required
              ? decodePaymentRequiredHeader(required).error
              : await response.clone().json();
          }
          return response;
        };
        const buyer = createBuyer(
          buyerSigner,
          config.rpcUrl,
          {
            mint: config.mint,
            payTo: config.addresses.seller,
            feePayer: config.addresses.facilitator,
            receiverAuthorizer: config.addresses.authorizer,
            maxAtomic: MAX_ATOMIC,
          },
          fetchImpl,
          async (authorization) => {
            channelId = authorization.channelId;
            await saveJournal(failureJournalPath(kind), {
              state: JOURNAL_STATES.AUTHORIZATION_CREATED,
              channelId,
              createdAt: new Date().toISOString(),
              case: kind,
            });
          },
        );
        const response = await buyer.request(`${url}${GATE_ROUTES.fixed}`);
        assert.equal(response.status, HTTP_STATUS.paymentRequired);
        assert.ok(channelId);
        const health = (await fetch(`${url}${ROUTES.health}`).then((response) =>
          response.json(),
        )) as {
          handlerCalls: number;
        };
        assert.equal(health.handlerCalls, 0);
        assert.ok(facilitator.events.every((event) => !event.success));
        const channel = await account(config.rpcUrl, channelId);
        const history = await rpc<unknown[]>(
          config.rpcUrl,
          'getSignaturesForAddress',
          [channelId, { limit: DIAGNOSTIC_LIMITS.failureHistory }],
        );
        assert.equal(channel, null);
        assert.equal(history.length, 0);
        const after = {
          buyer: (
            await tokens(config.rpcUrl, buyerSigner.address, config.mint)
          ).toString(),
          seller: (
            await tokens(config.rpcUrl, config.addresses.seller, config.mint)
          ).toString(),
        };
        assert.deepEqual(after, before);
        if (kind === FAILURE_CASES.EMPTY_BUYER) {
          assert.equal(before.buyer, '0');
          assert.equal(
            facilitator.events[0]?.errorReason,
            'invalid_upto_svm_settlement_simulation',
          );
          assert.match(
            facilitator.events[0]?.errorMessage ?? '',
            /Custom.*1[^0-9]/,
          );
        } else {
          assert.ok(expiresAt * UNITS.millisecondsPerSecond < Date.now());
          assert.match(
            facilitator.verifications.find(
              (verification) => !verification.isValid,
            )?.invalidReason ?? '',
            /expir/i,
          );
        }
        results.push({
          case: kind,
          status: CASE_STATUSES.PASSED,
          httpStatus: response.status,
          buyer: buyerSigner.address,
          channelId,
          expiresAt: expiresAt || undefined,
          rejection,
          verifications: facilitator.verifications,
          events: facilitator.events,
          handlerCalls: health.handlerCalls,
          before,
          after,
          channelExists: false,
          paymentTransactions: history,
        });
        await saveJson(failureResultPath(kind), results.at(-1));
        await saveJournal(failureJournalPath(kind), {
          state: JOURNAL_STATES.RESOLVED_REJECTED,
          channelId,
          resolvedAt: new Date().toISOString(),
          resultPath: failureResultPath(kind),
        });
        console.log(
          `${kind} passed: HTTP 402, no channel, no resource execution, unchanged token balances.`,
        );
      } finally {
        if (sellerServer)
          await new Promise<void>((resolve) =>
            sellerServer!.close(() => resolve()),
          );
        await new Promise<void>((resolve) =>
          facilitatorServer.close(() => resolve()),
        );
      }
    }
    const evidence: FailureGateEvidence = {
      schemaVersion: SCHEMA_VERSIONS.EVIDENCE,
      createdAt: new Date().toISOString(),
      network: DEVNET,
      mint: config.mint,
      assetLabel: config.assetLabel,
      setupTransaction,
      results,
      limitations: [
        'F1/F2 only; no replay or seller-crash validation',
        'Fixed resource, not inference',
      ],
    };
    await saveJson(FAILURE_EVIDENCE_PATH, evidence);
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
