import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { P2P } from '@gyblos/config';
import { saveJson } from '@gyblos/runtime';
import { TRANSPORT_ROUTES } from '@gyblos/transport/constants';

import type { inspectDocker } from './docker-checks.js';
import { collectDockerCalls, type dockerEvidence } from './docker-evidence.js';
import type { prepareDocker } from './docker-prepare.js';
import type { inspectNat } from './nat-checks.js';

export interface NatResult {
  status: 'passed';
  candidateMode: 'default-discovery' | 'manual-lab-candidates';
  source: Awaited<ReturnType<typeof prepareDocker>>['source'];
  runId: string;
  image: string;
  routerImage: string;
  previousAttempts: Awaited<
    ReturnType<typeof collectDockerCalls>
  >['previousAttempts'];
  security: Awaited<ReturnType<typeof inspectDocker>>;
  topologyBefore: Awaited<ReturnType<typeof inspectNat>>;
  topologyAfter: Awaited<ReturnType<typeof inspectNat>>;
  cases: Awaited<ReturnType<typeof collectDockerCalls>>['cases'];
}
type BaseEvidence = Awaited<ReturnType<typeof dockerEvidence>>;
type NatReport = Omit<BaseEvidence, 'scenarios'> & {
  scenarios: {
    flat: BaseEvidence['scenarios']['flat'];
    natDirect: { status: string } | NatResult;
    natRelay: { status: string } | NatResult;
  };
  defaultNatProbe?: {
    status: string;
    observedTransport: string;
    paymentAttempted: false;
  };
};

export async function recordNatEvidence(
  context: Awaited<ReturnType<typeof prepareDocker>>,
  offset: number,
  security: Awaited<ReturnType<typeof inspectDocker>>,
  before: Awaited<ReturnType<typeof inspectNat>>,
  after: Awaited<ReturnType<typeof inspectNat>>,
) {
  assert.ok(['nat-direct', 'nat-relay'].includes(context.scenario));
  const expectedRoute =
    context.scenario === 'nat-relay'
      ? TRANSPORT_ROUTES.RELAY
      : TRANSPORT_ROUTES.DIRECT;
  const { cases, previousAttempts } = await collectDockerCalls(context, {
    offset,
    expectedRoute,
  });
  const lab = context.environment.GYBLOS_P2P_LAB_CANDIDATES === '1';
  const report = JSON.parse(
    await readFile(P2P.docker.evidence, 'utf8'),
  ) as NatReport;
  assert.equal(report.evidenceId, 'GYB-GATE-0006');
  const result: NatResult = {
    status: 'passed',
    candidateMode: lab ? 'manual-lab-candidates' : 'default-discovery',
    source: context.source,
    runId: context.runId,
    image: context.image,
    routerImage: context.environment.GYBLOS_P2P_ROUTER_IMAGE!,
    previousAttempts,
    security,
    topologyBefore: before,
    topologyAfter: after,
    cases,
  };
  for (let index = 0; index < after.routers.length; index++)
    assert.ok(
      after.routers[index]!.forwardedPackets >
        before.routers[index]!.forwardedPackets,
    );
  report.scenarios[
    context.scenario === 'nat-direct' ? 'natDirect' : 'natRelay'
  ] = result;
  // Preserve the original flat result and failed attempt, with their own provenance.
  report.status = 'partial';
  report.limitations = report.limitations.filter(
    (line) =>
      line !==
      'NAT routers and UDP-blocked relay fallback have not been executed.',
  );
  if (
    lab &&
    !report.limitations.includes(
      'Controlled lab WAN candidates were supplied explicitly; this does not validate automatic NAT discovery.',
    )
  )
    report.limitations.push(
      'Controlled lab WAN candidates were supplied explicitly; this does not validate automatic NAT discovery.',
    );
  await saveJson(P2P.docker.evidence, report);
  return result;
}
