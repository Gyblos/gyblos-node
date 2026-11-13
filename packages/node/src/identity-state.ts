// Persists scoped buyer identity floors before returning policy decisions, including denials.
// RPC reads happen outside this store; explicit manual overrides cannot bypass failed storage.
import { join } from 'node:path';

import {
  homeLayout,
  ROLE_FILES,
  type HomeEnvironment,
} from '@gyblos/config/home';
import {
  evaluateIdentityPolicy,
  IDENTITY_POLICY_CODES,
  type IdentityLookup,
  type IdentityPolicyDecision,
  type IdentityRegistryScope,
  type IdentityState,
} from '@gyblos/core/identity-policy';
import { P2P_ROLES } from '@gyblos/protocol/constants';

import { assertRoleHome } from './home';
import {
  identityAdmission,
  type BuyerIdentityAdmission,
} from './identity-state-admission';
import {
  acquireIdentityLock,
  identityDirectory,
  readIdentityFile,
  writeIdentityFile,
} from './identity-state-file';
import {
  assertIdentityMonotonic,
  checkedIdentityScope,
  encodeIdentityStates,
  identityStateUnavailable,
  parseIdentityStates,
  recordIdentityDecision,
} from './identity-state-schema';

export interface BuyerIdentityInput {
  nodeId: string;
  owner: string;
  manual?: { nodeId: string; owner: string };
  lookup?: IdentityLookup;
}
export async function openBuyerIdentityState(
  environment: HomeEnvironment,
  value: IdentityRegistryScope,
  admission?: BuyerIdentityAdmission,
) {
  try {
    const scope = checkedIdentityScope(value);
    const admit = identityAdmission(admission);
    await assertRoleHome(P2P_ROLES.BUYER, environment);
    const directory = await identityDirectory(
      homeLayout(environment).roles.buyer,
    );
    const path = join(directory, ROLE_FILES.identityState);
    const lock = join(directory, ROLE_FILES.identityStateLock);
    const initial = await readIdentityFile(path);
    let held =
      initial === undefined
        ? new Map<string, IdentityState>()
        : parseIdentityStates(initial, scope);
    let exists = initial !== undefined;
    let failed = false;
    let pending = Promise.resolve();
    return {
      async evaluate(
        input: BuyerIdentityInput,
      ): Promise<IdentityPolicyDecision> {
        const previous = pending;
        let release = () => {};
        pending = new Promise<void>((resolve) => {
          release = resolve;
        });
        await previous;
        let unlock;
        try {
          if (failed) identityStateUnavailable();
          await identityDirectory(directory);
          unlock = await acquireIdentityLock(lock);
          const bytes = await readIdentityFile(path);
          if (exists && bytes === undefined) identityStateUnavailable();
          const current =
            bytes === undefined
              ? new Map<string, IdentityState>()
              : parseIdentityStates(bytes, scope);
          assertIdentityMonotonic(held, current);
          if (!admit(current, input.nodeId)) {
            // Preserve every observed floor even when this new identity is refused without writing.
            held = current;
            exists = bytes !== undefined;
            return { ok: false, code: IDENTITY_POLICY_CODES.LIMIT };
          }
          const decision = evaluateIdentityPolicy({
            ...input,
            scope,
            previous: current.get(input.nodeId),
          });
          recordIdentityDecision(current, decision);
          await writeIdentityFile(path, encodeIdentityStates(current, scope));
          held = current;
          exists = true;
          return decision;
        } catch {
          failed = true;
          return identityStateUnavailable();
        } finally {
          try {
            await unlock?.();
          } catch {
            failed = true;
            identityStateUnavailable();
          } finally {
            release();
          }
        }
      },
    };
  } catch {
    return identityStateUnavailable();
  }
}
