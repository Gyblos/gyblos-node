import { NAT, P2P } from '@gyblos/config';

import { composeArgs, docker } from './docker-command.js';

export type NatScenario = 'nat-direct' | 'nat-relay';

export function natEnvironment(
  scenario: NatScenario,
  volumePrefix: string,
  labCandidates = false,
) {
  if (
    !['nat-direct', 'nat-relay'].includes(scenario) ||
    !/^gyblos-p2p-[a-z0-9-]+$/.test(volumePrefix)
  )
    throw new Error('Invalid NAT scenario or isolated volume prefix.');
  return {
    GYBLOS_P2P_SCENARIO: scenario,
    GYBLOS_P2P_LAB_CANDIDATES: labCandidates ? '1' : '0',
    GYBLOS_P2P_SELLER_BIND: `${NAT.homeA.actor}:${labCandidates ? NAT.sellerUdpPort : 0}`,
    GYBLOS_P2P_BUYER_BIND: `${NAT.homeB.actor}:${labCandidates ? NAT.buyerUdpPort : 0}`,
    GYBLOS_P2P_SELLER_EXTERNAL: labCandidates
      ? `${NAT.wan.routerA}:${NAT.sellerUdpPort}`
      : '',
    GYBLOS_P2P_BUYER_EXTERNAL: labCandidates
      ? `${NAT.wan.routerB}:${NAT.buyerUdpPort}`
      : '',
    GYBLOS_P2P_VOLUME_PREFIX: volumePrefix,
    GYBLOS_P2P_EXPECTED_ROUTE:
      scenario === 'nat-direct' ? 'iroh-direct' : 'iroh-relay',
    GYBLOS_P2P_BLOCK_UDP: scenario === 'nat-relay' ? '1' : '0',
    GYBLOS_P2P_SELLER_IP: NAT.homeA.actor,
    GYBLOS_P2P_BUYER_IP: NAT.homeB.actor,
    GYBLOS_P2P_HOME_A: NAT.homeA.subnet,
    GYBLOS_P2P_HOME_B: NAT.homeB.subnet,
    GYBLOS_P2P_GATEWAY_A: NAT.homeA.gateway,
    GYBLOS_P2P_GATEWAY_B: NAT.homeB.gateway,
    GYBLOS_P2P_ROUTER_A_HOME: NAT.homeA.router,
    GYBLOS_P2P_ROUTER_B_HOME: NAT.homeB.router,
    GYBLOS_P2P_ROUTER_A_WAN: NAT.wan.routerA,
    GYBLOS_P2P_ROUTER_B_WAN: NAT.wan.routerB,
    GYBLOS_P2P_WAN: NAT.wan.subnet,
    GYBLOS_P2P_PREFIX_LENGTH: String(NAT.prefixLength),
    GYBLOS_P2P_ROUTER_PIDS: String(NAT.routerProcessLimit),
    GYBLOS_P2P_ROUTER_MEMORY: NAT.routerMemory,
  };
}

export async function startNatRouters(
  project: string,
  environment: NodeJS.ProcessEnv,
) {
  await docker([
    'build',
    '--build-arg',
    `ROUTER_BASE=${NAT.routerBase}`,
    '--build-arg',
    `IPROUTE_VERSION=${NAT.packages.iproute}`,
    '--build-arg',
    `IPTABLES_VERSION=${NAT.packages.iptables}`,
    '--build-arg',
    `LIBCAP_VERSION=${NAT.packages.libcap}`,
    '--build-arg',
    `CONNTRACK_VERSION=${NAT.packages.conntrack}`,
    '-f',
    NAT.routerDockerfile,
    '-t',
    NAT.routerImage,
    '.',
  ]);
  environment.GYBLOS_P2P_ROUTER_IMAGE = (
    await docker(['image', 'inspect', '--format', '{{.Id}}', NAT.routerImage])
  ).trim();
  await docker(
    composeArgs(
      project,
      ['up', '-d', '--wait', 'router-a', 'router-b'],
      environment,
    ),
    undefined,
    environment,
  );
}

export async function stopNatTopology(
  project: string,
  environment: NodeJS.ProcessEnv,
) {
  await docker(
    composeArgs(project, ['down', '--remove-orphans'], environment),
    undefined,
    environment,
  );
}
