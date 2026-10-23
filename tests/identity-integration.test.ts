// Owns identity integration cases on a local solana-test-validator cloned from devnet: a 0-SOL owner is
// sponsored, read back without an indexer, neither a squatter's replayed binding nor a preloaded burned
// claimant hijacks or blocks resolveOwner, and a higher-sequence rebinding moves the NodeId. Opt-in.
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';

import {
  appendTransactionMessageInstructions,
  createSolanaRpc,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  lamports,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Rpc,
  type SolanaRpcApi,
  type TransactionSigner,
} from '@solana/kit';

import { SVM_TRANSACTION_VERSION } from '@gyblos/config';
import {
  BINDING_STATUSES,
  IDENTITY_ERROR_CODES,
  IdentityError,
  METADATA_KEYS,
  readNodeIdentity,
  resolveOwner,
} from '@gyblos/identity';
import {
  encodeBindingValue,
  setMetadataInstruction,
  signNodeBinding,
} from '@gyblos/identity/codec';
import { PROGRAMS } from '@gyblos/identity/constants';

import {
  confirm,
  freshParticipants,
  printable,
  runSponsoredFlow,
  type FlowParticipants,
  type FlowResult,
} from '../lab/tools/identity-flow.js';
import {
  addClaimant,
  burnedCoreAssetBytes,
  type SyntheticChain,
} from './support/identity-accounts.js';
import {
  startLocalValidator,
  VALIDATOR_SKIP,
  type LocalValidator,
} from './support/identity-validator.js';

const SPONSOR_AIRDROP = lamports(2_000_000_000n);
const AGENT_URI = 'https://gyblos.com/.well-known/node.json';
const CASE_OPTIONS = { skip: VALIDATOR_SKIP, timeout: 120_000 };
const HONEST_SEQUENCE = 1n;

let validator: LocalValidator | undefined;
let startSkip: string | undefined;
let rpc: Rpc<SolanaRpcApi>;
let sponsor: TransactionSigner;
let honest: FlowParticipants;
let honestResult: FlowResult;
let burnedAsset: TransactionSigner;

// A claimant for the honest NodeId whose Core asset is a burned 1-byte stub, preloaded at genesis.
async function burnedClaimant(): Promise<SyntheticChain> {
  const chain: SyntheticChain = new Map();
  burnedAsset = await generateKeyPairSigner();
  const claimant = await addClaimant(chain, {
    owner: (await generateKeyPairSigner()).address,
    asset: burnedAsset.address,
    node: honest.node,
  });
  chain.set(claimant.core, {
    owner: PROGRAMS.mplCore,
    data: burnedCoreAssetBytes(),
  });
  return chain;
}

before(
  async () => {
    if (VALIDATOR_SKIP !== false) return;
    honest = await freshParticipants();
    const started = await startLocalValidator(await burnedClaimant());
    if (!started.ok) {
      startSkip = `identity integration skipped: ${started.reason}`;
      return;
    }
    validator = started.validator;
    rpc = createSolanaRpc(validator.url);
    // Ephemeral signer funded only by the local validator's faucet.
    sponsor = await generateKeyPairSigner();
    await confirm(
      rpc,
      await rpc.requestAirdrop(sponsor.address, SPONSOR_AIRDROP).send(),
    );
  },
  { timeout: 120_000 },
);

after(() => validator?.stop());

void test(
  'registers via sponsor with a 0-SOL owner, binds nodeId and payout wallet, reads back',
  CASE_OPTIONS,
  async (t) => {
    if (startSkip !== undefined) return t.skip(startSkip);
    assert.equal((await rpc.getBalance(honest.owner.address).send()).value, 0n);
    honestResult = await runSponsoredFlow(rpc, sponsor, honest, {
      agentUri: AGENT_URI,
      bindingSequence: HONEST_SEQUENCE,
    });
    t.diagnostic(
      printable({
        prefundLamports: honestResult.prefundLamports,
        feeLamports: honestResult.feeLamports,
        sponsorSpentLamports: honestResult.sponsorSpentLamports,
        transactionBytes: honestResult.transactionBytes,
        unitsConsumed: honestResult.unitsConsumed,
      }),
    );
    assert.equal(honestResult.ownerBalanceAfter, 0n);
    assert.equal(
      honestResult.sponsorSpentLamports,
      honestResult.prefundLamports + honestResult.feeLamports,
    );
    // The builder's quoted sponsor cost, and what the ledger recorded, match the chain.
    assert.equal(
      honestResult.sponsorCostLamports,
      honestResult.sponsorSpentLamports,
    );
    assert.equal(
      honestResult.ledgerSpentLamports,
      honestResult.sponsorSpentLamports,
    );
    assert.deepEqual(honestResult.byAsset, {
      asset: honest.asset.address,
      owner: honest.owner.address,
      creator: honest.owner.address,
      payoutWallet: honest.payoutWallet.address,
      uri: AGENT_URI,
      nodeId: honestResult.nodeId,
      bindingSequence: HONEST_SEQUENCE,
      bindingStatus: 'valid',
    });
    assert.deepEqual(honestResult.byOwner, [honestResult.byAsset]);
    assert.equal(honestResult.resolvedOwner, honest.owner.address);
  },
);

