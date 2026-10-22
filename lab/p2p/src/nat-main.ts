import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { P2P } from '@gyblos/config';
import { lamports, tokens } from '@gyblos/payments-x402/chain';
import { withExclusiveLock } from '@gyblos/payments-x402/recovery/lock';
import { saveJson } from '@gyblos/runtime';

import { NAT } from './constants.js';
import { inspectDocker } from './docker-checks.js';
import { execute, readContainerJson } from './docker-command.js';
import { fundingConfig } from './docker-fund.js';
import { prepareDocker } from './docker-prepare.js';
import { inspectNat } from './nat-checks.js';
import { recordNatEvidence } from './nat-evidence.js';
import { stopNatTopology, type NatScenario } from './nat-topology.js';

export async function runNat(options: {
  scenario: NatScenario;
  operatorRoot: string;
  volumePrefix: string;
  labCandidates: boolean;
}) {
  const project = `${P2P.docker.projectPrefix}-${randomUUID().slice(0, P2P.docker.projectIdCharacters)}`;
  const context = await prepareDocker(
    project,
    resolve(options.operatorRoot),
    options,
  );
  const journal = await readContainerJson<{ state: string }>(
    context.buyerContainer,
    `${P2P.root}/${P2P.journalFilename}`,
  );
  assert.equal(journal.state, 'confirmed');
  const config = await fundingConfig(options.operatorRoot);
  assert.ok(
    (await tokens(config.rpcUrl, context.buyer.buyer, context.seller.mint)) >=
      P2P.docker.fundTokens / BigInt(P2P.minimumRequests),
  );
  assert.ok(
    (await lamports(config.rpcUrl, context.seller.facilitator)) >
      NAT.minimumSponsorLamports,
  );
  const calls = await readContainerJson<unknown[]>(
    context.buyerContainer,
    `${P2P.root}/${P2P.callsFilename}`,
  );
  const security = await inspectDocker(context),
    before = await inspectNat(context);
  await saveJson(`${NAT.startManifestPrefix}-${context.runId}.json`, {
    scenario: context.scenario,
    source: context.source,
    runId: context.runId,
    image: context.image,
    routerImage: context.environment.GYBLOS_P2P_ROUTER_IMAGE,
    offset: calls.length,
    callPrefixSha256: createHash('sha256')
      .update(JSON.stringify(calls))
      .digest('hex'),
    security,
    topology: before,
  });
  for (let index = 0; index < P2P.minimumRequests; index++)
    await execute(context.buyerContainer, [
      'node',
      '--import',
      'tsx',
      P2P.callEntry,
      String(index),
    ]);
  const after = await inspectNat(context);
  const result = await recordNatEvidence(
    context,
    calls.length,
    security,
    before,
    after,
  );
  await stopNatTopology(project, context.environment);
  return result;
}

export async function natGate(options: Parameters<typeof runNat>[0]) {
  return withExclusiveLock(P2P.docker.lock, () => runNat(options));
}
