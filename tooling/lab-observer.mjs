import assert from 'node:assert/strict';

import {
  docker,
  execute,
  writeContainerFile,
} from '@gyblos/cli/p2p/docker-command';
import { NAT, P2P } from '@gyblos/config';

import { nativeSource } from './iroh-probe.mjs';

export function addLabObserver(template, values) {
  if (!values['wan-discovery']) return;
  assert.ok(values['native-image'], 'WAN discovery requires a native image.');
  assert.ok(
    !values['lab-candidates'],
    'Reflected discovery excludes manual peer candidates.',
  );
  assert.ok(
    !values['block-udp'],
    'Reflective discovery requires inbound UDP; use the separate blocked control.',
  );
  const actor = structuredClone(template.services.buyer);
  delete actor.depends_on;
  actor.networks = { internet: { ipv4_address: NAT.discovery.observerHost } };
  template.services.observer = actor;
}

export async function startLabObserver(ids, closeCode) {
  await docker([
    'exec',
    '-d',
    ids.observer,
    'node',
    '--input-type=module',
    '-e',
    nativeSource('observer'),
    JSON.stringify({
      ...NAT.discovery,
      closeCode,
      bind: `${NAT.discovery.observerHost}:${NAT.discovery.observerPort}`,
    }),
  ]);
  let descriptor;
  for (let index = 0; index < P2P.docker.readyMs / P2P.routePollMs; index++) {
    try {
      descriptor = await execute(ids.observer, [
        'cat',
        NAT.discovery.descriptorPath,
      ]);
      break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, P2P.routePollMs));
  }
  assert.ok(descriptor, 'Native lab observer did not become ready.');
  const value = JSON.parse(descriptor);
  assert.ok(
    value.addresses.includes(
      `${NAT.discovery.observerHost}:${NAT.discovery.observerPort}`,
    ),
  );
  for (const role of ['seller', 'buyer'])
    await writeContainerFile(
      ids[role],
      NAT.discovery.descriptorPath,
      Buffer.from(descriptor),
    );
}
