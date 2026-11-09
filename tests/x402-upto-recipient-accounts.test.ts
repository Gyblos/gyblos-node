// The token accounts a seller's claim pays into: read in one call at confirmed commitment; every
// missing one is created in one transaction the fee payer signs and pays for; creations run one at a
// time, each reading again first; a frozen account, an account the token program does not own, a
// refused or unconfirmed creation, or an unreachable RPC is a failure and nothing more is sent. RPC is
// a double; no network.
import assert from 'node:assert/strict';
import test from 'node:test';

import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import {
  generateKeyPairSigner,
  getBase58Decoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  SolanaError,
  type Address,
  type Blockhash,
} from '@solana/kit';
import {
  createUptoRecipientAccounts,
  UPTO_ERROR_CODES,
  UPTO_PROGRAM,
  UPTO_TOKEN_ACCOUNT,
  UptoError,
  uptoRecipientTokenAccounts,
  uptoTokenAccount,
  type UptoRecipientAccountsRpc,
} from 'x402-upto-metered';

import {
  decodeSent,
  newAddress,
  type SentTransaction,
} from './support/upto-withdraw-chain';

const TOKEN_PROGRAM = String(TOKEN_PROGRAM_ADDRESS);
// A token account's data (165 bytes) in the given state.
const tokenAccount = (state: number) => {
  const bytes = new Uint8Array(165);
  bytes[UPTO_TOKEN_ACCOUNT.stateOffset] = state;
  return Buffer.from(bytes).toString('base64');
};
const INITIALIZED = tokenAccount(UPTO_TOKEN_ACCOUNT.initialized);
const FROZEN = tokenAccount(UPTO_TOKEN_ACCOUNT.frozen);

interface Chain {
  // Token accounts that exist, by address, with their owning program.
  // Accounts at those addresses: their owning program and base64 data ('' when empty).
  existing: Map<string, { owner: string; data: string }>;
  // The RPC answers with one entry too few.
  short?: boolean;
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
          value: accounts.slice(state.short ? 1 : 0).map((account) => {
            const found = state.existing.get(String(account));
            return found
              ? {
                  owner: found.owner as Address,
                  data: [found.data, 'base64'] as const,
                }
              : null;
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
        const transaction = decodeSent(wire);
        sent.push(transaction);
        // A confirmed creation exists for the next read.
        if (state.outcome === undefined || state.outcome === 'confirmed')
          for (const instruction of transaction.instructions)
            state.existing.set(String(instruction.accounts[1]), {
              owner: TOKEN_PROGRAM,
              data: INITIALIZED,
            });
        return getSignatureFromTransaction(
          getTransactionDecoder().decode(Buffer.from(wire, 'base64')),
        );
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
    (state.present ?? []).map((index) => [
      accounts[index]!,
      { owner: TOKEN_PROGRAM, data: INITIALIZED },
    ]),
  );
  const chainState: Chain = { ...state, existing };
  const chain = chainDouble(chainState);
  const recipients = createUptoRecipientAccounts(chain.rpc, {
    feePayer,
    mint,
    tokenProgram: TOKEN_PROGRAM,
    // The fee payer twice: duplicates are read and created once.
    owners: [...owners, feePayer.address],
    sleep: async () => undefined,
  });
  return {
    ...chain,
    chainState,
    recipients,
    feePayer,
    mint,
    owners,
    accounts,
    existing,
  };
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

void test('an empty system account at an address (anyone can fund one) is missing and created over', async () => {
  const { recipients, sent, existing, accounts, owners } = await setup({
    present: [1, 2],
  });
  existing.set(accounts[0]!, { owner: UPTO_PROGRAM.systemProgram, data: '' });
  await recipients.ensure();
  assert.deepEqual(
    sent[0]?.instructions.map((instruction) => instruction.accounts[2]),
    [owners[0]],
  );
});

void test('owners given for one claim are read and created with the seller’s own', async () => {
  const { recipients, sent, reads, mint, accounts } = await setup({
    present: [0, 1, 2],
  });
  const buyer = await newAddress();
  await recipients.ensure([buyer]);
  const refund = String(await uptoTokenAccount(buyer, mint, TOKEN_PROGRAM));
  assert.deepEqual(reads[0]?.accounts, [...accounts, refund]);
  assert.deepEqual(
    sent[0]?.instructions.map((instruction) => instruction.accounts[2]),
    [buyer],
  );
});

void test('creations run one at a time and read again first, so a missing account is created once', async () => {
  const { recipients, sent, reads } = await setup({ present: [1, 2] });
  await Promise.all([recipients.ensure(), recipients.ensure()]);
  assert.equal(sent.length, 1);
  // Each found it missing, then read again in turn before creating.
  assert.equal(reads.length, 4);
  // With nothing missing, a check only reads.
  await recipients.ensure();
  assert.equal(reads.length, 5);
  // A failed check does not stop the next one.
  const failing = await setup({ failing: true });
  await assert.rejects(
    failing.recipients.ensure(),
    failsWith(UPTO_ERROR_CODES.UNAVAILABLE),
  );
  failing.chainState.failing = false;
  await failing.recipients.ensure();
  assert.equal(failing.sent.length, 1);
});

void test('a frozen or uninitialized token account fails before anything is sent', async () => {
  for (const data of [FROZEN, tokenAccount(0), '']) {
    const { recipients, sent, existing, accounts } = await setup({
      present: [1, 2],
    });
    existing.set(accounts[0]!, { owner: TOKEN_PROGRAM, data });
    await assert.rejects(
      recipients.ensure(),
      failsWith(UPTO_ERROR_CODES.UNAVAILABLE),
      data,
    );
    assert.deepEqual(sent, []);
  }
  // Read on its own, a frozen account is unusable rather than missing.
  const { chainState, rpc, mint, owners, accounts } = await setup({
    present: [1, 2],
  });
  chainState.existing.set(accounts[1]!, { owner: TOKEN_PROGRAM, data: FROZEN });
  assert.deepEqual(
    await uptoRecipientTokenAccounts(rpc, {
      mint,
      tokenProgram: TOKEN_PROGRAM,
      owners,
    }),
    { missing: [owners[0]], unusable: [owners[1]] },
  );
});

void test('an RPC answer of the wrong length fails before anything is sent', async () => {
  const { recipients, sent } = await setup({ present: [0, 1, 2], short: true });
  await assert.rejects(
    recipients.ensure(),
    failsWith(UPTO_ERROR_CODES.UNAVAILABLE),
  );
  assert.deepEqual(sent, []);
});

void test('an account the token program does not own fails before anything is sent', async () => {
  const { recipients, sent, existing, accounts } = await setup({
    present: [1, 2],
  });
  existing.set(accounts[0]!, {
    owner: UPTO_PROGRAM.systemProgram,
    data: 'AA==',
  });
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
