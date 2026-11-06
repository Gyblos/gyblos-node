// Coordinates a seller's 8004 registration with one private pending attempt.
// The chain, signature handling and private state are separate boundaries.
import { generateKeyPairSync } from 'node:crypto';

import {
  createKeyPairSignerFromBytes,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getTransactionDecoder,
  signature,
  type KeyPairSigner,
} from '@solana/kit';

import type { HomeEnvironment } from '@gyblos/config/home';
import type {
  OwnerRegistrationSubmission,
  PreparedOwnerRegistration,
} from '@gyblos/identity';
import { OWNER_REGISTRATION_STATUS } from '@gyblos/identity/constants';

import { openSellerRegistrationState } from './seller-registration-state';

export interface SellerRegistrationOperations {
  // true means a matching binding exists; false means absent; undefined means unavailable.
  lookup(asset?: string): Promise<boolean | undefined>;
  build(asset: KeyPairSigner): Promise<{
    estimatedTotalLamports: bigint;
    sign(): Promise<PreparedOwnerRegistration>;
  }>;
  send(
    prepared: PreparedOwnerRegistration,
  ): Promise<OwnerRegistrationSubmission>;
  check(
    prepared: PreparedOwnerRegistration,
  ): Promise<OwnerRegistrationSubmission>;
}
function newAssetSecret(): number[] {
  const key = generateKeyPairSync('ed25519').privateKey.export({
    format: 'jwk',
  });
  if (!key.d || !key.x) throw new Error('REGISTRATION_KEY_UNAVAILABLE');
  return [
    ...Buffer.from(key.d, 'base64url'),
    ...Buffer.from(key.x, 'base64url'),
  ];
}
export async function registerSellerIdentity(input: {
  environment: HomeEnvironment;
  identity: { owner: string; nodeId: string };
  operations: SellerRegistrationOperations;
  confirm(estimatedTotalLamports: bigint): Promise<boolean>;
}): Promise<boolean> {
  const state = await openSellerRegistrationState(
    input.environment,
    input.identity,
  );
  try {
    let current = await state.read();
    const asset = current
      ? await createKeyPairSignerFromBytes(Uint8Array.from(current.assetSecret))
      : undefined;
    const existing = await input.operations.lookup(asset?.address);
    if (existing === true) return true;
    if (existing === undefined) return false;
    let failedSignature: string | undefined;
    if (current?.prepared) {
      const pending = {
        wire: getBase64EncodedWireTransaction(
          getTransactionDecoder().decode(
            getBase64Encoder().encode(current.prepared.wire),
          ),
        ),
        signature: signature(current.prepared.signature),
        lastValidBlockHeight: BigInt(current.prepared.lastValidBlockHeight),
      };
      const result = await input.operations.check(pending);
      if (result.status === OWNER_REGISTRATION_STATUS.CONFIRMED)
        return (await input.operations.lookup(asset?.address)) === true;
      if (result.status !== OWNER_REGISTRATION_STATUS.FAILED) return false;
      failedSignature = current.prepared.signature;
    }
    if (!current) {
      await state.create(newAssetSecret());
      current = await state.read();
    }
    if (!current) return false;
    const signer = await createKeyPairSignerFromBytes(
      Uint8Array.from(current.assetSecret),
    );
    const draft = await input.operations.build(signer);
    if (!(await input.confirm(draft.estimatedTotalLamports))) return false;
    const prepared = await draft.sign();
    await state.savePrepared(prepared, failedSignature);
    const result = await input.operations.send(prepared);
    return (
      result.status === OWNER_REGISTRATION_STATUS.CONFIRMED &&
      (await input.operations.lookup(signer.address)) === true
    );
  } finally {
    await state.close();
  }
}

export { sellerRegistrationOperations } from './seller-registration-chain';
