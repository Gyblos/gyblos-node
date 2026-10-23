// Fixed-price upto gate body: under the gate lock, pays the local seller once, correlates deposit and
// claim events with the receipt, confirms them on devnet and saves evidence plus a verified journal.
import { discoverChannelsByRentPayer, toFacilitatorSvmSigner } from '@x402/svm';

import {
  CHANNEL_STATUS,
  FAILED_REQUEST_PATH,
  FIXED_MIN_FACILITATOR_LAMPORTS,
  fixedEvidencePath,
  HOSTS,
  HTTP_STATUS,
  JOURNAL_PATHS,
  LOCK_PATH,
  ROUTES,
  X402_SDK_VERSION,
} from '@gyblos/config';
import { runGate } from '@gyblos/core';
import { createBuyer } from '@gyblos/payments-x402';
import {
  account,
  assertProgram,
  confirm,
  explorer,
  GateError,
  lamports,
  tokens,
} from '@gyblos/payments-x402/chain';
import {
  ACTUAL_ATOMIC,
  DEVNET,
  GATE_ERROR_CODES,
  MAX_ATOMIC,
  UPSTREAM_COMMIT,
} from '@gyblos/payments-x402/constants';
import type { SettlementEvent } from '@gyblos/payments-x402/facilitator';
import { withExclusiveLock } from '@gyblos/payments-x402/recovery/lock';
import { validateSettlement } from '@gyblos/payments-x402/trust';

import { loadConfig, saveJson, signer } from '../config.js';
import {
  EVIDENCE_STATUSES,
  JOURNAL_STATES,
  SCHEMA_VERSIONS,
  WALLET_ROLES,
} from '../constants.js';
import type { FixedGateEvidence } from '../fixture-evidence-types.js';
import { assertNoUnresolvedAuthorizations, saveJournal } from '../journal.js';

const JOURNAL_PATH = JOURNAL_PATHS.fixed;

