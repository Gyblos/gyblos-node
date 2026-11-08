// Real LiteSVM execution behind the SDK signer port. Only synthetic mint/key setup and native Clock
// are injected; channel status, settlements and token balances are changed solely by transactions.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { getCreateAccountInstruction } from '@solana-program/system';
import {
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getInitializeMint2Instruction,
  getMintSize,
  getMintToInstruction,
  getTokenDecoder,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import {
  address,
  appendTransactionMessageInstructions,
  signature as asSignature,
  blockhash,
  compileTransaction,
  createTransactionMessage,
  decompileTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  lamports,
  partiallySignTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Instruction,
  type Transaction,
} from '@solana/kit';
import { SOLANA_MAINNET_CAIP2, type FacilitatorSvmSigner } from '@x402/svm';
import { FailedTransactionMetadata, LiteSVM } from 'litesvm';
import { UPTO_PROGRAM, uptoTokenAccount } from 'x402-upto-metered';

import manifest from '../fixtures/payment-channels-native.json';

const NATIVE_FUNDS = 100_000n;

function replaceBlockhash(
  transaction: Transaction,
  recent: string,
): Transaction {
  const message = decompileTransactionMessage(
    getCompiledTransactionMessageDecoder().decode(transaction.messageBytes),
  );
  return compileTransaction(
    setTransactionMessageLifetimeUsingBlockhash(
      {
        blockhash: blockhash(recent),
        lastValidBlockHeight: 500_000_000n,
      },
      message,
    ),
  );
}

function nativeCode(failure: FailedTransactionMetadata): number | undefined {
  const error = failure.err();
  if (typeof error !== 'object' || !('err' in error)) return undefined;
  const detail: unknown = error.err();
  return detail &&
    typeof detail === 'object' &&
    'code' in detail &&
    typeof detail.code === 'number'
    ? detail.code
    : undefined;
}

export async function nativeVm(now: () => number) {
  const bytes = await readFile(
    new URL('../fixtures/payment-channels-native.so', import.meta.url),
  );
  assert.equal(bytes.length, manifest.bytes);
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    manifest.sha256,
  );
  const [namespace, reference] = SOLANA_MAINNET_CAIP2.split(':');
  assert.ok(namespace && reference);
  const network: `${string}:${string}` = `${namespace}:${reference}`;
  const svm = new LiteSVM()
    .withPrecompiles()
    .withSigverify(true)
    .withBlockhashCheck(true);
  svm.addProgram(address(UPTO_PROGRAM.id), bytes);
  const clock = svm.getClock();
  clock.slot = 400_000_000n;
  clock.unixTimestamp = BigInt(now() / 1000);
  svm.setClock(clock);
  const payer = await generateKeyPairSigner();
  const feePayer = await generateKeyPairSigner();
  const authorizer = await generateKeyPairSigner();
  const seller = await generateKeyPairSigner();
  const fee = await generateKeyPairSigner();
  const mint = await generateKeyPairSigner();
  for (const signer of [payer, feePayer])
    assert.ok(
      !(
        svm.airdrop(signer.address, lamports(1_000_000_000n)) instanceof
        FailedTransactionMetadata
      ),
    );
  let lastFailure: FailedTransactionMetadata | undefined;
  let inclusion: number | undefined;
  let confirmationLost = false;
  const wires: string[] = [];
  const time = (seconds: number) => {
    const current = svm.getClock();
    current.unixTimestamp = BigInt(seconds);
    svm.setClock(current);
  };
  function execute(transaction: Transaction) {
    const result = svm.sendTransaction(transaction);
    lastFailure =
      result instanceof FailedTransactionMetadata ? result : undefined;
    return result;
  }
  async function send(instructions: readonly Instruction[]) {
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (value) => setTransactionMessageFeePayerSigner(feePayer, value),
      (value) =>
        setTransactionMessageLifetimeUsingBlockhash(
          {
            blockhash: blockhash(String(svm.latestBlockhash())),
            lastValidBlockHeight: 500_000_000n,
          },
          value,
        ),
      (value) => appendTransactionMessageInstructions(instructions, value),
    );
    const transaction = await signTransactionMessageWithSigners(message);
    const result = execute(transaction);
    assert.ok(
      !(result instanceof FailedTransactionMetadata),
      result.toString(),
    );
  }
  const accountInfo: FacilitatorSvmSigner['getAccountInfo'] = async (
    requested,
  ) => {
    const found = svm.getAccount(address(requested));
    if (!found.exists) return null;
    return {
      owner: address(found.programAddress),
      data: [Buffer.from(found.data).toString('base64'), 'base64'],
      executable: found.executable,
      lamports: found.lamports,
      space: found.space,
    };
  };
  const signer: FacilitatorSvmSigner = {
    getAddresses: () => [feePayer.address],
    getSigner: () => feePayer,
    getAccountInfo: accountInfo,
    getLatestBlockhash: async () => ({
      blockhash: blockhash(String(svm.latestBlockhash())),
      lastValidBlockHeight: 500_000_000n,
    }),
    getSlot: async () => svm.getClock().slot,
    async signTransaction(wire) {
      return getBase64EncodedWireTransaction(
        await partiallySignTransaction(
          [feePayer.keyPair],
          getTransactionDecoder().decode(Buffer.from(wire, 'base64')),
        ),
      );
    },
    async simulateTransaction(wire, _network, options = {}) {
      // A clone honors only the RPC simulation overrides; executed transactions remain checked.
      const simulation = LiteSVM.fromBytes(svm.toBytes()).withSigverify(
        options.sigVerify ?? false,
      );
      let transaction = getTransactionDecoder().decode(
        Buffer.from(wire, 'base64'),
      );
      if (options.replaceRecentBlockhash)
        transaction = replaceBlockhash(
          transaction,
          String(svm.latestBlockhash()),
        );
      const result = simulation.simulateTransaction(transaction);
      if (result instanceof FailedTransactionMetadata)
        throw new Error(result.toString());
    },
    async sendTransaction(wire) {
      if (inclusion !== undefined) {
        time(inclusion);
        inclusion = undefined;
      }
      const transaction = getTransactionDecoder().decode(
        Buffer.from(wire, 'base64'),
      );
      wires.push(wire);
      const result = execute(transaction);
      if (result instanceof FailedTransactionMetadata)
        throw new Error(result.toString());
      return getSignatureFromTransaction(transaction);
    },
    async confirmTransaction(signature) {
      if (confirmationLost)
        throw new Error('Synthetic confirmation unavailable');
      const found = svm.getTransaction(asSignature(signature));
      assert.ok(found && !(found instanceof FailedTransactionMetadata));
    },
  };
  await send([
    getCreateAccountInstruction({
      payer: feePayer,
      newAccount: mint,
      lamports: svm.minimumBalanceForRentExemption(BigInt(getMintSize())),
      space: BigInt(getMintSize()),
      programAddress: TOKEN_PROGRAM_ADDRESS,
    }),
    getInitializeMint2Instruction({
      mint: mint.address,
      decimals: 6,
      mintAuthority: feePayer.address,
      freezeAuthority: null,
    }),
  ]);
  for (const owner of [
    payer.address,
    feePayer.address,
    seller.address,
    fee.address,
    address(UPTO_PROGRAM.treasuryOwners.mainnet),
  ])
    await send([
      await getCreateAssociatedTokenIdempotentInstructionAsync({
        payer: feePayer,
        owner,
        mint: mint.address,
      }),
    ]);
  await send([
    getMintToInstruction({
      mint: mint.address,
      token: await uptoTokenAccount(
        payer.address,
        mint.address,
        TOKEN_PROGRAM_ADDRESS,
      ),
      mintAuthority: feePayer,
      amount: NATIVE_FUNDS,
    }),
  ]);
  const tokenAccount = async (owner: string) => {
    const found = svm.getAccount(
      await uptoTokenAccount(owner, mint.address, TOKEN_PROGRAM_ADDRESS),
    );
    if (!found.exists) return undefined;
    assert.equal(found.programAddress, TOKEN_PROGRAM_ADDRESS);
    const token = getTokenDecoder().decode(found.data);
    assert.equal(token.owner, owner);
    assert.equal(token.mint, mint.address);
    return token;
  };
  const balance = async (owner: string) =>
    (await tokenAccount(owner))?.amount ?? 0n;
  return {
    payer,
    feePayer,
    authorizer,
    seller,
    fee,
    mint,
    signer,
    send,
    accountInfo,
    balance,
    requireAccount: async (owner: string) => {
      assert.ok(await tokenAccount(owner));
    },
    time,
    slot: () => svm.getClock().slot,
    hints: () => ({
      recentBlockhash: String(svm.latestBlockhash()),
      lastValidBlockHeight: '500000000',
      recentSlot: String(svm.getClock().slot),
    }),
    network,
    atInclusion: (seconds: number) => {
      inclusion = seconds;
    },
    loseConfirmation: (lost: boolean) => {
      confirmationLost = lost;
    },
    sends: () => wires.length,
    failureCode: () => (lastFailure ? nativeCode(lastFailure) : undefined),
    signatureSucceeded: (signature: string) => {
      const found = svm.getTransaction(asSignature(signature));
      return (
        !confirmationLost &&
        !!found &&
        !(found instanceof FailedTransactionMetadata)
      );
    },
    async replay() {
      const wire = wires.at(-1);
      assert.ok(wire);
      svm.expireBlockhash();
      const transaction = replaceBlockhash(
        getTransactionDecoder().decode(Buffer.from(wire, 'base64')),
        String(svm.latestBlockhash()),
      );
      return !(
        execute(
          await partiallySignTransaction([feePayer.keyPair], transaction),
        ) instanceof FailedTransactionMetadata
      );
    },
  };
}
