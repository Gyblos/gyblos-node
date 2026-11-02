// The token accounts a seller's claim pays into: read in one call at confirmed commitment; every
// missing one is created in one transaction the fee payer signs and pays for; an account the token
// program does not own, a refused or unconfirmed creation, or an unreachable RPC is a failure and
// nothing more is sent. RPC is a double; no network.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  generateKeyPairSigner,
  getBase58Decoder,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  SolanaError,
  type Address,
  type Blockhash,
  type Signature,
} from '@solana/kit';
import {
  createUptoRecipientAccounts,
  UPTO_ERROR_CODES,
  UPTO_PROGRAM,
  UptoError,
  uptoTokenAccount,
  type UptoRecipientAccountsRpc,
} from 'x402-upto-metered';

import { TOKEN_PROGRAM_ADDRESS } from '@gyblos/config';

import {
  decodeSent,
  newAddress,
  type SentTransaction,
} from './support/upto-withdraw-chain';

const TOKEN_PROGRAM = String(TOKEN_PROGRAM_ADDRESS);

interface Chain {
  // Token accounts that exist, by address, with their owning program.
  existing: Map<string, string>;
  outcome?: 'confirmed' | 'never' | 'failed';
  preflightFails?: boolean;
  failing?: boolean;
}

function chainDouble(state: Chain) {
  const sent: SentTransaction[] = [];
  const reads: { accounts: string[]; commitment: string }[] = [];
  const call = <T>(answer: () => T) => ({
    send: async () => {
      if (state.failing)
        throw new Error('rpc down at https://rpc.example/?key=s');
      return answer();
    },
  });
  const rpc: UptoRecipientAccountsRpc = {
    getMultipleAccounts: (accounts, config) =>
      call(() => {
        reads.push({
          accounts: accounts.map(String),
          commitment: config.commitment,
        });
        return {
          value: accounts.map((account) => {
            const owner = state.existing.get(String(account));
            return owner ? { owner: owner as Address } : null;
          }),
        };
      }),
    getLatestBlockhash: () =>
      call(() => ({
        value: {
          blockhash: getBase58Decoder().decode(
            new Uint8Array(32).fill(9),
          ) as Blockhash,
          lastValidBlockHeight: 900n,
        },
      })),
    sendTransaction: (wire) =>
      call(() => {
        if (state.preflightFails)
          throw new SolanaError(
            SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
            {
              accounts: null,
              loadedAccountsDataSize: null,
              logs: null,
              replacementBlockhash: null,
              returnData: null,
              unitsConsumed: null,
            },
          );
        sent.push(decodeSent(wire));
        const bytes = new Uint8Array(64);
        bytes[0] = sent.length;
        return getBase58Decoder().decode(bytes) as Signature;
      }),
    getSignatureStatuses: () =>
      call(() => ({
        value: [
          state.outcome === 'never'
            ? null
            : {
                err:
                  state.outcome === 'failed'
                    ? { InstructionError: [0, 'Custom'] }
                    : null,
                confirmationStatus: 'confirmed' as const,
              },
        ],
      })),
  };
  return { rpc, sent, reads };
}

async function setup(
  state: Omit<Chain, 'existing'> & { present?: number[] } = {},
) {
  const feePayer = await generateKeyPairSigner();
  const mint = await newAddress();
  const payTo = await newAddress();
  const treasury = await newAddress();
  const owners = [payTo, treasury, feePayer.address];
  const accounts = await Promise.all(
    owners.map(async (owner) =>
      String(await uptoTokenAccount(owner, mint, TOKEN_PROGRAM)),
    ),
  );
  const existing = new Map(
    (state.present ?? []).map((index) => [accounts[index]!, TOKEN_PROGRAM]),
  );
  const chain = chainDouble({ ...state, existing });
  const recipients = createUptoRecipientAccounts(chain.rpc, {
    feePayer,
    mint,
    tokenProgram: TOKEN_PROGRAM,
    // The fee payer twice: duplicates are read and created once.
    owners: [...owners, feePayer.address],
    sleep: async () => undefined,
  });
  return { ...chain, recipients, feePayer, mint, owners, accounts, existing };
}

const failsWith = (code: string) => (error: unknown) =>
  error instanceof UptoError &&
  error.code === code &&
  !String(error.message).includes('rpc.example');

void test('accounts that all exist are read once, at confirmed commitment, and nothing is sent', async () => {
  const { recipients, reads, sent, accounts } = await setup({
    present: [0, 1, 2],
  });
  await recipients.ensure();
  assert.deepEqual(reads, [{ accounts, commitment: 'confirmed' }]);
  assert.deepEqual(sent, []);
});

void test('the missing accounts are created idempotently in one transaction the fee payer signs and pays', async () => {
  const { recipients, sent, feePayer, mint, owners, accounts } = await setup({
    present: [2],
  });
  await recipients.ensure();
  assert.equal(sent.length, 1);
  const [transaction] = sent;
  assert.equal(transaction?.feePayer, feePayer.address);
  assert.deepEqual(transaction?.signers, [feePayer.address]);
  // payTo and the treasury, in order; the fee payer's own account already existed.
  assert.deepEqual(
    transaction?.instructions,
    [0, 1].map((index) => ({
      program: UPTO_PROGRAM.associatedTokenProgram,
      accounts: [
        feePayer.address,
        accounts[index],
        owners[index],
        mint,
        UPTO_PROGRAM.systemProgram,
        TOKEN_PROGRAM,
      ],
      data: [UPTO_PROGRAM.createTokenAccountIdempotent],
    })),
  );
});

void test('an account the token program does not own fails before anything is sent', async () => {
  const { recipients, sent, existing, accounts } = await setup({
    present: [1, 2],
  });
  existing.set(accounts[0]!, UPTO_PROGRAM.systemProgram);
  await assert.rejects(
    recipients.ensure(),
    failsWith(UPTO_ERROR_CODES.UNAVAILABLE),
  );
  assert.deepEqual(sent, []);
});

void test('a creation that is refused, does not confirm, or cannot reach the RPC is a failure', async () => {
  for (const [state, code] of [
    [{ preflightFails: true }, UPTO_ERROR_CODES.CHAIN_REJECTED],
    [{ outcome: 'failed' as const }, UPTO_ERROR_CODES.CHAIN_REJECTED],
    [{ outcome: 'never' as const }, UPTO_ERROR_CODES.UNAVAILABLE],
    [{ failing: true }, UPTO_ERROR_CODES.UNAVAILABLE],
  ] as const) {
    const { recipients } = await setup(state);
    await assert.rejects(
      recipients.ensure(),
      failsWith(code),
      JSON.stringify(state),
    );
  }
});
