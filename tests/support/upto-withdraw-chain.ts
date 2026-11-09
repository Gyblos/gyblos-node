// A confirmed-chain double for the payer's withdrawal: channel accounts as synthetic bytes in the
// program's layout at their canonical address, a block clock, and a send that records each signed
// transaction's instructions and answers with a scripted status. No network.
import {
  address,
  generateKeyPairSigner,
  getAddressEncoder,
  getArrayEncoder,
  getBase58Decoder,
  getBase64Decoder,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getI64Encoder,
  getProgramDerivedAddress,
  getSignatureFromTransaction,
  getStructEncoder,
  getTransactionDecoder,
  getU8Encoder,
  getU32Encoder,
  getU64Encoder,
  getUtf8Encoder,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  SolanaError,
  type Address,
  type Blockhash,
} from '@solana/kit';
import { UPTO_PROGRAM, type UptoWithdrawRpc } from 'x402-upto-metered';

import { DEVNET_GENESIS } from '@gyblos/config';

const channelEncoder = getStructEncoder([
  ['discriminator', getU8Encoder()],
  ['version', getU8Encoder()],
  ['bump', getU8Encoder()],
  ['status', getU8Encoder()],
  ['salt', getU64Encoder()],
  ['deposit', getU64Encoder()],
  [
    'settlement',
    getStructEncoder([
      ['settled', getU64Encoder()],
      ['payoutWatermark', getU64Encoder()],
    ]),
  ],
  ['closureStartedAt', getI64Encoder()],
  ['payerWithdrawnAt', getI64Encoder()],
  ['gracePeriod', getU32Encoder()],
  ['distributionHash', getArrayEncoder(getU8Encoder(), { size: 32 })],
  ['payer', getAddressEncoder()],
  ['payee', getAddressEncoder()],
  ['authorizedSigner', getAddressEncoder()],
  ['mint', getAddressEncoder()],
  ['rentPayer', getAddressEncoder()],
  ['openSlot', getU64Encoder()],
]);

export const newAddress = async (): Promise<Address> =>
  (await generateKeyPairSigner()).address;

export interface ChannelFields {
  payer: Address;
  payee: Address;
  authorizedSigner: Address;
  mint: Address;
  rentPayer: Address;
  status: number;
  deposit: bigint;
  settled: bigint;
  closureStartedAt: bigint;
  gracePeriod: number;
  distributionHash: Uint8Array;
  salt?: bigint;
  openSlot?: bigint;
}

// The account bytes at the channel's canonical address.
export async function channelAccount(fields: ChannelFields) {
  const salt = fields.salt ?? 7n;
  const openSlot = fields.openSlot ?? 99n;
  const [channelId] = await getProgramDerivedAddress({
    programAddress: address(UPTO_PROGRAM.id),
    seeds: [
      getUtf8Encoder().encode('channel'),
      ...[fields.payer, fields.payee, fields.mint, fields.authorizedSigner].map(
        (key) => getAddressEncoder().encode(key),
      ),
      getU64Encoder().encode(salt),
      getU64Encoder().encode(openSlot),
    ],
  });
  const bytes = new Uint8Array(256);
  bytes.set(
    channelEncoder.encode({
      discriminator: 1,
      version: 1,
      bump: 255,
      salt,
      settlement: { settled: fields.settled, payoutWatermark: fields.settled },
      payerWithdrawnAt: 0n,
      openSlot,
      ...fields,
      distributionHash: [...fields.distributionHash],
    }),
  );
  return {
    channelId: String(channelId),
    account: {
      owner: address(UPTO_PROGRAM.id),
      data: [getBase64Decoder().decode(bytes), 'base64'] as const,
    },
  };
}

export interface SentInstruction {
  program: string;
  accounts: string[];
  data: number[];
}
export interface SentTransaction {
  // A partially signed SDK wire can still be inspected before its fee payer signs.
  signature: string | null;
  feePayer: string;
  signers: string[];
  writableSigners: number;
  instructions: SentInstruction[];
}

