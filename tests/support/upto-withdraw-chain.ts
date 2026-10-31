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
  getStructEncoder,
  getTransactionDecoder,
  getU8Encoder,
  getU32Encoder,
  getU64Encoder,
  getUtf8Encoder,
  type Address,
  type Blockhash,
  type Signature,
} from '@solana/kit';
import { UPTO_PROGRAM, type UptoWithdrawRpc } from 'x402-upto-metered';

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
}

// The account bytes at the channel's canonical address.
export async function channelAccount(fields: ChannelFields) {
  const salt = 7n;
  const openSlot = 99n;
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
  feePayer: string;
  signers: string[];
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
  return {
    feePayer: keys[0]!,
    signers: keys.slice(0, message.header.numSignerAccounts),
    instructions: message.instructions.map((ix) => ({
      program: keys[ix.programAddressIndex]!,
      accounts: (ix.accountIndices ?? []).map((index) => keys[index]!),
      data: [...(ix.data ?? [])],
    })),
  };
}

export interface WithdrawChainState {
  accounts: Map<string, { owner: Address; data: readonly [string, 'base64'] }>;
  // Unix seconds of the confirmed block.
  blockTime: bigint;
  // The status each sent transaction ends with; null never confirms.
  outcome?: { err: unknown; confirmationStatus: string | null } | null;
  failing?: boolean;
}

export function withdrawChain(state: WithdrawChainState) {
  const sent: SentTransaction[] = [];
  const commitments: string[] = [];
  const unavailable = () => {
    if (state.failing)
      throw new Error('rpc down at https://rpc.example/?key=s');
  };
  const signature = (index: number) => {
    const bytes = new Uint8Array(64);
    bytes[0] = index + 1;
    return getBase58Decoder().decode(bytes) as Signature;
  };
  const rpc: UptoWithdrawRpc = {
    getAccountInfo: (account, config) => ({
      send: async () => {
        commitments.push(config.commitment);
        unavailable();
        return { value: state.accounts.get(String(account)) ?? null };
      },
    }),
    getSlot: () => ({ send: async () => (unavailable(), 500n) }),
    getBlockTime: () => ({
      send: async () => (unavailable(), state.blockTime),
    }),
    getLatestBlockhash: () => ({
      send: async () => {
        unavailable();
        return {
          value: {
            blockhash: getBase58Decoder().decode(
              new Uint8Array(32).fill(9),
            ) as Blockhash,
            lastValidBlockHeight: 900n,
          },
        };
      },
    }),
    sendTransaction: (wire, config) => ({
      send: async () => {
        commitments.push(config.preflightCommitment);
        unavailable();
        sent.push(decodeSent(wire));
        return signature(sent.length - 1);
      },
    }),
    getSignatureStatuses: () => ({
      send: async () => {
        unavailable();
        const outcome =
          state.outcome === undefined
            ? { err: null, confirmationStatus: 'confirmed' }
            : state.outcome;
        return { value: [outcome] };
      },
    }),
  };
  return { rpc, sent, commitments };
}
