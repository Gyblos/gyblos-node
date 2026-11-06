// Small JSON-RPC helpers for the batch-settlement channel check: send and confirm a transaction,
// airdrop on a loopback validator, read balances and create a throwaway test mint with funded ATAs.
import { getCreateAccountInstruction } from '@solana-program/system';
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getInitializeMint2Instruction,
  getMintToInstruction,
} from '@solana-program/token';
import {
  appendTransactionMessageInstructions,
  blockhash,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type KeyPairSigner,
} from '@solana/kit';

import { TOKEN_PROGRAM_ADDRESS } from '@gyblos/config';

const DECIMALS = 6;
const MINT_SPACE = 82n;
const AIRDROP_LAMPORTS = 2_000_000_000;
const CONFIRM_ATTEMPTS = 120;
const CONFIRM_POLL_MS = 1_000;

export type Chain = ReturnType<typeof chainClient>;

export function chainClient(rpcUrl: string) {
  async function rpc<T>(method: string, params: unknown[]): Promise<T> {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null)
      throw new Error(`${method}: malformed JSON-RPC response`);
    if ('error' in body)
      throw new Error(`${method}: ${JSON.stringify(body.error)}`);
    if (!('result' in body)) throw new Error(`${method}: no result`);
    // The caller names the result type of the method it called.
    return body.result as T;
  }

  async function confirm(signature: string) {
    for (let attempt = 0; attempt < CONFIRM_ATTEMPTS; attempt++) {
      const { value } = await rpc<{
        value: ({ confirmationStatus?: string; err: unknown } | null)[];
      }>('getSignatureStatuses', [[signature]]);
      const status = value[0];
      if (status?.err)
        throw new Error(`transaction failed: ${JSON.stringify(status.err)}`);
      if (
        status?.confirmationStatus === 'confirmed' ||
        status?.confirmationStatus === 'finalized'
      )
        return;
      await new Promise((resolve) => setTimeout(resolve, CONFIRM_POLL_MS));
    }
    throw new Error(`not confirmed: ${signature}`);
  }

  async function send(feePayer: KeyPairSigner, instructions: Instruction[]) {
    const { value: latest } = await rpc<{
      value: { blockhash: string; lastValidBlockHeight: number };
    }>('getLatestBlockhash', [{ commitment: 'confirmed' }]);
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (draft) => setTransactionMessageFeePayerSigner(feePayer, draft),
      (draft) =>
        setTransactionMessageLifetimeUsingBlockhash(
          {
            blockhash: blockhash(latest.blockhash),
            lastValidBlockHeight: BigInt(latest.lastValidBlockHeight),
          },
          draft,
        ),
      (draft) => appendTransactionMessageInstructions(instructions, draft),
    );
    const signed = await signTransactionMessageWithSigners(message);
    const signature = await rpc<string>('sendTransaction', [
      getBase64EncodedWireTransaction(signed),
      { encoding: 'base64', preflightCommitment: 'confirmed' },
    ]);
    await confirm(signature);
  }

  async function airdrop(to: Address, lamports = AIRDROP_LAMPORTS) {
    await confirm(await rpc<string>('requestAirdrop', [to, lamports]));
  }

  async function tokenBalance(owner: Address, mint: Address): Promise<bigint> {
    const [ata] = await findAssociatedTokenPda({
      owner,
      mint,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    const info = await rpc<{ value: { amount: string } | null } | null>(
      'getTokenAccountBalance',
      [ata, { commitment: 'confirmed' }],
    ).catch(() => null);
    return BigInt(info?.value?.amount ?? 0);
  }

  async function solBalance(owner: Address): Promise<bigint> {
    const { value } = await rpc<{ value: number }>('getBalance', [
      owner,
      { commitment: 'confirmed' },
    ]);
    return BigInt(value);
  }

  // A fresh mint (never USDC) with an ATA for every owner; only the buyer receives tokens.
  async function createTestMint(
    feePayer: KeyPairSigner,
    owners: Address[],
    buyer: Address,
    amount: bigint,
  ) {
    const mint = await generateKeyPairSigner();
    const rent = await rpc<number>('getMinimumBalanceForRentExemption', [
      Number(MINT_SPACE),
    ]);
    const accounts = await Promise.all(
      owners.map((owner) =>
        getCreateAssociatedTokenIdempotentInstructionAsync({
          payer: feePayer,
          owner,
          mint: mint.address,
        }),
      ),
    );
    const [buyerAta] = await findAssociatedTokenPda({
      owner: buyer,
      mint: mint.address,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    await send(feePayer, [
      getCreateAccountInstruction({
        payer: feePayer,
        newAccount: mint,
        lamports: BigInt(rent),
        space: MINT_SPACE,
        programAddress: TOKEN_PROGRAM_ADDRESS,
      }),
      getInitializeMint2Instruction({
        mint: mint.address,
        decimals: DECIMALS,
        mintAuthority: feePayer.address,
        freezeAuthority: null,
      }),
      ...accounts,
      getMintToInstruction({
        mint: mint.address,
        token: buyerAta,
        mintAuthority: feePayer,
        amount,
      }),
    ]);
    return mint.address;
  }

  return { rpc, send, airdrop, tokenBalance, solBalance, createTestMint };
}
