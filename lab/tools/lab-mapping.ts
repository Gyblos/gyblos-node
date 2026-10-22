// Owns laboratory lab mapping; product code must not depend on this module.
import assert from 'node:assert/strict';

import { NAT } from '@gyblos/lab-p2p/constants';
import {
  advertisedMappingMatches,
  selectUdpMapping,
} from '@gyblos/lab-p2p/nat-mapping';

import type { NativeMappings, NativeResult } from './types.js';

export function assertReflectedMappings(
  raw: Pick<NativeResult, 'reflectedAddress' | 'boundSockets'> & {
    peer: Pick<NativeResult['peer'], 'reflectedAddress' | 'boundSockets'>;
  },
  mappings: NativeMappings,
) {
  const roles = [
    {
      side: 'a',
      home: NAT.homeA.actor,
      own: raw.peer.reflectedAddress,
      remote: raw.reflectedAddress,
      sockets: raw.peer.boundSockets,
    },
    {
      side: 'b',
      home: NAT.homeB.actor,
      own: raw.reflectedAddress,
      remote: raw.peer.reflectedAddress,
      sockets: raw.boundSockets,
    },
  ];
  for (const role of roles) {
    const socket = role.sockets.find((value) =>
      value.startsWith(`${role.home}:`),
    );
    assert.ok(socket, 'Native source socket was not retained.');
    const sourcePort = Number(socket.split(':')[1]);
    const [host, port] = role.own!.split(':');
    const [remoteHost, remotePort] = role.remote!.split(':');
    for (const [destination, destinationPort] of [
      [NAT.discovery.observerHost, NAT.discovery.observerPort],
      [remoteHost, Number(remotePort)],
    ] as const) {
      const mapping = selectUdpMapping(mappings[role.side]!, {
        source: role.home,
        sourcePort,
        destination: destination!,
        destinationPort: destinationPort!,
      });
      assert.equal(
        advertisedMappingMatches(mapping, { host: host!, port: Number(port) }),
        true,
        'Observed and peer-directed NAT mappings differ.',
      );
    }
  }
}
