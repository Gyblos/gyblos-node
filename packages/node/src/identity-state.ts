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
  type IdentityLookup,
  type IdentityPolicyDecision,
  type IdentityRegistryScope,
  type IdentityState,
} from '@gyblos/core/identity-policy';

import { IDENTITY_STATE, P2P_ROLES } from './constants.js';
import { assertRoleHome } from './home.js';
import {
  acquireIdentityLock,
  identityDirectory,
  readIdentityFile,
  writeIdentityFile,
} from './identity-state-file.js';
import {
  assertIdentityMonotonic,
  checkedIdentityScope,
  encodeIdentityStates,
  identityStateUnavailable,
  parseIdentityStates,
} from './identity-state-schema.js';

export interface BuyerIdentityInput {
  nodeId: string;
  owner: string;
  manual?: { nodeId: string; owner: string };
  lookup?: IdentityLookup;
}
export async function openBuyerIdentityState(
  environment: HomeEnvironment,
  value: IdentityRegistryScope,
) {
  try {
    const scope = checkedIdentityScope(value);
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
          const decision = evaluateIdentityPolicy({
            ...input,
            scope,
            previous: current.get(input.nodeId),
          });
          if (decision.state) {
            if (
              !current.has(decision.state.binding.nodeId) &&
              current.size >= IDENTITY_STATE.maxRows
            )
              identityStateUnavailable();
            current.set(decision.state.binding.nodeId, decision.state);
          }
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
