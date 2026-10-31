// The payer's way out of a channel, encoded as the SDK's generated client does (it does not export
// these builders): request_close, the permissionless seal and distribute with its recipient tail, and
// the distribution hash the channel stores. A test compares every byte with the SDK. No Gyblos imports.
import { createHash } from 'node:crypto';

import {
  AccountRole,
  address,
  getAddressEncoder,
  getProgramDerivedAddress,
  getU16Encoder,
  getU32Encoder,
  getUtf8Encoder,
  type AccountMeta,
  type AccountSignerMeta,
  type Address,
  type Instruction,
  type ReadonlyUint8Array,
  type TransactionSigner,
} from '@solana/kit';
import { SOLANA_DEVNET_CAIP2 } from '@x402/svm';

import { UPTO_PROGRAM } from './constants';
import type { UptoSplit } from './types';

export type UptoProgramInstruction = Instruction & {
  accounts: readonly AccountMeta[];
  data: Uint8Array;
};

const program = address(UPTO_PROGRAM.id);
const encode = getAddressEncoder();

function instruction(
  discriminator: number,
  accounts: readonly AccountMeta[],
  args: readonly ReadonlyUint8Array[] = [],
): UptoProgramInstruction {
  const data = new Uint8Array(
    [Uint8Array.of(discriminator), ...args].flatMap((part) => [...part]),
  );
  return { programAddress: program, accounts, data };
}

const writable = (account: string): AccountMeta => ({
  address: address(account),
  role: AccountRole.WRITABLE,
});
const readonly = (account: string): AccountMeta => ({
  address: address(account),
  role: AccountRole.READONLY,
});

// The payer starts the grace period; only the payer may sign it.
export function requestCloseInstruction(
  payer: TransactionSigner,
  channelId: string,
): UptoProgramInstruction {
  const signer: AccountSignerMeta = {
    address: payer.address,
    role: AccountRole.READONLY_SIGNER,
    signer: payer,
  };
  return instruction(UPTO_PROGRAM.discriminators.REQUEST_CLOSE, [
    signer,
    writable(channelId),
  ]);
}

// Anyone may seal a closing channel once its grace period has elapsed.
export function sealInstruction(channelId: string): UptoProgramInstruction {
  return instruction(UPTO_PROGRAM.discriminators.SEAL, [writable(channelId)]);
}

// The SHA-256 the program stores at open: recipient count, then each recipient and its bps.
export function uptoDistributionHash(splits: readonly UptoSplit[]): Uint8Array {
  const bytes = (value: ReadonlyUint8Array) => Uint8Array.from(value);
  const hash = createHash('sha256').update(
    bytes(getU32Encoder().encode(splits.length)),
  );
  for (const split of splits)
    hash
      .update(bytes(encode.encode(address(split.recipient))))
      .update(bytes(getU16Encoder().encode(split.bps)));
  return new Uint8Array(hash.digest());
}

export async function uptoTokenAccount(
  owner: string,
  mint: string,
  tokenProgram: string,
): Promise<Address> {
  const [found] = await getProgramDerivedAddress({
    programAddress: address(UPTO_PROGRAM.associatedTokenProgram),
    seeds: [owner, tokenProgram, mint].map((key) =>
      encode.encode(address(key)),
    ),
  });
  return found;
}

// The treasury the program binary for this network pays redirected payouts to.
export const uptoProgramTreasury = (network: string) =>
  network === SOLANA_DEVNET_CAIP2
    ? UPTO_PROGRAM.treasuryOwners.devnet
    : UPTO_PROGRAM.treasuryOwners.mainnet;

// Creates the payer's token account if it was closed, which costs only rent when it already exists:
// distribute would otherwise redirect the refund to the program's treasury for good.
export async function payerTokenAccountInstruction(
  payer: TransactionSigner,
  mint: string,
  tokenProgram: string,
): Promise<UptoProgramInstruction> {
  const signer: AccountSignerMeta = {
    address: payer.address,
    role: AccountRole.WRITABLE_SIGNER,
    signer: payer,
  };
  return {
    programAddress: address(UPTO_PROGRAM.associatedTokenProgram),
    accounts: [
      signer,
      writable(await uptoTokenAccount(payer.address, mint, tokenProgram)),
      readonly(payer.address),
      readonly(mint),
      readonly(UPTO_PROGRAM.systemProgram),
      readonly(tokenProgram),
    ],
    data: Uint8Array.of(UPTO_PROGRAM.createTokenAccountIdempotent),
  };
}

export interface UptoDistributeQuery {
  channelId: string;
  payer: string;
  // The channel's payee as stored at open (the seller's fee payer), not payTo.
  payee: string;
  rentPayer: string;
  mint: string;
  tokenProgram: string;
  network: string;
  splits: readonly UptoSplit[];
}

// Pays the settled amount by the splits and refunds the rest to the payer; anyone may send it.
export async function distributeInstruction(
  query: UptoDistributeQuery,
): Promise<UptoProgramInstruction> {
  const ata = (owner: string) =>
    uptoTokenAccount(owner, query.mint, query.tokenProgram);
  const [eventAuthority] = await getProgramDerivedAddress({
    programAddress: program,
    seeds: [getUtf8Encoder().encode(UPTO_PROGRAM.eventAuthoritySeed)],
  });
  const recipients = query.splits.flatMap((split) => [
    encode.encode(address(split.recipient)),
    getU16Encoder().encode(split.bps),
  ]);
  return instruction(
    UPTO_PROGRAM.discriminators.DISTRIBUTE,
    [
      writable(query.channelId),
      writable(query.payer),
      writable(query.rentPayer),
      writable(await ata(query.channelId)),
      writable(await ata(query.payer)),
      writable(await ata(query.payee)),
      writable(await ata(uptoProgramTreasury(query.network))),
      readonly(query.mint),
      readonly(query.tokenProgram),
      readonly(eventAuthority),
      readonly(UPTO_PROGRAM.id),
      ...(await Promise.all(
        query.splits.map(async (split) => writable(await ata(split.recipient))),
      )),
    ],
    [getU32Encoder().encode(query.splits.length), ...recipients],
  );
}
