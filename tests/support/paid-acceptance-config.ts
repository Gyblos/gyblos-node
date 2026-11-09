// Fresh synthetic roles and private config in the parent-owned acceptance home; no existing keys or data.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { BUYER_SELECTION } from '@gyblos/buyer/constants';
import { DEVNET, DEVNET_USDC, FILE_MODES, rolePathIn } from '@gyblos/config';
import { SELLER_BADGES } from '@gyblos/core/constants';
import { MODEL } from '@gyblos/engine-ollama/model';
import { ACCEPTANCE } from '@gyblos/lab-harness/acceptance/constants';
import { setupRole } from '@gyblos/node/roles';
import {
  DATA_RETENTION,
  ENGINE_KINDS,
  MODEL_IDS,
  OFFER_PRICING_KINDS,
  P2P_ROLES,
  REASONING_LEVELS,
  type OfferPricingKind,
} from '@gyblos/protocol/constants';

import { PAID_ACCEPTANCE } from './paid-acceptance-constants';

export async function paidAcceptanceRoles() {
  process.env.GYBLOS_RPC_URL = 'http://127.0.0.1:9';
  process.env.GYBLOS_CONFIG = join(process.cwd(), 'paid-acceptance.toml');
  const buyer = await setupRole({ role: P2P_ROLES.BUYER, mint: DEVNET_USDC });
  if (buyer.role !== P2P_ROLES.BUYER)
    throw new Error('Synthetic buyer required');
  const seller = await setupRole({
    role: P2P_ROLES.SELLER,
    mint: DEVNET_USDC,
    buyer: buyer.buyer,
  });
  if (seller.role !== P2P_ROLES.SELLER || buyer.role !== P2P_ROLES.BUYER)
    throw new Error('Synthetic role mismatch');
  await paidSellerConfiguration(OFFER_PRICING_KINDS.PAID);
  return { seller, buyer };
}
export async function paidSellerConfiguration(pricing: OfferPricingKind) {
  const price =
    pricing === OFFER_PRICING_KINDS.FREE
      ? `free = { daily_token_cap = 10000, per_buyer_cap = 1000 }`
      : `price = { input_per_mtok = "1", output_per_mtok = "2", currency = "USDC" }`;
  await writeFile(
    process.env.GYBLOS_CONFIG!,
    `version = 1\n[node]\nnetwork = "devnet"\n[discovery]\npublish = true\nurl = "${ACCEPTANCE.baseUrl}"\n[telemetry]\nfile = true\n[[offers]]\nmodel = "${MODEL_IDS.QWEN3_0_6B}"\nreasoning = ["${REASONING_LEVELS.OFF}"]\nengine = { kind = "${ENGINE_KINDS.OLLAMA}", url = "http://127.0.0.1:11434" }\n${price}\n`,
    { mode: FILE_MODES.privateFile },
  );
}
export async function paidBuyerConfiguration(
  owner: string,
  nodeId: string,
  directAddresses: string[],
  rpcUrl: string,
  maxAtomic: string = PAID_ACCEPTANCE.maxAtomic,
) {
  await writeFile(
    rolePathIn(process.env, P2P_ROLES.BUYER, BUYER_SELECTION.configFile),
    JSON.stringify({
      request: {
        selection: {
          modelId: MODEL_IDS.QWEN3_0_6B,
          variant: null,
          quantization: MODEL.quantization,
        },
        reasoning: REASONING_LEVELS.OFF,
        lowestReasoning: null,
        network: DEVNET,
        asset: DEVNET_USDC,
        maxTokens: PAID_ACCEPTANCE.maxTokens,
        maxAtomic,
        priceCeilings: {
          inputAtomicPerMtok: '2000000',
          outputAtomicPerMtok: '3000000',
        },
        minimumBadge: SELLER_BADGES.DECLARED_USAGE,
        retention: [DATA_RETENTION.NONE],
      },
      sellers: [
        { owner, nodeId, directAddresses, relayUrl: null, manualTrust: false },
      ],
      discovery: { baseUrl: ACCEPTANCE.baseUrl, maxPages: 1 },
      identity: { rpcUrl },
    }),
    { mode: FILE_MODES.privateFile },
  );
}