async function executeLocked(signal?: AbortSignal) {
  const config = await loadConfig();
  await assertNoUnresolvedAuthorizations();
  const buyer = createBuyer(
    await signer(config, WALLET_ROLES.BUYER),
    config.rpcUrl,
    {
      mint: config.mint,
      payTo: config.addresses.seller,
      feePayer: config.addresses.facilitator,
      receiverAuthorizer: config.addresses.authorizer,
      maxAtomic: MAX_ATOMIC,
    },
    fetch,
    async (authorization) => {
      await saveJournal(JOURNAL_PATH, {
        state: JOURNAL_STATES.AUTHORIZATION_CREATED,
        channelId: authorization.channelId,
        asset: config.mint,
        network: DEVNET,
        ceiling: authorization.requirements.amount,
        createdAt: new Date().toISOString(),
      });
    },
  );
  const result = await runGate({
    async preflight() {
      await assertProgram(config.rpcUrl);
      if (
        (await lamports(config.rpcUrl, config.addresses.facilitator)) <
        FIXED_MIN_FACILITATOR_LAMPORTS
      )
        throw new GateError(
          GATE_ERROR_CODES.NEEDS_SOL,
          `Fund facilitator ${config.addresses.facilitator} with devnet SOL.`,
        );
      if (
        (await tokens(config.rpcUrl, config.addresses.buyer, config.mint)) <
        BigInt(MAX_ATOMIC)
      )
        throw new GateError(
          GATE_ERROR_CODES.NEEDS_TOKENS,
          'Buyer does not have enough test tokens for the ceiling.',
        );
    },
    async snapshot() {
      return {
        buyer: (
          await tokens(config.rpcUrl, config.addresses.buyer, config.mint)
        ).toString(),
        seller: (
          await tokens(config.rpcUrl, config.addresses.seller, config.mint)
        ).toString(),
        buyerLamports: (
          await lamports(config.rpcUrl, config.addresses.buyer)
        ).toString(),
      };
    },
    async request() {
      signal?.throwIfAborted();
      const response = await buyer.request(
        `${HOSTS.seller}${ROUTES.fixed}`,
        signal,
      );
      if (
        response.status !== HTTP_STATUS.ok ||
        !response.settlement?.success ||
        !response.authorization
      ) {
        const diagnostics = await fetch(
          `${HOSTS.facilitator}${ROUTES.events}`,
        ).then((response) => response.json());
        await saveJson(FAILED_REQUEST_PATH, {
          status: response.status,
          settlement: response.settlement,
          events: diagnostics,
        });
        console.error(
          JSON.stringify({ status: response.status, events: diagnostics }),
        );
        throw new GateError(
          GATE_ERROR_CODES.PAID_REQUEST_FAILED,
          `Paid request HTTP ${response.status}; inspect journal and chain before retrying.`,
        );
      }
      validateSettlement(response.settlement, {
        payer: config.addresses.buyer,
        amount: ACTUAL_ATOMIC,
      });
      const eventResponse = await fetch(`${HOSTS.facilitator}${ROUTES.events}`);
      const events = (await eventResponse.json()) as SettlementEvent[];
      const channelId = response.authorization.channelId;
      const open = events.find(
        (event) =>
          event.phase === 'deposit' &&
          event.channelId === channelId &&
          event.success,
      );
      const claim = events.find(
        (event) =>
          event.phase === 'claim' &&
          event.channelId === channelId &&
          event.success,
      );
      if (
        !open?.transaction ||
        !claim?.transaction ||
        claim.transaction !== response.settlement.transaction
      )
        throw new GateError(
          GATE_ERROR_CODES.MISSING_EVIDENCE,
          'Could not correlate deposit, claim and response receipt.',
        );
      await confirm(config.rpcUrl, open.transaction);
      await confirm(config.rpcUrl, claim.transaction);
      const raw = await account(config.rpcUrl, channelId);
      let distributed = !raw;
      if (raw) {
        const channels = await discoverChannelsByRentPayer(
          toFacilitatorSvmSigner(
            await signer(config, WALLET_ROLES.FACILITATOR),
            {
              defaultRpcUrl: config.rpcUrl,
            },
          ),
          DEVNET,
          config.addresses.facilitator,
        );
        distributed =
          channels.find((channel) => channel.channelId === channelId)?.channel
            .status === CHANNEL_STATUS.distributed;
      }
      if (
        open.amount !== response.authorization.requirements.amount ||
        claim.amount !== ACTUAL_ATOMIC
      )
        throw new GateError(
          GATE_ERROR_CODES.AMOUNT_MISMATCH,
          'Unexpected settlement amount.',
        );
      return {
        receipt: {
          authorized: response.authorization.requirements.amount,
          actual: claim.amount,
          openTransaction: open.transaction,
          claimTransaction: claim.transaction,
          channelId: channelId,
          channelDistributed: distributed,
        },
        resource: response.body,
      };
    },
  });
  const evidence: FixedGateEvidence = {
    schemaVersion: SCHEMA_VERSIONS.EVIDENCE,
    status: EVIDENCE_STATUSES.PASSED,
    createdAt: new Date().toISOString(),
    network: DEVNET,
    assetLabel: config.assetLabel,
    mint: config.mint,
    upstreamCommit: UPSTREAM_COMMIT,
    sdkVersion: X402_SDK_VERSION,
    ...result,
    transactions: {
      open: explorer(result.accounting.openTransaction),
      claim: explorer(result.accounting.claimTransaction),
    },
    limitations: [
      'Fixed resource, not inference',
      'In-memory facilitator storage',
      'No crash recovery validation',
      'No P2P/mobile validation',
    ],
  };
  const evidencePath = fixedEvidencePath(Date.now());
  await saveJson(evidencePath, evidence);
  await saveJournal(JOURNAL_PATH, {
    state: JOURNAL_STATES.VERIFIED,
    evidencePath,
    channelId: result.accounting.channelId,
  });
  return { evidencePath, evidence };
}

export async function executeGate(signal?: AbortSignal) {
  return withExclusiveLock(LOCK_PATH, () => executeLocked(signal));
}
