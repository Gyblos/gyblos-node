// Owns one acceptance session and its restartable control-only seller; all resources are ephemeral.
// The index survives restart to retain high-water marks; no role keys, paid host or RPC is started.
import { randomBytes } from 'node:crypto';

import { generateKeyPairSigner } from '@solana/kit';

import { buyerDiscoveryState } from '@gyblos/buyer/discovery-storage';
import { NODE_KEY_BYTES } from '@gyblos/node/constants';

import { createAcceptanceClock } from './clock.js';
import type { AcceptanceMode } from './constants.js';
import { createAcceptanceEngine } from './engine.js';
import { startAcceptanceHost, type AcceptanceHost } from './host.js';
import { createAcceptanceIndex } from './index.js';
import { createNativeAcceptanceNode } from './native.js';
import { createAcceptanceWorkspace } from './workspace.js';

export async function createAcceptanceSession(
  mode: AcceptanceMode,
  signal: AbortSignal,
) {
  const workspace = await createAcceptanceWorkspace();
  const engine = createAcceptanceEngine(mode);
  let host: AcceptanceHost | undefined;
  let closeWire: (() => Promise<void>) | undefined;
  try {
    const identity = {
      owner: await generateKeyPairSigner(),
      buyer: await generateKeyPairSigner(),
      payTo: await generateKeyPairSigner(),
      feePayer: await generateKeyPairSigner(),
      authorizer: await generateKeyPairSigner(),
    };
    const secret = [...randomBytes(NODE_KEY_BYTES)];
    const wire = await createNativeAcceptanceNode(secret);
    closeWire = wire.close;
    const clock = createAcceptanceClock(mode, signal);
    const index = createAcceptanceIndex(clock.now, wire.nodeId);
    const options = { identity, engine, clock, index, workspace, signal };
    host = await startAcceptanceHost({ ...options, wire });
    let state = await buyerDiscoveryState(workspace.environment);
    return {
      ...options,
      host: () => host!,
      state: () => state,
      async restart() {
        await host!.close();
        host = undefined;
        const next = await createNativeAcceptanceNode(secret);
        closeWire = next.close;
        host = await startAcceptanceHost({ ...options, wire: next });
        state = await buyerDiscoveryState(workspace.environment);
      },
      async close() {
        engine.release();
        try {
          if (host) await host.close();
          else await closeWire?.();
        } finally {
          await workspace.close();
        }
      },
    };
  } catch (error) {
    engine.release();
    try {
      if (host) await host.close();
      else await closeWire?.();
    } finally {
      await workspace.close();
    }
    throw error;
  }
}
export type AcceptanceSession = Awaited<
  ReturnType<typeof createAcceptanceSession>
>;
