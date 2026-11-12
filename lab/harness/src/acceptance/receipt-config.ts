// Writes only synthetic role and TOML configuration after proving the parent-allocated home is empty.
import { readdir, realpath, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { BUYER_SELECTION } from '@gyblos/buyer/constants';
import {
  DEVNET,
  DEVNET_USDC,
  FILE_MODES,
  homeLayout,
  rolePathIn,
} from '@gyblos/config';
import { SELLER_BADGES } from '@gyblos/core/constants';
import { NODE_NETWORKS } from '@gyblos/node/constants';
import { setupRole } from '@gyblos/node/roles';
import {
  DATA_RETENTION,
  ENGINE_KINDS,
  P2P_ROLES,
  REASONING_LEVELS,
} from '@gyblos/protocol/constants';

import { ACCEPTANCE } from './constants';
import { acceptanceAssert } from './errors';
import { RECEIPT_ACCEPTANCE } from './receipt-constants';
import { assertAcceptanceTempBase } from './workspace';

async function freshWorkspace() {
  const root = await realpath(process.cwd());
  assertAcceptanceTempBase(root);
  acceptanceAssert(basename(root).startsWith(ACCEPTANCE.temporaryPrefix));
  acceptanceAssert(
    process.env.GYBLOS_HOME === root && process.env.GYBLOS_LAB_HOME === root,
  );
  for (const role of [P2P_ROLES.BUYER, P2P_ROLES.SELLER])
    acceptanceAssert(
      (await readdir(homeLayout(process.env).roles[role])).length === 0,
    );
  return root;
}
function toml(cap: number) {
  return `version = 1\n[node]\nnetwork = "${NODE_NETWORKS.DEVNET}"\n[discovery]\npublish = true\nurl = "${ACCEPTANCE.baseUrl}"\n[telemetry]\nfile = true\n[[offers]]\nmodel = "${RECEIPT_ACCEPTANCE.modelId}"\ncustom = true\nreasoning = ["${REASONING_LEVELS.OFF}"]\nengine = { kind = "${ENGINE_KINDS.OPENAI}", url = "${RECEIPT_ACCEPTANCE.engineOrigin}/v1", context_tokens = ${RECEIPT_ACCEPTANCE.contextTokens} }\nfree = { daily_token_cap = ${RECEIPT_ACCEPTANCE.dailyCap}, per_buyer_cap = ${cap} }\n`;
}

export async function receiptRoles() {
  const root = await freshWorkspace();
  process.env.GYBLOS_RPC_URL = ACCEPTANCE.unusedHttpOrigin;
  process.env.GYBLOS_CONFIG = join(root, RECEIPT_ACCEPTANCE.configFile);
  const sellerRole = await setupRole({
    role: P2P_ROLES.SELLER,
    mint: DEVNET_USDC,
  });
  const buyerRole = await setupRole({
    role: P2P_ROLES.BUYER,
    mint: DEVNET_USDC,
  });
  acceptanceAssert(
    sellerRole.role === P2P_ROLES.SELLER && buyerRole.role === P2P_ROLES.BUYER,
  );
  return { root, sellerRole, buyerRole };
}
export async function writeReceiptBuyerConfig(
  owner: string,
  nodeId: string,
  directAddresses: string[],
  rpcUrl: string,
  manualTrust = false,
  maxTokens: number = RECEIPT_ACCEPTANCE.maxTokens,
) {
  const config = {
    request: {
      selection: {
        modelId: RECEIPT_ACCEPTANCE.modelId,
        variant: null,
        quantization: null,
      },
      reasoning: REASONING_LEVELS.OFF,
      lowestReasoning: null,
      network: DEVNET,
      asset: DEVNET_USDC,
      maxTokens,
      maxAtomic: '0',
      priceCeilings: { inputAtomicPerMtok: '0', outputAtomicPerMtok: '0' },
      minimumBadge: SELLER_BADGES.DECLARED_USAGE,
      retention: [DATA_RETENTION.NONE],
    },
    sellers: [
      {
        owner: owner,
        nodeId: nodeId,
        relayUrl: null,
        directAddresses,
        manualTrust,
      },
    ],
    discovery: { baseUrl: ACCEPTANCE.baseUrl, maxPages: 1 },
    identity: { rpcUrl },
  };
  await writeFile(
    rolePathIn(process.env, P2P_ROLES.BUYER, BUYER_SELECTION.configFile),
    JSON.stringify(config),
    { mode: FILE_MODES.privateFile },
  );
}
export async function writeReceiptSellerConfig(cap: number) {
  await writeFile(process.env.GYBLOS_CONFIG!, toml(cap), {
    mode: FILE_MODES.privateFile,
  });
}
