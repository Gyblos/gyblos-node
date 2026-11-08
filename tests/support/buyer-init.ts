// Synthetic public buyer-init inputs and isolated homes, never product state or real identities.
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEVNET_RPC_URL,
  DEVNET_USDC,
  IROH_RELAYS,
  ROLE_FILES,
  rolePathIn,
} from '@gyblos/config';
import { CONFIG_ASSET_LABELS } from '@gyblos/config/constants';
import { MODEL } from '@gyblos/engine-ollama/model';
import type { BuyerInitAnswers } from '@gyblos/node/buyer-init';
import { ROLE_CONFIG_SCHEMA_VERSION } from '@gyblos/node/constants';
import type { RoleConfig } from '@gyblos/node/roles';
import { MODEL_IDS, P2P_ROLES } from '@gyblos/protocol/constants';

export const owner = '11111111111111111111111111111111';
export const sellerNodeId = 'ab'.repeat(32);
export function answers(): BuyerInitAnswers {
  return {
    modelId: MODEL_IDS.QWEN3_0_6B,
    variant: '',
    quantization: MODEL.quantization,
    maxTokens: '128',
    maxUsdc: '0',
    inputUsdcPerMtok: '0',
    outputUsdcPerMtok: '0',
    sellerOwner: owner,
    sellerNodeId,
    relayUrl: IROH_RELAYS.urls[0]!,
    discoveryUrl: 'https://discovery.example/v1',
    rpcUrl: DEVNET_RPC_URL,
  };
}
export function role(): RoleConfig {
  return {
    schemaVersion: ROLE_CONFIG_SCHEMA_VERSION,
    role: P2P_ROLES.BUYER,
    rpcUrl: DEVNET_RPC_URL,
    mint: DEVNET_USDC,
    assetLabel: CONFIG_ASSET_LABELS.TEST_TOKEN,
    buyer: owner,
    nodeId: 'cd'.repeat(32),
  };
}
export async function home() {
  const directory = await mkdtemp(join(tmpdir(), 'buyer-init-'));
  const environment = { GYBLOS_HOME: join(directory, 'home') };
  const path = rolePathIn(
    environment,
    P2P_ROLES.BUYER,
    ROLE_FILES.buyerSelection,
  );
  return { directory, environment, path };
}