// What a signed wire transaction asks the chain to do.
export function decodeSent(wire: string): SentTransaction {
  const decoded = getTransactionDecoder().decode(
    getBase64Encoder().encode(wire),
  );
  const message = getCompiledTransactionMessageDecoder().decode(
    decoded.messageBytes,
  );
  const keys = message.staticAccounts.map(String);
  const payerSignature = decoded.signatures[message.staticAccounts[0]!];
  return {
    signature: payerSignature
      ? getBase58Decoder().decode(payerSignature)
      : null,
    feePayer: keys[0]!,
    signers: keys.slice(0, message.header.numSignerAccounts),
    writableSigners:
      message.header.numSignerAccounts -
      message.header.numReadonlySignerAccounts,
    instructions: message.instructions.map((ix) => ({
      program: keys[ix.programAddressIndex]!,
      accounts: (ix.accountIndices ?? []).map((index) => keys[index]!),
      data: [...(ix.data ?? [])],
    })),
  };
}

export interface WithdrawChainState {
  accounts: Map<string, { owner: Address; data: readonly [string, 'base64'] }>;
  // Unix seconds of the confirmed block; null while the node does not know it.
  blockTime: bigint | null;
  // The status each sent transaction ends with; null never confirms.
  outcome?: {
    err: unknown;
    confirmationStatus: 'confirmed' | 'finalized' | null;
  } | null;
  // Preflight simulation refuses every send, as the RPC does for a transaction that would fail.
  preflightFails?: boolean;
  // These calls alone fail, with the RPC's own error or a transport one carrying its URL.
  blockTimeError?: unknown;
  sendError?: boolean;
  statusError?: boolean;
  failing?: boolean;
}

export function withdrawChain(state: WithdrawChainState) {
  const sent: SentTransaction[] = [];
  // Each read with the commitment it asked for, and every call's deadline.
  const reads: { call: string; commitment?: string }[] = [];
  const deadlines: (AbortSignal | undefined)[] = [];
  const call =
    <T>(name: string, commitment: string | undefined, answer: () => T) =>
    () => ({
      send: async (options?: { abortSignal?: AbortSignal }) => {
        reads.push({ call: name, commitment });
        deadlines.push(options?.abortSignal);
        if (state.failing)
          throw new Error('rpc down at https://rpc.example/?key=s');
        return answer();
      },
    });
  const rpc: UptoWithdrawRpc & {
    getGenesisHash(): { send(): Promise<string> };
  } = {
    getGenesisHash: () => ({ send: async () => DEVNET_GENESIS }),
    getAccountInfo: (account, config) =>
      call('account', config.commitment, () => ({
        value: state.accounts.get(String(account)) ?? null,
      }))(),
    getSlot: (config) => call('slot', config.commitment, () => 500n)(),
    getBlockTime: () =>
      call('blockTime', undefined, () => {
        if (state.blockTimeError) throw state.blockTimeError;
        return state.blockTime;
      })(),
    getLatestBlockhash: (config) =>
      call('blockhash', config.commitment, () => ({
        value: {
          blockhash: getBase58Decoder().decode(
            new Uint8Array(32).fill(9),
          ) as Blockhash,
          lastValidBlockHeight: 900n,
        },
      }))(),
    sendTransaction: (wire, config) =>
      call('send', config.preflightCommitment, () => {
        if (state.sendError)
          throw new Error('send failed at https://rpc.example/?key=s');
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
        return getSignatureFromTransaction(
          getTransactionDecoder().decode(getBase64Encoder().encode(wire)),
        );
      })(),
    getSignatureStatuses: () =>
      call('status', undefined, () => {
        if (state.statusError)
          throw new Error('status failed at https://rpc.example/?key=s');
        return {
          value: [
            state.outcome === undefined
              ? { err: null, confirmationStatus: 'confirmed' as const }
              : state.outcome,
          ],
        };
      })(),
  };
  const commitments = () => [
    ...new Set(reads.flatMap(({ commitment }) => commitment ?? [])),
  ];
  return { rpc, sent, reads, deadlines, commitments };
}
