// Builds ephemeral signed registry accounts from the public identity codec, never a real chain/key file.
// These synthetic layout bytes are a fixture, not evidence of deployed registry behavior.
import {
  generateKeyPairSigner,
  getAddressDecoder,
  getAddressEncoder,
  type Address,
} from '@solana/kit';

import {
  concatBytes,
  encodeBindingValue,
  encodeBool,
  encodeString,
  encodeVecU8,
  findAgentAddress,
  findMetadataAddress,
  signNodeBinding,
} from '@gyblos/identity/codec';
import {
  ACCOUNT_DISCRIMINATORS,
  DEVNET_REGISTRY,
  METADATA_KEYS,
  MPL_CORE_ASSET_V1_KEY,
  PROGRAMS,
} from '@gyblos/identity/constants';
import { controlHex } from '@gyblos/protocol/control-validation';
import type { Signer } from '@gyblos/protocol/signing';

import { REGISTRY_FIXTURE } from './identity-registry-constants.js';

export interface RegistrySubject {
  nodeId: string;
  owner: Address;
  nodeSigner: Signer;
}
export interface RegistryAccount {
  address: Address;
  owner: Address;
  data: Uint8Array;
}
export interface RegistryClaim {
  nodeId: string;
  sequence: bigint;
  accounts: RegistryAccount[];
}
function addressBytes(value: Address) {
  return new Uint8Array(getAddressEncoder().encode(value));
}
function agentBytes(owner: Address, asset: Address) {
  return concatBytes([
    ACCOUNT_DISCRIMINATORS.agent,
    addressBytes(DEVNET_REGISTRY.collection),
    addressBytes(owner),
    addressBytes(owner),
    addressBytes(asset),
    Uint8Array.of(REGISTRY_FIXTURE.bump),
    encodeBool(false),
    encodeBool(false),
    new Uint8Array(REGISTRY_FIXTURE.reputationDigestBytes),
    encodeBool(false),
    encodeBool(false),
    encodeBool(false),
    encodeString('https://synthetic.invalid/agent'),
    encodeString('Synthetic agent'),
    encodeString(''),
  ]);
}
export async function registryClaim(
  subject: RegistrySubject,
  sequence: bigint,
): Promise<RegistryClaim> {
  const nodeId = controlHex(subject.nodeId);
  const asset = (await generateKeyPairSigner()).address;
  const binding = await signNodeBinding(
    {
      address: getAddressDecoder().decode(Buffer.from(nodeId, 'hex')),
      signDetached: (message) => subject.nodeSigner(Uint8Array.from(message)),
    },
    { asset, owner: subject.owner, sequence },
  );
  return {
    nodeId,
    sequence,
    accounts: [
      {
        address: await findAgentAddress(asset),
        owner: PROGRAMS.registry,
        data: agentBytes(subject.owner, asset),
      },
      {
        address: asset,
        owner: PROGRAMS.mplCore,
        data: concatBytes([
          Uint8Array.of(MPL_CORE_ASSET_V1_KEY),
          addressBytes(subject.owner),
          new Uint8Array(REGISTRY_FIXTURE.coreTailBytes),
        ]),
      },
      {
        address: await findMetadataAddress(asset, METADATA_KEYS.nodeId),
        owner: PROGRAMS.registry,
        data: concatBytes([
          ACCOUNT_DISCRIMINATORS.metadata,
          addressBytes(asset),
          encodeBool(false),
          Uint8Array.of(REGISTRY_FIXTURE.bump),
          encodeString(METADATA_KEYS.nodeId),
          encodeVecU8(encodeBindingValue(binding)),
        ]),
      },
    ],
  };
}
export function registryAccountJson(account: RegistryAccount | undefined) {
  return account
    ? {
        data: [Buffer.from(account.data).toString('base64'), 'base64'],
        executable: false,
        lamports: REGISTRY_FIXTURE.lamports,
        owner: account.owner,
        rentEpoch: 0,
        space: account.data.length,
      }
    : null;
}
