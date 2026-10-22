import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { P2P } from '@gyblos/config';
import { NAT } from '@gyblos/lab-p2p/constants';
import { natEnvironment } from '@gyblos/lab-p2p/nat-topology';

test('NAT plan restricts capabilities to keyless non-root routers and isolates actor networks', async () => {
  const environment = natEnvironment('nat-direct', 'gyblos-p2p-synthetic');
  assert.equal(environment.GYBLOS_P2P_BLOCK_UDP, '0');
  assert.equal(environment.GYBLOS_P2P_SELLER_IP, NAT.homeA.actor);
  assert.equal(environment.GYBLOS_P2P_BUYER_IP, NAT.homeB.actor);
  assert.equal(environment.GYBLOS_P2P_EXPECTED_ROUTE, 'iroh-direct');
  const compose = JSON.parse(await readFile(NAT.composePath, 'utf8')) as {
    services: Record<
      string,
      {
        user: string;
        cap_add?: string[];
        cap_drop: string[];
        volumes?: string[];
        networks: Record<string, unknown>;
        read_only: boolean;
      }
    >;
    networks: Record<string, { driver_opts?: Record<string, string> }>;
  };
  for (const role of ['buyer', 'seller']) {
    const actor = compose.services[role]!;
    assert.deepEqual(actor.cap_drop, ['ALL']);
    assert.equal(actor.cap_add, undefined);
    assert.equal(actor.read_only, true);
    assert.equal(actor.user, '${GYBLOS_P2P_USER}');
    assert.equal(Object.keys(actor.networks).length, 1);
  }
  for (const role of ['router-a', 'router-b']) {
    const router = compose.services[role]!;
    assert.deepEqual(router.cap_add, ['NET_ADMIN']);
    assert.deepEqual(router.cap_drop, ['ALL']);
    assert.equal(router.volumes, undefined);
    assert.equal(router.read_only, true);
    assert.equal(Object.keys(router.networks).length, 2);
  }
  for (const home of ['home-a', 'home-b'])
    assert.equal(
      compose.networks[home]!.driver_opts?.[
        'com.docker.network.bridge.inhibit_ipv4'
      ],
      'true',
    );
  assert.equal(P2P.docker.user, '1000:1000');
});

test('UDP-blocked plan requires relay and rejects unsafe volume prefixes or unknown scenarios', () => {
  const environment = natEnvironment('nat-relay', 'gyblos-p2p-synthetic');
  assert.equal(environment.GYBLOS_P2P_BLOCK_UDP, '1');
  assert.equal(environment.GYBLOS_P2P_EXPECTED_ROUTE, 'iroh-relay');
  for (const prefix of [
    '',
    '../wallets',
    'unrelated-project',
    'gyblos-p2p-;command',
  ])
    assert.throws(() => natEnvironment('nat-direct', prefix));
  assert.throws(() =>
    natEnvironment('invalid' as 'nat-direct', 'gyblos-p2p-synthetic'),
  );
});

test('manual lab candidates require an explicit opt-in and remain separate from default discovery', () => {
  const automatic = natEnvironment('nat-direct', 'gyblos-p2p-synthetic');
  assert.equal(automatic.GYBLOS_P2P_LAB_CANDIDATES, '0');
  assert.equal(automatic.GYBLOS_P2P_SELLER_EXTERNAL, '');
  assert.equal(automatic.GYBLOS_P2P_BUYER_EXTERNAL, '');
  const assisted = natEnvironment('nat-direct', 'gyblos-p2p-synthetic', true);
  assert.equal(assisted.GYBLOS_P2P_LAB_CANDIDATES, '1');
  assert.equal(
    assisted.GYBLOS_P2P_SELLER_EXTERNAL,
    `${NAT.wan.routerA}:${NAT.sellerUdpPort}`,
  );
  assert.equal(
    assisted.GYBLOS_P2P_BUYER_EXTERNAL,
    `${NAT.wan.routerB}:${NAT.buyerUdpPort}`,
  );
});
