// Stores one seller-funded 8004 registration under a private, role-scoped process lock.
// Never sends transactions or prints the retained asset key or signed bytes.
import { createKeyPairSignerFromBytes, signature } from '@solana/kit';

import { KEY_LIMITS } from '@gyblos/config';
import {
  ROLE_FILES,
  rolePathIn,
  type HomeEnvironment,
} from '@gyblos/config/home';
import {
  verifyPreparedOwnerRegistration,
  type PreparedOwnerRegistration,
} from '@gyblos/identity';
import { P2P_ROLES } from '@gyblos/protocol/constants';
import {
  acquireProcessLock,
  ensurePrivateDirectory,
  readPrivateFile,
  writePrivateFile,
} from '@gyblos/runtime/private-file';

import { NODE_ERROR_CODES, SELLER_REGISTRATION_STATE } from './constants';
import { NodeError } from './errors';

interface RegistrationState {
  version: typeof SELLER_REGISTRATION_STATE.version;
  owner: string;
  nodeId: string;
  assetSecret: number[];
  prepared?: { wire: string; signature: string; lastValidBlockHeight: string };
}
function fail(): never {
  throw new NodeError(NODE_ERROR_CODES.SELLER_REGISTRATION_STATE_UNAVAILABLE);
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
async function parse(
  source: string,
  identity: { owner: string; nodeId: string },
): Promise<RegistrationState> {
  const value: unknown = JSON.parse(source);
  if (
    !object(value) ||
    Object.keys(value).some(
      (key) =>
        !['version', 'owner', 'nodeId', 'assetSecret', 'prepared'].includes(
          key,
        ),
    ) ||
    value.version !== SELLER_REGISTRATION_STATE.version ||
    value.owner !== identity.owner ||
    value.nodeId !== identity.nodeId ||
    !Array.isArray(value.assetSecret) ||
    value.assetSecret.length !== SELLER_REGISTRATION_STATE.secretBytes ||
    value.assetSecret.some(
      (byte: unknown) =>
        typeof byte !== 'number' ||
        !Number.isInteger(byte) ||
        byte < 0 ||
        byte > KEY_LIMITS.byteMax,
    )
  )
    fail();
  const asset = await createKeyPairSignerFromBytes(
    Uint8Array.from(value.assetSecret),
  );
  const state: RegistrationState = {
    version: SELLER_REGISTRATION_STATE.version,
    owner: identity.owner,
    nodeId: identity.nodeId,
    assetSecret: [...value.assetSecret],
  };
  if (value.prepared !== undefined) {
    const pending = value.prepared;
    if (
      !object(pending) ||
      Object.keys(pending).sort().join(',') !==
        'lastValidBlockHeight,signature,wire' ||
      typeof pending.wire !== 'string' ||
      typeof pending.signature !== 'string' ||
      typeof pending.lastValidBlockHeight !== 'string' ||
      !/^(0|[1-9][0-9]*)$/.test(pending.lastValidBlockHeight)
    )
      fail();
    await verifyPreparedOwnerRegistration(
      {
        wire: pending.wire,
        signature: signature(pending.signature),
        lastValidBlockHeight: BigInt(pending.lastValidBlockHeight),
      },
      { ...identity, asset: asset.address },
    );
    state.prepared = {
      wire: pending.wire,
      signature: pending.signature,
      lastValidBlockHeight: pending.lastValidBlockHeight,
    };
  }
  if (JSON.stringify(state) !== source) fail();
  return state;
}
function withPrepared(
  state: RegistrationState | undefined,
  prepared: PreparedOwnerRegistration,
  failedSignature?: string,
): RegistrationState {
  if (
    !state ||
    (state.prepared
      ? state.prepared.signature !== failedSignature
      : failedSignature !== undefined)
  )
    fail();
  return {
    ...state,
    prepared: {
      wire: prepared.wire,
      signature: prepared.signature,
      lastValidBlockHeight: String(prepared.lastValidBlockHeight),
    },
  };
}
async function readState(
  path: string,
  subject: { owner: string; nodeId: string },
) {
  const source = await readPrivateFile(
    path,
    SELLER_REGISTRATION_STATE.maxBytes,
  );
  return source === undefined ? undefined : parse(source, subject);
}
async function ensureSellerDirectory(environment: HomeEnvironment) {
  await ensurePrivateDirectory(rolePathIn(environment, P2P_ROLES.SELLER, '.'));
}
export async function openSellerRegistrationState(
  environment: HomeEnvironment,
  identity: { owner: string; nodeId: string },
) {
  const subject = { owner: identity.owner, nodeId: identity.nodeId };
  const path = rolePathIn(
    environment,
    P2P_ROLES.SELLER,
    ROLE_FILES.sellerRegistration,
  );
  await ensureSellerDirectory(environment);
  const lock = await acquireProcessLock(
    rolePathIn(
      environment,
      P2P_ROLES.SELLER,
      ROLE_FILES.sellerRegistrationLock,
    ),
  );
  let queue: Promise<unknown> = Promise.resolve();
  let closing = false;
  let poisoned = false;
  const run = <T>(work: () => Promise<T>): Promise<T> => {
    if (closing || poisoned)
      return Promise.reject(
        new NodeError(NODE_ERROR_CODES.SELLER_REGISTRATION_STATE_UNAVAILABLE),
      );
    const result = queue.then(async () => {
      try {
        if (poisoned) fail();
        await lock.verify();
        return await work();
      } catch {
        return fail();
      }
    });
    queue = result.catch(() => {});
    return result;
  };
  const read = () => readState(path, subject);
  const save = async (state: RegistrationState) => {
    const text = JSON.stringify(state);
    await parse(text, subject);
    try {
      await writePrivateFile(path, text, SELLER_REGISTRATION_STATE.maxBytes);
    } catch {
      poisoned = true;
      fail();
    }
  };
  return {
    read: () => run(read),
    create: (assetSecret: number[]) => {
      const secret = [...assetSecret];
      return run(async () => {
        if (await read()) fail();
        await save({
          version: SELLER_REGISTRATION_STATE.version,
          ...subject,
          assetSecret: secret,
        });
      });
    },
    savePrepared: (
      prepared: PreparedOwnerRegistration,
      failedSignature?: string,
    ) => {
      const snapshot = { ...prepared };
      return run(async () =>
        save(withPrepared(await read(), snapshot, failedSignature)),
      );
    },
    close: async () => {
      closing = true;
      await queue;
      await lock.release();
    },
  };
}
