// Fixed-price upto gate body: under the gate lock, pays the local seller once, correlates deposit and
// claim events with the receipt, confirms them on devnet and saves evidence plus a verified journal.
import { discoverChannelsByRentPayer, toFacilitatorSvmSigner } from '@x402/svm';

import {
  CHANNEL_STATUS,
  DEVNET,
  explorerUrl,
  HOSTS,
  HTTP_STATUS,
  MAX_ATOMIC,
  ROUTES,
  X402_SDK_VERSION,
} from '@gyblos/config';
import { createBuyer } from '@gyblos/payments-x402';
import {
  account,
  assertProgram,
  confirm,
  lamports,
  tokens,
} from '@gyblos/payments-x402/chain';
import { JOURNAL_STATES } from '@gyblos/payments-x402/constants';
import type { SettlementEvent } from '@gyblos/payments-x402/facilitator';
import { withExclusiveLock } from '@gyblos/payments-x402/recovery/lock';
import { validateSettlement } from '@gyblos/payments-x402/trust';
import { PROTOCOL_ERROR_CODES } from '@gyblos/protocol/constants';
import { ProtocolError } from '@gyblos/protocol/errors';
import { saveJson } from '@gyblos/runtime';

import {
  ACTUAL_ATOMIC,
  EVIDENCE_STATUSES,
  FIXED_MIN_FACILITATOR_LAMPORTS,
  fixedEvidencePath,
  GATE_HOSTS,
  GATE_ROUTES,
  labPaths,
  SCHEMA_VERSIONS,
  UPSTREAM_COMMIT,
  WALLET_ROLES,
} from '../constants';
import type { FixedGateEvidence } from '../fixture-evidence-types';
import { runGate } from '../gate';
import { assertNoUnresolvedAuthorizations, saveJournal } from '../journal';
import { assertLabHome, loadConfig, signer } from '../wallet';

const journalPath = () => labPaths().journals.fixed;

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
      await saveJournal(journalPath(), {
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
        throw new ProtocolError(
          PROTOCOL_ERROR_CODES.NEEDS_SOL,
          `Fund facilitator ${config.addresses.facilitator} with devnet SOL.`,
        );
      if (
        (await tokens(config.rpcUrl, config.addresses.buyer, config.mint)) <
        BigInt(MAX_ATOMIC)
      )
        throw new ProtocolError(
          PROTOCOL_ERROR_CODES.NEEDS_TOKENS,
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
        `${GATE_HOSTS.seller}${GATE_ROUTES.fixed}`,
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
        await saveJson(labPaths().failedRequest, {
          status: response.status,
          settlement: response.settlement,
          events: diagnostics,
        });
        console.error(
          JSON.stringify({ status: response.status, events: diagnostics }),
        );
        throw new ProtocolError(
          PROTOCOL_ERROR_CODES.PAID_REQUEST_FAILED,
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
        throw new ProtocolError(
          PROTOCOL_ERROR_CODES.MISSING_EVIDENCE,
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
        throw new ProtocolError(
          PROTOCOL_ERROR_CODES.AMOUNT_MISMATCH,
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
      open: explorerUrl(result.accounting.openTransaction),
      claim: explorerUrl(result.accounting.claimTransaction),
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
  await saveJournal(journalPath(), {
    state: JOURNAL_STATES.VERIFIED,
    evidencePath,
    channelId: result.accounting.channelId,
  });
  return { evidencePath, evidence };
}

export async function executeGate(signal?: AbortSignal) {
  // Before the lab lock, which would create the lab home.
  await assertLabHome();
  return withExclusiveLock(labPaths().lock, () => executeLocked(signal));
}
