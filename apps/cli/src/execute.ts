import { discoverChannelsByRentPayer, toFacilitatorSvmSigner } from '@x402/svm';

import { runGate } from '@gyblos/application/gate';
import {
  FIXED_MIN_FACILITATOR_LAMPORTS,
  HOSTS,
  LOCAL_DIR,
  localPath,
  LOCK_PATH,
  X402_SDK_VERSION,
} from '@gyblos/config';
import { loadConfig, saveJson, signer } from '@gyblos/gate/config';
import { assertNoUnresolvedAuthorizations } from '@gyblos/gate/journal';
import { withExclusiveLock } from '@gyblos/gate/lock';
import { createBuyer } from '@gyblos/payments-x402/buyer';
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
  MAX_ATOMIC,
  UPSTREAM_COMMIT,
} from '@gyblos/payments-x402/constants';
import type { SettlementEvent } from '@gyblos/payments-x402/facilitator';
import { validateSettlement } from '@gyblos/payments-x402/trust';

const journalPath = localPath('attempt.json');
export async function executeGate(signal?: AbortSignal) {
  return withExclusiveLock(LOCK_PATH, () => executeLocked(signal));
}
async function executeLocked(signal?: AbortSignal) {
  const config = await loadConfig();
  await assertNoUnresolvedAuthorizations();
  const buyer = createBuyer(
    await signer(config, 'buyer'),
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
      await saveJson(journalPath, {
        state: 'authorization-created',
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
          'NEEDS_SOL',
          `Fund facilitator ${config.addresses.facilitator} with devnet SOL.`,
        );
      if (
        (await tokens(config.rpcUrl, config.addresses.buyer, config.mint)) <
        BigInt(MAX_ATOMIC)
      )
        throw new GateError(
          'NEEDS_TOKENS',
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
        `${HOSTS.seller}/api/generate`,
        signal,
      );
      if (
        response.status !== 200 ||
        !response.settlement?.success ||
        !response.authorization
      ) {
        const diagnostics = await fetch(
          `${HOSTS.facilitator}/gate/events`,
        ).then((r) => r.json());
        await saveJson(localPath('failed-request.json'), {
          status: response.status,
          settlement: response.settlement,
          events: diagnostics,
        });
        console.error(
          JSON.stringify({ status: response.status, events: diagnostics }),
        );
        throw new GateError(
          'PAID_REQUEST_FAILED',
          `Paid request HTTP ${response.status}; inspect journal and chain before retrying.`,
        );
      }
      validateSettlement(response.settlement, {
        payer: config.addresses.buyer,
        amount: ACTUAL_ATOMIC,
      });
      const eventResponse = await fetch(`${HOSTS.facilitator}/gate/events`);
      const events = (await eventResponse.json()) as SettlementEvent[];
      const id = response.authorization.channelId;
      const open = events.find(
        (e) => e.phase === 'deposit' && e.channelId === id && e.success,
      );
      const claim = events.find(
        (e) => e.phase === 'claim' && e.channelId === id && e.success,
      );
      if (
        !open?.transaction ||
        !claim?.transaction ||
        claim.transaction !== response.settlement.transaction
      )
        throw new GateError(
          'MISSING_EVIDENCE',
          'Could not correlate deposit, claim and response receipt.',
        );
      await confirm(config.rpcUrl, open.transaction);
      await confirm(config.rpcUrl, claim.transaction);
      const raw = await account(config.rpcUrl, id);
      let distributed = !raw;
      if (raw) {
        const channels = await discoverChannelsByRentPayer(
          toFacilitatorSvmSigner(await signer(config, 'facilitator'), {
            defaultRpcUrl: config.rpcUrl,
          }),
          DEVNET,
          config.addresses.facilitator,
        );
        distributed =
          channels.find((c) => c.channelId === id)?.channel.status === 3;
      }
      if (
        open.amount !== response.authorization.requirements.amount ||
        claim.amount !== ACTUAL_ATOMIC
      )
        throw new GateError('AMOUNT_MISMATCH', 'Unexpected settlement amount.');
      return {
        receipt: {
          authorized: response.authorization.requirements.amount,
          actual: claim.amount,
          openTransaction: open.transaction,
          claimTransaction: claim.transaction,
          channelId: id,
          channelDistributed: distributed,
        },
        resource: response.body,
      };
    },
  });
  const evidence = {
    schemaVersion: 1,
    status: 'passed',
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
  const evidencePath = `${LOCAL_DIR}/evidence-${Date.now()}.json`;
  await saveJson(evidencePath, evidence);
  await saveJson(journalPath, {
    state: 'verified',
    evidencePath,
    channelId: result.accounting.channelId,
  });
  return { evidencePath, evidence };
}
