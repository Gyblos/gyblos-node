import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { FILE_MODES, MAX_ATOMIC, P2P } from '@gyblos/config';
import { saveJson } from '@gyblos/runtime';

import { modelArchive, provisionArtifacts } from './docker-artifacts.js';
import {
  composeArgs,
  containerId,
  docker,
  execute,
  readContainerJson,
  writeContainerFile,
} from './docker-command.js';
import { fundingConfig } from './docker-fund.js';
import { sourceFingerprint } from './docker-source.js';

export interface PublicBuyer {
  role: 'buyer';
  buyer: string;
  nodeId: string;
  keys: { name: string; mode: number }[];
}
export interface PublicSeller {
  role: 'seller';
  buyer: string;
  owner: string;
  facilitator: string;
  authorizer: string;
  payTo: string;
  mint: string;
  nodeId: string;
  keys: { name: string; mode: number }[];
}

async function waitReady(container: string, runId: string) {
  const expires = Date.now() + P2P.docker.readyMs;
  while (Date.now() < expires) {
    try {
      const state = await readContainerJson<{ status: string; runId: string }>(
        container,
        `${P2P.root}/${P2P.statusFilename}`,
      );
      if (state.status === 'ready' && state.runId === runId) return;
    } catch {
      /* Actor initialization is asynchronous. */
    }
    await new Promise((resolve) => setTimeout(resolve, P2P.routePollMs));
  }
  throw new Error('Role startup did not become ready; no paid call attempted.');
}

export async function prepareDocker(project: string, operatorRoot: string) {
  const config = await fundingConfig(operatorRoot),
    manifest = JSON.parse(await readFile('package.json', 'utf8')) as {
      packageManager: string;
    };
  const source = await sourceFingerprint();
  await docker([
    'build',
    '--build-arg',
    `SOURCE_SHA256=${source.digest}`,
    '--build-arg',
    `NODE_IMAGE=${P2P.docker.nodeImage}`,
    '--build-arg',
    `OLLAMA_IMAGE=${P2P.docker.ollamaImage}`,
    '--build-arg',
    `PNPM_VERSION=${manifest.packageManager.split('@').at(-1)}`,
    '-f',
    'docker/p2p/Dockerfile',
    '-t',
    P2P.docker.image,
    '.',
  ]);
  const image = (
    await docker(['image', 'inspect', '--format', '{{.Id}}', P2P.docker.image])
  ).trim();
  const runId = randomUUID();
  const environment = {
    GYBLOS_P2P_RUN_ID: runId,
    ...process.env,
    GYBLOS_P2P_IMAGE: image,
    GYBLOS_P2P_USER: P2P.docker.user,
    GYBLOS_P2P_CPUS: String(P2P.docker.cpus),
    GYBLOS_P2P_ACTOR_ENTRY: P2P.actorEntry,
    GYBLOS_P2P_PIDS: String(P2P.docker.processLimit),
    GYBLOS_P2P_SELLER_MEMORY: P2P.docker.sellerMemory,
    GYBLOS_P2P_BUYER_MEMORY: P2P.docker.buyerMemory,
    GYBLOS_P2P_SUBNET: P2P.docker.flatSubnet,
    GYBLOS_P2P_SELLER_IP: P2P.docker.sellerIp,
    GYBLOS_P2P_BUYER_IP: P2P.docker.buyerIp,
    GYBLOS_P2P_RPC: config.rpcUrl,
  };
  const archive = await modelArchive(operatorRoot);
  const buyer = JSON.parse(
    await docker(
      composeArgs(project, [
        'run',
        '--rm',
        '-T',
        '--no-deps',
        'buyer',
        'node',
        '--import',
        'tsx',
        'scripts/setup.ts',
        '--role',
        'buyer',
        '--mint',
        config.mint,
      ]),
      undefined,
      environment,
    ),
  ) as PublicBuyer;
  await provisionArtifacts(
    project,
    'buyer',
    operatorRoot,
    archive,
    environment,
  );
  await provisionArtifacts(
    project,
    'seller',
    operatorRoot,
    archive,
    environment,
  );
  const seller = JSON.parse(
    await docker(
      composeArgs(project, [
        'run',
        '--rm',
        '-T',
        '--no-deps',
        'seller',
        'node',
        '--import',
        'tsx',
        'scripts/setup.ts',
        '--role',
        'seller',
        '--mint',
        config.mint,
        '--buyer',
        buyer.buyer,
        '--pay-to',
        config.addresses.seller,
      ]),
      undefined,
      environment,
    ),
  ) as PublicSeller;
  assert.notEqual(seller.nodeId, buyer.nodeId);
  await docker(
    composeArgs(project, ['up', '-d', 'seller']),
    undefined,
    environment,
  );
  const sellerContainer = await containerId(project, 'seller', environment);
  await waitReady(sellerContainer, runId);
  const offer = await execute(sellerContainer, [
    'node',
    '-e',
    `process.stdout.write(require('fs').readFileSync(process.argv[1],'utf8'))`,
    `${P2P.root}/${P2P.offerFilename}`,
  ]);
  const trust = {
    owner: seller.owner,
    nodeId: seller.nodeId,
    mint: seller.mint,
    payTo: seller.payTo,
    buyer: buyer.buyer,
    maxAtomic: MAX_ATOMIC,
  };
  for (const [name, value] of [
    [P2P.offerFilename, JSON.parse(offer)],
    [P2P.trustFilename, trust],
  ] as const)
    await docker(
      composeArgs(project, [
        'run',
        '--rm',
        '-T',
        '--no-deps',
        'buyer',
        'node',
        '-e',
        `const fs=require('fs');const path=process.argv[1];let parts=[];process.stdin.on('data',part=>parts.push(part));process.stdin.on('end',()=>fs.writeFileSync(path,Buffer.concat(parts),{mode:${FILE_MODES.privateFile}}));`,
        `${P2P.root}/${name}`,
      ]),
      Buffer.from(JSON.stringify(value)),
      environment,
    );
  await docker(
    composeArgs(project, ['up', '-d', 'buyer']),
    undefined,
    environment,
  );
  const buyerContainer = await containerId(project, 'buyer', environment);
  await waitReady(buyerContainer, runId);
  await saveJson(P2P.docker.operatorLog, {
    project,
    source,
    runId,
    image,
    buyer,
    seller,
    buyerContainer,
    sellerContainer,
    stage: 'prepared',
    scenario: 'flat',
  });
  return {
    project,
    source,
    runId,
    image,
    environment,
    buyer,
    seller,
    buyerContainer,
    sellerContainer,
  };
}
