import { assertNoUnresolvedAuthorizations } from '../../../scripts/journal.js';
import { discoverChannelsByRentPayer, toFacilitatorSvmSigner } from '@x402/svm';
import { loadConfig, saveJson, signer } from '../../../scripts/config.js';
import { createBuyer } from '../../../packages/payments-x402/src/buyer.js';
import { account, assertProgram, confirm, explorer, GateError, lamports, tokens } from '../../../packages/payments-x402/src/chain.js';
import { ACTUAL_ATOMIC, DEVNET, MAX_ATOMIC, UPSTREAM_COMMIT } from '../../../packages/payments-x402/src/constants.js';
import type { SettlementEvent } from '../../../packages/payments-x402/src/facilitator.js';
import { runGate } from '../../../packages/application/src/gate.js';
import { withExclusiveLock } from '../../../scripts/lock.js';
import { validateSettlement } from '../../../packages/payments-x402/src/trust.js';

const journalPath = '.local/devnet/attempt.json';
export async function executeGate(signal?: AbortSignal) {
  return withExclusiveLock('.local/devnet/buyer.lock', () => executeLocked(signal));
}
async function executeLocked(signal?: AbortSignal) {
  const config = await loadConfig();
  await assertNoUnresolvedAuthorizations();
  const buyer = createBuyer(await signer(config, 'buyer'), config.rpcUrl, {
    mint: config.mint, payTo: config.addresses.seller, feePayer: config.addresses.facilitator,
    receiverAuthorizer: config.addresses.authorizer, maxAtomic: MAX_ATOMIC,
  }, fetch, async authorization => { await saveJson(journalPath, { state: 'authorization-created', channelId: authorization.channelId,
    asset: config.mint, network: DEVNET, ceiling: authorization.requirements.amount, createdAt: new Date().toISOString() }); });
  const result = await runGate({
    async preflight() {
      await assertProgram(config.rpcUrl);
      if (await lamports(config.rpcUrl, config.addresses.facilitator) < 10_000_000n) throw new GateError('NEEDS_SOL', `Fund facilitator ${config.addresses.facilitator} with devnet SOL.`);
      if (await tokens(config.rpcUrl, config.addresses.buyer, config.mint) < BigInt(MAX_ATOMIC)) throw new GateError('NEEDS_TOKENS', 'Buyer does not have enough test tokens for the ceiling.');
    },
    async snapshot() {
      return { buyer: (await tokens(config.rpcUrl, config.addresses.buyer, config.mint)).toString(),
        seller: (await tokens(config.rpcUrl, config.addresses.seller, config.mint)).toString(),
        buyerLamports: (await lamports(config.rpcUrl, config.addresses.buyer)).toString() };
    },
    async request() {
      signal?.throwIfAborted();
      const response = await buyer.request('http://127.0.0.1:4021/api/generate', signal);
      if (response.status !== 200 || !response.settlement?.success || !response.authorization) {
        const diagnostics = await fetch('http://127.0.0.1:4022/gate/events').then(r => r.json());
        await saveJson('.local/devnet/failed-request.json', { status: response.status, settlement: response.settlement, events: diagnostics });
        console.error(JSON.stringify({ status: response.status, events: diagnostics }));
        throw new GateError('PAID_REQUEST_FAILED', `Paid request HTTP ${response.status}; inspect journal and chain before retrying.`);
      }
      validateSettlement(response.settlement, { payer: config.addresses.buyer, amount: ACTUAL_ATOMIC });
      const eventResponse = await fetch('http://127.0.0.1:4022/gate/events');
      const events = await eventResponse.json() as SettlementEvent[];
      const id = response.authorization.channelId;
      const open = events.find(e => e.phase === 'deposit' && e.channelId === id && e.success);
      const claim = events.find(e => e.phase === 'claim' && e.channelId === id && e.success);
      if (!open?.transaction || !claim?.transaction || claim.transaction !== response.settlement.transaction)
        throw new GateError('MISSING_EVIDENCE', 'Could not correlate deposit, claim and response receipt.');
      await confirm(config.rpcUrl, open.transaction); await confirm(config.rpcUrl, claim.transaction);
      const raw = await account(config.rpcUrl, id);
      let distributed = !raw;
      if (raw) {
        const channels = await discoverChannelsByRentPayer(toFacilitatorSvmSigner(await signer(config, 'facilitator'), { defaultRpcUrl: config.rpcUrl }), DEVNET, config.addresses.facilitator);
        distributed = channels.find(c => c.channelId === id)?.channel.status === 3;
      }
      if (open.amount !== response.authorization.requirements.amount || claim.amount !== ACTUAL_ATOMIC)
        throw new GateError('AMOUNT_MISMATCH', 'Unexpected settlement amount.');
      return { receipt: { authorized: response.authorization.requirements.amount, actual: claim.amount,
        openTransaction: open.transaction, claimTransaction: claim.transaction, channelId: id, channelDistributed: distributed }, resource: response.body };
    },
  });
  const evidence = { schemaVersion: 1, status: 'passed', createdAt: new Date().toISOString(), network: DEVNET,
    assetLabel: config.assetLabel, mint: config.mint, upstreamCommit: UPSTREAM_COMMIT, sdkVersion: '2.28.0',
    ...result, transactions: { open: explorer(result.accounting.openTransaction), claim: explorer(result.accounting.claimTransaction) },
    limitations: ['Fixed resource, not inference', 'In-memory facilitator storage', 'No crash recovery validation', 'No P2P/mobile validation'] };
  const evidencePath = `.local/devnet/evidence-${Date.now()}.json`;
  await saveJson(evidencePath, evidence);
  await saveJson(journalPath, { state: 'verified', evidencePath, channelId: result.accounting.channelId });
  return { evidencePath, evidence };
}
