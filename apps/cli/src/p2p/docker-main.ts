import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { P2P } from '@gyblos/config';
import { withExclusiveLock } from '@gyblos/gate/lock';
import { isMain } from '@gyblos/runtime';

import { inspectDocker } from './docker-checks.js';
import { execute } from './docker-command.js';
import { dockerEvidence } from './docker-evidence.js';
import { fundRoles } from './docker-fund.js';
import { prepareDocker } from './docker-prepare.js';
import { runNat } from './nat-main.js';

async function run() {
  const { values } = parseArgs({
    options: {
      'operator-root': { type: 'string' },
      scenario: { type: 'string', default: 'flat' },
      'volume-prefix': { type: 'string' },
      'lab-candidates': { type: 'boolean', default: false },
    },
  });
  if (values.scenario === 'nat-direct' || values.scenario === 'nat-relay') {
    if (!values['volume-prefix'])
      throw new Error('NAT requires existing isolated role volumes.');
    const result = await runNat({
      scenario: values.scenario,
      operatorRoot: resolve(values['operator-root'] ?? process.cwd()),
      volumePrefix: values['volume-prefix'],
      labCandidates: values['lab-candidates'],
    });
    console.log(
      JSON.stringify({
        scenario: values.scenario,
        status: result.status,
        candidateMode: result.candidateMode,
      }),
    );
    return;
  }
  if (values.scenario !== 'flat')
    throw new Error('Unknown scenario; choose flat, nat-direct or nat-relay.');
  const operatorRoot = resolve(values['operator-root'] ?? process.cwd());
  const project = `${P2P.docker.projectPrefix}-${randomUUID().slice(0, P2P.docker.projectIdCharacters)}`;
  const context = await prepareDocker(project, operatorRoot);
  const security = await inspectDocker(context);
  const funding = await fundRoles(
    operatorRoot,
    context.buyer.buyer,
    context.seller.facilitator,
  );
  for (let index = 0; index < P2P.minimumRequests; index++) {
    await execute(context.buyerContainer, [
      'node',
      '--import',
      'tsx',
      P2P.callEntry,
      String(index),
    ]);
  }
  const evidence = await dockerEvidence(context, security, funding.signature);
  console.log(
    JSON.stringify({
      evidence: P2P.docker.evidence,
      status: evidence.status,
      flat: 'passed',
      nat: 'not-run',
      project,
    }),
  );
}

export async function main() {
  await withExclusiveLock(P2P.docker.lock, run);
}

if (isMain(import.meta.url)) await main();