void test(
  'a squatter replaying the binding bytes on its own asset does not hijack resolveOwner',
  CASE_OPTIONS,
  async (t) => {
    if (startSkip !== undefined) return t.skip(startSkip);
    const squatter = await freshParticipants();
    await runSponsoredFlow(rpc, sponsor, squatter, {
      agentUri: AGENT_URI,
      bindingSequence: HONEST_SEQUENCE,
    });
    const stolen = await signNodeBinding(honest.node, {
      asset: honest.asset.address,
      owner: honest.owner.address,
      sequence: HONEST_SEQUENCE,
    });
    const replay = await setMetadataInstruction(
      squatter.owner,
      squatter.asset.address,
      METADATA_KEYS.nodeId,
      encodeBindingValue(stolen),
    );
    const { value: blockhash } = await rpc.getLatestBlockhash().send();
    const message = pipe(
      createTransactionMessage({ version: SVM_TRANSACTION_VERSION }),
      (draft) => setTransactionMessageFeePayerSigner(sponsor, draft),
      (draft) => setTransactionMessageLifetimeUsingBlockhash(blockhash, draft),
      (draft) => appendTransactionMessageInstructions([replay], draft),
    );
    const signed = await signTransactionMessageWithSigners(message);
    await rpc
      .sendTransaction(getBase64EncodedWireTransaction(signed), {
        encoding: 'base64',
      })
      .send();
    await confirm(rpc, getSignatureFromTransaction(signed));
    const squatterIdentity = await readNodeIdentity(rpc, {
      asset: squatter.asset.address,
    });
    assert.equal(squatterIdentity?.bindingStatus, BINDING_STATUSES.INVALID);
    assert.equal(
      await resolveOwner(rpc, honestResult.nodeId),
      honest.owner.address,
    );
  },
);

void test(
  'a burned claimant for the same NodeId cannot block resolveOwner',
  CASE_OPTIONS,
  async (t) => {
    if (startSkip !== undefined) return t.skip(startSkip);
    await assert.rejects(
      readNodeIdentity(rpc, { asset: burnedAsset.address }),
      (error) =>
        error instanceof IdentityError &&
        error.code === IDENTITY_ERROR_CODES.ACCOUNT_DATA_INVALID,
    );
    assert.equal(
      await resolveOwner(rpc, honestResult.nodeId),
      honest.owner.address,
    );
  },
);

void test(
  'a later registration signed by the node key with a higher sequence moves the NodeId to the new owner',
  CASE_OPTIONS,
  async (t) => {
    if (startSkip !== undefined) return t.skip(startSkip);
    const first = await freshParticipants();
    const firstResult = await runSponsoredFlow(rpc, sponsor, first, {
      agentUri: AGENT_URI,
      bindingSequence: 1n,
    });
    assert.equal(firstResult.resolvedOwner, first.owner.address);
    const second = { ...(await freshParticipants()), node: first.node };
    const secondResult = await runSponsoredFlow(rpc, sponsor, second, {
      agentUri: AGENT_URI,
      bindingSequence: 2n,
    });
    assert.equal(secondResult.nodeId, firstResult.nodeId);
    assert.equal(secondResult.resolvedOwner, second.owner.address);
    // The first owner's binding is still valid on chain, just outranked.
    assert.equal(
      (await readNodeIdentity(rpc, { asset: first.asset.address }))
        ?.bindingStatus,
      BINDING_STATUSES.VALID,
    );
  },
);
