import { isIP } from 'node:net';

import { NAT } from '@gyblos/config';

export interface UdpTuple {
  source: string;
  destination: string;
  sourcePort: number;
  destinationPort: number;
}
export interface UdpMapping {
  original: UdpTuple;
  reply: UdpTuple;
  assured: boolean;
}

function tuple(groups: string[]): UdpTuple {
  const [source, destination, sourcePort, destinationPort] = groups;
  if (isIP(source!) !== NAT.ipv4Family || isIP(destination!) !== NAT.ipv4Family)
    throw new Error('Invalid UDP mapping address.');
  const ports = [Number(sourcePort), Number(destinationPort)];
  if (
    ports.some(
      (port) => !Number.isInteger(port) || port < 1 || port > NAT.maximumPort,
    )
  )
    throw new Error('Invalid UDP mapping port.');
  return {
    source: source!,
    destination: destination!,
    sourcePort: ports[0]!,
    destinationPort: ports[1]!,
  };
}

export function parseUdpMappings(output: string): UdpMapping[] {
  return output
    .split('\n')
    .filter((line) => /^udp\s/.test(line))
    .map((line) => {
      const tuples = [
        ...line.matchAll(/src=(\S+)\s+dst=(\S+)\s+sport=(\d+)\s+dport=(\d+)/g),
      ];
      if (tuples.length !== 2) throw new Error('Incomplete UDP mapping.');
      return {
        original: tuple(tuples[0]!.slice(1)),
        reply: tuple(tuples[1]!.slice(1)),
        assured: line.includes('[ASSURED]'),
      };
    });
}

export function selectUdpMapping(mappings: UdpMapping[], expected: UdpTuple) {
  const matches = mappings.filter((mapping) =>
    Object.entries(expected).every(
      ([key, value]) => mapping.original[key as keyof UdpTuple] === value,
    ),
  );
  if (matches.length !== 1)
    throw new Error(
      matches.length ? 'UDP mapping is ambiguous.' : 'UDP mapping is missing.',
    );
  return matches[0]!;
}

export function advertisedMappingMatches(
  mapping: UdpMapping,
  candidate: { host: string; port: number },
) {
  return (
    mapping.reply.destination === candidate.host &&
    mapping.reply.destinationPort === candidate.port
  );
}
