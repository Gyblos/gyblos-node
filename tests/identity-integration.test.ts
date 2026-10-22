// Owns identity integration cases on a local solana-test-validator cloned from devnet: a 0-SOL owner is
// sponsored, read back without an indexer, and a squatter's replayed binding is rejected. Skips without the validator.
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
  METADATA_KEYS,
  readNodeIdentity,
  resolveOwner,
} from '@gyblos/identity';
import { encodeBindingValue, signNodeBinding } from '@gyblos/identity/binding';
import { setMetadataInstruction } from '@gyblos/identity/instructions';

import {
  confirm,
  freshParticipants,
  printable,
  runSponsoredFlow,
  type FlowParticipants,
  type FlowResult,
} from '../lab/tools/identity-flow.js';
import {
  startLocalValidator,
  VALIDATOR_SKIP,
  type LocalValidator,
} from './support/identity-validator.js';

const SPONSOR_AIRDROP = lamports(2_000_000_000n);
const AGENT_URI = 'https://gyblos.com/.well-known/node.json';
const CASE_OPTIONS = { skip: VALIDATOR_SKIP, timeout: 120_000 };

let validator: LocalValidator | undefined;
let startSkip: string | undefined;
let rpc: Rpc<SolanaRpcApi>;
let sponsor: TransactionSigner;
let honest: FlowParticipants;
let honestResult: FlowResult;

before(
  async () => {
    if (VALIDATOR_SKIP !== false) return;
    const started = await startLocalValidator();
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
    honest = await freshParticipants();
    assert.equal((await rpc.getBalance(honest.owner.address).send()).value, 0n);
    honestResult = await runSponsoredFlow(rpc, sponsor, honest, AGENT_URI);
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
    assert.deepEqual(honestResult.byAsset, {
      asset: honest.asset.address,
      owner: honest.owner.address,
      creator: honest.owner.address,
      payoutWallet: honest.payoutWallet.address,
      uri: AGENT_URI,
      nodeId: honestResult.nodeId,
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
    await runSponsoredFlow(rpc, sponsor, squatter, AGENT_URI);
    const stolen = await signNodeBinding(
      honest.node,
      honest.asset.address,
      honest.owner.address,
    );
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
